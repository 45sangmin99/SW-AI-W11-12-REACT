#include "mdb.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    const unsigned char *p;
    size_t n, pos;
    mdb_error *error;
} json_reader;
static int fail(json_reader *r, mdb_code code, const char *message) {
    r->error->code = code;
    r->error->offset = r->pos;
    snprintf(r->error->message, sizeof r->error->message, "%s", message);
    return -1;
}
static void space(json_reader *r) {
    while (r->pos < r->n && (r->p[r->pos] == ' ' || r->p[r->pos] == '\t' || r->p[r->pos] == '\r' ||
                             r->p[r->pos] == '\n'))
        r->pos++;
}
static int hex4(json_reader *r, unsigned *out) {
    unsigned v = 0;
    for (int i = 0; i < 4; i++) {
        if (r->pos >= r->n)
            return fail(r, MDB_SYNTAX, "Incomplete Unicode escape");
        unsigned c = r->p[r->pos++], d;
        if (c >= '0' && c <= '9')
            d = c - '0';
        else if (c >= 'a' && c <= 'f')
            d = c - 'a' + 10;
        else if (c >= 'A' && c <= 'F')
            d = c - 'A' + 10;
        else
            return fail(r, MDB_SYNTAX, "Invalid Unicode escape");
        v = v * 16 + d;
    }
    *out = v;
    return 0;
}
static int append(json_reader *r, char *out, size_t cap, size_t *len, unsigned c) {
    if (*len + 1 >= cap)
        return fail(r, MDB_LIMIT, "SQL exceeds length limit");
    out[(*len)++] = (char)c;
    return 0;
}
static int string(json_reader *r, char *out, size_t cap) {
    size_t len = 0;
    if (r->pos >= r->n || r->p[r->pos++] != '"')
        return fail(r, MDB_SYNTAX, "Expected JSON string");
    while (r->pos < r->n) {
        unsigned c = r->p[r->pos++];
        if (c == '"') {
            out[len] = 0;
            if (!mdb_utf8(out, len))
                return fail(r, MDB_SYNTAX, "Invalid UTF-8");
            return 0;
        }
        if (c < 0x20)
            return fail(r, MDB_SYNTAX, "Unescaped JSON control character");
        if (c == '\\') {
            if (r->pos >= r->n)
                return fail(r, MDB_SYNTAX, "Incomplete JSON escape");
            c = r->p[r->pos++];
            switch (c) {
            case '"':
            case '\\':
            case '/':
                break;
            case 'b':
                c = '\b';
                break;
            case 'f':
                c = '\f';
                break;
            case 'n':
                c = '\n';
                break;
            case 'r':
                c = '\r';
                break;
            case 't':
                c = '\t';
                break;
            case 'u': {
                unsigned cp;
                if (hex4(r, &cp))
                    return -1;
                if (cp >= 0xd800 && cp <= 0xdbff) {
                    unsigned low;
                    if (r->n - r->pos < 2 || r->p[r->pos] != '\\' || r->p[r->pos + 1] != 'u')
                        return fail(r, MDB_SYNTAX, "Missing low surrogate");
                    r->pos += 2;
                    if (hex4(r, &low))
                        return -1;
                    if (low < 0xdc00 || low > 0xdfff)
                        return fail(r, MDB_SYNTAX, "Invalid low surrogate");
                    cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
                } else if (cp >= 0xdc00 && cp <= 0xdfff)
                    return fail(r, MDB_SYNTAX, "Unexpected low surrogate");
                if (!cp)
                    return fail(r, MDB_SYNTAX, "NUL is not permitted");
                if (cp < 0x80) {
                    if (append(r, out, cap, &len, cp))
                        return -1;
                } else if (cp < 0x800) {
                    if (append(r, out, cap, &len, 0xc0 | (cp >> 6)) ||
                        append(r, out, cap, &len, 0x80 | (cp & 63)))
                        return -1;
                } else if (cp < 0x10000) {
                    if (append(r, out, cap, &len, 0xe0 | (cp >> 12)) ||
                        append(r, out, cap, &len, 0x80 | ((cp >> 6) & 63)) ||
                        append(r, out, cap, &len, 0x80 | (cp & 63)))
                        return -1;
                } else {
                    if (append(r, out, cap, &len, 0xf0 | (cp >> 18)) ||
                        append(r, out, cap, &len, 0x80 | ((cp >> 12) & 63)) ||
                        append(r, out, cap, &len, 0x80 | ((cp >> 6) & 63)) ||
                        append(r, out, cap, &len, 0x80 | (cp & 63)))
                        return -1;
                }
                continue;
            }
            default:
                return fail(r, MDB_SYNTAX, "Invalid JSON escape");
            }
        }
        if (append(r, out, cap, &len, c))
            return -1;
    }
    return fail(r, MDB_SYNTAX, "Unclosed JSON string");
}
int mdb_query_json(const char *body, size_t length, char **sql, mdb_error *error) {
    json_reader r = {(const unsigned char *)body, length, 0, error};
    char key[32], *value = NULL;
    *sql = NULL;
    memset(error, 0, sizeof *error);
    if (!body || length > 65536)
        return fail(&r, MDB_LIMIT, "Request body exceeds limit");
    space(&r);
    if (r.pos == r.n || r.p[r.pos++] != '{')
        return fail(&r, MDB_SYNTAX, "Expected object containing sql");
    space(&r);
    if (string(&r, key, sizeof key))
        return -1;
    if (strcmp(key, "sql"))
        return fail(&r, MDB_SYNTAX, "Unknown request property");
    space(&r);
    if (r.pos == r.n || r.p[r.pos++] != ':')
        return fail(&r, MDB_SYNTAX, "Expected colon");
    space(&r);
    value = malloc(MDB_SQL_MAX + 1);
    if (!value)
        return fail(&r, MDB_NOMEM, "Allocation failed");
    if (string(&r, value, MDB_SQL_MAX + 1)) {
        free(value);
        return -1;
    }
    space(&r);
    if (r.pos == r.n || r.p[r.pos++] != '}') {
        free(value);
        return fail(&r, MDB_SYNTAX, "Exactly one sql property is required");
    }
    space(&r);
    if (r.pos != r.n) {
        free(value);
        return fail(&r, MDB_SYNTAX, "Trailing JSON input");
    }
    *sql = value;
    return 0;
}
