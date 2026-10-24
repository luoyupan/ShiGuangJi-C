#ifndef SGJ_BROWSER_VIEW_H
#define SGJ_BROWSER_VIEW_H
#include "sgj.h"

void browser_view_init(HWND parent);
void browser_view_show(int x, int y, int w, int h, double dpr, const char *url);
void browser_view_hide(void);
void browser_view_navigate(const char *url);
void browser_view_back(void);
void browser_view_forward(void);
void browser_view_reload(void);
void browser_view_stop(void);
cJSON *browser_view_state(void);
int browser_view_exists(void);

#endif
