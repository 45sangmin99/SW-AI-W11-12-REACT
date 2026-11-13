#!/usr/bin/env python3
"""Read/malformed-request soak; process RSS/fd samples are evidence, not a leak proof."""
import argparse
import concurrent.futures
import http.client
import json
import os
import pathlib
import re
import secrets
import signal
import socket
import subprocess
import tempfile
import threading
import time

ROOT=pathlib.Path(__file__).resolve().parents[1]

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds",type=float,default=120)
    parser.add_argument("--output",type=pathlib.Path,default=ROOT/"soak-results.json")
    args=parser.parse_args()
    if args.seconds<12:parser.error("--seconds must be at least 12 (10-second warmup)")
    cli=pathlib.Path(os.environ.get("MDB_CLI",ROOT/"build/mini-db"))
    server=pathlib.Path(os.environ.get("MDB_SERVER",ROOT/"build/mini-db-server"))
    token=secrets.token_hex(32)
    with tempfile.TemporaryDirectory(prefix="mdb-soak-") as directory:
        data=pathlib.Path(directory)
        (data/"characters.schema").write_text("id INT AUTO\nname VARCHAR(80)\nattack INT\n")
        (data/"characters.csv").write_text("")
        initial=subprocess.run([str(cli),"--data-dir",str(data),"-e","INSERT INTO characters VALUES ('soak',7);"],capture_output=True,text=True,check=True)
        identifier=json.loads(initial.stdout.strip())["inserted_id"]
        with socket.socket() as probe:probe.bind(("127.0.0.1",0));port=probe.getsockname()[1]
        log=open(data/"server.log","wb")
        process=subprocess.Popen([str(server),"--data-dir",str(data),"--port",str(port),"--threads","4","--queue","128"],stdout=log,stderr=log,env=dict(os.environ,MINIDB_TOKEN=token))
        def request(sql):
            c=http.client.HTTPConnection("127.0.0.1",port,timeout=10)
            try:
                c.request("POST","/query",json.dumps({"sql":sql}),{"Authorization":"Bearer "+token,"Content-Type":"application/json"})
                response=c.getresponse();body=json.loads(response.read())
                if response.status!=200 or not body.get("ok"):raise RuntimeError("Unexpected SQL response status")
                return body
            finally:c.close()
        def malformed():
            with socket.create_connection(("127.0.0.1",port),timeout=10) as c:
                c.sendall(b"INVALID REQUEST\r\n\r\n");response=b""
                while True:
                    part=c.recv(4096)
                    if not part:break
                    response+=part
                if not response.startswith(b"HTTP/1.1 400 "):raise RuntimeError("Malformed HTTP did not produce 400")
        def resources(elapsed):
            rss=subprocess.run(["ps","-o","rss=","-p",str(process.pid)],capture_output=True,text=True,timeout=5,check=True)
            procfd=pathlib.Path("/proc")/str(process.pid)/"fd"
            if procfd.is_dir():fd_count=len(list(procfd.iterdir()));method="/proc/pid/fd"
            else:
                listing=subprocess.run(["lsof","-nP","-a","-p",str(process.pid),"-Ff"],capture_output=True,text=True,timeout=10,check=True)
                fd_count=sum(bool(re.fullmatch(r"f[0-9]+",line)) for line in listing.stdout.splitlines());method="lsof numeric descriptors"
            return {"elapsed_seconds":round(elapsed,3),"rss_kib":int(rss.stdout.strip()),"open_fds":fd_count,"fd_measurement":method}
        stop=threading.Event();start=0.0;samples=[];outcomes=[]
        def client(worker):
            reads=bad=0
            while not stop.is_set():
                if reads%5==4:
                    malformed();bad+=1
                body=request("SELECT name,attack FROM characters WHERE id="+identifier+";")
                if body["rows"]!=[["soak","7"]] or not body["used_index"]:raise RuntimeError("Incorrect indexed result")
                reads+=1
                # Moderate paced clients exercise reuse/lifetimes without making this a throughput benchmark.
                stop.wait(.005)
            return {"worker":worker,"successful_selects":reads,"rejected_malformed_requests":bad}
        try:
            for _ in range(100):
                if process.poll() is not None:raise RuntimeError("Server exited during startup")
                try:
                    if request("SELECT COUNT(*) FROM characters;")["rows"]==[["1"]]:break
                except (OSError,http.client.HTTPException):time.sleep(.05)
            else:raise RuntimeError("Startup timed out")
            start=time.monotonic()
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as workers:
                futures=[workers.submit(client,i) for i in range(4)]
                try:
                    next_sample=10.0
                    while True:
                        elapsed=time.monotonic()-start
                        if process.poll() is not None:raise RuntimeError("Server exited during soak")
                        for future in futures:
                            if future.done():future.result();raise RuntimeError("Client stopped early")
                        if elapsed>=next_sample:
                            sample=resources(elapsed);samples.append(sample)
                            print("sample",json.dumps(sample),flush=True);next_sample+=10
                        if elapsed>=args.seconds:break
                        time.sleep(min(.25,args.seconds-elapsed))
                finally:stop.set()
                outcomes=[future.result(timeout=15) for future in futures]
            samples.append(resources(time.monotonic()-start))
            final=request("SELECT COUNT(*) FROM characters;")
            if final["rows"]!=[["1"]]:raise RuntimeError("Row count changed during read-only soak")
            process.send_signal(signal.SIGTERM)
            if process.wait(timeout=30)!=0:raise RuntimeError("Graceful server exit failed")
            rss=[sample["rss_kib"] for sample in samples];fds=[sample["open_fds"] for sample in samples]
            result={"duration_seconds":round(time.monotonic()-start,3),"requested_seconds":args.seconds,"warmup_seconds":10,"clients":4,"workload":"indexed SELECT plus one malformed HTTP request per five SELECTs","successful_selects":sum(o["successful_selects"] for o in outcomes),"rejected_malformed_requests":sum(o["rejected_malformed_requests"] for o in outcomes),"per_client":outcomes,"samples":samples,"rss_end_minus_first_kib":rss[-1]-rss[0],"rss_peak_kib":max(rss),"fd_end_minus_first":fds[-1]-fds[0],"fd_min":min(fds),"fd_max":max(fds),"final_row_count":1,"server_exit_code":process.returncode,"interpretation":"Process-specific RSS/fd observations after warmup; allocator caching and concurrent open sockets affect values. This does not prove absence of leaks."}
            args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n")
            print(json.dumps({key:result[key] for key in ("successful_selects","rejected_malformed_requests","rss_end_minus_first_kib","fd_end_minus_first","server_exit_code")}),flush=True)
        finally:
            stop.set()
            if process.poll() is None:
                process.terminate()
                try:process.wait(timeout=30)
                except subprocess.TimeoutExpired:process.kill();process.wait()
            log.close()

if __name__=="__main__":main()
