#include "sgj.h"
#include "modules.h"
#include "store.h"
#include "net.h"
#include "dialogs.h"
#include "http_server.h"
#include <tlhelp32.h>
#include <shellapi.h>

#pragma comment(lib, "kernel32.lib")
#pragma comment(lib, "shell32.lib")

static void *h_alloc(size_t n) { return host_alloc(n); }
static void h_free(void *p) { host_dealloc(p); }
static void h_log(int level, const char *msg) { log_msg(level, "%s", msg ? msg : ""); }

static char *h_read_text(const char *path) {
  char *t = file_read_text(path);
  if (!t) return NULL;
  char *r = (char *)host_alloc(strlen(t) + 1);
  if (r) strcpy(r, t);
  free(t);
  return r;
}
static int h_write_text(const char *path, const char *text) { return file_write_text_atomic(path, text ? text : ""); }
static int h_file_exists(const char *path) { return path_exists(path); }
static int h_ensure_dir(const char *path) { return path_mkdirs(path); }
static const char *h_data_dir(void) { return sgj_data_dir(); }
static const char *h_app_dir(void) { return sgj_app_dir(); }

static char *h_http(const char *method, const char *url, const char *headers,
                    const void *body, size_t body_len, int timeout_ms, int *status, size_t *out_len) {
  HttpResult r;
  if (!http_request_ex(method, url, headers, body, body_len, timeout_ms, &r)) return NULL;
  char *p = (char *)host_alloc(r.len + 1);
  if (p) { memcpy(p, r.data ? r.data : "", r.len); p[r.len] = 0; }
  if (status) *status = r.status;
  if (out_len) *out_len = r.len;
  http_result_free(&r);
  return p;
}

static char *h_store_get(const char *key) {
  char *t = store_get_text(key);
  if (!t) return NULL;
  char *r = (char *)host_alloc(strlen(t) + 1);
  if (r) strcpy(r, t);
  cJSON_free(t);
  return r;
}
static void h_store_set(const char *key, const char *json) {
  cJSON *v = json ? cJSON_Parse(json) : NULL;
  if (v) { store_set(key, v); cJSON_Delete(v); }
}
static void h_store_merge(const char *key, const char *json) {
  cJSON *v = json ? cJSON_Parse(json) : NULL;
  if (v) { store_merge(key, v); cJSON_Delete(v); }
}
static void h_emit(const char *channel, const char *json) { bus_emit_json(channel, json && *json ? json : "null"); }

static char *h_pick_folder(int multi, const char *title) {
  char *p = dlg_pick_folder(sgj_main_window(), multi, title);
  char *r = (char *)host_alloc(strlen(p) + 1);
  if (r) strcpy(r, p);
  free(p);
  return r;
}
static char *h_pick_file(const char *filter, int save, const char *default_name) {
  char *p = dlg_pick_files(sgj_main_window(), save, NULL, filter, default_name);
  char *r = (char *)host_alloc(strlen(p) + 1);
  if (r) strcpy(r, p);
  free(p);
  return r;
}
static int h_message_box(const char *title, const char *text, int yes_no) {
  return dlg_message(sgj_main_window(), title, text, yes_no);
}
static void h_open_path(const char *path) { open_path(path); }
static void h_open_url(const char *url) { open_url(url); }
static void h_reveal(const char *path) { reveal_in_explorer(path); }
static void h_notify(const char *title, const char *msg) {
  cJSON *o = cJSON_CreateObject();
  cJSON_AddStringToObject(o, "title", title ? title : "");
  cJSON_AddStringToObject(o, "msg", msg ? msg : "");
  cJSON_AddStringToObject(o, "type", "info");
  bus_emit("toast", o);
}

static int h_proc_running(const char *exe) {
  if (!exe || !*exe) return 0;
  const char *base = path_basename(exe);
  wchar_t *wbase = u8_to_w(base);
  int found = 0;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap != INVALID_HANDLE_VALUE) {
    PROCESSENTRY32W pe; pe.dwSize = sizeof(pe);
    if (Process32FirstW(snap, &pe)) {
      do {
        if (_wcsicmp(pe.szExeFile, wbase) == 0) { found = 1; break; }
      } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
  }
  free(wbase);
  return found;
}

static int h_run_command(const char *cmdline, int wait) {
  wchar_t *w = u8_to_w(cmdline);
  STARTUPINFOW si; PROCESS_INFORMATION pi;
  memset(&si, 0, sizeof(si)); si.cb = sizeof(si);
  si.dwFlags = STARTF_USESHOWWINDOW; si.wShowWindow = SW_HIDE;
  memset(&pi, 0, sizeof(pi));
  BOOL ok = CreateProcessW(NULL, w, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi);
  free(w);
  if (!ok) return -1;
  DWORD code = 0;
  if (wait) { WaitForSingleObject(pi.hProcess, 10 * 60 * 1000); GetExitCodeProcess(pi.hProcess, &code); }
  CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
  return (int)code;
}

static char *h_local_url(const char *path) {
  char *u = http_local_url(path);
  char *r = (char *)host_alloc(strlen(u) + 1);
  if (r) strcpy(r, u);
  free(u);
  return r;
}

static SgjHostApi g_host = {
  SGJ_ABI,
  h_alloc, h_free, h_log,
  h_read_text, h_write_text, h_file_exists, h_ensure_dir, h_data_dir, h_app_dir,
  h_http,
  h_store_get, h_store_set, h_store_merge,
  h_emit,
  h_pick_folder, h_pick_file, h_message_box,
  h_open_path, h_open_url, h_reveal, h_notify,
  h_proc_running, h_run_command,
  h_local_url
};

const SgjHostApi *host_api(void) { return &g_host; }
