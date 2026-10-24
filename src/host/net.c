#include "net.h"
#include <winhttp.h>

#pragma comment(lib, "winhttp.lib")

static int parse_url(const char *url, int *https, wchar_t *host, size_t host_cap, wchar_t *path, size_t path_cap, int *port) {
  *https = 0; *port = 0;
  const char *p = url;
  if (str_starts(p, "https://")) { *https = 1; p += 8; *port = 443; }
  else if (str_starts(p, "http://")) { *https = 0; p += 7; *port = 80; }
  else return 0;
  const char *slash = strchr(p, '/');
  size_t hostlen = slash ? (size_t)(slash - p) : strlen(p);
  char hbuf[512];
  if (hostlen >= sizeof(hbuf)) return 0;
  memcpy(hbuf, p, hostlen); hbuf[hostlen] = 0;
  char *colon = strrchr(hbuf, ':');
  if (colon && colon[1]) { *port = atoi(colon + 1); *colon = 0; }
  wchar_t *wh = u8_to_w(hbuf);
  wcsncpy(host, wh, host_cap - 1); host[host_cap - 1] = 0;
  free(wh);
  const char *pathp = slash ? slash : "/";
  wchar_t *wp = u8_to_w(pathp);
  wcsncpy(path, wp, path_cap - 1); path[path_cap - 1] = 0;
  free(wp);
  return 1;
}

int http_request_ex(const char *method, const char *url, const char *headers,
                    const void *body, size_t body_len, int timeout_ms, HttpResult *out) {
  memset(out, 0, sizeof(*out));
  wchar_t host[512], path[4096];
  int https = 0, port = 0;
  if (!parse_url(url, &https, host, 512, path, 4096, &port)) {
    snprintf(out->error, sizeof(out->error), "地址不合法：%s", url ? url : "");
    return 0;
  }
  wchar_t *wmethod = u8_to_w(method ? method : "GET");
  HINTERNET hS = WinHttpOpen(L"ShiGuangJi/0.4 (Windows)", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                             WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!hS) { snprintf(out->error, sizeof(out->error), "WinHttpOpen 失败"); free(wmethod); return 0; }
  if (timeout_ms <= 0) timeout_ms = 20000;
  WinHttpSetTimeouts(hS, timeout_ms, timeout_ms, timeout_ms, timeout_ms);
  HINTERNET hC = WinHttpConnect(hS, host, (INTERNET_PORT)port, 0);
  if (!hC) { snprintf(out->error, sizeof(out->error), "连接失败"); WinHttpCloseHandle(hS); free(wmethod); return 0; }
  DWORD flags = https ? WINHTTP_FLAG_SECURE : 0;
  HINTERNET hR = WinHttpOpenRequest(hC, wmethod, path, NULL, WINHTTP_NO_REFERER,
                                    WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
  if (!hR) { snprintf(out->error, sizeof(out->error), "请求创建失败"); WinHttpCloseHandle(hC); WinHttpCloseHandle(hS); free(wmethod); return 0; }
  free(wmethod);

  DWORD redir = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS;
  WinHttpSetOption(hR, WINHTTP_OPTION_REDIRECT_POLICY, &redir, sizeof(redir));
  DWORD secflags = SECURITY_FLAG_IGNORE_UNKNOWN_CA | SECURITY_FLAG_IGNORE_CERT_DATE_INVALID;
  (void)secflags;

  wchar_t *wh = headers ? u8_to_w(headers) : NULL;
  BOOL ok = WinHttpSendRequest(hR,
      wh ? wh : WINHTTP_NO_ADDITIONAL_HEADERS,
      wh ? (DWORD)-1L : 0,
      (LPVOID)body, (DWORD)body_len, (DWORD)body_len, 0);
  free(wh);
  if (!ok) {
    snprintf(out->error, sizeof(out->error), "发送请求失败（错误码 %lu）", (unsigned long)GetLastError());
    WinHttpCloseHandle(hR); WinHttpCloseHandle(hC); WinHttpCloseHandle(hS);
    return 0;
  }
  if (!WinHttpReceiveResponse(hR, NULL)) {
    snprintf(out->error, sizeof(out->error), "接收响应失败（错误码 %lu）", (unsigned long)GetLastError());
    WinHttpCloseHandle(hR); WinHttpCloseHandle(hC); WinHttpCloseHandle(hS);
    return 0;
  }
  DWORD status = 0, slen = sizeof(status);
  WinHttpQueryHeaders(hR, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                      WINHTTP_HEADER_NAME_BY_INDEX, &status, &slen, WINHTTP_NO_HEADER_INDEX);
  out->status = (int)status;

  Buf b; buf_init(&b);
  for (;;) {
    DWORD avail = 0;
    if (!WinHttpQueryDataAvailable(hR, &avail)) break;
    if (!avail) break;
    char *tmp = (char *)xmalloc(avail);
    DWORD got = 0;
    if (!WinHttpReadData(hR, tmp, avail, &got) || !got) { free(tmp); break; }
    buf_add(&b, tmp, got);
    free(tmp);
    if (b.len > (size_t)256 * 1024 * 1024) break;
  }
  out->len = b.len;
  out->data = buf_take(&b);
  WinHttpCloseHandle(hR); WinHttpCloseHandle(hC); WinHttpCloseHandle(hS);
  return 1;
}

void http_result_free(HttpResult *r) {
  if (r) { free(r->data); r->data = NULL; r->len = 0; }
}
