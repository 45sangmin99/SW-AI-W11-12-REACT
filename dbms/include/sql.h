#ifndef MINI_DB_SQL_H
#define MINI_DB_SQL_H

#include "storage.h"

/* Deliberately small Phase 1 grammar: one INSERT with explicit columns. */
#define DB_SQL_MAX_BYTES (1024u * 1024u)
#define DB_SQL_MAX_COLUMNS 1024u

typedef struct {
    size_t offset; /* Zero-based byte offset in the original SQL input. */
    char message[192];
} DBSQLError;

typedef enum {
    DB_SQL_EOF, DB_SQL_IDENTIFIER, DB_SQL_INTEGER, DB_SQL_STRING,
    DB_SQL_INSERT, DB_SQL_INTO, DB_SQL_VALUES,
    DB_SQL_LPAREN, DB_SQL_RPAREN, DB_SQL_COMMA, DB_SQL_SEMICOLON,
    DB_SQL_SELECT, DB_SQL_FROM, DB_SQL_WHERE, DB_SQL_STAR, DB_SQL_EQUALS
} DBSQLTokenKind;

typedef struct {
    DBSQLTokenKind kind;
    size_t offset;
    size_t length; /* Source byte length, including quotes for strings. */
    char *text; /* Owned lowercase identifier or decoded string, otherwise NULL. */
    int64_t integer;
} DBSQLToken;

typedef struct {
    const char *source; /* Borrowed: input must outlive this lexer. */
    size_t length;
    size_t position;
} DBSQLLexer;

int db_sql_lexer_init(DBSQLLexer *lexer, const char *source, DBSQLError *error);
/* Each successful next() produces a token to clear before requesting another. */
int db_sql_lexer_next(DBSQLLexer *lexer, DBSQLToken *token, DBSQLError *error);
void db_sql_token_clear(DBSQLToken *token);

typedef struct {
    char *table;
    char **columns;
    size_t column_count;
    DBValue *values;
    size_t value_count;
} DBInsert;

/* On failure, *statement is NULL. AST owns every returned identifier/string. */
int db_sql_parse_insert(const char *source, DBInsert **statement, DBSQLError *error);
void db_sql_insert_free(DBInsert *statement);

typedef struct {
    char *table;
    char **columns;
    size_t column_count; /* 0 means SELECT *. */
    char *where_column; /* NULL means no filter. */
    DBValue where_value;
} DBSelect;
int db_sql_parse_select(const char *source, DBSelect **statement, DBSQLError *error);
void db_sql_select_free(DBSelect *statement);

#endif
