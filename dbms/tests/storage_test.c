#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE
#define _DEFAULT_SOURCE
#include "storage.h"
#include <assert.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int main(void) {
    DBColumn columns[] = {{"id", DB_INTEGER, 0}, {"name", DB_TEXT, 64}, {"age", DB_INTEGER, 0}};
    DBSchema schema = {columns, 3};
    char directory[] = "/tmp/mini-db-storage-XXXXXX";
    assert(mkdtemp(directory));
    char path[256], error[256];
    snprintf(path, sizeof path, "%s/users.tbl", directory);
    assert(db_table_create(path, &schema, error, sizeof error) == 0);
    assert(db_table_create(path, &schema, error, sizeof error) == -1);
    DBTable *table = db_table_open(path, &schema, error, sizeof error);
    assert(table);
    assert(db_table_count(table) == 0);
    assert(db_table_row_size(table) == 84); /* 8 + (4 + 64) + 8 */
    assert(!db_table_open(path, &schema, error, sizeof error));
    DBValue *row = NULL;
    assert(db_table_read(table, 0, &row, error, sizeof error) == -1);
    DBValue values[] = {{DB_INTEGER, 1, NULL}, {DB_TEXT, 0, "민수, O'Brien\n문자열"}, {DB_INTEGER, 25, NULL}};
    uint64_t first, second;
    assert(db_table_append(table, values, 3, &first, error, sizeof error) == 0);
    assert(first == 16);
    values[0].integer = INT64_MIN; values[1].text = ""; values[2].integer = INT64_MAX;
    assert(db_table_append(table, values, 3, &second, error, sizeof error) == 0);
    assert(second == first + 84);
    assert(db_table_read_offset(table, first, &row, error, sizeof error) == 0);
    assert(row[0].integer == 1 && row[2].integer == 25);
    assert(strcmp(row[1].text, "민수, O'Brien\n문자열") == 0);
    db_row_free(row, 3);
    assert(db_table_read_offset(table, first + 1, &row, error, sizeof error) == -1);
    assert(db_table_read(table, UINT64_MAX, &row, error, sizeof error) == -1);

    char boundary[66]; memset(boundary, 'x', 64); boundary[64] = '\0';
    values[1].text = boundary;
    assert(db_table_append(table, values, 3, NULL, error, sizeof error) == 0);
    boundary[64] = 'x'; boundary[65] = '\0';
    assert(db_table_append(table, values, 3, NULL, error, sizeof error) == -1);
    values[1].type = DB_INTEGER;
    assert(db_table_append(table, values, 3, NULL, error, sizeof error) == -1);
    assert(db_table_append(table, values, 2, NULL, error, sizeof error) == -1);
    assert(db_table_count(table) == 3);
    db_table_close(table);

    /* Reopen: count and data survive; no struct layout is involved. */
    table = db_table_open(path, &schema, error, sizeof error);
    assert(table && db_table_count(table) == 3);
    assert(db_table_read(table, 1, &row, error, sizeof error) == 0);
    assert(row[0].integer == INT64_MIN && row[2].integer == INT64_MAX);
    assert(strcmp(row[1].text, "") == 0); db_row_free(row, 3);
    db_table_close(table);
    FILE *raw = fopen(path, "rb"); assert(raw);
    unsigned char bytes[24]; assert(fread(bytes, 1, sizeof bytes, raw) == sizeof bytes);
    assert(memcmp(bytes, "MINIDB01", 8) == 0);
    assert(bytes[8] == 84 && bytes[9] == 0);
    assert(bytes[16] == 1 && bytes[17] == 0); fclose(raw);

    columns[1].text_capacity = 65;
    assert(!db_table_open(path, &schema, error, sizeof error));
    columns[1].text_capacity = 64; columns[1].name = "different";
    assert(!db_table_open(path, &schema, error, sizeof error));
    columns[1].name = "name";

    /* Malformed text lengths and incomplete records are rejected. */
    raw = fopen(path, "r+b"); assert(raw); assert(fseek(raw, 24, SEEK_SET) == 0);
    unsigned char corrupt[4] = {255, 255, 255, 255};
    assert(fwrite(corrupt, 1, 4, raw) == 4); fclose(raw);
    table = db_table_open(path, &schema, error, sizeof error); assert(table);
    assert(db_table_read(table, 0, &row, error, sizeof error) == -1); db_table_close(table);
    raw = fopen(path, "ab"); assert(raw); fputc(0, raw); fclose(raw);
    assert(!db_table_open(path, &schema, error, sizeof error));
    unlink(path); rmdir(directory);
    puts("PASS: fixed records, offsets, persistence, validation, locking and corruption checks");
    return 0;
}
