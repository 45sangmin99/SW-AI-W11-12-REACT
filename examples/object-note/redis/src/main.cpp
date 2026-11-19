#include "aof.hpp"
#include "http.hpp"
#include <arpa/inet.h>
#include <csignal>
#include <poll.h>
#include <sys/socket.h>
using namespace mini;
namespace {
volatile sig_atomic_t stopping = 0;
void stop(int) { stopping = 1; }
struct Fd {
    int n = -1;
    explicit Fd(int fd = -1) : n(fd) {}
    ~Fd() {
        if (n >= 0)
            close(n);
    }
    Fd(const Fd &) = delete;
};
template <class T> T option_number(const std::string &text) {
    T out{};
    auto result = std::from_chars(text.data(), text.data() + text.size(), out);
    if (result.ec != std::errc() || result.ptr != text.data() + text.size())
        throw std::runtime_error("invalid numeric option");
    return out;
}
void nonblock(int fd) {
    if (fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK) < 0)
        throw std::runtime_error("nonblock");
}
struct Conn {
    int fd = -1;
    std::string input, output;
    bool closing = false, eof = false;
    std::chrono::steady_clock::time_point activity = std::chrono::steady_clock::now();
    ~Conn() {
        if (fd >= 0)
            close(fd);
    }
};
std::string execute(const Request &r, Keyspace &ks, Aof &aof, bool fail_prepare = false) {
    if (r.path.rfind("/keys/", 0) != 0)
        throw HttpError(404, "route");
    std::string segment = r.path.substr(6);
    bool ttl = false;
    auto slash = segment.find('/');
    if (slash != std::string::npos) {
        if (segment.substr(slash) != "/ttl")
            throw HttpError(404, "route");
        ttl = true;
        segment.resize(slash);
    }
    if (segment.find('?') != std::string::npos || segment.find('#') != std::string::npos)
        throw HttpError(400, "query unsupported");
    auto key = decode(segment);
    if (r.method != "GET" && r.method != "PUT" && r.method != "DELETE")
        throw HttpError(405, "method");
    if (ttl && r.method != "GET")
        throw HttpError(405, "method");
    if (r.method != "PUT" && !r.body.empty())
        throw HttpError(400, "unexpected body");
    if (r.method == "PUT") {
        auto [value, seconds] = Json(r.body).parse();
        int64_t now = wall_ms();
        if (seconds && seconds > (INT64_MAX - now) / 1000)
            throw HttpError(400, "TTL range");
        int64_t expiry = seconds ? now + seconds * 1000 : 0;
        if (fail_prepare)
            throw std::bad_alloc();
        auto prepared = ks.prepare(key, std::move(value), expiry);
        aof.append('P', key, prepared.node->value, expiry);
        ks.commit(std::move(prepared));
        if (aof.failed)
            throw std::runtime_error("AOF failed during commit");
        return response(204, "", r.close);
    }
    auto *e = ks.get(key);
    if (!e)
        throw HttpError(404, "key not found");
    if (r.method == "DELETE") {
        aof.append('D', key, "", 0);
        ks.commit_delete(e);
        if (aof.failed)
            throw std::runtime_error("AOF failed during delete");
        return response(204, "", r.close);
    }
    if (ttl) {
        int64_t remain = e->expiry ? remaining_seconds(e->expiry, wall_ms()) : 0;
        if (e->expiry && remain <= 0)
            throw HttpError(404, "key not found");
        return response(200,
                        "{\"ttl_seconds\":" + (e->expiry ? std::to_string(remain) : "null") + "}",
                        r.close);
    }
    return response(200, "{\"value\":" + quote(e->value) + "}", r.close);
}
} // namespace
int main(int argc, char **argv) {
    try {
        std::string host = "127.0.0.1", path = "appendonly.aof";
        int port = 6380, idle = 10;
        size_t max_connections = 256, memory = 64 * 1024 * 1024;
        Hooks hooks;
        bool test = false;
        for (int i = 1; i < argc; ++i) {
            std::string arg = argv[i];
            if (arg == "--test-hooks") {
                test = true;
                continue;
            }
            if (i + 1 == argc)
                throw std::runtime_error("missing option value");
            std::string v = argv[++i];
            if (arg == "--host")
                host = v;
            else if (arg == "--port")
                port = option_number<int>(v);
            else if (arg == "--aof-path")
                path = v;
            else if (arg == "--memory-limit")
                memory = option_number<size_t>(v);
            else if (arg == "--max-connections")
                max_connections = option_number<size_t>(v);
            else if (arg == "--idle-seconds")
                idle = option_number<int>(v);
            else if (arg == "--append-delay-ms")
                hooks.append_delay = option_number<int>(v);
            else if (arg == "--sync-delay-ms")
                hooks.sync_delay = option_number<int>(v);
            else if (arg == "--repair-delay-ms")
                hooks.repair_delay = option_number<int>(v);
            else if (arg == "--fail-write-after")
                hooks.fail_write_after = option_number<int>(v);
            else if (arg == "--fail-sync")
                hooks.fail_sync = option_number<int>(v);
            else if (arg == "--write-chunk-size")
                hooks.write_chunk = option_number<int>(v);
            else if (arg == "--fail-prepare")
                hooks.fail_prepare = option_number<int>(v);
            else if (arg == "--events")
                hooks.events = v;
            else
                throw std::runtime_error("unknown option: " + arg);
        }
        if (port < 1 || port > 65535 || idle < 1 || max_connections < 1 ||
            max_connections > 100000 || hooks.append_delay < 0 || hooks.sync_delay < 0 ||
            hooks.write_chunk < 0 || hooks.repair_delay < 0 || hooks.fail_write_after < -1)
            throw std::runtime_error("option range");
        if (!test && (hooks.append_delay || hooks.sync_delay || hooks.repair_delay ||
                      hooks.fail_write_after != -1 || hooks.fail_sync || hooks.fail_prepare ||
                      hooks.write_chunk || !hooks.events.empty()))
            throw std::runtime_error("injection requires --test-hooks");
        Keyspace ks(memory);
        Aof aof(path, ks, hooks);
        Fd listener(socket(AF_INET, SOCK_STREAM, 0));
        if (listener.n < 0)
            throw std::runtime_error("socket");
        int yes = 1;
        setsockopt(listener.n, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);
        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_port = htons(port);
        if (inet_pton(AF_INET, host.c_str(), &addr.sin_addr) != 1 ||
            bind(listener.n, (sockaddr *)&addr, sizeof addr) < 0 || listen(listener.n, 128) < 0)
            throw std::runtime_error("bind/listen");
        nonblock(listener.n);
        signal(SIGPIPE, SIG_IGN);
        signal(SIGINT, stop);
        signal(SIGTERM, stop);
        std::vector<std::unique_ptr<Conn>> clients;
        std::cerr << "ready " << host << ":" << port << "\n";
        uint64_t last_starts = ks.starts, last_finishes = ks.finishes;
        while (!stopping) {
            ks.expire(64);
            ks.step(4, 8);
            if (ks.starts != last_starts || ks.finishes != last_finishes) {
                std::cerr << wall_ms() << " rehash starts=" << ks.starts
                          << " finishes=" << ks.finishes << " moved=" << ks.moved
                          << " old=" << ks.buckets() << " new=" << ks.new_buckets()
                          << " scanned=" << ks.scanned << " max_scans=" << ks.max_step_scans
                          << " max_nodes=" << ks.max_step_nodes << " max_ns=" << ks.max_step_ns
                          << "\n";
                last_starts = ks.starts;
                last_finishes = ks.finishes;
            }
            std::vector<pollfd> fds{{listener.n, POLLIN, 0}};
            for (auto &c : clients)
                fds.push_back(
                    {c->fd,
                     short((!c->closing && !c->eof && c->output.size() < 2 * 1048576 ? POLLIN : 0) |
                           (!c->output.empty() ? POLLOUT : 0)),
                     0});
            int ready = poll(fds.data(), fds.size(), 10);
            if (ready < 0 && errno != EINTR)
                throw std::runtime_error("poll");
            if (fds[0].revents & POLLIN)
                for (int n = 0; n < 16; ++n) {
                    int fd = accept(listener.n, nullptr, nullptr);
                    if (fd < 0)
                        break;
                    if (clients.size() >= max_connections) {
                        close(fd);
                        continue;
                    }
                    Fd accepted(fd);
                    nonblock(fd);
                    auto c = std::make_unique<Conn>();
                    c->fd = fd;
                    accepted.n = -1;
                    clients.push_back(std::move(c));
                }
            size_t commands = 0;
            for (size_t i = 0; i + 1 < fds.size(); ++i) {
                auto &c = *clients[i];
                auto re = fds[i + 1].revents;
                if (re & (POLLERR | POLLNVAL)) {
                    c.closing = true;
                    c.output.clear();
                }
                try {
                    if ((re & POLLIN) && !c.closing) {
                        char buf[16384];
                        for (int n = 0; n < 4; ++n) {
                            auto z = recv(c.fd, buf, sizeof buf, 0);
                            if (z > 0) {
                                c.activity = std::chrono::steady_clock::now();
                                c.input.append(buf, z);
                                if (c.input.size() > 1100000)
                                    throw HttpError(413, "input limit");
                            } else {
                                if (z == 0)
                                    c.eof = true;
                                else if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)
                                    c.closing = true;
                                break;
                            }
                        }
                    }
                    for (int n = 0;
                         n < 4 && !c.closing && commands < 64 && c.output.size() < 2 * 1048576;
                         ++n) {
                        auto r = request(c.input);
                        if (!r) {
                            if (c.eof) {
                                if (!c.input.empty())
                                    throw HttpError(400, "incomplete request");
                                c.closing = true;
                            }
                            break;
                        }
                        ++commands;
                        try {
                            c.output += execute(*r, ks, aof, hooks.fail_prepare);
                        } catch (const HttpError &e) {
                            c.output +=
                                response(e.status, "{\"error\":" + quote(e.what()) + "}", r->close);
                        } catch (const std::length_error &e) {
                            std::cerr << "resource rejected: " << e.what() << "\n";
                            c.output += response(503, "{\"error\":\"resource limit\"}", r->close);
                        } catch (const std::logic_error &) {
                            throw; // Broken invariants are fatal, never continue with a damaged
                                   // keyspace.
                        } catch (const std::exception &e) {
                            std::cerr << "write rejected: " << e.what() << "\n";
                            c.output +=
                                response(503, "{\"error\":\"write unavailable\"}", r->close);
                        }
                        c.closing = r->close || (c.eof && c.input.empty());
                        ks.step();
                    }
                    if ((re & POLLOUT) && !c.output.empty()) {
                        auto z = send(c.fd, c.output.data(),
                                      std::min<size_t>(65536, c.output.size()), 0);
                        if (z > 0) {
                            c.output.erase(0, z);
                            c.activity = std::chrono::steady_clock::now();
                        } else if (z < 0 && errno != EAGAIN && errno != EWOULDBLOCK &&
                                   errno != EINTR) {
                            c.closing = true;
                            c.output.clear();
                        }
                    }
                } catch (const HttpError &e) {
                    c.output += response(e.status, "{\"error\":" + quote(e.what()) + "}", true);
                    c.closing = true;
                    c.input.clear();
                }
                if (std::chrono::steady_clock::now() - c.activity > std::chrono::seconds(idle)) {
                    c.closing = true;
                    c.output.clear();
                }
                if (re & POLLHUP) {
                    c.closing = true;
                    if (c.output.empty())
                        c.input.clear();
                }
            }
            clients.erase(std::remove_if(clients.begin(), clients.end(),
                                         [](auto &c) { return c->closing && c->output.empty(); }),
                          clients.end());
            if (clients.size() > 1)
                std::rotate(clients.begin(), clients.begin() + 1, clients.end());
        }
        ks.validate();
        std::cerr << "shutdown appended=" << aof.appended << " synced=" << aof.synced
                  << " moved=" << ks.moved << " scanned=" << ks.scanned
                  << " max_scans=" << ks.max_step_scans << " max_nodes=" << ks.max_step_nodes
                  << " max_ns=" << ks.max_step_ns << "\n";
        return 0;
    } catch (const std::exception &e) {
        std::cerr << "fatal: " << e.what() << "\n";
        return 1;
    }
}
