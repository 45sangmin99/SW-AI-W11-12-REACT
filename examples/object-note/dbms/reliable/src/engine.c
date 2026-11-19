#define _DARWIN_C_SOURCE 1
#include "bpt.h"
#include "mdb.h"
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

/* All mutable shared state and reference counts are protected by db->mutex.
 * Published views are immutable: their fd and B+ tree always describe one inode.
 * A transaction owns only a snapshot reference and an ID hash of changed rows. */
#define RECORD_MAX (1024U * 1024U)
#define CSV_RECORD_MAX (MDB_COL_MAX * (MDB_TEXT_MAX * 2U + 40U))
#define RESERVE_BLOCK 4096U
#define WAL_HEADER "MDBWAL1\n"
#define WAL_MAGIC 0x314c574dU
#define LOG_RESERVE 1U
#define LOG_TXIDS 2U
#define LOG_BEGIN 3U
#define LOG_ROW 4U
#define LOG_COMMIT 5U
#define LOG_APPLIED 6U
#define FNV_INIT UINT64_C(1469598103934665603)
#define FNV_PRIME UINT64_C(1099511628211)

typedef struct {
    int used;
    int64_t key;
    size_t value;
} bucket;
typedef struct {
    bucket *b;
    size_t cap, n;
} idmap;
typedef struct row {
    size_t refs;
    mdb_value v[];
} row;
typedef struct {
    char name[MDB_NAME_MAX + 1];
    mdb_type type;
    size_t max;
} column;
typedef struct {
    char name[MDB_NAME_MAX + 1];
    column cols[MDB_COL_MAX];
    size_t ncols;
    uint64_t schemahash, basehash, next_id, reserved;
} tabledef;
typedef struct view {
    size_t refs;
    int fd;
    row **rows;
    size_t n;
    mdb_bpt *index;
} view;
typedef struct snapshot {
    size_t refs;
    uint64_t version;
    view **tables;
} snapshot;
typedef struct {
    int64_t id;
    row *value;
    int deleted, inserted;
} change;
typedef struct {
    change *v;
    size_t n, cap;
    idmap map;
} overlay;
typedef struct {
    snapshot *snap;
    overlay *tables;
    uint64_t id;
    size_t nchanges;
    int failed, writes;
} transaction;
struct mdb_db {
    pthread_mutex_t mutex;
    int mutex_ready, dirfd, basefd, lockfd, walfd, healthy;
    tabledef *defs;
    size_t ntables;
    snapshot *current;
    uint64_t txnext, txreserved;
    uint64_t *committed;
    size_t ncommitted, capcommitted, nsessions, max_sessions, max_changes, max_sort_rows;
    int recovering;
    mdb_metrics metrics;
#ifdef MDB_TESTING
    void (*read_hook)(void *);
    void *read_hook_context;
#endif
};
struct mdb_session {
    mdb_db *db;
    transaction *tx;
};
typedef struct {
    int fd;
    uint64_t offset;
    unsigned char buf[8192];
    size_t pos, len;
} csv_reader;
typedef struct {
    row **v;
    size_t n, cap;
    idmap map;
} rowset;

static double seconds(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts))
        return 0;
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}
static int fail(mdb_error *e, mdb_code c, const char *m) {
    if (e) {
        e->code = c;
        e->offset = 0;
        (void)snprintf(e->message, sizeof e->message, "%s", m);
    }
    return -1;
}
static uint64_t hashbytes(uint64_t h, const void *p, size_t n) {
    const unsigned char *b = p;
    for (size_t i = 0; i < n; i++) {
        h ^= b[i];
        h *= FNV_PRIME;
    }
    return h;
}
static uint64_t hashkey(int64_t k) {
    uint64_t x = (uint64_t)k;
    x ^= x >> 30;
    x *= UINT64_C(0xbf58476d1ce4e5b9);
    x ^= x >> 27;
    x *= UINT64_C(0x94d049bb133111eb);
    return x ^ (x >> 31);
}
static int map_get(const idmap *m, int64_t key, size_t *value) {
    if (!m->cap)
        return 0;
    size_t i = (size_t)hashkey(key) & (m->cap - 1);
    while (m->b[i].used) {
        if (m->b[i].key == key) {
            *value = m->b[i].value;
            return 1;
        }
        i = (i + 1) & (m->cap - 1);
    }
    return 0;
}
static int map_reserve(idmap *m, size_t count) {
    size_t cap = m->cap ? m->cap : 16;
    if (count > SIZE_MAX / 2)
        return -1;
    while (count > cap / 2) {
        if (cap > SIZE_MAX / 2)
            return -1;
        cap *= 2;
    }
    if (cap == m->cap)
        return 0;
    bucket *b = calloc(cap, sizeof *b);
    if (!b)
        return -1;
    for (size_t j = 0; j < m->cap; j++)
        if (m->b[j].used) {
            size_t i = (size_t)hashkey(m->b[j].key) & (cap - 1);
            while (b[i].used)
                i = (i + 1) & (cap - 1);
            b[i] = m->b[j];
        }
    free(m->b);
    m->b = b;
    m->cap = cap;
    return 0;
}
static void map_put(idmap *m, int64_t key, size_t value) {
    size_t i = (size_t)hashkey(key) & (m->cap - 1);
    while (m->b[i].used && m->b[i].key != key)
        i = (i + 1) & (m->cap - 1);
    if (!m->b[i].used) {
        m->b[i].used = 1;
        m->b[i].key = key;
        m->n++;
    }
    m->b[i].value = value;
}
static int grow(void **p, size_t *cap, size_t need, size_t size) {
    if (need <= *cap)
        return 0;
    size_t c = *cap ? *cap : 16;
    while (c < need) {
        if (c > SIZE_MAX / 2)
            return -1;
        c *= 2;
    }
    if (size && c > SIZE_MAX / size)
        return -1;
    void *q = realloc(*p, c * size);
    if (!q)
        return -1;
    *p = q;
    *cap = c;
    return 0;
}
static row *row_new(size_t n) {
    if (n > (SIZE_MAX - sizeof(row)) / sizeof(mdb_value))
        return NULL;
    row *r = calloc(1, sizeof *r + n * sizeof(mdb_value));
    if (r)
        r->refs = 1;
    return r;
}
static void row_drop(row *r, size_t n) {
    if (!r || --r->refs)
        return;
    for (size_t i = 0; i < n; i++)
        mdb_value_clear(&r->v[i]);
    free(r);
}
static row *row_clone(const row *r, size_t n) {
    row *v = row_new(n);
    if (!v)
        return NULL;
    for (size_t i = 0; i < n; i++)
        if (mdb_value_copy(&v->v[i], &r->v[i])) {
            row_drop(v, n);
            return NULL;
        }
    return v;
}
static void overlay_clear(overlay *o, size_t ncols) {
    for (size_t i = 0; i < o->n; i++)
        row_drop(o->v[i].value, ncols);
    free(o->v);
    free(o->map.b);
    memset(o, 0, sizeof *o);
}
static int overlay_set(overlay *o, int64_t id, row *value, int deleted, int inserted,
                       size_t ncols) {
    size_t i;
    if (map_get(&o->map, id, &i)) {
        row_drop(o->v[i].value, ncols);
        o->v[i].value = value;
        o->v[i].deleted = deleted;
        return 0;
    }
    if (grow((void **)&o->v, &o->cap, o->n + 1, sizeof *o->v) || map_reserve(&o->map, o->n + 1))
        return -1;
    i = o->n++;
    o->v[i] = (change){id, value, deleted, inserted};
    map_put(&o->map, id, i);
    return 0;
}
static void view_drop(mdb_db *db, view *v, size_t table) {
    if (!v || --v->refs)
        return;
    if (v->fd >= 0)
        close(v->fd);
    mdb_bpt_free(v->index);
    for (size_t i = 0; i < v->n; i++)
        row_drop(v->rows[i], db->defs[table].ncols);
    free(v->rows);
    free(v);
}
static void snapshot_drop(mdb_db *db, snapshot *s) {
    if (!s || --s->refs)
        return;
    for (size_t i = 0; i < db->ntables; i++)
        view_drop(db, s->tables[i], i);
    free(s->tables);
    free(s);
}
static void tx_drop(mdb_db *db, transaction *tx) {
    if (!tx)
        return;
    for (size_t i = 0; i < db->ntables; i++)
        overlay_clear(&tx->tables[i], db->defs[i].ncols);
    free(tx->tables);
    snapshot_drop(db, tx->snap);
    free(tx);
}
static void fault(const char *name) {
    const char *f = getenv("MDB_FAILPOINT");
    if (f && strcmp(f, name) == 0) {
        const char *action = getenv("MDB_FAILPOINT_ACTION");
        if (action && strcmp(action, "pause") == 0) {
            /* Test parent owns termination. Handshake avoids timing-based kills. */
            const char *ready = getenv("MDB_FAILPOINT_READY_FD");
            char *end = NULL;
            if (!ready || !*ready)
                _exit(138);
            errno = 0;
            long descriptor = strtol(ready, &end, 10);
            if (errno || !end || *end || descriptor < 3 || descriptor > INT_MAX)
                _exit(138);
            ssize_t count;
            do {
                count = write((int)descriptor, "R", 1);
            } while (count < 0 && errno == EINTR);
            if (count != 1)
                _exit(138);
            for (;;)
                pause();
        }
        (void)kill(getpid(), SIGKILL);
        _exit(137);
    }
}
static int full_write(int fd, const void *data, size_t n) {
    const unsigned char *p = data;
    while (n) {
        ssize_t k = write(fd, p, n);
        if (k < 0 && errno == EINTR)
            continue;
        if (k <= 0)
            return -1;
        p += (size_t)k;
        n -= (size_t)k;
    }
    return 0;
}
static int full_pread(int fd, void *data, size_t n, uint64_t offset) {
    unsigned char *p = data;
    if (offset > (uint64_t)INT64_MAX || n > (uint64_t)INT64_MAX - offset)
        return -1;
    while (n) {
        ssize_t k = pread(fd, p, n, (off_t)offset);
        if (k < 0 && errno == EINTR)
            continue;
        if (k <= 0)
            return -1;
        p += (size_t)k;
        n -= (size_t)k;
        offset += (size_t)k;
    }
    return 0;
}
static int syncfd(int fd) {
    int k;
    do {
        k = fsync(fd);
    } while (k < 0 && errno == EINTR);
    return k;
}
static int valid_name(const char *s) {
    size_t n = strlen(s);
    if (!n || n > MDB_NAME_MAX)
        return 0;
    if (!((s[0] >= 'a' && s[0] <= 'z') || s[0] == '_'))
        return 0;
    for (size_t i = 0; i < n; i++)
        if (!((s[i] >= 'a' && s[i] <= 'z') || (s[i] >= '0' && s[i] <= '9') || s[i] == '_'))
            return 0;
    return 1;
}
static int filehash(int fd, uint64_t *hash) {
    unsigned char b[8192];
    uint64_t off = 0, h = FNV_INIT;
    for (;;) {
        ssize_t n = pread(fd, b, sizeof b, (off_t)off);
        if (n < 0 && errno == EINTR)
            continue;
        if (n < 0)
            return -1;
        if (!n)
            break;
        h = hashbytes(h, b, (size_t)n);
        off += (size_t)n;
    }
    *hash = h;
    return 0;
}
static int find_table(mdb_db *db, const char *name) {
    for (size_t i = 0; i < db->ntables; i++)
        if (strcmp(db->defs[i].name, name) == 0)
            return (int)i;
    return -1;
}
static int find_column(const tabledef *t, const char *name) {
    for (size_t i = 0; i < t->ncols; i++)
        if (strcmp(t->cols[i].name, name) == 0)
            return (int)i;
    return -1;
}
static void put32(unsigned char *p, uint32_t x) {
    for (size_t i = 0; i < 4; i++)
        p[i] = (unsigned char)(x >> (i * 8));
}
static void put64(unsigned char *p, uint64_t x) {
    for (size_t i = 0; i < 8; i++)
        p[i] = (unsigned char)(x >> (i * 8));
}
static uint32_t get32(const unsigned char *p) {
    uint32_t v = 0;
    for (size_t i = 0; i < 4; i++)
        v |= (uint32_t)p[i] << (i * 8);
    return v;
}
static uint64_t get64(const unsigned char *p) {
    uint64_t v = 0;
    for (size_t i = 0; i < 8; i++)
        v |= (uint64_t)p[i] << (i * 8);
    return v;
}
static int64_t signed64(uint64_t x) {
    if (x <= INT64_MAX)
        return (int64_t)x;
    return -1 - (int64_t)(UINT64_MAX - x);
}

/* Reader finds physical byte offsets while keeping quoted CR/LF inside a row. */
static int reader_byte(csv_reader *r, unsigned char *c) {
    if (r->pos == r->len) {
        ssize_t n;
        do {
            n = pread(r->fd, r->buf, sizeof r->buf, (off_t)r->offset);
        } while (n < 0 && errno == EINTR);
        if (n < 0)
            return -1;
        if (!n)
            return 0;
        r->len = (size_t)n;
        r->pos = 0;
    }
    *c = r->buf[r->pos++];
    r->offset++;
    return 1;
}
static int csv_record(csv_reader *r, char **out, size_t *length, uint64_t *start, mdb_error *e) {
    size_t n = 0, cap = 0;
    char *p = NULL;
    int quoted = 0;
    *start = r->offset;
    for (;;) {
        unsigned char c;
        int k = reader_byte(r, &c);
        if (k < 0) {
            free(p);
            return fail(e, MDB_IO, "CSV read failed");
        }
        if (!k) {
            if (!n) {
                free(p);
                return 0;
            }
            if (quoted) {
                free(p);
                return fail(e, MDB_CORRUPT, "Unterminated CSV quoted field");
            }
            break;
        }
        if (c == 0) {
            free(p);
            return fail(e, MDB_CORRUPT, "NUL in CSV");
        }
        if (c == '"')
            quoted = !quoted;
        if (c == '\n' && !quoted) {
            if (n && p[n - 1] == '\r')
                n--;
            break;
        }
        if (n >= CSV_RECORD_MAX) {
            free(p);
            return fail(e, MDB_CORRUPT, "CSV record exceeds limit");
        }
        if (grow((void **)&p, &cap, n + 2, 1)) {
            free(p);
            return fail(e, MDB_NOMEM, "Allocation failed");
        }
        p[n++] = (char)c;
    }
    if (!p) {
        p = malloc(1);
        if (!p)
            return fail(e, MDB_NOMEM, "Allocation failed");
    }
    p[n] = 0;
    *out = p;
    *length = n;
    return 1;
}
static int parse_integer(const char *s, int64_t *v) {
    if (!*s)
        return -1;
    const char *p = s;
    if (*p == '-')
        p++;
    if (!*p)
        return -1;
    for (; *p; p++)
        if (*p < '0' || *p > '9')
            return -1;
    errno = 0;
    char *end;
    long long k = strtoll(s, &end, 10);
    if (errno == ERANGE || *end)
        return -1;
    *v = (int64_t)k;
    return 0;
}
static row *csv_parse(const tabledef *t, const char *p, size_t n, mdb_error *e) {
    row *r = row_new(t->ncols);
    if (!r) {
        fail(e, MDB_NOMEM, "Allocation failed");
        return NULL;
    }
    size_t pos = 0;
    for (size_t col = 0; col < t->ncols; col++) {
        char value[MDB_TEXT_MAX + 32];
        size_t len = 0;
        int quoted = pos < n && p[pos] == '"';
        if (quoted)
            pos++;
        int closed = !quoted;
        while (pos < n) {
            char c = p[pos++];
            if (quoted) {
                if (c == '"') {
                    if (pos < n && p[pos] == '"') {
                        pos++;
                        c = '"';
                    } else {
                        closed = 1;
                        break;
                    }
                }
            } else if (c == ',') {
                pos--;
                break;
            } else if (c == '"' || c == '\r' || c == '\n') {
                fail(e, MDB_CORRUPT, "Invalid unquoted CSV field");
                goto bad;
            }
            if (len + 1 >= sizeof value) {
                fail(e, MDB_CORRUPT, "CSV field exceeds limit");
                goto bad;
            }
            value[len++] = c;
        }
        if (!closed) {
            fail(e, MDB_CORRUPT, "Unterminated CSV field");
            goto bad;
        }
        value[len] = 0;
        if (col + 1 < t->ncols) {
            if (pos >= n || p[pos] != ',') {
                fail(e, MDB_CORRUPT, "CSV column count mismatch");
                goto bad;
            }
            pos++;
        } else if (pos != n) {
            fail(e, MDB_CORRUPT, "CSV column count mismatch");
            goto bad;
        }
        r->v[col].type = t->cols[col].type;
        if (t->cols[col].type == MDB_INT) {
            if (parse_integer(value, &r->v[col].i)) {
                fail(e, MDB_CORRUPT, "Invalid CSV integer");
                goto bad;
            }
        } else {
            if (len > t->cols[col].max || !mdb_utf8(value, len)) {
                fail(e, MDB_CORRUPT, "Invalid CSV string");
                goto bad;
            }
            r->v[col].s = strdup(value);
            if (!r->v[col].s) {
                fail(e, MDB_NOMEM, "Allocation failed");
                goto bad;
            }
        }
    }
    return r;
bad:
    row_drop(r, t->ncols);
    return NULL;
}
static int csv_encode(const tabledef *t, const row *r, char *out, size_t cap, size_t *length) {
    size_t n = 0;
    for (size_t i = 0; i < t->ncols; i++) {
        if (i) {
            if (n >= cap)
                return -1;
            out[n++] = ',';
        }
        if (t->cols[i].type == MDB_INT) {
            char b[32];
            int k = snprintf(b, sizeof b, "%lld", (long long)r->v[i].i);
            if (k < 0 || (size_t)k >= sizeof b || n > cap - (size_t)k)
                return -1;
            memcpy(out + n, b, (size_t)k);
            n += (size_t)k;
        } else {
            const char *s = r->v[i].s;
            int quote = strpbrk(s, ",\"\r\n") != NULL;
            if (quote) {
                if (n >= cap)
                    return -1;
                out[n++] = '"';
            }
            for (; *s; s++) {
                if (n >= cap)
                    return -1;
                out[n++] = *s;
                if (*s == '"') {
                    if (n >= cap)
                        return -1;
                    out[n++] = '"';
                }
            }
            if (quote) {
                if (n >= cap)
                    return -1;
                out[n++] = '"';
            }
        }
    }
    if (n >= cap)
        return -1;
    out[n++] = '\n';
    *length = n;
    return 0;
}
static row *view_read(const tabledef *t, const view *v, uint64_t offset, mdb_error *e) {
    csv_reader r = {.fd = v->fd, .offset = offset};
    char *text = NULL;
    size_t n;
    uint64_t start;
    int k = csv_record(&r, &text, &n, &start, e);
    if (k != 1) {
        if (!k)
            fail(e, MDB_CORRUPT, "Index offset outside CSV");
        return NULL;
    }
    row *value = csv_parse(t, text, n, e);
    free(text);
    return value;
}
static int rowset_add(rowset *s, row *r, mdb_error *e) {
    size_t old;
    if (map_get(&s->map, r->v[0].i, &old))
        return fail(e, MDB_DUPLICATE, "Duplicate ID in CSV");
    if (grow((void **)&s->v, &s->cap, s->n + 1, sizeof *s->v) || map_reserve(&s->map, s->n + 1))
        return fail(e, MDB_NOMEM, "Allocation failed");
    map_put(&s->map, r->v[0].i, s->n);
    s->v[s->n++] = r;
    return 0;
}
static void rowset_clear(rowset *s, size_t ncols) {
    for (size_t i = 0; i < s->n; i++)
        row_drop(s->v[i], ncols);
    free(s->v);
    free(s->map.b);
    memset(s, 0, sizeof *s);
}
static int read_rows(int fd, const tabledef *t, rowset *s, mdb_error *e) {
    csv_reader reader = {.fd = fd};
    for (;;) {
        char *text = NULL;
        size_t n;
        uint64_t off;
        int k = csv_record(&reader, &text, &n, &off, e);
        if (k <= 0)
            return k;
        row *r = csv_parse(t, text, n, e);
        free(text);
        if (!r)
            return -1;
        if (rowset_add(s, r, e)) {
            row_drop(r, t->ncols);
            return -1;
        }
    }
}
static int defcmp(const void *a, const void *b) {
    return strcmp(((const tabledef *)a)->name, ((const tabledef *)b)->name);
}
static int load_schema(mdb_db *db, tabledef *t, mdb_error *e) {
    char name[MDB_NAME_MAX + 16];
    (void)snprintf(name, sizeof name, "%s.schema", t->name);
    int fd = openat(db->dirfd, name, O_RDONLY);
    if (fd < 0)
        return fail(e, MDB_IO, "Cannot open schema");
    struct stat schema_stat;
    if (fstat(fd, &schema_stat) || schema_stat.st_size > 65536) {
        close(fd);
        return fail(e, MDB_CORRUPT, "Schema file exceeds limit");
    }
    if (filehash(fd, &t->schemahash)) {
        close(fd);
        return fail(e, MDB_IO, "Cannot read schema");
    }
    FILE *f = fdopen(fd, "r");
    if (!f) {
        close(fd);
        return fail(e, MDB_IO, "Cannot read schema");
    }
    char *line = NULL;
    size_t cap = 0;
    int rc = -1;
    ssize_t len;
    while ((len = getline(&line, &cap, f)) >= 0) {
        if ((size_t)len > 4096) {
            fail(e, MDB_CORRUPT, "Schema line too long");
            goto done;
        }
        char *comment = strchr(line, '#');
        if (comment)
            *comment = 0;
        char *save = NULL, *col = strtok_r(line, " \t\r\n", &save);
        if (!col)
            continue;
        char *type = strtok_r(NULL, " \t\r\n", &save), *option = strtok_r(NULL, " \t\r\n", &save),
             *extra = strtok_r(NULL, " \t\r\n", &save);
        if (!type || extra || t->ncols >= MDB_COL_MAX) {
            fail(e, MDB_CORRUPT, "Invalid schema definition");
            goto done;
        }
        for (char *p = col; *p; p++)
            *p = (char)tolower((unsigned char)*p);
        for (char *p = type; *p; p++)
            *p = (char)tolower((unsigned char)*p);
        if (option)
            for (char *p = option; *p; p++)
                *p = (char)tolower((unsigned char)*p);
        if (!valid_name(col) || find_column(t, col) >= 0) {
            fail(e, MDB_CORRUPT, "Invalid or duplicate column name");
            goto done;
        }
        column *c = &t->cols[t->ncols];
        (void)snprintf(c->name, sizeof c->name, "%s", col);
        if (strcmp(type, "int") == 0)
            c->type = MDB_INT;
        else if (strncmp(type, "varchar(", 8) == 0) {
            size_t n = strlen(type);
            if (n < 10 || type[n - 1] != ')') {
                fail(e, MDB_CORRUPT, "Invalid VARCHAR size");
                goto done;
            }
            type[n - 1] = 0;
            int64_t k;
            if (parse_integer(type + 8, &k) || k < 1 || k > MDB_TEXT_MAX) {
                fail(e, MDB_CORRUPT, "Invalid VARCHAR size");
                goto done;
            }
            c->type = MDB_STRING;
            c->max = (size_t)k;
        } else {
            fail(e, MDB_CORRUPT, "Unsupported schema type");
            goto done;
        }
        if (t->ncols == 0) {
            if (strcmp(col, "id") || c->type != MDB_INT || !option || strcmp(option, "auto")) {
                fail(e, MDB_CORRUPT, "First column must be id INT AUTO");
                goto done;
            }
        } else if (option || strcmp(col, "id") == 0) {
            fail(e, MDB_CORRUPT, "Unsupported schema option");
            goto done;
        }
        t->ncols++;
    }
    if (ferror(f)) {
        fail(e, MDB_IO, "Schema read failed");
        goto done;
    }
    if (!t->ncols) {
        fail(e, MDB_CORRUPT, "Empty schema");
        goto done;
    }
    rc = 0;
done:
    free(line);
    fclose(f);
    return rc;
}
static int discover(mdb_db *db, mdb_error *e) {
    int scanfd = dup(db->dirfd);
    if (scanfd < 0)
        return fail(e, MDB_IO, "Cannot scan data directory");
    DIR *d = fdopendir(scanfd);
    if (!d) {
        close(scanfd);
        return fail(e, MDB_IO, "Cannot scan data directory");
    }
    size_t cap = 0;
    struct dirent *ent;
    int rc = -1;
    errno = 0;
    while ((ent = readdir(d))) {
        size_t n = strlen(ent->d_name);
        if (n <= 7 || strcmp(ent->d_name + n - 7, ".schema"))
            continue;
        if (n - 7 > MDB_NAME_MAX) {
            fail(e, MDB_CORRUPT, "Invalid table name");
            goto done;
        }
        char name[MDB_NAME_MAX + 1];
        memcpy(name, ent->d_name, n - 7);
        name[n - 7] = 0;
        if (!valid_name(name)) {
            fail(e, MDB_CORRUPT, "Invalid table filename");
            goto done;
        }
        if (db->ntables >= 128) {
            fail(e, MDB_LIMIT, "Maximum table count is 128");
            goto done;
        }
        if (grow((void **)&db->defs, &cap, db->ntables + 1, sizeof *db->defs)) {
            fail(e, MDB_NOMEM, "Allocation failed");
            goto done;
        }
        tabledef *t = &db->defs[db->ntables++];
        memset(t, 0, sizeof *t);
        (void)snprintf(t->name, sizeof t->name, "%s", name);
    }
    if (errno) {
        fail(e, MDB_IO, "Directory scan failed");
        goto done;
    }
    if (!db->ntables) {
        fail(e, MDB_CORRUPT, "No prepared tables");
        goto done;
    }
    qsort(db->defs, db->ntables, sizeof *db->defs, defcmp);
    for (size_t i = 0; i < db->ntables; i++)
        if (load_schema(db, &db->defs[i], e))
            goto done;
    rc = 0;
done:
    closedir(d);
    return rc;
}
static int copy_file(int source, int target) {
    unsigned char b[8192];
    uint64_t off = 0;
    for (;;) {
        ssize_t n;
        do {
            n = pread(source, b, sizeof b, (off_t)off);
        } while (n < 0 && errno == EINTR);
        if (n < 0)
            return -1;
        if (!n)
            break;
        if (full_write(target, b, (size_t)n))
            return -1;
        off += (size_t)n;
    }
    return syncfd(target);
}
static int exists_at(int fd, const char *name) {
    struct stat st;
    return fstatat(fd, name, &st, 0) == 0;
}
static int initialize(mdb_db *db, mdb_error *e) {
    if (exists_at(db->dirfd, ".mdb-base") || exists_at(db->dirfd, ".mdb-base.tmp") ||
        exists_at(db->dirfd, ".mdb.wal"))
        return fail(e, MDB_CORRUPT,
                    "Initialization incomplete: required initialization marker missing");
    if (mkdirat(db->dirfd, ".mdb-base.tmp", 0700))
        return fail(e, MDB_IO, "Cannot prepare baseline");
    int base = openat(db->dirfd, ".mdb-base.tmp", O_RDONLY | O_DIRECTORY);
    if (base < 0)
        return fail(e, MDB_IO, "Cannot open baseline");
    int manifest = openat(base, "manifest", O_CREAT | O_EXCL | O_WRONLY, 0600);
    if (manifest < 0) {
        close(base);
        return fail(e, MDB_IO, "Cannot create baseline manifest");
    }
    char line[256];
    int n = snprintf(line, sizeof line, "MDBBASE1\n%zu\n", db->ntables);
    int rc = -1;
    if (n < 0 || full_write(manifest, line, (size_t)n))
        goto io;
    for (size_t i = 0; i < db->ntables; i++) {
        tabledef *t = &db->defs[i];
        char filename[MDB_NAME_MAX + 16];
        (void)snprintf(filename, sizeof filename, "%s.csv", t->name);
        int source = openat(db->dirfd, filename, O_RDONLY);
        if (source < 0)
            goto io;
        rowset checked = {0};
        if (read_rows(source, t, &checked, e)) {
            rowset_clear(&checked, t->ncols);
            close(source);
            goto done;
        }
        rowset_clear(&checked, t->ncols);
        if (filehash(source, &t->basehash)) {
            close(source);
            goto io;
        }
        int target = openat(base, filename, O_CREAT | O_EXCL | O_WRONLY, 0600);
        if (target < 0) {
            close(source);
            goto io;
        }
        int k = copy_file(source, target);
        close(source);
        close(target);
        if (k)
            goto io;
        if (i == 0)
            fault("init_baseline");
        n = snprintf(line, sizeof line, "%s %016llx %016llx\n", t->name,
                     (unsigned long long)t->schemahash, (unsigned long long)t->basehash);
        if (n < 0 || (size_t)n >= sizeof line || full_write(manifest, line, (size_t)n))
            goto io;
    }
    if (syncfd(manifest) || syncfd(base))
        goto io;
    if (renameat(db->dirfd, ".mdb-base.tmp", db->dirfd, ".mdb-base") || syncfd(db->dirfd))
        goto io;
    int wal = openat(db->dirfd, ".mdb.wal", O_CREAT | O_EXCL | O_WRONLY, 0600);
    if (wal < 0)
        goto io;
    int k = full_write(wal, WAL_HEADER, 8) || syncfd(wal);
    close(wal);
    if (k)
        goto io;
    int marker = openat(db->dirfd, ".mdb.init.tmp", O_CREAT | O_TRUNC | O_WRONLY, 0600);
    if (marker < 0)
        goto io;
    k = full_write(marker, "MDBINIT1\n", 9) || syncfd(marker);
    close(marker);
    if (k || renameat(db->dirfd, ".mdb.init.tmp", db->dirfd, ".mdb.init") || syncfd(db->dirfd))
        goto io;
    rc = 0;
    goto done;
io:
    fail(e, MDB_IO, "Cannot persist initial database baseline");
done:
    close(manifest);
    close(base);
    return rc;
}
static int verify_baseline(mdb_db *db, mdb_error *e) {
    int marker = openat(db->dirfd, ".mdb.init", O_RDONLY);
    char check[10] = {0};
    if (marker < 0 || full_pread(marker, check, 9, 0) || strcmp(check, "MDBINIT1\n")) {
        if (marker >= 0)
            close(marker);
        return fail(e, MDB_CORRUPT, "Invalid initialization marker");
    }
    struct stat st;
    if (fstat(marker, &st) || st.st_size != 9) {
        close(marker);
        return fail(e, MDB_CORRUPT, "Invalid initialization marker");
    }
    close(marker);
    db->basefd = openat(db->dirfd, ".mdb-base", O_RDONLY | O_DIRECTORY);
    if (db->basefd < 0)
        return fail(e, MDB_CORRUPT, "Required baseline missing");
    int fd = openat(db->basefd, "manifest", O_RDONLY);
    if (fd < 0)
        return fail(e, MDB_CORRUPT, "Required baseline manifest missing");
    FILE *f = fdopen(fd, "r");
    if (!f) {
        close(fd);
        return fail(e, MDB_IO, "Cannot read baseline manifest");
    }
    char magic[32];
    size_t count;
    int rc = -1;
    if (!fgets(magic, sizeof magic, f) || strcmp(magic, "MDBBASE1\n") ||
        fscanf(f, "%zu", &count) != 1 || count != db->ntables) {
        fail(e, MDB_CORRUPT, "Baseline schema set mismatch");
        goto done;
    }
    for (size_t i = 0; i < count; i++) {
        char name[MDB_NAME_MAX + 1];
        unsigned long long sh, bh;
        if (fscanf(f, "%63s %llx %llx", name, &sh, &bh) != 3 || strcmp(name, db->defs[i].name) ||
            (uint64_t)sh != db->defs[i].schemahash) {
            fail(e, MDB_CORRUPT, "Baseline schema fingerprint mismatch");
            goto done;
        }
        db->defs[i].basehash = (uint64_t)bh;
        char path[MDB_NAME_MAX + 16];
        (void)snprintf(path, sizeof path, "%s.csv", name);
        int csv = openat(db->basefd, path, O_RDONLY);
        uint64_t hash;
        if (csv < 0 || filehash(csv, &hash) || hash != (uint64_t)bh) {
            if (csv >= 0)
                close(csv);
            fail(e, MDB_CORRUPT, "Baseline missing or checksum mismatch");
            goto done;
        }
        close(csv);
    }
    int ch;
    do {
        ch = fgetc(f);
    } while (ch != EOF && isspace((unsigned char)ch));
    if (ch != EOF || ferror(f)) {
        fail(e, MDB_CORRUPT, "Malformed baseline manifest");
        goto done;
    }
    rc = 0;
done:
    fclose(f);
    return rc;
}

/* WAL v1: 32-byte LE header: magic/type/length/payload-checksum/txid,
 * independent header-checksum and reserved zero. Checksums are low32(FNV64).
 * Header integrity is verified BEFORE trusting length or truncating a tail. */
static int wal_append(mdb_db *db, uint32_t kind, uint64_t txid, const unsigned char *payload,
                      size_t n) {
    if (n > RECORD_MAX)
        return -1;
    unsigned char h[32] = {0};
    put32(h, WAL_MAGIC);
    put32(h + 4, kind);
    put32(h + 8, (uint32_t)n);
    put32(h + 12, (uint32_t)hashbytes(FNV_INIT, payload, n));
    put64(h + 16, txid);
    put32(h + 24, (uint32_t)hashbytes(FNV_INIT, h, 24));
    if (full_write(db->walfd, h, sizeof h))
        return -1;
    const char *fp = getenv("MDB_FAILPOINT"), *io = getenv("MDB_IO_FAIL");
    if (kind == LOG_ROW &&
        ((fp && strcmp(fp, "wal_partial") == 0) || (io && strcmp(io, "wal_write") == 0))) {
        if (n)
            (void)full_write(db->walfd, payload, n / 2);
        fault("wal_partial");
        errno = EIO;
        return -1;
    }
    if (kind == LOG_APPLIED && io && strcmp(io, "applied_write") == 0) {
        errno = EIO;
        return -1;
    }
    return full_write(db->walfd, payload, n);
}
static int reserve_txid(mdb_db *db, uint64_t *id, mdb_error *e) {
    if (!db->txnext || db->txnext > INT64_MAX)
        return fail(e, MDB_LIMIT, "Transaction identifier space exhausted");
    if (db->txnext > db->txreserved) {
        uint64_t top =
            db->txnext > INT64_MAX - RESERVE_BLOCK ? INT64_MAX : db->txnext + RESERVE_BLOCK - 1;
        unsigned char p[8];
        put64(p, top);
        if (wal_append(db, LOG_TXIDS, 0, p, 8) || syncfd(db->walfd)) {
            db->healthy = 0;
            return fail(e, MDB_IO, "Transaction ID reservation outcome unknown; recovery required");
        }
        db->txreserved = top;
    }
    *id = db->txnext++;
    return 0;
}
static int reserve_id(mdb_db *db, size_t table, int64_t *id, mdb_error *e) {
    pthread_mutex_lock(&db->mutex);
    tabledef *t = &db->defs[table];
    int rc = -1;
    if (!db->healthy) {
        fail(e, MDB_IO, "Engine requires recovery");
        goto done;
    }
    if (t->next_id > (uint64_t)INT64_MAX) {
        fail(e, MDB_LIMIT, "Automatic ID space exhausted");
        goto done;
    }
    if (t->next_id > t->reserved) {
        uint64_t top = t->next_id > (uint64_t)INT64_MAX - RESERVE_BLOCK
                           ? INT64_MAX
                           : t->next_id + RESERVE_BLOCK - 1;
        unsigned char p[12];
        put32(p, (uint32_t)table);
        put64(p + 4, top);
        if (wal_append(db, LOG_RESERVE, 0, p, 12) || syncfd(db->walfd)) {
            db->healthy = 0;
            fail(e, MDB_IO, "ID reservation outcome unknown; recovery required");
            goto done;
        }
        t->reserved = top;
        fault("id_reserved");
    }
    *id = (int64_t)t->next_id++;
    rc = 0;
done:
    pthread_mutex_unlock(&db->mutex);
    return rc;
}
static int ledger_prepare(mdb_db *db) {
    return grow((void **)&db->committed, &db->capcommitted, db->ncommitted + 1,
                sizeof *db->committed);
}
static int encode_change(mdb_db *db, size_t ti, const change *c, unsigned char *p, size_t *length) {
    const tabledef *t = &db->defs[ti];
    put32(p, (uint32_t)ti);
    put32(p + 4, c->deleted ? 3U : (c->inserted ? 1U : 2U));
    put64(p + 8, (uint64_t)c->id);
    size_t n = 16;
    if (!c->deleted)
        for (size_t j = 0; j < t->ncols; j++) {
            if (t->cols[j].type == MDB_INT) {
                put64(p + n, (uint64_t)c->value->v[j].i);
                n += 8;
            } else {
                size_t k = strlen(c->value->v[j].s);
                put32(p + n, (uint32_t)k);
                n += 4;
                memcpy(p + n, c->value->v[j].s, k);
                n += k;
            }
        }
    *length = n;
    return 0;
}
static int decode_change(mdb_db *db, const unsigned char *p, size_t n, size_t *ti, change *c,
                         mdb_error *e) {
    if (n < 16)
        return fail(e, MDB_CORRUPT, "Short WAL change");
    *ti = get32(p);
    uint32_t action = get32(p + 4);
    if (*ti >= db->ntables || action < 1 || action > 3)
        return fail(e, MDB_CORRUPT, "Invalid WAL change");
    const tabledef *t = &db->defs[*ti];
    memset(c, 0, sizeof *c);
    c->id = signed64(get64(p + 8));
    c->deleted = action == 3;
    c->inserted = action == 1;
    size_t off = 16;
    if (c->deleted) {
        if (n != 16)
            return fail(e, MDB_CORRUPT, "Invalid WAL delete");
        return 0;
    }
    c->value = row_new(t->ncols);
    if (!c->value)
        return fail(e, MDB_NOMEM, "Allocation failed");
    for (size_t i = 0; i < t->ncols; i++) {
        mdb_value *v = &c->value->v[i];
        v->type = t->cols[i].type;
        if (v->type == MDB_INT) {
            if (n - off < 8)
                goto corrupt;
            v->i = signed64(get64(p + off));
            off += 8;
        } else {
            if (n - off < 4)
                goto corrupt;
            size_t k = get32(p + off);
            off += 4;
            if (k > t->cols[i].max || k > n - off || memchr(p + off, 0, k) ||
                !mdb_utf8((const char *)p + off, k))
                goto corrupt;
            v->s = malloc(k + 1);
            if (!v->s) {
                row_drop(c->value, t->ncols);
                c->value = NULL;
                return fail(e, MDB_NOMEM, "Allocation failed");
            }
            memcpy(v->s, p + off, k);
            v->s[k] = 0;
            off += k;
        }
    }
    if (off != n || c->value->v[0].i != c->id)
        goto corrupt;
    return 0;
corrupt:
    row_drop(c->value, t->ncols);
    c->value = NULL;
    return fail(e, MDB_CORRUPT, "Malformed WAL row");
}
static int replay_commit(mdb_db *db, rowset *sets, overlay *pending, mdb_error *e) {
    for (size_t ti = 0; ti < db->ntables; ti++) {
        rowset *s = &sets[ti];
        overlay *o = &pending[ti];
        for (size_t j = 0; j < o->n; j++) {
            change *c = &o->v[j];
            size_t index;
            int found = map_get(&s->map, c->id, &index) && s->v[index];
            if (c->inserted) {
                if (found || c->id < 1 || (uint64_t)c->id > db->defs[ti].reserved)
                    return fail(e, MDB_CORRUPT, "WAL insert violates reserved ID or uniqueness");
                if (grow((void **)&s->v, &s->cap, s->n + 1, sizeof *s->v) ||
                    map_reserve(&s->map, s->n + 1))
                    return fail(e, MDB_NOMEM, "Allocation failed");
                c->value->refs++;
                map_put(&s->map, c->id, s->n);
                s->v[s->n++] = c->value;
            } else {
                if (!found)
                    return fail(e, MDB_CORRUPT, "WAL update/delete references missing ID");
                row_drop(s->v[index], db->defs[ti].ncols);
                s->v[index] = c->deleted ? NULL : c->value;
                if (!c->deleted)
                    c->value->refs++;
            }
        }
    }
    return 0;
}
static int wal_replay(mdb_db *db, rowset *sets, uint64_t *version, mdb_error *e) {
    struct stat st;
    if (fstat(db->walfd, &st) || st.st_size < 8)
        return fail(e, MDB_CORRUPT, "Required WAL header missing");
    char magic[8];
    if (full_pread(db->walfd, magic, 8, 0) || memcmp(magic, WAL_HEADER, 8))
        return fail(e, MDB_CORRUPT, "Invalid WAL header");
    overlay *pending = calloc(db->ntables, sizeof *pending);
    if (!pending)
        return fail(e, MDB_NOMEM, "Allocation failed");
    uint64_t offset = 8, active = 0, count = 0, digest = FNV_INIT, beginver = 0;
    int rc = -1;
    while (offset < (uint64_t)st.st_size) {
        uint64_t remaining = (uint64_t)st.st_size - offset;
        if (remaining < 32) {
            if (ftruncate(db->walfd, (off_t)offset) || syncfd(db->walfd))
                goto io;
            break;
        }
        unsigned char h[32];
        if (full_pread(db->walfd, h, 32, offset))
            goto io;
        uint32_t kind = get32(h + 4), n = get32(h + 8), checksum = get32(h + 12);
        uint64_t txid = get64(h + 16);
        if (get32(h) != WAL_MAGIC || get32(h + 28) != 0 ||
            get32(h + 24) != (uint32_t)hashbytes(FNV_INIT, h, 24) || n > RECORD_MAX ||
            kind < LOG_RESERVE || kind > LOG_APPLIED) {
            fail(e, MDB_CORRUPT, "Invalid WAL record header");
            goto done;
        }
        if ((uint64_t)n > remaining - 32) {
            if (ftruncate(db->walfd, (off_t)offset) || syncfd(db->walfd))
                goto io;
            break;
        }
        unsigned char *p = malloc(n ? n : 1);
        if (!p) {
            fail(e, MDB_NOMEM, "Allocation failed");
            goto done;
        }
        if (n && full_pread(db->walfd, p, n, offset + 32)) {
            free(p);
            goto io;
        }
        uint64_t sum = hashbytes(FNV_INIT, p, n);
        if ((uint32_t)sum != checksum) {
            free(p);
            fail(e, MDB_CORRUPT, "WAL checksum mismatch");
            goto done;
        }
        int bad = 0;
        if (kind == LOG_RESERVE) {
            if (n != 12 || txid || get32(p) >= db->ntables)
                bad = 1;
            else {
                tabledef *t = &db->defs[get32(p)];
                uint64_t top = get64(p + 4);
                if (top < t->reserved || top > INT64_MAX)
                    bad = 1;
                else
                    t->reserved = top;
            }
        } else if (kind == LOG_TXIDS) {
            if (n != 8 || txid || get64(p) < db->txreserved || get64(p) > INT64_MAX)
                bad = 1;
            else
                db->txreserved = get64(p);
        } else if (kind == LOG_BEGIN) {
            if (n != 8 || !txid || txid > db->txreserved)
                bad = 1;
            else {
                for (size_t i = 0; i < db->ntables; i++)
                    overlay_clear(&pending[i], db->defs[i].ncols);
                active = txid;
                beginver = get64(p);
                count = 0;
                digest = FNV_INIT;
            }
        } else if (kind == LOG_ROW) {
            if (!active || txid != active)
                bad = 1;
            else {
                size_t ti;
                change c;
                if (decode_change(db, p, n, &ti, &c, e)) {
                    free(p);
                    goto done;
                }
                size_t ignored;
                if (map_get(&pending[ti].map, c.id, &ignored)) {
                    row_drop(c.value, db->defs[ti].ncols);
                    bad = 1;
                } else if (overlay_set(&pending[ti], c.id, c.value, c.deleted, c.inserted,
                                       db->defs[ti].ncols)) {
                    row_drop(c.value, db->defs[ti].ncols);
                    free(p);
                    fail(e, MDB_NOMEM, "Allocation failed");
                    goto done;
                } else {
                    count++;
                    digest = hashbytes(digest, p, n);
                }
            }
        } else if (kind == LOG_COMMIT) {
            if (n != 24 || !active || txid != active || get64(p) != count ||
                get64(p + 8) != digest || beginver != *version || *version == UINT64_MAX ||
                get64(p + 16) != *version + 1)
                bad = 1;
            else {
                if (ledger_prepare(db) || replay_commit(db, sets, pending, e)) {
                    free(p);
                    if (!e || !e->code)
                        fail(e, MDB_NOMEM, "Allocation failed");
                    goto done;
                }
                db->committed[db->ncommitted++] = txid;
                (*version)++;
                active = 0;
                for (size_t i = 0; i < db->ntables; i++)
                    overlay_clear(&pending[i], db->defs[i].ncols);
            }
        } else if (kind == LOG_APPLIED) {
            if (n || !txid)
                bad = 1;
            else {
                int found = 0;
                for (size_t i = 0; i < db->ncommitted; i++)
                    if (db->committed[i] == txid) {
                        found = 1;
                        break;
                    }
                if (!found)
                    bad = 1;
            }
        }
        free(p);
        if (bad) {
            fail(e, MDB_CORRUPT, "Inconsistent WAL transaction or reservation");
            goto done;
        }
        offset += 32 + (uint64_t)n;
    }
    db->txnext = db->txreserved + 1;
    for (size_t i = 0; i < db->ntables; i++)
        db->defs[i].next_id = db->defs[i].reserved + 1;
    rc = 0;
    goto done;
io:
    fail(e, MDB_IO, "WAL read/truncate failed");
done:
    for (size_t i = 0; i < db->ntables; i++)
        overlay_clear(&pending[i], db->defs[i].ncols);
    free(pending);
    return rc;
}
static void tempfile_name(char *out, size_t cap, const tabledef *t) {
    (void)snprintf(out, cap, ".mdb-new-%s.csv", t->name);
}
static view *build_view(mdb_db *db, size_t ti, row **rows, size_t count, mdb_error *e) {
    tabledef *t = &db->defs[ti];
    view *v = calloc(1, sizeof *v);
    if (!v) {
        fail(e, MDB_NOMEM, "Allocation failed");
        return NULL;
    }
    v->refs = 1;
    v->fd = -1;
    char filename[MDB_NAME_MAX + 32];
    tempfile_name(filename, sizeof filename, t);
    v->fd = openat(db->dirfd, filename, O_CREAT | O_TRUNC | O_RDWR, 0600);
    if (v->fd < 0) {
        fail(e, MDB_IO, "Cannot create replacement CSV");
        goto bad;
    }
    if (count > SIZE_MAX / sizeof(row *) || count > SIZE_MAX / sizeof(uint64_t)) {
        fail(e, MDB_LIMIT, "Table exceeds memory limits");
        goto bad;
    }
    v->rows = malloc((count ? count : 1) * sizeof *v->rows);
    int64_t *keys = malloc((count ? count : 1) * sizeof *keys);
    uint64_t *offsets = malloc((count ? count : 1) * sizeof *offsets);
    if (!v->rows || !keys || !offsets) {
        free(keys);
        free(offsets);
        fail(e, MDB_NOMEM, "Allocation failed");
        goto bad;
    }
    uint64_t offset = 0;
    double csv_started = seconds();
    char buffer[CSV_RECORD_MAX];
    for (size_t j = 0; j < count; j++) {
        size_t len;
        if (csv_encode(t, rows[j], buffer, sizeof buffer, &len)) {
            free(keys);
            free(offsets);
            fail(e, MDB_IO, "CSV encoding failed");
            goto bad;
        }
        const char *io = getenv("MDB_IO_FAIL");
        if (!db->recovering && io && strcmp(io, "csv_write") == 0) {
            (void)full_write(v->fd, buffer, len / 2);
            free(keys);
            free(offsets);
            fail(e, MDB_IO, "Injected replacement CSV write failure");
            goto bad;
        }
        if (offset > (uint64_t)INT64_MAX - len || full_write(v->fd, buffer, len)) {
            free(keys);
            free(offsets);
            fail(e, MDB_IO, "Replacement CSV write failed");
            goto bad;
        }
        keys[j] = rows[j]->v[0].i;
        offsets[j] = offset;
        offset += len;
        v->rows[v->n++] = rows[j];
        rows[j]->refs++;
    }
    double index_started = seconds();
    db->metrics.csv_write_s += index_started - csv_started;
    db->metrics.csv_bytes += offset;
    v->index = mdb_bpt_bulk(keys, offsets, count);
    free(keys);
    free(offsets);
    if (!v->index) {
        fail(e, MDB_NOMEM, "Cannot build replacement index");
        goto bad;
    }
    if (mdb_bpt_validate(v->index)) {
        fail(e, MDB_CORRUPT, "Replacement index validation failed");
        goto bad;
    }
    double sync_started = seconds();
    db->metrics.index_build_s += sync_started - index_started;
    if (syncfd(v->fd)) {
        fail(e, MDB_IO, "Replacement CSV synchronization failed");
        goto bad;
    }
    db->metrics.csv_write_s += seconds() - sync_started;
    return v;
bad:
    view_drop(db, v, ti);
    (void)unlinkat(db->dirfd, filename, 0);
    return NULL;
}
static int install_view(mdb_db *db, size_t ti) {
    char temp[MDB_NAME_MAX + 32], target[MDB_NAME_MAX + 16];
    tempfile_name(temp, sizeof temp, &db->defs[ti]);
    (void)snprintf(target, sizeof target, "%s.csv", db->defs[ti].name);
    return renameat(db->dirfd, temp, db->dirfd, target);
}
static int recover(mdb_db *db, mdb_error *e) {
    double recovery_started = seconds();
    db->recovering = 1;
    rowset *sets = calloc(db->ntables, sizeof *sets);
    snapshot *s = calloc(1, sizeof *s);
    if (!sets || !s) {
        free(sets);
        free(s);
        return fail(e, MDB_NOMEM, "Allocation failed");
    }
    s->refs = 1;
    s->tables = calloc(db->ntables, sizeof *s->tables);
    int rc = -1;
    if (!s->tables) {
        fail(e, MDB_NOMEM, "Allocation failed");
        goto done;
    }
    for (size_t i = 0; i < db->ntables; i++) {
        char name[MDB_NAME_MAX + 16];
        (void)snprintf(name, sizeof name, "%s.csv", db->defs[i].name);
        int fd = openat(db->basefd, name, O_RDONLY);
        if (fd < 0) {
            fail(e, MDB_CORRUPT, "Required baseline CSV missing");
            goto done;
        }
        int k = read_rows(fd, &db->defs[i], &sets[i], e);
        close(fd);
        if (k)
            goto done;
        uint64_t high = 0;
        for (size_t j = 0; j < sets[i].n; j++)
            if (sets[i].v[j]->v[0].i > 0 && (uint64_t)sets[i].v[j]->v[0].i > high)
                high = (uint64_t)sets[i].v[j]->v[0].i;
        db->defs[i].reserved = high;
    }
    if (wal_replay(db, sets, &s->version, e))
        goto done;
    for (size_t i = 0; i < db->ntables; i++) {
        size_t n = 0;
        for (size_t j = 0; j < sets[i].n; j++)
            if (sets[i].v[j])
                sets[i].v[n++] = sets[i].v[j];
        sets[i].n = n;
        s->tables[i] = build_view(db, i, sets[i].v, n, e);
        if (!s->tables[i])
            goto done;
        if (i == 0)
            fault("recovery_write");
    }
    for (size_t i = 0; i < db->ntables; i++)
        if (install_view(db, i)) {
            fail(e, MDB_IO, "Recovery CSV replacement failed");
            goto done;
        }
    if (syncfd(db->dirfd)) {
        fail(e, MDB_IO, "Recovery directory synchronization failed");
        goto done;
    }
    db->current = s;
    s = NULL;
    db->recovering = 0;
    db->metrics.recovery_s = seconds() - recovery_started;
    rc = 0;
done:
    for (size_t i = 0; i < db->ntables; i++)
        rowset_clear(&sets[i], db->defs[i].ncols);
    free(sets);
    if (s) {
        if (s->tables)
            snapshot_drop(db, s);
        else
            free(s);
    }
    return rc;
}

static int configured_limit(const char *name, size_t fallback, size_t *out, mdb_error *e) {
    const char *s = getenv(name);
    if (!s) {
        *out = fallback;
        return 0;
    }
    int64_t v;
    if (parse_integer(s, &v) || v < 1 || (uint64_t)v > SIZE_MAX)
        return fail(e, MDB_LIMIT, "Invalid configured resource limit");
    *out = (size_t)v;
    return 0;
}
mdb_db *mdb_open(const char *directory, mdb_error *e) {
    if (e)
        memset(e, 0, sizeof *e);
    mdb_db *db = calloc(1, sizeof *db);
    if (!db) {
        fail(e, MDB_NOMEM, "Allocation failed");
        return NULL;
    }
    db->dirfd = db->basefd = db->lockfd = db->walfd = -1;
    db->healthy = 1;
    db->txnext = 1;
    if (configured_limit("MDB_MAX_SESSIONS", 256, &db->max_sessions, e) ||
        configured_limit("MDB_TX_MAX_CHANGES", 2000000, &db->max_changes, e) ||
        configured_limit("MDB_MAX_SORT_ROWS", 1000000, &db->max_sort_rows, e))
        goto bad;
    if (pthread_mutex_init(&db->mutex, NULL)) {
        fail(e, MDB_IO, "Mutex initialization failed");
        goto bad;
    }
    db->mutex_ready = 1;
    db->dirfd = open(directory, O_RDONLY | O_DIRECTORY);
    if (db->dirfd < 0) {
        fail(e, MDB_IO, "Cannot open data directory");
        goto bad;
    }
    db->lockfd = openat(db->dirfd, ".mdb.lock", O_CREAT | O_RDWR, 0600);
    if (db->lockfd < 0 || flock(db->lockfd, LOCK_EX | LOCK_NB)) {
        fail(e, MDB_BUSY, "Data directory is owned by another DBMS process");
        goto bad;
    }
    if (discover(db, e))
        goto bad;
    if (!exists_at(db->dirfd, ".mdb.init") && initialize(db, e))
        goto bad;
    if (verify_baseline(db, e))
        goto bad;
    db->walfd = openat(db->dirfd, ".mdb.wal", O_RDWR | O_APPEND);
    if (db->walfd < 0) {
        fail(e, MDB_CORRUPT, "Required WAL missing");
        goto bad;
    }
    if (recover(db, e))
        goto bad;
    return db;
bad:
    mdb_close(db);
    return NULL;
}
void mdb_close(mdb_db *db) {
    if (!db)
        return;
    snapshot_drop(db, db->current);
    if (db->walfd >= 0)
        close(db->walfd);
    if (db->basefd >= 0)
        close(db->basefd);
    if (db->lockfd >= 0)
        close(db->lockfd);
    if (db->dirfd >= 0)
        close(db->dirfd);
    if (db->mutex_ready)
        pthread_mutex_destroy(&db->mutex);
    free(db->committed);
    free(db->defs);
    free(db);
}
mdb_session *mdb_session_open(mdb_db *db, mdb_error *e) {
    if (!db) {
        fail(e, MDB_STATE, "Invalid engine");
        return NULL;
    }
    mdb_session *s = calloc(1, sizeof *s);
    if (!s) {
        fail(e, MDB_NOMEM, "Allocation failed");
        return NULL;
    }
    pthread_mutex_lock(&db->mutex);
    if (db->nsessions >= db->max_sessions) {
        pthread_mutex_unlock(&db->mutex);
        free(s);
        fail(e, MDB_LIMIT, "Session resource limit reached");
        return NULL;
    }
    db->nsessions++;
    pthread_mutex_unlock(&db->mutex);
    s->db = db;
    return s;
}
void mdb_session_close(mdb_session *s) {
    if (!s)
        return;
    pthread_mutex_lock(&s->db->mutex);
    tx_drop(s->db, s->tx);
    s->db->nsessions--;
    pthread_mutex_unlock(&s->db->mutex);
    free(s);
}
#ifdef MDB_TESTING
void mdb_test_read_hook(mdb_db *db, void (*fn)(void *), void *context) {
    pthread_mutex_lock(&db->mutex);
    db->read_hook = fn;
    db->read_hook_context = context;
    pthread_mutex_unlock(&db->mutex);
}
#endif
int mdb_healthy(mdb_db *db) {
    pthread_mutex_lock(&db->mutex);
    int v = db->healthy;
    pthread_mutex_unlock(&db->mutex);
    return v;
}
int mdb_transaction_status(mdb_db *db, uint64_t id) {
    pthread_mutex_lock(&db->mutex);
    int found = 0;
    for (size_t i = 0; i < db->ncommitted; i++)
        if (db->committed[i] == id) {
            found = 1;
            break;
        }
    pthread_mutex_unlock(&db->mutex);
    return found;
}
static transaction *tx_begin(mdb_db *db, int need_id, mdb_error *e) {
    transaction *tx = calloc(1, sizeof *tx);
    if (!tx) {
        fail(e, MDB_NOMEM, "Allocation failed");
        return NULL;
    }
    tx->tables = calloc(db->ntables, sizeof *tx->tables);
    if (!tx->tables) {
        free(tx);
        fail(e, MDB_NOMEM, "Allocation failed");
        return NULL;
    }
    pthread_mutex_lock(&db->mutex);
    if (!db->healthy) {
        fail(e, MDB_IO, "Engine requires recovery");
        goto bad;
    }
    if (need_id && reserve_txid(db, &tx->id, e))
        goto bad;
    tx->snap = db->current;
    tx->snap->refs++;
    pthread_mutex_unlock(&db->mutex);
    return tx;
bad:
    pthread_mutex_unlock(&db->mutex);
    free(tx->tables);
    free(tx);
    return NULL;
}
static int value_valid(const column *c, const mdb_value *v, mdb_error *e) {
    if (c->type != v->type)
        return fail(e, MDB_TYPE, "Value type mismatch");
    if (v->type == MDB_STRING) {
        size_t n = strlen(v->s);
        if (n > c->max)
            return fail(e, MDB_TOO_LONG, "VARCHAR value exceeds byte limit");
        if (!mdb_utf8(v->s, n))
            return fail(e, MDB_TYPE, "Invalid UTF-8 string");
    }
    return 0;
}
static int operand_type(const tabledef *t, const mdb_operand *o, mdb_type *type, mdb_error *e) {
    if (o->is_column) {
        int i = find_column(t, o->column);
        if (i < 0)
            return fail(e, MDB_UNKNOWN_COLUMN, "Unknown column");
        *type = t->cols[i].type;
    } else {
        *type = o->value.type;
        if (*type == MDB_STRING && !mdb_utf8(o->value.s, strlen(o->value.s)))
            return fail(e, MDB_TYPE, "Invalid UTF-8 string");
    }
    return 0;
}
static int expr_valid(const tabledef *t, const mdb_expr *x, mdb_error *e) {
    if (!x)
        return 0;
    if (x->kind == MDB_AND || x->kind == MDB_OR) {
        if (expr_valid(t, x->left, e))
            return -1;
        return expr_valid(t, x->right, e);
    }
    mdb_type a = MDB_INT, b = MDB_INT;
    if (operand_type(t, &x->a, &a, e) || operand_type(t, &x->b, &b, e))
        return -1;
    if (a != b)
        return fail(e, MDB_TYPE, "Comparison type mismatch");
    return 0;
}
static const mdb_value *operand_value(const tabledef *t, const mdb_operand *o, const row *r) {
    return o->is_column ? &r->v[find_column(t, o->column)] : &o->value;
}
static int value_cmp(const mdb_value *a, const mdb_value *b) {
    if (a->type == MDB_INT)
        return (a->i > b->i) - (a->i < b->i);
    int c = strcmp(a->s, b->s);
    return (c > 0) - (c < 0);
}
static int expr_eval(const tabledef *t, const mdb_expr *x, const row *r) {
    if (!x)
        return 1;
    if (x->kind == MDB_AND)
        return expr_eval(t, x->left, r) && expr_eval(t, x->right, r);
    if (x->kind == MDB_OR)
        return expr_eval(t, x->left, r) || expr_eval(t, x->right, r);
    int c = value_cmp(operand_value(t, &x->a, r), operand_value(t, &x->b, r));
    switch (x->cmp) {
    case MDB_EQ:
        return c == 0;
    case MDB_NE:
        return c != 0;
    case MDB_LT:
        return c < 0;
    case MDB_LE:
        return c <= 0;
    case MDB_GT:
        return c > 0;
    case MDB_GE:
        return c >= 0;
    }
    return 0;
}
static int tx_set(mdb_db *db, transaction *tx, size_t ti, int64_t id, row *value, int deleted,
                  int inserted, mdb_error *e) {
    size_t ignored;
    int existing = map_get(&tx->tables[ti].map, id, &ignored);
    if (!existing && tx->nchanges >= db->max_changes)
        return fail(e, MDB_LIMIT, "Transaction change workspace limit reached");
    if (overlay_set(&tx->tables[ti], id, value, deleted, inserted, db->defs[ti].ncols))
        return fail(e, MDB_NOMEM, "Allocation failed");
    if (!existing)
        tx->nchanges++;
    return 0;
}
static int execute_insert(mdb_db *db, transaction *tx, size_t ti, const mdb_stmt *st,
                          mdb_result *out) {
    tabledef *t = &db->defs[ti];
    int positions[MDB_COL_MAX];
    memset(positions, -1, sizeof positions);
    if (st->nvalues != t->ncols - 1)
        return fail(&out->error, MDB_COLUMN_COUNT, "INSERT requires every nonautomatic column");
    if (st->ncolumns) {
        if (st->ncolumns != st->nvalues)
            return fail(&out->error, MDB_COLUMN_COUNT, "INSERT column/value count mismatch");
        for (size_t i = 0; i < st->ncolumns; i++) {
            int col = find_column(t, st->columns[i]);
            if (col < 0)
                return fail(&out->error, MDB_UNKNOWN_COLUMN, "Unknown column");
            if (col == 0)
                return fail(&out->error, MDB_TYPE, "Automatic id cannot be assigned");
            if (positions[col] >= 0)
                return fail(&out->error, MDB_COLUMN_COUNT, "Duplicate INSERT column");
            positions[col] = (int)i;
        }
    } else
        for (size_t i = 1; i < t->ncols; i++)
            positions[i] = (int)i - 1;
    for (size_t i = 1; i < t->ncols; i++) {
        if (positions[i] < 0)
            return fail(&out->error, MDB_COLUMN_COUNT, "Missing INSERT column");
        if (value_valid(&t->cols[i], &st->values[positions[i]], &out->error))
            return -1;
    }
    row *r = row_new(t->ncols);
    if (!r)
        return fail(&out->error, MDB_NOMEM, "Allocation failed");
    r->v[0].type = MDB_INT;
    for (size_t i = 1; i < t->ncols; i++)
        if (mdb_value_copy(&r->v[i], &st->values[positions[i]])) {
            row_drop(r, t->ncols);
            return fail(&out->error, MDB_NOMEM, "Allocation failed");
        }
    int64_t id;
    if (reserve_id(db, ti, &id, &out->error)) {
        row_drop(r, t->ncols);
        return -1;
    }
    r->v[0].i = id;
    if (tx_set(db, tx, ti, id, r, 0, 1, &out->error)) {
        row_drop(r, t->ncols);
        return -1;
    }
    tx->writes = 1;
    out->affected = 1;
    out->inserted_id = id;
    out->has_inserted_id = 1;
    return 0;
}
static int execute_changes(mdb_db *db, transaction *tx, size_t ti, const mdb_stmt *st,
                           mdb_result *out) {
    tabledef *t = &db->defs[ti];
    if (expr_valid(t, st->where, &out->error))
        return -1;
    int positions[MDB_COL_MAX];
    if (st->nupdates > MDB_COL_MAX)
        return fail(&out->error, MDB_LIMIT, "Too many assignments");
    for (size_t j = 0; j < st->nupdates; j++) {
        int k = find_column(t, st->updates[j].column);
        if (k < 0)
            return fail(&out->error, MDB_UNKNOWN_COLUMN, "Unknown UPDATE column");
        if (k == 0)
            return fail(&out->error, MDB_TYPE, "Automatic id cannot be modified");
        for (size_t i = 0; i < j; i++)
            if (positions[i] == k)
                return fail(&out->error, MDB_COLUMN_COUNT, "Duplicate UPDATE column");
        positions[j] = k;
        if (value_valid(&t->cols[k], &st->updates[j].value, &out->error))
            return -1;
    }
    overlay *o = &tx->tables[ti];
    view *v = tx->snap->tables[ti];
    size_t original_changes =
        o->n; /* Existing rows retain their physical scan position; inserted rows follow. */
    for (size_t phase = 0; phase < 2; phase++) {
        size_t count = phase ? original_changes : v->n;
        for (size_t i = 0; i < count; i++) {
            row *base;
            int inserted = 0;
            int64_t id;
            if (phase) {
                if (!o->v[i].inserted || o->v[i].deleted)
                    continue;
                base = o->v[i].value;
                id = o->v[i].id;
                inserted = 1;
            } else {
                base = v->rows[i];
                id = base->v[0].i;
                size_t j;
                if (map_get(&o->map, id, &j)) {
                    if (o->v[j].deleted)
                        continue;
                    base = o->v[j].value;
                }
            }
            if (!expr_eval(t, st->where, base))
                continue;
            row *changed = NULL;
            int deleted = st->kind == MDB_DELETE;
            if (!deleted) {
                changed = row_clone(base, t->ncols);
                if (!changed)
                    return fail(&out->error, MDB_NOMEM, "Allocation failed");
                for (size_t j = 0; j < st->nupdates; j++) {
                    int col = positions[j];
                    mdb_value_clear(&changed->v[col]);
                    if (mdb_value_copy(&changed->v[col], &st->updates[j].value)) {
                        row_drop(changed, t->ncols);
                        return fail(&out->error, MDB_NOMEM, "Allocation failed");
                    }
                }
            }
            if (tx_set(db, tx, ti, id, changed, deleted, inserted, &out->error)) {
                row_drop(changed, t->ncols);
                return -1;
            }
            out->affected++;
            tx->writes = 1;
        }
    }
    return 0;
}
typedef struct {
    row **rows;
    size_t n, cap;
    uint64_t count;
    const tabledef *table;
    const mdb_stmt *stmt;
    mdb_error *error;
    size_t max_sort_rows;
} selection;
/* Takes ownership of r. Return 1 when an unordered LIMIT has been satisfied. */
static int select_visit(selection *s, row *r) {
    if (!expr_eval(s->table, s->stmt->where, r)) {
        row_drop(r, s->table->ncols);
        return 0;
    }
    if (s->count == UINT64_MAX) {
        row_drop(r, s->table->ncols);
        return fail(s->error, MDB_LIMIT, "COUNT overflow");
    }
    s->count++;
    if (s->stmt->count) {
        row_drop(r, s->table->ncols);
        return 0;
    }
    if (!s->stmt->norder && s->stmt->limit >= 0 && s->n >= (uint64_t)s->stmt->limit) {
        row_drop(r, s->table->ncols);
        return 1;
    }
    if (s->stmt->limit < 0 && s->n >= MDB_RESULT_MAX) {
        row_drop(r, s->table->ncols);
        return fail(s->error, MDB_LIMIT, "Result exceeds 10000 rows; use LIMIT");
    }
    if (s->stmt->norder && s->n >= s->max_sort_rows) {
        row_drop(r, s->table->ncols);
        return fail(s->error, MDB_LIMIT, "ORDER BY workspace limit reached");
    }
    if (grow((void **)&s->rows, &s->cap, s->n + 1, sizeof *s->rows)) {
        row_drop(r, s->table->ncols);
        return fail(s->error, MDB_NOMEM, "Allocation failed");
    }
    s->rows[s->n++] = r;
    return 0;
}
static int sort_compare(const selection *s, const row *a, const row *b) {
    for (size_t i = 0; i < s->stmt->norder; i++) {
        int col = find_column(s->table, s->stmt->order[i].column);
        int c = value_cmp(&a->v[col], &b->v[col]);
        if (c)
            return s->stmt->order[i].descending ? -c : c;
    }
    return 0;
}
static int stable_sort(selection *s) {
    if (s->n < 2)
        return 0;
    row **temp = malloc(s->n * sizeof *temp);
    if (!temp)
        return fail(s->error, MDB_NOMEM, "Allocation failed");
    for (size_t width = 1; width < s->n;) {
        for (size_t start = 0; start < s->n; start += 2 * width) {
            size_t mid = start + width < s->n ? start + width : s->n,
                   end = mid + width < s->n ? mid + width : s->n, a = start, b = mid, k = start;
            while (a < mid && b < end)
                temp[k++] =
                    sort_compare(s, s->rows[a], s->rows[b]) <= 0 ? s->rows[a++] : s->rows[b++];
            while (a < mid)
                temp[k++] = s->rows[a++];
            while (b < end)
                temp[k++] = s->rows[b++];
        }
        memcpy(s->rows, temp, s->n * sizeof *temp);
        if (width > s->n / 2)
            break;
        width *= 2;
    }
    free(temp);
    return 0;
}
static int result_columns(mdb_result *out, const tabledef *t, const mdb_stmt *st, int *positions) {
    out->ncolumns = st->count ? 1 : (st->star ? t->ncols : st->ncolumns);
    out->columns = calloc(out->ncolumns, sizeof *out->columns);
    out->types = calloc(out->ncolumns, sizeof *out->types);
    if (!out->columns || !out->types)
        return fail(&out->error, MDB_NOMEM, "Allocation failed");
    for (size_t i = 0; i < out->ncolumns; i++) {
        if (st->count) {
            out->columns[i] = strdup("count");
            out->types[i] = MDB_INT;
            positions[i] = 0;
        } else {
            int col = st->star ? (int)i : find_column(t, st->columns[i]);
            if (col < 0)
                return fail(&out->error, MDB_UNKNOWN_COLUMN, "Unknown SELECT column");
            positions[i] = col;
            out->columns[i] = strdup(t->cols[col].name);
            out->types[i] = t->cols[col].type;
        }
        if (!out->columns[i])
            return fail(&out->error, MDB_NOMEM, "Allocation failed");
    }
    return 0;
}
static int execute_select(mdb_db *db, transaction *tx, size_t ti, const mdb_stmt *st,
                          mdb_result *out) {
#ifdef MDB_TESTING
    void (*hook)(void *);
    void *hook_context;
    pthread_mutex_lock(&db->mutex);
    hook = db->read_hook;
    hook_context = db->read_hook_context;
    pthread_mutex_unlock(&db->mutex);
    if (hook)
        hook(hook_context);
#endif
    if (st->limit > MDB_RESULT_MAX)
        return fail(&out->error, MDB_LIMIT, "LIMIT exceeds maximum result rows (10000)");
    tabledef *t = &db->defs[ti];
    if (expr_valid(t, st->where, &out->error))
        return -1;
    for (size_t i = 0; i < st->norder; i++)
        if (find_column(t, st->order[i].column) < 0)
            return fail(&out->error, MDB_UNKNOWN_COLUMN, "Unknown ORDER BY column");
    int positions[MDB_COL_MAX] = {0};
    if (result_columns(out, t, st, positions))
        return -1;
    selection found = {
        .table = t, .stmt = st, .error = &out->error, .max_sort_rows = db->max_sort_rows};
    overlay *o = &tx->tables[ti];
    view *v = tx->snap->tables[ti];
    int rc = -1;
    int64_t id;
    const char *force = getenv("MDB_FORCE_SCAN");
    int indexed = !(force && strcmp(force, "0")) && mdb_expr_id(st->where, &id);
    out->used_index = indexed;
    if (st->limit == 0 && !st->count) {
        rc = 0;
        goto done;
    }
    if (indexed) {
        uint64_t offset; /* Always execute the real tree search, including for own inserted rows. */
        int exists = mdb_bpt_search(v->index, id, &offset);
        row *r = NULL;
        if (exists) {
            r = view_read(t, v, offset, &out->error);
            if (!r)
                goto done;
            if (r->v[0].i != id) {
                row_drop(r, t->ncols);
                fail(&out->error, MDB_CORRUPT, "Index/CSV key mismatch");
                goto done;
            }
        }
        size_t j;
        if (map_get(&o->map, id, &j)) {
            row_drop(r, t->ncols);
            r = NULL;
            if (!o->v[j].deleted) {
                r = row_clone(o->v[j].value, t->ncols);
                if (!r) {
                    fail(&out->error, MDB_NOMEM, "Allocation failed");
                    goto done;
                }
            }
        }
        if (r && select_visit(&found, r) < 0)
            goto done;
    } else {
        csv_reader reader = {.fd = v->fd};
        int stop = 0;
        for (;;) {
            char *text = NULL;
            size_t len;
            uint64_t offset;
            int k = csv_record(&reader, &text, &len, &offset, &out->error);
            if (k < 0)
                goto done;
            if (!k)
                break;
            row *r = csv_parse(t, text, len, &out->error);
            free(text);
            if (!r)
                goto done;
            size_t j;
            if (map_get(&o->map, r->v[0].i, &j)) {
                row_drop(r, t->ncols);
                r = NULL;
                if (!o->v[j].deleted) {
                    r = row_clone(o->v[j].value, t->ncols);
                    if (!r) {
                        fail(&out->error, MDB_NOMEM, "Allocation failed");
                        goto done;
                    }
                }
            }
            if (r) {
                k = select_visit(&found, r);
                if (k < 0)
                    goto done;
                if (k > 0) {
                    stop = 1;
                    break;
                }
            }
        }
        if (!stop)
            for (size_t j = 0; j < o->n; j++)
                if (o->v[j].inserted && !o->v[j].deleted) {
                    row *r = row_clone(o->v[j].value, t->ncols);
                    if (!r) {
                        fail(&out->error, MDB_NOMEM, "Allocation failed");
                        goto done;
                    }
                    int k = select_visit(&found, r);
                    if (k < 0)
                        goto done;
                    if (k > 0)
                        break;
                }
    }
    if (st->count) {
        if (found.count > INT64_MAX) {
            fail(&out->error, MDB_LIMIT, "COUNT exceeds int64 range");
            goto done;
        }
        if (st->limit != 0) {
            out->rows = calloc(1, sizeof *out->rows);
            if (!out->rows) {
                fail(&out->error, MDB_NOMEM, "Allocation failed");
                goto done;
            }
            out->nrows = 1;
            out->rows[0].values = calloc(1, sizeof(mdb_value));
            if (!out->rows[0].values) {
                fail(&out->error, MDB_NOMEM, "Allocation failed");
                goto done;
            }
            out->rows[0].values[0] = (mdb_value){.type = MDB_INT, .i = (int64_t)found.count};
        }
    } else {
        if (st->norder && stable_sort(&found))
            goto done;
        size_t count = found.n;
        if (st->limit >= 0 && (uint64_t)st->limit < count)
            count = (size_t)st->limit;
        if (count > MDB_RESULT_MAX) {
            fail(&out->error, MDB_LIMIT, "Result exceeds 10000 rows; use LIMIT");
            goto done;
        }
        out->rows = calloc(count ? count : 1, sizeof *out->rows);
        if (!out->rows) {
            fail(&out->error, MDB_NOMEM, "Allocation failed");
            goto done;
        }
        out->nrows = count;
        for (size_t i = 0; i < count; i++) {
            out->rows[i].values = calloc(out->ncolumns, sizeof(mdb_value));
            if (!out->rows[i].values) {
                fail(&out->error, MDB_NOMEM, "Allocation failed");
                goto done;
            }
            for (size_t j = 0; j < out->ncolumns; j++)
                if (mdb_value_copy(&out->rows[i].values[j], &found.rows[i]->v[positions[j]])) {
                    fail(&out->error, MDB_NOMEM, "Allocation failed");
                    goto done;
                }
        }
    }
    rc = 0;
done:
    for (size_t i = 0; i < found.n; i++)
        row_drop(found.rows[i], t->ncols);
    free(found.rows);
    return rc;
}
static snapshot *prepare_commit(mdb_db *db, transaction *tx, mdb_error *e) {
    snapshot *s = calloc(1, sizeof *s);
    if (!s) {
        fail(e, MDB_NOMEM, "Allocation failed");
        return NULL;
    }
    s->refs = 1;
    s->version = db->current->version + 1;
    s->tables = calloc(db->ntables, sizeof *s->tables);
    if (!s->tables) {
        free(s);
        fail(e, MDB_NOMEM, "Allocation failed");
        return NULL;
    }
    for (size_t ti = 0; ti < db->ntables; ti++) {
        overlay *o = &tx->tables[ti];
        view *old = tx->snap->tables[ti];
        if (!o->n) {
            s->tables[ti] = old;
            old->refs++;
            continue;
        }
        if (o->n > SIZE_MAX - old->n || (old->n + o->n) > SIZE_MAX / sizeof(row *)) {
            fail(e, MDB_LIMIT, "Table size overflow");
            goto bad;
        }
        row **rows = malloc((old->n + o->n + 1) * sizeof *rows);
        if (!rows) {
            fail(e, MDB_NOMEM, "Allocation failed");
            goto bad;
        }
        size_t count = 0;
        for (size_t j = 0; j < old->n; j++) {
            size_t k;
            if (map_get(&o->map, old->rows[j]->v[0].i, &k)) {
                if (!o->v[k].deleted)
                    rows[count++] = o->v[k].value;
            } else
                rows[count++] = old->rows[j];
        }
        for (size_t j = 0; j < o->n; j++)
            if (o->v[j].inserted && !o->v[j].deleted)
                rows[count++] = o->v[j].value;
        s->tables[ti] = build_view(db, ti, rows, count, e);
        free(rows);
        if (!s->tables[ti])
            goto bad;
    }
    return s;
bad:
    snapshot_drop(db, s);
    for (size_t i = 0; i < db->ntables; i++)
        if (tx->tables[i].n) {
            char temp[MDB_NAME_MAX + 32];
            tempfile_name(temp, sizeof temp, &db->defs[i]);
            (void)unlinkat(db->dirfd, temp, 0);
        }
    return NULL;
}
static int commit_tx(mdb_db *db, transaction *tx, mdb_result *out) {
    pthread_mutex_lock(&db->mutex);
    snapshot *next = NULL;
    int rc = -1;
    out->txid = tx->id;
    if (!db->healthy) {
        fail(&out->error, MDB_IO, "Engine requires recovery");
        goto done;
    }
    if (!tx->writes) {
        out->commit = MDB_NO_CHANGES;
        rc = 0;
        goto done;
    }
    if (tx->snap->version != db->current->version) {
        fail(&out->error, MDB_CONFLICT,
             "Commit version changed; ROLLBACK and retry from latest state");
        goto done;
    }
    if (db->current->version == UINT64_MAX) {
        fail(&out->error, MDB_LIMIT, "Commit version exhausted");
        goto done;
    }
    if (ledger_prepare(db)) {
        fail(&out->error, MDB_NOMEM, "Allocation failed");
        goto done;
    }
    next = prepare_commit(db, tx, &out->error);
    if (!next)
        goto done;
    unsigned char begin[8];
    put64(begin, tx->snap->version);
    if (wal_append(db, LOG_BEGIN, tx->id, begin, 8))
        goto unknown;
    uint64_t count = 0, digest = FNV_INIT;
    unsigned char record[CSV_RECORD_MAX + 128];
    for (size_t ti = 0; ti < db->ntables; ti++)
        for (size_t j = 0; j < tx->tables[ti].n; j++) {
            change *c = &tx->tables[ti].v[j];
            if (c->inserted && c->deleted)
                continue;
            size_t n;
            encode_change(db, ti, c, record, &n);
            if (wal_append(db, LOG_ROW, tx->id, record, n))
                goto unknown;
            count++;
            digest = hashbytes(digest, record, n);
        }
    unsigned char commit[24];
    put64(commit, count);
    put64(commit + 8, digest);
    put64(commit + 16, next->version);
    if (wal_append(db, LOG_COMMIT, tx->id, commit, sizeof commit))
        goto unknown;
    fault("before_commit_sync");
    const char *io = getenv("MDB_IO_FAIL");
    double wal_started = seconds();
    if ((io && strcmp(io, "wal_fsync") == 0) || syncfd(db->walfd))
        goto unknown;
    db->metrics.wal_sync_s += seconds() - wal_started;
    out->commit = MDB_DURABLE;
    db->committed[db->ncommitted++] = tx->id;
    fault("after_commit_sync");
    for (size_t ti = 0; ti < db->ntables; ti++)
        if (tx->tables[ti].n) {
            if (install_view(db, ti))
                goto durable_failure;
            fault("after_csv_rename");
        }
    if (syncfd(db->dirfd))
        goto durable_failure;
    snapshot *old = db->current;
    db->current = next;
    next = NULL;
    snapshot_drop(db, old);
    fault("before_applied");
    wal_started = seconds();
    if (wal_append(db, LOG_APPLIED, tx->id, NULL, 0) || syncfd(db->walfd))
        goto durable_failure;
    db->metrics.wal_sync_s += seconds() - wal_started;
    rc = 0;
    goto done;
unknown:
    out->commit = MDB_UNKNOWN;
    db->healthy = 0;
    out->recovery_required = 1;
    fail(&out->error, MDB_IO, "Commit outcome unknown; restart to recover before further SQL");
    goto done;
durable_failure:
    out->commit = MDB_DURABLE;
    db->healthy = 0;
    out->recovery_required = 1;
    fail(&out->error, MDB_IO,
         "Commit is durable; CSV/completion needs recovery before further SQL");
done:
    if (next)
        snapshot_drop(db, next);
    if (rc)
        for (size_t i = 0; i < db->ntables; i++)
            if (tx->tables[i].n) {
                char temp[MDB_NAME_MAX + 32];
                tempfile_name(temp, sizeof temp, &db->defs[i]);
                (void)unlinkat(db->dirfd, temp, 0);
            }
    pthread_mutex_unlock(&db->mutex);
    return rc;
}
static void clear_result_data(mdb_result *out) {
    mdb_result saved = *out;
    mdb_result_free(out);
    out->error = saved.error;
    out->commit = saved.commit;
    out->txid = saved.txid;
    out->recovery_required = saved.recovery_required;
    out->staged = saved.staged;
    out->used_index = saved.used_index;
    (void)snprintf(out->state, sizeof out->state, "%s", saved.state);
}
int mdb_execute(mdb_session *session, const char *sql, mdb_result *out) {
    if (!out)
        return -1;
    memset(out, 0, sizeof *out);
    out->commit = MDB_NOT_COMMITTED;
    (void)snprintf(out->state, sizeof out->state, "IDLE");
    if (!session || !sql)
        return fail(&out->error, MDB_STATE, "Invalid execution context");
    mdb_db *db = session->db;
    mdb_stmt *st = NULL;
    int rc = -1, implicit = 0;
    if (mdb_parse(sql, &st, &out->error)) {
        if (session->tx)
            session->tx->failed = 1;
        goto finish;
    }
    if (session->tx && session->tx->failed && st->kind != MDB_ROLLBACK) {
        fail(&out->error, MDB_FAILED, "Transaction is FAILED; ROLLBACK required");
        goto finish;
    }
    if (st->kind == MDB_ROLLBACK) {
        if (!session->tx) {
            fail(&out->error, MDB_STATE, "No active transaction");
            goto finish;
        }
        pthread_mutex_lock(&db->mutex);
        tx_drop(db, session->tx);
        session->tx = NULL;
        pthread_mutex_unlock(&db->mutex);
        (void)snprintf(out->state, sizeof out->state, "ROLLED_BACK");
        rc = 0;
        goto finish;
    }
    if (!mdb_healthy(db)) {
        out->recovery_required = 1;
        fail(&out->error, MDB_IO, "Engine requires recovery before SQL processing");
        goto finish;
    }
    if (st->kind == MDB_BEGIN) {
        if (session->tx) {
            session->tx->failed = 1;
            fail(&out->error, MDB_STATE, "Nested BEGIN is not supported");
            goto finish;
        }
        session->tx = tx_begin(db, 1, &out->error);
        if (!session->tx)
            goto finish;
        out->txid = session->tx->id;
        (void)snprintf(out->state, sizeof out->state, "ACTIVE");
        rc = 0;
        goto finish;
    }
    if (st->kind == MDB_COMMIT) {
        if (!session->tx) {
            fail(&out->error, MDB_STATE, "No active transaction");
            goto finish;
        }
        rc = commit_tx(db, session->tx, out);
        if (!rc || out->commit != MDB_NOT_COMMITTED) {
            pthread_mutex_lock(&db->mutex);
            tx_drop(db, session->tx);
            session->tx = NULL;
            pthread_mutex_unlock(&db->mutex);
            (void)snprintf(out->state, sizeof out->state, !rc ? "COMMITTED" : "RECOVERY_REQUIRED");
        } else
            session->tx->failed = 1;
        goto finish;
    }
    if (!session->tx) {
        session->tx = tx_begin(db, st->kind != MDB_SELECT, &out->error);
        if (!session->tx)
            goto finish;
        implicit = 1;
    }
    transaction *tx = session->tx;
    out->txid = tx->id;
    int ti = find_table(db, st->table);
    if (ti < 0) {
        fail(&out->error, MDB_UNKNOWN_TABLE, "Unknown table");
        goto execution_done;
    }
    if (st->kind == MDB_SELECT)
        rc = execute_select(db, tx, (size_t)ti, st, out);
    else if (st->kind == MDB_INSERT)
        rc = execute_insert(db, tx, (size_t)ti, st, out);
    else if (st->kind == MDB_UPDATE || st->kind == MDB_DELETE)
        rc = execute_changes(db, tx, (size_t)ti, st, out);
    else
        fail(&out->error, MDB_SYNTAX, "Unsupported SQL operation");
execution_done:
    if (!rc && implicit && st->kind != MDB_SELECT)
        rc = commit_tx(db, tx, out);
    if (implicit) {
        pthread_mutex_lock(&db->mutex);
        tx_drop(db, session->tx);
        session->tx = NULL;
        pthread_mutex_unlock(&db->mutex);
        if (out->commit != MDB_NOT_COMMITTED)
            (void)snprintf(out->state, sizeof out->state, rc ? "RECOVERY_REQUIRED" : "COMMITTED");
    } else if (rc)
        tx->failed = 1;
    else if (st->kind != MDB_SELECT) {
        out->staged = 1;
        (void)snprintf(out->state, sizeof out->state, "STAGED");
    }
finish:
    if (session->tx) {
        out->txid = session->tx->id;
        if (session->tx->failed)
            (void)snprintf(out->state, sizeof out->state, "FAILED");
        else if (!out->staged)
            (void)snprintf(out->state, sizeof out->state, "ACTIVE");
    }
    if (!mdb_healthy(db)) {
        out->recovery_required = 1;
        if (rc && out->commit == MDB_NOT_COMMITTED && out->error.code == MDB_IO)
            out->commit = MDB_UNKNOWN;
    }
    if (rc)
        clear_result_data(out);
    mdb_stmt_free(st);
    return rc;
}

void mdb_get_metrics(mdb_db *db, mdb_metrics *out) {
    if (!db || !out)
        return;
    pthread_mutex_lock(&db->mutex);
    *out = db->metrics;
    pthread_mutex_unlock(&db->mutex);
}
