#include "browser_view.h"
#include "webview.h"
#include "dialogs.h"
#include "store.h"
#include <WebView2.h>
#include <shellapi.h>
#include <shlobj.h>

#pragma comment(lib, "ole32.lib")

/* 宿主内嵌的浏览器子 WebView2：只负责「一块网页画布」。
   🔴 WebView2 的 COM 调用必须在创建它的 UI 线程上做；而 IPC 请求跑在
   HTTP 工作线程里 —— 所以这里用一个 message-only 窗口把调用 SendMessage 回 UI 线程。 */
extern ICoreWebView2Environment *webview_env(void);

#define WM_BV_SHOW   (WM_APP + 101)
#define WM_BV_HIDE   (WM_APP + 102)
#define WM_BV_NAV    (WM_APP + 103)
#define WM_BV_BACK   (WM_APP + 104)
#define WM_BV_FWD    (WM_APP + 105)
#define WM_BV_RELOAD (WM_APP + 106)
#define WM_BV_STOP   (WM_APP + 107)
#define WM_BV_STATE  (WM_APP + 108)
#define WM_BV_COOKIES (WM_APP + 109)

static HWND g_parent = NULL, g_child = NULL, g_msgwnd = NULL;
static ICoreWebView2Controller *g_ctrl = NULL;
static ICoreWebView2 *g_wv = NULL;
static int g_creating = 0;
static char g_pending_url[2048];

typedef struct { int x, y, w, h; double dpr; char url[2048]; } ShowReq;

static void emit_state(void) {
  if (!g_wv) return;
  cJSON *o = cJSON_CreateObject();
  LPWSTR uri = NULL, title = NULL;
  BOOL back = FALSE, fwd = FALSE;
  g_wv->lpVtbl->get_Source(g_wv, &uri);
  g_wv->lpVtbl->get_DocumentTitle(g_wv, &title);
  g_wv->lpVtbl->get_CanGoBack(g_wv, &back);
  g_wv->lpVtbl->get_CanGoForward(g_wv, &fwd);
  char *u = uri ? w_to_u8(uri) : xstrdup("");
  char *t = title ? w_to_u8(title) : xstrdup("");
  cJSON_AddStringToObject(o, "url", u);
  cJSON_AddStringToObject(o, "title", t);
  cJSON_AddBoolToObject(o, "canBack", back ? 1 : 0);
  cJSON_AddBoolToObject(o, "canForward", fwd ? 1 : 0);
  if (uri) CoTaskMemFree(uri);
  if (title) CoTaskMemFree(title);
  free(u); free(t);
  bus_emit("browser:state", o);
}

/* ---------- COM 回调 ---------- */
typedef struct { ICoreWebView2NavigationCompletedEventHandlerVtbl *lpVtbl; LONG ref; } NavCb;
static HRESULT STDMETHODCALLTYPE Nav_QI(ICoreWebView2NavigationCompletedEventHandler *T, REFIID riid, void **ppv) { *ppv = T; return S_OK; }
static ULONG STDMETHODCALLTYPE Nav_AddRef(ICoreWebView2NavigationCompletedEventHandler *T) { return InterlockedIncrement(&((NavCb *)T)->ref); }
static ULONG STDMETHODCALLTYPE Nav_Release(ICoreWebView2NavigationCompletedEventHandler *T) { return InterlockedDecrement(&((NavCb *)T)->ref); }
static HRESULT STDMETHODCALLTYPE Nav_Invoke(ICoreWebView2NavigationCompletedEventHandler *T, ICoreWebView2 *s, ICoreWebView2NavigationCompletedEventArgs *a) { (void)T; (void)s; (void)a; emit_state(); return S_OK; }
static ICoreWebView2NavigationCompletedEventHandlerVtbl g_navVtbl = { Nav_QI, Nav_AddRef, Nav_Release, Nav_Invoke };
static NavCb g_nav = { &g_navVtbl, 1 };

typedef struct { ICoreWebView2DocumentTitleChangedEventHandlerVtbl *lpVtbl; LONG ref; } TitleCb;
static HRESULT STDMETHODCALLTYPE Title_QI(ICoreWebView2DocumentTitleChangedEventHandler *T, REFIID riid, void **ppv) { *ppv = T; return S_OK; }
static ULONG STDMETHODCALLTYPE Title_AddRef(ICoreWebView2DocumentTitleChangedEventHandler *T) { return InterlockedIncrement(&((TitleCb *)T)->ref); }
static ULONG STDMETHODCALLTYPE Title_Release(ICoreWebView2DocumentTitleChangedEventHandler *T) { return InterlockedDecrement(&((TitleCb *)T)->ref); }
static HRESULT STDMETHODCALLTYPE Title_Invoke(ICoreWebView2DocumentTitleChangedEventHandler *T, ICoreWebView2 *s, IUnknown *a) { (void)T; (void)s; (void)a; emit_state(); return S_OK; }
static ICoreWebView2DocumentTitleChangedEventHandlerVtbl g_titleVtbl = { Title_QI, Title_AddRef, Title_Release, Title_Invoke };
static TitleCb g_title = { &g_titleVtbl, 1 };

typedef struct { ICoreWebView2NewWindowRequestedEventHandlerVtbl *lpVtbl; LONG ref; } NwCb;
static HRESULT STDMETHODCALLTYPE Nw_QI(ICoreWebView2NewWindowRequestedEventHandler *T, REFIID riid, void **ppv) { *ppv = T; return S_OK; }
static ULONG STDMETHODCALLTYPE Nw_AddRef(ICoreWebView2NewWindowRequestedEventHandler *T) { return InterlockedIncrement(&((NwCb *)T)->ref); }
static ULONG STDMETHODCALLTYPE Nw_Release(ICoreWebView2NewWindowRequestedEventHandler *T) { return InterlockedDecrement(&((NwCb *)T)->ref); }
static HRESULT STDMETHODCALLTYPE Nw_Invoke(ICoreWebView2NewWindowRequestedEventHandler *T, ICoreWebView2 *s, ICoreWebView2NewWindowRequestedEventArgs *a) {
  (void)T; (void)s;
  if (!a) return S_OK;
  /* 网页里点开的新窗口（target=_blank / window.open）：不在当前页覆盖，
     发事件给界面，由它开一个新标签页 */
  LPWSTR uri = NULL;
  a->lpVtbl->get_Uri(a, &uri);
  if (uri) {
    char *u8 = w_to_u8(uri);
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "url", u8 ? u8 : "");
    bus_emit("browser:newtab", o);
    free(u8);
    CoTaskMemFree(uri);
  }
  a->lpVtbl->put_Handled(a, TRUE);
  return S_OK;
}
static ICoreWebView2NewWindowRequestedEventHandlerVtbl g_nwVtbl = { Nw_QI, Nw_AddRef, Nw_Release, Nw_Invoke };
static NwCb g_nw = { &g_nwVtbl, 1 };

/* ---------- 下载：接管 DownloadStarting ----------
   🔴 不接管的话 WebView2 用它自己的默认行为，我们控制不了保存位置。
   现在每次下载弹「另存为」，对话框从**上次用过的文件夹**打开；
   确认后记住那个文件夹，下次还从那儿开始。取消 = 放弃这次下载。 */
typedef struct { ICoreWebView2DownloadStartingEventHandlerVtbl *lpVtbl; LONG ref; } DlCb;
static HRESULT STDMETHODCALLTYPE Dl_QI(ICoreWebView2DownloadStartingEventHandler *T, REFIID riid, void **ppv) { *ppv = T; return S_OK; }
static ULONG STDMETHODCALLTYPE Dl_AddRef(ICoreWebView2DownloadStartingEventHandler *T) { return InterlockedIncrement(&((DlCb *)T)->ref); }
static ULONG STDMETHODCALLTYPE Dl_Release(ICoreWebView2DownloadStartingEventHandler *T) { return InterlockedDecrement(&((DlCb *)T)->ref); }

/* 从 Content-Disposition / URI 里猜一个像样的文件名（SDK 这版没有 SuggestedFileName） */
static void suggest_name(ICoreWebView2DownloadOperation *op, wchar_t *out, size_t cap) {
  wchar_t *cd = NULL, *uri = NULL;
  if (op) op->lpVtbl->get_ContentDisposition(op, &cd);
  if (op && (!cd || !*cd)) op->lpVtbl->get_Uri(op, &uri);
  const wchar_t *src = NULL;
  if (cd && *cd) {
    /* filename="xxx.mp4"; filename*=UTF-8''xxx —— 两种都容忍 */
    const wchar_t *f = cd;
    const wchar_t *star = wcsstr(f, L"filename*=");
    const wchar_t *plain = wcsstr(f, L"filename=");
    if (star && (!plain || star < plain)) {
      f = star + 10;
      const wchar_t *q = wcschr(f, L'\'');            /* UTF-8''名字 —— 取最后一段引号之后 */
      if (q) f = q + 1;
      if (*f == L'\'') f++;                            /* 第二个引号 */
    } else if (plain) {
      f = plain + 9;
    }
    while (*f == L' ' || *f == L'"') f++;
    src = f;
  } else if (uri && *uri) {
    src = uri;
  }
  if (src) {
    /* 截到引号 / 分号 / 问号（查询串）/ 斜杠（取最后一段）为止 */
    wchar_t tmp[MAX_PATH * 2];
    size_t k = 0;
    for (const wchar_t *p = src; *p && k + 1 < sizeof(tmp) / sizeof(tmp[0]); p++) {
      if (*p == L'"' || *p == L';' || *p == L'?' || *p == L'#') break;
      tmp[k++] = *p;
    }
    tmp[k] = 0;
    const wchar_t *base = wcsrchr(tmp, L'/');
    const wchar_t *q = wcsrchr(tmp, L'\\');
    if (q && (!base || q > base)) base = q;
    base = base ? base + 1 : tmp;
    /* URL 编码的字符先解一层（%E8%A7%86 → 中文） */
    char *u8 = w_to_u8(base);
    if (u8) {
      char *dec = url_decode(u8);
      free(u8);
      if (dec && *dec) {
        for (char *p = dec; *p; p++) if (strchr("\\/:*?\"<>|", *p)) *p = '_';
        wchar_t *w = u8_to_w(dec);
        free(dec);
        if (w) { wcsncpy(out, w, cap - 1); out[cap - 1] = 0; free(w); return; }
      } else free(dec);
    }
    wcsncpy(out, base, cap - 1); out[cap - 1] = 0;
    for (wchar_t *p = out; *p; p++) if (wcschr(L"\\/:*?\"<>|", *p)) *p = L'_';
    return;
  }
  wcsncpy(out, L"下载文件", cap - 1);
  out[cap - 1] = 0;
}

/* 系统下载文件夹（这套 SDK 没有 CSIDL_DOWNLOADS，走 Known Folder） */
static char *downloads_dir(void) {
  PWSTR p = NULL;
  if (SUCCEEDED(SHGetKnownFolderPath(&FOLDERID_Downloads, 0, NULL, &p))) {
    char *u = w_to_u8(p);
    CoTaskMemFree(p);
    return u ? u : xstrdup("");
  }
  return xstrdup("");
}

static HRESULT STDMETHODCALLTYPE Dl_Invoke(ICoreWebView2DownloadStartingEventHandler *T, ICoreWebView2 *s, ICoreWebView2DownloadStartingEventArgs *a) {
  (void)T; (void)s;
  if (!a) return S_OK;
  /* 默认起点：上次下载用的文件夹 > 系统下载文件夹 */
  char last[MAX_PATH * 2] = "";
  cJSON *cfg = store_get("browserDownload");
  if (cfg) {
    const char *d = json_str(cfg, "dir", "");
    if (d && *d) snprintf(last, sizeof(last), "%s", d);
    cJSON_Delete(cfg);
  }
  if (!last[0]) {
    char *dl = downloads_dir();
    snprintf(last, sizeof(last), "%s", (dl && *dl) ? dl : ".");
    free(dl);
  }
  wchar_t suggest[MAX_PATH * 2];
  suggest[0] = 0;
  ICoreWebView2DownloadOperation *op = NULL;
  if (SUCCEEDED(a->lpVtbl->get_DownloadOperation(a, &op)) && op) {
    suggest_name(op, suggest, sizeof(suggest) / sizeof(suggest[0]));
    op->lpVtbl->Release(op);
  }
  if (!suggest[0]) { wcsncpy(suggest, L"下载文件", 15); suggest[15] = 0; }
  char *nm8 = w_to_u8(suggest);
  char *picked = dlg_save_at(g_parent, "保存下载文件", NULL, nm8 ? nm8 : "", last);
  free(nm8);
  if (!picked || !*picked) {           /* 用户取消 = 不要这次下载 */
    a->lpVtbl->put_Cancel(a, TRUE);
    free(picked);
    return S_OK;
  }
  cJSON *save = cJSON_CreateObject();  /* 记住文件夹，下次对话框从这里打开 */
  char *dirp = path_dirname(picked);
  cJSON_AddStringToObject(save, "dir", dirp ? dirp : "");
  free(dirp);
  store_set("browserDownload", save);
  cJSON_Delete(save);
  wchar_t *wp = u8_to_w(picked);
  if (wp) a->lpVtbl->put_ResultFilePath(a, wp);
  free(wp);
  a->lpVtbl->put_Handled(a, TRUE);
  free(picked);
  return S_OK;
}
static ICoreWebView2DownloadStartingEventHandlerVtbl g_dlVtbl = { Dl_QI, Dl_AddRef, Dl_Release, Dl_Invoke };
static DlCb g_dl = { &g_dlVtbl, 1 };

/* ---------- Cookie 抓取（音乐 / 网盘登录复用浏览器登录态） ---------- */
typedef struct CookieReq {
  wchar_t uri[2048];
  HANDLE ev;
  char *header;
  int count;
  volatile LONG abandoned;
} CookieReq;

typedef struct {
  ICoreWebView2GetCookiesCompletedHandlerVtbl *lpVtbl;
  LONG ref;
  CookieReq *req;
} CookieCb;

static HRESULT STDMETHODCALLTYPE Cookie_QI(ICoreWebView2GetCookiesCompletedHandler *T, REFIID riid, void **ppv) {
  (void)riid;
  *ppv = T;
  return S_OK;
}
static ULONG STDMETHODCALLTYPE Cookie_AddRef(ICoreWebView2GetCookiesCompletedHandler *T) {
  return InterlockedIncrement(&((CookieCb *)T)->ref);
}
static ULONG STDMETHODCALLTYPE Cookie_Release(ICoreWebView2GetCookiesCompletedHandler *T) {
  LONG n = InterlockedDecrement(&((CookieCb *)T)->ref);
  if (n == 0) free(T);
  return n;
}
static HRESULT STDMETHODCALLTYPE Cookie_Invoke(ICoreWebView2GetCookiesCompletedHandler *T,
                                               HRESULT hr, ICoreWebView2CookieList *list) {
  CookieCb *cb = (CookieCb *)T;
  CookieReq *r = cb->req;
  if (!r || InterlockedCompareExchange(&r->abandoned, 0, 0)) return S_OK;
  if (SUCCEEDED(hr) && list) {
    UINT32 n = 0;
    list->lpVtbl->get_Count(list, &n);
    Buf b; buf_init(&b);
    for (UINT32 i = 0; i < n; i++) {
      ICoreWebView2Cookie *c = NULL;
      if (FAILED(list->lpVtbl->GetValueAtIndex(list, i, &c)) || !c) continue;
      LPWSTR nm = NULL, val = NULL;
      c->lpVtbl->get_Name(c, &nm);
      c->lpVtbl->get_Value(c, &val);
      if (nm && val) {
        char *n8 = w_to_u8(nm), *v8 = w_to_u8(val);
        if (n8 && *n8) buf_addf(&b, "%s=%s; ", n8, v8 ? v8 : "");
        free(n8); free(v8);
      }
      if (nm) CoTaskMemFree(nm);
      if (val) CoTaskMemFree(val);
      c->lpVtbl->Release(c);
    }
    r->header = buf_take(&b);
    r->count = (int)n;
  }
  SetEvent(r->ev);
  return S_OK;
}
static ICoreWebView2GetCookiesCompletedHandlerVtbl g_cookieVtbl = { Cookie_QI, Cookie_AddRef, Cookie_Release, Cookie_Invoke };

typedef struct { ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerVtbl *lpVtbl; LONG ref; } BCtrlCb;
static HRESULT STDMETHODCALLTYPE BCtrl_QI(ICoreWebView2CreateCoreWebView2ControllerCompletedHandler *T, REFIID riid, void **ppv) { *ppv = T; return S_OK; }
static ULONG STDMETHODCALLTYPE BCtrl_AddRef(ICoreWebView2CreateCoreWebView2ControllerCompletedHandler *T) { return InterlockedIncrement(&((BCtrlCb *)T)->ref); }
static ULONG STDMETHODCALLTYPE BCtrl_Release(ICoreWebView2CreateCoreWebView2ControllerCompletedHandler *T) { return InterlockedDecrement(&((BCtrlCb *)T)->ref); }
static HRESULT STDMETHODCALLTYPE BCtrl_Invoke(ICoreWebView2CreateCoreWebView2ControllerCompletedHandler *T, HRESULT hr, ICoreWebView2Controller *ctrl);
static ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerVtbl g_bctrlVtbl = { BCtrl_QI, BCtrl_AddRef, BCtrl_Release, BCtrl_Invoke };
static BCtrlCb g_bctrl = { &g_bctrlVtbl, 1 };

static void update_bounds(void) {
  if (!g_ctrl || !g_child) return;
  RECT rc; GetClientRect(g_child, &rc);
  g_ctrl->lpVtbl->put_Bounds(g_ctrl, rc);
}

static HRESULT STDMETHODCALLTYPE BCtrl_Invoke(ICoreWebView2CreateCoreWebView2ControllerCompletedHandler *T, HRESULT hr, ICoreWebView2Controller *ctrl) {
  (void)T;
  g_creating = 0;
  if (FAILED(hr) || !ctrl) return S_OK;
  g_ctrl = ctrl; ctrl->lpVtbl->AddRef(ctrl);
  ctrl->lpVtbl->get_CoreWebView2(ctrl, &g_wv);
  if (g_wv) {
    g_wv->lpVtbl->AddRef(g_wv);
    g_wv->lpVtbl->add_NavigationCompleted(g_wv, (ICoreWebView2NavigationCompletedEventHandler *)&g_nav, NULL);
    g_wv->lpVtbl->add_DocumentTitleChanged(g_wv, (ICoreWebView2DocumentTitleChangedEventHandler *)&g_title, NULL);
    g_wv->lpVtbl->add_NewWindowRequested(g_wv, (ICoreWebView2NewWindowRequestedEventHandler *)&g_nw, NULL);
    /* 下载要走 ICoreWebView2_4 的 DownloadStarting（默认行为记不住文件夹） */
    ICoreWebView2_4 *w4 = NULL;
    if (SUCCEEDED(g_wv->lpVtbl->QueryInterface(g_wv, &IID_ICoreWebView2_4, (void **)&w4)) && w4) {
      w4->lpVtbl->add_DownloadStarting(w4, (ICoreWebView2DownloadStartingEventHandler *)&g_dl, NULL);
      w4->lpVtbl->Release(w4);
    }
    ICoreWebView2Settings *st = NULL;
    if (SUCCEEDED(g_wv->lpVtbl->get_Settings(g_wv, &st)) && st) {
      st->lpVtbl->put_IsStatusBarEnabled(st, FALSE);
      st->lpVtbl->put_AreDevToolsEnabled(st, TRUE);
      st->lpVtbl->Release(st);
    }
  }
  update_bounds();
  ctrl->lpVtbl->put_IsVisible(ctrl, TRUE);
  if (g_pending_url[0] && g_wv) {
    wchar_t *w = u8_to_w(g_pending_url);
    g_wv->lpVtbl->Navigate(g_wv, w);
    free(w);
    g_pending_url[0] = 0;
  }
  emit_state();
  return S_OK;
}

static void ensure_controller(void) {
  if (!g_child || g_ctrl || g_creating) return;
  ICoreWebView2Environment *env = webview_env();
  if (!env) return;
  g_creating = 1;
  env->lpVtbl->CreateCoreWebView2Controller(env, g_child,
      (ICoreWebView2CreateCoreWebView2ControllerCompletedHandler *)&g_bctrl);
}

static LRESULT CALLBACK BwChildProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  if (m == WM_SIZE) { update_bounds(); return 0; }
  return DefWindowProcW(h, m, w, l);
}

/* ---------- UI 线程里的实际操作 ---------- */
static void do_show(ShowReq *r) {
  if (!g_child) { free(r); return; }
  ensure_controller();
  double dpr = r->dpr > 0 ? r->dpr : 1.0;
  int px = (int)(r->x * dpr + 0.5), py = (int)(r->y * dpr + 0.5);
  int pw = (int)(r->w * dpr + 0.5), ph = (int)(r->h * dpr + 0.5);
  if (pw < 1) pw = 1;
  if (ph < 1) ph = 1;
  SetWindowPos(g_child, HWND_TOP, px, py, pw, ph, SWP_SHOWWINDOW);
  ShowWindow(g_child, SW_SHOW);
  update_bounds();
  if (g_ctrl) g_ctrl->lpVtbl->put_IsVisible(g_ctrl, TRUE);
  if (r->url[0]) {
    if (g_wv) {
      wchar_t *w = u8_to_w(r->url);
      g_wv->lpVtbl->Navigate(g_wv, w);
      free(w);
    } else snprintf(g_pending_url, sizeof(g_pending_url), "%s", r->url);
  }
  free(r);
}

static cJSON *make_state(void) {
  cJSON *o = cJSON_CreateObject();
  if (!g_wv) { cJSON_AddBoolToObject(o, "ready", 0); return o; }
  LPWSTR uri = NULL, title = NULL;
  BOOL back = FALSE, fwd = FALSE;
  g_wv->lpVtbl->get_Source(g_wv, &uri);
  g_wv->lpVtbl->get_DocumentTitle(g_wv, &title);
  g_wv->lpVtbl->get_CanGoBack(g_wv, &back);
  g_wv->lpVtbl->get_CanGoForward(g_wv, &fwd);
  char *u = uri ? w_to_u8(uri) : xstrdup("");
  char *t = title ? w_to_u8(title) : xstrdup("");
  cJSON_AddBoolToObject(o, "ready", 1);
  cJSON_AddStringToObject(o, "url", u);
  cJSON_AddStringToObject(o, "title", t);
  cJSON_AddBoolToObject(o, "canBack", back ? 1 : 0);
  cJSON_AddBoolToObject(o, "canForward", fwd ? 1 : 0);
  if (uri) CoTaskMemFree(uri);
  if (title) CoTaskMemFree(title);
  free(u); free(t);
  return o;
}

static LRESULT CALLBACK BVMsgProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
  case WM_BV_SHOW: do_show((ShowReq *)l); return 0;
  case WM_BV_HIDE:
    if (g_child) ShowWindow(g_child, SW_HIDE);
    if (g_ctrl) g_ctrl->lpVtbl->put_IsVisible(g_ctrl, FALSE);
    return 0;
  case WM_BV_NAV: {
    char *u = (char *)l;
    if (g_wv && u) { wchar_t *wu = u8_to_w(u); g_wv->lpVtbl->Navigate(g_wv, wu); free(wu); }
    else if (u) snprintf(g_pending_url, sizeof(g_pending_url), "%s", u);
    free(u);
    return 0;
  }
  case WM_BV_BACK: if (g_wv) g_wv->lpVtbl->GoBack(g_wv); return 0;
  case WM_BV_FWD: if (g_wv) g_wv->lpVtbl->GoForward(g_wv); return 0;
  case WM_BV_RELOAD: if (g_wv) g_wv->lpVtbl->Reload(g_wv); return 0;
  case WM_BV_STOP: if (g_wv) g_wv->lpVtbl->Stop(g_wv); return 0;
  case WM_BV_STATE: {
    cJSON **out = (cJSON **)l;
    *out = make_state();
    return 0;
  }
  case WM_BV_COOKIES: {
    CookieReq *r = (CookieReq *)l;
    int started = 0;
    if (g_wv && r) {
      ICoreWebView2_2 *w2 = NULL;
      if (SUCCEEDED(g_wv->lpVtbl->QueryInterface(g_wv, &IID_ICoreWebView2_2, (void **)&w2)) && w2) {
        ICoreWebView2CookieManager *cm = NULL;
        if (SUCCEEDED(w2->lpVtbl->get_CookieManager(w2, &cm)) && cm) {
          CookieCb *cb = (CookieCb *)xcalloc(1, sizeof(CookieCb));
          cb->lpVtbl = &g_cookieVtbl;
          cb->ref = 1;
          cb->req = r;
          if (SUCCEEDED(cm->lpVtbl->GetCookies(cm, r->uri, (ICoreWebView2GetCookiesCompletedHandler *)cb))) started = 1;
          else free(cb);
          cm->lpVtbl->Release(cm);
        }
        w2->lpVtbl->Release(w2);
      }
    }
    if (!started && r) SetEvent(r->ev);
    return 0;
  }
  }
  return DefWindowProcW(h, m, w, l);
}

void browser_view_init(HWND parent) {
  if (g_msgwnd) return;
  g_parent = parent;
  WNDCLASSEXW wc; memset(&wc, 0, sizeof(wc));
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = BVMsgProc;
  wc.hInstance = GetModuleHandleW(NULL);
  wc.lpszClassName = L"SGJBrowserMsg";
  RegisterClassExW(&wc);
  g_msgwnd = CreateWindowExW(0, L"SGJBrowserMsg", L"", 0, 0, 0, 0, 0, HWND_MESSAGE, NULL, GetModuleHandleW(NULL), NULL);

  WNDCLASSEXW bc; memset(&bc, 0, sizeof(bc));
  bc.cbSize = sizeof(bc);
  bc.lpfnWndProc = BwChildProc;
  bc.hInstance = GetModuleHandleW(NULL);
  bc.hCursor = LoadCursorW(NULL, IDC_ARROW);
  bc.lpszClassName = L"SGJBrowserChild";
  RegisterClassExW(&bc);
  g_child = CreateWindowExW(0, L"SGJBrowserChild", L"", WS_CHILD | WS_CLIPCHILDREN,
                            0, 0, 10, 10, parent, NULL, GetModuleHandleW(NULL), NULL);
  ShowWindow(g_child, SW_HIDE);
  ensure_controller();
}

int browser_view_exists(void) { return g_wv != NULL; }

void browser_view_show(int x, int y, int w, int h, double dpr, const char *url) {
  if (!g_msgwnd) return;
  ShowReq *r = (ShowReq *)xcalloc(1, sizeof(ShowReq));
  r->x = x; r->y = y; r->w = w; r->h = h; r->dpr = dpr;
  if (url) snprintf(r->url, sizeof(r->url), "%s", url);
  SendMessageW(g_msgwnd, WM_BV_SHOW, 0, (LPARAM)r);
}

void browser_view_hide(void) { if (g_msgwnd) SendMessageW(g_msgwnd, WM_BV_HIDE, 0, 0); }

void browser_view_navigate(const char *url) {
  if (!g_msgwnd || !url) return;
  char *u = xstrdup(url);
  SendMessageW(g_msgwnd, WM_BV_NAV, 0, (LPARAM)u);
}
void browser_view_back(void) { if (g_msgwnd) SendMessageW(g_msgwnd, WM_BV_BACK, 0, 0); }
void browser_view_forward(void) { if (g_msgwnd) SendMessageW(g_msgwnd, WM_BV_FWD, 0, 0); }
void browser_view_reload(void) { if (g_msgwnd) SendMessageW(g_msgwnd, WM_BV_RELOAD, 0, 0); }
void browser_view_stop(void) { if (g_msgwnd) SendMessageW(g_msgwnd, WM_BV_STOP, 0, 0); }

cJSON *browser_view_state(void) {
  cJSON *out = NULL;
  if (g_msgwnd) SendMessageW(g_msgwnd, WM_BV_STATE, 0, (LPARAM)&out);
  return out ? out : cJSON_CreateObject();
}

char *browser_view_cookies(const char *uri, int *count) {
  if (count) *count = 0;
  if (!g_msgwnd || !uri) return NULL;
  CookieReq *r = (CookieReq *)xcalloc(1, sizeof(CookieReq));
  r->ev = CreateEventW(NULL, FALSE, FALSE, NULL);
  wchar_t *wu = u8_to_w(uri);
  wcsncpy(r->uri, wu, 2047);
  r->uri[2047] = 0;
  free(wu);
  SendMessageW(g_msgwnd, WM_BV_COOKIES, 0, (LPARAM)r);
  DWORD w = WaitForSingleObject(r->ev, 10000);
  if (w != WAIT_OBJECT_0) {
    /* 回调还没回来：标记放弃，不释放 req（避免回调 UAF）；极小概率的泄漏换稳定 */
    InterlockedExchange(&r->abandoned, 1);
    return NULL;
  }
  char *out = r->header;
  r->header = NULL;
  if (count) *count = r->count;
  CloseHandle(r->ev);
  free(r);
  return out;
}
