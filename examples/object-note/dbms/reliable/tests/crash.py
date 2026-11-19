#!/usr/bin/env python3
import json, os, pathlib, select, shutil, signal, subprocess, tempfile, time
from helpers import fixture,run,CLI
def kill_at(path,sql,fault):
    read_fd,write_fd=os.pipe()
    env=dict(os.environ,MDB_FAILPOINT=fault,MDB_FAILPOINT_ACTION='pause',MDB_FAILPOINT_READY_FD=str(write_fd))
    process=subprocess.Popen([str(CLI),'--data-dir',str(path),'-e',sql],env=env,pass_fds=(write_fd,),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    os.close(write_fd)
    try:
        ready=select.select([read_fd],[],[],30)[0]
        marker=os.read(read_fd,1) if ready else b''
        if marker!=b'R':
            if process.poll() is None:process.kill()
            out,err=process.communicate(timeout=10)
            raise AssertionError((fault,'fault checkpoint not reached',process.returncode,out,err))
        process.kill()  # SIGKILL is sent by this external parent, not by the engine.
        process.communicate(timeout=10)
        assert process.returncode==-signal.SIGKILL,(fault,process.returncode)
    finally:
        os.close(read_fd)
        if process.poll() is None:process.kill();process.wait()
cases=[('wal_partial',False),('before_commit_sync',None),('after_commit_sync',True),('after_csv_rename',True),('before_applied',True)]
report=[]
for fault,expected in cases:
    with tempfile.TemporaryDirectory(prefix='mdb-crash-') as folder:
        p=pathlib.Path(folder);fixture(p)
        run(p,"BEGIN; INSERT INTO characters VALUES ('confirmed',1); INSERT INTO items VALUES ('confirmed',1); COMMIT;")
        kill_at(p,"BEGIN; INSERT INTO characters VALUES ('crash',2); INSERT INTO items VALUES ('crash',2); COMMIT;",fault)
        counts=[]
        for _ in range(2):
            _,out=run(p,"SELECT COUNT(*) FROM characters; SELECT COUNT(*) FROM items;")
            got=[int(v['rows'][0][0]) for v in out if v.get('columns')]
            assert len(got)==2 and got[0]==got[1] and got[0] in (1,2),(fault,got)
            if expected is not None:assert got[0]==(2 if expected else 1),(fault,got)
            counts.append(got)
        assert counts[0]==counts[1],(fault,counts)
        report.append({'fault':fault,'external_sigkill':True,'counts_after_recovery':counts[0],'repeat_identical':True})
with tempfile.TemporaryDirectory(prefix='mdb-recovery-crash-') as folder:
    p=pathlib.Path(folder);fixture(p)
    run(p,"INSERT INTO characters VALUES ('confirmed',1);")
    kill_at(p,'SELECT COUNT(*) FROM characters;','recovery_write')
    _,out=run(p,'SELECT COUNT(*) FROM characters;');assert out[-1]['rows']==[['1']],out
    report.append({'fault':'recovery_write','external_sigkill':True,'repeat_identical':True})
with tempfile.TemporaryDirectory(prefix='mdb-id-crash-') as folder:
    p=pathlib.Path(folder);fixture(p)
    run(p,"INSERT INTO characters VALUES ('confirmed',1);")
    kill_at(p,"INSERT INTO characters VALUES ('never handed out',2);",'id_reserved')
    _,out=run(p,"INSERT INTO characters VALUES ('after reservation',3);")
    assert int(out[-1]['inserted_id'])>8192,out
    report.append({'fault':'id_reserved','external_sigkill':True,'reserved_ids_not_reused':True})
with tempfile.TemporaryDirectory(prefix='mdb-init-crash-') as folder:
    p=pathlib.Path(folder);fixture(p)
    (p/'characters.csv').write_text('7,initial,1\n')
    kill_at(p,'SELECT * FROM characters;','init_baseline')
    proc,_=run(p,'SELECT * FROM characters;',check=False)
    assert proc.returncode!=0 and 'initial' in (p/'characters.csv').read_text()
    report.append({'fault':'init_baseline','external_sigkill':True,'incomplete_initialization_rejected':True})
print(json.dumps({'crash_tests':report},ensure_ascii=False,indent=2))
print('PASS crash: real child SIGKILL, multi-table atomic recovery, acknowledged commit preservation and repeated recovery')
