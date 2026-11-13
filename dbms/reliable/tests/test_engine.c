#define _DARWIN_C_SOURCE 1
#include "mdb.h"
#include <assert.h>
#include <limits.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static void file(const char *dir, const char *name, const char *content) {
    char p[512];
    snprintf(p, sizeof p, "%s/%s", dir, name);
    FILE *f = fopen(p, "w");
    assert(f);
    assert(fputs(content, f) >= 0);
    assert(!fclose(f));
}
static mdb_result execute(mdb_session *s, const char *sql) {
    mdb_result r;
    int rc = mdb_execute(s, sql, &r);
    if (rc) {
        fprintf(stderr, "SQL failed %s: %s\n", sql, r.error.message);
        abort();
    }
    return r;
}
static void ok(mdb_session *s, const char *sql) {
    mdb_result r = execute(s, sql);
    mdb_result_free(&r);
}
static void bad(mdb_session *s, const char *sql, mdb_code expected) {
    mdb_result r;
    assert(mdb_execute(s, sql, &r) < 0);
    assert(r.error.code == expected);
    mdb_result_free(&r);
}
static int64_t scalar(mdb_session *s, const char *sql) {
    mdb_result r = execute(s, sql);
    assert(r.nrows == 1 && r.ncolumns == 1);
    int64_t v = r.rows[0].values[0].i;
    mdb_result_free(&r);
    return v;
}
static int64_t insert(mdb_session *s, const char *name, int n) {
    char q[512];
    snprintf(q, sizeof q, "INSERT INTO characters (name,attack) VALUES ('%s',%d)", name, n);
    mdb_result r = execute(s, q);
    assert(r.has_inserted_id);
    int64_t id = r.inserted_id;
    mdb_result_free(&r);
    return id;
}
typedef struct {
    mdb_db *db;
    int64_t ids[20];
} worker;
static void *concurrent(void *p) {
    worker *w = p;
    mdb_error e;
    mdb_session *s = mdb_session_open(w->db, &e);
    assert(s);
    ok(s, "BEGIN");
    for (int i = 0; i < 20; i++)
        w->ids[i] = insert(s, "thread", i);
    ok(s, "ROLLBACK");
    mdb_session_close(s);
    return NULL;
}
#ifdef MDB_TESTING
extern void mdb_test_read_hook(mdb_db *, void (*)(void *), void *);
typedef struct {
    pthread_mutex_t mutex;
    pthread_cond_t ready;
    int entered, release;
} gate;
static void read_hook(void *context) {
    gate *g = context;
    pthread_mutex_lock(&g->mutex);
    g->entered++;
    pthread_cond_broadcast(&g->ready);
    while (!g->release)
        pthread_cond_wait(&g->ready, &g->mutex);
    pthread_mutex_unlock(&g->mutex);
}
static void *read_once(void *context) {
    mdb_db *db = context;
    mdb_error e;
    mdb_session *s = mdb_session_open(db, &e);
    assert(s);
    assert(scalar(s, "SELECT attack FROM characters WHERE id=1") == INT64_MIN);
    mdb_session_close(s);
    return NULL;
}
static void parallel_reads(mdb_db *db) {
    gate g;
    memset(&g, 0, sizeof g);
    assert(!pthread_mutex_init(&g.mutex, NULL));
    assert(!pthread_cond_init(&g.ready, NULL));
    mdb_test_read_hook(db, read_hook, &g);
    pthread_t a, b;
    assert(!pthread_create(&a, NULL, read_once, db));
    assert(!pthread_create(&b, NULL, read_once, db));
    pthread_mutex_lock(&g.mutex);
    struct timespec deadline;
    assert(!clock_gettime(CLOCK_REALTIME, &deadline));
    deadline.tv_sec += 5;
    while (g.entered < 2)
        assert(!pthread_cond_timedwait(&g.ready, &g.mutex, &deadline));
    g.release = 1;
    pthread_cond_broadcast(&g.ready);
    pthread_mutex_unlock(&g.mutex);
    assert(!pthread_join(a, NULL) && !pthread_join(b, NULL));
    mdb_test_read_hook(db, NULL, NULL);
    pthread_cond_destroy(&g.ready);
    pthread_mutex_destroy(&g.mutex);
}
#endif
static void io_failures(void) {
    const char *points[] = {"wal_write", "wal_fsync", "applied_write"};
    for (size_t i = 0; i < 3; i++) {
        char dir[] = "/tmp/mdb-io-XXXXXX";
        assert(mkdtemp(dir));
        file(dir, "characters.schema", "id INT AUTO\nname VARCHAR(80)\nattack INT\n");
        file(dir, "characters.csv", "");
        mdb_error e;
        mdb_db *db = mdb_open(dir, &e);
        assert(db);
        mdb_session *session = mdb_session_open(db, &e);
        assert(session);
        insert(session, "kept", 1);
        assert(!setenv("MDB_IO_FAIL", points[i], 1));
        mdb_result r;
        assert(mdb_execute(session, "INSERT INTO characters VALUES ('uncertain',2)", &r) < 0);
        assert(r.error.code == MDB_IO && r.recovery_required);
        assert(r.commit == (i == 2 ? MDB_DURABLE : MDB_UNKNOWN));
        uint64_t txid = r.txid;
        mdb_result_free(&r);
        assert(!mdb_healthy(db));
        bad(session, "SELECT * FROM characters", MDB_IO);
        unsetenv("MDB_IO_FAIL");
        mdb_session_close(session);
        mdb_close(db);
        db = mdb_open(dir, &e);
        if (!db) {
            fprintf(stderr, "IO reopen %s: %s\n", points[i], e.message);
            abort();
        }
        session = mdb_session_open(db, &e);
        assert(session);
        int64_t expected = i == 0 ? 1 : 2;
        assert(scalar(session, "SELECT COUNT(*) FROM characters") == expected);
        assert(mdb_transaction_status(db, txid) == (i != 0));
        mdb_session_close(session);
        mdb_close(db);
        db = mdb_open(dir, &e);
        assert(db);
        session = mdb_session_open(db, &e);
        assert(scalar(session, "SELECT COUNT(*) FROM characters") == expected);
        mdb_session_close(session);
        mdb_close(db);
        char command[600];
        snprintf(command, sizeof command, "rm -rf %s", dir);
        assert(system(command) == 0);
    }
}
static void limits(void) {
    char dir[] = "/tmp/mdb-limit-XXXXXX";
    assert(mkdtemp(dir));
    file(dir, "characters.schema", "id INT AUTO\nname VARCHAR(80)\nattack INT\n");
    file(dir, "characters.csv", "");
    assert(!setenv("MDB_MAX_SESSIONS", "2", 1));
    assert(!setenv("MDB_TX_MAX_CHANGES", "2", 1));
    mdb_error e;
    mdb_db *db = mdb_open(dir, &e);
    assert(db);
    unsetenv("MDB_MAX_SESSIONS");
    unsetenv("MDB_TX_MAX_CHANGES");
    mdb_session *a = mdb_session_open(db, &e), *b = mdb_session_open(db, &e);
    assert(a && b);
    assert(!mdb_session_open(db, &e) && e.code == MDB_LIMIT);
    ok(a, "BEGIN");
    insert(a, "one", 1);
    insert(a, "two", 2);
    bad(a, "INSERT INTO characters VALUES ('three',3)", MDB_LIMIT);
    bad(a, "SELECT * FROM characters", MDB_FAILED);
    ok(a, "ROLLBACK");
    assert(scalar(a, "SELECT COUNT(*) FROM characters") == 0);
    bad(a, "SELECT * FROM characters LIMIT 10001", MDB_LIMIT);
    mdb_session_close(a);
    mdb_session_close(b);
    mdb_close(db);
    char command[600];
    snprintf(command, sizeof command, "rm -rf %s", dir);
    assert(system(command) == 0);
}
int main(void) {
    char dir[] = "/tmp/mdb-engine-XXXXXX";
    assert(mkdtemp(dir));
    file(dir, "characters.schema", "# sample\nid INT AUTO\nname VARCHAR(80)\nattack INT\n");
    file(dir, "items.schema", "id INT AUTO\nname VARCHAR(80)\n");
    file(dir, "characters.csv", "1,\"초기,\"\"값\"\"\n다음\",-9223372036854775808\r\n");
    file(dir, "items.csv", "");
    mdb_error e;
    mdb_db *db = mdb_open(dir, &e);
    if (!db) {
        fprintf(stderr, "open: %s\n", e.message);
        return 1;
    }
    mdb_session *a = mdb_session_open(db, &e), *b = mdb_session_open(db, &e);
    assert(a && b);
    assert(scalar(a, "SELECT attack FROM characters WHERE id=1") == INT64_MIN);
    mdb_result r = execute(a, "SELECT name FROM characters WHERE id=1");
    assert(r.used_index && strcmp(r.rows[0].values[0].s, "초기,\"값\"\n다음") == 0);
    mdb_result_free(&r);
    mdb_db *again = mdb_open(dir, &e);
    assert(!again && e.code == MDB_BUSY);
#ifdef MDB_TESTING
    parallel_reads(db);
#endif

    ok(a, "BEGIN");
    int64_t rolled = insert(a, "rolled", 2);
    assert(scalar(a, "SELECT COUNT(*) FROM characters") == 2);
    assert(scalar(b, "SELECT COUNT(*) FROM characters") == 1);
    ok(a, "ROLLBACK");
    int64_t saved = insert(a, "saved", 10);
    assert(saved > rolled);
    assert(scalar(b, "SELECT COUNT(*) FROM characters") == 2);
    ok(a, "BEGIN");
    ok(b, "BEGIN");
    ok(a, "UPDATE characters SET attack=20 WHERE name='saved'");
    ok(a, "INSERT INTO items VALUES ('one')");
    ok(a, "COMMIT");
    assert(scalar(b, "SELECT attack FROM characters WHERE name='saved'") == 10);
    assert(scalar(b, "SELECT COUNT(*) FROM items") == 0);
    ok(b, "COMMIT");
    assert(scalar(b, "SELECT COUNT(*) FROM items") == 1);
    ok(a, "BEGIN");
    ok(b, "BEGIN");
    ok(a, "UPDATE characters SET attack=30 WHERE name='saved'");
    ok(b, "UPDATE characters SET attack=40 WHERE name='saved'");
    ok(a, "COMMIT");
    bad(b, "COMMIT", MDB_CONFLICT);
    bad(b, "SELECT * FROM items", MDB_FAILED);
    ok(b, "ROLLBACK");
    assert(scalar(b, "SELECT attack FROM characters WHERE name='saved'") == 30);
    ok(a, "BEGIN");
    int64_t transient = insert(a, "transient", 5);
    char query[256];
    snprintf(query, sizeof query, "UPDATE characters SET attack=9 WHERE id=%lld",
             (long long)transient);
    ok(a, query);
    snprintf(query, sizeof query, "SELECT attack FROM characters WHERE id=%lld",
             (long long)transient);
    assert(scalar(a, query) == 9);
    assert(!setenv("MDB_FORCE_SCAN", "1", 1));
    assert(scalar(a, query) == 9);
    unsetenv("MDB_FORCE_SCAN");
    ok(a, "DELETE FROM characters WHERE name='transient'");
    ok(a, "COMMIT");
    assert(scalar(a, "SELECT COUNT(*) FROM characters WHERE name='transient'") == 0);
    bad(a, "INSERT INTO characters (id,name,attack) VALUES (99,'x',1)", MDB_COLUMN_COUNT);
    bad(a, "SELECT * FROM characters WHERE attack='x'", MDB_TYPE);
    ok(a, "BEGIN");
    bad(a, "SELECT missing FROM characters", MDB_UNKNOWN_COLUMN);
    bad(a, "COMMIT", MDB_FAILED);
    ok(a, "ROLLBACK");
    ok(a, "BEGIN");
    int64_t dupsort = insert(a, "z", 30);
    (void)dupsort;
    insert(a, "y", 30);
    r = execute(a, "SELECT name,attack FROM characters WHERE attack=30 ORDER BY attack");
    assert(r.nrows == 3 && strcmp(r.rows[0].values[0].s, "saved") == 0 &&
           strcmp(r.rows[1].values[0].s, "z") == 0 && strcmp(r.rows[2].values[0].s, "y") == 0);
    mdb_result_free(&r);
    ok(a, "ROLLBACK");
    worker workers[4] = {0};
    pthread_t threads[4];
    for (int i = 0; i < 4; i++) {
        workers[i].db = db;
        assert(!pthread_create(&threads[i], NULL, concurrent, &workers[i]));
    }
    for (int i = 0; i < 4; i++)
        assert(!pthread_join(threads[i], NULL));
    for (int i = 0; i < 4; i++)
        for (int j = 0; j < 20; j++)
            for (int k = 0; k <= i; k++)
                for (int l = 0; l < 20; l++)
                    if (k != i || l != j)
                        assert(workers[i].ids[j] != workers[k].ids[l]);
    assert(!setenv("MDB_IO_FAIL", "csv_write", 1));
    mdb_result injected;
    assert(mdb_execute(a, "INSERT INTO characters VALUES ('fail',1)", &injected) < 0);
    assert(injected.commit == MDB_NOT_COMMITTED && injected.error.code == MDB_IO &&
           mdb_healthy(db));
    mdb_result_free(&injected);
    unsetenv("MDB_IO_FAIL");
    assert(scalar(a, "SELECT COUNT(*) FROM characters WHERE name='fail'") == 0);
    int64_t before = insert(a, "before-restart", 77);
    mdb_session_close(a);
    mdb_session_close(b);
    mdb_close(db);
    db = mdb_open(dir, &e);
    if (!db) {
        fprintf(stderr, "reopen: %s\n", e.message);
        return 1;
    }
    a = mdb_session_open(db, &e);
    assert(scalar(a, "SELECT COUNT(*) FROM characters") == 3);
    assert(insert(a, "after-restart", 88) > before);
    ok(a, "BEGIN");
    ok(a, "UPDATE characters SET name='a,b' WHERE name='saved'");
    ok(a, "ROLLBACK");
    assert(scalar(a, "SELECT COUNT(*) FROM characters WHERE name='saved'") == 1);
    mdb_session_close(a);
    mdb_close(db);
    char command[600];
    snprintf(command, sizeof command, "rm -rf %s", dir);
    assert(system(command) == 0);
    io_failures();
    limits();
    puts("PASS engine: CSV multiline/int64, snapshots, own writes, rollback, conflict, atomic "
         "tables, ID reservations, concurrent IDs, restart, process lock");
    return 0;
}
