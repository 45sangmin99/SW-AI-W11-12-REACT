#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE
#define _DEFAULT_SOURCE
#include "records.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    const DBColumn columns[] = {{"id", DB_INTEGER, 0}, {"name", DB_TEXT, 8}};
    const DBSchema schema = {columns, 2};
    char dir[] = "/tmp/mini-db-ids-XXXXXX", path[256], error[256];
    assert(mkdtemp(dir)); snprintf(path, sizeof path, "%s/users.tbl", dir);
    assert(db_table_create(path, &schema, error, sizeof error) == 0);
    DBRecords *records = db_records_open(path, &schema, error, sizeof error); assert(records);
    DBValue field = {DB_TEXT, 0, "민수"};
    int64_t id; uint64_t first, second;
    assert(db_records_insert(records, &field, 1, &id, &first, error, sizeof error) == 0 && id == 1);
    field.text = "too long!";
    assert(db_records_insert(records, &field, 1, &id, NULL, error, sizeof error) == -1);
    field.text = "지수";
    assert(db_records_insert(records, &field, 1, &id, &second, error, sizeof error) == 0 && id == 2);
    assert(first == 16 && second == 36);
    db_records_close(records);
    records = db_records_open(path, &schema, error, sizeof error); assert(records);
    assert(db_records_insert(records, &field, 1, &id, NULL, error, sizeof error) == 0 && id == 3);
    DBValue *row = NULL;
    assert(db_records_read_offset(records, second, &row, error, sizeof error) == 0);
    assert(row[0].integer == 2 && !strcmp(row[1].text, "지수")); db_row_free(row, 2);
    db_records_close(records);
    unlink(path);

    assert(db_table_create(path, &schema, error, sizeof error) == 0);
    DBTable *table = db_table_open(path, &schema, error, sizeof error); assert(table);
    DBValue high[] = {{DB_INTEGER, INT64_MAX, NULL}, {DB_TEXT, 0, "max"}};
    assert(db_table_append(table, high, 2, NULL, error, sizeof error) == 0); db_table_close(table);
    records = db_records_open(path, &schema, error, sizeof error); assert(records);
    assert(db_records_insert(records, &field, 1, &id, NULL, error, sizeof error) == -1);
    db_records_close(records); unlink(path);

    assert(db_table_create(path, &schema, error, sizeof error) == 0);
    table = db_table_open(path, &schema, error, sizeof error); assert(table);
    high[0].integer = 1;
    assert(db_table_append(table, high, 2, NULL, error, sizeof error) == 0);
    assert(db_table_append(table, high, 2, NULL, error, sizeof error) == 0); db_table_close(table);
    assert(!db_records_open(path, &schema, error, sizeof error));
    unlink(path); rmdir(dir);
    puts("PASS: automatic IDs, restart continuity, rejected-insert sequence, offsets, duplicates and overflow");
    return 0;
}
