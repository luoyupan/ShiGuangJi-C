#include "api.h"
#include "modules.h"
#include "store.h"
#include "net.h"
#include "dialogs.h"
#include "http_server.h"
#include "browser_view.h"
#include <shellapi.h>

#pragma comment(lib, "shell32.lib")

/* ---------------- 返回封装 ---------------- */
static char *dup_host(const char *s) {
  size_t n = strlen(s ? s : "");
  char *p = (char *)host_alloc(n + 1);
  if (p) memcpy(p, s ? s : "", n + 1);
  return p;
}
static int ret_json(cJSON *v, char **out_json) {
  char *t = json_dumps(v ? v : cJSON_CreateNull());
  *out_json = dup_host(t);
  cJSON_free(t);
  if (v) cJSON_Delete(v);
  return 0;
}
static int ret_error(char **out_error, const char *fmt, ...) {
  char msg[1024];
  va_list ap; va_start(ap, fmt);
  vsnprintf(msg, sizeof(msg), fmt, ap);
  va_end(ap);
  *out_error = dup_host(msg);
  return -1;
}

/* ---------------- 参数 ---------------- */
static cJSON *arg_at(cJSON *args, int i) {
  if (!args || !cJSON_IsArray(args)) return NULL;
  return cJSON_GetArrayItem(args, i);
}
static const char *arg_str(cJSON *args, int i, const char *def) {
  cJSON *v = arg_at(args, i);
  return (v && cJSON_IsString(v) && v->valuestring) ? v->valuestring : def;
}
static int arg_int(cJSON *args, int i, int def) {
  cJSON *v = arg_at(args, i);
  return cJSON_IsNumber(v) ? (int)v->valuedouble : (cJSON_IsBool(v) ? (cJSON_IsTrue(v) ? 1 : 0) : def);
}
static int arg_bool(cJSON *args, int i, int def) {
  cJSON *v = arg_at(args, i);
  if (cJSON_IsBool(v)) return cJSON_IsTrue(v) ? 1 : 0;
  if (cJSON_IsNumber(v)) return v->valuedouble != 0;
  return def;
}
static cJSON *arg_obj(cJSON *args, int i) {
  cJSON *v = arg_at(args, i);
  return cJSON_IsObject(v) ? v : NULL;
}

/* ---------------- appearance ---------------- */
static char *bg_path_for_slot(const char *slot) {
  char name[64];
  snprintf(name, sizeof(name), "bg-%s.img", (slot && *slot) ? slot : "content");
  return path_join(sgj_data_dir(), name);
}
static cJSON *appearance_urls(void) {
  cJSON *settings = store_get("settings");
  cJSON *bg = settings ? cJSON_GetObjectItemCaseSensitive(settings, "background") : NULL;
  char *sidebar = bg ? (char *)json_str(bg, "sidebar", "") : (char *)"";
  char *content = bg ? (char *)json_str(bg, "content", "") : (char *)"";
  double op = bg ? json_num(bg, "opacity", 1) : 1;
  cJSON *o = cJSON_CreateObject();
  char *u = http_local_url(sidebar);
  cJSON_AddStringToObject(o, "sidebar", u); free(u);
  u = http_local_url(content);
  cJSON_AddStringToObject(o, "content", u); free(u);
  cJSON_AddNumberToObject(o, "opacity", op);
  if (settings) cJSON_Delete(settings);
  return o;
}
static int do_set_image(cJSON *args, char **out_json, char **out_error) {
  cJSON *o = arg_obj(args, 0);
  const char *slot = o ? json_str(o, "slot", "content") : "content";
  char *p = dlg_pick_files(sgj_main_window(), 0, NULL, "*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.gif", NULL);
  if (!p || !*p) { free(p); return ret_json(appearance_urls(), out_json); }
  char *dst = bg_path_for_slot(slot);
  wchar_t *ws = u8_to_w(p), *wd = u8_to_w(dst);
  BOOL ok = CopyFileW(ws, wd, FALSE);
  free(ws); free(wd);
  if (!ok) { free(p); free(dst); return ret_error(out_error, "复制背景图失败"); }
  cJSON *patch = cJSON_CreateObject();
  cJSON *bg = cJSON_CreateObject();
  cJSON_AddStringToObject(bg, slot, dst);
  cJSON_AddItemToObject(patch, "background", bg);
  store_merge("settings", patch);
  cJSON_Delete(patch);
  free(p); free(dst);
  cJSON *settings = store_get("settings");
  bus_emit("settings:changed", settings);
  bus_emit_json("appearance:changed", "{}");
  return ret_json(appearance_urls(), out_json);
}
static int do_clear_image(cJSON *args) {
  cJSON *o = arg_obj(args, 0);
  const char *slot = o ? json_str(o, "slot", "content") : "content";
  cJSON *patch = cJSON_CreateObject();
  cJSON *bg = cJSON_CreateObject();
  cJSON_AddStringToObject(bg, slot, "");
  cJSON_AddItemToObject(patch, "background", bg);
  store_merge("settings", patch);
  cJSON_Delete(patch);
  cJSON *settings = store_get("settings");
  bus_emit("settings:changed", settings);
  bus_emit_json("appearance:changed", "{}");
  return 0;
}

/* ---------------- 版本 ---------------- */
static int ver_cmp(const char *a, const char *b) {
  while (*a == 'v' || *a == 'V') a++;
  while (*b == 'v' || *b == 'V') b++;
  int na = 0, nb = 0;
  for (;;) {
    while (*a && (*a < '0' || *a > '9')) a++;
    while (*b && (*b < '0' || *b > '9')) b++;
    if (!*a && !*b) break;
    na = atoi(a); nb = atoi(b);
    if (na != nb) return na > nb ? 1 : -1;
    while (*a >= '0' && *a <= '9') a++;
    while (*b >= '0' && *b <= '9') b++;
  }
  return 0;
}

static cJSON *update_status_json(void) {
  cJSON *settings = store_get("settings");
  cJSON *up = settings ? cJSON_GetObjectItemCaseSensitive(settings, "update") : NULL;
  const char *mode = up ? json_str(up, "mode", "auto") : "auto";
  cJSON *last = up ? cJSON_GetObjectItemCaseSensitive(up, "last") : NULL;
  cJSON *o = cJSON_CreateObject();
  cJSON_AddStringToObject(o, "current", SGJ_VERSION);
  cJSON_AddStringToObject(o, "mode", mode);
  cJSON_AddItemToObject(o, "last", last ? cJSON_Duplicate(last, 1) : cJSON_CreateNull());
  cJSON_AddStringToObject(o, "repo", "luoyupan/ShiGuangJi");
  cJSON_AddStringToObject(o, "page", "https://github.com/luoyupan/ShiGuangJi/releases/latest");
  cJSON *modes = cJSON_CreateArray();
  cJSON_AddItemToArray(modes, cJSON_CreateString("auto"));
  cJSON_AddItemToArray(modes, cJSON_CreateString("manual"));
  cJSON_AddItemToArray(modes, cJSON_CreateString("off"));
  cJSON_AddItemToObject(o, "modes", modes);
  if (settings) cJSON_Delete(settings);
  return o;
}

static int do_update_check(char **out_json, char **out_error) {
  cJSON *settings = store_get("settings");
  cJSON *up = settings ? cJSON_GetObjectItemCaseSensitive(settings, "update") : NULL;
  const char *mode = up ? json_str(up, "mode", "auto") : "auto";
  if (!strcmp(mode, "off")) {
    if (settings) cJSON_Delete(settings);
    return ret_error(out_error, "你已在设置里屏蔽了更新检查（屏蔽 = 完全不联网）");
  }
  const char *url = "https://api.github.com/repos/luoyupan/ShiGuangJi/releases/latest";
  HttpResult r;
  if (!http_request_ex("GET", url,
      "User-Agent: ShiGuangJi/" SGJ_VERSION "\r\nAccept: application/vnd.github+json\r\n",
      NULL, 0, 20000, &r)) {
    if (settings) cJSON_Delete(settings);
    return ret_error(out_error, "检查更新失败：%s", r.error);
  }
  if (r.status != 200) {
    http_result_free(&r);
    if (settings) cJSON_Delete(settings);
    return ret_error(out_error, "GitHub 返回 %d，可能是网络受限", r.status);
  }
  cJSON *j = cJSON_Parse(r.data);
  http_result_free(&r);
  if (!j) { if (settings) cJSON_Delete(settings); return ret_error(out_error, "更新信息解析失败"); }
  const char *tag = json_str(j, "tag_name", "");
  const char *name = json_str(j, "name", "");
  const char *notes = json_str(j, "body", "");
  const char *page = json_str(j, "html_url", "");
  const char *pub = json_str(j, "published_at", "");
  int has = ver_cmp(tag, SGJ_VERSION) > 0;
  cJSON *last = cJSON_CreateObject();
  cJSON_AddNumberToObject(last, "at", (double)now_ms());
  cJSON_AddStringToObject(last, "mode", mode);
  cJSON_AddBoolToObject(last, "ok", 1);
  cJSON_AddStringToObject(last, "current", SGJ_VERSION);
  cJSON_AddStringToObject(last, "latest", tag);
  cJSON_AddBoolToObject(last, "hasUpdate", has);
  cJSON_AddStringToObject(last, "name", name);
  cJSON_AddStringToObject(last, "notes", notes);
  cJSON_AddStringToObject(last, "pageUrl", page);
  cJSON_AddStringToObject(last, "publishedAt", pub);
  cJSON_AddStringToObject(last, "repo", "luoyupan/ShiGuangJi");
  const cJSON *assets = cJSON_GetObjectItemCaseSensitive(j, "assets");
  if (cJSON_IsArray(assets)) {
    const cJSON *a = NULL;
    cJSON_ForEach(a, assets) {
      const char *an = json_str(a, "name", "");
      if (strstr(an, "portable.exe")) {
        cJSON_AddStringToObject(last, "assetName", an);
        cJSON_AddStringToObject(last, "assetUrl", json_str(a, "browser_download_url", ""));
        cJSON_AddNumberToObject(last, "assetSize", json_num(a, "size", 0));
        break;
      }
    }
  }
  cJSON_Delete(j);
  cJSON *res = cJSON_Duplicate(last, 1);
  if (has) bus_emit("update:available", cJSON_Duplicate(last, 1));
  cJSON *patch = cJSON_CreateObject();
  cJSON *pu = cJSON_CreateObject();
  json_set_int(pu, "lastCheck", now_ms());
  cJSON_AddStringToObject(pu, "lastVersion", tag);
  cJSON_AddItemToObject(pu, "last", last);
  cJSON_AddItemToObject(patch, "update", pu);
  store_merge("settings", patch);
  cJSON_Delete(patch);
  if (settings) cJSON_Delete(settings);
  return ret_json(res, out_json);
}

/* ---------------- settings ---------------- */
static int do_settings_set(cJSON *args) {
  cJSON *patch = arg_obj(args, 0);
  if (patch) store_merge("settings", patch);
  cJSON *settings = store_get("settings");
  bus_emit("settings:changed", cJSON_Duplicate(settings, 1));
  cJSON_Delete(settings);
  return 0;
}

/* ---------------- 主分发 ---------------- */
static int host_dispatch(const char *channel, cJSON *args, char **out_json, char **out_error) {
  if (!strcmp(channel, "app:info")) {
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "name", "拾光集");
    cJSON_AddStringToObject(o, "version", SGJ_VERSION);
    cJSON_AddStringToObject(o, "platform", "win32");
    cJSON_AddStringToObject(o, "electron", "native-c / WebView2");
    cJSON_AddStringToObject(o, "dataDir", sgj_data_dir());
    return ret_json(o, out_json);
  }
  if (!strcmp(channel, "settings:get")) return ret_json(store_get("settings"), out_json);
  if (!strcmp(channel, "settings:set")) {
    do_settings_set(args);
    return ret_json(store_get("settings"), out_json);
  }
  if (!strcmp(channel, "profile:get")) return ret_json(store_get("profile"), out_json);
  if (!strcmp(channel, "profile:set")) {
    cJSON *patch = arg_obj(args, 0);
    if (patch) store_merge("profile", patch);
    return ret_json(store_get("profile"), out_json);
  }
  if (!strcmp(channel, "plugins:list")) return ret_json(plugins_list_json(), out_json);
  if (!strcmp(channel, "hub:modules")) return ret_json(hub_modules_json(), out_json);
  if (!strcmp(channel, "modules:list")) return ret_json(modules_list_json(), out_json);
  if (!strcmp(channel, "plugins:set")) {
    const char *id = arg_str(args, 0, "");
    int on = arg_bool(args, 1, 1);
    char *err = NULL;
    if (!plugins_set(id, on, &err)) { int r = ret_error(out_error, "%s", err ? err : "操作失败"); free(err); return r; }
    cJSON *list = plugins_list_json();
    bus_emit("hub:modules-changed", hub_modules_json());
    cJSON *settings = store_get("settings");
    bus_emit("settings:changed", cJSON_Duplicate(settings, 1));
    cJSON_Delete(settings);
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", 1);
    cJSON_AddItemToObject(o, "list", cJSON_GetObjectItemCaseSensitive(list, "list") ? cJSON_Duplicate(cJSON_GetObjectItemCaseSensitive(list, "list"), 1) : cJSON_CreateArray());
    cJSON_AddItemToObject(o, "enabled", cJSON_Duplicate(cJSON_GetObjectItemCaseSensitive(list, "enabled"), 1));
    cJSON_Delete(list);
    return ret_json(o, out_json);
  }
  if (!strcmp(channel, "plugins:reset")) {
    plugins_reset();
    bus_emit("hub:modules-changed", hub_modules_json());
    cJSON *settings = store_get("settings");
    bus_emit("settings:changed", cJSON_Duplicate(settings, 1));
    cJSON_Delete(settings);
    return ret_json(plugins_list_json(), out_json);
  }
  if (!strcmp(channel, "win:minimize")) { ShowWindow(sgj_main_window(), SW_MINIMIZE); return ret_json(cJSON_CreateBool(1), out_json); }
  if (!strcmp(channel, "win:maximize")) {
    HWND h = sgj_main_window();
    ShowWindow(h, IsZoomed(h) ? SW_RESTORE : SW_MAXIMIZE);
    return ret_json(cJSON_CreateBool(1), out_json);
  }
  if (!strcmp(channel, "win:close")) { PostMessageW(sgj_main_window(), WM_CLOSE, 0, 0); return ret_json(cJSON_CreateBool(1), out_json); }
  if (!strcmp(channel, "win:devtools")) { extern void webview_open_devtools(void); webview_open_devtools(); return ret_json(cJSON_CreateBool(1), out_json); }
  if (!strcmp(channel, "win:drag")) {
    HWND h = sgj_main_window();
    ReleaseCapture();
    SendMessageW(h, WM_NCLBUTTONDOWN, HTCAPTION, 0);
    return ret_json(cJSON_CreateBool(1), out_json);
  }
  if (!strcmp(channel, "shell:openPath")) { const char *p = arg_str(args, 0, ""); if (*p) open_path(p); return ret_json(cJSON_CreateBool(1), out_json); }
  if (!strcmp(channel, "shell:revealPath")) { const char *p = arg_str(args, 0, ""); if (*p) reveal_in_explorer(p); return ret_json(cJSON_CreateBool(1), out_json); }
  if (!strcmp(channel, "shell:openUrl")) {
    const char *u = arg_str(args, 0, "");
    if (!str_starts(u, "http://") && !str_starts(u, "https://") && !str_starts(u, "steam://")) return ret_error(out_error, "不支持的链接");
    open_url(u);
    return ret_json(cJSON_CreateBool(1), out_json);
  }
  if (!strcmp(channel, "appearance:urls")) return ret_json(appearance_urls(), out_json);
  if (!strcmp(channel, "appearance:setImage")) return do_set_image(args, out_json, out_error);
  if (!strcmp(channel, "appearance:clearImage")) {
    do_clear_image(args);
    return ret_json(appearance_urls(), out_json);
  }
  if (!strcmp(channel, "appearance:fonts")) {
    cJSON *a = cJSON_CreateArray();
    cJSON_AddItemToArray(a, cJSON_CreateString("Microsoft YaHei UI"));
    cJSON_AddItemToArray(a, cJSON_CreateString("Microsoft YaHei"));
    cJSON_AddItemToArray(a, cJSON_CreateString("Segoe UI"));
    cJSON_AddItemToArray(a, cJSON_CreateString("SimSun"));
    return ret_json(a, out_json);
  }
  if (!strcmp(channel, "dialog:pickFolder")) {
    char *p = dlg_pick_folder(sgj_main_window(), 0, NULL);
    cJSON *v = cJSON_CreateString(p ? p : "");
    free(p);
    return ret_json(v, out_json);
  }
  if (!strcmp(channel, "dialog:pickFolders")) {
    char *p = dlg_pick_folder(sgj_main_window(), 1, NULL);
    char **lines = NULL;
    int n = split_lines(p, &lines);
    cJSON *a = cJSON_CreateArray();
    for (int i = 0; i < n; i++) { cJSON_AddItemToArray(a, cJSON_CreateString(lines[i])); free(lines[i]); }
    free(lines); free(p);
    return ret_json(a, out_json);
  }
  if (!strcmp(channel, "dialog:pickExe")) {
    char *p = dlg_pick_files(sgj_main_window(), 0, NULL, "*.exe", NULL);
    char *nl = strchr(p, '\n');
    if (nl) *nl = 0;
    cJSON *v = cJSON_CreateString(p ? p : "");
    free(p);
    return ret_json(v, out_json);
  }
  if (!strcmp(channel, "dialog:pickFiles")) {
    cJSON *o = arg_obj(args, 0);
    const cJSON *filters = o ? cJSON_GetObjectItemCaseSensitive(o, "filters") : NULL;
    Buf pat; buf_init(&pat);
    if (cJSON_IsArray(filters)) {
      const cJSON *f = NULL;
      cJSON_ForEach(f, filters) {
        const cJSON *exts = cJSON_GetObjectItemCaseSensitive(f, "extensions");
        const cJSON *e = NULL;
        cJSON_ForEach(e, exts) {
          if (cJSON_IsString(e)) { if (pat.len) buf_addc(&pat, ';'); buf_addf(&pat, "*.%s", e->valuestring); }
        }
      }
    }
    char *p = dlg_pick_files(sgj_main_window(), 0, NULL, pat.p ? pat.p : "*.*", NULL);
    buf_free(&pat);
    char **lines = NULL;
    int n = split_lines(p, &lines);
    cJSON *a = cJSON_CreateArray();
    for (int i = 0; i < n; i++) { cJSON_AddItemToArray(a, cJSON_CreateString(lines[i])); free(lines[i]); }
    free(lines); free(p);
    return ret_json(a, out_json);
  }
  if (!strcmp(channel, "dialog:pickSave")) {
    cJSON *o = arg_obj(args, 0);
    const char *defaultPath = o ? json_str(o, "defaultPath", "") : "";
    cJSON *filters = o ? cJSON_GetObjectItemCaseSensitive(o, "filters") : NULL;
    Buf pat; buf_init(&pat);
    if (cJSON_IsArray(filters)) {
      const cJSON *f = NULL;
      cJSON_ForEach(f, filters) {
        const cJSON *exts = cJSON_GetObjectItemCaseSensitive(f, "extensions");
        const cJSON *e = NULL;
        cJSON_ForEach(e, exts) if (cJSON_IsString(e)) { if (pat.len) buf_addc(&pat, ';'); buf_addf(&pat, "*.%s", e->valuestring); }
      }
    }
    char *p = dlg_pick_files(sgj_main_window(), 1, NULL, pat.p ? pat.p : "*.*", defaultPath);
    buf_free(&pat);
    cJSON *v = cJSON_CreateString(p ? p : "");
    free(p);
    return ret_json(v, out_json);
  }
  if (!strcmp(channel, "dialog:message")) {
    cJSON *o = arg_obj(args, 0);
    const char *title = o ? json_str(o, "title", "拾光集") : "拾光集";
    const char *text = o ? json_str(o, "message", json_str(o, "text", "")) : "";
    int yes = o ? json_bool(o, "yesNo", 0) : 0;
    int r = dlg_message(sgj_main_window(), title, text, yes);
    return ret_json(cJSON_CreateBool(r), out_json);
  }
  if (!strcmp(channel, "update:status")) return ret_json(update_status_json(), out_json);
  if (!strcmp(channel, "update:set-mode")) {
    const char *m = arg_str(args, 0, "auto");
    if (strcmp(m, "auto") && strcmp(m, "manual") && strcmp(m, "off")) return ret_error(out_error, "未知的更新方式");
    cJSON *patch = cJSON_CreateObject();
    cJSON *up = cJSON_CreateObject();
    cJSON_AddStringToObject(up, "mode", m);
    cJSON_AddItemToObject(patch, "update", up);
    store_merge("settings", patch);
    cJSON_Delete(patch);
    cJSON *settings = store_get("settings");
    bus_emit("settings:changed", cJSON_Duplicate(settings, 1));
    cJSON_Delete(settings);
    return ret_json(update_status_json(), out_json);
  }
  if (!strcmp(channel, "update:check")) return do_update_check(out_json, out_error);
  if (!strcmp(channel, "update:open")) {
    const char *u = arg_str(args, 0, "");
    if (!str_starts(u, "http://") && !str_starts(u, "https://")) return ret_error(out_error, "不支持的链接");
    open_url(u);
    return ret_json(cJSON_CreateBool(1), out_json);
  }
  if (!strcmp(channel, "login:state")) {
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "open", 0);
    cJSON_AddStringToObject(o, "platform", "");
    return ret_json(o, out_json);
  }
  if (!strcmp(channel, "login:cancel")) return ret_json(cJSON_CreateBool(1), out_json);
  if (!strcmp(channel, "login:open") || !strcmp(channel, "login:check"))
    return ret_error(out_error, "C 版的内置登录窗还没接上（可先用浏览器模块登录）");
  if (!strcmp(channel, "plugin:list") || !strcmp(channel, "plugin:rescan")) {
    cJSON *root = cJSON_CreateObject();
    cJSON *arr = cJSON_CreateArray();
    for (int i = 0; i < modules_count(); i++) {
      LoadedModule *m = modules_at(i);
      if (!m || m->builtin) continue;
      cJSON *o = cJSON_CreateObject();
      cJSON_AddStringToObject(o, "id", m->id);
      cJSON_AddStringToObject(o, "name", json_str(m->manifest, "title", m->id));
      cJSON_AddStringToObject(o, "title", json_str(m->manifest, "title", m->id));
      cJSON_AddStringToObject(o, "desc", json_str(m->manifest, "desc", ""));
      cJSON_AddStringToObject(o, "version", json_str(m->manifest, "version", "1.0.0"));
      cJSON_AddStringToObject(o, "author", json_str(m->manifest, "author", ""));
      cJSON_AddNumberToObject(o, "apiVersion", 1);
      cJSON_AddBoolToObject(o, "enabled", m->enabled);
      cJSON_AddStringToObject(o, "kind", "dll");
      char url[512];
      snprintf(url, sizeof(url), "%s/mod/%s/renderer.js", sgj_base_url(), m->id);
      cJSON *src = cJSON_CreateObject();
      cJSON_AddStringToObject(src, "js", url);
      snprintf(url, sizeof(url), "%s/mod/%s/style.css", sgj_base_url(), m->id);
      cJSON_AddStringToObject(src, "css", m->mod->style_css ? url : "");
      cJSON_AddItemToObject(o, "src", src);
      cJSON_AddStringToObject(o, "dir", modules_dir());
      cJSON_AddItemToArray(arr, o);
    }
    cJSON_AddItemToObject(root, "list", arr);
    cJSON_AddItemToObject(root, "errors", cJSON_CreateArray());
    cJSON_AddStringToObject(root, "dir", modules_dir());
    cJSON_AddNumberToObject(root, "apiVersion", 1);
    return ret_json(root, out_json);
  }
  if (!strcmp(channel, "plugin:set")) {
    const char *id = arg_str(args, 0, "");
    int on = arg_bool(args, 1, 1);
    char *err = NULL;
    if (!plugins_set(id, on, &err)) { int r = ret_error(out_error, "%s", err ? err : "操作失败"); free(err); return r; }
    return ret_json(cJSON_CreateBool(1), out_json);
  }
  if (!strcmp(channel, "plugin:call")) {
    const char *id = arg_str(args, 0, "");
    const char *method = arg_str(args, 1, "");
    cJSON *pargs = arg_at(args, 2);
    char channel[256];
    snprintf(channel, sizeof(channel), "%s:%s", id, method);
    char *aj = pargs ? json_dumps(pargs) : xstrdup("[]");
    char *oj = NULL, *oe = NULL;
    int handled = modules_dispatch(channel, aj, &oj, &oe);
    free(aj);
    if (!handled) return ret_error(out_error, "插件 %s 没有这个方法：%s", id, method);
    if (oe) { *out_error = oe; if (oj) host_dealloc(oj); return -1; }
    cJSON *data = oj ? cJSON_Parse(oj) : NULL;
    if (oj) host_dealloc(oj);
    return ret_json(data ? data : cJSON_CreateNull(), out_json);
  }
  if (!strcmp(channel, "plugin:store:get")) {
    const char *id = arg_str(args, 0, "");
    cJSON *all = store_get("plugin-data");
    cJSON *v = all ? cJSON_GetObjectItemCaseSensitive(all, id) : NULL;
    cJSON *res = v ? cJSON_Duplicate(v, 1) : cJSON_CreateObject();
    if (all) cJSON_Delete(all);
    return ret_json(res, out_json);
  }
  if (!strcmp(channel, "plugin:store:set")) {
    const char *id = arg_str(args, 0, "");
    cJSON *patch = arg_obj(args, 1);
    cJSON *all = store_get("plugin-data");
    if (!all || !cJSON_IsObject(all)) { if (all) cJSON_Delete(all); all = cJSON_CreateObject(); }
    cJSON *cur = cJSON_GetObjectItemCaseSensitive(all, id);
    if (!cur) { cur = cJSON_CreateObject(); cJSON_AddItemToObject(all, id, cur); }
    if (patch) json_deep_merge(cur, patch);
    store_set("plugin-data", all);
    cJSON *res = cJSON_Duplicate(cur, 1);
    cJSON_Delete(all);
    return ret_json(res, out_json);
  }
  if (!strcmp(channel, "plugin:openDir")) {
    open_path(modules_dir());
    return ret_json(cJSON_CreateBool(1), out_json);
  }
  /* 内嵌浏览器画布（宿主里的第二个 WebView2，由界面报告位置） */
  if (!strcmp(channel, "browser:viewShow")) {
    cJSON *o = arg_obj(args, 0);
    int x = o ? json_int(o, "x", 0) : 0;
    int y = o ? json_int(o, "y", 0) : 0;
    int w = o ? json_int(o, "w", 800) : 800;
    int h = o ? json_int(o, "h", 600) : 600;
    double dpr = o ? json_num(o, "dpr", 1) : 1;
    browser_view_show(x, y, w, h, dpr, o ? json_str(o, "url", "") : "");
    return ret_json(browser_view_state(), out_json);
  }
  if (!strcmp(channel, "browser:viewHide")) { browser_view_hide(); return ret_json(cJSON_CreateBool(1), out_json); }
  if (!strcmp(channel, "browser:viewNavigate")) { browser_view_navigate(arg_str(args, 0, "")); return ret_json(cJSON_CreateBool(1), out_json); }
  if (!strcmp(channel, "browser:viewBack")) { browser_view_back(); return ret_json(cJSON_CreateBool(1), out_json); }
  if (!strcmp(channel, "browser:viewForward")) { browser_view_forward(); return ret_json(cJSON_CreateBool(1), out_json); }
  if (!strcmp(channel, "browser:viewReload")) { browser_view_reload(); return ret_json(cJSON_CreateBool(1), out_json); }
  if (!strcmp(channel, "browser:viewStop")) { browser_view_stop(); return ret_json(cJSON_CreateBool(1), out_json); }
  if (!strcmp(channel, "browser:viewState")) return ret_json(browser_view_state(), out_json);
  return -2; /* 未处理 */
}

int api_handle(const char *body_json, char **out_json, char **out_error) {
  *out_json = NULL; *out_error = NULL;
  cJSON *root = body_json ? cJSON_Parse(body_json) : NULL;
  if (!root) return ret_error(out_error, "请求不是合法 JSON");
  const char *channel = json_str(root, "channel", "");
  cJSON *args = cJSON_GetObjectItemCaseSensitive(root, "args");
  if (!*channel) { cJSON_Delete(root); return ret_error(out_error, "缺少 channel"); }

  int r = host_dispatch(channel, args, out_json, out_error);
  if (r == -2) {
    char *oj = NULL, *oe = NULL;
    char *aj = args ? json_dumps(args) : xstrdup("[]");
    if (modules_dispatch(channel, aj, &oj, &oe)) {
      if (oe) { *out_error = oe; r = -1; if (oj) host_dealloc(oj); }
      else { *out_json = oj; r = 0; }
    } else {
      r = ret_error(out_error, "C 版还没有实现这个接口：%s", channel);
    }
  }
  cJSON_Delete(root);
  return r;
}
