#!/usr/bin/env bash
# DBMS 서버 + Mini Redis + VOC 서비스(Node)를 한 번에 켜고, Ctrl-C 하면 셋 다 끈다.
#
#   ./tools/start-all.sh                 # 화면: http://localhost:8001/voc.html
#   NO_REDIS=1 ./tools/start-all.sh      # Redis 없이 (캐시 없는 DBMS 단독 동작 확인용)
#   SIMULATE=1 ./tools/start-all.sh      # 고객 쪽 대역(simulate-intake.py)도 같이 켠다: 문의가 평균 30초에 1건씩 DB에 들어오고 화면이 10초마다 갱신된다
#   SIMULATE=1 SIMULATE_ARGS="--burst 배송" ./tools/start-all.sh   # 시작할 때 '배송' 25건이 한꺼번에 들어와 새 이상 신호가 생긴다
#                                         (SIMULATE_ARGS에는 simulate-intake.py의 옵션을 그대로 쓴다. 기본은 옵션 없음)
#
# SIMULATE는 실제 db/data에 문의를 추가한다 (지우거나 고치지 않는다). 그래서 기본은 꺼져 있다.
# 처음이면 빌드와 데이터 적재도 한다. 이미 있는 데이터는 덮어쓰지 않는다.
# 포트: DBMS 8080, Redis 6380, VOC 서비스 8001 (이미 쓰는 포트가 있으면 시작하지 않는다)
# 필요한 것: Node 18 이상 (VOC 서비스), C 컴파일러(DBMS), clang++(Redis), python3(데이터 적재, 접수 시연)
# 시험용 환경변수: DB_PORT, PROXY_PORT, DATA_DIR(DB 폴더), LOG_DIR 로 기본값을 바꿀 수 있다
set -u
cd "$(dirname "$0")/.."

DB_PORT="${DB_PORT:-8080}"
REDIS_PORT=6380
PROXY_PORT="${PROXY_PORT:-8001}"
DATA_DIR="${DATA_DIR:-db/data}"
DB_BIN=dbms/reliable/build/mini-db-server
REDIS_BIN=redis/build/mini-redis
LOG_DIR="${LOG_DIR:-${TMPDIR:-/tmp}/mini-react-logs}"
mkdir -p "$LOG_DIR"

fail() { echo "오류: $*" >&2; exit 1; }

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

command -v node >/dev/null 2>&1 || fail "VOC 서비스는 Node(18 이상)가 필요합니다. 설치하거나, DB 없이 화면만 보려면 python3 -m http.server 8000 후 /voc.html?source=sample 을 여세요"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] || fail "Node 18 이상이 필요합니다 (지금: $(node -v))"

for p in $DB_PORT $PROXY_PORT; do
  port_busy "$p" && fail "포트 $p 를 이미 쓰고 있습니다. 먼저 끄세요 (lsof -nP -iTCP:$p -sTCP:LISTEN)"
done
[ -z "${NO_REDIS:-}" ] && port_busy "$REDIS_PORT" && fail "포트 $REDIS_PORT 를 이미 쓰고 있습니다. 먼저 끄세요"

# ---- 준비 (처음 한 번)
[ -x "$DB_BIN" ] || { echo "DBMS 빌드 중..."; make -C dbms >"$LOG_DIR/build-dbms.log" 2>&1 || fail "DBMS 빌드 실패: $LOG_DIR/build-dbms.log"; }
[ -d "$DATA_DIR" ] || { echo "문의 1만 건 적재 중..."; python3 db/load_sample.py --data-dir "$DATA_DIR" || fail "데이터 적재 실패"; }
if [ -z "${NO_REDIS:-}" ]; then
  [ -x "$REDIS_BIN" ] || { echo "Redis 빌드 중..."; make -C redis >"$LOG_DIR/build-redis.log" 2>&1 || fail "Redis 빌드 실패: $LOG_DIR/build-redis.log"; }
  mkdir -p redis/data
fi

# 토큰은 DBMS 서버와 VOC 서비스가 같은 값을 써야 한다. 지정하지 않으면 이번 실행에만 쓰는 값을 만든다
export MINIDB_TOKEN="${MINIDB_TOKEN:-$(python3 -c 'import secrets; print(secrets.token_hex(16))')}"
# 시연용 접수 스크립트(tools/simulate-intake.py)가 같은 토큰을 읽을 수 있게 내 계정만 읽는 파일로 남긴다 (끌 때 지운다)
TOKEN_FILE="$LOG_DIR/dev-token"
( umask 077; printf '%s' "$MINIDB_TOKEN" > "$TOKEN_FILE" )

PIDS=()
cleanup() {
  trap - INT TERM EXIT
  echo; echo "끄는 중..."
  rm -f "$TOKEN_FILE"
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null; done
  wait 2>/dev/null
}
trap cleanup INT TERM HUP EXIT  # HUP: 터미널 창을 닫을 때도 서버를 함께 끈다

wait_http() {  # $1=URL $2=이름
  for _ in $(seq 1 50); do
    curl -s -o /dev/null "$1" && return 0
    sleep 0.1
  done
  fail "$2 가 시작되지 않았습니다. 로그: $LOG_DIR"
}

"$DB_BIN" --data-dir "$DATA_DIR" --port "$DB_PORT" >"$LOG_DIR/dbms.log" 2>&1 &
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

node tools/voc-service.mjs --port "$PROXY_PORT" --db-url "http://127.0.0.1:$DB_PORT" --redis-url "http://127.0.0.1:$REDIS_PORT" >"$LOG_DIR/proxy.log" 2>&1 &
PIDS+=($!)
wait_http "http://127.0.0.1:$PROXY_PORT/api/v1/overview" "VOC 서비스"

# 접수 시연(선택): 고객 쪽 시스템의 대역이 문의를 DB에 넣는다. 서비스가 준비된 뒤에 켜서, 넣을 때마다 캐시 비우기가 닿게 한다
if [ -n "${SIMULATE:-}" ]; then
  # shellcheck disable=SC2086  # SIMULATE_ARGS는 옵션 여러 개를 공백으로 구분해 받는다
  python3 tools/simulate-intake.py --db-url "http://127.0.0.1:$DB_PORT" --service-url "http://127.0.0.1:$PROXY_PORT" ${SIMULATE_ARGS:-} >"$LOG_DIR/intake.log" 2>&1 &
  PIDS+=($!)
  sleep 1
  kill -0 "${PIDS[${#PIDS[@]}-1]}" 2>/dev/null || { cat "$LOG_DIR/intake.log" >&2; fail "접수 시연이 시작되지 않았습니다 (로그: $LOG_DIR/intake.log)"; }
fi

echo "준비됐습니다. Ctrl-C 로 모두 끕니다."
echo "  홈     http://localhost:$PROXY_PORT/home.html   (프로젝트 지도와 바로가기)"
echo "  화면   http://localhost:$PROXY_PORT/voc.html"
echo "  로그   $LOG_DIR/{dbms,redis,proxy}.log"
if [ -n "${SIMULATE:-}" ]; then
  echo "  접수 시연 켜짐: 문의가 DB에 들어옵니다 (실제 $DATA_DIR 에 추가). 접수 로그: tail -f $LOG_DIR/intake.log"
else
  echo "  접수 시연은 꺼져 있습니다. 같이 켜려면 Ctrl-C 후  SIMULATE=1 ./tools/start-all.sh  (새 신호까지: SIMULATE=1 SIMULATE_ARGS=\"--burst 배송\" ./tools/start-all.sh)"
fi
head -1 "$LOG_DIR/proxy.log"
wait
