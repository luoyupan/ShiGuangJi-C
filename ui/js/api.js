/**
 * 拾光集 · API 封装 (api.js)
 * 统一处理异常 → Toast；提供事件订阅便捷方法。
 */
'use strict';

const API = {
  raw: window.SGJ,

  /** 调用并捕获错误（返回 null 并提示，避免打断界面） */
  async try(promise, opts = {}) {
    try { return await promise; }
    catch (e) {
      if (!opts.silent) window.Shell && window.Shell.toast(e.message || String(e), 'err');
      return opts.fallback !== undefined ? opts.fallback : null;
    }
  },

  on(channel, handler) { return window.SGJ.on(channel, handler); }
};
window.API = API;
