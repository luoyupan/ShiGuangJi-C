#include "module_common.h"
#include <stdarg.h>

const SgjHostApi *g_host = NULL;
void mod_set_host(const SgjHostApi *h) { g_host = h; }

/* 资源在 dll 自己的 .rsrc 里（编译时由 build.ps1 生成 .rc） */
char *mod_load_resource(const wchar_t *name, size_t *out_len) {
  /* 注意：FindResourceW(NULL,…) 查的是 **exe** 的资源，不是调用者 dll 的 —— 必须拿本 dll 的句柄 */
  HMODULE self = NULL;
  GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                     (LPCWSTR)(const void *)&mod_load_resource, &self);
  HRSRC r = FindResourceW(self, name, RT_RCDATA);
  if (!r) { if (out_len) *out_len = 0; return NULL; }
  DWORD sz = SizeofResource(self, r);
  HGLOBAL g = LoadResource(self, r);
  if (!g) { if (out_len) *out_len = 0; return NULL; }
  void *p = LockResource(g);
  if (out_len) *out_len = sz;
  return (char *)p;
}

cJSON *mod_parse_args(const char *args_json) {
  cJSON *a = args_json ? cJSON_Parse(args_json) : NULL;
  return a ? a : cJSON_CreateArray();
}
cJSON *mod_arg_at(cJSON *args, int i) {
  return (args && cJSON_IsArray(args)) ? cJSON_GetArrayItem(args, i) : NULL;
}
cJSON *mod_store_get(const char *key) {
  if (!g_host || !g_host->store_get) return NULL;
  char *t = g_host->store_get(key);
  if (!t) return NULL;
  cJSON *v = cJSON_Parse(t);
  g_host->dealloc(t);
  return v;
}
void mod_store_set(const char *key, cJSON *v) {
  if (!g_host || !g_host->store_set) return;
  char *t = json_dumps(v);
  g_host->store_set(key, t);
  cJSON_free(t);
}
void mod_emit_json(const char *channel, const char *json) {
  if (g_host && g_host->emit) g_host->emit(channel, json ? json : "null");
}
void mod_emit(const char *channel, cJSON *payload) {
  char *t = json_dumps(payload);
  mod_emit_json(channel, t);
  cJSON_free(t);
  if (payload) cJSON_Delete(payload);
}
int mod_proc_running(const char *exe) {
  return (g_host && g_host->proc_running) ? g_host->proc_running(exe) : 0;
}
const char *mod_data_dir(void) { return (g_host && g_host->data_dir) ? g_host->data_dir() : ""; }
const char *mod_app_dir(void) { return (g_host && g_host->app_dir) ? g_host->app_dir() : ""; }

static char *host_dup(const char *s) {
  if (!g_host) return NULL;
  size_t n = strlen(s ? s : "");
  char *p = (char *)g_host->alloc(n + 1);
  if (p) memcpy(p, s ? s : "", n + 1);
  return p;
}

char *mod_res_dup(const wchar_t *name) {
  size_t n = 0;
  char *p = mod_load_resource(name, &n);
  if (!p) return NULL;
  char *c = (char *)malloc(n + 1);
  if (!c) return NULL;
  memcpy(c, p, n);
  c[n] = 0;
  return c;
}

char *mod_ret_json(cJSON *v) {
  char *t = v ? cJSON_PrintUnformatted(v) : NULL;
  if (!t) t = _strdup("null");
  char *r = host_dup(t);
  free(t);
  if (v) cJSON_Delete(v);
  return r;
}

char *mod_ret_error(const char *fmt, ...) {
  char msg[1024];
  va_list ap; va_start(ap, fmt);
  vsnprintf(msg, sizeof(msg), fmt, ap);
  va_end(ap);
  return host_dup(msg);
}

const char *mod_arg_str(cJSON *args, int i, const char *def) {
  cJSON *v = args ? cJSON_GetArrayItem(args, i) : NULL;
  return (v && cJSON_IsString(v) && v->valuestring) ? v->valuestring : def;
}
int mod_arg_int(cJSON *args, int i, int def) {
  cJSON *v = args ? cJSON_GetArrayItem(args, i) : NULL;
  if (cJSON_IsNumber(v)) return (int)v->valuedouble;
  if (cJSON_IsBool(v)) return cJSON_IsTrue(v) ? 1 : 0;
  if (cJSON_IsString(v) && v->valuestring) return atoi(v->valuestring);
  return def;
}
int mod_arg_bool(cJSON *args, int i, int def) {
  cJSON *v = args ? cJSON_GetArrayItem(args, i) : NULL;
  if (cJSON_IsBool(v)) return cJSON_IsTrue(v) ? 1 : 0;
  if (cJSON_IsNumber(v)) return v->valuedouble != 0;
  return def;
}
cJSON *mod_arg_obj(cJSON *args, int i) {
  cJSON *v = args ? cJSON_GetArrayItem(args, i) : NULL;
  return cJSON_IsObject(v) ? v : NULL;
}

char *mod_path_from_url(const char *s) {
  if (!s) return xstrdup("");
  const char *p = strstr(s, "/local/");
  if (p && (str_starts(s, "http://127.0.0.1:") || str_starts(s, "http://localhost:"))) {
    char *d = url_decode(p + 7);
    for (char *q = d; *q; q++) if (*q == '/') *q = '\\';
    if (d[0] == '\\' && d[1] && d[1] != '\\') memmove(d, d + 1, strlen(d));
    return d;
  }
  if (str_starts(s, "file:")) {
    char *d = xstrdup(s + 5);
    while (*d == '/') memmove(d, d + 1, strlen(d));
    char *dd = url_decode(d);
    free(d);
    for (char *q = dd; *q; q++) if (*q == '/') *q = '\\';
    return dd;
  }
  return xstrdup(s);
}
char *mod_path_from_arg(cJSON *args, int i) {
  return mod_path_from_url(mod_arg_str(args, i, ""));
}
char *mod_host_local(const char *path) {
  char *u = g_host && g_host->local_url ? g_host->local_url(path) : NULL;
  return u ? u : host_dup("");
}
int mod_str_in_array(const cJSON *arr, const char *s) {
  const cJSON *it = NULL;
  if (!cJSON_IsArray(arr)) return 0;
  cJSON_ArrayForEach(it, arr) if (cJSON_IsString(it) && !strcmp(it->valuestring, s)) return 1;
  return 0;
}
char *mod_read_file(const char *path, size_t *n) {
  char *c = file_read_text(path);
  if (c && n) *n = strlen(c);
  return c;
}
int mod_write_file(const char *path, const void *data, size_t n) {
  return file_write_all(path, data, n);
}
