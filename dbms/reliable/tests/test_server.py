#!/usr/bin/env python3
"""Actual-socket checks: framing, sessions, OCC, Unicode, parallel clients, slow input."""
import concurrent.futures
import http.client
import json
import os
import pathlib
import random
import signal
import socket
import subprocess
import tempfile
import time
from helpers import ROOT,fixture,run

TOKEN="test-token-not-for-production"
SERVER=pathlib.Path(os.environ.get("MDB_SERVER",ROOT/"build/mini-db-server"))

def main():
    with tempfile.TemporaryDirectory(prefix="mdb-server-") as directory:
        path=pathlib.Path(directory);fixture(path)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1",0));port=probe.getsockname()[1]
        log=open(path/"server.log","w+")
        process=subprocess.Popen([str(SERVER),"--data-dir",str(path),"--port",str(port),"--threads","4","--queue","8","--read-timeout","2"],env=dict(os.environ,MINIDB_TOKEN=TOKEN),stdout=log,stderr=log)
        def request(method,path,body=None,token=TOKEN):
            connection=http.client.HTTPConnection("127.0.0.1",port,timeout=15)
            headers={"Content-Type":"application/json"}
            if token is not None: headers["Authorization"]="Bearer "+token
            if isinstance(body,dict):body=json.dumps(body,ensure_ascii=False).encode()
            try:
                connection.request(method,path,body=body,headers=headers)
                response=connection.getresponse();raw=response.read()
                return response.status,json.loads(raw)
            finally:connection.close()
        def query(sql,session=None):return request("POST","/sessions/"+session+"/query" if session else "/query",{"sql":sql})
        def session():
            status,body=request("POST","/sessions",b"")
            assert status==201,(status,body)
            return body["session"]
        def raw(data):
            with socket.create_connection(("127.0.0.1",port),timeout=5) as connection:
                connection.sendall(data); response=b""
                while True:
                    part=connection.recv(65536)
                    if not part:break
                    response+=part
                assert response.startswith(b"HTTP/1.1 "),response
                return int(response.split(b" ",2)[1])
        try:
            for _ in range(100):
                if process.poll() is not None:raise AssertionError("Server exited during startup")
                try:
                    if request("GET","/health",token=None)[0]==200:break
                except (OSError,http.client.HTTPException):time.sleep(.05)
            else:raise AssertionError("Server startup timed out")
            assert request("POST","/query",{"sql":"SELECT * FROM characters;"},token=None)[0]==401
            assert request("POST","/query",{"sql":"SELECT * FROM characters;"},token="wrong")[0]==401
            assert request("GET","/unknown")[0]==405
            assert request("POST","/unknown",b"")[0]==404
            assert query("BEGIN;")[0]==409
            assert query("INSERT INTO characters VALUES ('never',1); SELECT * FROM characters;")[0]==400
            assert query("SELECT COUNT(*) FROM characters;")[1]["rows"]==[["0"]]
            status,body=query("INSERT INTO characters VALUES ('한글 😀, \\\"',100);")
            assert status==200,(status,body)
            initial=body["inserted_id"]
            status,body=query("SELECT name,attack FROM characters WHERE id="+initial+";")
            assert status==200 and body["used_index"] and body["rows"][0][1]=="100",body
            assert query("SELECT * FROM characters WHERE id=9223372036854775807;")[1]["rows"]==[]
            assert query("SELECT unknown FROM characters;")[0]==400
            assert query("SELECT * FROM missing;")[0]==404
            assert request("POST","/query",b'{"sql":"x","sql":"y"}')[0]==400
            assert request("POST","/query",b'{"sql":"\\u0000"}')[0]==400
            assert request("POST","/query",{"sql":"x"*4097})[0]==413
            # Stable snapshots, private writes, conservative conflict detection.
            first=session();second=session()
            assert query("BEGIN;",first)[0]==200
            assert query("BEGIN;",second)[0]==200
            assert query("INSERT INTO characters VALUES ('private',120);",first)[1]["staged"]
            assert query("SELECT COUNT(*) FROM characters;",first)[1]["rows"]==[["2"]]
            assert query("SELECT COUNT(*) FROM characters;",second)[1]["rows"]==[["1"]]
            assert query("COMMIT;",first)[0]==200
            assert query("SELECT COUNT(*) FROM characters;",second)[1]["rows"]==[["1"]]
            assert query("INSERT INTO items VALUES ('conflicting',10);",second)[0]==200
            assert query("COMMIT;",second)[0]==409
            assert query("SELECT * FROM items;",second)[0]==409
            assert query("ROLLBACK;",second)[0]==200
            assert query("SELECT COUNT(*) FROM items;")[1]["rows"]==[["0"]]
            assert request("DELETE","/sessions/"+first)[0]==200
            assert request("DELETE","/sessions/"+second)[0]==200
            assert query("SELECT * FROM characters;",first)[0]==404
            # Independent clients: count successful commits, explicitly allow OCC conflicts.
            def insert(i):return query("INSERT INTO characters VALUES ('parallel%d',%d);"%(i,i))
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as workers:
                results=list(workers.map(insert,range(32)))
            successes=[body for status,body in results if status==200]
            assert successes and all(status in (200,409,503) for status,_ in results),results
            ids=[body["inserted_id"] for body in successes];assert len(ids)==len(set(ids))
            assert query("SELECT COUNT(*) FROM characters;")[1]["rows"]==[[str(2+len(successes))]]
            for identifier in ids:
                status,body=query("SELECT id FROM characters WHERE id="+identifier+";")
                assert status==200 and body["rows"]==[[identifier]] and body["used_index"],body
            # Framing is rejected without SQL execution.
            base=b"POST /query HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer "+TOKEN.encode()+b"\r\n"
            assert raw(base+b"\r\n")==411
            assert raw(base+b"Content-Length: 0\r\nContent-Length: 0\r\n\r\n")==400
            assert raw(base+b"Content-Length: -1\r\n\r\n")==400
            assert raw(base+b"Content-Length: 99999999\r\n\r\n")==413
            assert raw(base+b"Transfer-Encoding: chunked\r\n\r\n")==501
            assert raw(b"GET /health HTTP/1.1\r\n\r\n")==400
            assert raw(b"GET /health HTTP/1.1\r\nHost: x\r\nX: "+b"a"*17000+b"\r\n\r\n")==431
            # Slow clients do not occupy SQL workers and have an absolute receive deadline.
            slow=[socket.create_connection(("127.0.0.1",port),timeout=5) for _ in range(6)]
            for connection in slow:connection.sendall(b"POST /query HTTP/1.1\r\n")
            assert query("SELECT COUNT(*) FROM characters;")[0]==200
            time.sleep(2.3)
            for connection in slow:
                connection.settimeout(5);assert connection.recv(4096).startswith(b"HTTP/1.1 408");connection.close()
            # A valid frame split inside UTF-8 and every other byte is still one request.
            payload=json.dumps({"sql":"SELECT name FROM characters WHERE name='한글';"},ensure_ascii=False).encode()
            frame=base+b"Content-Type: application/json\r\nContent-Length: "+str(len(payload)).encode()+b"\r\n\r\n"+payload
            with socket.create_connection(("127.0.0.1",port),timeout=5) as partial:
                for byte in frame:partial.sendall(bytes([byte]))
                data=b""
                while True:
                    chunk=partial.recv(4096)
                    if not chunk:break
                    data+=chunk
                assert data.startswith(b"HTTP/1.1 200"),data
            # A disconnected request and malformed input must not crash the server.
            for data in (b"garbage\r\n\r\n",b"GET /health HTTP/1.1\r\nHost: x\r\nBad\r\n\r\n"):
                assert raw(data)==400
            broken=socket.create_connection(("127.0.0.1",port));broken.sendall(base);broken.close()
            generator=random.Random(8731)
            for _ in range(2000):
                garbage=b"INVALID"+bytes(generator.randrange(256) for _ in range(generator.randrange(128)))+b"\r\n\r\n"
                assert raw(garbage)==400
            assert request("GET","/health",token=None)[0]==200
            # Multi-process directory ownership protects CLI against the running server.
            proc,_=run(path,"SELECT * FROM characters;",check=False);assert proc.returncode!=0
            process.send_signal(signal.SIGTERM);assert process.wait(timeout=30)==0
            _,restored=run(path,"SELECT COUNT(*) FROM characters;")
            assert restored[-1]["rows"]==[[str(2+len(successes))]]
        finally:
            if process.poll() is None:
                process.terminate()
                try:process.wait(timeout=30)
                except subprocess.TimeoutExpired:process.kill();process.wait()
            log.flush();log.seek(0);diagnostics=log.read();log.close()
            if process.returncode:print(diagnostics)
    print("PASS HTTP: real sockets, auth, strict framing/Unicode, session isolation/conflicts, parallel clients, partial/slow input, 2000 malformed frames, restart")

if __name__=="__main__":main()
