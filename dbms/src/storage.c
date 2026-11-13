#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE
#define _DEFAULT_SOURCE
#include "storage.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#define HEADER_SIZE 16u
#define MAX_ROW_SIZE (16u * 1024u * 1024u)
static const unsigned char MAGIC[8] = {'M','I','N','I','D','B','0','1'};

struct DBTable {
    FILE *file;
    DBColumn *columns;
    size_t count;
    uint32_t row_size;
    uint64_t rows;
};

static int fail(char *error, size_t size, const char *format, ...) {
    if (error && size) {
        va_list args;
        va_start(args, format);
        vsnprintf(error, size, format, args);
        va_end(args);
    }
    return -1;
}

static void put32(unsigned char *p, uint32_t n) {
    for (unsigned i = 0; i < 4; i++) p[i] = (unsigned char)(n >> (i * 8));
}
static uint32_t get32(const unsigned char *p) {
    uint32_t n = 0;
    for (unsigned i = 0; i < 4; i++) n |= (uint32_t)p[i] << (i * 8);
    return n;
}
static uint32_t hash_byte(uint32_t hash, unsigned char value) {
    return (hash ^ value) * UINT32_C(16777619);
}

static int schema_info(const DBSchema *schema, uint32_t *row_size,
                       uint32_t *hash, char *error, size_t size) {
    if (!schema || !schema->columns || schema->count == 0 || schema->count > 1024)
        return fail(error, size, "Schema requires 1..1024 columns");
    uint64_t bytes = 0;
    *hash = UINT32_C(2166136261);
    for (size_t i = 0; i < schema->count; i++) {
        const DBColumn *col = &schema->columns[i];
        if (!col->name || !*col->name)
            return fail(error, size, "Column name is empty");
        for (size_t j = 0; j < i; j++)
            if (strcmp(col->name, schema->columns[j].name) == 0)
                return fail(error, size, "Duplicate column: %s", col->name);
        if (col->type == DB_INTEGER) {
            if (col->text_capacity != 0)
                return fail(error, size, "INTEGER capacity must be zero");
            bytes += 8;
        } else if (col->type == DB_TEXT && col->text_capacity > 0) {
            bytes += (uint64_t)4 + col->text_capacity;
        } else return fail(error, size, "Invalid column type/capacity");
        if (bytes > MAX_ROW_SIZE) return fail(error, size, "Record exceeds 16 MiB");
        for (const unsigned char *p = (const unsigned char *)col->name; *p; p++)
            *hash = hash_byte(*hash, *p);
        *hash = hash_byte(*hash, 0);
        *hash = hash_byte(*hash, (unsigned char)col->type);
        for (unsigned k = 0; k < 4; k++)
            *hash = hash_byte(*hash, (unsigned char)(col->text_capacity >> (8 * k)));
    }
    *row_size = (uint32_t)bytes;
    return 0;
}

int db_table_create(const char *path, const DBSchema *schema, char *error, size_t size) {
    uint32_t row_size, hash;
    if (!path || schema_info(schema, &row_size, &hash, error, size) < 0) return -1;
    /* Never overwrite a user's existing table. */
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (fd < 0) return fail(error, size, "Create failed: %s", strerror(errno));
    unsigned char header[HEADER_SIZE] = {0};
    memcpy(header, MAGIC, sizeof MAGIC);
    put32(header + 8, row_size);
    put32(header + 12, hash);
    FILE *file = fdopen(fd, "wb");
    if (!file) { close(fd); unlink(path); return fail(error, size, "Open stream failed"); }
    int ok = fwrite(header, 1, sizeof header, file) == sizeof header;
    if (fclose(file) != 0) ok = 0;
    if (!ok) { unlink(path); return fail(error, size, "Header write failed"); }
    return 0;
}

DBTable *db_table_open(const char *path, const DBSchema *schema, char *error, size_t size) {
    uint32_t row_size, hash;
    if (!path || schema_info(schema, &row_size, &hash, error, size) < 0) return NULL;
    FILE *file = fopen(path, "r+b");
    if (!file) { fail(error, size, "Open failed: %s", strerror(errno)); return NULL; }
    /* Phase 1 uses one owner per table; concurrent opens fail instead of racing. */
    if (flock(fileno(file), LOCK_EX | LOCK_NB) < 0) {
        fail(error, size, "Table is locked: %s", strerror(errno)); fclose(file); return NULL;
    }
    unsigned char header[HEADER_SIZE];
    struct stat info;
    if (fstat(fileno(file), &info) != 0 || !S_ISREG(info.st_mode) ||
        fread(header, 1, sizeof header, file) != sizeof header ||
        memcmp(header, MAGIC, sizeof MAGIC) != 0 ||
        get32(header + 8) != row_size || get32(header + 12) != hash ||
        info.st_size < HEADER_SIZE || ((uint64_t)info.st_size - HEADER_SIZE) % row_size != 0) {
        fail(error, size, "Invalid table header, schema mismatch, or truncated record");
        fclose(file); return NULL;
    }
    DBTable *table = calloc(1, sizeof *table);
    if (!table) { fail(error, size, "Out of memory"); fclose(file); return NULL; }
    table->file = file; table->row_size = row_size;
    table->rows = ((uint64_t)info.st_size - HEADER_SIZE) / row_size;
    table->count = schema->count;
    table->columns = calloc(table->count, sizeof *table->columns);
    if (!table->columns) { fail(error, size, "Out of memory"); db_table_close(table); return NULL; }
    for (size_t i = 0; i < table->count; i++) {
        table->columns[i] = schema->columns[i];
        table->columns[i].name = strdup(schema->columns[i].name);
        if (!table->columns[i].name) {
            fail(error, size, "Out of memory"); db_table_close(table); return NULL;
        }
    }
    return table;
}

void db_table_close(DBTable *table) {
    if (!table) return;
    if (table->file) fclose(table->file);
    if (table->columns) {
        for (size_t i = 0; i < table->count; i++) free((char *)table->columns[i].name);
        free(table->columns);
    }
    free(table);
}
uint64_t db_table_count(const DBTable *table) { return table->rows; }
uint32_t db_table_row_size(const DBTable *table) { return table->row_size; }

int db_table_append(DBTable *table, const DBValue *values, size_t count,
                    uint64_t *offset, char *error, size_t size) {
    if (!table || !values || count != table->count)
        return fail(error, size, "Column count mismatch");
    unsigned char *record = calloc(1, table->row_size);
    if (!record) return fail(error, size, "Out of memory");
    size_t pos = 0;
    for (size_t i = 0; i < count; i++) {
        const DBColumn *col = &table->columns[i];
        if (values[i].type != col->type) {
            free(record); return fail(error, size, "Type mismatch: %s", col->name);
        }
        if (col->type == DB_INTEGER) {
            uint64_t n = (uint64_t)values[i].integer;
            for (unsigned k = 0; k < 8; k++) record[pos++] = (unsigned char)(n >> (8 * k));
        } else {
            if (!values[i].text) { free(record); return fail(error, size, "NULL TEXT unsupported"); }
            size_t length = strlen(values[i].text);
            if (length > col->text_capacity) {
                free(record); return fail(error, size, "TEXT exceeds %u bytes: %s", col->text_capacity, col->name);
            }
            put32(record + pos, (uint32_t)length); pos += 4;
            memcpy(record + pos, values[i].text, length); pos += col->text_capacity;
        }
    }
    uint64_t start = HEADER_SIZE + table->rows * table->row_size;
    if (start > INT64_MAX - table->row_size || fseeko(table->file, (off_t)start, SEEK_SET) != 0) {
        free(record); return fail(error, size, "Seek failed or table too large");
    }
    int ok = fwrite(record, 1, table->row_size, table->file) == table->row_size;
    free(record);
    if (fflush(table->file) != 0) ok = 0;
    if (!ok) {
        clearerr(table->file);
        return fail(error, size, "Record write failed; close and inspect the table before retrying");
    }
    table->rows++;
    if (offset) *offset = start;
    return 0;
}

void db_row_free(DBValue *values, size_t count) {
    if (!values) return;
    for (size_t i = 0; i < count; i++) if (values[i].type == DB_TEXT) free((char *)values[i].text);
    free(values);
}

int db_table_read_offset(DBTable *table, uint64_t offset, DBValue **values, char *error, size_t size) {
    if (values) *values = NULL;
    if (!table || !values || offset < HEADER_SIZE ||
        (offset - HEADER_SIZE) % table->row_size != 0 ||
        (offset - HEADER_SIZE) / table->row_size >= table->rows)
        return fail(error, size, "Invalid record offset");
    unsigned char *record = malloc(table->row_size);
    DBValue *result = calloc(table->count, sizeof *result);
    if (!record || !result) {
        free(record); free(result); return fail(error, size, "Out of memory");
    }
    if (fseeko(table->file, (off_t)offset, SEEK_SET) != 0 ||
        fread(record, 1, table->row_size, table->file) != table->row_size) {
        free(record); free(result); return fail(error, size, "Record read failed");
    }
    size_t pos = 0;
    for (size_t i = 0; i < table->count; i++) {
        const DBColumn *col = &table->columns[i];
        result[i].type = col->type;
        if (col->type == DB_INTEGER) {
            uint64_t n = 0;
            for (unsigned k = 0; k < 8; k++) n |= (uint64_t)record[pos++] << (k * 8);
            result[i].integer = n <= INT64_MAX ? (int64_t)n : -1 - (int64_t)(UINT64_MAX - n);
        } else {
            uint32_t length = get32(record + pos); pos += 4;
            if (length > col->text_capacity || memchr(record + pos, 0, length)) {
                free(record); db_row_free(result, table->count);
                return fail(error, size, "Corrupt TEXT length/content");
            }
            char *text = malloc((size_t)length + 1);
            if (!text) {
                free(record); db_row_free(result, table->count); return fail(error, size, "Out of memory");
            }
            memcpy(text, record + pos, length); text[length] = '\0';
            result[i].text = text; pos += col->text_capacity;
        }
    }
    free(record); *values = result;
    return 0;
}

int db_table_read(DBTable *table, uint64_t index, DBValue **values, char *error, size_t size) {
    if (!table || index >= table->rows) {
        if (values) *values = NULL;
        return fail(error, size, "Record index out of range");
    }
    return db_table_read_offset(table, HEADER_SIZE + index * table->row_size, values, error, size);
}
