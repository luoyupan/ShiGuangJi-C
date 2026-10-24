#include "webview.h"
#include <WebView2.h>
#include <shellapi.h>

#pragma comment(lib, "WebView2LoaderStatic.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")

static ICoreWebView2Environment *g_env = NULL;
static ICoreWebView2Controller *g_ctrl = NULL;
static ICoreWebView2 *g_wv = NULL;
static HWND g_hwnd = NULL;
static char *g_url = NULL;

/* ---------------- 回调对象 ---------------- */
typedef struct { ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandlerVtbl *lpVtbl; LONG ref; } EnvCb;
static HRESULT STDMETHODCALLTYPE EnvCb_QI(ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *This, REFIID riid, void **ppv) { *ppv = This; return S_OK; }
static ULONG STDMETHODCALLTYPE EnvCb_AddRef(ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *This) { return InterlockedIncrement(&((EnvCb *)This)->ref); }
static ULONG STDMETHODCALLTYPE EnvCb_Release(ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *This) { return InterlockedDecrement(&((EnvCb *)This)->ref); }
static HRESULT STDMETHODCALLTYPE EnvCb_Invoke(ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *This, HRESULT hr, ICoreWebView2Environment *env);
static ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandlerVtbl g_envVtbl = { EnvCb_QI, EnvCb_AddRef, EnvCb_Release, EnvCb_Invoke };

typedef struct { ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerVtbl *lpVtbl; LONG ref; } CtrlCb;
static HRESULT STDMETHODCALLTYPE CtrlCb_QI(ICoreWebView2CreateCoreWebView2ControllerCompletedHandler *This, REFIID riid, void **ppv) { *ppv = This; return S_OK; }
static ULONG STDMETHODCALLTYPE CtrlCb_AddRef(ICoreWebView2CreateCoreWebView2ControllerCompletedHandler *This) { return InterlockedIncrement(&((CtrlCb *)This)->ref); }
static ULONG STDMETHODCALLTYPE CtrlCb_Release(ICoreWebView2CreateCoreWebView2ControllerCompletedHandler *This) { return InterlockedDecrement(&((CtrlCb *)This)->ref); }
static HRESULT STDMETHODCALLTYPE CtrlCb_Invoke(ICoreWebView2CreateCoreWebView2ControllerCompletedHandler *This, HRESULT hr, ICoreWebView2Controller *ctrl);
static ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerVtbl g_ctrlVtbl = { CtrlCb_QI, CtrlCb_AddRef, CtrlCb_Release, CtrlCb_Invoke };

typedef struct { ICoreWebView2NewWindowRequestedEventHandlerVtbl *lpVtbl; LONG ref; } NewWinCb;
static HRESULT STDMETHODCALLTYPE NewWinCb_QI(ICoreWebView2NewWindowRequestedEventHandler *This, REFIID riid, void **ppv) { *ppv = This; return S_OK; }
static ULONG STDMETHODCALLTYPE NewWinCb_AddRef(ICoreWebView2NewWindowRequestedEventHandler *This) { return InterlockedIncrement(&((NewWinCb *)This)->ref); }
static ULONG STDMETHODCALLTYPE NewWinCb_Release(ICoreWebView2NewWindowRequestedEventHandler *This) { return InterlockedDecrement(&((NewWinCb *)This)->ref); }
static HRESULT STDMETHODCALLTYPE NewWinCb_Invoke(ICoreWebView2NewWindowRequestedEventHandler *This,
    ICoreWebView2 *sender, ICoreWebView2NewWindowRequestedEventArgs *args);
static ICoreWebView2NewWindowRequestedEventHandlerVtbl g_newwinVtbl = { NewWinCb_QI, NewWinCb_AddRef, NewWinCb_Release, NewWinCb_Invoke };

typedef struct { ICoreWebView2PermissionRequestedEventHandlerVtbl *lpVtbl; LONG ref; } PermCb;
static HRESULT STDMETHODCALLTYPE PermCb_QI(ICoreWebView2PermissionRequestedEventHandler *This, REFIID riid, void **ppv) { *ppv = This; return S_OK; }
static ULONG STDMETHODCALLTYPE PermCb_AddRef(ICoreWebView2PermissionRequestedEventHandler *This) { return InterlockedIncrement(&((PermCb *)This)->ref); }
static ULONG STDMETHODCALLTYPE PermCb_Release(ICoreWebView2PermissionRequestedEventHandler *This) { return InterlockedDecrement(&((PermCb *)This)->ref); }
static HRESULT STDMETHODCALLTYPE PermCb_Invoke(ICoreWebView2PermissionRequestedEventHandler *This,
    ICoreWebView2 *sender, ICoreWebView2PermissionRequestedEventArgs *args);
static ICoreWebView2PermissionRequestedEventHandlerVtbl g_permVtbl = { PermCb_QI, PermCb_AddRef, PermCb_Release, PermCb_Invoke };

static EnvCb g_envcb = { &g_envVtbl, 1 };
static CtrlCb g_ctrlcb = { &g_ctrlVtbl, 1 };
static NewWinCb g_newwincb = { &g_newwinVtbl, 1 };
static PermCb g_permcb = { &g_permVtbl, 1 };

/* ---------------- 实现 ---------------- */
static void do_resize(void) {
  if (!g_ctrl || !g_hwnd) return;
  RECT rc;
  GetClientRect(g_hwnd, &rc);
  g_ctrl->lpVtbl->put_Bounds(g_ctrl, rc);
}

void webview_resize(void) { do_resize(); }

static HRESULT STDMETHODCALLTYPE NewWinCb_Invoke(ICoreWebView2NewWindowRequestedEventHandler *This,
    ICoreWebView2 *sender, ICoreWebView2NewWindowRequestedEventArgs *args) {
  (void)This; (void)sender;
  LPWSTR uri = NULL;
  if (args) {
    args->lpVtbl->get_Uri(args, &uri);
    if (uri) {
      char *u = w_to_u8(uri);
      if (u && (str_starts(u, "http://") || str_starts(u, "https://"))) open_url(u);
      free(u);
      CoTaskMemFree(uri);
    }
    args->lpVtbl->put_Handled(args, TRUE);
  }
  return S_OK;
}

static HRESULT STDMETHODCALLTYPE PermCb_Invoke(ICoreWebView2PermissionRequestedEventHandler *This,
    ICoreWebView2 *sender, ICoreWebView2PermissionRequestedEventArgs *args) {
  (void)This; (void)sender;
  if (!args) return S_OK;
  /* 本地界面需要的权限（剪贴板等）一律放行；这是本机 127.0.0.1 的界面进程 */
  args->lpVtbl->put_State(args, COREWEBVIEW2_PERMISSION_STATE_ALLOW);
  return S_OK;
}

static HRESULT STDMETHODCALLTYPE CtrlCb_Invoke(ICoreWebView2CreateCoreWebView2ControllerCompletedHandler *This, HRESULT hr, ICoreWebView2Controller *ctrl) {
  (void)This;
  if (FAILED(hr) || !ctrl) {
    MessageBoxW(g_hwnd, L"创建 WebView2 控制器失败。\n请确认已安装 Microsoft Edge WebView2 Runtime。", L"拾光集", MB_ICONERROR);
    return S_OK;
  }
  g_ctrl = ctrl;
  ctrl->lpVtbl->AddRef(ctrl);
  ctrl->lpVtbl->get_CoreWebView2(ctrl, &g_wv);
  if (!g_wv) return S_OK;
  g_wv->lpVtbl->AddRef(g_wv);
  ICoreWebView2Settings *st = NULL;
  if (SUCCEEDED(g_wv->lpVtbl->get_Settings(g_wv, &st)) && st) {
    st->lpVtbl->put_IsStatusBarEnabled(st, FALSE);
    st->lpVtbl->put_AreDefaultContextMenusEnabled(st, TRUE);
    st->lpVtbl->put_AreDevToolsEnabled(st, TRUE);
    st->lpVtbl->put_IsZoomControlEnabled(st, FALSE);
    st->lpVtbl->put_IsBuiltInErrorPageEnabled(st, TRUE);
    /* 让 CSS 的 -webkit-app-region: drag 生效（无边框窗口靠它拖动 / 双击最大化） */
    ICoreWebView2Settings9 *st9 = NULL;
    if (SUCCEEDED(st->lpVtbl->QueryInterface(st, &IID_ICoreWebView2Settings9, (void **)&st9)) && st9) {
      st9->lpVtbl->put_IsNonClientRegionSupportEnabled(st9, TRUE);
      st9->lpVtbl->Release(st9);
    }
    st->lpVtbl->Release(st);
  }
  g_wv->lpVtbl->add_NewWindowRequested(g_wv, (ICoreWebView2NewWindowRequestedEventHandler *)&g_newwincb, NULL);
  g_wv->lpVtbl->add_PermissionRequested(g_wv, (ICoreWebView2PermissionRequestedEventHandler *)&g_permcb, NULL);
  do_resize();
  ctrl->lpVtbl->put_IsVisible(ctrl, TRUE);
  ctrl->lpVtbl->MoveFocus(ctrl, COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
  if (g_url && *g_url) {
    wchar_t *wu = u8_to_w(g_url);
    g_wv->lpVtbl->Navigate(g_wv, wu);
    free(wu);
  }
  return S_OK;
}

static HRESULT STDMETHODCALLTYPE EnvCb_Invoke(ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *This, HRESULT hr, ICoreWebView2Environment *env) {
  (void)This;
  if (FAILED(hr) || !env) {
    wchar_t msg[512];
    swprintf(msg, 512, L"创建 WebView2 环境失败（0x%08X）。\n请安装 Microsoft Edge WebView2 Runtime 后重试。", (unsigned)hr);
    MessageBoxW(g_hwnd, msg, L"拾光集", MB_ICONERROR);
    return S_OK;
  }
  g_env = env;
  env->lpVtbl->AddRef(env);
  env->lpVtbl->CreateCoreWebView2Controller(env, g_hwnd, (ICoreWebView2CreateCoreWebView2ControllerCompletedHandler *)&g_ctrlcb);
  return S_OK;
}

int webview_create(HWND parent, const char *url, const char *user_data_dir, int devtools_port) {
  g_hwnd = parent;
  if (devtools_port > 0) {
    wchar_t args[256];
    swprintf(args, 256, L"--remote-debugging-port=%d --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows", devtools_port);
    SetEnvironmentVariableW(L"WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args);
  }
  wchar_t *wdir = u8_to_w(user_data_dir);
  HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(NULL, wdir, NULL,
      (ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *)&g_envcb);
  free(wdir);
  if (FAILED(hr)) {
    wchar_t msg[512];
    swprintf(msg, 512, L"WebView2 初始化失败（0x%08X）。\n请安装 Microsoft Edge WebView2 Runtime。", (unsigned)hr);
    MessageBoxW(parent, msg, L"拾光集", MB_ICONERROR);
    return 0;
  }
  if (g_url) free(g_url);
  g_url = xstrdup(url);
  return 1;
}

void webview_navigate(const char *url) {
  if (!g_wv) return;
  wchar_t *w = u8_to_w(url);
  g_wv->lpVtbl->Navigate(g_wv, w);
  free(w);
}

void webview_open_devtools(void) {
  if (g_wv) g_wv->lpVtbl->OpenDevToolsWindow(g_wv);
}

void webview_set_visible(int on) {
  if (g_ctrl) g_ctrl->lpVtbl->put_IsVisible(g_ctrl, on ? TRUE : FALSE);
}

ICoreWebView2Environment *webview_env(void) { return g_env; }

void webview_close(void) {
  if (g_ctrl) { g_ctrl->lpVtbl->Close(g_ctrl); g_ctrl->lpVtbl->Release(g_ctrl); g_ctrl = NULL; }
  if (g_wv) { g_wv->lpVtbl->Release(g_wv); g_wv = NULL; }
  if (g_env) { g_env->lpVtbl->Release(g_env); g_env = NULL; }
}
