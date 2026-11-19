#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE
#define _XOPEN_SOURCE 700
#include "engine.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void usage(void) {
    fputs("Usage:\n  mini-db prepare --data-dir PATH  (prepare missing tables from existing schema.txt)\n"
          "  mini-db init --data-dir PATH     (validate and remember DB in .mini-db)\n"
          "  mini-db run FILE.sql\n", stderr);
}

static char *read_file(const char *path, size_t limit) {
    FILE *file = fopen(path, "rb");
    if (!file) { fprintf(stderr, "Cannot open %s: %s\n", path, strerror(errno)); return NULL; }
    char *text = malloc(limit + 1);
    if (!text) { fclose(file); return NULL; }
    size_t count = fread(text, 1, limit, file);
    int too_long = fgetc(file) != EOF;
    int invalid = ferror(file) || too_long || memchr(text, 0, count) != NULL;
    fclose(file);
    if (invalid) {
        fprintf(stderr, "Invalid file, embedded NUL, or exceeds %zu bytes: %s\n", limit, path);
        free(text); return NULL;
    }
    text[count] = 0; return text;
}

static int save_config(const char *directory) {
    char temp[] = ".mini-db.tmp-XXXXXX";
    int fd = mkstemp(temp);
    if (fd < 0) return -1;
    FILE *file = fdopen(fd, "w");
    if (!file) { close(fd); unlink(temp); return -1; }
    int ok = fprintf(file, "%s\n", directory) >= 0;
    if (fflush(file) != 0 || fsync(fileno(file)) != 0) ok = 0;
    if (fclose(file) != 0) ok = 0;
    if (!ok || rename(temp, ".mini-db") != 0) { unlink(temp); return -1; }
    return 0;
}

int main(int argc, char **argv) {
    if (argc == 4 && (!strcmp(argv[1], "init") || !strcmp(argv[1], "prepare")) && !strcmp(argv[2], "--data-dir")) {
        char *directory = realpath(argv[3], NULL);
        if (!directory || strchr(directory, '\n') || strchr(directory, '\r')) {
            fputs("DB directory must exist and cannot contain newlines\n", stderr); free(directory); return 1;
        }
        char error[256] = {0};
        if (!strcmp(argv[1], "prepare")) {
            int result = db_prepare_tables(directory, error, sizeof error);
            if (result < 0) fprintf(stderr, "%s\n", error); else puts("Table files prepared; existing files preserved.");
            free(directory); return result < 0;
        }
        DBEngine *engine = db_engine_open(directory, error, sizeof error);
        if (!engine) { fprintf(stderr, "%s\n", error); free(directory); return 1; }
        db_engine_close(engine);
        if (save_config(directory) < 0) { fputs("Cannot save .mini-db configuration\n", stderr); free(directory); return 1; }
        printf("Connected: %s\n", directory); free(directory); return 0;
    }
    if (argc == 3 && !strcmp(argv[1], "run")) {
        char *directory = read_file(".mini-db", 4095);
        if (!directory) { fputs("Run init --data-dir PATH in this working directory first.\n", stderr); return 1; }
        size_t length = strlen(directory);
        while (length && (directory[length - 1] == '\n' || directory[length - 1] == '\r')) directory[--length] = 0;
        if (!length || directory[0] != '/' || strchr(directory, '\n') || strchr(directory, '\r')) {
            fputs("Invalid .mini-db configuration\n", stderr); free(directory); return 1;
        }
        char *sql = read_file(argv[2], DB_SQL_MAX_BYTES);
        if (!sql) { free(directory); return 1; }
        char error[256] = {0};
        DBEngine *engine = db_engine_open(directory, error, sizeof error); free(directory);
        if (!engine) { fprintf(stderr, "%s\n", error); free(sql); return 1; }
        char *json = NULL; DBSQLError sql_error;
        int result = db_engine_execute(engine, sql, &json, &sql_error);
        if (result < 0) fprintf(stderr, "SQL error at byte %zu: %s\nEarlier successful statements, if any, remain committed.\n", sql_error.offset, sql_error.message);
        else puts(json);
        db_result_free(json); free(sql); db_engine_close(engine); return result < 0;
    }
    usage(); return 2;
}
