#include "mdb.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static mdb_stmt *parse_ok(const char *sql) {
    mdb_stmt *statement = NULL;
    mdb_error error;
    int rc = mdb_parse(sql, &statement, &error);
    if (rc) {
        fprintf(stderr, "Parse failed: %s at %zu: %s\n", error.message, error.offset, sql);
        abort();
    }
    assert(statement);
    return statement;
}
static void parse_bad(const char *sql, mdb_code code) {
    mdb_stmt *statement = (void *)(uintptr_t)1;
    mdb_error error;
    assert(mdb_parse(sql, &statement, &error) == -1);
    assert(statement == NULL);
    assert(error.code == code);
    assert(error.message[0]);
    assert(error.offset <= strlen(sql));
}
static void test_statements(void) {
    mdb_stmt *s = parse_ok(
        "InSeRt INTO Characters (name, attack) VALUES ('총웨; FROM ''x''', -9223372036854775808);");
    assert(s->kind == MDB_INSERT && !strcmp(s->table, "characters"));
    assert(s->ncolumns == 2 && s->nvalues == 2);
    assert(!strcmp(s->values[0].s, "총웨; FROM 'x'"));
    assert(s->values[1].i == INT64_MIN);
    mdb_stmt_free(s);
    s = parse_ok("INSERT INTO t VALUES ('', 9223372036854775807)");
    assert(s->ncolumns == 0 && s->values[0].s[0] == '\0' && s->values[1].i == INT64_MAX);
    mdb_stmt_free(s);
    s = parse_ok("SELECT name, attack FROM characters WHERE attack >= 100 AND (name = '총웨' OR "
                 "name = '슈') ORDER BY attack DESC, name ASC LIMIT 8;");
    assert(s->kind == MDB_SELECT && s->ncolumns == 2 && s->where->kind == MDB_AND &&
           s->where->right->kind == MDB_OR);
    assert(s->norder == 2 && s->order[0].descending && !s->order[1].descending && s->limit == 8);
    mdb_stmt_free(s);
    s = parse_ok("SELECT COUNT(*) FROM t WHERE id != -1 LIMIT 0;");
    assert(s->count && !s->star && s->limit == 0 && s->where->cmp == MDB_NE);
    mdb_stmt_free(s);
    s = parse_ok("UPDATE t SET name='a,b\nline', attack=120 WHERE id=1;");
    assert(s->kind == MDB_UPDATE && s->nupdates == 2 &&
           !strcmp(s->updates[0].value.s, "a,b\nline"));
    mdb_stmt_free(s);
    s = parse_ok("DELETE FROM t");
    assert(s->kind == MDB_DELETE && !s->where);
    mdb_stmt_free(s);
    s = parse_ok("UPDATE t SET attack=1");
    assert(s->kind == MDB_UPDATE && !s->where);
    mdb_stmt_free(s);
    s = parse_ok("BEGIN;");
    assert(s->kind == MDB_BEGIN);
    mdb_stmt_free(s);
    s = parse_ok("commit");
    assert(s->kind == MDB_COMMIT);
    mdb_stmt_free(s);
    s = parse_ok("ROLLBACK ; \n");
    assert(s->kind == MDB_ROLLBACK);
    mdb_stmt_free(s);
}
static void test_precedence_and_candidates(void) {
    mdb_stmt *s = parse_ok("SELECT * FROM t WHERE id=3 OR attack=2 AND name='x'");
    int64_t id = 0;
    assert(s->where->kind == MDB_OR && s->where->right->kind == MDB_AND);
    assert(!mdb_expr_id(s->where, &id));
    mdb_stmt_free(s);
    s = parse_ok("SELECT * FROM t WHERE id=3 AND (attack=2 OR name='x')");
    assert(mdb_expr_id(s->where, &id) && id == 3);
    mdb_stmt_free(s);
    s = parse_ok("SELECT * FROM t WHERE (id=3 OR id=4) AND attack=2");
    assert(!mdb_expr_id(s->where, &id));
    mdb_stmt_free(s);
    s = parse_ok("SELECT * FROM t WHERE attack=2 AND -5=id");
    assert(mdb_expr_id(s->where, &id) && id == -5);
    mdb_stmt_free(s);
    s = parse_ok("SELECT * FROM t WHERE id='3'");
    assert(!mdb_expr_id(s->where, &id));
    mdb_stmt_free(s);
    s = parse_ok("SELECT * FROM t WHERE id>3");
    assert(!mdb_expr_id(s->where, &id));
    mdb_stmt_free(s);
    s = parse_ok("SELECT * FROM t WHERE 1=2 AND 2<=3 OR 'x'='x'");
    assert(s->where->kind == MDB_OR);
    mdb_stmt_free(s);
}
static void test_errors(void) {
    const char *invalid[] = {"",
                             ";",
                             "SELECT",
                             "SELECT * FROM",
                             "SELECT * FROM t;INSERT INTO t VALUES(1)",
                             "SELECT * FROM ../x",
                             "SELECT * FROM t WHERE (id=1",
                             "SELECT * FROM t WHERE id=1)",
                             "SELECT * FROM t WHERE id!1",
                             "SELECT * FROM t WHERE id = 'unclosed",
                             "INSERT INTO t VALUES ()",
                             "INSERT INTO t (id,) VALUES (1)",
                             "UPDATE t SET id = x",
                             "SELECT count(id) FROM t",
                             "SELECT * FROM t LIMIT -1",
                             "BEGIN;;",
                             "SELECT * FROM t WHERE id=1 AND",
                             "SELECT * FROM t ORDER attack",
                             "INSERT INTO t VALUES (1,)",
                             "SELECT * FROM t --comment"};
    for (size_t i = 0; i < sizeof(invalid) / sizeof(*invalid); i++)
        parse_bad(invalid[i], MDB_SYNTAX);
    parse_bad("INSERT INTO t VALUES (9223372036854775808)", MDB_LIMIT);
    parse_bad("INSERT INTO t VALUES (-9223372036854775809)", MDB_LIMIT);
    char huge[MDB_SQL_MAX + 2];
    memset(huge, ' ', sizeof(huge));
    huge[sizeof(huge) - 1] = '\0';
    parse_bad(huge, MDB_LIMIT);
    char nested[1024];
    size_t n = (size_t)snprintf(nested, sizeof(nested), "SELECT * FROM t WHERE ");
    for (size_t i = 0; i < 65; i++)
        nested[n++] = '(';
    memcpy(nested + n, "id=1", 4);
    n += 4;
    for (size_t i = 0; i < 65; i++)
        nested[n++] = ')';
    nested[n] = '\0';
    parse_bad(nested, MDB_LIMIT);
    char longstring[350];
    n = (size_t)snprintf(longstring, sizeof(longstring), "INSERT INTO t VALUES ('");
    memset(longstring + n, 'x', MDB_TEXT_MAX + 1);
    n += MDB_TEXT_MAX + 1;
    memcpy(longstring + n, "')", 3);
    parse_bad(longstring, MDB_LIMIT);
    mdb_stmt *out = NULL;
    assert(mdb_parse(NULL, &out, NULL) == -1);
    assert(mdb_parse("BEGIN", NULL, NULL) == -1);
    mdb_stmt_free(NULL);
}
static uint64_t random_next(uint64_t *state) {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    return *state;
}
static void test_fuzz(void) {
    uint64_t seed = UINT64_C(89733451);
    char source[129];
    for (size_t i = 0; i < 30000; i++) {
        size_t n = (size_t)(random_next(&seed) % 128);
        for (size_t k = 0; k < n; k++)
            source[k] = (char)(1 + random_next(&seed) % 127);
        source[n] = '\0';
        mdb_stmt *s = NULL;
        mdb_error e;
        if (mdb_parse(source, &s, &e) == 0) {
            assert(s);
            mdb_stmt_free(s);
        } else {
            assert(!s && e.code != MDB_OK);
            assert(e.offset <= n);
        }
    }
}
int main(void) {
    test_statements();
    test_precedence_and_candidates();
    test_errors();
    test_fuzz();
    puts("SQL tests passed (30,000 deterministic fuzz inputs)");
    return 0;
}
