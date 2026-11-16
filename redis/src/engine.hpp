#pragma once
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <vector>
namespace mini {
inline int64_t wall_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}
// Caller distinguishes permanent keys; zero means an elapsed deadline.
inline int64_t remaining_seconds(int64_t expiry, int64_t now) noexcept {
    if (now >= expiry)
        return 0;
    int64_t ms = expiry - now;
    return ms / 1000 + (ms % 1000 != 0);
}
inline uint64_t hash(const std::string &s) {
    uint64_t h = 14695981039346656037ULL;
    for (unsigned char c : s) {
        h ^= c;
        h *= 1099511628211ULL;
    }
    return h;
}
struct Entry {
    std::string key, value;
    int64_t expiry = 0;
    size_t heap = SIZE_MAX;
    Entry *next = nullptr;
};
class Keyspace {
    std::vector<Entry *> old_, next_, heap_;
    size_t cursor_ = 0, count_ = 0, bytes_ = 0, limit_;
    std::function<int64_t()> clock_;
    Entry *locate(const std::string &k) const {
        for (auto *t : {&next_, &old_})
            if (!t->empty())
                for (auto *p = (*t)[hash(k) & (t->size() - 1)]; p; p = p->next)
                    if (p->key == k)
                        return p;
        return nullptr;
    }
    void swapheap(size_t a, size_t b) noexcept {
        std::swap(heap_[a], heap_[b]);
        heap_[a]->heap = a;
        heap_[b]->heap = b;
    }
    void up(size_t i) noexcept {
        while (i && heap_[i]->expiry < heap_[(i - 1) / 2]->expiry) {
            size_t p = (i - 1) / 2;
            swapheap(i, p);
            i = p;
        }
    }
    void down(size_t i) noexcept {
        while (2 * i + 1 < heap_.size()) {
            size_t j = 2 * i + 1;
            if (j + 1 < heap_.size() && heap_[j + 1]->expiry < heap_[j]->expiry)
                ++j;
            if (heap_[i]->expiry <= heap_[j]->expiry)
                break;
            swapheap(i, j);
            i = j;
        }
    }
    void unheap(Entry *e) noexcept {
        size_t i = e->heap;
        if (i == SIZE_MAX)
            return;
        swapheap(i, heap_.size() - 1);
        heap_.pop_back();
        e->heap = SIZE_MAX;
        if (i < heap_.size()) {
            auto *moved = heap_[i];
            up(i);
            down(moved->heap);
        }
    }
    void erase(Entry *e) noexcept {
        unheap(e);
        for (auto *t : {&old_, &next_})
            if (!t->empty()) {
                auto **p = &(*t)[hash(e->key) & (t->size() - 1)];
                while (*p) {
                    if (*p == e) {
                        *p = e->next;
                        bytes_ -= e->key.size() + e->value.size() + sizeof(Entry);
                        --count_;
                        delete e;
                        return;
                    }
                    p = &(*p)->next;
                }
            }
        std::terminate();
    }

  public:
    uint64_t starts = 0, finishes = 0, moved = 0, scanned = 0, max_step_nodes = 0,
             max_step_scans = 0, max_step_ns = 0;
    explicit Keyspace(size_t limit = 64 * 1024 * 1024, std::function<int64_t()> c = wall_ms)
        : old_(4, nullptr), limit_(limit), clock_(std::move(c)) {}
    ~Keyspace() {
        for (auto *t : {&old_, &next_})
            for (auto *p : *t)
                while (p) {
                    auto *n = p->next;
                    delete p;
                    p = n;
                }
    }
    Keyspace(const Keyspace &) = delete;
    void step(size_t budget = 4, size_t scans = 8) noexcept {
        if (next_.empty())
            return;
        auto begin = std::chrono::steady_clock::now();
        size_t n = 0, advanced = 0;
        while (!next_.empty() && cursor_ < old_.size() && budget && scans) {
            auto *&p = old_[cursor_];
            if (!p) {
                ++cursor_;
                --scans;
                ++advanced;
                ++scanned;
                continue;
            }
            auto *e = p;
            p = e->next;
            auto i = hash(e->key) & (next_.size() - 1);
            e->next = next_[i];
            next_[i] = e;
            --budget;
            ++n;
            ++moved;
        }
        if (!next_.empty() && cursor_ == old_.size()) {
            old_.swap(next_);
            std::vector<Entry *>().swap(next_);
            cursor_ = 0;
            ++finishes;
        }
        max_step_scans = std::max<uint64_t>(max_step_scans, advanced);
        max_step_nodes = std::max<uint64_t>(max_step_nodes, n);
        max_step_ns =
            std::max<uint64_t>(max_step_ns, std::chrono::duration_cast<std::chrono::nanoseconds>(
                                                std::chrono::steady_clock::now() - begin)
                                                .count());
    }
    Entry *get(const std::string &k) {
        auto *e = locate(k);
        if (e && e->expiry && clock_() >= e->expiry) {
            erase(e);
            return nullptr;
        }
        return e;
    }
    // Nodes stay at stable addresses throughout rehashing; the heap owns no entries.
    struct Prepared {
        std::unique_ptr<Entry> node;
        Entry *existing;
    };
    Prepared prepare(std::string k, std::string v, int64_t expiry) {
        auto *e = get(k);
        size_t base = bytes_ - (e ? e->key.size() + e->value.size() + sizeof(Entry) : 0);
        size_t need = k.size() + v.size() + sizeof(Entry);
        if (need > limit_ || base > limit_ - need)
            throw std::length_error("memory limit");
        auto n = std::make_unique<Entry>();
        n->key = std::move(k);
        n->value = std::move(v);
        n->expiry = expiry;
        if (heap_.size() == heap_.capacity())
            heap_.reserve(std::max<size_t>(8, heap_.size() * 2));
        if (next_.empty() && (count_ + 1) * 4 > old_.size() * 3) {
            std::vector<Entry *> fresh(old_.size() * 2, nullptr);
            next_.swap(fresh);
            ++starts;
        }
        return {std::move(n), e};
    }
    // prepare() reserves all storage. Commit only swaps strings and links pointers.
    void commit(Prepared p) noexcept {
        auto *n = p.node.get();
        auto *e = p.existing;
        if (e) {
            bytes_ -= e->value.size();
            unheap(e);
            e->value.swap(n->value);
            e->expiry = n->expiry;
            bytes_ += e->value.size();
        } else {
            e = p.node.release();
            auto &t = next_.empty() ? old_ : next_;
            auto i = hash(e->key) & (t.size() - 1);
            e->next = t[i];
            t[i] = e;
            ++count_;
            bytes_ += e->key.size() + e->value.size() + sizeof(Entry);
        }
        if (e->expiry) {
            e->heap = heap_.size();
            heap_.push_back(e);
            up(e->heap);
        }
    }
    void put(std::string k, std::string v, int64_t expiry = 0) {
        commit(prepare(std::move(k), std::move(v), expiry));
    }
    void commit_delete(Entry *e) noexcept { erase(e); }
    bool del(const std::string &k) {
        auto *e = get(k);
        if (!e)
            return false;
        erase(e);
        return true;
    }
    size_t expire(size_t budget = 64) {
        size_t n = 0;
        while (n < budget && !heap_.empty() && heap_[0]->expiry <= clock_()) {
            erase(heap_[0]);
            ++n;
        }
        return n;
    }
    size_t size() const { return count_; }
    size_t heap_size() const { return heap_.size(); }
    size_t buckets() const { return old_.size(); }
    size_t new_buckets() const { return next_.size(); }
    void validate() const {
        std::unordered_set<std::string> keys;
        std::unordered_set<Entry *> nodes;
        size_t bytes = 0;
        for (auto *t : {&old_, &next_})
            for (size_t i = 0; i < t->size(); ++i)
                for (auto *e = (*t)[i]; e; e = e->next) {
                    if ((hash(e->key) & (t->size() - 1)) != i || !keys.insert(e->key).second ||
                        !nodes.insert(e).second)
                        throw std::logic_error("hash invariant");
                    bytes += e->key.size() + e->value.size() + sizeof(Entry);
                    if (e->expiry) {
                        if (e->heap >= heap_.size() || heap_[e->heap] != e)
                            throw std::logic_error("entry heap invariant");
                    } else if (e->heap != SIZE_MAX)
                        throw std::logic_error("permanent heap invariant");
                }
        if (nodes.size() != count_ || bytes != bytes_)
            throw std::logic_error("count invariant");
        for (size_t i = 0; i < heap_.size(); ++i)
            if (!nodes.count(heap_[i]) || heap_[i]->heap != i || !heap_[i]->expiry ||
                (i && heap_[(i - 1) / 2]->expiry > heap_[i]->expiry))
                throw std::logic_error("heap invariant");
    }
};
} // namespace mini
