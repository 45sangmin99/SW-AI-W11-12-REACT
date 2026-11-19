"""Run with `python3 dev_server.py`; reload the browser after source changes."""

import argparse
import hashlib
import http.cookies
import importlib.util
import io
import json
import os
import re
import secrets
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit


ROOT = Path(__file__).resolve().parent
WATCHED_EXTENSIONS = {'.html', '.css', '.js', '.mjs', '.json', '.svg'}
IGNORED_DIRECTORIES = {'.git', '.venv', '__pycache__', 'node_modules'}
VERSION_PATH = '/__dev_version'
# This example has its own API server. Expose only its sample pages and assets here.
VOC_ROOT = ROOT / 'examples' / 'object-note'
VOC_FILES = {'index.html', 'home.html', 'flow.html', 'voc.html', 'test.html',
             'data/inquiries.sample.json', 'status.json'}
VOC_ASSET_DIRS = {'css', 'src', 'tests'}
MINI_PREFIX = '/mini-project/'
MINI_ROOT = ROOT.parent / 'Mini Project'
ENGINE_PREFIX = '/engine-runtime/'
ENGINE_WEB = Path(os.environ.get('CHARACTER_ENGINE_WEB', '/Users/sangmin/dev/engine/runtime/web'))
GAME_API = '/api/game/progress'
GAME_COOKIE = 'mini_game_profile'
GAME_SHARED_COOKIE = 'mini_game_profile_v2'
DEFAULT_GAME_DB = Path.home() / '.local' / 'share' / 'mini-dbms' / 'mini-project'


def engine_file(request_path, engine_web):
    """Expose only runtime modules, WASM, explicit character assets and their PNG art."""
    if not request_path.startswith(ENGINE_PREFIX):
        return None
    relative = unquote(request_path[len(ENGINE_PREFIX):])
    parts = Path(relative).parts
    if not parts or any(part in ('.', '..') or part.startswith('.') for part in parts):
        return None
    allowed = (
        re.fullmatch(r'[A-Za-z0-9_-]+\.js', relative)
        or relative == 'surface.wasm'
        or re.fullmatch(r'environments/lungmen/(environment\.json|[A-Za-z0-9_-]+\.png)', relative)
        or re.fullmatch(r'direction-examples/chongyue/source/skill1-effects/(effect-bundle|effect-source|effect-animation|effect-meshes|shader-programs)\.json', relative)
        or re.fullmatch(r'examples/(amiya|ayerscarpe|chongyue|shu|wang|originium-slug|basic-soldier|basic-crossbowman|crossbow-projectile)/surfaces\.json', relative)
        or re.fullmatch(r'direction-examples/(amiya|ayerscarpe|chongyue|shu|wang|originium-slug|basic-soldier|basic-crossbowman)/[^\\]+\.png', relative)
    )
    if not allowed:
        return None
    root = Path(engine_web).resolve()
    path = (root / relative).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        return None
    return path if path.is_file() else None


def mini_project_file(request_path, mini_root=MINI_ROOT):
    if not request_path.startswith(MINI_PREFIX):
        return None
    relative = unquote(request_path[len(MINI_PREFIX):]) or 'index.html'
    if any(part.startswith('.') for part in Path(relative).parts):
        return None
    root = Path(mini_root).resolve()
    path = (root / relative).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        return None
    if path.suffix not in {'.html', '.js', '.css', '.png'}:
        return None
    return path if path.is_file() else None


def source_version():
    """Fingerprint source contents, including added and deleted files."""
    digest = hashlib.sha256()
    for path in sorted([*ROOT.rglob('*'), *MINI_ROOT.rglob('*')]):
        relative = path.relative_to(ROOT.parent)
        if any(part in IGNORED_DIRECTORIES for part in relative.parts):
            continue
        if path.suffix not in WATCHED_EXTENSIONS or not path.is_file():
            continue
        try:
            contents = path.read_bytes()
        except FileNotFoundError:
            # An editor can replace a file while it is being scanned.
            continue
        digest.update(str(relative).encode())
        digest.update(b'\0')
        digest.update(hashlib.sha256(contents).digest())
    return digest.hexdigest()


def reload_script(version):
    return f"""
<script>
(() => {{
  const version = {json.dumps(version)};
  async function checkForChanges() {{
    try {{
      const response = await fetch('{VERSION_PATH}', {{ cache: 'no-store' }});
      if (response.ok && (await response.json()).version !== version) {{
        location.reload();
        return;
      }}
    }} catch {{
      // Retry when the development server becomes available again.
    }}
    setTimeout(checkForChanges, 700);
  }}
  setTimeout(checkForChanges, 700);
}})();
</script>
""".encode()


class DevHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, engine_web=ENGINE_WEB, game_store=None, item_store=None, **kwargs):
        self.engine_web = engine_web
        self.game_store = game_store
        self.item_store = item_store
        super().__init__(*args, **kwargs)

    def _game_json(self, status, payload, cookie=None):
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            pass  # A lost response does not undo a durable DB commit.

    def _game_error(self, status, code, message, commit='NOT_COMMITTED', recovery_required=False, txid=None):
        payload = {'ok': False, 'error': {'code': code, 'message': message},
                   'commit': commit, 'recovery_required': recovery_required}
        if txid is not None:
            payload['txid'] = txid
        self._game_json(status, payload)

    def _game_origin_allowed(self):
        host = self.headers.get('Host', '')
        try:
            parsed = urlsplit('http://' + host)
            port = parsed.port or 80
            if parsed.hostname not in ('localhost', '127.0.0.1') or port != self.server.server_address[1]:
                return False
            origin = self.headers.get('Origin')
            if origin:
                other = urlsplit(origin)
                if other.scheme != 'http' or other.hostname not in ('localhost', '127.0.0.1'):
                    return False
                if (other.port or 80) != port:
                    return False
            return self.headers.get('Sec-Fetch-Site') != 'cross-site'
        except ValueError:
            return False

    def _game_profile(self):
        cookies = http.cookies.SimpleCookie()
        try:
            cookies.load(self.headers.get('Cookie', ''))
        except http.cookies.CookieError:
            return None
        morsel = cookies.get(GAME_SHARED_COOKIE) or cookies.get(GAME_COOKIE)
        value = morsel.value if morsel else ''
        return value if re.fullmatch(r'[0-9a-f]{32}', value) else None

    def _game_request(self, saving):
        if not self._game_origin_allowed():
            self._game_error(403, 'ERR_ORIGIN', '같은 로컬 서버에서 요청해 주세요.')
            return
        if self.game_store is None:
            self._game_error(503, 'ERR_DB_UNAVAILABLE', '진행도 저장 서버가 연결되지 않았습니다.')
            return
        profile = self._game_profile()
        cookie = None
        if not profile:
            if saving:
                self._game_error(400, 'ERR_PROFILE', '진행도를 먼저 불러와 주세요.')
                return
            profile = secrets.token_hex(16)
            cookie = f'{GAME_SHARED_COOKIE}={profile}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=31536000'
        try:
            if saving:
                if self.headers.get('Transfer-Encoding') or len(self.headers.get_all('Content-Length', [])) != 1:
                    self._game_error(400, 'ERR_REQUEST', '올바른 요청 길이가 필요합니다.')
                    return
                length_text = self.headers.get('Content-Length', '')
                if not re.fullmatch(r'[0-9]+', length_text) or len(length_text) > 6:
                    self._game_error(400, 'ERR_REQUEST', '올바른 요청 길이가 필요합니다.')
                    return
                length = int(length_text)
                if not 1 <= length <= 4096:
                    self._game_error(413, 'ERR_LIMIT', '저장 요청이 너무 큽니다.')
                    return
                if self.headers.get_content_type() != 'application/json':
                    self._game_error(415, 'ERR_REQUEST', 'JSON 요청이 필요합니다.')
                    return
                deadline = time.monotonic() + 5
                raw = bytearray()
                while len(raw) < length:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        raise socket.timeout()
                    self.connection.settimeout(left)
                    part = self.rfile.read1(length - len(raw))
                    if not part:
                        self._game_error(400, 'ERR_REQUEST', '저장 요청이 완성되지 않았습니다.')
                        return
                    raw.extend(part)
                def unique_object(pairs):
                    value = {}
                    for key, item in pairs:
                        if key in value:
                            raise ValueError('duplicate property')
                        value[key] = item
                    return value
                payload = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object,
                                     parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
                if not isinstance(payload, dict) or set(payload) != {'revision', 'progress'}:
                    self._game_error(400, 'ERR_REQUEST', '저장 버전과 진행도가 필요합니다.')
                    return
                response = self.game_store.save(profile, payload['revision'], payload['progress'])
            else:
                response = self.game_store.load(profile)
            if not saving:
                # Migrate the old /api/game cookie without changing its profile.
                cookie = f'{GAME_SHARED_COOKIE}={profile}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=31536000'
            self._game_json(200, response, cookie)
        except (UnicodeError, ValueError, json.JSONDecodeError):
            self._game_error(400, 'ERR_REQUEST', '올바른 JSON 진행도가 필요합니다.')
        except socket.timeout:
            self._game_error(408, 'ERR_REQUEST_TIMEOUT', '요청을 읽는 시간이 초과됐습니다.')
        except Exception as error:
            status = getattr(error, 'status', 503)
            if not isinstance(status, int) or not 400 <= status <= 599:
                status = 503
            self._game_error(status, getattr(error, 'code', 'ERR_DB_UNAVAILABLE'),
                             getattr(error, 'message', '진행도를 확인하지 못했습니다.'),
                             getattr(error, 'commit', 'UNKNOWN'),
                             bool(getattr(error, 'recovery_required', False)),
                             getattr(error, 'txid', None))

    def _items_json_body(self):
        if self.headers.get('Transfer-Encoding') or len(self.headers.get_all('Content-Length', [])) != 1:
            raise ValueError('Invalid content length')
        length = self.headers.get('Content-Length', '')
        if not re.fullmatch(r'[0-9]{1,4}', length) or not 1 <= int(length) <= 4096:
            raise ValueError('Invalid content length')
        if self.headers.get_content_type() != 'application/json':
            raise ValueError('Expected JSON')
        raw = bytearray()
        deadline = time.monotonic() + 5
        while len(raw) < int(length):
            left = deadline - time.monotonic()
            if left <= 0:
                raise socket.timeout()
            self.connection.settimeout(left)
            data = self.rfile.read1(int(length) - len(raw))
            if not data:
                raise ValueError('Incomplete request')
            raw.extend(data)
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError('Duplicate key')
                result[key] = value
            return result
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=unique,
                           parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
        if not isinstance(value, dict):
            raise ValueError('Expected object')
        return value

    def _items_request(self, writing=False):
        if not self._game_origin_allowed():
            self._game_error(403, 'ERR_ORIGIN', '같은 로컬 서버에서 요청해 주세요.')
            return
        if self.item_store is None:
            self._game_error(503, 'ERR_DB_UNAVAILABLE', '아이템 저장 서버가 연결되지 않았습니다.')
            return
        profile = self._game_profile()
        if not profile:
            self._game_error(400, 'ERR_PROFILE', '진행도를 먼저 불러와 주세요.')
            return
        parsed = urlsplit(self.path)
        path = parsed.path
        try:
            if not writing:
                if path == '/api/items/inventory':
                    query = parse_qs(parsed.query, keep_blank_values=True, max_num_fields=8)
                    if set(query) - {'rarity', 'minAttack', 'sort', 'descending', 'partnerCode'} or any(len(v) != 1 for v in query.values()):
                        raise ValueError('Invalid filter')
                    kwargs = {}
                    if 'rarity' in query:
                        kwargs['rarity'] = query['rarity'][0]
                    if 'minAttack' in query:
                        minimum = query['minAttack'][0]
                        if not re.fullmatch(r'[0-9]{1,8}', minimum):
                            raise ValueError('Invalid attack filter')
                        kwargs['min_attack'] = int(minimum)
                    if 'sort' in query:
                        kwargs['sort'] = query['sort'][0]
                    if 'descending' in query:
                        if query['descending'][0] not in ('0', '1'):
                            raise ValueError('Invalid sort direction')
                        kwargs['descending'] = query['descending'][0] == '1'
                    if 'partnerCode' in query:
                        kwargs['partner_code'] = query['partnerCode'][0]
                    response = self.item_store.inventory(profile, **kwargs)
                elif path == '/api/items/offers' and not parsed.query:
                    response = self.item_store.offers(profile)
                else:
                    self._game_error(404, 'ERR_NOT_FOUND', '알 수 없는 아이템 API입니다.')
                    return
            else:
                if parsed.query:
                    raise ValueError('Unexpected query parameters')
                body = self._items_json_body()
                if path == '/api/items/drop' and set(body) == {'stage', 'enemy'}:
                    response = self.item_store.drop(profile, body['stage'], body['enemy'])
                elif path == '/api/items/equip' and set(body) == {'itemId'}:
                    response = self.item_store.equip(profile, body['itemId'])
                elif path == '/api/items/discard' and set(body) == {'itemId'}:
                    response = self.item_store.discard(profile, body['itemId'])
                elif path == '/api/items/unequip' and set(body) == {'slot'}:
                    response = self.item_store.unequip(profile, body['slot'])
                elif path == '/api/items/offers' and set(body) == {'targetCode', 'giveItemId', 'wantItemId', 'requestKey'}:
                    response = self.item_store.offer(profile, body['targetCode'], body['giveItemId'], body['wantItemId'], body['requestKey'])
                else:
                    match = re.fullmatch(r'/api/items/offers/([1-9][0-9]{0,18})/(accept|cancel)', path)
                    if not match or body:
                        raise ValueError('Unknown item request')
                    response = (self.item_store.accept if match[2] == 'accept' else self.item_store.cancel)(profile, match[1])
            self._game_json(200, response)
        except (UnicodeError, ValueError):
            self._game_error(400, 'ERR_REQUEST', '올바른 아이템 요청이 필요합니다.')
        except socket.timeout:
            self._game_error(408, 'ERR_REQUEST_TIMEOUT', '요청을 읽는 시간이 초과됐습니다.')
        except Exception as error:
            status = getattr(error, 'status', 503)
            if type(status) is not int or not 400 <= status <= 599:
                status = 503
            self._game_error(status, getattr(error, 'code', 'ERR_DB_UNAVAILABLE'),
                             getattr(error, 'message', '아이템 상태를 확인하지 못했습니다.'),
                             getattr(error, 'commit', 'UNKNOWN'),
                             bool(getattr(error, 'recovery_required', False)),
                             getattr(error, 'txid', None))

    def do_GET(self):
        if urlsplit(self.path).path == GAME_API:
            self._game_request(False)
            return
        if urlsplit(self.path).path.startswith('/api/items/'):
            self._items_request(False)
            return
        super().do_GET()

    def do_PUT(self):
        if urlsplit(self.path).path == GAME_API:
            self._game_request(True)
            return
        self._game_error(404, 'ERR_NOT_FOUND', '알 수 없는 API입니다.')

    def do_POST(self):
        if urlsplit(self.path).path.startswith('/api/items/'):
            self._items_request(True)
            return
        self._game_error(405, 'ERR_METHOD', '이 API는 GET과 PUT을 사용합니다.')

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_bytes(self, body, content_type):
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        return io.BytesIO(body)

    def send_head(self):
        request_path = urlsplit(self.path).path
        if request_path.startswith(ENGINE_PREFIX):
            path = engine_file(request_path, self.engine_web)
            if path is None:
                self.send_error(404, 'Engine resource not exposed')
                return None
            try:
                stream = path.open('rb')
            except OSError:
                self.send_error(404, 'Engine resource unavailable')
                return None
            self.send_response(200)
            self.send_header('Content-Type', 'application/wasm' if path.suffix == '.wasm' else self.guess_type(str(path)))
            self.send_header('Content-Length', str(path.stat().st_size))
            self.end_headers()
            return stream
        if request_path == VERSION_PATH:
            body = json.dumps({'version': source_version()}).encode()
            return self.send_bytes(body, 'application/json')

        if request_path == MINI_PREFIX.rstrip('/'):
            self.send_response(301)
            self.send_header('Location', MINI_PREFIX)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return None
        mini = request_path.startswith(MINI_PREFIX)
        path = mini_project_file(request_path) if mini else Path(self.translate_path(self.path))
        if path is None:
            self.send_error(404, 'Mini Project resource not exposed')
            return None
        try:
            voc_path = path.resolve().relative_to(VOC_ROOT)
        except ValueError:
            voc_path = None
        if voc_path is not None and voc_path.as_posix() not in VOC_FILES:
            if (not voc_path.parts or voc_path.parts[0] not in VOC_ASSET_DIRS
                    or path.suffix not in {'.css', '.js'} or not path.is_file()):
                self.send_error(404, 'VOC static resource not exposed')
                return None
        if path.is_dir():
            path = path / 'index.html'
        if path.suffix == '.html' and path.is_file():
            # Read the version first so edits during this request trigger a reload.
            version = source_version()
            try:
                body = path.read_bytes()
            except OSError:
                return super().send_head()
            script = reload_script(version)
            closing_tag = body.lower().rfind(b'</body>')
            if closing_tag >= 0:
                body = body[:closing_tag] + script + body[closing_tag:]
            else:
                body += script
            return self.send_bytes(body, 'text/html; charset=utf-8')
        if mini:
            try:
                stream = path.open('rb')
            except OSError:
                self.send_error(404)
                return None
            self.send_response(200)
            self.send_header('Content-Type', self.guess_type(str(path)))
            self.send_header('Content-Length', str(path.stat().st_size))
            self.end_headers()
            return stream
        return super().send_head()

    def log_message(self, format, *args):
        if urlsplit(self.path).path != VERSION_PATH:
            super().log_message(format, *args)


class GameDBRuntime:
    """Own a private C DBMS process; keep token/data outside static file roots."""
    def __init__(self, data_dir=DEFAULT_GAME_DB, port=0, items=False):
        self.data_dir = Path(data_dir).resolve()
        self.port = port
        self.items = items
        self.process = None
        self.log = None
        self.store = None

    def start(self):
        for public in (ROOT.resolve(), MINI_ROOT.resolve()):
            try:
                self.data_dir.relative_to(public)
            except ValueError:
                continue
            raise RuntimeError('DB 데이터는 정적 파일 디렉터리 밖에 보관해야 합니다.')
        implementation = MINI_ROOT / 'server' / 'game_store.py'
        spec = importlib.util.spec_from_file_location('_mini_project_game_store', implementation)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        sys.modules['game_store'] = module
        if self.items:
            spec = importlib.util.spec_from_file_location('_mini_project_item_store', MINI_ROOT / 'server' / 'item_store.py')
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)
        binary = ROOT.parent / 'SW-AI-W11-12-DBMS' / 'reliable' / 'build' / 'mini-db-server'
        if not binary.is_file():
            raise RuntimeError('DBMS 저장소에서 make를 먼저 실행해 주세요.')
        self.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        schemas = sorted((MINI_ROOT / 'server' / 'item-schemas').glob('*.schema')) if self.items else [MINI_ROOT / 'server' / 'game_progress.schema']
        if not schemas:
            raise RuntimeError('아이템 스키마가 없습니다.')
        initialized = any((self.data_dir / name).exists() for name in ('.mdb.init', '.mdb.wal', '.mdb-base', '.mdb-base.tmp'))
        for schema_path in schemas:
            schema = schema_path.read_bytes()
            destination = self.data_dir / schema_path.name
            if destination.exists():
                if destination.read_bytes() != schema:
                    raise RuntimeError('기존 DB 스키마가 현재 버전과 다릅니다.')
            elif initialized:
                raise RuntimeError('기존 DB의 필수 스키마가 없습니다.')
            else:
                with destination.open('xb') as out:
                    out.write(schema)
            csv = destination.with_suffix('.csv')
            if not csv.exists() and not initialized:
                with csv.open('xb'):
                    pass
        if not self.port:
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
                self.port = probe.getsockname()[1]
        token = secrets.token_hex(32)
        self.log = (self.data_dir / 'server.log').open('ab')
        self.process = subprocess.Popen([str(binary), '--data-dir', str(self.data_dir),
                                         '--bind', '127.0.0.1', '--port', str(self.port), '--threads', '4'],
                                        env=dict(os.environ, MINIDB_TOKEN=token),
                                        stdin=subprocess.DEVNULL, stdout=self.log, stderr=self.log)
        url = f'http://127.0.0.1:{self.port}'
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        deadline = time.monotonic() + 15
        try:
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise RuntimeError('DBMS 시작에 실패했습니다. 데이터 디렉터리의 server.log를 확인해 주세요.')
                try:
                    with opener.open(url + '/health', timeout=.5) as response:
                        if response.status == 200:
                            self.store = (module.ItemStore if self.items else module.GameStore)(url, token)
                            return self
                except (OSError, urllib.error.URLError):
                    time.sleep(.05)
            raise RuntimeError('DBMS 시작 대기 시간이 초과됐습니다.')
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        if self.log is not None:
            self.log.close()
        self.process = None
        self.log = None
        self.store = None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--engine-web', type=Path, default=ENGINE_WEB, help='Read-only character-engine runtime/web directory')
    parser.add_argument('--with-game-db', action='store_true', help='Start the private C DBMS for Mini Project progress')
    parser.add_argument('--game-db-dir', type=Path, default=DEFAULT_GAME_DB)
    parser.add_argument('--game-items-db-dir', type=Path, default=None, help='Separate item/transaction DB; defaults to a sibling of game-db-dir')
    parser.add_argument('--game-db-port', type=int, default=0, help='Private DBMS port; 0 selects an available loopback port')
    args = parser.parse_args()
    runtime = GameDBRuntime(args.game_db_dir, args.game_db_port) if args.with_game_db else None
    item_dir = args.game_items_db_dir or args.game_db_dir.with_name(args.game_db_dir.name + '-items')
    item_runtime = GameDBRuntime(item_dir, items=True) if args.with_game_db else None
    previous = signal.getsignal(signal.SIGTERM)
    def stop(signum, frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, stop)
    try:
        if runtime:
            runtime.start()
            item_runtime.start()
        handler = partial(DevHandler, directory=str(ROOT), engine_web=args.engine_web,
                          game_store=runtime.store if runtime else None,
                          item_store=item_runtime.store if item_runtime else None)
        with ThreadingHTTPServer(('127.0.0.1', args.port), handler) as server:
            print(f'Development server: http://localhost:{args.port}', flush=True)
            if runtime:
                print(f'Mini Project progress DBMS: http://127.0.0.1:{runtime.port} (server-side only)', flush=True)
                print(f'Mini Project item DBMS: http://127.0.0.1:{item_runtime.port} (server-side only)', flush=True)
            print('HTML/CSS/JS changes reload the page. Stop with Ctrl+C.', flush=True)
            try:
                server.serve_forever(poll_interval=.2)
            except KeyboardInterrupt:
                pass
    finally:
        if item_runtime:
            item_runtime.close()
        if runtime:
            runtime.close()
        signal.signal(signal.SIGTERM, previous)


if __name__ == '__main__':
    main()
