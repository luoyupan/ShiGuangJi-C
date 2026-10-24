#include "store.h"

static cJSON *g_data = NULL;
static char g_path[MAX_PATH * 2];
static char g_dir[MAX_PATH * 2];
static CRITICAL_SECTION g_cs;
static int g_timer_started = 0;

static const char *DEFAULTS_JSON =
"{"
  "\"settings\":{"
    "\"theme\":\"light\",\"accent\":\"#4f7cff\",\"fontScale\":1,\"downloadDir\":\"\","
    "\"modDownload\":{\"mode\":\"install\",\"dir\":\"\",\"keepArchive\":false},"
    "\"playMode\":\"order\",\"volume\":0.8,\"desktopMaterial\":\"off\","
    "\"background\":{\"sidebar\":\"\",\"content\":\"\",\"opacity\":1},"
    "\"update\":{\"mode\":\"auto\",\"lastCheck\":0,\"lastVersion\":\"\",\"skipped\":\"\"}"
  "},"
  "\"plugins\":{\"version\":1,\"enabled\":{}},"
  "\"hidden\":{\"enabled\":false,\"name\":\"隐藏空间\",\"hint\":\"\",\"autoLockMinutes\":10,\"space\":[]},"
  "\"games\":{\"list\":[],\"categories\":[],\"sessions\":[]},"
  "\"music\":{\"roots\":[],\"tracks\":[],\"playlists\":[],\"logins\":{},\"plays\":{}},"
  "\"netdisk\":{\"cookies\":{}},"
  "\"link\":{"
    "\"mode\":\"p2p\",\"roomName\":\"我的联机房\",\"playerName\":\"\",\"gameName\":\"\",\"gamePort\":25565,"
    "\"localPort\":25565,\"tunnelPort\":47788,\"ctrlPort\":0,\"publicAddr\":\"\","
    "\"relayHost\":\"\",\"relayPort\":47777,\"relayServePort\":47777,"
    "\"stunHost\":\"\",\"stunPort\":3478,\"ttlMinutes\":1440,\"useVnic\":false,"
    "\"netConsent\":false,\"netConsentAt\":0"
  "},"
  "\"photos\":{\"roots\":[],\"places\":{},\"sort\":\"time-desc\","
    "\"map\":{\"source\":\"tianditu\",\"tk\":\"\",\"style\":\"auto\",\"view\":\"china\",\"layers\":[]}},"
  "\"browser\":{"
    "\"settings\":{\"home\":\"https://www.bing.com/\",\"engine\":\"bing\",\"sidebar\":true,\"newTabSites\":true},"
    "\"bookmarks\":[],\"folders\":[\"默认\"],\"history\":[],\"plugins\":[],\"extDirs\":[],\"builtinsSeeded\":false"
  "},"
  "\"profile\":{\"nickname\":\"主人\",\"avatar\":\"\"}"
"}";

void store_flush(void) {
  EnterCriticalSection(&g_cs);
  if (g_data) json_to_file(g_path, g_data);
  LeaveCriticalSection(&g_cs);
}

static DWORD WINAPI store_timer_thread(LPVOID p) {
  (void)p;
  for (;;) {
    Sleep(1200);
    /* 只在有变更标记时写；简单起见每 1.2 秒检查一个脏标记 */
    extern volatile LONG g_store_dirty;
    if (g_store_dirty) {
      InterlockedExchange(&g_store_dirty, 0);
      store_flush();
    }
  }
  return 0;
}

volatile LONG g_store_dirty = 0;

static void mark_dirty(void) {
  InterlockedExchange(&g_store_dirty, 1);
  if (!g_timer_started) {
    g_timer_started = 1;
    CreateThread(NULL, 0, store_timer_thread, NULL, 0, NULL);
  }
}

int store_init(const char *data_dir) {
  InitializeCriticalSection(&g_cs);
  snprintf(g_dir, sizeof(g_dir), "%s", data_dir ? data_dir : "");
  path_mkdirs(g_dir);
  snprintf(g_path, sizeof(g_path), "%s\\shiguangji.json", g_dir);

  cJSON *defaults = cJSON_Parse(DEFAULTS_JSON);
  cJSON *loaded = json_from_file(g_path);
  if (loaded && cJSON_IsObject(loaded)) {
    /* 以默认值为底，把存档合并进去（存档优先）—— 反了就会把用户数据全抹成默认值 */
    json_deep_merge(defaults, loaded);
  }
  if (loaded) cJSON_Delete(loaded);
  g_data = defaults;
  LOGI("store: %s (%s)", g_path, loaded ? "已加载" : "新建");
  return 1;
}

const char *store_path(void) { return g_path; }
const char *store_data_dir(void) { return g_dir; }
int store_ready(void) { return g_data != NULL; }

cJSON *store_get(const char *key) {
  EnterCriticalSection(&g_cs);
  cJSON *v = g_data ? cJSON_GetObjectItemCaseSensitive(g_data, key) : NULL;
  cJSON *cp = v ? cJSON_Duplicate(v, 1) : NULL;
  LeaveCriticalSection(&g_cs);
  return cp;
}

char *store_get_text(const char *key) {
  cJSON *v = store_get(key);
  char *t = json_dumps(v ? v : cJSON_CreateNull());
  if (v) cJSON_Delete(v);
  return t;
}

void store_set(const char *key, const cJSON *val) {
  EnterCriticalSection(&g_cs);
  cJSON *cp = val ? cJSON_Duplicate(val, 1) : cJSON_CreateNull();
  cJSON *old = cJSON_GetObjectItemCaseSensitive(g_data, key);
  if (old) cJSON_ReplaceItemInObjectCaseSensitive(g_data, key, cp);
  else cJSON_AddItemToObject(g_data, key, cp);
  LeaveCriticalSection(&g_cs);
  mark_dirty();
}

void store_merge(const char *key, const cJSON *patch) {
  EnterCriticalSection(&g_cs);
  cJSON *cur = cJSON_GetObjectItemCaseSensitive(g_data, key);
  if (!cur) {
    cJSON_AddItemToObject(g_data, key, cJSON_Duplicate(patch, 1));
  } else if (cJSON_IsObject(cur) && cJSON_IsObject(patch)) {
    json_deep_merge(cur, patch);
  } else {
    cJSON *cp = cJSON_Duplicate(patch, 1);
    cJSON_ReplaceItemInObjectCaseSensitive(g_data, key, cp);
  }
  LeaveCriticalSection(&g_cs);
  mark_dirty();
}

cJSON *store_snapshot(void) {
  EnterCriticalSection(&g_cs);
  cJSON *cp = g_data ? cJSON_Duplicate(g_data, 1) : cJSON_CreateObject();
  LeaveCriticalSection(&g_cs);
  return cp;
}
