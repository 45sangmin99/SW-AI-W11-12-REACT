"""Two real C DBMS processes plus Python routes; no live game data is touched."""
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


spec = importlib.util.spec_from_file_location('item_api_dev_server_test', Path(__file__).resolve().parents[1] / 'dev_server.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
PROGRESS = dict(stage=3, kills=25, lungmenDollars=25, attackLevel=4, speedLevel=5, skillLevel=2, healthLevel=3, moveLevel=6)


class Client:
    def __init__(self, address):
        self.address = address
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(self.cookies))

    def call(self, path, method='GET', body=None, headers=None):
        if body is not None and not isinstance(body, bytes):
            body = json.dumps(body).encode()
        request = urllib.request.Request(self.address + path, data=body, method=method, headers={'Content-Type': 'application/json', **(headers or {})})
        try:
            response = self.opener.open(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read()), response.headers

    @property
    def profile(self):
        return next(cookie.value for cookie in self.cookies if cookie.name == module.GAME_SHARED_COOKIE)


class ZeroRolls:
    def randrange(self, stop):
        return 0


class QuietHandler(module.DevHandler):
    def log_message(self, *_args):
        pass


class ItemAPITest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='items-python-api-')
        cls.path = Path(cls.temp.name)
        cls.progress_runtime = module.GameDBRuntime(cls.path / 'progress').start()
        try:
            cls.items_runtime = module.GameDBRuntime(cls.path / 'items', items=True).start()
            handler = functools.partial(QuietHandler, directory=cls.temp.name, game_store=cls.progress_runtime.store, item_store=cls.items_runtime.store)
            cls.server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
            cls.address = 'http://127.0.0.1:' + str(cls.server.server_address[1])
            cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
            cls.thread.start()
        except BaseException:
            cls.progress_runtime.close()
            if hasattr(cls, 'items_runtime'):
                cls.items_runtime.close()
            cls.temp.cleanup()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join(timeout=10)
        cls.items_runtime.close(); cls.progress_runtime.close(); cls.temp.cleanup()

    def setUp(self):
        self.a, self.b = Client(self.address), Client(self.address)
        self.assertEqual(self.a.call('/api/game/progress')[0], 200)
        self.assertEqual(self.b.call('/api/game/progress')[0], 200)
        self.items_runtime.store._rng = ZeroRolls()

    def inventory(self, client, query=''):
        status, body, _ = client.call('/api/items/inventory' + query)
        self.assertEqual(status, 200, body)
        return body

    def post(self, client, path, body, expected=200):
        status, response, _ = client.call(path, 'POST', body)
        self.assertEqual(status, expected, response)
        return response

    def test_two_players_filters_equipment_and_atomic_barter(self):
        status, saved, _ = self.a.call('/api/game/progress', 'PUT', {'revision': 0, 'progress': PROGRESS})
        self.assertEqual(status, 200, saved)
        inventory_a, inventory_b = self.inventory(self.a), self.inventory(self.b)
        item_a, item_b = inventory_a['items'][0]['id'], inventory_b['items'][0]['id']
        self.assertEqual(len(inventory_a['items']), 1)
        self.assertNotEqual(inventory_a['player']['code'], inventory_b['player']['code'])
        filtered = self.inventory(self.a, '?rarity=epic&minAttack=10&sort=attack&descending=1')
        self.assertEqual(filtered['items'], [])
        self.assertEqual(self.inventory(self.a, '?minAttack=2&sort=attack&descending=0')['items'][0]['id'], item_a)
        equipped = self.post(self.a, '/api/items/equip', {'itemId': item_a})
        self.assertEqual(equipped['commit'], 'DURABLE')
        self.assertEqual(equipped['bonuses']['attack'], 2)
        self.post(self.a, '/api/items/unequip', {'slot': 'weapon'})
        peer = self.inventory(self.a, '?partnerCode=' + inventory_b['player']['code'])
        self.assertEqual(peer['player']['code'], inventory_b['player']['code'])
        request = {'targetCode': inventory_b['player']['code'], 'giveItemId': item_a, 'wantItemId': item_b, 'requestKey': '1' * 32}
        offer = self.post(self.a, '/api/items/offers', request)['offer']
        replay = self.post(self.a, '/api/items/offers', request)['offer']
        self.assertEqual(offer['id'], replay['id'])
        self.assertEqual(self.inventory(self.a)['items'][0]['lockedByOffer'], offer['id'])
        self.assertIsNone(self.inventory(self.b)['items'][0]['lockedByOffer'])
        self.post(self.a, '/api/items/equip', {'itemId': item_a}, expected=409)
        self.post(self.a, '/api/items/offers/' + offer['id'] + '/accept', {}, expected=403)
        status, incoming, _ = self.b.call('/api/items/offers')
        self.assertEqual(status, 200, incoming)
        self.assertEqual(incoming['offers'][0]['direction'], 'incoming')
        accepted = self.post(self.b, '/api/items/offers/' + offer['id'] + '/accept', {})
        self.assertEqual(accepted['offer']['status'], 'accepted')
        self.assertEqual(accepted['commit'], 'DURABLE')
        self.post(self.b, '/api/items/offers/' + offer['id'] + '/accept', {})
        self.assertEqual([item['id'] for item in self.inventory(self.a)['items']], [item_b])
        self.assertEqual([item['id'] for item in self.inventory(self.b)['items']], [item_a])
        progress_after = self.a.call('/api/game/progress')[1]
        self.assertEqual(progress_after, {**saved, 'commit': 'NOT_COMMITTED'})
        for response in (inventory_a, inventory_b, peer, incoming, accepted):
            self.assertNotIn(self.a.profile, json.dumps(response))
            self.assertNotIn(self.b.profile, json.dumps(response))

    def test_drop_replay_and_cancel(self):
        inventory_a, inventory_b = self.inventory(self.a), self.inventory(self.b)
        first = self.post(self.a, '/api/items/drop', {'stage': 1, 'enemy': 1})
        second = self.post(self.a, '/api/items/drop', {'stage': 1, 'enemy': 1})
        self.assertTrue(first['didDrop']); self.assertFalse(first['replayed'])
        self.assertTrue(second['replayed']); self.assertEqual(first['itemId'], second['itemId'])
        self.assertEqual(len(self.inventory(self.a)['items']), 2)
        request = {'targetCode': inventory_b['player']['code'], 'giveItemId': first['itemId'], 'wantItemId': inventory_b['items'][0]['id'], 'requestKey': '2' * 32}
        offer = self.post(self.a, '/api/items/offers', request)['offer']
        cancelled = self.post(self.b, '/api/items/offers/' + offer['id'] + '/cancel', {})
        self.assertEqual(cancelled['offer']['status'], 'cancelled')
        self.assertTrue(all(item['lockedByOffer'] is None for item in self.inventory(self.a)['items']))
        self.post(self.b, '/api/items/offers/' + offer['id'] + '/accept', {}, expected=409)

    def test_invalid_routes_origins_and_inputs_have_no_writes(self):
        inventory = self.inventory(self.a)
        self.assertEqual(Client(self.address).call('/api/items/inventory')[0], 400)
        for query in ('?sort=attack%3BDELETE', '?rarity=unknown', '?minAttack=-1', '?descending=maybe', '?sort=attack&sort=health', '?profile=' + self.b.profile):
            self.assertEqual(self.a.call('/api/items/inventory' + query)[0], 400, query)
        for body in ({'stage': True, 'enemy': 1}, {'stage': 1, 'enemy': 6}, {'stage': 1, 'enemy': 1, 'sql': 'DELETE FROM instances;'}):
            self.post(self.a, '/api/items/drop', body, expected=400)
        self.assertEqual(self.a.call('/api/items/drop', 'POST', b'{"stage":1,"stage":2,"enemy":1}')[0], 400)
        self.assertEqual(self.a.call('/api/items/drop', 'POST', {'stage': 1, 'enemy': 1}, {'Origin': 'https://untrusted.invalid'})[0], 403)
        self.assertEqual(self.a.call('/api/items/inventory', 'PUT', {})[0], 404)
        self.assertEqual(self.a.call('/api/items/missing')[0], 404)
        after = self.inventory(self.a)
        self.assertEqual(after['items'], inventory['items'])
        self.assertEqual(after['player']['revision'], inventory['player']['revision'])

    def test_legacy_cookie_keeps_progress_and_migrates_path(self):
        secret_profile = 'd' * 32
        self.progress_runtime.store.save(secret_profile, 0, PROGRESS)
        legacy = Client(self.address)
        legacy.cookies.set_cookie(http.cookiejar.Cookie(version=0, name=module.GAME_COOKIE, value=secret_profile, port=None, port_specified=False, domain='127.0.0.1', domain_specified=False, domain_initial_dot=False, path='/api/game', path_specified=True, secure=False, expires=None, discard=True, comment=None, comment_url=None, rest={'HttpOnly': None}, rfc2109=False))
        self.assertEqual(legacy.call('/api/items/inventory')[0], 400)
        status, progress, headers = legacy.call('/api/game/progress')
        self.assertEqual(status, 200, progress)
        self.assertEqual(progress['progress'], PROGRESS)
        self.assertEqual(progress['revision'], 1)
        self.assertIn(module.GAME_SHARED_COOKIE + '=' + secret_profile, headers['Set-Cookie'])
        self.assertIn('Path=/api;', headers['Set-Cookie'])
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        self.assertEqual(legacy.profile, secret_profile)
        inventory = self.inventory(legacy)
        self.assertNotIn(secret_profile, json.dumps(inventory))
        self.post(legacy, '/api/items/drop', {'stage': 3, 'enemy': 1})
        self.assertEqual(legacy.call('/api/game/progress')[1], progress)


if __name__ == '__main__':
    unittest.main()
