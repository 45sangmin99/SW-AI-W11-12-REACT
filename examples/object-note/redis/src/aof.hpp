#pragma once
#include "engine.hpp"
#include "text.hpp"
#include <atomic>
#include <condition_variable>
#include <cstring>
#include <fcntl.h>
#include <iostream>
#include <mutex>
#include <sys/file.h>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
namespace mini {
struct Hooks {
    int append_delay = 0, sync_delay = 0, repair_delay = 0, fail_write_after = -1, write_chunk = 0;
    bool fail_prepare = false;
    bool fail_sync = false;
    std::string events;
};
inline uint32_t crc32(const std::string &s) {
    uint32_t c = ~0u;
    for (unsigned char b : s) {
        c ^= b;
        for (int i = 0; i < 8; ++i)
            c = (c >> 1) ^ (0xedb88320u & -(c & 1));
    }
    return ~c;
}
inline void encode(std::string &s, uint64_t v, int n) {
    for (int i = 0; i < n; ++i)
        s.push_back(char(v >> (8 * i)));
}
inline uint64_t decode_number(const std::string &s, size_t at, int n) {
    uint64_t v = 0;
    for (int i = 0; i < n; ++i)
        v |= uint64_t((unsigned char)s.at(at + i)) << (8 * i);
    return v;
}
class Aof {
    int fd_ = -1;
    Hooks hooks_;
    std::thread worker_;
    std::mutex mutex_, events_mutex_;
    std::condition_variable cv_;
    bool stop_ = false;
    void event(const std::string &s) noexcept {
        try {
            std::lock_guard lock(events_mutex_);
            if (!hooks_.events.empty()) {
                std::string line = std::to_string(wall_ms()) + " " + s + "\n";
                int f = open(hooks_.events.c_str(), O_WRONLY | O_CREAT | O_APPEND, 0600);
                if (f >= 0) {
                    (void)write(f, line.data(), line.size());
                    close(f);
                }
            }
        } catch (...) {
        }
    }
    void sync_once() {
        uint64_t target = appended.load();
        if (target == synced.load() || failed.load())
            return;
        event("sync_start " + std::to_string(target));
        if (hooks_.sync_delay)
            std::this_thread::sleep_for(std::chrono::milliseconds(hooks_.sync_delay));
        if (hooks_.fail_sync || fsync(fd_) < 0) {
            failed = true;
            std::cerr << "AOF fsync failed; writes blocked\n";
            event("sync_error");
            return;
        }
        synced = target;
        event("sync_done " + std::to_string(target));
    }
    void replay(Keyspace &ks) {
        struct stat st{};
        if (fstat(fd_, &st) < 0)
            throw std::runtime_error("stat AOF");
        off_t pos = 0;
        uint64_t seq = 0;
        while (pos < st.st_size) {
            // Header CRC protects length metadata: a corrupted middle length must
            // never be mistaken for a repairable truncated tail.
            std::string head(37, '\0');
            ssize_t got = pread(fd_, head.data(), head.size(), pos);
            if (got < 0)
                throw std::runtime_error("read AOF");
            if (got < 37) {
                std::string prefix = "MRD1";
                if (head.substr(0, std::min<ssize_t>(got, 4)) !=
                    prefix.substr(0, std::min<ssize_t>(got, 4)))
                    throw std::runtime_error("AOF partial header corruption");
                if (got >= 8) {
                    auto length = decode_number(head, 4, 4);
                    if (length < 41 || length > 1100000)
                        throw std::runtime_error("AOF partial length corruption");
                }
                repair(pos, st.st_size);
                break;
            }
            if (head.substr(0, 4) != "MRD1")
                throw std::runtime_error("AOF magic corruption");
            if (decode_number(head, 8, 4) != crc32(head.substr(0, 8) + head.substr(12)))
                throw std::runtime_error("AOF header checksum corruption");
            uint64_t len = decode_number(head, 4, 4), s = decode_number(head, 12, 8),
                     expiry = decode_number(head, 21, 8), kl = decode_number(head, 29, 4),
                     vl = decode_number(head, 33, 4);
            char op = head[20];
            if (len < 41 || len > 1100000 || s != seq + 1 || (op != 'P' && op != 'D') || kl == 0 ||
                kl > 512 || vl > 1048576 || 41 + kl + vl != len || expiry > uint64_t(INT64_MAX) ||
                (op == 'D' && (vl || expiry)))
                throw std::runtime_error("AOF semantic corruption");
            if (uint64_t(st.st_size - pos) < len) {
                repair(pos, st.st_size);
                break;
            }
            std::string r(len, '\0');
            size_t n = 0;
            while (n < len) {
                auto z = pread(fd_, r.data() + n, len - n, pos + n);
                if (z <= 0)
                    throw std::runtime_error("AOF read failure");
                n += z;
            }
            if (decode_number(r, len - 4, 4) != crc32(r.substr(0, len - 4)))
                throw std::runtime_error("AOF checksum corruption");
            std::string k = r.substr(37, kl);
            if (!valid_key(k) || (op == 'P' && !utf8(r.substr(37 + kl, vl))))
                throw std::runtime_error("AOF text corruption");
            if (op == 'P')
                ks.put(k, r.substr(37 + kl, vl), expiry);
            else
                ks.del(k);
            ks.expire(SIZE_MAX);
            ks.step();
            seq = s;
            pos += len;
        }
        // Complete bytes recovered from a previous process may still be in page cache.
        if (fsync(fd_) < 0)
            throw std::runtime_error("startup AOF fsync");
        appended = seq;
        synced = seq;
        if (lseek(fd_, 0, SEEK_END) < 0)
            throw std::runtime_error("seek AOF");
        ks.expire(SIZE_MAX);
        ks.validate();
    }
    void repair(off_t pos, off_t end) {
        if (ftruncate(fd_, pos) < 0)
            throw std::runtime_error("tail truncate failed");
        event("repair_truncated");
        if (hooks_.repair_delay)
            std::this_thread::sleep_for(std::chrono::milliseconds(hooks_.repair_delay));
        if (fsync(fd_) < 0)
            throw std::runtime_error("tail sync failed");
        std::cerr << "AOF tail repaired bytes=" << end - pos << "\n";
    }

  public:
    std::atomic<uint64_t> appended{0}, synced{0};
    std::atomic<bool> failed{false};
    Aof(const std::string &path, Keyspace &ks, Hooks h = {}) : hooks_(std::move(h)) {
        fd_ = open(path.c_str(), O_RDWR | O_CREAT | O_APPEND, 0600);
        if (fd_ < 0)
            throw std::runtime_error("open AOF: " + std::string(strerror(errno)));
        try {
            if (flock(fd_, LOCK_EX | LOCK_NB) < 0)
                throw std::runtime_error("AOF already locked");
            replay(ks);
            auto slash = path.find_last_of('/');
            std::string parent = slash == std::string::npos ? "."
                                 : slash == 0               ? "/"
                                                            : path.substr(0, slash);
            int dir = open(parent.c_str(), O_RDONLY | O_DIRECTORY);
            if (dir < 0)
                throw std::runtime_error("open AOF directory");
            int synced_dir = fsync(dir);
            close(dir);
            if (synced_dir < 0)
                throw std::runtime_error("fsync AOF directory");
            worker_ = std::thread([this] {
                std::unique_lock lock(mutex_);
                while (!cv_.wait_for(lock, std::chrono::seconds(1), [this] { return stop_; })) {
                    lock.unlock();
                    sync_once();
                    lock.lock();
                }
                lock.unlock();
                sync_once();
            });
        } catch (...) {
            close(fd_);
            fd_ = -1;
            throw;
        }
    }
    ~Aof() {
        {
            std::lock_guard lock(mutex_);
            stop_ = true;
        }
        cv_.notify_one();
        if (worker_.joinable())
            worker_.join();
        if (fd_ >= 0)
            close(fd_);
    }
    // Called only by the event loop. No fallible work follows successful publication.
    void append(char op, const std::string &key, const std::string &value, int64_t expiry) {
        if (failed)
            throw std::runtime_error("AOF write blocked");
        if (appended == UINT64_MAX) {
            failed = true;
            throw std::runtime_error("AOF sequence exhausted");
        }
        uint64_t seq = appended + 1;
        std::string r = "MRD1";
        encode(r, 41 + key.size() + value.size(), 4);
        encode(r, 0, 4);
        encode(r, seq, 8);
        r += op;
        encode(r, expiry, 8);
        encode(r, key.size(), 4);
        encode(r, value.size(), 4);
        uint32_t header_crc = crc32(r.substr(0, 8) + r.substr(12));
        for (int i = 0; i < 4; ++i)
            r[8 + i] = char(header_crc >> (8 * i));
        r += key;
        r += value;
        encode(r, crc32(r), 4);
        event("append_start " + std::to_string(seq));
        if (hooks_.append_delay)
            std::this_thread::sleep_for(std::chrono::milliseconds(hooks_.append_delay));
        size_t n = 0;
        while (n < r.size()) {
            if (hooks_.fail_write_after >= 0 && n >= size_t(hooks_.fail_write_after)) {
                failed = true;
                event("append_error");
                throw std::runtime_error("injected append failure");
            }
            size_t len = r.size() - n;
            if (hooks_.write_chunk)
                len = std::min(len, size_t(hooks_.write_chunk));
            if (hooks_.fail_write_after >= 0)
                len = std::min(len, size_t(hooks_.fail_write_after) - n);
            auto z = write(fd_, r.data() + n, len);
            if (z < 0 && errno == EINTR)
                continue;
            if (z <= 0) {
                failed = true;
                event("append_error");
                throw std::runtime_error("AOF append failure");
            }
            n += z;
        }
        appended = seq;
        try {
            event("append_done " + std::to_string(seq));
        } catch (...) {
        }
    }
};
} // namespace mini
