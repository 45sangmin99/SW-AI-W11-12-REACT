#!/usr/bin/env python3
"""Real HTTP measurements; nearest-rank quantiles. No third-party dependencies."""
import concurrent.futures
import http.client as client
import json
import math
import platform
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'tests'))
from support import ROOT, Server, http, port, wait_for

BINARY = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT/'build/mini-redis').resolve()


def quantiles(samples):
    data = sorted(samples)
    return {name: round(data[max(0, math.ceil(len(data)*q)-1)], 4)
            for name, q in [('p50_ms', .5), ('p95_ms', .95), ('p99_ms', .99), ('max_ms', 1)]}


def api_bench():
    rows = []
    for concurrency in (1, 8):
        with tempfile.TemporaryDirectory() as d:
            s = Server(BINARY, d)
            dataset = [{'id': str(i), 'name': 'product-'+str(i), 'price': i*100} for i in range(512)]
            path = Path(d)/'products.json';path.write_text(json.dumps(dataset))
            p = port()
            api = subprocess.Popen([sys.executable, str(ROOT/'example/product_api.py'), '--port', str(p), '--redis-port', str(s.port), '--products', str(path), '--ttl', '120'])
            try:
                def ready():
                    try: return http(p, 'GET', '/stats')[0] == 200
                    except OSError: return False
                wait_for(ready)
                # Warm connections/interpreter using a distinct key, then clear.
                for _ in range(16): http(p, 'GET', '/products/0?cache=off')
                for mode in ('OFF', 'MISS', 'HIT'):
                    if mode == 'MISS':
                        for i in range(512): s.call('DELETE', 'product%3A'+str(i))
                    before = json.loads(http(p, 'GET', '/stats')[1])
                    barrier = threading.Barrier(concurrency+1)
                    def worker(index):
                        c = client.HTTPConnection('127.0.0.1', p, timeout=15)
                        samples=[];failed=0;sources={};barrier.wait()
                        try:
                            for i in range(index, 512, concurrency):
                                start=time.perf_counter_ns()
                                c.request('GET', '/products/'+str(i)+'?cache='+('off' if mode=='OFF' else 'on'))
                                r=c.getresponse();body=r.read()
                                samples.append((time.perf_counter_ns()-start)/1e6)
                                if r.status != 200 or json.loads(body)!=dataset[i]: failed+=1
                                source=r.getheader('X-Data-Source');sources[source]=sources.get(source,0)+1
                        finally:c.close()
                        return samples,failed,sources
                    with concurrent.futures.ThreadPoolExecutor(concurrency) as pool:
                        fs=[pool.submit(worker,i) for i in range(concurrency)]
                        begin=time.perf_counter();barrier.wait();result=[f.result() for f in fs];elapsed=time.perf_counter()-begin
                    after=json.loads(http(p,'GET','/stats')[1])
                    samples=[x for r in result for x in r[0]]
                    row=dict(group=mode,concurrency=concurrency,requests=len(samples),unique_keys=512,
                             failures=sum(r[1] for r in result),origin=after['origin']-before['origin'],
                             hit=after['hit']-before['hit'],miss=after['miss']-before['miss'],rps=round(512/elapsed,2),**quantiles(samples))
                    assert row['failures']==0
                    assert row['origin']==(0 if mode=='HIT' else 512)
                    rows.append(row);print(json.dumps(row),flush=True)
            finally:api.terminate();api.wait();s.close()
    return rows


def engine_bench():
    rows=[]
    for condition in ('baseline','rehash','append_delay','fsync_delay'):
        with tempfile.TemporaryDirectory() as d:
            args=[]
            if condition=='append_delay':args=['--append-delay-ms','50']
            if condition=='fsync_delay':args=['--sync-delay-ms','1500']
            s=Server(BINARY,d,*args)
            try:
                for i in range(3):s.call('PUT','read'+str(i),{'value':'v'*64})
                if condition=='fsync_delay':wait_for(lambda:s.event('sync_start 3'))
                writer=condition in ('rehash','append_delay')
                barrier=threading.Barrier(9+int(writer))
                origin=dict(wall_ms=time.time_ns()/1e6,monotonic_ns=time.perf_counter_ns())
                spans=[];put_spans=[];lock=threading.Lock()
                def reader(index):
                    c=client.HTTPConnection('127.0.0.1',s.port,timeout=15)
                    local=[];fail=0;barrier.wait()
                    try:
                        for i in range(200):
                            time.sleep(max(0, experiment_start + i*.005 - time.perf_counter()))
                            a=time.perf_counter_ns();c.request('GET','/keys/read'+str(i%3));r=c.getresponse();r.read();b=time.perf_counter_ns()
                            local.append((a,b));fail+=r.status!=200
                    finally:c.close()
                    with lock:spans.extend(local)
                    return fail
                def writes():
                    barrier.wait()
                    for i in range(600 if condition=='rehash' else 12):
                        if condition=='rehash':time.sleep(max(0,experiment_start+i*.0015-time.perf_counter()))
                        a=time.perf_counter_ns();status=s.call('PUT','write'+str(i),{'value':'w'*64})[0];b=time.perf_counter_ns()
                        assert status==204;put_spans.append((a,b))
                with concurrent.futures.ThreadPoolExecutor(9) as pool:
                    fs=[pool.submit(reader,i) for i in range(8)]
                    fw=pool.submit(writes) if writer else None
                    experiment_start=time.perf_counter()
                    barrier.wait();failed=sum(f.result() for f in fs)
                    if fw:fw.result()
                    time.sleep(max(0,experiment_start+2-time.perf_counter()))
                    window_ms=(time.perf_counter()-experiment_start)*1000
                samples=[(b-a)/1e6 for a,b in spans]
                overlaps=sum(any(a<d and b>c for c,d in put_spans) for a,b in spans)
                s.close()
                row=dict(condition=condition,window_ms=round(window_ms,3),concurrency=8,requests=len(samples),failures=failed,
                         gets_overlapping_put=overlaps,put_count=len(put_spans),
                         put_latency=quantiles([(b-a)/1e6 for a,b in put_spans]) if put_spans else None,
                         injection_ms=50 if condition=='append_delay' else 1500 if condition=='fsync_delay' else 0,
                         **quantiles(samples),server_log=s.log.read_text(),
                         events=s.events.read_text() if s.events.exists() else '',
                         timeline=dict(origin=origin,get=spans,put=put_spans))
                assert not failed
                if writer:assert overlaps>0
                if condition=='rehash':assert 'rehash starts=' in row['server_log']
                rows.append(row);print(json.dumps({k:v for k,v in row.items() if k not in ('events','timeline')}),flush=True)
            finally:s.close()
    return rows


if __name__=='__main__':
    result=dict(environment=dict(platform=platform.platform(),python=platform.python_version(),
                                 compiler=subprocess.check_output(['clang++','--version'],text=True),
                                 cpu=subprocess.check_output(['/usr/sbin/sysctl','-n','machdep.cpu.brand_string'],text=True).strip() if sys.platform=='darwin' else platform.processor(),
                                 build='C++20 -O2 -g; single run; nearest rank; HTTP keep-alive'),
                product=api_bench(),engine=engine_bench())
    out=ROOT/'benchmarks/results.json';out.write_text(json.dumps(result,indent=2))
    print('Saved',out)
