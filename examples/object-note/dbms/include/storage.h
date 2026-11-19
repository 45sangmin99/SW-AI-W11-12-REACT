#ifndef MINI_DB_STORAGE_H
#define MINI_DB_STORAGE_H

#include <stddef.h>
#include <stdint.h>

typedef enum { DB_INTEGER = 1, DB_TEXT = 2 } DBType;

typedef struct {
    const char *name;
    DBType type;
    uint32_t text_capacity; /* UTF-8 byte limit, not character count. */
} DBColumn;

typedef struct {
    const DBColumn *columns;
    size_t count;
} DBSchema;

typedef struct {
    DBType type;
    int64_t integer;
    const char *text;
} DBValue;

typedef struct DBTable DBTable;

/* Return 0 on success, -1 on failure; errors go into the caller's buffer. */
int db_table_create(const char *path, const DBSchema *schema, char *error, size_t error_size);
DBTable *db_table_open(const char *path, const DBSchema *schema, char *error, size_t error_size);
void db_table_close(DBTable *table);
uint64_t db_table_count(const DBTable *table);
uint32_t db_table_row_size(const DBTable *table);

/* Append returns a persistent file offset suitable for a future ID index. */
int db_table_append(DBTable *table, const DBValue *values, size_t count,
                    uint64_t *offset, char *error, size_t error_size);
int db_table_read(DBTable *table, uint64_t index, DBValue **values,
                  char *error, size_t error_size);
int db_table_read_offset(DBTable *table, uint64_t offset, DBValue **values,
                         char *error, size_t error_size);
/* Read results own their TEXT allocations; schema.count gives the array size. */
void db_row_free(DBValue *values, size_t count);

#endif
