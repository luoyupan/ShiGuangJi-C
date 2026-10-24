#ifndef SGJ_MODULE_COMMON_H
#define SGJ_MODULE_COMMON_H
#include "sgj.h"

extern const SgjHostApi *g_host;

void mod_set_host(const SgjHostApi *h);
char *mod_load_resource(const wchar_t *name, size_t *out_len);
char *mod_res_dup(const wchar_t *name);   /* 复制成 NUL 结尾（资源块本身不一定有结尾 0） */
cJSON *mod_parse_args(const char *args_json);
cJSON *mod_arg_at(cJSON *args, int i);
cJSON *mod_store_get(const char *key);      /* 深拷贝；没有返回 NULL */
void mod_store_set(const char *key, cJSON *v);
void mod_emit(const char *channel, cJSON *payload);
void mod_emit_json(const char *channel, const char *json);
int mod_proc_running(const char *exe);
const char *mod_data_dir(void);
const char *mod_app_dir(void);
char *mod_ret_json(cJSON *v);
char *mod_ret_error(const char *fmt, ...);
const char *mod_arg_str(cJSON *args, int i, const char *def);
int mod_arg_int(cJSON *args, int i, int def);
int mod_arg_bool(cJSON *args, int i, int def);
cJSON *mod_arg_obj(cJSON *args, int i);
char *mod_path_from_arg(cJSON *args, int i);
char *mod_path_from_url(const char *s);
char *mod_host_local(const char *path); /* 返回 host 分配的本地 URL */
int mod_str_in_array(const cJSON *arr, const char *s);
char *mod_read_file(const char *path, size_t *n);
int mod_write_file(const char *path, const void *data, size_t n);

#endif
