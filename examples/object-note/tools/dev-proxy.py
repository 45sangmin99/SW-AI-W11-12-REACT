#!/usr/bin/env python3
"""개발용 중계기: 화면 파일을 제공하고, 화면의 요청을 Mini DBMS(HTTP)로 전달한다.

왜 필요한가
  - DBMS 서버는 Bearer 토큰이 있어야 쓸 수 있고 CORS 헤더가 없어서 브라우저가 직접 부를 수 없다.
  - 토큰을 브라우저 코드에 넣으면 누구나 볼 수 있으므로, 토큰은 이 프로그램(서버 쪽)에만 둔다.
  - 화면 파일과 API를 같은 주소에서 제공하므로 CORS 문제가 생기지 않는다.

Mini Redis(선택)
  - 읽기 두 주소는 Redis를 먼저 본다. 있으면 그대로 돌려주고(HIT), 없으면 DBMS에서 읽어 TTL을 걸어 저장한다(MISS).
    응답 헤더 X-Data-Source(redis 또는 dbms)로 어디서 읽었는지 알려 준다 (화면의 출처 표시가 쓴다).
    문의 1만 건 응답은 Redis 값 한도(1MiB)를 넘으므로 zlib으로 압축해서 저장한다.
  - 원본은 언제나 DBMS다. Redis가 꺼져 있거나 오류여도 DBMS로 읽는다 (캐시는 없어도 되는 것).
  - 상태 저장이 DURABLE로 확인된 뒤에만 신호 상태 이력 캐시를 지운다 (반대 순서면 옛 데이터가 다시 캐시된다).
    저장 여부를 알 수 없을 때(unknown)도 지운다. 저장됐을 수 있기 때문이다.
  - 읽는 도중에 무효화되면 그 읽기는 캐시에 저장하지 않는다 (옛 값을 다시 채우는 경쟁을 막는다).
  - 같은 키의 MISS가 동시에 와도 DBMS에는 한 번만 보낸다.
  - TTL은 안전장치다. 지우기에 실패해도 TTL이 지나면 맞는 값으로 돌아온다.

열어 두는 주소는 아래 셋뿐이다. 브라우저는 SQL을 보낼 수 없다.
  GET  /api/inquiries       문의 전체          -> { meta, inquiries: [...] }
  GET  /api/status-history  신호 상태 이력     -> { history: { 신호ID: [{ status, at }, ...] } }
  POST /api/status          상태 추가 { alertId, status }
                            -> 201 { alertId, status, at }   at(변경 시각)은 이 프로그램이 찍는다

저장 결과 (POST /api/status)
  201  DBMS가 영구 저장(DURABLE)을 확인했다
  409  다른 쓰기와 충돌해 저장되지 않았다 (outcome: "not_saved"). 3번까지 다시 시도한 뒤의 결과다
  502  저장되지 않았거나(outcome: "not_saved") 저장 여부를 알 수 없다(outcome: "unknown")
  503  DBMS에 닿지 못했다
  충돌(409)만 자동으로 다시 시도한다. 충돌은 확정 전에 거절된 것이라 중복 저장이 없다.
  "unknown"을 다시 보내면 같은 상태가 두 번 저장될 수 있으므로 여기서는 다시 시도하지 않는다.

실행 (저장소 루트에서)
  1) python3 db/load_sample.py                      # DB 데이터 폴더 만들기 (처음 한 번)
  2) export MINIDB_TOKEN='아무 비밀 문자열'
  3) ./dbms/reliable/build/mini-db-server --data-dir db/data --port 8080     # 터미널 1
  4) make -C redis && mkdir -p redis/data
     ./redis/build/mini-redis --port 6380 --aof-path redis/data/appendonly.aof   # 터미널 2 (선택)
  5) python3 tools/dev-proxy.py                                              # 터미널 3
  6) 브라우저에서 http://localhost:8001/voc.html

개발용이라 127.0.0.1에서만 받는다. 외부에 열지 않는다.
"""
import argparse
import base64
import http.client
import json
import os
import re
import sys
import threading
import time
import zlib
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error, request
from urllib.parse import quote as url_quote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
PAGE = 10000  # DBMS가 한 번에 돌려주는 최대 행 수
MAX_BODY = 4096
ALERT_ID_MAX = 120  # db/alert_status_history.schema 의 alert_id 한도 (바이트)
CONFLICT_RETRIES = 3
# 화면 파일로 내보내지 않는 경로 (DB 데이터, DBMS 소스, git 기록)
BLOCKED = ("/.git", "/dbms", "/db/data", "/tools")
# 지금 DB에는 시연용으로 만든 샘플만 들어 있으므로 시연 데이터 표시를 켠다.
# 실제 문의를 넣게 되면 false로 바꾼다 (화면 상단의 시연용 안내가 이 값을 따른다)
META = {"generated": True, "source": "mini-dbms"}
# Mini Redis 캐시 키 (cache:voc:... 구역 규칙)와 TTL(초)
KEY_INQUIRIES = "cache:voc:inquiries"
KEY_HISTORY = "cache:voc:status-history"
TTL_INQUIRIES = 60  # 문의는 이 중계기로 바뀌지 않는다. TTL로만 갱신한다
TTL_HISTORY = 10    # 상태 저장 때 지우지만, 지우기에 실패해도 오래 어긋나지 않게 짧게 둔다
# Mini Redis는 값 하나가 1MiB까지다. 문의 1만 건 응답은 약 1.7MB라 그대로는 못 담으므로 압축해서 저장한다
# (zlib + base64, 약 196KB). 맨 앞의 "z:"는 형식 표시이고, 이 표시가 없는 옛 값은 없는 것으로 본다
CACHE_PREFIX = "z:"


def load_statuses():
    """src/voc/config.js 의 STATUSES 를 읽는다. 화면과 같은 목록을 쓰기 위해 복사해 두지 않는다"""
    text = (ROOT / "src" / "voc" / "config.js").read_text(encoding="utf-8")
    match = re.search(r"STATUSES:\s*Object\.freeze\(\[(.*?)\]\)", text, re.S)
    names = re.findall(r'"([^"]+)"', match.group(1)) if match else []
    if not names:
        sys.exit("오류: src/voc/config.js 에서 STATUSES 를 찾지 못했습니다")
    return tuple(names)


class DbError(Exception):
    """DBMS와 통신하지 못했다. maybe_saved: 쓰기 요청이 이미 전달됐을 수 있으면 True"""

    def __init__(self, message, maybe_saved=False):
        super().__init__(message)
        self.maybe_saved = maybe_saved


class Db:
    def __init__(self, url, token):
        self.url = url.rstrip("/")
        self.token = token

    def query(self, sql):
        """SQL 한 문장을 실행하고 (HTTP 상태, 응답 JSON)을 돌려준다"""
        req = request.Request(
            self.url + "/query",
            data=json.dumps({"sql": sql}).encode("utf-8"),
            method="POST",
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
        )
        try:
            with request.urlopen(req, timeout=10) as res:
                status, raw = res.status, res.read()
        except error.HTTPError as e:
            status, raw = e.code, e.read()
        except error.URLError as e:
            # 연결 자체가 거절됐으면 전달되지 않은 것이다. 그 밖에는 전달됐을 수 있다
            refused = isinstance(e.reason, ConnectionRefusedError)
            raise DbError("DBMS 서버에 연결할 수 없습니다. 서버가 켜져 있는지 확인해 주세요.", maybe_saved=not refused)
        except (TimeoutError, ConnectionError, OSError):
            raise DbError("DBMS 서버의 응답을 받지 못했습니다.", maybe_saved=True)
        try:
            data = json.loads(raw)
        except ValueError:
            data = {}
        return status, data

    def select_all(self, columns, table):
        """id 순서로 전부 읽는다. 한 번에 10,000행까지만 받을 수 있어 id 기준으로 나눠 읽는다"""
        rows, last = [], 0
        while True:
            status, data = self.query(f"SELECT id,{columns} FROM {table} WHERE id>{last} ORDER BY id LIMIT {PAGE};")
            if status != 200 or not data.get("ok"):
                message = (data.get("error") or {}).get("message", f"HTTP {status}")
                raise DbError(f"DBMS 조회에 실패했습니다: {message}")
            page = data["rows"]
            rows.extend(page)
            if len(page) < PAGE:
                return rows
            last = int(page[-1][0])


class Cache:
    """Mini Redis(HTTP)의 키-값 캐시. 어떤 실패도 예외로 올리지 않는다 (캐시가 없어도 DBMS로 동작해야 한다)"""

    def __init__(self, url):
        parts = urlsplit(url)
        self.host, self.port = parts.hostname or "127.0.0.1", parts.port or 6380
        self._lock = threading.Lock()  # _versions, _flights 보호. 아래 fetch/invalidate 의 확인-저장, 올림-삭제도 이 락 안에서 한다
        self._versions = {}  # 키별로 무효화한 횟수. 읽는 도중에 무효화됐는지 알아내는 용도
        self._flights = {}   # 키별 락. 같은 키의 MISS를 한 번만 DBMS로 보내는 용도

    def _call(self, method, key, body=None):
        conn = http.client.HTTPConnection(self.host, self.port, timeout=2)
        try:
            conn.request(method, "/keys/" + url_quote(key, safe=""), body, {"Content-Type": "application/json"})
            res = conn.getresponse()
            return res.status, res.read()
        finally:
            conn.close()

    def get(self, key):
        """저장된 문자열을 돌려준다. 없거나 Redis에 문제가 있으면 None (둘 다 DBMS에서 읽으면 된다)"""
        try:
            status, raw = self._call("GET", key)
            value = json.loads(raw)["value"] if status == 200 else None
            if not isinstance(value, str) or not value.startswith(CACHE_PREFIX):
                return None
            return zlib.decompress(base64.b64decode(value[len(CACHE_PREFIX):])).decode("utf-8")
        except (OSError, http.client.HTTPException, ValueError, KeyError, TypeError, zlib.error):
            return None

    def put(self, key, text, ttl):
        packed = CACHE_PREFIX + base64.b64encode(zlib.compress(text.encode("utf-8"), 6)).decode("ascii")
        body = json.dumps({"value": packed, "ttl_seconds": ttl}, ensure_ascii=False, separators=(",", ":"))
        try:
            self._call("PUT", key, body.encode("utf-8"))
        except (OSError, http.client.HTTPException):
            pass  # 저장 못 해도 이번 응답은 이미 DBMS에서 읽은 값이다

    def delete(self, key):
        try:
            self._call("DELETE", key)
            return True
        except (OSError, http.client.HTTPException):
            return False  # TTL이 지나면 사라진다

    def fetch(self, key, ttl, build):
        """캐시 어사이드. (본문, 출처)를 돌려준다. 출처는 "redis"(캐시에서) 또는 "dbms"(DBMS에서 읽음).
        있으면 그대로, 없으면 build()로 DBMS에서 만들어 저장한다.

        - 같은 키의 MISS가 동시에 와도 DBMS에는 한 번만 보낸다 (먼저 잡은 요청이 만들고, 나머지는 기다렸다가 캐시를 본다).
        - 읽는 도중에 invalidate() 됐으면 저장하지 않는다. 저장 전의 옛 값을 지운 뒤에 다시 채우는 일을 막는다.
        """
        text = self.get(key)
        if text is not None:
            return text, "redis"
        with self._lock:
            flight = self._flights.setdefault(key, threading.Lock())
        with flight:
            text = self.get(key)  # 기다리는 사이 다른 요청이 채웠을 수 있다
            if text is not None:
                return text, "redis"
            with self._lock:
                version = self._versions.get(key, 0)
            text = json.dumps(build(), ensure_ascii=False, separators=(",", ":"))
            with self._lock:  # 확인과 저장 사이에 invalidate()가 끼어들지 못하게 같은 락 안에서 한다
                if self._versions.get(key, 0) == version:
                    self.put(key, text, ttl)
            return text, "dbms"

    def invalidate(self, key):
        """무효화: 읽고 있는 요청이 옛 값을 다시 저장하지 못하게 표시한 뒤 지운다"""
        with self._lock:
            self._versions[key] = self._versions.get(key, 0) + 1
            return self.delete(key)


def quote(value):
    return "'" + value.replace("'", "''") + "'"


class Handler(SimpleHTTPRequestHandler):
    db = None
    cache = None
    statuses = ()
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript"}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # 개발 중에는 ES 모듈이 캐시되지 않게 한다
        super().end_headers()

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def route(self):
        return self.path.split("?", 1)[0]

    def blocked(self, path):
        return any(path == b or path.startswith(b + "/") for b in BLOCKED)

    # ---- 읽기
    def do_GET(self):
        path = self.route()
        try:
            if path == "/api/inquiries":
                self.get_inquiries()
            elif path == "/api/status-history":
                self.get_status_history()
            elif path.startswith("/api/") or self.blocked(path):
                self.send_json(404, {"error": "없는 주소입니다."})
            else:
                super().do_GET()
        except DbError as e:
            self.send_json(503, {"error": str(e)})

    def do_HEAD(self):
        path = self.route()
        if path.startswith("/api/") or self.blocked(path):
            self.send_response(404)
            self.end_headers()
        else:
            super().do_HEAD()

    def send_cached(self, key, ttl, build):
        text, source = self.cache.fetch(key, ttl, build)
        body = text.encode("utf-8")
        self.send_response(200)
        self.send_header("X-Data-Source", source)  # 화면이 "Redis 캐시 / DBMS 직접"을 표시하는 데 쓴다
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def get_inquiries(self):
        def build():
            columns = ("created_at", "category", "device", "app_version", "text")
            rows = self.db.select_all(",".join(columns), "inquiries")
            inquiries = [{"id": int(r[0]), **dict(zip(columns, r[1:]))} for r in rows]
            return {"meta": META, "inquiries": inquiries}

        self.send_cached(KEY_INQUIRIES, TTL_INQUIRIES, build)

    def get_status_history(self):
        def build():
            history = {}
            for _id, alert_id, status, at in self.db.select_all("alert_id,status,at", "alert_status_history"):
                history.setdefault(alert_id, []).append({"status": status, "at": at})
            return {"history": history}

        self.send_cached(KEY_HISTORY, TTL_HISTORY, build)

    # ---- 쓰기
    def do_POST(self):
        if self.route() != "/api/status":
            self.send_json(404, {"error": "없는 주소입니다."})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_BODY:
            self.send_json(400, {"error": "요청 본문의 크기가 올바르지 않습니다."})
            return
        try:
            body = json.loads(self.rfile.read(length))
            alert_id, status = body["alertId"], body["status"]
        except (ValueError, KeyError, TypeError):
            self.send_json(400, {"error": "alertId 와 status 가 필요합니다."})
            return
        if not isinstance(alert_id, str) or not isinstance(status, str):
            self.send_json(400, {"error": "alertId 와 status 는 문자열이어야 합니다."})
            return
        if status not in self.statuses:
            self.send_json(400, {"error": f"알 수 없는 상태입니다: {status}"})
            return
        if not alert_id or len(alert_id.encode("utf-8")) > ALERT_ID_MAX or any(ord(ch) < 32 for ch in alert_id):
            self.send_json(400, {"error": "alertId 가 올바르지 않습니다."})
            return
        self.save_status(alert_id, status)

    def save_status(self, alert_id, status):
        at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        sql = f"INSERT INTO alert_status_history (alert_id,status,at) VALUES ({quote(alert_id)},{quote(status)},{quote(at)});"
        try:
            for attempt in range(CONFLICT_RETRIES + 1):
                code, data = self.db.query(sql)
                if code == 409 and attempt < CONFLICT_RETRIES:
                    time.sleep(0.05 * (attempt + 1))
                    continue
                break
        except DbError as e:
            if e.maybe_saved:
                self.cache.invalidate(KEY_HISTORY)  # 저장됐을 수 있으니 옛 캐시를 남기지 않는다
            self.send_json(503, {"error": str(e), "outcome": "unknown" if e.maybe_saved else "not_saved"})
            return
        if code == 200 and data.get("ok") and data.get("commit") == "DURABLE":
            self.cache.invalidate(KEY_HISTORY)  # DBMS 저장이 확인된 뒤에 지운다 (반대 순서 금지)
            self.send_json(201, {"alertId": alert_id, "status": status, "at": at})
            return
        unknown = data.get("commit") == "UNKNOWN" or bool(data.get("recovery_required"))
        if unknown:
            self.cache.invalidate(KEY_HISTORY)
        message = (data.get("error") or {}).get("message", f"HTTP {code}")
        if code == 409:
            self.send_json(409, {"error": "다른 변경과 충돌해 저장하지 못했습니다. 다시 시도해 주세요.", "outcome": "not_saved"})
        else:
            self.send_json(502, {"error": f"저장하지 못했습니다: {message}", "outcome": "unknown" if unknown else "not_saved"})


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--port", type=int, default=8001, help="이 중계기가 받을 포트 (기본 8001)")
    parser.add_argument("--db-url", default=os.environ.get("MINIDB_URL", "http://127.0.0.1:8080"), help="DBMS 서버 주소")
    parser.add_argument("--redis-url", default=os.environ.get("MINIREDIS_URL", "http://127.0.0.1:6380"), help="Mini Redis 서버 주소 (꺼져 있으면 캐시 없이 동작)")
    args = parser.parse_args()

    token = os.environ.get("MINIDB_TOKEN")
    if not token:
        sys.exit("오류: 환경변수 MINIDB_TOKEN 이 필요합니다. DBMS 서버를 켤 때 쓴 것과 같은 값을 넣으세요")

    Handler.db = Db(args.db_url, token)
    Handler.cache = Cache(args.redis_url)
    Handler.statuses = load_statuses()
    try:  # 켜져 있는지만 미리 알려 준다. 꺼져 있어도 시작은 한다
        request.urlopen(args.db_url.rstrip("/") + "/health", timeout=3).read()
        state = "연결됨"
    except (error.URLError, OSError):
        state = "연결 안 됨 (DBMS 서버를 먼저 켜세요)"
    try:
        http.client.HTTPConnection(Handler.cache.host, Handler.cache.port, timeout=3).connect()
        cache_state = "연결됨"
    except OSError:
        cache_state = "연결 안 됨 (캐시 없이 DBMS로만 동작)"
    print(f"중계기: http://localhost:{args.port}/voc.html  |  DBMS {args.db_url}: {state}  |  Redis {args.redis_url}: {cache_state}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
