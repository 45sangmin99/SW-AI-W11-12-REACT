#include "records.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct DBRecords {
    DBTable *table;
    size_t column_count;
    int64_t last_id;
};

static int failure(char *error, size_t size, const char *message) {
    if (error && size) snprintf(error, size, "%s", message);
    return -1;
}

DBRecords *db_records_open(const char *path, const DBSchema *schema, char *error, size_t size) {
    if (!schema || !schema->columns || !schema->count || !schema->columns[0].name ||
        strcmp(schema->columns[0].name, "id") || schema->columns[0].type != DB_INTEGER) {
        failure(error, size, "Automatic IDs require first column id INTEGER"); return NULL;
    }
    DBRecords *records = calloc(1, sizeof *records);
    if (!records) { failure(error, size, "Out of memory"); return NULL; }
    records->table = db_table_open(path, schema, error, size);
    if (!records->table) { free(records); return NULL; }
    records->column_count = schema->count;
    /* Rebuild the sequence from persisted records; no stale counter file. */
    for (uint64_t i = 0; i < db_table_count(records->table); i++) {
        DBValue *row = NULL;
        if (db_table_read(records->table, i, &row, error, size) < 0) {
            db_records_close(records); return NULL;
        }
        int64_t id = row[0].integer;
        db_row_free(row, records->column_count);
        if (id <= records->last_id) {
            failure(error, size, "Persisted IDs must be positive and strictly increasing");
            db_records_close(records); return NULL;
        }
        records->last_id = id;
    }
    return records;
}

void db_records_close(DBRecords *records) {
    if (!records) return;
    db_table_close(records->table);
    free(records);
}

uint64_t db_records_count(const DBRecords *records) { return db_table_count(records->table); }
int db_records_read(DBRecords *records, uint64_t index, DBValue **row, char *error, size_t size) {
    if (!records) return failure(error, size, "Records handle is NULL");
    return db_table_read(records->table, index, row, error, size);
}

int db_records_insert(DBRecords *records, const DBValue *fields, size_t count,
                      int64_t *id, uint64_t *offset, char *error, size_t size) {
    if (!records || count != records->column_count - 1 || (count && !fields))
        return failure(error, size, "Provide every non-ID field in schema order");
    if (records->last_id == INT64_MAX)
        return failure(error, size, "Automatic ID range exhausted");
    DBValue *row = calloc(records->column_count, sizeof *row);
    if (!row) return failure(error, size, "Out of memory");
    int64_t next = records->last_id + 1;
    row[0] = (DBValue){DB_INTEGER, next, NULL};
    if (count) memcpy(row + 1, fields, count * sizeof *fields);
    uint64_t position;
    int result = db_table_append(records->table, row, records->column_count, &position, error, size);
    free(row);
    if (result < 0) return -1;
    records->last_id = next;
    if (id) *id = next;
    if (offset) *offset = position;
    return 0;
}

int db_records_read_offset(DBRecords *records, uint64_t offset, DBValue **row, char *error, size_t size) {
    if (!records) return failure(error, size, "Records handle is NULL");
    return db_table_read_offset(records->table, offset, row, error, size);
}
