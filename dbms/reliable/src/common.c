#define _POSIX_C_SOURCE 200809L
#include "mdb.h"
#include <inttypes.h>
#include <limits.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

const char *mdb_code_name(mdb_code c) {
    static const char *const names[] = {"ERR_OK",
                                        "ERR_SYNTAX",
                                        "ERR_UNKNOWN_TABLE",
                                        "ERR_UNKNOWN_COLUMN",
                                        "ERR_TYPE_MISMATCH",
                                        "ERR_VALUE_TOO_LONG",
                                        "ERR_COLUMN_COUNT",
                                        "ERR_DUPLICATE_ID",
                                        "ERR_IO",
                                        "ERR_NOMEM",
                                        "ERR_LIMIT_EXCEEDED",
                                        "ERR_CONFLICT",
                                        "ERR_FAILED_TRANSACTION",
                                        "ERR_CORRUPT",
                                        "ERR_BUSY",
                                        "ERR_STATE"};
    return (unsigned)c < sizeof(names) / sizeof(names[0]) ? names[c] : "ERR_INTERNAL";
}
int mdb_utf8(const char *s, size_t n) {
    size_t i = 0;
    while (i < n) {
        unsigned char a = (unsigned char)s[i++];
        if (!a)
            return 0;
        if (a < 0x80)
            continue;
        unsigned need;
        uint32_t cp, min;
        if (a >= 0xc2 && a <= 0xdf) {
            need = 1;
            cp = a & 31;
            min = 0x80;
        } else if (a >= 0xe0 && a <= 0xef) {
            need = 2;
            cp = a & 15;
            min = 0x800;
        } else if (a >= 0xf0 && a <= 0xf4) {
            need = 3;
            cp = a & 7;
            min = 0x10000;
        } else
            return 0;
        if (n - i < need)
            return 0;
        while (need--) {
            unsigned char b = (unsigned char)s[i++];
            if ((b & 0xc0) != 0x80)
                return 0;
            cp = (cp << 6) | (b & 63);
        }
        if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))
            return 0;
    }
    return 1;
}
int mdb_value_copy(mdb_value *out, const mdb_value *in) {
    *out = *in;
    if (in->type == MDB_STRING) {
        out->s = strdup(in->s ? in->s : "");
        if (!out->s)
            return -1;
    }
    return 0;
}
void mdb_value_clear(mdb_value *v) {
    if (v->type == MDB_STRING)
        free(v->s);
    memset(v, 0, sizeof(*v));
}
void mdb_result_free(mdb_result *r) {
    if (!r)
        return;
    for (size_t i = 0; i < r->nrows; i++) {
        if (r->rows[i].values) {
            for (size_t j = 0; j < r->ncolumns; j++)
                mdb_value_clear(&r->rows[i].values[j]);
            free(r->rows[i].values);
        }
    }
    for (size_t i = 0; i < r->ncolumns; i++)
        free(r->columns ? r->columns[i] : NULL);
    free(r->columns);
    free(r->types);
    free(r->rows);
    memset(r, 0, sizeof(*r));
}
typedef struct {
    char *p;
    size_t n, cap;
    int failed;
} buf;
static int grow(buf *b, size_t add) {
    if (b->failed)
        return -1;
    if (add > 64u * 1024u * 1024u || b->n > 64u * 1024u * 1024u - add) {
        b->failed = 1;
        return -1;
    }
    size_t required = b->n + add + 1;
    if (required > b->cap) {
        size_t cap = b->cap ? b->cap : 512;
        while (cap < required)
            cap *= 2;
        char *p = realloc(b->p, cap);
        if (!p) {
            b->failed = 1;
            return -1;
        }
        b->p = p;
        b->cap = cap;
    }
    return 0;
}
static void addn(buf *b, const char *s, size_t n) {
    if (grow(b, n))
        return;
    memcpy(b->p + b->n, s, n);
    b->n += n;
    b->p[b->n] = 0;
}
static void add(buf *b, const char *s) {
    addn(b, s, strlen(s));
}
static void fmt(buf *b, const char *f, ...) {
    char text[128];
    va_list ap;
    va_start(ap, f);
    int n = vsnprintf(text, sizeof(text), f, ap);
    va_end(ap);
    if (n < 0 || (size_t)n >= sizeof(text)) {
        b->failed = 1;
        return;
    }
    addn(b, text, (size_t)n);
}
static void string(buf *b, const char *s) {
    if (!s)
        s = "";
    if (!mdb_utf8(s, strlen(s))) {
        b->failed = 1;
        return;
    }
    add(b, "\"");
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        if (*p == '"')
            add(b, "\\\"");
        else if (*p == '\\')
            add(b, "\\\\");
        else if (*p < 32)
            fmt(b, "\\u%04x", (unsigned)*p);
        else
            addn(b, (const char *)p, 1);
    }
    add(b, "\"");
}
char *mdb_result_json(const mdb_result *r) {
    buf b = {0};
    add(&b, r->error.code == MDB_OK ? "{\"ok\":true" : "{\"ok\":false");
    add(&b, ",\"error\":");
    if (r->error.code) {
        add(&b, "{\"code\":");
        string(&b, mdb_code_name(r->error.code));
        add(&b, ",\"message\":");
        string(&b, r->error.message);
        fmt(&b, ",\"offset\":%zu}", r->error.offset);
    } else
        add(&b, "null");
    add(&b, ",\"state\":");
    string(&b, r->state);
    add(&b, ",\"commit\":");
    string(&b, r->commit == MDB_DURABLE      ? "DURABLE"
               : r->commit == MDB_UNKNOWN    ? "UNKNOWN"
               : r->commit == MDB_NO_CHANGES ? "NO_CHANGES"
                                             : "NOT_COMMITTED");
    fmt(&b,
        ",\"recovery_required\":%s,\"staged\":%s,\"used_index\":%s,\"txid\":\"%" PRIu64
        "\",\"affected_rows\":\"%" PRIu64 "\",\"inserted_id\":",
        r->recovery_required ? "true" : "false", r->staged ? "true" : "false",
        r->used_index ? "true" : "false", r->txid, r->affected);
    if (r->has_inserted_id)
        fmt(&b, "\"%" PRId64 "\"", r->inserted_id);
    else
        add(&b, "null");
    add(&b, ",\"columns\":[");
    for (size_t i = 0; i < r->ncolumns; i++) {
        if (i)
            add(&b, ",");
        add(&b, "{\"name\":");
        string(&b, r->columns[i]);
        add(&b, ",\"type\":");
        string(&b, r->types[i] == MDB_INT ? "INT" : "VARCHAR");
        add(&b, "}");
    }
    add(&b, "],\"rows\":[");
    for (size_t i = 0; i < r->nrows; i++) {
        if (i)
            add(&b, ",");
        add(&b, "[");
        for (size_t j = 0; j < r->ncolumns; j++) {
            if (j)
                add(&b, ",");
            const mdb_value *v = &r->rows[i].values[j];
            if (v->type == MDB_INT)
                fmt(&b, "\"%" PRId64 "\"", v->i);
            else
                string(&b, v->s);
        }
        add(&b, "]");
    }
    fmt(&b, "],\"count\":%zu}", r->nrows);
    if (b.failed) {
        free(b.p);
        return NULL;
    }
    return b.p;
}
