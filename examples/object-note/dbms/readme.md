# Mini DBMS — 성공 응답의 의미까지 검증하는 C 데이터베이스

SQL을 실행하는 것에서 끝나지 않고, **확정한 변경이 프로세스 종료 뒤에도 남는지** 확인하는 미니 DBMS입니다. SQL 파서, 파일 저장, 메모리 B+ 트리, 트랜잭션, 복구 엔진과 HTTP Thread Pool 서버를 C로 직접 구현합니다. CLI와 HTTP API가 동일한 엔진을 호출합니다.

## 이 프로젝트의 강점

| 강점 | 구현 원칙 | 확인 방법 |
| --- | --- | --- |
| 성공을 구분합니다 | 작업 공간 반영, 영구 커밋, 결과 불명을 별도 상태로 응답합니다 | 트랜잭션·실패 주입 테스트 |
| 사람이 CSV를 고치지 않습니다 | 초기 기준본과 유효한 커밋 로그로 시작 시 재구성합니다 | 실제 SIGKILL 후 복구·반복 복구 |
| 여러 테이블을 함께 복구합니다 | 파일 교체 도중 종료해도 커밋 전체를 재생합니다 | 테이블 교체 사이 강제 종료 |
| 읽던 데이터가 바뀌지 않습니다 | 조회자는 해당 버전의 CSV 파일과 B+ 트리를 함께 참조합니다 | 이전 스냅샷과 새 커밋의 동시 실행 |
| 롤백한 ID도 재사용하지 않습니다 | ID 범위를 로그에 영구 예약한 뒤 발급합니다 | 롤백·재시작 이후 ID 검사 |
| 빠른 조회를 실제로 검증합니다 | B+ 트리에서 바이트 오프셋을 찾고 CSV 레코드를 직접 읽습니다 | 선형 탐색과 결과 비교·100만 건 실측 |

위 표는 보장과 검증의 대응입니다. 아래의 실제 검사 결과와 알려진 한계를 함께 확인하세요. 전원 장애·저장장치 고장 전체를 검증했다는 뜻은 아닙니다.

## 빠른 시작

POSIX 환경(macOS 또는 Linux), C11 컴파일러, GNU Make가 필요합니다. 테스트와 벤치마크 스크립트에는 Python 3을 사용합니다. 실행 코어는 외부 DBMS나 SQL·B+ 트리 라이브러리를 사용하지 않습니다.

저장소 루트에서:

```sh
make
cp -R reliable/examples/demo /tmp/mini-db-demo
./reliable/build/mini-db --data-dir /tmp/mini-db-demo --file reliable/examples/demo.sql
./reliable/build/mini-db --data-dir /tmp/mini-db-demo -e 'SELECT * FROM characters;' --csv
./reliable/build/mini-db --data-dir /tmp/mini-db-demo -e 'SELECT * FROM characters WHERE id=1;' --explain
```

이미 존재하는 `/tmp/mini-db-demo`를 덮어쓰지 않도록 실행 전 경로를 확인하세요. 예제를 다시 실행하면 행이 추가됩니다. ID는 연속 번호가 아니라 재사용하지 않는 식별자이므로 재시작·롤백 이후 건너뛸 수 있습니다.

실행 파일은 `reliable/build/mini-db`, `reliable/build/mini-db-server`, 엔진 라이브러리는 `reliable/build/libmdb.a`입니다. `--file`, `-e`, 표준입력, REPL을 지원하며 기본 결과는 문장별 JSON입니다. `--csv`는 헤더를 포함한 CSV, `--explain`은 실제 조회 경로를 출력합니다. 파일은 첫 오류에서 멈추고 0이 아닌 종료 코드를 반환합니다. 앞서 커밋한 문장은 유지하고 미완료 트랜잭션은 폐기합니다.

기존 작업 중이던 바이너리 저장 Phase 1 코드는 `src/`, `include/`, `tests/`에 보존했습니다. 새 신뢰성 모델은 저장 형식과 복구 규칙이 달라 `reliable/`에 구현했습니다. 두 형식은 자동 호환되지 않습니다. 기존 문서와 SQL 인젝션 학습 내용은 [기존 Phase 1 문서](reliable/legacy-phase1-readme.md)에 그대로 보존했습니다.

## SQL과 파일 형식

테이블은 실행 전에 준비합니다. CREATE TABLE, ALTER TABLE, JOIN, GROUP BY, NULL, 서브쿼리는 지원하지 않습니다.

```text
my-data/
  characters.schema
  characters.csv
  items.schema
  items.csv
```

```text
# characters.schema
id INT AUTO
name VARCHAR(80)
attack INT
```

`INT`는 signed 64비트 정수, `VARCHAR(n)`은 UTF-8 바이트 수 기준 1~255입니다. 첫 열은 `id INT AUTO`, 열은 최대 32개입니다. SQL은 기본 4096바이트로 제한합니다. SQL의 키워드·식별자는 대소문자를 구분하지 않고 문자열 값은 보존합니다. 파일과 스키마의 이름은 소문자 `[a-z_][a-z0-9_]*`, 길이 1~63바이트로 준비합니다. CSV는 헤더 없이 스키마 순서로 기록합니다. 입력은 LF·CRLF를 허용하고 출력은 LF로 통일합니다. 쉼표·큰따옴표·인용된 줄바꿈을 처리하며 인용 필드 안의 큰따옴표는 두 번 기록합니다. 파일을 직접 수정하는 대신 SQL을 사용하세요. 초기화 이후 현재 CSV는 복구 결과물이며 기준본과 로그가 복구 기준입니다.

```sql
BEGIN;
INSERT INTO characters (attack,name) VALUES (100,'총웨');
INSERT INTO characters VALUES ('O''Brien, 슈',120);
UPDATE characters SET attack=150 WHERE id=1;
SELECT name,attack FROM characters
WHERE attack>=100 AND (name='총웨' OR id=2)
ORDER BY attack DESC,name ASC LIMIT 20;
SELECT COUNT(*) FROM characters WHERE attack>=100;
DELETE FROM characters WHERE attack<10;
COMMIT;
```

INSERT는 ID를 제외한 모든 값을 정확히 한 번 제공합니다. 열 목록을 생략하면 비자동 열의 스키마 순서입니다. ID 지정·변경은 거부합니다. WHERE는 같은 자료형의 비교와 AND·OR·괄호를 지원합니다. ORDER BY는 여러 열과 안정 정렬을 지원하며 LIMIT은 음수가 될 수 없습니다. ORDER BY가 없는 결과 순서는 보장하지 않습니다. 10,000행을 넘는 결과와 LIMIT 10001 이상은 조용히 자르지 않고 오류로 보고합니다. ORDER BY는 기본 최대 100만 후보를 메모리에 모아 안정 정렬하며, 후보 상한을 넘으면 LIMIT이 작아도 명시적으로 실패합니다.

## 트랜잭션과 성공 응답

BEGIN은 DB 전체의 같은 버전을 참조합니다. 삽입·수정·삭제는 개인 작업 공간에 보관하고 조회 시 원래 스냅샷과 합칩니다. 다른 세션에는 커밋 전까지 보이지 않습니다. BEGIN마다 DB 전체를 복사하지 않습니다.

쓰기 트랜잭션은 커밋할 때 시작 버전과 현재 버전을 비교합니다. 다른 변경이 먼저 커밋됐다면 충돌 오류를 반환합니다. 서로 다른 테이블을 변경해도 충돌할 수 있습니다. 충돌과 트랜잭션 내부 SQL 오류 이후에는 ROLLBACK이 필요합니다. 읽기 전용 트랜잭션은 기존 스냅샷을 계속 읽을 수 있습니다.

변경을 최종 확정하는 구간은 잠금으로 보호해 한 번에 하나씩 실행합니다. 트랜잭션 전체에 잠금을 유지하지 않으며, 공개된 파일과 인덱스는 수정하지 않습니다. 네트워크 I/O를 기다리는 동안 엔진 잠금을 보유하지 않습니다.

| 응답 | 의미 |
| --- | --- |
| `staged: true`, `NOT_COMMITTED` | 작업 공간에 반영했으며 아직 영구 저장되지 않았습니다 |
| `DURABLE` | 유효한 COMMIT 로그의 영구 저장을 확인했습니다 |
| `UNKNOWN` | I/O 실패로 커밋 여부를 확정할 수 없습니다 |
| `NO_CHANGES` | 읽기 전용 등 데이터 변경 없이 트랜잭션을 종료했습니다. COMMIT 로그 영구 저장을 뜻하지 않습니다 |
| `recovery_required: true` | 정상 SQL 처리를 멈추고 재시작 복구가 필요합니다 |

COMMIT 로그 영구 저장 이후의 CSV·APPLIED 오류를 롤백으로 응답하지 않습니다. 성공 응답 유실 시에도 이미 커밋됐을 수 있습니다. 요청 중복 제거와 정확히 한 번 실행은 보장하지 않으므로 INSERT를 무조건 재전송하지 마세요. 변경이 없는 트랜잭션의 `NO_CHANGES`는 쓰기 커밋 이력에 기록하지 않습니다. 알고 있는 쓰기 트랜잭션 ID는 CLI `--tx-status ID`로 복구 후 확정 여부를 확인할 수 있습니다. 서버가 해당 디렉터리를 사용 중이면 종료한 뒤 CLI에서 확인합니다. 응답을 잃어 식별자 자체를 모르면 이 수단만으로 요청을 특정할 수 없습니다.

## 복구와 내구성

첫 실행은 스키마와 초기 CSV를 검증해 변경하지 않는 기준본을 만듭니다. 초기화 완료 정보가 없거나 기준본·필수 로그가 손상되면 빈 DB로 시작하지 않습니다. 데이터 디렉터리의 프로세스 잠금은 CLI와 서버의 동시 소유를 막습니다.

변경 로그와 COMMIT을 영구 저장한 뒤 새 CSV를 반영하고 새 스냅샷을 공개합니다. APPLIED는 CSV 반영 완료 기록이며 COMMIT이나 체크포인트와 다릅니다. 시작 시에는 현재 CSV나 APPLIED 여부에 기대지 않고 기준본부터 유효한 전체 커밋을 재생합니다. 인덱스도 해당 CSV에서 다시 만듭니다. 중간 로그 손상은 건너뛰지 않습니다.

ID와 트랜잭션 식별자는 범위 단위로 영구 예약합니다. 롤백한 값과 재시작 시 남은 예약 구간은 다시 쓰지 않으므로 번호에 빈칸이 생깁니다.

정상 모드에서 로그·필요한 파일·디렉터리의 동기화를 생략하지 않습니다. 보장은 로컬 파일시스템·운영체제·저장장치가 동기화 계약을 지킨다는 전제입니다. SIGKILL 검증은 프로세스 종료 검증이며 실제 전원 차단 시험은 아닙니다. 초기화 완료 전 강제 종료는 초기 데이터를 정상 DB로 오인하지 않도록 시작을 거부합니다. 이 미완료 초기화의 자동 재개는 지원하지 않습니다. 정상 초기화 이후의 커밋·복구 장애는 자동 재생 대상입니다. 체크포인트·로그 정리는 없으므로 로그 사용량과 시작 시 전체 재생 시간이 증가합니다.

참고한 공식 문서: [PostgreSQL WAL](https://www.postgresql.org/docs/current/wal-intro.html), [InnoDB redo](https://dev.mysql.com/doc/refman/8.4/en/innodb-redo-log.html), [InnoDB undo](https://dev.mysql.com/doc/refman/8.4/en/innodb-undo-logs.html). 이 엔진은 미커밋 변경을 공개 CSV에 쓰지 않으므로 InnoDB의 디스크 undo 구조를 그대로 구현한 것이 아닙니다.

## HTTP API

```sh
export MINIDB_TOKEN='replace-with-your-local-secret'
./reliable/build/mini-db-server --data-dir /tmp/mini-db-demo --port 8080 --threads 4
curl http://127.0.0.1:8080/health
curl -s http://127.0.0.1:8080/query \
  -H "Authorization: Bearer $MINIDB_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"sql":"SELECT * FROM characters WHERE id=1;"}'
```

`POST /query`는 SQL 한 문장을 실행하며 변경은 자동 커밋합니다. 명시적 트랜잭션에는 세션 API를 사용합니다.

1. `POST /sessions`로 토큰을 받습니다.
2. `POST /sessions/{token}/query`에 BEGIN, SQL, COMMIT 또는 ROLLBACK을 순서대로 보냅니다.
3. `DELETE /sessions/{token}`으로 종료합니다.

한 세션의 동시 요청은 실행 전에 거부합니다. 세션은 소켓 연결과 별개이며 연결 종료가 확정된 COMMIT을 취소하지 않습니다. 서버는 네트워크 담당과 고정 SQL 작업자 풀을 분리합니다. 큐 포화는 실행 전 503, SQL·자료형 오류는 400, 충돌은 409, 내부 오류는 500으로 구분합니다. 실행 큐 포화는 완전한 503 응답을 처리하지만, 최대 연결 슬롯까지 소진되면 비차단 best-effort 503 뒤 연결을 닫으므로 응답 수신까지 보장하지 않습니다. `/health`도 작업자 큐를 공유해 부하 중 503을 반환할 수 있습니다.

HTTP/1.1, Content-Length 기반 요청, 요청당 연결 종료를 사용합니다. chunked·keep-alive·파이프라이닝은 지원하지 않습니다. JSON 본문은 `sql` 문자열 한 개만 허용합니다. INT·발급 ID·COUNT는 JavaScript 정밀도 손실을 막기 위해 **십진 문자열**로 전달하고 열 타입을 함께 반환합니다.

응답 JSON 생성의 내부 상한은 64MiB이며 한도를 넘으면 오류로 보고합니다. 송신 기한을 넘기면 연결이 닫힐 수 있습니다. Content-Length만큼 받지 못한 응답은 완성된 결과로 처리하지 마세요. 연결 종료로 이미 확정된 커밋이 취소되지는 않습니다.

`/health` 외에는 Bearer 인증을 요구하고 토큰·SQL 본문 전체를 로그에 남기지 않습니다. 기본 주소는 127.0.0.1이며 TLS는 구현하지 않았습니다. 외부 연결에는 TLS를 처리하는 리버스 프록시 또는 SSH 터널을 사용하세요.

조회 응답의 주요 필드는 다음과 같습니다. INT 값은 JSON 숫자가 아닌 문자열입니다.

```json
{
  "ok": true,
  "commit": "NOT_COMMITTED",
  "used_index": true,
  "columns": [{"name":"id","type":"INT"},{"name":"name","type":"VARCHAR"}],
  "rows": [["1","총웨"]]
}
```

서버 옵션은 `--data-dir`, `--bind`, `--port`, `--threads`, `--queue`, `--max-conn`, `--read-timeout`입니다. 요청 크기·유휴 세션·응답 한도는 위 정책을 적용합니다. 기본 내구성을 끄는 `--sync off` 옵션은 제공하지 않습니다.

## 검증과 벤치마크 재현

```sh
make test                 # 기존 구현 검사 + 새 엔진·HTTP 검사
make test-small-order     # B+ 트리 연속 분할
make test-crash           # 외부 부모가 실제 자식 프로세스에 SIGKILL
make asan                 # AddressSanitizer + UndefinedBehaviorSanitizer
make tsan                 # ThreadSanitizer, 별도 빌드
make bench                # 100만 건 실제 SQL INSERT와 조회 비교
make bench-server         # 실제 HTTP 동시 부하
```

벤치마크는 SQL 파서·검증·동일 INSERT 실행기를 통과합니다. CSV 직접 생성은 삽입 성능으로 사용하지 않습니다. 조회는 같은 한 행·같은 열을 반환하는 ID 조건과 다른 정수열 조건을 비교하고 터미널 출력 시간은 제외합니다. 커밋·재작성·복구 비용은 별도로 기록합니다. OS 캐시를 비운 실제 cold 측정과 단순 첫 실행을 혼동하지 않습니다.

### 실제 검사 결과

검증 환경은 macOS arm64, Apple clang 21.0.0, `-std=c11 -O2 -g -Wall -Wextra -Werror -pedantic`입니다. 2026-11-12에 실행했습니다.

| 검사 | 실제 결과 |
| --- | --- |
| 기존 Phase 1 단위·CLI 검사 | 통과, 기존 CLI 7개 테스트 포함 |
| SQL·B+ 트리·엔진·프로토콜 | 통과, SQL 30,000건·JSON 20,000건 결정적 퍼징 포함 |
| 참조 모델 | 한 세션의 SQL 600개와 재시작 후 117행 일치 |
| 실제 HTTP | 인증·세션·충돌·부분 전송·slow client·2,000개 비정상 프레임·재시작 통과 |
| 큐·종료 | 실행 1개/대기 1개 고정 후 503 미실행 거부, 같은 세션 BUSY, 종료 중 두 INSERT 완료·재시작 보존 |
| 세션·송신 수명 | 만료 시 미커밋 폐기, 실행 중 세션 유지, 느린 수신자의 송신 기한 정리·다른 조회 정상 처리 |
| 장애 복구 | 외부 SIGKILL 8지점, 반복 복구·다중 테이블·ID 예약·미완료 초기화 검사 통과 |
| I/O 오류 | 부분 로그 쓰기·로그 동기화·CSV 준비·APPLIED 실패 결과와 복구 상태 확인 |
| ASan·UBSan / TSan | 별도 빌드의 단위·통합·실제 소켓 검사 통과. TSan 검사 범위에서 race 경고 없음 |

[장애 지점별 실제 실행 결과](reliable/crash-results.txt)를 함께 보관합니다. SIGKILL 위치는 `tests/crash.py`, I/O 오류 위치는 `tests/io_failures.py`로 재현합니다.

`make asan`은 macOS에서 지원되지 않는 LeakSanitizer를 끄고 실행합니다. 메모리 누수 부재 전체를 입증했다는 뜻은 아닙니다. 일반 빌드 엔진 테스트를 `leaks --atExit -- ./reliable/build/test-engine`로 실행해 0 leaks를 관찰했고, 프로토콜 검사도 0 leaks였습니다. macOS의 디버깅 접근 제한 안내가 함께 출력됐으므로 이 관찰과 120초 자원 측정은 실행 범위의 증거로만 해석합니다. Clang 정적 분석도 최종 소스에서 경고 없이 완료했습니다.

### 100만 건 실측

빈 DB에 단일 트랜잭션으로 1,000,000개의 INSERT를 실행했습니다. ID와 다른 정수열 `k`에 같은 유일값을 넣고 `id,name,k`를 동일하게 반환했습니다. 각 조회 경로는 준비 실행 2회 뒤 고정 시드 42로 선택한 키 11개를 측정했습니다. 프로세스·OS 캐시가 따뜻한 조건이며 터미널 출력은 제외했습니다.

| 항목 | 실측 |
| --- | ---: |
| SQL 생성·파싱·검증·작업 공간 삽입 | 0.520초 |
| 최종 커밋 전체 | 4.337초 |
| 위 둘의 합계 | 4.857초 |
| 커밋 내부 CSV 작성·파일 동기화 | 1.520초 |
| 커밋 내부 인덱스 구축·검증 | 0.044초 |
| COMMIT·APPLIED 로그 동기화 | 0.011초 |
| ID 조회 중앙값 | 85μs |
| 다른 정수열 선형 탐색 중앙값 | 184.718ms |
| UPDATE 1행 + 전체 파일 재작성·커밋 | 1.552초 |
| DELETE 1행 + 전체 파일 재작성·커밋 | 1.519초 |
| 재시작·전체 복구·인덱스 재구축 | 2.695초 |
| 별도 무작위 키 B+ 트리 개별 삽입 구축 | 0.139초 / 39.68MiB |
| 별도 무작위 키 B+ 트리 bulk load | 0.119초 / 24.22MiB |

커밋 내부 세 항목은 전체 커밋을 모두 설명하는 합계가 아닙니다. 전체에는 변경 병합·로그 인코딩·로그 쓰기·파일 교체 등도 포함됩니다. `wal_sync_s`는 COMMIT·APPLIED 동기화이며 ID 범위 예약의 동기화는 삽입 시간에 포함됩니다. 재시작은 전체 로그 재생 비용까지 포함합니다. 개별 삽입·bulk load 비교는 CSV를 제외한 독립 인덱스 실험이고, 두 경로는 동일한 무작위 입력을 사용합니다. 작은 표본의 최댓값을 p99로 부르지 않습니다.

[원시 엔진 측정값](reliable/bench-results.json)을 함께 보관합니다.

### HTTP 부하 실측

별도로 실제 SQL 파일로 준비한 100만 행에서 작업자 1·2·4·8개와 클라이언트 1·4·16·64개의 모든 조합을 측정했습니다. 각 조합·부하당 128요청, 읽기 준비 실행 후 1회 측정이며 HTTP 연결·JSON·네트워크 시간을 포함합니다. 아래는 클라이언트 16개의 발췌입니다.

| 작업자 | 부하 | 전체 요청/초 | p99 | 성공 / 충돌 |
| ---: | --- | ---: | ---: | ---: |
| 1 | ID 읽기 | 4460.8 | 7.15ms | 128 / 0 |
| 1 | 읽기·쓰기 혼합 | 10.0 | 3223.18ms | 128 / 0 |
| 2 | ID 읽기 | 4526.5 | 6.21ms | 128 / 0 |
| 2 | 읽기·쓰기 혼합 | 21.1 | 3007.34ms | 124 / 4 |
| 4 | ID 읽기 | 5219.5 | 4.94ms | 128 / 0 |
| 4 | 읽기·쓰기 혼합 | 24.8 | 3485.08ms | 123 / 5 |
| 8 | ID 읽기 | 4522.1 | 5.76ms | 128 / 0 |
| 8 | 읽기·쓰기 혼합 | 21.3 | 2973.88ms | 124 / 4 |

혼합 부하는 128개 중 8개가 UPDATE입니다. 여러 작업자의 혼합 처리량에는 **충돌로 거부된 요청도 포함**되므로 높은 숫자를 성공한 쓰기 처리량으로 해석하면 안 됩니다. CSV 전체 재작성과 커밋 잠금이 쓰기의 병목입니다. 짧은 ID 조회는 Python 부하 도구·HTTP 처리 비용의 영향도 받아 작업자 수에 비례해 빨라지지 않았습니다. 실제 조회 중첩은 별도의 엔진 barrier 테스트로 검증합니다.

32개 배치에서 예상하지 않은 오류는 없었습니다. [전체 HTTP 결과](reliable/bench-server-results.json)에 모든 조합, 성공 처리량, 오류·충돌 수, 지연과 시작 시간을 보관합니다.

```sh
cd reliable
python3 tools/bench.py --count 1000000 --output bench-results.json
python3 tools/bench_server.py --count 1000000 --requests 128 \
  --workers 1,2,4,8 --clients 1,4,16,64 --workloads index,mixed \
  --output bench-server-results.json
python3 tools/soak.py --seconds 120 --output soak-results.json
```

### 120초 자원 관찰

동시 클라이언트 4개에서 정확한 SELECT 69,616건과 비정상 HTTP 거절 13,921건을 확인했습니다. 준비 구간 이후 RSS는 1,904→2,032KiB, 열린 FD는 11개로 유지됐습니다. 종료·재시작 후 행 수는 그대로였습니다. 메모리의 작은 변동만으로 누수 여부를 확정하지 않습니다. [원시 관찰 결과](reliable/soak-results.json)를 제공합니다.


## 자원 상한과 구조

기본 상한은 테이블 128개, 엔진 세션 256개(`MDB_MAX_SESSIONS`), 트랜잭션 변경 행 200만 개(`MDB_TX_MAX_CHANGES`), 정렬 후보 100만 개(`MDB_MAX_SORT_ROWS`)입니다. 환경변수로 허용 범위 내에서 조정합니다. HTTP 세션은 별도로 256개, 유휴 만료 300초이며 본문은 65,536바이트, 헤더 총 크기는 16,384바이트입니다. SQL·VARCHAR·결과 행 제한은 위 규칙을 적용합니다.

## 구조와 비용

핵심 흐름은 `CLI 또는 HTTP 작업자 → mdb_execute → 파서·검증 → 스냅샷/작업 공간 → 로그·커밋`입니다. 네트워크 담당은 소켓만, SQL 작업자는 엔진 호출만 담당합니다.

핵심 로직을 읽는 순서는 다음과 같습니다.

- `sql.c`: 비교·AND·OR의 재귀 하향 파싱과 arena 수명
- `bpt.c`: 분할 전에 노드를 확보하는 삽입, 리프 연결, bottom-up 구축과 불변식
- `engine.c`: `execute_select`의 CSV 오프셋·작업 공간 병합, `commit_tx`의 확정 순서, `recover`의 기준본·로그 재생
- `server.c`: 큐 잠금 밖에서 실행하는 작업자, 연결 세대 번호를 통한 오래된 완료 결과 차단

공개 인터페이스는 [mdb.h](reliable/include/mdb.h), 인덱스 인터페이스는 [bpt.h](reliable/include/bpt.h)입니다. AST는 요청별 arena, 결과는 호출자 소유이며 `mdb_result_free`로 해제합니다. 세션·스냅샷·파일·인덱스는 참조 수명에 따라 해제합니다.

UPDATE·DELETE와 커밋 시 CSV 재작성은 대규모 쓰기에 비쌉니다. 오래 열린 트랜잭션은 이전 파일·인덱스·메모리를 유지합니다. DB 전체 버전 충돌 정책 때문에 불필요한 쓰기 충돌이 발생할 수 있습니다. 이 비용을 숨기지 않고 실측과 함께 공개합니다. 디스크 기반 B+ 트리, 세밀한 행 잠금, 체크포인트·로그 정리, 요청 중복 제거는 현재 범위에 없습니다.

## AI 구현 토큰 사용량과 API 환산 비용

구현 시작 지시부터 완료 보고까지(2026-11-12 22:26:51~23:01:01, KST)의 로컬 실행 로그에서 누적 사용량 차이를 집계했습니다. 메인 에이전트와 서브에이전트·하위 검토 작업을 포함하며, 앞선 프롬프트 비교·작성과 이후 Git 작업·사용량 조회·문서 추가는 제외했습니다. 각 에이전트에 상속된 시작 누적값을 빼고 구현 구간의 증가분만 더했습니다.

모델은 로그에서 확인한 `gpt-6.1-sol`입니다. 아래는 **2026-11-13에 확인한 Standard API 단가를 적용한 토큰 비용 추정**이며, 실제 Codex 구독료나 청구액이 아닙니다.

| 구분 | 토큰 수 | 100만 토큰당 단가(USD) | 환산 비용(USD) |
| --- | ---: | ---: | ---: |
| 일반 입력(캐시 제외) | 283,566 | $2.00 | $0.567132 |
| 캐시에서 재사용한 입력 | 34,403,328 | $0.10 | $3.440333 |
| 출력 | 187,901 | $10.00 | $1.879010 |
| **합계** | **34,874,795** | — | **$5.886475 ≈ $5.89** |

```text
(283,566 × 2.00 + 34,403,328 × 0.10 + 187,901 × 10.00) / 1,000,000
= 5.8864748 USD
```

캐시 입력은 여러 요청에서 재사용한 문맥의 누적량이므로 총 토큰 수를 새로 작성한 코드량으로 해석하면 안 됩니다. 출력에는 추론 토큰 62,874개가 이미 포함돼 있어 별도로 더하지 않았습니다. 로그의 캐시 쓰기 토큰은 0으로 기록돼 별도 캐시 쓰기 비용은 반영하지 않았습니다.

요청당 최대 입력은 201,344토큰으로, 확인한 272,000토큰 초과 장문 요청 할증 기준에는 해당하지 않았습니다. 실제 서비스 등급은 이 로그로 확정하지 못해 Standard를 기준으로 삼았습니다. 같은 사용량에 Fast 단가(일반 입력 $4.00·캐시 입력 $0.20·출력 $20.00/100만 토큰)를 적용하면 약 **$11.77**입니다. 도구별 별도 이용료·세금·환율은 포함하지 않았으며, API에서 같은 구현을 다시 실행할 때 사용량과 비용이 같다는 보장은 없습니다.

단가와 계산 기준: [OpenAI GPT-6.1 Sol 공식 모델 문서](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [공식 API 요금표](https://developers.openai.com/api/docs/pricing), [토큰 집계 설명](https://developers.openai.com/api/docs/guides/token-counting). 원본 실행 로그에는 대화·로컬 환경 정보가 포함되므로 저장소에는 집계값만 기록했습니다.
