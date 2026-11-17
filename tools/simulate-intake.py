#!/usr/bin/env python3
"""시연용 접수 스크립트: 고객 쪽 시스템의 대역.

실제 서비스에서는 고객이 글을 쓰면 고객 쪽 시스템이 DBMS에 문의를 저장하고, 이 VOC 화면은 그 DB에서 문의를 꺼내 이상 신호를 보여 준다.
(유관부서가 보는 화면이라 문의를 쓰는 폼은 두지 않는다.) 이 스크립트는 고객 쪽 시스템 대신 문의를 DBMS에 넣어서,
화면이 10초마다 다시 받아 문의 건수와 신호가 바뀌는 것을 시연할 수 있게 한다.

  python3 tools/simulate-intake.py                       # 평균 30초에 1건 (10~50초 사이로 들쭉날쭉). Ctrl-C로 멈춘다
  python3 tools/simulate-intake.py --interval 60         # 더 드물게
  python3 tools/simulate-intake.py --burst 배송          # 시작할 때 '배송' 문의 25건을 한꺼번에 넣어 이상 신호(문의 급증)를 만든다
  python3 tools/simulate-intake.py --burst 배송 --burst-device Android --burst-only   # 급증 + Android 쏠림을 만들고 끝낸다
  python3 tools/simulate-intake.py --count 5             # 5건만 넣고 끝낸다

어떻게 동작하나
  1. DBMS에서 평소 문의(앞쪽 id) 몇백 건을 읽어 두고, 그중 하나를 골라 지금 시각으로 새 문의로 저장한다 (생성 데이터이므로 실제 고객 문구가 아니다).
  2. 저장이 DURABLE로 확인되면 VOC 서비스의 캐시를 비우라고 알린다 (admin/invalidate). DBMS에는 바뀌었다고 알려 주는 기능이 없어서
     이 알림이 없으면 화면은 캐시(최대 60초)가 지난 뒤에야 새 문의를 본다. 서비스가 꺼져 있으면 알림은 건너뛴다.
  3. 새 문의의 접수 시각은 "지금"(UTC)이다. 데이터가 14일치(10/27~11/9)라서 화면의 "최근 24시간" 같은 기간 필터는 지금 시각 기준으로 바뀐다.
     "전체 기간"에서는 예전 신호가 그대로 보인다.

주의: 실제 db/data에 문의를 **추가**한다 (지우거나 고치지 않는다). 처음 상태로 되돌리려면 서버를 끄고 db/data를 옮긴 뒤
python3 db/load_sample.py 로 다시 적재한다.

토큰: 환경변수 MINIDB_TOKEN, 없으면 ./tools/start-all.sh가 남긴 파일($TMPDIR/mini-react-logs/dev-token)을 읽는다.
"""
import argparse
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

CATEGORIES = ("쿠폰·할인", "사이즈·교환", "반품·환불", "로그인·계정", "배송", "적립금·포인트", "기타")
DEVICES = ("iOS", "Android", "Web")
POOL_ROWS = 1500  # 평소 문의 풀: 앞쪽 id (시나리오가 심기기 전의 평소 구간)
RETRIES = 3


def fail(message):
    print(f"오류: {message}", file=sys.stderr)
    sys.exit(1)


def read_token():
    if os.environ.get("MINIDB_TOKEN"):
        return os.environ["MINIDB_TOKEN"]
    token_file = Path(os.environ.get("TMPDIR", "/tmp")) / "mini-react-logs" / "dev-token"
    try:
        return token_file.read_text(encoding="utf-8").strip()
    except OSError:
        fail("토큰을 찾지 못했습니다. ./tools/start-all.sh 로 서버를 켜거나, DBMS 서버를 켤 때 쓴 MINIDB_TOKEN을 환경변수로 주세요")


def quote(value):
    return "'" + value.replace("'", "''") + "'"


class Db:
    def __init__(self, url, token):
        self.url, self.token = url.rstrip("/"), token

    def query(self, sql):
        request = urllib.request.Request(
            self.url + "/query",
            data=json.dumps({"sql": sql}).encode("utf-8"),
            method="POST",
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as res:
                status, raw = res.status, res.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        except OSError as e:
            fail(f"DBMS 서버({self.url})에 연결하지 못했습니다: {e}. ./tools/start-all.sh 로 서버를 먼저 켜세요")
        try:
            return status, json.loads(raw)
        except ValueError:
            return status, {}


def now_utc():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def insert(db, category, device, version, text):
    """문의 1건을 저장한다. 저장이 DURABLE로 확인되면 새 문의 id, 아니면 None"""
    sql = (
        "INSERT INTO inquiries (created_at,category,device,app_version,text) VALUES "
        f"({quote(now_utc())},{quote(category)},{quote(device)},{quote(version)},{quote(text)});"
    )
    for attempt in range(RETRIES + 1):
        status, data = db.query(sql)
        if status == 409 and attempt < RETRIES:
            time.sleep(0.05 * (attempt + 1))  # 다른 쓰기와 충돌: 확정 전에 거절된 것이라 다시 보내도 중복되지 않는다
            continue
        break
    if status == 200 and data.get("ok") and data.get("commit") == "DURABLE":
        return data.get("inserted_id")
    unknown = data.get("commit") == "UNKNOWN" or data.get("recovery_required")
    reason = (data.get("error") or {}).get("message", f"HTTP {status}")
    print(f"  ! 저장하지 못했습니다{' (저장 여부를 알 수 없음. 다시 넣지 않습니다)' if unknown else ''}: {reason}", file=sys.stderr)
    return None


class Notifier:
    """VOC 서비스에 캐시를 비우라고 알린다. 실패해도 접수는 계속하고, 같은 실패는 한 번만 알린다"""

    def __init__(self, service_url, token, enabled):
        self.url = service_url.rstrip("/") + "/api/v1/admin/invalidate"
        self.token, self.enabled, self.warned = token, enabled, False

    def invalidate(self):
        if not self.enabled:
            return
        request = urllib.request.Request(self.url, data=b"", method="POST", headers={"X-Admin-Token": self.token})
        try:
            with urllib.request.urlopen(request, timeout=3):
                self.warned = False
        except (urllib.error.URLError, OSError) as e:
            if not self.warned:
                reason = f"HTTP {e.code}" if isinstance(e, urllib.error.HTTPError) else "서비스에 연결하지 못함"
                print(f"  ! 캐시 비우기를 건너뜁니다 ({reason}). 화면은 캐시가 만료되는 최대 60초 뒤에 새 문의를 봅니다", file=sys.stderr)
                self.warned = True


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n", 2)[2])
    parser.add_argument("--interval", type=float, default=30, help="새 문의 사이의 평균 간격(초). 기본 30")
    parser.add_argument("--jitter", type=float, default=0.5, help="간격이 평균에서 벗어나는 비율(0~1). 기본 0.5 = 평균의 ±50%%")
    parser.add_argument("--count", type=int, default=0, help="이만큼 넣고 끝낸다. 기본은 Ctrl-C로 멈출 때까지")
    parser.add_argument("--burst", metavar="유형", help="시작할 때 이 유형의 문의를 한꺼번에 넣는다 (이상 신호 시연). 예: 배송")
    parser.add_argument("--burst-count", type=int, default=25, help="한꺼번에 넣는 건수. 기본 25 (문의 급증 기준은 한 시간 20건 이상)")
    parser.add_argument("--burst-device", choices=DEVICES, help="한꺼번에 넣는 문의를 모두 이 기기로 한다 (기기 쏠림 시연)")
    parser.add_argument("--burst-only", action="store_true", help="한꺼번에 넣고 바로 끝낸다")
    parser.add_argument("--no-invalidate", action="store_true", help="VOC 서비스에 캐시 비우기를 알리지 않는다")
    parser.add_argument("--db-url", default=os.environ.get("MINIDB_URL", "http://127.0.0.1:8080"), help="DBMS 서버 주소")
    parser.add_argument("--service-url", default=os.environ.get("VOC_SERVICE_URL", "http://127.0.0.1:8001"), help="VOC 서비스 주소")
    args = parser.parse_args()

    if args.interval <= 0 or not 0 <= args.jitter <= 1 or args.count < 0 or args.burst_count < 1:
        fail("--interval은 0보다 크고, --jitter는 0~1, --count는 0 이상, --burst-count는 1 이상이어야 합니다")
    if args.burst and args.burst not in CATEGORIES:
        fail(f"--burst는 다음 중 하나여야 합니다: {', '.join(CATEGORIES)}")
    if args.burst_only and not args.burst:
        fail("--burst-only는 --burst와 함께 써야 합니다")

    token = read_token()
    db = Db(args.db_url, token)
    notifier = Notifier(args.service_url, token, not args.no_invalidate)

    status, data = db.query(f"SELECT category,device,app_version,text FROM inquiries WHERE id<={POOL_ROWS} ORDER BY id LIMIT {POOL_ROWS};")
    if status != 200 or not data.get("ok") or not data.get("rows"):
        fail("DBMS에서 평소 문의를 읽지 못했습니다. 문의가 적재돼 있는지 확인하세요 (python3 db/load_sample.py)")
    pool = data["rows"]
    _, total = db.query("SELECT COUNT(*) FROM inquiries;")
    start_count = int(total["rows"][0][0])
    print("고객 쪽 시스템 대역: 실제 db/data에 문의를 추가합니다 (지우거나 고치지 않습니다). Ctrl-C로 멈춥니다.")
    print(f"지금 문의 {start_count:,}건. 평소 문의 {len(pool):,}건에서 골라 새 접수로 넣습니다.")

    added = 0

    def put(row, device=None):
        nonlocal added
        category, row_device, version, text = row
        if device:  # 기기를 정하면 앱 버전도 그 기기에 맞춘다 (Web은 "web")
            row_device, version = device, ("web" if device == "Web" else "4.4.0")
        new_id = insert(db, category, row_device, version, text)
        if new_id is None:
            return False
        added += 1
        print(f"[{datetime.now(timezone.utc):%H:%M:%S} UTC] 접수 #{new_id}  {category} · {row_device} · {version}  \"{text}\"")
        return True

    try:
        if args.burst:
            candidates = [r for r in pool if r[0] == args.burst]
            if not candidates:
                fail(f"평소 문의에 '{args.burst}' 유형이 없습니다")
            device_note = f", 기기 {args.burst_device}" if args.burst_device else ""
            print(f"== {args.burst} 문의 {args.burst_count}건을 한꺼번에 접수합니다{device_note} ==")
            for _ in range(args.burst_count):
                put(random.choice(candidates), args.burst_device)
                time.sleep(0.2)
            notifier.invalidate()
            print("== 한꺼번에 접수 끝. 화면이 다음 갱신 때 이상 신호를 보여 줍니다 ==")
            if args.burst_only:
                print(f"끝: {added}건 접수")
                return
        done = 0
        while not args.count or done < args.count:
            wait = args.interval * (1 + random.uniform(-args.jitter, args.jitter))
            time.sleep(wait)
            if put(random.choice(pool)):
                notifier.invalidate()
            done += 1
        print(f"끝: {added}건 접수")
    except KeyboardInterrupt:
        print(f"\n멈춤: 이번에 {added}건을 접수했습니다")


if __name__ == "__main__":
    main()
