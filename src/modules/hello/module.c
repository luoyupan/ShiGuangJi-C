/* ============================================================
 * 拾光集 · 第三方 dll 插件示例 (hello.dll)
 * ------------------------------------------------------------
 * 把 hello.dll 丢进 modules/ 目录，主界面就多一张「示例插件」卡。
 * 这一个文件同时演示：
 *   · 清单 / 界面 / 后端都在 dll 里
 *   · 界面用 SGJPlugin.define() 注册，路由 #/p/hello
 *   · api.call('greet', '名字') → 本文件的 sgj_invoke
 *   · 私有存储 api.getItem()/setItem() → plugin-data
 * ============================================================ */
#include "../module_common.h"

static const char *g_manifest = NULL;
static const char *g_js = NULL;
static const char *g_css = NULL;
static SgjModule g_mod;

static int hello_init(const SgjHostApi *h) {
  mod_set_host(h);
  return 0;
}
static void hello_shutdown(void) { }

static int hello_invoke(const char *channel, const char *args_json, char **out_json, char **out_error) {
  cJSON *args = mod_parse_args(args_json);
  int rc = 0;
  if (!strcmp(channel, "hello:greet")) {
    const char *who = mod_arg_str(args, 0, "朋友");
    cJSON *o = cJSON_CreateObject();
    char buf[512];
    snprintf(buf, sizeof(buf), "你好，%s！这条消息来自 hello.dll 里的 C 代码。", who);
    cJSON_AddStringToObject(o, "msg", buf);
    cJSON_AddStringToObject(o, "engine", "native C dll");
    cJSON_AddNumberToObject(o, "abi", SGJ_ABI);
    *out_json = mod_ret_json(o);
  } else if (!strcmp(channel, "hello:info")) {
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "id", "hello");
    cJSON_AddStringToObject(o, "version", "1.0.0");
    cJSON_AddStringToObject(o, "tip", "删掉 modules\\hello.dll，这一页和主界面卡片就一起消失。");
    *out_json = mod_ret_json(o);
  } else {
    *out_error = mod_ret_error("hello.dll 没有这个方法：%s", channel);
    rc = -1;
  }
  cJSON_Delete(args);
  return rc;
}

SGJ_MODULE_EXPORT const SgjModule *sgj_module_entry(void) {
  if (!g_manifest) {
    g_manifest = mod_res_dup(L"MANIFEST");
    g_js = mod_res_dup(L"UI_JS");
    g_css = mod_res_dup(L"UI_CSS");
  }
  g_mod.abi = SGJ_ABI;
  g_mod.id = "hello";
  g_mod.manifest_json = g_manifest;
  g_mod.renderer_js = g_js;
  g_mod.style_css = g_css && *g_css ? g_css : NULL;
  g_mod.init = hello_init;
  g_mod.shutdown = hello_shutdown;
  g_mod.invoke = hello_invoke;
  return &g_mod;
}
