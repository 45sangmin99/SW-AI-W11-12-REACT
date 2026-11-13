#define _POSIX_C_SOURCE 200809L
/* 콘솔의 순수한 부분 시험: 문장 끊기, 표시 폭, 셀 문자열, 표, 메시지 */
#include "console.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static con_splitter splitter;

/* 글자를 하나씩 넣고 일어난 일을 글자로 적는다: S[문장] 완성, E 빈 문장, L 너무 긴 문장, P 끝나지 않은 입력이 남음 */
static char *split_log(const char *text) {
    char *log = calloc(strlen(text) + 256, 1);
    assert(log);
    con_splitter_reset(&splitter);
    for (const char *p = text; *p; p++) {
        con_feed_result r = con_feed(&splitter, (unsigned char)*p);
        if (r == CON_STATEMENT) {
            strcat(log, "S[");
            strcat(log, splitter.sql);
            strcat(log, "]");
            con_splitter_reset(&splitter);
        } else if (r == CON_EMPTY) {
            strcat(log, "E");
            con_splitter_reset(&splitter);
        } else if (r == CON_TOO_LONG) {
            strcat(log, "L");
            con_splitter_reset(&splitter);
        }
    }
    if (con_pending(&splitter))
        strcat(log, "P");
    return log;
}
static void expect_split(const char *text, const char *expected) {
    char *log = split_log(text);
    if (strcmp(log, expected)) {
        fprintf(stderr, "split(%s)\n  expected %s\n  got      %s\n", text, expected, log);
        abort();
    }
    free(log);
}
static void test_splitter(void) {
    expect_split("SELECT 1;", "S[SELECT 1;]");
    expect_split("A;B;", "S[A;]S[B;]");
    expect_split("  \n\n  SELECT 1;", "S[SELECT 1;]"); /* 문장 앞의 공백·빈 줄은 버린다 */
    expect_split(";", "E");
    expect_split(";;", "EE");
    expect_split("A; ;", "S[A;]E");
    expect_split("INSERT 'a;b';", "S[INSERT 'a;b';]"); /* 따옴표 안의 ; 는 끝이 아니다 */
    expect_split("X 'O''Brien; x';", "S[X 'O''Brien; x';]"); /* '' 는 따옴표 안의 작은따옴표다 */
    expect_split("SELECT *\nFROM t;", "S[SELECT *\nFROM t;]"); /* 여러 줄 */
    expect_split("SELECT 1", "P"); /* 끝나지 않았다 */
    expect_split("SELECT 'abc;", "P"); /* 따옴표가 닫히지 않았으니 ; 도 끝이 아니다 */
    expect_split("한글 'ㄱ;ㄴ';", "S[한글 'ㄱ;ㄴ';]"); /* 여러 바이트 글자 */
    expect_split("   \n  ", ""); /* 공백뿐이면 남은 입력이 없다 */

    /* 한도: 엔진과 같이 MDB_SQL_MAX 바이트까지는 받는다 (;까지 센다) */
    char *text = malloc(MDB_SQL_MAX + 16);
    assert(text);
    memset(text, 'a', MDB_SQL_MAX - 1);
    strcpy(text + MDB_SQL_MAX - 1, ";");
    char *log = split_log(text);
    assert(log[0] == 'S' && strlen(log) == MDB_SQL_MAX + 3); /* S[ + MDB_SQL_MAX 글자 + ] */
    free(log);
    memset(text, 'a', MDB_SQL_MAX);
    strcpy(text + MDB_SQL_MAX, ";B;"); /* 한도를 한 글자 넘는 문장, 그다음 정상 문장 */
    log = split_log(text);
    assert(!strcmp(log, "LS[B;]")); /* 긴 문장만 버리고 다음 문장은 정상이다 */
    free(log);
    /* 버리는 동안에도 따옴표 상태를 따라가서, 따옴표 안의 ; 에서는 끝나지 않는다 */
    memset(text, 'a', MDB_SQL_MAX);
    text[0] = '\'';
    strcpy(text + MDB_SQL_MAX, ";'x;Q;");
    log = split_log(text);
    assert(!strcmp(log, "LS[Q;]"));
    free(log);
    free(text);
}

static void test_width(void) {
    assert(con_display_width("") == 0);
    assert(con_display_width("abc") == 3);
    assert(con_display_width("가") == 2);
    assert(con_display_width("총웨") == 4);
    assert(con_display_width("a총b") == 4);
    assert(con_display_width("e\xCC\x81") == 1); /* e + 결합 악센트는 1칸 */
    assert(con_display_width("\xF0\x9F\x98\x80") == 2); /* 이모지 */
    assert(con_display_width("\xFF") == 1); /* 올바르지 않은 바이트도 멈추지 않는다 */
    assert(con_display_width("\xE3\x81") == 2); /* 끊어진 3바이트 글자: 두 바이트가 각각 1칸 */
}

static void test_escape(void) {
    char *s = con_escape_cell("a\nb\tc\r\x01\x7F" "가");
    assert(!strcmp(s, "a\\nb\\tc\\r\\x01\\x7F" "가"));
    free(s);
    s = con_escape_cell("");
    assert(!strcmp(s, ""));
    free(s);
}

/* 출력을 문자열로 받아 보는 도구 */
typedef struct {
    char *out, *err;
    size_t out_size, err_size;
    FILE *fo, *fe;
} capture;
static void capture_open(capture *c) {
    c->out = c->err = NULL;
    c->fo = open_memstream(&c->out, &c->out_size);
    c->fe = open_memstream(&c->err, &c->err_size);
    assert(c->fo && c->fe);
}
static void capture_close(capture *c) {
    fclose(c->fo);
    fclose(c->fe);
}
static void capture_free(capture *c) {
    free(c->out);
    free(c->err);
}
static int has(const char *text, const char *needle) { return strstr(text, needle) != NULL; }

static void test_table(void) {
    char *columns[] = {"id", "name"};
    mdb_type types[] = {MDB_INT, MDB_STRING};
    mdb_value r0[] = {{MDB_INT, 1, NULL}, {MDB_STRING, 0, "총웨"}};
    mdb_value r1[] = {{MDB_INT, 10, NULL}, {MDB_STRING, 0, ""}};
    mdb_value r2[] = {{MDB_INT, 200, NULL}, {MDB_STRING, 0, "a\nb"}};
    mdb_value r3[] = {{MDB_INT, -5, NULL}, {MDB_STRING, 0, NULL}}; /* 문자열 포인터가 NULL: 엔진은 빈 문자열과 같게 다룬다 */
    mdb_result_row rows[] = {{r0}, {r1}, {r2}, {r3}};
    mdb_result r;
    memset(&r, 0, sizeof r);
    r.columns = columns;
    r.types = types;
    r.ncolumns = 2;
    r.rows = rows;
    r.nrows = 4;
    capture c;
    capture_open(&c);
    con_print_table(c.fo, &r);
    capture_close(&c);
    const char *expected =
        "+-----+------+\n"
        "|  id | name |\n"
        "+-----+------+\n"
        "|   1 | 총웨 |\n"
        "|  10 |      |\n"
        "| 200 | a\\nb |\n"
        "|  -5 |      |\n"
        "+-----+------+\n";
    if (strcmp(c.out, expected)) {
        fprintf(stderr, "table\nexpected:\n%s\ngot:\n%s\n", expected, c.out);
        abort();
    }
    assert(!has(c.out, "NULL")); /* 이 엔진에는 NULL이 없다. 빈 문자열을 NULL로 보여 주지 않는다 */
    capture_free(&c);

    /* 0행이어도 머리글은 나온다 */
    r.nrows = 0;
    capture_open(&c);
    con_print_table(c.fo, &r);
    capture_close(&c);
    assert(!strcmp(c.out, "+----+------+\n| id | name |\n+----+------+\n+----+------+\n"));
    capture_free(&c);
}

static mdb_result base(void) {
    mdb_result r;
    memset(&r, 0, sizeof r);
    snprintf(r.state, sizeof r.state, "IDLE");
    return r;
}
static void test_messages(void) {
    capture c;
    mdb_result r;

    /* INSERT: 영향받은 행, 새 id, 커밋 상태 */
    r = base();
    r.affected = 1, r.has_inserted_id = 1, r.inserted_id = 7, r.commit = MDB_DURABLE, r.txid = 3;
    capture_open(&c);
    con_report(c.fo, c.fe, "INSERT INTO t VALUES ('x');", 0, &r, 0.5);
    capture_close(&c);
    assert(has(c.out, "1행이 영향받았습니다") && has(c.out, "inserted id=7") && has(c.out, "DURABLE, txid 3"));
    assert(c.err[0] == 0);
    capture_free(&c);

    /* 트랜잭션 안: 아직 커밋되지 않음 */
    r = base();
    r.affected = 2, r.staged = 1;
    capture_open(&c);
    con_report(c.fo, c.fe, "update t set a=1;", 0, &r, 0.1); /* 소문자 키워드도 같다 */
    capture_close(&c);
    assert(has(c.out, "2행이 영향받았습니다") && has(c.out, "STAGED") && !has(c.out, "inserted"));
    capture_free(&c);

    /* 바뀐 것이 없는 경우 */
    r = base();
    r.commit = MDB_NO_CHANGES;
    capture_open(&c);
    con_report(c.fo, c.fe, "DELETE FROM t WHERE id = 9;", 0, &r, 0.1);
    capture_close(&c);
    assert(has(c.out, "0행이 영향받았습니다") && has(c.out, "NO_CHANGES"));
    capture_free(&c);

    /* BEGIN / COMMIT / ROLLBACK */
    r = base();
    r.txid = 5;
    capture_open(&c);
    con_report(c.fo, c.fe, "BEGIN;", 0, &r, 0.1);
    capture_close(&c);
    assert(has(c.out, "트랜잭션을 시작했습니다") && has(c.out, "txid 5"));
    capture_free(&c);
    r = base();
    r.commit = MDB_DURABLE, r.txid = 5;
    capture_open(&c);
    con_report(c.fo, c.fe, "COMMIT;", 0, &r, 0.1);
    capture_close(&c);
    assert(has(c.out, "커밋했습니다") && has(c.out, "DURABLE"));
    capture_free(&c);
    r = base();
    capture_open(&c);
    con_report(c.fo, c.fe, "ROLLBACK;", 0, &r, 0.1);
    capture_close(&c);
    assert(has(c.out, "롤백했습니다"));
    capture_free(&c);

    /* SELECT: 표 + 몇 행, 인덱스를 썼는지 */
    char *columns[] = {"id"};
    mdb_type types[] = {MDB_INT};
    mdb_value v[] = {{MDB_INT, 1, NULL}};
    mdb_result_row rows[] = {{v}};
    r = base();
    r.columns = columns, r.types = types, r.ncolumns = 1, r.rows = rows, r.nrows = 1, r.used_index = 1;
    capture_open(&c);
    con_report(c.fo, c.fe, "SELECT id FROM t WHERE id = 1;", 0, &r, 0.25);
    capture_close(&c);
    assert(has(c.out, "| id |") && has(c.out, "(1행 · 인덱스 조회 · 0.25 ms)"));
    capture_free(&c);
    r.used_index = 0;
    capture_open(&c);
    con_report(c.fo, c.fe, "SELECT id FROM t;", 0, &r, 0.25);
    capture_close(&c);
    assert(has(c.out, "전체 훑기"));
    capture_free(&c);

    /* 문법 오류: 메시지와 오류가 난 자리를 가리키는 ^ (한글 앞에서는 폭만큼 띄운다) */
    r = base();
    r.error.code = MDB_SYNTAX;
    r.error.offset = 7;
    snprintf(r.error.message, sizeof r.error.message, "Expected something");
    capture_open(&c);
    con_report(c.fo, c.fe, "가나 FROM;", -1, &r, 0.1); /* offset 7 = "가나 " 뒤 (가=3바이트, 나=3바이트, 공백=1) */
    capture_close(&c);
    assert(c.out[0] == 0);
    assert(has(c.err, "오류 [ERR_SYNTAX] Expected something"));
    assert(has(c.err, "  가나 FROM;\n  " "     ^\n")); /* 가나(4칸) + 공백(1칸) = 5칸 */
    capture_free(&c);

    /* 여러 줄 SQL 에서는 오류가 난 줄만 보여 준다 */
    r = base();
    r.error.code = MDB_SYNTAX;
    r.error.offset = 12; /* 두 번째 줄의 "b" 앞 */
    snprintf(r.error.message, sizeof r.error.message, "x");
    capture_open(&c);
    con_report(c.fo, c.fe, "SELECT *\nFROM  b;", -1, &r, 0.1);
    capture_close(&c);
    assert(has(c.err, "  FROM  b;\n") && !has(c.err, "SELECT *"));
    capture_free(&c);

    /* 없는 테이블 안내 */
    r = base();
    r.error.code = MDB_UNKNOWN_TABLE;
    snprintf(r.error.message, sizeof r.error.message, "Unknown table");
    capture_open(&c);
    con_report(c.fo, c.fe, "SELECT * FROM x;", -1, &r, 0.1);
    capture_close(&c);
    assert(has(c.err, "ERR_UNKNOWN_TABLE") && has(c.err, ".tables"));
    capture_free(&c);

    /* 트랜잭션 안의 오류: FAILED 안내. 이미 FAILED 인 트랜잭션의 오류는 같은 안내를 되풀이하지 않는다 */
    r = base();
    r.error.code = MDB_SYNTAX;
    snprintf(r.state, sizeof r.state, "FAILED");
    snprintf(r.error.message, sizeof r.error.message, "x");
    capture_open(&c);
    con_report(c.fo, c.fe, "SELEC;", -1, &r, 0.1);
    capture_close(&c);
    assert(has(c.err, "FAILED 상태") && has(c.err, "ROLLBACK"));
    capture_free(&c);
    r.error.code = MDB_FAILED;
    capture_open(&c);
    con_report(c.fo, c.fe, "SELECT 1;", -1, &r, 0.1);
    capture_close(&c);
    assert(has(c.err, "ERR_FAILED_TRANSACTION") && !has(c.err, "FAILED 상태"));
    capture_free(&c);

    /* 충돌 */
    r = base();
    r.error.code = MDB_CONFLICT;
    snprintf(r.error.message, sizeof r.error.message, "conflict");
    capture_open(&c);
    con_report(c.fo, c.fe, "COMMIT;", -1, &r, 0.1);
    capture_close(&c);
    assert(has(c.err, "충돌") && has(c.err, "ROLLBACK"));
    capture_free(&c);

    /* 커밋 여부 모름 + 복구 필요 */
    r = base();
    r.error.code = MDB_IO;
    r.commit = MDB_UNKNOWN, r.txid = 9, r.recovery_required = 1;
    snprintf(r.error.message, sizeof r.error.message, "io");
    capture_open(&c);
    con_report(c.fo, c.fe, "COMMIT;", -1, &r, 0.1);
    capture_close(&c);
    assert(has(c.err, "UNKNOWN, txid 9") && has(c.err, "--tx-status 9") && has(c.err, "복구가 필요"));
    assert(!has(c.err, "NOT_COMMITTED") && !has(c.err, "DURABLE"));
    capture_free(&c);

    /* 오류로 보여도 커밋이 확정된 경우: 다시 실행하면 중복 저장되므로 그 사실을 말한다 */
    r = base();
    r.error.code = MDB_IO;
    r.commit = MDB_DURABLE, r.txid = 4097, r.recovery_required = 1;
    snprintf(r.error.message, sizeof r.error.message, "Commit is durable; CSV/completion needs recovery before further SQL");
    capture_open(&c);
    con_report(c.fo, c.fe, "INSERT INTO t VALUES ('x');", -1, &r, 0.1);
    capture_close(&c);
    assert(has(c.err, "커밋은 확정됐습니다 (DURABLE, txid 4097)") && has(c.err, "다시 실행하지 마세요") && has(c.err, "복구가 필요"));
    assert(!has(c.err, "NOT_COMMITTED"));
    capture_free(&c);

    /* 입출력 오류로 저장되지 않은 경우: 다시 시도해도 안전하다고 말한다 */
    r = base();
    r.error.code = MDB_IO;
    r.commit = MDB_NOT_COMMITTED;
    snprintf(r.error.message, sizeof r.error.message, "write failed");
    capture_open(&c);
    con_report(c.fo, c.fe, "INSERT INTO t VALUES ('x');", -1, &r, 0.1);
    capture_close(&c);
    assert(has(c.err, "저장되지 않았습니다 (NOT_COMMITTED)") && has(c.err, "중복되지 않습니다") && !has(c.err, "DURABLE"));
    capture_free(&c);

    /* 일반 오류(문법 등)에는 저장 여부 안내를 붙이지 않는다: 매번 나오면 소음이다 */
    r = base();
    r.error.code = MDB_SYNTAX;
    r.commit = MDB_NOT_COMMITTED;
    snprintf(r.error.message, sizeof r.error.message, "x");
    capture_open(&c);
    con_report(c.fo, c.fe, "SELEC;", -1, &r, 0.1);
    capture_close(&c);
    assert(!has(c.err, "NOT_COMMITTED") && !has(c.err, "DURABLE") && !has(c.err, "저장되지 않았습니다"));
    capture_free(&c);
}

int main(void) {
    test_splitter();
    test_width();
    test_escape();
    test_table();
    test_messages();
    puts("console core: ok");
    return 0;
}
