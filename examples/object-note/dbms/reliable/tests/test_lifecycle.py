#!/usr/bin/env python3
"""Short test-only session TTL, in-flight lifetime, and stalled response deadlines."""
import http.client
import json
import os
import pathlib
import re
import signal
import socket
import subprocess
import tempfile
import time
from helpers import ROOT,CLI,fixture,run

SERVER=pathlib.Path(os.environ.get("MDB_SERVER_LIFECYCLE",ROOT/"build/mini-db-server-lifecycle"))
TOKEN="lifecycle-test"

class Running:
    def __init__(self,path,gate=None,timeout=2):
        with socket.socket() as probe:probe.bind(("127.0.0.1",0));self.port=probe.getsockname()[1]
        self.log=open(path/"server.log","wb")
        env=dict(os.environ,MINIDB_TOKEN=TOKEN)
        if gate is not None:env["MDB_TEST_JOB_GATE"]=str(gate)
        self.process=subprocess.Popen([str(SERVER),"--data-dir",str(path),"--port",str(self.port),"--threads","2","--queue","8","--read-timeout",str(timeout)],stdout=self.log,stderr=self.log,env=env)
        self.connections=[]
        for _ in range(100):
            if self.process.poll() is not None:raise AssertionError("Lifecycle server exited during startup")
            try:
                status,_=self.request("/health",method="GET")
                if status==200:break
            except (OSError,http.client.HTTPException):time.sleep(.05)
        else:raise AssertionError("Lifecycle server startup timeout")
    def send(self,path,sql=None,method="POST"):
        c=http.client.HTTPConnection("127.0.0.1",self.port,timeout=15);self.connections.append(c)
        c.request(method,path,json.dumps({"sql":sql}) if sql is not None else b"",{"Authorization":"Bearer "+TOKEN,"Content-Type":"application/json"})
        return c
    def response(self,c):
        response=c.getresponse();body=json.loads(response.read());c.close();return response.status,body
    def request(self,path,sql=None,method="POST"):return self.response(self.send(path,sql,method))
    def query(self,sql,session=None):return self.request("/sessions/"+session+"/query" if session else "/query",sql)
    def session(self):
        status,body=self.request("/sessions");assert status==201,(status,body);return body["session"]
    def close(self):
        for c in self.connections:c.close()
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            try:self.process.wait(timeout=30)
            except subprocess.TimeoutExpired:self.process.kill();self.process.wait()
        code=self.process.returncode;self.log.close();assert code==0,code

def wait_marker(path):
    deadline=time.monotonic()+5
    while not path.exists():
        if time.monotonic()>deadline:raise AssertionError("Worker did not enter test gate")
        time.sleep(.005)

def sessions():
    with tempfile.TemporaryDirectory(prefix="mdb-session-lifecycle-") as directory:
        path=pathlib.Path(directory);fixture(path);run(path,"INSERT INTO characters VALUES ('seed',1);")
        prefix=path/"gate";release=path/"gate.release";entered=path/"gate.entered";release.touch()
        server=Running(path,prefix)
        try:
            token=server.session()
            assert server.query("BEGIN;",token)[0]==200
            assert server.query("INSERT INTO characters VALUES ('expired-private',2);",token)[1]["staged"]
            time.sleep(2.5)
            status,body=server.query("SELECT * FROM characters;",token)
            assert status==404,(status,body)
            assert server.query("SELECT COUNT(*) FROM characters;")[1]["rows"]==[["1"]]
            token=server.session();assert server.query("BEGIN;",token)[0]==200
            release.unlink();entered.unlink()
            pending=server.send("/sessions/"+token+"/query","SELECT COUNT(*) FROM characters;")
            wait_marker(entered);time.sleep(1.5)
            status,body=server.query("INSERT INTO characters VALUES ('busy-rejected',3);",token)
            assert status==409,(status,body)
            release.touch()
            status,body=server.response(pending)
            assert status==200 and body["rows"]==[["1"]],(status,body)
            assert server.query("ROLLBACK;",token)[0]==200
            assert server.request("/sessions/"+token,method="DELETE")[0]==200
            assert server.query("SELECT COUNT(*) FROM characters;")[1]["rows"]==[["1"]]
        finally:release.touch();server.close()

def stalled_receiver():
    with tempfile.TemporaryDirectory(prefix="mdb-send-lifecycle-") as directory:
        path=pathlib.Path(directory);fixture(path)
        sql=path/"bulk.sql"
        with sql.open("w") as output:
            output.write("BEGIN;\n")
            for i in range(10000):output.write("INSERT INTO characters VALUES ('"+"x"*80+"',"+str(i)+");\n")
            output.write("COMMIT;\n")
        subprocess.run([str(CLI),"--data-dir",str(path),"--file",str(sql)],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,check=True)
        server=Running(path,timeout=1)
        receiver=socket.socket();receiver.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,1024);receiver.settimeout(10)
        try:
            receiver.connect(("127.0.0.1",server.port))
            body=json.dumps({"sql":"SELECT * FROM characters;"}).encode()
            header=("POST /query HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer "+TOKEN+"\r\nContent-Type: application/json\r\nContent-Length: "+str(len(body))+"\r\n\r\n").encode()
            receiver.sendall(header+body)
            time.sleep(3)  # Response cannot fit in the advertised receive window without reads.
            status,result=server.query("SELECT COUNT(*) FROM characters;")
            assert status==200 and result["rows"]==[["10000"]],(status,result)
            received=b""
            while True:
                block=receiver.recv(65536)
                if not block:break
                received+=block
            assert received.startswith(b"HTTP/1.1 200 "),received[:100]
            headers,payload=received.split(b"\r\n\r\n",1)
            match=re.search(rb"Content-Length: ([0-9]+)\r?",headers)
            assert match,headers
            declared=int(match.group(1))
            assert len(payload)<declared,(len(payload),declared)
        finally:receiver.close();server.close()
        print("send deadline: declared",declared,"bytes; received",len(payload),"bytes before EOF")

if __name__=="__main__":
    sessions();stalled_receiver()
    print("PASS lifecycle: idle staged transaction expires/discards, busy session survives TTL, stalled receiver times out while other SQL completes")
