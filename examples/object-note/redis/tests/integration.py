#!/usr/bin/env python3
import concurrent.futures
import http.client as http_client
import json
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zlib
from support import Server, ROOT, http, port, wait_for

BINARY = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / 'build/mini-redis').resolve()
passed = []


def check(name, fn):
    fn()
    passed.append(name)
    print('PASS', name, flush=True)


def contract():
    with tempfile.TemporaryDirectory() as d:
        s = Server(BINARY, d)
        try:
            value = 'hello\n"\\😀'
            assert s.call('PUT', 'a%2Fttl', {'value': value})[0] == 204
            assert json.loads(s.call('GET', 'a%2Fttl')[1]) == {'value': value}
            assert json.loads(s.call('GET', 'a%2Fttl/ttl')[1]) == {'ttl_seconds': None}
            unchanged = s.aof.stat().st_size
            for body in ['', '{}', '{', '{"value":1}', '{"value":"x","value":"y"}',
                         '{"value":"\\ud800"}', '{"value":"x","extra":1}']:
                assert s.call('PUT', 'invalid', raw=body.encode())[0] == 400, body
            for ttl in ['0', '-1', '1.5', '1e2', '"1"', 'null', 'true', '9223372036854775808']:
                assert s.call('PUT', 'invalid', raw=('{"value":"x","ttl_seconds":'+ttl+'}').encode())[0] == 400
            assert s.aof.stat().st_size == unchanged
            assert s.call('GET', 'invalid')[0] == 404
            assert s.call('PUT', 'empty', {'value': ''})[0] == 204
            assert json.loads(s.call('GET', 'empty')[1])['value'] == ''
            assert s.call('PUT', 't', {'value': 'x', 'ttl_seconds': 1})[0] == 204
            assert json.loads(s.call('GET', 't/ttl')[1])['ttl_seconds'] == 1
            time.sleep(1.08)
            assert s.call('GET', 't')[0] == s.call('GET', 't/ttl')[0] == 404
            s.call('PUT', 't', {'value': 'x', 'ttl_seconds': 1})
            s.call('PUT', 't', {'value': 'y'})
            assert json.loads(s.call('GET', 't/ttl')[1])['ttl_seconds'] is None
            assert s.call('DELETE', 't')[0] == 204
            for method, key in [('GET', 't'), ('DELETE', 't'), ('GET', 't/ttl')]:
                assert s.call(method, key)[0] == 404
            for key in ['%xx', '%', '%00', 'x'*513, '%ff']:
                assert s.call('GET', key)[0] == 400
            assert s.call('POST', 'x')[0] == 405
            before = s.aof.stat().st_size
            assert s.call('DELETE', 'missing')[0] == 404
            assert s.aof.stat().st_size == before
        finally:
            s.close()


def raw_http():
    with tempfile.TemporaryDirectory() as d:
        s = Server(BINARY, d, '--idle-seconds', '1')
        try:
            sock = socket.create_connection(('127.0.0.1', s.port))
            data = b'PUT /keys/a HTTP/1.1\r\nHost: x\r\nContent-Length: 13\r\n\r\n{"value":"x"}'
            for i in range(0, len(data), 3):
                sock.sendall(data[i:i+3])
            stream = sock.makefile('rb')
            r = http_client.HTTPResponse(sock)
            r.begin()
            assert r.status == 204
            r.read()
            sock.sendall((b'GET /keys/a HTTP/1.1\r\nHost: x\r\n\r\n')*10)
            for _ in range(10):
                # use one buffered reader to preserve pipelined bytes
                line = stream.readline()
                assert b'200' in line, line
                headers = {}
                while True:
                    line = stream.readline()
                    if line == b'\r\n': break
                    k, v = line.decode().split(':', 1)
                    headers[k.lower()] = v.strip()
                assert json.loads(stream.read(int(headers['content-length']))) == {'value': 'x'}
            stream.close();sock.close()
            cases = [b'Content-Length: 1\r\nContent-Length: 2\r\n', b'Transfer-Encoding: chunked\r\n',
                     b'Content-Length: -1\r\n', b'Bad Header: x\r\n', b'Content-Length: 2000000\r\n']
            for h in cases:
                with socket.create_connection(('127.0.0.1', s.port)) as c:
                    c.sendall(b'PUT /keys/a HTTP/1.1\r\nHost: x\r\n'+h+b'\r\n')
                    assert b' 4' in c.recv(4096).split(b'\r\n')[0]
            with socket.create_connection(('127.0.0.1', s.port)) as c:
                c.sendall(b'PUT /keys/a HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{')
                c.shutdown(socket.SHUT_WR)
                assert b' 400 ' in c.recv(4096)
            slow = socket.create_connection(('127.0.0.1', s.port))
            slow.sendall(b'PUT /keys/slow HTTP/1.1\r\nHost: x\r\nContent-Length: 20\r\n\r\n{')
            assert s.call('GET', 'a')[0] == 200
            time.sleep(1.2)
            assert slow.recv(100) == b''
            slow.close()
            assert s.call('GET', 'a')[0] == 200
        finally:
            s.close()


def backpressure_limits():
    with tempfile.TemporaryDirectory() as d:
        s = Server(BINARY, d, '--idle-seconds', '1', '--max-connections', '8')
        stalled = []
        try:
            assert s.call('PUT', 'big', {'value': 'x'*800000})[0] == 204
            assert s.call('PUT', 'small', {'value': 'ok'})[0] == 204
            for _ in range(3):
                c = socket.create_connection(('127.0.0.1', s.port))
                c.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
                c.sendall(b'GET /keys/big HTTP/1.1\r\nHost: x\r\n\r\n'*20)
                stalled.append(c)
            start = time.monotonic()
            assert s.call('GET', 'small')[0] == 200
            assert time.monotonic()-start < 1
            with socket.create_connection(('127.0.0.1', s.port)) as c:
                c.sendall(b'GET /keys/a HTTP/1.1\r\nHost: x\r\nLong: '+b'x'*17000)
                assert b' 431 ' in c.recv(4096)
            for c in stalled:c.close()
            stalled.clear()
            for _ in range(8):
                c=socket.create_connection(('127.0.0.1',s.port))
                c.sendall(b'G')
                stalled.append(c)
            time.sleep(.1)
            with socket.create_connection(('127.0.0.1',s.port)) as extra:
                extra.settimeout(2)
                try:
                    extra.sendall(b'GET /keys/small HTTP/1.1\r\nHost: x\r\n\r\n')
                    assert extra.recv(100)==b''
                except ConnectionResetError:
                    pass
            for c in stalled:c.close()
            stalled.clear()
            time.sleep(.1)
            assert s.call('GET','small')[0]==200
        finally:
            for c in stalled:c.close()
            s.close()


def concurrency():
    with tempfile.TemporaryDirectory() as d:
        s = Server(BINARY, d)
        try:
            values = ['initial'] + [str(i)+':'+chr(65+i)*10000 for i in range(8)]
            s.call('PUT', 'race', {'value': values[0]})
            barrier = threading.Barrier(17)
            def writer(i):
                barrier.wait()
                for _ in range(20):
                    assert s.call('PUT', 'race', {'value': values[i+1]})[0] == 204
            def reader():
                barrier.wait()
                for _ in range(60):
                    status, body, _ = s.call('GET', 'race')
                    assert status == 200 and json.loads(body)['value'] in values
            with concurrent.futures.ThreadPoolExecutor(16) as ex:
                fs = [ex.submit(writer, i) for i in range(8)] + [ex.submit(reader) for _ in range(8)]
                barrier.wait()
                for f in fs: f.result()
            assert s.call('DELETE', 'race')[0] == 204
            with concurrent.futures.ThreadPoolExecutor(8) as ex:
                assert all(x == 404 for x in ex.map(lambda _: s.call('GET', 'race')[0], range(80)))
        finally:
            s.close()


def recovery():
    with tempfile.TemporaryDirectory() as d:
        s = Server(BINARY, d)
        s.call('PUT', 'a', {'value': 'A'})
        s.call('PUT', 'b', {'value': 'B'})
        s.call('DELETE', 'b')
        s.call('PUT', 'ttl', {'value': 'T', 'ttl_seconds': 3})
        wait_for(lambda: s.event('sync_done 4'))
        s.close(kill=True)
        time.sleep(1.1)
        s = Server(BINARY, d)
        assert s.call('GET', 'a')[0] == 200 and s.call('GET', 'b')[0] == 404
        assert json.loads(s.call('GET', 'ttl/ttl')[1])['ttl_seconds'] <= 1
        s.close()
        time.sleep(1.1)
        s = Server(BINARY, d)
        assert s.call('GET', 'ttl')[0] == 404
        s.close()
        path = Path(d)/'data.aof'
        valid = path.read_bytes()
        # valid header + partial body of next record
        path.write_bytes(valid + b'MRD1' + struct.pack('<I', 80) + b'123')
        s = Server(BINARY, d)
        assert 'tail repaired bytes=11' in s.log.read_text()
        assert path.stat().st_size == len(valid)
        assert s.call('GET', 'a')[0] == 200
        assert s.call('PUT', 'new', {'value': 'ok'})[0] == 204
        s.close()
        s = Server(BINARY, d)
        assert json.loads(s.call('GET', 'new')[1])['value'] == 'ok'
        s.close()
        # Full valid next header + body with only the CRC tail missing.
        blob=path.read_bytes();record=bytearray(blob[len(valid):])
        struct.pack_into('<Q',record,12,6)
        struct.pack_into('<I',record,8,zlib.crc32(record[:8]+record[12:37]))
        struct.pack_into('<I',record,len(record)-4,zlib.crc32(record[:-4]))
        path.write_bytes(blob+record[:-2])
        s=Server(BINARY,d)
        assert 'tail repaired bytes='+str(len(record)-2) in s.log.read_text()
        assert path.read_bytes()==blob
        assert s.call('GET','new')[0]==200
        # second writer rejects locked AOF
        p = subprocess.run([str(BINARY), '--aof-path', str(path)], capture_output=True, timeout=3)
        assert p.returncode != 0 and b'locked' in p.stderr
        s.close()
        damaged = bytearray(path.read_bytes());damaged[38] ^= 1;path.write_bytes(damaged)
        p = subprocess.run([str(BINARY), '--aof-path', str(path)], capture_output=True, timeout=3)
        assert p.returncode != 0 and b'checksum' in p.stderr
        bad_length = bytearray(valid);bad_length[5] ^= 1;path.write_bytes(bad_length)
        p = subprocess.run([str(BINARY), '--aof-path', str(path)], capture_output=True, timeout=3)
        assert p.returncode != 0 and b'header checksum' in p.stderr
        assert path.read_bytes() == bytes(bad_length)


def interrupted_repair():
    with tempfile.TemporaryDirectory() as d:
        s=Server(BINARY,d)
        s.call('PUT','a',{'value':'A'});s.close()
        path=Path(d)/'data.aof';valid=path.read_bytes()
        path.write_bytes(valid+b'MRD1'+struct.pack('<I',80)+b'123')
        events=Path(d)/'repair-events'
        proc=subprocess.Popen([str(BINARY),'--aof-path',str(path),'--port',str(port()),
                               '--test-hooks','--events',str(events),'--repair-delay-ms','1000'],
                              stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        try:
            wait_for(lambda:events.exists() and 'repair_truncated' in events.read_text())
            proc.kill();proc.wait()
            assert path.read_bytes()==valid
            s=Server(BINARY,d)
            assert s.call('GET','a')[0]==200
            assert s.call('PUT','b',{'value':'B'})[0]==204
            s.close()
            s=Server(BINARY,d)
            assert s.call('GET','a')[0]==s.call('GET','b')[0]==200
            s.close()
        finally:
            if proc.poll() is None:proc.kill();proc.wait()


def faults():
    for fail in ('0', '12'):
        with tempfile.TemporaryDirectory() as d:
            s = Server(BINARY, d, '--fail-write-after', fail)
            assert s.call('PUT', 'bad', {'value': 'x'})[0] == 503
            assert s.call('GET', 'bad')[0] == 404
            assert s.call('PUT', 'later', {'value': 'y'})[0] == 503
            s.close()
            s = Server(BINARY, d)
            assert s.call('GET', 'bad')[0] == 404
            s.close()
    with tempfile.TemporaryDirectory() as d:
        s = Server(BINARY, d, '--fail-sync', '1')
        assert s.call('PUT', 'a', {'value': 'x'})[0] == 204
        wait_for(lambda: s.event('sync_error'))
        assert s.call('PUT', 'b', {'value': 'y'})[0] == 503
        assert s.call('GET', 'a')[0] == 200
        s.close()
    with tempfile.TemporaryDirectory() as d:
        s = Server(BINARY, d, '--memory-limit', '100')
        before = s.aof.stat().st_size
        assert s.call('PUT', 'large', {'value': 'x'*200})[0] == 503
        assert s.aof.stat().st_size == before
        assert s.call('GET', 'large')[0] == 404
        s.close()

    # Failure published by fsync while a second append is already in flight.
    with tempfile.TemporaryDirectory() as d:
        s = Server(BINARY, d, '--append-delay-ms', '1200', '--fail-sync', '1')
        try:
            assert s.call('PUT', 'a', {'value': 'first'})[0] == 204
            assert s.call('PUT', 'b', {'value': 'inflight'})[0] == 503
            assert s.event('sync_error')
            # The failed request may already have committed; never claim rollback.
            assert s.call('GET', 'b')[0] == 200
            assert s.call('PUT', 'c', {'value': 'blocked'})[0] == 503
        finally:
            s.close()


def prepare_and_short_write():
    with tempfile.TemporaryDirectory() as d:
        s = Server(BINARY, d, '--fail-prepare', '1')
        before = s.aof.stat().st_size
        assert s.call('PUT', 'a', {'value': 'x'})[0] == 503
        assert s.aof.stat().st_size == before
        assert s.call('GET', 'a')[0] == 404
        s.close()
        s = Server(BINARY, d, '--write-chunk-size', '3')
        assert s.call('PUT', 'a', {'value': 'short write complete'})[0] == 204
        s.close()
        s = Server(BINARY, d)
        assert json.loads(s.call('GET', 'a')[1])['value'] == 'short write complete'
        s.close()


def kill_during_append():
    with tempfile.TemporaryDirectory() as d:
        s = Server(BINARY, d, '--append-delay-ms', '500')
        s.call('PUT', 'a', {'value': 'durable'})
        wait_for(lambda: s.event('sync_done 1'))
        with concurrent.futures.ThreadPoolExecutor(1) as ex:
            future = ex.submit(s.call, 'PUT', 'b', {'value': 'inflight'})
            wait_for(lambda: s.event('append_start 2'))
            s.close(kill=True)
            try:
                future.result()
                raise AssertionError('expected dropped response')
            except (OSError, http_client.HTTPException):
                pass
        s = Server(BINARY, d)
        assert s.call('GET', 'a')[0] == 200
        assert s.call('GET', 'b')[0] == 404
        s.close()


def sync_overlap():
    with tempfile.TemporaryDirectory() as d:
        s = Server(BINARY, d, '--sync-delay-ms', '1500')
        try:
            assert s.call('PUT', 'a', {'value': 'A'})[0] == 204
            assert not s.event('sync_done 1')
            wait_for(lambda: s.event('sync_start 1'))
            start = time.monotonic()
            assert s.call('GET', 'a')[0] == 200
            assert time.monotonic()-start < .8
            assert not s.event('sync_done 1')
            assert s.call('PUT', 'b', {'value': 'B'})[0] == 204
            wait_for(lambda: s.event('sync_done 1'))
            assert not s.event('sync_done 2')
            wait_for(lambda: s.event('sync_done 2'))
            s.close(kill=True)
            s = Server(BINARY, d)
            assert s.call('GET', 'a')[0] == s.call('GET', 'b')[0] == 200
        finally:
            s.close()


def append_overlap():
    with tempfile.TemporaryDirectory() as d:
        s = Server(BINARY, d, '--append-delay-ms', '100')
        try:
            s.call('PUT', 'a', {'value': 'A'})
            done = threading.Event()
            def put():
                assert s.call('PUT', 'b', {'value': 'B'})[0] == 204
                done.set()
            t = threading.Thread(target=put);t.start()
            wait_for(lambda: s.event('append_start 2'))
            start = time.monotonic()
            assert s.call('GET', 'a')[0] == 200
            elapsed = time.monotonic()-start
            t.join();assert done.is_set() and elapsed > .05, elapsed
        finally:
            s.close()


def products():
    with tempfile.TemporaryDirectory() as d:
        s = Server(BINARY, d)
        p = port()
        api = subprocess.Popen([sys.executable, str(ROOT/'example/product_api.py'), '--port', str(p), '--redis-port', str(s.port), '--ttl', '1'])
        try:
            def ready():
                try: return http(p, 'GET', '/stats')[0] == 200
                except OSError: return False
            wait_for(ready)
            def product(mode='on'): return http(p, 'GET', '/products/1001?cache='+mode)
            a = product();b = product()
            assert a[0] == b[0] == 200 and a[1] == b[1]
            assert a[2]['X-Data-Source'] == 'origin' and b[2]['X-Data-Source'] == 'redis'
            assert json.loads(http(p, 'GET', '/stats')[1])['origin'] == 1
            time.sleep(1.1)
            assert product()[2]['X-Data-Source'] == 'origin'
            assert s.call('DELETE', 'product%3A1001')[0] == 204
            assert product()[2]['X-Data-Source'] == 'origin'
            assert json.loads(http(p, 'GET', '/stats')[1])['origin'] == 3
            assert product('off')[1] == a[1]
            s.call('PUT', 'product%3A1001', {'value': json.dumps({'id': '1001', 'name': 'new', 'price': 1})})
            assert json.loads(product()[1])['name'] == 'new'
            s.close()
            assert product()[0] == 502
        finally:
            api.terminate();api.wait();s.close()


if __name__ == '__main__':
    for name, fn in [('http_contract', contract), ('streaming_keepalive_isolation', raw_http),
                     ('backpressure_connection_limits', backpressure_limits),
                     ('concurrent_linearization', concurrency), ('recovery_sigkill_tail_corruption_lock', recovery),
                     ('interrupted_tail_repair', interrupted_repair),
                     ('write_sync_memory_failures', faults),
                     ('prepare_failure_short_writes', prepare_and_short_write),
                     ('sigkill_during_append', kill_during_append), ('fsync_watermark_overlap', sync_overlap),
                     ('append_blocks_get', append_overlap), ('product_cache_scenarios', products)]:
        check(name, fn)
    print(f'{len(passed)} integration groups PASS')
