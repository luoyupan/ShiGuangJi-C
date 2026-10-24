#ifndef SGJ_STORE_H
#define SGJ_STORE_H
#include "sgj.h"

int store_init(const char *data_dir);
cJSON *store_get(const char *key);            /* 深拷贝 */
char *store_get_text(const char *key);        /* JSON 文本 */
void store_set(const char *key, const cJSON *val);
void store_merge(const char *key, const cJSON *patch);
void store_flush(void);
cJSON *store_snapshot(void);
const char *store_path(void);
const char *store_data_dir(void);
int store_ready(void);

#endif
