# Mini Redis — C++20 / HTTP / AOF

직접 만든 chaining hash table과 indexed TTL heap을 사용하는 단일 프로세스 저장소다. 핵심 서버는 C++20/POSIX이며 외부 라이브러리가 없다. Python 표준 라이브러리로 실제 HTTP 통합 테스트, 별도 상품 API, 벤치마크를 제공한다. 구현·검증 환경은 **macOS ARM64**다. Linux용 POSIX API를 사용했지만 Linux 실행 검증은 수행하지 않았다.

## 빌드와 실행

C++20 컴파일러, CMake 3.16 이상, Python 3, POSIX 환경이 필요하다.

```sh
cmake -S . -B build/cmake -DCMAKE_BUILD_TYPE=Release
cmake --build build/cmake -j2
ctest --test-dir build/cmake --output-on-failure

mkdir -p data
./build/cmake/mini-redis --host 127.0.0.1 --port 6380 --aof-path ./data/appendonly.aof
# 다른 터미널
python3 example/product_api.py --port 8080 --redis-port 6380 --ttl 60
```

SIGINT(Ctrl-C)/SIGTERM은 시그널 플래그만 설정한다. 이벤트 루프 종료 후 연결을 정리하고, fsync 스레드가 마지막 동기화를 시도한 뒤 join하며 AOF fd를 닫는다. 종료 중 미처 응답하지 못한 명령은 실행됐을 수 있다. `shutdown appended=... synced=...` 로그는 **destructor의 최종 fsync 이전** 스냅샷이다. 최종 동기화 완료는 시험 이벤트 `sync_done`으로 확인한다.

현재 호스트에는 CMake가 없었으므로 `build/tools`의 격리된 Python 가상환경에 CMake 4.4.5와 clang-format을 설치해 CTest를 실제 실행했다. 시스템 Python 패키지는 변경하지 않았다. 이 환경에서는 `cmake`/`ctest` 대신 `build/tools/bin/cmake`/`build/tools/bin/ctest`를 사용할 수 있다. 실행 서버의 패키지 의존성은 없다. CMake 없이도 다음 명령이 동작한다.

```sh
make -j2
make test
make benchmark
```

`make`는 `build/mini-redis`, `build/unit-tests`를 생성한다. `make benchmark`는 `build/engine-bench`도 생성한다. `make sanitize`는 Make 산출물을 sanitizer 버전으로 덮어쓴다. 벤치마크 전에 `make -B all build/engine-bench`로 최적화 빌드를 복구해야 한다. 별도 sanitizer 빌드가 권장된다.

```sh
cmake -S . -B build/sanitize -DCMAKE_BUILD_TYPE=Debug -DSANITIZE=ON
cmake --build build/sanitize -j2
ctest --test-dir build/sanitize --output-on-failure
```

## 공개 HTTP 계약

```sh
curl -i -X PUT http://127.0.0.1:6380/keys/keyboard \
  -H 'Content-Type: application/json' \
  --data-binary '{"value":"keyboard","ttl_seconds":60}'
# 204, 본문 없음
curl -i http://127.0.0.1:6380/keys/keyboard
# 200 {"value":"keyboard"}
curl -i http://127.0.0.1:6380/keys/keyboard/ttl
# 200 {"ttl_seconds":60} (실제 남은 시간에 따라 감소)
curl -i -X DELETE http://127.0.0.1:6380/keys/keyboard
# 204, 본문 없음
curl -i http://127.0.0.1:6380/keys/keyboard
# 404 {"error":"key not found"}
```

| 동작 | 성공 | 없는/만료된 키 |
|---|---|---|
| `PUT /keys/{key}` | 204 | 생성 가능 |
| `GET /keys/{key}` | 200 `{"value":"..."}` | 404 |
| `GET /keys/{key}/ttl` | 200 `{"ttl_seconds":정수 또는 null}` | 404 |
| `DELETE /keys/{key}` | 204 | 404 |

`value`는 필수 JSON 문자열이며 빈 문자열도 값이다. TTL은 생략 가능한 양의 JSON 정수다. 0·음수·소수·지수 표기·문자열·null·bool·정수/만료 시각 오버플로는 400이다. 중복/알 수 없는 필드, trailing comma, 잘못된 UTF-8/Unicode escape/짝 없는 surrogate도 400이다. TTL 생략 덮어쓰기는 기존 TTL을 제거한다. TTL은 남은 양의 ms를 초로 올림하며 만료 시각과 같아지는 순간 404다.

경로 segment를 **먼저 분리하고 한 번만** percent-decode한다. `a/ttl` 키는 `/keys/a%2Fttl`, 이 키의 TTL은 `/keys/a%2Fttl/ttl`이다. `+`는 그대로 `+`다. 빈 키, 512바이트 초과, 잘못된 encoding, ASCII/C1 제어문자와 유효하지 않은 UTF-8 키를 거부한다. 쿼리/fragment는 지원하지 않으며 필요한 문자 자체는 percent-encode한다. 공개 명령 추가, RESP/redis-cli 호환은 없다.

잘못된 요청은 `{"error":"..."}` 형태다. 미지원 메서드 405, 경로 없음 404, JSON/HTTP 구문 오류 400, 명시한 Content-Type이 JSON이 아니면 415, 본문 초과 413, 헤더 초과 431, Expect 미지원 417, 쓰기/자원 실패 503이다. Content-Type 생략은 허용한다. JSON은 `application/json` 또는 `application/json; charset=utf-8`을 받는다. 상세 저장 장치 오류는 stderr에 기록한다. 204 응답 본문은 비어 있다.

## 구조와 스레드

| 파일 | 책임 |
|---|---|
| `src/engine.hpp` | 키/값 소유, FNV-1a, chaining, 점진적 재배치, indexed heap, validate |
| `src/aof.hpp` | 바이너리 레코드, 잠금, append/replay/repair, 백그라운드 fsync |
| `src/http.hpp`, `src/text.hpp` | 스트리밍 HTTP/엄격한 JSON/UTF-8 검증과 직렬화 |
| `src/main.cpp` | CLI, 소켓 RAII, poll 연결 루프, HTTP→명령 매핑 |
| `tests/` | 단위/실제 프로세스 통합/실패 주입 및 실행 결과 |
| `example/` | 한 번 로드한 상품 데이터와 별도 HTTP API |
| `benchmarks/` | 재현 스크립트, 직접 GET 측정, 관측 결과/타임라인 |

키 공간에 접근하는 실행 흐름은 이벤트 루프 하나다. 연결별 명령 스레드를 만들지 않는다. HTTP 파싱 → 검증 → 명령 실행 → 응답 생성이 이 흐름에서 직렬 실행된다. GET은 한 PUT의 완전한 문자열을 읽는다. DELETE 204 완료 후 새 PUT 없이 시작한 GET은 404다. 백그라운드 스레드는 AOF fd/원자적 watermark/종료 상태만 다루며 키 공간을 보지 않는다.

리스닝/연결 소켓은 non-blocking이고 poll()을 사용한다. 부분 recv/send, 연속 요청, Keep-Alive와 pipeline을 지원하며 같은 연결 응답은 FIFO다. 매 연결 read/write는 반복당 각각 최대 64KiB, 명령은 연결당 4개/전체 64개, accept는 16개다. 연결 처리 시작점을 회전한다. TTL active 정리는 반복당 64개다. 기본 poll 대기는 10ms다.

동일 Content-Length 중복도 보수적으로 400으로 거부한다. Transfer-Encoding은 chunked를 포함해 전부 거부한다. Host가 필수다. framing 오류는 그 연결에 오류 응답 후 닫는다. 짧은 본문은 추가 바이트를 기다리며, write-half-close로 부족함이 확정되면 400, 유휴 타임아웃이면 연결을 닫는다. 클라이언트가 선언한 길이보다 뒤에 보낸 바이트는 HTTP/1.1의 다음 요청으로 해석한다. 이 경우 임의로 길이를 추정하지 않는다.

기본 한도는 헤더 16KiB, 본문 1MiB, 누적 입력 1,100,000바이트, 연결 256개, 무활동 10초다. 출력 2MiB 도달 시 추가 읽기/명령 실행을 멈추므로, 마지막 단일 응답까지 포함하면 약 3.1MiB 미만의 문자열이 연결별로 대기할 수 있다(allocator capacity 제외). 연결 한도를 넘으면 새 연결을 닫는다. 느린 수신자에게 다른 연결의 진행을 맡기지 않는다. 전체 프로세스 RSS 제한은 제공하지 않는다.

CLI: `--host`(IPv4, 기본 127.0.0.1), `--port`(6380), `--aof-path`(appendonly.aof), `--memory-limit`(67108864), `--max-connections`(256), `--idle-seconds`(10). 메모리 한도는 **엔트리 구조체+키+값 논리 바이트**의 한도이며 버킷/heap capacity/문자열 여유 용량/네트워크 버퍼/AOF 임시 문자열은 포함하지 않는다. 이 한도 초과 시 데이터를 축출하지 않고 PUT을 503으로 거부한다. 배열/노드 실제 할당 실패도 성공으로 처리하지 않는다. 불변식 오류/복구 불가능 예외는 fail-stop 처리한다.

인증/TLS는 없다. 기본은 loopback이며, 외부 바인딩은 신뢰할 수 있는 환경에서만 명시적으로 선택해야 한다. 소켓과 영속화의 POSIX 코드는 각각 main/aof 모듈에 모여 있다. Windows는 지원하지 않는다.

## 해시 테이블과 TTL

FNV-1a 64비트를 직접 구현했다. 최초 버킷은 4개이며 2의 거듭제곱이다. `hash & (size-1)`로 버킷을 고르고 체인에서 전체 키를 비교한다. UPDATE는 기존 엔트리를 갱신하고 DELETE는 해당 노드만 제거한다. `std::map`/`unordered_map`으로 키 공간을 대신하지 않는다. `unordered_set`은 hot path 밖의 validate에서만 쓴다.

다음 삽입의 load factor가 0.75를 넘으면 두 배 배열을 미리 준비한다. 신규 삽입은 새 배열에 넣고 조회/삭제는 두 배열을 확인한다. 한 step은 **최대 4노드 이동/8버킷 전진**으로 제한된다. 긴 충돌 체인도 한 번에 전부 이동하지 않는다. 노드 주소는 그대로이고 TTL heap의 포인터도 그대로 유지된다. 완료하면 이전 배열을 해제한다. 재배치 중에는 추가 확장을 시작하지 않고 완료 후 다음 PUT 준비에서 필요 시 확장한다.

새 버킷 배열 할당/초기화와 heap capacity 증가 자체는 동기 작업이다. 노드 이동 예산이 모든 PUT 시간을 엄격히 제한하는 것은 아니다. 시작/완료 횟수, old/new 배열 크기, 이동 노드/전진 버킷 수, step의 최대 노드/스캔/시간을 stderr와 내부 카운터로 관측한다. 단계 완료 로그가 다음 루프에서 나와 시작과 완료가 한 로그에 함께 보일 수도 있다.

validate는 실제 노드 수/바이트 수, 올바른 버킷, 키 중복, 엔트리와 heap의 양방향 일치, heap 순서를 검사한다. 복구 완료 후 listen 이전과 정상 종료 시 실행하며 hot path에서 매번 호출하지 않는다. 단위 무작위 검사에서는 주기적으로 실행한다.

TTL은 Unix epoch ms 절대 시각이다. TTL 없는 엔트리는 heap에 없다. 엔트리는 heap index를 보유하고 heap은 안정적인 엔트리 포인터를 보유한다. 갱신/제거는 O(log n), key lookup은 해시 테이블을 사용한다. TTL 재설정/해제/삭제/재생성 시 오래된 예약을 남기지 않는다. Passive expiration은 키 접근 때 항상 확인하고, active expiration은 heap root부터 예산 내에서 지운다. 만료 DEL은 AOF에 따로 쓰지 않는다.

테스트에 시계를 주입해 만료 1ms 전/정확한 경계/동시 만료/정리 예산을 sleep 없이 확인하고, 1200ms→2초/100ms→1초 및 큰 정수의 올림을 단위 검사했다. HTTP 테스트는 실제 경과도 확인한다. 벽시계가 뒤로 이동하면 아직 제거되지 않은 키의 실제 수명이 길어질 수 있고, 앞으로 뛰면 즉시 만료될 수 있다. 이미 제거한 엔트리는 시계가 돌아와도 현재 프로세스에서 복구하지 않는다. AOF가 절대 시각을 보유하므로 벽시계 역행 후 재시작에서는 이전 만료 PUT이 다시 유효하게 해석될 여지가 있다. monotonic TTL로 의미를 바꾸지 않았으며 시계 동기화가 운영 전제다.

## AOF와 성공 응답의 의미

PUT은 JSON/TTL/논리 한도 검사 → 문자열·노드·heap capacity·필요한 버킷 배열 준비 → 레코드 문자열 준비 → 전체 append → 예외 없는 메모리 commit → 204 순서다. UPDATE commit은 문자열 swap과 heap/pointer 연산만 한다. DELETE도 엔트리 확인 → append → 해당 포인터 제거 → 204다. 없는/만료된 키 DELETE는 404이며 DEL 레코드를 추가하지 않는다. 실제 allocator 실패 주입과 commit 중 allocator 차단으로 이 경계를 검사했다.

레코드는 고정 폭 **little endian**이다. `MRD1`이 버전 1을 나타낸다.

| 오프셋 | 크기 | 필드 |
|---|---|---|
| 0 | 4 | ASCII `MRD1` |
| 4 | 4 | 레코드 전체 바이트 수 = 41+key_length+value_length |
| 8 | 4 | 헤더 CRC32: bytes [0,8)+[12,37) |
| 12 | 8 | sequence (1부터 연속) |
| 20 | 1 | `P` PUT / `D` DELETE |
| 21 | 8 | epoch ms 만료 시각 (0은 무기한) |
| 29 | 4 | key_length |
| 33 | 4 | value_length (DELETE는 0) |
| 37 | 가변 | key, value 바이트 |
| 끝-4 | 4 | 앞의 전체 레코드에 대한 CRC32 |

CRC32는 표준 IEEE 다항식 0xEDB88320이다. 레코드 최대 1,100,000바이트, 키 최대 512바이트, 값 최대 1MiB다. 헤더 자체 CRC가 길이 필드 손상을 검출하므로 중간 길이 손상을 잘린 꼬리로 오인해 지우지 않는다. CRC는 악의적 변조를 인증하지 않는다.

append는 EINTR/짧은 write를 반복하며 전체 레코드 성공 후에만 `appended_seq`를 게시한다. 실패하면 메모리에 반영하지 않고 프로세스 수명 동안 이후 변경을 차단한다. 부분 레코드는 남을 수 있으며 다음 시작에서 규칙에 맞는 꼬리만 절단한다. 읽기/TTL은 계속 제공한다. 이미 append와 commit이 끝났어도 fsync 실패가 그 사이 관측되면 503을 보낼 수 있다. **실패 응답이나 끊긴 연결은 rollback을 뜻하지 않는다.** 재시도 전에 현재 상태를 확인할 수 있지만, 이 API는 exactly-once 요청 식별을 제공하지 않는다.

백그라운드 스레드는 약 1초 대기 후 dirty 여부를 확인한다. 새 append가 없으면 fsync를 생략한다. 호출 직전 `target_seq=appended_seq`를 저장하고 AOF 상태 mutex 없이 `fsync(fd)`를 실행한다. 성공하면 `synced_seq=target_seq`까지만 게시한다. 겹친 이후 append는 다음 주기에 남는다. GET/TTL은 이 스레드와 공유 락을 잡지 않는다. 종료 플래그의 condition-variable mutex와 시험 이벤트 파일 mutex는 fsync 호출 동안 유지하지 않는다. fsync 실패는 stderr/시험 이벤트/이후 변경 요청 503으로 드러나며 GET/TTL은 허용한다.

시작 시 flock(LOCK_EX|LOCK_NB) → 파일 크기/각 헤더·레코드 CRC/길이·type·sequence·텍스트·만료 의미 검사 → 동일 keyspace 변경 경로로 replay → 복구 파일 fsync/워터마크 초기화 → 만료 제거/validate → 부모 디렉터리 fsync → listen 순서다. 복구된 완전한 레코드도 시작 시 fsync한 다음 synced watermark를 설정한다. 같은 AOF 파일을 두 프로세스가 동시에 소유할 수 없다. 잠금은 같은 inode를 대상으로 하므로 운영 중 AOF를 외부에서 교체/수정/삭제해서는 안 된다.

끝의 잘린 헤더(올바른 magic prefix/가능한 길이) 또는 유효한 헤더 뒤 부족한 본문만 마지막 완전 오프셋으로 ftruncate하고 fsync한다. 완전 레코드 CRC 오류, 헤더 CRC 오류, 불가능한 명령/길이/sequence는 시작 실패다. 손상 로그를 빈 파일로 초기화하지 않는다. ftruncate 직후/fsync 전에 SIGKILL 후 재시작하는 idempotence도 검증했다. CRC로도 구분할 수 없는 일부 짧은 마지막 헤더 prefix 손상은 잘린 꼬리와 구별할 수 없다.

**204는 append+메모리 반영 성공이며 해당 쓰기의 fsync 완료를 의미하지 않는다.** 전원/OS/저장 장치 장애로 미동기화 append가 사라지면 이미 204를 받은 쓰기도 유실될 수 있다. 1초는 호출 주기이며 데이터 손실 시간의 엄격한 상한이 아니다. 지연 주입 시 주기는 완료 후 다음 1초를 기다리므로 더 길어진다. SIGKILL은 OS 페이지 캐시를 지우지 않는다. 이번 검증은 실제 프로세스 강제 종료이며 전원 장애 재현이 아니다. macOS에서도 요청된 fsync를 사용하며 F_FULLFSYNC나 저장 장치 내부 캐시/하드웨어 보장은 검증하지 않았다.

## 상품 API

`example/products.json`을 시작 시 한 번 파싱해 메모리에 저장한다. `lookup_product()` 하나가 원본 조회와 카운터 증가를 담당한다. 요청마다 파일을 다시 읽지 않는다.

```sh
curl -i 'http://127.0.0.1:8080/products/1001?cache=off'
curl -i 'http://127.0.0.1:8080/products/1001?cache=on'
curl -s http://127.0.0.1:8080/stats
curl -i -X DELETE http://127.0.0.1:6380/keys/product%3A1001
```

OFF는 Mini Redis를 전혀 호출하지 않는다. ON은 `GET product:1001` → HIT이면 저장된 상품 문자열을 JSON으로 읽어 반환 → 404 MISS이면 원본 조회 후 `PUT+TTL`하고 반환한다. 본문은 OFF/ON이 동일하고 `X-Data-Source: origin|redis`로 출처만 구별한다. `/stats`는 origin/hit/miss/error 누계다. 서버 재시작으로 통계를 초기화하며 벤치마크는 전후 차이를 사용한다. Redis 연결 실패/5xx/잘못된 캐시 값은 404로 간주하지 않고 502다.

예제 API는 Python ThreadingHTTPServer이며 동시 원본 조회 counter는 락으로 보호한다. 같은 키의 동시 MISS를 합치는 single-flight는 없다. 이런 경우 여러 번 원본을 조회할 수 있다. 주 벤치마크는 서로 다른 512개 키를 각 1회 사용하는 분포라 같은 키의 중복 원본 호출이 발생하지 않는 조건이다.

## 검증 실행과 결과

```sh
./build/unit-tests
python3 tests/integration.py ./build/mini-redis
python3 benchmarks/run.py ./build/mini-redis
./build/engine-bench
```

마지막 Make 검사: 단위 바이너리 1개 통과, 실제 서버 통합 **12개 그룹 통과/실패 0**. CTest Release **2/2 통과**, ASan+UBSan Debug **2/2 통과**이며 ASan/UBSan 진단은 없었다. unit은 40,000회 seeded 무작위 연산을 참조 unordered_map과 대조하고 충돌/여러 확장/heap·TTL/경계/실제 allocator 실패/할당 없는 commit을 검사한다. CTest의 integration 하나 안에서 다음 12개 그룹을 실행한다. 실제 실행 로그는 `tests/make-results.txt`, `tests/release-results.txt`, `tests/sanitizer-results.txt`에 있다. 기본 6380/8080 포트에서도 curl로 네 명령과 상품 OFF/MISS/HIT를 실행했으며 원문 응답은 `tests/curl-results.txt`에 있다.

| 그룹 | 실제 검증 |
|---|---|
| `http_contract` | 204/200/404, 빈 값/escape, TTL/해제, 잘못된 JSON·경로·TTL, 실패 시 AOF 불변 |
| `streaming_keepalive_isolation` | 3바이트 분할, 10개 pipeline FIFO, 길이 충돌/chunked 거부, half-close, 느린 본문/유휴 격리 |
| `backpressure_connection_limits` | 큰 응답을 안 읽는 연결과 정상 GET 공존, 과대 헤더, 최대 연결 초과 거부 |
| `concurrent_linearization` | barrier로 8 writers+8 readers 겹침, PUT 160회/GET 480회 완전 값, DELETE 후 GET 80회 모두 404 |
| `recovery_sigkill_tail_corruption_lock` | sync 완료 후 SIGKILL/재시작, DEL/TTL 비연장·다운 중 만료, tail repair+추가 PUT+재시작, 본문·길이 손상 거부, 중복 소유 거부 |
| `interrupted_tail_repair` | ftruncate 직후 fsync 전 강제 종료, 반복 복구 및 추가 append 유지 |
| `write_sync_memory_failures` | write 0/12바이트 후 실패, 메모리 한도, fsync 오류, append와 겹친 fsync 오류에서 204 금지 |
| `prepare_failure_short_writes` | 준비 실패 시 로그/키 불변, 3바이트씩 짧은 write 반복 성공 및 replay |
| `sigkill_during_append` | 동기화 완료 키 유지, 다음 append 지연 도중 SIGKILL, 미완료 요청의 연결 종료 |
| `fsync_watermark_overlap` | fsync cycle 시작 확인 → 완료 전 GET·새 PUT 완료, target=1 완료 때 seq=2 완료로 오표시하지 않음, 다음 sync 후 SIGKILL 복구 |
| `append_blocks_get` | append 지연 시작 이벤트 후 실제 GET을 보내 대기 지연 확인 |
| `product_cache_scenarios` | 첫 MISS/두 번째 HIT/실제 TTL 만료/DELETE 후 MISS, origin 1→3, OFF 본문 동일, 덮어쓰기, Redis 장애 502 |

오류/지연 주입은 `--test-hooks`를 명시해야 활성화된다. 기본에는 시험 HTTP 엔드포인트가 없다. 옵션은 `--append-delay-ms`, `--sync-delay-ms`, `--repair-delay-ms`, `--fail-write-after`(레코드별 성공 바이트 수, 기본 -1), `--write-chunk-size`, `--fail-sync 1`, `--fail-prepare 1`, `--events PATH`다. sync 지연은 **fsync syscall 직전**에 놓인 시험 지연이며 실제 커널 syscall을 느리게 만든 것이 아니다. 이벤트 파일은 epoch ms와 append_start/done/error, sync_start/done/error 및 target sequence, repair_truncated를 기록한다. 프로덕션 명령 계약과 분리했다. 실제 disk-full/파일시스템 I/O fault는 수행하지 않았고 동일 실패 분기를 시험 후크로 재현했다.

## 측정 환경과 재현

2026-11-16, Apple M2, RAM 8GiB, Darwin 25.5.0/macOS ARM64, Apple Clang 21.0.0, Python 3.9.6. 성능 수치는 Make **`-std=c++20 -O2 -g -pthread`** 빌드다. CMake Release 검사는 별도로 수행했다. 모든 서비스/클라이언트는 loopback의 같은 호스트에 있다. 프로세스를 코어에 고정하거나 다른 호스트 작업을 차단하지 않았다. 실행마다 OS의 빈 포트를 사용하고 임시 AOF를 생성/정리한다. AOF 1초 fsync 설정과 시험 이벤트 계측은 모든 비교군에서 동일하다.

```sh
make -B -j2 all build/engine-bench
python3 benchmarks/run.py ./build/mini-redis > benchmarks/run.log
./build/engine-bench > benchmarks/engine-direct.txt
```

`benchmarks/results.json`은 환경, p50/p95/p99/max/RPS, 원본·HIT·MISS·실패 수, PUT 지연, 서버 재배치 로그, append/sync 이벤트, GET/PUT 시작·완료 raw monotonic ns 타임라인과 wall-clock 변환 기준점을 저장한다. 벤치마크 스크립트를 실행하면 이 관측 파일을 갱신한다. `benchmarks/run.log`에도 요약이 있다. 아래는 **한 번의 관측**이며 통계적 성능 향상 주장/신뢰구간은 아니다. 분위수는 정렬 후 nearest rank `ceil(n*q)-1`이다. 실패는 별도 집계하며 이번 모든 군에서 0이었다.

상품 API는 매 비교 실행 전에 원본 파일 파싱을 끝내며 시작 시간은 지연에 넣지 않는다. 기본 3개 상품 대신 벤치마크가 512개 상품 JSON(짧은 id/name/price)을 생성한다. OFF 16회 워밍업 후, OFF/MISS/HIT 각각 같은 512개 ID를 1회 순회한다. MISS 전에 키들을 DELETE하고, 이어진 HIT는 MISS가 채운 동일 512개 캐시를 사용한다. TTL 120초. 동시성 1/8에서 worker별 strided 동일 순서이며 각 worker는 HTTP keep-alive를 사용한다(최초 TCP 연결 비용 포함). 상품 API→Mini Redis 연결은 요청마다 새 연결이다. 본문 동일성도 매 응답 확인한다. 원본 카운터는 워밍업/준비를 뺀 전후 차이다.

| 군 | 동시 수 | 요청/고유 키 | p50 ms | p95 ms | 원본 호출 | HIT / MISS | 실패 |
|---|---:|---:|---:|---:|---:|---:|---:|
| OFF | 1 | 512 / 512 | 0.1732 | 0.5426 | 512 | 0 / 0 | 0 |
| MISS | 1 | 512 / 512 | 0.4915 | 1.2649 | 512 | 0 / 512 | 0 |
| HIT | 1 | 512 / 512 | 0.2500 | 0.3717 | 0 | 512 / 0 | 0 |
| OFF | 8 | 512 / 512 | 0.8870 | 3.2362 | 512 | 0 / 0 | 0 |
| MISS | 8 | 512 / 512 | 2.8701 | 5.4825 | 512 | 0 / 512 | 0 |
| HIT | 8 | 512 / 512 | 1.8792 | 3.6390 | 0 | 512 / 0 | 0 |

이 데이터에서는 원본이 이미 메모리에 있고 HIT 중앙값이 OFF보다 컸다. p95의 상대 순서는 동시 수와 스케줄링에 따라 달랐다. HIT은 원본 호출을 제거했지만 추가 HTTP 통신·JSON 처리 비용이 있다. MISS는 GET 404+원본+PUT까지 수행한다. 현실 DB/외부 API의 느린 원본을 흉내 낸 수치는 아니다. TTL/DELETE 후 MISS는 별도 기능 검사에서 확인했으며 대량 지연 측정 군에는 넣지 않았다.

HTTP GET 병목은 모든 군에서 클라이언트 8개×200회=1,600 GET, 기존 3개 키의 64바이트 값을 같은 순서로 읽는다. barrier로 reader/writer를 함께 시작한다. 리해싱 군은 8회 확장했고 서버 종료 계측은 `shutdown appended=603 synced=603 moved=765 scanned=1020 max_scans=8 max_nodes=4 max_ns=10541`였다. 카운터의 `moved`는 모든 확장을 합한 이동 횟수이며 동일 엔트리가 여러 확장에서 다시 이동할 수 있다. append 지연 50ms 군의 PUT p50/p95는 59.1402/66.5945ms였고 GET 410개가 PUT 요청 구간과 겹쳤다. GET/PUT raw 구간과 서버 epoch 이벤트는 results.json에서 비교할 수 있다. 계측된 step 시간에는 재배치 중인 호출의 scheduler 선점도 포함된다. 재배치가 없는 호출은 시간 계측에서 제외한다.

| 조건 | 동시/GET 수 | 관측 창 ms | p50 ms | p95 ms | p99 ms | 최대 ms | 겹친 GET/PUT 수 | 실패 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline | 8 / 1600 | 2000.253 | 0.5524 | 1.5056 | 3.2749 | 6.0122 | 0 / 0 | 0 |
| rehash | 8 / 1600 | 2001.936 | 0.3473 | 1.0529 | 1.5456 | 2.4749 | 897 / 600 | 0 |
| append_delay | 8 / 1600 | 2005.110 | 0.5526 | 52.8734 | 56.8837 | 59.6561 | 410 / 12 | 0 |
| fsync_delay | 8 / 1600 | 2005.108 | 0.6363 | 1.4170 | 1.9603 | 2.8990 | 0 / 0 | 0 |

리해싱 군은 8회 확장했고 서버 종료 계측은 `shutdown appended=603 synced=0 moved=765 scanned=1020 max_scans=8 max_nodes=4 max_ns=2417`였다. 카운터의 `moved`는 모든 확장을 합한 이동 횟수이며 동일 엔트리가 여러 확장에서 다시 이동할 수 있다. append 지연 50ms 군의 PUT p50/p95는 58.7632/67.8411ms였고 GET 411개가 PUT 요청 구간과 겹쳤다. GET/PUT raw 구간과 서버 epoch 이벤트는 results.json에서 비교할 수 있다. 계측된 step 시간에는 재배치가 진행 중인 호출의 scheduler 선점도 포함된다. 재배치가 없는 호출은 시간 계측에서 제외한다.

모든 조건은 2초의 관측 창을 목표로 한다. worker당 5ms 간격의 고정 시각에 200회 GET을 시작하며, 이전 요청이 지연되면 그 worker는 완료 후 밀린 요청을 이어 보낸다. 600개 리해싱 PUT은 1.5ms 간격을 목표로 투입한다. 스케줄러 때문에 실제 창은 2초보다 조금 길 수 있으며 아래에 관측값을 적었다. CPU 부하/스케줄링은 통제하지 않았다. 리해싱 군의 p95가 baseline보다 작아도 개선을 증명하지 않는다. 점진적 재배치가 있어도 배열 준비/노드 이동/동기 append 중에는 한 실행 흐름에서 GET이 기다린다. 별도 fsync 지연 군은 같은 50ms급 대기 효과를 보이지 않았지만, 커널의 fsync가 다른 I/O나 append에 끼치는 영향까지 없다고 주장하지 않는다.

직접 엔진 GET은 `benchmarks/engine.cpp`가 256키/64바이트 값으로 64회 호출을 한 묶음으로 측정해 호출당 ns로 나눈다. 조건별 10,000묶음=640,000 GET이며 loop/체크섬 누계/해시 비용과 timer overhead를 포함한다. **단건 지연 분위수가 아닌 묶음 평균의 분위수**다. 처음 단건 측정은 약 42ns 시계 해상도로 0이 나와 이 방식으로 바꿨다. PUT/rehash step 시간은 측정 묶음 밖이므로 직접 수치에는 HTTP 큐 대기가 들어가지 않는다. 초기 256키 채우기의 확장 카운터도 direct 로그에 포함된다.

| 직접 GET 조건 | GET 수 | 묶음당 호출 수 | 호출당 p50 ns | p95 ns | p99 ns |
|---|---:|---:|---:|---:|---:|
| baseline | 640000 | 64 | 24.7344 | 31.25 | 33.8438 |
| rehash | 640000 | 64 | 12.375 | 17.5781 | 20.8281 |

## 평가 연결표와 한계

| 평가 항목 | 구현 | 증거/결과 |
|---|---|---|
| 동시성 | 단일 poll 명령 실행/원자적 commit | `concurrent_linearization`, `append_blocks_get` 통과 |
| 만료 | 절대 TTL/indexed heap/passive+active | 단위 시계·heap 검증, `http_contract`, `recovery_sigkill_tail_corruption_lock` 통과 |
| 외부 API | 한 번 로드/공통 lookup/캐시 어사이드 | `product_cache_scenarios`, 6개 상품 측정 군 성공 |
| 무효화 | append 후 엔트리+heap 제거 | DELETE 후 GET 80회 404, 상품 원본 재조회 통과 |
| 장애 보존 | AOF/백그라운드 fsync/CRC/repair/잠금 | sync 경합·오류·SIGKILL·손상·repair 중단 그룹 모두 통과 |
| 해시 엔진 | FNV/chaining/두 배열/이동 예산 | 단위 40,000회 참조 대조·충돌·다중 확장·validate 통과 |
| 성능 | 원본/MISS/HIT, GET 원인별 지연 | c=1/8 상품 3,072회, HTTP GET 6,400회, direct GET 1,280,000회 실측 |

필수 네 API, HTTP 서버, 자체 해시/TTL, AOF, 예제 API, 자동 테스트와 성능 측정은 구현했다. 제외 범위는 복제/클러스터/RESP/트랜잭션/추가 명령/메모리 축출/디스크 계층화다. AOF rewrite/압축은 없으므로 로그는 계속 커지고 복구는 로그 길이에 비례한다. 키 공간 cap은 RSS cap이 아니다. 헤더 이름/Content-Type 등은 제한된 HTTP subset이며 범용 웹 서버가 아니다. 대형 동시 워크로드에서 전체 메모리/RSS 압력이나 랜덤 해시 공격 방어를 인증하지 않았다(FNV는 비밀키 없는 해시).

실제 전원 차단/스토리지 손실, Linux 실행, ThreadSanitizer, 파일시스템 자체 오류/ENOSPC, 광범위한 장시간 soak/fuzz, allocator 실패 위치의 완전한 열거는 **미검증**이다. ASan/UBSan과 실행 가능한 후크 범위는 실제 수행했다. 물리 내구성 검증에는 별도 VM/파일시스템 fault 도구/전원 차단 환경이 필요하다. 성능 결과는 이 호스트·이 요청 패턴의 관측값이며 보편적인 캐시 가속이나 엄격한 tail latency 보장이 아니다.
