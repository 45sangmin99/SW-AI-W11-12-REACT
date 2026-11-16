#include "../src/engine.hpp"
#include "../src/http.hpp"
#include <cstdlib>
#include <iostream>
#include <new>
#include <random>
#include <unordered_map>
// Fail actual allocator calls, including node/string/vector preparation.
static int fail_after = -1;
void *operator new(std::size_t n) {
    if (fail_after == 0)
        throw std::bad_alloc();
    if (fail_after > 0)
        --fail_after;
    if (auto *p = std::malloc(n ? n : 1))
        return p;
    throw std::bad_alloc();
}
void operator delete(void *p) noexcept { std::free(p); }
void *operator new[](std::size_t n) { return ::operator new(n); }
void operator delete[](void *p) noexcept { ::operator delete(p); }
using namespace mini;
#define CHECK(x)                                                                                   \
    do {                                                                                           \
        if (!(x))                                                                                  \
            throw std::runtime_error(#x);                                                          \
    } while (0)
int main() {
    try {
        int allocation_failures = 0;
        for (int at = 0; at < 8; ++at) {
            Keyspace allocation;
            allocation.put("existing", "old", wall_ms() + 100000);
            allocation.put("two", "v");
            allocation.put("three", "v");
            std::string k(100, 'k'), v(100, 'v');
            bool failed = false;
            try {
                fail_after = at;
                auto p = allocation.prepare(k, v, wall_ms() + 100000);
                fail_after = -1;
                allocation.commit(std::move(p));
            } catch (const std::bad_alloc &) {
                fail_after = -1;
                failed = true;
                ++allocation_failures;
            }
            CHECK(allocation.get("existing")->value == "old");
            CHECK(bool(allocation.get(k)) == !failed);
            allocation.validate();
        }
        CHECK(allocation_failures >= 4);
        {
            Keyspace atomic;
            atomic.put("k", "old", wall_ms() + 100000);
            auto p = atomic.prepare("k", std::string(1000, 'x'), wall_ms() + 200000);
            fail_after = 0;
            atomic.commit(std::move(p));
            fail_after = -1;
            CHECK(atomic.get("k")->value == std::string(1000, 'x'));
            atomic.validate();
        }
        CHECK(remaining_seconds(2200, 1000) == 2);
        CHECK(remaining_seconds(1100, 1000) == 1);
        CHECK(remaining_seconds(1001, 1000) == 1);
        CHECK(remaining_seconds(1000, 1000) == 0);
        CHECK(remaining_seconds(INT64_MAX, 0) == 9223372036854776LL);
        int64_t now = 1000;
        Keyspace ks(64 * 1024 * 1024, [&] { return now; });
        ks.put("a", "", 2001);
        CHECK(ks.get("a") && ks.get("a")->value.empty());
        now = 2000;
        CHECK(ks.get("a"));
        now = 2001;
        CHECK(!ks.get("a"));
        ks.put("a", "v", 3000);
        ks.put("a", "permanent");
        now = 4000;
        CHECK(ks.get("a")->expiry == 0);
        for (int i = 0; i < 100; ++i)
            ks.put("ttl" + std::to_string(i), "v", 5000);
        CHECK(ks.heap_size() == 100);
        now = 5000;
        CHECK(ks.expire(7) == 7);
        CHECK(ks.heap_size() == 93);
        CHECK(!ks.get("ttl99"));
        ks.expire(1000);
        ks.validate();
        ks.del("a");
        std::unordered_map<std::string, std::pair<std::string, int64_t>> model;
        std::mt19937 rng(44);
        for (int i = 0; i < 40000; ++i) {
            now += rng() % 3;
            std::string k = "k" + std::to_string(rng() % 800);
            auto it = model.find(k);
            if (it != model.end() && it->second.second && it->second.second <= now) {
                model.erase(it);
                it = model.end();
            }
            switch (rng() % 4) {
            case 0: {
                std::string v = std::to_string(rng());
                int64_t exp = rng() % 2 ? now + 1 + rng() % 500 : 0;
                ks.put(k, v, exp);
                model[k] = {v, exp};
                break;
            }
            case 1:
                CHECK(ks.del(k) == (it != model.end()));
                model.erase(k);
                break;
            default: {
                auto *e = ks.get(k);
                CHECK(bool(e) == (it != model.end()));
                if (e)
                    CHECK(e->value == it->second.first);
            }
            }
            ks.step(1, 1);
            if (i % 20 == 0)
                ks.validate();
        }
        ks.validate();
        CHECK(ks.starts >= 4 && ks.finishes >= 4 && ks.max_step_nodes <= 1);
        std::vector<std::string> collisions;
        for (int i = 0; collisions.size() < 20; ++i) {
            auto k = "collision" + std::to_string(i);
            if ((hash(k) & 2047) == 0)
                collisions.push_back(k);
        }
        {
            Keyspace chain;
            for (auto &k : collisions)
                chain.put(k, "x", wall_ms() + 100000);
            while (chain.new_buckets())
                chain.step(1, 1);
            auto *stable = chain.get(collisions[10]);
            chain.put("trigger", "v");
            CHECK(chain.new_buckets() > 0);
            auto before = chain.moved;
            chain.step(1, 1);
            CHECK(chain.moved - before == 1);
            CHECK(chain.get(collisions[10]) == stable);
            chain.put(collisions[0], "updated");
            chain.del(collisions[3]);
            chain.validate();
            while (chain.new_buckets()) {
                chain.step(1, 1);
                chain.validate();
            }
            CHECK(chain.get(collisions[10]) == stable);
            CHECK(chain.max_step_nodes <= 1);
            CHECK(chain.get(collisions[0])->expiry == 0);
        }
        for (auto &k : collisions)
            ks.put(k, "x");
        ks.del(collisions[10]);
        for (size_t i = 0; i < collisions.size(); ++i)
            CHECK(bool(ks.get(collisions[i])) == (i != 10));
        ks.validate();
        CHECK(Json("{\"value\":\"\\ud83d\\ude00\",\"ttl_seconds\":1}").parse().first == "😀");
        for (auto s : {"{\"value\":1}", "{\"value\":\"x\",\"ttl_seconds\":1e2}",
                       "{\"value\":\"\\ud800\"}", "{\"value\":\"x\",\"value\":\"y\"}"}) {
            bool caught = false;
            try {
                Json(s).parse();
            } catch (const HttpError &) {
                caught = true;
            }
            CHECK(caught);
        }
        bool limited = false;
        try {
            Keyspace small(1);
            small.put("a", "b");
        } catch (const std::length_error &) {
            limited = true;
        }
        CHECK(limited);
        std::cout << "unit: PASS (40000 random operations, TTL boundaries, collisions, multiple "
                     "rehash, JSON, memory limit, allocator failures, allocation-free commit)\n";
    } catch (const std::exception &e) {
        std::cerr << "unit FAIL: " << e.what() << "\n";
        return 1;
    }
}
