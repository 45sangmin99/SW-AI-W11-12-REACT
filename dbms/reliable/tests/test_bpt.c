#include "bpt.h"
#include <assert.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#ifdef MDB_BPT_TEST_ALLOC
/* Test-only allocator state; the production tree has no global mutable state. */
static long allocation_budget = -1;
void *mdb_bpt_test_calloc(size_t n, size_t size) {
    if (allocation_budget == 0)
        return NULL;
    if (allocation_budget > 0)
        allocation_budget--;
    return calloc(n, size);
}
#endif
static uint64_t random_next(uint64_t *state) {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    return *state;
}
typedef struct {
    size_t count;
    int have;
    int64_t previous;
    uint64_t sum;
} iteration_state;
static int ordered_visit(int64_t key, uint64_t offset, void *context) {
    iteration_state *state = context;
    if (state->have)
        assert(state->previous < key);
    state->have = 1;
    state->previous = key;
    state->count++;
    state->sum += offset;
    return 0;
}
static int stop_visit(int64_t key, uint64_t offset, void *context) {
    (void)key;
    (void)offset;
    (void)context;
    return 9;
}
static void test_order(unsigned mode) {
    const size_t count = 8192;
    int64_t *keys = malloc(count * sizeof(*keys));
    uint64_t *offsets = malloc(count * sizeof(*offsets));
    assert(keys && offsets);
    uint64_t seed = UINT64_C(9123456789);
    for (size_t i = 0; i < count; i++)
        keys[i] = (int64_t)i - 4096;
    if (mode == 1) {
        for (size_t i = 0; i < count / 2; i++) {
            int64_t temporary = keys[i];
            keys[i] = keys[count - i - 1];
            keys[count - i - 1] = temporary;
        }
    }
    if (mode == 2) {
        for (size_t i = count; i > 1; i--) {
            size_t j = (size_t)(random_next(&seed) % i);
            int64_t temporary = keys[i - 1];
            keys[i - 1] = keys[j];
            keys[j] = temporary;
        }
    }
    mdb_bpt *tree = mdb_bpt_create();
    assert(tree && mdb_bpt_validate(tree) == 0);
    assert(!mdb_bpt_search(tree, 0, NULL));
    assert(mdb_bpt_foreach(tree, ordered_visit, &(iteration_state){0}) == 0);
    uint64_t expected_sum = 0;
    for (size_t i = 0; i < count; i++) {
        offsets[i] = (uint64_t)(keys[i] + 4096) * 17 + 11;
        expected_sum += offsets[i];
        assert(mdb_bpt_insert(tree, keys[i], offsets[i]) == 0);
        if (i < 512 || i % 127 == 0)
            assert(mdb_bpt_validate(tree) == 0);
    }
    assert(mdb_bpt_validate(tree) == 0);
    for (size_t i = 0; i < count; i++) {
        uint64_t result = 0;
        assert(mdb_bpt_search(tree, keys[i], &result) && result == offsets[i]);
    }
    size_t memory = mdb_bpt_memory(tree);
    assert(mdb_bpt_insert(tree, keys[count / 2], UINT64_MAX) == 1);
    assert(mdb_bpt_memory(tree) == memory);
    assert(mdb_bpt_validate(tree) == 0);
    uint64_t duplicate_offset = 0;
    assert(mdb_bpt_search(tree, keys[count / 2], &duplicate_offset) &&
           duplicate_offset == offsets[count / 2]);
    assert(!mdb_bpt_search(tree, INT64_MIN, NULL) && !mdb_bpt_search(tree, INT64_MAX, NULL));
    iteration_state iteration = {0};
    assert(mdb_bpt_foreach(tree, ordered_visit, &iteration) == 0);
    assert(iteration.count == count && iteration.sum == expected_sum);
    assert(mdb_bpt_foreach(tree, stop_visit, NULL) == 9);
    mdb_bpt *bulk = mdb_bpt_bulk(keys, offsets, count);
    assert(bulk && mdb_bpt_validate(bulk) == 0);
    for (size_t i = 0; i < count; i++) {
        uint64_t result = 0;
        assert(mdb_bpt_search(bulk, keys[i], &result) && result == offsets[i]);
    }
    iteration = (iteration_state){0};
    assert(mdb_bpt_foreach(bulk, ordered_visit, &iteration) == 0 && iteration.count == count &&
           iteration.sum == expected_sum);
    mdb_bpt_free(tree);
    mdb_bpt_free(bulk);
    free(keys);
    free(offsets);
}
static void test_boundaries_and_bulk_sizes(void) {
    const int64_t edges[] = {INT64_MIN, INT64_MIN + 1, -1, 0, 1, INT64_MAX - 1, INT64_MAX};
    mdb_bpt *tree = mdb_bpt_create();
    assert(tree);
    for (size_t i = 0; i < sizeof(edges) / sizeof(*edges); i++) {
        assert(!mdb_bpt_insert(tree, edges[i], (uint64_t)i));
        assert(mdb_bpt_validate(tree) == 0);
    }
    for (size_t i = 0; i < sizeof(edges) / sizeof(*edges); i++) {
        uint64_t value = 99;
        assert(mdb_bpt_search(tree, edges[i], &value) && value == i);
    }
    mdb_bpt_free(tree);
    int64_t keys[300];
    uint64_t offsets[300];
    for (size_t i = 0; i < 300; i++) {
        keys[i] = (int64_t)(300 - i);
        offsets[i] = (uint64_t)i;
    }
    for (size_t n = 0; n <= 300; n++) {
        tree = mdb_bpt_bulk(keys, offsets, n);
        assert(tree && mdb_bpt_validate(tree) == 0);
        iteration_state it = {0};
        assert(!mdb_bpt_foreach(tree, ordered_visit, &it) && it.count == n);
        mdb_bpt_free(tree);
    }
    const int64_t duplicate[] = {7, 3, 7};
    const uint64_t values[] = {1, 2, 3};
    assert(mdb_bpt_bulk(duplicate, values, 3) == NULL);
    assert(mdb_bpt_bulk(NULL, NULL, 1) == NULL);
    assert(mdb_bpt_validate(NULL) == -1);
    assert(mdb_bpt_insert(NULL, 1, 1) == -1);
    assert(!mdb_bpt_search(NULL, 1, NULL));
    mdb_bpt_free(NULL);
}
#ifdef MDB_BPT_TEST_ALLOC
static void test_allocation_failure(void) {
    allocation_budget = 0;
    assert(!mdb_bpt_create());
    allocation_budget = -1;
    mdb_bpt *tree = mdb_bpt_create();
    assert(tree);
    int observed = 0;
    for (int64_t key = 0; key < 10000; key++) {
        allocation_budget = 0;
        size_t memory = mdb_bpt_memory(tree);
        int rc = mdb_bpt_insert(tree, key, (uint64_t)key + 99);
        allocation_budget = -1;
        if (rc == -1) {
            observed++;
            assert(mdb_bpt_validate(tree) == 0);
            assert(mdb_bpt_memory(tree) == memory);
            assert(!mdb_bpt_search(tree, key, NULL));
            for (int64_t prior = 0; prior < key; prior++) {
                uint64_t offset = 0;
                assert(mdb_bpt_search(tree, prior, &offset) && offset == (uint64_t)prior + 99);
            }
            assert(mdb_bpt_insert(tree, key, (uint64_t)key + 99) == 0);
            assert(mdb_bpt_validate(tree) == 0);
            if (observed == 8)
                break;
        } else
            assert(rc == 0);
    }
    assert(observed == 8);
    mdb_bpt_free(tree);
    int64_t keys[600];
    uint64_t offsets[600];
    for (size_t i = 0; i < 600; i++) {
        keys[i] = (int64_t)i;
        offsets[i] = (uint64_t)i;
    }
    for (long budget = 0; budget < 6; budget++) {
        allocation_budget = budget;
        tree = mdb_bpt_bulk(keys, offsets, 600);
        allocation_budget = -1;
        if (tree) {
            assert(!mdb_bpt_validate(tree));
            mdb_bpt_free(tree);
        }
    }
}
#endif
int main(void) {
    test_order(0);
    test_order(1);
    test_order(2);
    test_boundaries_and_bulk_sizes();
#ifdef MDB_BPT_TEST_ALLOC
    test_allocation_failure();
#endif
    puts(
        "B+ tree tests passed (sequential/reverse/random, bottom-up bulk, boundaries, invariants)");
    return 0;
}
