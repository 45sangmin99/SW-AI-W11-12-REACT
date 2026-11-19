#define _POSIX_C_SOURCE 200809L
#include "mdb.h"
#include <ctype.h>
#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void csv_field(const char *s) {
    int quote = strpbrk(s, ",\"\r\n") != NULL;
    if (quote)
        putchar('"');
    for (; *s; s++) {
        if (*s == '"')
            putchar('"');
        putchar((unsigned char)*s);
    }
    if (quote)
        putchar('"');
}
static void csv_result(const mdb_result *r) {
    if (!r->ncolumns) {
        printf("affected,inserted_id,state\n%" PRIu64 ",", r->affected);
        if (r->has_inserted_id)
            printf("%" PRId64, r->inserted_id);
        printf(",%s\n", r->state);
        return;
    }
    for (size_t i = 0; i < r->ncolumns; i++) {
        if (i)
            putchar(',');
        csv_field(r->columns[i]);
    }
    putchar('\n');
    for (size_t row = 0; row < r->nrows; row++) {
        for (size_t col = 0; col < r->ncolumns; col++) {
            if (col)
                putchar(',');
            const mdb_value *v = &r->rows[row].values[col];
            if (v->type == MDB_INT)
                printf("%" PRId64, v->i);
            else
                csv_field(v->s ? v->s : "");
        }
        putchar('\n');
    }
}
static int execute(mdb_session *session, const char *sql, size_t number, int csv, int explain) {
    mdb_result result;
    memset(&result, 0, sizeof result);
    int rc = mdb_execute(session, sql, &result);
    if (rc)
        fprintf(stderr, "statement %zu: %s: %s\n", number, mdb_code_name(result.error.code),
                result.error.message);
    char *json = NULL;
    if (!csv || rc) {
        json = mdb_result_json(&result);
        if (json) {
            puts(json);
            free(json);
        } else {
            fprintf(stderr,
                    "Unable to serialize result: commit=%s txid=%" PRIu64 " recovery_required=%d\n",
                    result.commit == MDB_DURABLE      ? "DURABLE"
                    : result.commit == MDB_UNKNOWN    ? "UNKNOWN"
                    : result.commit == MDB_NO_CHANGES ? "NO_CHANGES"
                                                      : "NOT_COMMITTED",
                    result.txid, result.recovery_required);
            rc = -1;
        }
    } else
        csv_result(&result);
    if (explain && !rc)
        fprintf(stderr, "[%s]\n", result.used_index ? "index" : "full scan");
    mdb_result_free(&result);
    if (ferror(stdout))
        return -1;
    return rc;
}
static int meaningful(const char *s) {
    while (*s) {
        if (!isspace((unsigned char)*s))
            return 1;
        s++;
    }
    return 0;
}
static int process(mdb_session *session, FILE *in, const char *text, int csv, int explain,
                   int interactive) {
    char sql[MDB_SQL_MAX + 1];
    size_t len = 0, number = 0, pos = 0;
    int quoted = 0, ch;
    if (interactive) {
        fputs("mydb> ", stdout);
        fflush(stdout);
    }
    for (;;) {
        ch = text ? (text[pos] ? (unsigned char)text[pos++] : EOF) : fgetc(in);
        if (ch == EOF)
            break;
        if (ch == 0) {
            fprintf(stderr, "NUL input is not permitted\n");
            return 1;
        }
        if (len == MDB_SQL_MAX) {
            fprintf(stderr, "statement %zu: SQL length limit exceeded\n", number + 1);
            return 1;
        }
        sql[len++] = (char)ch;
        if (ch == '\'')
            quoted = !quoted;
        if (ch == ';' && !quoted) {
            sql[len] = 0;
            if (execute(session, sql, ++number, csv, explain))
                return 1;
            len = 0;
            if (interactive) {
                fputs("mydb> ", stdout);
                fflush(stdout);
            }
        }
    }
    if (!text && ferror(in)) {
        fprintf(stderr, "Input read failed\n");
        return 1;
    }
    sql[len] = 0;
    if (meaningful(sql) && execute(session, sql, ++number, csv, explain))
        return 1;
    return 0;
}
int main(int argc, char **argv) {
    const char *directory = "./data", *file = NULL, *text = NULL, *txstatus = NULL;
    int csv = 0, explain = 0;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--csv"))
            csv = 1;
        else if (!strcmp(argv[i], "--explain"))
            explain = 1;
        else if (!strcmp(argv[i], "--data-dir") && i + 1 < argc)
            directory = argv[++i];
        else if ((!strcmp(argv[i], "--file") || !strcmp(argv[i], "-f")) && i + 1 < argc)
            file = argv[++i];
        else if (!strcmp(argv[i], "-e") && i + 1 < argc)
            text = argv[++i];
        else if (!strcmp(argv[i], "--tx-status") && i + 1 < argc)
            txstatus = argv[++i];
        else {
            fprintf(stderr,
                    "usage: %s [--data-dir DIR] [--file SQL|-e SQL] [--csv] [--explain] "
                    "[--tx-status ID]\n",
                    argv[0]);
            return 2;
        }
    }
    if ((file && text) || (txstatus && (file || text))) {
        fprintf(stderr, "Choose one input mode\n");
        return 2;
    }
    mdb_error error;
    memset(&error, 0, sizeof error);
    mdb_db *db = mdb_open(directory, &error);
    if (!db) {
        fprintf(stderr, "%s: %s\n", mdb_code_name(error.code), error.message);
        return 1;
    }
    if (txstatus) {
        char *end = NULL;
        errno = 0;
        unsigned long long id = strtoull(txstatus, &end, 10);
        if (errno || !txstatus[0] || txstatus[0] == '-' || *end) {
            fprintf(stderr, "Invalid transaction ID\n");
            mdb_close(db);
            return 2;
        }
        int status = mdb_transaction_status(db, (uint64_t)id);
        printf("{\"txid\":\"%llu\",\"committed\":%s}\n", id, status > 0 ? "true" : "false");
        mdb_close(db);
        return status < 0 ? 1 : 0;
    }
    mdb_session *session = mdb_session_open(db, &error);
    if (!session) {
        fprintf(stderr, "%s: %s\n", mdb_code_name(error.code), error.message);
        mdb_close(db);
        return 1;
    }
    FILE *in = stdin;
    if (file && (in = fopen(file, "rb")) == NULL) {
        fprintf(stderr, "Cannot open SQL input\n");
        mdb_session_close(session);
        mdb_close(db);
        return 1;
    }
    int status = process(session, in, text, csv, explain, !file && !text && isatty(STDIN_FILENO));
    if (file && fclose(in))
        status = 1;
    mdb_session_close(session);
    mdb_close(db);
    return status;
}
