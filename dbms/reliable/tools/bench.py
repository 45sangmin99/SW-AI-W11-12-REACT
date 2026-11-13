#!/usr/bin/env python3
import argparse,json,os,pathlib,platform,subprocess,tempfile,time
ROOT=pathlib.Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--count',type=int,default=1000000);p.add_argument('--output',default=str(ROOT/'bench-results.json'));a=p.parse_args()
subprocess.run(['make','build/bench'],cwd=ROOT,check=True)
with tempfile.TemporaryDirectory(prefix='mdb-bench-') as folder:
    data=pathlib.Path(folder)
    start=time.perf_counter()
    (data/'records.schema').write_text('id INT AUTO\nname VARCHAR(32)\nk INT\n')
    (data/'records.csv').write_bytes(b'')
    generated=time.perf_counter()-start
    proc=subprocess.run([str(ROOT/'build/bench'),folder,str(a.count)],capture_output=True,text=True)
    if proc.returncode:raise SystemExit(proc.stderr+'\n'+proc.stdout)
    result=json.loads(proc.stdout)
    result.update({'platform':platform.platform(),'processor':platform.machine(),'compiler':subprocess.check_output(['cc','--version'],text=True).splitlines()[0],'schema_generation_s':generated,'insert_generation':'snprintf per SQL included in sql_insert_s','data_distribution':'sequential automatic ID; unique k equals ID; constant name','cache':'warm process/OS cache; no OS cache eviction; not a cold-cache claim','output_excluded':True,'durability':'normal durable mode; one explicit transaction; durable ID ranges','timing_notes':'commit includes CSV write and engine index construction; reopen includes full baseline/WAL replay and index construction; standalone BPT times exclude CSV and compare shuffle construction; max is not p99','unix_time':time.time()})
    result['files']={str(x.relative_to(data)):x.stat().st_size for x in data.rglob('*') if x.is_file()}
    pathlib.Path(a.output).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(result,ensure_ascii=False,indent=2))
