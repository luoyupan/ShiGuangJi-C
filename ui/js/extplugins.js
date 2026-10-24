/**
 * 拾光集 · 第三方插件（界面侧）(extplugins.js)
 * ------------------------------------------------------------
 *  第五十轮。跟 src/main/plugin-host.js 是一对：
 *    主进程那边：扫目录 / require 插件 main.js / 转发调用 / 供资源
 *    这边：把插件的 renderer.js 拉进来、收下它的 SGJPlugin.define()、
 *          在 #/p/<id> 上把它的界面挂起来
 *
 *  插件作者的写法（开发指南里也是这一套）：
 *      SGJPlugin.define({
 *        id: 'com.example.hello',
 *        apiVersion: 1,
 *        mount(container, api) {
 *          container.appendChild(api.el('h1', { text: '你好' }));
 *          return () => { ... };        // 可选：卸载时清理
 *        }
 *      });
 *
 *  🔴 插件界面**不是沙箱**：它和内置界面共享同一个渲染进程、同一个 `window.API`。
 *     别在界面上假装它被隔离了 —— 真相写在指南和设置页的风险提示里。
 * ============================================================ */
'use strict';
(function () {
const { el } = window.util;

/** 宿主支持的插件 API 版本（和 plugin-host.js 的 PLUGIN_API 必须一致） */
const API_V = 1;

const SGJPlugin = {
  apiVersion: API_V,
  /** @type {Map<string, object>} 已 define 的插件（renderer.js 注册进来的） */
  reg: new Map(),
  /** @type {Map<string, object>} 主进程报上来的元信息（含 src / enabled / version） */
  meta: new Map(),
  /** 已注入过 renderer.js 的插件 id */
  injected: new Set(),
  /** @type {Map<string, Promise>} 正在加载中的界面代码（同一份被要两次时等它，别判失败） */
  pending: new Map(),
  /** 加载 / 定义过程中的问题（设置页会照实列出来） */
  errors: [],
  /** 当前挂着的插件：{ id, cleanup } */
  current: null,
  /** 挂载代次：每次 mount / unmount 自增。await 回来发现代次变了就说明这页已经被换掉了，
      不许再往那块（已脱离文档的）DOM 里画东西。 */
  _mt: 0,

  /* ============================================================
     插件作者调这个
     ============================================================ */
  define(def) {
    const d = def && typeof def === 'object' ? def : null;
    if (!d) { this._err('define() 传的不是对象'); return; }
    const id = String(d.id || '').trim();
    if (!id) { this._err('define() 少写 id'); return; }
    if (Number(d.apiVersion) !== API_V) {
      this._err(`${id}：apiVersion 是 ${d.apiVersion}，本程序只支持 ${API_V}`);
      return;
    }
    if (typeof d.mount !== 'function') { this._err(`${id}：没有 mount(container, api) 函数`); return; }
    if (this.reg.has(id)) { this._err(`${id}：重复 define（同一份 renderer.js 被加载了两次？）`); return; }
    this.reg.set(id, d);
  },

  /* ============================================================
     与主进程同步
     ============================================================ */
  async sync() {
    const r = await API.raw.plugin.list().catch((e) => ({ list: [], errors: [{ dir: '', error: e.message }] }));
    this.meta.clear();
    for (const p of r.list || []) this.meta.set(p.id, p);
    /* 把「主进程扫描时的报错」和「界面侧的报错」分开攒：两边都可能出问题，
       一起显示才不会出现「装了个插件，界面什么都没有，也没人告诉我为什么」。 */
    this.errors = (r.errors || []).slice();
    this.hostApi = r.apiVersion;
    this.dir = r.dir || '';
    if (r.apiVersion && Number(r.apiVersion) !== API_V) {
      this.errors.push({ dir: '', error: `主进程的插件 API 是 v${r.apiVersion}，界面这边是 v${API_V} —— 版本不匹配` });
    }
    return this.list();
  },

  /** 合并后的插件清单（已启用） */
  list() { return [...this.meta.values()]; },

  /* ============================================================
     加载某个插件的界面代码
     ============================================================ */
  ensureScript(id) {
    const m = this.meta.get(id);
    if (!m) return Promise.reject(new Error('没有这个插件：' + id));
    if (this.reg.has(id)) return Promise.resolve();
    /* 🔴 同一份脚本正在加载中 → 等同一个 Promise。
       早期版本这里直接 reject（"已加载但没 define"），结果「路由跑了两遍」时
       第二遍必然判失败、给出一个假的错误块 —— 那是我们自己的竞态，不是插件的错。 */
    const inflight = this.pending.get(id);
    if (inflight) return inflight;
    if (this.injected.has(id)) {
      /* 真的加载完了一轮却没 define → 一定是它自己没调，或者调的时候参数不合格。
         别一直等下去（等下去就是「点进去一直转圈」）。 */
      return Promise.reject(new Error('界面代码已加载，但没有调用 SGJPlugin.define()'));
    }
    this.injected.add(id);
    const p = new Promise((resolve, reject) => {
      if (m.src && m.src.css) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = m.src.css;
        document.head.appendChild(link);
      }
      const s = document.createElement('script');
      s.src = m.src && m.src.js ? m.src.js : '';
      s.async = false;
      const timer = setTimeout(() => reject(new Error('界面代码加载超时（8 秒）')), 8000);
      s.onload = () => {
        clearTimeout(timer);
        /* onload 之后 define 应该已经跑完了（async=false 的经典脚本是同步执行） */
        if (this.reg.has(id)) resolve();
        else reject(new Error('界面代码跑完了，但没有调用 SGJPlugin.define()'));
      };
      s.onerror = () => {
        clearTimeout(timer);
        reject(new Error('界面代码加载失败（' + s.src + '）—— 检查清单里的 renderer 字段'));
      };
      document.head.appendChild(s);
      /* 极端情况：CSP 把脚本拦了，onerror 也不一定触发 */
      if (!s.src) { clearTimeout(timer); reject(new Error('插件清单里没有可用的 renderer 地址')); }
    });
    /* 无论成不成都要把「在途记录」摘掉，否则失败之后永远卡在这条路上重试不了 */
    const done = () => this.pending.delete(id);
    p.then(done, done);
    this.pending.set(id, p);
    return p;
  },

  /* ============================================================
     挂载 / 卸载
     ============================================================ */
  async mount(container, rawId) {
    const id = String(rawId || '');
    this.unmount();
    const mt = ++this._mt;
    /* 每次 await 之后都得问一句「这页还在吗」：await 期间用户可能已经点走了，
       此时那个 body 早已被 route() 的 clear() 摘掉，往里画就是画到看不见的地方。 */
    const alive = () => mt === this._mt;
    const page = el('div', { class: 'page ext-page' });
    const head = el('div', { class: 'page-head' }, el('h2', { text: '插件' }));
    const body = el('div', { class: 'page-body ext-body' });
    page.appendChild(head);
    page.appendChild(body);
    container.appendChild(page);

    let m = this.meta.get(id);
    if (!m) { await this.sync(); m = this.meta.get(id); if (!alive()) return; }
    if (!m) {
      this._fail(body, `找不到插件「${id}」`, '可能已经被删掉，或者插件目录里没有它（设置 → 插件 → 打开插件目录）。');
      return;
    }

    /* 返回按钮 + 标题（和内置模块的页头一致，别让第三方插件看起来像「另一个软件」） */
    head.insertBefore(el('button', { class: 'back-btn', onclick: () => window.Shell.go('#/') },
      window.ICON.uiSpan('back'), '返回'), head.firstChild);
    head.style.gap = '14px';
    head.appendChild(el('span', { class: 'sub', text: `v${m.version} · ${m.author}` }));
    const h2 = head.querySelector('h2');
    if (h2) h2.textContent = m.name;
    if (m.accent) page.style.setProperty('--accent', m.accent);

    try {
      await this.ensureScript(id);
    } catch (e) {
      if (alive()) this._fail(body, '插件界面没能加载', e && e.message);
      return;
    }
    if (!alive()) return;
    const def = this.reg.get(id);
    if (!def) { this._fail(body, '插件界面没能加载', '界面代码里没有定义 id 为 ' + id + ' 的插件'); return; }

    const api = this._api(m);
    try {
      const cleanup = await def.mount(body, api);
      if (!alive()) {
        /* 插件自己是异步挂载的，挂完这页已经走了 —— 补一次它给的清理函数，
           否则它绑的定时器/事件会留在内存里。 */
        if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
        return;
      }
      this.current = { id, cleanup: typeof cleanup === 'function' ? cleanup : null };
    } catch (e) {
      if (alive()) this._fail(body, '插件界面抛错了', (e && e.message) + '\n' + String((e && e.stack) || '').split('\n').slice(0, 3).join('\n'));
    }
  },

  unmount() {
    /* 代次自增在最外面：即使下面什么都没做，正在 await 的那次 mount 也会立刻变成「过期」 */
    this._mt++;
    const c = this.current;
    this.current = null;
    if (c && c.cleanup) {
      try { c.cleanup(); } catch (e) { this._err(`${c.id} 的清理函数抛错：${e && e.message}`); }
    }
  },

  /* ============================================================
     给插件的 api（开发指南里逐条写着）
     ============================================================ */
  _api(m) {
    const id = m.id;
    const me = this;
    return {
      apiVersion: API_V,
      id,
      version: m.version,
      author: m.author,
      dir: this.dir,

      /** 调自己 main.js 里的方法：api.call('greet', '小明') */
      call: (method, ...args) => API.raw.plugin.call(id, method, args),
      /** 自己的持久化（和本体、别的插件完全隔离） */
      getItem: () => API.raw.plugin.store.get(id),
      setItem: (patch) => API.raw.plugin.store.set(id, patch),
      /** 订阅自己 main.js 里 host.emit() 推出来的事件 */
      on: (event, cb) => API.on(`plugin:${id}:${String(event || 'event')}`, cb),

      /* 复用本体的界面工具，省得每个插件自己造一套样式 */
      el,
      icon: (name) => window.ICON.uiSpan(name || 'extension'),
      toast: (msg, type) => window.Shell.toast(String(msg), type || 'info'),
      go: (hash) => window.Shell.go(String(hash || '#/')),
      theme: () => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'),
      /** 主题色（用户在设置里选的那个），插件可以用它染自己的元素 */
      accent: () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),

      log: (...a) => { try { console.log('[plugin:' + id + ']', ...a); } catch { /* ignore */ } },
      _meta: m,
      _me: me
    };
  },

  /* ============================================================
     错误呈现（不许静默失败）
     ============================================================ */
  _fail(body, title, detail) {
    body.appendChild(el('div', { class: 'ext-fail' },
      el('div', { class: 'ext-fail-t' }, window.ICON.uiSpan('info'), title),
      el('pre', { class: 'ext-fail-s', text: String(detail || '') }),
      el('div', { class: 'ext-fail-acts' },
        el('button', { class: 'btn btn-sm', onclick: () => window.Shell.go('#/settings') }, '打开插件设置'),
        el('button', { class: 'btn btn-sm btn-ghost', onclick: () => API.raw.plugin.openDir().catch(() => {}) }, '打开插件目录'))));
  },

  _err(msg) {
    this.errors.push({ dir: '', error: String(msg) });
    if (window.console) console.warn('[plugin]', msg);
  }
};

window.SGJPlugin = SGJPlugin;
})();
