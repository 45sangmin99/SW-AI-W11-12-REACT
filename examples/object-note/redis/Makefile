CXX = clang++
CXXFLAGS = -std=c++20 -O2 -g -Wall -Wextra -Wpedantic -pthread
all: build/mini-redis build/unit-tests
build:
	mkdir -p build
build/mini-redis: src/main.cpp src/engine.hpp src/aof.hpp src/http.hpp src/text.hpp | build
	$(CXX) $(CXXFLAGS) src/main.cpp -o $@
build/unit-tests: tests/unit.cpp src/engine.hpp src/http.hpp src/text.hpp | build
	$(CXX) $(CXXFLAGS) tests/unit.cpp -o $@
test: all
	./build/unit-tests
	python3 tests/integration.py ./build/mini-redis
sanitize:
	$(MAKE) CXXFLAGS='-std=c++20 -O1 -g -Wall -Wextra -pthread -fsanitize=address,undefined -fno-omit-frame-pointer' -B all
	$(MAKE) test
.PHONY: all test sanitize
build/engine-bench: benchmarks/engine.cpp src/engine.hpp | build
	$(CXX) $(CXXFLAGS) benchmarks/engine.cpp -o $@
benchmark: all build/engine-bench
	python3 benchmarks/run.py ./build/mini-redis
	./build/engine-bench
.PHONY: benchmark
