/* ============================================================
 * 拾光集 · C 版宿主公共头文件 (sgj.h)
 * ------------------------------------------------------------
 * 纯 C11 + Win32。字符串一律 UTF-8（Windows API 边界转 UTF-16）。
 * ============================================================ */
#ifndef SGJ_H
#define SGJ_H

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#ifndef _CRT_SECURE_NO_WARNINGS
#define _CRT_SECURE_NO_WARNINGS
#endif
#ifndef CINTERFACE
#define CINTERFACE
#endif
#ifndef COBJMACROS
#define COBJMACROS
#endif
#include <windows.h>
#include <objbase.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <time.h>
#include <ctype.h>
#include <math.h>

#ifdef _MSC_VER
#ifndef strtok_r
#define strtok_r strtok_s
#endif
#endif

/* MIDL 生成的 C 头文件用 `interface` 作 struct 的别名（C++ 里才是关键字） */
#ifndef __cplusplus
#ifndef interface
#define interface struct
#endif
#endif

#include "cJSON.h"

#ifndef cJSON_ForEach
#define cJSON_ForEach(el, arr) cJSON_ArrayForEach(el, arr)
#endif

#define SGJ_APP_NAME "拾光集"
#define SGJ_APP_ID "ShiGuangJi"
#define SGJ_VERSION "1.1.0"
#define SGJ_ABI 2

/* ---------------- 动态字符串 ---------------- */
typedef struct {
  char *p;
  size_t len, cap;
} Buf;

void buf_init(Buf *b);
void buf_free(Buf *b);
void buf_clear(Buf *b);
void buf_reserve(Buf *b, size_t need);
void buf_add(Buf *b, const void *data, size_t n);
void buf_adds(Buf *b, const char *s);
void buf_addc(Buf *b, char c);
void buf_addf(Buf *b, const char *fmt, ...);
char *buf_take(Buf *b); /* 交出所有权（NUL 结尾） */

/* ---------------- 内存 / 字符串 ---------------- */
void *xmalloc(size_t n);
void *xcalloc(size_t n, size_t sz);
void *xrealloc(void *p, size_t n);
char *xstrdup(const char *s);
char *xstrndup(const char *s, size_t n);
int str_eq_ci(const char *a, const char *b);
int str_starts(const char *s, const char *prefix);
int str_ends_ci(const char *s, const char *suffix);
void str_trim(char *s);
char *str_lower(const char *s);

/* UTF-8 / UTF-16 */
wchar_t *u8_to_w(const char *s);
char *w_to_u8(const wchar_t *s);

/* ---------------- 路径 / 文件 ---------------- */
char *path_join(const char *a, const char *b);
char *path_dirname(const char *p);
const char *path_basename(const char *p);
const char *path_ext(const char *p);
int path_exists(const char *p);
int path_is_dir(const char *p);
int path_mkdirs(const char *p);
int file_read_all(const char *path, char **out, size_t *out_len);
char *file_read_text(const char *path);
int file_write_all(const char *path, const void *data, size_t n);
int file_write_text_atomic(const char *path, const char *text);
int64_t file_size(const char *p);
int64_t file_mtime_ms(const char *p);
int file_delete(const char *p);
int dir_exists(const char *p);
int dir_create(const char *p);
int path_is_absolute(const char *p);
char *path_abs(const char *p);
char *path_norm(const char *p);
void reveal_in_explorer(const char *path);
void open_path(const char *path);
void open_url(const char *url);
char *exe_dir(void);
char *special_folder(int csidl);

/* ---------------- 时间 ---------------- */
int64_t now_ms(void);
int64_t now_sec(void);
/* 本地墙钟 "YYYY-MM-DD HH:MM:SS" */
void local_time_str(int64_t ms, char *out, size_t n);
void local_date_str(int64_t ms, char *out, size_t n);
/* 本地日期（当天 0 点）毫秒 */
int64_t local_day_start_ms(int64_t ms);
int64_t local_day_start_ms_ymd(int y, int m, int d);

/* ---------------- URI ---------------- */
char *url_encode(const char *s);
char *url_decode(const char *s);
char *url_encode_path(const char *path); /* 文件路径 → /local 用的编码 */
char *json_url_encode(const char *s);

/* ---------------- JSON 辅助 ---------------- */
cJSON *json_from_file(const char *path);
int json_to_file(const char *path, const cJSON *v);
cJSON *json_clone(const cJSON *v);
const char *json_str(const cJSON *obj, const char *key, const char *def);
int json_int(const cJSON *obj, const char *key, int def);
double json_num(const cJSON *obj, const char *key, double def);
int json_bool(const cJSON *obj, const char *key, int def);
void json_set_str(cJSON *obj, const char *key, const char *val);
void json_set_int(cJSON *obj, const char *key, int64_t val);
void json_set_num(cJSON *obj, const char *key, double val);
void json_set_bool(cJSON *obj, const char *key, int val);
cJSON *json_array_of_strings(char **items, int n);
char *json_dumps(const cJSON *v);
int json_array_contains(const cJSON *arr, const char *s);
void json_deep_merge(cJSON *base, const cJSON *patch);

/* ---------------- 日志 ---------------- */
void log_init(const char *dir);
void log_msg(int level, const char *fmt, ...); /* 0=info 1=warn 2=error/debug */
void log_flush(void);
#define LOGI(...) log_msg(0, __VA_ARGS__)
#define LOGW(...) log_msg(1, __VA_ARGS__)
#define LOGE(...) log_msg(2, __VA_ARGS__)

/* ---------------- 全局窗口 / 服务 ---------------- */
HWND sgj_main_window(void);
const char *sgj_data_dir(void);
const char *sgj_app_dir(void);
const char *sgj_token(void);
const char *sgj_base_url(void); /* http://127.0.0.1:port/token */
int sgj_is_dev(void);

/* ---------------- 事件总线（SSE 推送） ---------------- */
void bus_emit_json(const char *channel, const char *payload_json);
void bus_emit(const char *channel, cJSON *payload /* 转移所有权 */);

/* ---------------- 模块 API ---------------- */
typedef struct SgjHostApi SgjHostApi;
struct SgjHostApi {
  int abi;
  void *(*alloc)(size_t);
  void (*dealloc)(void *);
  void (*log)(int level, const char *msg);

  char *(*read_text)(const char *path);
  int (*write_text)(const char *path, const char *text);
  int (*file_exists)(const char *path);
  int (*ensure_dir)(const char *path);
  const char *(*data_dir)(void);
  const char *(*app_dir)(void);

  /* method: GET/POST...; 返回响应体（alloc 分配）；headers 可为 NULL；status 可为 NULL */
  char *(*http_request)(const char *method, const char *url, const char *headers,
                        const void *body, size_t body_len, int timeout_ms,
                        int *status, size_t *out_len);

  char *(*store_get)(const char *key);
  void (*store_set)(const char *key, const char *json);
  void (*store_merge)(const char *key, const char *json);

  void (*emit)(const char *channel, const char *json);

  char *(*pick_folder)(int multi, const char *title);
  char *(*pick_file)(const char *filter, int save, const char *default_name);
  int (*message_box)(const char *title, const char *text, int yes_no);

  void (*open_path)(const char *path);
  void (*open_url)(const char *url);
  void (*reveal)(const char *path);
  void (*notify)(const char *title, const char *msg);

  int (*proc_running)(const char *exe);
  int (*run_command)(const char *cmdline, int wait);

  /* 把本地路径变成前端可用的 URL（http://.../local/...），返回 alloc 字符串 */
  char *(*local_url)(const char *path);
};

typedef struct SgjModule SgjModule;
struct SgjModule {
  int abi;
  const char *id;
  const char *manifest_json;
  const char *renderer_js;
  const char *style_css;
  int (*init)(const SgjHostApi *host);
  void (*shutdown)(void);
  /* 返回 0 成功；*out_json 由模块用 host->alloc 分配；失败时 *out_error 同 */
  int (*invoke)(const char *channel, const char *args_json, char **out_json, char **out_error);
};

typedef const SgjModule *(*SgjEntryFn)(void);

/* 模块必备导出 */
#define SGJ_MODULE_EXPORT __declspec(dllexport)

#endif /* SGJ_H */
