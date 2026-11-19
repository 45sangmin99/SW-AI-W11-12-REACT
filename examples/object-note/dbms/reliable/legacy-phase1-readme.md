# Mini DBMS

Phase 1·2의 DB 엔진은 C로, Phase 3의 API 서버는 Python으로 구성할 계획입니다. CLI와 서버가 같은 엔진을 호출하도록 분리합니다.

## 현재 구현 범위

Phase 1의 파일 기반 SQL 처리기를 구현했습니다. SQL 파일 → CLI → 파싱 → 스키마 검증 → 저장·조회 흐름이 동작합니다. C 엔진은 CLI와 분리하여 정적·공유 라이브러리로도 빌드합니다. B+ 트리와 Python API 서버는 다음 단계입니다. 현재 ID 조회도 선형 탐색합니다.

## 실행 방법과 데이터 폴더

C 컴파일러와 make가 필요하며 테스트에는 Python 3을 사용합니다. 아래 명령은 이 프로젝트 폴더에서 실행합니다.

```sh
make
./build/mini-db prepare --data-dir ./examples/demo-db
./build/mini-db init --data-dir ./examples/demo-db
./build/mini-db run ./examples/insert.sql
./build/mini-db run ./examples/select.sql
```

`prepare`는 이미 작성된 스키마를 읽어 없는 테이블 파일만 준비하는 보조 명령입니다. 기존 파일은 덮어쓰지 않습니다. 과제의 기존 테이블 전제를 준비하는 용도이며 SQL `CREATE TABLE` 구현은 아닙니다. 예제를 반복 실행하면 INSERT가 추가됩니다.

`init`은 데이터 폴더와 테이블을 검증한 뒤 절대 경로를 현재 작업 폴더의 `.mini-db`에 기록합니다. 이후 같은 작업 폴더에서 `run`을 호출하면 경로를 다시 전달하지 않아도 됩니다. 설정은 작업 폴더 단위이며 데이터는 지정한 폴더에 남습니다. 다른 작업 폴더에서는 다시 init해야 합니다.

```text
demo-db/
  schema.txt
  tables/
    users.tbl
    products.tbl
```

`schema.txt`는 한 줄에 테이블 하나를 정의합니다. 빈 줄과 #로 시작하는 줄은 무시합니다.

```text
users id:INTEGER name:TEXT(64) age:INTEGER
products id:INTEGER name:TEXT(128) price:INTEGER
```

스키마 이름은 소문자 ASCII 식별자를 사용하고 SQL 예약어는 제외합니다. 첫 컬럼은 자동 발급하는 `id:INTEGER`입니다. 최대 128개 테이블, 테이블당 128개 컬럼을 지원합니다. 기존 바이너리 파일에 맞지 않게 스키마만 수정하면 열기를 거부합니다. 문자열 용량을 늘리려면 새 스키마의 테이블에 데이터를 옮기는 별도 마이그레이션이 필요합니다.

## SELECT와 SQL 실행

```sql
INSERT INTO users (age, name) VALUES (25, '민수');
SELECT * FROM users;
SELECT name, id FROM users WHERE age = 25;
SELECT * FROM users WHERE name = '민수';
```

SELECT는 전체 컬럼 또는 지정한 컬럼 목록, 선택적인 단일 `WHERE 컬럼 = 정수/문자열` 조건을 지원합니다. AND·OR·범위 조건·JOIN·정렬·집계는 지원하지 않습니다. INSERT는 id를 제외한 모든 컬럼을 명시하며, 컬럼을 나열하는 순서는 자유입니다. 실행기가 스키마 순서로 값을 재배열하고 존재 여부·타입·길이를 검사합니다.

SQL 파일에서 문자열 밖의 세미콜론으로 여러 문장을 구분하며 순서대로 실행합니다. 마지막 세미콜론은 생략 가능합니다. 결과는 INSERT의 ID·파일 위치와 SELECT의 컬럼·행·건수를 담는 JSON 배열입니다. 오류는 stderr와 실패 종료 코드로 전달합니다. 오류가 나면 이후 문장을 실행하지 않으며, 앞서 성공한 INSERT는 유지합니다. 파일 전체를 하나의 트랜잭션으로 처리하지 않습니다.

[engine.h](./include/engine.h)의 `db_engine_open()` → `db_engine_execute()` → `db_engine_close()`가 공통 진입점입니다. 실행 결과 문자열은 `db_result_free()`로 해제합니다. CLI는 경로 설정·SQL 파일 읽기·출력을 담당하며 SQL 처리 자체는 엔진을 호출합니다. 공유 라이브러리를 Python ctypes에서 호출하는 테스트도 포함합니다. Thread Pool을 위한 같은 엔진의 동시 호출 제어는 아직 구현하지 않았습니다.

## 학습 실험: SQL 인젝션

현재 CLI는 사용자가 작성한 SQL 파일을 실행하는 도구입니다. SQL 파일에 여러 명령을 직접 쓰는 것 자체는 인젝션이 아닙니다. 외부 입력을 SQL 문자열에 그대로 이어 붙이는 호출 코드를 만들면, 데이터가 명령으로 해석되는 SQL 인젝션이 가능합니다. 현재 파라미터 바인딩은 없으며, 이 동작은 학습 실험을 위해 그대로 둡니다.

예를 들어 호출 코드가 다음과 같이 SQL을 조립한다고 가정합니다.

```c
snprintf(sql, sizeof(sql),
         "INSERT INTO users (name, age) VALUES ('%s', 25);",
         user_input);
```

`snprintf()`는 버퍼 크기를 제한할 뿐 SQL 문법과 데이터를 분리하지 않습니다. 버퍼가 충분히 크고 입력값이 다음과 같으면:

```text
민수', 25); INSERT INTO users (name, age) VALUES ('공격자
```

완성된 SQL은 INSERT 두 개가 됩니다.

```sql
INSERT INTO users (name, age) VALUES ('민수', 25);
INSERT INTO users (name, age) VALUES ('공격자', 25);
```

별도 실험용 데이터 폴더에서 위 SQL을 `injection.sql`로 저장하고 다음 명령으로 엔진의 실행 결과를 확인할 수 있습니다. 이는 입력을 이어 붙인 **결과 SQL의 재현**이며, 현재 CLI에 사용자 이름 입력 기능이 있다는 뜻은 아닙니다.

```sh
./build/mini-db run injection.sql
```

두 INSERT 결과가 반환되고 `SELECT * FROM users;`로 조회하면 두 행이 추가되어 있습니다. 문자열 안에 있던 작은따옴표가 문자열을 닫고, 문자열 밖의 세미콜론이 새 문장을 시작하게 된 것입니다. 토크나이저·파서에는 정상적인 SQL 두 문장이므로 문법 검사만으로 호출자의 의도와 다른 명령임을 알아낼 수 없습니다.

OR·주석을 지원하지 않아 전형적인 로그인 우회 예시는 거부하지만, 그것이 인젝션 방지를 의미하지는 않습니다. 비교 학습할 주제는 같은 입력을 파라미터 바인딩으로 전달했을 때 전체가 하나의 문자열 값으로 저장되는 차이입니다. 이 문서 추가에서는 차단 로직이나 실행 동작을 변경하지 않았습니다.

## INSERT 파싱

[sql.h](./include/sql.h), [sql_lexer.c](./src/sql_lexer.c), [sql_parser.c](./src/sql_parser.c)는 SQL 문자열을 토큰으로 나눈 뒤 테이블·컬럼·값을 소유하는 `DBInsert` 구조체로 변환합니다. `strtok()` 대신 따옴표를 인식하는 재진입 토크나이저를 사용합니다.

```sql
INSERT INTO users (name, age) VALUES ('김,민수; O''Brien', 25);
```

키워드는 대소문자를 무시하고, 식별자는 ASCII 이름을 소문자로 정규화합니다. 문자열 내부 쉼표·세미콜론·공백은 구분자로 취급하지 않으며 `''`는 작은따옴표 하나입니다. 정수는 signed 64비트 범위를 검사합니다. 명시적 컬럼 목록과 단일 VALUES 튜플만 지원하며 마지막 세미콜론은 선택입니다. 단일 INSERT의 여러 튜플·NULL·실수·주석·표현식은 지원하지 않습니다. 여러 SQL 문장의 분리는 엔진이 담당합니다. 오류는 원본의 0부터 시작하는 바이트 위치로 보고합니다. 입력은 최대 1 MiB, 컬럼·값은 최대 1024개입니다.

파서는 문법을 구조화할 뿐 저장을 실행하지 않습니다. 테이블 존재·스키마의 컬럼과 타입 검증, 컬럼명 기준 값 재배열은 실행기 책임입니다. `db_sql_insert_free()`로 AST와 문자열을 해제합니다.

### C에서 문자열 안의 쉼표·따옴표 읽기

예를 들어 `'김,''민수'', O''Brien', 25`를 읽으면 문자열 값은 `김,'민수', O'Brien`이고 남은 입력은 `, 25`입니다. 여는 작은따옴표를 만나면 문자열 전용 읽기에 들어갑니다. 이 안의 쉼표는 일반 데이터이며, 연속된 `''`는 작은따옴표 하나로 복원합니다. 단독 작은따옴표는 문자열 종료이고, 닫히기 전에 입력이 끝나면 오류입니다.

다음은 원리를 보여주는 독립적인 C 예시입니다. `cursor`는 여는 따옴표를 가리키며, 성공하면 닫는 따옴표 다음으로 이동합니다. 반환값은 호출자가 `free()`합니다. NULL은 잘못된 시작·닫히지 않은 문자열·메모리 할당 실패를 뜻합니다.

```c
#include <stdlib.h>
#include <string.h>

char *read_sql_string(const char **cursor)
{
    const char *p = *cursor;
    if (*p != '\'') return NULL;

    char *value = malloc(strlen(p) + 1);
    if (value == NULL) return NULL;

    size_t length = 0;
    p++; // 여는 따옴표 건너뛰기
    while (*p != '\0') {
        if (*p == '\'') {
            if (p[1] == '\'') {
                value[length++] = '\'';
                p += 2; // ''는 작은따옴표 하나
            } else {
                value[length] = '\0';
                *cursor = p + 1;
                return value;
            }
        } else {
            value[length++] = *p++; // 쉼표도 그대로 복사
        }
    }
    free(value);
    return NULL;
}
```

실제 [sql_lexer.c](./src/sql_lexer.c)의 `db_sql_lexer_next()`도 같은 규칙으로 동작합니다. 다만 위 예시처럼 남은 입력 전체 크기를 할당하지 않고, 먼저 닫는 따옴표를 찾으며 복원될 바이트 수를 센 뒤 필요한 크기만 할당하고 두 번째 순회에서 복사합니다. 작은 문자열마다 큰 버퍼를 확보하는 일을 피하기 위한 차이입니다. 결과는 `DB_SQL_STRING` 토큰의 `text`에 담고, 다음 읽기 위치와 원본 바이트 길이도 기록합니다. 닫히지 않은 문자열은 시작 위치를 포함한 오류로 반환합니다.

파서는 문자열 내부의 쉼표와 따옴표를 다시 문법으로 해석하지 않습니다. 이미 완성된 문자열 토큰 하나를 받아 AST의 값으로 사용합니다.

## 자동 ID

[records.h](./include/records.h), [records.c](./src/records.c)는 일반 저장 API 위에 ID 자동 발급 계층을 둡니다. 스키마의 첫 컬럼을 `id INTEGER`로 고정하고, 호출자는 나머지 컬럼 값만 순서대로 전달합니다. 빈 테이블은 1부터 시작하고, 성공한 저장 후에만 다음 번호로 넘어갑니다. 길이·타입 검증 실패는 번호를 소모하지 않습니다.

재열기 시 파일을 선형으로 검사해 마지막 ID 다음부터 이어갑니다. 기존 ID는 양수이며 물리적인 행 순서대로 엄격히 증가해야 합니다. 중복·역순 ID는 오류로 거부하며, INT64_MAX에 도달하면 더 삽입하지 않습니다. 파일 위치는 ID와 별도로 반환하여 B+ 트리 연결에 사용할 수 있습니다. ID 재구성은 열기 시 O(n), 열린 동안 다음 ID 결정은 O(1)입니다.

일반 `db_table_append()`는 바이너리 저장 자체를 위한 저수준 API여서 자동 ID를 강제하지 않습니다. 자동 발급을 원하는 엔진은 `db_records_insert()`를 사용해야 합니다. 실행기는 이 계층을 통해 SQL INSERT의 ID를 발급합니다. 같은 레코드 핸들을 여러 스레드에서 공유하는 동시성 제어는 향후 서버 단계의 작업입니다.

## 파일 규격

`struct` 메모리를 그대로 저장하지 않고, 필드별 바이트를 명시적으로 인코딩합니다. 정수는 little-endian, 음수는 64비트 2의 보수 표현입니다.

| 구간 | 크기 | 내용 |
| --- | --- | --- |
| 파일 헤더 | 8바이트 | 형식 표시 `MINIDB01` |
| 파일 헤더 | 4바이트 | 행 크기 |
| 파일 헤더 | 4바이트 | 컬럼 이름·타입·길이·순서의 FNV-1a 검사값 |
| 각 INTEGER | 8바이트 | 부호 있는 64비트 정수 |
| 각 TEXT(N) | 4 + N바이트 | 실제 길이 4바이트 + 문자열을 위한 고정 N바이트 공간 |

예를 들어 `id INTEGER`, `name TEXT(64)`, `age INTEGER`는 행마다 `8 + 68 + 8 = 84`바이트입니다. 문자열이 짧아도 다음 행의 위치는 변하지 않습니다. 길이는 문자 수가 아닌 바이트 수이며 문자열 초과는 자르지 않고 오류로 거부합니다. UTF-8을 담을 수 있지만 인코딩 유효성 검사는 아직 하지 않습니다. 현재 문자열 API는 NUL 종료 C 문자열이며 문자열 내부 NUL과 SQL NULL은 지원하지 않습니다.

```text
파일 위치 = 16 + 행 번호 × 행 크기

B+ 트리(향후): ID → 파일 위치 → 해당 레코드 읽기
```

열 이름·타입은 각 행에 반복 저장하지 않습니다. 저장 공간이 문자열 최대 길이에 따라 낭비되는 대신, 파일 위치 계산과 경계 검사가 단순합니다. 스키마 검사값은 형식 불일치를 찾는 보조 검사이며 충돌 없는 스키마 식별자나 데이터 무결성 체크섬은 아닙니다.

## 저장 API

[include/storage.h](./include/storage.h)에 인터페이스, [src/storage.c](./src/storage.c)에 구현이 있습니다.

- `db_table_create()` — 기존 파일을 덮어쓰지 않고 빈 테이블 파일 준비
- `db_table_open()` — 헤더·스키마·행 경계 검사 후 열기. 스키마 정보는 내부 복사
- `db_table_append()` — 컬럼 수·타입·문자열 길이를 확인한 뒤 추가, 파일 위치 반환
- `db_table_read()` — 행 번호로 조회
- `db_table_read_offset()` — 인덱스가 전달할 파일 위치로 조회
- `db_row_free()` — 조회 결과와 문자열 메모리 해제
- `db_table_close()` — 테이블 자원 해제

Phase 1에서는 파일을 여는 동안 advisory exclusive lock을 유지하여 다른 테이블 핸들이 동시에 여는 것을 거부합니다. 같은 핸들을 여러 스레드에서 병렬 호출하는 기능은 아직 지원하지 않으며, Phase 3의 동시성 설계와 별개입니다. 협조하지 않는 외부 프로그램의 파일 수정까지 막는 잠금은 아닙니다.

쓰기 전 검증 실패는 행을 추가하지 않습니다. 성공 시 `fflush()`로 버퍼를 전달하지만 `fsync()`·WAL·트랜잭션을 구현한 것은 아니므로 전원 장애에서의 내구성은 보장하지 않습니다. 쓰기 도중 실패하면 부분 레코드가 남을 수 있으며 닫은 뒤 점검해야 합니다. 불완전한 행 경계와 읽을 때 발견한 잘못된 문자열 길이는 오류로 거부합니다.

## 빌드와 검증

```sh
make          # CLI + 정적 라이브러리 + 공유 라이브러리
make test     # C 단위 테스트 + 실제 CLI/공유 라이브러리 기능 테스트
make sanitize # AddressSanitizer + UndefinedBehaviorSanitizer로 C 코드 재검증
```

- `tests/storage_test.c`: 고정 행·파일 위치·재열기 영속성, 문자열과 정수 경계, 스키마 불일치, 잠금, 손상된 행 검사
- `tests/sql_parser_test.c`: INSERT AST, 문자열 구분자·따옴표, 정수 범위, 잘못된 SQL, 재진입과 입력 제한
- `tests/records_test.c`: 자동 ID, 재열기 연속성, 실패 삽입의 번호 보존, 중복·범위 초과
- `tests/cli_test.py`: 실제 프로세스와 임시 데이터 폴더로 INSERT/SELECT, 컬럼 순서와 조건, 프로세스 간 영속성, 설정, 스키마·SQL 오류, 중간 실패, JSON 이스케이프, 공유 라이브러리 직접 호출 검증

Phase 2에서는 ID → 파일 위치 인덱스를 연결하고 100만 건 이상으로 인덱스 조회와 선형 탐색을 비교합니다. Phase 3에서는 이 엔진 위에 Python API와 Thread Pool, 동시성 제어를 추가합니다.
