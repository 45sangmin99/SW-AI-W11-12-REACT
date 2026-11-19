#!/usr/bin/env bash
# 더블클릭하면 터미널이 열리고 서버(DBMS + Redis + VOC 서비스)가 켜진다. 준비되면 브라우저에서 화면이 자동으로 열린다.
# 끄려면 이 창에서 Ctrl-C (또는 창을 닫는다). 이미 켜져 있으면 화면만 연다.
# 문의가 들어오는 시연까지 하려면 "시연 켜기.command"를 쓴다.
cd "$(dirname "$0")" || exit 1
PORT="${PROXY_PORT:-8001}"
URL="http://localhost:$PORT/voc.html"
READY="http://127.0.0.1:$PORT/api/v1/overview"

if curl -s -o /dev/null "$READY"; then
  echo "서버가 이미 켜져 있습니다. 화면을 엽니다: $URL"
  [ -z "${NO_OPEN:-}" ] && open "$URL"
  exit 0
fi

# 서버가 준비되면 화면을 연다 (최대 30초 기다린다)
if [ -z "${NO_OPEN:-}" ]; then
  ( for _ in $(seq 1 60); do curl -s -o /dev/null "$READY" && { open "$URL"; break; }; sleep 0.5; done ) &
fi

./tools/start-all.sh
echo
echo "서버가 꺼졌습니다. 이 창은 닫아도 됩니다."
read -r -p "엔터를 누르면 끝납니다. " _
