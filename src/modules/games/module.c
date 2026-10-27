/* ============================================================
 * 拾光集 · 游戏模块 (games.dll)
 * ------------------------------------------------------------
 * 后端全部是 C：游戏库 CRUD / 分类 / 游玩统计 / 启动守护 /
 * 扫描 Steam·注册表·Epic·文件夹 / 平台总览 / MOD 管理 / 隐藏空间。
 * 界面 JS 由本 dll 的 UI_JS 资源提供，路由 #/games。
 * ============================================================ */
#include "../module_common.h"
#include <tlhelp32.h>
#include <shlobj.h>
#include <shellapi.h>
#include <wincrypt.h>
#include <bcrypt.h>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "ole32.lib")

static const char *g_manifest = NULL;
static const char *g_js = NULL;
static SgjModule g_mod;

#define ADULT_CAT "18+"

/* ============================================================
 *  基础工具
 * ============================================================ */
static char *G_id(void) {
  static volatile LONG seq = 0;
  LONG n = InterlockedIncrement(&seq);
  char buf[64];
  snprintf(buf, sizeof(buf), "g_%llx%x", (unsigned long long)(now_ms() & 0xFFFFFFFFFFFFULL), (unsigned)n);
  return xstrdup(buf);
}
static const char *J_str(cJSON *o, const char *k, const char *d) { return json_str(o, k, d); }
static int J_int(cJSON *o, const char *k, int d) { return json_int(o, k, d); }
static double J_num(cJSON *o, const char *k, double d) { return json_num(o, k, d); }
static cJSON *J_arr(cJSON *o, const char *k) {
  cJSON *a = cJSON_GetObjectItemCaseSensitive(o, k);
  if (!cJSON_IsArray(a)) {
    if (a) cJSON_DeleteItemFromObjectCaseSensitive(o, k);
    a = cJSON_CreateArray();
    cJSON_AddItemToObject(o, k, a);
  }
  return a;
}
static void J_set(cJSON *o, const char *k, cJSON *v) {
  cJSON_DeleteItemFromObjectCaseSensitive(o, k);
  cJSON_AddItemToObject(o, k, v);
}
static void J_set_str(cJSON *o, const char *k, const char *v) {
  cJSON_DeleteItemFromObjectCaseSensitive(o, k);
  cJSON_AddStringToObject(o, k, v ? v : "");
}
static cJSON *obj_get(cJSON *o, const char *k) {
  cJSON *v = cJSON_GetObjectItemCaseSensitive(o, k);
  return v;
}
static const char *cats_first(cJSON *cats) {
  cJSON *it = cJSON_GetArrayItem(cats, 0);
  return (it && cJSON_IsString(it)) ? it->valuestring : "未分类";
}
static int cats_has(cJSON *cats, const char *name) {
  cJSON *it = NULL;
  cJSON_ArrayForEach(it, cats) if (cJSON_IsString(it) && !strcmp(it->valuestring, name)) return 1;
  return 0;
}

/* ============================================================
 *  平台 / 分类
 * ============================================================ */
static const char *platform_name(const char *id) {
  if (!id) return "本地";
  if (!strcmp(id, "steam")) return "Steam";
  if (!strcmp(id, "epic")) return "Epic Games";
  if (!strcmp(id, "ubisoft")) return "Ubisoft Connect";
  if (!strcmp(id, "gog")) return "GOG Galaxy";
  if (!strcmp(id, "battlenet")) return "Battle.net";
  if (!strcmp(id, "ea")) return "EA App";
  if (!strcmp(id, "xbox")) return "Xbox";
  if (!strcmp(id, "wegame")) return "WeGame";
  return "本地";
}
static const char *platform_color(const char *id) {
  if (!id) return "#6b7280";
  if (!strcmp(id, "steam")) return "#1b2838";
  if (!strcmp(id, "epic")) return "#2a2a2a";
  if (!strcmp(id, "ubisoft")) return "#0070ff";
  if (!strcmp(id, "gog")) return "#8b46ff";
  if (!strcmp(id, "battlenet")) return "#00aeff";
  if (!strcmp(id, "ea")) return "#ff4747";
  if (!strcmp(id, "xbox")) return "#107c10";
  if (!strcmp(id, "wegame")) return "#e4393c";
  return "#6b7280";
}
static const char *detect_platform(const char *path, const char *name, const char *exe) {
  char buf[2048];
  snprintf(buf, sizeof(buf), "%s|%s|%s", path ? path : "", name ? name : "", exe ? exe : "");
  char *low = str_lower(buf);
  const char *p = "local";
  if (strstr(low, "steamapps") || strstr(low, "steam\\")) p = "steam";
  else if (strstr(low, "epic games") || strstr(low, "epicgames")) p = "epic";
  else if (strstr(low, "ubisoft") || strstr(low, "uplay")) p = "ubisoft";
  else if (strstr(low, "gog galaxy") || strstr(low, "gog.com")) p = "gog";
  else if (strstr(low, "battle.net") || strstr(low, "blizzard")) p = "battlenet";
  else if (strstr(low, "origin") || strstr(low, "ea games") || strstr(low, "ea app")) p = "ea";
  else if (strstr(low, "windowsapps") || strstr(low, "xbox")) p = "xbox";
  else if (strstr(low, "wegame")) p = "wegame";
  free(low);
  return p;
}

/* 25 类内置词表（自动归类用；自建分类不会被覆盖） */
typedef struct { const char *name; const char *kw[10]; } CatRule;
static const CatRule CAT_RULES[] = {
  { "动作", { "assassin", "devil may cry", "god of war", "nier", "bayonetta", "无双", "动作", "act", NULL } },
  { "射击", { "call of duty", "battlefield", "counter-strike", "counter strike", "overwatch", "apex", "doom", "halo", "守望先锋", "射击" } },
  { "角色扮演", { "elder scrolls", "witcher", "fallout", "dragon age", "final fantasy", "persona", "巫师", "上古卷轴", "仙剑", "rpg" } },
  { "冒险", { "tomb raider", "uncharted", "life is strange", "walking dead", "古墓丽影", "神秘海域", "adventure", "冒险", NULL } },
  { "模拟", { "flight simulator", "euro truck", "farming simulator", "模拟器", "simulator", "sim", "模拟", NULL } },
  { "策略", { "civilization", "total war", "stellaris", "starcraft", "crusader kings", "文明", "全面战争", "三国志", "strategy", "策略" } },
  { "体育", { "fifa", "nba 2k", "efootball", "nfl", "mlb", "football", "basketball", "sports", "体育", "足球" } },
  { "竞速", { "need for speed", "forza", "assetto corsa", "gran turismo", "极品飞车", "极限竞速", "racing", "race", "竞速", "赛车" } },
  { "格斗", { "street fighter", "tekken", "mortal kombat", "guilty gear", "拳皇", "街霸", "铁拳", "fighter", "格斗", NULL } },
  { "沙盒", { "minecraft", "terraria", "我的世界", "泰拉瑞亚", "garry", "sandbox", "craft", "沙盒", NULL } },
  { "解谜", { "talos principle", "the witness", "portal", "传送门", "puzzle", "解谜", NULL } },
  { "恐怖", { "resident evil", "silent hill", "outlast", "phasmophobia", "生化危机", "寂静岭", "horror", "zombie", "恐怖", NULL } },
  { "生存", { "the forest", "valheim", "subnautica", "ark survival", "don't starve", "饥荒", "survival", "rust", "生存", NULL } },
  { "音乐节奏", { "osu!", "beat saber", "guitar hero", "djmax", "rhythm", "音游", "music", "节奏", NULL } },
  { "休闲", { "stardew valley", "animal crossing", "among us", "星露谷物语", "casual", "party", "休闲", NULL } },
  { "卡牌", { "hearthstone", "slay the spire", "yu-gi-oh", "炉石传说", "杀戮尖塔", "card", "卡牌", NULL } },
  { "塔防", { "kingdom rush", "tower defense", "bloons", "保卫萝卜", "塔防", "defense", NULL } },
  { "MOBA", { "dota", "league of legends", "smite", "英雄联盟", "王者荣耀", "moba", NULL } },
  { "大逃杀", { "pubg", "battlegrounds", "fortnite", "warzone", "绝地求生", "堡垒之夜", "吃鸡", NULL } },
  { "平台跳跃", { "celeste", "hollow knight", "cuphead", "rayman", "空洞骑士", "蔚蓝", "platformer", "跳跃", NULL } },
  { "回合制", { "baldur's gate", "divinity original", "xcom", "博德之门", "神界原罪", "幽浮", "turn-based", "回合制", NULL } },
  { "开放世界", { "grand theft auto", "red dead", "cyberpunk", "荒野大镖客", "赛博朋克", "侠盗猎车", "open world", "开放世界", NULL } },
  { "建造经营", { "factorio", "satisfactory", "rimworld", "oxygen not included", "prison architect", "异星工厂", "缺氧", "环世界", "建造", "经营" } },
  { "视觉小说", { "danganronpa", "steins;gate", "clannad", "visual novel", "弹丸论破", "galgame", "恋爱", NULL } },
  { "独立", { "indie", "独立", NULL } },
};
static const char *auto_classify(const char *name) {
  if (!name || !*name) return "";
  char *low = str_lower(name);
  const char *hit = "";
  for (size_t i = 0; i < sizeof(CAT_RULES) / sizeof(CAT_RULES[0]); i++) {
    for (int k = 0; CAT_RULES[i].kw[k]; k++) {
      if (strstr(low, CAT_RULES[i].kw[k])) { hit = CAT_RULES[i].name; break; }
    }
    if (*hit) break;
  }
  free(low);
  return hit;
}
static cJSON *default_categories(void) {
  cJSON *a = cJSON_CreateArray();
  cJSON_AddItemToArray(a, cJSON_CreateString("未分类"));
  cJSON_AddItemToArray(a, cJSON_CreateString(ADULT_CAT));
  for (size_t i = 0; i < sizeof(CAT_RULES) / sizeof(CAT_RULES[0]); i++)
    cJSON_AddItemToArray(a, cJSON_CreateString(CAT_RULES[i].name));
  return a;
}

/* ============================================================
 *  store 根 / 装饰
 * ============================================================ */
static cJSON *G_root(void) {
  cJSON *r = mod_store_get("games");
  if (!cJSON_IsObject(r)) { if (r) cJSON_Delete(r); r = cJSON_CreateObject(); }
  if (!cJSON_IsArray(obj_get(r, "list"))) {
    cJSON *a = cJSON_CreateArray();
    if (obj_get(r, "list")) J_set(r, "list", a); else cJSON_AddItemToObject(r, "list", a);
  }
  if (!cJSON_IsArray(obj_get(r, "sessions"))) {
    cJSON *a = cJSON_CreateArray();
    if (obj_get(r, "sessions")) J_set(r, "sessions", a); else cJSON_AddItemToObject(r, "sessions", a);
  }
  if (!cJSON_IsArray(obj_get(r, "categories"))) {
    cJSON *a = default_categories();
    if (obj_get(r, "categories")) J_set(r, "categories", a); else cJSON_AddItemToObject(r, "categories", a);
  }
  return r;
}
static void G_save(cJSON *root) { mod_store_set("games", root); }
static void G_emit(const char *reason, const char *id) {
  cJSON *o = cJSON_CreateObject();
  cJSON_AddStringToObject(o, "reason", reason ? reason : "update");
  if (id) cJSON_AddStringToObject(o, "id", id);
  mod_emit("games:changed", o);
}

static char *normalize_file_url(const char *u) {
  if (!u) return xstrdup("");
  if (!str_starts(u, "file:")) return xstrdup(u);
  const char *p = u + 5;
  if (str_starts(p, "///")) return xstrdup(u);
  while (*p == '/') p++;
  char *r = (char *)xmalloc(strlen(p) + 10);
  sprintf(r, "file:///%s", p);
  return r;
}

static cJSON *cats_of(cJSON *g) {
  cJSON *cats = cJSON_GetObjectItemCaseSensitive(g, "categories");
  cJSON *out = cJSON_CreateArray();
  if (cJSON_IsArray(cats)) {
    cJSON *it = NULL;
    cJSON_ArrayForEach(it, cats) if (cJSON_IsString(it) && *it->valuestring) cJSON_AddItemToArray(out, cJSON_CreateString(it->valuestring));
  } else {
    const char *c = J_str(g, "category", "");
    if (*c) cJSON_AddItemToArray(out, cJSON_CreateString(c));
  }
  return out;
}

static const char *clear_text(const char *s) {
  if (!strcmp(s, "cleared")) return "已通关";
  if (!strcmp(s, "multi")) return "多周目通关";
  return "未通关";
}
static void format_minutes(int minutes, char *out, size_t n) {
  if (minutes < 60) snprintf(out, n, "%d 分钟", minutes);
  else {
    int h = minutes / 60, m = minutes % 60;
    if (m) snprintf(out, n, "%d 小时 %d 分", h, m);
    else snprintf(out, n, "%d 小时", h);
  }
}

/* 运行状态（启动守护用） */
static CRITICAL_SECTION g_run_cs;
static int g_run_init = 0;
#define MAX_RUN 64
typedef struct {
  char id[64];
  HANDLE proc;
  DWORD pid;
  int external;
  int starting;
  int active;
  int64_t start;
  char exe[MAX_PATH];
} RunSlot;
static RunSlot g_runs[MAX_RUN];
static void run_init(void) { if (!g_run_init) { InitializeCriticalSection(&g_run_cs); g_run_init = 1; } }
static RunSlot *run_find(const char *id) {
  run_init();
  EnterCriticalSection(&g_run_cs);
  RunSlot *r = NULL;
  for (int i = 0; i < MAX_RUN; i++) if (g_runs[i].active && !strcmp(g_runs[i].id, id)) { r = &g_runs[i]; break; }
  LeaveCriticalSection(&g_run_cs);
  return r;
}
static int run_state(const char *id, int *pending) {
  RunSlot *r = run_find(id);
  if (!r) { if (pending) *pending = 0; return 0; }
  int starting = r->starting;
  int active = r->active && !r->starting;
  if (pending) *pending = starting;
  return active;
}

/* 隐藏空间的前向声明（G_list 在它定义之前就要用） */
static int g_unlocked;
static void hidden_check_lock(void);
static cJSON *H_root(void);

static cJSON *G_decorate(cJSON *g) {
  cJSON *o = cJSON_Duplicate(g, 1);
  cJSON *cats = cats_of(g);
  J_set(o, "categories", cats);
  J_set_str(o, "category", cats_first(cats));
  const char *pf = J_str(g, "platform", "local");
  J_set_str(o, "platformName", platform_name(pf));
  J_set_str(o, "platformColor", platform_color(pf));
  const char *path = J_str(g, "path", "");
  const char *exe = J_str(g, "exe", "");
  const char *coverLocal = J_str(g, "coverLocal", "");
  char *cu = normalize_file_url(coverLocal);
  J_set_str(o, "coverLocal", cu);
  free(cu);
  int trackable = (*path || *exe);
  int missing = trackable ? (!path_exists(path) && !(*path == 0 && exe && path_exists(exe))) : 0;
  if (*path == 0) missing = 0;
  json_set_bool(o, "missing", missing);
  const char *cs = J_str(g, "clearState", "uncleared");
  if (strcmp(cs, "cleared") && strcmp(cs, "multi")) cs = "uncleared";
  J_set_str(o, "clearState", cs);
  J_set_str(o, "clearStateText", clear_text(cs));
  int minutes = J_int(g, "playTime", 0);
  char pt[64]; format_minutes(minutes, pt, sizeof(pt));
  J_set_str(o, "playTimeText", pt);
  int pend = 0;
  int running = run_state(J_str(g, "id", ""), &pend);
  json_set_bool(o, "running", running);
  json_set_bool(o, "pending", pend);
  if (!obj_get(o, "installed")) json_set_bool(o, "installed", 1);
  return o;
}

/* ============================================================
 *  游戏库 CRUD
 * ============================================================ */
static cJSON *G_normalize(cJSON *in) {
  cJSON *o = cJSON_CreateObject();
  const char *name = J_str(in, "name", "");
  const char *path = J_str(in, "path", "");
  const char *exe = J_str(in, "exe", "");
  const char *launch = J_str(in, "launch", "");
  const char *pf = J_str(in, "platform", "");
  if (!*pf) pf = detect_platform(path, name, exe);
  const char *id = J_str(in, "id", "");
  char *nid = *id ? xstrdup(id) : G_id();
  cJSON *cats = cats_of(in);
  int hidden = J_int(in, "hidden", 0);
  int locked = J_int(in, "categoryLocked", 0);
  if (!cJSON_GetArraySize(cats) && !locked) {
    const char *guess = auto_classify(name);
    if (*guess) cJSON_AddItemToArray(cats, cJSON_CreateString(guess));
  }
  if (hidden && !cats_has(cats, ADULT_CAT)) cJSON_AddItemToArray(cats, cJSON_CreateString(ADULT_CAT));
  if (cats_has(cats, ADULT_CAT)) hidden = 1;

  J_set_str(o, "id", nid);
  free(nid);
  J_set_str(o, "name", *name ? name : "未命名游戏");
  J_set_str(o, "path", path);
  J_set_str(o, "exe", exe);
  J_set_str(o, "launch", *launch ? launch : exe);
  J_set_str(o, "platform", pf);
  {
    const char *appid = J_str(in, "appid", "");
    J_set_str(o, "appid", appid);
  }
  J_set_str(o, "cover", J_str(in, "cover", ""));
  {
    char *cu = normalize_file_url(J_str(in, "coverLocal", ""));
    J_set_str(o, "coverLocal", cu); free(cu);
  }
  J_set_str(o, "coverKind", J_str(in, "coverKind", J_str(in, "coverLocal", "")[0] ? "local" : (J_str(in, "cover", "")[0] ? "steam" : "none")));
  J_set(o, "categories", cats);
  J_set_str(o, "category", cats_first(cats));
  json_set_bool(o, "categoryLocked", locked);
  J_set_str(o, "catSource", J_str(in, "catSource", ""));
  json_set_bool(o, "favorite", J_int(in, "favorite", 0));
  json_set_bool(o, "hidden", hidden);
  J_set_str(o, "publisher", J_str(in, "publisher", ""));
  J_set_str(o, "version", J_str(in, "version", ""));
  J_set(o, "altNames", cJSON_IsArray(obj_get(in, "altNames")) ? cJSON_Duplicate(obj_get(in, "altNames"), 1) : cJSON_CreateArray());
  J_set_str(o, "note", J_str(in, "note", ""));
  J_set_str(o, "source", J_str(in, "source", ""));
  J_set_str(o, "launchArgs", J_str(in, "launchArgs", ""));
  J_set_str(o, "uninstallString", J_str(in, "uninstallString", ""));
  J_set_str(o, "installDate", J_str(in, "installDate", ""));
  const char *cs = J_str(in, "clearState", "uncleared");
  if (strcmp(cs, "cleared") && strcmp(cs, "multi")) cs = "uncleared";
  J_set_str(o, "clearState", cs);
  json_set_int(o, "addedAt", J_num(in, "addedAt", 0) > 0 ? (int64_t)J_num(in, "addedAt", 0) : now_ms());
  json_set_int(o, "updatedAt", now_ms());
  json_set_int(o, "lastPlayed", (int64_t)J_num(in, "lastPlayed", 0));
  json_set_int(o, "playTime", J_int(in, "playTime", 0));
  json_set_int(o, "playCount", J_int(in, "playCount", 0));
  J_set(o, "achievements", cJSON_IsObject(obj_get(in, "achievements")) ? cJSON_Duplicate(obj_get(in, "achievements"), 1) : cJSON_CreateNull());
  json_set_int(o, "size", (int64_t)J_num(in, "size", 0));
  json_set_int(o, "sizeComputedAt", (int64_t)J_num(in, "sizeComputedAt", 0));
  json_set_bool(o, "missing", J_int(in, "missing", 0));
  json_set_bool(o, "installed", J_int(in, "installed", 1));
  /* 附加字段原样保留 */
  const char *extra[] = { "modDir", "watchExe", "installLocation", "header", "description", NULL };
  for (int i = 0; extra[i]; i++) {
    cJSON *v = obj_get(in, extra[i]);
    if (v) J_set(o, extra[i], cJSON_Duplicate(v, 1));
  }
  return o;
}
/* ---------- 归一化：判断「是不是同一款游戏」用 ---------- */
/* 路径归一：小写、`/`→`\`、去掉结尾反斜杠 */
static char *path_key(const char *p) {
  if (!p || !*p) return xstrdup("");
  char *s = xstrdup(p);
  for (char *q = s; *q; q++) {
    if (*q == '/') *q = '\\';
    *q = (char)tolower((unsigned char)*q);
  }
  size_t n = strlen(s);
  while (n && s[n - 1] == '\\') s[--n] = 0;
  return s;
}
/* 名字归一：小写 + 去掉空格和常见标点（"Battle.net" == "battle net" == "battlenet"） */
static char *name_key(const char *name) {
  char *low = str_lower(name ? name : "");
  char *out = (char *)xmalloc(strlen(low) + 1);
  size_t k = 0;
  for (const char *p = low; *p; p++) {
    if (*p == ' ' || *p == '\t' || *p == '.' || *p == '_' || *p == '-' || *p == '\'' || *p == '"' ||
        *p == ':' || *p == ',' || *p == '&' || *p == '+' || *p == '(' || *p == ')' ||
        *p == '[' || *p == ']' || *p == '!' || *p == '?') continue;
    out[k++] = *p;
  }
  out[k] = 0;
  free(low);
  return out;
}
/* 一条记录的「安装目录」：优先 path，其次主程序所在目录 */
static char *record_dir_key(cJSON *g) {
  const char *p = J_str(g, "path", "");
  if (p && *p) return path_key(p);
  const char *e = J_str(g, "exe", "");
  if (e && *e) { char *d = path_dirname(e); char *k = path_key(d); free(d); return k; }
  return xstrdup("");
}

/* ---------- 平台客户端 / 运行库：这些不是游戏 ----------
   🔴 它们和游戏一样有卸载注册表项、一样躺在 SteamLibrary 里，
      不单列一张表就会被当成「游戏」入库（暴雪战网 / Steamworks Common 就是这么进来的）。 */
static int is_launcher_or_runtime(const char *name, const char *path, const char *exe) {
  (void)path;
  char *nk = name_key(name);
  int hit = 0;
  static const char *exact[] = {
    /* 平台客户端本体 */
    "steam", "steamvr", "steamworks", "steamclient", "battlenet", "battle.net", "暴雪战网", "战网",
    "epicgames", "epicgameslauncher", "goggalaxy", "ubisoftconnect", "uplay", "eaapp", "eadesktop",
    "origin", "rockstargames", "rockstargameslauncher", "socialclub", "wegame", "wegameclient",
    "hoyoplay", "mihoyolauncher", "riotclient", "riotgames", "playnite", "itch", "xboxapp",
    "网易游戏", "腾讯游戏", "游戏加加", "游戏平台", "启动器", NULL
  };
  for (int i = 0; exact[i]; i++) if (!strcmp(nk, exact[i])) { hit = 1; break; }
  if (!hit) {
    /* 长串用包含匹配：这些词出现在真游戏名里的概率几乎为零。
       🔴 注意这里比的是 **name_key 归一化后的串**（已去掉空格/点/下划线），
          所以模式本身也必须写成去空格的形态，否则永远匹配不上。 */
    static const char *contains[] = {
      "steamworkscommonredistributable", "steamlinuxruntime", "protonexperimental",
      "protonhotfix", "steamredistributable", "battlenet", "暴雪战网",
      "epicgameslauncher", "goggalaxy", "ubisoftconnect", "ubisoftgamelauncher",
      "rockstargameslauncher", "eadesktop", "eaapp", "腾讯游戏平台", "游戏运行库",
      "游戏必备运行库", NULL
    };
    for (int i = 0; contains[i]; i++) if (strstr(nk, contains[i])) { hit = 1; break; }
  }
  free(nk);
  if (hit) return 1;
  if (exe && *exe) {
    char *ek = name_key(path_basename(exe));
    static const char *lexe[] = {
      "battlenetexe", "steamexe", "steamwebhelperexe", "epicgameslauncherexe",
      "galaxyclientexe", "ubisoftconnectexe", "uplayexe", "eadesktopexe", "originexe",
      "wegameexe", "rockstargameslauncherexe", "socialclubhelperexe", "hoyoplayexe",
      "riotclientuxexe", "riotclientservicesexe", NULL
    };
    for (int i = 0; lexe[i]; i++) if (!strcmp(ek, lexe[i])) { hit = 1; break; }
    free(ek);
  }
  return hit;
}
/* Steam 里不是游戏的那几个 AppID（运行库 / 运行时 / SteamVR） */
static int steam_appid_skip(const char *appid) {
  static const char *bad[] = {
    "228980",  /* Steamworks Common Redistributables */
    "250820",  /* SteamVR */
    "1070560", /* Steam Linux Runtime 1.0 (scout) */
    "1391110", /* Steam Linux Runtime 2.0 (soldier) */
    "1628350", /* Steam Linux Runtime 3.0 (sniper) */
    "1493710", /* Proton Experimental */
    NULL
  };
  for (int i = 0; bad[i]; i++) if (!strcmp(appid, bad[i])) return 1;
  return 0;
}

static char *dedupe_key(cJSON *g) {
  const char *appid = J_str(g, "appid", "");
  const char *pf = J_str(g, "platform", "local");
  char buf[1024];
  if (*appid && strcmp(pf, "local")) snprintf(buf, sizeof(buf), "%s:%s", pf, appid);
  else {
    const char *p = J_str(g, "path", "");
    if (!*p) p = J_str(g, "launch", "");
    if (!*p) p = J_str(g, "name", "");
    snprintf(buf, sizeof(buf), "path:%s", p);
  }
  char *low = str_lower(buf);
  return low;
}

/* 两条记录是不是同一款游戏。
   🔴 只看 dedupe_key 不够：Steam 清单写的是 `steam:<appid>`，而目录/注册表扫描
      写的是 `path:<安装目录>` —— 同一款游戏两套键，于是重复入库
      （Deadlock / 虹霓深渊2 / 方寸小家 都是这么来两份的）。 */
static int same_game(cJSON *a, cJSON *b) {
  char *da = record_dir_key(a), *db = record_dir_key(b);
  int same = (*da && *db && !strcmp(da, db));
  free(da); free(db);
  if (same) return 1;
  char *ka = dedupe_key(a), *kb = dedupe_key(b);
  same = !strcmp(ka, kb);
  free(ka); free(kb);
  if (same) return 1;
  /* 名字归一后完全相同 + 同平台 + 至少一边没 appid（两边 appid 不同就不是同一款） */
  const char *na = J_str(a, "name", ""), *nb = J_str(b, "name", "");
  if (*na && *nb && !strcmp(J_str(a, "platform", "local"), J_str(b, "platform", "local"))) {
    char *na2 = name_key(na), *nb2 = name_key(nb);
    int eq = !strcmp(na2, nb2);
    free(na2); free(nb2);
    if (eq) {
      const char *ap1 = J_str(a, "appid", ""), *ap2 = J_str(b, "appid", "");
      if (!*ap1 || !*ap2) return 1;
    }
  }
  return 0;
}

/* 谁的信息更全，合并时就留谁 */
static int score_record(cJSON *g) {
  int s = 0;
  if (J_str(g, "appid", "")[0]) s += 4;
  if (J_str(g, "cover", "")[0] || J_str(g, "coverLocal", "")[0]) s += 2;
  if (J_str(g, "exe", "")[0]) s += 1;
  if (J_str(g, "path", "")[0]) s += 1;
  return s;
}

/* 把 drop 并进 keep：补空字段、数值取大、布尔取或、分类并集 */
static void G_merge_into(cJSON *keep, cJSON *drop) {
  static const char *fills[] = { "cover", "coverLocal", "coverKind", "exe", "launch", "watchExe",
    "path", "publisher", "version", "uninstallString", "installDate", "appid",
    "header", "description", "modDir", "installLocation", NULL };
  for (int i = 0; fills[i]; i++) {
    if (!J_str(keep, fills[i], "")[0] && J_str(drop, fills[i], "")[0])
      J_set_str(keep, fills[i], J_str(drop, fills[i], ""));
  }
  static const char *nums[] = { "playTime", "playCount", "size", "sizeComputedAt", NULL };
  for (int i = 0; nums[i]; i++) {
    int64_t a = (int64_t)J_num(keep, nums[i], 0), b = (int64_t)J_num(drop, nums[i], 0);
    if (b > a) json_set_int(keep, nums[i], b);
  }
  static const char *bools[] = { "favorite", "hidden", "installed", "categoryLocked", NULL };
  for (int i = 0; bools[i]; i++)
    if (J_int(drop, bools[i], 0) && !J_int(keep, bools[i], 0)) json_set_bool(keep, bools[i], 1);
  /* 分类：用户手动锁定的不动；否则做并集（扫描来的自动分类也算进去） */
  if (!J_int(keep, "categoryLocked", 0)) {
    cJSON *kc = cats_of(keep), *dc = cats_of(drop), *it = NULL;
    cJSON_ArrayForEach(it, dc) {
      if (cJSON_IsString(it) && *it->valuestring && !cats_has(kc, it->valuestring))
        cJSON_AddItemToArray(kc, cJSON_CreateString(it->valuestring));
    }
    cJSON_Delete(dc);
    J_set(keep, "categories", kc);
    J_set_str(keep, "category", cats_first(kc));
  }
  json_set_int(keep, "updatedAt", now_ms());
}

/* 整理游戏库：① 删掉「平台客户端 / 运行库」这类误入库的 ② 合并重复
   返回 0 表示没动过；*merged / *cleaned 带回各自数量 */
static int G_tidy(int *merged, int *cleaned) {
  int m = 0, c = 0;
  cJSON *root = G_root();
  cJSON *list = obj_get(root, "list");
  if (!cJSON_IsArray(list)) { cJSON_Delete(root); return 0; }
  /* ① 扫描进来的平台客户端 / 运行库：没玩过、没收藏的直接删 */
  for (int i = cJSON_GetArraySize(list) - 1; i >= 0; i--) {
    cJSON *g = cJSON_GetArrayItem(list, i);
    if (!g) continue;
    const char *src = J_str(g, "source", "");
    int from_scan = !strcmp(src, "steam") || !strcmp(src, "epic") ||
                    !strcmp(src, "registry") || !strcmp(src, "folder");
    if (!from_scan) continue;
    if (J_int(g, "playTime", 0) > 0 || J_int(g, "favorite", 0)) continue;
    if (!is_launcher_or_runtime(J_str(g, "name", ""), J_str(g, "path", ""), J_str(g, "exe", ""))) continue;
    cJSON_DetachItemFromArray(list, i);
    cJSON_Delete(g);
    c++;
  }
  /* ② 两两比对合并（每次合并后数组会挪位，重头再扫一遍最省心） */
  int again = 1;
  while (again) {
    again = 0;
    int n = cJSON_GetArraySize(list);
    for (int i = 0; i < n && !again; i++) {
      cJSON *a = cJSON_GetArrayItem(list, i);
      if (!a) continue;
      for (int j = i + 1; j < n; j++) {
        cJSON *b = cJSON_GetArrayItem(list, j);
        if (!b || !same_game(a, b)) continue;
        cJSON *keep = a, *drop = b;
        if (score_record(b) > score_record(a)) { keep = b; drop = a; }
        G_merge_into(keep, drop);
        cJSON_DetachItemViaPointer(list, drop);
        cJSON_Delete(drop);
        m++;
        again = 1;
        break;
      }
    }
  }
  if (m || c) { G_save(root); G_emit("tidy", ""); }
  cJSON_Delete(root);
  if (merged) *merged = m;
  if (cleaned) *cleaned = c;
  return m || c;
}

static cJSON *G_add(cJSON *in, int *is_new) {
  cJSON *root = G_root();
  cJSON *list = obj_get(root, "list");
  cJSON *rec = G_normalize(in);
  /* 扫描来源里的平台客户端 / 运行库不入库（手动添加不受影响：source 为空或 manual） */
  {
    const char *src = J_str(rec, "source", "");
    if (*src && strcmp(src, "manual") &&
        is_launcher_or_runtime(J_str(rec, "name", ""), J_str(rec, "path", ""), J_str(rec, "exe", ""))) {
      cJSON_Delete(rec);
      cJSON_Delete(root);
      if (is_new) *is_new = 0;
      return NULL;
    }
  }
  char *key = dedupe_key(rec);
  cJSON *dup = NULL;
  cJSON *it = NULL;
  cJSON_ArrayForEach(it, list) {
    char *k = dedupe_key(it);
    int same = !strcmp(k, key);
    free(k);
    if (!same) same = same_game(it, rec);
    if (same) { dup = it; break; }
  }
  free(key);
  if (dup) {
    G_merge_into(dup, rec);
    cJSON_Delete(rec);
    G_save(root);
    G_emit("merge", J_str(dup, "id", ""));
    cJSON *g = G_decorate(dup);
    cJSON_Delete(root);
    if (is_new) *is_new = 0;
    return g;
  }
  cJSON_AddItemToArray(list, rec);
  G_save(root);
  G_emit("add", J_str(rec, "id", ""));
  cJSON *g = G_decorate(rec);
  cJSON_Delete(root);
  if (is_new) *is_new = 1;
  return g;
}

static cJSON *G_find(cJSON *root, const char *id) {
  cJSON *list = obj_get(root, "list");
  cJSON *it = NULL;
  cJSON_ArrayForEach(it, list) if (!strcmp(J_str(it, "id", ""), id)) return it;
  return NULL;
}

static cJSON *G_update(const char *id, cJSON *patch) {
  cJSON *root = G_root();
  cJSON *g = G_find(root, id);
  if (!g) { cJSON_Delete(root); return NULL; }
  if (patch) {
    cJSON *it = NULL;
    cJSON_ArrayForEach(it, patch) {
      if (!it->string) continue;
      if (!strcmp(it->string, "categories") || !strcmp(it->string, "category")) continue;
      J_set(g, it->string, cJSON_Duplicate(it, 1));
    }
    if (obj_get(patch, "categories") || obj_get(patch, "category")) {
      int was_adult = cats_has(cats_of(g), ADULT_CAT);
      cJSON *nc = cats_of(patch);
      J_set(g, "categories", nc);
      J_set_str(g, "category", cats_first(nc));
      if (!obj_get(patch, "categoryLocked")) json_set_bool(g, "categoryLocked", 1);
      if (!obj_get(patch, "catSource")) J_set_str(g, "catSource", "user");
      int is_adult = cats_has(nc, ADULT_CAT);
      if (!obj_get(patch, "hidden") && was_adult != is_adult) json_set_bool(g, "hidden", is_adult);
    }
    if (obj_get(patch, "clearState")) {
      const char *cs = J_str(patch, "clearState", "uncleared");
      if (strcmp(cs, "cleared") && strcmp(cs, "multi")) cs = "uncleared";
      J_set_str(g, "clearState", cs);
    }
    json_set_int(g, "updatedAt", now_ms());
  }
  G_save(root);
  G_emit("update", id);
  cJSON *out = G_decorate(g);
  cJSON_Delete(root);
  return out;
}

/* ============================================================
 *  列表 / 排序
 * ============================================================ */
static char g_sort_key[32] = "addedAt";
static int g_sort_mul = -1;
static int g_sort_zh = 0;
static int cmp_games(const void *a, const void *b) {
  cJSON *ga = *(cJSON *const *)a, *gb = *(cJSON *const *)b;
  if (!strcmp(g_sort_key, "favorite")) {
    int fa = J_int(ga, "favorite", 0), fb = J_int(gb, "favorite", 0);
    return (fa - fb) * g_sort_mul;
  }
  cJSON *va = obj_get(ga, g_sort_key), *vb = obj_get(gb, g_sort_key);
  if ((va && cJSON_IsString(va)) || (vb && cJSON_IsString(vb))) {
    const char *sa = (va && cJSON_IsString(va)) ? va->valuestring : "";
    const char *sb = (vb && cJSON_IsString(vb)) ? vb->valuestring : "";
    int r = _stricmp(sa, sb);
    return r * g_sort_mul;
  }
  double na = (va && cJSON_IsNumber(va)) ? va->valuedouble : 0;
  double nb = (vb && cJSON_IsNumber(vb)) ? vb->valuedouble : 0;
  return (na < nb ? -1 : na > nb ? 1 : 0) * g_sort_mul;
}
static int matches_search(cJSON *g, const char *q) {
  if (!q || !*q) return 1;
  Buf b; buf_init(&b);
  buf_adds(&b, J_str(g, "name", "")); buf_addc(&b, ' ');
  cJSON *alts = obj_get(g, "altNames");
  if (cJSON_IsArray(alts)) {
    cJSON *x = NULL;
    cJSON_ArrayForEach(x, alts) if (cJSON_IsString(x)) { buf_adds(&b, x->valuestring); buf_addc(&b, ' '); }
  }
  cJSON *cats = cats_of(g);
  cJSON *c = NULL;
  cJSON_ArrayForEach(c, cats) if (cJSON_IsString(c)) { buf_adds(&b, c->valuestring); buf_addc(&b, ' '); }
  cJSON_Delete(cats);
  buf_adds(&b, J_str(g, "platform", "")); buf_addc(&b, ' ');
  buf_adds(&b, J_str(g, "appid", "")); buf_addc(&b, ' ');
  buf_adds(&b, J_str(g, "publisher", ""));
  char *low = str_lower(b.p); buf_free(&b);
  char *qlow = str_lower(q);
  int hit = strstr(low, qlow) != NULL;
  free(low); free(qlow);
  return hit;
}
static cJSON *G_list(cJSON *opts) {
  cJSON *root = G_root();
  cJSON *list = obj_get(root, "list");
  const char *view = J_str(opts, "view", "all");
  const char *scope = J_str(opts, "scope", "");
  const char *category = J_str(opts, "category", "");
  const char *search = J_str(opts, "search", "");
  const char *platform = J_str(opts, "platform", "");
  const char *sort = J_str(opts, "sort", "added:desc");
  int in_hidden = !strcmp(scope, "hidden") || !strcmp(view, "hidden");
  if (in_hidden) {
    cJSON *h = H_root();
    int en = J_int(h, "enabled", 0);
    cJSON_Delete(h);
    hidden_check_lock();
    if (en && !g_unlocked) { cJSON_Delete(root); return cJSON_CreateArray(); }
  }

  cJSON *arr = cJSON_CreateArray();
  cJSON *it = NULL;
  cJSON_ArrayForEach(it, list) {
    int hidden = J_int(it, "hidden", 0) || cats_has(cats_of(it), ADULT_CAT);
    if (hidden != in_hidden) continue;
    if (!strcmp(view, "favorite") && !J_int(it, "favorite", 0)) continue;
    if (!strcmp(view, "recent") && !J_num(it, "lastPlayed", 0)) continue;
    if (*category && strcmp(category, "all")) {
      cJSON *cs = cats_of(it);
      int has = cats_has(cs, category);
      cJSON_Delete(cs);
      if (!has) continue;
    }
    if (*platform && strcmp(platform, "all") && strcmp(J_str(it, "platform", "local"), platform)) continue;
    if (!matches_search(it, search)) continue;
    cJSON_AddItemToArray(arr, G_decorate(it));
  }
  cJSON_Delete(root);

  if (!strcmp(view, "recent")) {
    strcpy(g_sort_key, "lastPlayed"); g_sort_mul = -1; g_sort_zh = 0;
    cJSON **vec = (cJSON **)xmalloc(sizeof(cJSON *) * (size_t)(cJSON_GetArraySize(arr) ? cJSON_GetArraySize(arr) : 1));
    int n = 0;
    cJSON *x = NULL;
    cJSON_ArrayForEach(x, arr) vec[n++] = x;
    qsort(vec, (size_t)n, sizeof(cJSON *), cmp_games);
    cJSON *out = cJSON_CreateArray();
    for (int i = 0; i < n; i++) { cJSON_DetachItemViaPointer(arr, vec[i]); cJSON_AddItemToArray(out, vec[i]); }
    free(vec); cJSON_Delete(arr);
    return out;
  }

  char key[32] = "addedAt";
  const char *colon = strchr(sort, ':');
  if (colon) {
    size_t klen = (size_t)(colon - sort);
    if (klen >= sizeof(key)) klen = sizeof(key) - 1;
    memcpy(key, sort, klen); key[klen] = 0;
    g_sort_mul = !strcmp(colon + 1, "asc") ? 1 : -1;
  } else {
    snprintf(key, sizeof(key), "%s", sort);
    g_sort_mul = -1;
  }
  if (!strcmp(key, "added")) strcpy(key, "addedAt");
  strcpy(g_sort_key, key);
  g_sort_zh = 1;

  int n = cJSON_GetArraySize(arr);
  cJSON **vec = (cJSON **)xmalloc(sizeof(cJSON *) * (size_t)(n ? n : 1));
  int i = 0;
  cJSON *x = NULL;
  cJSON_ArrayForEach(x, arr) vec[i++] = x;
  qsort(vec, (size_t)n, sizeof(cJSON *), cmp_games);
  cJSON *out = cJSON_CreateArray();
  for (i = 0; i < n; i++) {
    cJSON_DetachItemViaPointer(arr, vec[i]);
    cJSON_AddItemToArray(out, vec[i]);
  }
  free(vec); cJSON_Delete(arr);
  return out;
}

/* ============================================================
 *  统计
 * ============================================================ */
static int64_t period_start(const char *period) {
  if (!period || !strcmp(period, "all")) return 0;
  SYSTEMTIME st; FILETIME ft; GetLocalTime(&st);
  st.wHour = st.wMinute = st.wSecond = st.wMilliseconds = 0;
  if (!strcmp(period, "week")) {
    int dow = (st.wDayOfWeek + 6) % 7;
    int64_t day = local_day_start_ms(now_ms());
    return day - (int64_t)dow * 86400000LL;
  }
  if (!strcmp(period, "month")) { st.wDay = 1; }
  else if (!strcmp(period, "quarter")) { st.wDay = 1; st.wMonth = (WORD)(((st.wMonth - 1) / 3) * 3 + 1); }
  else if (!strcmp(period, "year")) { st.wDay = 1; st.wMonth = 1; }
  SystemTimeToFileTime(&st, &ft);
  ULARGE_INTEGER u; u.LowPart = ft.dwLowDateTime; u.HighPart = ft.dwHighDateTime;
  return (int64_t)(u.QuadPart / 10000ULL) - INT64_C(11644473600000);
}
static double minutes_in(cJSON *s, int64_t since) {
  double end = J_num(s, "end", J_num(s, "start", 0));
  double start = J_num(s, "start", 0);
  double mins = J_num(s, "minutes", 0);
  if (!end || !mins) return 0;
  if (!since) return mins;
  if (end <= (double)since) return 0;
  if (start >= (double)since) return mins;
  double span = end - start; if (span < 1) span = 1;
  return (double)((int)(mins * ((end - (double)since) / span) + 0.5));
}
static cJSON *G_stats(const char *period) {
  if (!period) period = "all";
  int64_t since = period_start(period);
  cJSON *root = G_root();
  cJSON *sessions = obj_get(root, "sessions"), *list = obj_get(root, "list");
  double total = 0;
  int count = 0;
  cJSON *by = cJSON_CreateObject(); /* id -> {id,name,minutes,count,lastPlayed} */
  cJSON *s = NULL;
  cJSON_ArrayForEach(s, sessions) {
    double m = minutes_in(s, since);
    if (m <= 0) continue;
    total += m; count++;
    const char *id = J_str(s, "id", "");
    cJSON *cur = cJSON_GetObjectItemCaseSensitive(by, id);
    if (!cur) {
      cur = cJSON_CreateObject();
      cJSON_AddStringToObject(cur, "id", id);
      cJSON_AddStringToObject(cur, "name", J_str(s, "name", ""));
      cJSON_AddNumberToObject(cur, "minutes", 0);
      cJSON_AddNumberToObject(cur, "count", 0);
      cJSON_AddNumberToObject(cur, "lastPlayed", 0);
      cJSON_AddItemToObject(by, id, cur);
    }
    cJSON *jm = cJSON_GetObjectItemCaseSensitive(cur, "minutes");
    jm->valuedouble += m;
    cJSON *jc = cJSON_GetObjectItemCaseSensitive(cur, "count");
    jc->valuedouble += 1;
    double lp = J_num(s, "end", J_num(s, "start", 0));
    if (lp > J_num(cur, "lastPlayed", 0)) json_set_num(cur, "lastPlayed", lp);
    if (J_str(s, "name", "")[0]) J_set_str(cur, "name", J_str(s, "name", ""));
  }
  cJSON *games = cJSON_CreateArray();
  cJSON *g = NULL;
  cJSON_ArrayForEach(g, by) cJSON_AddItemToArray(games, cJSON_Duplicate(g, 1));
  cJSON_Delete(by);
  /* 按分钟倒序 */
  int n = cJSON_GetArraySize(games);
  for (int i = 0; i < n; i++) for (int j = i + 1; j < n; j++) {
    cJSON *a = cJSON_GetArrayItem(games, i), *b = cJSON_GetArrayItem(games, j);
    if (J_num(b, "minutes", 0) > J_num(a, "minutes", 0)) {
      cJSON *ta = cJSON_Duplicate(a, 1), *tb = cJSON_Duplicate(b, 1);
      cJSON_ReplaceItemInArray(games, i, tb);
      cJSON_ReplaceItemInArray(games, j, ta);
    }
  }
  double totalMinutes = 0, playCount = 0;
  int gameCount = 0, installed = 0, missing = 0, hidden = 0, favorite = 0;
  cJSON *it = NULL;
  cJSON_ArrayForEach(it, list) {
    totalMinutes += J_num(it, "playTime", 0);
    playCount += J_num(it, "playCount", 0);
    gameCount++;
    if (!J_int(it, "missing", 0)) installed++; else missing++;
    if (J_int(it, "hidden", 0)) hidden++;
    if (J_int(it, "favorite", 0)) favorite++;
  }
  cJSON *out = cJSON_CreateObject();
  cJSON_AddStringToObject(out, "period", period);
  json_set_int(out, "since", since);
  cJSON_AddNumberToObject(out, "minutes", (double)((int)(total + 0.5)));
  cJSON_AddNumberToObject(out, "count", count);
  cJSON_AddItemToObject(out, "games", games);
  char buf[64];
  format_minutes((int)(total + 0.5), buf, sizeof(buf));
  cJSON_AddStringToObject(out, "minutesText", buf);
  cJSON_AddNumberToObject(out, "totalMinutes", totalMinutes);
  format_minutes((int)(totalMinutes + 0.5), buf, sizeof(buf));
  cJSON_AddStringToObject(out, "totalText", buf);
  cJSON_AddNumberToObject(out, "playCount", playCount);
  cJSON_AddNumberToObject(out, "gameCount", gameCount);
  cJSON_AddNumberToObject(out, "installed", installed);
  cJSON_AddNumberToObject(out, "missing", missing);
  cJSON_AddNumberToObject(out, "hidden", hidden);
  cJSON_AddNumberToObject(out, "favorite", favorite);
  cJSON_AddNumberToObject(out, "running", 0);
  cJSON *top = cJSON_CreateArray();
  /* 全部游戏按时长前 8 */
  cJSON *copy = cJSON_Duplicate(list, 1);
  int cn = cJSON_GetArraySize(copy);
  for (int i = 0; i < cn; i++) for (int j = i + 1; j < cn; j++) {
    cJSON *a = cJSON_GetArrayItem(copy, i), *b = cJSON_GetArrayItem(copy, j);
    if (J_num(b, "playTime", 0) > J_num(a, "playTime", 0)) {
      cJSON *ta = cJSON_Duplicate(a, 1), *tb = cJSON_Duplicate(b, 1);
      cJSON_ReplaceItemInArray(copy, i, tb); cJSON_ReplaceItemInArray(copy, j, ta);
    }
  }
  for (int i = 0; i < cn && i < 8; i++) {
    cJSON *a = cJSON_GetArrayItem(copy, i);
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "id", J_str(a, "id", ""));
    cJSON_AddStringToObject(o, "name", J_str(a, "name", ""));
    cJSON_AddNumberToObject(o, "minutes", J_num(a, "playTime", 0));
    format_minutes(J_int(a, "playTime", 0), buf, sizeof(buf));
    cJSON_AddStringToObject(o, "text", buf);
    cJSON_AddItemToArray(top, o);
  }
  cJSON_Delete(copy);
  cJSON_AddItemToObject(out, "topMinutes", top);
  cJSON_Delete(root);
  return out;
}

/* ============================================================
 *  隐藏空间
 * ============================================================ */
static int g_unlocked = 0;
static int64_t g_last_active = 0;
static cJSON *H_root(void) {
  cJSON *h = mod_store_get("hidden");
  if (!cJSON_IsObject(h)) { if (h) cJSON_Delete(h); h = cJSON_CreateObject(); }
  if (!obj_get(h, "space")) cJSON_AddItemToObject(h, "space", cJSON_CreateArray());
  return h;
}
/* ---- scrypt（和原版 security.js 的 crypto.scryptSync 参数一致：N=16384,r=8,p=1,keylen=64）
   —— 这样老用户的隐藏空间密码在 C 版里仍然能解开 ---- */
static void salsa20_8(uint32_t B[16]) {
  uint32_t x[16];
  memcpy(x, B, sizeof(x));
#define ROTL(a, b) (((a) << (b)) | ((a) >> (32 - (b))))
  for (int i = 0; i < 8; i += 2) {
    x[4] ^= ROTL(x[0] + x[12], 7);  x[8] ^= ROTL(x[4] + x[0], 9);
    x[12] ^= ROTL(x[8] + x[4], 13); x[0] ^= ROTL(x[12] + x[8], 18);
    x[9] ^= ROTL(x[5] + x[1], 7);   x[13] ^= ROTL(x[9] + x[5], 9);
    x[1] ^= ROTL(x[13] + x[9], 13); x[5] ^= ROTL(x[1] + x[13], 18);
    x[14] ^= ROTL(x[10] + x[6], 7); x[2] ^= ROTL(x[14] + x[10], 9);
    x[6] ^= ROTL(x[2] + x[14], 13); x[10] ^= ROTL(x[6] + x[2], 18);
    x[3] ^= ROTL(x[15] + x[11], 7); x[7] ^= ROTL(x[3] + x[15], 9);
    x[11] ^= ROTL(x[7] + x[3], 13); x[15] ^= ROTL(x[11] + x[7], 18);
    x[1] ^= ROTL(x[0] + x[3], 7);   x[2] ^= ROTL(x[1] + x[0], 9);
    x[3] ^= ROTL(x[2] + x[1], 13);  x[0] ^= ROTL(x[3] + x[2], 18);
    x[6] ^= ROTL(x[5] + x[4], 7);   x[7] ^= ROTL(x[6] + x[5], 9);
    x[4] ^= ROTL(x[7] + x[6], 13);  x[5] ^= ROTL(x[4] + x[7], 18);
    x[11] ^= ROTL(x[10] + x[9], 7); x[8] ^= ROTL(x[11] + x[10], 9);
    x[9] ^= ROTL(x[8] + x[11], 13); x[10] ^= ROTL(x[9] + x[8], 18);
    x[12] ^= ROTL(x[15] + x[14], 7); x[13] ^= ROTL(x[12] + x[15], 9);
    x[14] ^= ROTL(x[13] + x[12], 13); x[15] ^= ROTL(x[14] + x[13], 18);
  }
#undef ROTL
  for (int i = 0; i < 16; i++) B[i] += x[i];
}
static int pbkdf2_sha256(const unsigned char *pwd, ULONG np, const unsigned char *salt, ULONG ns,
                         ULONGLONG iter, unsigned char *out, ULONG n) {
  BCRYPT_ALG_HANDLE h = NULL;
  if (!BCRYPT_SUCCESS(BCryptOpenAlgorithmProvider(&h, BCRYPT_SHA256_ALGORITHM, NULL, BCRYPT_ALG_HANDLE_HMAC_FLAG))) return 0;
  NTSTATUS st = BCryptDeriveKeyPBKDF2(h, (PUCHAR)pwd, np, (PUCHAR)salt, ns, iter, out, n, 0);
  BCryptCloseAlgorithmProvider(h, 0);
  return BCRYPT_SUCCESS(st) ? 1 : 0;
}
static void blockmix(const unsigned char *in, unsigned char *out, int r) {
  uint32_t X[16];
  memcpy(X, in + (size_t)(2 * r - 1) * 64, 64);
  unsigned char *tmp = (unsigned char *)xmalloc((size_t)2 * r * 64);
  for (int i = 0; i < 2 * r; i++) {
    for (int k = 0; k < 16; k++) X[k] ^= ((const uint32_t *)(in + (size_t)i * 64))[k];
    salsa20_8(X);
    memcpy(tmp + (size_t)i * 64, X, 64);
  }
  for (int i = 0; i < r; i++) memcpy(out + (size_t)i * 64, tmp + (size_t)(2 * i) * 64, 64);
  for (int i = 0; i < r; i++) memcpy(out + (size_t)(r + i) * 64, tmp + (size_t)(2 * i + 1) * 64, 64);
  free(tmp);
}
static char *hash_pwd(const char *salt, const char *pwd) {
  const int N = 16384, r = 8, p = 1;
  size_t blen = (size_t)128 * r * p;
  unsigned char *B = (unsigned char *)xmalloc(blen);
  unsigned char *V = (unsigned char *)xmalloc((size_t)128 * r * N);
  unsigned char *X = (unsigned char *)xmalloc((size_t)128 * r);
  unsigned char *Y = (unsigned char *)xmalloc((size_t)128 * r);
  char hex[129] = "";
  const char *pw = pwd ? pwd : "";
  const char *st = salt ? salt : "";
  if (pbkdf2_sha256((const unsigned char *)pw, (ULONG)strlen(pw), (const unsigned char *)st, (ULONG)strlen(st), 1, B, (ULONG)blen)) {
    for (int pi = 0; pi < p; pi++) {
      unsigned char *Bi = B + (size_t)pi * 128 * r;
      memcpy(X, Bi, (size_t)128 * r);
      for (int i = 0; i < N; i++) {
        memcpy(V + (size_t)i * 128 * r, X, (size_t)128 * r);
        blockmix(X, Y, r);
        unsigned char *t = X; X = Y; Y = t;
      }
      for (int i = 0; i < N; i++) {
        uint32_t j = ((const uint32_t *)(X + (size_t)(2 * r - 1) * 64))[0] & (uint32_t)(N - 1);
        for (size_t k = 0; k < (size_t)128 * r; k++) X[k] ^= V[(size_t)j * 128 * r + k];
        blockmix(X, Y, r);
        unsigned char *t = X; X = Y; Y = t;
      }
      memcpy(Bi, X, (size_t)128 * r);
    }
    unsigned char dk[64];
    if (pbkdf2_sha256((const unsigned char *)pw, (ULONG)strlen(pw), B, (ULONG)blen, 1, dk, 64)) {
      for (int i = 0; i < 64; i++) sprintf(hex + i * 2, "%02x", dk[i]);
    }
  }
  free(B); free(V); free(X); free(Y);
  return xstrdup(hex);
}
static const char *hidden_stored(cJSON *h) {
  const char *p = J_str(h, "pwd", "");
  return *p ? p : J_str(h, "hash", "");
}
static void hidden_check_lock(void) {
  if (!g_unlocked) return;
  cJSON *h = H_root();
  int mins = J_int(h, "autoLockMinutes", 10);
  cJSON_Delete(h);
  if (mins <= 0) return;
  if (now_ms() - g_last_active > (int64_t)mins * 60000) g_unlocked = 0;
}

/* ============================================================
 *  启动 / 停止 / 守护
 * ============================================================ */
static void emit_run(const char *id, int running, int pending) {
  cJSON *o = cJSON_CreateObject();
  cJSON_AddStringToObject(o, "id", id ? id : "");
  cJSON_AddBoolToObject(o, "running", running);
  cJSON_AddBoolToObject(o, "pending", pending);
  mod_emit("games:run-state", o);
}
static void emit_notice(const char *id, const char *name, const char *kind, const char *msg, int minutes) {
  cJSON *o = cJSON_CreateObject();
  cJSON_AddStringToObject(o, "id", id ? id : "");
  cJSON_AddStringToObject(o, "name", name ? name : "");
  cJSON_AddStringToObject(o, "kind", kind ? kind : "info");
  cJSON_AddStringToObject(o, "message", msg ? msg : "");
  cJSON_AddNumberToObject(o, "minutes", minutes);
  mod_emit("games:notice", o);
}
static void settle_count(const char *id) {
  cJSON *root = G_root();
  cJSON *g = G_find(root, id);
  if (g) {
    json_set_int(g, "playCount", J_int(g, "playCount", 0) + 1);
    json_set_int(g, "lastPlayed", now_ms());
    json_set_int(g, "updatedAt", now_ms());
    G_save(root);
    G_emit("play", id);
  }
  cJSON_Delete(root);
}
static void settle_session(const char *id, int64_t start, int64_t end) {
  int minutes = (int)((end - start) / 60000);
  if (minutes < 1) minutes = 1;
  cJSON *root = G_root();
  cJSON *g = G_find(root, id);
  if (!g) { cJSON_Delete(root); return; }
  json_set_int(g, "playTime", J_int(g, "playTime", 0) + minutes);
  json_set_int(g, "updatedAt", now_ms());
  cJSON *sessions = obj_get(root, "sessions");
  char date[64]; local_time_str(end, date, sizeof(date));
  cJSON *s = cJSON_CreateObject();
  cJSON_AddStringToObject(s, "id", id);
  cJSON_AddStringToObject(s, "name", J_str(g, "name", ""));
  json_set_int(s, "start", start);
  json_set_int(s, "end", end);
  json_set_int(s, "minutes", minutes);
  cJSON_AddStringToObject(s, "at", date);
  cJSON_AddItemToArray(sessions, s);
  int n = cJSON_GetArraySize(sessions);
  while (n > 500) { cJSON_DeleteItemFromArray(sessions, 0); n--; }
  char gname[256]; snprintf(gname, sizeof(gname), "%s", J_str(g, "name", ""));
  G_save(root);
  cJSON_Delete(root);
  G_emit("session", id);
  emit_notice(id, gname, "finished", "", minutes);
}

typedef struct {
  char id[64];
  char exe[MAX_PATH];
  int external;
  int64_t start;
  HANDLE proc;
  DWORD pid;
  volatile int cancel;
} WatchCtx;

static DWORD WINAPI watch_proc_thread(LPVOID p) {
  WatchCtx *w = (WatchCtx *)p;
  WaitForSingleObject(w->proc, INFINITE);
  CloseHandle(w->proc);
  run_init();
  EnterCriticalSection(&g_run_cs);
  for (int i = 0; i < MAX_RUN; i++) if (g_runs[i].active && !strcmp(g_runs[i].id, w->id)) { g_runs[i].active = 0; if (g_runs[i].proc) CloseHandle(g_runs[i].proc); g_runs[i].proc = NULL; }
  LeaveCriticalSection(&g_run_cs);
  settle_session(w->id, w->start, now_ms());
  emit_run(w->id, 0, 0);
  free(w);
  return 0;
}

static DWORD WINAPI watch_external_thread(LPVOID p) {
  WatchCtx *w = (WatchCtx *)p;
  /* 最多等 3 分钟进程出现 */
  int found = 0;
  for (int i = 0; i < 90 && !w->cancel; i++) {
    Sleep(2000);
    if (mod_proc_running(w->exe)) { found = 1; break; }
  }
  run_init();
  EnterCriticalSection(&g_run_cs);
  int idx = -1;
  for (int i = 0; i < MAX_RUN; i++) if (g_runs[i].active && !strcmp(g_runs[i].id, w->id)) { idx = i; break; }
  if (idx >= 0) { g_runs[idx].starting = found ? 0 : 0; }
  LeaveCriticalSection(&g_run_cs);
  if (!found) {
    EnterCriticalSection(&g_run_cs);
    if (idx >= 0) g_runs[idx].active = 0;
    LeaveCriticalSection(&g_run_cs);
    emit_run(w->id, 0, 0);
    emit_notice(w->id, w->id, "no-process", "启动后没等到游戏进程", 0);
    free(w);
    return 0;
  }
  emit_run(w->id, 1, 0);
  /* 进程出现 → 等它退出 */
  while (!w->cancel) {
    Sleep(3000);
    if (!mod_proc_running(w->exe)) break;
  }
  EnterCriticalSection(&g_run_cs);
  if (idx >= 0) g_runs[idx].active = 0;
  LeaveCriticalSection(&g_run_cs);
  settle_session(w->id, w->start, now_ms());
  emit_run(w->id, 0, 0);
  free(w);
  return 0;
}

static int slot_alloc(const char *id, HANDLE proc, DWORD pid, int external, const char *exe) {
  run_init();
  EnterCriticalSection(&g_run_cs);
  int idx = -1;
  for (int i = 0; i < MAX_RUN; i++) if (!g_runs[i].active) { idx = i; break; }
  if (idx >= 0) {
    memset(&g_runs[idx], 0, sizeof(RunSlot));
    snprintf(g_runs[idx].id, sizeof(g_runs[idx].id), "%s", id);
    g_runs[idx].proc = proc; g_runs[idx].pid = pid;
    g_runs[idx].external = external;
    g_runs[idx].starting = external ? 1 : 0;
    g_runs[idx].active = 1;
    g_runs[idx].start = now_ms();
    snprintf(g_runs[idx].exe, sizeof(g_runs[idx].exe), "%s", exe ? exe : "");
  }
  LeaveCriticalSection(&g_run_cs);
  return idx;
}

static cJSON *G_launch(const char *id) {
  cJSON *root = G_root();
  cJSON *g = G_find(root, id);
  if (!g) { cJSON_Delete(root); return NULL; }
  const char *target = J_str(g, "launch", J_str(g, "exe", ""));
  if (!*target) { cJSON_Delete(root); return NULL; }
  const char *name = J_str(g, "name", "");
  int pending = 0;
  if (run_state(id, &pending)) {
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", 0);
    cJSON_AddStringToObject(o, "reason", "running");
    cJSON_AddStringToObject(o, "name", name);
    cJSON_Delete(root);
    return o;
  }
  if (pending) {
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", 0);
    cJSON_AddStringToObject(o, "reason", "starting");
    cJSON_AddStringToObject(o, "name", name);
    cJSON_Delete(root);
    return o;
  }
  int64_t start = now_ms();
  if (strstr(target, "://")) {
    /* 外部协议：交给系统 */
    wchar_t *w = u8_to_w(target);
    ShellExecuteW(NULL, L"open", w, NULL, NULL, SW_SHOWNORMAL);
    free(w);
    settle_count(id);
    const char *watch = J_str(g, "watchExe", "");
    char exebuf[MAX_PATH];
    if (!*watch) {
      const char *e = J_str(g, "exe", "");
      snprintf(exebuf, sizeof(exebuf), "%s", path_basename(e));
    } else snprintf(exebuf, sizeof(exebuf), "%s", path_basename(watch));
    slot_alloc(id, NULL, 0, 1, exebuf);
    WatchCtx *w2 = (WatchCtx *)xcalloc(1, sizeof(WatchCtx));
    snprintf(w2->id, sizeof(w2->id), "%s", id);
    snprintf(w2->exe, sizeof(w2->exe), "%s", exebuf);
    w2->external = 1; w2->start = start;
    CreateThread(NULL, 0, watch_external_thread, w2, 0, NULL);
    cJSON *o = cJSON_CreateObject();
    cJSON_AddBoolToObject(o, "ok", 1);
    cJSON_AddStringToObject(o, "target", target);
    cJSON_AddBoolToObject(o, "pending", 1);
    cJSON_Delete(root);
    return o;
  }
  if (!path_exists(target)) {
    cJSON_Delete(root);
    return NULL;
  }
  const char *cwd = J_str(g, "path", "");
  wchar_t *wt = u8_to_w(target);
  wchar_t *wc = u8_to_w(*cwd ? cwd : "");
  STARTUPINFOW si; PROCESS_INFORMATION pi;
  memset(&si, 0, sizeof(si)); si.cb = sizeof(si);
  memset(&pi, 0, sizeof(pi));
  BOOL ok = CreateProcessW(NULL, wt, NULL, NULL, FALSE, 0, NULL, *cwd ? wc : NULL, &si, &pi);
  free(wt); free(wc);
  if (!ok) { cJSON_Delete(root); return NULL; }
  slot_alloc(id, pi.hProcess, pi.dwProcessId, 0, "");
  settle_count(id);
  WatchCtx *w = (WatchCtx *)xcalloc(1, sizeof(WatchCtx));
  snprintf(w->id, sizeof(w->id), "%s", id);
  w->proc = pi.hProcess; w->pid = pi.dwProcessId; w->start = start;
  CreateThread(NULL, 0, watch_proc_thread, w, 0, NULL);
  CloseHandle(pi.hThread);
  cJSON *o = cJSON_CreateObject();
  cJSON_AddBoolToObject(o, "ok", 1);
  cJSON_AddStringToObject(o, "target", target);
  cJSON_Delete(root);
  return o;
}

static cJSON *G_stop(const char *id) {
  run_init();
  EnterCriticalSection(&g_run_cs);
  int idx = -1;
  for (int i = 0; i < MAX_RUN; i++) if (g_runs[i].active && !strcmp(g_runs[i].id, id)) { idx = i; break; }
  int external = idx >= 0 ? g_runs[idx].external : 0;
  HANDLE proc = idx >= 0 ? g_runs[idx].proc : NULL;
  char exe[MAX_PATH] = "";
  if (idx >= 0) snprintf(exe, sizeof(exe), "%s", g_runs[idx].exe);
  LeaveCriticalSection(&g_run_cs);
  cJSON *o = cJSON_CreateObject();
  if (idx < 0) { cJSON_AddBoolToObject(o, "ok", 0); cJSON_AddStringToObject(o, "reason", "未在运行"); return o; }
  if (external) {
    char cmd[512];
    snprintf(cmd, sizeof(cmd), "taskkill /IM \"%s\" /F", exe);
    g_host->run_command(cmd, 0);
    cJSON_AddBoolToObject(o, "ok", 1);
    cJSON_AddBoolToObject(o, "external", 1);
  } else {
    if (proc) TerminateProcess(proc, 0);
    cJSON_AddBoolToObject(o, "ok", 1);
  }
  return o;
}

/* ============================================================
 *  MOD 目录规则 + 列表
 * ============================================================ */
typedef struct { const char *id, *root, *dir, *kw, *note; } ModRule;
static const ModRule MOD_RULES[] = {
  { "bethesda", "game", "Data", "fallout|skyrim|elder scrolls|starfield|辐射|上古卷轴|星空", "Bethesda 系（老滚 / 辐射 / 星空）的 MOD 放 Data" },
  { "witcher3", "game", "mods", "witcher|巫师", "巫师 3 的 mod 文件夹必须以 mod 开头" },
  { "cyberpunk", "game", "archive/pc/mod", "cyberpunk|赛博朋克", "赛博朋克 2077 的 MOD 放 archive/pc/mod" },
  { "eldenring", "game", "Game/mod", "elden ring|dark souls|sekiro|nier|艾尔登法环|黑暗之魂|只狼", "魂系游戏的 MOD 放 Game/mod" },
  { "wukong", "game", "b1/Content/Paks/~mods", "black myth|wukong|黑神话|悟空", "黑神话：悟空的 MOD 放 b1/Content/Paks/~mods" },
  { "palworld", "game", "Pal/Content/Paks/~mods", "palworld|幻兽帕鲁|帕鲁", "幻兽帕鲁的 MOD 放 Pal/Content/Paks/~mods" },
  { "monsterhunter", "game", "nativePC", "monster hunter|怪物猎人", "怪物猎人的 MOD 放 nativePC" },
  { "minecraft", "appdata", ".minecraft/mods", "minecraft|我的世界", "我的世界的 MOD 在 %APPDATA%\\.minecraft\\mods" },
  { "mountblade", "game", "Modules", "mount & blade|bannerlord|骑马与砍杀", "骑马与砍杀 2 的目录叫 Modules" },
  { "nomansky", "game", "GAMEDATA/PCBANKS/MODS", "no man's sky|无人深空", "无人深空的 MOD 放 GAMEDATA/PCBANKS/MODS" },
  { "valheim", "game", "BepInEx/plugins", "valheim|英灵神殿", "英灵神殿的 MOD 是 BepInEx/plugins" },
  { "citiesskylines", "game", "Files/Mods", "cities skylines|城市天际线", "城市天际线的 MOD 放 Files/Mods" },
  { "rimworld", "game", "Mods", "rimworld|环世界", "环世界的 MOD 放游戏目录下的 Mods" },
  { "stardew", "game", "Mods", "stardew|星露谷", "星露谷的 MOD 放游戏目录下的 Mods" },
  { "factorio", "appdata", "Factorio/mods", "factorio|异星工厂", "异星工厂的 MOD 在 %APPDATA%\\Factorio\\mods" },
};
static int name_match_rule(const char *name, const char *kw) {
  if (!name || !kw) return 0;
  char *low = str_lower(name);
  const char *p = kw;
  int hit = 0;
  while (*p) {
    const char *bar = strchr(p, '|');
    size_t n = bar ? (size_t)(bar - p) : strlen(p);
    char pat[128];
    if (n >= sizeof(pat)) n = sizeof(pat) - 1;
    memcpy(pat, p, n); pat[n] = 0;
    if (*pat && strstr(low, pat)) { hit = 1; break; }
    if (!bar) break;
    p = bar + 1;
  }
  free(low);
  return hit;
}
static const char *user_root(const char *kind, char *out, size_t n) {
  if (!strcmp(kind, "appdata")) snprintf(out, n, "%s", getenv("APPDATA") ? getenv("APPDATA") : "");
  else if (!strcmp(kind, "localappdata")) snprintf(out, n, "%s", getenv("LOCALAPPDATA") ? getenv("LOCALAPPDATA") : "");
  else if (!strcmp(kind, "docs")) { char *d = special_folder(CSIDL_PERSONAL); snprintf(out, n, "%s", d); free(d); }
  else if (!strcmp(kind, "userdata")) { char *d = special_folder(CSIDL_PROFILE); snprintf(out, n, "%s", d); free(d); }
  else out[0] = 0;
  return out;
}
static cJSON *mod_dir_info(cJSON *g) {
  cJSON *out = cJSON_CreateObject();
  const char *gd = J_str(g, "path", "");
  char gdir[MAX_PATH] = "";
  if (*gd) snprintf(gdir, sizeof(gdir), "%s", gd);
  else {
    const char *exe = J_str(g, "exe", "");
    if (*exe) { char *d = path_dirname(exe); snprintf(gdir, sizeof(gdir), "%s", d); free(d); }
  }
  const char *manual = J_str(g, "modDir", "");
  if (*manual && path_exists(manual)) {
    cJSON_AddStringToObject(out, "dir", manual);
    cJSON_AddStringToObject(out, "source", "manual");
    cJSON_AddStringToObject(out, "note", "手动指定");
    return out;
  }
  const char *subs[] = { "Mods", "mods", "Mod", "mod", "MOD", "modules", "Modules", "plugins", "addons", "nativePC", "~mods", "BepInEx\\plugins", NULL };
  for (int i = 0; subs[i]; i++) {
    if (!*gdir) break;
    char *d = path_join(gdir, subs[i]);
    if (path_exists(d)) {
      cJSON_AddStringToObject(out, "dir", d);
      cJSON_AddStringToObject(out, "source", "probe");
      char note[128]; snprintf(note, sizeof(note), "在游戏目录里找到 %s", subs[i]);
      cJSON_AddStringToObject(out, "note", note);
      free(d);
      return out;
    }
    free(d);
  }
  const char *name = J_str(g, "name", "");
  for (size_t i = 0; i < sizeof(MOD_RULES) / sizeof(MOD_RULES[0]); i++) {
    if (!name_match_rule(name, MOD_RULES[i].kw)) continue;
    char base[MAX_PATH] = "";
    if (!strcmp(MOD_RULES[i].root, "game")) snprintf(base, sizeof(base), "%s", gdir);
    else user_root(MOD_RULES[i].root, base, sizeof(base));
    if (!*base) continue;
    char *d = path_join(base, MOD_RULES[i].dir);
    if (path_exists(d)) {
      cJSON_AddStringToObject(out, "dir", d);
      cJSON_AddStringToObject(out, "source", "rule");
      cJSON_AddStringToObject(out, "ruleId", MOD_RULES[i].id);
      cJSON_AddStringToObject(out, "note", MOD_RULES[i].note);
      free(d);
      return out;
    }
    cJSON_AddStringToObject(out, "suggest", d);
    cJSON_AddStringToObject(out, "source", "unknown");
    cJSON_AddStringToObject(out, "ruleId", MOD_RULES[i].id);
    cJSON_AddStringToObject(out, "note", MOD_RULES[i].note);
    free(d);
    return out;
  }
  cJSON_AddStringToObject(out, "dir", "");
  cJSON_AddStringToObject(out, "source", "unknown");
  cJSON_AddStringToObject(out, "note", "");
  return out;
}
static int64_t dir_size(const char *path, int depth) {
  if (depth > 12) return 0;
  int64_t total = 0;
  char *pat = path_join(path, "*");
  wchar_t *wp = u8_to_w(pat);
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileW(wp, &fd);
  free(wp); free(pat);
  if (h == INVALID_HANDLE_VALUE) return file_size(path);
  do {
    if (!wcscmp(fd.cFileName, L".") || !wcscmp(fd.cFileName, L"..")) continue;
    char *child = path_join(path, w_to_u8(fd.cFileName));
    if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) total += dir_size(child, depth + 1);
    else total += ((int64_t)fd.nFileSizeHigh << 32) | fd.nFileSizeLow;
    free(child);
  } while (FindNextFileW(h, &fd));
  FindClose(h);
  return total;
}
static cJSON *workshop_dirs(const char *appid) {
  cJSON *dirs = cJSON_CreateArray();
  if (!appid || !*appid) return dirs;
  /* 从注册表/常见路径找 Steam 库，再拼 steamapps/workshop/content/<appid> */
  char roots[8][MAX_PATH]; int nr = 0;
  char *reg = NULL;
  HKEY k;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\Valve\\Steam", 0, KEY_READ, &k) == ERROR_SUCCESS) {
    wchar_t val[MAX_PATH]; DWORD sz = sizeof(val), type = 0;
    if (RegQueryValueExW(k, L"SteamPath", NULL, &type, (LPBYTE)val, &sz) == ERROR_SUCCESS) {
      reg = w_to_u8(val);
      if (reg && *reg) snprintf(roots[nr++], MAX_PATH, "%s", reg);
      free(reg);
    }
    RegCloseKey(k);
  }
  const char *guess[] = { "C:\\Program Files (x86)\\Steam", "C:\\Program Files\\Steam", "D:\\Steam", "E:\\Steam", NULL };
  for (int i = 0; guess[i] && nr < 8; i++) if (path_exists(guess[i])) snprintf(roots[nr++], MAX_PATH, "%s", guess[i]);
  for (int i = 0; i < nr; i++) {
    char *d = path_join(roots[i], "steamapps\\workshop\\content");
    char *d2 = path_join(d, appid);
    if (path_exists(d2)) cJSON_AddItemToArray(dirs, cJSON_CreateString(d2));
    free(d); free(d2);
  }
  return dirs;
}
static cJSON *mods_list(const char *game_id, int force) {
  (void)force;
  cJSON *root = G_root();
  cJSON *g = G_find(root, game_id);
  if (!g) { cJSON_Delete(root); return NULL; }
  cJSON *info = mod_dir_info(g);
  const char *dir = J_str(info, "dir", "");
  cJSON *local = cJSON_CreateArray();
  if (*dir && path_is_dir(dir)) {
    char *pat = path_join(dir, "*");
    wchar_t *wp = u8_to_w(pat);
    WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW(wp, &fd);
    free(wp); free(pat);
    if (h != INVALID_HANDLE_VALUE) {
      do {
        if (!wcscmp(fd.cFileName, L".") || !wcscmp(fd.cFileName, L"..")) continue;
        char *name = w_to_u8(fd.cFileName);
        if (name[0] == '.') { free(name); continue; }
        int disabled = str_ends_ci(name, ".disabled");
        char disp[512]; snprintf(disp, sizeof(disp), "%s", name);
        if (disabled) disp[strlen(disp) - 9] = 0;
        char *full = path_join(dir, name);
        cJSON *o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "name", disp);
        cJSON_AddStringToObject(o, "path", full);
        json_set_bool(o, "isDir", (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? 1 : 0);
        json_set_bool(o, "toggleable", 1);
        json_set_bool(o, "enabled", disabled ? 0 : 1);
        cJSON_AddStringToObject(o, "origin", "local");
        int64_t sz = (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? dir_size(full, 0) : (((int64_t)fd.nFileSizeHigh << 32) | fd.nFileSizeLow);
        json_set_int(o, "size", sz);
        json_set_int(o, "mtime", file_mtime_ms(full));
        cJSON_AddItemToArray(local, o);
        free(full); free(name);
      } while (FindNextFileW(h, &fd));
      FindClose(h);
    }
  }
  /* 创意工坊 */
  const char *appid = J_str(g, "appid", "");
  cJSON *wdirs = workshop_dirs(appid);
  cJSON *witems = cJSON_CreateArray();
  int dn = cJSON_GetArraySize(wdirs);
  for (int i = 0; i < dn; i++) {
    cJSON *d = cJSON_GetArrayItem(wdirs, i);
    char *pat = path_join(d->valuestring, "*");
    wchar_t *wp = u8_to_w(pat);
    WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW(wp, &fd);
    free(wp); free(pat);
    if (h == INVALID_HANDLE_VALUE) continue;
    do {
      if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
      char *name = w_to_u8(fd.cFileName);
      int is_num = 1;
      for (char *p = name; *p; p++) if (!(*p >= '0' && *p <= '9') && *p != '.') { is_num = 0; break; }
      if (!is_num) { free(name); continue; }
      int disabled = str_ends_ci(name, ".disabled");
      char fid[128]; snprintf(fid, sizeof(fid), "%s", name);
      if (disabled) fid[strlen(fid) - 9] = 0;
      char *full = path_join(d->valuestring, name);
      cJSON *o = cJSON_CreateObject();
      char nm[160]; snprintf(nm, sizeof(nm), "创意工坊 %s", fid);
      cJSON_AddStringToObject(o, "name", nm);
      cJSON_AddStringToObject(o, "id", fid);
      cJSON_AddStringToObject(o, "path", full);
      json_set_bool(o, "isDir", 1);
      json_set_bool(o, "toggleable", 1);
      json_set_bool(o, "enabled", disabled ? 0 : 1);
      cJSON_AddStringToObject(o, "origin", "workshop");
      json_set_int(o, "size", dir_size(full, 0));
      json_set_int(o, "mtime", file_mtime_ms(full));
      char url[128]; snprintf(url, sizeof(url), "steam://url/CommunityFilePage/%s", fid);
      cJSON_AddStringToObject(o, "url", url);
      cJSON_AddItemToArray(witems, o);
      free(full); free(name);
    } while (FindNextFileW(h, &fd));
    FindClose(h);
  }

  cJSON *mods = cJSON_CreateArray();
  cJSON *it = NULL;
  cJSON_ArrayForEach(it, local) cJSON_AddItemToArray(mods, cJSON_Duplicate(it, 1));
  cJSON_ArrayForEach(it, witems) cJSON_AddItemToArray(mods, cJSON_Duplicate(it, 1));
  int enabled = 0;
  cJSON_ArrayForEach(it, mods) if (J_int(it, "enabled", 1)) enabled++;

  cJSON *out = cJSON_CreateObject();
  cJSON_AddStringToObject(out, "dir", dir);
  json_set_bool(out, "hasDir", *dir ? 1 : 0);
  cJSON_AddStringToObject(out, "source", J_str(info, "source", ""));
  cJSON_AddStringToObject(out, "note", J_str(info, "note", ""));
  cJSON_AddStringToObject(out, "suggest", J_str(info, "suggest", ""));
  cJSON_AddStringToObject(out, "ruleId", J_str(info, "ruleId", ""));
  cJSON_AddItemToObject(out, "mods", mods);
  cJSON_AddItemToObject(out, "local", local);
  cJSON *ws = cJSON_CreateObject();
  cJSON_AddStringToObject(ws, "appid", appid);
  cJSON_AddItemToObject(ws, "dirs", wdirs);
  cJSON_AddItemToObject(ws, "items", witems);
  json_set_bool(ws, "hasDir", cJSON_GetArraySize(wdirs) > 0);
  cJSON_AddItemToObject(out, "workshop", ws);
  cJSON *counts = cJSON_CreateObject();
  json_set_int(counts, "total", cJSON_GetArraySize(mods));
  json_set_int(counts, "enabled", enabled);
  json_set_int(counts, "workshop", cJSON_GetArraySize(witems));
  json_set_int(counts, "local", cJSON_GetArraySize(local));
  cJSON_AddItemToObject(out, "counts", counts);
  json_set_bool(out, "cached", 0);
  json_set_int(out, "cachedAt", now_ms());
  json_set_bool(out, "wsMetaFailed", 0);
  cJSON_Delete(info);
  cJSON_Delete(root);
  return out;
}

/* ============================================================
 *  扫描（Steam / 注册表 / Epic / 文件夹）
 * ============================================================ */
static const char *STEAM_CDN = "https://cdn.cloudflare.steamstatic.com/steam/apps/";
static char *steam_root_find(void) {
  HKEY k;
  char out[MAX_PATH] = "";
  if (RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\Valve\\Steam", 0, KEY_READ, &k) == ERROR_SUCCESS) {
    wchar_t val[MAX_PATH]; DWORD sz = sizeof(val), type = 0;
    if (RegQueryValueExW(k, L"SteamPath", NULL, &type, (LPBYTE)val, &sz) == ERROR_SUCCESS) {
      char *s = w_to_u8(val);
      snprintf(out, sizeof(out), "%s", s);
      free(s);
    }
    RegCloseKey(k);
  }
  if (!*out) {
    const char *guess[] = { "C:\\Program Files (x86)\\Steam", "C:\\Program Files\\Steam", "D:\\Steam", "E:\\Steam", "F:\\Steam", NULL };
    for (int i = 0; guess[i]; i++) if (path_exists(guess[i])) { snprintf(out, sizeof(out), "%s", guess[i]); break; }
  }
  for (char *p = out; *p; p++) if (*p == '/') *p = '\\';
  return *out ? xstrdup(out) : NULL;
}
static void steam_add_library(cJSON *libs, const char *path) {
  if (!path || !*path) return;
  char *low = str_lower(path);
  cJSON *it = NULL;
  cJSON_ArrayForEach(it, libs) if (cJSON_IsString(it) && !strcmp(str_lower(it->valuestring), low)) { free(low); return; }
  free(low);
  cJSON_AddItemToArray(libs, cJSON_CreateString(path));
}
static cJSON *steam_libraries(void) {
  cJSON *libs = cJSON_CreateArray();
  char *root = steam_root_find();
  if (!root) return libs;
  steam_add_library(libs, root);
  char *vdf = path_join(root, "steamapps\\libraryfolders.vdf");
  char *txt = file_read_text(vdf);
  if (txt) {
    const char *p = txt;
    while ((p = strstr(p, "\"path\"")) != NULL) {
      p += 6;
      while (*p == ' ' || *p == '\t' || *p == '"') p++;
      const char *e = p;
      while (*e && *e != '"') e++;
      char *path = xstrndup(p, (size_t)(e - p));
      steam_add_library(libs, path);
      free(path);
      p = e;
    }
    free(txt);
  }
  free(vdf);
  free(root);
  return libs;
}
static char *steam_cover_local(const char *root, const char *appid) {
  char *base = path_join(root, "appcache\\librarycache");
  char *appdir = path_join(base, appid);
  free(base);
  if (!path_exists(appdir)) { free(appdir); return NULL; }
  const char *names[] = { "library_600x900.jpg", "library_600x900_2x.jpg", "library_capsule.jpg", "header.jpg", NULL };
  char *found = NULL;
  for (int i = 0; names[i] && !found; i++) {
    char *pat = path_join(appdir, "**");
    (void)pat;
    /* 在 appdir 的下一层目录里找 */
    char *p2 = path_join(appdir, "*");
    wchar_t *wp = u8_to_w(p2);
    WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW(wp, &fd);
    free(wp); free(p2);
    if (h != INVALID_HANDLE_VALUE) {
      do {
        if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
        char *sub = w_to_u8(fd.cFileName);
        char *f = path_join(appdir, sub);
        char *f2 = path_join(f, names[i]);
        if (path_exists(f2)) found = xstrdup(f2);
        free(f); free(f2); free(sub);
        if (found) break;
      } while (FindNextFileW(h, &fd));
      FindClose(h);
    }
    if (!found) {
      char *f2 = path_join(appdir, names[i]);
      if (path_exists(f2)) found = xstrdup(f2);
      free(f2);
    }
  }
  free(appdir);
  return found;
}
/* Steam 登录账号：config\loginusers.vdf（文本 VDF） */
static char *vdf_field(const char *block, const char *key) {
  char pat[128];
  snprintf(pat, sizeof(pat), "\"%s\"", key);
  const char *p = strstr(block, pat);
  if (!p) return NULL;
  p += strlen(pat);
  while (*p == ' ' || *p == '\t') p++;
  if (*p != '"') return NULL;
  p++;
  const char *e = strchr(p, '"');
  if (!e) return NULL;
  return xstrndup(p, (size_t)(e - p));
}
static cJSON *steam_accounts(void) {
  cJSON *arr = cJSON_CreateArray();
  char *root = steam_root_find();
  if (!root) return arr;
  char *file = path_join(root, "config\\loginusers.vdf");
  char *txt = file_read_text(file);
  free(file); free(root);
  if (!txt) return arr;
  const char *p = txt;
  while ((p = strchr(p, '"')) != NULL) {
    const char *q = p + 1;
    const char *r = q;
    int digits = 1;
    while (*r && *r != '"') {
      if (*r < '0' || *r > '9') digits = 0;
      r++;
    }
    size_t len = (size_t)(r - q);
    if (digits && len >= 17 && *r == '"') {
      char sid[32];
      snprintf(sid, sizeof(sid), "%.*s", (int)len, q);
      const char *block = r + 1;
      char *an = vdf_field(block, "AccountName");
      char *pn = vdf_field(block, "PersonaName");
      char *rp = vdf_field(block, "RememberPassword");
      char *mr = vdf_field(block, "MostRecent");
      if (an || pn) {
        cJSON *o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "steamId64", sid);
        unsigned long long v = strtoull(sid, NULL, 10);
        char aid[32];
        snprintf(aid, sizeof(aid), "%llu", v & 0xFFFFFFFFULL);
        cJSON_AddStringToObject(o, "accountId", aid);
        cJSON_AddStringToObject(o, "accountName", an ? an : "");
        cJSON_AddStringToObject(o, "personaName", pn ? pn : (an ? an : sid));
        json_set_bool(o, "autoLogin", rp && !strcmp(rp, "1"));
        json_set_bool(o, "mostRecent", mr && !strcmp(mr, "1"));
        json_set_int(o, "lastLogin", 0);
        cJSON_AddItemToArray(arr, o);
      }
      free(an); free(pn); free(rp); free(mr);
      p = block;
    } else p = r + (*r ? 1 : 0);
  }
  free(txt);
  return arr;
}

static cJSON *scan_steam(cJSON **out_roots) {
  cJSON *libs = steam_libraries();
  cJSON *games = cJSON_CreateArray();
  cJSON *roots = cJSON_Duplicate(libs, 1);
  int n = cJSON_GetArraySize(libs);
  for (int i = 0; i < n; i++) {
    const char *lib = cJSON_GetArrayItem(libs, i)->valuestring;
    char *apps = path_join(lib, "steamapps");
    char *pat = path_join(apps, "appmanifest_*.acf");
    wchar_t *wp = u8_to_w(pat);
    WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW(wp, &fd);
    free(wp); free(pat);
    if (h != INVALID_HANDLE_VALUE) {
      do {
        char *fname = w_to_u8(fd.cFileName);
        char *file = path_join(apps, fname);
        char *txt = file_read_text(file);
        if (txt) {
          char appid[32] = "", name[512] = "", instdir[512] = "";
          const char *p;
          if ((p = strstr(txt, "\"appid\""))) sscanf(p + 8, " \"%31[^\"]\"", appid);
          if ((p = strstr(txt, "\"name\""))) sscanf(p + 6, " \"%511[^\"]\"", name);
          if ((p = strstr(txt, "\"installdir\""))) sscanf(p + 13, " \"%511[^\"]\"", instdir);
          if (*appid && *instdir) {
            /* Steamworks 运行库 / SteamVR / Linux Runtime 不是游戏 */
            if (steam_appid_skip(appid) || is_launcher_or_runtime(name, instdir, NULL)) { free(txt); free(file); free(fname); continue; }
            char *common = path_join(apps, "common");
            char *path = path_join(common, instdir);
            free(common);
            if (path_exists(path)) {
              cJSON *o = cJSON_CreateObject();
              cJSON_AddStringToObject(o, "name", *name ? name : instdir);
              cJSON_AddStringToObject(o, "path", path);
              cJSON_AddStringToObject(o, "platform", "steam");
              cJSON_AddStringToObject(o, "appid", appid);
              cJSON_AddStringToObject(o, "source", "steam");
              char launch[128]; snprintf(launch, sizeof(launch), "steam://rungameid/%s", appid);
              cJSON_AddStringToObject(o, "launch", launch);
              char cover[512]; snprintf(cover, sizeof(cover), "%s%s/library_600x900.jpg", STEAM_CDN, appid);
              cJSON_AddStringToObject(o, "cover", cover);
              char *cl = steam_cover_local(lib, appid);
              if (cl) {
                char *u = (char *)xmalloc(strlen(cl) + 12);
                sprintf(u, "file:///%s", cl);
                for (char *q = u + 8; *q; q++) if (*q == '\\') *q = '/';
                cJSON_AddStringToObject(o, "coverLocal", u);
                free(u);
                cJSON_AddStringToObject(o, "coverKind", "local");
                free(cl);
              } else cJSON_AddStringToObject(o, "coverKind", "steam");
              cJSON_AddStringToObject(o, "installDate", "");
              /* 找主程序用于守护计时 */
              char *exe = NULL;
              char *p3 = path_join(path, "*");
              wchar_t *wp3 = u8_to_w(p3);
              WIN32_FIND_DATAW fd3; HANDLE h3 = FindFirstFileW(wp3, &fd3);
              free(wp3); free(p3);
              if (h3 != INVALID_HANDLE_VALUE) {
                do {
                  if (fd3.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
                  if (!str_ends_ci(w_to_u8(fd3.cFileName), ".exe")) continue;
                  char *en = w_to_u8(fd3.cFileName);
                  if (strstr(en, "unins") || strstr(en, "crash") || strstr(en, "setup")) { free(en); continue; }
                  if (!exe) exe = path_join(path, en);
                  free(en);
                } while (FindNextFileW(h3, &fd3));
                FindClose(h3);
              }
              if (exe) {
                cJSON_AddStringToObject(o, "exe", exe);
                cJSON_AddStringToObject(o, "watchExe", path_basename(exe));
                free(exe);
              }
              cJSON_AddItemToArray(games, o);
            }
            free(path);
          }
          free(txt);
        }
        free(file); free(fname);
      } while (FindNextFileW(h, &fd));
      FindClose(h);
    }
    free(apps);
  }
  cJSON_Delete(libs);
  if (out_roots) *out_roots = roots; else cJSON_Delete(roots);
  return games;
}

/* ---------------- 封面：Steam AppID / CDN 缓存 / 本地 librarycache ---------------- */
static char *steam_appid_from_text(const char *s) {
  if (!s || !*s) return NULL;
  char *low = str_lower(s);
  const char *marks[] = { "steam://uninstall/", "steam://rungameid/", NULL };
  for (int i = 0; marks[i]; i++) {
    const char *p = strstr(low, marks[i]);
    if (!p) continue;
    p += strlen(marks[i]);
    int n = 0;
    while (p[n] >= '0' && p[n] <= '9') n++;
    if (n > 0) {
      char *out = xstrndup(p, (size_t)n);
      free(low);
      return out;
    }
  }
  free(low);
  return NULL;
}
static char *steam_appid_from_game(cJSON *g) {
  const char *a = J_str(g, "appid", "");
  if (*a && strlen(a) <= 12) {
    int digits = 1;
    for (const char *p = a; *p; p++) if (*p < '0' || *p > '9') digits = 0;
    if (digits) return xstrdup(a);
  }
  char *id = steam_appid_from_text(J_str(g, "uninstallString", ""));
  if (id) return id;
  id = steam_appid_from_text(J_str(g, "launch", ""));
  if (id) return id;
  /* 从 steamapps\common\<installdir> 反查 appmanifest */
  const char *path = J_str(g, "path", "");
  char *low = str_lower(path);
  const char *common = strstr(low, "\\steamapps\\common\\");
  if (common) {
    const char *dir = path + (common - low) + strlen("\\steamapps\\common\\");
    char installdir[MAX_PATH]; snprintf(installdir, sizeof(installdir), "%s", dir);
    char *slash = strchr(installdir, '\\'); if (slash) *slash = 0;
    char *root = steam_root_find();
    if (root) {
      char *pat = path_join(root, "steamapps\\appmanifest_*.acf");
      wchar_t *wp = u8_to_w(pat);
      WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW(wp, &fd);
      free(wp); free(pat);
      if (h != INVALID_HANDLE_VALUE) {
        do {
          char *fn = w_to_u8(fd.cFileName);
          unsigned appid = 0;
          if (sscanf(fn, "appmanifest_%u.acf", &appid) == 1) {
            char *file = path_join(root, "steamapps");
            char *full = path_join(file, fn);
            char *txt = file_read_text(full);
            if (txt) {
              char *inst = vdf_field(txt, "installdir");
              if (inst && !_stricmp(inst, installdir)) {
                free(inst); free(txt); free(full); free(file); free(fn);
                FindClose(h); free(root);
                char b[32]; snprintf(b, sizeof(b), "%u", appid);
                free(low);
                return xstrdup(b);
              }
              free(inst); free(txt);
            }
            free(full); free(file);
          }
          free(fn);
        } while (FindNextFileW(h, &fd));
        FindClose(h);
      }
      free(root);
    }
  }
  free(low);
  return NULL;
}
static char *file_url_of(const char *path) {
  size_t n = strlen(path);
  char *u = (char *)xmalloc(n + 12);
  sprintf(u, "file:///%s", path);
  for (char *p = u + 8; *p; p++) if (*p == '\\') *p = '/';
  return u;
}
static int download_image(const char *url, const char *dest) {
  int status = 0;
  size_t len = 0;
  char *body = g_host->http_request("GET", url,
      "Accept: image/jpeg,image/png,image/*;q=0.8\r\nUser-Agent: ShiGuangJi/1.0\r\n",
      NULL, 0, 12000, &status, &len);
  if (!body) return 0;
  int ok = status == 200 && len > 800 &&
           ((unsigned char)body[0] == 0xFF || (unsigned char)body[0] == 0x89);
  if (ok) {
    wchar_t *w = u8_to_w(dest);
    HANDLE h = CreateFileW(w, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    free(w);
    if (h != INVALID_HANDLE_VALUE) {
      DWORD wrote = 0;
      ok = WriteFile(h, body, (DWORD)len, &wrote, NULL) && wrote == len;
      CloseHandle(h);
      if (!ok) DeleteFileW(u8_to_w(dest));
    } else ok = 0;
  }
  g_host->dealloc(body);
  return ok;
}
static char *steam_store_search_appid(const char *name) {
  if (!name || !*name) return NULL;
  char *q = url_encode(name);
  if (!q) return NULL;
  size_t cap = strlen(q) + 256;
  char *url = (char *)xmalloc(cap);
  snprintf(url, cap, "https://store.steampowered.com/api/storesearch/?term=%s&l=schinese&cc=CN", q);
  int status = 0;
  char *body = g_host->http_request("GET", url,
      "Accept: application/json\r\nUser-Agent: ShiGuangJi/1.0\r\n", NULL, 0, 9000, &status, NULL);
  free(url); free(q);
  if (!body) return NULL;
  char *out = NULL;
  if (status == 200) {
    cJSON *j = cJSON_Parse(body);
    cJSON *items = j ? cJSON_GetObjectItemCaseSensitive(j, "items") : NULL;
    cJSON *it = NULL;
    if (cJSON_IsArray(items)) {
      cJSON_ArrayForEach(it, items) {
        int id = (int)json_num(it, "id", 0);
        const char *nm = json_str(it, "name", "");
        if (id > 0 && *nm) {
          char b[32]; snprintf(b, sizeof(b), "%d", id);
          out = xstrdup(b);
          break;
        }
      }
    }
    cJSON_Delete(j);
  }
  g_host->dealloc(body);
  return out;
}
static cJSON *cover_apply(const char *id, const char *appid, const char *cover,
                          const char *local_path, const char *kind) {
  cJSON *patch = cJSON_CreateObject();
  if (appid && *appid) J_set_str(patch, "appid", appid);
  J_set_str(patch, "cover", cover ? cover : "");
  J_set_str(patch, "coverKind", kind ? kind : "none");
  char *u = (local_path && *local_path) ? file_url_of(local_path) : xstrdup("");
  J_set_str(patch, "coverLocal", u);
  free(u);
  cJSON *o = G_update(id, patch);
  cJSON_Delete(patch);
  return o;
}
static cJSON *cover_apply_steam(const char *id, const char *appid) {
  char *covers = path_join(mod_data_dir(), "covers");
  path_mkdirs(covers);
  char fn[64]; snprintf(fn, sizeof(fn), "steam_%s.jpg", appid);
  char *cached = path_join(covers, fn);
  char *local = NULL;
  char *remote = NULL;
  size_t n = strlen(appid) + 128;
  remote = (char *)xmalloc(n);
  snprintf(remote, n, "https://cdn.cloudflare.steamstatic.com/steam/apps/%s/library_600x900.jpg", appid);
  if (path_exists(cached)) local = xstrdup(cached);
  if (!local) {
    char *root = steam_root_find();
    if (root) {
      char *cl = steam_cover_local(root, appid);
      if (cl) { local = xstrdup(cl); free(cl); }
      free(root);
    }
  }
  if (!local && download_image(remote, cached)) local = xstrdup(cached);
  if (!local) {
    /* 600x900 没有就退回 header（至少不是空白） */
    char *hdr = (char *)xmalloc(n);
    snprintf(hdr, n, "https://cdn.cloudflare.steamstatic.com/steam/apps/%s/header.jpg", appid);
    if (download_image(hdr, cached)) local = xstrdup(cached);
    else { free(remote); remote = hdr; hdr = NULL; }
    free(hdr);
  }
  cJSON *o = cover_apply(id, appid, remote, local, "steam");
  free(local); free(remote); free(cached); free(covers);
  return o;
}
static cJSON *resolve_cover_game(const char *id, const char *mode, int allow_net, char **out_err) {
  cJSON *root = G_root();
  cJSON *g = G_find(root, id);
  if (!g) { cJSON_Delete(root); *out_err = mod_ret_error("游戏不存在"); return NULL; }
  const char *kind = J_str(g, "coverKind", "");
  if (!strcmp(kind, "custom") && strcmp(mode, "default")) {
    cJSON *o = G_decorate(g);
    cJSON_Delete(root);
    return o;
  }
  char *appid = steam_appid_from_game(g);
  if (!appid && allow_net && !strcmp(J_str(g, "platform", ""), "steam"))
    appid = steam_store_search_appid(J_str(g, "name", ""));
  if (appid) {
    cJSON *o = cover_apply_steam(id, appid);
    free(appid);
    cJSON_Delete(root);
    if (!o) *out_err = mod_ret_error("保存封面失败");
    return o;
  }
  const char *exe = J_str(g, "exe", "");
  const char *path = J_str(g, "path", "");
  cJSON_Delete(root);
  if (*exe || *path)
    *out_err = mod_ret_error("这款游戏没有 Steam AppID，也没找到可用的本地封面；可以先在编辑信息里填 AppID，或换一张本地图片");
  else
    *out_err = mod_ret_error("没能提取到封面 —— 没有 Steam AppID，也没有启动程序（.exe）");
  return NULL;
}

/* ---------------- Steam 完整库（社区 XML 缓存） ----------------
   本机 appmanifest 只有“已安装”，Steam 客户端里的 340 款是账号库。
   这里读公开资料页的 games?xml=1，缓存 12 小时；私密资料/断网时退回本机记录。 */
static char *xml_text(const char *s, const char *e, const char *tag) {
  char open[32], close[32];
  snprintf(open, sizeof(open), "<%s>", tag);
  snprintf(close, sizeof(close), "</%s>", tag);
  const char *p = strstr(s, open);
  if (!p || p >= e) return NULL;
  p += strlen(open);
  const char *q = strstr(p, close);
  if (!q || q > e) return NULL;
  if (!strncmp(p, "<![CDATA[", 9)) {
    p += 9;
    const char *ce = strstr(p, "]]>");
    if (!ce || ce > q) return NULL;
    q = ce;
  }
  char *out = xstrndup(p, (size_t)(q - p));
  /* 常见 XML 实体 */
  char *w = out;
  for (char *r = out; *r; ) {
    if (!strncmp(r, "&amp;", 5)) { *w++ = '&'; r += 5; }
    else if (!strncmp(r, "&lt;", 4)) { *w++ = '<'; r += 4; }
    else if (!strncmp(r, "&gt;", 4)) { *w++ = '>'; r += 4; }
    else if (!strncmp(r, "&quot;", 6)) { *w++ = '"'; r += 6; }
    else if (!strncmp(r, "&apos;", 6)) { *w++ = '\''; r += 6; }
    else *w++ = *r++;
  }
  *w = 0;
  return out;
}
static int steam_library_cache(cJSON **out, int64_t *age_ms, char **account) {
  *out = NULL; if (age_ms) *age_ms = 0; if (account) *account = NULL;
  cJSON *root = G_root();
  cJSON *sl = obj_get(root, "steamLibrary");
  cJSON *games = sl ? cJSON_GetObjectItemCaseSensitive(sl, "games") : NULL;
  if (cJSON_IsArray(games)) {
    *out = cJSON_Duplicate(games, 1);
    if (age_ms) *age_ms = now_ms() - (int64_t)J_num(sl, "at", 0);
    if (account) *account = xstrdup(J_str(sl, "account", ""));
  }
  cJSON_Delete(root);
  return *out ? 1 : 0;
}
static cJSON *steam_sync_library(int force, int timeout_ms) {
  cJSON *cached = NULL;
  int64_t age = 0;
  if (!force && steam_library_cache(&cached, &age, NULL) && age < 12LL * 3600 * 1000) return cached;
  cJSON_Delete(cached);
  cJSON *acc = steam_accounts();
  char sid_buf[64] = "";
  cJSON *a0 = cJSON_GetArrayItem(acc, 0);
  if (a0) snprintf(sid_buf, sizeof(sid_buf), "%s", J_str(a0, "steamId64", ""));
  if (!*sid_buf) { cJSON_Delete(acc); return NULL; }
  const char *sid = sid_buf;
  char url[512];
  snprintf(url, sizeof(url), "https://steamcommunity.com/profiles/%s/games?tab=all&xml=1&l=schinese", sid);
  int status = 0;
  char *body = g_host->http_request("GET", url,
      "Accept: application/xml,text/xml\r\nUser-Agent: ShiGuangJi/1.0\r\n", NULL, 0,
      timeout_ms > 0 ? timeout_ms : 9000, &status, NULL);
  if (!body) { cJSON_Delete(acc); return NULL; }
  cJSON *arr = cJSON_CreateArray();
  if (status == 200) {
    const char *p = body;
    while ((p = strstr(p, "<game>")) != NULL) {
      const char *end = strstr(p, "</game>");
      if (!end) break;
      char *appid = xml_text(p, end, "appID");
      char *name = xml_text(p, end, "name");
      char *hours = xml_text(p, end, "hoursOnRecord");
      char *logo = xml_text(p, end, "logo");
      if (appid && *appid && name && *name) {
        cJSON *o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "appid", appid);
        cJSON_AddStringToObject(o, "name", name);
        double h = hours ? atof(hours) : 0;
        cJSON_AddNumberToObject(o, "minutes", h * 60);
        cJSON_AddStringToObject(o, "logo", logo ? logo : "");
        cJSON_AddItemToArray(arr, o);
      }
      free(appid); free(name); free(hours); free(logo);
      p = end + 7;
    }
  }
  g_host->dealloc(body);
  cJSON_Delete(acc);
  if (!cJSON_GetArraySize(arr)) { cJSON_Delete(arr); return NULL; }
  cJSON *root = G_root();
  cJSON *sl = cJSON_CreateObject();
  cJSON_AddNumberToObject(sl, "at", (double)now_ms());
  cJSON_AddStringToObject(sl, "account", sid);
  cJSON_AddItemToObject(sl, "games", cJSON_Duplicate(arr, 1));
  J_set(root, "steamLibrary", sl);
  G_save(root);
  cJSON_Delete(root);
  return arr;
}

/* ---------------- 卸载：平台优先 → 自带卸载器 → 删目录 ---------------- */
static int safe_game_dir(const char *path) {
  if (!path || !*path || !path_is_dir(path)) return 0;
  char *low = str_lower(path);
  size_t n = strlen(low);
  while (n && (low[n - 1] == '\\' || low[n - 1] == '/')) low[--n] = 0;
  int ok = 1;
  if (n < 8 || (n == 2 && low[1] == ':')) ok = 0;
  const char *bad[] = { "\\windows", "\\program files", "\\program files (x86)", "\\users", NULL };
  for (int i = 0; ok && bad[i]; i++) {
    size_t bl = strlen(bad[i]);
    if (!strncmp(low, bad[i], bl) && (low[bl] == 0 || low[bl] == '\\')) {
      if (low[bl] == 0) ok = 0;
    }
  }
  const char *base = path_basename(path);
  if (ok && (!_stricmp(base, "common") || !_stricmp(base, "steamapps") || !_stricmp(base, "steam"))) ok = 0;
  const char *common = strstr(low, "\\steamapps\\common\\");
  if (ok && common) {
    const char *tail = common + strlen("\\steamapps\\common\\");
    if (!*tail) ok = 0;
  }
  free(low);
  return ok;
}
static int run_cmd_line(const char *cmd) {
  if (!cmd || !*cmd) return 0;
  char *low = str_lower(cmd);
  int is_url = strstr(low, "://") != NULL;
  free(low);
  if (is_url) {
    wchar_t *w = u8_to_w(cmd);
    HINSTANCE r = ShellExecuteW(NULL, L"open", w, NULL, NULL, SW_SHOWNORMAL);
    free(w);
    return (INT_PTR)r > 32;
  }
  const char *p = cmd;
  while (*p == ' ' || *p == '\t') p++;
  if (*p == '"') {
    const char *e = strchr(p + 1, '"');
    if (e) {
      char *exe = xstrndup(p + 1, (size_t)(e - p - 1));
      char *args = xstrdup(e + 1);
      while (*args == ' ') memmove(args, args + 1, strlen(args));
      wchar_t *wexe = u8_to_w(exe), *wargs = *args ? u8_to_w(args) : NULL;
      HINSTANCE r = ShellExecuteW(NULL, L"open", wexe, wargs, NULL, SW_SHOWNORMAL);
      free(wexe); free(wargs); free(exe); free(args);
      return (INT_PTR)r > 32;
    }
  }
  wchar_t *w = u8_to_w(cmd);
  STARTUPINFOW si; PROCESS_INFORMATION pi;
  memset(&si, 0, sizeof(si)); si.cb = sizeof(si);
  memset(&pi, 0, sizeof(pi));
  BOOL ok = CreateProcessW(NULL, w, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi);
  free(w);
  if (ok) { CloseHandle(pi.hThread); CloseHandle(pi.hProcess); }
  return ok;
}
static int delete_dir_recycle(const char *path) {
  wchar_t *w = u8_to_w(path);
  size_t n = wcslen(w);
  wchar_t *from = (wchar_t *)xmalloc((n + 2) * sizeof(wchar_t));
  memcpy(from, w, n * sizeof(wchar_t));
  from[n] = 0; from[n + 1] = 0;
  free(w);
  SHFILEOPSTRUCTW op;
  memset(&op, 0, sizeof(op));
  op.wFunc = FO_DELETE;
  op.pFrom = from;
  op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI;
  int ok = SHFileOperationW(&op) == 0 && !op.fAnyOperationsAborted;
  free(from);
  if (!ok) {
    char cmd[MAX_PATH * 3];
    snprintf(cmd, sizeof(cmd), "cmd /c rmdir /s /q \"%s\"", path);
    g_host->run_command(cmd, 1);
  }
  return !path_exists(path);
}
static int remove_game_record(const char *id) {
  cJSON *root = G_root();
  cJSON *list = obj_get(root, "list"), *out = cJSON_CreateArray();
  int removed = 0;
  cJSON *it = NULL;
  cJSON_ArrayForEach(it, list) {
    if (!strcmp(J_str(it, "id", ""), id)) removed++;
    else cJSON_AddItemToArray(out, cJSON_Duplicate(it, 1));
  }
  J_set(root, "list", out);
  G_save(root);
  if (removed) G_emit("remove", NULL);
  cJSON_Delete(root);
  return removed;
}
static cJSON *uninstall_info_of(cJSON *g) {
  cJSON *o = cJSON_CreateObject();
  cJSON_AddStringToObject(o, "name", J_str(g, "name", ""));
  cJSON_AddStringToObject(o, "id", J_str(g, "id", ""));
  cJSON_AddStringToObject(o, "path", J_str(g, "path", ""));
  cJSON_AddStringToObject(o, "uninstallString", J_str(g, "uninstallString", ""));
  cJSON_AddStringToObject(o, "platform", J_str(g, "platform", "local"));
  char *appid = steam_appid_from_game(g);
  cJSON_AddStringToObject(o, "appid", appid ? appid : "");
  const char *us = J_str(g, "uninstallString", "");
  const char *platform = J_str(g, "platform", "local");
  char *dir = NULL;
  if (path_is_dir(J_str(g, "path", ""))) dir = xstrdup(J_str(g, "path", ""));
  else if (*J_str(g, "exe", "")) {
    char *d = path_dirname(J_str(g, "exe", ""));
    if (d && path_is_dir(d)) dir = d; else free(d);
  }
  int safe = 0;
  const char *route = "none";
  char label[64] = "无法卸载";
  char detail[900] = "没有可用的卸载命令，也没有可删除的游戏目录。";
  char warn[512] = "";
  if (!strcmp(platform, "steam") && appid && *appid) {
    route = "platform"; safe = 1;
    snprintf(label, sizeof(label), "Steam 平台卸载");
    snprintf(detail, sizeof(detail), "调用 Steam 客户端卸载「%s」（appid %s）。", J_str(g, "name", ""), appid);
    snprintf(warn, sizeof(warn), "Steam 会删除游戏文件；云存档、创意工坊订阅和截图按 Steam 自己的规则保留。");
  } else if (*us) {
    route = "uninstaller"; safe = 1;
    snprintf(label, sizeof(label), "%s",
             (!strcmp(platform, "local") || !strcmp(platform, "auto")) ? "游戏自带卸载程序" : "平台卸载程序");
    snprintf(detail, sizeof(detail), "运行卸载命令：%s", us);
    snprintf(warn, sizeof(warn), "会打开厂商的卸载界面，请按提示完成；不会直接删除游戏目录。");
  } else if (dir && safe_game_dir(dir)) {
    route = "trash"; safe = 1;
    snprintf(label, sizeof(label), "删除游戏目录");
    snprintf(detail, sizeof(detail), "没有可用的卸载命令，将把「%s」移进回收站。", dir);
    snprintf(warn, sizeof(warn), "只删除这个游戏目录；存档、文档和启动器不动。删前请确认路径。");
  }
  cJSON_AddStringToObject(o, "route", route);
  cJSON_AddStringToObject(o, "label", label);
  cJSON_AddStringToObject(o, "detail", detail);
  cJSON_AddStringToObject(o, "warn", warn);
  json_set_bool(o, "safe", safe);
  free(appid); free(dir);
  return o;
}

static int non_game_name(const char *name) {
  const char *bad[] = { "microsoft", "windows", "update", "hotfix", "redistributable", "runtime", "sdk", ".net",
    "visual c++", "visual studio", "directx", "driver", "service pack", "python", "java", "node.js", "git",
    "vmware", "virtualbox", "nvidia", "realtek", "chipset", "office", "wps", "libreoffice", "adobe",
    "autodesk", "acad", "solidworks", "matlab", "antivirus", "browser", "player", "wallpaper", "powertoys",
    "tool", "cleaner", "benchmark", "copilot", "vpn", "launcher", "client", "galaxy", "connect",
    "输入法", "杀毒", "安全", "浏览器", "播放器", "压缩", "解压", "网盘", "云盘", "下载", "迅雷",
    "管家", "助手", "壁纸", "截图", "看图", "录屏", "剪辑", "直播", "清理", "加速器", "模拟器", "启动器",
    "平台", "客户端", "驱动", "编辑器", NULL };
  char *low = str_lower(name ? name : "");
  int hit = 0;
  for (int i = 0; bad[i]; i++) if (strstr(low, bad[i])) { hit = 1; break; }
  free(low);
  return hit;
}
static int game_dir_hint(const char *path) {
  char *low = str_lower(path ? path : "");
  int hit = 0;
  const char *keys[] = { "\\steamapps\\", "\\epic games\\", "\\gog games\\", "\\games\\", "\\game\\", "\\游戏\\", "\\单机游戏\\", "\\游戏库\\", NULL };
  for (int i = 0; keys[i]; i++) if (strstr(low, keys[i])) { hit = 1; break; }
  free(low);
  return hit;
}
static int game_publisher_hint(const char *pub) {
  char *low = str_lower(pub ? pub : "");
  int hit = 0;
  const char *keys[] = { "blizzard", "epic games", "ubisoft", "electronic arts", "rockstar", "riot games",
    "valve", "bethesda", "bandai namco", "capcom", "sega", "square enix", "konami", "koei", "paradox",
    "activision", "take-two", "2k games", "fromsoftware", "cd projekt", "larian", "warner", "sony",
    "bungie", "mojang", "krafton", "ncsoft", "nexon", "perfect world", "netease", "hoyoverse", "mihoyo",
    "devolver", "team17", "505 games", "annapurna", "thq", "deep silver", "techland", "bohemia", NULL };
  for (int i = 0; keys[i]; i++) if (strstr(low, keys[i])) { hit = 1; break; }
  free(low);
  return hit;
}
static int game_name_hint(const char *name) {
  char *low = str_lower(name ? name : "");
  int hit = 0;
  const char *keys[] = { "game", "play", "war", "craft", "quest", "fantasy", "story", "adventure",
    "saga", "legend", "dragon", "hero", "star", "simulator", "online", "rpg", "world", "kingdom",
    "dark", "lost", "survival", "tactics", "strategy", "shooter", "racing", "sport", "游戏", "战",
    "幻想", "传说", "冒险", "模拟", "世界", "生存", "英雄", "三国", "仙剑", "武侠", NULL };
  for (int i = 0; keys[i]; i++) if (strstr(low, keys[i])) { hit = 1; break; }
  free(low);
  return hit;
}
static int score_registry(const char *name, const char *path, const char *pub, const char *unins) {
  if (non_game_name(name)) return -10;
  int score = 0;
  if (game_dir_hint(path)) score += 5;
  if (game_publisher_hint(pub)) score += 3;
  if (game_name_hint(name)) score += 2;
  if (path && *path) score += 1;
  char *low = str_lower(unins ? unins : "");
  if (strstr(low, "game") || strstr(low, "play")) score += 1;
  free(low);
  return score;
}

static cJSON *scan_registry(void) {
  cJSON *games = cJSON_CreateArray();
  const wchar_t *roots[] = {
    L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    L"SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    NULL
  };
  const HKEY hives[] = { HKEY_LOCAL_MACHINE, HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER };
  for (int hi = 0; hi < 3; hi++) {
    for (int ri = 0; roots[ri]; ri++) {
      HKEY k;
      if (RegOpenKeyExW(hives[hi], roots[ri], 0, KEY_READ, &k) != ERROR_SUCCESS) continue;
      wchar_t sub[256]; DWORD idx = 0, len = 256;
      while (RegEnumKeyExW(k, idx++, sub, &len, NULL, NULL, NULL, NULL) == ERROR_SUCCESS) {
        len = 256;
        HKEY sk;
        if (RegOpenKeyExW(k, sub, 0, KEY_READ, &sk) != ERROR_SUCCESS) continue;
        wchar_t name[512] = L"", loc[512] = L"", icon[1024] = L"", unins[1024] = L"", pub[256] = L"", ver[128] = L"", idate[64] = L"";
        DWORD sz, type;
        sz = sizeof(name); RegQueryValueExW(sk, L"DisplayName", NULL, &type, (LPBYTE)name, &sz);
        sz = sizeof(loc); RegQueryValueExW(sk, L"InstallLocation", NULL, &type, (LPBYTE)loc, &sz);
        sz = sizeof(icon); RegQueryValueExW(sk, L"DisplayIcon", NULL, &type, (LPBYTE)icon, &sz);
        sz = sizeof(unins); RegQueryValueExW(sk, L"UninstallString", NULL, &type, (LPBYTE)unins, &sz);
        sz = sizeof(pub); RegQueryValueExW(sk, L"Publisher", NULL, &type, (LPBYTE)pub, &sz);
        sz = sizeof(ver); RegQueryValueExW(sk, L"DisplayVersion", NULL, &type, (LPBYTE)ver, &sz);
        sz = sizeof(idate); RegQueryValueExW(sk, L"InstallDate", NULL, &type, (LPBYTE)idate, &sz);
        DWORD sys = 0; sz = sizeof(sys);
        RegQueryValueExW(sk, L"SystemComponent", NULL, &type, (LPBYTE)&sys, &sz);
        RegCloseKey(sk);
        if (!name[0] || sys) continue;
        char *n = w_to_u8(name);
        if (strstr(n, "Microsoft Visual C++") || strstr(n, "Update for") || strstr(n, "Security Update") ||
            strstr(n, "DirectX") || strstr(n, "Redistributable") || strstr(n, ".NET") || strstr(n, "驱动程序")) { free(n); continue; }
        char *lp = w_to_u8(loc);
        char *exe = NULL;
        if (icon[0]) {
          char *ic = w_to_u8(icon);
          char *comma = strchr(ic, ',');
          if (comma) *comma = 0;
          if (str_ends_ci(ic, ".exe") && path_exists(ic)) exe = xstrdup(ic);
          free(ic);
        }
        if (!exe && *lp) {
          char *p = path_join(lp, "*");
          wchar_t *wp = u8_to_w(p);
          WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW(wp, &fd);
          free(wp); free(p);
          if (h != INVALID_HANDLE_VALUE) {
            do {
              if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
              char *en = w_to_u8(fd.cFileName);
              if (str_ends_ci(en, ".exe") && !strstr(en, "unins") && !strstr(en, "setup")) {
                char *f = path_join(lp, en);
                if (!exe && file_size(f) > 200 * 1024) exe = xstrdup(f);
                free(f);
              }
              free(en);
            } while (FindNextFileW(h, &fd));
            FindClose(h);
          }
        }
        if (!exe && !*lp) { free(n); free(lp); continue; }
        char *pp = w_to_u8(pub); char *vv = w_to_u8(ver); char *uu = w_to_u8(unins); char *ii = w_to_u8(idate);
        /* 暴雪战网 / Steam / Epic 启动器这类平台客户端，不是游戏 */
        if (is_launcher_or_runtime(n, lp, exe)) { free(n); free(lp); free(pp); free(vv); free(uu); free(ii); free(exe); continue; }
        if (score_registry(n, lp, pp, uu) < 4) { free(n); free(lp); free(pp); free(vv); free(uu); free(ii); free(exe); continue; }
        cJSON *o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "name", n);
        cJSON_AddStringToObject(o, "path", lp);
        if (exe) { cJSON_AddStringToObject(o, "exe", exe); cJSON_AddStringToObject(o, "launch", exe); free(exe); }
        cJSON_AddStringToObject(o, "publisher", pp);
        cJSON_AddStringToObject(o, "version", vv);
        cJSON_AddStringToObject(o, "uninstallString", uu);
        cJSON_AddStringToObject(o, "installDate", ii);
        cJSON_AddStringToObject(o, "platform", detect_platform(lp, n, NULL));
        cJSON_AddStringToObject(o, "source", "registry");
        cJSON_AddItemToArray(games, o);
        free(n); free(lp); free(pp); free(vv); free(uu); free(ii);
      }
      RegCloseKey(k);
      len = 256;
    }
  }
  return games;
}

static cJSON *scan_epic(void) {
  cJSON *games = cJSON_CreateArray();
  char pd[MAX_PATH]; snprintf(pd, sizeof(pd), "%s", getenv("ProgramData") ? getenv("ProgramData") : "C:\\ProgramData");
  char *dir = path_join(pd, "Epic\\EpicGamesLauncher\\Data\\Manifests");
  char *pat = path_join(dir, "*.item");
  wchar_t *wp = u8_to_w(pat);
  WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW(wp, &fd);
  free(wp); free(pat);
  if (h != INVALID_HANDLE_VALUE) {
    do {
      char *fname = w_to_u8(fd.cFileName);
      char *file = path_join(dir, fname);
      cJSON *j = json_from_file(file);
      if (j) {
        const char *dn = J_str(j, "DisplayName", "");
        const char *loc = J_str(j, "InstallLocation", "");
        const char *le = J_str(j, "LaunchExecutable", "");
        const char *app = J_str(j, "AppName", "");
        if (*dn && *loc && path_exists(loc) && !is_launcher_or_runtime(dn, loc, le)) {
          cJSON *o = cJSON_CreateObject();
          cJSON_AddStringToObject(o, "name", dn);
          cJSON_AddStringToObject(o, "path", loc);
          if (*le) {
            char *exe = path_join(loc, le);
            cJSON_AddStringToObject(o, "exe", exe);
            cJSON_AddStringToObject(o, "launch", exe);
            cJSON_AddStringToObject(o, "watchExe", path_basename(exe));
            free(exe);
          }
          cJSON_AddStringToObject(o, "platform", "epic");
          cJSON_AddStringToObject(o, "appid", app);
          cJSON_AddStringToObject(o, "source", "epic");
          cJSON_AddItemToArray(games, o);
        }
        cJSON_Delete(j);
      }
      free(file); free(fname);
    } while (FindNextFileW(h, &fd));
    FindClose(h);
  }
  free(dir);
  return games;
}

static int looks_like_game_exe(const char *name) {
  char *low = str_lower(name);
  const char *bad[] = { "unins", "setup", "install", "vcredist", "vc_redist", "dxsetup", "dotnetfx",
    "directx", "crashpad", "updater", "update.exe", "report", "helper", "launcher", "server", NULL };
  int ok = 1;
  for (int i = 0; bad[i]; i++) if (strstr(low, bad[i])) {
    /* Launcher 也可能是游戏本体（如 Launcher.exe），只在名字很短时跳过 */
    if (!strcmp(bad[i], "launcher") && strlen(low) > 12) continue;
    ok = 0; break;
  }
  free(low);
  return ok;
}
static char *main_exe_in(const char *dir, const char *folder, int depth) {
  if (depth > 2) return NULL;
  char *best = NULL;
  int64_t best_score = 0;
  char *pat = path_join(dir, "*");
  wchar_t *wp = u8_to_w(pat);
  WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW(wp, &fd);
  free(wp); free(pat);
  if (h != INVALID_HANDLE_VALUE) {
    do {
      if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
      char *n = w_to_u8(fd.cFileName);
      if (!str_ends_ci(n, ".exe") || !looks_like_game_exe(n)) { free(n); continue; }
      char *full = path_join(dir, n);
      int64_t sz = ((int64_t)fd.nFileSizeHigh << 32) | fd.nFileSizeLow;
      if (sz < 200 * 1024) { free(full); free(n); continue; }
      int64_t score = sz;
      if (folder && *folder) {
        char *ln = str_lower(n), *lf = str_lower(folder);
        if (strstr(ln, lf)) score += INT64_C(1000000000000);
        free(ln); free(lf);
      }
      if (score > best_score) { free(best); best = full; best_score = score; }
      else free(full);
      free(n);
    } while (FindNextFileW(h, &fd));
    FindClose(h);
  }
  if (best) return best;
  /* bin / x64 子目录 */
  const char *subs[] = { "bin", "binaries", "win64", "x64", "game", "release", NULL };
  for (int i = 0; subs[i]; i++) {
    char *sub = path_join(dir, subs[i]);
    if (path_is_dir(sub)) {
      char *r = main_exe_in(sub, folder, depth + 1);
      free(sub);
      if (r) return r;
    }
    free(sub);
  }
  return NULL;
}

/* ============================================================
 *  IPC 分发
 * ============================================================ */
static int is_switch(const char *ch, const char *name) { return !strcmp(ch, name); }

static int games_invoke(const char *channel, const char *args_json, char **out_json, char **out_error) {
  cJSON *args = mod_parse_args(args_json);
  int rc = 0;
  cJSON *res = NULL;

  /* ---- 列表 / CRUD ---- */
  if (is_switch(channel, "games:list")) {
    res = G_list(mod_arg_obj(args, 0));
  } else if (is_switch(channel, "games:tidy")) {
    /* 整理游戏库：清掉误入库的平台客户端/运行库，合并重复条目 */
    int m = 0, c = 0;
    G_tidy(&m, &c);
    res = cJSON_CreateObject();
    cJSON_AddNumberToObject(res, "merged", m);
    cJSON_AddNumberToObject(res, "cleaned", c);
  } else if (is_switch(channel, "games:hiddenList")) {
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "view", "hidden");
    res = G_list(o);
    cJSON_Delete(o);
  } else if (is_switch(channel, "games:add")) {
    int isnew = 0;
    cJSON *g = G_add(mod_arg_obj(args, 0), &isnew);
    res = cJSON_CreateObject();
    cJSON_AddItemToObject(res, "game", g ? g : cJSON_CreateNull());
    cJSON_AddBoolToObject(res, "isNew", isnew);
  } else if (is_switch(channel, "games:addManual")) {
    int isnew = 0;
    cJSON *g = G_add(mod_arg_obj(args, 0), &isnew);
    res = cJSON_CreateObject();
    cJSON_AddItemToObject(res, "game", g ? g : cJSON_CreateNull());
    cJSON_AddBoolToObject(res, "isNew", isnew);
  } else if (is_switch(channel, "games:addMany")) {
    cJSON *arr = mod_arg_at(args, 0);
    cJSON *out = cJSON_CreateArray();
    cJSON *it = NULL;
    cJSON_ArrayForEach(it, arr) {
      int isnew = 0;
      cJSON *g = G_add(it, &isnew);
      if (g && isnew) cJSON_AddItemToArray(out, g);
      else if (g) cJSON_Delete(g);
    }
    res = out;
  } else if (is_switch(channel, "games:update")) {
    const char *id = mod_arg_str(args, 0, "");
    cJSON *o = G_update(id, mod_arg_obj(args, 1));
    res = o ? o : cJSON_CreateNull();
  } else if (is_switch(channel, "games:remove")) {
    cJSON *ids = mod_arg_at(args, 0);
    cJSON *root = G_root();
    cJSON *list = obj_get(root, "list"), *out = cJSON_CreateArray();
    int n = 0;
    cJSON *it = NULL;
    cJSON_ArrayForEach(it, list) {
      int del = 0;
      if (cJSON_IsArray(ids)) { cJSON *x = NULL; cJSON_ArrayForEach(x, ids) if (cJSON_IsString(x) && !strcmp(x->valuestring, J_str(it, "id", ""))) del = 1; }
      else if (cJSON_IsString(ids) && !strcmp(ids->valuestring, J_str(it, "id", ""))) del = 1;
      if (!del) cJSON_AddItemToArray(out, cJSON_Duplicate(it, 1));
      else n++;
    }
    J_set(root, "list", out);
    G_save(root);
    G_emit("remove", NULL);
    int total = cJSON_GetArraySize(out);
    cJSON_Delete(root);
    res = cJSON_CreateNumber(total);
    (void)n;
  } else if (is_switch(channel, "games:clear")) {
    cJSON *root = G_root();
    J_set(root, "list", cJSON_CreateArray());
    G_save(root); cJSON_Delete(root);
    G_emit("clear", NULL);
    res = cJSON_CreateBool(1);
  } else if (is_switch(channel, "games:setHidden")) {
    cJSON *ids = mod_arg_at(args, 0);
    int on = mod_arg_bool(args, 1, 0);
    cJSON *root = G_root();
    cJSON *list = obj_get(root, "list"), *it = NULL;
    cJSON_ArrayForEach(it, list) {
      int hit = 0;
      if (cJSON_IsArray(ids)) { cJSON *x = NULL; cJSON_ArrayForEach(x, ids) if (cJSON_IsString(x) && !strcmp(x->valuestring, J_str(it, "id", ""))) hit = 1; }
      else if (cJSON_IsString(ids) && !strcmp(ids->valuestring, J_str(it, "id", ""))) hit = 1;
      if (!hit) continue;
      cJSON *cats = cats_of(it);
      int has = cats_has(cats, ADULT_CAT);
      if (on != has) {
        cJSON *nc = cJSON_CreateArray();
        cJSON *c = NULL;
        cJSON_ArrayForEach(c, cats) if (cJSON_IsString(c) && strcmp(c->valuestring, ADULT_CAT)) cJSON_AddItemToArray(nc, cJSON_CreateString(c->valuestring));
        cJSON_Delete(cats); cats = nc;
        if (on) cJSON_AddItemToArray(cats, cJSON_CreateString(ADULT_CAT));
      }
      json_set_bool(it, "hidden", on);
      J_set(it, "categories", cats);
      J_set_str(it, "category", cats_first(cats));
    }
    G_save(root); cJSON_Delete(root);
    G_emit("hidden", NULL);
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "view", "hidden");
    res = G_list(o);
    cJSON_Delete(o);
  } else if (is_switch(channel, "games:categories")) {
    cJSON *root = G_root();
    cJSON *storecats = obj_get(root, "categories");
    cJSON *set = cJSON_CreateArray();
    const char *base[] = { "未分类", ADULT_CAT, NULL };
    for (int i = 0; base[i]; i++) {
      cJSON *it = NULL;
      int has = 0;
      cJSON_ArrayForEach(it, storecats) if (cJSON_IsString(it) && !strcmp(it->valuestring, base[i])) has = 1;
      if (!has) cJSON_AddItemToArray(set, cJSON_CreateString(base[i]));
      else cJSON_AddItemToArray(set, cJSON_CreateString(base[i]));
    }
    cJSON *it = NULL;
    cJSON_ArrayForEach(it, storecats) {
      if (!cJSON_IsString(it)) continue;
      if (!strcmp(it->valuestring, "未分类") || !strcmp(it->valuestring, ADULT_CAT)) continue;
      if (!cats_has(set, it->valuestring)) cJSON_AddItemToArray(set, cJSON_CreateString(it->valuestring));
    }
    cJSON *list = obj_get(root, "list");
    cJSON_ArrayForEach(it, list) {
      cJSON *cs = cats_of(it);
      cJSON *c = NULL;
      cJSON_ArrayForEach(c, cs) if (cJSON_IsString(c) && !cats_has(set, c->valuestring)) cJSON_AddItemToArray(set, cJSON_CreateString(c->valuestring));
      cJSON_Delete(cs);
    }
    cJSON_Delete(root);
    res = set;
  } else if (is_switch(channel, "games:addCategory")) {
    const char *name = mod_arg_str(args, 0, "");
    char buf[16]; snprintf(buf, sizeof(buf), "%.12s", name);
    str_trim(buf);
    if (!*buf) { rc = -1; *out_error = mod_ret_error("分类名不能为空"); goto done; }
    if (!strcmp(buf, "未分类")) { rc = -1; *out_error = mod_ret_error("不能新建「未分类」"); goto done; }
    cJSON *root = G_root();
    cJSON *cats = obj_get(root, "categories");
    if (cats_has(cats, buf)) { cJSON_Delete(root); rc = -1; *out_error = mod_ret_error("分类「%s」已存在", buf); goto done; }
    cJSON_AddItemToArray(cats, cJSON_CreateString(buf));
    G_save(root); cJSON_Delete(root);
    G_emit("categories", NULL);
    cJSON *o = cJSON_CreateObject(); cJSON_AddStringToObject(o, "x", "1"); cJSON_Delete(o);
    cJSON *dummy = cJSON_CreateArray();
    /* 直接复用 categories 逻辑 */
    {
      cJSON *r2 = G_root();
      cJSON *sc = obj_get(r2, "categories");
      cJSON *out = cJSON_CreateArray();
      cJSON_AddItemToArray(out, cJSON_CreateString("未分类"));
      cJSON_AddItemToArray(out, cJSON_CreateString(ADULT_CAT));
      cJSON *it = NULL;
      cJSON_ArrayForEach(it, sc) {
        if (cJSON_IsString(it) && strcmp(it->valuestring, "未分类") && strcmp(it->valuestring, ADULT_CAT) && !cats_has(out, it->valuestring))
          cJSON_AddItemToArray(out, cJSON_CreateString(it->valuestring));
      }
      cJSON_Delete(r2);
      cJSON_Delete(dummy);
      res = out;
    }
  } else if (is_switch(channel, "games:renameCategory")) {
    const char *from = mod_arg_str(args, 0, ""), *to = mod_arg_str(args, 1, "");
    char b[16]; snprintf(b, sizeof(b), "%.12s", to); str_trim(b);
    if (!*b) { rc = -1; *out_error = mod_ret_error("分类名不能为空"); goto done; }
    if (!strcmp(from, "未分类")) { rc = -1; *out_error = mod_ret_error("「未分类」不能改名"); goto done; }
    if (!strcmp(from, ADULT_CAT)) { rc = -1; *out_error = mod_ret_error("「18+」是内建的特殊分类，不能改名"); goto done; }
    cJSON *root = G_root();
    cJSON *cats = obj_get(root, "categories");
    if (!cats_has(cats, from)) { cJSON_Delete(root); rc = -1; *out_error = mod_ret_error("分类「%s」不存在", from); goto done; }
    cJSON *it = NULL;
    cJSON *nc = cJSON_CreateArray();
    cJSON_ArrayForEach(it, cats) if (cJSON_IsString(it)) cJSON_AddItemToArray(nc, cJSON_CreateString(!strcmp(it->valuestring, from) ? b : it->valuestring));
    J_set(root, "categories", nc);
    cJSON *list = obj_get(root, "list");
    cJSON_ArrayForEach(it, list) {
      cJSON *cs = cats_of(it);
      int has = cats_has(cs, from);
      if (has) {
        cJSON *ncats = cJSON_CreateArray();
        cJSON *c = NULL;
        cJSON_ArrayForEach(c, cs) if (cJSON_IsString(c)) cJSON_AddItemToArray(ncats, cJSON_CreateString(!strcmp(c->valuestring, from) ? b : c->valuestring));
        J_set(it, "categories", ncats);
        J_set_str(it, "category", cats_first(ncats));
      }
      cJSON_Delete(cs);
    }
    G_save(root); cJSON_Delete(root);
    G_emit("categories", NULL);
    res = cJSON_CreateBool(1);
  } else if (is_switch(channel, "games:removeCategory")) {
    const char *name = mod_arg_str(args, 0, "");
    if (!strcmp(name, "未分类")) { rc = -1; *out_error = mod_ret_error("「未分类」不能删除"); goto done; }
    if (!strcmp(name, ADULT_CAT)) { rc = -1; *out_error = mod_ret_error("「18+」不能删除；从游戏上摘掉它就会回到游戏库"); goto done; }
    cJSON *root = G_root();
    cJSON *cats = obj_get(root, "categories");
    cJSON *nc = cJSON_CreateArray();
    cJSON *it = NULL;
    cJSON_ArrayForEach(it, cats) if (cJSON_IsString(it) && strcmp(it->valuestring, name)) cJSON_AddItemToArray(nc, cJSON_CreateString(it->valuestring));
    J_set(root, "categories", nc);
    cJSON *list = obj_get(root, "list");
    cJSON_ArrayForEach(it, list) {
      cJSON *cs = cats_of(it);
      if (cats_has(cs, name)) {
        cJSON *n2 = cJSON_CreateArray();
        cJSON *c = NULL;
        cJSON_ArrayForEach(c, cs) if (cJSON_IsString(c) && strcmp(c->valuestring, name)) cJSON_AddItemToArray(n2, cJSON_CreateString(c->valuestring));
        J_set(it, "categories", n2);
        J_set_str(it, "category", cats_first(n2));
        if (!cJSON_GetArraySize(n2)) json_set_bool(it, "categoryLocked", 0);
      }
      cJSON_Delete(cs);
    }
    G_save(root); cJSON_Delete(root);
    G_emit("categories", NULL);
    res = cJSON_CreateBool(1);
  } else if (is_switch(channel, "games:setCategories")) {
    const char *id = mod_arg_str(args, 0, "");
    cJSON *cats = mod_arg_at(args, 1);
    cJSON *patch = cJSON_CreateObject();
    J_set(patch, "categories", cJSON_IsArray(cats) ? cJSON_Duplicate(cats, 1) : cJSON_CreateArray());
    cJSON *o = G_update(id, patch);
    cJSON_Delete(patch);
    res = o ? o : cJSON_CreateNull();
  } else if (is_switch(channel, "games:stats")) {
    res = G_stats(mod_arg_str(args, 0, "all"));
  } else if (is_switch(channel, "games:sessions")) {
    cJSON *root = G_root();
    cJSON *ss = obj_get(root, "sessions");
    int limit = mod_arg_int(args, 0, 60);
    int n = cJSON_GetArraySize(ss);
    cJSON *out = cJSON_CreateArray();
    for (int i = n - 1; i >= 0 && cJSON_GetArraySize(out) < limit; i--) {
      cJSON *e = cJSON_GetArrayItem(ss, i);
      cJSON *cp = cJSON_Duplicate(e, 1);
      char t[64]; local_time_str((int64_t)J_num(e, "start", 0), t, sizeof(t));
      cJSON_AddStringToObject(cp, "startText", t);
      cJSON_AddItemToArray(out, cp);
    }
    cJSON_Delete(root);
    res = out;
  } else if (is_switch(channel, "games:launch")) {
    const char *id = mod_arg_str(args, 0, "");
    res = G_launch(id);
    if (!res) { rc = -1; *out_error = mod_ret_error("启动失败：找不到可执行目标或文件不存在"); }
  } else if (is_switch(channel, "games:stop")) {
    res = G_stop(mod_arg_str(args, 0, ""));
  } else if (is_switch(channel, "games:openFolder")) {
    cJSON *root = G_root();
    cJSON *g = G_find(root, mod_arg_str(args, 0, ""));
    const char *p = g ? J_str(g, "path", "") : "";
    char *dir = *p ? xstrdup(p) : (g && *J_str(g, "exe", "") ? path_dirname(J_str(g, "exe", "")) : NULL);
    cJSON_Delete(root);
    if (!dir || !path_exists(dir)) { free(dir); rc = -1; *out_error = mod_ret_error("目录不存在"); goto done; }
    open_path(dir);
    res = cJSON_CreateObject();
    cJSON_AddStringToObject(res, "dir", dir);
    free(dir);
  } else if (is_switch(channel, "games:calcSize")) {
    cJSON *root = G_root();
    cJSON *g = G_find(root, mod_arg_str(args, 0, ""));
    const char *p = g ? J_str(g, "path", "") : "";
    int64_t sz = (*p && path_exists(p)) ? dir_size(p, 0) : 0;
    cJSON_Delete(root);
    if (sz > 0) {
      cJSON *patch = cJSON_CreateObject();
      json_set_int(patch, "size", sz);
      json_set_int(patch, "sizeComputedAt", now_ms());
      cJSON *o = G_update(mod_arg_str(args, 0, ""), patch);
      cJSON_Delete(patch);
      if (o) cJSON_Delete(o);
    }
    cJSON *ev = cJSON_CreateObject();
    json_set_int(ev, "size", sz);
    mod_emit("games:size", ev);
    res = cJSON_CreateNumber((double)sz);
  } else if (is_switch(channel, "games:setCover")) {
    cJSON *root = G_root();
    cJSON *g = G_find(root, mod_arg_str(args, 0, ""));
    if (!g) { cJSON_Delete(root); rc = -1; *out_error = mod_ret_error("游戏不存在"); goto done; }
    char *src = mod_path_from_arg(args, 1);
    char *ext = xstrdup(path_ext(src));
    char *dst = path_join(mod_data_dir(), "covers");
    path_mkdirs(dst);
    char fname[128]; snprintf(fname, sizeof(fname), "custom_%s.%s", J_str(g, "id", ""), *ext ? ext : "jpg");
    char *file = path_join(dst, fname);
    int ok = CopyFileW(u8_to_w(src), u8_to_w(file), FALSE);
    char *u = (char *)xmalloc(strlen(file) + 12);
    sprintf(u, "file:///%s", file);
    for (char *q = u + 8; *q; q++) if (*q == '\\') *q = '/';
    cJSON *patch = cJSON_CreateObject();
    J_set_str(patch, "coverLocal", u);
    J_set_str(patch, "coverKind", "custom");
    J_set(patch, "cover", cJSON_CreateString(""));
    cJSON *o = G_update(mod_arg_str(args, 0, ""), patch);
    cJSON_Delete(patch); free(u); free(file); free(dst); free(ext); free(src);
    cJSON_Delete(root);
    if (!ok) { rc = -1; *out_error = mod_ret_error("复制封面失败"); goto done; }
    res = o ? o : cJSON_CreateNull();
  } else if (is_switch(channel, "games:clearCover")) {
    cJSON *patch = cJSON_CreateObject();
    J_set_str(patch, "coverLocal", "");
    J_set_str(patch, "cover", "");
    J_set_str(patch, "coverKind", "none");
    cJSON *o = G_update(mod_arg_str(args, 0, ""), patch);
    cJSON_Delete(patch);
    res = o ? o : cJSON_CreateNull();
  } else if (is_switch(channel, "games:resolveCover") || is_switch(channel, "games:fetchSteamCover")) {
    cJSON *opts = mod_arg_obj(args, 1);
    const char *mode = opts ? json_str(opts, "mode", "refresh") : "refresh";
    int net = opts ? json_bool(opts, "allowNetwork", 1) : 1;
    char *err = NULL;
    cJSON *o = resolve_cover_game(mod_arg_str(args, 0, ""), mode, net, &err);
    if (!o) { rc = -1; *out_error = err ? err : mod_ret_error("获取封面失败"); goto done; }
    res = o;
  } else if (is_switch(channel, "games:resolveCovers")) {
    cJSON *ids = mod_arg_at(args, 0);
    cJSON *opts = mod_arg_obj(args, 1);
    int net = opts ? json_bool(opts, "allowNetwork", 1) : 1;
    int count = 0;
    int n = cJSON_IsArray(ids) ? cJSON_GetArraySize(ids) : 0;
    for (int i = 0; i < n; i++) {
      cJSON *x = cJSON_GetArrayItem(ids, i);
      if (!cJSON_IsString(x)) continue;
      char *err = NULL;
      cJSON *o = resolve_cover_game(x->valuestring, "refresh", net, &err);
      if (o) {
        if (*J_str(o, "cover", "") || *J_str(o, "coverLocal", "")) count++;
        cJSON_Delete(o);
      }
      if (err) g_host->dealloc(err);
    }
    res = cJSON_CreateObject();
    cJSON_AddNumberToObject(res, "count", count);
  } else if (is_switch(channel, "games:scan") || is_switch(channel, "games:scanCandidates")) {
    /* 扫描：Steam + Epic + 注册表 + 常见目录
       🔴 先整理旧库：以前版本会把 Steam 清单和目录扫描各存一份（同一款两套 dedupe 键），
          还会把「暴雪战网 / Steamworks Common」这些平台与运行库当成游戏。 */
    int merged0 = 0, cleaned0 = 0;
    G_tidy(&merged0, &cleaned0);
    mod_emit_json("games:scan-progress", "{\"phase\":\"steam\",\"name\":\"正在读取 Steam 库…\"}");
    cJSON *roots = NULL;
    cJSON *st = scan_steam(&roots);
    mod_emit_json("games:scan-progress", "{\"phase\":\"epic\",\"name\":\"正在读取 Epic 清单…\"}");
    cJSON *ep = scan_epic();
    mod_emit_json("games:scan-progress", "{\"phase\":\"registry\",\"name\":\"正在读取注册表卸载项…\"}");
    cJSON *rg = scan_registry();
    int cs = cJSON_GetArraySize(st), ce = cJSON_GetArraySize(ep), cr = cJSON_GetArraySize(rg);
    cJSON *all = cJSON_CreateArray();
    cJSON *arrs[3] = { st, ep, rg };
    for (int k = 0; k < 3; k++) {
      cJSON *it = NULL;
      cJSON_ArrayForEach(it, arrs[k]) cJSON_AddItemToArray(all, cJSON_Duplicate(it, 1));
      cJSON_Delete(arrs[k]);
    }
    /* 常见目录 */
    cJSON *folder = cJSON_CreateArray();
    for (char d = 'C'; d <= 'Z'; d++) {
      const char *names[] = { "Games", "SteamLibrary", "Epic Games", "GOG Games", NULL };
      for (int i = 0; names[i]; i++) {
        char rootp[16]; snprintf(rootp, sizeof(rootp), "%c:\\%s", d, names[i]);
        if (!path_exists(rootp)) continue;
        char *pat = path_join(rootp, "*");
        wchar_t *wp = u8_to_w(pat);
        WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW(wp, &fd);
        free(wp); free(pat);
        if (h == INVALID_HANDLE_VALUE) continue;
        do {
          if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
          char *nm = w_to_u8(fd.cFileName);
          if (!wcscmp(fd.cFileName, L".") || !wcscmp(fd.cFileName, L"..") || !strcmp(nm, "steamapps")) { free(nm); continue; }
          char *dir = path_join(rootp, nm);
          char *exe = main_exe_in(dir, nm, 0);
          if (exe && is_launcher_or_runtime(nm, dir, exe)) { free(exe); exe = NULL; }
          if (exe) {
            cJSON *o = cJSON_CreateObject();
            cJSON_AddStringToObject(o, "name", nm);
            cJSON_AddStringToObject(o, "path", dir);
            cJSON_AddStringToObject(o, "exe", exe);
            cJSON_AddStringToObject(o, "launch", exe);
            cJSON_AddStringToObject(o, "platform", detect_platform(dir, nm, exe));
            cJSON_AddStringToObject(o, "source", "folder");
            cJSON_AddItemToArray(folder, o);
            free(exe);
          }
          free(dir); free(nm);
        } while (FindNextFileW(h, &fd));
        FindClose(h);
      }
    }
    int cf = cJSON_GetArraySize(folder);
    cJSON *it = NULL;
    cJSON_ArrayForEach(it, folder) cJSON_AddItemToArray(all, cJSON_Duplicate(it, 1));
    cJSON_Delete(folder);
    int before = 0;
    {
      cJSON *r = G_root();
      before = cJSON_GetArraySize(obj_get(r, "list"));
      cJSON_Delete(r);
    }
    int added = 0;
    cJSON_ArrayForEach(it, all) {
      int isnew = 0;
      cJSON *g = G_add(it, &isnew);
      if (g) { if (isnew) added++; cJSON_Delete(g); }
    }
    /* 新进来的若和旧的撞了（名字相同但目录写法不同），再整一遍 */
    int merged1 = 0, cleaned1 = 0;
    G_tidy(&merged1, &cleaned1);
    int after = 0;
    {
      cJSON *r = G_root();
      after = cJSON_GetArraySize(obj_get(r, "list"));
      cJSON_Delete(r);
    }
    cJSON *o = cJSON_CreateObject();
    cJSON_AddNumberToObject(o, "steam", cs);
    cJSON_AddNumberToObject(o, "epic", ce);
    cJSON_AddNumberToObject(o, "registry", cr);
    cJSON_AddNumberToObject(o, "folder", cf);
    cJSON_AddNumberToObject(o, "added", added);
    cJSON_AddNumberToObject(o, "merged", merged0 + merged1);
    cJSON_AddNumberToObject(o, "cleaned", cleaned0 + cleaned1);
    cJSON_AddNumberToObject(o, "total", after);
    cJSON_AddItemToObject(o, "list", cJSON_Duplicate(all, 1));
    cJSON_AddItemToObject(o, "steamRoots", roots ? roots : cJSON_CreateArray());
    cJSON_Delete(all);
    res = o;
    (void)before;
  } else if (is_switch(channel, "games:scanFolder")) {
    cJSON *roots = mod_arg_at(args, 0);
    cJSON *out = cJSON_CreateArray();
    int n = cJSON_IsArray(roots) ? cJSON_GetArraySize(roots) : 0;
    for (int i = 0; i < n; i++) {
      const char *root = cJSON_GetArrayItem(roots, i)->valuestring;
      char *pat = path_join(root, "*");
      wchar_t *wp = u8_to_w(pat);
      WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW(wp, &fd);
      free(wp); free(pat);
      if (h == INVALID_HANDLE_VALUE) continue;
      do {
        if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
        char *nm = w_to_u8(fd.cFileName);
        if (!wcscmp(fd.cFileName, L".") || !wcscmp(fd.cFileName, L"..")) { free(nm); continue; }
        char *dir = path_join(root, nm);
        char *exe = main_exe_in(dir, nm, 0);
        if (exe) {
          cJSON *o = cJSON_CreateObject();
          cJSON_AddStringToObject(o, "name", nm);
          cJSON_AddStringToObject(o, "path", dir);
          cJSON_AddStringToObject(o, "exe", exe);
          cJSON_AddStringToObject(o, "launch", exe);
          cJSON_AddStringToObject(o, "platform", detect_platform(dir, nm, exe));
          cJSON_AddStringToObject(o, "source", "folder");
          cJSON_AddItemToArray(out, o);
          free(exe);
        }
        free(dir); free(nm);
      } while (FindNextFileW(h, &fd));
      FindClose(h);
    }
    res = out;
  } else if (is_switch(channel, "games:importCandidates") || is_switch(channel, "games:importScanned")) {
    cJSON *items = mod_arg_at(args, 0);
    if (!cJSON_IsArray(items)) items = cJSON_GetObjectItemCaseSensitive(args ? cJSON_GetArrayItem(args, 0) : NULL, "list");
    int added = 0;
    cJSON *it = NULL;
    cJSON_ArrayForEach(it, items) {
      int isnew = 0;
      cJSON *g = G_add(it, &isnew);
      if (g) { if (isnew) added++; cJSON_Delete(g); }
    }
    cJSON *o = cJSON_CreateObject();
    cJSON_AddNumberToObject(o, "added", added);
    res = o;
  } else if (is_switch(channel, "games:analyzeCandidate")) {
    cJSON *in = mod_arg_obj(args, 0);
    cJSON *o = in ? cJSON_Duplicate(in, 1) : cJSON_CreateObject();
    cJSON_AddStringToObject(o, "confidence", "high");
    cJSON_AddStringToObject(o, "note", "找到主程序");
    res = o;
  } else if (is_switch(channel, "games:patrol") || is_switch(channel, "games:cleanupCandidates")) {
    res = cJSON_CreateArray();
  } else if (is_switch(channel, "games:cleanupApply")) {
    res = cJSON_CreateNumber(0);
  } else if (is_switch(channel, "games:uninstallInfo")) {
    cJSON *root = G_root();
    cJSON *g = G_find(root, mod_arg_str(args, 0, ""));
    res = g ? uninstall_info_of(g) : cJSON_CreateObject();
    cJSON_Delete(root);
  } else if (is_switch(channel, "games:uninstall")) {
    const char *id = mod_arg_str(args, 0, "");
    cJSON *opts = mod_arg_obj(args, 1);
    int want_remove = opts ? json_bool(opts, "removeRecord", 0) : 0;
    cJSON *root = G_root();
    cJSON *g = G_find(root, id);
    cJSON *info = g ? uninstall_info_of(g) : NULL;
    cJSON_Delete(root);
    if (!info) { rc = -1; *out_error = mod_ret_error("游戏不存在"); goto done; }
    if (!json_bool(info, "safe", 0)) {
      cJSON_Delete(info);
      rc = -1;
      *out_error = mod_ret_error("没有安全可用的卸载方式");
      goto done;
    }
    const char *route = json_str(info, "route", "none");
    char route_buf[32];
    snprintf(route_buf, sizeof(route_buf), "%s", route);
    const char *us = json_str(info, "uninstallString", "");
    const char *path = json_str(info, "path", "");
    const char *appid = json_str(info, "appid", "");
    int ok = 0, removed = 0;
    char msg[512] = "";
    if (!strcmp(route, "platform") && *appid) {
      char url[96];
      snprintf(url, sizeof(url), "steam://uninstall/%s", appid);
      wchar_t *w = u8_to_w(url);
      HINSTANCE r = ShellExecuteW(NULL, L"open", w, NULL, NULL, SW_SHOWNORMAL);
      free(w);
      ok = (INT_PTR)r > 32;
      snprintf(msg, sizeof(msg), ok ? "已调用 Steam 客户端卸载「%s」" : "调用 Steam 卸载失败", json_str(info, "name", ""));
    } else if (!strcmp(route, "uninstaller")) {
      ok = run_cmd_line(us);
      snprintf(msg, sizeof(msg), ok ? "已启动卸载程序，请按它的提示完成" : "卸载程序启动失败");
    } else if (!strcmp(route, "trash")) {
      ok = delete_dir_recycle(path);
      if (ok) removed = remove_game_record(id);
      snprintf(msg, sizeof(msg), ok ? "已删除游戏目录（回收站）" : "删除目录失败（可能被占用）");
    } else {
      snprintf(msg, sizeof(msg), "没有可用的卸载方式");
    }
    cJSON_Delete(info);
    if (!ok) { rc = -1; *out_error = mod_ret_error("%s", msg); goto done; }
    if (want_remove && strcmp(route_buf, "trash")) removed = remove_game_record(id) || removed;
    res = cJSON_CreateObject();
    cJSON_AddBoolToObject(res, "ok", 1);
    cJSON_AddStringToObject(res, "message", msg);
    cJSON_AddStringToObject(res, "route", route_buf);
    json_set_bool(res, "removed", removed);
  } else if (is_switch(channel, "games:mods")) {
    const char *id = mod_arg_str(args, 0, "");
    cJSON *o = mods_list(id, json_bool(mod_arg_obj(args, 1), "force", 0));
    if (!o) { rc = -1; *out_error = mod_ret_error("游戏不存在"); goto done; }
    res = o;
  } else if (is_switch(channel, "games:toggleMod")) {
    char *p = mod_path_from_arg(args, 1);
    char to[MAX_PATH * 2];
    if (str_ends_ci(p, ".disabled")) {
      snprintf(to, sizeof(to), "%s", p);
      to[strlen(to) - 9] = 0;
    } else snprintf(to, sizeof(to), "%s.disabled", p);
    int ok = MoveFileExW(u8_to_w(p), u8_to_w(to), MOVEFILE_REPLACE_EXISTING);
    free(p);
    if (!ok) { rc = -1; *out_error = mod_ret_error("改名失败（文件被占用？）"); goto done; }
    res = cJSON_CreateBool(1);
  } else if (is_switch(channel, "games:setModDir")) {
    char *dir = mod_path_from_arg(args, 1);
    cJSON *patch = cJSON_CreateObject();
    J_set_str(patch, "modDir", dir);
    cJSON *o = G_update(mod_arg_str(args, 0, ""), patch);
    cJSON_Delete(patch); free(dir);
    res = o ? o : cJSON_CreateNull();
  } else if (is_switch(channel, "games:useSuggestedModDir")) {
    cJSON *root = G_root();
    cJSON *g = G_find(root, mod_arg_str(args, 0, ""));
    if (!g) { cJSON_Delete(root); rc = -1; *out_error = mod_ret_error("游戏不存在"); goto done; }
    cJSON *info = mod_dir_info(g);
    const char *dir = J_str(info, "dir", "");
    char *target = *dir ? xstrdup(dir) : xstrdup(J_str(info, "suggest", ""));
    cJSON_Delete(info); cJSON_Delete(root);
    if (!*target) { free(target); rc = -1; *out_error = mod_ret_error("这款游戏没有可用的目录建议，请手动选一个"); goto done; }
    path_mkdirs(target);
    cJSON *patch = cJSON_CreateObject();
    J_set_str(patch, "modDir", target);
    cJSON *o = G_update(mod_arg_str(args, 0, ""), patch);
    cJSON_Delete(patch); free(target);
    res = o ? o : cJSON_CreateNull();
  } else if (is_switch(channel, "games:revealMod")) {
    char *p = mod_path_from_arg(args, 0);
    reveal_in_explorer(p);
    free(p);
    res = cJSON_CreateBool(1);
  } else if (is_switch(channel, "games:deleteMod")) {
    char *p = mod_path_from_arg(args, 0);
    int ok = 0;
    if (path_is_dir(p)) {
      char cmd[MAX_PATH * 2 + 32];
      snprintf(cmd, sizeof(cmd), "cmd /c rmdir /s /q \"%s\"", p);
      g_host->run_command(cmd, 1);
      ok = !path_exists(p);
    } else ok = file_delete(p);
    free(p);
    if (!ok) { rc = -1; *out_error = mod_ret_error("删除失败（文件可能被占用）"); goto done; }
    res = cJSON_CreateBool(1);
  } else if (is_switch(channel, "games:importMods")) {
    cJSON *sources = mod_arg_at(args, 1);
    int n = cJSON_IsArray(sources) ? cJSON_GetArraySize(sources) : 0;
    cJSON *root = G_root();
    cJSON *g = G_find(root, mod_arg_str(args, 0, ""));
    cJSON *info = g ? mod_dir_info(g) : NULL;
    const char *dir = info ? J_str(info, "dir", "") : "";
    cJSON *done = cJSON_CreateArray();
    for (int i = 0; i < n; i++) {
      char *src = mod_path_from_url(cJSON_GetArrayItem(sources, i)->valuestring);
      if (!*dir) { free(src); continue; }
      path_mkdirs(dir);
      const char *bn = path_basename(src);
      char *dst = path_join(dir, bn);
      const char *se = path_ext(src);
      if (path_is_dir(src)) {
        char cmd[MAX_PATH * 3 + 64];
        snprintf(cmd, sizeof(cmd), "cmd /c xcopy /e /i /y \"%s\" \"%s\" >nul", src, dst);
        g_host->run_command(cmd, 1);
      } else if (!_stricmp(se, "zip") || !_stricmp(se, "tar") || !_stricmp(se, "gz") || !_stricmp(se, "tgz")) {
        char stem[MAX_PATH]; snprintf(stem, sizeof(stem), "%s", bn);
        char *dot = strrchr(stem, '.'); if (dot) *dot = 0;
        char *exdir = path_join(dir, stem);
        path_mkdirs(exdir);
        char cmd[MAX_PATH * 3 + 64];
        snprintf(cmd, sizeof(cmd), "tar.exe -xf \"%s\" -C \"%s\"", src, exdir);
        g_host->run_command(cmd, 1);
        free(exdir);
      } else {
        CopyFileW(u8_to_w(src), u8_to_w(dst), FALSE);
      }
      cJSON_AddItemToArray(done, cJSON_CreateString(dst));
      free(dst); free(src);
    }
    if (info) cJSON_Delete(info);
    cJSON_Delete(root);
    res = done;
  } else if (is_switch(channel, "games:packMods")) {
    const char *id = mod_arg_str(args, 0, "");
    char *target = mod_path_from_arg(args, 1);
    cJSON *root = G_root();
    cJSON *g = G_find(root, id);
    cJSON *info = g ? mod_dir_info(g) : NULL;
    const char *dir = info ? J_str(info, "dir", "") : "";
    if (!g || !*dir) {
      if (info) cJSON_Delete(info);
      cJSON_Delete(root); free(target);
      rc = -1; *out_error = mod_ret_error("这款游戏还没有 MOD 目录"); goto done;
    }
    if (!*target) {
      char *pick = g_host->pick_file("*.zip", 1, "mods.zip");
      char *nl = pick ? strchr(pick, '\n') : NULL;
      if (nl) *nl = 0;
      free(target);
      target = pick ? xstrdup(pick) : xstrdup("");
      if (pick) g_host->dealloc(pick);
    }
    if (!*target) {
      if (info) cJSON_Delete(info); cJSON_Delete(root); free(target);
      res = cJSON_CreateObject(); cJSON_AddBoolToObject(res, "canceled", 1);
      goto done;
    }
    int count = 0;
    char *pat = path_join(dir, "*");
    wchar_t *wp = u8_to_w(pat);
    WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW(wp, &fd);
    free(wp); free(pat);
    if (h != INVALID_HANDLE_VALUE) {
      do { if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) count++; } while (FindNextFileW(h, &fd));
      FindClose(h);
    }
    char cmd[MAX_PATH * 4];
    snprintf(cmd, sizeof(cmd), "tar.exe -a -c -f \"%s\" -C \"%s\" .", target, dir);
    int tr = g_host->run_command(cmd, 1);
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "file", target);
    cJSON_AddNumberToObject(o, "count", count);
    cJSON_AddNumberToObject(o, "size", (double)file_size(target));
    cJSON_AddStringToObject(o, "dir", dir);
    cJSON_AddStringToObject(o, "name", path_basename(target));
    if (tr != 0) cJSON_AddStringToObject(o, "error", "打包失败（系统没有可用的压缩器）");
    res = o;
    free(target);
    if (info) cJSON_Delete(info);
    cJSON_Delete(root);
  } else if (is_switch(channel, "games:modCode")) {
    cJSON *root = G_root();
    cJSON *g = G_find(root, mod_arg_str(args, 0, ""));
    cJSON *info = g ? mod_dir_info(g) : NULL;
    const char *dir = info ? J_str(info, "dir", "") : "";
    unsigned long long hash = 1469598103934665603ULL;
    if (*dir) {
      char *pat = path_join(dir, "*");
      wchar_t *wp = u8_to_w(pat);
      WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW(wp, &fd);
      free(wp); free(pat);
      if (h != INVALID_HANDLE_VALUE) {
        do {
          if (!wcscmp(fd.cFileName, L".") || !wcscmp(fd.cFileName, L"..")) continue;
          char *nm = w_to_u8(fd.cFileName);
          for (char *q = nm; *q; q++) { hash ^= (unsigned char)*q; hash *= 1099511628211ULL; }
          free(nm);
        } while (FindNextFileW(h, &fd));
        FindClose(h);
      }
    }
    if (info) cJSON_Delete(info); cJSON_Delete(root);
    char code[64]; snprintf(code, sizeof(code), "SGM-%016llX", hash);
    res = cJSON_CreateString(code);
  } else if (is_switch(channel, "games:compareMods")) {
    res = cJSON_CreateObject();
    cJSON_AddNumberToObject(res, "same", 0);
    cJSON_AddNumberToObject(res, "added", 0);
    cJSON_AddNumberToObject(res, "removed", 0);
  } else if (is_switch(channel, "games:workshop")) {
    const char *id = mod_arg_str(args, 0, "");
    cJSON *ml = mods_list(id, 0);
    if (!ml) { rc = -1; *out_error = mod_ret_error("游戏不存在"); goto done; }
    res = cJSON_Duplicate(obj_get(ml, "workshop"), 1);
    cJSON_Delete(ml);
  } else if (is_switch(channel, "games:openWorkshop")) {
    const char *fid = mod_arg_str(args, 1, "");
    cJSON *root = G_root();
    cJSON *g = G_find(root, mod_arg_str(args, 0, ""));
    const char *appid = g ? J_str(g, "appid", "") : "";
    char url[256];
    if (*fid) snprintf(url, sizeof(url), "steam://url/CommunityFilePage/%s", fid);
    else if (*appid) snprintf(url, sizeof(url), "steam://url/SteamWorkshopPage/%s", appid);
    else snprintf(url, sizeof(url), "steam://url/SteamWorkshopPage/");
    open_url(url);
    cJSON_Delete(root);
    res = cJSON_CreateBool(1);
  } else if (is_switch(channel, "games:openStorePage")) {
    cJSON *root = G_root();
    cJSON *g = G_find(root, mod_arg_str(args, 0, ""));
    const char *appid = g ? J_str(g, "appid", "") : "";
    char url[256];
    if (*appid) snprintf(url, sizeof(url), "https://store.steampowered.com/app/%s/", appid);
    else snprintf(url, sizeof(url), "https://store.steampowered.com/");
    open_url(url);
    cJSON_Delete(root);
    res = cJSON_CreateBool(1);
  } else if (is_switch(channel, "games:openNexusSearch") || is_switch(channel, "games:nexusTarget") ||
             is_switch(channel, "games:modBrowser")) {
    cJSON *root = G_root();
    cJSON *g = G_find(root, mod_arg_str(args, 0, ""));
    const char *name = g ? J_str(g, "name", "") : "";
    char *q = url_encode(name);
    char url[1024];
    snprintf(url, sizeof(url), "https://www.nexusmods.com/search/?gsearch=%s", q);
    free(q);
    open_url(url);
    cJSON_Delete(root);
    res = cJSON_CreateObject();
    cJSON_AddStringToObject(res, "url", url);
  } else if (is_switch(channel, "games:modDownloadCfg")) {
    cJSON *s = mod_store_get("settings");
    cJSON *md = s ? obj_get(s, "modDownload") : NULL;
    res = md ? cJSON_Duplicate(md, 1) : cJSON_CreateObject();
    if (s) cJSON_Delete(s);
  } else if (is_switch(channel, "games:modBrowserSystemOpen")) {
    const char *u = mod_arg_str(args, 0, "");
    if (str_starts(u, "http")) open_url(u);
    res = cJSON_CreateBool(1);
  } else if (is_switch(channel, "games:platformCatsInfo")) {
    res = cJSON_CreateObject();
    cJSON_AddNumberToObject(res, "total", 0);
  } else if (is_switch(channel, "games:syncPlatformCats")) {
    res = cJSON_CreateObject();
    cJSON_AddNumberToObject(res, "updated", 0);
  } else if (is_switch(channel, "platform:overview")) {
    /* 平台总览：7 个平台 + 本机检测 */
    cJSON *arr = cJSON_CreateArray();
    const char *ids[] = { "steam", "epic", "ubisoft", "gog", "battlenet", "ea", "xbox" };
    cJSON *root = G_root();
    cJSON *list = obj_get(root, "list");
    char *steamroot = steam_root_find();
    cJSON *steamLib = NULL;
    int steamTotal = 0;
    double steamMinutes = 0;
    if (steamroot) {
      steam_library_cache(&steamLib, NULL, NULL);
      if (steamLib) {
        steamTotal = cJSON_GetArraySize(steamLib);
        cJSON *sg = NULL;
        cJSON_ArrayForEach(sg, steamLib) steamMinutes += J_num(sg, "minutes", 0);
      }
    }
    for (int i = 0; i < 7; i++) {
      cJSON *o = cJSON_CreateObject();
      cJSON_AddStringToObject(o, "id", ids[i]);
      cJSON_AddStringToObject(o, "name", platform_name(ids[i]));
      cJSON_AddStringToObject(o, "color", platform_color(ids[i]));
      int installed = 0;
      char client[MAX_PATH] = "";
      if (!strcmp(ids[i], "steam") && steamroot) { installed = 1; snprintf(client, sizeof(client), "%s\\steam.exe", steamroot); }
      else if (!strcmp(ids[i], "epic")) {
        char pd[MAX_PATH]; snprintf(pd, sizeof(pd), "%s", getenv("ProgramData") ? getenv("ProgramData") : "C:\\ProgramData");
        char *m = path_join(pd, "Epic\\EpicGamesLauncher\\Data\\Manifests");
        if (path_exists(m)) installed = 1;
        free(m);
      }
      json_set_bool(o, "installed", installed);
      if (steamroot && !strcmp(ids[i], "steam")) cJSON_AddStringToObject(o, "installPath", steamroot);
      cJSON_AddStringToObject(o, "clientPath", client);
      int count = 0, libs = 0;
      int64_t size = 0, playtime = 0;
      cJSON *it = NULL;
      cJSON_ArrayForEach(it, list) {
        if (strcmp(J_str(it, "platform", "local"), ids[i])) continue;
        count++;
        if (J_int(it, "installed", 1)) libs++;
        size += (int64_t)J_num(it, "size", 0);
        playtime += (int64_t)J_num(it, "playTime", 0);
      }
      cJSON *stats = cJSON_CreateObject();
      if (!strcmp(ids[i], "steam") && steamTotal > 0) {
        cJSON_AddNumberToObject(stats, "games", libs);          /* 本机已安装 */
        cJSON_AddNumberToObject(stats, "libraryGames", steamTotal > count ? steamTotal : count); /* 账号完整库 */
        cJSON_AddNumberToObject(stats, "size", (double)size);
        cJSON_AddNumberToObject(stats, "playtime", steamMinutes > playtime ? steamMinutes : (double)playtime);
      } else {
        cJSON_AddNumberToObject(stats, "games", count);
        cJSON_AddNumberToObject(stats, "libraryGames", count);
        cJSON_AddNumberToObject(stats, "size", (double)size);
        cJSON_AddNumberToObject(stats, "playtime", (double)playtime);
      }
      cJSON_AddItemToObject(o, "stats", stats);
      cJSON *acc = (!strcmp(ids[i], "steam")) ? steam_accounts() : cJSON_CreateArray();
      int nacc = cJSON_GetArraySize(acc);
      cJSON_AddItemToObject(o, "accounts", acc);
      cJSON_AddItemToObject(o, "account", nacc ? cJSON_Duplicate(cJSON_GetArrayItem(acc, 0), 1) : cJSON_CreateNull());
      if (!installed) cJSON_AddStringToObject(o, "note", "未检测到客户端");
      else if (!strcmp(ids[i], "steam") && !nacc) cJSON_AddStringToObject(o, "note", "未读到 Steam 登录账号（需要 config/loginusers.vdf）");
      else cJSON_AddStringToObject(o, "note", "");
      cJSON_AddItemToArray(arr, o);
    }
    free(steamroot);
    cJSON_Delete(steamLib);
    cJSON_Delete(root);
    res = arr;
  } else if (is_switch(channel, "platform:syncSteam")) {
    cJSON *lib = steam_sync_library(1, 7000);
    int n = lib ? cJSON_GetArraySize(lib) : 0;
    cJSON_Delete(lib);
    res = cJSON_CreateObject();
    json_set_bool(res, "ok", n > 0);
    cJSON_AddNumberToObject(res, "count", n);
    if (!n) cJSON_AddStringToObject(res, "error", "没能读取 Steam 账号库（资料页不可见或网络受限）");
  } else if (is_switch(channel, "platform:detail")) {
    cJSON *opts = mod_arg_obj(args, 0);
    const char *pid = opts ? J_str(opts, "platformId", "") : "";
    cJSON *root = G_root();
    cJSON *list = obj_get(root, "list");
    cJSON *games = cJSON_CreateArray();
    int installedCount = 0;
    int64_t playtime = 0;
    cJSON *it = NULL;
    int force = opts ? json_bool(opts, "force", 0) : 0;
    cJSON *steamLib = NULL;
    if (!strcmp(pid, "steam")) steam_library_cache(&steamLib, NULL, NULL);
    (void)force;
    int steamAccount = steamLib ? 1 : 0;
    if (steamLib) {
      cJSON *sg = NULL;
      cJSON_ArrayForEach(sg, steamLib) {
        const char *appid = J_str(sg, "appid", "");
        if (!*appid) continue;
        cJSON *o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "appid", appid);
        cJSON_AddStringToObject(o, "name", J_str(sg, "name", ""));
        cJSON_AddStringToObject(o, "gid", "");
        char curl[256];
        snprintf(curl, sizeof(curl), "https://cdn.cloudflare.steamstatic.com/steam/apps/%s/library_600x900.jpg", appid);
        cJSON_AddStringToObject(o, "cover", curl);
        json_set_bool(o, "installed", 0);
        json_set_bool(o, "inLibrary", 1);
        json_set_int(o, "playtime", (int64_t)J_num(sg, "minutes", 0));
        json_set_int(o, "lastPlayed", 0);
        json_set_int(o, "size", 0);
        cJSON_AddItemToArray(games, o);
      }
      /* 把本机已安装记录并进去：同一个 appid 就补 path/大小/图标，没进账号库的也补一款 */
      cJSON_ArrayForEach(it, list) {
        if (strcmp(J_str(it, "platform", "local"), pid)) continue;
        char *aid = steam_appid_from_game(it);
        cJSON *match = NULL;
        if (aid && *aid) {
          cJSON *g2 = NULL;
          cJSON_ArrayForEach(g2, games) if (!strcmp(J_str(g2, "appid", ""), aid)) { match = g2; break; }
        }
        if (match) {
          json_set_bool(match, "installed", 1);
          J_set_str(match, "gid", J_str(it, "id", ""));
          json_set_int(match, "size", (int64_t)J_num(it, "size", 0));
          if ((int64_t)J_num(it, "lastPlayed", 0) > 0) json_set_int(match, "lastPlayed", (int64_t)J_num(it, "lastPlayed", 0));
          int64_t pt = (int64_t)J_num(it, "playTime", 0);
          if (pt > (int64_t)J_num(match, "playtime", 0)) json_set_int(match, "playtime", pt);
          installedCount++;
        } else {
          cJSON *o = cJSON_CreateObject();
          cJSON_AddStringToObject(o, "appid", aid ? aid : J_str(it, "appid", ""));
          cJSON_AddStringToObject(o, "name", J_str(it, "name", ""));
          cJSON_AddStringToObject(o, "gid", J_str(it, "id", ""));
          cJSON_AddStringToObject(o, "cover", J_str(it, "cover", ""));
          json_set_bool(o, "installed", 1);
          json_set_bool(o, "inLibrary", 1);
          json_set_int(o, "playtime", (int64_t)J_num(it, "playTime", 0));
          json_set_int(o, "lastPlayed", (int64_t)J_num(it, "lastPlayed", 0));
          json_set_int(o, "size", (int64_t)J_num(it, "size", 0));
          cJSON_AddItemToArray(games, o);
          installedCount++;
        }
        free(aid);
      }
      cJSON_ArrayForEach(it, games) playtime += (int64_t)J_num(it, "playtime", 0);
      cJSON_Delete(steamLib);
    } else {
      cJSON_ArrayForEach(it, list) {
        if (strcmp(J_str(it, "platform", "local"), pid)) continue;
        cJSON *o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "appid", J_str(it, "appid", ""));
        cJSON_AddStringToObject(o, "name", J_str(it, "name", ""));
        cJSON_AddStringToObject(o, "gid", J_str(it, "id", ""));
        cJSON_AddStringToObject(o, "cover", J_str(it, "cover", ""));
        json_set_bool(o, "installed", J_int(it, "installed", 1));
        json_set_bool(o, "inLibrary", 1);
        json_set_int(o, "playtime", J_int(it, "playTime", 0));
        json_set_int(o, "lastPlayed", (int64_t)J_num(it, "lastPlayed", 0));
        json_set_int(o, "size", (int64_t)J_num(it, "size", 0));
        if (J_int(it, "installed", 1)) installedCount++;
        playtime += (int64_t)J_num(it, "playTime", 0);
        cJSON_AddItemToArray(games, o);
      }
    }
    /* 同一 appid 可能同时来自 Steam 扫描和注册表，列表已去重；
       已安装数也要按去重后的列表算，不能按原始记录数 */
    installedCount = 0;
    cJSON_ArrayForEach(it, games) if (json_bool(it, "installed", 0)) installedCount++;
    cJSON *out = cJSON_CreateObject();
    cJSON_AddStringToObject(out, "id", pid);
    cJSON_AddStringToObject(out, "name", platform_name(pid));
    cJSON_AddNumberToObject(out, "total", cJSON_GetArraySize(games));
    cJSON_AddNumberToObject(out, "installedCount", installedCount);
    cJSON_AddNumberToObject(out, "playtime", (double)playtime);
    json_set_bool(out, "accountLibrary", steamAccount);
    cJSON_AddItemToObject(out, "games", games);
    cJSON *acc2 = !strcmp(pid, "steam") ? steam_accounts() : cJSON_CreateArray();
    int n2 = cJSON_GetArraySize(acc2);
    cJSON_AddItemToObject(out, "accounts", acc2);
    cJSON_AddItemToObject(out, "account", n2 ? cJSON_Duplicate(cJSON_GetArrayItem(acc2, 0), 1) : cJSON_CreateNull());
    cJSON_Delete(root);
    res = out;
  } else if (is_switch(channel, "platform:openClient")) {
    const char *pid = mod_arg_str(args, 0, "");
    char url[512];
    if (!strcmp(pid, "steam")) snprintf(url, sizeof(url), "steam://open/main");
    else if (!strcmp(pid, "epic")) snprintf(url, sizeof(url), "com.epicgames.launcher://apps");
    else url[0] = 0;
    if (*url) open_url(url);
    res = cJSON_CreateBool(1);
  } else if (is_switch(channel, "platform:install")) {
    cJSON *o = mod_arg_obj(args, 0);
    const char *appid = o ? J_str(o, "appid", "") : "";
    if (*appid && (!o || !strcmp(J_str(o, "platform", "steam"), "steam"))) {
      char url[128]; snprintf(url, sizeof(url), "steam://install/%s", appid);
      open_url(url);
    }
    res = cJSON_CreateBool(1);
  } else if (is_switch(channel, "platform:openApp")) {
    cJSON *o = mod_arg_obj(args, 0);
    const char *appid = o ? J_str(o, "appid", "") : "";
    if (*appid) {
      char url[128]; snprintf(url, sizeof(url), "steam://rungameid/%s", appid);
      open_url(url);
    }
    res = cJSON_CreateBool(1);
  } else if (is_switch(channel, "platform:applySteam")) {
    res = cJSON_CreateObject();
    cJSON_AddNumberToObject(res, "applied", 0);
  } else if (is_switch(channel, "hidden:info")) {
    hidden_check_lock();
    cJSON *h = H_root();
    res = cJSON_CreateObject();
    json_set_bool(res, "enabled", J_int(h, "enabled", 0));
    cJSON_AddStringToObject(res, "name", J_str(h, "name", "隐藏空间"));
    cJSON_AddStringToObject(res, "hint", J_str(h, "hint", ""));
    cJSON_AddNumberToObject(res, "autoLockMinutes", J_int(h, "autoLockMinutes", 10));
    json_set_bool(res, "unlocked", g_unlocked);
    cJSON_AddNumberToObject(res, "spaceCount", cJSON_GetArraySize(obj_get(h, "space")));
    cJSON_Delete(h);
  } else if (is_switch(channel, "hidden:setup")) {
    cJSON *o = mod_arg_obj(args, 0);
    const char *pwd = o ? J_str(o, "password", "") : "";
    if (strlen(pwd) < 1) { rc = -1; *out_error = mod_ret_error("密码不能为空"); goto done; }
    cJSON *h = H_root();
    char salt[33];
    for (int i = 0; i < 32; i++) salt[i] = "0123456789abcdef"[rand() % 16];
    salt[32] = 0;
    char *hash = hash_pwd(salt, pwd);
    json_set_bool(h, "enabled", 1);
    J_set_str(h, "name", o ? J_str(o, "name", "隐藏空间") : "隐藏空间");
    J_set_str(h, "hint", o ? J_str(o, "hint", "") : "");
    J_set_str(h, "salt", salt);
    J_set_str(h, "pwd", hash);
    free(hash);
    mod_store_set("hidden", h);
    cJSON_Delete(h);
    g_unlocked = 1;
    g_last_active = now_ms();
    res = cJSON_CreateBool(1);
  } else if (is_switch(channel, "hidden:unlock")) {
    const char *pwd = mod_arg_str(args, 0, "");
    cJSON *h = H_root();
    char *hash = hash_pwd(J_str(h, "salt", ""), pwd);
    int ok = !strcmp(hash, hidden_stored(h));
    free(hash);
    cJSON_Delete(h);
    if (!ok) { rc = -1; *out_error = mod_ret_error("密码不对"); goto done; }
    g_unlocked = 1;
    g_last_active = now_ms();
    res = cJSON_CreateBool(1);
  } else if (is_switch(channel, "hidden:lock")) {
    g_unlocked = 0;
    mod_emit_json("hidden:locked", "{}");
    res = cJSON_CreateBool(1);
  } else if (is_switch(channel, "hidden:activity")) {
    if (g_unlocked) g_last_active = now_ms();
    hidden_check_lock();
    res = cJSON_CreateBool(1);
  } else if (is_switch(channel, "hidden:changePassword")) {
    cJSON *o = mod_arg_obj(args, 0);
    const char *oldp = o ? J_str(o, "oldPwd", "") : "";
    const char *newp = o ? J_str(o, "newPwd", "") : "";
    cJSON *h = H_root();
    char *hash = hash_pwd(J_str(h, "salt", ""), oldp);
    int ok = !strcmp(hash, hidden_stored(h));
    free(hash);
    if (!ok) { cJSON_Delete(h); rc = -1; *out_error = mod_ret_error("原密码不对"); goto done; }
    if (!strcmp(newp, oldp)) {
      J_set_str(h, "hint", o ? J_str(o, "hint", J_str(h, "hint", "")) : J_str(h, "hint", ""));
      J_set_str(h, "name", o ? J_str(o, "name", J_str(h, "name", "隐藏空间")) : J_str(h, "name", "隐藏空间"));
    } else {
      char salt[33];
      for (int i = 0; i < 32; i++) salt[i] = "0123456789abcdef"[rand() % 16];
      salt[32] = 0;
      char *nh = hash_pwd(salt, newp);
      J_set_str(h, "salt", salt); J_set_str(h, "pwd", nh); free(nh);
      if (o) { J_set_str(h, "hint", J_str(o, "hint", "")); J_set_str(h, "name", J_str(o, "name", "隐藏空间")); }
    }
    mod_store_set("hidden", h);
    cJSON_Delete(h);
    res = cJSON_CreateBool(1);
  } else if (is_switch(channel, "hidden:disable")) {
    const char *pwd = mod_arg_str(args, 0, "");
    cJSON *h = H_root();
    char *hash = hash_pwd(J_str(h, "salt", ""), pwd);
    int ok = !strcmp(hash, hidden_stored(h));
    free(hash);
    if (!ok) { cJSON_Delete(h); rc = -1; *out_error = mod_ret_error("密码不对"); goto done; }
    json_set_bool(h, "enabled", 0);
    J_set(h, "space", cJSON_CreateArray());
    mod_store_set("hidden", h);
    cJSON_Delete(h);
    g_unlocked = 0;
    /* 清掉 18+ 标记 */
    cJSON *root = G_root();
    cJSON *list = obj_get(root, "list"), *it = NULL;
    cJSON_ArrayForEach(it, list) {
      cJSON *cs = cats_of(it);
      int has = cats_has(cs, ADULT_CAT);
      cJSON_Delete(cs);
      if (!has) continue;
      json_set_bool(it, "hidden", 0);
    }
    G_save(root); cJSON_Delete(root);
    res = cJSON_CreateBool(1);
  } else if (is_switch(channel, "hidden:items")) {
    cJSON *h = H_root();
    res = cJSON_Duplicate(obj_get(h, "space"), 1);
    cJSON_Delete(h);
  } else if (is_switch(channel, "hidden:addItem")) {
    cJSON *h = H_root();
    cJSON *o = cJSON_Duplicate(mod_arg_obj(args, 0), 1);
    if (!o) o = cJSON_CreateObject();
    json_set_int(o, "addedAt", now_ms());
    cJSON_AddItemToArray(obj_get(h, "space"), o);
    mod_store_set("hidden", h);
    cJSON_Delete(h);
    res = cJSON_CreateBool(1);
  } else if (is_switch(channel, "hidden:removeItem")) {
    const char *id = mod_arg_str(args, 0, "");
    cJSON *h = H_root();
    cJSON *space = obj_get(h, "space"), *out = cJSON_CreateArray();
    cJSON *it = NULL;
    cJSON_ArrayForEach(it, space) if (strcmp(J_str(it, "id", ""), id)) cJSON_AddItemToArray(out, cJSON_Duplicate(it, 1));
    J_set(h, "space", out);
    mod_store_set("hidden", h);
    cJSON_Delete(h);
    res = cJSON_CreateBool(1);
  } else {
    rc = -1;
    *out_error = mod_ret_error("游戏模块没有这个方法：%s", channel);
    goto done;
  }

  *out_json = mod_ret_json(res ? res : cJSON_CreateNull());
done:
  cJSON_Delete(args);
  return rc;
}

/* ============================================================
 *  dll 入口
 * ============================================================ */
static int games_init(const SgjHostApi *h) {
  mod_set_host(h);
  run_init();
  hidden_check_lock();
  return 0;
}
static void games_shutdown(void) {}

SGJ_MODULE_EXPORT const SgjModule *sgj_module_entry(void) {
  if (!g_manifest) {
    g_manifest = mod_res_dup(L"MANIFEST");
    g_js = mod_res_dup(L"UI_JS");
  }
  g_mod.abi = SGJ_ABI;
  g_mod.id = "games";
  g_mod.manifest_json = g_manifest;
  g_mod.renderer_js = g_js;
  g_mod.style_css = NULL;
  g_mod.init = games_init;
  g_mod.shutdown = games_shutdown;
  g_mod.invoke = games_invoke;
  return &g_mod;
}
