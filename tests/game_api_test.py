"""Real HTTP bridge checks against the C DBMS; all data stays in temporary folders."""
import functools
import http.cookiejar
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

spec = importlib.util.spec_from_file_location('game_dev_server_test', Path(__file__).resolve().parents[1] / 'dev_server.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
PROGRESS = dict(stage=3, kills=25, lungmenDollars=25, attackLevel=4, speedLevel=5, skillLevel=2, healthLevel=3, moveLevel=6)

class Client:
    def __init__(self, address):
        self.address = address
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(self.cookies))
    def call(self, method='GET', body=None, headers=None):
        if body is not None and not isinstance(body, bytes):
            body = json.dumps(body).encode()
        h = {'Content-Type': 'application/json'}
        h.update(headers or {})
        request = urllib.request.Request(self.address + module.GAME_API, data=body, method=method, headers=h)
        try:
            response = self.opener.open(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read()), response.headers

class GameAPITest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='mini-game-api-')
        cls.data = Path(cls.temp.name) / 'db'
        cls.runtime = module.GameDBRuntime(cls.data).start()
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(module.DevHandler, directory=cls.temp.name, game_store=cls.runtime.store))
        cls.address = 'http://127.0.0.1:' + str(cls.server.server_address[1])
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join(timeout=10)
        cls.runtime.close(); cls.temp.cleanup()
    def setUp(self):
        self.client = Client(self.address)
    def test_save_load_and_stale_revision(self):
        status, body, headers = self.client.call()
        self.assertEqual(status, 200); self.assertIsNone(body['progress']); self.assertEqual(body['revision'], 0)
        self.assertIn('HttpOnly', headers['Set-Cookie']); self.assertIn('SameSite=Strict', headers['Set-Cookie'])
        status, body, _ = self.client.call('PUT', dict(revision=0, progress=PROGRESS))
        self.assertEqual(status, 200, body); self.assertEqual(body['commit'], 'DURABLE'); self.assertEqual(body['revision'], 1)
        status, body, _ = self.client.call()
        self.assertEqual(body['progress'], PROGRESS)
        status, body, _ = self.client.call('PUT', dict(revision=0, progress={**PROGRESS, 'kills': 999}))
        self.assertEqual(status, 409, body); self.assertEqual(body['commit'], 'NOT_COMMITTED')
        self.assertEqual(self.client.call()[1]['progress'], PROGRESS)
        self.assertIsNone(Client(self.address).call()[1]['progress'])
    def test_input_and_origin_rejection(self):
        self.client.call()
        for field, value in [('stage', True), ('kills', -1), ('attackLevel', 11), ('healthLevel', 101), ('speedLevel', '9'), ('lungmenDollars', 2**53), ('moveLevel', "1);DELETE FROM game_progress;")]:
            status, body, _ = self.client.call('PUT', dict(revision=0, progress={**PROGRESS, field:value}))
            self.assertEqual(status, 400, (field,body))
        self.assertEqual(self.client.call('PUT', b'{"revision":0,"revision":0,"progress":{}}')[0], 400)
        self.assertEqual(self.client.call('PUT', b'{"sql":"SELECT * FROM game_progress;"}')[0], 400)
        self.assertEqual(self.client.call('PUT', dict(revision=0, progress=PROGRESS), {'Origin':'http://untrusted.invalid'})[0], 403)
        self.assertEqual(Client(self.address).call('PUT', dict(revision=0, progress=PROGRESS))[0], 400)
        self.assertIsNone(self.client.call()[1]['progress'])
    def test_restart_and_unavailable_are_explicit(self):
        self.client.call()
        self.assertEqual(self.client.call('PUT', dict(revision=0, progress=PROGRESS))[0], 200)
        self.__class__.runtime.close()
        try:
            status, body, _ = self.client.call()
            self.assertEqual(status, 503, body); self.assertFalse(body['ok'])
        finally:
            self.__class__.runtime = module.GameDBRuntime(self.data).start()
            self.server.RequestHandlerClass = functools.partial(module.DevHandler, directory=self.temp.name, game_store=self.runtime.store)
        status, body, _ = self.client.call()
        self.assertEqual(status, 200, body); self.assertEqual(body['progress'], PROGRESS); self.assertEqual(body['revision'], 1)
    def test_data_not_inside_static_roots(self):
        for root in (module.ROOT,module.MINI_ROOT):
            with self.assertRaises(RuntimeError):
                module.GameDBRuntime(root / '.hidden-db').start()

if __name__=='__main__':unittest.main()
