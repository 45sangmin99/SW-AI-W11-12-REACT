CC = cc
CPPFLAGS = -Iinclude
CFLAGS = -std=c11 -Wall -Wextra -Werror -pedantic -O2 -fPIC
CORE = src/storage.c src/records.c src/sql_lexer.c src/sql_parser.c src/engine.c
OBJECTS = build/storage.o build/records.o build/sql_lexer.o build/sql_parser.o build/engine.o
ifeq ($(shell uname -s),Darwin)
SHARED = build/libminidb.dylib
SHARED_FLAGS = -dynamiclib
else
SHARED = build/libminidb.so
SHARED_FLAGS = -shared
endif

.PHONY: all test sanitize clean
all: build/mini-db build/libminidb.a $(SHARED)

build:
	mkdir -p build

build/storage.o: src/storage.c include/storage.h | build
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@

build/sql_lexer.o: src/sql_lexer.c include/sql.h include/storage.h | build
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@

build/sql_parser.o: src/sql_parser.c include/sql.h include/storage.h | build
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@

build/records.o: src/records.c include/records.h include/storage.h | build
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@

build/engine.o: src/engine.c include/engine.h include/sql.h include/records.h include/storage.h | build
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@

build/main.o: src/main.c include/engine.h include/sql.h include/storage.h | build
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@

build/mini-db: build/main.o $(OBJECTS)
	$(CC) $(CFLAGS) $^ -o $@

$(SHARED): $(OBJECTS)
	$(CC) $(SHARED_FLAGS) $^ -o $@

build/libminidb.a: $(OBJECTS)
	$(AR) rcs $@ $^

build/storage-test: tests/storage_test.c src/storage.c include/storage.h | build
	$(CC) $(CPPFLAGS) $(CFLAGS) tests/storage_test.c src/storage.c -o $@

build/sql-parser-test: tests/sql_parser_test.c src/sql_lexer.c src/sql_parser.c src/storage.c include/sql.h include/storage.h | build
	$(CC) $(CPPFLAGS) $(CFLAGS) tests/sql_parser_test.c src/sql_lexer.c src/sql_parser.c src/storage.c -o $@

build/records-test: tests/records_test.c src/records.c src/storage.c include/records.h include/storage.h | build
	$(CC) $(CPPFLAGS) $(CFLAGS) tests/records_test.c src/records.c src/storage.c -o $@

test: all build/storage-test build/sql-parser-test build/records-test
	./build/storage-test
	./build/sql-parser-test
	./build/records-test
	python3 tests/cli_test.py ./build/mini-db

sanitize: all | build
	$(CC) $(CPPFLAGS) -std=c11 -Wall -Wextra -Werror -pedantic -g -O1 -fsanitize=address,undefined -fno-omit-frame-pointer tests/storage_test.c src/storage.c -o build/storage-test-sanitized
	./build/storage-test-sanitized
	$(CC) $(CPPFLAGS) -std=c11 -Wall -Wextra -Werror -pedantic -g -O1 -fsanitize=address,undefined -fno-omit-frame-pointer tests/sql_parser_test.c src/sql_lexer.c src/sql_parser.c src/storage.c -o build/sql-parser-test-sanitized
	./build/sql-parser-test-sanitized
	$(CC) $(CPPFLAGS) -std=c11 -Wall -Wextra -Werror -pedantic -g -O1 -fsanitize=address,undefined -fno-omit-frame-pointer tests/records_test.c src/records.c src/storage.c -o build/records-test-sanitized
	./build/records-test-sanitized
	$(CC) $(CPPFLAGS) -std=c11 -Wall -Wextra -Werror -pedantic -g -O1 -fsanitize=address,undefined -fno-omit-frame-pointer src/main.c $(CORE) -o build/mini-db-sanitized
	python3 tests/cli_test.py ./build/mini-db-sanitized

clean:
	rm -rf build

# Reliable CSV/WAL engine; original Phase 1 sources and targets are preserved.
.PHONY: reliable reliable-test asan tsan test-small-order test-crash bench bench-server
all: reliable
reliable:
	$(MAKE) -C reliable all
test: reliable-test
reliable-test:
	$(MAKE) -C reliable test
asan tsan test-small-order test-crash bench bench-server:
	$(MAKE) -C reliable $@

.PHONY: reliable-clean
clean: reliable-clean
reliable-clean:
	$(MAKE) -C reliable clean
