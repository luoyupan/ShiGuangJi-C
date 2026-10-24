/* ============================================================
 * 拾光集 · 浏览器模块 (browser.dll)
 * ------------------------------------------------------------
 * 网页画布由宿主的第二个 WebView2 提供（browser:view*，见 api.c）；
 * 这个 dll 负责设置 / 书签 / 历史 / 搜索引擎 / 新标签页 / 插件清单。
 * 界面是本 dll 里的 renderer.js（标签 + 地址栏 + 书签侧栏）。
 * ============================================================ */
#include "../module_common.h"

static const char *g_manifest = NULL;
static const char *g_js = NULL;
static SgjModule g_mod;

static const char *ENGINES[][2] = {
  { "bing", "https://www.bing.com/search?q=" },
  { "baidu", "https://www.baidu.com/s?wd=" },
  { "google", "https://www.google.com/search?q=" },
  { "sogou", "https://www.sogou.com/web?query=" },
  { "360", "https://www.so.com/s?q=" },
  { "duckduckgo", "https://duckduckgo.com/?q=" },
  { NULL, NULL }
};
static const char *SITES[][2] = {
  { "必应", "https://www.bing.com/" }, { "百度", "https://www.baidu.com/" },
  { "哔哩哔哩", "https://www.bilibili.com/" }, { "知乎", "https://www.zhihu.com/" },
  { "微博", "https://weibo.com/" }, { "豆瓣", "https://www.douban.com/" },
  { "GitHub", "https://github.com/" }, { "Steam", "https://store.steampowered.com/" },
  { "网易云音乐", "https://music.163.com/" }, { "QQ 音乐", "https://y.qq.com/" },
  { NULL, NULL }
};

static char *bid(void) {
  static volatile LONG n = 0;
  char b[64];
  snprintf(b, sizeof(b), "bm%llx%x", (unsigned long long)(now_ms() & 0xFFFFFFFFFFFFULL), (unsigned)InterlockedIncrement(&n));
  return xstrdup(b);
}
static cJSON *B_root(void) {
  cJSON *b = mod_store_get("browser");
  if (!cJSON_IsObject(b)) { if (b) cJSON_Delete(b); b = cJSON_CreateObject(); }
  const char *arrs[] = { "bookmarks", "folders", "history", "plugins", "extDirs", NULL };
  for (int i = 0; arrs[i]; i++) if (!cJSON_IsArray(cJSON_GetObjectItemCaseSensitive(b, arrs[i]))) {
    cJSON_DeleteItemFromObjectCaseSensitive(b, arrs[i]);
    cJSON_AddItemToObject(b, arrs[i], cJSON_CreateArray());
  }
  if (!cJSON_IsArray(cJSON_GetObjectItemCaseSensitive(b, "folders"))) {
    cJSON_DeleteItemFromObjectCaseSensitive(b, "folders");
    cJSON_AddItemToObject(b, "folders", cJSON_CreateArray());
  }
  if (!cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(b, "folders")))
    cJSON_AddItemToArray(cJSON_GetObjectItemCaseSensitive(b, "folders"), cJSON_CreateString("默认"));
  if (!cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(b, "settings"))) {
    cJSON_DeleteItemFromObjectCaseSensitive(b, "settings");
    cJSON *s = cJSON_CreateObject();
    cJSON_AddStringToObject(s, "home", "https://www.bing.com/");
    cJSON_AddStringToObject(s, "engine", "bing");
    cJSON_AddBoolToObject(s, "sidebar", 1);
    cJSON_AddBoolToObject(s, "newTabSites", 1);
    cJSON_AddBoolToObject(s, "adblock", 1);
    cJSON_AddItemToObject(s, "adblockRules", cJSON_CreateArray());
    cJSON_AddStringToObject(s, "nightMode", "off");
    cJSON_AddBoolToObject(s, "gestures", 1);
    cJSON *gm = cJSON_CreateObject();
    cJSON_AddStringToObject(gm, "L", "back"); cJSON_AddStringToObject(gm, "R", "forward");
    cJSON_AddStringToObject(gm, "U", "top"); cJSON_AddStringToObject(gm, "D", "bottom");
    cJSON_AddStringToObject(gm, "DR", "closeTab"); cJSON_AddStringToObject(gm, "UR", "newTab");
    cJSON_AddStringToObject(gm, "LR", "reload"); cJSON_AddStringToObject(gm, "DU", "reopenTab");
    cJSON_AddStringToObject(gm, "DL", "nextTab");
    cJSON_AddItemToObject(s, "gestureMap", gm);
    cJSON *ntp = cJSON_CreateObject();
    cJSON_AddNumberToObject(ntp, "quickRows", 1);
    cJSON_AddBoolToObject(ntp, "showTop", 0);
    cJSON_AddStringToObject(ntp, "bgPath", "");
    cJSON_AddStringToObject(ntp, "bgUrl", "");
    cJSON_AddStringToObject(ntp, "bgPreset", "");
    cJSON_AddStringToObject(ntp, "bgFit", "cover");
    cJSON_AddNumberToObject(ntp, "bgBlur", 0);
    cJSON_AddNumberToObject(ntp, "bgDim", 0);
    cJSON_AddItemToObject(ntp, "sites", cJSON_CreateArray());
    cJSON_AddItemToObject(s, "ntp", ntp);
    cJSON_AddStringToObject(s, "partition", "persist:sgj-browser");
    cJSON_AddStringToObject(s, "ua", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36");
    cJSON_AddItemToObject(b, "settings", s);
  }
  return b;
}
static void B_save(cJSON *b) { mod_store_set("browser", b); }

static cJSON *bookmarks_of(cJSON *b) { return cJSON_GetObjectItemCaseSensitive(b, "bookmarks"); }
static cJSON *bm_find(cJSON *arr, const char *id) {
  cJSON *it = NULL;
  cJSON_ArrayForEach(it, arr) if (!strcmp(json_str(it, "id", ""), id)) return it;
  return NULL;
}
static cJSON *resolve_input(const char *text, const char *engine) {
  cJSON *o = cJSON_CreateObject();
  char buf[4096];
  snprintf(buf, sizeof(buf), "%s", text ? text : "");
  str_trim(buf);
  if (!*buf) { cJSON_AddStringToObject(o, "url", ""); cJSON_AddStringToObject(o, "kind", "empty"); return o; }
  if (str_starts(buf, "http://") || str_starts(buf, "https://") || str_starts(buf, "file:") ||
      str_starts(buf, "about:") || str_starts(buf, "steam:")) {
    cJSON_AddStringToObject(o, "url", buf);
    cJSON_AddStringToObject(o, "kind", "url");
    return o;
  }
  /* 像域名（含点且无空格）→ 补 https */
  int dot = strchr(buf, '.') != NULL, space = strchr(buf, ' ') != NULL, colon = strchr(buf, ':') != NULL;
  if (dot && !space && !colon) {
    snprintf(buf + strlen(buf), sizeof(buf) - strlen(buf), "%s", "");
    char u[4200];
    snprintf(u, sizeof(u), "https://%s", buf);
    cJSON_AddStringToObject(o, "url", u);
    cJSON_AddStringToObject(o, "kind", "url");
    return o;
  }
  const char *base = "https://www.bing.com/search?q=";
  for (int i = 0; ENGINES[i][0]; i++) if (!strcmp(ENGINES[i][0], engine ? engine : "bing")) base = ENGINES[i][1];
  char *q = url_encode(buf);
  snprintf(buf, sizeof(buf), "%s%s", base, q);
  free(q);
  cJSON_AddStringToObject(o, "url", buf);
  cJSON_AddStringToObject(o, "kind", "search");
  return o;
}

static int browser_invoke(const char *channel, const char *args_json, char **out_json, char **out_error) {
  cJSON *args = mod_parse_args(args_json);
  int rc = 0;
  cJSON *res = NULL;
  cJSON *b = B_root();

  if (!strcmp(channel, "browser:settings")) {
    res = cJSON_Duplicate(cJSON_GetObjectItemCaseSensitive(b, "settings"), 1);
  } else if (!strcmp(channel, "browser:setSettings")) {
    cJSON *s = cJSON_GetObjectItemCaseSensitive(b, "settings");
    cJSON *patch = mod_arg_obj(args, 0);
    if (patch) json_deep_merge(s, patch);
    B_save(b);
    res = cJSON_Duplicate(s, 1);
  } else if (!strcmp(channel, "browser:engines")) {
    res = cJSON_CreateArray();
    for (int i = 0; ENGINES[i][0]; i++) {
      cJSON *o = cJSON_CreateObject();
      cJSON_AddStringToObject(o, "id", ENGINES[i][0]);
      cJSON_AddStringToObject(o, "name", ENGINES[i][0]);
      cJSON_AddStringToObject(o, "url", ENGINES[i][1]);
      cJSON_AddItemToArray(res, o);
    }
  } else if (!strcmp(channel, "browser:resolveInput")) {
    res = resolve_input(mod_arg_str(args, 0, ""), mod_arg_str(args, 1, "bing"));
  } else if (!strcmp(channel, "browser:sites")) {
    res = cJSON_CreateArray();
    for (int i = 0; SITES[i][0]; i++) {
      cJSON *o = cJSON_CreateObject();
      cJSON_AddStringToObject(o, "title", SITES[i][0]);
      cJSON_AddStringToObject(o, "url", SITES[i][1]);
      cJSON_AddItemToArray(res, o);
    }
  } else if (!strcmp(channel, "browser:bookmarks")) {
    res = cJSON_Duplicate(bookmarks_of(b), 1);
  } else if (!strcmp(channel, "browser:addBookmark")) {
    cJSON *o = mod_arg_obj(args, 0);
    cJSON *arr = bookmarks_of(b);
    const char *url = o ? json_str(o, "url", "") : "";
    cJSON *found = NULL, *it = NULL;
    cJSON_ArrayForEach(it, arr) if (!strcmp(json_str(it, "url", ""), url)) { found = it; break; }
    if (!found) {
      cJSON *bm = cJSON_CreateObject();
      char *id = bid();
      cJSON_AddStringToObject(bm, "id", id); free(id);
      cJSON_AddStringToObject(bm, "title", o ? json_str(o, "title", url) : url);
      cJSON_AddStringToObject(bm, "url", url);
      cJSON_AddStringToObject(bm, "favicon", o ? json_str(o, "favicon", "") : "");
      cJSON_AddStringToObject(bm, "folder", o ? json_str(o, "folder", "默认") : "默认");
      json_set_int(bm, "createdAt", now_ms());
      cJSON_AddItemToArray(arr, bm);
      B_save(b);
      found = bm;
    }
    res = cJSON_Duplicate(found, 1);
  } else if (!strcmp(channel, "browser:updateBookmark")) {
    cJSON *arr = bookmarks_of(b);
    cJSON *bm = bm_find(arr, mod_arg_str(args, 0, ""));
    cJSON *patch = mod_arg_obj(args, 1);
    if (bm && patch) {
      cJSON *it = NULL;
      cJSON_ArrayForEach(it, patch) if (it->string) { cJSON_DeleteItemFromObjectCaseSensitive(bm, it->string); cJSON_AddItemToObject(bm, it->string, cJSON_Duplicate(it, 1)); }
      B_save(b);
    }
    res = bm ? cJSON_Duplicate(bm, 1) : cJSON_CreateNull();
  } else if (!strcmp(channel, "browser:removeBookmark")) {
    cJSON *ids = mod_arg_at(args, 0);
    cJSON *arr = bookmarks_of(b);
    cJSON *out = cJSON_CreateArray();
    cJSON *it = NULL;
    cJSON_ArrayForEach(it, arr) {
      int del = 0;
      if (cJSON_IsArray(ids)) { cJSON *x = NULL; cJSON_ArrayForEach(x, ids) if (cJSON_IsString(x) && !strcmp(x->valuestring, json_str(it, "id", ""))) del = 1; }
      else if (cJSON_IsString(ids) && !strcmp(ids->valuestring, json_str(it, "id", ""))) del = 1;
      if (!del) cJSON_AddItemToArray(out, cJSON_Duplicate(it, 1));
    }
    cJSON_DeleteItemFromObjectCaseSensitive(b, "bookmarks");
    cJSON_AddItemToObject(b, "bookmarks", out);
    B_save(b);
    res = cJSON_CreateBool(1);
  } else if (!strcmp(channel, "browser:findBookmark")) {
    const char *u = mod_arg_str(args, 0, "");
    cJSON *arr = bookmarks_of(b);
    cJSON *it = NULL, *found = NULL;
    cJSON_ArrayForEach(it, arr) if (!strcmp(json_str(it, "url", ""), u)) { found = it; break; }
    res = found ? cJSON_Duplicate(found, 1) : cJSON_CreateNull();
  } else if (!strcmp(channel, "browser:folders")) {
    res = cJSON_Duplicate(cJSON_GetObjectItemCaseSensitive(b, "folders"), 1);
  } else if (!strcmp(channel, "browser:addFolder")) {
    cJSON *arr = cJSON_GetObjectItemCaseSensitive(b, "folders");
    const char *n = mod_arg_str(args, 0, "新文件夹");
    if (!cJSON_IsArray(arr)) arr = cJSON_CreateArray();
    int has = 0;
    cJSON *it = NULL;
    cJSON_ArrayForEach(it, arr) if (cJSON_IsString(it) && !strcmp(it->valuestring, n)) has = 1;
    if (!has) cJSON_AddItemToArray(arr, cJSON_CreateString(n));
    B_save(b);
    res = cJSON_Duplicate(arr, 1);
  } else if (!strcmp(channel, "browser:removeFolder")) {
    const char *n = mod_arg_str(args, 0, "");
    cJSON *arr = cJSON_GetObjectItemCaseSensitive(b, "folders");
    cJSON *out = cJSON_CreateArray();
    cJSON *it = NULL;
    cJSON_ArrayForEach(it, arr) if (cJSON_IsString(it) && strcmp(it->valuestring, n)) cJSON_AddItemToArray(out, cJSON_CreateString(it->valuestring));
    cJSON_DeleteItemFromObjectCaseSensitive(b, "folders");
    cJSON_AddItemToObject(b, "folders", out);
    B_save(b);
    res = cJSON_Duplicate(out, 1);
  } else if (!strcmp(channel, "browser:history")) {
    cJSON *arr = cJSON_GetObjectItemCaseSensitive(b, "history");
    cJSON *opt = mod_arg_obj(args, 0);
    int limit = opt ? json_int(opt, "limit", 200) : 200;
    const char *q = opt ? json_str(opt, "search", "") : "";
    cJSON *out = cJSON_CreateArray();
    int n = cJSON_GetArraySize(arr);
    for (int i = n - 1; i >= 0 && cJSON_GetArraySize(out) < limit; i--) {
      cJSON *it = cJSON_GetArrayItem(arr, i);
      if (*q) {
        char *low = str_lower(json_str(it, "title", ""));
        char *ql = str_lower(q);
        int hit = strstr(low, ql) != NULL;
        free(low); free(ql);
        if (!hit) continue;
      }
      cJSON_AddItemToArray(out, cJSON_Duplicate(it, 1));
    }
    res = out;
  } else if (!strcmp(channel, "browser:addHistory")) {
    cJSON *o = mod_arg_obj(args, 0);
    cJSON *arr = cJSON_GetObjectItemCaseSensitive(b, "history");
    if (o) {
      cJSON *it = NULL, *last = NULL;
      cJSON_ArrayForEach(it, arr) if (!strcmp(json_str(it, "url", ""), json_str(o, "url", ""))) last = it;
      if (last) {
        json_set_int(last, "visitedAt", now_ms());
        if (json_str(o, "title", "")[0]) { cJSON_DeleteItemFromObjectCaseSensitive(last, "title"); cJSON_AddStringToObject(last, "title", json_str(o, "title", "")); }
      } else {
        cJSON *e = cJSON_CreateObject();
        char *id = bid();
        cJSON_AddStringToObject(e, "id", id); free(id);
        cJSON_AddStringToObject(e, "url", json_str(o, "url", ""));
        cJSON_AddStringToObject(e, "title", json_str(o, "title", json_str(o, "url", "")));
        json_set_int(e, "visitedAt", now_ms());
        cJSON_AddItemToArray(arr, e);
      }
      while (cJSON_GetArraySize(arr) > 2000) cJSON_DeleteItemFromArray(arr, 0);
      B_save(b);
    }
    res = cJSON_CreateBool(1);
  } else if (!strcmp(channel, "browser:removeHistory")) {
    cJSON *ids = mod_arg_at(args, 0);
    cJSON *arr = cJSON_GetObjectItemCaseSensitive(b, "history");
    cJSON *out = cJSON_CreateArray();
    cJSON *it = NULL;
    cJSON_ArrayForEach(it, arr) {
      int del = 0;
      if (cJSON_IsArray(ids)) { cJSON *x = NULL; cJSON_ArrayForEach(x, ids) if (cJSON_IsString(x) && !strcmp(x->valuestring, json_str(it, "id", ""))) del = 1; }
      else if (cJSON_IsString(ids) && !strcmp(ids->valuestring, json_str(it, "id", ""))) del = 1;
      if (!del) cJSON_AddItemToArray(out, cJSON_Duplicate(it, 1));
    }
    cJSON_DeleteItemFromObjectCaseSensitive(b, "history");
    cJSON_AddItemToObject(b, "history", out);
    B_save(b);
    res = cJSON_CreateBool(1);
  } else if (!strcmp(channel, "browser:clearHistory")) {
    cJSON_DeleteItemFromObjectCaseSensitive(b, "history");
    cJSON_AddItemToObject(b, "history", cJSON_CreateArray());
    B_save(b);
    res = cJSON_CreateBool(1);
  } else if (!strcmp(channel, "browser:topSites")) {
    int n = mod_arg_int(args, 0, 8);
    cJSON *arr = cJSON_GetObjectItemCaseSensitive(b, "history");
    cJSON *out = cJSON_CreateArray();
    cJSON *it = NULL;
    cJSON_ArrayForEach(it, arr) {
      if (cJSON_GetArraySize(out) >= n) break;
      cJSON_AddItemToArray(out, cJSON_Duplicate(it, 1));
    }
    res = out;
  } else if (!strcmp(channel, "browser:plugins") || !strcmp(channel, "browser:extensions")) {
    res = cJSON_Duplicate(cJSON_GetObjectItemCaseSensitive(b, "plugins"), 1);
  } else if (!strcmp(channel, "browser:addPlugin")) {
    cJSON *o = mod_arg_obj(args, 0);
    cJSON *arr = cJSON_GetObjectItemCaseSensitive(b, "plugins");
    if (o) { cJSON *cp = cJSON_Duplicate(o, 1); if (!json_str(cp, "id", "")[0]) { char *id = bid(); cJSON_AddStringToObject(cp, "id", id); free(id); } cJSON_AddItemToArray(arr, cp); B_save(b); }
    res = cJSON_Duplicate(arr, 1);
  } else if (!strcmp(channel, "browser:updatePlugin")) {
    cJSON *arr = cJSON_GetObjectItemCaseSensitive(b, "plugins");
    cJSON *p = bm_find(arr, mod_arg_str(args, 0, ""));
    cJSON *patch = mod_arg_obj(args, 1);
    if (p && patch) { cJSON *it = NULL; cJSON_ArrayForEach(it, patch) if (it->string) { cJSON_DeleteItemFromObjectCaseSensitive(p, it->string); cJSON_AddItemToObject(p, it->string, cJSON_Duplicate(it, 1)); } B_save(b); }
    res = p ? cJSON_Duplicate(p, 1) : cJSON_CreateNull();
  } else if (!strcmp(channel, "browser:removePlugin")) {
    const char *id = mod_arg_str(args, 0, "");
    cJSON *arr = cJSON_GetObjectItemCaseSensitive(b, "plugins");
    cJSON *out = cJSON_CreateArray();
    cJSON *it = NULL;
    cJSON_ArrayForEach(it, arr) if (strcmp(json_str(it, "id", ""), id)) cJSON_AddItemToArray(out, cJSON_Duplicate(it, 1));
    cJSON_DeleteItemFromObjectCaseSensitive(b, "plugins");
    cJSON_AddItemToObject(b, "plugins", out);
    B_save(b);
    res = cJSON_CreateBool(1);
  } else if (!strcmp(channel, "browser:togglePlugin")) {
    cJSON *arr = cJSON_GetObjectItemCaseSensitive(b, "plugins");
    cJSON *p = bm_find(arr, mod_arg_str(args, 0, ""));
    if (p) { json_set_bool(p, "enabled", mod_arg_bool(args, 1, 1)); B_save(b); }
    res = cJSON_CreateBool(1);
  } else if (!strcmp(channel, "browser:matchPlugins")) {
    res = cJSON_CreateArray();
  } else if (!strcmp(channel, "browser:loadExtension")) {
    const char *dir = mod_arg_str(args, 0, "");
    cJSON *arr = cJSON_GetObjectItemCaseSensitive(b, "extDirs");
    int has = 0; cJSON *it = NULL;
    cJSON_ArrayForEach(it, arr) if (cJSON_IsString(it) && !strcmp(it->valuestring, dir)) has = 1;
    if (!has && *dir) cJSON_AddItemToArray(arr, cJSON_CreateString(dir));
    B_save(b);
    res = cJSON_Duplicate(arr, 1);
  } else if (!strcmp(channel, "browser:unloadExtension")) {
    const char *dir = mod_arg_str(args, 0, "");
    cJSON *arr = cJSON_GetObjectItemCaseSensitive(b, "extDirs");
    cJSON *out = cJSON_CreateArray();
    cJSON *it = NULL;
    cJSON_ArrayForEach(it, arr) if (cJSON_IsString(it) && strcmp(it->valuestring, dir)) cJSON_AddItemToArray(out, cJSON_CreateString(it->valuestring));
    cJSON_DeleteItemFromObjectCaseSensitive(b, "extDirs");
    cJSON_AddItemToObject(b, "extDirs", out);
    B_save(b);
    res = cJSON_Duplicate(out, 1);
  } else if (!strcmp(channel, "browser:clearData")) {
    cJSON *o = mod_arg_obj(args, 0);
    if (!o || json_bool(o, "history", 1)) { cJSON_DeleteItemFromObjectCaseSensitive(b, "history"); cJSON_AddItemToObject(b, "history", cJSON_CreateArray()); }
    if (o && json_bool(o, "bookmarks", 0)) { cJSON_DeleteItemFromObjectCaseSensitive(b, "bookmarks"); cJSON_AddItemToObject(b, "bookmarks", cJSON_CreateArray()); }
    B_save(b);
    res = cJSON_CreateBool(1);
  } else if (!strcmp(channel, "browser:env")) {
    res = cJSON_CreateObject();
    cJSON_AddStringToObject(res, "engine", "WebView2");
    cJSON_AddStringToObject(res, "chromium", "system");
    cJSON_AddBoolToObject(res, "webview", 1);
  } else if (!strcmp(channel, "browser:ntpSites")) {
    res = cJSON_CreateArray();
    for (int i = 0; SITES[i][0]; i++) {
      cJSON *o = cJSON_CreateObject();
      cJSON_AddStringToObject(o, "title", SITES[i][0]);
      cJSON_AddStringToObject(o, "url", SITES[i][1]);
      cJSON_AddItemToArray(res, o);
    }
  } else if (!strcmp(channel, "browser:pickNtpBg") || !strcmp(channel, "browser:pickExtDir") || !strcmp(channel, "browser:pickScript")) {
    char *p = g_host->pick_file(NULL, 0, NULL);
    char *nl = p ? strchr(p, '\n') : NULL;
    if (nl) *nl = 0;
    res = cJSON_CreateString(p ? p : "");
    if (p) g_host->dealloc(p);
  } else if (!strcmp(channel, "browser:clearNtpBg")) {
    cJSON *s = cJSON_GetObjectItemCaseSensitive(b, "settings");
    cJSON *ntp = cJSON_GetObjectItemCaseSensitive(s, "ntp");
    if (ntp) { cJSON_DeleteItemFromObjectCaseSensitive(ntp, "bgPath"); cJSON_AddStringToObject(ntp, "bgPath", ""); cJSON_DeleteItemFromObjectCaseSensitive(ntp, "bgUrl"); cJSON_AddStringToObject(ntp, "bgUrl", ""); B_save(b); }
    res = cJSON_CreateBool(1);
  } else if (!strcmp(channel, "browser:adblockInfo")) {
    res = cJSON_CreateObject();
    cJSON_AddNumberToObject(res, "blocked", 0);
    cJSON_AddNumberToObject(res, "rules", 0);
    cJSON_AddBoolToObject(res, "enabled", json_bool(cJSON_GetObjectItemCaseSensitive(b, "settings"), "adblock", 1));
  } else if (!strcmp(channel, "browser:adblockReset")) {
    res = cJSON_CreateBool(1);
  } else if (!strcmp(channel, "browser:nightCss")) {
    const char *mode = mod_arg_str(args, 0, "off");
    if (!strcmp(mode, "dark"))
      res = cJSON_CreateString("html{filter:invert(1) hue-rotate(180deg);background:#111!important}img,video,picture,canvas,svg{filter:invert(1) hue-rotate(180deg)!important}");
    else if (!strcmp(mode, "warm"))
      res = cJSON_CreateString("html{background:#f7ecd9!important}body{filter:sepia(.18) brightness(.97)!important}");
    else
      res = cJSON_CreateString("");
  } else if (!strcmp(channel, "browser:gestureKit")) {
    res = cJSON_CreateObject();
    cJSON_AddNumberToObject(res, "version", 1);
    cJSON_AddItemToObject(res, "map", cJSON_Duplicate(cJSON_GetObjectItemCaseSensitive(cJSON_GetObjectItemCaseSensitive(b, "settings"), "gestureMap"), 1));
  } else if (!strcmp(channel, "browser:importBookmarks")) {
    cJSON *o = mod_arg_obj(args, 0);
    const char *path = o ? json_str(o, "path", "") : "";
    char *p = *path ? xstrdup(path) : NULL;
    if (!p) { char *r = g_host->pick_file("*.html;*.htm", 0, NULL); if (r) { p = xstrdup(r); g_host->dealloc(r); } }
    cJSON *arr = bookmarks_of(b);
    int n = 0;
    if (p && *p) {
      char *txt = mod_read_file(p, NULL);
      if (txt) {
        const char *q = txt;
        while ((q = strstr(q, "<A ")) || (q = strstr(q, "<a "))) {
          const char *href = strstr(q, "HREF=");
          if (!href) href = strstr(q, "href=");
          const char *close = strstr(q, "</A>");
          if (!close) close = strstr(q, "</a>");
          if (!href || !close) break;
          href += 6;
          while (*href == '"' || *href == ' ') href++;
          const char *he = href;
          while (*he && *he != '"' && *he != '>') he++;
          const char *ts = strchr(q, '>');
          if (ts && ts < close) {
            char *url = xstrndup(href, (size_t)(he - href));
            char *title = xstrndup(ts + 1, (size_t)(close - ts - 1));
            cJSON *bm = cJSON_CreateObject();
            char *id = bid(); cJSON_AddStringToObject(bm, "id", id); free(id);
            cJSON_AddStringToObject(bm, "url", url);
            cJSON_AddStringToObject(bm, "title", title);
            cJSON_AddStringToObject(bm, "folder", "默认");
            json_set_int(bm, "createdAt", now_ms());
            cJSON_AddItemToArray(arr, bm);
            free(url); free(title); n++;
          }
          q = close + 4;
        }
        free(txt);
      }
      free(p);
      B_save(b);
    }
    res = cJSON_CreateObject();
    cJSON_AddNumberToObject(res, "added", n);
  } else if (!strcmp(channel, "browser:exportBookmarks")) {
    char *p = g_host->pick_file("*.html", 1, "bookmarks.html");
    char *nl = p ? strchr(p, '\n') : NULL;
    if (nl) *nl = 0;
    if (!p || !*p) { if (p) g_host->dealloc(p); res = cJSON_CreateObject(); cJSON_AddBoolToObject(res, "canceled", 1); goto end; }
    Buf out; buf_init(&out);
    buf_adds(&out, "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n");
    cJSON *arr = bookmarks_of(b), *it = NULL;
    cJSON_ArrayForEach(it, arr) {
      buf_addf(&out, "    <DT><A HREF=\"%s\">%s</A>\n", json_str(it, "url", ""), json_str(it, "title", ""));
    }
    buf_adds(&out, "</DL><p>\n");
    file_write_all(p, out.p, out.len);
    buf_free(&out);
    res = cJSON_CreateObject();
    cJSON_AddBoolToObject(res, "ok", 1);
    cJSON_AddStringToObject(res, "file", p);
    g_host->dealloc(p);
  } else if (!strcmp(channel, "browser:saveShot") || !strcmp(channel, "browser:copyShot") ||
             !strcmp(channel, "browser:revealShot") || !strcmp(channel, "browser:ocrShot")) {
    rc = -1; *out_error = mod_ret_error("C 版的浏览器截图 / OCR 还没接（WebView2 的 CapturePreview 留待下一步）");
  } else if (!strcmp(channel, "browser:toNetdisk")) {
    rc = -1; *out_error = mod_ret_error("从浏览器发送到网盘需要跨模块调用，C 版暂未接线");
  } else {
    rc = -1; *out_error = mod_ret_error("浏览器模块没有这个方法：%s", channel);
  }
end:
  cJSON_Delete(b);
  cJSON_Delete(args);
  if (rc == 0) *out_json = mod_ret_json(res ? res : cJSON_CreateNull());
  return rc;
}

static int browser_init(const SgjHostApi *h) { mod_set_host(h); return 0; }
static void browser_shutdown(void) {}

SGJ_MODULE_EXPORT const SgjModule *sgj_module_entry(void) {
  if (!g_manifest) { g_manifest = mod_res_dup(L"MANIFEST"); g_js = mod_res_dup(L"UI_JS"); }
  g_mod.abi = SGJ_ABI;
  g_mod.id = "browser";
  g_mod.manifest_json = g_manifest;
  g_mod.renderer_js = g_js;
  g_mod.style_css = NULL;
  g_mod.init = browser_init;
  g_mod.shutdown = browser_shutdown;
  g_mod.invoke = browser_invoke;
  return &g_mod;
}
