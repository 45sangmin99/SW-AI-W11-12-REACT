#define _POSIX_C_SOURCE 200809L
#include "console.h"
#include <ctype.h>
#include <inttypes.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

/* ------------------------------------------------------------ 문장 끊기 */
void con_splitter_reset(con_splitter *s) {
    s->len = 0;
    s->quoted = 0;
    s->overflow = 0;
    s->sql[0] = 0;
}
int con_pending(const con_splitter *s) { return s->len > 0 || s->overflow; }
con_feed_result con_feed(con_splitter *s, unsigned char ch) {
    /* 문장 앞의 공백과 빈 줄은 버린다 (엔진에 넘기는 SQL이 첫 글자부터 시작하게) */
    if (s->len == 0 && !s->overflow && isspace(ch))
        return CON_MORE;
    /* 엔진의 한도와 같다: MDB_SQL_MAX 바이트까지 받고, 한 글자라도 넘치면 이 문장은 버린다 */
    if (!s->overflow && s->len >= MDB_SQL_MAX)
        s->overflow = 1;
    if (!s->overflow)
        s->sql[s->len++] = (char)ch;
    if (ch == '\'')
        s->quoted = !s->quoted;
    if (ch == ';' && !s->quoted) {
        if (s->overflow)
            return CON_TOO_LONG;
        s->sql[s->len] = 0;
        return s->len == 1 ? CON_EMPTY : CON_STATEMENT;
    }
    return CON_MORE;
}

/* ------------------------------------------------------------ 표시 폭 */
/* UTF-8 한 글자를 읽는다. 올바르지 않은 바이트는 1바이트짜리 U+FFFD로 본다 */
static unsigned decode(const unsigned char *p, size_t *advance) {
    unsigned cp;
    *advance = 1;
    if (p[0] < 0x80)
        return p[0];
    if ((p[0] & 0xE0) == 0xC0 && (p[1] & 0xC0) == 0x80) {
        cp = ((unsigned)(p[0] & 0x1F) << 6) | (p[1] & 0x3F);
        if (cp >= 0x80) {
            *advance = 2;
            return cp;
        }
    } else if ((p[0] & 0xF0) == 0xE0 && (p[1] & 0xC0) == 0x80 && (p[2] & 0xC0) == 0x80) {
        cp = ((unsigned)(p[0] & 0x0F) << 12) | ((unsigned)(p[1] & 0x3F) << 6) | (p[2] & 0x3F);
        if (cp >= 0x800) {
            *advance = 3;
            return cp;
        }
    } else if ((p[0] & 0xF8) == 0xF0 && (p[1] & 0xC0) == 0x80 && (p[2] & 0xC0) == 0x80 &&
               (p[3] & 0xC0) == 0x80) {
        cp = ((unsigned)(p[0] & 0x07) << 18) | ((unsigned)(p[1] & 0x3F) << 12) |
             ((unsigned)(p[2] & 0x3F) << 6) | (p[3] & 0x3F);
        if (cp >= 0x10000 && cp <= 0x10FFFF) {
            *advance = 4;
            return cp;
        }
    }
    return 0xFFFD;
}
static int in_range(unsigned cp, unsigned lo, unsigned hi) { return cp >= lo && cp <= hi; }
/* 터미널 칸 수: 한글·한자·전각 문자는 2칸, 결합 문자·너비 없는 문자는 0칸 */
static int cp_width(unsigned cp) {
    if (in_range(cp, 0x0300, 0x036F) || in_range(cp, 0x1AB0, 0x1AFF) || in_range(cp, 0x1DC0, 0x1DFF) ||
        in_range(cp, 0x200B, 0x200F) || in_range(cp, 0x20D0, 0x20FF) || in_range(cp, 0xFE00, 0xFE0F) ||
        cp == 0xFEFF)
        return 0;
    if (in_range(cp, 0x1100, 0x115F) || in_range(cp, 0x2E80, 0x303E) || in_range(cp, 0x3041, 0x33FF) ||
        in_range(cp, 0x3400, 0x4DBF) || in_range(cp, 0x4E00, 0x9FFF) || in_range(cp, 0xA000, 0xA4CF) ||
        in_range(cp, 0xA960, 0xA97F) || in_range(cp, 0xAC00, 0xD7A3) || in_range(cp, 0xF900, 0xFAFF) ||
        in_range(cp, 0xFE30, 0xFE6F) || in_range(cp, 0xFF00, 0xFF60) || in_range(cp, 0xFFE0, 0xFFE6) ||
        in_range(cp, 0x1F300, 0x1F64F) || in_range(cp, 0x1F900, 0x1F9FF) || in_range(cp, 0x20000, 0x3FFFD))
        return 2;
    return 1;
}
size_t con_display_width(const char *text) {
    size_t width = 0, advance;
    for (const unsigned char *p = (const unsigned char *)text; *p; p += advance)
        width += (size_t)cp_width(decode(p, &advance));
    return width;
}

/* ------------------------------------------------------------ 셀 문자열 */
char *con_escape_cell(const char *text) {
    size_t n = strlen(text);
    char *out = malloc(n * 4 + 1), *w = out;
    if (!out)
        return NULL;
    for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
        if (*p == '\n')
            w += sprintf(w, "\\n");
        else if (*p == '\r')
            w += sprintf(w, "\\r");
        else if (*p == '\t')
            w += sprintf(w, "\\t");
        else if (*p < 0x20 || *p == 0x7F)
            w += sprintf(w, "\\x%02X", *p);
        else
            *w++ = (char)*p;
    }
    *w = 0;
    return out;
}

/* ------------------------------------------------------------ 표 */
static void rule(FILE *out, const size_t *width, size_t ncolumns) {
    for (size_t c = 0; c < ncolumns; c++) {
        fputc('+', out);
        for (size_t i = 0; i < width[c] + 2; i++)
            fputc('-', out);
    }
    fputs("+\n", out);
}
static void cell(FILE *out, const char *text, size_t width, int right) {
    size_t pad = width - con_display_width(text);
    fputs("| ", out);
    if (right)
        for (size_t i = 0; i < pad; i++)
            fputc(' ', out);
    fputs(text, out);
    if (!right)
        for (size_t i = 0; i < pad; i++)
            fputc(' ', out);
    fputc(' ', out);
}
/* 숫자(INT) 열은 오른쪽, 문자열 열은 왼쪽으로 맞춘다.
 * 빈 문자열은 빈 칸으로 보인다. 이 엔진에는 NULL이 없고, 빈 문자열과 같은 값이기 때문이다 */
void con_print_table(FILE *out, const mdb_result *r) {
    size_t nc = r->ncolumns, nr = r->nrows;
    if (!nc)
        return;
    char **cells = calloc((nr + 1) * nc, sizeof *cells);
    size_t *width = calloc(nc, sizeof *width);
    int ok = cells && width;
    for (size_t c = 0; ok && c < nc; c++) {
        cells[c] = con_escape_cell(r->columns[c]);
        ok = cells[c] != NULL;
    }
    for (size_t row = 0; ok && row < nr; row++)
        for (size_t c = 0; ok && c < nc; c++) {
            const mdb_value *v = &r->rows[row].values[c];
            char number[32];
            const char *text;
            if (v->type == MDB_INT) {
                snprintf(number, sizeof number, "%" PRId64, v->i);
                text = number;
            } else
                text = v->s ? v->s : "";
            cells[(row + 1) * nc + c] = con_escape_cell(text);
            ok = cells[(row + 1) * nc + c] != NULL;
        }
    if (ok) {
        for (size_t row = 0; row <= nr; row++)
            for (size_t c = 0; c < nc; c++) {
                size_t w = con_display_width(cells[row * nc + c]);
                if (w > width[c])
                    width[c] = w;
            }
        rule(out, width, nc);
        for (size_t c = 0; c < nc; c++)
            cell(out, cells[c], width[c], r->types && r->types[c] == MDB_INT);
        fputs("|\n", out);
        rule(out, width, nc);
        for (size_t row = 0; row < nr; row++) {
            for (size_t c = 0; c < nc; c++)
                cell(out, cells[(row + 1) * nc + c], width[c], r->types && r->types[c] == MDB_INT);
            fputs("|\n", out);
        }
        rule(out, width, nc);
    } else
        fputs("(메모리가 부족해 표를 출력하지 못했습니다)\n", out);
    if (cells)
        for (size_t i = 0; i < (nr + 1) * nc; i++)
            free(cells[i]);
    free(cells);
    free(width);
}

/* ------------------------------------------------------------ 메시지 */
typedef enum { K_OTHER, K_SELECT, K_INSERT, K_UPDATE, K_DELETE, K_BEGIN, K_COMMIT, K_ROLLBACK } kind_t;
/* 메시지 문구를 고르려고 첫 단어만 본다 (문법 검사는 엔진이 한다) */
static kind_t kind_of(const char *sql) {
    static const struct {
        const char *word;
        kind_t kind;
    } words[] = {{"SELECT", K_SELECT}, {"INSERT", K_INSERT}, {"UPDATE", K_UPDATE}, {"DELETE", K_DELETE},
                 {"BEGIN", K_BEGIN},   {"COMMIT", K_COMMIT}, {"ROLLBACK", K_ROLLBACK}};
    while (isspace((unsigned char)*sql))
        sql++;
    for (size_t i = 0; i < sizeof words / sizeof *words; i++) {
        size_t n = strlen(words[i].word);
        if (!strncasecmp(sql, words[i].word, n) && !isalnum((unsigned char)sql[n]) && sql[n] != '_')
            return words[i].kind;
    }
    return K_OTHER;
}
static const char *commit_text(const mdb_result *r, char *buffer, size_t size) {
    if (r->commit == MDB_DURABLE)
        snprintf(buffer, size, "커밋됨 (DURABLE, txid %" PRIu64 ")", r->txid);
    else if (r->commit == MDB_NO_CHANGES)
        snprintf(buffer, size, "변경 없음 (NO_CHANGES)");
    else if (r->staged)
        snprintf(buffer, size, "아직 커밋되지 않음 (STAGED: COMMIT 하면 확정, ROLLBACK 하면 버려짐)");
    else
        buffer[0] = 0;
    return buffer;
}
/* 오류가 난 자리를 가리킨다: 그 줄을 보여 주고 아래에 ^ 를 둔다 (문법 오류만. 다른 오류의 위치는 의미가 없다) */
static void point_at(FILE *err, const char *sql, size_t offset) {
    size_t len = strlen(sql);
    if (offset > len)
        offset = len;
    size_t start = offset, end = offset;
    while (start > 0 && sql[start - 1] != '\n')
        start--;
    while (sql[end] && sql[end] != '\n')
        end++;
    char *line = strndup(sql + start, end - start), *prefix = strndup(sql + start, offset - start);
    char *shown = line ? con_escape_cell(line) : NULL, *before = prefix ? con_escape_cell(prefix) : NULL;
    if (shown && before) {
        fprintf(err, "  %s\n  ", shown);
        for (size_t i = 0, n = con_display_width(before); i < n; i++)
            fputc(' ', err);
        fputs("^\n", err);
    }
    free(line);
    free(prefix);
    free(shown);
    free(before);
}
void con_report(FILE *out, FILE *err, const char *sql, int rc, const mdb_result *r, double ms) {
    if (rc == 0) {
        kind_t kind = kind_of(sql);
        char tail[160];
        if (r->ncolumns > 0) {
            con_print_table(out, r);
            fprintf(out, "(%zu행 · %s · %.2f ms)\n", r->nrows, r->used_index ? "인덱스 조회" : "전체 훑기", ms);
        } else if (kind == K_BEGIN)
            fprintf(out, "트랜잭션을 시작했습니다 (txid %" PRIu64 ") · %.2f ms\n", r->txid, ms);
        else if (kind == K_ROLLBACK)
            fprintf(out, "롤백했습니다 · 이 트랜잭션의 변경은 버려졌습니다 · %.2f ms\n", ms);
        else if (kind == K_COMMIT) {
            if (r->commit == MDB_NO_CHANGES)
                fprintf(out, "커밋할 변경이 없었습니다 (NO_CHANGES) · %.2f ms\n", ms);
            else
                fprintf(out, "커밋했습니다 · %s · %.2f ms\n", commit_text(r, tail, sizeof tail), ms);
        } else {
            fprintf(out, "%" PRIu64 "행이 영향받았습니다", r->affected);
            if (kind == K_INSERT && r->has_inserted_id)
                fprintf(out, " (inserted id=%" PRId64 ")", r->inserted_id);
            commit_text(r, tail, sizeof tail);
            if (tail[0])
                fprintf(out, " · %s", tail);
            fprintf(out, " · %.2f ms\n", ms);
        }
        fflush(out);
        return;
    }
    fflush(out); /* 표준 출력의 내용이 오류 메시지보다 먼저 보이게 한다 */
    fprintf(err, "오류 [%s] %s\n", mdb_code_name(r->error.code), r->error.message);
    if (r->error.code == MDB_SYNTAX)
        point_at(err, sql, r->error.offset);
    if (r->error.code == MDB_UNKNOWN_TABLE)
        fputs("  .tables 로 테이블 목록을 볼 수 있습니다\n", err);
    if (r->error.code == MDB_CONFLICT)
        fputs("  다른 변경이 먼저 커밋되어 충돌했습니다. ROLLBACK 한 뒤 처음부터 다시 시도하세요\n", err);
    if (!strcmp(r->state, "FAILED") && r->error.code != MDB_FAILED)
        fputs("  이 트랜잭션은 FAILED 상태입니다. 엔진은 오류가 난 트랜잭션을 이어 가지 않으므로 ROLLBACK 이 필요합니다\n",
              err);
    if (r->commit == MDB_UNKNOWN)
        fprintf(err,
                "  커밋됐는지 알 수 없습니다 (UNKNOWN, txid %" PRIu64 "). 콘솔을 다시 실행하면 로그로 복구하고,\n"
                "  확정 여부는 mini-db --data-dir 폴더 --tx-status %" PRIu64 " 로 확인할 수 있습니다\n",
                r->txid, r->txid);
    if (r->recovery_required)
        fputs("  엔진이 복구가 필요하다고 알렸습니다. 이후 SQL은 실행하지 않습니다.\n"
              "  .quit 로 나간 뒤 다시 실행하면 로그에서 자동으로 복구합니다\n",
              err);
    fflush(err);
}
