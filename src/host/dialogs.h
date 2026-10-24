#ifndef SGJ_DIALOGS_H
#define SGJ_DIALOGS_H
#include "sgj.h"

/* 返回换行分隔的绝对路径；调用者 free。取消返回空串。 */
char *dlg_pick_folder(HWND owner, int multi, const char *title);
char *dlg_pick_files(HWND owner, int save, const char *title, const char *pattern, const char *default_name);
int dlg_message(HWND owner, const char *title, const char *text, int yes_no);
/* 把 pick_* 结果拆成数组 */
int split_lines(const char *s, char ***out);

#endif
