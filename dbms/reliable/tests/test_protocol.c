#include "mdb.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void good(const char *json, const char *expected) {
    mdb_error e;
    char *sql = NULL;
    assert(mdb_query_json(json, strlen(json), &sql, &e) == 0);
    assert(sql && strcmp(sql, expected) == 0);
    free(sql);
}
static void bad(const char *json) {
    mdb_error e;
    char *sql = NULL;
    assert(mdb_query_json(json, strlen(json), &sql, &e) != 0);
    assert(!sql && e.code != MDB_OK);
}
int main(void) {
    good("{\"sql\":\"SELECT * FROM users;\"}", "SELECT * FROM users;");
    good(" \n{ \"s\\u0071l\" : \"한글 \\uD83D\\uDE00\" }\t", "한글 😀");
    good("{\"sql\":\"\\\"\\\\\\/\\b\\f\\n\\r\\t\"}", "\"\\/\b\f\n\r\t");
    good("{\"sql\":\"\\u0041\\u00e9\\uAC00\"}", "Aé가");
    const char *invalid[] = {"",
                             "{}",
                             "[]",
                             "{\"sql\":0}",
                             "{\"sql\":null}",
                             "{\"sql\":{}}",
                             "{\"other\":\"x\"}",
                             "{\"sql\":\"x\",\"sql\":\"y\"}",
                             "{\"sql\":\"x\",}",
                             "{\"sql\":\"x\"}x",
                             "{\"sql\":\"\\u0000\"}",
                             "{\"sql\":\"\\ud800\"}",
                             "{\"sql\":\"\\udc00\"}",
                             "{\"sql\":\"\\ud800\\u0041\"}",
                             "{\"sql\":\"\\uXXXX\"}",
                             "{\"sql\":\"\\x00\"}",
                             "{\"sql\":\"\n\"}",
                             "{\"sql\":\"x}",
                             "{\"sql\":\"\xc0\xaf\"}"};
    for (size_t i = 0; i < sizeof invalid / sizeof invalid[0]; i++)
        bad(invalid[i]);
    char big[MDB_SQL_MAX + 40];
    memcpy(big, "{\"sql\":\"", 8);
    memset(big + 8, 'a', MDB_SQL_MAX);
    memcpy(big + 8 + MDB_SQL_MAX, "\"}", 3);
    mdb_error e;
    char *sql = NULL;
    assert(!mdb_query_json(big, strlen(big), &sql, &e));
    assert(strlen(sql) == MDB_SQL_MAX);
    free(sql);
    big[8 + MDB_SQL_MAX] = 'a';
    memcpy(big + 9 + MDB_SQL_MAX, "\"}", 3);
    assert(mdb_query_json(big, strlen(big), &sql, &e));
    assert(e.code == MDB_LIMIT);
    unsigned state = 0xabc123u;
    unsigned char bytes[256];
    for (int trial = 0; trial < 20000; trial++) {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        size_t n = state % sizeof bytes;
        for (size_t i = 0; i < n; i++) {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            bytes[i] = (unsigned char)state;
        }
        sql = NULL;
        (void)mdb_query_json((const char *)bytes, n, &sql, &e);
        free(sql);
    }
    puts("protocol: Unicode, strict JSON, length limits, 20000 fuzz inputs passed");
    return 0;
}
