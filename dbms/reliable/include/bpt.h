#ifndef MDB_BPT_H
#define MDB_BPT_H
#include <stddef.h>
#include <stdint.h>
typedef struct mdb_bpt mdb_bpt;
mdb_bpt *mdb_bpt_create(void);
void mdb_bpt_free(mdb_bpt *tree);
/* 0 success,1 duplicate,-1 allocation failure; failure leaves logical contents unchanged */
int mdb_bpt_insert(mdb_bpt *tree, int64_t key, uint64_t offset);
int mdb_bpt_search(const mdb_bpt *tree, int64_t key, uint64_t *offset);
int mdb_bpt_validate(const mdb_bpt *tree);
mdb_bpt *mdb_bpt_bulk(const int64_t *keys, const uint64_t *offsets, size_t count);
size_t mdb_bpt_memory(const mdb_bpt *tree);
/* callback returns nonzero to stop */
int mdb_bpt_foreach(const mdb_bpt *tree, int (*visit)(int64_t, uint64_t, void *), void *context);
#endif
