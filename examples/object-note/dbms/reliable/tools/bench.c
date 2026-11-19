#define _POSIX_C_SOURCE 200809L
#ifdef __APPLE__
#define _DARWIN_C_SOURCE 1
#endif
#include "bpt.h"
#include "mdb.h"
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <time.h>
static double now(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (double)t.tv_sec + (double)t.tv_nsec / 1e9;
}
static void exec(mdb_session *s, const char *sql) {
    mdb_result r = {0};
    if (mdb_execute(s, sql, &r)) {
        fprintf(stderr, "%s: %s SQL=%s\n", mdb_code_name(r.error.code), r.error.message, sql);
        mdb_result_free(&r);
        exit(1);
    }
    mdb_result_free(&r);
}
static int cmp(const void *a, const void *b) {
    double x = *(const double *)a, y = *(const double *)b;
    return (x > y) - (x < y);
}
static void samples(mdb_session *s, uint64_t n, int indexed, double *out) {
    uint64_t seed = 42;
    for (int i = -2; i < 11; i++) {
        seed = seed * UINT64_C(6364136223846793005) + 1;
        uint64_t key = 1 + seed % n;
        char sql[256];
        snprintf(sql, sizeof(sql),
                 indexed ? "SELECT id,name,k FROM records WHERE id=%" PRIu64 ";"
                         : "SELECT id,name,k FROM records WHERE k=%" PRIu64 ";",
                 key);
        double start = now();
        mdb_result r = {0};
        if (mdb_execute(s, sql, &r)) {
            fprintf(stderr, "query failure: %s\n", r.error.message);
            exit(1);
        }
        double elapsed = now() - start;
        if (r.nrows != 1 || r.ncolumns != 3 || r.rows[0].values[0].i != (int64_t)key ||
            r.used_index != indexed) {
            fprintf(stderr, "query correctness failure\n");
            exit(1);
        }
        mdb_result_free(&r);
        if (i >= 0)
            out[i] = elapsed;
    }
    qsort(out, 11, sizeof(*out), cmp);
}
int main(int argc, char **argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: bench DATA_DIR COUNT\n");
        return 2;
    }
    char *end;
    unsigned long long count = strtoull(argv[2], &end, 10);
    if (!count || *end || count > 10000000)
        return 2;
    mdb_error e = {0};
    double start = now();
    mdb_db *db = mdb_open(argv[1], &e);
    if (!db) {
        fprintf(stderr, "open: %s\n", e.message);
        return 1;
    }
    double empty_open = now() - start;
    mdb_session *s = mdb_session_open(db, &e);
    if (!s)
        return 1;
    exec(s, "BEGIN;");
    start = now();
    char sql[256];
    for (uint64_t i = 1; i <= count; i++) {
        snprintf(sql, sizeof(sql), "INSERT INTO records (name,k) VALUES ('bench',%" PRIu64 ");", i);
        exec(s, sql);
    }
    double insert = now() - start;
    mdb_metrics before = {0}, after = {0};
    mdb_get_metrics(db, &before);
    start = now();
    exec(s, "COMMIT;");
    double commit = now() - start;
    mdb_get_metrics(db, &after);
    double idx[11], scan[11];
    samples(s, count, 1, idx);
    samples(s, count, 0, scan);
    start = now();
    exec(s, "UPDATE records SET name='updated' WHERE id=1;");
    double update = now() - start;
    start = now();
    exec(s, "DELETE FROM records WHERE id=2;");
    double delete_time = now() - start;
    mdb_session_close(s);
    mdb_close(db);
    start = now();
    db = mdb_open(argv[1], &e);
    if (!db) {
        fprintf(stderr, "reopen: %s\n", e.message);
        return 1;
    }
    double reopen = now() - start;
    mdb_metrics reopened = {0};
    mdb_get_metrics(db, &reopened);
    s = mdb_session_open(db, &e);
    exec(s, "SELECT COUNT(*) FROM records;");
    mdb_session_close(s);
    mdb_close(db);
    int64_t *keys = malloc((size_t)count * sizeof(*keys));
    uint64_t *offsets = malloc((size_t)count * sizeof(*offsets));
    if (!keys || !offsets)
        return 1;
    for (size_t i = 0; i < count; i++) {
        keys[i] = (int64_t)i + 1;
        offsets[i] = i;
    }
    /* Construction comparison is separate from storage: a reproducible shuffle. */
    uint64_t seed = 42;
    for (size_t i = (size_t)count - 1; i > 0; i--) {
        seed = seed * UINT64_C(6364136223846793005) + 1;
        size_t j = (size_t)(seed % (i + 1));
        int64_t k = keys[i];
        keys[i] = keys[j];
        keys[j] = k;
        uint64_t o = offsets[i];
        offsets[i] = offsets[j];
        offsets[j] = o;
    }
    mdb_bpt *t = mdb_bpt_create();
    start = now();
    for (size_t i = 0; i < count; i++)
        if (mdb_bpt_insert(t, keys[i], offsets[i]))
            return 1;
    double incremental = now() - start;
    if (mdb_bpt_validate(t))
        return 1;
    size_t memory = mdb_bpt_memory(t);
    mdb_bpt_free(t);
    start = now();
    t = mdb_bpt_bulk(keys, offsets, (size_t)count);
    double bulk = now() - start;
    if (!t || mdb_bpt_validate(t))
        return 1;
    size_t bulk_memory = mdb_bpt_memory(t);
    mdb_bpt_free(t);
    free(keys);
    free(offsets);
    struct rusage ru;
    getrusage(RUSAGE_SELF, &ru);
    printf("{\"count\":%llu,\"seed\":42,\"queries\":11,\"warmups\":2,\"transaction_size\":%llu,"
           "\"empty_open_s\":%.9f,\"sql_insert_s\":%.9f,\"commit_prepare_wal_csv_index_s\":%.9f,"
           "\"commit_csv_write_fsync_s\":%.9f,\"commit_index_build_s\":%.9f,\"commit_wal_sync_s\":%"
           ".9f,\"commit_csv_bytes\":%" PRIu64
           ",\"recovery_internal_s\":%.9f,\"index_query_median_s\":%.9f,\"index_query_max_s\":%.9f,"
           "\"scan_query_median_s\":%.9f,\"scan_query_max_s\":%.9f,\"update_commit_s\":%.9f,"
           "\"delete_commit_s\":%.9f,\"reopen_recovery_index_s\":%.9f,\"bpt_incremental_shuffle_"
           "s\":%.9f,\"bpt_bulk_shuffle_s\":%.9f,\"bpt_incremental_bytes\":%zu,\"bpt_bulk_bytes\":%"
           "zu,\"maxrss_platform_units\":%ld}\n",
           count, count, empty_open, insert, commit, after.csv_write_s - before.csv_write_s,
           after.index_build_s - before.index_build_s, after.wal_sync_s - before.wal_sync_s,
           after.csv_bytes - before.csv_bytes, reopened.recovery_s, idx[5], idx[10], scan[5],
           scan[10], update, delete_time, reopen, incremental, bulk, memory, bulk_memory,
           ru.ru_maxrss);
    return 0;
}
