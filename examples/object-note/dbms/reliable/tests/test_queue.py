#!/usr/bin/env python3
"""Gate one SQL worker to prove bounded queue rejection and session BUSY."""
import http.client
import json
import os
import pathlib
import signal
import socket
import subprocess
import tempfile
import time
from helpers import ROOT,fixture,run

SERVER=pathlib.Path(os.environ.get("MDB_SERVER_TEST",ROOT/"build/mini-db-server-test"))

def main():
    with tempfile.TemporaryDirectory(prefix="mdb-queue-") as directory:
        path=pathlib.Path(directory);fixture(path)
        run(path,"INSERT INTO characters VALUES ('seed',1);")
        prefix=path/"gate";entered=path/"gate.entered";queued=path/"gate.queued";release=path/"gate.release"
        with socket.socket() as probe:probe.bind(("127.0.0.1",0));port=probe.getsockname()[1]
        log=open(path/"server.log","wb")
        process=subprocess.Popen([str(SERVER),"--data-dir",str(path),"--port",str(port),"--threads","1","--queue","1"],env=dict(os.environ,MINIDB_TOKEN="queue-test",MDB_TEST_JOB_GATE=str(prefix)),stdout=log,stderr=log)
        connections=[]
        def send(endpoint,sql=None,method="POST"):
            connection=http.client.HTTPConnection("127.0.0.1",port,timeout=15);connections.append(connection)
            body=json.dumps({"sql":sql}) if sql is not None else b""
            connection.request(method,endpoint,body,{"Authorization":"Bearer queue-test","Content-Type":"application/json"})
            return connection
        def response(connection):
            result=connection.getresponse();body=json.loads(result.read());return result.status,body
        def wait_marker(marker):
            deadline=time.monotonic()+5
            while not marker.exists():
                if process.poll() is not None:raise AssertionError("Test server exited")
                if time.monotonic()>deadline:raise AssertionError("Test marker timeout: "+marker.name)
                time.sleep(.005)
        try:
            for _ in range(100):
                if process.poll() is not None:raise AssertionError("Test server exited during startup")
                try:
                    c=http.client.HTTPConnection("127.0.0.1",port,timeout=2)
                    c.request("GET","/health");r=c.getresponse();r.read();c.close()
                    if r.status==200:break
                except (OSError,http.client.HTTPException):time.sleep(.05)
            else:raise AssertionError("Server startup timeout")
            status,body=response(send("/sessions"));assert status==201,(status,body)
            endpoint="/sessions/"+body["session"]+"/query"
            first=send(endpoint,"SELECT COUNT(*) FROM characters;")
            wait_marker(entered)
            queued.unlink()  # First enqueue completed before its worker entered the gate.
            # Same session cannot execute or enqueue another SQL while its first is active.
            status,body=response(send(endpoint,"INSERT INTO characters VALUES ('busy-rejected',2);"))
            assert status==409,(status,body)
            second=send("/query","INSERT INTO characters VALUES ('queued',2);")
            wait_marker(queued)  # Exactly one waiting SQL now occupies queue capacity one.
            status,body=response(send("/query","INSERT INTO characters VALUES ('overload-rejected',3);"))
            assert status==503,(status,body)
            assert body.get("commit")=="NOT_COMMITTED",body
            release.touch()
            status,body=response(first);assert status==200 and body["rows"]==[["1"]],(status,body)
            status,body=response(second);assert status==200 and body["commit"]=="DURABLE",(status,body)
            status,body=response(send("/query","SELECT name FROM characters ORDER BY id;"))
            assert status==200 and body["rows"]==[["seed"],["queued"]],(status,body)
            # Terminate with one SQL stopped before execution and another still queued.
            release.unlink();entered.unlink();queued.unlink()
            running=send("/query","INSERT INTO characters VALUES ('shutdown-running',3);")
            wait_marker(entered);queued.unlink()
            waiting=send("/query","INSERT INTO characters VALUES ('shutdown-queued',4);")
            wait_marker(queued)
            process.send_signal(signal.SIGTERM)
            # Confirm the I/O owner has stopped accepting before allowing SQL to finish.
            deadline=time.monotonic()+5
            while True:
                try:
                    with socket.create_connection(("127.0.0.1",port),timeout=.2):pass
                except OSError:break
                if time.monotonic()>deadline:raise AssertionError("Shutdown did not stop accepting")
                time.sleep(.005)
            release.touch()
            for connection in (running,waiting):
                status,body=response(connection)
                assert status==200 and body["commit"]=="DURABLE",(status,body)
            assert process.wait(timeout=30)==0
            _,out=run(path,"SELECT COUNT(*) FROM characters;");assert out[-1]["rows"]==[["4"]]
        finally:
            release.touch()
            for connection in connections:connection.close()
            if process.poll() is None:
                process.terminate()
                try:process.wait(timeout=30)
                except subprocess.TimeoutExpired:process.kill();process.wait()
            log.close()
    print("PASS deterministic queue: active/queued SQL, pre-execution 503, session BUSY 409, shutdown drains active and queued commits, restart exact rows")

if __name__=="__main__":main()
