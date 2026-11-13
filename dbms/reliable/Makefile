CC = cc
CPPFLAGS = -Iinclude -D_POSIX_C_SOURCE=200809L -D_FILE_OFFSET_BITS=64
CFLAGS = -std=c11 -O2 -g -Wall -Wextra -Werror -pedantic
LDLIBS = -pthread
BUILD ?= build
CORE = src/common.c src/sql.c src/bpt.c src/engine.c
OBJ = $(CORE:src/%.c=$(BUILD)/%.o)
ifeq ($(shell uname -s),Darwin)
ASAN_ENV = detect_leaks=0
else
ASAN_ENV = detect_leaks=1
endif
.PHONY: all test asan tsan test-small-order test-crash test-queue test-lifecycle test-console bench bench-server clean
all: $(BUILD)/mini-db $(BUILD)/mini-db-server $(BUILD)/mini-db-console $(BUILD)/libmdb.a
$(BUILD):
	mkdir -p $@
$(BUILD)/%.o: src/%.c include/mdb.h include/bpt.h | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@
$(BUILD)/mini-db: $(OBJ) $(BUILD)/cli.o
	$(CC) $(CFLAGS) $^ $(LDLIBS) -o $@
$(BUILD)/mini-db-server: $(OBJ) $(BUILD)/server.o $(BUILD)/query_json.o
	$(CC) $(CFLAGS) $^ $(LDLIBS) -o $@
$(BUILD)/libmdb.a: $(OBJ) $(BUILD)/query_json.o
	$(AR) rcs $@ $^
$(BUILD)/test-%: tests/test_%.c $(OBJ) | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) $< $(OBJ) $(LDLIBS) -o $@
$(BUILD)/test-engine: tests/test_engine.c $(CORE) include/mdb.h include/bpt.h | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -DMDB_TESTING tests/test_engine.c $(CORE) $(LDLIBS) -o $@
$(BUILD)/test-bpt: tests/test_bpt.c src/bpt.c include/bpt.h | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -DMDB_BPT_TEST_ALLOC tests/test_bpt.c src/bpt.c $(LDLIBS) -o $@
$(BUILD)/test-protocol: tests/test_protocol.c $(OBJ) $(BUILD)/query_json.o | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) $< $(OBJ) $(BUILD)/query_json.o $(LDLIBS) -o $@
test: test-queue test-lifecycle test-console all $(BUILD)/test-sql $(BUILD)/test-bpt $(BUILD)/test-engine $(BUILD)/test-protocol
	./$(BUILD)/test-sql
	./$(BUILD)/test-bpt
	./$(BUILD)/test-engine
	./$(BUILD)/test-protocol
	MDB_CLI="$(CURDIR)/$(BUILD)/mini-db" python3 tests/integration.py
	MDB_CLI="$(CURDIR)/$(BUILD)/mini-db" python3 tests/corruption.py
	MDB_CLI="$(CURDIR)/$(BUILD)/mini-db" python3 tests/io_failures.py
	MDB_CLI="$(CURDIR)/$(BUILD)/mini-db" python3 tests/model.py
	MDB_CLI="$(CURDIR)/$(BUILD)/mini-db" MDB_SERVER="$(CURDIR)/$(BUILD)/mini-db-server" python3 tests/test_server.py
asan:
	ASAN_OPTIONS=$(ASAN_ENV) $(MAKE) BUILD=build/asan CFLAGS='-std=c11 -O1 -g -Wall -Wextra -Werror -pedantic -fsanitize=address,undefined -fno-omit-frame-pointer' test test-crash test-small-order
tsan:
	TSAN_OPTIONS=halt_on_error=1 $(MAKE) BUILD=build/tsan CFLAGS='-std=c11 -O1 -g -Wall -Wextra -Werror -pedantic -fsanitize=thread -fno-omit-frame-pointer' test test-small-order
test-small-order: | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -DBPT_ORDER=4 -DMDB_BPT_TEST_ALLOC tests/test_bpt.c src/bpt.c $(LDLIBS) -o $(BUILD)/test-bpt-small
	./$(BUILD)/test-bpt-small
test-crash: all
	MDB_CLI="$(CURDIR)/$(BUILD)/mini-db" python3 tests/crash.py
bench: all
	python3 tools/bench.py --count 1000000
bench-server: all
	python3 tools/bench_server.py
$(BUILD)/bench: tools/bench.c $(OBJ) | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) $< $(OBJ) $(LDLIBS) -o $@
clean:
	rm -rf build

$(BUILD)/mini-db-server-test: src/server.c src/query_json.c $(CORE) include/mdb.h include/bpt.h | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -DMDB_TESTING src/server.c src/query_json.c $(CORE) $(LDLIBS) -o $@
test-queue: all $(BUILD)/mini-db-server-test
	MDB_CLI="$(CURDIR)/$(BUILD)/mini-db" MDB_SERVER_TEST="$(CURDIR)/$(BUILD)/mini-db-server-test" python3 tests/test_queue.py

$(BUILD)/mini-db-server-lifecycle: src/server.c src/query_json.c $(CORE) include/mdb.h include/bpt.h | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -DMDB_TESTING -DSESSION_TTL=1 src/server.c src/query_json.c $(CORE) $(LDLIBS) -o $@
test-lifecycle: all $(BUILD)/mini-db-server-lifecycle
	MDB_CLI="$(CURDIR)/$(BUILD)/mini-db" MDB_SERVER_LIFECYCLE="$(CURDIR)/$(BUILD)/mini-db-server-lifecycle" python3 tests/test_lifecycle.py

# ---- Mini DB 콘솔: 입력 -> 실행 -> 출력 (엔진 라이브러리를 직접 호출한다)
$(BUILD)/console_core.o $(BUILD)/console.o: include/console.h
$(BUILD)/mini-db-console: $(OBJ) $(BUILD)/console_core.o $(BUILD)/console.o
	$(CC) $(CFLAGS) $^ $(LDLIBS) -o $@
$(BUILD)/test-console-core: tests/test_console_core.c $(OBJ) $(BUILD)/console_core.o include/console.h | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) tests/test_console_core.c $(OBJ) $(BUILD)/console_core.o $(LDLIBS) -o $@
test-console: all $(BUILD)/test-console-core
	./$(BUILD)/test-console-core
	MDB_CLI="$(CURDIR)/$(BUILD)/mini-db" MDB_CONSOLE="$(CURDIR)/$(BUILD)/mini-db-console" python3 tests/test_console.py
