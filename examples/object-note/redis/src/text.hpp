#pragma once
#include <string>
namespace mini {
inline bool utf8(const std::string &s) {
    for (size_t i = 0; i < s.size();) {
        unsigned char c = s[i++];
        if (c < 128)
            continue;
        int n;
        uint32_t v, min;
        if (c >= 0xc2 && c <= 0xdf) {
            n = 1;
            v = c & 31;
            min = 128;
        } else if (c >= 0xe0 && c <= 0xef) {
            n = 2;
            v = c & 15;
            min = 2048;
        } else if (c >= 0xf0 && c <= 0xf4) {
            n = 3;
            v = c & 7;
            min = 65536;
        } else
            return false;
        while (n--) {
            if (i == s.size() || ((unsigned char)s[i] & 0xc0) != 0x80)
                return false;
            v = (v << 6) | ((unsigned char)s[i++] & 63);
        }
        if (v < min || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff))
            return false;
    }
    return true;
}
inline bool valid_key(const std::string &key) {
    if (key.empty() || key.size() > 512 || !utf8(key))
        return false;
    for (size_t i = 0; i < key.size(); ++i) {
        unsigned char c = key[i];
        if (c < 32 || c == 127 ||
            (c == 0xc2 && i + 1 < key.size() && (unsigned char)key[i + 1] >= 0x80 &&
             (unsigned char)key[i + 1] <= 0x9f))
            return false;
    }
    return true;
}
} // namespace mini
