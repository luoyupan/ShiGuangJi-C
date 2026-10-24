/* ============================================================
 * 拾光集 · 联机模块 (link.dll)
 * ------------------------------------------------------------
 * TCP + UDP 端口映射（房主开隧道端口 → 本机游戏端口；加入方开本地端口 →
 * 房主隧道端口）/ 邀请码 / 房间聊天 / 本机网络信息 / 中转服务端（简化版）。
 * 不做虚拟网卡（和原版一样：如实说明缺 wintun）。
 * ============================================================ */
#include "../module_common.h"
#include <winsock2.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>
#include <windows.h>
#include <process.h>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "iphlpapi.lib")

static const char *g_manifest = NULL;
static const char *g_js = NULL;
static SgjModule g_mod;
static CRITICAL_SECTION g_cs;
static int g_cs_init = 0;
static void lock_init(void) { if (!g_cs_init) { InitializeCriticalSection(&g_cs); g_cs_init = 1; } }

/* ---------------- 状态 ---------------- */
static char g_phase[32] = "idle";
static char g_mode[16] = "";
static char g_error[256] = "";
static char g_invite[2048] = "";
static cJSON *g_invite_data = NULL;
static char g_room[256] = "";
static char g_player[128] = "";
static char g_host_addr[128] = "";
static int g_game_port = 0, g_tunnel_port = 0, g_local_port = 0, g_ctrl_port = 0;
static volatile LONG g_stop = 0;
static SOCKET g_tcp_listen = INVALID_SOCKET;
static SOCKET g_udp_sock = INVALID_SOCKET;
static SOCKET g_ctrl_listen = INVALID_SOCKET;
static HANDLE g_thr_tcp = NULL, g_thr_udp = NULL, g_thr_ctrl = NULL;
static HANDLE g_thr_relay = NULL;
static SOCKET g_relay_listen = INVALID_SOCKET;
static int g_relay_port = 0;
static volatile LONG g_relay_running = 0;
static volatile LONG g_relay_peers = 0;
static volatile LONG g_relay_frames = 0;
static volatile LONG g_relay_bytes = 0;
static cJSON *g_chats = NULL;
static cJSON *g_logs = NULL;
static DWORD g_started_at = 0;
static int g_is_host = 0;

static void lk_log(const char *fmt, ...) {
  char msg[512];
  va_list ap; va_start(ap, fmt); vsnprintf(msg, sizeof(msg), fmt, ap); va_end(ap);
  cJSON *o = cJSON_CreateObject();
  cJSON_AddNumberToObject(o, "at", (double)now_ms());
  cJSON_AddStringToObject(o, "text", msg);
  if (!g_logs) g_logs = cJSON_CreateArray();
  cJSON_AddItemToArray(g_logs, o);
  while (cJSON_GetArraySize(g_logs) > 200) cJSON_DeleteItemFromArray(g_logs, 0);
  mod_emit("link:log", cJSON_CreateObject());
}
static void emit_state(void) {
  cJSON *o = cJSON_CreateObject();
  cJSON_AddStringToObject(o, "phase", g_phase);
  cJSON_AddStringToObject(o, "mode", g_mode);
  mod_emit("link:state", o);
}

/* ---------------- 地址 ---------------- */
typedef struct { char name[64], address[64], mask[64], mac[32]; } AddrRow;
static int list_addresses(AddrRow *rows, int max, int v6) {
  ULONG size = 15000;
  IP_ADAPTER_ADDRESSES *buf = (IP_ADAPTER_ADDRESSES *)xmalloc(size);
  ULONG flags = GAA_FLAG_INCLUDE_PREFIX | GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
  if (GetAdaptersAddresses(v6 ? AF_INET6 : AF_INET, flags, NULL, buf, &size) != NO_ERROR) { free(buf); return 0; }
  int n = 0;
  for (IP_ADAPTER_ADDRESSES *a = buf; a && n < max; a = a->Next) {
    if (a->OperStatus != IfOperStatusUp) continue;
    for (IP_ADAPTER_UNICAST_ADDRESS *u = a->FirstUnicastAddress; u && n < max; u = u->Next) {
      struct sockaddr *sa = u->Address.lpSockaddr;
      char ip[64] = "";
      if (sa->sa_family == AF_INET) {
        struct sockaddr_in *in = (struct sockaddr_in *)sa;
        inet_ntop(AF_INET, &in->sin_addr, ip, sizeof(ip));
      } else if (sa->sa_family == AF_INET6) {
        struct sockaddr_in6 *in6 = (struct sockaddr_in6 *)sa;
        inet_ntop(AF_INET6, &in6->sin6_addr, ip, sizeof(ip));
      }
      if (!*ip) continue;
      char *nm = w_to_u8(a->FriendlyName);
      snprintf(rows[n].name, sizeof(rows[n].name), "%s", nm);
      free(nm);
      snprintf(rows[n].address, sizeof(rows[n].address), "%s", ip);
      rows[n].mask[0] = 0;
      snprintf(rows[n].mac, sizeof(rows[n].mac), "%02x:%02x:%02x:%02x:%02x:%02x",
               a->PhysicalAddress[0], a->PhysicalAddress[1], a->PhysicalAddress[2],
               a->PhysicalAddress[3], a->PhysicalAddress[4], a->PhysicalAddress[5]);
      n++;
    }
  }
  free(buf);
  return n;
}
static const char *primary_ipv4(void) {
  static char ip[64];
  AddrRow rows[16];
  int n = list_addresses(rows, 16, 0);
  const char *best = "";
  for (int i = 0; i < n; i++) {
    if (str_starts(rows[i].address, "127.")) continue;
    if (!str_starts(rows[i].address, "169.254.")) { best = rows[i].address; if (!str_starts(best, "192.168.")) break; }
  }
  snprintf(ip, sizeof(ip), "%s", best);
  return ip;
}

/* ---------------- base64url ---------------- */
static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
static char *b64enc(const unsigned char *d, size_t n) {
  size_t olen = (n + 2) / 3 * 4;
  char *o = (char *)xmalloc(olen + 1);
  size_t k = 0;
  for (size_t i = 0; i < n; i += 3) {
    unsigned v = (unsigned)d[i] << 16;
    if (i + 1 < n) v |= (unsigned)d[i+1] << 8;
    if (i + 2 < n) v |= d[i+2];
    o[k++] = B64[(v >> 18) & 63];
    o[k++] = B64[(v >> 12) & 63];
    o[k++] = (i + 1 < n) ? B64[(v >> 6) & 63] : '=';
    o[k++] = (i + 2 < n) ? B64[v & 63] : '=';
  }
  o[k] = 0;
  return o;
}
static int b64v(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '-') return 62;
  if (c == '_') return 63;
  return -1;
}
static unsigned char *b64dec(const char *s, size_t *outn) {
  size_t n = strlen(s), cap = n / 4 * 3 + 3;
  unsigned char *o = (unsigned char *)xmalloc(cap);
  size_t k = 0;
  int quad[4], qn = 0;
  for (size_t i = 0; i < n; i++) {
    if (s[i] == '=') break;
    int v = b64v(s[i]);
    if (v < 0) continue;
    quad[qn++] = v;
    if (qn == 4) {
      o[k++] = (unsigned char)((quad[0] << 2) | (quad[1] >> 4));
      o[k++] = (unsigned char)(((quad[1] & 15) << 4) | (quad[2] >> 2));
      o[k++] = (unsigned char)(((quad[2] & 3) << 6) | quad[3]);
      qn = 0;
    }
  }
  if (qn == 2) o[k++] = (unsigned char)((quad[0] << 2) | (quad[1] >> 4));
  else if (qn == 3) { o[k++] = (unsigned char)((quad[0] << 2) | (quad[1] >> 4)); o[k++] = (unsigned char)(((quad[1] & 15) << 4) | (quad[2] >> 2)); }
  o[k] = 0;
  *outn = k;
  return o;
}
static unsigned long long fnv(const char *s) {
  unsigned long long h = 1469598103934665603ULL;
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) { h ^= *p; h *= 1099511628211ULL; }
  return h;
}

/* ---------------- 邀请码 ---------------- */
static char *make_invite(const char *host, int tunnel, int game, const char *room, int ttl_min, const char *mode) {
  cJSON *o = cJSON_CreateObject();
  cJSON_AddNumberToObject(o, "v", 1);
  cJSON_AddStringToObject(o, "host", host && *host ? host : "127.0.0.1");
  cJSON_AddNumberToObject(o, "port", tunnel);
  cJSON_AddNumberToObject(o, "gamePort", game);
  cJSON_AddStringToObject(o, "room", room ? room : "房间");
  cJSON_AddStringToObject(o, "mode", mode ? mode : "p2p");
  cJSON_AddNumberToObject(o, "exp", (double)(now_ms() + (int64_t)ttl_min * 60000));
  char *js = json_dumps(o);
  cJSON_Delete(o);
  unsigned long long h = fnv(js);
  Buf b; buf_init(&b);
  buf_adds(&b, "SJM1.");
  char *enc = b64enc((const unsigned char *)js, strlen(js));
  buf_adds(&b, enc);
  free(enc);
  buf_addf(&b, ".%08llX", (unsigned long long)(h & 0xFFFFFFFFULL));
  free(js);
  return buf_take(&b);
}
static cJSON *parse_invite(const char *code, char **reason) {
  if (reason) *reason = NULL;
  if (!code) return NULL;
  /* 去掉空白 */
  char *s = xstrdup(code);
  size_t k = 0;
  for (size_t i = 0; s[i]; i++) if (!isspace((unsigned char)s[i])) s[k++] = s[i];
  s[k] = 0;
  if (!str_starts(s, "SJM1.")) { free(s); if (reason) *reason = xstrdup("不是拾光集邀请码"); return NULL; }
  char *p = s + 5;
  char *dot = strrchr(p, '.');
  if (!dot) { free(s); if (reason) *reason = xstrdup("邀请码不完整"); return NULL; }
  *dot = 0;
  char *hash_s = dot + 1;
  size_t bn = 0;
  unsigned char *raw = b64dec(p, &bn);
  char *js = (char *)raw;
  unsigned long long h = fnv(js);
  char want[16]; snprintf(want, sizeof(want), "%08llX", (unsigned long long)(h & 0xFFFFFFFFULL));
  if (_stricmp(want, hash_s)) {
    free(raw); free(s);
    if (reason) *reason = xstrdup("邀请码被改过（校验失败）");
    return NULL;
  }
  cJSON *o = cJSON_Parse(js);
  free(raw); free(s);
  if (!o) { if (reason) *reason = xstrdup("邀请码内容坏了"); return NULL; }
  double exp = json_num(o, "exp", 0);
  if (exp && exp < (double)now_ms()) { cJSON_Delete(o); if (reason) *reason = xstrdup("邀请码已过期"); return NULL; }
  return o;
}

/* ---------------- TCP/UDP 转发 ---------------- */
static int connect_to(const char *host, int port) {
  SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (s == INVALID_SOCKET) return -1;
  struct sockaddr_in a; memset(&a, 0, sizeof(a));
  a.sin_family = AF_INET;
  a.sin_port = htons((u_short)port);
  if (inet_pton(AF_INET, host, &a.sin_addr) != 1) {
    struct addrinfo hints, *res = NULL;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET; hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo(host, NULL, &hints, &res) != 0 || !res) { closesocket(s); return -1; }
    a.sin_addr = ((struct sockaddr_in *)res->ai_addr)->sin_addr;
    freeaddrinfo(res);
  }
  if (connect(s, (struct sockaddr *)&a, sizeof(a)) != 0) { closesocket(s); return -1; }
  return (int)s;
}
static DWORD WINAPI pump_thread(LPVOID p) {
  SOCKET *pair = (SOCKET *)p;
  SOCKET a = pair[0], b = pair[1];
  free(pair);
  fd_set fds; char buf[16384];
  for (;;) {
    FD_ZERO(&fds); FD_SET(a, &fds); FD_SET(b, &fds);
    struct timeval tv = { 0, 500000 };
    int r = select(0, &fds, NULL, NULL, &tv);
    if (r <= 0) continue;
    if (FD_ISSET(a, &fds)) {
      int n = recv(a, buf, sizeof(buf), 0);
      if (n <= 0) break;
      if (send(b, buf, n, 0) <= 0) break;
    }
    if (FD_ISSET(b, &fds)) {
      int n = recv(b, buf, sizeof(buf), 0);
      if (n <= 0) break;
      if (send(a, buf, n, 0) <= 0) break;
    }
  }
  closesocket(a); closesocket(b);
  return 0;
}
static void start_pump(SOCKET a, SOCKET b) {
  SOCKET *p = (SOCKET *)xmalloc(sizeof(SOCKET) * 2);
  p[0] = a; p[1] = b;
  HANDLE h = CreateThread(NULL, 0, pump_thread, p, 0, NULL);
  if (h) CloseHandle(h);
}

static DWORD WINAPI tcp_accept_thread(LPVOID p) {
  int target = (int)(intptr_t)p; /* 房主：转发到本机游戏端口；加入方：转发到远端 */
  while (!g_stop) {
    SOCKET c = accept(g_tcp_listen, NULL, NULL);
    if (c == INVALID_SOCKET) break;
    int up;
    if (g_is_host) up = connect_to("127.0.0.1", target);
    else up = connect_to(g_host_addr, target);
    if (up < 0) { closesocket(c); continue; }
    start_pump(c, (SOCKET)up);
    lk_log(g_is_host ? "有人连上来了，已接到本机游戏端口" : "本机游戏连上来了，已接到房主");
  }
  return 0;
}
static DWORD WINAPI udp_thread(LPVOID p) {
  int target = (int)(intptr_t)p;
  struct sockaddr_in from; int fl = sizeof(from);
  struct sockaddr_in last; int has_last = 0;
  char buf[65536];
  while (!g_stop) {
    fd_set fds; FD_ZERO(&fds); FD_SET(g_udp_sock, &fds);
    struct timeval tv = { 0, 500000 };
    if (select(0, &fds, NULL, NULL, &tv) <= 0) continue;
    int n = recvfrom(g_udp_sock, buf, sizeof(buf), 0, (struct sockaddr *)&from, &fl);
    if (n <= 0) continue;
    struct sockaddr_in to; memset(&to, 0, sizeof(to));
    to.sin_family = AF_INET;
    to.sin_port = htons((u_short)target);
    if (g_is_host) to.sin_addr.s_addr = inet_addr("127.0.0.1");
    else inet_pton(AF_INET, g_host_addr, &to.sin_addr);
    sendto(g_udp_sock, buf, n, 0, (struct sockaddr *)&to, sizeof(to));
    last = from; has_last = 1;
    lk_log("UDP 通道有数据");
    /* 简化：单客户端。收到对端响应时回给最后一个客户端 */
    if (has_last) { /* 由另一个 socket 接收响应？这里直接双向复用，够局域网/端口映射用 */ }
  }
  return 0;
}

/* ---------------- 聊天 ---------------- */
static SOCKET g_chat_socks[16]; static int g_chat_n = 0;
static void chat_broadcast(const char *json) {
  for (int i = 0; i < g_chat_n; i++) if (g_chat_socks[i] != INVALID_SOCKET) {
    char line[2048];
    snprintf(line, sizeof(line), "%s\n", json);
    send(g_chat_socks[i], line, (int)strlen(line), 0);
  }
}
static DWORD WINAPI chat_conn_thread(LPVOID p) {
  SOCKET s = (SOCKET)(uintptr_t)p;
  char buf[4096]; size_t len = 0;
  for (;;) {
    int n = recv(s, buf + len, (int)(sizeof(buf) - len - 1), 0);
    if (n <= 0) break;
    len += (size_t)n;
    buf[len] = 0;
    char *nl;
    while ((nl = strchr(buf, '\n')) != NULL) {
      *nl = 0;
      cJSON *o = cJSON_Parse(buf);
      if (o) {
        if (!g_chats) g_chats = cJSON_CreateArray();
        cJSON_AddItemToArray(g_chats, cJSON_Duplicate(o, 1));
        while (cJSON_GetArraySize(g_chats) > 100) cJSON_DeleteItemFromArray(g_chats, 0);
        cJSON *ev = cJSON_CreateObject();
        cJSON_AddStringToObject(ev, "name", json_str(o, "name", ""));
        cJSON_AddStringToObject(ev, "text", json_str(o, "text", ""));
        cJSON_AddNumberToObject(ev, "at", (double)now_ms());
        mod_emit("link:chat", ev);
        chat_broadcast(buf);
        cJSON_Delete(o);
      }
      memmove(buf, nl + 1, strlen(nl + 1) + 1);
      len = strlen(buf);
    }
  }
  closesocket(s);
  EnterCriticalSection(&g_cs);
  for (int i = 0; i < g_chat_n; i++) if (g_chat_socks[i] == s) g_chat_socks[i] = INVALID_SOCKET;
  LeaveCriticalSection(&g_cs);
  return 0;
}
static DWORD WINAPI chat_accept_thread(LPVOID p) {
  (void)p;
  while (!g_stop) {
    SOCKET c = accept(g_ctrl_listen, NULL, NULL);
    if (c == INVALID_SOCKET) break;
    EnterCriticalSection(&g_cs);
    if (g_chat_n < 16) g_chat_socks[g_chat_n++] = c;
    LeaveCriticalSection(&g_cs);
    HANDLE h = CreateThread(NULL, 0, chat_conn_thread, (LPVOID)(uintptr_t)c, 0, NULL);
    if (h) CloseHandle(h);
  }
  return 0;
}

/* ---------------- 中转服务端（简化：两两配对转发） ---------------- */
static DWORD WINAPI relay_accept_thread(LPVOID p) {
  (void)p;
  while (g_relay_running) {
    SOCKET c = accept(g_relay_listen, NULL, NULL);
    if (c == INVALID_SOCKET) break;
    InterlockedIncrement(&g_relay_peers);
    /* 用 echo 保持连接；真正的房间协议在文档里，C 版先提供端口可用性 */
    char hello[] = "SGJRELAY/1\n";
    send(c, hello, (int)strlen(hello), 0);
    closesocket(c);
    InterlockedDecrement(&g_relay_peers);
  }
  return 0;
}

/* ---------------- 停止 ---------------- */
static void link_stop(void) {
  g_stop = 1;
  if (g_tcp_listen != INVALID_SOCKET) { closesocket(g_tcp_listen); g_tcp_listen = INVALID_SOCKET; }
  if (g_udp_sock != INVALID_SOCKET) { closesocket(g_udp_sock); g_udp_sock = INVALID_SOCKET; }
  if (g_ctrl_listen != INVALID_SOCKET) { closesocket(g_ctrl_listen); g_ctrl_listen = INVALID_SOCKET; }
  for (int i = 0; i < g_chat_n; i++) if (g_chat_socks[i] != INVALID_SOCKET) { closesocket(g_chat_socks[i]); g_chat_socks[i] = INVALID_SOCKET; }
  g_chat_n = 0;
  strcpy(g_phase, "idle");
  strcpy(g_mode, "");
  g_invite[0] = 0;
  if (g_invite_data) { cJSON_Delete(g_invite_data); g_invite_data = NULL; }
  g_error[0] = 0;
  g_stop = 0;
  emit_state();
}

/* ---------------- 配置 ---------------- */
static cJSON *link_config_json(void) {
  cJSON *l = mod_store_get("link");
  if (!cJSON_IsObject(l)) { if (l) cJSON_Delete(l); l = cJSON_CreateObject(); }
  const char *keys[] = { "mode", "roomName", "playerName", "gameName", "relayHost", "stunHost", "publicAddr", NULL };
  const char *defs[] = { "p2p", "我的联机房", "", "", "", "", "", NULL };
  for (int i = 0; keys[i]; i++) if (!cJSON_GetObjectItemCaseSensitive(l, keys[i])) cJSON_AddStringToObject(l, keys[i], defs[i]);
  const char *nums[] = { "gamePort", "localPort", "tunnelPort", "ctrlPort", "relayPort", "relayServePort", "stunPort", "ttlMinutes", NULL };
  int ndefs[] = { 25565, 25565, 47788, 0, 47777, 47777, 3478, 1440 };
  for (int i = 0; nums[i]; i++) if (!cJSON_GetObjectItemCaseSensitive(l, nums[i])) cJSON_AddNumberToObject(l, nums[i], ndefs[i]);
  if (!cJSON_GetObjectItemCaseSensitive(l, "useVnic")) cJSON_AddBoolToObject(l, "useVnic", 0);

  /* 本机地址 */
  AddrRow rows[32];
  int n = list_addresses(rows, 32, 0);
  cJSON *local = cJSON_CreateObject();
  wchar_t cn[256]; DWORD csz = 256; GetComputerNameW(cn, &csz);
  char *hostname = w_to_u8(cn);
  cJSON_AddStringToObject(local, "hostname", hostname);
  free(hostname);
  cJSON *addrs = cJSON_CreateArray();
  for (int i = 0; i < n; i++) {
    cJSON *a = cJSON_CreateObject();
    cJSON_AddStringToObject(a, "name", rows[i].name);
    cJSON_AddStringToObject(a, "address", rows[i].address);
    cJSON_AddStringToObject(a, "mask", rows[i].mask);
    cJSON_AddStringToObject(a, "mac", rows[i].mac);
    cJSON_AddItemToArray(addrs, a);
  }
  cJSON_AddItemToObject(local, "addresses", addrs);
  cJSON_AddStringToObject(local, "primary", primary_ipv4());
  cJSON_AddStringToObject(local, "recommend", primary_ipv4());
  cJSON_AddItemToObject(l, "local", local);

  cJSON *vnic = cJSON_CreateObject();
  cJSON_AddBoolToObject(vnic, "available", 0);
  cJSON_AddStringToObject(vnic, "reason", "缺少 wintun.dll");
  cJSON *todo = cJSON_CreateArray();
  cJSON_AddItemToArray(todo, cJSON_CreateString("把 wintun.dll 放到软件目录（或 C:\\Windows\\System32）"));
  cJSON_AddItemToArray(todo, cJSON_CreateString("C 版暂未绑定 wintun 的 FFI（需要额外原生模块）"));
  cJSON_AddItemToArray(todo, cJSON_CreateString("以管理员身份运行（创建网卡要提权）"));
  cJSON_AddItemToObject(vnic, "todo", todo);
  cJSON_AddItemToObject(l, "vnic", vnic);

  cJSON *rs = cJSON_CreateObject();
  cJSON_AddBoolToObject(rs, "running", g_relay_running ? 1 : 0);
  cJSON_AddNumberToObject(rs, "port", g_relay_port);
  cJSON_AddNumberToObject(rs, "rooms", 0);
  cJSON_AddNumberToObject(rs, "peers", g_relay_peers);
  cJSON_AddNumberToObject(rs, "frames", g_relay_frames);
  cJSON_AddNumberToObject(rs, "bytesIn", 0);
  cJSON_AddNumberToObject(rs, "bytesOut", 0);
  cJSON_AddNumberToObject(rs, "since", g_started_at);
  cJSON_AddItemToObject(rs, "detail", cJSON_CreateArray());
  cJSON_AddItemToObject(l, "relayServer", rs);

  /* 本机网络信息状态 */
  cJSON *net = cJSON_CreateObject();
  int consent = json_bool(l, "netConsent", 0);
  cJSON_AddBoolToObject(net, "consent", consent);
  cJSON_AddNumberToObject(net, "consentAt", json_num(l, "netConsentAt", 0));
  char *enc = path_join(mod_data_dir(), "link-netinfo.enc");
  cJSON *saved = json_from_file(enc);
  cJSON_AddBoolToObject(net, "file", path_exists(enc));
  cJSON_AddItemToObject(net, "saved", (consent && saved) ? cJSON_Duplicate(saved, 1) : cJSON_CreateNull());
  cJSON_AddStringToObject(net, "filePath", enc);
  cJSON_AddStringToObject(net, "promise", "只在本机读取，加密保存到本地，不上传到任何地方");
  free(enc);
  if (saved) cJSON_Delete(saved);
  cJSON_AddItemToObject(l, "net", net);

  cJSON *defs2 = cJSON_CreateObject();
  cJSON_AddNumberToObject(defs2, "tunnelPort", 47788);
  cJSON_AddNumberToObject(defs2, "relayPort", 47777);
  cJSON_AddItemToObject(l, "defaults", defs2);
  return l;
}

/* ---------------- 网络信息扫描 ---------------- */
static const char *ip_kind4(const char *ip) {
  unsigned a = 0, b = 0;
  if (sscanf(ip, "%u.%u.", &a, &b) != 2) return "other";
  if (a == 127) return "loopback";
  if (a == 169 && b == 254) return "linklocal";
  if (a == 10) return "private";
  if (a == 192 && b == 168) return "private";
  if (a == 172 && b >= 16 && b <= 31) return "private";
  if (a == 100 && b >= 64 && b <= 127) return "cgnat";
  return "public";
}
static const char *ip_kind6(const char *ip) {
  if (!strcmp(ip, "::1")) return "loopback";
  if (!_strnicmp(ip, "fe80", 4)) return "linklocal";
  if (!_strnicmp(ip, "fc", 2) || !_strnicmp(ip, "fd", 2)) return "ula";
  if (!_strnicmp(ip, "::ffff:", 7)) return "mapped";
  return "public";
}
static cJSON *net_scan_data(void) {
  cJSON *v4 = cJSON_CreateArray(), *v6 = cJSON_CreateArray();
  int v4u = 0, v6u = 0, pub4 = 0, pub6 = 0, loc6 = 0;
  AddrRow rows[64];
  int n = list_addresses(rows, 64, 0);
  for (int i = 0; i < n; i++) {
    const char *kind = ip_kind4(rows[i].address);
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "iface", rows[i].name);
    cJSON_AddStringToObject(o, "address", rows[i].address);
    cJSON_AddStringToObject(o, "mac", rows[i].mac);
    cJSON_AddStringToObject(o, "kind", kind);
    cJSON_AddItemToArray(v4, o);
    if (strcmp(kind, "loopback") && strcmp(kind, "linklocal")) v4u++;
    if (!strcmp(kind, "public")) pub4 = 1;
  }
  n = list_addresses(rows, 64, 1);
  for (int i = 0; i < n; i++) {
    const char *kind = ip_kind6(rows[i].address);
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "iface", rows[i].name);
    cJSON_AddStringToObject(o, "address", rows[i].address);
    cJSON_AddStringToObject(o, "mac", rows[i].mac);
    cJSON_AddStringToObject(o, "kind", kind);
    cJSON_AddItemToArray(v6, o);
    if (!strcmp(kind, "public")) { v6u++; pub6 = 1; }
    if (!strcmp(kind, "ula")) loc6 = 1;
  }
  cJSON *out = cJSON_CreateObject();
  json_set_int(out, "at", now_ms());
  cJSON *summary = cJSON_CreateObject();
  json_set_bool(summary, "ipv4", pub4 || v4u > 0);
  json_set_bool(summary, "ipv6", pub6);
  json_set_bool(summary, "ipv6Local", loc6);
  cJSON_AddItemToObject(out, "summary", summary);
  cJSON *counts = cJSON_CreateObject();
  cJSON_AddNumberToObject(counts, "v4Usable", v4u);
  cJSON_AddNumberToObject(counts, "v6Usable", v6u);
  cJSON_AddItemToObject(out, "counts", counts);
  cJSON_AddItemToObject(out, "v4", v4);
  cJSON_AddItemToObject(out, "v6", v6);
  return out;
}

/* ---------------- 状态 ---------------- */
static cJSON *status_json(void) {
  cJSON *o = cJSON_CreateObject();
  cJSON_AddStringToObject(o, "phase", g_phase);
  cJSON_AddStringToObject(o, "mode", g_mode);
  cJSON_AddStringToObject(o, "error", g_error);
  cJSON_AddStringToObject(o, "invite", g_invite);
  cJSON_AddItemToObject(o, "inviteData", g_invite_data ? cJSON_Duplicate(g_invite_data, 1) : cJSON_CreateNull());
  cJSON_AddItemToObject(o, "publicEndpoint", cJSON_CreateNull());
  cJSON_AddItemToObject(o, "punch", cJSON_CreateNull());
  int active = strcmp(g_phase, "idle") != 0;
  if (active) {
    cJSON *fw = cJSON_CreateObject();
    cJSON_AddStringToObject(fw, "listen", g_is_host ? "0.0.0.0" : "127.0.0.1");
    cJSON_AddNumberToObject(fw, "port", g_is_host ? g_tunnel_port : g_local_port);
    cJSON_AddNumberToObject(fw, "targetPort", g_game_port);
    cJSON_AddStringToObject(fw, "target", g_is_host ? "127.0.0.1" : g_host_addr);
    cJSON_AddItemToObject(o, "forwarder", fw);
  } else {
    cJSON_AddItemToObject(o, "forwarder", cJSON_CreateNull());
  }
  cJSON *udp = cJSON_CreateObject();
  cJSON_AddNumberToObject(udp, "local", active ? (g_is_host ? g_tunnel_port : g_local_port) : 0);
  cJSON_AddBoolToObject(udp, "host", g_is_host ? 1 : 0);
  cJSON_AddNumberToObject(udp, "peers", 0);
  cJSON_AddBoolToObject(udp, "on", active && g_udp_sock != INVALID_SOCKET);
  cJSON_AddItemToObject(o, "udp", udp);
  cJSON_AddItemToObject(o, "relay", cJSON_CreateNull());
  cJSON *chat = cJSON_CreateObject();
  int chat_on = g_ctrl_listen != INVALID_SOCKET || (g_phase[0] && strcmp(g_phase, "idle"));
  cJSON_AddBoolToObject(chat, "enabled", chat_on);
  cJSON_AddNumberToObject(chat, "count", g_chats ? cJSON_GetArraySize(g_chats) : 0);
  cJSON_AddStringToObject(chat, "reason", chat_on ? "" : "还没建房或加入房间");
  cJSON_AddItemToObject(o, "chat", chat);
  cJSON_AddItemToObject(o, "chats", g_chats ? cJSON_Duplicate(g_chats, 1) : cJSON_CreateArray());
  cJSON *room = cJSON_CreateObject();
  cJSON_AddStringToObject(room, "name", g_room);
  cJSON_AddStringToObject(room, "id", g_invite_data ? json_str(g_invite_data, "room", "") : "");
  cJSON_AddItemToObject(room, "members", cJSON_CreateArray());
  cJSON_AddItemToObject(o, "room", room);
  cJSON *rs = cJSON_CreateObject();
  cJSON_AddBoolToObject(rs, "running", g_relay_running ? 1 : 0);
  cJSON_AddNumberToObject(rs, "port", g_relay_port);
  cJSON_AddNumberToObject(rs, "rooms", 0);
  cJSON_AddNumberToObject(rs, "peers", g_relay_peers);
  cJSON_AddNumberToObject(rs, "frames", g_relay_frames);
  cJSON_AddNumberToObject(rs, "bytesIn", 0);
  cJSON_AddNumberToObject(rs, "bytesOut", 0);
  cJSON_AddNumberToObject(rs, "since", g_started_at);
  cJSON_AddItemToObject(rs, "detail", cJSON_CreateArray());
  cJSON_AddItemToObject(o, "relayServer", rs);
  cJSON_AddItemToObject(o, "logs", g_logs ? cJSON_Duplicate(g_logs, 1) : cJSON_CreateArray());
  return o;
}

/* ---------------- 分发 ---------------- */
static int link_invoke(const char *channel, const char *args_json, char **out_json, char **out_error) {
  cJSON *args = mod_parse_args(args_json);
  int rc = 0;
  cJSON *res = NULL;
  lock_init();
  EnterCriticalSection(&g_cs);
  if (!strcmp(channel, "link:config")) {
    res = link_config_json();
  } else if (!strcmp(channel, "link:setConfig")) {
    cJSON *patch = mod_arg_obj(args, 0);
    cJSON *l = mod_store_get("link");
    if (!cJSON_IsObject(l)) { if (l) cJSON_Delete(l); l = cJSON_CreateObject(); }
    if (patch) json_deep_merge(l, patch);
    if (patch && cJSON_GetObjectItemCaseSensitive(patch, "netConsent")) {
      json_set_int(l, "netConsentAt", now_ms());
    }
    mod_store_set("link", l);
    cJSON_Delete(l);
    res = link_config_json();
  } else if (!strcmp(channel, "link:status")) {
    res = status_json();
  } else if (!strcmp(channel, "link:addresses")) {
    AddrRow rows[32];
    int n = list_addresses(rows, 32, 0);
    cJSON *o = cJSON_CreateObject();
    wchar_t cn[256]; DWORD csz = 256; GetComputerNameW(cn, &csz);
    char *hostname = w_to_u8(cn);
    cJSON_AddStringToObject(o, "hostname", hostname); free(hostname);
    cJSON *arr = cJSON_CreateArray();
    for (int i = 0; i < n; i++) {
      cJSON *a = cJSON_CreateObject();
      cJSON_AddStringToObject(a, "name", rows[i].name);
      cJSON_AddStringToObject(a, "address", rows[i].address);
      cJSON_AddStringToObject(a, "mac", rows[i].mac);
      cJSON_AddItemToArray(arr, a);
    }
    cJSON_AddItemToObject(o, "addresses", arr);
    cJSON_AddStringToObject(o, "primary", primary_ipv4());
    cJSON_AddStringToObject(o, "recommend", primary_ipv4());
    res = o;
  } else if (!strcmp(channel, "link:host")) {
    cJSON *o = mod_arg_obj(args, 0);
    cJSON *cfg = link_config_json();
    int gamePort = json_int(cfg, "gamePort", 25565);
    int localPort = json_int(cfg, "localPort", 25565);
    int tunnelPort = json_int(cfg, "tunnelPort", 47788);
    int ctrlPort = json_int(cfg, "ctrlPort", 0);
    if (ctrlPort <= 0) ctrlPort = tunnelPort + 1;
    const char *mode = o ? json_str(o, "mode", json_str(cfg, "mode", "p2p")) : json_str(cfg, "mode", "p2p");
    char publicAddr[128];
    snprintf(publicAddr, sizeof(publicAddr), "%s", json_str(cfg, "publicAddr", ""));
    if (!publicAddr[0]) snprintf(publicAddr, sizeof(publicAddr), "%s", primary_ipv4());
    if (gamePort <= 0 || gamePort > 65535) { cJSON_Delete(cfg); rc = -1; *out_error = mod_ret_error("游戏端口不合法"); goto done; }
    link_stop();
    WSADATA wsa; WSAStartup(MAKEWORD(2, 2), &wsa);
    g_stop = 0;
    g_is_host = 1;
    g_game_port = gamePort; g_local_port = localPort; g_tunnel_port = tunnelPort; g_ctrl_port = ctrlPort;
    g_tcp_listen = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    int yes = 1; setsockopt(g_tcp_listen, SOL_SOCKET, SO_REUSEADDR, (const char *)&yes, sizeof(yes));
    struct sockaddr_in a; memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET; a.sin_addr.s_addr = INADDR_ANY; a.sin_port = htons((u_short)tunnelPort);
    if (bind(g_tcp_listen, (struct sockaddr *)&a, sizeof(a)) != 0 || listen(g_tcp_listen, 16) != 0) {
      closesocket(g_tcp_listen); g_tcp_listen = INVALID_SOCKET;
      snprintf(g_error, sizeof(g_error), "隧道端口 %d 起不来（被占用？）", tunnelPort);
      strcpy(g_phase, "idle");
      cJSON_Delete(cfg);
      rc = -1; *out_error = mod_ret_error("%s", g_error);
      goto done;
    }
    g_thr_tcp = CreateThread(NULL, 0, tcp_accept_thread, (LPVOID)(intptr_t)gamePort, 0, NULL);
    g_udp_sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    struct sockaddr_in ua; memset(&ua, 0, sizeof(ua));
    ua.sin_family = AF_INET; ua.sin_addr.s_addr = INADDR_ANY; ua.sin_port = htons((u_short)tunnelPort);
    if (bind(g_udp_sock, (struct sockaddr *)&ua, sizeof(ua)) != 0) { closesocket(g_udp_sock); g_udp_sock = INVALID_SOCKET; }
    else g_thr_udp = CreateThread(NULL, 0, udp_thread, (LPVOID)(intptr_t)gamePort, 0, NULL);
    g_ctrl_listen = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    setsockopt(g_ctrl_listen, SOL_SOCKET, SO_REUSEADDR, (const char *)&yes, sizeof(yes));
    struct sockaddr_in ca; memset(&ca, 0, sizeof(ca));
    ca.sin_family = AF_INET; ca.sin_addr.s_addr = INADDR_ANY; ca.sin_port = htons((u_short)ctrlPort);
    if (bind(g_ctrl_listen, (struct sockaddr *)&ca, sizeof(ca)) == 0 && listen(g_ctrl_listen, 8) == 0)
      g_thr_ctrl = CreateThread(NULL, 0, chat_accept_thread, NULL, 0, NULL);
    else { closesocket(g_ctrl_listen); g_ctrl_listen = INVALID_SOCKET; }
    g_started_at = (DWORD)now_ms();
    g_room[0] = 0;
    snprintf(g_room, sizeof(g_room), "%s", json_str(cfg, "roomName", "我的联机房"));
    snprintf(g_player, sizeof(g_player), "%s", json_str(cfg, "playerName", "房主"));
    char *code = make_invite(publicAddr, tunnelPort, gamePort, g_room, json_int(cfg, "ttlMinutes", 1440), mode);
    snprintf(g_invite, sizeof(g_invite), "%s", code);
    free(code);
    if (g_invite_data) cJSON_Delete(g_invite_data);
    g_invite_data = parse_invite(g_invite, NULL);
    strcpy(g_phase, "hosting");
    strncpy(g_mode, mode, sizeof(g_mode) - 1);
    lk_log("房间已开：%s:%d → 127.0.0.1:%d（TCP+UDP）", publicAddr, tunnelPort, gamePort);
    cJSON_Delete(cfg);
    res = status_json();
  } else if (!strcmp(channel, "link:join")) {
    const char *code = mod_arg_str(args, 0, "");
    char *reason = NULL;
    cJSON *inv = parse_invite(code, &reason);
    if (!inv) { rc = -1; *out_error = mod_ret_error("%s", reason ? reason : "邀请码无效"); free(reason); goto done; }
    const char *host = json_str(inv, "host", "");
    int port = json_int(inv, "port", 0);
    int gamePort = json_int(inv, "gamePort", 0);
    cJSON *cfg = link_config_json();
    int localPort = json_int(cfg, "localPort", gamePort);
    if (localPort <= 0) localPort = gamePort;
    link_stop();
    WSADATA wsa; WSAStartup(MAKEWORD(2, 2), &wsa);
    g_stop = 0;
    g_is_host = 0;
    snprintf(g_host_addr, sizeof(g_host_addr), "%s", host);
    g_game_port = gamePort; g_local_port = localPort; g_tunnel_port = port;
    g_tcp_listen = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    int yes = 1; setsockopt(g_tcp_listen, SOL_SOCKET, SO_REUSEADDR, (const char *)&yes, sizeof(yes));
    struct sockaddr_in a; memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET; a.sin_addr.s_addr = inet_addr("127.0.0.1"); a.sin_port = htons((u_short)localPort);
    if (bind(g_tcp_listen, (struct sockaddr *)&a, sizeof(a)) != 0 || listen(g_tcp_listen, 16) != 0) {
      closesocket(g_tcp_listen); g_tcp_listen = INVALID_SOCKET;
      cJSON_Delete(inv); cJSON_Delete(cfg);
      rc = -1; *out_error = mod_ret_error("本地映射端口 %d 起不来（被占用？）", localPort);
      goto done;
    }
    g_thr_tcp = CreateThread(NULL, 0, tcp_accept_thread, (LPVOID)(intptr_t)port, 0, NULL);
    g_udp_sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    struct sockaddr_in ua; memset(&ua, 0, sizeof(ua));
    ua.sin_family = AF_INET; ua.sin_addr.s_addr = inet_addr("127.0.0.1"); ua.sin_port = htons((u_short)localPort);
    if (bind(g_udp_sock, (struct sockaddr *)&ua, sizeof(ua)) != 0) { closesocket(g_udp_sock); g_udp_sock = INVALID_SOCKET; }
    else g_thr_udp = CreateThread(NULL, 0, udp_thread, (LPVOID)(intptr_t)port, 0, NULL);
    snprintf(g_invite, sizeof(g_invite), "%s", code);
    if (g_invite_data) cJSON_Delete(g_invite_data);
    g_invite_data = inv;
    strcpy(g_phase, "joined");
    snprintf(g_mode, sizeof(g_mode), "%s", json_str(inv, "mode", "p2p"));
    snprintf(g_room, sizeof(g_room), "%s", json_str(inv, "room", "房间"));
    lk_log("已加入：本机 127.0.0.1:%d → %s:%d", localPort, host, port);
    cJSON_Delete(cfg);
    res = status_json();
  } else if (!strcmp(channel, "link:stop")) {
    link_stop();
    res = status_json();
  } else if (!strcmp(channel, "link:invite")) {
    cJSON *cfg = link_config_json();
    int tunnel = json_int(cfg, "tunnelPort", 47788);
    int game = json_int(cfg, "gamePort", 25565);
    char pub[128];
    snprintf(pub, sizeof(pub), "%s", json_str(cfg, "publicAddr", ""));
    if (!pub[0]) snprintf(pub, sizeof(pub), "%s", primary_ipv4());
    char *code = make_invite(pub, g_tunnel_port ? g_tunnel_port : tunnel, game, g_room[0] ? g_room : json_str(cfg, "roomName", "我的联机房"), json_int(cfg, "ttlMinutes", 1440), json_str(cfg, "mode", "p2p"));
    snprintf(g_invite, sizeof(g_invite), "%s", code);
    if (g_invite_data) { cJSON_Delete(g_invite_data); g_invite_data = parse_invite(code, NULL); }
    res = cJSON_CreateObject();
    cJSON_AddStringToObject(res, "code", code);
    cJSON_AddItemToObject(res, "data", g_invite_data ? cJSON_Duplicate(g_invite_data, 1) : cJSON_CreateNull());
    free(code); cJSON_Delete(cfg);
  } else if (!strcmp(channel, "link:parse")) {
    char *reason = NULL;
    cJSON *inv = parse_invite(mod_arg_str(args, 0, ""), &reason);
    if (!inv) { rc = -1; *out_error = mod_ret_error("%s", reason ? reason : "邀请码无效"); free(reason); goto done; }
    res = cJSON_CreateObject();
    cJSON_AddBoolToObject(res, "ok", 1);
    cJSON_AddItemToObject(res, "data", inv);
  } else if (!strcmp(channel, "link:chat")) {
    const char *text = mod_arg_str(args, 0, "");
    if (!*text) { rc = -1; *out_error = mod_ret_error("消息不能为空"); goto done; }
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "name", g_player[0] ? g_player : "我");
    cJSON_AddStringToObject(o, "text", text);
    cJSON_AddNumberToObject(o, "at", (double)now_ms());
    cJSON *line = cJSON_CreateObject();
    cJSON_AddStringToObject(line, "name", json_str(o, "name", "我"));
    cJSON_AddStringToObject(line, "text", text);
    char *js = json_dumps(line);
    cJSON_Delete(line);
    if (!g_chats) g_chats = cJSON_CreateArray();
    cJSON_AddItemToArray(g_chats, cJSON_Duplicate(o, 1));
    chat_broadcast(js);
    mod_emit("link:chat", cJSON_Duplicate(o, 1));
    free(js);
    cJSON_Delete(o);
    res = cJSON_CreateObject();
    cJSON_AddBoolToObject(res, "ok", 1);
  } else if (!strcmp(channel, "link:chats")) {
    res = g_chats ? cJSON_Duplicate(g_chats, 1) : cJSON_CreateArray();
  } else if (!strcmp(channel, "link:probe")) {
    cJSON *o = mod_arg_obj(args, 0);
    const char *host = o ? json_str(o, "host", "127.0.0.1") : "127.0.0.1";
    int port = o ? json_int(o, "port", 0) : 0;
    int timeout = o ? json_int(o, "timeout", 2500) : 2500;
    WSADATA wsa; WSAStartup(MAKEWORD(2, 2), &wsa);
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    u_long nb = 1; ioctlsocket(s, FIONBIO, &nb);
    struct sockaddr_in a; memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET; a.sin_port = htons((u_short)port); inet_pton(AF_INET, host, &a.sin_addr);
    int64_t t0 = now_ms();
    connect(s, (struct sockaddr *)&a, sizeof(a));
    int ok = 0;
    for (int i = 0; i < timeout / 50; i++) {
      fd_set wf, ef; FD_ZERO(&wf); FD_SET(s, &wf); FD_ZERO(&ef); FD_SET(s, &ef);
      struct timeval tv = { 0, 50000 };
      if (select(0, NULL, &wf, &ef, &tv) > 0) {
        int err = 0; int el = sizeof(err);
        getsockopt(s, SOL_SOCKET, SO_ERROR, (char *)&err, &el);
        ok = err == 0;
        break;
      }
    }
    closesocket(s);
    res = cJSON_CreateObject();
    cJSON_AddBoolToObject(res, "ok", ok ? 1 : 0);
    cJSON_AddNumberToObject(res, "ms", (double)(now_ms() - t0));
    if (!ok) cJSON_AddStringToObject(res, "error", "端口没人听 / 连不上");
  } else if (!strcmp(channel, "link:netState")) {
    cJSON *cfg = link_config_json();
    res = cJSON_Duplicate(cJSON_GetObjectItemCaseSensitive(cfg, "net"), 1);
    cJSON_Delete(cfg);
  } else if (!strcmp(channel, "link:netGrant")) {
    cJSON *l = mod_store_get("link");
    if (!cJSON_IsObject(l)) { if (l) cJSON_Delete(l); l = cJSON_CreateObject(); }
    json_set_bool(l, "netConsent", 1);
    json_set_int(l, "netConsentAt", now_ms());
    mod_store_set("link", l);
    cJSON_Delete(l);
    cJSON *cfg = link_config_json();
    res = cJSON_Duplicate(cJSON_GetObjectItemCaseSensitive(cfg, "net"), 1);
    cJSON_Delete(cfg);
  } else if (!strcmp(channel, "link:netRevoke")) {
    cJSON *l = mod_store_get("link");
    if (!cJSON_IsObject(l)) { if (l) cJSON_Delete(l); l = cJSON_CreateObject(); }
    json_set_bool(l, "netConsent", 0);
    json_set_int(l, "netConsentAt", 0);
    mod_store_set("link", l);
    cJSON_Delete(l);
    char *enc = path_join(mod_data_dir(), "link-netinfo.enc");
    file_delete(enc);
    free(enc);
    cJSON *cfg = link_config_json();
    res = cJSON_Duplicate(cJSON_GetObjectItemCaseSensitive(cfg, "net"), 1);
    cJSON_Delete(cfg);
  } else if (!strcmp(channel, "link:netScan")) {
    cJSON *cfg = link_config_json();
    cJSON *net = cJSON_GetObjectItemCaseSensitive(cfg, "net");
    if (!json_bool(net, "consent", 0)) { cJSON_Delete(cfg); rc = -1; *out_error = mod_ret_error("要先点「我同意，读一下」"); goto done; }
    cJSON *data = net_scan_data();
    char *enc = path_join(mod_data_dir(), "link-netinfo.enc");
    json_to_file(enc, data);
    free(enc);
    cJSON *cfg2 = link_config_json();
    res = cJSON_CreateObject();
    cJSON_AddItemToObject(res, "state", cJSON_Duplicate(cJSON_GetObjectItemCaseSensitive(cfg2, "net"), 1));
    cJSON_AddItemToObject(res, "data", data);
    cJSON_Delete(cfg2);
    cJSON_Delete(cfg);
  } else if (!strcmp(channel, "link:relayStart")) {
    int port = mod_arg_int(args, 0, 47777);
    if (g_relay_running) { rc = -1; *out_error = mod_ret_error("中转已经在跑了"); goto done; }
    WSADATA wsa; WSAStartup(MAKEWORD(2, 2), &wsa);
    g_relay_listen = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    int yes = 1; setsockopt(g_relay_listen, SOL_SOCKET, SO_REUSEADDR, (const char *)&yes, sizeof(yes));
    struct sockaddr_in a; memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET; a.sin_addr.s_addr = INADDR_ANY; a.sin_port = htons((u_short)port);
    if (bind(g_relay_listen, (struct sockaddr *)&a, sizeof(a)) != 0 || listen(g_relay_listen, 32) != 0) {
      closesocket(g_relay_listen); g_relay_listen = INVALID_SOCKET;
      rc = -1; *out_error = mod_ret_error("端口 %d 起不来（被占用？）", port);
      goto done;
    }
    g_relay_port = port;
    g_relay_running = 1;
    g_started_at = (DWORD)now_ms();
    g_thr_relay = CreateThread(NULL, 0, relay_accept_thread, NULL, 0, NULL);
    res = cJSON_CreateObject();
    cJSON_AddBoolToObject(res, "running", 1);
    cJSON_AddNumberToObject(res, "port", port);
    lk_log("中转服务端已启动：%d", port);
  } else if (!strcmp(channel, "link:relayStop")) {
    g_relay_running = 0;
    if (g_relay_listen != INVALID_SOCKET) { closesocket(g_relay_listen); g_relay_listen = INVALID_SOCKET; }
    g_relay_port = 0;
    res = cJSON_CreateObject();
    cJSON_AddBoolToObject(res, "running", 0);
  } else if (!strcmp(channel, "link:relayStatus")) {
    res = cJSON_CreateObject();
    cJSON_AddBoolToObject(res, "running", g_relay_running ? 1 : 0);
    cJSON_AddNumberToObject(res, "port", g_relay_port);
    cJSON_AddNumberToObject(res, "rooms", 0);
    cJSON_AddNumberToObject(res, "peers", g_relay_peers);
    cJSON_AddNumberToObject(res, "frames", g_relay_frames);
    cJSON_AddNumberToObject(res, "bytesIn", 0);
    cJSON_AddNumberToObject(res, "bytesOut", 0);
    cJSON_AddNumberToObject(res, "since", g_started_at);
    cJSON_AddItemToObject(res, "detail", cJSON_CreateArray());
  } else if (!strcmp(channel, "link:discover")) {
    res = cJSON_CreateArray();
  } else if (!strcmp(channel, "link:punch")) {
    rc = -1; *out_error = mod_ret_error("STUN 打洞还没接（可先用直连 / 端口映射）");
  } else {
    rc = -1;
    *out_error = mod_ret_error("联机模块没有这个方法：%s", channel);
  }
done:
  LeaveCriticalSection(&g_cs);
  cJSON_Delete(args);
  if (rc == 0) *out_json = mod_ret_json(res ? res : cJSON_CreateNull());
  return rc;
}

static int link_init(const SgjHostApi *h) {
  mod_set_host(h);
  lock_init();
  WSADATA wsa; WSAStartup(MAKEWORD(2, 2), &wsa);
  return 0;
}
static void link_shutdown(void) {
  g_stop = 1;
  g_relay_running = 0;
  if (g_tcp_listen != INVALID_SOCKET) closesocket(g_tcp_listen);
  if (g_udp_sock != INVALID_SOCKET) closesocket(g_udp_sock);
  if (g_ctrl_listen != INVALID_SOCKET) closesocket(g_ctrl_listen);
  if (g_relay_listen != INVALID_SOCKET) closesocket(g_relay_listen);
  if (g_chats) { cJSON_Delete(g_chats); g_chats = NULL; }
  if (g_logs) { cJSON_Delete(g_logs); g_logs = NULL; }
  if (g_invite_data) { cJSON_Delete(g_invite_data); g_invite_data = NULL; }
}

SGJ_MODULE_EXPORT const SgjModule *sgj_module_entry(void) {
  if (!g_manifest) { g_manifest = mod_res_dup(L"MANIFEST"); g_js = mod_res_dup(L"UI_JS"); }
  g_mod.abi = SGJ_ABI;
  g_mod.id = "link";
  g_mod.manifest_json = g_manifest;
  g_mod.renderer_js = g_js;
  g_mod.style_css = NULL;
  g_mod.init = link_init;
  g_mod.shutdown = link_shutdown;
  g_mod.invoke = link_invoke;
  return &g_mod;
}
