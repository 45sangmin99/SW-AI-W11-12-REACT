#ifndef MDB_H
#define MDB_H
#include <stddef.h>
#include <stdint.h>
#define MDB_SQL_MAX 4096
#define MDB_NAME_MAX 63
#define MDB_COL_MAX 32
#define MDB_TEXT_MAX 255
#define MDB_RESULT_MAX 10000
typedef enum {
    MDB_OK,
    MDB_SYNTAX,
    MDB_UNKNOWN_TABLE,
    MDB_UNKNOWN_COLUMN,
    MDB_TYPE,
    MDB_TOO_LONG,
    MDB_COLUMN_COUNT,
    MDB_DUPLICATE,
    MDB_IO,
    MDB_NOMEM,
    MDB_LIMIT,
    MDB_CONFLICT,
    MDB_FAILED,
    MDB_CORRUPT,
    MDB_BUSY,
    MDB_STATE
} mdb_code;
typedef struct {
    mdb_code code;
    char message[256];
    size_t offset;
} mdb_error;
typedef enum { MDB_INT = 1, MDB_STRING = 2 } mdb_type;
typedef struct {
    mdb_type type;
    int64_t i;
    char *s;
} mdb_value;
typedef struct {
    int is_column;
    char *column;
    mdb_value value;
} mdb_operand;
typedef enum { MDB_EQ, MDB_NE, MDB_LT, MDB_LE, MDB_GT, MDB_GE } mdb_cmp;
typedef enum { MDB_COMPARE, MDB_AND, MDB_OR } mdb_expr_kind;
typedef struct mdb_expr {
    mdb_expr_kind kind;
    struct mdb_expr *left, *right;
    mdb_operand a, b;
    mdb_cmp cmp;
} mdb_expr;
typedef enum {
    MDB_SELECT,
    MDB_INSERT,
    MDB_UPDATE,
    MDB_DELETE,
    MDB_BEGIN,
    MDB_COMMIT,
    MDB_ROLLBACK
} mdb_stmt_kind;
typedef struct {
    char *column;
    int descending;
} mdb_order;
typedef struct {
    char *column;
    mdb_value value;
} mdb_assignment;
typedef struct {
    mdb_stmt_kind kind;
    char *table;
    char **columns;
    size_t ncolumns;
    mdb_value *values;
    size_t nvalues;
    int star, count;
    mdb_expr *where;
    mdb_order *order;
    size_t norder;
    int64_t limit;
    mdb_assignment *updates;
    size_t nupdates;
    void *arena;
} mdb_stmt;
int mdb_parse(const char *sql, mdb_stmt **out, mdb_error *err);
void mdb_stmt_free(mdb_stmt *s);
/* Indexed candidate iff expression safely implies id = integer. 1 found,0 absent. */
int mdb_expr_id(const mdb_expr *expr, int64_t *id);
typedef struct mdb_db mdb_db;
typedef struct mdb_session mdb_session;
typedef enum { MDB_NOT_COMMITTED, MDB_DURABLE, MDB_UNKNOWN, MDB_NO_CHANGES } mdb_commit_result;
typedef struct {
    mdb_value *values;
} mdb_result_row;
typedef struct {
    mdb_error error;
    char **columns;
    mdb_type *types;
    size_t ncolumns;
    mdb_result_row *rows;
    size_t nrows;
    uint64_t affected, txid;
    int64_t inserted_id;
    int has_inserted_id, used_index, staged, recovery_required;
    mdb_commit_result commit;
    char state[24];
} mdb_result;
/* Exclusive directory owner; validates/replays recovery before returning.
 * All sessions must be closed before mdb_close; caller must join active calls. */
mdb_db *mdb_open(const char *directory, mdb_error *error);
void mdb_close(mdb_db *db);
mdb_session *mdb_session_open(mdb_db *db, mdb_error *error);
void mdb_session_close(mdb_session *session);
/* Distinct sessions may execute concurrently. Serialize calls on one session.
 * One SQL statement only. Result owns data on success AND error; always free it.
 * Return 0 on SQL success, -1 on error; commit outcome must be inspected separately. */
int mdb_execute(mdb_session *session, const char *sql, mdb_result *result);
void mdb_result_free(mdb_result *result);
int mdb_healthy(mdb_db *db);
/* Returns durable committed tx status after recovery; engine-owned implementation. */
int mdb_transaction_status(mdb_db *db, uint64_t txid);
typedef struct {
    double csv_write_s, index_build_s, wal_sync_s, recovery_s;
    uint64_t csv_bytes;
} mdb_metrics;
void mdb_get_metrics(mdb_db *db, mdb_metrics *out);
#ifdef MDB_TESTING
void mdb_test_read_hook(mdb_db *db, void (*hook)(void *), void *context);
#endif
const char *mdb_code_name(mdb_code code);
int mdb_utf8(const char *text, size_t length);
int mdb_value_copy(mdb_value *out, const mdb_value *in);
void mdb_value_clear(mdb_value *value);
char *mdb_result_json(const mdb_result *result);
/* strict JSON object with exactly one sql string, decoded owned output */
int mdb_query_json(const char *body, size_t length, char **sql, mdb_error *error);
#endif
