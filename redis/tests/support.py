import http.client as http_client
import atexit
import json
import socket
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def http(p, method, path, obj=None, raw=None):
    c = http_client.HTTPConnection('127.0.0.1', p, timeout=10)
    try:
        body = raw if raw is not None else (json.dumps(obj).encode() if obj is not None else None)
        c.request(method, path, body, {'Content-Type': 'application/json'})
        r = c.getresponse()
        return r.status, r.read(), dict(r.getheaders())
    finally:
        c.close()


def wait_for(fn, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if fn():
            return
        time.sleep(.01)
    raise AssertionError('wait timeout')


class Server:
    def __init__(self, binary, directory, *args, aof=None):
        self.port = port()
        self.aof = Path(aof) if aof else Path(directory) / 'data.aof'
        self.events = Path(directory) / ('events-' + str(self.port))
        self.log = Path(directory) / ('log-' + str(self.port))
        self.out = self.log.open('wb')
        self.proc = subprocess.Popen([str(binary), '--port', str(self.port), '--aof-path', str(self.aof),
                                      '--test-hooks', '--events', str(self.events), *args], stdout=self.out, stderr=self.out)
        self.closed = False
        atexit.register(self.close)
        def ready():
            if self.proc.poll() is not None:
                raise AssertionError(self.log.read_text())
            try:
                return http(self.port, 'GET', '/keys/__ready')[0] == 404
            except OSError:
                return False
        wait_for(ready)

    def event(self, text):
        return self.events.exists() and text in self.events.read_text()

    def close(self, kill=False):
        if self.closed:
            return
        if self.proc.poll() is None:
            self.proc.kill() if kill else self.proc.terminate()
            self.proc.wait(timeout=10)
        self.out.close()
        self.closed = True
        if not kill and self.proc.returncode != 0:
            raise AssertionError("server exit " + str(self.proc.returncode) + "\n" + self.log.read_text())

    def call(self, method, key, obj=None, **kw):
        return http(self.port, method, '/keys/' + key, obj, **kw)
