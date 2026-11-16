#include "../src/engine.hpp"
#include <iomanip>
#include <iostream>
using namespace mini;
int main() {
    for (bool rehash : {false, true}) {
        Keyspace ks;
        std::vector<std::string> keys;
        for (int i = 0; i < 256; ++i) {
            keys.push_back("read" + std::to_string(i));
            ks.put(keys.back(), std::string(64, 'v'));
            ks.step();
        }
        while (ks.new_buckets())
            ks.step();
        std::vector<double> samples;
        samples.reserve(10000);
        size_t checksum = 0;
        for (int i = 0; i < 10000; ++i) {
            if (rehash && i % 16 == 0)
                ks.put("write" + std::to_string(i), "v");
            ks.step();
            auto a = std::chrono::steady_clock::now();
            for (int j = 0; j < 64; ++j) {
                auto *e = ks.get(keys[(i * 64 + j) % keys.size()]);
                if (!e)
                    return 1;
                checksum += e->value.size();
            }
            auto b = std::chrono::steady_clock::now();
            samples.push_back(std::chrono::duration_cast<std::chrono::nanoseconds>(b - a).count() /
                              64.0);
        }
        ks.validate();
        std::sort(samples.begin(), samples.end());
        std::cout << (rehash ? "rehash" : "baseline") << " requests=" << samples.size() * 64
                  << " batch=64 samples=" << samples.size() << " p50_ns=" << samples[4999]
                  << " p95_ns=" << samples[9499] << " p99_ns=" << samples[9899]
                  << " max_ns=" << samples.back() << " starts=" << ks.starts
                  << " moved=" << ks.moved << " checksum=" << checksum << "\n";
    }
}
