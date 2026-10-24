#ifndef SGJ_MODULES_H
#define SGJ_MODULES_H
#include "sgj.h"

typedef struct LoadedModule {
  HMODULE h;
  const SgjModule *mod;
  char *id;
  char *manifest_json;
  cJSON *manifest;
  char *renderer;
  char *style;
  char *file;
  int builtin;
  int enabled;
  int failed;
  char error[512];
  char *channels[24];
  int n_channels;
} LoadedModule;

int modules_init(const char *dir);
void modules_shutdown(void);
int modules_count(void);
LoadedModule *modules_at(int i);
LoadedModule *modules_find(const char *id);
int modules_total(void);
const char *modules_dir(void);

/* 路由一个 IPC 频道到某个 dll；返回 1 表示已处理 */
int modules_dispatch(const char *channel, const char *args_json, char **out_json, char **out_error);

/* 取模块内嵌的渲染层 JS / CSS（指针属于 dll，勿释放） */
const char *modules_renderer(const char *id, size_t *len);
const char *modules_style(const char *id, size_t *len);

/* 清单 / 插件表 */
cJSON *modules_list_json(void);
cJSON *plugins_list_json(void);
cJSON *hub_modules_json(void);
int plugins_set(const char *id, int on, char **err);
int plugins_reset(void);
int module_is_enabled(const char *id);

/* 宿主服务（供 hostapi.c 实现） */
const SgjHostApi *host_api(void);
void *host_alloc(size_t n);
void host_dealloc(void *p);

#endif
