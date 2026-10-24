#ifndef SGJ_WEBVIEW_H
#define SGJ_WEBVIEW_H
#include "sgj.h"

int webview_create(HWND parent, const char *url, const char *user_data_dir, int devtools_port);
void webview_resize(void);
void webview_open_devtools(void);
void webview_navigate(const char *url);
void webview_set_visible(int on);
void webview_close(void);
struct ICoreWebView2Environment *webview_env(void);

#endif
