/**
 * 拾光集 · 全局状态 (state.js)
 * 缓存设置 / 用户档案 / 模块表，并负责把外观设置应用到 <html>。
 */
'use strict';

const State = {
  settings: null,
  profile: { nickname: '主人' },
  /** 主界面卡片（= 已启用的插件，顺序按插件清单的 order） */
  modules: [],
  /** 插件全量 + 开关（第四十九轮）：标题栏面包屑、路由拦截、设置页开关都读它 */
  plugins: { list: [], enabled: [], total: 0, preset: null },
  info: null,

  async load() {
    this.info = await API.raw.info().catch(() => null);
    this.settings = await API.raw.settings.get().catch(() => ({}));
    this.profile = await API.raw.profile.get().catch(() => ({ nickname: '主人' }));
    await this.refreshPlugins();
    this.applyTheme();
    return this;
  },

  /**
   * 只重取「插件表」（第四十九轮 / 第五十轮扩充）。
   * 开关插件后主界面卡片要跟着变，但没必要把设置 / 档案 / 主题整套重读一遍
   * —— 那会顺带重刷主题，把用户当前正在改的外观设置闪一下。
   *
   * 两张表合成一份 `list`：**内置模块**（plugins.js 的清单）在前，**第三方插件**
   * （从插件目录扫出来的）在后。合并之后 `route()` 的拦截、标题栏面包屑、主界面卡片
   * 全都免费支持第三方插件 —— 它们走的是一模一样的字段（id/route/title/enabled）。
   *
   * ⚠️ 这里顺手把 `modules` 也算出来：`plugins:list` 里每一项和 `hub:modules`
   *    返回的卡片字段是同一份，少发一次 IPC。真拿不到就退回 `hub:modules`。
   */
  async refreshPlugins() {
    const r = await API.raw.plugins.list().catch(() => null);
    if (r && Array.isArray(r.list)) {
      const builtin = r.list.map((p) => Object.assign({ kind: 'builtin' }, p));
      const ext = (Array.isArray(r.ext) ? r.ext : []).map((p) => Object.assign({ kind: 'ext' }, p));
      const list = builtin.concat(ext);
      const enabled = list.filter((p) => p.enabled);
      this.plugins = {
        list,
        builtin,
        ext,
        enabled: enabled.map((p) => p.id),
        /* 扫描插件目录时的问题（清单坏了 / apiVersion 不符 / 主进程加载失败…）。
           设置页要照实列出来 —— 静默吞掉就是「装了看不见也不知道为什么」。 */
        errors: r.errors || [],
        dir: r.dir || '',
        apiVersion: r.apiVersion || 1,
        /* 第五十二轮：模块版 exe 的打包预设（['music'] 之类）；普通版是 null */
        preset: Array.isArray(r.preset) && r.preset.length ? r.preset.slice() : null,
        total: builtin.length
      };
      this.modules = enabled;
    } else {
      this.modules = await API.raw.modules().catch(() => this.modules);
    }
    return this.plugins;
  },

  /** 兼容旧调用名：只要能拿到最新模块表就行 */
  async refreshModules() {
    await this.refreshPlugins();
    return this.modules;
  },

  applyTheme() {
    const s = this.settings || {};
    const html = document.documentElement;
    html.setAttribute('data-theme', s.theme === 'dark' ? 'dark' : 'light');
    if (s.accent) {
      html.style.setProperty('--accent', s.accent);
      html.style.setProperty('--accent-2', s.accent);
    }
    html.style.setProperty('--font-scale', s.fontScale || 1);
    if (s.background && s.background.content) {
      html.style.setProperty('--hub-bg', `url("${fileUrl(s.background.content)}")`);
      html.style.setProperty('--hub-bg-opacity', s.background.opacity != null ? (1 - s.background.opacity) : 0.06);
    } else {
      html.style.setProperty('--hub-bg', 'none');
    }
  },

  async set(patch) {
    this.settings = await API.raw.settings.set(patch).catch(() => this.settings);
    this.applyTheme();
    return this.settings;
  },

  setProfile(patch) {
    this.profile = Object.assign({}, this.profile, patch);
    return API.raw.profile.set(patch).catch(() => {});
  }
};

/** 允许把 data: 或 file: 地址统一成 url() 可用形式 */
function fileUrl(p) {
  if (!p) return '';
  return window.util.toFileUrl(p);
}

window.State = State;
