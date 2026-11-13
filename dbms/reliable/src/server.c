#define _POSIX_C_SOURCE 200809L
#include "mdb.h"
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define HEADER_MAX 16384u
#define BODY_MAX 65536u
#define SESSION_MAX 256
#define TOKEN_LEN 64
#ifndef SESSION_TTL
#define SESSION_TTL 300
#endif
#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif
/* Only signal communication is process-global; engine and request state is owned. */
static volatile sig_atomic_t stop_requested;
static void on_signal(int signo) {
    (void)signo;
    stop_requested = 1;
}
static double now_seconds(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t))
        return 0;
    return (double)t.tv_sec + (double)t.tv_nsec / 1e9;
}
#ifdef MDB_TESTING
/* Deterministic worker/queue tests only. Production binaries contain no gate. */
static int test_gate_path(char *out, size_t capacity, const char *suffix) {
    const char *prefix = getenv("MDB_TEST_JOB_GATE");
    if (!prefix || !*prefix)
        return -1;
    int n = snprintf(out, capacity, "%s.%s", prefix, suffix);
    return n < 0 || (size_t)n >= capacity ? -1 : 0;
}
static void test_gate_marker(const char *suffix) {
    char path[1024];
    if (test_gate_path(path, sizeof path, suffix))
        return;
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd >= 0)
        close(fd);
}
static void test_job_gate(void) {
    char release[1024];
    if (test_gate_path(release, sizeof release, "release"))
        return;
    test_gate_marker("entered");
    double deadline = now_seconds() + 10.0;
    while (access(release, F_OK) != 0 && now_seconds() < deadline) {
        struct timespec pause = {0, 10000000};
        while (nanosleep(&pause, &pause) && errno == EINTR) {
        }
    }
}
#endif
typedef struct {
    mdb_session *engine;
    char token[TOKEN_LEN + 1];
    int used, busy;
    double touched;
} session_slot;
typedef enum { JOB_QUERY, JOB_CREATE, JOB_CLOSE, JOB_HEALTH } job_kind;
typedef struct job {
    struct job *next;
    job_kind kind;
    int connection, session, status;
    uint64_t generation;
    char *sql, *json;
    char fallback[1024], operation[64];
    session_slot *slot;
    unsigned worker_id;
    double elapsed;
} job;
typedef struct {
    pthread_mutex_t mutex;
    pthread_cond_t ready;
    job *head, *tail, *done_head, *done_tail;
    size_t count, capacity;
    int stopping, wake_write;
    unsigned next_worker;
    mdb_db *db;
} pool;
typedef struct {
    int fd, state;
    uint64_t generation;
    char *input, *output;
    size_t received, header_length, body_length, sent, output_length;
    int parsed;
    double deadline;
    char method[16], path[256], auth[1100], content_type[128];
} connection;
typedef struct {
    pool workers;
    connection *connections;
    session_slot sessions[SESSION_MAX];
    int maxconn;
    const char *token;
    int timeout;
} server;

static char *duplicate(const char *s) {
    size_t n = strlen(s) + 1;
    char *v = malloc(n);
    if (v)
        memcpy(v, s, n);
    return v;
}
static int status_for(mdb_code c) {
    switch (c) {
    case MDB_OK:
        return 200;
    case MDB_UNKNOWN_TABLE:
        return 404;
    case MDB_DUPLICATE:
    case MDB_CONFLICT:
    case MDB_FAILED:
    case MDB_BUSY:
    case MDB_STATE:
        return 409;
    case MDB_LIMIT:
    case MDB_TOO_LONG:
        return 413;
    case MDB_IO:
    case MDB_NOMEM:
    case MDB_CORRUPT:
        return 500;
    default:
        return 400;
    }
}
static char *error_json(mdb_code code, const char *message) {
    mdb_result r;
    memset(&r, 0, sizeof r);
    r.error.code = code;
    snprintf(r.error.message, sizeof r.error.message, "%s", message);
    return mdb_result_json(&r);
}
static void *worker(void *arg) {
    pool *p = arg;
    pthread_mutex_lock(&p->mutex);
    unsigned worker_id = p->next_worker++;
    pthread_mutex_unlock(&p->mutex);
    for (;;) {
        pthread_mutex_lock(&p->mutex);
        while (!p->head && !p->stopping)
            pthread_cond_wait(&p->ready, &p->mutex);
        if (!p->head && p->stopping) {
            pthread_mutex_unlock(&p->mutex);
            return NULL;
        }
        job *j = p->head;
        p->head = j->next;
        if (!p->head)
            p->tail = NULL;
        p->count--;
        pthread_mutex_unlock(&p->mutex);
        j->next = NULL;
        j->status = 200;
        j->worker_id = worker_id;
        double started = now_seconds();
#ifdef MDB_TESTING
        if (j->kind == JOB_QUERY)
            test_job_gate();
#endif
        if (j->kind == JOB_CREATE) {
            mdb_error e;
            memset(&e, 0, sizeof e);
            j->slot->engine = mdb_session_open(p->db, &e);
            if (j->slot->engine) {
                snprintf(j->fallback, sizeof j->fallback, "{\"ok\":true,\"session\":\"%s\"}",
                         j->slot->token);
                j->json = duplicate(j->fallback);
                j->status = 201;
            } else {
                j->status = status_for(e.code);
                j->json = error_json(e.code, "Cannot create session");
            }
        } else if (j->kind == JOB_CLOSE) {
            mdb_session_close(j->slot->engine);
            j->slot->engine = NULL;
            j->json = duplicate("{\"ok\":true}");
        } else if (j->kind == JOB_HEALTH) {
            int healthy = mdb_healthy(p->db);
            j->status = healthy ? 200 : 503;
            j->json =
                duplicate(healthy ? "{\"ok\":true}" : "{\"ok\":false,\"recovery_required\":true}");
        } else {
            mdb_result r;
            memset(&r, 0, sizeof r);
            mdb_session *s = j->slot ? j->slot->engine : NULL;
            mdb_stmt *stmt = NULL;
            if (!s) {
                if (mdb_parse(j->sql, &stmt, &r.error))
                    goto query_done;
                if (stmt->kind == MDB_BEGIN || stmt->kind == MDB_COMMIT ||
                    stmt->kind == MDB_ROLLBACK) {
                    r.error.code = MDB_STATE;
                    snprintf(r.error.message, sizeof r.error.message,
                             "Transaction commands require an explicit session");
                    goto query_done;
                }
                s = mdb_session_open(p->db, &r.error);
                if (!s)
                    goto query_done;
            }
            (void)mdb_execute(s, j->sql, &r);
        query_done:
            mdb_stmt_free(stmt);
            if (!j->slot && s)
                mdb_session_close(s);
            j->status = status_for(r.error.code);
            if (j->status == 500)
                snprintf(r.error.message, sizeof r.error.message,
                         "Database operation failed; inspect server diagnostics");
            j->json = mdb_result_json(&r);
            if (!j->json) {
                j->status = 500;
                snprintf(j->fallback, sizeof j->fallback,
                         "{\"ok\":false,\"error\":{\"code\":\"ERR_NOMEM\",\"message\":\"Response "
                         "serialization failed\"},\"commit\":\"%s\",\"txid\":\"%" PRIu64
                         "\",\"recovery_required\":%s}",
                         r.commit == MDB_DURABLE      ? "DURABLE"
                         : r.commit == MDB_UNKNOWN    ? "UNKNOWN"
                         : r.commit == MDB_NO_CHANGES ? "NO_CHANGES"
                                                      : "NOT_COMMITTED",
                         r.txid, r.recovery_required ? "true" : "false");
            }
            mdb_result_free(&r);
        }
        free(j->sql);
        j->sql = NULL;
        j->elapsed = now_seconds() - started;
        if (!j->json && !j->fallback[0]) {
            j->status = 500;
            snprintf(j->fallback, sizeof j->fallback,
                     "{\"ok\":false,\"error\":{\"code\":\"ERR_NOMEM\",\"message\":\"Response "
                     "allocation failed\"}}");
        }
        pthread_mutex_lock(&p->mutex);
        if (p->done_tail)
            p->done_tail->next = j;
        else
            p->done_head = j;
        p->done_tail = j;
        pthread_mutex_unlock(&p->mutex);
        unsigned char byte = 1;
        ssize_t ignored = write(p->wake_write, &byte, 1);
        (void)ignored;
    }
}
static int enqueue(pool *p, job *j) {
    pthread_mutex_lock(&p->mutex);
    if (p->stopping || p->count >= p->capacity) {
        pthread_mutex_unlock(&p->mutex);
        return -1;
    }
    j->next = NULL;
    if (p->tail)
        p->tail->next = j;
    else
        p->head = j;
    p->tail = j;
    p->count++;
#ifdef MDB_TESTING
    if (j->kind == JOB_QUERY)
        test_gate_marker("queued");
#endif
    pthread_cond_signal(&p->ready);
    pthread_mutex_unlock(&p->mutex);
    return 0;
}
static const char *reason(int status) {
    switch (status) {
    case 200:
        return "OK";
    case 201:
        return "Created";
    case 400:
        return "Bad Request";
    case 401:
        return "Unauthorized";
    case 404:
        return "Not Found";
    case 405:
        return "Method Not Allowed";
    case 408:
        return "Request Timeout";
    case 409:
        return "Conflict";
    case 411:
        return "Length Required";
    case 413:
        return "Content Too Large";
    case 415:
        return "Unsupported Media Type";
    case 417:
        return "Expectation Failed";
    case 431:
        return "Request Header Fields Too Large";
    case 501:
        return "Not Implemented";
    case 503:
        return "Service Unavailable";
    default:
        return "Internal Server Error";
    }
}
static void disconnect(connection *c) {
    if (c->fd >= 0)
        close(c->fd);
    free(c->input);
    free(c->output);
    c->input = c->output = NULL;
    c->fd = -1;
    c->state = 0;
}
static void respond(connection *c, int status, const char *body, int timeout) {
    if (!body)
        body = "{\"ok\":false}";
    size_t len = strlen(body);
    char header[512];
    int n = snprintf(header, sizeof header,
                     "HTTP/1.1 %d %s\r\nContent-Type: application/json; "
                     "charset=utf-8\r\nContent-Length: %zu\r\nConnection: close\r\nCache-Control: "
                     "no-store\r\nX-Content-Type-Options: nosniff\r\n\r\n",
                     status, reason(status), len);
    if (n < 0 || (size_t)n >= sizeof header || len > SIZE_MAX - (size_t)n - 1) {
        disconnect(c);
        return;
    }
    c->output = malloc((size_t)n + len + 1);
    if (!c->output) {
        disconnect(c);
        return;
    }
    memcpy(c->output, header, (size_t)n);
    memcpy(c->output + n, body, len + 1);
    c->output_length = (size_t)n + len;
    c->sent = 0;
    c->state = 3;
    c->deadline = now_seconds() + timeout;
    free(c->input);
    c->input = NULL;
}
static void reject(connection *c, int status, const char *message, int timeout) {
    char *body = error_json(status == 503 ? MDB_BUSY : MDB_SYNTAX, message);
    respond(c, status, body, timeout);
    free(body);
}
static char *trim(char *s) {
    while (*s == ' ' || *s == '\t')
        s++;
    size_t n = strlen(s);
    while (n && (s[n - 1] == ' ' || s[n - 1] == '\t'))
        s[--n] = 0;
    return s;
}
static size_t header_end(const char *s, size_t n) {
    for (size_t i = 3; i < n; i++)
        if (s[i - 3] == '\r' && s[i - 2] == '\n' && s[i - 1] == '\r' && s[i] == '\n')
            return i + 1;
    return 0;
}
/* Returns HTTP failure status, zero once complete, -1 when more input is needed. */
static int parse_headers(connection *c) {
    size_t end = header_end(c->input, c->received);
    if (!end)
        return c->received >= HEADER_MAX ? 431 : -1;
    if (end > HEADER_MAX)
        return 431;
    if (memchr(c->input, 0, end))
        return 400;
    char copy[HEADER_MAX + 1];
    memcpy(copy, c->input, end);
    copy[end] = 0;
    char *line_end = strstr(copy, "\r\n");
    if (!line_end)
        return 400;
    *line_end = 0;
    char *a = strchr(copy, ' ');
    if (!a)
        return 400;
    *a++ = 0;
    char *b = strchr(a, ' ');
    if (!b)
        return 400;
    *b++ = 0;
    if (strcmp(b, "HTTP/1.1") || strlen(copy) >= sizeof c->method || strlen(a) >= sizeof c->path ||
        a[0] != '/')
        return 400;
    for (char *x = copy; *x; x++)
        if (*x < 'A' || *x > 'Z')
            return 400;
    for (char *x = a; *x; x++)
        if ((unsigned char)*x <= 32 || (unsigned char)*x >= 127)
            return 400;
    snprintf(c->method, sizeof c->method, "%s", copy);
    snprintf(c->path, sizeof c->path, "%s", a);
    char *line = line_end + 2;
    int count = 0, has_length = 0, has_host = 0, has_auth = 0, has_type = 0;
    while (*line) {
        line_end = strstr(line, "\r\n");
        if (!line_end)
            return 400;
        *line_end = 0;
        if (!*line)
            break;
        if (++count > 64 || line[0] == ' ' || line[0] == '\t')
            return 431;
        char *colon = strchr(line, ':');
        if (!colon)
            return 400;
        *colon++ = 0;
        if (!*line)
            return 400;
        for (char *x = line; *x; x++)
            if (!((*x >= 'a' && *x <= 'z') || (*x >= 'A' && *x <= 'Z') ||
                  (*x >= '0' && *x <= '9') || strchr("!#$%&'*+-.^_`|~", *x)))
                return 400;
        char *value = trim(colon);
        for (char *x = value; *x; x++)
            if (((unsigned char)*x < 32 && *x != '\t') || (unsigned char)*x == 127)
                return 400;
        if (!strcasecmp(line, "Content-Length")) {
            if (has_length++ || !*value)
                return 400;
            size_t length = 0;
            for (char *x = value; *x; x++) {
                if (*x < '0' || *x > '9')
                    return 400;
                if (length > (BODY_MAX - (size_t)(*x - '0')) / 10)
                    return 413;
                length = length * 10 + (size_t)(*x - '0');
            }
            c->body_length = length;
        } else if (!strcasecmp(line, "Transfer-Encoding"))
            return 501;
        else if (!strcasecmp(line, "Expect"))
            return 417;
        else if (!strcasecmp(line, "Host")) {
            if (has_host++ || !*value)
                return 400;
        } else if (!strcasecmp(line, "Authorization")) {
            if (has_auth++ || strlen(value) >= sizeof c->auth)
                return 400;
            snprintf(c->auth, sizeof c->auth, "%s", value);
        } else if (!strcasecmp(line, "Content-Type")) {
            if (has_type++ || strlen(value) >= sizeof c->content_type)
                return 400;
            snprintf(c->content_type, sizeof c->content_type, "%s", value);
        }
        line = line_end + 2;
    }
    if (!has_host)
        return 400;
    if (!strcmp(c->method, "POST") && !has_length)
        return 411;
    c->header_length = end;
    c->parsed = 1;
    return 0;
}
static int authenticated(const char *auth, const char *token) {
    if (strncmp(auth, "Bearer ", 7))
        return 0;
    auth += 7;
    size_t a = strlen(auth), b = strlen(token), n = a > b ? a : b;
    unsigned diff = (unsigned)(a ^ b);
    for (size_t i = 0; i < n; i++)
        diff |= (unsigned)((i < a ? (unsigned char)auth[i] : 0) ^
                           (i < b ? (unsigned char)token[i] : 0));
    return diff == 0;
}
static int random_token(char out[TOKEN_LEN + 1]) {
    unsigned char bytes[TOKEN_LEN / 2];
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd < 0)
        return -1;
    size_t done = 0;
    while (done < sizeof bytes) {
        ssize_t n = read(fd, bytes + done, sizeof bytes - done);
        if (n < 0 && errno == EINTR)
            continue;
        if (n <= 0) {
            close(fd);
            return -1;
        }
        done += (size_t)n;
    }
    close(fd);
    const char *digits = "0123456789abcdef";
    for (size_t i = 0; i < sizeof bytes; i++) {
        out[2 * i] = digits[bytes[i] >> 4];
        out[2 * i + 1] = digits[bytes[i] & 15];
    }
    out[TOKEN_LEN] = 0;
    return 0;
}
static int find_session(server *s, const char *token) {
    for (int i = 0; i < SESSION_MAX; i++)
        if (s->sessions[i].used && !strcmp(s->sessions[i].token, token))
            return i;
    return -1;
}
static void route(server *s, int index) {
    connection *c = &s->connections[index];
    int session = -1;
    job_kind kind = JOB_QUERY;
    if (!strcmp(c->method, "GET") && !strcmp(c->path, "/health"))
        kind = JOB_HEALTH;
    else {
        if (!authenticated(c->auth, s->token)) {
            reject(c, 401, "Authentication required", s->timeout);
            return;
        }
        if (strcmp(c->method, "POST") && strcmp(c->method, "DELETE")) {
            reject(c, 405, "Unsupported method", s->timeout);
            return;
        }
        if (!strcmp(c->path, "/query") && !strcmp(c->method, "POST"))
            kind = JOB_QUERY;
        else if (!strcmp(c->path, "/sessions") && !strcmp(c->method, "POST")) {
            kind = JOB_CREATE;
            for (int i = 0; i < SESSION_MAX; i++)
                if (!s->sessions[i].used) {
                    session = i;
                    break;
                }
            if (session < 0) {
                reject(c, 503, "Session capacity reached", s->timeout);
                return;
            }
            if (random_token(s->sessions[session].token)) {
                reject(c, 500, "Session token generation failed", s->timeout);
                return;
            }
        } else if (!strncmp(c->path, "/sessions/", 10)) {
            const char *rest = c->path + 10;
            size_t n = strlen(rest);
            char token[TOKEN_LEN + 1];
            if (n < TOKEN_LEN) {
                reject(c, 404, "Unknown session", s->timeout);
                return;
            }
            memcpy(token, rest, TOKEN_LEN);
            token[TOKEN_LEN] = 0;
            if (n == TOKEN_LEN && !strcmp(c->method, "DELETE"))
                kind = JOB_CLOSE;
            else if (n == TOKEN_LEN + 6 && !strcmp(rest + TOKEN_LEN, "/query") &&
                     !strcmp(c->method, "POST"))
                kind = JOB_QUERY;
            else {
                reject(c, 404, "Unknown endpoint", s->timeout);
                return;
            }
            session = find_session(s, token);
            if (session < 0) {
                reject(c, 404, "Unknown session", s->timeout);
                return;
            }
            if (s->sessions[session].busy) {
                reject(c, 409, "Session already has an active request", s->timeout);
                return;
            }
        } else {
            reject(c, 404, "Unknown endpoint", s->timeout);
            return;
        }
    }
    if (kind != JOB_QUERY && c->body_length) {
        reject(c, 400, "This endpoint requires an empty body", s->timeout);
        return;
    }
    char *sql = NULL;
    if (kind == JOB_QUERY) {
        if (strncasecmp(c->content_type, "application/json", 16) ||
            (c->content_type[16] && c->content_type[16] != ';' && c->content_type[16] != ' ')) {
            reject(c, 415, "Expected application/json", s->timeout);
            return;
        }
        mdb_error error;
        if (mdb_query_json(c->input + c->header_length, c->body_length, &sql, &error)) {
            reject(c, status_for(error.code), error.message, s->timeout);
            return;
        }
    }
    job *j = calloc(1, sizeof *j);
    if (!j) {
        free(sql);
        reject(c, 500, "Allocation failed", s->timeout);
        return;
    }
    j->kind = kind;
    j->connection = index;
    j->generation = c->generation;
    j->session = session;
    j->sql = sql;
    const char *endpoint = session >= 0 ? (kind == JOB_CREATE  ? "/sessions"
                                           : kind == JOB_CLOSE ? "/sessions/:token"
                                                               : "/sessions/:token/query")
                                        : c->path;
    snprintf(j->operation, sizeof j->operation, "%s %.42s", c->method, endpoint);
    if (session >= 0) {
        j->slot = &s->sessions[session];
        j->slot->used = 1;
        j->slot->busy = 1;
        j->slot->touched = now_seconds();
    }
    if (enqueue(&s->workers, j)) {
        if (j->slot) {
            j->slot->busy = 0;
            if (kind == JOB_CREATE)
                j->slot->used = 0;
        }
        free(sql);
        free(j);
        reject(c, 503, "SQL queue is full; request was not executed", s->timeout);
        return;
    }
    c->state = 2;
    free(c->input);
    c->input = NULL;
}
static void completions(server *s) {
    pool *p = &s->workers;
    pthread_mutex_lock(&p->mutex);
    job *j = p->done_head;
    p->done_head = p->done_tail = NULL;
    pthread_mutex_unlock(&p->mutex);
    while (j) {
        job *next = j->next;
        char logline[256];
        int loglen = snprintf(logline, sizeof logline,
                              "request worker=%u operation=%s status=%d engine_ms=%.3f\n",
                              j->worker_id, j->operation, j->status, j->elapsed * 1000.0);
        if (loglen > 0 && (size_t)loglen < sizeof logline) {
            ssize_t ignored = write(STDERR_FILENO, logline, (size_t)loglen);
            (void)ignored;
        }
        if (j->slot) {
            j->slot->busy = 0;
            j->slot->touched = now_seconds();
            if (j->kind == JOB_CLOSE || (j->kind == JOB_CREATE && !j->slot->engine)) {
                j->slot->used = 0;
                j->slot->token[0] = 0;
            }
        }
        if (j->connection >= 0) {
            connection *c = &s->connections[j->connection];
            if (c->fd >= 0 && c->generation == j->generation && c->state == 2)
                respond(c, j->status, j->json ? j->json : j->fallback, s->timeout);
        }
        free(j->json);
        free(j);
        j = next;
    }
}
static void expire_sessions(server *s, double now) {
    for (int i = 0; i < SESSION_MAX; i++)
        if (s->sessions[i].used && !s->sessions[i].busy &&
            now - s->sessions[i].touched > SESSION_TTL) {
            job *j = calloc(1, sizeof *j);
            if (!j)
                return;
            j->kind = JOB_CLOSE;
            j->connection = -1;
            j->session = i;
            j->slot = &s->sessions[i];
            j->slot->busy = 1;
            if (enqueue(&s->workers, j)) {
                j->slot->busy = 0;
                free(j);
                return;
            }
        }
}
static int nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL);
    return flags < 0 ? -1 : fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}
static int number(const char *s, int low, int high) {
    char *end;
    errno = 0;
    long n = strtol(s, &end, 10);
    if (errno || !*s || *end || n < low || n > high)
        return -1;
    return (int)n;
}
int main(int argc, char **argv) {
    const char *directory = "./data", *bind_address = "127.0.0.1", *auth = getenv("MINIDB_TOKEN");
    int port = 8080, threads = 4, queue = 128, maxconn = 128, timeout = 15;
    for (int i = 1; i < argc; i++) {
        if (i + 1 >= argc) {
            fprintf(stderr, "Missing server option value\n");
            return 2;
        }
        const char *option = argv[i], *value = argv[++i];
        if (!strcmp(option, "--data-dir"))
            directory = value;
        else if (!strcmp(option, "--bind"))
            bind_address = value;
        else if (!strcmp(option, "--port"))
            port = number(value, 1, 65535);
        else if (!strcmp(option, "--threads"))
            threads = number(value, 1, 128);
        else if (!strcmp(option, "--queue"))
            queue = number(value, 1, 65536);
        else if (!strcmp(option, "--max-conn"))
            maxconn = number(value, 1, 4096);
        else if (!strcmp(option, "--read-timeout"))
            timeout = number(value, 1, 300);
        else {
            fprintf(stderr, "Unknown server option\n");
            return 2;
        }
    }
    if (port < 0 || threads < 0 || queue < 0 || maxconn < 0 || timeout < 0) {
        fprintf(stderr, "Invalid server option\n");
        return 2;
    }
    if (!auth || !*auth || strlen(auth) > 1024) {
        fprintf(stderr, "MINIDB_TOKEN must contain 1..1024 bytes\n");
        return 2;
    }
    struct sockaddr_in address;
    memset(&address, 0, sizeof address);
    address.sin_family = AF_INET;
    address.sin_port = htons((uint16_t)port);
    if (inet_pton(AF_INET, bind_address, &address.sin_addr) != 1) {
        fprintf(stderr, "Invalid IPv4 bind address\n");
        return 2;
    }
    if (strcmp(bind_address, "127.0.0.1"))
        fprintf(stderr, "Warning: external binding requires a trusted TLS proxy or SSH tunnel\n");
    mdb_error error;
    mdb_db *db = mdb_open(directory, &error);
    if (!db) {
        fprintf(stderr, "%s: %s\n", mdb_code_name(error.code), error.message);
        return 1;
    }
    int listener = socket(AF_INET, SOCK_STREAM, 0), wake[2] = {-1, -1}, one = 1;
    if (listener < 0 || pipe(wake)) {
        fprintf(stderr, "Network initialization failed\n");
        if (listener >= 0)
            close(listener);
        mdb_close(db);
        return 1;
    }
    if (setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one) || nonblocking(listener) ||
        nonblocking(wake[0]) || nonblocking(wake[1]) ||
        bind(listener, (struct sockaddr *)&address, sizeof address) || listen(listener, 128)) {
        fprintf(stderr, "Cannot start listening socket\n");
        close(listener);
        close(wake[0]);
        close(wake[1]);
        mdb_close(db);
        return 1;
    }
    struct sigaction action;
    memset(&action, 0, sizeof action);
    action.sa_handler = on_signal;
    sigemptyset(&action.sa_mask);
    sigaction(SIGINT, &action, NULL);
    sigaction(SIGTERM, &action, NULL);
    signal(SIGPIPE, SIG_IGN);
    server s;
    memset(&s, 0, sizeof s);
    s.maxconn = maxconn;
    s.token = auth;
    s.timeout = timeout;
    s.connections = calloc((size_t)maxconn, sizeof *s.connections);
    pthread_t *workers = calloc((size_t)threads, sizeof *workers);
    struct pollfd *polls = calloc((size_t)maxconn + 2, sizeof *polls);
    if (!s.connections || !workers || !polls) {
        fprintf(stderr, "Allocation failed\n");
        free(s.connections);
        free(workers);
        free(polls);
        close(listener);
        close(wake[0]);
        close(wake[1]);
        mdb_close(db);
        return 1;
    }
    for (int i = 0; i < maxconn; i++)
        s.connections[i].fd = -1;
    pool *p = &s.workers;
    p->capacity = (size_t)queue;
    p->db = db;
    p->wake_write = wake[1];
    int mutex_ok = pthread_mutex_init(&p->mutex, NULL) == 0, cond_ok = 0;
    if (mutex_ok)
        cond_ok = pthread_cond_init(&p->ready, NULL) == 0;
    int started = 0;
    if (cond_ok)
        for (; started < threads; started++)
            if (pthread_create(&workers[started], NULL, worker, p))
                break;
    if (started != threads)
        stop_requested = 1;
    fprintf(stderr, "mini-db-server listening on %s:%d (%d SQL workers)\n", bind_address, port,
            started);
    int shutting = 0;
    double shutdown_deadline = 0;
    for (;;) {
        if (stop_requested && !shutting) {
            shutting = 1;
            shutdown_deadline = now_seconds() + timeout;
            close(listener);
            listener = -1;
            for (int i = 0; i < maxconn; i++)
                if (s.connections[i].fd >= 0 && s.connections[i].state == 1)
                    reject(&s.connections[i], 503,
                           "Server is shutting down; request was not executed", timeout);
        }
        polls[0] = (struct pollfd){listener, POLLIN, 0};
        polls[1] = (struct pollfd){wake[0], POLLIN, 0};
        int active = 0;
        for (int i = 0; i < maxconn; i++) {
            connection *c = &s.connections[i];
            if (c->fd >= 0)
                active++;
            polls[i + 2] = (struct pollfd){c->fd,
                                           c->state == 1   ? POLLIN
                                           : c->state == 3 ? POLLOUT
                                                           : 0,
                                           0};
        }
        if (shutting && !active)
            break;
        if (poll(polls, (nfds_t)maxconn + 2, 100) < 0 && errno != EINTR) {
            stop_requested = 1;
            continue;
        }
        if (polls[1].revents & POLLIN) {
            unsigned char bytes[256];
            while (read(wake[0], bytes, sizeof bytes) > 0) {
            }
        }
        if (mutex_ok)
            completions(&s);
        if (listener >= 0 && (polls[0].revents & POLLIN))
            for (int accepted = 0; accepted < 32; accepted++) {
                int fd = accept(listener, NULL, NULL);
                if (fd < 0) {
                    if (errno == EINTR)
                        continue;
                    break;
                }
                if (nonblocking(fd)) {
                    close(fd);
                    continue;
                }
#ifdef SO_NOSIGPIPE
                (void)setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
#endif
                int slot = -1;
                for (int i = 0; i < maxconn; i++)
                    if (s.connections[i].fd < 0) {
                        slot = i;
                        break;
                    }
                if (slot < 0) {
                    /* Best-effort overload notice; never wait for the client. */
                    const char reply[] = "HTTP/1.1 503 Service Unavailable\r\nContent-Length: "
                                         "0\r\nConnection: close\r\n\r\n";
                    ssize_t ignored = send(fd, reply, sizeof reply - 1, MSG_NOSIGNAL);
                    (void)ignored;
                    close(fd);
                    continue;
                }
                connection *c = &s.connections[slot];
                uint64_t generation = c->generation + 1;
                memset(c, 0, sizeof *c);
                c->generation = generation;
                c->fd = fd;
                c->state = 1;
                c->deadline = now_seconds() + timeout;
                c->input = malloc(HEADER_MAX + BODY_MAX + 1);
                if (!c->input)
                    disconnect(c);
            }
        double now = now_seconds();
        for (int i = 0; i < maxconn; i++) {
            connection *c = &s.connections[i];
            if (c->fd < 0)
                continue;
            short events = polls[i + 2].revents;
            if (events & (POLLERR | POLLNVAL)) {
                disconnect(c);
                continue;
            }
            if (c->state == 1 && (events & POLLIN)) {
                ssize_t n =
                    recv(c->fd, c->input + c->received, HEADER_MAX + BODY_MAX - c->received, 0);
                if (n == 0) {
                    disconnect(c);
                    continue;
                }
                if (n < 0) {
                    if (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK)
                        disconnect(c);
                    continue;
                }
                c->received += (size_t)n;
                c->input[c->received] = 0;
                if (!c->parsed) {
                    int status = parse_headers(c);
                    if (status > 0) {
                        reject(c, status, "Invalid HTTP request framing", timeout);
                        continue;
                    }
                }
                if (c->parsed) {
                    size_t total = c->header_length + c->body_length;
                    if (c->received > total) {
                        reject(c, 400, "Pipelining and trailing request bytes are not supported",
                               timeout);
                        continue;
                    }
                    if (c->received == total)
                        route(&s, i);
                }
            }
            if (c->state == 3 && (events & POLLOUT)) {
                ssize_t n =
                    send(c->fd, c->output + c->sent, c->output_length - c->sent, MSG_NOSIGNAL);
                if (n > 0) {
                    c->sent += (size_t)n;
                    if (c->sent == c->output_length)
                        disconnect(c);
                } else if (n == 0 || (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK))
                    disconnect(c);
            }
            if (c->fd >= 0 && (events & POLLHUP) && !(events & POLLIN) && c->state != 3)
                disconnect(c);
            if (c->fd >= 0 && c->state != 2 && now > c->deadline) {
                if (c->state == 1)
                    reject(c, 408, "Request deadline exceeded", timeout);
                else
                    disconnect(c);
            }
            if (shutting && now > shutdown_deadline && c->fd >= 0 && c->state != 2)
                disconnect(c);
        }
        if (!shutting)
            expire_sessions(&s, now);
    }
    if (mutex_ok) {
        pthread_mutex_lock(&p->mutex);
        p->stopping = 1;
        if (cond_ok)
            pthread_cond_broadcast(&p->ready);
        pthread_mutex_unlock(&p->mutex);
    }
    for (int i = 0; i < started; i++)
        pthread_join(workers[i], NULL);
    if (mutex_ok)
        completions(&s);
    for (int i = 0; i < maxconn; i++)
        disconnect(&s.connections[i]);
    for (int i = 0; i < SESSION_MAX; i++)
        if (s.sessions[i].engine)
            mdb_session_close(s.sessions[i].engine);
    if (cond_ok)
        pthread_cond_destroy(&p->ready);
    if (mutex_ok)
        pthread_mutex_destroy(&p->mutex);
    if (listener >= 0)
        close(listener);
    close(wake[0]);
    close(wake[1]);
    free(s.connections);
    free(workers);
    free(polls);
    mdb_close(db);
    return started == threads ? 0 : 1;
}
