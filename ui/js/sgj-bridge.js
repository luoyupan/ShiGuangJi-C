/**
 * 拾光集 C 版 · 渲染层桥 (sgj-bridge.js)
 * ------------------------------------------------------------
 * 原版 preload.js 通过 Electron contextBridge 暴露 window.SGJ。
 * 这里用同一份 preload.js，但给它一个「假的 electron」：
 *   ipcRenderer.invoke → POST /t/<token>/api（JSON）
 *   ipcRenderer.on     → SSE /t/<token>/events
 * 这样界面代码一行都不用改，后端换成了 C + dll。
 */
'use strict';
(function () {
  const BASE = location.pathname.replace(/[^/]*$/, ''); // 以 / 结尾
  const ORIGIN = location.origin;
  window.__SGJ_BASE = BASE;

  function localUrl(p) {
    if (!p) return '';
    if (/^(https?|data|blob):/i.test(p)) return p;
    let s = String(p).replace(/\\/g, '/');
    if (/^file:/i.test(s)) {
      s = s.replace(/^file:\/+/i, '');
      if (s.startsWith('/')) s = s.slice(1);
      try { s = decodeURIComponent(s); } catch (e) { /* ignore */ }
    }
    return ORIGIN + BASE + 'local/' + encodeURIComponent(s);
  }
  window.__sgjLocalUrl = localUrl;

  /** 把后端返回里的 file:// 地址换成 http 本地代理地址（图片 / 音频要用） */
  function mapLocal(v, depth) {
    if (depth > 12 || v == null) return v;
    if (typeof v === 'string') {
      return /^file:/i.test(v) ? localUrl(v) : v;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) v[i] = mapLocal(v[i], depth + 1);
      return v;
    }
    if (typeof v === 'object') {
      for (const k of Object.keys(v)) v[k] = mapLocal(v[k], depth + 1);
      return v;
    }
    return v;
  }
  window.__sgjMapLocal = mapLocal;

  let seq = 0;
  async function invoke(channel, ...args) {
    try {
      const res = await fetch(BASE + 'api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: String(channel), args: args, id: ++seq })
      });
      if (!res.ok) return { ok: false, error: '本地服务返回 ' + res.status };
      const j = await res.json();
      if (j && j.ok) {
        j.data = mapLocal(j.data, 0);
        return j;
      }
      return { ok: false, error: (j && j.error) || '操作失败' };
    } catch (e) {
      return { ok: false, error: '连不上本地服务：' + (e && e.message ? e.message : e) };
    }
  }

  /* ---------------- 事件订阅 ---------------- */
  const handlers = new Map();
  let es = null;
  function ensureEvents() {
    if (es) return;
    try {
      es = new EventSource(BASE + 'events');
      es.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (!msg || !msg.channel) return;
        const list = handlers.get(msg.channel);
        if (list) for (const fn of list.slice()) {
          try { fn(msg.payload); } catch (e) { console.error('[bridge] event handler', e); }
        }
      };
      es.onerror = () => { /* EventSource 自动重连 */ };
    } catch (e) { console.error('[bridge] events', e); }
  }
  function on(channel, cb) {
    ensureEvents();
    const k = String(channel);
    if (!handlers.has(k)) handlers.set(k, []);
    handlers.get(k).push(cb);
    return () => {
      const list = handlers.get(k);
      if (!list) return;
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /* ---------------- 假的 electron ---------------- */
  const ipcRenderer = {
    invoke,
    on(channel, wrapped) {
      const off = on(channel, (payload) => wrapped({}, payload));
      return off;
    },
    removeListener(channel, wrapped) { /* on() 返回的取消函数由 preload 包装，这里不追踪 */ },
    send() { /* no-op */ }
  };
  const electron = {
    contextBridge: {
      exposeInMainWorld(key, value) { window[key] = value; }
    },
    ipcRenderer,
    webUtils: {
      getPathForFile(file) { return (file && file.__sgjPath) || ''; }
    }
  };
  window.require = function require(name) {
    if (name === 'electron') return electron;
    if (name === 'path') {
      return {
        basename: (p) => String(p || '').replace(/\\/g, '/').split('/').pop(),
        dirname: (p) => String(p || '').replace(/[\\/][^\\/]*$/, ''),
        extname: (p) => { const m = /(\.[^./\\]+)$/.exec(String(p || '')); return m ? m[1] : ''; },
        join: (...a) => a.join('\\')
      };
    }
    throw new Error('C 版渲染层没有 Node 模块：' + name);
  };

  /* ---------------- 标题栏拖动 / 双击最大化 ---------------- */
  function bindTitlebar() {
    const tb = document.getElementById('titlebar');
    if (!tb) return;
    tb.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button, a, input, select, textarea, .brand, .crumb, .tb-bread')) return;
      invoke('win:drag').catch(() => {});
    });
    tb.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, a, input, .brand, .crumb')) return;
      invoke('win:maximize').catch(() => {});
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindTitlebar);
  else bindTitlebar();

  /* ---------------- 额外能力（原版没有） ---------------- */
  document.addEventListener('DOMContentLoaded', () => {
    if (!window.SGJ) return;
    window.SGJ.win = window.SGJ.win || {};
    window.SGJ.win.drag = () => invoke('win:drag');
    window.SGJ.win.devtools = () => invoke('win:devtools');
    window.SGJ.__localUrl = localUrl;
    /* 给「不在 preload 白名单里」的新能力留一个通用入口（浏览器画布 / 内部事件） */
    window.SGJ.__call = async (channel, ...args) => {
      const r = await invoke(channel, ...args);
      if (r && r.ok === false) throw new Error(r.error || '操作失败');
      return r ? r.data : null;
    };
  });

  window.__SGJ_BRIDGE_READY = true;
})();
