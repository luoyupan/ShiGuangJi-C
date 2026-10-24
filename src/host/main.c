#include "sgj.h"
#include "store.h"
#include "modules.h"
#include "http_server.h"
#include "webview.h"
#include "browser_view.h"
#include "uipack.h"
#include <dwmapi.h>
#include <shellapi.h>
#include <shlobj.h>

#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "uuid.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "advapi32.lib")

#ifndef DWMWA_WINDOW_CORNER_PREFERENCE
#define DWMWA_WINDOW_CORNER_PREFERENCE 33
#endif

static HWND g_hwnd = NULL;
static char g_data_dir[MAX_PATH * 2] = {0};
static char g_app_dir[MAX_PATH * 2] = {0};
static char g_token[64] = {0};
static char g_base[512] = {0};
static int g_dev = 0;
static int g_devtools_port = 0;
static HBRUSH g_bgbrush = NULL;

HWND sgj_main_window(void) { return g_hwnd; }
const char *sgj_data_dir(void) { return g_data_dir; }
const char *sgj_app_dir(void) { return g_app_dir; }
const char *sgj_token(void) { return g_token; }
const char *sgj_base_url(void) { return g_base; }
int sgj_is_dev(void) { return g_dev; }

static void make_token(void) {
  GUID g1, g2;
  CoCreateGuid(&g1);
  CoCreateGuid(&g2);
  snprintf(g_token, sizeof(g_token), "%08lx%04x%04x%04x%012llx%08lx",
           (unsigned long)g1.Data1, g1.Data2, g1.Data3,
           (unsigned)((g1.Data4[0] << 8) | g1.Data4[1]),
           (unsigned long long)(*(unsigned long long *)&g1.Data4[2] & 0xFFFFFFFFFFFFULL),
           (unsigned long)g2.Data1);
}

static void add_clip_round(HWND h) {
  DWORD pref = 2; /* DWMWCP_ROUND */
  DwmSetWindowAttribute(h, DWMWA_WINDOW_CORNER_PREFERENCE, &pref, sizeof(pref));
  MARGINS m = { 1, 1, 1, 1 };
  DwmExtendFrameIntoClientArea(h, &m);
}

static LRESULT CALLBACK WndProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
  case WM_SIZE:
    webview_resize();
    return 0;
  case WM_GETMINMAXINFO: {
    MINMAXINFO *mm = (MINMAXINFO *)lp;
    mm->ptMinTrackSize.x = 1040;
    mm->ptMinTrackSize.y = 680;
    /* 最大化贴合工作区，别盖住任务栏 */
    MONITORINFO mi;
    mi.cbSize = sizeof(mi);
    if (GetMonitorInfoW(MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST), &mi)) {
      mm->ptMaxPosition.x = mi.rcWork.left - mi.rcMonitor.left;
      mm->ptMaxPosition.y = mi.rcWork.top - mi.rcMonitor.top;
      mm->ptMaxSize.x = mi.rcWork.right - mi.rcWork.left;
      mm->ptMaxSize.y = mi.rcWork.bottom - mi.rcWork.top;
    }
    return 0;
  }
  case WM_ERASEBKGND: {
    RECT rc; GetClientRect(h, &rc);
    FillRect((HDC)wp, &rc, g_bgbrush);
    return 1;
  }
  case WM_CLOSE:
    store_flush();
    webview_close();
    DestroyWindow(h);
    return 0;
  case WM_DESTROY:
    PostQuitMessage(0);
    return 0;
  }
  return DefWindowProcW(h, msg, wp, lp);
}

static void parse_cmdline(const wchar_t *cmd) {
  int argc = 0;
  LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  for (int i = 1; i < argc; i++) {
    if (!wcscmp(argv[i], L"--dev")) g_dev = 1;
    else if (!wcscmp(argv[i], L"--data-dir") && i + 1 < argc) {
      char *d = w_to_u8(argv[++i]);
      snprintf(g_data_dir, sizeof(g_data_dir), "%s", d);
      free(d);
    } else if (!wcscmp(argv[i], L"--remote-debugging-port") && i + 1 < argc) {
      g_devtools_port = _wtoi(argv[++i]);
    }
  }
  if (argv) LocalFree(argv);
  (void)cmd;
}

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE prev, PWSTR cmd, int show) {
  (void)prev; (void)cmd;
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);

  char *dir = exe_dir();
  snprintf(g_app_dir, sizeof(g_app_dir), "%s", dir);
  free(dir);

  parse_cmdline(cmd);
  if (!g_data_dir[0]) {
    char *appdata = special_folder(CSIDL_APPDATA);
    snprintf(g_data_dir, sizeof(g_data_dir), "%s\\shiguangji", appdata);
    free(appdata);
  }
  char *local = special_folder(CSIDL_LOCAL_APPDATA);
  char logdir[MAX_PATH * 2];
  snprintf(logdir, sizeof(logdir), "%s\\ShiGuangJi-C\\logs", local);
  log_init(logdir);
  LOGI("==== 拾光集 C 版启动 %s ====", SGJ_VERSION);
  LOGI("app=%s data=%s dev=%d", g_app_dir, g_data_dir, g_dev);

  /* 单实例 */
  HANDLE mutex = CreateMutexW(NULL, TRUE, L"Local\\ShiGuangJi-C-SingleInstance");
  if (mutex && GetLastError() == ERROR_ALREADY_EXISTS) {
    HWND old = FindWindowW(L"SGJMainWnd", L"拾光集");
    if (old) { ShowWindow(old, SW_RESTORE); SetForegroundWindow(old); }
    return 0;
  }

  store_init(g_data_dir);
  make_token();

  /* HTTP 服务（先起，模块初始化时就能拿到 base url）。
     优先用 exe 旁边的 ui/（开发态），没有就用 exe 内嵌的 UI_ZIP 解压。 */
  char *ui = path_join(g_app_dir, "ui");
  char *idx = path_join(ui, "index.html");
  if (!path_exists(idx)) {
    free(idx);
    char *packed = uipack_extract();
    if (packed) { free(ui); ui = packed; }
  } else free(idx);
  if (!http_server_start(ui, g_token, 0)) {
    MessageBoxW(NULL, L"本地界面服务启动失败（端口被占用？）", L"拾光集", MB_ICONERROR);
    return 1;
  }
  free(ui);
  snprintf(g_base, sizeof(g_base), "http://127.0.0.1:%d/t/%s", http_server_port(), g_token);

  /* dll 模块 */
  char *moddir = path_join(g_app_dir, "modules");
  modules_init(moddir);
  free(moddir);

  /* 窗口 */
  WNDCLASSEXW wc;
  memset(&wc, 0, sizeof(wc));
  wc.cbSize = sizeof(wc);
  wc.style = CS_HREDRAW | CS_VREDRAW;
  wc.lpfnWndProc = WndProc;
  wc.hInstance = hInst;
  wc.hCursor = LoadCursorW(NULL, IDC_ARROW);
  wc.lpszClassName = L"SGJMainWnd";
  wc.hIcon = LoadIconW(hInst, L"APPICON");
  wc.hIconSm = wc.hIcon;
  RegisterClassExW(&wc);
  g_bgbrush = CreateSolidBrush(RGB(245, 247, 251));

  int w = 1360, hgt = 860;
  int sw = GetSystemMetrics(SM_CXSCREEN), sh = GetSystemMetrics(SM_CYSCREEN);
  g_hwnd = CreateWindowExW(WS_EX_APPWINDOW, L"SGJMainWnd", L"拾光集",
      WS_POPUP | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_CLIPCHILDREN,
      (sw - w) / 2, (sh - hgt) / 2, w, hgt, NULL, NULL, hInst, NULL);
  if (!g_hwnd) return 1;
  add_clip_round(g_hwnd);

  char wvdata[MAX_PATH * 2];
  snprintf(wvdata, sizeof(wvdata), "%s\\ShiGuangJi-C\\WebView2", local);
  path_mkdirs(wvdata);
  free(local);

  ShowWindow(g_hwnd, show);
  UpdateWindow(g_hwnd);

  char url[600];
  snprintf(url, sizeof(url), "%s/", g_base);
  webview_create(g_hwnd, url, wvdata, g_dev ? (g_devtools_port ? g_devtools_port : 9333) : 0);
  browser_view_init(g_hwnd);

  MSG msg;
  while (GetMessageW(&msg, NULL, 0, 0)) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  store_flush();
  modules_shutdown();
  http_server_stop();
  if (mutex) { ReleaseMutex(mutex); CloseHandle(mutex); }
  CoUninitialize();
  return 0;
}
