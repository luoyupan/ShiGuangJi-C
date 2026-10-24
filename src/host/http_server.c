#include "http_server.h"
#include "api.h"
#include "modules.h"
#include <winsock2.h>
#include <ws2tcpip.h>
#include <process.h>
#include <ctype.h>

#pragma comment(lib, "ws2_32.lib")

static SOCKET g_listen = INVALID_SOCKET;
static int g_port = 0;
static char g_token[64];
static char g_ui_dir[MAX_PATH * 2];
static volatile LONG g_stop = 0;
static HANDLE g_thread = NULL;

/* ---------------- SSE ---------------- */
#define MAX_SSE 32
typedef struct { SOCKET s; CRITICAL_SECTION cs; int used; } SseClient;
static SseClient g_sse[MAX_SSE];
static CRITICAL_SECTION g_sse_cs;
static int g_sse_init = 0;

static void sse_init_once(void) {
  if (g_sse_init) return;
  InitializeCriticalSection(&g_sse_cs);
  for (int i = 0; i < MAX_SSE; i++) { g_sse[i].used = 0; g_sse[i].s = INVALID_SOCKET; InitializeCriticalSection(&g_sse[i].cs); }
  g_sse_init = 1;
}

static int sse_add(SOCKET s) {
  sse_init_once();
  EnterCriticalSection(&g_sse_cs);
  for (int i = 0; i < MAX_SSE; i++) {
    if (!g_sse[i].used) {
      g_sse[i].used = 1; g_sse[i].s = s;
      LeaveCriticalSection(&g_sse_cs);
      return i;
    }
  }
  LeaveCriticalSection(&g_sse_cs);
  return -1;
}

static void sse_remove(int idx) {
  if (idx < 0 || idx >= MAX_SSE) return;
  EnterCriticalSection(&g_sse_cs);
  if (g_sse[idx].used) {
    g_sse[idx].used = 0;
    if (g_sse[idx].s != INVALID_SOCKET) { shutdown(g_sse[idx].s, SD_BOTH); closesocket(g_sse[idx].s); }
    g_sse[idx].s = INVALID_SOCKET;
  }
  LeaveCriticalSection(&g_sse_cs);
}

static void sse_send_all(const char *data, int len) {
  if (!g_sse_init) return;
  EnterCriticalSection(&g_sse_cs);
  for (int i = 0; i < MAX_SSE; i++) {
    if (!g_sse[i].used) continue;
    EnterCriticalSection(&g_sse[i].cs);
    int sent = 0, ok = 1;
    while (sent < len) {
      int n = send(g_sse[i].s, data + sent, len - sent, 0);
      if (n <= 0) { ok = 0; break; }
      sent += n;
    }
    LeaveCriticalSection(&g_sse[i].cs);
    if (!ok) {
      /* 不能在持 g_sse_cs 时调用 sse_remove（会重入） */
      SOCKET s = g_sse[i].s;
      g_sse[i].used = 0; g_sse[i].s = INVALID_SOCKET;
      shutdown(s, SD_BOTH); closesocket(s);
    }
  }
  LeaveCriticalSection(&g_sse_cs);
}

void bus_emit_json(const char *channel, const char *payload_json) {
  if (!g_sse_init) return;
  Buf b; buf_init(&b);
  buf_adds(&b, "data: {\"channel\":\"");
  for (const char *p = channel; *p; p++) {
    if (*p == '"' || *p == '\\') buf_addc(&b, '\\'), buf_addc(&b, *p);
    else buf_addc(&b, *p);
  }
  buf_adds(&b, "\",\"payload\":");
  buf_adds(&b, payload_json ? payload_json : "null");
  buf_adds(&b, "}\n\n");
  sse_send_all(b.p, (int)b.len);
  buf_free(&b);
}

void bus_emit(const char *channel, cJSON *payload) {
  char *t = json_dumps(payload);
  bus_emit_json(channel, t);
  cJSON_free(t);
  if (payload) cJSON_Delete(payload);
}

/* ---------------- 工具 ---------------- */
static void send_all(SOCKET s, const char *data, size_t n) {
  size_t sent = 0;
  while (sent < n) {
    int k = send(s, data + sent, (int)(n - sent > 1 << 20 ? 1 << 20 : n - sent), 0);
    if (k <= 0) return;
    sent += (size_t)k;
  }
}
static void send_str(SOCKET sock, const char *text) { send_all(sock, text, strlen(text)); }

static const char *mime_of(const char *path) {
  const char *e = path_ext(path);
  if (!_stricmp(e, "html")) return "text/html; charset=utf-8";
  if (!_stricmp(e, "css")) return "text/css; charset=utf-8";
  if (!_stricmp(e, "js") || !_stricmp(e, "mjs")) return "text/javascript; charset=utf-8";
  if (!_stricmp(e, "json")) return "application/json; charset=utf-8";
  if (!_stricmp(e, "png")) return "image/png";
  if (!_stricmp(e, "jpg") || !_stricmp(e, "jpeg")) return "image/jpeg";
  if (!_stricmp(e, "webp")) return "image/webp";
  if (!_stricmp(e, "gif")) return "image/gif";
  if (!_stricmp(e, "avif")) return "image/avif";
  if (!_stricmp(e, "bmp")) return "image/bmp";
  if (!_stricmp(e, "svg")) return "image/svg+xml";
  if (!_stricmp(e, "ico")) return "image/x-icon";
  if (!_stricmp(e, "woff2")) return "font/woff2";
  if (!_stricmp(e, "woff")) return "font/woff";
  if (!_stricmp(e, "ttf")) return "font/ttf";
  if (!_stricmp(e, "mp3")) return "audio/mpeg";
  if (!_stricmp(e, "flac")) return "audio/flac";
  if (!_stricmp(e, "m4a") || !_stricmp(e, "aac")) return "audio/mp4";
  if (!_stricmp(e, "ogg") || !_stricmp(e, "opus")) return "audio/ogg";
  if (!_stricmp(e, "wav")) return "audio/wav";
  if (!_stricmp(e, "mp4")) return "video/mp4";
  if (!_stricmp(e, "lrc") || !_stricmp(e, "txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

static void http_send(SOCKET s, int code, const char *ctype, const void *body, size_t n, const char *extra) {
  const char *reason = code == 200 ? "OK" : code == 206 ? "Partial Content" : code == 404 ? "Not Found"
                     : code == 403 ? "Forbidden" : code == 405 ? "Method Not Allowed" : code == 500 ? "Internal Server Error"
                     : code == 400 ? "Bad Request" : "OK";
  char head[1024];
  int k = snprintf(head, sizeof(head),
      "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\nConnection: close\r\n"
      "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n%s\r\n", code, reason, ctype, n, extra ? extra : "");
  send_all(s, head, (size_t)k);
  if (body && n) send_all(s, (const char *)body, n);
}

static void http_text(SOCKET s, int code, const char *ctype, const char *text) {
  http_send(s, code, ctype, text, strlen(text), NULL);
}

static int parse_range(const char *hdr, int64_t total, int64_t *start, int64_t *end) {
  if (!hdr) return 0;
  const char *p = strstr(hdr, "bytes=");
  if (!p) return 0;
  p += 6;
  int64_t a = 0, b = -1;
  int has_a = 0, has_b = 0;
  char *endp = NULL;
  if (*p != '-') { a = _strtoi64(p, &endp, 10); has_a = 1; if (endp == p) return 0; p = endp; }
  if (*p == '-') {
    p++;
    if (*p >= '0' && *p <= '9') { b = _strtoi64(p, &endp, 10); has_b = 1; p = endp; }
  }
  if (!has_a && !has_b) return 0;
  if (!has_a && has_b) { a = total - b; b = total - 1; if (a < 0) a = 0; }
  else if (has_a && !has_b) b = total - 1;
  if (b >= total) b = total - 1;
  if (a > b || a < 0) return 0;
  *start = a; *end = b;
  return 1;
}

static int serve_file(SOCKET s, const char *path, int allow_range, const char *range_hdr) {
  wchar_t *wp = u8_to_w(path);
  HANDLE h = CreateFileW(wp, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                         NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  free(wp);
  if (h == INVALID_HANDLE_VALUE) { http_text(s, 404, "text/plain; charset=utf-8", "404 file not found"); return 0; }
  LARGE_INTEGER sz; GetFileSizeEx(h, &sz);
  int64_t total = sz.QuadPart;
  int64_t start = 0, end = total - 1;
  int partial = 0;
  if (allow_range && range_hdr && total > 0 && parse_range(range_hdr, total, &start, &end)) partial = 1;
  int64_t len = total == 0 ? 0 : end - start + 1;
  char extra[256] = "";
  if (partial) {
    snprintf(extra, sizeof(extra), "Content-Range: bytes %lld-%lld/%lld\r\nAccept-Ranges: bytes\r\n",
             (long long)start, (long long)end, (long long)total);
  } else {
    snprintf(extra, sizeof(extra), "Accept-Ranges: bytes\r\n");
  }
  char head[1024];
  const char *reason = partial ? "Partial Content" : "OK";
  int k = snprintf(head, sizeof(head),
      "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %lld\r\nConnection: close\r\n"
      "Cache-Control: no-cache\r\n%s\r\n", partial ? 206 : 200, reason, mime_of(path), (long long)len, extra);
  send_all(s, head, (size_t)k);
  if (len <= 0) { CloseHandle(h); return 1; }
  LARGE_INTEGER li; li.QuadPart = start;
  SetFilePointerEx(h, li, NULL, FILE_BEGIN);
  char buf[1 << 16];
  int64_t left = len;
  while (left > 0) {
    DWORD want = (DWORD)(left > (int64_t)sizeof(buf) ? (int64_t)sizeof(buf) : left);
    DWORD got = 0;
    if (!ReadFile(h, buf, want, &got, NULL) || !got) break;
    send_all(s, buf, got);
    left -= got;
  }
  CloseHandle(h);
  return 1;
}

static int path_is_inside(const char *base, const char *rel) {
  if (strstr(rel, "..")) return 0;
  if (rel[0] == '\\' || rel[0] == '/') return 0;
  if (rel[0] && rel[1] == ':') return 0;
  (void)base;
  return 1;
}

static void serve_ui(SOCKET s, const char *rel) {
  char *r = xstrdup(rel);
  for (char *p = r; *p; p++) if (*p == '/') *p = '\\';
  char *trim = r;
  while (*trim == '\\') trim++;
  if (!*trim) { free(r); r = xstrdup("index.html"); trim = r; }
  if (!path_is_inside(g_ui_dir, trim)) { free(r); http_text(s, 403, "text/plain; charset=utf-8", "403"); return; }
  char *full = path_join(g_ui_dir, trim);
  if (!path_exists(full)) {
    /* SPA 兜底：不带扩展名的路径回 index.html */
    if (!strchr(trim, '.')) { free(full); full = path_join(g_ui_dir, "index.html"); }
  }
  serve_file(s, full, 0, NULL);
  free(full); free(r);
}

static void serve_local(SOCKET s, const char *enc_path, const char *range_hdr) {
  char *dec = url_decode(enc_path);
  /* /local/C:/x 或 /local//server/share */
  for (char *p = dec; *p; p++) if (*p == '/') *p = '\\';
  if (dec[0] == '\\' && dec[1] && dec[1] != '\\') memmove(dec, dec + 1, strlen(dec));
  if (!path_exists(dec)) { http_text(s, 404, "text/plain; charset=utf-8", "404 local file not found"); free(dec); return; }
  serve_file(s, dec, 1, range_hdr);
  free(dec);
}

char *http_local_url(const char *path) {
  if (!path) return xstrdup("");
  if (str_starts(path, "http://") || str_starts(path, "https://") || str_starts(path, "data:") || str_starts(path, "blob:"))
    return xstrdup(path);
  char norm[MAX_PATH * 2];
  snprintf(norm, sizeof(norm), "%s", path);
  for (char *p = norm; *p; p++) if (*p == '/') *p = '\\';
  char *enc = url_encode_path(norm);
  Buf b; buf_init(&b);
  buf_addf(&b, "http://127.0.0.1:%d/t/%s/local/%s", g_port, g_token, enc);
  free(enc);
  return buf_take(&b);
}

/* ---------------- 请求处理 ---------------- */
static int handle_client(SOCKET s) {
  /* 读头 */
  char *buf = (char *)xmalloc(1 << 16);
  size_t cap = 1 << 16, len = 0;
  int header_end = -1;
  while (len < cap - 1) {
    int n = recv(s, buf + len, (int)(cap - 1 - len), 0);
    if (n <= 0) break;
    len += (size_t)n;
    buf[len] = 0;
    char *p = strstr(buf, "\r\n\r\n");
    if (p) { header_end = (int)(p - buf); break; }
  }
  if (header_end < 0) { http_text(s, 400, "text/plain; charset=utf-8", "400 bad request"); free(buf); return 0; }
  char *headers = (char *)xmalloc((size_t)header_end + 1);
  memcpy(headers, buf, (size_t)header_end); headers[header_end] = 0;

  char method[16] = "", target[4096] = "", version[16] = "";
  sscanf(headers, "%15s %4095s %15s", method, target, version);

  /* 头字段 */
  char *hdr_lower = xstrdup(headers);
  for (char *p = hdr_lower; *p; p++) *p = (char)tolower((unsigned char)*p);
  char *cl_h = strstr(hdr_lower, "\r\ncontent-length:");
  int64_t content_len = 0;
  if (cl_h) content_len = _strtoi64(cl_h + 17, NULL, 10);
  char *range_h = strstr(headers, "\r\nRange:");
  if (!range_h) range_h = strstr(headers, "\r\nrange:");
  char range_val[256] = "";
  if (range_h) {
    char *v = range_h + 8;
    while (*v == ' ') v++;
    const char *e = strstr(v, "\r\n");
    size_t n = e ? (size_t)(e - v) : strlen(v);
    if (n > 255) n = 255;
    memcpy(range_val, v, n); range_val[n] = 0;
  }

  char *body = NULL;
  if (content_len > 0 && content_len < (32 << 20)) {
    body = (char *)xmalloc((size_t)content_len + 1);
    size_t already = len - (size_t)header_end - 4;
    if (already > (size_t)content_len) already = (size_t)content_len;
    if (already) memcpy(body, buf + header_end + 4, already);
    size_t got = already;
    while (got < (size_t)content_len) {
      int n = recv(s, body + got, (int)((size_t)content_len - got), 0);
      if (n <= 0) break;
      got += (size_t)n;
    }
    body[got] = 0;
  }
  free(buf); free(hdr_lower);

  /* 校验 token 前缀 */
  char prefix[96];
  snprintf(prefix, sizeof(prefix), "/t/%s/", g_token);
  if (strncmp(target, prefix, strlen(prefix)) != 0) {
    http_text(s, 403, "text/plain; charset=utf-8", "403 bad token");
    free(headers); free(body);
    return 0;
  }
  const char *path = target + strlen(prefix);
  char *path_dec = url_decode(path);
  /* 去掉查询串 */
  char *q = strchr(path_dec, '?');
  char *query = NULL;
  if (q) { *q = 0; query = q + 1; }

  if (!strcmp(path_dec, "api") && !strcmp(method, "POST")) {
    char *out_json = NULL, *out_err = NULL;
    int rc = api_handle(body, &out_json, &out_err);
    cJSON *resp = cJSON_CreateObject();
    if (rc == 0) {
      cJSON_AddBoolToObject(resp, "ok", 1);
      cJSON *data = out_json ? cJSON_Parse(out_json) : NULL;
      cJSON_AddItemToObject(resp, "data", data ? data : cJSON_CreateNull());
    } else {
      cJSON_AddBoolToObject(resp, "ok", 0);
      cJSON_AddStringToObject(resp, "error", out_err ? out_err : "操作失败");
    }
    char *t = json_dumps(resp);
    http_send(s, 200, "application/json; charset=utf-8", t, strlen(t), NULL);
    cJSON_free(t);
    cJSON_Delete(resp);
    if (out_json) host_dealloc(out_json);
    if (out_err) host_dealloc(out_err);
  } else if (!strcmp(path_dec, "events") && !strcmp(method, "GET")) {
    send_str(s, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\n"
                "Cache-Control: no-cache\r\nConnection: keep-alive\r\nAccess-Control-Allow-Origin: *\r\n\r\n"
                "retry: 1500\n\n");
    if (sse_add(s) < 0) closesocket(s);
    free(headers); free(body); free(path_dec);
    return 1; /* socket 交给 SSE 管理 */
  } else if (!strcmp(path_dec, "health")) {
    http_text(s, 200, "text/plain; charset=utf-8", "ok");
  } else if (str_starts(path_dec, "mod/") && !strcmp(method, "GET")) {
    char *rest = path_dec + 4;
    char *slash = strchr(rest, '/');
    if (slash) {
      *slash = 0;
      const char *what = slash + 1;
      size_t n = 0;
      const char *data = NULL;
      const char *ctype = "text/plain; charset=utf-8";
      if (!strcmp(what, "renderer.js")) { data = modules_renderer(rest, &n); ctype = "text/javascript; charset=utf-8"; }
      else if (!strcmp(what, "style.css")) { data = modules_style(rest, &n); ctype = "text/css; charset=utf-8"; }
      if (data) http_send(s, 200, ctype, data, n, NULL);
      else http_text(s, 404, "text/plain; charset=utf-8", "404 module asset");
    } else http_text(s, 404, "text/plain; charset=utf-8", "404");
  } else if (str_starts(path_dec, "local/")) {
    serve_local(s, path_dec + 6, range_val);
  } else if (!strcmp(method, "GET")) {
    serve_ui(s, path_dec);
  } else {
    http_text(s, 405, "text/plain; charset=utf-8", "405");
  }
  free(headers); free(body); free(path_dec);
  return 0;
}

static unsigned __stdcall client_thread(void *arg) {
  SOCKET s = (SOCKET)(uintptr_t)arg;
  CoInitializeEx(NULL, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
  int keep = handle_client(s);
  if (!keep) {
    shutdown(s, SD_BOTH);
    closesocket(s);
  }
  CoUninitialize();
  return 0;
}

static DWORD WINAPI heartbeat_thread(LPVOID p) {
  (void)p;
  while (!g_stop) {
    Sleep(15000);
    sse_send_all(": ping\n\n", 8);
  }
  return 0;
}

static DWORD WINAPI accept_thread(LPVOID p) {
  (void)p;
  while (!g_stop) {
    SOCKET c = accept(g_listen, NULL, NULL);
    if (c == INVALID_SOCKET) { if (g_stop) break; Sleep(10); continue; }
    uintptr_t h = _beginthreadex(NULL, 0, client_thread, (void *)(uintptr_t)c, 0, NULL);
    if (h) CloseHandle((HANDLE)h);
    else closesocket(c);
  }
  return 0;
}

int http_server_start(const char *ui_dir, const char *token, int port) {
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return 0;
  snprintf(g_ui_dir, sizeof(g_ui_dir), "%s", ui_dir ? ui_dir : "");
  snprintf(g_token, sizeof(g_token), "%s", token ? token : "");
  g_listen = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (g_listen == INVALID_SOCKET) return 0;
  BOOL yes = TRUE;
  setsockopt(g_listen, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char *)&yes, sizeof(yes));
  struct sockaddr_in a;
  memset(&a, 0, sizeof(a));
  a.sin_family = AF_INET;
  a.sin_addr.s_addr = inet_addr("127.0.0.1");
  a.sin_port = htons((u_short)port);
  if (bind(g_listen, (struct sockaddr *)&a, sizeof(a)) != 0) { closesocket(g_listen); g_listen = INVALID_SOCKET; return 0; }
  int alen = sizeof(a);
  if (getsockname(g_listen, (struct sockaddr *)&a, &alen) == 0) g_port = ntohs(a.sin_port);
  if (listen(g_listen, 32) != 0) { closesocket(g_listen); g_listen = INVALID_SOCKET; return 0; }
  g_stop = 0;
  g_thread = CreateThread(NULL, 0, accept_thread, NULL, 0, NULL);
  CreateThread(NULL, 0, heartbeat_thread, NULL, 0, NULL);
  LOGI("http: http://127.0.0.1:%d/t/%s/ (ui=%s)", g_port, g_token, g_ui_dir);
  return 1;
}

void http_server_stop(void) {
  g_stop = 1;
  if (g_listen != INVALID_SOCKET) { closesocket(g_listen); g_listen = INVALID_SOCKET; }
  if (g_sse_init) {
    EnterCriticalSection(&g_sse_cs);
    for (int i = 0; i < MAX_SSE; i++) if (g_sse[i].used) {
      shutdown(g_sse[i].s, SD_BOTH); closesocket(g_sse[i].s); g_sse[i].used = 0;
    }
    LeaveCriticalSection(&g_sse_cs);
  }
  WSACleanup();
}

int http_server_port(void) { return g_port; }
