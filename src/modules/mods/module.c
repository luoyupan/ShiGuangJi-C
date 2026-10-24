/* ============================================================
 * 拾光集 · MOD 模块 (mods.dll)
 * ------------------------------------------------------------
 * MOD 的数据与 IPC 仍在 games 模块里（历史原因：MOD 是游戏库的一部分），
 * 这个 dll 负责自己的界面与卡片。把它删掉，MOD 这一页和主界面卡片就没了，
 * 而游戏库里的 MOD 记录/文件一个都不会动。
 * ============================================================ */
#include "../module_common.h"

static const char *g_manifest = NULL;
static const char *g_js = NULL;
static SgjModule g_mod;

static int mods_init(const SgjHostApi *h) { mod_set_host(h); return 0; }
static void mods_shutdown(void) { }

static int mods_invoke(const char *channel, const char *args_json, char **out_json, char **out_error) {
  (void)channel; (void)args_json; (void)out_json;
  *out_error = mod_ret_error("MOD 模块的 IPC 由 games.dll 提供（games:mods / games:toggleMod …）");
  return -1;
}

SGJ_MODULE_EXPORT const SgjModule *sgj_module_entry(void) {
  if (!g_manifest) { g_manifest = mod_res_dup(L"MANIFEST"); g_js = mod_res_dup(L"UI_JS"); }
  g_mod.abi = SGJ_ABI;
  g_mod.id = "mods";
  g_mod.manifest_json = g_manifest;
  g_mod.renderer_js = g_js;
  g_mod.style_css = NULL;
  g_mod.init = mods_init;
  g_mod.shutdown = mods_shutdown;
  g_mod.invoke = mods_invoke;
  return &g_mod;
}
