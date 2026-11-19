#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE
#include "engine.h"
#include "records.h"

#include <ctype.h>
#include <errno.h>
#include <inttypes.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define MAX_TABLES 128
#define MAX_COLUMNS 128
typedef struct {
    char *name;
    DBColumn columns[MAX_COLUMNS];
    size_t count;
    DBRecords *records;
} Table;
struct DBEngine { Table tables[MAX_TABLES]; size_t count; };

static int fail(char *error, size_t size, const char *format, ...) {
    if (error && size) {
        va_list args; va_start(args, format); vsnprintf(error, size, format, args); va_end(args);
    }
    return -1;
}
static int identifier(const char *name) {
    if (!name || !(islower((unsigned char)*name) || *name == '_')) return 0;
    for (const char *p = name + 1; *p; p++)
        if (!(islower((unsigned char)*p) || isdigit((unsigned char)*p) || *p == '_')) return 0;
    return strlen(name) <= 63 && strcmp(name,"insert") && strcmp(name,"into") &&
        strcmp(name,"values") && strcmp(name,"select") && strcmp(name,"from") && strcmp(name,"where");
}
void db_engine_close(DBEngine *engine) {
    if (!engine) return;
    for (size_t t = 0; t < engine->count; t++) {
        Table *table = &engine->tables[t];
        db_records_close(table->records); free(table->name);
        for (size_t c = 0; c < table->count; c++) free((char *)table->columns[c].name);
    }
    free(engine);
}
void db_result_free(char *result) { free(result); }

/* One line: users id:INTEGER name:TEXT(64) age:INTEGER */
static DBEngine *load_schema(const char *directory, char *error, size_t size) {
    char path[4096];
    if (!directory || snprintf(path, sizeof path, "%s/schema.txt", directory) >= (int)sizeof path) {
        fail(error, size, "Invalid/long DB directory"); return NULL;
    }
    FILE *file = fopen(path, "r");
    if (!file) { fail(error, size, "Cannot read schema.txt: %s", strerror(errno)); return NULL; }
    DBEngine *engine = calloc(1, sizeof *engine);
    if (!engine) { fclose(file); fail(error, size, "Out of memory"); return NULL; }
    char *line = NULL; size_t capacity = 0; ssize_t length; size_t line_number = 0;
    while ((length = getline(&line, &capacity, file)) >= 0) {
        line_number++;
        if (length > 65536 || memchr(line, 0, (size_t)length)) goto invalid;
        char *save = NULL;
        char *word = strtok_r(line, " \t\r\n", &save);
        if (!word || word[0] == '#') continue;
        if (engine->count == MAX_TABLES || !identifier(word)) goto invalid;
        for (size_t i = 0; i < engine->count; i++) if (!strcmp(engine->tables[i].name, word)) goto invalid;
        Table *table = &engine->tables[engine->count++];
        table->name = strdup(word); if (!table->name) goto invalid;
        while ((word = strtok_r(NULL, " \t\r\n", &save))) {
            char *colon = strchr(word, ':'); if (!colon || table->count == MAX_COLUMNS) goto invalid;
            *colon++ = 0;
            if (!identifier(word)) goto invalid;
            for (size_t i = 0; i < table->count; i++) if (!strcmp(table->columns[i].name, word)) goto invalid;
            DBType type; uint32_t bytes = 0;
            if (!strcmp(colon, "INTEGER")) type = DB_INTEGER;
            else {
                if (strncmp(colon, "TEXT(", 5)) goto invalid;
                char *end; errno = 0; unsigned long n = strtoul(colon + 5, &end, 10);
                if (!isdigit((unsigned char)colon[5]) || errno || strcmp(end, ")") || !n || n > 1048576) goto invalid;
                type = DB_TEXT; bytes = (uint32_t)n;
            }
            char *name = strdup(word); if (!name) goto invalid;
            table->columns[table->count++] = (DBColumn){name, type, bytes};
        }
        if (!table->count || strcmp(table->columns[0].name, "id") || table->columns[0].type != DB_INTEGER) goto invalid;
    }
    if (ferror(file) || !engine->count) goto invalid;
    free(line); fclose(file); return engine;
invalid:
    fail(error, size, "Invalid schema.txt at line %zu (lowercase names, id:INTEGER first required)", line_number);
    free(line); fclose(file); db_engine_close(engine); return NULL;
}

DBEngine *db_engine_open(const char *directory, char *error, size_t size) {
    DBEngine *engine = load_schema(directory, error, size); if (!engine) return NULL;
    for (size_t i = 0; i < engine->count; i++) {
        char path[4096]; Table *table = &engine->tables[i];
        if (snprintf(path, sizeof path, "%s/tables/%s.tbl", directory, table->name) >= (int)sizeof path) {
            fail(error, size, "Table path too long"); db_engine_close(engine); return NULL;
        }
        DBSchema schema = {table->columns, table->count};
        table->records = db_records_open(path, &schema, error, size);
        if (!table->records) { db_engine_close(engine); return NULL; }
    }
    return engine;
}

int db_prepare_tables(const char *directory, char *error, size_t size) {
    DBEngine *engine = load_schema(directory, error, size); if (!engine) return -1;
    char path[4096]; int result = 0;
    if (snprintf(path, sizeof path, "%s/tables", directory) >= (int)sizeof path ||
        (mkdir(path, 0700) && errno != EEXIST)) {
        result = fail(error, size, "Cannot prepare tables directory"); goto done;
    }
    for (size_t i = 0; i < engine->count; i++) {
        Table *table = &engine->tables[i];
        if (snprintf(path, sizeof path, "%s/tables/%s.tbl", directory, table->name) >= (int)sizeof path) {
            result = fail(error, size, "Table path too long"); break;
        }
        struct stat info;
        DBSchema schema = {table->columns, table->count};
        if (lstat(path, &info) == 0) continue; /* Existing user files are never overwritten. */
        if (errno != ENOENT || db_table_create(path, &schema, error, size) < 0) { result = -1; break; }
    }
done:
    db_engine_close(engine);
    if (!result) {
        DBEngine *check = db_engine_open(directory, error, size);
        if (!check) return -1;
        db_engine_close(check);
    }
    return result;
}

static Table *find_table(DBEngine *engine, const char *name) {
    for (size_t i = 0; i < engine->count; i++) if (!strcmp(engine->tables[i].name, name)) return &engine->tables[i];
    return NULL;
}
static int column_index(Table *table, const char *name) {
    for (size_t i = 0; i < table->count; i++) if (!strcmp(table->columns[i].name, name)) return (int)i;
    return -1;
}
static void json_string(FILE *out, const char *text) {
    fputc('"', out);
    for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
        if (*p == '"' || *p == '\\') { fputc('\\', out); fputc(*p, out); }
        else if (*p < 32) fprintf(out, "\\u%04x", *p);
        else fputc(*p, out);
    }
    fputc('"', out);
}
static void json_value(FILE *out, const DBValue *value) {
    if (value->type == DB_INTEGER) fprintf(out, "%" PRId64, value->integer);
    else json_string(out, value->text);
}

static int execute_insert(DBEngine *engine, DBInsert *sql, FILE *out, DBSQLError *error) {
    Table *table = find_table(engine, sql->table);
    if (!table) return fail(error->message, sizeof error->message, "Unknown table: %s", sql->table);
    if (sql->column_count != table->count - 1)
        return fail(error->message, sizeof error->message, "INSERT requires all non-ID columns; id is automatic");
    DBValue fields[MAX_COLUMNS] = {0}; int seen[MAX_COLUMNS] = {0};
    for (size_t i = 0; i < sql->column_count; i++) {
        int c = column_index(table, sql->columns[i]);
        if (c <= 0) return fail(error->message, sizeof error->message, "Unknown column or explicit id: %s", sql->columns[i]);
        if (seen[c] || table->columns[c].type != sql->values[i].type)
            return fail(error->message, sizeof error->message, "Duplicate column or type mismatch: %s", sql->columns[i]);
        seen[c] = 1; fields[c - 1] = sql->values[i];
    }
    int64_t id; uint64_t offset;
    if (db_records_insert(table->records, fields, table->count - 1, &id, &offset,
                          error->message, sizeof error->message) < 0) return -1;
    fprintf(out, "{\"type\":\"INSERT\",\"table\":"); json_string(out, table->name);
    fprintf(out, ",\"id\":%" PRId64 ",\"offset\":%" PRIu64 "}", id, offset);
    return 0;
}

static int execute_select(DBEngine *engine, DBSelect *sql, FILE *out, DBSQLError *error) {
    Table *table = find_table(engine, sql->table);
    if (!table) return fail(error->message, sizeof error->message, "Unknown table: %s", sql->table);
    int selected[DB_SQL_MAX_COLUMNS], where = -1;
    size_t count = sql->column_count ? sql->column_count : table->count;
    for (size_t i = 0; i < count; i++) {
        selected[i] = sql->column_count ? column_index(table, sql->columns[i]) : (int)i;
        if (selected[i] < 0) return fail(error->message, sizeof error->message, "Unknown selected column");
    }
    if (sql->where_column) {
        where = column_index(table, sql->where_column);
        if (where < 0 || table->columns[where].type != sql->where_value.type)
            return fail(error->message, sizeof error->message, "Invalid WHERE column or type");
    }
    fputs("{\"type\":\"SELECT\",\"columns\":[", out);
    for (size_t i = 0; i < count; i++) {
        if (i) fputc(',', out);
        json_string(out, table->columns[selected[i]].name);
    }
    fputs("],\"rows\":[", out); uint64_t matched = 0;
    for (uint64_t i = 0; i < db_records_count(table->records); i++) {
        DBValue *row = NULL;
        if (db_records_read(table->records, i, &row, error->message, sizeof error->message) < 0) return -1;
        int match = where < 0 || (row[where].type == DB_INTEGER
            ? row[where].integer == sql->where_value.integer : !strcmp(row[where].text, sql->where_value.text));
        if (match) {
            if (matched++) fputc(',', out);
            fputc('[', out);
            for (size_t j = 0; j < count; j++) { if (j) fputc(',', out); json_value(out, &row[selected[j]]); }
            fputc(']', out);
        }
        db_row_free(row, table->count);
    }
    fprintf(out, "],\"count\":%" PRIu64 "}", matched); return 0;
}

static int execute_one(DBEngine *engine, const char *sql, FILE *out, DBSQLError *error) {
    DBSQLLexer lexer; DBSQLToken token = {0};
    if (db_sql_lexer_init(&lexer, sql, error) < 0 || db_sql_lexer_next(&lexer, &token, error) < 0) return -1;
    DBSQLTokenKind kind = token.kind; db_sql_token_clear(&token);
    if (kind == DB_SQL_INSERT) {
        DBInsert *statement = NULL;
        if (db_sql_parse_insert(sql, &statement, error) < 0) return -1;
        int result = execute_insert(engine, statement, out, error);
        db_sql_insert_free(statement); return result;
    }
    if (kind == DB_SQL_SELECT) {
        DBSelect *statement = NULL;
        if (db_sql_parse_select(sql, &statement, error) < 0) return -1;
        int result = execute_select(engine, statement, out, error);
        db_sql_select_free(statement); return result;
    }
    return fail(error->message, sizeof error->message, "Only INSERT and SELECT are supported");
}

int db_engine_execute(DBEngine *engine, const char *sql, char **json, DBSQLError *error) {
    DBSQLError local = {0}; if (!error) error = &local; else memset(error, 0, sizeof *error);
    if (json) *json = NULL;
    if (!engine || !json) return fail(error->message, sizeof error->message, "Engine and output are required");
    DBSQLLexer lexer; DBSQLToken token = {0};
    if (db_sql_lexer_init(&lexer, sql, error) < 0) return -1;
    char *buffer = NULL; size_t bytes = 0;
    FILE *out = open_memstream(&buffer, &bytes);
    if (!out) return fail(error->message, sizeof error->message, "Out of memory");
    fputc('[', out); size_t begin = 0, statements = 0; int pending = 0, result = 0;
    for (;;) {
        if (db_sql_lexer_next(&lexer, &token, error) < 0) { result = -1; break; }
        if (token.kind != DB_SQL_EOF && token.kind != DB_SQL_SEMICOLON) pending = 1;
        if (token.kind == DB_SQL_SEMICOLON || token.kind == DB_SQL_EOF) {
            size_t end = token.offset + token.length;
            if (pending) {
                char *part = malloc(end - begin + 1);
                if (!part) { result = fail(error->message, sizeof error->message, "Out of memory"); break; }
                memcpy(part, sql + begin, end - begin); part[end - begin] = 0;
                if (statements) fputc(',', out);
                result = execute_one(engine, part, out, error); free(part);
                if (result < 0) { error->offset += begin; break; }
                statements++;
            }
            pending = 0; begin = end;
        }
        int done = token.kind == DB_SQL_EOF; db_sql_token_clear(&token);
        if (done) break;
    }
    db_sql_token_clear(&token);
    if (!statements && result == 0) result = fail(error->message, sizeof error->message, "SQL contains no statements");
    fputc(']', out);
    if (fclose(out) != 0) result = fail(error->message, sizeof error->message, "Result allocation failed");
    if (result < 0) { free(buffer); return -1; }
    *json = buffer; return 0;
}
