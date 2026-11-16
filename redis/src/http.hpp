#pragma once
#include "engine.hpp"
#include "text.hpp"
#include <cctype>
#include <charconv>
#include <optional>
#include <sstream>
namespace mini {
struct HttpError : std::runtime_error {
    int status;
    HttpError(int s, const std::string &m) : runtime_error(m), status(s) {}
};
inline std::string quote(const std::string &s) {
    std::string out = "\"";
    const char *hex = "0123456789abcdef";
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') {
            out += '\\';
            out += c;
        } else if (c < 32) {
            out += "\\u00";
            out += hex[c >> 4];
            out += hex[c & 15];
        } else
            out += c;
    }
    return out + '"';
}
class Json {
    const std::string &s;
    size_t i = 0;
    void ws() {
        while (i < s.size() && (s[i] == ' ' || s[i] == '\r' || s[i] == '\n' || s[i] == '\t'))
            ++i;
    }
    void expect(char c) {
        ws();
        if (i == s.size() || s[i++] != c)
            throw HttpError(400, "invalid JSON");
    }
    unsigned hex4() {
        unsigned v = 0;
        for (int n = 0; n < 4; ++n) {
            if (i == s.size())
                throw HttpError(400, "unicode escape");
            char c = s[i++];
            int d = c >= '0' && c <= '9'   ? c - '0'
                    : c >= 'a' && c <= 'f' ? c - 'a' + 10
                    : c >= 'A' && c <= 'F' ? c - 'A' + 10
                                           : -1;
            if (d < 0)
                throw HttpError(400, "unicode escape");
            v = v * 16 + d;
        }
        return v;
    }
    void code(std::string &o, unsigned v) {
        if (v < 128)
            o += char(v);
        else if (v < 2048) {
            o += char(0xc0 | (v >> 6));
            o += char(0x80 | (v & 63));
        } else if (v < 65536) {
            o += char(0xe0 | (v >> 12));
            o += char(0x80 | ((v >> 6) & 63));
            o += char(0x80 | (v & 63));
        } else {
            o += char(0xf0 | (v >> 18));
            o += char(0x80 | ((v >> 12) & 63));
            o += char(0x80 | ((v >> 6) & 63));
            o += char(0x80 | (v & 63));
        }
    }
    std::string str() {
        expect('"');
        std::string o;
        bool end = false;
        while (i < s.size()) {
            unsigned char c = s[i++];
            if (c == '"') {
                end = true;
                break;
            }
            if (c < 32)
                throw HttpError(400, "JSON control");
            if (c != '\\') {
                o += c;
                continue;
            }
            if (i == s.size())
                throw HttpError(400, "JSON escape");
            switch (s[i++]) {
            case '"':
                o += '"';
                break;
            case '\\':
                o += '\\';
                break;
            case '/':
                o += '/';
                break;
            case 'b':
                o += '\b';
                break;
            case 'f':
                o += '\f';
                break;
            case 'n':
                o += '\n';
                break;
            case 'r':
                o += '\r';
                break;
            case 't':
                o += '\t';
                break;
            case 'u': {
                unsigned v = hex4();
                if (v >= 0xd800 && v <= 0xdbff) {
                    if (i + 2 > s.size() || s.substr(i, 2) != "\\u")
                        throw HttpError(400, "surrogate");
                    i += 2;
                    unsigned lo = hex4();
                    if (lo < 0xdc00 || lo > 0xdfff)
                        throw HttpError(400, "surrogate");
                    v = 0x10000 + ((v - 0xd800) << 10) + lo - 0xdc00;
                } else if (v >= 0xdc00 && v <= 0xdfff)
                    throw HttpError(400, "surrogate");
                code(o, v);
                break;
            }
            default:
                throw HttpError(400, "JSON escape");
            }
        }
        if (!end || !utf8(o))
            throw HttpError(400, "invalid string");
        return o;
    }

  public:
    explicit Json(const std::string &text) : s(text) {}
    std::pair<std::string, int64_t> parse() {
        expect('{');
        bool value = false, ttl = false;
        std::string v;
        int64_t seconds = 0;
        while (true) {
            ws();
            if (i < s.size() && s[i] == '}') {
                ++i;
                break;
            }
            auto k = str();
            expect(':');
            if (k == "value" && !value) {
                v = str();
                value = true;
            } else if (k == "ttl_seconds" && !ttl) {
                ttl = true;
                ws();
                size_t begin = i;
                while (i < s.size() && s[i] >= '0' && s[i] <= '9')
                    ++i;
                if (begin == i || (i - begin > 1 && s[begin] == '0'))
                    throw HttpError(400, "TTL integer");
                auto result = std::from_chars(s.data() + begin, s.data() + i, seconds);
                if (result.ec != std::errc() || seconds <= 0 ||
                    seconds > (INT64_MAX - wall_ms()) / 1000)
                    throw HttpError(400, "TTL range");
            } else
                throw HttpError(400, "unknown or duplicate field");
            ws();
            if (i < s.size() && s[i] == '}') {
                ++i;
                break;
            }
            expect(',');
            ws();
            if (i < s.size() && s[i] == '}')
                throw HttpError(400, "trailing comma");
        }
        ws();
        if (i != s.size() || !value)
            throw HttpError(400, "invalid JSON body");
        return {v, seconds};
    }
};
inline std::string decode(std::string s) {
    std::string o;
    auto h = [](char c) {
        if (c >= '0' && c <= '9')
            return c - '0';
        if (c >= 'a' && c <= 'f')
            return c - 'a' + 10;
        if (c >= 'A' && c <= 'F')
            return c - 'A' + 10;
        return -1;
    };
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '%') {
            if (i + 2 >= s.size() || h(s[i + 1]) < 0 || h(s[i + 2]) < 0)
                throw HttpError(400, "percent encoding");
            o += char(h(s[i + 1]) * 16 + h(s[i + 2]));
            i += 2;
        } else
            o += s[i];
    }
    if (!valid_key(o))
        throw HttpError(400, "invalid key");
    for (unsigned char c : o)
        if (c < 32 || c == 127)
            throw HttpError(400, "invalid key");
    return o;
}
struct Request {
    std::string method, path, body;
    bool close = false;
};
inline std::string lower(std::string s) {
    for (char &c : s)
        c = std::tolower((unsigned char)c);
    return s;
}
inline bool token(unsigned char c) {
    return std::isalnum(c) || std::string("!#$%&'*+-.^_`|~").find(char(c)) != std::string::npos;
}
inline std::optional<Request> request(std::string &input) {
    size_t end = input.find("\r\n\r\n");
    if (end == std::string::npos) {
        if (input.size() > 16384)
            throw HttpError(431, "headers too large");
        return {};
    }
    if (end > 16384)
        throw HttpError(431, "headers too large");
    size_t line = input.find("\r\n");
    std::string first = input.substr(0, line);
    size_t a = first.find(' '), b = first.find(' ', a == std::string::npos ? 0 : a + 1);
    if (a == 0 || a == std::string::npos || b == std::string::npos ||
        first.substr(b + 1) != "HTTP/1.1")
        throw HttpError(400, "request line");
    Request r{first.substr(0, a), first.substr(a + 1, b - a - 1), "", false};
    for (unsigned char c : r.method)
        if (!token(c))
            throw HttpError(400, "method syntax");
    if (r.path.empty() || r.path[0] != '/')
        throw HttpError(400, "target");
    for (unsigned char c : r.path)
        if (c <= 32 || c == 127)
            throw HttpError(400, "target");
    size_t length = 0;
    bool cl = false, host = false;
    size_t p = line + 2;
    while (p < end) {
        size_t q = input.find("\r\n", p), colon = input.find(':', p);
        if (colon == std::string::npos || colon >= q || colon == p)
            throw HttpError(400, "header syntax");
        std::string name = lower(input.substr(p, colon - p));
        for (char c : name)
            if (!token((unsigned char)c))
                throw HttpError(400, "header name");
        std::string v = input.substr(colon + 1, q - colon - 1);
        while (!v.empty() && (v.front() == ' ' || v.front() == '\t'))
            v.erase(0, 1);
        while (!v.empty() && (v.back() == ' ' || v.back() == '\t'))
            v.pop_back();
        for (unsigned char c : v)
            if (c < 32 && c != '\t')
                throw HttpError(400, "header value");
        if (name == "content-length") {
            if (cl || v.empty())
                throw HttpError(400, "duplicate length");
            cl = true;
            auto z = std::from_chars(v.data(), v.data() + v.size(), length);
            if (z.ec != std::errc() || z.ptr != v.data() + v.size())
                throw HttpError(400, "length");
        }
        if (name == "content-type" && r.method == "PUT" && lower(v) != "application/json" &&
            lower(v) != "application/json; charset=utf-8")
            throw HttpError(415, "JSON content type required");
        if (name == "transfer-encoding")
            throw HttpError(400, "transfer encoding unsupported");
        if (name == "expect")
            throw HttpError(417, "expect unsupported");
        if (name == "host") {
            if (host || v.empty())
                throw HttpError(400, "host");
            host = true;
        }
        if (name == "connection" && lower(v) == "close")
            r.close = true;
        p = q + 2;
    }
    if (!host)
        throw HttpError(400, "host required");
    if (length > 1048576)
        throw HttpError(413, "body too large");
    if (input.size() < end + 4 + length)
        return {};
    r.body = input.substr(end + 4, length);
    input.erase(0, end + 4 + length);
    return r;
}
inline std::string response(int status, std::string body = "", bool close = false) {
    std::string reason = status == 200   ? "OK"
                         : status == 204 ? "No Content"
                         : status == 400 ? "Bad Request"
                         : status == 404 ? "Not Found"
                         : status == 405 ? "Method Not Allowed"
                         : status == 503 ? "Service Unavailable"
                                         : "Error";
    return "HTTP/1.1 " + std::to_string(status) + " " + reason +
           "\r\nContent-Length: " + std::to_string(body.size()) +
           "\r\nContent-Type: application/json\r\nConnection: " + (close ? "close" : "keep-alive") +
           "\r\n\r\n" + body;
}
} // namespace mini
