#!/usr/bin/env bash
# DBMS 서버 + Mini Redis + 중계기를 한 번에 켜고, Ctrl-C 하면 셋 다 끈다.
#
#   ./tools/start-all.sh                 # 화면: http://localhost:8001/voc.html
#   NO_REDIS=1 ./tools/start-all.sh      # Redis 없이 (캐시 없는 DBMS 단독 동작 확인용)
#
# 처음이면 빌드와 데이터 적재도 한다. 이미 있는 데이터는 덮어쓰지 않는다.
# 포트: DBMS 8080, Redis 6380, 중계기 8001 (이미 쓰는 포트가 있으면 시작하지 않는다)
set -u
cd "$(dirname "$0")/.."

DB_PORT=8080
REDIS_PORT=6380
PROXY_PORT=8001
DB_BIN=dbms/reliable/build/mini-db-server
REDIS_BIN=redis/build/mini-redis
LOG_DIR="${TMPDIR:-/tmp}/mini-react-logs"
mkdir -p "$LOG_DIR"

fail() { echo "오류: $*" >&2; exit 1; }

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

for p in $DB_PORT $PROXY_PORT; do
  port_busy "$p" && fail "포트 $p 를 이미 쓰고 있습니다. 먼저 끄세요 (lsof -nP -iTCP:$p -sTCP:LISTEN)"
done
[ -z "${NO_REDIS:-}" ] && port_busy "$REDIS_PORT" && fail "포트 $REDIS_PORT 를 이미 쓰고 있습니다. 먼저 끄세요"

# ---- 준비 (처음 한 번)
[ -x "$DB_BIN" ] || { echo "DBMS 빌드 중..."; make -C dbms >"$LOG_DIR/build-dbms.log" 2>&1 || fail "DBMS 빌드 실패: $LOG_DIR/build-dbms.log"; }
[ -d db/data ] || { echo "문의 1만 건 적재 중..."; python3 db/load_sample.py || fail "데이터 적재 실패"; }
if [ -z "${NO_REDIS:-}" ]; then
  [ -x "$REDIS_BIN" ] || { echo "Redis 빌드 중..."; make -C redis >"$LOG_DIR/build-redis.log" 2>&1 || fail "Redis 빌드 실패: $LOG_DIR/build-redis.log"; }
  mkdir -p redis/data
fi

# 토큰은 DBMS 서버와 중계기가 같은 값을 써야 한다. 지정하지 않으면 이번 실행에만 쓰는 값을 만든다
export MINIDB_TOKEN="${MINIDB_TOKEN:-$(python3 -c 'import secrets; print(secrets.token_hex(16))')}"

PIDS=()
cleanup() {
  trap - INT TERM EXIT
  echo; echo "끄는 중..."
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null; done
  wait 2>/dev/null
}
trap cleanup INT TERM EXIT

wait_http() {  # $1=URL $2=이름
  for _ in $(seq 1 50); do
    curl -s -o /dev/null "$1" && return 0
    sleep 0.1
  done
  fail "$2 가 시작되지 않았습니다. 로그: $LOG_DIR"
}

"$DB_BIN" --data-dir db/data --port "$DB_PORT" >"$LOG_DIR/dbms.log" 2>&1 &
PIDS+=($!)
wait_http "http://127.0.0.1:$DB_PORT/health" "DBMS 서버"

if [ -z "${NO_REDIS:-}" ]; then
  "$REDIS_BIN" --port "$REDIS_PORT" --aof-path redis/data/appendonly.aof >"$LOG_DIR/redis.log" 2>&1 &
  PIDS+=($!)
  for _ in $(seq 1 50); do
    curl -s -o /dev/null "http://127.0.0.1:$REDIS_PORT/keys/ping" && break
    sleep 0.1
  done
  kill -0 "${PIDS[1]}" 2>/dev/null || fail "Redis 가 시작되지 않았습니다 (로그: $LOG_DIR/redis.log)"
fi

python3 tools/dev-proxy.py --port "$PROXY_PORT" >"$LOG_DIR/proxy.log" 2>&1 &
PIDS+=($!)
wait_http "http://127.0.0.1:$PROXY_PORT/api/status-history" "중계기"

echo "준비됐습니다. Ctrl-C 로 모두 끕니다."
echo "  홈     http://localhost:$PROXY_PORT/home.html   (프로젝트 지도와 바로가기)"
echo "  화면   http://localhost:$PROXY_PORT/voc.html"
echo "  로그   $LOG_DIR/{dbms,redis,proxy}.log"
head -1 "$LOG_DIR/proxy.log"
wait
