#include "sql.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    DBSQLLexer lexer;
    DBSQLToken token;
    DBSQLError *error;
} Parser;

static int fail(Parser *parser, const char *message) {
    if (parser->error) {
        parser->error->offset = parser->token.offset;
        snprintf(parser->error->message, sizeof parser->error->message, "%s", message);
    }
    return -1;
}

static int advance(Parser *parser) {
    db_sql_token_clear(&parser->token);
    return db_sql_lexer_next(&parser->lexer, &parser->token, parser->error);
}

static int consume(Parser *parser, DBSQLTokenKind kind, const char *message) {
    if (parser->token.kind != kind) return fail(parser, message);
    return advance(parser);
}

void db_sql_insert_free(DBInsert *statement) {
    if (!statement) return;
    free(statement->table);
    for (size_t i = 0; i < statement->column_count; i++) free(statement->columns[i]);
    free(statement->columns);
    for (size_t i = 0; i < statement->value_count; i++)
        if (statement->values[i].type == DB_TEXT) free((char *)statement->values[i].text);
    free(statement->values);
    free(statement);
}

int db_sql_parse_insert(const char *source, DBInsert **statement, DBSQLError *error) {
    if (error) { error->offset = 0; error->message[0] = '\0'; }
    if (!statement) {
        if (error) snprintf(error->message, sizeof error->message, "AST output pointer is required");
        return -1;
    }
    *statement = NULL;
    Parser parser = {0};
    parser.error = error;
    if (db_sql_lexer_init(&parser.lexer, source, error) < 0) return -1;
    DBInsert *result = calloc(1, sizeof *result);
    if (!result) return fail(&parser, "Out of memory");
    result->columns = calloc(DB_SQL_MAX_COLUMNS, sizeof *result->columns);
    result->values = calloc(DB_SQL_MAX_COLUMNS, sizeof *result->values);
    if (!result->columns || !result->values) { fail(&parser, "Out of memory"); goto invalid; }

    if (advance(&parser) < 0 ||
        consume(&parser, DB_SQL_INSERT, "Expected INSERT") < 0 ||
        consume(&parser, DB_SQL_INTO, "Expected INTO after INSERT") < 0) goto invalid;
    if (parser.token.kind != DB_SQL_IDENTIFIER) { fail(&parser, "Expected unquoted table name"); goto invalid; }
    result->table = parser.token.text; parser.token.text = NULL;
    if (advance(&parser) < 0 ||
        consume(&parser, DB_SQL_LPAREN, "Expected explicit column list after table name") < 0) goto invalid;

    for (;;) {
        if (result->column_count == DB_SQL_MAX_COLUMNS) {
            fail(&parser, "INSERT exceeds 1024 column limit"); goto invalid;
        }
        if (parser.token.kind != DB_SQL_IDENTIFIER) { fail(&parser, "Expected column name"); goto invalid; }
        for (size_t i = 0; i < result->column_count; i++) {
            if (strcmp(result->columns[i], parser.token.text) == 0) {
                fail(&parser, "Duplicate column name"); goto invalid;
            }
        }
        result->columns[result->column_count++] = parser.token.text; parser.token.text = NULL;
        if (advance(&parser) < 0) goto invalid;
        if (parser.token.kind != DB_SQL_COMMA) break;
        if (advance(&parser) < 0) goto invalid;
    }
    if (consume(&parser, DB_SQL_RPAREN, "Expected ')' after column list") < 0 ||
        consume(&parser, DB_SQL_VALUES, "Expected VALUES") < 0 ||
        consume(&parser, DB_SQL_LPAREN, "Expected '(' after VALUES") < 0) goto invalid;
    for (;;) {
        if (result->value_count == DB_SQL_MAX_COLUMNS) {
            fail(&parser, "INSERT exceeds 1024 value limit"); goto invalid;
        }
        DBValue *value = &result->values[result->value_count];
        if (parser.token.kind == DB_SQL_INTEGER) {
            value->type = DB_INTEGER;
            value->integer = parser.token.integer;
        } else if (parser.token.kind == DB_SQL_STRING) {
            value->type = DB_TEXT;
            value->text = parser.token.text; parser.token.text = NULL;
        } else {
            fail(&parser, "Expected INTEGER or single-quoted TEXT; NULL and expressions are unsupported");
            goto invalid;
        }
        result->value_count++;
        if (advance(&parser) < 0) goto invalid;
        if (parser.token.kind != DB_SQL_COMMA) break;
        if (advance(&parser) < 0) goto invalid;
    }
    if (consume(&parser, DB_SQL_RPAREN, "Expected ')' after VALUES tuple") < 0) goto invalid;
    if (parser.token.kind == DB_SQL_SEMICOLON && advance(&parser) < 0) goto invalid;
    if (parser.token.kind != DB_SQL_EOF) {
        fail(&parser, "Expected end of input; only one INSERT statement is supported"); goto invalid;
    }
    if (result->column_count != result->value_count) {
        fail(&parser, "Column count and value count differ"); goto invalid;
    }
    db_sql_token_clear(&parser.token);
    *statement = result;
    return 0;

invalid:
    db_sql_token_clear(&parser.token);
    db_sql_insert_free(result);
    return -1;
}

void db_sql_select_free(DBSelect *statement) {
    if (!statement) return;
    free(statement->table);
    for (size_t i = 0; i < statement->column_count; i++) free(statement->columns[i]);
    free(statement->columns);
    free(statement->where_column);
    if (statement->where_value.type == DB_TEXT) free((char *)statement->where_value.text);
    free(statement);
}

int db_sql_parse_select(const char *source, DBSelect **statement, DBSQLError *error) {
    if (error) { error->offset = 0; error->message[0] = '\0'; }
    if (!statement) return -1;
    *statement = NULL;
    Parser p = {0}; p.error = error;
    if (db_sql_lexer_init(&p.lexer, source, error) < 0) return -1;
    DBSelect *result = calloc(1, sizeof *result);
    if (!result) return fail(&p, "Out of memory");
    result->columns = calloc(DB_SQL_MAX_COLUMNS, sizeof *result->columns);
    if (!result->columns) { fail(&p, "Out of memory"); goto invalid_select; }
    if (advance(&p) < 0 || consume(&p, DB_SQL_SELECT, "Expected SELECT") < 0) goto invalid_select;
    if (p.token.kind == DB_SQL_STAR) {
        if (advance(&p) < 0) goto invalid_select;
    } else {
        for (;;) {
            if (p.token.kind != DB_SQL_IDENTIFIER || result->column_count == DB_SQL_MAX_COLUMNS) {
                fail(&p, "Expected column name (maximum 1024)"); goto invalid_select;
            }
            result->columns[result->column_count++] = p.token.text; p.token.text = NULL;
            if (advance(&p) < 0) goto invalid_select;
            if (p.token.kind != DB_SQL_COMMA) break;
            if (advance(&p) < 0) goto invalid_select;
        }
    }
    if (consume(&p, DB_SQL_FROM, "Expected FROM") < 0) goto invalid_select;
    if (p.token.kind != DB_SQL_IDENTIFIER) { fail(&p, "Expected table name"); goto invalid_select; }
    result->table = p.token.text; p.token.text = NULL;
    if (advance(&p) < 0) goto invalid_select;
    if (p.token.kind == DB_SQL_WHERE) {
        if (advance(&p) < 0) goto invalid_select;
        if (p.token.kind != DB_SQL_IDENTIFIER) { fail(&p, "Expected WHERE column"); goto invalid_select; }
        result->where_column = p.token.text; p.token.text = NULL;
        if (advance(&p) < 0 || consume(&p, DB_SQL_EQUALS, "Only WHERE column = literal is supported") < 0)
            goto invalid_select;
        if (p.token.kind == DB_SQL_INTEGER) {
            result->where_value.type = DB_INTEGER; result->where_value.integer = p.token.integer;
        } else if (p.token.kind == DB_SQL_STRING) {
            result->where_value.type = DB_TEXT; result->where_value.text = p.token.text; p.token.text = NULL;
        } else { fail(&p, "Expected INTEGER or TEXT literal"); goto invalid_select; }
        if (advance(&p) < 0) goto invalid_select;
    }
    if (p.token.kind == DB_SQL_SEMICOLON && advance(&p) < 0) goto invalid_select;
    if (p.token.kind != DB_SQL_EOF) { fail(&p, "Unsupported SELECT syntax or extra statement"); goto invalid_select; }
    db_sql_token_clear(&p.token); *statement = result; return 0;
invalid_select:
    db_sql_token_clear(&p.token); db_sql_select_free(result); return -1;
}
