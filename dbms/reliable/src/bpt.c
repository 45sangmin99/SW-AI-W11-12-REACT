#include "bpt.h"
#include <limits.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#ifndef BPT_ORDER
#define BPT_ORDER 64
#endif
#if BPT_ORDER < 4
#error BPT_ORDER must be at least four
#endif
#define BPT_KEYS (BPT_ORDER - 1)
#define BPT_HEIGHT_MAX 64
#define SLAB_NODES 32
#ifdef MDB_BPT_TEST_ALLOC
extern void *mdb_bpt_test_calloc(size_t, size_t);
#define BPT_CALLOC mdb_bpt_test_calloc
#else
#define BPT_CALLOC calloc
#endif

typedef struct bpt_node {
    size_t count;
    int leaf;
    int64_t keys[BPT_ORDER];
    uint64_t offsets[BPT_ORDER];
    struct bpt_node *children[BPT_ORDER + 1], *next;
} bpt_node;
typedef struct node_slab {
    struct node_slab *next;
    size_t used;
    bpt_node nodes[SLAB_NODES];
} node_slab;
struct mdb_bpt {
    bpt_node *root;
    node_slab *slabs;
    size_t nslabs, size;
};

/* Reserve all potentially required nodes before changing any key/pointer. */
static int reserve_nodes(mdb_bpt *tree, size_t needed) {
    size_t available = tree->slabs ? SLAB_NODES - tree->slabs->used : 0;
    node_slab *pending = NULL;
    size_t allocated = 0;
    while (available < needed) {
        node_slab *slab = BPT_CALLOC(1, sizeof(*slab));
        if (!slab) {
            while (pending) {
                node_slab *next = pending->next;
                free(pending);
                pending = next;
            }
            return -1;
        }
        slab->next = pending;
        pending = slab;
        allocated++;
        available += SLAB_NODES;
    }
    if (pending) {
        node_slab *tail = pending;
        while (tail->next)
            tail = tail->next;
        tail->next = tree->slabs;
        tree->slabs = pending;
        tree->nslabs += allocated;
    }
    return 0;
}
static bpt_node *new_node(mdb_bpt *tree, int leaf) {
    node_slab *slab = tree->slabs;
    while (slab && slab->used == SLAB_NODES)
        slab = slab->next;
    if (!slab)
        return NULL;
    bpt_node *node = &slab->nodes[slab->used++];
    node->leaf = leaf;
    return node;
}
static size_t child_index(const bpt_node *node, int64_t key) {
    size_t low = 0, high = node->count;
    while (low < high) {
        size_t middle = low + (high - low) / 2;
        if (key >= node->keys[middle])
            low = middle + 1;
        else
            high = middle;
    }
    return low;
}
static size_t key_index(const bpt_node *node, int64_t key) {
    size_t low = 0, high = node->count;
    while (low < high) {
        size_t middle = low + (high - low) / 2;
        if (node->keys[middle] < key)
            low = middle + 1;
        else
            high = middle;
    }
    return low;
}
mdb_bpt *mdb_bpt_create(void) {
    return BPT_CALLOC(1, sizeof(mdb_bpt));
}
void mdb_bpt_free(mdb_bpt *tree) {
    if (!tree)
        return;
    node_slab *slab = tree->slabs;
    while (slab) {
        node_slab *next = slab->next;
        free(slab);
        slab = next;
    }
    free(tree);
}
int mdb_bpt_search(const mdb_bpt *tree, int64_t key, uint64_t *offset) {
    if (!tree)
        return 0;
    const bpt_node *node = tree->root;
    while (node && !node->leaf)
        node = node->children[child_index(node, key)];
    if (!node)
        return 0;
    size_t at = key_index(node, key);
    if (at == node->count || node->keys[at] != key)
        return 0;
    if (offset)
        *offset = node->offsets[at];
    return 1;
}
int mdb_bpt_insert(mdb_bpt *tree, int64_t key, uint64_t offset) {
    if (!tree)
        return -1;
    if (!tree->root) {
        if (reserve_nodes(tree, 1))
            return -1;
        tree->root = new_node(tree, 1);
        tree->root->keys[0] = key;
        tree->root->offsets[0] = offset;
        tree->root->count = 1;
        tree->size = 1;
        return 0;
    }
    bpt_node *path[BPT_HEIGHT_MAX];
    size_t positions[BPT_HEIGHT_MAX], depth = 0;
    bpt_node *leaf = tree->root;
    while (!leaf->leaf) {
        if (depth == BPT_HEIGHT_MAX)
            return -1;
        path[depth] = leaf;
        positions[depth] = child_index(leaf, key);
        leaf = leaf->children[positions[depth++]];
    }
    size_t at = key_index(leaf, key);
    if (at < leaf->count && leaf->keys[at] == key)
        return 1;
    if (leaf->count == BPT_KEYS && reserve_nodes(tree, depth + 2))
        return -1;
    memmove(leaf->keys + at + 1, leaf->keys + at, (leaf->count - at) * sizeof(*leaf->keys));
    memmove(leaf->offsets + at + 1, leaf->offsets + at,
            (leaf->count - at) * sizeof(*leaf->offsets));
    leaf->keys[at] = key;
    leaf->offsets[at] = offset;
    leaf->count++;
    tree->size++;
    if (leaf->count <= BPT_KEYS)
        return 0;
    bpt_node *right = new_node(tree, 1);
    size_t split = leaf->count / 2;
    right->count = leaf->count - split;
    memcpy(right->keys, leaf->keys + split, right->count * sizeof(*right->keys));
    memcpy(right->offsets, leaf->offsets + split, right->count * sizeof(*right->offsets));
    leaf->count = split;
    right->next = leaf->next;
    leaf->next = right;
    int64_t separator = right->keys[0];
    bpt_node *left = leaf;
    for (;;) {
        if (depth == 0) {
            bpt_node *root = new_node(tree, 0);
            root->count = 1;
            root->keys[0] = separator;
            root->children[0] = left;
            root->children[1] = right;
            tree->root = root;
            return 0;
        }
        depth--;
        bpt_node *parent = path[depth];
        size_t slot = positions[depth];
        memmove(parent->keys + slot + 1, parent->keys + slot,
                (parent->count - slot) * sizeof(*parent->keys));
        memmove(parent->children + slot + 2, parent->children + slot + 1,
                (parent->count - slot) * sizeof(*parent->children));
        parent->keys[slot] = separator;
        parent->children[slot + 1] = right;
        parent->count++;
        if (parent->count <= BPT_KEYS)
            return 0;
        size_t middle = parent->count / 2;
        separator = parent->keys[middle];
        right = new_node(tree, 0);
        right->count = parent->count - middle - 1;
        memcpy(right->keys, parent->keys + middle + 1, right->count * sizeof(*right->keys));
        memcpy(right->children, parent->children + middle + 1,
               (right->count + 1) * sizeof(*right->children));
        parent->count = middle;
        left = parent;
    }
}
size_t mdb_bpt_memory(const mdb_bpt *tree) {
    return tree ? sizeof(*tree) + tree->nslabs * sizeof(node_slab) : 0;
}
int mdb_bpt_foreach(const mdb_bpt *tree, int (*visit)(int64_t, uint64_t, void *), void *context) {
    if (!tree || !visit)
        return -1;
    const bpt_node *node = tree->root;
    while (node && !node->leaf)
        node = node->children[0];
    while (node) {
        for (size_t i = 0; i < node->count; i++) {
            int code = visit(node->keys[i], node->offsets[i], context);
            if (code)
                return code;
        }
        node = node->next;
    }
    return 0;
}
typedef struct {
    size_t leaves, values, depth;
    const bpt_node *previous;
    int has_previous;
} validate_context;
static int validate_node(const bpt_node *node, int root, size_t depth, validate_context *context,
                         int64_t *minimum, int64_t *maximum) {
    if (!node || depth > BPT_HEIGHT_MAX || node->count > BPT_KEYS || node->count == 0)
        return 0;
    size_t lower = node->leaf ? (BPT_ORDER / 2) : ((BPT_ORDER + 1) / 2 - 1);
    if (!root && node->count < lower)
        return 0;
    for (size_t i = 1; i < node->count; i++)
        if (node->keys[i - 1] >= node->keys[i])
            return 0;
    if (node->leaf) {
        if (context->has_previous &&
            (context->depth != depth || context->previous->next != node ||
             context->previous->keys[context->previous->count - 1] >= node->keys[0]))
            return 0;
        context->has_previous = 1;
        context->previous = node;
        context->depth = depth;
        context->leaves++;
        context->values += node->count;
        *minimum = node->keys[0];
        *maximum = node->keys[node->count - 1];
        return 1;
    }
    int64_t previous_max = 0, submin = 0, submax = 0;
    for (size_t i = 0; i <= node->count; i++) {
        if (!validate_node(node->children[i], 0, depth + 1, context, &submin, &submax))
            return 0;
        if (i == 0)
            *minimum = submin;
        else if (previous_max >= submin || node->keys[i - 1] != submin)
            return 0;
        previous_max = submax;
    }
    *maximum = previous_max;
    return 1;
}
int mdb_bpt_validate(const mdb_bpt *tree) {
    if (!tree)
        return -1;
    if (!tree->root)
        return tree->size == 0 ? 0 : -1;
    validate_context context = {0};
    int64_t minimum = 0, maximum = 0;
    return validate_node(tree->root, 1, 0, &context, &minimum, &maximum) &&
                   context.values == tree->size && context.previous &&
                   context.previous->next == NULL
               ? 0
               : -1;
}
typedef struct {
    int64_t key;
    uint64_t offset;
} key_pair;
static int compare_pairs(const void *a, const void *b) {
    const key_pair *left = a, *right = b;
    return (left->key > right->key) - (left->key < right->key);
}
/* Bottom-up construction accepts arbitrary input order and rejects duplicates. */
mdb_bpt *mdb_bpt_bulk(const int64_t *keys, const uint64_t *offsets, size_t count) {
    if (count && (!keys || !offsets))
        return NULL;
    if (count > SIZE_MAX / sizeof(key_pair) || count > SIZE_MAX / sizeof(bpt_node *))
        return NULL;
    mdb_bpt *tree = mdb_bpt_create();
    if (!tree)
        return NULL;
    if (!count)
        return tree;
    key_pair *pairs = malloc(count * sizeof(*pairs));
    bpt_node **level = NULL, **next = NULL;
    if (!pairs)
        goto failure;
    for (size_t i = 0; i < count; i++) {
        pairs[i].key = keys[i];
        pairs[i].offset = offsets[i];
    }
    qsort(pairs, count, sizeof(*pairs), compare_pairs);
    for (size_t i = 1; i < count; i++)
        if (pairs[i - 1].key == pairs[i].key)
            goto failure;
    size_t nleaf = count / BPT_KEYS + (count % BPT_KEYS != 0);
    level = malloc(nleaf * sizeof(*level));
    if (!level || reserve_nodes(tree, nleaf))
        goto failure;
    size_t at = 0;
    for (size_t i = 0; i < nleaf; i++) {
        size_t n = count / nleaf + (i < count % nleaf);
        bpt_node *node = new_node(tree, 1);
        node->count = n;
        level[i] = node;
        for (size_t k = 0; k < n; k++, at++) {
            node->keys[k] = pairs[at].key;
            node->offsets[k] = pairs[at].offset;
        }
        if (i)
            level[i - 1]->next = node;
    }
    size_t nlevel = nleaf;
    while (nlevel > 1) {
        size_t parents = nlevel / BPT_ORDER + (nlevel % BPT_ORDER != 0);
        next = malloc(parents * sizeof(*next));
        if (!next || reserve_nodes(tree, parents))
            goto failure;
        size_t cursor = 0;
        for (size_t i = 0; i < parents; i++) {
            size_t children = nlevel / parents + (i < nlevel % parents);
            bpt_node *node = new_node(tree, 0);
            node->count = children - 1;
            next[i] = node;
            for (size_t k = 0; k < children; k++, cursor++) {
                bpt_node *child = level[cursor];
                node->children[k] = child;
                if (k) {
                    while (!child->leaf)
                        child = child->children[0];
                    node->keys[k - 1] = child->keys[0];
                }
            }
        }
        free(level);
        level = next;
        next = NULL;
        nlevel = parents;
    }
    tree->root = level[0];
    tree->size = count;
    free(level);
    free(pairs);
    return tree;
failure:
    free(next);
    free(level);
    free(pairs);
    mdb_bpt_free(tree);
    return NULL;
}
