#ifndef MINI_DB_RECORDS_H
#define MINI_DB_RECORDS_H
#include "storage.h"

typedef struct DBRecords DBRecords;
/* Requires first column id INTEGER. Existing IDs must be positive and increasing. */
DBRecords *db_records_open(const char *path, const DBSchema *schema, char *error, size_t error_size);
void db_records_close(DBRecords *records);
uint64_t db_records_count(const DBRecords *records);
int db_records_read(DBRecords *records, uint64_t index, DBValue **row,
                    char *error, size_t error_size);
/* Supply non-ID fields in schema order; ID is assigned only on successful append. */
int db_records_insert(DBRecords *records, const DBValue *fields, size_t count,
                      int64_t *id, uint64_t *offset, char *error, size_t error_size);
int db_records_read_offset(DBRecords *records, uint64_t offset, DBValue **row,
                           char *error, size_t error_size);
#endif
