#ifndef MINI_DB_ENGINE_H
#define MINI_DB_ENGINE_H
#include "sql.h"

typedef struct DBEngine DBEngine;
/* schema.txt and every tables/<name>.tbl must already exist. */
DBEngine *db_engine_open(const char *directory, char *error, size_t error_size);
void db_engine_close(DBEngine *engine);
/* SQL statements run sequentially, stop on first error; no batch transaction.
 * Successful output is owned JSON. Free it with db_result_free().
 * Calls on one engine must be serialized; Thread Pool support is a later phase. */
int db_engine_execute(DBEngine *engine, const char *sql, char **json, DBSQLError *error);
void db_result_free(char *result);
/* Sample/setup helper, not a SQL CREATE TABLE implementation; never overwrites tables. */
int db_prepare_tables(const char *directory, char *error, size_t error_size);
#endif
