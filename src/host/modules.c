#include "modules.h"
#include "store.h"

static LoadedModule **g_mods = NULL;
static int g_nmods = 0, g_capmods = 0;
static char g_dir[MAX_PATH * 2] = {0};
static CRITICAL_SECTION g_cs;
static int g_inited = 0;
static cJSON *g_load_errors = NULL;

void *host_alloc(size_t n) {
  void *p = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, n ? n : 1);
  return p;
}
void host_dealloc(void *p) {
  if (p) HeapFree(GetProcessHeap(), 0, p);
}
static char *host_strdup(const char *s) {
  size_t n = strlen(s ? s : "");
  char *p = (char *)host_alloc(n + 1);
  if (p) memcpy(p, s ? s : "", n + 1);
  return p;
}

static int module_bit(const char *id) {
  const cJSON *pl = NULL;
  cJSON *plugins = store_get("plugins");
  (void)pl;
  int en = 1;
  if (plugins) {
    const cJSON *e = cJSON_GetObjectItemCaseSensitive(plugins, "enabled");
    const cJSON *v = e ? cJSON_GetObjectItemCaseSensitive(e, id) : NULL;
    if (v && cJSON_IsBool(v)) en = cJSON_IsTrue(v);
    cJSON_Delete(plugins);
  }
  return en;
}

int module_is_enabled(const char *id) {
  LoadedModule *m = modules_find(id);
  return m ? m->enabled : 0;
}

static void add_error(const char *file, const char *err) {
  if (!g_load_errors) g_load_errors = cJSON_CreateArray();
  cJSON *o = cJSON_CreateObject();
  cJSON_AddStringToObject(o, "file", file ? file : "");
  cJSON_AddStringToObject(o, "error", err ? err : "");
  cJSON_AddItemToArray(g_load_errors, o);
}

static void fill_meta(LoadedModule *m) {
  cJSON *mf = m->manifest;
  m->id = xstrdup(json_str(mf, "id", ""));
  m->builtin = json_bool(mf, "builtin", 0);
  m->enabled = module_bit(m->id);
  const cJSON *ch = cJSON_GetObjectItemCaseSensitive(mf, "channels");
  if (cJSON_IsArray(ch)) {
    const cJSON *it = NULL;
    cJSON_ArrayForEach(it, ch) {
      if (cJSON_IsString(it) && m->n_channels < 24) m->channels[m->n_channels++] = xstrdup(it->valuestring);
    }
  }
  if (m->n_channels == 0) {
    char buf[128];
    snprintf(buf, sizeof(buf), "%s:", m->id);
    m->channels[m->n_channels++] = xstrdup(buf);
  }
  m->renderer = NULL;
  m->style = NULL;
}

static int load_one(const char *dir, const char *name) {
  char *path = path_join(dir, name);
  wchar_t *wp = u8_to_w(path);
  HMODULE h = LoadLibraryExW(wp, NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
  free(wp);
  if (!h) {
    char err[256];
    snprintf(err, sizeof(err), "LoadLibrary 失败（错误码 %lu）", (unsigned long)GetLastError());
    add_error(name, err);
    free(path);
    return 0;
  }
  SgjEntryFn fn = (SgjEntryFn)(void *)GetProcAddress(h, "sgj_module_entry");
  if (!fn) {
    add_error(name, "缺少导出 sgj_module_entry（不是拾光集模块）");
    FreeLibrary(h); free(path);
    return 0;
  }
  const SgjModule *mod = fn();
  if (!mod) { add_error(name, "sgj_module_entry 返回空"); FreeLibrary(h); free(path); return 0; }
  if (mod->abi != SGJ_ABI) {
    char err[160]; snprintf(err, sizeof(err), "ABI 不匹配（dll=%d / 宿主=%d）", mod->abi, SGJ_ABI);
    add_error(name, err); FreeLibrary(h); free(path); return 0;
  }
  if (!mod->id || !*mod->id) { add_error(name, "清单缺少 id"); FreeLibrary(h); free(path); return 0; }
  cJSON *mf = mod->manifest_json ? cJSON_Parse(mod->manifest_json) : NULL;
  if (!mf) { add_error(name, "清单不是合法 JSON"); FreeLibrary(h); free(path); return 0; }
  const char *mid = json_str(mf, "id", "");
  if (!*mid) { add_error(name, "清单缺少 id"); cJSON_Delete(mf); FreeLibrary(h); free(path); return 0; }
  if (!json_str(mf, "route", "")[0] || !json_str(mf, "title", "")[0]) {
    add_error(name, "清单缺少 route / title"); cJSON_Delete(mf); FreeLibrary(h); free(path); return 0;
  }
  if (modules_find(mid)) {
    char err[256]; snprintf(err, sizeof(err), "id 跟已加载的 %s 重复", mid);
    add_error(name, err); cJSON_Delete(mf); FreeLibrary(h); free(path); return 0;
  }

  LoadedModule *lm = (LoadedModule *)xcalloc(1, sizeof(LoadedModule));
  lm->h = h; lm->mod = mod; lm->manifest = mf; lm->manifest_json = xstrdup(mod->manifest_json);
  lm->file = path;
  fill_meta(lm);
  if (mod->init) {
    int rc = mod->init(host_api());
    if (rc != 0) {
      char err[256]; snprintf(err, sizeof(err), "init 失败（%d）", rc);
      add_error(name, err);
      if (lm->id) free(lm->id);
      for (int i = 0; i < lm->n_channels; i++) free(lm->channels[i]);
      cJSON_Delete(lm->manifest); free(lm->manifest_json); free(lm->file); free(lm);
      FreeLibrary(h);
      return 0;
    }
  }
  if (g_nmods == g_capmods) {
    g_capmods = g_capmods ? g_capmods * 2 : 8;
    g_mods = (LoadedModule **)xrealloc(g_mods, sizeof(LoadedModule *) * (size_t)g_capmods);
  }
  g_mods[g_nmods++] = lm;
  LOGI("module: %s (%s) %s", lm->id, name, lm->builtin ? "builtin" : "ext");
  return 1;
}

int modules_init(const char *dir) {
  InitializeCriticalSection(&g_cs);
  g_inited = 1;
  snprintf(g_dir, sizeof(g_dir), "%s", dir ? dir : "");
  g_load_errors = cJSON_CreateArray();
  if (!dir || !*dir) return 0;
  path_mkdirs(dir);
  char *pat = path_join(dir, "*.dll");
  wchar_t *wpat = u8_to_w(pat);
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileW(wpat, &fd);
  free(wpat); free(pat);
  if (h == INVALID_HANDLE_VALUE) {
    LOGW("modules: 目录里没有 dll（%s）", dir);
    return 0;
  }
  int loaded = 0;
  do {
    if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
    char *name = w_to_u8(fd.cFileName);
    if (str_ends_ci(name, ".dll")) loaded += load_one(dir, name);
    free(name);
  } while (FindNextFileW(h, &fd));
  FindClose(h);
  LOGI("modules: 共 %d 个（目录 %s）", loaded, dir);
  return loaded;
}

void modules_shutdown(void) {
  for (int i = 0; i < g_nmods; i++) {
    LoadedModule *m = g_mods[i];
    if (!m) continue;
    if (m->mod && m->mod->shutdown) m->mod->shutdown();
    if (m->h) FreeLibrary(m->h);
    free(m->id); cJSON_Delete(m->manifest); free(m->manifest_json); free(m->file);
    for (int k = 0; k < m->n_channels; k++) free(m->channels[k]);
    free(m);
  }
  free(g_mods); g_mods = NULL; g_nmods = g_capmods = 0;
  if (g_load_errors) { cJSON_Delete(g_load_errors); g_load_errors = NULL; }
}

int modules_count(void) { return g_nmods; }
int modules_total(void) { return g_nmods; }
const char *modules_dir(void) { return g_dir; }
LoadedModule *modules_at(int i) { return (i >= 0 && i < g_nmods) ? g_mods[i] : NULL; }

LoadedModule *modules_find(const char *id) {
  if (!id) return NULL;
  for (int i = 0; i < g_nmods; i++) {
    if (g_mods[i] && g_mods[i]->id && strcmp(g_mods[i]->id, id) == 0) return g_mods[i];
  }
  return NULL;
}

int modules_dispatch(const char *channel, const char *args_json, char **out_json, char **out_error) {
  *out_json = NULL; *out_error = NULL;
  if (!channel) return 0;
  EnterCriticalSection(&g_cs);
  int best = -1, best_len = 0;
  for (int i = 0; i < g_nmods; i++) {
    LoadedModule *m = g_mods[i];
    if (!m || !m->mod || !m->mod->invoke) continue;
    for (int k = 0; k < m->n_channels; k++) {
      int len = (int)strlen(m->channels[k]);
      if (len > best_len && str_starts(channel, m->channels[k])) { best = i; best_len = len; }
    }
  }
  if (best >= 0) {
    LoadedModule *m = g_mods[best];
    char *oj = NULL, *oe = NULL;
    int rc = m->mod->invoke(channel, args_json ? args_json : "[]", &oj, &oe);
    LeaveCriticalSection(&g_cs);
    if (rc != 0) {
      if (!oe) oe = host_strdup("模块调用失败");
      *out_error = oe;
      if (oj) host_dealloc(oj);
      return 1;
    }
    *out_json = oj ? oj : host_strdup("null");
    if (oe) host_dealloc(oe);
    return 1;
  }
  LeaveCriticalSection(&g_cs);
  return 0;
}

const char *modules_renderer(const char *id, size_t *len) {
  LoadedModule *m = modules_find(id);
  if (!m || !m->mod || !m->mod->renderer_js) { if (len) *len = 0; return NULL; }
  if (len) *len = strlen(m->mod->renderer_js);
  return m->mod->renderer_js;
}
const char *modules_style(const char *id, size_t *len) {
  LoadedModule *m = modules_find(id);
  if (!m || !m->mod || !m->mod->style_css) { if (len) *len = 0; return NULL; }
  if (len) *len = strlen(m->mod->style_css);
  return m->mod->style_css;
}

static void add_meta_fields(cJSON *o, LoadedModule *m) {
  cJSON *mf = m->manifest;
  const char *keys[] = { "id", "route", "title", "desc", "icon", "accent", "detail", NULL };
  for (int i = 0; keys[i]; i++) {
    const char *v = json_str(mf, keys[i], "");
    cJSON_AddStringToObject(o, keys[i], v);
  }
  cJSON_AddNumberToObject(o, "order", json_int(mf, "order", 99));
  cJSON_AddStringToObject(o, "name", m->id);
  cJSON_AddBoolToObject(o, "enabled", m->enabled);
  cJSON_AddBoolToObject(o, "builtin", m->builtin);
  cJSON_AddStringToObject(o, "kind", m->builtin ? "builtin" : "ext");
  char url[512];
  snprintf(url, sizeof(url), "%s/mod/%s/renderer.js", sgj_base_url(), m->id);
  cJSON_AddStringToObject(o, "rendererUrl", url);
  cJSON *src = cJSON_CreateObject();
  cJSON_AddStringToObject(src, "js", url);
  if (m->mod->style_css) {
    snprintf(url, sizeof(url), "%s/mod/%s/style.css", sgj_base_url(), m->id);
    cJSON_AddStringToObject(o, "styleUrl", url);
    cJSON_AddStringToObject(src, "css", url);
  } else {
    cJSON_AddStringToObject(o, "styleUrl", "");
    cJSON_AddStringToObject(src, "css", "");
  }
  cJSON_AddItemToObject(o, "src", src);
}

static int cmp_mods(const void *a, const void *b) {
  const LoadedModule *ma = *(const LoadedModule *const *)a;
  const LoadedModule *mb = *(const LoadedModule *const *)b;
  int oa = json_int(ma->manifest, "order", 99);
  int ob = json_int(mb->manifest, "order", 99);
  if (oa != ob) return oa < ob ? -1 : 1;
  return strcmp(ma->id, mb->id);
}

cJSON *modules_list_json(void) {
  cJSON *root = cJSON_CreateObject();
  cJSON *arr = cJSON_CreateArray();
  LoadedModule **sorted = (LoadedModule **)xmalloc(sizeof(LoadedModule *) * (size_t)(g_nmods ? g_nmods : 1));
  for (int i = 0; i < g_nmods; i++) sorted[i] = g_mods[i];
  qsort(sorted, (size_t)g_nmods, sizeof(LoadedModule *), cmp_mods);
  for (int i = 0; i < g_nmods; i++) {
    LoadedModule *m = sorted[i];
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "id", m->id);
    cJSON *mf = cJSON_Duplicate(m->manifest, 1);
    cJSON_AddItemToObject(o, "manifest", mf);
    cJSON_AddBoolToObject(o, "hasStyles", m->mod->style_css != NULL);
    char url[512];
    snprintf(url, sizeof(url), "%s/mod/%s/renderer.js", sgj_base_url(), m->id);
    cJSON_AddStringToObject(o, "rendererUrl", url);
    if (m->mod->style_css) {
      snprintf(url, sizeof(url), "%s/mod/%s/style.css", sgj_base_url(), m->id);
      cJSON_AddStringToObject(o, "styleUrl", url);
    }
    cJSON_AddStringToObject(o, "file", m->file);
    cJSON *native = cJSON_CreateObject();
    cJSON_AddStringToObject(native, "kind", "native-c");
    cJSON_AddNumberToObject(native, "abi", SGJ_ABI);
    cJSON_AddStringToObject(native, "host", SGJ_VERSION);
    cJSON_AddItemToObject(o, "native", native);
    cJSON_AddItemToArray(arr, o);
  }
  free(sorted);
  cJSON_AddItemToObject(root, "modules", arr);
  cJSON_AddItemToObject(root, "errors", cJSON_Duplicate(g_load_errors ? g_load_errors : cJSON_CreateArray(), 1));
  return root;
}

cJSON *plugins_list_json(void) {
  cJSON *root = cJSON_CreateObject();
  cJSON *list = cJSON_CreateArray();
  cJSON *ext = cJSON_CreateArray();
  LoadedModule **sorted = (LoadedModule **)xmalloc(sizeof(LoadedModule *) * (size_t)(g_nmods ? g_nmods : 1));
  for (int i = 0; i < g_nmods; i++) sorted[i] = g_mods[i];
  qsort(sorted, (size_t)g_nmods, sizeof(LoadedModule *), cmp_mods);
  int total = 0;
  for (int i = 0; i < g_nmods; i++) {
    LoadedModule *m = sorted[i];
    cJSON *o = cJSON_CreateObject();
    add_meta_fields(o, m);
    if (m->builtin) { cJSON_AddItemToArray(list, o); total++; }
    else cJSON_AddItemToArray(ext, o);
  }
  free(sorted);
  cJSON_AddItemToObject(root, "list", list);
  cJSON_AddItemToObject(root, "ext", ext);
  cJSON_AddItemToObject(root, "errors", cJSON_Duplicate(g_load_errors ? g_load_errors : cJSON_CreateArray(), 1));
  cJSON_AddStringToObject(root, "dir", g_dir);
  cJSON_AddNumberToObject(root, "apiVersion", 1);
  cJSON_AddItemToObject(root, "preset", cJSON_CreateNull());
  cJSON_AddNumberToObject(root, "total", total);
  cJSON *en = cJSON_CreateArray();
  for (int i = 0; i < g_nmods; i++) if (g_mods[i]->enabled) cJSON_AddItemToArray(en, cJSON_CreateString(g_mods[i]->id));
  cJSON_AddItemToObject(root, "enabled", en);
  return root;
}

cJSON *hub_modules_json(void) {
  cJSON *arr = cJSON_CreateArray();
  LoadedModule **sorted = (LoadedModule **)xmalloc(sizeof(LoadedModule *) * (size_t)(g_nmods ? g_nmods : 1));
  for (int i = 0; i < g_nmods; i++) sorted[i] = g_mods[i];
  qsort(sorted, (size_t)g_nmods, sizeof(LoadedModule *), cmp_mods);
  for (int i = 0; i < g_nmods; i++) {
    LoadedModule *m = sorted[i];
    if (!m->enabled) continue;
    cJSON *o = cJSON_CreateObject();
    add_meta_fields(o, m);
    cJSON_AddItemToArray(arr, o);
  }
  free(sorted);
  return arr;
}

int plugins_set(const char *id, int on, char **err) {
  LoadedModule *m = modules_find(id);
  if (!m) {
    if (err) {
      char buf[256]; snprintf(buf, sizeof(buf), "没有这个插件：%s", id ? id : "");
      *err = xstrdup(buf);
    }
    return 0;
  }
  cJSON *pl = store_get("plugins");
  if (!pl) pl = cJSON_CreateObject();
  cJSON *en = cJSON_GetObjectItemCaseSensitive(pl, "enabled");
  if (!en || !cJSON_IsObject(en)) {
    cJSON_DeleteItemFromObjectCaseSensitive(pl, "enabled");
    en = cJSON_CreateObject();
    cJSON_AddItemToObject(pl, "enabled", en);
  }
  cJSON_DeleteItemFromObjectCaseSensitive(en, id);
  cJSON_AddBoolToObject(en, id, on ? 1 : 0);
  cJSON_DeleteItemFromObjectCaseSensitive(pl, "version");
  cJSON_AddNumberToObject(pl, "version", 1);
  store_set("plugins", pl);
  cJSON_Delete(pl);
  m->enabled = on ? 1 : 0;
  return 1;
}

int plugins_reset(void) {
  cJSON *pl = cJSON_CreateObject();
  cJSON_AddNumberToObject(pl, "version", 1);
  cJSON *en = cJSON_CreateObject();
  cJSON_AddItemToObject(pl, "enabled", en);
  for (int i = 0; i < g_nmods; i++) {
    cJSON_AddBoolToObject(en, g_mods[i]->id, 1);
    g_mods[i]->enabled = 1;
  }
  store_set("plugins", pl);
  cJSON_Delete(pl);
  return 1;
}
