#include "sql.h"

#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int fail(DBSQLError *error, size_t offset, const char *message) {
    if (error) {
        error->offset = offset;
        snprintf(error->message, sizeof error->message, "%s", message);
    }
    return -1;
}

static int letter(unsigned char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_';
}
static int digit(unsigned char c) { return c >= '0' && c <= '9'; }
static int space(unsigned char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v';
}

int db_sql_lexer_init(DBSQLLexer *lexer, const char *source, DBSQLError *error) {
    if (error) { error->offset = 0; error->message[0] = '\0'; }
    if (!lexer || !source) return fail(error, 0, "SQL input and lexer are required");
    size_t length = 0;
    while (source[length] && length < DB_SQL_MAX_BYTES) length++;
    if (length == DB_SQL_MAX_BYTES && source[length])
        return fail(error, length, "SQL exceeds 1 MiB input limit");
    *lexer = (DBSQLLexer){source, length, 0};
    return 0;
}

void db_sql_token_clear(DBSQLToken *token) {
    if (!token) return;
    free(token->text);
    memset(token, 0, sizeof *token);
}

int db_sql_lexer_next(DBSQLLexer *lexer, DBSQLToken *token, DBSQLError *error) {
    if (!lexer || !lexer->source || !token)
        return fail(error, 0, "Initialized lexer and token are required");
    memset(token, 0, sizeof *token);
    const char *source = lexer->source;
    size_t *pos = &lexer->position;
    while (*pos < lexer->length && space((unsigned char)source[*pos])) (*pos)++;
    const size_t start = *pos;
    token->offset = start;
    if (start == lexer->length) { token->kind = DB_SQL_EOF; return 0; }
    const unsigned char c = (unsigned char)source[(*pos)++];
    switch (c) {
        case '(': token->kind = DB_SQL_LPAREN; break;
        case ')': token->kind = DB_SQL_RPAREN; break;
        case ',': token->kind = DB_SQL_COMMA; break;
        case ';': token->kind = DB_SQL_SEMICOLON; break;
        case '*': token->kind = DB_SQL_STAR; break;
        case '=': token->kind = DB_SQL_EQUALS; break;
        default: break;
    }
    if (c == '(' || c == ')' || c == ',' || c == ';' || c == '*' || c == '=') {
        token->length = 1;
        return 0;
    }
    if (letter(c)) {
        while (*pos < lexer->length &&
               (letter((unsigned char)source[*pos]) || digit((unsigned char)source[*pos]))) (*pos)++;
        token->length = *pos - start;
        token->text = malloc(token->length + 1);
        if (!token->text) return fail(error, start, "Out of memory");
        for (size_t i = 0; i < token->length; i++) {
            unsigned char ch = (unsigned char)source[start + i];
            token->text[i] = ch >= 'A' && ch <= 'Z' ? (char)(ch + ('a' - 'A')) : (char)ch;
        }
        token->text[token->length] = '\0';
        token->kind = strcmp(token->text, "insert") == 0 ? DB_SQL_INSERT
            : strcmp(token->text, "into") == 0 ? DB_SQL_INTO
            : strcmp(token->text, "values") == 0 ? DB_SQL_VALUES
            : strcmp(token->text, "select") == 0 ? DB_SQL_SELECT
            : strcmp(token->text, "from") == 0 ? DB_SQL_FROM
            : strcmp(token->text, "where") == 0 ? DB_SQL_WHERE : DB_SQL_IDENTIFIER;
        if (token->kind != DB_SQL_IDENTIFIER) { free(token->text); token->text = NULL; }
        return 0;
    }
    if (c == '\'') {
        /* Count first so many small literals cannot retain huge input-sized buffers. */
        size_t scan = *pos, decoded = 0;
        while (scan < lexer->length) {
            char ch = source[scan++];
            if (ch == '\'') {
                if (scan < lexer->length && source[scan] == '\'') {
                    scan++;
                    decoded++;
                } else {
                    token->text = malloc(decoded + 1);
                    if (!token->text) return fail(error, start, "Out of memory");
                    size_t output = 0;
                    for (size_t i = start + 1; i < scan - 1; i++) {
                        token->text[output++] = source[i];
                        if (source[i] == '\'') i++; /* A doubled quote decodes to one. */
                    }
                    token->text[output] = '\0';
                    token->kind = DB_SQL_STRING;
                    token->length = scan - start;
                    *pos = scan;
                    return 0;
                }
            } else decoded++;
        }
        return fail(error, start, "Unterminated SQL string; escape a quote as two single quotes");
    }
    if (digit(c) || c == '-' || c == '+') {
        int negative = c == '-';
        size_t number_start = digit(c) ? start : *pos;
        *pos = number_start;
        if (*pos == lexer->length || !digit((unsigned char)source[*pos]))
            return fail(error, start, "Integer sign must be immediately followed by digits");
        const uint64_t limit = negative ? (uint64_t)INT64_MAX + 1 : (uint64_t)INT64_MAX;
        uint64_t value = 0;
        while (*pos < lexer->length && digit((unsigned char)source[*pos])) {
            unsigned n = (unsigned)(source[*pos] - '0');
            if (value > (limit - n) / 10)
                return fail(error, start, "Integer is outside signed 64-bit range");
            value = value * 10 + n;
            (*pos)++;
        }
        if (*pos < lexer->length &&
            (letter((unsigned char)source[*pos]) || source[*pos] == '.'))
            return fail(error, *pos, "Invalid integer literal");
        token->kind = DB_SQL_INTEGER;
        token->length = *pos - start;
        token->integer = negative
            ? (value == (uint64_t)INT64_MAX + 1 ? INT64_MIN : -(int64_t)value)
            : (int64_t)value;
        return 0;
    }
    return fail(error, start, "Unsupported SQL character");
}
