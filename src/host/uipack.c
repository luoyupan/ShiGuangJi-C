#include "uipack.h"
#include <shlobj.h>

/* 内嵌 UI 包（build.ps1 把 ui/ 压成 ui.zip，以 RCDATA UI_ZIP 编进 exe）。
   启动时解到 %LOCALAPPDATA%\ShiGuangJi-C\ui-<版本>，这样交付形态仍然是
   「一个 exe + 若干 dll」，不会在 exe 旁边散落一堆 css/js。 */
char *uipack_extract(void) {
  HRSRC r = FindResourceW(NULL, L"UI_ZIP", RT_RCDATA);
  if (!r) return NULL;
  DWORD sz = SizeofResource(NULL, r);
  HGLOBAL g = LoadResource(NULL, r);
  void *data = g ? LockResource(g) : NULL;
  if (!data || !sz) return NULL;

  /* 用 zip 内容哈希做缓存目录后缀：同版本重编 UI 也不会读到旧缓存 */
  unsigned long long hash = 1469598103934665603ULL;
  for (DWORD i = 0; i < sz; i++) { hash ^= ((const unsigned char *)data)[i]; hash *= 1099511628211ULL; }
  char *local = special_folder(CSIDL_LOCAL_APPDATA);
  char base[MAX_PATH * 2];
  snprintf(base, sizeof(base), "%s\\ShiGuangJi-C\\ui-%s-%08llx", local, SGJ_VERSION,
           (unsigned long long)(hash & 0xFFFFFFFFULL));
  free(local);
  char *index = path_join(base, "index.html");
  if (path_exists(index)) { free(index); return xstrdup(base); }
  path_mkdirs(base);

  char *zip = path_join(base, "ui.zip");
  if (!file_write_all(zip, data, sz)) { free(zip); free(index); return NULL; }
  char cmd[MAX_PATH * 4];
  snprintf(cmd, sizeof(cmd), "tar.exe -xf \"%s\" -C \"%s\"", zip, base);
  STARTUPINFOW si; PROCESS_INFORMATION pi;
  memset(&si, 0, sizeof(si)); si.cb = sizeof(si);
  si.dwFlags = STARTF_USESHOWWINDOW; si.wShowWindow = SW_HIDE;
  memset(&pi, 0, sizeof(pi));
  wchar_t *wc = u8_to_w(cmd);
  BOOL ok = CreateProcessW(NULL, wc, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi);
  free(wc);
  if (ok) {
    WaitForSingleObject(pi.hProcess, 30000);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
  }
  file_delete(zip);
  free(zip);
  if (!path_exists(index)) { free(index); return NULL; }
  free(index);
  return xstrdup(base);
}
