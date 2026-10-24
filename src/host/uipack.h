#ifndef SGJ_UIPACK_H
#define SGJ_UIPACK_H
#include "sgj.h"
/* 把 exe 里内嵌的 UI_ZIP 解到 %LOCALAPPDATA%，返回目录（malloc）。失败返回 NULL。 */
char *uipack_extract(void);
#endif
