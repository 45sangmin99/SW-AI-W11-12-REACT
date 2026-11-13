#define _POSIX_C_SOURCE 200809L
/* Mini DB 콘솔: 입력 -> 실행 -> 출력을 되풀이한다. 엔진 호출은 mdb_execute 하나뿐이다. */
#include "console.h"
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>
#include <unistd.h>

typedef struct {
    mdb_session *session;
    const char *directory;
    int interactive;
    int tx;                /* 0 트랜잭션 없음, 1 진행 중, 2 FAILED (ROLLBACK만 받는다) */
    int needs_recovery;    /* 엔진이 복구를 요구했다: SQL을 더 보내지 않는다 */
    unsigned long errors;
} console;

static volatile sig_atomic_t interrupted;
static void on_interrupt(int signo) {
    (void)signo;
    interrupted = 1;
}
static double now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (double)t.tv_sec * 1000.0 + (double)t.tv_nsec / 1e6;
}

/* ------------------------------------------------------------ SQL 실행 */
static void run_statement(console *c, const char *sql) {
    if (c->needs_recovery) {
        fflush(stdout);
        fputs("오류: 엔진이 복구를 요구해서 SQL을 실행하지 않습니다. .quit 로 나간 뒤 다시 실행하세요\n", stderr);
        c->errors++;
        return;
    }
    mdb_result result;
    memset(&result, 0, sizeof result);
    double started = now_ms();
    int rc = mdb_execute(c->session, sql, &result);
    double elapsed = now_ms() - started;
    con_report(stdout, stderr, sql, rc, &result, elapsed);
    if (rc)
        c->errors++;
    /* 프롬프트에 보여 줄 트랜잭션 상태는 엔진이 알려 주는 state 에서 읽는다 */
    c->tx = !strcmp(result.state, "ACTIVE") || !strcmp(result.state, "STAGED") ? 1 : !strcmp(result.state, "FAILED") ? 2 : 0;
    if (result.recovery_required)
        c->needs_recovery = 1;
    mdb_result_free(&result);
}

/* ------------------------------------------------------------ . 명령 */
static void print_help(void) {
    puts("SQL은 세미콜론(;)으로 끝납니다. 여러 줄에 걸쳐 써도 됩니다.\n"
         "명령은 줄의 맨 앞에서 씁니다 (SQL을 쓰는 도중에는 명령이 아니라 SQL로 읽습니다).\n"
         "  .quit  .exit  \\q   콘솔을 끝냅니다 (커밋하지 않은 트랜잭션은 버려집니다)\n"
         "  .help  \\?          이 도움말\n"
         "  .tables            테이블 목록\n"
         "  .schema [이름]     테이블의 열 정의\n"
         "Ctrl-C 는 쓰고 있던 입력을 취소합니다. Ctrl-D 는 끝냅니다.\n"
         "이 엔진은 SELECT INSERT UPDATE DELETE BEGIN COMMIT ROLLBACK 만 지원하고, NULL이 없습니다.");
}
static int is_table_name(const char *name) {
    size_t n = strlen(name);
    if (n == 0 || n > MDB_NAME_MAX)
        return 0;
    for (size_t i = 0; i < n; i++)
        if (!(islower((unsigned char)name[i]) || isdigit((unsigned char)name[i]) || name[i] == '_'))
            return 0;
    return 1;
}
static int by_name(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }
/* 테이블 이름은 데이터 폴더의 *.schema 파일에서 읽는다 (엔진에는 목록을 묻는 SQL이 없다) */
static char **list_tables(const char *directory, size_t *count) {
    DIR *dir = opendir(directory);
    char **names = NULL;
    size_t n = 0, cap = 0;
    *count = 0;
    if (!dir)
        return NULL;
    for (struct dirent *e; (e = readdir(dir));) {
        size_t len = strlen(e->d_name);
        if (len <= 7 || strcmp(e->d_name + len - 7, ".schema"))
            continue;
        char *name = strndup(e->d_name, len - 7);
        if (!name || !is_table_name(name)) {
            free(name);
            continue;
        }
        if (n == cap) {
            char **grown = realloc(names, (cap ? cap * 2 : 8) * sizeof *names);
            if (!grown) {
                free(name);
                break;
            }
            names = grown;
            cap = cap ? cap * 2 : 8;
        }
        names[n++] = name;
    }
    closedir(dir);
    if (n)
        qsort(names, n, sizeof *names, by_name);
    *count = n;
    return names;
}
static void show_schema(const char *directory, const char *name) {
    char path[4096];
    int written = snprintf(path, sizeof path, "%s/%s.schema", directory, name);
    FILE *f = written > 0 && (size_t)written < sizeof path ? fopen(path, "r") : NULL;
    if (!f) {
        fprintf(stderr, "오류: 테이블 '%s'을(를) 찾을 수 없습니다 (.tables 로 목록을 보세요)\n", name);
        return;
    }
    printf("%s\n", name);
    char line[512];
    while (fgets(line, sizeof line, f))
        printf("  %s%s", line, strchr(line, '\n') ? "" : "\n");
    fclose(f);
}
/* 명령이면 처리하고 1, 아니면 0. quit 이 설정되면 콘솔을 끝낸다 */
static int command(console *c, char *line, int *quit) {
    char *p = line;
    while (isspace((unsigned char)*p))
        p++;
    if (*p != '.' && *p != '\\')
        return 0;
    char *end = p + strlen(p);
    while (end > p && isspace((unsigned char)end[-1]))
        *--end = 0;
    char *arg = p;
    while (*arg && !isspace((unsigned char)*arg))
        arg++;
    if (*arg) {
        *arg++ = 0;
        while (isspace((unsigned char)*arg))
            arg++;
    }
    if (!strcasecmp(p, ".quit") || !strcasecmp(p, ".exit") || !strcasecmp(p, "\\q"))
        *quit = 1;
    else if (!strcasecmp(p, ".help") || !strcmp(p, "\\?"))
        print_help();
    else if (!strcasecmp(p, ".tables")) {
        size_t n;
        char **names = list_tables(c->directory, &n);
        for (size_t i = 0; i < n; i++) {
            puts(names[i]);
            free(names[i]);
        }
        if (!n)
            puts("(테이블이 없습니다)");
        free(names);
    } else if (!strcasecmp(p, ".schema")) {
        if (*arg) {
            if (is_table_name(arg))
                show_schema(c->directory, arg);
            else
                fprintf(stderr, "오류: 테이블 이름이 올바르지 않습니다: %s\n", arg);
        } else {
            size_t n;
            char **names = list_tables(c->directory, &n);
            for (size_t i = 0; i < n; i++) {
                show_schema(c->directory, names[i]);
                free(names[i]);
            }
            if (!n)
                puts("(테이블이 없습니다)");
            free(names);
        }
    } else {
        fflush(stdout);
        fprintf(stderr, "오류: 알 수 없는 명령입니다: %s (.help 를 보세요)\n", p);
        c->errors++;
    }
    fflush(stdout);
    return 1;
}

/* ------------------------------------------------------------ 입력 루프 */
static void prompt(const console *c, const con_splitter *s) {
    if (con_pending(s))
        fputs("   ...> ", stdout);
    else if (c->tx == 2)
        fputs("mydb(tx FAILED)> ", stdout);
    else if (c->tx == 1)
        fputs("mydb(tx)> ", stdout);
    else
        fputs("mydb> ", stdout);
    fflush(stdout);
}
static int usage(const char *program) {
    fprintf(stderr, "usage: %s [--data-dir DIR]\n", program);
    return 2;
}
int main(int argc, char **argv) {
    const char *directory = "./data";
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--data-dir") && i + 1 < argc)
            directory = argv[++i];
        else
            return usage(argv[0]);
    }
    mdb_error error;
    memset(&error, 0, sizeof error);
    mdb_db *db = mdb_open(directory, &error);
    if (!db) {
        fprintf(stderr, "데이터 폴더를 열 수 없습니다 [%s] %s\n", mdb_code_name(error.code), error.message);
        return 1;
    }
    mdb_session *session = mdb_session_open(db, &error);
    if (!session) {
        fprintf(stderr, "세션을 열 수 없습니다 [%s] %s\n", mdb_code_name(error.code), error.message);
        mdb_close(db);
        return 1;
    }
    console c = {session, directory, isatty(STDIN_FILENO), 0, 0, 0};
    if (c.interactive) {
        /* SA_RESTART 없이 등록해서, 입력을 기다리는 중에 Ctrl-C 가 오면 읽기가 끊기게 한다 */
        struct sigaction action;
        memset(&action, 0, sizeof action);
        action.sa_handler = on_interrupt;
        sigemptyset(&action.sa_mask);
        sigaction(SIGINT, &action, NULL);
        printf("Mini DB 콘솔 (데이터 폴더: %s)\nSQL은 세미콜론(;)으로 끝납니다. 종료: .quit  .exit  \\q   도움말: .help\n", directory);
    }
    static con_splitter splitter; /* 4KB가 넘어서 스택 대신 정적 영역에 둔다 */
    con_splitter_reset(&splitter);
    char *line = NULL;
    size_t capacity = 0;
    int quit = 0;
    while (!quit) {
        if (c.interactive)
            prompt(&c, &splitter);
        interrupted = 0;
        ssize_t n = getline(&line, &capacity, stdin);
        if (n < 0) {
            if (errno == EINTR) { /* 신호로 읽기가 끊겼다. Ctrl-C 라면 쓰던 입력만 취소하고 계속한다 */
                clearerr(stdin);
                if (interrupted) {
                    con_splitter_reset(&splitter);
                    puts("\n입력을 취소했습니다");
                }
                continue;
            }
            if (c.interactive)
                putchar('\n');
            break; /* EOF */
        }
        if (memchr(line, 0, (size_t)n)) {
            fflush(stdout);
            fputs("오류: 입력에 NUL(0) 글자가 있어 이 줄을 무시했습니다\n", stderr);
            c.errors++;
            continue;
        }
        if (!con_pending(&splitter) && command(&c, line, &quit))
            continue;
        for (ssize_t i = 0; i < n; i++) {
            con_feed_result r = con_feed(&splitter, (unsigned char)line[i]);
            if (r == CON_STATEMENT) {
                run_statement(&c, splitter.sql);
                con_splitter_reset(&splitter);
            } else if (r == CON_TOO_LONG) {
                fflush(stdout);
                fprintf(stderr, "오류: SQL이 한도(%d바이트)를 넘어서 이 문장은 실행하지 않았습니다\n", MDB_SQL_MAX);
                c.errors++;
                con_splitter_reset(&splitter);
            } else if (r == CON_EMPTY)
                con_splitter_reset(&splitter);
        }
    }
    free(line);
    if (con_pending(&splitter)) {
        fflush(stdout);
        fputs("세미콜론으로 끝나지 않은 입력은 실행하지 않았습니다\n", stderr);
        c.errors++;
    }
    if (c.tx) {
        puts("커밋하지 않은 트랜잭션이 있어서 변경은 버려집니다 (ROLLBACK)");
        fflush(stdout);
    }
    mdb_session_close(session);
    mdb_close(db);
    /* 대화형이 아닐 때(스크립트)는 오류가 있었는지를 종료 코드로 알린다 */
    return !c.interactive && c.errors ? 1 : 0;
}
