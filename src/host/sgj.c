#include "sgj.h"
#include <shlobj.h>
#include <shellapi.h>
#include <stdarg.h>
#include <ctype.h>
#include <errno.h>

/* ============================================================
 * Buf
 * ============================================================ */
void buf_init(Buf *b) { b->p = NULL; b->len = 0; b->cap = 0; }
void buf_free(Buf *b) { free(b->p); b->p = NULL; b->len = b->cap = 0; }
void buf_clear(Buf *b) { b->len = 0; if (b->p) b->p[0] = 0; }

void buf_reserve(Buf *b, size_t need) {
  if (b->len + need + 1 <= b->cap) return;
  size_t cap = b->cap ? b->cap : 256;
  while (cap < b->len + need + 1) cap = cap < 4096 ? cap * 2 : cap + cap / 2;
  b->p = (char *)xrealloc(b->p, cap);
  b->cap = cap;
}

void buf_add(Buf *b, const void *data, size_t n) {
  if (!n) return;
  buf_reserve(b, n);
  memcpy(b->p + b->len, data, n);
  b->len += n;
  b->p[b->len] = 0;
}

void buf_adds(Buf *b, const char *s) {
  if (!s) return;
  buf_add(b, s, strlen(s));
}

void buf_addc(Buf *b, char c) { buf_add(b, &c, 1); }

void buf_addf(Buf *b, const char *fmt, ...) {
  va_list ap, ap2;
  va_start(ap, fmt);
  va_copy(ap2, ap);
  int n = vsnprintf(NULL, 0, fmt, ap);
  va_end(ap);
  if (n > 0) {
    char *tmp = (char *)xmalloc((size_t)n + 1);
    vsnprintf(tmp, (size_t)n + 1, fmt, ap2);
    buf_add(b, tmp, (size_t)n);
    free(tmp);
  }
  va_end(ap2);
}

char *buf_take(Buf *b) {
  char *p;
  if (!b->p) { p = (char *)xmalloc(1); p[0] = 0; }
  else p = b->p;
  b->p = NULL;
  b->len = b->cap = 0;
  return p;
}

/* ============================================================
 * 内存 / 字符串
 * ============================================================ */
void *xmalloc(size_t n) {
  void *p = malloc(n ? n : 1);
  if (!p) { MessageBoxW(NULL, L"内存不足", L"拾光集", MB_ICONERROR); ExitProcess(1); }
  return p;
}
void *xcalloc(size_t n, size_t sz) {
  void *p = calloc(n ? n : 1, sz ? sz : 1);
  if (!p) { MessageBoxW(NULL, L"内存不足", L"拾光集", MB_ICONERROR); ExitProcess(1); }
  return p;
}
void *xrealloc(void *p, size_t n) {
  void *q = realloc(p, n ? n : 1);
  if (!q) { MessageBoxW(NULL, L"内存不足", L"拾光集", MB_ICONERROR); ExitProcess(1); }
  return q;
}
char *xstrdup(const char *s) {
  if (!s) s = "";
  size_t n = strlen(s);
  char *p = (char *)xmalloc(n + 1);
  memcpy(p, s, n + 1);
  return p;
}
char *xstrndup(const char *s, size_t n) {
  if (!s) return xstrdup("");
  size_t k = 0; while (k < n && s[k]) k++;
  char *p = (char *)xmalloc(k + 1);
  memcpy(p, s, k); p[k] = 0;
  return p;
}
int str_eq_ci(const char *a, const char *b) {
  if (!a || !b) return a == b;
  while (*a && *b) {
    if (tolower((unsigned char)*a) != tolower((unsigned char)*b)) return 0;
    a++; b++;
  }
  return *a == 0 && *b == 0;
}
int str_starts(const char *s, const char *prefix) {
  if (!s || !prefix) return 0;
  return strncmp(s, prefix, strlen(prefix)) == 0;
}
int str_ends_ci(const char *s, const char *suffix) {
  if (!s || !suffix) return 0;
  size_t n = strlen(s), m = strlen(suffix);
  if (m > n) return 0;
  return _stricmp(s + n - m, suffix) == 0;
}
void str_trim(char *s) {
  if (!s) return;
  char *p = s;
  while (*p && (unsigned char)*p <= ' ') p++;
  if (p != s) memmove(s, p, strlen(p) + 1);
  size_t n = strlen(s);
  while (n && (unsigned char)s[n - 1] <= ' ') s[--n] = 0;
}
char *str_lower(const char *s) {
  char *p = xstrdup(s ? s : "");
  for (char *q = p; *q; q++) *q = (char)tolower((unsigned char)*q);
  return p;
}

wchar_t *u8_to_w(const char *s) {
  if (!s) s = "";
  int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
  if (n <= 0) n = 1;
  wchar_t *w = (wchar_t *)xmalloc((size_t)n * sizeof(wchar_t));
  if (MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n) <= 0) w[0] = 0;
  return w;
}
char *w_to_u8(const wchar_t *s) {
  if (!s) return xstrdup("");
  int n = WideCharToMultiByte(CP_UTF8, 0, s, -1, NULL, 0, NULL, NULL);
  if (n <= 0) n = 1;
  char *p = (char *)xmalloc((size_t)n);
  if (WideCharToMultiByte(CP_UTF8, 0, s, -1, p, n, NULL, NULL) <= 0) p[0] = 0;
  return p;
}

/* ============================================================
 * 路径
 * ============================================================ */
int path_is_absolute(const char *p) {
  if (!p || !*p) return 0;
  if ((p[0] && p[1] == ':') || (p[0] == '\\' && p[1] == '\\') || p[0] == '/') return 1;
  return 0;
}
char *path_join(const char *a, const char *b) {
  if (!a || !*a) return xstrdup(b ? b : "");
  if (!b || !*b) return xstrdup(a);
  if (path_is_absolute(b)) return xstrdup(b);
  size_t la = strlen(a);
  int sep = (a[la - 1] == '\\' || a[la - 1] == '/');
  char *p = (char *)xmalloc(la + strlen(b) + 2);
  strcpy(p, a);
  if (!sep) strcat(p, "\\");
  strcat(p, b);
  return p;
}
char *path_norm(const char *p) {
  if (!p) return xstrdup("");
  char *q = xstrdup(p);
  for (char *s = q; *s; s++) if (*s == '/') *s = '\\';
  return q;
}
char *path_abs(const char *p) {
  if (!p || !*p) return xstrdup("");
  wchar_t *w = u8_to_w(p);
  wchar_t full[MAX_PATH * 2];
  DWORD n = GetFullPathNameW(w, (DWORD)(sizeof(full) / sizeof(full[0])), full, NULL);
  free(w);
  if (!n) return xstrdup(p);
  return w_to_u8(full);
}
char *path_dirname(const char *p) {
  if (!p || !*p) return xstrdup("");
  char *q = xstrdup(p);
  size_t n = strlen(q);
  while (n > 0 && q[n - 1] != '\\' && q[n - 1] != '/') n--;
  while (n > 0 && (q[n - 1] == '\\' || q[n - 1] == '/')) n--;
  q[n] = 0;
  return q;
}
const char *path_basename(const char *p) {
  if (!p) return "";
  const char *a = strrchr(p, '\\');
  const char *b = strrchr(p, '/');
  const char *s = a > b ? a : b;
  return s ? s + 1 : p;
}
const char *path_ext(const char *p) {
  const char *base = path_basename(p);
  const char *dot = strrchr(base, '.');
  return (dot && dot != base) ? dot + 1 : "";
}
int path_exists(const char *p) {
  wchar_t *w = u8_to_w(p);
  DWORD a = GetFileAttributesW(w);
  free(w);
  return a != INVALID_FILE_ATTRIBUTES;
}
int path_is_dir(const char *p) {
  wchar_t *w = u8_to_w(p);
  DWORD a = GetFileAttributesW(w);
  free(w);
  return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
}
int dir_exists(const char *p) { return path_is_dir(p); }
int dir_create(const char *p) {
  wchar_t *w = u8_to_w(p);
  BOOL ok = CreateDirectoryW(w, NULL);
  DWORD e = GetLastError();
  free(w);
  if (ok || e == ERROR_ALREADY_EXISTS) return 1;
  return 0;
}
int path_mkdirs(const char *p) {
  if (!p || !*p) return 0;
  char *norm = path_norm(p);
  size_t n = strlen(norm);
  for (size_t i = 3; i <= n; i++) {
    if (norm[i] == '\\' || norm[i] == 0) {
      char save = norm[i];
      norm[i] = 0;
      if (!path_exists(norm)) dir_create(norm);
      norm[i] = save;
    }
  }
  free(norm);
  return path_is_dir(p);
}
int file_read_all(const char *path, char **out, size_t *out_len) {
  *out = NULL;
  if (out_len) *out_len = 0;
  wchar_t *w = u8_to_w(path);
  HANDLE h = CreateFileW(w, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                         NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  free(w);
  if (h == INVALID_HANDLE_VALUE) return 0;
  LARGE_INTEGER sz;
  if (!GetFileSizeEx(h, &sz) || sz.QuadPart < 0 || sz.QuadPart > INT64_C(1) * 1024 * 1024 * 1024) { CloseHandle(h); return 0; }
  size_t n = (size_t)sz.QuadPart;
  char *p = (char *)xmalloc(n + 1);
  size_t got = 0;
  while (got < n) {
    DWORD r = 0;
    if (!ReadFile(h, p + got, (DWORD)(n - got > 1 << 20 ? 1 << 20 : n - got), &r, NULL) || !r) break;
    got += r;
  }
  CloseHandle(h);
  p[got] = 0;
  *out = p;
  if (out_len) *out_len = got;
  return 1;
}
char *file_read_text(const char *path) {
  char *p = NULL; size_t n = 0;
  if (!file_read_all(path, &p, &n)) return NULL;
  /* 去 BOM */
  if (n >= 3 && (unsigned char)p[0] == 0xEF && (unsigned char)p[1] == 0xBB && (unsigned char)p[2] == 0xBF) {
    memmove(p, p + 3, n - 3); p[n - 3] = 0;
  }
  return p;
}
int file_write_all(const char *path, const void *data, size_t n) {
  char *dir = path_dirname(path);
  if (dir && *dir) path_mkdirs(dir);
  free(dir);
  wchar_t *w = u8_to_w(path);
  HANDLE h = CreateFileW(w, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  free(w);
  if (h == INVALID_HANDLE_VALUE) return 0;
  const char *p = (const char *)data;
  size_t done = 0;
  while (done < n) {
    DWORD wr = 0;
    if (!WriteFile(h, p + done, (DWORD)(n - done > 1 << 20 ? 1 << 20 : n - done), &wr, NULL) || !wr) { CloseHandle(h); return 0; }
    done += wr;
  }
  CloseHandle(h);
  return 1;
}
int file_write_text_atomic(const char *path, const char *text) {
  char *dir = path_dirname(path);
  if (dir && *dir) path_mkdirs(dir);
  free(dir);
  size_t n = strlen(text);
  char *tmp = (char *)xmalloc(strlen(path) + 8);
  sprintf(tmp, "%s.tmp", path);
  if (!file_write_all(tmp, text, n)) { free(tmp); return 0; }
  wchar_t *wt = u8_to_w(tmp), *wp = u8_to_w(path);
  BOOL ok = MoveFileExW(wt, wp, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
  free(wt); free(wp); free(tmp);
  return ok ? 1 : 0;
}
int64_t file_size(const char *p) {
  wchar_t *w = u8_to_w(p);
  WIN32_FILE_ATTRIBUTE_DATA d;
  int64_t r = 0;
  if (GetFileAttributesExW(w, GetFileExInfoStandard, &d))
    r = ((int64_t)d.nFileSizeHigh << 32) | d.nFileSizeLow;
  free(w);
  return r;
}
int64_t file_mtime_ms(const char *p) {
  wchar_t *w = u8_to_w(p);
  WIN32_FILE_ATTRIBUTE_DATA d;
  int64_t r = 0;
  if (GetFileAttributesExW(w, GetFileExInfoStandard, &d)) {
    ULARGE_INTEGER u; u.LowPart = d.ftLastWriteTime.dwLowDateTime; u.HighPart = d.ftLastWriteTime.dwHighDateTime;
    r = (int64_t)(u.QuadPart / 10000ULL) - INT64_C(11644473600000);
  }
  free(w);
  return r;
}
int file_delete(const char *p) {
  wchar_t *w = u8_to_w(p);
  BOOL ok = DeleteFileW(w);
  free(w);
  return ok ? 1 : 0;
}
void open_path(const char *path) {
  wchar_t *w = u8_to_w(path);
  ShellExecuteW(NULL, L"open", w, NULL, NULL, SW_SHOWNORMAL);
  free(w);
}
void reveal_in_explorer(const char *path) {
  wchar_t *w = u8_to_w(path);
  wchar_t args[MAX_PATH * 2 + 16];
  swprintf(args, sizeof(args) / sizeof(args[0]), L"/select,\"%s\"", w);
  ShellExecuteW(NULL, L"open", L"explorer.exe", args, NULL, SW_SHOWNORMAL);
  free(w);
}
void open_url(const char *url) {
  wchar_t *w = u8_to_w(url);
  ShellExecuteW(NULL, L"open", w, NULL, NULL, SW_SHOWNORMAL);
  free(w);
}
char *exe_dir(void) {
  wchar_t w[MAX_PATH * 2];
  DWORD n = GetModuleFileNameW(NULL, w, (DWORD)(sizeof(w) / sizeof(w[0])));
  if (!n) return xstrdup(".");
  wchar_t *s = wcsrchr(w, L'\\');
  if (s) *s = 0;
  return w_to_u8(w);
}
char *special_folder(int csidl) {
  wchar_t w[MAX_PATH * 2];
  if (FAILED(SHGetFolderPathW(NULL, csidl, NULL, 0, w))) return xstrdup("");
  return w_to_u8(w);
}

/* ============================================================
 * 时间
 * ============================================================ */
int64_t now_ms(void) {
  FILETIME ft; GetSystemTimeAsFileTime(&ft);
  ULARGE_INTEGER u; u.LowPart = ft.dwLowDateTime; u.HighPart = ft.dwHighDateTime;
  return (int64_t)(u.QuadPart / 10000ULL) - INT64_C(11644473600000);
}
int64_t now_sec(void) { return now_ms() / 1000; }

static void ms_to_local(int64_t ms, SYSTEMTIME *st) {
  FILETIME ft;
  ULARGE_INTEGER u; u.QuadPart = (ULONGLONG)(ms + INT64_C(11644473600000)) * 10000ULL;
  ft.dwLowDateTime = u.LowPart; ft.dwHighDateTime = u.HighPart;
  FileTimeToLocalFileTime(&ft, &ft);
  FileTimeToSystemTime(&ft, st);
}
void local_time_str(int64_t ms, char *out, size_t n) {
  SYSTEMTIME st; ms_to_local(ms, &st);
  snprintf(out, n, "%04d-%02d-%02d %02d:%02d:%02d", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
}
void local_date_str(int64_t ms, char *out, size_t n) {
  SYSTEMTIME st; ms_to_local(ms, &st);
  snprintf(out, n, "%04d-%02d-%02d", st.wYear, st.wMonth, st.wDay);
}
int64_t local_day_start_ms(int64_t ms) {
  SYSTEMTIME st; ms_to_local(ms, &st);
  st.wHour = st.wMinute = st.wSecond = st.wMilliseconds = 0;
  FILETIME lft, ft;
  SystemTimeToFileTime(&st, &lft);
  LocalFileTimeToFileTime(&lft, &ft);
  ULARGE_INTEGER u; u.LowPart = ft.dwLowDateTime; u.HighPart = ft.dwHighDateTime;
  return (int64_t)(u.QuadPart / 10000ULL) - INT64_C(11644473600000);
}
int64_t local_day_start_ms_ymd(int y, int m, int d) {
  SYSTEMTIME st = {0};
  st.wYear = (WORD)y; st.wMonth = (WORD)m; st.wDay = (WORD)d;
  FILETIME lft, ft;
  SystemTimeToFileTime(&st, &lft);
  LocalFileTimeToFileTime(&lft, &ft);
  ULARGE_INTEGER u; u.LowPart = ft.dwLowDateTime; u.HighPart = ft.dwHighDateTime;
  return (int64_t)(u.QuadPart / 10000ULL) - INT64_C(11644473600000);
}

/* ============================================================
 * URL
 * ============================================================ */
static int is_unreserved(unsigned char c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
         c == '-' || c == '_' || c == '.' || c == '~';
}
char *url_encode(const char *s) {
  Buf b; buf_init(&b);
  for (const unsigned char *p = (const unsigned char *)(s ? s : ""); *p; p++) {
    if (is_unreserved(*p)) buf_addc(&b, (char)*p);
    else if (*p == ' ') buf_addc(&b, '%'), buf_addc(&b, '2'), buf_addc(&b, '0');
    else buf_addf(&b, "%%%02X", *p);
  }
  return buf_take(&b);
}
static int hexval(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
char *url_decode(const char *s) {
  Buf b; buf_init(&b);
  for (const char *p = s ? s : ""; *p; p++) {
    if (*p == '%' && p[1] && p[2] && hexval(p[1]) >= 0 && hexval(p[2]) >= 0) {
      buf_addc(&b, (char)(hexval(p[1]) * 16 + hexval(p[2])));
      p += 2;
    } else if (*p == '+') buf_addc(&b, ' ');
    else buf_addc(&b, *p);
  }
  return buf_take(&b);
}
char *url_encode_path(const char *path) {
  /* 文件路径中 / 和 : 保留可读性，其余按段编码；用 encodeURIComponent 风格 */
  Buf b; buf_init(&b);
  for (const unsigned char *p = (const unsigned char *)(path ? path : ""); *p; p++) {
    if (is_unreserved(*p) || *p == '/' || *p == ':') buf_addc(&b, (char)*p);
    else buf_addf(&b, "%%%02X", *p);
  }
  return buf_take(&b);
}
char *json_url_encode(const char *s) { return url_encode(s); }

/* ============================================================
 * JSON 辅助
 * ============================================================ */
cJSON *json_clone(const cJSON *v) { return v ? cJSON_Duplicate(v, 1) : NULL; }
cJSON *json_from_file(const char *path) {
  char *t = file_read_text(path);
  if (!t) return NULL;
  cJSON *v = cJSON_Parse(t);
  free(t);
  return v;
}
int json_to_file(const char *path, const cJSON *v) {
  char *t = cJSON_Print(v);
  if (!t) return 0;
  int ok = file_write_text_atomic(path, t);
  cJSON_free(t);
  return ok;
}
const char *json_str(const cJSON *obj, const char *key, const char *def) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
  return cJSON_IsString(v) && v->valuestring ? v->valuestring : def;
}
int json_int(const cJSON *obj, const char *key, int def) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
  if (cJSON_IsNumber(v)) return (int)v->valuedouble;
  if (cJSON_IsBool(v)) return cJSON_IsTrue(v) ? 1 : 0;
  return def;
}
double json_num(const cJSON *obj, const char *key, double def) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
  return cJSON_IsNumber(v) ? v->valuedouble : def;
}
int json_bool(const cJSON *obj, const char *key, int def) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
  if (cJSON_IsBool(v)) return cJSON_IsTrue(v) ? 1 : 0;
  if (cJSON_IsNumber(v)) return v->valuedouble != 0;
  return def;
}
void json_set_str(cJSON *obj, const char *key, const char *val) {
  cJSON_DeleteItemFromObjectCaseSensitive(obj, key);
  cJSON_AddStringToObject(obj, key, val ? val : "");
}
void json_set_int(cJSON *obj, const char *key, int64_t val) {
  cJSON_DeleteItemFromObjectCaseSensitive(obj, key);
  cJSON_AddNumberToObject(obj, key, (double)val);
}
void json_set_num(cJSON *obj, const char *key, double val) {
  cJSON_DeleteItemFromObjectCaseSensitive(obj, key);
  cJSON_AddNumberToObject(obj, key, val);
}
void json_set_bool(cJSON *obj, const char *key, int val) {
  cJSON_DeleteItemFromObjectCaseSensitive(obj, key);
  cJSON_AddBoolToObject(obj, key, val ? 1 : 0);
}
cJSON *json_array_of_strings(char **items, int n) {
  cJSON *a = cJSON_CreateArray();
  for (int i = 0; i < n; i++) cJSON_AddItemToArray(a, cJSON_CreateString(items[i] ? items[i] : ""));
  return a;
}
char *json_dumps(const cJSON *v) {
  if (!v) return xstrdup("null");
  char *t = cJSON_PrintUnformatted(v);
  return t ? t : xstrdup("null");
}
int json_array_contains(const cJSON *arr, const char *s) {
  const cJSON *it = NULL;
  cJSON_ArrayForEach(it, arr) if (cJSON_IsString(it) && strcmp(it->valuestring, s) == 0) return 1;
  return 0;
}
void json_deep_merge(cJSON *base, const cJSON *patch) {
  if (!base || !patch) return;
  if (cJSON_IsObject(base) && cJSON_IsObject(patch)) {
    const cJSON *it = NULL;
    cJSON_ArrayForEach(it, patch) {
      cJSON *ex = cJSON_GetObjectItemCaseSensitive(base, it->string);
      if (ex && cJSON_IsObject(ex) && cJSON_IsObject(it)) json_deep_merge(ex, it);
      else {
        cJSON *cp = cJSON_Duplicate(it, 1);
        if (ex) { cJSON_ReplaceItemInObjectCaseSensitive(base, it->string, cp); }
        else cJSON_AddItemToObject(base, it->string, cp);
      }
    }
  }
}

/* ============================================================
 * 日志
 * ============================================================ */
static FILE *g_logf = NULL;
static CRITICAL_SECTION g_logcs;
static int g_loginit = 0;
static char g_logpath[MAX_PATH * 2];

void log_init(const char *dir) {
  if (!g_loginit) { InitializeCriticalSection(&g_logcs); g_loginit = 1; }
  path_mkdirs(dir);
  snprintf(g_logpath, sizeof(g_logpath), "%s\\app.log", dir);
  /* 超过 4MB 轮转 */
  if (file_size(g_logpath) > 4 * 1024 * 1024) {
    char old[MAX_PATH * 2]; snprintf(old, sizeof(old), "%s.1", g_logpath);
    MoveFileExW(u8_to_w(g_logpath), u8_to_w(old), MOVEFILE_REPLACE_EXISTING);
  }
  g_logf = fopen(g_logpath, "ab");
}
void log_msg(int level, const char *fmt, ...) {
  char msg[4096];
  va_list ap; va_start(ap, fmt);
  vsnprintf(msg, sizeof(msg), fmt, ap);
  va_end(ap);
  static const char *tag[] = { "INFO", "WARN", "ERR " };
  char ts[64]; local_time_str(now_ms(), ts, sizeof(ts));
  char line[4300];
  snprintf(line, sizeof(line), "[%s] [%s] %s\n", ts, tag[level < 0 ? 0 : (level > 2 ? 2 : level)], msg);
  OutputDebugStringA(line);
  if (g_logf) {
    if (g_loginit) EnterCriticalSection(&g_logcs);
    fputs(line, g_logf); fflush(g_logf);
    if (g_loginit) LeaveCriticalSection(&g_logcs);
  }
}
void log_flush(void) { if (g_logf) fflush(g_logf); }
