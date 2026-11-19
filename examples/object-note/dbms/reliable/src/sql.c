#include "mdb.h"
#include <ctype.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SQL_DEPTH_MAX 64
#define SQL_EXPR_MAX 256
#define ARENA_BLOCK 4096

typedef struct arena_block {
    struct arena_block *next;
    size_t used, capacity;
    max_align_t align;
    unsigned char data[];
} arena_block;
typedef struct {
    arena_block *head;
} sql_arena;
typedef enum {
    T_END,
    T_IDENT,
    T_INT,
    T_STRING,
    T_LP,
    T_RP,
    T_COMMA,
    T_STAR,
    T_SEMI,
    T_EQ,
    T_NE,
    T_LT,
    T_LE,
    T_GT,
    T_GE,
    T_BAD
} token_kind;
typedef struct {
    token_kind kind;
    const char *text;
    int64_t integer;
    size_t offset;
} token;
typedef struct {
    const char *source;
    size_t length, position;
    token current;
    sql_arena *arena;
    mdb_error *error;
    unsigned depth, nexpr;
    int failed;
} parser;

static void *arena_alloc(sql_arena *arena, size_t length) {
    const size_t alignment = _Alignof(max_align_t);
    if (length > SIZE_MAX - (alignment - 1))
        return NULL;
    length = (length + alignment - 1) / alignment * alignment;
    arena_block *block = arena->head;
    if (!block || length > block->capacity - block->used) {
        size_t capacity = length > ARENA_BLOCK ? length : ARENA_BLOCK;
        if (capacity > SIZE_MAX - sizeof(*block))
            return NULL;
        block = malloc(sizeof(*block) + capacity);
        if (!block)
            return NULL;
        block->next = arena->head;
        block->used = 0;
        block->capacity = capacity;
        arena->head = block;
    }
    void *result = block->data + block->used;
    block->used += length;
    memset(result, 0, length);
    return result;
}
static void arena_free(sql_arena *arena) {
    if (!arena)
        return;
    arena_block *block = arena->head;
    while (block) {
        arena_block *next = block->next;
        free(block);
        block = next;
    }
    free(arena);
}
static int fail(parser *p, mdb_code code, size_t offset, const char *message) {
    if (!p->failed) {
        p->failed = 1;
        p->error->code = code;
        p->error->offset = offset;
        (void)snprintf(p->error->message, sizeof(p->error->message), "%s", message);
    }
    return 0;
}
static void *allocate(parser *p, size_t length) {
    void *out = arena_alloc(p->arena, length);
    if (!out)
        (void)fail(p, MDB_NOMEM, p->position, "SQL allocation failed");
    return out;
}
static int ident_first(unsigned char ch) {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch == '_';
}
static int ident_rest(unsigned char ch) {
    return ident_first(ch) || (ch >= '0' && ch <= '9');
}
static void advance(parser *p) {
    if (p->failed)
        return;
    while (p->position < p->length && isspace((unsigned char)p->source[p->position]))
        p->position++;
    size_t start = p->position;
    token t = {T_END, NULL, 0, start};
    if (start == p->length) {
        p->current = t;
        return;
    }
    unsigned char ch = (unsigned char)p->source[p->position++];
    if (ident_first(ch)) {
        while (p->position < p->length && ident_rest((unsigned char)p->source[p->position]))
            p->position++;
        size_t n = p->position - start;
        if (n > MDB_NAME_MAX) {
            (void)fail(p, MDB_LIMIT, start, "Identifier exceeds length limit");
            return;
        }
        char *name = allocate(p, n + 1);
        if (!name)
            return;
        for (size_t i = 0; i < n; i++) {
            unsigned char c = (unsigned char)p->source[start + i];
            name[i] = (char)(c >= 'A' && c <= 'Z' ? c + ('a' - 'A') : c);
        }
        name[n] = '\0';
        t.kind = T_IDENT;
        t.text = name;
    } else if ((ch >= '0' && ch <= '9') ||
               (ch == '-' && p->position < p->length && p->source[p->position] >= '0' &&
                p->source[p->position] <= '9')) {
        int negative = ch == '-';
        size_t cursor = negative ? start + 1 : start;
        uint64_t magnitude = 0, maximum = negative ? (uint64_t)INT64_MAX + 1 : (uint64_t)INT64_MAX;
        while (cursor < p->length && p->source[cursor] >= '0' && p->source[cursor] <= '9') {
            unsigned digit = (unsigned)(p->source[cursor] - '0');
            if (magnitude > (maximum - digit) / 10) {
                (void)fail(p, MDB_LIMIT, start, "Integer outside int64 range");
                return;
            }
            magnitude = magnitude * 10 + digit;
            cursor++;
        }
        p->position = cursor;
        t.kind = T_INT;
        t.integer = negative
                        ? (magnitude == (uint64_t)INT64_MAX + 1 ? INT64_MIN : -(int64_t)magnitude)
                        : (int64_t)magnitude;
    } else if (ch == '\'') {
        char *value = allocate(p, p->length - start + 1);
        size_t used = 0;
        int closed = 0;
        if (!value)
            return;
        while (p->position < p->length) {
            char c = p->source[p->position++];
            if (c == '\'') {
                if (p->position < p->length && p->source[p->position] == '\'')
                    p->position++;
                else {
                    closed = 1;
                    break;
                }
            }
            if (used == MDB_TEXT_MAX) {
                (void)fail(p, MDB_LIMIT, start, "String exceeds maximum byte length");
                return;
            }
            value[used++] = c;
        }
        if (!closed) {
            (void)fail(p, MDB_SYNTAX, start, "Unterminated string literal");
            return;
        }
        value[used] = '\0';
        t.kind = T_STRING;
        t.text = value;
    } else {
        switch (ch) {
        case '(':
            t.kind = T_LP;
            break;
        case ')':
            t.kind = T_RP;
            break;
        case ',':
            t.kind = T_COMMA;
            break;
        case '*':
            t.kind = T_STAR;
            break;
        case ';':
            t.kind = T_SEMI;
            break;
        case '=':
            t.kind = T_EQ;
            break;
        case '<':
            t.kind = T_LT;
            if (p->position < p->length && p->source[p->position] == '=') {
                p->position++;
                t.kind = T_LE;
            }
            break;
        case '>':
            t.kind = T_GT;
            if (p->position < p->length && p->source[p->position] == '=') {
                p->position++;
                t.kind = T_GE;
            }
            break;
        case '!':
            if (p->position < p->length && p->source[p->position] == '=') {
                p->position++;
                t.kind = T_NE;
            } else
                t.kind = T_BAD;
            break;
        default:
            t.kind = T_BAD;
            break;
        }
        if (t.kind == T_BAD) {
            (void)fail(p, MDB_SYNTAX, start, "Unexpected SQL character");
            return;
        }
    }
    p->current = t;
}
static int keyword(const parser *p, const char *word) {
    return p->current.kind == T_IDENT && strcmp(p->current.text, word) == 0;
}
static int take(parser *p, token_kind kind) {
    if (!p->failed && p->current.kind == kind) {
        advance(p);
        return !p->failed;
    }
    return 0;
}
static int require(parser *p, token_kind kind, const char *message) {
    if (take(p, kind))
        return 1;
    return fail(p, MDB_SYNTAX, p->current.offset, message);
}
static int require_word(parser *p, const char *word) {
    if (!p->failed && keyword(p, word)) {
        advance(p);
        return !p->failed;
    }
    return fail(p, MDB_SYNTAX, p->current.offset, "Required SQL keyword is missing");
}
static char *identifier(parser *p) {
    if (p->failed)
        return NULL;
    if (p->current.kind != T_IDENT) {
        (void)fail(p, MDB_SYNTAX, p->current.offset, "Expected identifier");
        return NULL;
    }
    char *result = (char *)p->current.text;
    advance(p);
    return result;
}
static int literal(parser *p, mdb_value *out) {
    if (p->failed)
        return 0;
    if (p->current.kind == T_INT) {
        out->type = MDB_INT;
        out->i = p->current.integer;
        advance(p);
        return !p->failed;
    }
    if (p->current.kind == T_STRING) {
        out->type = MDB_STRING;
        out->s = (char *)p->current.text;
        advance(p);
        return !p->failed;
    }
    return fail(p, MDB_SYNTAX, p->current.offset, "Expected integer or quoted string");
}
static int operand(parser *p, mdb_operand *out) {
    if (p->current.kind == T_IDENT) {
        out->is_column = 1;
        out->column = identifier(p);
        return !p->failed;
    }
    return literal(p, &out->value);
}
static mdb_expr *expression(parser *p);
static mdb_expr *new_expr(parser *p, mdb_expr_kind kind) {
    if (p->nexpr == SQL_EXPR_MAX) {
        (void)fail(p, MDB_LIMIT, p->current.offset, "Too many expression nodes");
        return NULL;
    }
    mdb_expr *expr = allocate(p, sizeof(*expr));
    if (expr) {
        expr->kind = kind;
        p->nexpr++;
    }
    return expr;
}
static mdb_expr *comparison(parser *p) {
    if (p->failed)
        return NULL;
    if (p->current.kind == T_LP) {
        if (p->depth == SQL_DEPTH_MAX) {
            (void)fail(p, MDB_LIMIT, p->current.offset, "Expression nesting limit exceeded");
            return NULL;
        }
        p->depth++;
        advance(p);
        mdb_expr *expr = expression(p);
        p->depth--;
        if (!require(p, T_RP, "Expected closing parenthesis"))
            return NULL;
        return expr;
    }
    mdb_expr *expr = new_expr(p, MDB_COMPARE);
    if (!expr)
        return NULL;
    if (!operand(p, &expr->a))
        return NULL;
    switch (p->current.kind) {
    case T_EQ:
        expr->cmp = MDB_EQ;
        break;
    case T_NE:
        expr->cmp = MDB_NE;
        break;
    case T_LT:
        expr->cmp = MDB_LT;
        break;
    case T_LE:
        expr->cmp = MDB_LE;
        break;
    case T_GT:
        expr->cmp = MDB_GT;
        break;
    case T_GE:
        expr->cmp = MDB_GE;
        break;
    default:
        (void)fail(p, MDB_SYNTAX, p->current.offset, "Expected comparison operator");
        return NULL;
    }
    advance(p);
    if (!operand(p, &expr->b))
        return NULL;
    return expr;
}
static mdb_expr *conjunction(parser *p) {
    mdb_expr *left = comparison(p);
    while (!p->failed && keyword(p, "and")) {
        advance(p);
        mdb_expr *node = new_expr(p, MDB_AND);
        if (!node)
            return NULL;
        node->left = left;
        node->right = comparison(p);
        left = node;
    }
    return left;
}
static mdb_expr *expression(parser *p) {
    mdb_expr *left = conjunction(p);
    while (!p->failed && keyword(p, "or")) {
        advance(p);
        mdb_expr *node = new_expr(p, MDB_OR);
        if (!node)
            return NULL;
        node->left = left;
        node->right = conjunction(p);
        left = node;
    }
    return left;
}
static int column_list(parser *p, mdb_stmt *s) {
    s->columns = allocate(p, MDB_COL_MAX * sizeof(*s->columns));
    if (!s->columns)
        return 0;
    do {
        if (s->ncolumns == MDB_COL_MAX)
            return fail(p, MDB_LIMIT, p->current.offset, "Column limit exceeded");
        char *name = identifier(p);
        if (!name)
            return 0;
        s->columns[s->ncolumns++] = name;
    } while (take(p, T_COMMA));
    return !p->failed;
}
static void parse_select(parser *p, mdb_stmt *s) {
    s->kind = MDB_SELECT;
    advance(p);
    if (take(p, T_STAR))
        s->star = 1;
    else if (keyword(p, "count")) {
        s->count = 1;
        advance(p);
        if (!require(p, T_LP, "Expected '(' after COUNT") ||
            !require(p, T_STAR, "Only COUNT(*) is supported") ||
            !require(p, T_RP, "Expected ')' after COUNT(*)"))
            return;
    } else if (!column_list(p, s))
        return;
    if (!require_word(p, "from"))
        return;
    s->table = identifier(p);
    if (p->failed)
        return;
    if (keyword(p, "where")) {
        advance(p);
        s->where = expression(p);
    }
    if (keyword(p, "order")) {
        advance(p);
        if (!require_word(p, "by"))
            return;
        s->order = allocate(p, MDB_COL_MAX * sizeof(*s->order));
        if (!s->order)
            return;
        do {
            if (s->norder == MDB_COL_MAX) {
                (void)fail(p, MDB_LIMIT, p->current.offset, "ORDER BY column limit exceeded");
                return;
            }
            mdb_order *order = &s->order[s->norder++];
            order->column = identifier(p);
            if (p->failed)
                return;
            if (keyword(p, "asc"))
                advance(p);
            else if (keyword(p, "desc")) {
                order->descending = 1;
                advance(p);
            }
        } while (take(p, T_COMMA));
    }
    if (keyword(p, "limit")) {
        advance(p);
        if (p->current.kind != T_INT || p->current.integer < 0) {
            (void)fail(p, MDB_SYNTAX, p->current.offset, "LIMIT must be a nonnegative integer");
            return;
        }
        s->limit = p->current.integer;
        advance(p);
    }
}
static void parse_insert(parser *p, mdb_stmt *s) {
    s->kind = MDB_INSERT;
    advance(p);
    if (!require_word(p, "into"))
        return;
    s->table = identifier(p);
    if (p->failed)
        return;
    if (take(p, T_LP)) {
        if (!column_list(p, s) || !require(p, T_RP, "Expected ')' after column list"))
            return;
    }
    if (!require_word(p, "values") || !require(p, T_LP, "Expected '(' after VALUES"))
        return;
    s->values = allocate(p, MDB_COL_MAX * sizeof(*s->values));
    if (!s->values)
        return;
    do {
        if (s->nvalues == MDB_COL_MAX) {
            (void)fail(p, MDB_LIMIT, p->current.offset, "Value count limit exceeded");
            return;
        }
        if (!literal(p, &s->values[s->nvalues++]))
            return;
    } while (take(p, T_COMMA));
    (void)require(p, T_RP, "Expected ')' after values");
}
static void parse_update(parser *p, mdb_stmt *s) {
    s->kind = MDB_UPDATE;
    advance(p);
    s->table = identifier(p);
    if (p->failed || !require_word(p, "set"))
        return;
    s->updates = allocate(p, MDB_COL_MAX * sizeof(*s->updates));
    if (!s->updates)
        return;
    do {
        if (s->nupdates == MDB_COL_MAX) {
            (void)fail(p, MDB_LIMIT, p->current.offset, "Assignment limit exceeded");
            return;
        }
        mdb_assignment *assignment = &s->updates[s->nupdates++];
        assignment->column = identifier(p);
        if (p->failed || !require(p, T_EQ, "Expected '=' in assignment") ||
            !literal(p, &assignment->value))
            return;
    } while (take(p, T_COMMA));
    if (keyword(p, "where")) {
        advance(p);
        s->where = expression(p);
    }
}
static void parse_delete(parser *p, mdb_stmt *s) {
    s->kind = MDB_DELETE;
    advance(p);
    if (!require_word(p, "from"))
        return;
    s->table = identifier(p);
    if (p->failed)
        return;
    if (keyword(p, "where")) {
        advance(p);
        s->where = expression(p);
    }
}
int mdb_parse(const char *sql, mdb_stmt **out, mdb_error *err) {
    mdb_error local = {0};
    if (!err)
        err = &local;
    memset(err, 0, sizeof(*err));
    if (out)
        *out = NULL;
    if (!sql || !out) {
        err->code = MDB_SYNTAX;
        (void)snprintf(err->message, sizeof(err->message), "SQL and output are required");
        return -1;
    }
    size_t length = 0;
    while (length <= MDB_SQL_MAX && sql[length])
        length++;
    if (length > MDB_SQL_MAX) {
        err->code = MDB_LIMIT;
        err->offset = MDB_SQL_MAX;
        (void)snprintf(err->message, sizeof(err->message), "SQL exceeds 4096 bytes");
        return -1;
    }
    sql_arena *arena = calloc(1, sizeof(*arena));
    if (!arena) {
        err->code = MDB_NOMEM;
        (void)snprintf(err->message, sizeof(err->message), "SQL allocation failed");
        return -1;
    }
    parser p = {sql, length, 0, {0}, arena, err, 0, 0, 0};
    mdb_stmt *stmt = allocate(&p, sizeof(*stmt));
    if (!stmt) {
        arena_free(arena);
        return -1;
    }
    stmt->arena = arena;
    stmt->limit = -1;
    advance(&p);
    if (keyword(&p, "select"))
        parse_select(&p, stmt);
    else if (keyword(&p, "insert"))
        parse_insert(&p, stmt);
    else if (keyword(&p, "update"))
        parse_update(&p, stmt);
    else if (keyword(&p, "delete"))
        parse_delete(&p, stmt);
    else if (keyword(&p, "begin")) {
        stmt->kind = MDB_BEGIN;
        advance(&p);
    } else if (keyword(&p, "commit")) {
        stmt->kind = MDB_COMMIT;
        advance(&p);
    } else if (keyword(&p, "rollback")) {
        stmt->kind = MDB_ROLLBACK;
        advance(&p);
    } else
        (void)fail(&p, MDB_SYNTAX, p.current.offset, "Unsupported or empty SQL statement");
    if (!p.failed && p.current.kind == T_SEMI)
        advance(&p);
    if (!p.failed && p.current.kind != T_END)
        (void)fail(&p, MDB_SYNTAX, p.current.offset, "Only one complete SQL statement is allowed");
    if (p.failed) {
        arena_free(arena);
        return -1;
    }
    *out = stmt;
    return 0;
}
void mdb_stmt_free(mdb_stmt *stmt) {
    if (stmt)
        arena_free(stmt->arena);
}
int mdb_expr_id(const mdb_expr *expr, int64_t *id) {
    if (!expr || !id)
        return 0;
    if (expr->kind == MDB_AND)
        return mdb_expr_id(expr->left, id) || mdb_expr_id(expr->right, id);
    if (expr->kind != MDB_COMPARE || expr->cmp != MDB_EQ)
        return 0;
    if (expr->a.is_column && strcmp(expr->a.column, "id") == 0 && !expr->b.is_column &&
        expr->b.value.type == MDB_INT) {
        *id = expr->b.value.i;
        return 1;
    }
    if (expr->b.is_column && strcmp(expr->b.column, "id") == 0 && !expr->a.is_column &&
        expr->a.value.type == MDB_INT) {
        *id = expr->a.value.i;
        return 1;
    }
    return 0;
}
