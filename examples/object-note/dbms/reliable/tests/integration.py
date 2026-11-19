#!/usr/bin/env python3
import csv, json, os, pathlib, subprocess, tempfile
from helpers import fixture, run, CLI

def rows(result):
    return result[-1]['rows']
with tempfile.TemporaryDirectory(prefix='mdb-integration-') as folder:
    p=pathlib.Path(folder);fixture(p)
    _,out=run(p,"BEGIN; INSERT INTO characters VALUES ('총웨',100); INSERT INTO characters VALUES ('슈',120); INSERT INTO items VALUES ('검',500); COMMIT; SELECT name,attack FROM characters ORDER BY attack DESC;")
    assert rows(out)==[['슈','120'],['총웨','100']],out
    _,out=run(p,'SELECT COUNT(*) FROM characters;');assert rows(out)==[['2']],out
    _,out=run(p,"BEGIN; UPDATE characters SET name='새 이름',attack=150 WHERE id=1; DELETE FROM characters WHERE id=2; INSERT INTO characters VALUES ('임시',10); SELECT name FROM characters ORDER BY id; ROLLBACK; SELECT name FROM characters ORDER BY id;")
    selects=[v for v in out if v.get('columns')]
    assert selects[-2]['rows']==[['새 이름'],['임시']],selects
    assert selects[-1]['rows']==[['총웨'],['슈']],selects
    _,out=run(p,"INSERT INTO characters VALUES ('쉼표, 큰따옴표 \" 그리고\n줄바꿈',200);")
    new=int(out[-1]['inserted_id']);assert new>3,out
    _,out=run(p,f'SELECT * FROM characters WHERE id={new};');assert out[-1]['used_index'] is True,out
    assert rows(out)[0][1]=='쉼표, 큰따옴표 " 그리고\n줄바꿈'
    _,scan=run(p,f'SELECT * FROM characters WHERE id={new};',{'MDB_FORCE_SCAN':'1'})
    assert rows(out)==rows(scan),(out,scan)
    proc,out=run(p,"INSERT INTO characters VALUES ('kept',1); INSERT INTO characters (id,name,attack) VALUES (99,'bad',2); INSERT INTO characters VALUES ('never',3);",check=False)
    assert proc.returncode!=0
    _,out=run(p,"SELECT COUNT(*) FROM characters WHERE name='kept';");assert rows(out)==[['1']]
    _,out=run(p,"SELECT COUNT(*) FROM characters WHERE name='never';");assert rows(out)==[['0']]
    _,out=run(p,"SELECT COUNT(*) FROM characters WHERE attack>=100 AND (name='총웨' OR name='슈');");assert rows(out)==[['2']]
    _,out=run(p,'SELECT COUNT(*) FROM characters LIMIT 0;');assert rows(out)==[]
    proc,_=run(p,'SELECT * FROM ../outside;',check=False);assert proc.returncode
    # A valid commit must survive loss/corruption of derived current CSV.
    for table in ('characters','items'):
        (p/(table+'.csv')).write_bytes(b'corrupt derived output\n')
    _,out=run(p,'SELECT COUNT(*) FROM characters;');assert rows(out)==[['4']],out
    _,out=run(p,'SELECT COUNT(*) FROM items;');assert rows(out)==[['1']],out
print('PASS integration: SQL, overlay, rollback ID reservation, restart, UTF-8 multiline CSV, index oracle, failure boundaries, derived-file recovery')
