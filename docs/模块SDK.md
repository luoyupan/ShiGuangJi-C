# 模块 dll 开发指南（C ABI v2）

拾光集 C 版的「模块」就是一个 **PE dll**。主程序启动时扫描 `modules\*.dll`，
`LoadLibrary` 后取导出函数 `sgj_module_entry`，校验 ABI，读清单，然后：

- 主界面按清单生成卡片；
- 点卡片进入 `#/p/<id>`（第三方）或内置路由（`#/games` 等）；
- 界面的 `SGJ.<模块>.<方法>` 调用被宿主 POST 到 `/api`，按清单里的频道前缀路由到 dll 的
  `invoke`。

一个 dll 里可以同时带：**清单 + C 后端 + 界面 JS + CSS**。删掉 dll = 删掉整个模块；
放进去 = 多一个模块。没有注册表、没有安装程序。

> ⚠️ **没有沙箱。** dll 是本机机器码，加载即拥有当前用户权限。只放你信得过的 dll。

---

## 1. 最小示例

`src/modules/hello/` 就是完整示例（构建产物 `build/modules/hello.dll`）：

```
hello/
  module.json     清单
  module.c        C 后端 + 导出入口
  renderer.js     界面（会被编进 dll 的 UI_JS 资源）
  style.css       可选（UI_CSS 资源）
```

### 1.1 清单 `module.json`

```json
{
  "id": "hello",
  "route": "#/p/hello",
  "title": "示例插件",
  "desc": "第三方 dll 插件 · 加一个 dll 就多一个模块",
  "icon": "extension",
  "accent": "#8b46ff",
  "order": 90,
  "detail": "卡片详情里的一句话",
  "builtin": false,
  "channels": ["hello:"],
  "version": "1.0.0",
  "author": "拾光集"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 唯一；重复会跳过并记错误 |
| `route` | ✅ | 第三方用 `#/p/<id>`；内置用 `#/games` 等 |
| `title` / `desc` / `icon` / `accent` / `order` | ✅/推荐 | 卡片外观；`icon` 取 `icons.js` 里的名字 |
| `builtin` | | `true` = 内置模块（进「设置 → 插件」的内置组） |
| `channels` | | 这个 dll 接管的 IPC 频道前缀，如 `["hello:"]`、`["games:","platform:"]` |
| `version` / `author` | | 第三方插件页会显示 |

### 1.2 C 入口

```c
#include "../module_common.h"   // 宿主公共头（sgj.h + 资源/参数/返回辅助）

static const char *g_manifest = NULL;
static const char *g_js = NULL;
static SgjModule g_mod;

static int hello_init(const SgjHostApi *host) {
  mod_set_host(host);          // 保存宿主服务表
  return 0;                    // 非 0 = 加载失败（主界面仍会启动）
}

static int hello_invoke(const char *channel, const char *args_json,
                        char **out_json, char **out_error) {
  cJSON *args = mod_parse_args(args_json);   // 参数是 JSON 数组，对应 JS 的 ...args
  if (!strcmp(channel, "hello:greet")) {
    const char *who = mod_arg_str(args, 0, "朋友");
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "msg", "你好！");
    cJSON_AddStringToObject(o, "who", who);
    *out_json = mod_ret_json(o);             // 用宿主 alloc 分配，宿主负责释放
  } else {
    *out_error = mod_ret_error("没有这个方法：%s", channel);
    cJSON_Delete(args);
    return -1;
  }
  cJSON_Delete(args);
  return 0;
}

SGJ_MODULE_EXPORT const SgjModule *sgj_module_entry(void) {
  if (!g_manifest) {                          // 资源只读一次
    g_manifest = mod_res_dup(L"MANIFEST");    // module.json
    g_js = mod_res_dup(L"UI_JS");             // renderer.js（可选）
  }
  g_mod.abi = SGJ_ABI;                        // 2
  g_mod.id = "hello";
  g_mod.manifest_json = g_manifest;
  g_mod.renderer_js = g_js;
  g_mod.style_css = NULL;                     // 有 style.css 就返回它
  g_mod.init = hello_init;
  g_mod.shutdown = NULL;
  g_mod.invoke = hello_invoke;
  return &g_mod;
}
```

### 1.3 界面 `renderer.js`

第三方模块的界面由宿主当普通 `<script>` 加载（**不是** `eval`，CSP 只放行 `'self'`）。
它必须调用一次 `SGJPlugin.define`：

```js
SGJPlugin.define({
  id: 'hello',
  apiVersion: 1,
  mount(container, api) {
    const { el } = window.util;
    container.appendChild(el('h3', { text: '你好' }));
    const out = el('div');
    container.appendChild(el('button', {
      class: 'btn btn-primary',
      text: '问个好吧',
      onclick: async () => {
        const r = await api.call('greet', '小明');   // → hello:greet
        out.textContent = r.msg + ' ' + r.who;
      }
    }));
    container.appendChild(out);
    return () => {};       // 可选：卸载清理
  }
});
```

`api` 提供：`call(method, ...args)`、`getItem()/setItem(patch)`（私有存储）、
`on(event, cb)`、`el/icon/toast/go/theme/accent/log`。

---

## 2. ABI

`src/host/sgj.h` 中的定义（**不要在插件里重复定义，直接 include**）：

```c
typedef struct SgjHostApi SgjHostApi;   // 宿主服务表，只读
typedef struct SgjModule SgjModule;

struct SgjModule {
  int abi;                     // 必须 == SGJ_ABI（当前 2）
  const char *id;              // 与清单 id 一致
  const char *manifest_json;   // UTF-8 JSON，NUL 结尾
  const char *renderer_js;     // 可选，UTF-8，NUL 结尾
  const char *style_css;       // 可选
  int (*init)(const SgjHostApi *host);
  void (*shutdown)(void);
  int (*invoke)(const char *channel, const char *args_json,
                char **out_json, char **out_error);
};

__declspec(dllexport) const SgjModule *sgj_module_entry(void);
```

约定：

- `invoke` 返回 `0` 成功、非 0 失败；成功写 `*out_json`，失败写 `*out_error`；
- **两个输出串都必须用 `host->alloc` 分配**（宿主用 `HeapFree` 释放，跨 CRT 安全）；
- 模块内部自己的 `malloc/free` 只在自己 dll 里成对使用；
- `init` 失败返回非 0，宿主记错误并继续启动；
- `invoke` 会被宿主串行调用（同一时刻一个方法）；要并发请模块自己起线程；
- 模块可以调用 `host->emit("mod:<id>:事件", "json")` 主动推事件（前缀 `mod:` 已在白名单）。

### 宿主服务（`SgjHostApi`）

| 字段 | 用途 |
|---|---|
| `alloc/dealloc` | 跨 dll 安全的分配（输出串必须用它） |
| `read_text/write_text/file_exists/ensure_dir` | UTF-8 路径文件操作 |
| `data_dir/app_dir` | `%APPDATA%\shiguangji` / exe 目录 |
| `http_request` | WinHTTP GET/POST，返回响应体（可带 headers/body/超时/状态码） |
| `store_get/set/merge` | 读写 `shiguangji.json` 的命名空间（JSON 文本） |
| `emit` | 向界面推事件（SSE） |
| `pick_folder/pick_file/message_box` | 原生对话框（工作线程安全） |
| `open_path/open_url/reveal/notify` | Shell 操作 |
| `proc_running/run_command` | 进程检测 / 起隐藏进程 |
| `local_url` | 本地路径 → 前端可用的 `http://…/local/…` URL |

完整定义以 `src/host/sgj.h` 为准。

---

## 3. 资源：清单和界面怎么进 dll

`build.ps1` 会为每个模块生成一个 `.rc`：

```rc
#pragma code_page(65001)
MANIFEST RCDATA "…\module.json"
UI_JS    RCDATA "…\gen\hello.js"       // renderer.js 原样
UI_CSS   RCDATA "…\style.css"          // 可选
```

模块入口里用 `mod_res_dup(L"MANIFEST")` 等取出（资源块本身不保证 NUL 结尾，helper 会复制）。
宿主通过 `GET /mod/<id>/renderer.js` 和 `/mod/<id>/style.css` 把资源发给界面；
**不需要**把 js 文件放在 exe 旁边。

`hello` 的构建映射在 `build.ps1` 的 `$mods` 表里；加新模块时加一行：

```powershell
"myplugin" = @(@("src\modules\myplugin\renderer.js"), "src\modules\myplugin\style.css")
```

编译命令会把 `module.c + module_common.c + sgj.c + cJSON.c + 资源` 一起链成
`build\modules\myplugin.dll`（`/MT` 静态 CRT，不依赖 VC 运行库）。

---

## 4. 频道与命名

- 内置模块用 `<模块id>:` 前缀：`games:`、`music:`、`photos:`……
- 一个 dll 可以声明多个前缀（`games.dll` 同时管 `games:`、`platform:`、`hidden:`）；
- 匹配按**最长前缀**优先，所以 `mods.dll` 可以抢 `games:mods` 而不影响 `games:` 其它方法；
- 第三方插件推荐只用自己的 id：`helloworld:doSomething`；
- 前端拿到的返回会进 `{ok:true,data}` / `{ok:false,error}` 包，异常会变成 `throw`。

---

## 5. 安装 / 卸载

1. 把 `myplugin.dll` 放进 `ShiGuangJi.exe` 同级的 `modules\`；
2. 重启（内置模块的渲染层在启动时加载）或刷新（第三方模块走 `SGJPlugin` 懒加载）；
3. 主界面出现卡片；设置 → 插件里的第三方组也能开关；
4. 卸载 = 删 dll（可选：一起删 `%APPDATA%\shiguangji\plugin-data` 里它的私有数据）。

同一个 `id` 出现两次时，后扫到的不会生效，设置页会写「id 跟 xxx 重复了」。

---

## 6. 调试

- `ShiGuangJi.exe --dev` → WebView2 远程调试端口 9333：
  `http://127.0.0.1:9333/json` 能看到「应用界面」和「浏览器画布」两个 target。
- 模块 `init` 失败、清单错、ABI 不匹配都会出现在
  `%LOCALAPPDATA%\ShiGuangJi-C\logs\app.log` 与界面「设置 → 插件」的错误列表里。
- C 侧崩溃没有沙箱兜底：先用 `--data-dir` 指向测试库，再加 `OutputDebugString`/日志。
