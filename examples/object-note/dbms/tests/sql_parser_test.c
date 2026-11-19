#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE
#define _DEFAULT_SOURCE
#include "sql.h"

#include <assert.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static DBInsert *parse(const char *source) {
    DBInsert *statement = NULL;
    DBSQLError error;
    if (db_sql_parse_insert(source, &statement, &error) != 0) {
        fprintf(stderr, "Unexpected parse failure at byte %zu: %s\n%s\n", error.offset, error.message, source);
        abort();
    }
    assert(statement && statement->column_count == statement->value_count);
    return statement;
}

static void reject(const char *source) {
    DBInsert *statement = NULL;
    DBSQLError error;
    assert(db_sql_parse_insert(source, &statement, &error) == -1);
    assert(statement == NULL);
    assert(error.message[0]);
    assert(error.offset <= strlen(source));
}

static void test_valid(void) {
    char source[] = "\n InSeRt\tInTo Users (ID, name, AGE)\r\nVaLuEs (1, '김,민수; O''Brien\n강화', +25); \t";
    DBInsert *statement = parse(source);
    memset(source, 'x', strlen(source)); /* AST does not borrow input memory. */
    assert(strcmp(statement->table, "users") == 0);
    assert(statement->column_count == 3);
    assert(strcmp(statement->columns[0], "id") == 0);
    assert(strcmp(statement->columns[1], "name") == 0);
    assert(strcmp(statement->columns[2], "age") == 0);
    assert(statement->values[0].type == DB_INTEGER && statement->values[0].integer == 1);
    assert(statement->values[1].type == DB_TEXT);
    assert(strcmp(statement->values[1].text, "김,민수; O'Brien\n강화") == 0);
    assert(statement->values[2].integer == 25);
    db_sql_insert_free(statement);

    statement = parse("INSERT INTO t (a,b,c,d) VALUES (-9223372036854775808,9223372036854775807,-0,00012)");
    assert(statement->values[0].integer == INT64_MIN);
    assert(statement->values[1].integer == INT64_MAX);
    assert(statement->values[2].integer == 0);
    assert(statement->values[3].integer == 12);
    db_sql_insert_free(statement);
    statement = parse("INSERT INTO _t (_a,x2) VALUES ('','''')");
    assert(strcmp(statement->values[0].text, "") == 0);
    assert(strcmp(statement->values[1].text, "'") == 0);
    db_sql_insert_free(statement);
    db_sql_insert_free(NULL);
}

static void test_invalid(void) {
    const char *invalid[] = {
        "", "  \n", "SELECT * FROM t", "INSERT t (x) VALUES (1)",
        "INSERT INTO (x) VALUES (1)", "INSERT INTO t VALUES (1)",
        "INSERT INTO t () VALUES ()", "INSERT INTO t (x,) VALUES (1)",
        "INSERT INTO t (x y) VALUES (1,2)", "INSERT INTO t (x,x) VALUES (1,2)",
        "INSERT INTO t (ID,id) VALUES (1,2)", "INSERT INTO t (x) VALUE (1)",
        "INSERT INTO t (x) VALUES ()", "INSERT INTO t (x) VALUES (1,)",
        "INSERT INTO t (x) VALUES ('unclosed)", "INSERT INTO t (x) VALUES (1",
        "INSERT INTO t (x) VALUES (1,2)", "INSERT INTO t (x,y) VALUES (1)",
        "INSERT INTO t (x) VALUES (NULL)", "INSERT INTO t (x) VALUES (true)",
        "INSERT INTO t (x) VALUES (1+2)", "INSERT INTO t (x) VALUES (1.5)",
        "INSERT INTO t (x) VALUES (12abc)", "INSERT INTO t (x) VALUES (0x10)",
        "INSERT INTO t (x) VALUES (9223372036854775808)",
        "INSERT INTO t (x) VALUES (-9223372036854775809)",
        "INSERT INTO t (x) VALUES (999999999999999999999999999999999999999)",
        "INSERT INTO t (x) VALUES (- 1)", "INSERT INTO t (x) VALUES (+)",
        "INSERT INTO t (x) VALUES (1); garbage", "INSERT INTO t (x) VALUES (1);;",
        "INSERT INTO t (x) VALUES (1); INSERT INTO t (x) VALUES (2)",
        "INSERT INTO t (x) VALUES (1),(2)", "INSERT INTO t (x) VALUES (\"text\")",
        "INSERT INTO t (x) VALUES (1) -- comment", "INSERT INTO t (x) VALUES (1) /* comment */",
        "INSERT INTO \"t\" (x) VALUES (1)", "INSERT INTO 한글 (x) VALUES (1)",
        "INSERT INTO t (x) VALUES ('O\\'Brien')"
    };
    for (size_t i = 0; i < sizeof invalid / sizeof invalid[0]; i++) reject(invalid[i]);
    DBSQLError error;
    DBInsert *statement = NULL;
    assert(db_sql_parse_insert(NULL, &statement, &error) == -1 && !statement);
    assert(db_sql_parse_insert("INSERT INTO t (x) VALUES (1)", NULL, &error) == -1);
    assert(db_sql_parse_insert("invalid", &statement, NULL) == -1 && !statement);
    const char *unterminated = "INSERT INTO t (x) VALUES ('oops)";
    assert(db_sql_parse_insert(unterminated, &statement, &error) == -1);
    assert(error.offset == (size_t)(strchr(unterminated, '\'') - unterminated));
    const char *missing_comma = "INSERT INTO t (x y) VALUES (1,2)";
    assert(db_sql_parse_insert(missing_comma, &statement, &error) == -1);
    assert(error.offset == (size_t)(strstr(missing_comma, "y)") - missing_comma));
}

static void test_reentrant_lexer(void) {
    DBSQLLexer a, b;
    DBSQLToken token = {0};
    DBSQLError error;
    assert(db_sql_lexer_init(&a, "INSERT 'a,b;''c' -3", &error) == 0);
    assert(db_sql_lexer_init(&b, "other(7)", &error) == 0);
    assert(db_sql_lexer_next(&a, &token, &error) == 0 && token.kind == DB_SQL_INSERT);
    db_sql_token_clear(&token);
    assert(db_sql_lexer_next(&b, &token, &error) == 0 && token.kind == DB_SQL_IDENTIFIER);
    assert(strcmp(token.text, "other") == 0); db_sql_token_clear(&token);
    assert(db_sql_lexer_next(&a, &token, &error) == 0 && token.kind == DB_SQL_STRING);
    assert(strcmp(token.text, "a,b;'c") == 0 && token.offset == 7); db_sql_token_clear(&token);
    assert(db_sql_lexer_next(&b, &token, &error) == 0 && token.kind == DB_SQL_LPAREN);
    db_sql_token_clear(&token);
    assert(db_sql_lexer_next(&a, &token, &error) == 0 && token.integer == -3);
    db_sql_token_clear(&token);
    assert(db_sql_lexer_next(&a, &token, &error) == 0 && token.kind == DB_SQL_EOF);
    db_sql_token_clear(&token);
}

static void test_limits_and_prefixes(void) {
    const char *valid = "INSERT INTO t(x) VALUES(1);";
    size_t length = strlen(valid);
    char *input = malloc(DB_SQL_MAX_BYTES + 2); assert(input);
    memcpy(input, valid, length);
    memset(input + length, ' ', DB_SQL_MAX_BYTES - length);
    input[DB_SQL_MAX_BYTES] = '\0';
    db_sql_insert_free(parse(input));
    input[DB_SQL_MAX_BYTES] = ' '; input[DB_SQL_MAX_BYTES + 1] = '\0';
    reject(input); free(input);

    /* All incomplete prefixes fail cleanly; the complete statement succeeds. */
    char *prefix = malloc(length + 1); assert(prefix);
    for (size_t i = 0; i + 2 < length; i++) {
        memcpy(prefix, valid, i); prefix[i] = '\0'; reject(prefix);
    }
    free(prefix);

    char *wide = malloc(40000); assert(wide);
    size_t pos = (size_t)sprintf(wide, "INSERT INTO t(");
    for (unsigned i = 0; i < DB_SQL_MAX_COLUMNS; i++)
        pos += (size_t)sprintf(wide + pos, "%sc%u", i ? "," : "", i);
    pos += (size_t)sprintf(wide + pos, ") VALUES(");
    for (unsigned i = 0; i < DB_SQL_MAX_COLUMNS; i++)
        pos += (size_t)sprintf(wide + pos, "%s1", i ? "," : "");
    sprintf(wide + pos, ")");
    DBInsert *statement = parse(wide);
    assert(statement->column_count == DB_SQL_MAX_COLUMNS); db_sql_insert_free(statement);
    /* One more value is rejected independently of the column limit. */
    sprintf(wide + pos, ",1)"); reject(wide);
    pos = (size_t)sprintf(wide, "INSERT INTO t(");
    for (unsigned i = 0; i <= DB_SQL_MAX_COLUMNS; i++)
        pos += (size_t)sprintf(wide + pos, "%sc%u", i ? "," : "", i);
    sprintf(wide + pos, ") VALUES(1)"); reject(wide);
    free(wide);

    /* Exercise cleanup on many malformed short byte strings under sanitizers. */
    const char alphabet[] = "iNsert(),;'123-+ xyz\n";
    unsigned seed = 42;
    for (size_t i = 0; i < 4000; i++) {
        char fuzz[65];
        size_t n = i % 64;
        for (size_t j = 0; j < n; j++) {
            seed = seed * 1664525u + 1013904223u;
            fuzz[j] = alphabet[seed % (sizeof alphabet - 1)];
        }
        fuzz[n] = '\0';
        DBInsert *ast = NULL;
        DBSQLError error;
        int result = db_sql_parse_insert(fuzz, &ast, &error);
        assert(result == 0 || result == -1);
        db_sql_insert_free(ast);
    }
}

static void test_storage_boundary(void) {
    DBColumn columns[] = {{"id", DB_INTEGER, 0}, {"name", DB_TEXT, 64}, {"age", DB_INTEGER, 0}};
    DBSchema schema = {columns, 3};
    char directory[] = "/tmp/mini-db-parser-XXXXXX"; assert(mkdtemp(directory));
    char path[256], error[256]; snprintf(path, sizeof path, "%s/users.tbl", directory);
    assert(db_table_create(path, &schema, error, sizeof error) == 0);
    DBTable *table = db_table_open(path, &schema, error, sizeof error); assert(table);
    DBInsert *statement = parse("INSERT INTO users(id,name,age) VALUES(1,'김,민수',25)");
    assert(db_table_append(table, statement->values, statement->value_count, NULL, error, sizeof error) == 0);
    db_sql_insert_free(statement);
    DBValue *row = NULL;
    assert(db_table_read(table, 0, &row, error, sizeof error) == 0);
    assert(row[0].integer == 1 && row[2].integer == 25 && strcmp(row[1].text, "김,민수") == 0);
    db_row_free(row, 3); db_table_close(table); unlink(path); rmdir(directory);
}

int main(void) {
    test_valid(); test_invalid(); test_reentrant_lexer();
    test_limits_and_prefixes(); test_storage_boundary();
    puts("PASS: INSERT AST, quoting, int64 bounds, diagnostics, reentrant lexer, limits and storage boundary");
    return 0;
}
