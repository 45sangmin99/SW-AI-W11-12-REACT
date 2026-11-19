import json, os, pathlib, subprocess, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
CLI=pathlib.Path(os.environ.get('MDB_CLI',ROOT/'build/mini-db'))
def fixture(path):
    path=pathlib.Path(path)
    for table,tail in [('characters','attack INT'),('items','price INT')]:
        (path/(table+'.schema')).write_text('id INT AUTO\nname VARCHAR(80)\n'+tail+'\n')
        (path/(table+'.csv')).write_text('')
def run(path,sql,env=None,check=True):
    proc=subprocess.run([str(CLI),'--data-dir',str(path),'-e',sql],capture_output=True,text=True,env=dict(os.environ,**(env or {})))
    if check and proc.returncode: raise AssertionError((sql,proc.returncode,proc.stdout,proc.stderr))
    values=[]
    for line in proc.stdout.splitlines():
        try: value=json.loads(line)
        except ValueError: continue
        if isinstance(value,list):values.extend(value)
        else:values.append(value)
    return proc,values
