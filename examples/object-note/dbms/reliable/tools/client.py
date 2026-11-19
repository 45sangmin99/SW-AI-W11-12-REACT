#!/usr/bin/env python3
"""Small authenticated HTTP client; never automatically retries SQL."""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("sql",nargs="?")
    p.add_argument("--url",default="http://127.0.0.1:8080")
    p.add_argument("--session")
    p.add_argument("--create-session",action="store_true")
    p.add_argument("--close-session",action="store_true")
    p.add_argument("--health",action="store_true")
    a=p.parse_args()
    token=os.environ.get("MINIDB_TOKEN","")
    headers={"Authorization":"Bearer "+token,"Content-Type":"application/json"}
    method="POST"; data=b""
    if a.health: path="/health"; method="GET"; data=None
    elif a.create_session: path="/sessions"
    elif a.close_session:
        if not a.session: p.error("--close-session requires --session")
        path="/sessions/"+a.session; method="DELETE"; data=None
    else:
        if not a.sql: p.error("provide SQL or an action")
        path="/sessions/"+a.session+"/query" if a.session else "/query"
        data=json.dumps({"sql":a.sql},ensure_ascii=False).encode()
    request=urllib.request.Request(a.url.rstrip("/")+path,data=data,headers=headers,method=method)
    try:
        with urllib.request.urlopen(request,timeout=30) as response:
            print(json.dumps(json.load(response),ensure_ascii=False,indent=2))
    except urllib.error.HTTPError as error:
        print(error.read().decode(),file=sys.stderr); return 1
    except (urllib.error.URLError,TimeoutError) as error:
        print("Transport failure; execution/commit may have occurred. Do not blindly retry: "+str(error),file=sys.stderr); return 2
    return 0

if __name__=="__main__": raise SystemExit(main())
