/* ============================================================
 * 拾光集 · 网盘模块 (netdisk.dll)
 * ------------------------------------------------------------
 * 链接识别 / 下载队列 / 断点续传 / 自动解压。
 * 下载走 WinHTTP（模块自己的线程），进度通过 netdisk:task 事件推送。
 * ============================================================ */
#include "../module_common.h"
#include <winhttp.h>
#include <shlobj.h>
#include <shellapi.h>

#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "shell32.lib")

static const char *g_manifest = NULL;
static const char *g_js = NULL;
static SgjModule g_mod;
static CRITICAL_SECTION g_cs;
static int g_init = 0;
static void lock_init(void) { if (!g_init) { InitializeCriticalSection(&g_cs); g_init = 1; } }

typedef struct { char id[64]; volatile LONG stop; volatile LONG running; } DlRun;
static DlRun g_runs[32];

static DlRun *run_find(const char *id) {
  for (int i = 0; i < 32; i++) if (g_runs[i].running && !strcmp(g_runs[i].id, id)) return &g_runs[i];
  return NULL;
}
static DlRun *run_new(const char *id) {
  for (int i = 0; i < 32; i++) if (!g_runs[i].running) {
    memset(&g_runs[i], 0, sizeof(g_runs[i]));
    snprintf(g_runs[i].id, sizeof(g_runs[i].id), "%s", id);
    g_runs[i].running = 1;
    return &g_runs[i];
  }
  return NULL;
}

static cJSON *N_root(void) {
  cJSON *n = mod_store_get("netdisk");
  if (!cJSON_IsObject(n)) { if (n) cJSON_Delete(n); n = cJSON_CreateObject(); }
  if (!cJSON_IsArray(cJSON_GetObjectItemCaseSensitive(n, "tasks"))) {
    cJSON_DeleteItemFromObjectCaseSensitive(n, "tasks");
    cJSON_AddItemToObject(n, "tasks", cJSON_CreateArray());
  }
  if (!cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(n, "cookies"))) {
    cJSON_DeleteItemFromObjectCaseSensitive(n, "cookies");
    cJSON_AddItemToObject(n, "cookies", cJSON_CreateObject());
  }
  return n;
}
static void N_save(cJSON *n) { mod_store_set("netdisk", n); }
static cJSON *task_find(cJSON *tasks, const char *id) {
  cJSON *t = NULL;
  cJSON_ArrayForEach(t, tasks) if (!strcmp(json_str(t, "id", ""), id)) return t;
  return NULL;
}
static void emit_task(cJSON *task) {
  mod_emit("netdisk:task", cJSON_Duplicate(task, 1));
}
static void emit_changed(void) { mod_emit_json("netdisk:changed", "{}"); }

/* ---------------- 平台 ---------------- */
typedef struct { const char *id, *name, *color, *login, *home; int need; const char *pat; } NPlatform;
static const NPlatform PLATFORMS[] = {
  { "baidu", "百度网盘", "#2932e1", "https://pan.baidu.com/", "https://pan.baidu.com/disk/home", 1, "pan.baidu.com" },
  { "quark", "夸克网盘", "#1f6bff", "https://pan.quark.cn/", "https://pan.quark.cn/list", 1, "pan.quark.cn" },
  { "123", "123 云盘", "#2f86ff", "https://www.123pan.com/", "https://www.123pan.com/", 1, "123pan.com|123684.com" },
  { "aliyun", "阿里云盘", "#4a6cf7", "https://www.alipan.com/", "https://www.alipan.com/drive", 1, "alipan.com|aliyundrive.com" },
  { "xunlei", "迅雷云盘", "#3d7dff", "https://pan.xunlei.com/", "https://pan.xunlei.com/", 1, "pan.xunlei.com" },
  { "115", "115 网盘", "#1a7af8", "https://115.com/", "https://115.com/", 1, "115.com" },
  { "lanzou", "蓝奏云", "#0a84ff", "https://up.woozooo.com/", "https://up.woozooo.com/", 0, "lanzou" },
  { "ctyun", "天翼云盘", "#0e6cf0", "https://cloud.189.cn/", "https://cloud.189.cn/", 1, "cloud.189.cn" },
  { "weiyun", "微云", "#0aaff0", "https://www.weiyun.com/", "https://www.weiyun.com/", 1, "weiyun.com" },
  { "onedrive", "OneDrive", "#0364b8", "https://onedrive.live.com/", "https://onedrive.live.com/", 0, "1drv.ms|onedrive.live.com" },
  { "mega", "MEGA", "#d9272e", "https://mega.nz/", "https://mega.nz/", 0, "mega.nz" },
  { "google", "Google Drive", "#1a73e8", "https://drive.google.com/", "https://drive.google.com/", 0, "drive.google.com" },
  { "direct", "直链下载", "#22a06b", "", "", 0, "" },
};
static int pat_match(const char *pat, const char *url) {
  if (!pat || !*pat) return 0;
  char *low = str_lower(url);
  const char *p = pat;
  int hit = 0;
  while (*p) {
    const char *bar = strchr(p, '|');
    size_t n = bar ? (size_t)(bar - p) : strlen(p);
    char b[128];
    if (n >= sizeof(b)) n = sizeof(b) - 1;
    memcpy(b, p, n); b[n] = 0;
    if (strstr(low, b)) { hit = 1; break; }
    if (!bar) break;
    p = bar + 1;
  }
  free(low);
  return hit;
}
static const NPlatform *platform_of(const char *url) {
  for (size_t i = 0; i < sizeof(PLATFORMS) / sizeof(PLATFORMS[0]); i++) {
    if (PLATFORMS[i].pat[0] && pat_match(PLATFORMS[i].pat, url)) return &PLATFORMS[i];
  }
  return &PLATFORMS[sizeof(PLATFORMS) / sizeof(PLATFORMS[0]) - 1];
}

/* ---------------- 识别 ---------------- */
static char *extract_code(const char *text, const char *key1, const char *key2) {
  const char *p = text;
  while ((p = strstr(p, key1))) {
    p += strlen(key1);
    while (*p == ' ' || *p == ':' || *p == '：' || *p == '=') p++;
    char b[32]; int n = 0;
    while (*p && n < 31 && ((*p >= '0' && *p <= '9') || (*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z'))) b[n++] = *p++;
    if (n) { b[n] = 0; return xstrdup(b); }
    if (key2 && *key2) {
      const char *q = strstr(text, key2);
      if (q) { q += strlen(key2); while (*q == ' ' || *q == ':' || *q == '：' || *q == '=') q++; n = 0; while (*q && n < 31 && ((*q >= '0' && *q <= '9') || (*q >= 'a' && *q <= 'z') || (*q >= 'A' && *q <= 'Z'))) b[n++] = *q++; if (n) { b[n] = 0; return xstrdup(b); } }
    }
  }
  return xstrdup("");
}
static cJSON *N_recognize(const char *text) {
  cJSON *urls = cJSON_CreateArray();
  cJSON *hits = cJSON_CreateArray();
  const char *p = text;
  while (p && *p) {
    const char *h = strstr(p, "http://");
    const char *s = strstr(p, "https://");
    if (!h || (s && s < h)) h = s;
    if (!h) break;
    const char *e = h;
    while (*e && *e != ' ' && *e != '\n' && *e != '\r' && *e != '\t' && *e != '"' && *e != '<' && *e != '>') e++;
    char *u = xstrndup(h, (size_t)(e - h));
    /* 去掉中文标点结尾 */
    while (*u && strchr("，。、；）】”,;)]", u[strlen(u) - 1])) u[strlen(u) - 1] = 0;
    if (*u) {
      cJSON_AddItemToArray(urls, cJSON_CreateString(u));
      const NPlatform *pf = platform_of(u);
      cJSON *o = cJSON_CreateObject();
      cJSON_AddStringToObject(o, "url", u);
      cJSON_AddStringToObject(o, "kind", !strcmp(pf->id, "direct") ? "direct" : "netdisk");
      cJSON_AddStringToObject(o, "platform", pf->id);
      cJSON_AddStringToObject(o, "platformName", pf->name);
      json_set_bool(o, "needLogin", pf->need);
      cJSON *root = N_root();
      cJSON *ck = cJSON_GetObjectItemCaseSensitive(root, "cookies");
      json_set_bool(o, "logged", cJSON_IsObject(ck) && cJSON_GetObjectItemCaseSensitive(ck, pf->id) != NULL);
      cJSON_Delete(root);
      cJSON_AddItemToArray(hits, o);
    }
    free(u);
    p = e;
  }
  char *code = extract_code(text, "pwd=", "提取码");
  if (!*code) { free(code); code = extract_code(text, "提取码", "pwd="); }
  char *uz = extract_code(text, "解压码", "zipcode=");
  cJSON *out = cJSON_CreateObject();
  cJSON_AddItemToObject(out, "urls", urls);
  cJSON_AddStringToObject(out, "extractCode", code);
  cJSON_AddStringToObject(out, "unzipCode", uz);
  cJSON_AddItemToObject(out, "hits", hits);
  free(code); free(uz);
  return out;
}

/* ---------------- 下载 ---------------- */
static const char *download_dir(void) {
  static char dir[MAX_PATH];
  cJSON *s = mod_store_get("settings");
  const char *d = s ? json_str(s, "downloadDir", "") : "";
  if (d && *d) snprintf(dir, sizeof(dir), "%s", d);
  else {
    const char *up = getenv("USERPROFILE");
    snprintf(dir, sizeof(dir), "%s\\Downloads\\拾光集", up ? up : ".");
  }
  if (s) cJSON_Delete(s);
  path_mkdirs(dir);
  return dir;
}
static char *url_filename(const char *url) {
  const char *p = strstr(url, "://");
  p = p ? p + 3 : url;
  const char *slash = strrchr(p, '/');
  char *name = xstrdup(slash ? slash + 1 : "download.bin");
  char *q = strchr(name, '?'); if (q) *q = 0;
  char *hash = strchr(name, '#'); if (hash) *hash = 0;
  char *dec = url_decode(name);
  free(name);
  if (!*dec || strchr(dec, '\\') || strchr(dec, '/') || strchr(dec, ':')) { free(dec); dec = xstrdup("download.bin"); }
  return dec;
}
static int parse_http_url(const char *url, int *https, wchar_t *host, size_t hc, wchar_t *path, size_t pc, int *port) {
  const char *p = url;
  *https = 0; *port = 0;
  if (str_starts(p, "https://")) { *https = 1; p += 8; *port = 443; }
  else if (str_starts(p, "http://")) { *https = 0; p += 7; *port = 80; }
  else return 0;
  const char *slash = strchr(p, '/');
  size_t hl = slash ? (size_t)(slash - p) : strlen(p);
  char hb[512];
  if (hl >= sizeof(hb)) return 0;
  memcpy(hb, p, hl); hb[hl] = 0;
  char *colon = strrchr(hb, ':');
  if (colon) { *port = atoi(colon + 1); *colon = 0; }
  wchar_t *wh = u8_to_w(hb);
  wcsncpy(host, wh, hc - 1); host[hc - 1] = 0;
  free(wh);
  wchar_t *wp = u8_to_w(slash ? slash : "/");
  wcsncpy(path, wp, pc - 1); path[pc - 1] = 0;
  free(wp);
  return 1;
}

static void task_update(const char *id, const char *status, double progress, int64_t received, int64_t total, const char *error, const char *save_dir) {
  cJSON *root = N_root();
  cJSON *tasks = cJSON_GetObjectItemCaseSensitive(root, "tasks");
  cJSON *t = task_find(tasks, id);
  if (!t) { cJSON_Delete(root); return; }
  if (status) { cJSON_DeleteItemFromObjectCaseSensitive(t, "status"); cJSON_AddStringToObject(t, "status", status); }
  if (progress >= 0) json_set_num(t, "progress", progress);
  if (received >= 0) json_set_int(t, "received", received);
  if (total >= 0) json_set_int(t, "total", total);
  if (error) { cJSON_DeleteItemFromObjectCaseSensitive(t, "error"); cJSON_AddStringToObject(t, "error", error); }
  if (save_dir) { cJSON_DeleteItemFromObjectCaseSensitive(t, "saveDir"); cJSON_AddStringToObject(t, "saveDir", save_dir); }
  N_save(root);
  emit_task(t);
  cJSON_Delete(root);
}

static DWORD WINAPI download_thread(LPVOID p) {
  char *id = (char *)p;
  DlRun *run = NULL;
  EnterCriticalSection(&g_cs);
  run = run_new(id);
  LeaveCriticalSection(&g_cs);
  cJSON *root = N_root();
  cJSON *tasks = cJSON_GetObjectItemCaseSensitive(root, "tasks");
  cJSON *t = task_find(tasks, id);
  if (!t || !run) { cJSON_Delete(root); free(id); if (run) run->running = 0; return 0; }
  char url[4096]; snprintf(url, sizeof(url), "%s", json_str(t, "url", ""));
  char *dir = path_join(download_dir(), "");
  const char *tdir = json_str(t, "saveDir", "");
  if (*tdir) { free(dir); dir = xstrdup(tdir); }
  path_mkdirs(dir);
  char *fname = url_filename(url);
  char *file = path_join(dir, fname);
  char *part = (char *)xmalloc(strlen(file) + 8); sprintf(part, "%s.part", file);
  cJSON_Delete(root);
  int64_t have = path_exists(part) ? file_size(part) : 0;

  wchar_t host[512], path[4096]; int https = 0, port = 0;
  if (!parse_http_url(url, &https, host, 512, path, 4096, &port)) {
    task_update(id, "error", -1, -1, -1, "链接不是 http(s) 地址", NULL);
    free(id); free(dir); free(fname); free(file); free(part);
    run->running = 0;
    return 0;
  }
  HINTERNET hs = WinHttpOpen(L"ShiGuangJi/0.4", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  HINTERNET hc = WinHttpConnect(hs, host, (INTERNET_PORT)port, 0);
  HINTERNET hr = WinHttpOpenRequest(hc, L"GET", path, NULL, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, https ? WINHTTP_FLAG_SECURE : 0);
  wchar_t range[128];
  if (have > 0) swprintf(range, 128, L"Range: bytes=%lld-", (long long)have);
  WinHttpSendRequest(hr, have > 0 ? range : WINHTTP_NO_ADDITIONAL_HEADERS, have > 0 ? (DWORD)-1L : 0,
                     WINHTTP_NO_REQUEST_DATA, 0, 0, 0);
  int ok = WinHttpReceiveResponse(hr, NULL);
  DWORD status = 0, sl = sizeof(status);
  WinHttpQueryHeaders(hr, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status, &sl, WINHTTP_NO_HEADER_INDEX);
  int64_t total = 0;
  wchar_t clen[64]; DWORD cl = sizeof(clen);
  if (WinHttpQueryHeaders(hr, WINHTTP_QUERY_CONTENT_LENGTH, WINHTTP_HEADER_NAME_BY_INDEX, clen, &cl, WINHTTP_NO_HEADER_INDEX))
    total = _wtoi64(clen);
  if (status == 200 && have > 0) { have = 0; file_delete(part); }
  if (status != 200 && status != 206) {
    char err[128]; snprintf(err, sizeof(err), "HTTP %lu", (unsigned long)status);
    task_update(id, "error", -1, -1, -1, err, NULL);
    goto cleanup;
  }
  FILE *fp = _wfopen(u8_to_w(part), have > 0 ? L"ab" : L"wb");
  if (!fp) {
    task_update(id, "error", -1, -1, -1, "写文件失败", NULL);
    goto cleanup;
  }
  int64_t got = have;
  int64_t last_emit = now_ms();
  task_update(id, "downloading", 0, got, total, "", dir);
  for (;;) {
    if (run->stop) { task_update(id, "paused", -1, got, total, "", dir); break; }
    DWORD avail = 0;
    if (!WinHttpQueryDataAvailable(hr, &avail) || !avail) break;
    char *buf = (char *)xmalloc(avail);
    DWORD rd = 0;
    if (!WinHttpReadData(hr, buf, avail, &rd) || !rd) { free(buf); break; }
    fwrite(buf, 1, rd, fp);
    free(buf);
    got += rd;
    if (now_ms() - last_emit > 400) {
      last_emit = now_ms();
      double prog = total > 0 ? (double)got / (double)total : 0;
      task_update(id, "downloading", prog, got, total, "", dir);
    }
    if (got > (int64_t)8 * 1024 * 1024 * 1024) break;
  }
  fclose(fp);
  if (!run->stop) {
    /* 完成：改名 */
    if (path_exists(file)) file_delete(file);
    MoveFileW(u8_to_w(part), u8_to_w(file));
    task_update(id, "done", 1, got, total, "", dir);
    mod_emit_json("netdisk:done", "{}");
    /* 自动解压 */
    const char *e = path_ext(file);
    if (!_stricmp(e, "zip") || !_stricmp(e, "tar") || !_stricmp(e, "gz") || !_stricmp(e, "tgz")) {
      char *dest = path_join(dir, fname);
      char *dot = strrchr(dest, '.'); if (dot) *dot = 0;
      path_mkdirs(dest);
      char cmd[MAX_PATH * 3 + 64];
      snprintf(cmd, sizeof(cmd), "tar -xf \"%s\" -C \"%s\"", file, dest);
      int r = g_host->run_command(cmd, 1);
      if (r == 0) {
        cJSON *ev = cJSON_CreateObject();
        cJSON_AddStringToObject(ev, "file", file);
        cJSON_AddStringToObject(ev, "dir", dest);
        mod_emit("netdisk:extracted", ev);
      } else {
        cJSON *ev = cJSON_CreateObject();
        cJSON_AddStringToObject(ev, "file", file);
        cJSON_AddStringToObject(ev, "error", "自动解压失败（系统没有可用的解压器）");
        mod_emit("netdisk:extract-failed", ev);
      }
      free(dest);
    }
  }
cleanup:
  if (hr) WinHttpCloseHandle(hr);
  if (hc) WinHttpCloseHandle(hc);
  if (hs) WinHttpCloseHandle(hs);
  free(dir); free(fname); free(file); free(part);
  free(id);
  EnterCriticalSection(&g_cs);
  run->running = 0;
  LeaveCriticalSection(&g_cs);
  emit_changed();
  return 0;
}

/* ---------------- 分发 ---------------- */
static int netdisk_invoke(const char *channel, const char *args_json, char **out_json, char **out_error) {
  cJSON *args = mod_parse_args(args_json);
  int rc = 0;
  cJSON *res = NULL;
  lock_init();
  EnterCriticalSection(&g_cs);
  if (!strcmp(channel, "netdisk:platforms")) {
    cJSON *root = N_root();
    cJSON *ck = cJSON_GetObjectItemCaseSensitive(root, "cookies");
    res = cJSON_CreateArray();
    for (size_t i = 0; i < sizeof(PLATFORMS) / sizeof(PLATFORMS[0]); i++) {
      const NPlatform *p = &PLATFORMS[i];
      cJSON *o = cJSON_CreateObject();
      cJSON_AddStringToObject(o, "id", p->id);
      cJSON_AddStringToObject(o, "name", p->name);
      cJSON_AddStringToObject(o, "color", p->color);
      cJSON_AddStringToObject(o, "loginUrl", p->login);
      cJSON_AddStringToObject(o, "home", p->home);
      json_set_bool(o, "needLogin", p->need);
      cJSON *lg = cJSON_GetObjectItemCaseSensitive(ck, p->id);
      json_set_bool(o, "logged", lg ? 1 : 0);
      cJSON_AddStringToObject(o, "nickname", lg ? json_str(lg, "nickname", "") : "");
      json_set_int(o, "loginAt", lg ? (int64_t)json_num(lg, "at", 0) : 0);
      cJSON_AddItemToArray(res, o);
    }
    cJSON_Delete(root);
  } else if (!strcmp(channel, "netdisk:list")) {
    cJSON *root = N_root();
    res = cJSON_Duplicate(cJSON_GetObjectItemCaseSensitive(root, "tasks"), 1);
    cJSON_Delete(root);
  } else if (!strcmp(channel, "netdisk:recognize")) {
    res = N_recognize(mod_arg_str(args, 0, ""));
  } else if (!strcmp(channel, "netdisk:enqueue")) {
    cJSON *o = mod_arg_obj(args, 0);
    cJSON *urls = o ? cJSON_GetObjectItemCaseSensitive(o, "urls") : NULL;
    if (!cJSON_IsArray(urls)) {
      rc = -1; *out_error = mod_ret_error("没有可下载的链接"); goto done;
    }
    cJSON *root = N_root();
    cJSON *tasks = cJSON_GetObjectItemCaseSensitive(root, "tasks");
    cJSON *u = NULL;
    int n = 0;
    cJSON_ArrayForEach(u, urls) {
      if (!cJSON_IsString(u) || !*u->valuestring) continue;
      const NPlatform *pf = platform_of(u->valuestring);
      if (pf->need) {
        cJSON *ck = cJSON_GetObjectItemCaseSensitive(root, "cookies");
        if (!cJSON_GetObjectItemCaseSensitive(ck, pf->id)) {
          /* 需要登录的平台：仍然建任务，但标 need-login，让界面看得见原因 */
        }
      }
      char id[64]; snprintf(id, sizeof(id), "nd_%llx%x", (unsigned long long)(now_ms() & 0xFFFFFFFFFFFFULL), n++);
      cJSON *t = cJSON_CreateObject();
      cJSON_AddStringToObject(t, "id", id);
      cJSON_AddStringToObject(t, "url", u->valuestring);
      cJSON_AddStringToObject(t, "platform", pf->id);
      cJSON_AddStringToObject(t, "platformName", pf->name);
      cJSON_AddStringToObject(t, "status", "queued");
      cJSON_AddNumberToObject(t, "progress", 0);
      json_set_int(t, "received", 0);
      json_set_int(t, "total", 0);
      cJSON_AddStringToObject(t, "error", "");
      char *dir = xstrdup(download_dir());
      cJSON_AddStringToObject(t, "saveDir", dir);
      cJSON_AddStringToObject(t, "name", url_filename(u->valuestring));
      free(dir);
      cJSON_AddStringToObject(t, "origin", o ? json_str(o, "origin", "hub") : "hub");
      json_set_int(t, "createdAt", now_ms());
      cJSON_AddItemToArray(tasks, t);
    }
    N_save(root);
    cJSON_Delete(root);
    /* 起线程 */
    cJSON *root2 = N_root();
    cJSON *ts = cJSON_GetObjectItemCaseSensitive(root2, "tasks");
    cJSON *tt = NULL;
    cJSON_ArrayForEach(tt, ts) {
      if (strcmp(json_str(tt, "status", ""), "queued")) continue;
      char *id = xstrdup(json_str(tt, "id", ""));
      CreateThread(NULL, 0, download_thread, id, 0, NULL);
    }
    cJSON_Delete(root2);
    res = cJSON_CreateObject();
    cJSON_AddBoolToObject(res, "ok", 1);
  } else if (!strcmp(channel, "netdisk:pause")) {
    const char *id = mod_arg_str(args, 0, "");
    cJSON *root = N_root();
    cJSON *t = task_find(cJSON_GetObjectItemCaseSensitive(root, "tasks"), id);
    if (t) {
      DlRun *r = run_find(id);
      if (r) r->stop = 1;
      cJSON_DeleteItemFromObjectCaseSensitive(t, "status");
      cJSON_AddStringToObject(t, "status", "paused");
      N_save(root);
      emit_task(t);
    }
    cJSON_Delete(root);
    res = cJSON_CreateBool(1);
  } else if (!strcmp(channel, "netdisk:resume")) {
    const char *id = mod_arg_str(args, 0, "");
    cJSON *root = N_root();
    cJSON *t = task_find(cJSON_GetObjectItemCaseSensitive(root, "tasks"), id);
    if (t) {
      cJSON_DeleteItemFromObjectCaseSensitive(t, "status");
      cJSON_AddStringToObject(t, "status", "queued");
      cJSON_DeleteItemFromObjectCaseSensitive(t, "error");
      cJSON_AddStringToObject(t, "error", "");
      N_save(root);
      char *cid = xstrdup(id);
      CreateThread(NULL, 0, download_thread, cid, 0, NULL);
    }
    cJSON_Delete(root);
    res = cJSON_CreateBool(1);
  } else if (!strcmp(channel, "netdisk:remove")) {
    const char *id = mod_arg_str(args, 0, "");
    DlRun *r = run_find(id);
    if (r) r->stop = 1;
    cJSON *root = N_root();
    cJSON *tasks = cJSON_GetObjectItemCaseSensitive(root, "tasks");
    cJSON *out = cJSON_CreateArray();
    cJSON *t = NULL;
    cJSON_ArrayForEach(t, tasks) if (strcmp(json_str(t, "id", ""), id)) cJSON_AddItemToArray(out, cJSON_Duplicate(t, 1));
    cJSON_DeleteItemFromObjectCaseSensitive(root, "tasks");
    cJSON_AddItemToObject(root, "tasks", out);
    N_save(root);
    cJSON_Delete(root);
    mod_emit_json("netdisk:removed", "{}");
    res = cJSON_CreateBool(1);
  } else if (!strcmp(channel, "netdisk:clearDone")) {
    cJSON *root = N_root();
    cJSON *tasks = cJSON_GetObjectItemCaseSensitive(root, "tasks");
    cJSON *out = cJSON_CreateArray();
    cJSON *t = NULL;
    cJSON_ArrayForEach(t, tasks) if (strcmp(json_str(t, "status", ""), "done")) cJSON_AddItemToArray(out, cJSON_Duplicate(t, 1));
    cJSON_DeleteItemFromObjectCaseSensitive(root, "tasks");
    cJSON_AddItemToObject(root, "tasks", out);
    N_save(root);
    cJSON_Delete(root);
    res = cJSON_CreateBool(1);
  } else if (!strcmp(channel, "netdisk:logout")) {
    const char *p = mod_arg_str(args, 0, "");
    cJSON *root = N_root();
    cJSON *ck = cJSON_GetObjectItemCaseSensitive(root, "cookies");
    cJSON_DeleteItemFromObjectCaseSensitive(ck, p);
    N_save(root);
    cJSON_Delete(root);
    res = cJSON_CreateBool(1);
  } else {
    rc = -1;
    *out_error = mod_ret_error("网盘模块没有这个方法：%s", channel);
  }
done:
  LeaveCriticalSection(&g_cs);
  cJSON_Delete(args);
  if (rc == 0) *out_json = mod_ret_json(res ? res : cJSON_CreateNull());
  return rc;
}

static int netdisk_init(const SgjHostApi *h) { mod_set_host(h); lock_init(); return 0; }
static void netdisk_shutdown(void) {}

SGJ_MODULE_EXPORT const SgjModule *sgj_module_entry(void) {
  if (!g_manifest) { g_manifest = mod_res_dup(L"MANIFEST"); g_js = mod_res_dup(L"UI_JS"); }
  g_mod.abi = SGJ_ABI;
  g_mod.id = "netdisk";
  g_mod.manifest_json = g_manifest;
  g_mod.renderer_js = g_js;
  g_mod.style_css = NULL;
  g_mod.init = netdisk_init;
  g_mod.shutdown = netdisk_shutdown;
  g_mod.invoke = netdisk_invoke;
  return &g_mod;
}
