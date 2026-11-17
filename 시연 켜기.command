#!/usr/bin/env bash
# 더블클릭하면 터미널이 열리고 서버 + 접수 시연이 켜진다. 준비되면 브라우저에서 화면이 자동으로 열린다.
#   - 시작할 때 '배송' 문의 25건이 한꺼번에 들어와 새 이상 신호(문의 급증)가 생기고,
#   - 그 뒤 문의가 평균 30초에 1건씩 DB에 들어온다. 화면은 10초마다 갱신된다.
# 실제 db/data에 문의가 추가된다 (지우거나 고치지 않는다). 끄려면 이 창에서 Ctrl-C (또는 창을 닫는다).
# 서버만 켜려면 "서버 켜기.command"를 쓴다. 이미 서버가 켜져 있다면 먼저 그 창에서 Ctrl-C로 끄고 이 파일을 연다.
cd "$(dirname "$0")" || exit 1
PORT="${PROXY_PORT:-8001}"
URL="http://localhost:$PORT/voc.html"
READY="http://127.0.0.1:$PORT/api/v1/overview"

if curl -s -o /dev/null "$READY"; then
  echo "서버가 이미 켜져 있어서 접수 시연을 함께 켤 수 없습니다."
  echo "켜 둔 터미널 창에서 Ctrl-C로 서버를 끈 뒤, 이 파일을 다시 열어 주세요."
  read -r -p "엔터를 누르면 끝납니다. " _
  exit 1
fi

if [ -z "${NO_OPEN:-}" ]; then
  ( for _ in $(seq 1 60); do curl -s -o /dev/null "$READY" && { open "$URL"; break; }; sleep 0.5; done ) &
fi

export SIMULATE=1
export SIMULATE_ARGS="${SIMULATE_ARGS:---burst 배송}"
./tools/start-all.sh
echo
echo "서버가 꺼졌습니다. 이 창은 닫아도 됩니다."
read -r -p "엔터를 누르면 끝납니다. " _
