#!/usr/bin/env python3
"""샘플 문의 JSON(data/inquiries.sample.json)을 Mini DBMS 데이터 폴더로 만든다.

하는 일:
  1. 데이터 폴더를 새로 만들고 테이블 정의(*.schema)와 빈 CSV를 둔다
  2. 문의를 INSERT 문으로 바꿔 한 번의 트랜잭션으로 넣는다 (mini-db --file)
  3. 넣은 내용을 다시 읽어 원본과 한 건도 다르지 않은지 확인한다

사용법 (저장소 루트에서, 먼저 `make -C dbms`로 빌드):
  python3 db/load_sample.py                    # db/data/ 에 만든다
  python3 db/load_sample.py --data-dir /경로   # 다른 곳에 만든다

이미 내용이 있는 폴더는 덮어쓰지 않고 멈춘다.
문의 ID는 DBMS가 1부터 순서대로 발급한다 (샘플의 id와 같은 순서로 넣으므로 같은 번호가 된다).
"""
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
MINI_DB = ROOT / "dbms" / "reliable" / "build" / "mini-db"
TABLES = ("inquiries", "alert_status_history")
# 열 길이는 UTF-8 바이트 수 기준이다. *.schema와 같은 값이어야 한다
LIMITS = {"created_at": 24, "category": 40, "device": 20, "app_version": 20, "text": 255}
COLUMNS = ("created_at", "category", "device", "app_version", "text")


def quote(value):
    """SQL 문자열 리터럴. 작은따옴표는 두 번 쓴다"""
    return "'" + value.replace("'", "''") + "'"


def fail(message):
    print(f"오류: {message}", file=sys.stderr)
    sys.exit(1)


def load_rows(path):
    rows = json.loads(path.read_text(encoding="utf-8"))["inquiries"]
    for number, row in enumerate(rows, 1):
        for column in COLUMNS:
            size = len(str(row[column]).encode("utf-8"))
            if size > LIMITS[column]:
                fail(f"{number}번째 문의의 {column}이(가) {size}바이트라 한도 {LIMITS[column]}바이트를 넘습니다")
    return rows


def build_sql(rows):
    lines = ["BEGIN;"]
    for row in rows:
        values = ",".join(quote(str(row[c])) for c in COLUMNS)
        lines.append(f"INSERT INTO inquiries ({','.join(COLUMNS)}) VALUES ({values});")
    lines.append("COMMIT;")
    return "\n".join(lines) + "\n"


def run_mini_db(data_dir, *args):
    result = subprocess.run([str(MINI_DB), "--data-dir", str(data_dir), *args], capture_output=True, text=True)
    if result.returncode != 0:
        tail = (result.stdout.strip().splitlines() or [""])[-1]
        fail(f"mini-db가 실패했습니다 (종료 코드 {result.returncode})\n  {tail}\n  {result.stderr.strip()}\n"
             f"  만들다 만 폴더는 직접 지운 뒤 다시 실행하세요: {data_dir}")
    return result.stdout


def verify(data_dir, rows):
    """DB에서 다시 읽어 원본과 비교한다"""
    if len(rows) > 10000:  # DBMS는 한 번에 10,000행까지만 돌려준다
        out = run_mini_db(data_dir, "-e", "SELECT COUNT(*) FROM inquiries;")
        count = int(json.loads(out.strip().splitlines()[-1])["rows"][0][0])
        return count == len(rows)
    out = run_mini_db(data_dir, "-e", f"SELECT id,{','.join(COLUMNS)} FROM inquiries ORDER BY id LIMIT {len(rows)};")
    stored = json.loads(out.strip().splitlines()[-1])["rows"]
    expected = [[str(i)] + [str(r[c]) for c in COLUMNS] for i, r in enumerate(rows, 1)]
    return stored == expected


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--data-dir", type=Path, default=HERE / "data", help="만들 DB 데이터 폴더 (기본: db/data)")
    parser.add_argument("--sample", type=Path, default=ROOT / "data" / "inquiries.sample.json", help="문의 샘플 JSON")
    args = parser.parse_args()

    if not MINI_DB.exists():
        fail(f"{MINI_DB} 가 없습니다. 먼저 `make -C dbms`로 빌드하세요")
    data_dir = args.data_dir.resolve()
    if data_dir.exists() and any(data_dir.iterdir()):
        fail(f"{data_dir} 에 이미 파일이 있습니다. 덮어쓰지 않습니다. 다른 --data-dir을 쓰거나 폴더를 직접 지우세요")

    rows = load_rows(args.sample)
    data_dir.mkdir(parents=True, exist_ok=True)
    for table in TABLES:
        shutil.copy(HERE / f"{table}.schema", data_dir / f"{table}.schema")
        (data_dir / f"{table}.csv").touch()  # 처음에는 빈 파일

    with tempfile.NamedTemporaryFile("w", suffix=".sql", encoding="utf-8") as sql_file:
        sql_file.write(build_sql(rows))
        sql_file.flush()
        run_mini_db(data_dir, "--file", sql_file.name)

    if not verify(data_dir, rows):
        fail("DB에서 다시 읽은 내용이 원본과 다릅니다")
    print(f"완료: 문의 {len(rows)}건을 {data_dir} 에 넣고 원본과 일치함을 확인했습니다")


if __name__ == "__main__":
    main()
