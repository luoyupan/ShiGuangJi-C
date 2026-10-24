#include "dialogs.h"
#include <shobjidl.h>
#include <shlobj.h>
#include <commdlg.h>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "comdlg32.lib")
#pragma comment(lib, "shell32.lib")

static void ensure_com(void) {
  HRESULT hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
  (void)hr;
}

static char *item_path(IShellItem *item) {
  LPWSTR pw = NULL;
  char *r = NULL;
  if (SUCCEEDED(item->lpVtbl->GetDisplayName(item, SIGDN_FILESYSPATH, &pw)) && pw) {
    r = w_to_u8(pw);
    CoTaskMemFree(pw);
  }
  return r;
}

/* 生成 Windows 过滤器：pattern 例如 "*.mp3;*.flac"；name 固定「文件」 */
static void make_filter(const char *pattern, COMDLG_FILTERSPEC *spec, wchar_t *buf, size_t cap) {
  const char *pat = (pattern && *pattern) ? pattern : "*.*";
  wchar_t *wp = u8_to_w(pat);
  wcsncpy(buf, wp, cap - 1); buf[cap - 1] = 0;
  free(wp);
  spec->pszName = L"支持的文件";
  spec->pszSpec = buf;
}

char *dlg_pick_folder(HWND owner, int multi, const char *title) {
  ensure_com();
  IFileOpenDialog *dlg = NULL;
  if (FAILED(CoCreateInstance(&CLSID_FileOpenDialog, NULL, CLSCTX_INPROC_SERVER, &IID_IFileOpenDialog, (void **)&dlg)))
    return xstrdup("");
  DWORD opts = 0;
  dlg->lpVtbl->GetOptions(dlg, &opts);
  opts |= FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST;
  if (multi) opts |= FOS_ALLOWMULTISELECT;
  dlg->lpVtbl->SetOptions(dlg, opts);
  if (title && *title) {
    wchar_t *wt = u8_to_w(title);
    dlg->lpVtbl->SetTitle(dlg, wt);
    free(wt);
  }
  Buf b; buf_init(&b);
  if (SUCCEEDED(dlg->lpVtbl->Show(dlg, owner))) {
    if (multi) {
      IShellItemArray *arr = NULL;
      if (SUCCEEDED(dlg->lpVtbl->GetResults(dlg, &arr)) && arr) {
        DWORD n = 0;
        arr->lpVtbl->GetCount(arr, &n);
        for (DWORD i = 0; i < n; i++) {
          IShellItem *it = NULL;
          if (SUCCEEDED(arr->lpVtbl->GetItemAt(arr, i, &it)) && it) {
            char *p = item_path(it);
            if (p) { if (b.len) buf_addc(&b, '\n'); buf_adds(&b, p); free(p); }
            it->lpVtbl->Release(it);
          }
        }
        arr->lpVtbl->Release(arr);
      }
    } else {
      IShellItem *it = NULL;
      if (SUCCEEDED(dlg->lpVtbl->GetResult(dlg, &it)) && it) {
        char *p = item_path(it);
        if (p) { buf_adds(&b, p); free(p); }
        it->lpVtbl->Release(it);
      }
    }
  }
  dlg->lpVtbl->Release(dlg);
  if (!b.p) return xstrdup("");
  return buf_take(&b);
}

char *dlg_pick_files(HWND owner, int save, const char *title, const char *pattern, const char *default_name) {
  ensure_com();
  if (save) {
    IFileSaveDialog *dlg = NULL;
    if (FAILED(CoCreateInstance(&CLSID_FileSaveDialog, NULL, CLSCTX_INPROC_SERVER, &IID_IFileSaveDialog, (void **)&dlg)))
      return xstrdup("");
    COMDLG_FILTERSPEC spec;
    wchar_t patbuf[512];
    make_filter(pattern, &spec, patbuf, 512);
    dlg->lpVtbl->SetFileTypes(dlg, 1, &spec);
    if (title && *title) { wchar_t *wt = u8_to_w(title); dlg->lpVtbl->SetTitle(dlg, wt); free(wt); }
    if (default_name && *default_name) { wchar_t *wn = u8_to_w(default_name); dlg->lpVtbl->SetFileName(dlg, wn); free(wn); }
    char *out = xstrdup("");
    if (SUCCEEDED(dlg->lpVtbl->Show(dlg, owner))) {
      IShellItem *it = NULL;
      if (SUCCEEDED(dlg->lpVtbl->GetResult(dlg, &it)) && it) {
        char *p = item_path(it);
        if (p) { free(out); out = p; }
        it->lpVtbl->Release(it);
      }
    }
    dlg->lpVtbl->Release(dlg);
    return out;
  }
  IFileOpenDialog *dlg = NULL;
  if (FAILED(CoCreateInstance(&CLSID_FileOpenDialog, NULL, CLSCTX_INPROC_SERVER, &IID_IFileOpenDialog, (void **)&dlg)))
    return xstrdup("");
  DWORD opts = 0;
  dlg->lpVtbl->GetOptions(dlg, &opts);
  opts |= FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_FILEMUSTEXIST | FOS_ALLOWMULTISELECT;
  dlg->lpVtbl->SetOptions(dlg, opts);
  COMDLG_FILTERSPEC specs[2];
  wchar_t patbuf[512];
  make_filter(pattern, &specs[0], patbuf, 512);
  specs[1].pszName = L"所有文件";
  specs[1].pszSpec = L"*.*";
  dlg->lpVtbl->SetFileTypes(dlg, 2, specs);
  if (title && *title) { wchar_t *wt = u8_to_w(title); dlg->lpVtbl->SetTitle(dlg, wt); free(wt); }
  Buf b; buf_init(&b);
  if (SUCCEEDED(dlg->lpVtbl->Show(dlg, owner))) {
    IShellItemArray *arr = NULL;
    if (SUCCEEDED(dlg->lpVtbl->GetResults(dlg, &arr)) && arr) {
      DWORD n = 0;
      arr->lpVtbl->GetCount(arr, &n);
      for (DWORD i = 0; i < n; i++) {
        IShellItem *it = NULL;
        if (SUCCEEDED(arr->lpVtbl->GetItemAt(arr, i, &it)) && it) {
          char *p = item_path(it);
          if (p) { if (b.len) buf_addc(&b, '\n'); buf_adds(&b, p); free(p); }
          it->lpVtbl->Release(it);
        }
      }
      arr->lpVtbl->Release(arr);
    }
  }
  dlg->lpVtbl->Release(dlg);
  if (!b.p) return xstrdup("");
  return buf_take(&b);
}

int dlg_message(HWND owner, const char *title, const char *text, int yes_no) {
  wchar_t *wt = u8_to_w(title ? title : "拾光集");
  wchar_t *wx = u8_to_w(text ? text : "");
  UINT flags = MB_ICONINFORMATION | (yes_no ? MB_YESNO : MB_OK);
  int r = MessageBoxW(owner, wx, wt, flags);
  free(wt); free(wx);
  return r == IDYES || r == IDOK;
}

int split_lines(const char *s, char ***out) {
  *out = NULL;
  if (!s || !*s) return 0;
  int n = 1;
  for (const char *p = s; *p; p++) if (*p == '\n') n++;
  char **arr = (char **)xmalloc(sizeof(char *) * (size_t)n);
  const char *start = s;
  int k = 0;
  for (;;) {
    const char *nl = strchr(start, '\n');
    size_t len = nl ? (size_t)(nl - start) : strlen(start);
    if (len) {
      arr[k] = xstrndup(start, len);
      str_trim(arr[k]);
      if (*arr[k]) k++;
      else free(arr[k]);
    }
    if (!nl) break;
    start = nl + 1;
  }
  *out = arr;
  return k;
}
