#include "browser_view.h"
#include "webview.h"
#include <WebView2.h>
#include <shellapi.h>

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
  LPWSTR uri = NULL;
  a->lpVtbl->get_Uri(a, &uri);
  if (uri && g_wv) g_wv->lpVtbl->Navigate(g_wv, uri);
  if (uri) CoTaskMemFree(uri);
  a->lpVtbl->put_Handled(a, TRUE);
  return S_OK;
}
static ICoreWebView2NewWindowRequestedEventHandlerVtbl g_nwVtbl = { Nw_QI, Nw_AddRef, Nw_Release, Nw_Invoke };
static NwCb g_nw = { &g_nwVtbl, 1 };

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
