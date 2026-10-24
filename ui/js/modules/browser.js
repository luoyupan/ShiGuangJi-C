/**
 * 拾光集 · 浏览器模块视图 (modules/browser.js)
 * ------------------------------------------------------------
 * 内核：Electron 自带 Chromium，页面用 `<webview>` 承载（主进程已开 webviewTag）。
 * 这个视图只管：多标签、地址栏 / 搜索、书签、历史、插件、设置。
 *
 * ⚠️ 四条硬经验（写之前就在这儿，别踩）：
 *  ① 标签页切换**不能用 display:none** —— webview 被 display:none 后再显示会白屏，
 *     必须保持尺寸（absolute inset:0）+ 用 visibility 切换。
 *  ② 离开模块时把整个舞台**挪到 body 上的隐藏容器**，回来再挪回去 ——
 *     否则路由 clear() 会连浏览状态一起销毁。
 *  ③ 默认 UA 带 Electron 字样会被很多网站拒绝服务，必须伪装成同版本 Chrome。
 *  ④ ⚠️⚠️ 舞台（.br-stage）和 webview 容器（.br-views）**只能建一次、永远不搬家**。
 *     新标签页 / 面板 / 失败页都画在舞台里的 .br-overlay 覆盖层上。
 *     之前每帧 renderMain 都把 .br-views 从一个 stage 挪到另一个 stage，
 *     webview 每次重挂都会丢 dom-ready，executeJavaScript 直接抛
 *     "The WebView must be attached to the DOM and the dom-ready event emitted"。
 */
'use strict';
(function () {
const { el, clear } = window.util;
const { uiSpan } = window.ICON;

const NEW_TAB = 'about:newtab';
const KEEPER_ID = 'sgj-browser-keeper';

/** 标签组可用的颜色（要跟软件的 accent 色系对得上，别太跳） */
const GROUP_COLORS = ['blue', 'green', 'amber', 'pink', 'teal', 'gray'];

/** 标签搜索浮层 / 查找条的键位由这里统一管，免得散落在各处 */
const KEY_SEARCH_TABS = 'k';
const KEY_REOPEN = 't';

/* 新标签页的内置渐变背景（不占磁盘，点一下即换）。
   id 由主进程校验（NTP_PRESETS），色值只活在这里 —— 那边不需要知道具体长什么样。 */
const NTP_PRESETS = {
  aurora: 'linear-gradient(135deg,#0f172a 0%,#1e3a5f 35%,#2f6f8f 65%,#63b6a4 100%)',
  sunset: 'linear-gradient(135deg,#2a1a3e 0%,#6b2f5f 38%,#c2544e 70%,#f0a05a 100%)',
  ocean: 'linear-gradient(135deg,#04121f 0%,#0b3550 45%,#146a83 75%,#5fc2c4 100%)',
  forest: 'linear-gradient(135deg,#0a1a12 0%,#14402c 45%,#2c6b45 75%,#96c98a 100%)',
  mono: 'linear-gradient(135deg,#14161a 0%,#2b3038 55%,#4b525c 100%)',
  violet: 'linear-gradient(135deg,#140f2b 0%,#3a2470 45%,#6d49b8 75%,#b79bf0 100%)'
};
const NTP_PRESET_NAME = {
  aurora: '极光', sunset: '落日', ocean: '深海', forest: '森林', mono: '石墨', violet: '紫罗兰'
};

/* 阅读模式的正文提取脚本（跑在 guest 里，返回可序列化的对象）。
   ⚠️ 必须把相对链接改写成绝对链接 —— 正文要拿到宿主这边渲染，
      不改写的话所有 <a href="/x"> / <img src="/y"> 全是死链。 */
const READ_SCRIPT = `(function () {
  var bad = 'script,style,noscript,nav,aside,footer,header,form,iframe,button,select,input,textarea,svg,canvas';
  var badCls = /(comment|share|sidebar|related|recommend|advert|adsbygoogle|banner|promo|nav|breadcrumb|footer|meta-|toolbar|social|subscribe|popup|modal)/i;
  function txt(n) { return (n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim(); }
  function linkLen(n) { var s = 0, a = n.querySelectorAll('a'); for (var i = 0; i < a.length; i++) s += (a[i].innerText || '').length; return s; }
  var best = null;
  var arts = document.querySelectorAll('article');
  if (arts.length) {
    for (var i = 0; i < arts.length; i++) {
      var t = txt(arts[i]);
      if (!best || t.length > best.len) best = { n: arts[i], len: t.length };
    }
  }
  if (!best || best.len < 300) {
    var all = document.querySelectorAll('div,section,main,td,article');
    var top = 0;
    for (var j = 0; j < all.length; j++) {
      var n2 = all[j];
      var text = txt(n2);
      if (text.length < 250) continue;
      var p = n2.querySelectorAll('p').length;
      var ll = linkLen(n2);
      var score = (text.length - ll * 2.5) + p * 40;
      if (n2.closest && n2.closest(bad)) score -= 500;
      if (score > top) { top = score; best = { n: n2, len: text.length }; }
    }
  }
  if (!best) return { ok: false, reason: 'no-content' };
  var clone = best.n.cloneNode(true);
  var junk = clone.querySelectorAll(bad);
  for (var k = 0; k < junk.length; k++) junk[k].remove();
  var divs = clone.querySelectorAll('div,span,section,ul,ol');
  for (var q = 0; q < divs.length; q++) {
    var d = divs[q];
    if (d.querySelector('p,h1,h2,h3,img,table,li,pre,blockquote')) continue;
    if (txt(d).length < 40) d.remove();
  }
  var cn = clone.querySelectorAll('*');
  for (var w = 0; w < cn.length; w++) {
    var e = cn[w];
    if (e.className && typeof e.className === 'string' && badCls.test(e.className)) { e.remove(); continue; }
    var keep = e.tagName === 'A' ? ['href'] : (e.tagName === 'IMG' ? ['src', 'alt'] : []);
    var at = [].slice.call(e.attributes);
    for (var z = 0; z < at.length; z++) {
      if (keep.indexOf(at[z].name) < 0) e.removeAttribute(at[z].name);
    }
    if (e.tagName === 'A' && e.getAttribute('href')) {
      try { e.setAttribute('href', new URL(e.getAttribute('href'), location.href).href); } catch (err) {}
      e.setAttribute('target', '_blank');
    }
    if (e.tagName === 'IMG') {
      try { e.setAttribute('src', new URL(e.getAttribute('src') || '', location.href).href); } catch (err2) {}
    }
  }
  var title = (document.querySelector('meta[property="og:title"]') || {}).content
    || (document.querySelector('h1') || {}).innerText || document.title || '';
  var byline = (document.querySelector('meta[name="author"]') || {}).content
    || (document.querySelector('meta[property="article:author"]') || {}).content || '';
  return { ok: true, title: String(title).trim(), byline: String(byline).trim(), url: location.href,
           textLength: txt(clone).length, html: clone.innerHTML };
})()`;


/** 隐藏的「寄存处」：离开模块时 webview 放这儿，保住浏览状态 */
function keeper() {
  let n = document.getElementById(KEEPER_ID);
  if (!n) {
    n = el('div', { id: KEEPER_ID, style: { position: 'absolute', left: '-99999px', top: '0', width: '800px', height: '600px', overflow: 'hidden' } });
    document.body.appendChild(n);
  }
  return n;
}

/**
 * 给「跨进程等 guest 回答」的调用加个上限。
 *
 * ⚠️⚠️ 实测踩到的坑：webview 的 `executeJavaScript()` / `capturePage()` 在 guest
 *   状态不干净时（页面正在导航、刚被摘过 DOM、渲染进程忙）会**永远不 resolve** ——
 *   不是 reject，就是安静地悬着。不设上限的话：
 *     · 夜间模式切换卡在「正在切换」
 *     · 截图卡在「正在截图…」而且 `_busy` 一直不清，后面再也截不了
 *     · 脚本注入把 `did-finish-load` 那条链拖死
 *   界面又没任何报错，用户只能强杀进程。宁可超时失败，也别无声卡死。
 */
function withTimeout(p, ms, tag) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error((tag || '操作') + '等待超时')), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

const BrowserView = {
  root: null,
  tabs: [],            // { id, title, url, favicon, loading, failed, failText, wv, groupId, muted, incognito, zoom }
  groups: [],          // [{ id, name, color, collapsed }] —— 只活在这一次会话里
  activeId: '',
  panel: 'web',        // web | bookmarks | history | plugins | settings
  settings: null,
  engines: [],
  sites: [],
  bookmarks: [],
  folders: [],
  history: [],
  plugins: [],
  extensions: [],
  topSites: [],
  closed: [],          // 关掉的标签栈（Ctrl+Shift+T 恢复），最多留 25 个
  _seq: 0,
  _gseq: 0,
  _histQ: '',
  _bmFolder: '',
  _env: null,          // { partition, incognitoPartition, shotDir }
  _nightCss: '',       // 当前夜间/护眼模式对应的 CSS（空 = 不注入）
  _gestureKit: null,   // { enabled, script, prefix, map, actions }
  _adStats: { count: 0 },
  _findQuery: '',
  _findHits: null,
  _findTries: 0,       // 本次查找已经重发过几次（事件被吞时最多补发 1 次）
  _shotImg: '',
  _reading: null,
  _busy: '',

  /* ============================================================
   *  挂载 / 卸载
   * ========================================================== */
  async mount(container) {
    this.root = container;

    this.settings = await API.raw.browser.settings().catch(() => null) || { home: 'https://www.bing.com/', engine: 'bing', sidebar: true };
    this.engines = await API.raw.browser.engines().catch(() => []);
    this.sites = await API.raw.browser.ntpSites().catch(() => [])
      .then((x) => (x && x.length ? x : null))
      .then((x) => x || API.raw.browser.sites().catch(() => []));
    this._env = await API.raw.browser.env().catch(() => null);
    this._gestureKit = await API.raw.browser.gestureKit().catch(() => null);
    await this.refreshNight();

    // 广告过滤的累计拦截数（跨会话累计在内存里，重开软件归零）
    API.raw.browser.adblockInfo().then((d) => { this._adStats = (d && d.stats) || { count: 0 }; this.renderBar(); }).catch(() => {});

    // ⚠️ 整棵树只建一次：webview 一旦从 DOM 上摘下来，dom-ready 就丢了，
    //    executeJavaScript 会直接抛 "The WebView must be attached to the DOM..."（见文件头 ④）
    if (!this.wrapEl) {
      this.wrapEl = el('div', { class: 'browser' });
      this.tabsEl = el('div', { class: 'br-tabs' });
      this.barEl = el('div', { class: 'br-bar' });
      this.findEl = el('div', { class: 'br-find', hidden: true });
      this.mainEl = el('div', { class: 'br-main' });
      this.railEl = el('div', { class: 'br-rail' });
      /* 侧栏收起后留下的那根窄条 —— 总得有个地方点回来，否则用户找不到侧栏了 */
      this.railOpenEl = el('div', {
        class: 'br-rail-open', title: '展开侧栏（收藏 / 历史 / 插件 / 设置）',
        onclick: () => this.toggleRail(true)
      }, uiSpan('forward'));
      this.stageEl = el('div', { class: 'br-stage' });
      this.viewsEl = el('div', { class: 'br-views' });
      this.overlayEl = el('div', { class: 'br-overlay' });
      /* 阅读模式 / 截图预览 / 区域框选：都挂 stageEl 上，绝对定位盖住画面 */
      this.readEl = el('div', { class: 'br-read', hidden: true });
      this.shotEl = el('div', { class: 'br-shot', hidden: true });
      this.shotSelEl = el('div', { class: 'br-shot-sel', hidden: true });
      this.stageEl.appendChild(this.viewsEl);
      this.stageEl.appendChild(this.overlayEl);
      this.stageEl.appendChild(this.readEl);
      this.stageEl.appendChild(this.shotEl);
      this.stageEl.appendChild(this.shotSelEl);
      /* 🔴🔴 查找条**必须挂在舞台里当浮层**，绝不能挂在 wrapEl 上占布局。
         实测根因：挂在 wrapEl 上时它是 flex 列里的一行，一打开就把 webview 挤矮
         （727px → 684px）；而 Chromium 的 find-in-page 会在视口尺寸变化的瞬间
         把**进行中**的这次查找作废 —— found-in-page 事件永远不回来。
         用户看到的就是「第一次查找永远显示没有匹配，再按一次才出来」。
         挂在舞台里 absolute 定位，视口一动不动，问题从根上消失。 */
      this.stageEl.appendChild(this.findEl);
      this.mainEl.appendChild(this.railEl);
      this.mainEl.appendChild(this.railOpenEl);
      this.mainEl.appendChild(this.stageEl);
      this.wrapEl.appendChild(this.tabsEl);
      this.wrapEl.appendChild(this.barEl);
      this.wrapEl.appendChild(this.mainEl);
    }

    clear(container);
    container.appendChild(this.wrapEl);

    await this.reloadData();
    // 第一次进来先给新标签页（搜索框 + 常用站点），主页用工具栏那个小房子按钮
    if (!this.tabs.length) this.newTab(NEW_TAB, { active: true });
    // 进模块之前就有页面想开新标签（window.open 早于用户切过来）→ 现在补上
    if (this._pendingOpen) {
      const p = this._pendingOpen;
      this._pendingOpen = null;
      this.newTab(p.url, { active: p.active });
    }
    this.render();
    return this;
  },

  /**
   * 离开模块：把整棵浏览器树挪到 body 上的隐藏容器，别让路由 clear() 把它摘下来。
   * ⚠️ 还在浏览器页时不要动 —— 否则每次路由都要摘一次挂一次。
   */
  detach() {
    if (location.hash === '#/browser') return;
    if (this.wrapEl) keeper().appendChild(this.wrapEl);
  },

  onDownload(d) {
    if (!d) return;
    if (d.state === 'completed') window.Shell.toast(`已下载：${d.name}`, 'ok');
    else if (d.state === 'cancelled') window.Shell.toast(`已取消下载：${d.name}`);
    else window.Shell.toast(`下载失败：${d.name}`, 'err');
  },

  async reloadData() {
    const [bm, hs, pl, fo, ts, ex] = await Promise.all([
      API.raw.browser.bookmarks().catch(() => []),
      API.raw.browser.history().catch(() => []),
      API.raw.browser.plugins().catch(() => []),
      API.raw.browser.folders().catch(() => ['默认']),
      API.raw.browser.topSites(10).catch(() => []),
      API.raw.browser.extensions().catch(() => [])
    ]);
    this.bookmarks = bm; this.history = hs; this.plugins = pl;
    this.folders = fo.length ? fo : ['默认']; this.topSites = ts; this.extensions = ex;
    if (!this._bmFolder) this._bmFolder = this.folders[0];
  },

  /* ============================================================
   *  标签页
   * ========================================================== */
  active() { return this.tabs.find((t) => t.id === this.activeId) || this.tabs[0] || null; },

  newTab(url, opts = {}) {
    const t = {
      id: 't' + (++this._seq) + '-' + Date.now().toString(36),
      title: opts.incognito ? '隐身标签页' : '新标签页',
      url: String(url || NEW_TAB),
      favicon: '',
      loading: false,
      failed: false,
      failText: '',
      zoom: 0,          // 缩放级别（Chromium 对数刻度：0 = 100%），Ctrl+滚轮改它
      groupId: '',      // 所属标签组
      muted: false,
      incognito: !!opts.incognito,
      wv: null
    };
    // 插到当前标签右边（Chrome 的行为），没指定就往末尾加
    const at = opts.after === undefined ? this.tabs.length : Math.max(0, Math.min(this.tabs.length, opts.after));
    this.tabs.splice(at, 0, t);
    if (opts.active !== false) this.activeId = t.id;
    this.panel = 'web';
    if (this.root) { this.render(); this.navigate(t, t.url); }
    return t;
  },

  closeTab(id, e) {
    if (e) e.stopPropagation();
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const t = this.tabs[idx];
    // 隐身标签不进「恢复关闭」栈 —— 否则 Ctrl+Shift+T 会把临时会话又把拉回来
    if (!t.incognito && t.url && t.url !== NEW_TAB) {
      this.closed.unshift({ url: t.url, title: t.title, at: idx, groupId: t.groupId, incognito: false });
      if (this.closed.length > 25) this.closed.length = 25;
    }
    if (t.wv && t.wv.parentNode) t.wv.parentNode.removeChild(t.wv);
    this.tabs.splice(idx, 1);
    if (this.activeId === id) {
      const next = this.tabs[idx] || this.tabs[idx - 1];
      this.activeId = next ? next.id : '';
    }
    if (!this.tabs.length) { this.newTab(NEW_TAB, { active: true }); return; }
    this.render();
  },

  /** Ctrl+Shift+T：把刚关掉的标签原样放回原位 */
  reopenClosed() {
    const c = this.closed.shift();
    if (!c) return window.Shell.toast('没有可以恢复的标签页');
    const t = this.newTab(c.url, { active: true, after: Math.min(c.at, this.tabs.length) });
    if (c.groupId) t.groupId = c.groupId;
    this.render();
    window.Shell.toast(`已恢复：${c.title || this.shortUrl(c.url)}`, 'ok');
  },

  /** 下一个 / 上一个标签（Ctrl+Tab 与鼠标手势都走它） */
  cycleTab(step) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.findIndex((x) => x.id === this.activeId);
    const n = (i + step + this.tabs.length) % this.tabs.length;
    this.selectTab(this.tabs[n].id);
  },

  selectTab(id) {
    if (this.activeId === id) return;
    this.activeId = id;
    this.panel = 'web';
    this.render();
    // 切回来时把 webview 尺寸刷新一下（visibility 方案下偶尔需要）
    const t = this.active();
    if (t && t.wv) { try { t.wv.focus(); } catch { /* ignore */ } }
  },

  /** 确保 webview 建好并挂进容器 */
  ensureWv(t) {
    if (t.wv) return t.wv;
    const wv = document.createElement('webview');
    /* 隐身：用**不带 persist:** 的分区 = 纯内存，关掉软件什么都不留。
       分区只能在创建 webview 时定死，所以隐身标签和非隐身标签是两只不同的 webview。 */
    const part = t.incognito
      ? ((this._env && this._env.incognitoPartition) || 'sgj-incognito')
      : 'persist:sgj-browser';
    wv.setAttribute('partition', part);
    wv.setAttribute('webpreferences', 'contextIsolation=yes,nodeIntegration=no,webSecurity=yes');
    wv.setAttribute('allowpopups', 'on');
    wv.setAttribute('useragent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
    wv.className = 'br-wv';
    this.bindWv(t, wv);
    t.wv = wv;
    return wv;
  },

  bindWv(t, wv) {
    const upd = () => { if (this.activeId === t.id) this.renderBar(); this.renderTabs(); };
    wv.addEventListener('did-start-loading', () => { t.loading = true; t.failed = false; upd(); });
    wv.addEventListener('did-stop-loading', () => {
      t.loading = false;
      this.syncNav(t);
      upd();
    });
    wv.addEventListener('did-finish-load', () => {
      t.loading = false;
      this.syncNav(t);
      this.recordVisit(t);
      this.injectPlugins(t);
      /* ⚠️ 夜间样式和手势脚本都是**注入进页面的**，导航后要重新来一遍
         （页面一换，之前注入的 DOM / 全局变量全没了）。 */
      this.applyNight(t);
      this.injectGesture(t);
      /* 页面一换，上一轮的查找会话就没了 → 必须重新开一次新会话（findNext 传 true） */
      if (this.activeId === t.id && this._findQuery) { this._findHits = null; this.runFind(this._findQuery, true, true); }
      upd();
    });
    wv.addEventListener('did-navigate', (e) => { t.url = e.url; t.failed = false; this.recordVisit(t); upd(); });
    wv.addEventListener('did-navigate-in-page', (e) => { t.url = e.url; upd(); this.injectPlugins(t); });
    wv.addEventListener('page-title-updated', (e) => { t.title = e.title || t.title; upd(); });
    wv.addEventListener('page-favicon-updated', (e) => {
      const f = (e.favicons && e.favicons[0]) || '';
      if (f) { t.favicon = f; upd(); }
    });
    // -3 = ERR_ABORTED（用户自己点了停止 / 换页），不算失败
    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3) return;
      if (e.isMainFrame === false) return;
      t.loading = false;
      t.failed = true;
      t.failText = `打不开 ${e.validatedURL || e.targetURL || t.url}（错误码 ${e.errorCode}）`;
      upd();
    });
    /* 页内查找的结果 —— 计数和当前第几个都从这儿来 */
    wv.addEventListener('found-in-page', (e) => { this.onFound(e); });
    /* ⚠️ 鼠标手势只能靠注入脚本在页面里识别，再隔着进程用 console 传回来
       （宿主收不到 webview 内部的鼠标事件，guest 是独立进程、事件不冒泡）。 */
    wv.addEventListener('console-message', (e) => {
      const msg = String((e && e.message) || '');
      const p = (this._gestureKit && this._gestureKit.prefix) || '__SGJ_GESTURE__:';
      const i = msg.indexOf(p);
      if (i < 0) return;
      this.runGesture(msg.slice(i + p.length).trim());
    });
    // ⚠️ 这里原来监听 `<webview>` 的 `new-window` 事件 —— 那是**死代码**：
    //    该事件在 Electron 22 就被移除了（我们用 33），所以点 target=_blank 的链接
    //    会弹出一个带自己菜单栏的**独立系统窗口**，完全脱离软件的标签条。
    //    现在改成主进程 `initWebviewPolicy()` 里 setWindowOpenHandler 拦下来，
    //    再用 `browser:open-tab` 事件送回来 → `openFromPage()` 开成新标签页。
  },

  /**
   * 页面里 window.open / target=_blank → 在**标签条上**新建标签页（而不是独立窗口）。
   * 主进程 `initWebviewPolicy()` 那边负责 deny 掉默认的独立窗口。
   */
  openFromPage(d) {
    if (!d || !d.url) return;
    const url = String(d.url);
    if (/^about:blank$/i.test(url)) return;      // 有些站点先开空白窗再往里面写，没意义
    // 谁开的就继承谁的隐身状态（隐身页面里点出来的链接当然也得是隐身的）
    let incognito = false;
    if (d.wcId) {
      const opener = this.tabs.find((x) => {
        try { return x.wv && x.wv.getWebContentsId() === d.wcId; } catch { return false; }
      });
      if (opener) incognito = !!opener.incognito;
    }
    // 还没进过浏览器模块（没有标签容器）→ 先记下来，切过去 mount 完再开
    if (!this.wrapEl) {
      this._pendingOpen = { url, active: d.active !== false, incognito };
      if (location.hash !== '#/browser') location.hash = '#/browser';
      return;
    }
    const t = this.newTab(url, { active: d.active !== false, incognito });
    // 就算当前不在浏览器页（挂在隐藏容器里），也把用户带过去 —— 他刚点了链接
    if (location.hash !== '#/browser') location.hash = '#/browser';
    if (t && d.active !== false) window.Shell.toast(`已在新标签页打开：${this.shortUrl(url)}`);
  },

  /** 地址栏 / 提示里用的短网址 */
  shortUrl(u) {
    try { const x = new URL(u); return x.hostname + (x.pathname === '/' ? '' : x.pathname).slice(0, 40); }
    catch { return String(u).slice(0, 40); }
  },

  /* ---------------- 跟 guest 打交道（一律带超时，见 withTimeout） ---------------- */

  /** 在 guest 里跑一段 JS；超时 / 出错都回 null（调用方自己决定怎么提示） */
  async wvJs(t, js, ms) {
    if (!t || !t.wv || !t.attached) return null;
    try { return await withTimeout(t.wv.executeJavaScript(js), ms || 5000, '页面脚本'); }
    catch { return null; }
  },

  /** 抓一张 guest 的画面（rect 省略 = 当前视口）；超时 / 出错回 null */
  async wvShot(t, rect, ms) {
    if (!t || !t.wv || !t.attached) return null;
    try {
      const p = rect ? t.wv.capturePage(rect) : t.wv.capturePage();
      return await withTimeout(p, ms || 8000, '截图');
    } catch { return null; }
  },

  /** 注入页面级 CSS（插件用）；超时就算了，别把导航链拖住 */
  async wvCss(t, css, ms) {
    if (!t || !t.wv || !t.attached || !css) return false;
    try { await withTimeout(t.wv.insertCSS(css), ms || 4000, '样式注入'); return true; }
    catch { return false; }
  },

  syncNav(t) {
    if (!t || !t.wv) return;
    try {
      t.canBack = !!t.wv.canGoBack();
      t.canForward = !!t.wv.canGoForward();
      const u = t.wv.getURL();
      if (u) t.url = u;
      const ti = t.wv.getTitle();
      if (ti) t.title = ti;
    } catch { /* webview 还没就绪 */ }
  },

  /** 记一条历史（主进程按 URL 去重 + 计次） */
  recordVisit(t) {
    if (!t || !t.url || !/^https?:/i.test(t.url)) return;
    if (t.incognito) return;      // 隐身标签不留历史 —— 这是隐身的基本承诺
    API.raw.browser.addHistory({ url: t.url, title: t.title, favicon: t.favicon }).catch(() => {});
  },

  /** 命中的脚本 / 样式插件注入当前页 */
  async injectPlugins(t) {
    // 除 about: 之外都注入（http / file / data 都行，用户脚本在本地页上一样有用）
    if (!t || !t.wv || !t.url || /^about:/i.test(t.url)) return;
    let list = [];
    try { list = await API.raw.browser.matchPlugins(t.url); } catch { return; }
    if (!list || !list.length) return;
    for (const p of list) {
      // ⚠️ 这两步都可能悬着（见 withTimeout），带超时走，别把 did-finish-load 那条链拖死
      if (p.css) await this.wvCss(t, p.css);
      if (p.kind === 'script' && p.code) await this.wvJs(t, p.code, 4000);
    }
  },

  /* ============================================================
   *  导航
   * ========================================================== */
  navigate(t, url) {
    if (!t) return;
    const u = String(url || '');
    if (!u || u === NEW_TAB) {
      t.url = NEW_TAB; t.title = '新标签页'; t.failed = false;
      if (t.wv && t.wv.parentNode) t.wv.parentNode.removeChild(t.wv);
      t.wv = null;
      this.render();
      return;
    }
    t.failed = false;
    t.url = u;
    const wv = this.ensureWv(t);
    if (!wv.parentNode) this.viewsEl.appendChild(wv);
    this.render();
    this.load(t, wv, u);
  },

  /**
   * ⚠️⚠️ 本模块最大的坑（实测出来的）：
   *   webview 刚 append 到 DOM 时，guest（真正的 Chromium 内核）是**异步**附加上去的。
   *   在这之前调用 loadURL / executeJavaScript / getURL / getWebContentsId 都会同步抛
   *   "The WebView must be attached to the DOM and the dom-ready event emitted"。
   *   而且**光 append 是不会附加 guest 的** —— 必须先设置 src 属性才会触发。
   * 所以：第一次用 `wv.src = url` 把内核带起来；起来了之后就正常用 loadURL（同一个地址也能重新导航）。
   */
  load(t, wv, url) {
    if (t.attached) {
      try { wv.loadURL(url); return; } catch { /* 内核掉了？退回 src 方式 */ }
    }
    const mark = () => { t.attached = true; };
    wv.addEventListener('did-start-loading', mark, { once: true });
    wv.addEventListener('dom-ready', mark, { once: true });
    wv.src = url;
  },

  /** 地址栏 / 新标签页搜索框提交 */
  async go(input) {
    const t = this.active() || this.newTab('', { active: true });
    const raw = String(input || '').trim();
    if (!raw) { this.navigate(t, NEW_TAB); return; }
    const r = await API.raw.browser.resolveInput(raw, this.settings.engine).catch(() => null);
    this.panel = 'web';
    this.navigate(t, r ? r.url : raw);
  },

  back() { const t = this.active(); if (t && t.wv && t.attached) { try { t.wv.goBack(); } catch { /* ignore */ } } },
  forward() { const t = this.active(); if (t && t.wv && t.attached) { try { t.wv.goForward(); } catch { /* ignore */ } } },
  reload() {
    const t = this.active();
    if (!t) return;
    if (t.url === NEW_TAB) return;
    if (!t.wv || !t.attached) return this.navigate(t, t.url);
    try { t.wv.reload(); } catch { /* ignore */ }
  },
  stop() { const t = this.active(); if (t && t.wv && t.attached) { try { t.wv.stop(); } catch { /* ignore */ } } },
  home() { this.go(this.settings.home || 'https://www.bing.com/'); },

  toastErr(e) { window.Shell.toast((e && e.message) || String(e), 'err'); },

  /* ============================================================
   *  渲染
   * ========================================================== */
  render() {
    this.renderTabs();
    this.renderBar();
    this.renderMain();
  },

  renderTabs() {
    const box = clear(this.tabsEl);
    for (let i = 0; i < this.tabs.length; i++) {
      const t = this.tabs[i];
      const g = t.groupId ? this.groups.find((x) => x.id === t.groupId) : null;
      if (g) {
        const firstIdx = this.tabs.findIndex((x) => x.groupId === g.id);
        if (firstIdx === i) box.appendChild(this.groupChip(g));
        // 组折叠后：整组收成一个彩色小圆点，鼠标悬浮能看标题
        if (g.collapsed) {
          box.appendChild(el('div', {
            class: 'br-tab mini g-' + g.color + (t.id === this.activeId ? ' on' : ''),
            title: `${t.title}\n${t.url}\n（${g.name} 组已折叠，点组名展开）`,
            onclick: () => this.selectTab(t.id)
          }));
          continue;
        }
      }
      box.appendChild(this.tabNode(t));
    }
    box.appendChild(el('div', { class: 'br-newtab', title: '新标签页', onclick: () => this.newTab(NEW_TAB, { active: true }) }, uiSpan('plus')));
    box.appendChild(el('div', {
      class: 'br-tabsearch', title: '搜索标签页（Ctrl+Shift+A）', onclick: () => this.toggleTabSearch()
    }, uiSpan('search')));
  },

  groupChip(g) {
    const n = this.tabs.filter((x) => x.groupId === g.id).length;
    return el('div', {
      class: 'br-gchip g-' + g.color + (g.collapsed ? ' collapsed' : ''),
      title: `${g.name}（${n} 个标签）\n左键：折叠 / 展开　右键：重命名、换色、取消分组`,
      onclick: () => this.toggleGroupCollapse(g.id),
      oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); this.groupMenu(e, g); }
    },
      el('span', { class: 'br-gchip-dot' }),
      el('span', { class: 'br-gchip-name ellipsis', text: g.name }),
      el('span', { class: 'br-gchip-n', text: String(n) })
    );
  },

  tabNode(t) {
    return el('div', {
      class: 'br-tab' + (t.id === this.activeId ? ' on' : '') + (t.incognito ? ' incog' : '') + (t.muted ? ' muted' : ''),
      title: t.title + '\n' + t.url + (t.incognito ? '\n（隐身标签页：不记历史、不留 cookie）' : ''),
      onclick: () => this.selectTab(t.id),
      onmousedown: (e) => { if (e.button === 1) this.closeTab(t.id, e); },
      oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); this.tabMenu(e, t); }
    },
      t.incognito
        ? el('span', { class: 'br-tab-fav ph incog' }, uiSpan('shield'))
        : (t.favicon ? el('img', { class: 'br-tab-fav', src: t.favicon, onerror: (e) => { e.target.style.display = 'none'; } }) : el('span', { class: 'br-tab-fav ph' }, uiSpan('globe'))),
      el('span', { class: 'br-tab-title ellipsis', text: t.title || '新标签页' }),
      t.muted ? el('span', { class: 'br-tab-mute', title: '已静音（右键标签可取消）', onclick: (e) => { e.stopPropagation(); this.toggleMute(t); } }, uiSpan('volume-off')) : null,
      t.loading ? el('span', { class: 'br-tab-spin' }) : null,
      el('span', { class: 'br-tab-x', title: '关闭标签', onclick: (e) => this.closeTab(t.id, e) }, '✕')
    );
  },

  /* ---------------- 标签组 ---------------- */
  newGroup(tabIds, name) {
    const id = 'g' + (++this._gseq);
    const used = new Set(this.groups.map((g) => g.color));
    const color = GROUP_COLORS.find((c) => !used.has(c)) || GROUP_COLORS[this.groups.length % GROUP_COLORS.length];
    // 组名默认用组里第一个标签的标题，用户想改再改
    const first = this.tabs.find((t) => tabIds.includes(t.id));
    const g = { id, name: name || (first ? (first.title || '新标签组').slice(0, 12) : '新标签组'), color, collapsed: false };
    this.groups.push(g);
    // ⚠️ 组内标签必须在数组里**连续**，否则组名只会出现在第一段前面。
    //    先把它们摘出来，再插回「最靠前那个被摘走的标签」原来的位置。
    const moved = [];
    const rest = [];
    for (const t of this.tabs) {
      if (tabIds.includes(t.id)) { t.groupId = id; moved.push(t); }
      else rest.push(t);
    }
    const firstIdx = this.tabs.findIndex((t) => tabIds.includes(t.id));
    let before = 0;
    for (let i = 0; i < Math.max(0, firstIdx); i++) if (!tabIds.includes(this.tabs[i].id)) before++;
    this.tabs = [...rest.slice(0, before), ...moved, ...rest.slice(before)];
    this.render();
    return g;
  },

  toggleGroupCollapse(id) {
    const g = this.groups.find((x) => x.id === id);
    if (!g) return;
    g.collapsed = !g.collapsed;
    // 折叠时如果当前标签被藏起来了，切到组里第一个
    const cur = this.active();
    if (cur && cur.groupId === id && g.collapsed) { /* 还能点小圆点，不用换 */ }
    this.renderTabs();
  },

  ungroup(id) {
    for (const t of this.tabs) if (t.groupId === id) t.groupId = '';
    this.groups = this.groups.filter((g) => g.id !== id);
    this.render();
  },

  groupMenu(e, g) {
    const r = e.currentTarget.getBoundingClientRect();
    const items = [
      { label: g.collapsed ? '展开这个组' : '折叠这个组', icon: 'list', onClick: () => this.toggleGroupCollapse(g.id) },
      { label: '重命名…', icon: 'edit', onClick: async () => {
          const n = await window.Shell.prompt({ title: '重命名标签组', label: '组名', value: g.name });
          if (n == null) return;
          g.name = String(n).trim().slice(0, 20) || g.name;
          this.renderTabs();
        } },
      { label: '换个颜色', icon: 'image', onClick: () => {
          const i = GROUP_COLORS.indexOf(g.color);
          g.color = GROUP_COLORS[(i + 1) % GROUP_COLORS.length];
          this.renderTabs();
        } },
      { divider: true },
      { label: '取消分组', icon: 'close', onClick: () => this.ungroup(g.id) },
      { label: '关闭这一组', icon: 'trash', danger: true, onClick: () => {
          const ids = this.tabs.filter((t) => t.groupId === g.id).map((t) => t.id);
          for (const id of ids) this.closeTab(id);
          this.ungroup(g.id);
        } }
    ];
    window.Shell.contextMenu(Math.min(r.left, window.innerWidth - 220), r.bottom + 6, items);
  },

  /* ---------------- 标签右键菜单 ---------------- */
  tabMenu(e, t) {
    const others = this.tabs.filter((x) => x.id !== t.id);
    const items = [
      { label: '新标签页', icon: 'plus', onClick: () => this.newTab(NEW_TAB, { active: true, after: this.tabs.indexOf(t) + 1 }) },
      { label: '复制标签网址', icon: 'link', onClick: () => {
          if (!/^https?:/i.test(t.url || '')) return window.Shell.toast('这个标签没有可复制的网址', 'err');
          try { navigator.clipboard.writeText(t.url); window.Shell.toast('已复制', 'ok'); } catch { window.Shell.toast('复制失败', 'err'); }
        } },
      { label: t.muted ? '取消静音' : '静音这个标签', icon: 'volume-off', onClick: () => this.toggleMute(t) },
      { divider: true },
      { label: '新建标签组（含这个标签）', icon: 'plus', onClick: () => this.newGroup([t.id]) }
    ];
    for (const g of this.groups) {
      if (t.groupId === g.id) {
        items.push({ label: `移出「${g.name}」`, icon: 'close', onClick: () => { t.groupId = ''; this.render(); } });
      } else {
        items.push({ label: `加入「${g.name}」`, icon: 'list', onClick: () => { t.groupId = g.id; this.render(); } });
      }
    }
    items.push(
      { divider: true },
      { label: '关闭其他标签', icon: 'trash', onClick: () => { for (const x of others) this.closeTab(x.id); } },
      { label: '关闭右侧标签', icon: 'trash', onClick: () => {
          const i = this.tabs.indexOf(t);
          for (const x of this.tabs.slice(i + 1)) this.closeTab(x.id);
        } },
      { label: '关闭这个标签', icon: 'close', danger: true, onClick: () => this.closeTab(t.id) }
    );
    const r = e.currentTarget.getBoundingClientRect();
    window.Shell.contextMenu(Math.min(r.left, window.innerWidth - 240), r.bottom + 6, items);
  },

  /* ---------------- 静音 ---------------- */
  toggleMute(t) {
    t.muted = !t.muted;
    if (t.wv) { try { t.wv.setAudioMuted(t.muted); } catch { /* 还没附加 */ } }
    this.renderTabs();
    window.Shell.toast(t.muted ? `已静音「${t.title}」` : `已取消静音「${t.title}」`, 'ok');
  },

  muteAll(on) {
    let n = 0;
    for (const t of this.tabs) {
      t.muted = !!on;
      if (t.wv) { try { t.wv.setAudioMuted(!!on); } catch { /* ignore */ } }
      if (on) n++;
    }
    this.renderTabs();
    window.Shell.toast(on ? `已静音 ${n} 个标签` : '已取消全部静音', 'ok');
  },

  /* ============================================================
   *  页内查找（Ctrl+F）
   * ========================================================== */
  toggleFind() { this._findOpen ? this.closeFind() : this.openFind(); },

  openFind() {
    this._findOpen = true;
    this.findEl.hidden = false;
    this.renderFind();
    const i = this.findEl.querySelector('.br-find-inp');
    if (i) { i.focus(); i.select(); }
  },

  closeFind() {
    this._findOpen = false;
    this.findEl.hidden = true;
    this._findHits = null;
    this._findReq = undefined;
    this._findTries = 0;
    if (this._findTimer) { clearTimeout(this._findTimer); this._findTimer = null; }
    const t = this.active();
    if (t && t.wv && t.attached) { try { t.wv.stopFindInPage('clearSelection'); } catch { /* ignore */ } }
  },

  renderFind() {
    const box = clear(this.findEl);
    const input = el('input', {
      class: 'inp br-find-inp', value: this._findQuery, placeholder: '在页面中查找…',
      /* 敲字 = 换查询词 = **开新会话**（findNext 传 true，见 runFind 上面的注释） */
      oninput: () => { this._findQuery = input.value; this.runFind(input.value, true, true); },
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this._findQuery = input.value;
          /* 回车 / Shift+回车 = 在**当前会话里**跳下一个，所以 findNext 传 false */
          this.runFind(input.value, !e.shiftKey, false);
        } else if (e.key === 'Escape') { e.preventDefault(); this.closeFind(); }
      }
    });
    const hits = this._findHits;
    const n = el('span', {
      class: 'br-find-n' + (hits && hits.total ? '' : ' dim'),
      text: hits ? (hits.total ? `${hits.cur} / ${hits.total}` : '没有匹配') : ''
    });
    box.appendChild(input);
    box.appendChild(n);
    /* 「上一个 / 下一个」都是**在当前会话里继续**，所以 findNext 传 false */
    box.appendChild(el('button', { class: 'br-btn', title: '上一个（Shift+Enter）', onclick: () => this.runFind(this._findQuery, false, false) }, uiSpan('back')));
    box.appendChild(el('button', { class: 'br-btn', title: '下一个（Enter）', onclick: () => this.runFind(this._findQuery, true, false) }, uiSpan('forward')));
    box.appendChild(el('button', { class: 'br-btn', title: '关闭（Esc）', onclick: () => this.closeFind() }, uiSpan('close')));
  },

  /**
   * 🔴🔴 `findNext` 这个名字极其误导 —— 它**不是**「找下一个」，语义正好相反。
   * Electron 官方文档（electron.d.ts · FindInPageOptions）写得很清楚：
   *
   *   findNext — Whether to begin a **new** text finding session with this
   *              request. Should be `true` for **initial** requests, and
   *              `false` for **follow-up** requests. Defaults to `false`.
   *
   * 即：true = **开一次新会话**（用户打完字要搜索）；false = **续上一次会话**
   * （点「下一个 / 上一个」）。如果页面上还没有会话却传了 false，Chromium 直接
   * 当成无事发生 —— `found-in-page` 一个都不发，界面就永远卡在「没有匹配」。
   * 这条是页内查找最核心的坑，之前按名字理解反了，整个功能等于半残。
   */
  runFind(q, forward, findNext) {
    this._findTries = 0;
    /* 还没有会话（第一次查 / 刚导航完）就不能传 false，否则是空转 */
    if (!findNext && !this._findHits) findNext = true;
    this.sendFind(String(q || ''), forward, findNext);
  },

  /** 真正发一次 findInPage。抽出来是因为「事件被吞」时要能原样重发一次 */
  sendFind(text, forward, findNext) {
    const t = this.active();
    this._findQuery = text;
    if (this._findTimer) { clearTimeout(this._findTimer); this._findTimer = null; }
    if (!t || !t.wv || !t.attached) {
      this._findHits = null;
      this.updateFindCount();
      return;
    }
    try {
      if (!text) { t.wv.stopFindInPage('clearSelection'); this._findHits = null; this.updateFindCount(); return; }
      this._findHits = null;              // 上一次查询的计数不许留到这一次
      const rid = t.wv.findInPage(text, { forward: forward !== false, findNext: !!findNext });
      this._findReq = rid;
      const myRid = rid;
      this._findTimer = setTimeout(() => {
        this._findTimer = null;
        if (this._findReq !== myRid || this._findHits) return;
        /* 🔴🔴 这里要兜住实测出来的两个坑：
           ① **一个都没匹配时 Chromium 不一定回报** —— 光等事件的话「没有匹配」
              永远显示不出来，用户以为查找卡住了。
           ② **视口或页面状态一变，进行中的这次查找会被作废，事件石沉大海**。
              最典型的就是「打开查找条」本身：以前查找条占布局，一开就把 webview
              挤矮（727→684px），紧接着发的 findInPage 直接被作废 →
              用户看到「第一次查找永远没有匹配，再按一下才出来」。
              （现在查找条已改成浮层，不会再挤；但切标签 / 页面重排仍可能触发。）
           所以先**原样重发一次**（多半就回来了），两次都没动静才认 0/0。 */
        if (this._findTries < 1) {
          this._findTries += 1;
          this.sendFind(text, forward, findNext);
          return;
        }
        this._findHits = { cur: 0, total: 0 };
        this.updateFindCount();
      }, 450);
    } catch { /* webview 还没就绪 */ }
  },

  /**
   * ⚠️⚠️ `<webview>` 的 `found-in-page` **不把结果摊在事件对象上** ——
   *     真实结构是 `e.result = { requestId, matches, activeMatchOrdinal, selectionArea, finalUpdate }`
   *     （实测：`Object.keys(e)` 只有 `isTrusted, result`）。
   *     照 `webContents` 那套写 `e.matches` 会一直拿到 undefined → 计数永远空白。
   */
  onFound(e) {
    const r = (e && e.result) || e;
    if (!r || r.requestId === undefined) return;
    // 旧请求的迟到回报直接丢掉，否则计数会被前一次查询覆盖
    if (this._findReq !== undefined && Number(r.requestId) !== Number(this._findReq)) return;
    this._findHits = { cur: Number(r.activeMatchOrdinal) || 0, total: Number(r.matches) || 0 };
    this.updateFindCount();
  },

  /** ⚠️ 只改计数那一小块，别整条重画 —— 重画会让输入框失焦，用户打字会断 */
  updateFindCount() {
    const n = this.findEl && this.findEl.querySelector('.br-find-n');
    if (!n) return;
    const h = this._findHits;
    n.textContent = h ? (h.total ? `${h.cur} / ${h.total}` : '没有匹配') : '';
    n.classList.toggle('dim', !(h && h.total));
  },

  /* ============================================================
   *  夜间 / 护眼模式（往页面里注入一段样式）
   * ========================================================== */
  async refreshNight() {
    const r = await API.raw.browser.nightCss().catch(() => null);
    this._nightCss = (r && r.css) || '';
    return this._nightCss;
  },

  async setNight(mode) {
    this.settings = await API.raw.browser.setSettings({ nightMode: mode }).catch((e) => { this.toastErr(e); return this.settings; });
    await this.refreshNight();
    for (const t of this.tabs) this.applyNight(t);
    this.renderMain();
    const NAME = { off: '已关闭', dark: '夜间模式已开（整页压暗）', warm: '护眼模式已开（暖色降蓝光）', both: '夜间 + 护眼都开了' };
    window.Shell.toast(NAME[mode] || '已切换');
  },

  /**
   * 把当前的夜间 CSS 注入这只 webview。
   * ⚠️ 用「插一个带 id 的 <style>」而不是 insertCSS()：id 可以就地覆盖，
   *    不用记 removeInsertedCSS 返回的那串 key，导航后重来一遍也不会叠加。
   */
  async applyNight(t) {
    if (!t || !t.wv || !t.attached) return;
    const css = JSON.stringify(this._nightCss || '');
    const js = "(function(){var o=document.getElementById('__sgj_night');if(o)o.remove();"
      + 'var c=' + css + ";if(!c)return;var s=document.createElement('style');s.id='__sgj_night';"
      + "s.textContent=c;(document.head||document.documentElement).appendChild(s);})();";
    await this.wvJs(t, js, 4000);
  },

  /* ============================================================
   *  鼠标手势
   * ========================================================== */
  async injectGesture(t) {
    if (!t || !t.wv || !t.attached) return;
    if (!this._gestureKit || !this._gestureKit.enabled) return;
    await this.wvJs(t, this._gestureKit.script, 4000);
  },

  async runGesture(dirs) {
    const kit = this._gestureKit || {};
    const act = (kit.map || {})[dirs];
    const t = this.active();
    if (!act) return window.Shell.toast(`手势「${dirs}」还没有绑定动作`, 'err');
    const NAME = { back: '后退', forward: '前进', reload: '刷新', top: '到页首', bottom: '到页尾',
      closeTab: '关闭标签', reopenTab: '恢复标签', newTab: '新标签页', nextTab: '下一个标签' };
    switch (act) {
      case 'back': this.back(); break;
      case 'forward': this.forward(); break;
      case 'reload': this.reload(); break;
      case 'top': await this.wvJs(t, 'window.scrollTo({top:0,behavior:"smooth"})', 3000); break;
      case 'bottom': await this.wvJs(t, 'window.scrollTo({top:document.documentElement.scrollHeight,behavior:"smooth"})', 3000); break;
      case 'closeTab': if (t) this.closeTab(t.id); break;
      case 'reopenTab': this.reopenClosed(); break;
      case 'newTab': this.newTab(NEW_TAB, { active: true }); break;
      case 'nextTab': this.cycleTab(1); break;
    }
    window.Shell.toast(`手势 ${dirs} → ${NAME[act] || act}`);
  },

  async setGestures(on) {
    this.settings = await API.raw.browser.setSettings({ gestures: on }).catch((e) => { this.toastErr(e); return this.settings; });
    this._gestureKit = await API.raw.browser.gestureKit().catch(() => this._gestureKit);
    const t = this.active();
    if (on && t) this.injectGesture(t);
    this.renderMain();
    window.Shell.toast(on ? '鼠标手势已开启：按住右键画 L / R / U / D 等' : '鼠标手势已关闭', 'ok');
  },

  /* ============================================================
   *  标签搜索（Ctrl+Shift+A）
   * ========================================================== */
  toggleTabSearch() { this._tabSearch ? this.closeTabSearch() : this.openTabSearch(); },

  openTabSearch() {
    this._tabSearch = true;
    this.renderTabSearch();
  },

  closeTabSearch() {
    this._tabSearch = false;
    if (this._tsEl && this._tsEl.parentNode) this._tsEl.parentNode.removeChild(this._tsEl);
    this._tsEl = null;
  },

  renderTabSearch() {
    this.closeTabSearchKeepFlag();
    const q0 = this._tsQuery || '';
    const list = el('div', { class: 'br-ts-list' });
    const input = el('input', { class: 'inp br-ts-inp', value: q0, placeholder: '搜索标签页（标题或网址）…' });
    const paint = () => {
      const q = String(input.value || '').trim().toLowerCase();
      this._tsQuery = input.value;
      clear(list);
      const hits = this.tabs.filter((t) => !q
        || String(t.title || '').toLowerCase().includes(q)
        || String(t.url || '').toLowerCase().includes(q));
      if (!hits.length) {
        list.appendChild(el('div', { class: 'br-ts-empty', text: '没有匹配的标签页' }));
        return;
      }
      hits.forEach((t, i) => {
        list.appendChild(el('div', {
          class: 'br-ts-row' + (t.id === this.activeId ? ' on' : '') + (i === 0 ? ' first' : ''),
          onclick: () => { this.closeTabSearch(); this.selectTab(t.id); }
        },
          t.incognito ? el('span', { class: 'br-tab-fav ph incog' }, uiSpan('shield'))
            : (t.favicon ? el('img', { class: 'br-fav', src: t.favicon, onerror: (e) => { e.target.style.display = 'none'; } }) : el('span', { class: 'br-fav ph' }, uiSpan('globe'))),
          el('div', { class: 'tt' },
            el('div', { class: 'n ellipsis', text: t.title || '新标签页' }),
            el('div', { class: 'a ellipsis', text: t.url || '' })
          ),
          t.id === this.activeId ? el('span', { class: 'chip', text: '当前' }) : null
        ));
      });
    };
    input.oninput = paint;
    input.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.closeTabSearch(); }
      if (e.key === 'Enter') {
        const first = (this.tabs.find((t) => {
          const q = String(input.value || '').trim().toLowerCase();
          return !q || String(t.title || '').toLowerCase().includes(q) || String(t.url || '').toLowerCase().includes(q);
        }) || {}).id;
        if (first) { this.closeTabSearch(); this.selectTab(first); }
      }
    };
    paint();
    const box = el('div', { class: 'br-ts' }, input, list);
    box.onclick = (e) => { if (e.target === box) this.closeTabSearch(); };
    this.stageEl.appendChild(box);
    this._tsEl = box;
    setTimeout(() => { try { input.focus(); } catch { /* ignore */ } }, 50);
  },

  closeTabSearchKeepFlag() {
    if (this._tsEl && this._tsEl.parentNode) this._tsEl.parentNode.removeChild(this._tsEl);
    this._tsEl = null;
  },

  /* ============================================================
   *  阅读模式
   * ========================================================== */
  async readMode() {
    const t = this.active();
    if (!t || !t.wv || !t.attached) return window.Shell.toast('先打开一个网页', 'err');
    if (this._reading) return this.closeReading();
    window.Shell.toast('正在提取正文…');
    const r = await this.wvJs(t, READ_SCRIPT, 7000);
    if (!r || !r.ok) return window.Shell.toast('这个页面提取不出正文（可能是首页或应用页）', 'err');
    if (Number(r.textLength) < 200) return window.Shell.toast(`正文太短（${r.textLength} 字），不像文章页`, 'err');
    this._reading = r;
    this._readFont = this._readFont || 17;
    this.renderReading();
  },

  closeReading() {
    this._reading = null;
    this.readEl.hidden = true;
    clear(this.readEl);
  },

  readFont(d) {
    this._readFont = Math.max(13, Math.min(26, (this._readFont || 17) + d));
    const b = this.readEl.querySelector('.br-read-body');
    if (b) b.style.fontSize = this._readFont + 'px';
  },

  renderReading() {
    const r = this._reading;
    const box = clear(this.readEl);
    if (!r) { this.readEl.hidden = true; return; }
    this.readEl.hidden = false;
    box.appendChild(el('div', { class: 'br-read-bar' },
      el('span', { class: 'br-read-tag' }, uiSpan('read'), `阅读模式 · ${r.textLength} 字`),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn-sm', title: '缩小字号', onclick: () => this.readFont(-1) }, 'A−'),
      el('button', { class: 'btn btn-sm', title: '放大字号', onclick: () => this.readFont(1) }, 'A＋'),
      el('button', { class: 'btn btn-sm', onclick: () => { try { navigator.clipboard.writeText(this.readEl.querySelector('.br-read-body').innerText || ''); window.Shell.toast('正文已复制', 'ok'); } catch { window.Shell.toast('复制失败', 'err'); } } }, uiSpan('save'), '复制全文'),
      el('button', { class: 'btn btn-sm', onclick: () => { if (r.url) API.raw.shell.openUrl(r.url).catch(() => {}); } }, uiSpan('globe'), '用系统浏览器打开'),
      el('button', { class: 'btn btn-sm', onclick: () => this.closeReading() }, uiSpan('close'), '退出阅读模式')
    ));
    const body = el('div', { class: 'br-read-body', style: { fontSize: (this._readFont || 17) + 'px' } });
    body.appendChild(el('h1', { class: 'br-read-h1', text: r.title || '（无标题）' }));
    if (r.byline) body.appendChild(el('p', { class: 'br-read-by', text: r.byline }));
    /* ⚠️ 抽出来的正文里**通常已经带了那个 h1**（标题节点本来就在正文容器里），
       上面又单独渲染了一次 r.title —— 不去重标题就会连出现两遍（截图里一眼就看出来）。 */
    let artHtml = r.html || '';
    if (r.title) artHtml = artHtml.replace(/^\s*<h1[^>]*>[\s\S]*?<\/h1>\s*/i, '');
    const art = el('div', { class: 'br-read-html', html: artHtml });
    /* ⚠️ 正文里的链接必须**自己接管**：改成 target=_blank 的话，宿主里点开
       会变成一个没有地址栏的裸窗口（Electron 默认行为）。所以拦下来开成标签页。 */
    art.onclick = (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a') : null;
      if (!a) return;
      const href = a.getAttribute('href') || '';
      if (!/^https?:/i.test(href)) return;
      e.preventDefault();
      this.closeReading();
      this.newTab(href, { active: true });
    };
    body.appendChild(art);
    box.appendChild(body);
    try { box.querySelector('.br-read-body').scrollTop = 0; } catch { /* ignore */ }
  },

  /* ============================================================
   *  截图（可见区域 / 框选区域 / 整页长图）
   * ========================================================== */
  async shot(mode, autoOcr) {
    const t = this.active();
    if (!t || !t.wv || !t.attached) return window.Shell.toast('先打开一个网页再截图', 'err');
    if (mode === 'region') return this.beginRegionShot();
    if (this._busy) return;
    this._busy = 'shot';
    window.Shell.toast(mode === 'full' ? '正在拼整页长图，页面高的话要几秒…' : '正在截图…');
    try {
      let url = '';
      if (mode === 'visible') {
        const img = await this.wvShot(t);
        if (!img) return window.Shell.toast('截图失败（页面没响应），再试一次', 'err');
        url = img.toDataURL();
      } else {
        url = await this.captureFull(t);
      }
      if (!url) return window.Shell.toast('截图失败，再试一次', 'err');
      this.showShot(url, t, '', autoOcr);
    } catch (e) { this.toastErr(e); } finally { this._busy = ''; }
  },

  /**
   * 整页长图：把视口一屏一屏往下滚，逐屏 capturePage 拼到 canvas 上。
   * ⚠️ capturePage 抓的是**当前视口**，不是整页 —— 所谓「整页截图」必须自己拼。
   * ⚠️ 每一屏都可能悬着（见 withTimeout）；某屏没抓到就跳过，别把整张图弄没。
   */
  async captureFull(t) {
    const d = await this.wvJs(t,
      '({ h: Math.max((document.body||{}).scrollHeight||0, document.documentElement.scrollHeight||0),'
      + ' vh: window.innerHeight, w: document.documentElement.clientWidth })', 5000);
    if (!d) return '';
    const vh = Math.max(200, Math.min(4000, Number(d.vh) || 800));
    const w = Math.max(200, Number(d.w) || 1000);
    const MAXH = 16000;                       // canvas 再高浏览器就要炸了
    const total = Math.max(vh, Math.min(MAXH, Math.round(Number(d.h) || vh)));
    const steps = Math.ceil(total / vh);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = total;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, total);
    let painted = 0;
    for (let i = 0; i < steps; i++) {
      const y = i * vh;
      await this.wvJs(t, 'window.scrollTo(0,' + y + ')', 3000);
      await new Promise((r) => setTimeout(r, 260));
      const img = await this.wvShot(t);
      if (!img) continue;                     // 这一屏没抓到 → 跳过，别毁掉整张图
      const bmp = new Image();
      bmp.src = img.toDataURL();
      await bmp.decode().catch(() => {});
      try { ctx.drawImage(bmp, 0, y, w, vh); painted++; } catch { /* 某一屏失败就跳过 */ }
    }
    await this.wvJs(t, 'window.scrollTo(0,0)', 3000);
    if (!painted) return '';                  // 一屏都没抓到 → 老实报失败
    const url = canvas.toDataURL('image/png');
    if (Number(d.h) > MAXH) window.Shell.toast(`页面太高（${d.h}px），只截了前 ${MAXH}px`, 'err');
    return url;
  },

  /** 框选区域截图：在画面上盖一层，拖出一个框，再把框换算成 webview 内的坐标 */
  beginRegionShot() {
    const t = this.active();
    if (!t || !t.wv) return;
    if (this._regionOff) this._regionOff();
    this.shotSelEl.hidden = false;
    const box = clear(this.shotSelEl);
    const hint = el('div', { class: 'br-shot-hint', text: '按住左键拖出要截的区域 · Esc 取消' });
    const rect = el('div', { class: 'br-shot-box', hidden: true });
    box.appendChild(hint);
    box.appendChild(rect);
    const wvr = t.wv.getBoundingClientRect();
    let sx = 0, sy = 0, down = false;
    const onDown = (e) => {
      if (e.button !== 0) return;
      down = true; sx = e.clientX; sy = e.clientY;
      rect.hidden = true;
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!down) return;
      const x = Math.min(sx, e.clientX), y = Math.min(sy, e.clientY);
      const w0 = Math.abs(e.clientX - sx), h0 = Math.abs(e.clientY - sy);
      rect.hidden = false;
      Object.assign(rect.style, { left: x + 'px', top: y + 'px', width: w0 + 'px', height: h0 + 'px' });
      e.preventDefault();
    };
    const onUp = async (e) => {
      if (!down) return;
      down = false;
      const x = Math.min(sx, e.clientX), y = Math.min(sy, e.clientY);
      const w0 = Math.abs(e.clientX - sx), h0 = Math.abs(e.clientY - sy);
      cleanup();
      if (w0 < 8 || h0 < 8) { window.Shell.toast('框太小了，重来一次'); return; }
      // 客户区坐标 → webview 内坐标，再夹到 webview 的可视范围里
      const rx = Math.max(0, Math.round(x - wvr.left));
      const ry = Math.max(0, Math.round(y - wvr.top));
      const rw = Math.max(1, Math.min(Math.round(w0), Math.round(wvr.width) - rx));
      const rh = Math.max(1, Math.min(Math.round(h0), Math.round(wvr.height) - ry));
      this._busy = 'shot';
      try {
        const img = await this.wvShot(t, { x: rx, y: ry, width: rw, height: rh }, 8000);
        if (!img) window.Shell.toast('这一块没截到（页面没响应），再试一次', 'err');
        else this.showShot(img.toDataURL(), t, `${rw}×${rh}`);
      } catch (err) { this.toastErr(err); } finally { this._busy = ''; }
    };
    const onKey = (e) => { if (e.key === 'Escape') { cleanup(); window.Shell.toast('已取消截图'); } };
    const cleanup = () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      document.removeEventListener('keydown', onKey, true);
      this.shotSelEl.hidden = true;
      clear(this.shotSelEl);
      this._regionOff = null;
    };
    this._regionOff = cleanup;
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
    document.addEventListener('keydown', onKey, true);
  },

  showShot(dataUrl, t, sizeText, autoOcr) {
    this._shotImg = dataUrl;
    const box = clear(this.shotEl);
    this.shotEl.hidden = false;
    const name = (t && t.title ? String(t.title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) : 'screenshot');
    /** 取字：把当前这张截图交给 Windows 自带的 OCR */
    const doOcr = async (btn) => {
      if (btn) { btn.disabled = true; btn.dataset.old = btn.textContent; btn.textContent = '识别中…'; }
      try {
        const r = await API.raw.browser.ocrShot({ dataUrl: this._shotImg });
        this.showOcrText((r && r.text) || '');
      } catch (e) { this.toastErr(e); } finally {
        if (btn) { btn.disabled = false; btn.textContent = btn.dataset.old || '取字（OCR）'; }
      }
    };
    const ocrBtn = el('button', { class: 'btn btn-sm', onclick: () => doOcr(ocrBtn) }, uiSpan('type'), '取字（OCR）');
    box.appendChild(el('div', { class: 'br-shot-bar' },
      el('span', { class: 'br-shot-tag' }, uiSpan('crop'), '截图' + (sizeText ? ' · ' + sizeText : '')),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn-sm btn-primary', onclick: async () => {
          try {
            const r = await API.raw.browser.saveShot({ dataUrl: this._shotImg, name });
            window.Shell.toast('已保存到 ' + r.file, 'ok');
            this._shotFile = r.file;
          } catch (e) { this.toastErr(e); }
        } }, uiSpan('save'), '保存到文件'),
      el('button', { class: 'btn btn-sm', onclick: async () => {
          try { await API.raw.browser.copyShot(this._shotImg); window.Shell.toast('已复制到剪贴板', 'ok'); }
          catch (e) { this.toastErr(e); }
        } }, uiSpan('link'), '复制'),
      ocrBtn,
      el('button', { class: 'btn btn-sm', onclick: () => { if (this._shotFile) API.raw.browser.revealShot(this._shotFile).catch(() => {}); else window.Shell.toast('先保存一次，才能定位到文件'); } }, uiSpan('folder'), '打开所在文件夹'),
      el('button', { class: 'btn btn-sm', onclick: () => this.closeShot() }, uiSpan('close'), '关闭')
    ));
    box.appendChild(el('div', { class: 'br-shot-body' }, el('img', { src: dataUrl, alt: '截图预览' })));
    if (autoOcr) doOcr(ocrBtn);
  },

  showOcrText(text) {
    const t = String(text || '').trim();
    if (!t) return window.Shell.toast('这一块没识别出文字', 'err');
    /* ⚠️ textarea 的内容要建完再赋 .value（setAttribute('value') 对 textarea 无效） */
    const ta = el('textarea', {
      class: 'inp', rows: 12, readonly: true,
      style: { width: '100%', fontFamily: 'var(--font-mono, monospace)' }
    });
    ta.value = t;
    window.Shell.modal({
      title: '识别到的文字',
      wide: true,
      body: el('div', {},
        el('p', { class: 'hint', text: '用的是 Windows 自带的 OCR 引擎，纯本地识别，不联网。' }),
        ta
      ),
      okText: '复制并关闭',
      cancelText: '',
      onOk: () => { try { navigator.clipboard.writeText(t); window.Shell.toast('已复制', 'ok'); } catch { /* ignore */ } }
    });
  },

  closeShot() {
    this.shotEl.hidden = true;
    clear(this.shotEl);
    this._shotImg = '';
    this._shotFile = '';
  },

  /* ============================================================
   *  隐身标签页
   * ========================================================== */
  incognitoTab(url) {
    const t = this.newTab(url || NEW_TAB, { active: true, incognito: true });
    window.Shell.toast('已开一个隐身标签页：不进历史、不留 cookie，关掉就没了');
    return t;
  },

  /* ============================================================
   *  书签导入 / 导出
   * ========================================================== */
  async importBookmarks() {
    const r = await API.raw.browser.importBookmarks().catch((e) => { this.toastErr(e); return null; });
    if (!r || r.canceled) return;
    await this.reloadData();
    this.renderMain();
    const x = r.result || {};
    window.Shell.toast(`从文件导入 ${x.added || 0} 条（跳过重复 ${x.skipped || 0} 条，共读到 ${x.total || 0} 条）`, 'ok');
  },

  async exportBookmarks() {
    if (!this.bookmarks.length) return window.Shell.toast('收藏夹是空的，没什么可导出的', 'err');
    const r = await API.raw.browser.exportBookmarks().catch((e) => { this.toastErr(e); return null; });
    if (!r || r.canceled) return;
    window.Shell.toast(`已导出 ${this.bookmarks.length} 条到 ${r.file}`, 'ok');
  },

  /* ============================================================
   *  广告过滤
   * ========================================================== */
  onAdBlock(d) {
    if (!d) return;
    this._adStats = d;
    this.renderBar();   // 工具栏上那个小盾牌上的数字
  },

  async setAdblock(on) {
    this.settings = await API.raw.browser.setSettings({ adblock: on }).catch((e) => { this.toastErr(e); return this.settings; });
    this.renderMain();
    window.Shell.toast(on ? '广告过滤已开启（刷新页面后对新请求生效）' : '广告过滤已关闭', 'ok');
  },

  async resetAdStats() {
    await API.raw.browser.adblockReset().catch(() => {});
    this._adStats = { count: 0, byRule: {} };
    this.renderBar();
    window.Shell.toast('拦截计数已归零', 'ok');
  },

  /**
   * 自定义过滤规则。三种写法（主进程 matchAdRule 都认）：
   *   ① 域名片段   ads.example.com   —— 网址里出现这段就拦
   *   ② 星号通配   star.example.com/adtrack/star  —— 星号代表任意字符
   *   ③ 斜杠正则   /(^|\.)ad[sx]?\d*\./   —— 首尾都是斜杠就当正则
   * ⚠️ 内置规则一直生效、这里只加不减；写错了最多是不生效，不会把页面打挂。
   */
  adblockRulesDialog() {
    const cur = (this.settings.adblockRules || []).join('\n');
    /* ⚠️ textarea 的内容**不能**用 el(..., {value}) 写 —— setAttribute('value') 对 textarea
       是无效的（跟 <select> 同一个坑），必须建完再赋 .value。 */
    const ta = el('textarea', {
      class: 'inp', rows: 10, spellcheck: false,
      placeholder: '一行一条，例如：\nads.example.com\nstar.example.com/promo/star\n/(^|\\.)ad[sx]?\\d*\\./',
      style: { width: '100%', fontFamily: 'var(--font-mono, monospace)', fontSize: '.86em' }
    });
    ta.value = cur;
    window.Shell.modal({
      title: '自定义广告过滤规则',
      wide: true,
      body: el('div', {},
        el('p', { class: 'hint', text: '一行一条。可写域名片段、带 * 的通配，或用 /…/ 包起来的正则。内置规则（约 60 条主流广告/统计域名）始终生效，这里只是额外补充。' }),
        ta,
        el('p', { class: 'hint', text: '改完对新发出的请求生效，已经加载完的页面刷新一下就好。' })
      ),
      okText: '保存规则',
      onOk: async () => {
        const list = String(ta.value || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 500);
        this.settings = await API.raw.browser.setSettings({ adblockRules: list }).catch((e) => { this.toastErr(e); return this.settings; });
        this.renderMain();
        window.Shell.toast(list.length ? `已保存 ${list.length} 条自定义规则` : '自定义规则已清空（内置规则照常）', 'ok');
      }
    });
  },

  renderBar() {
    const bar = clear(this.barEl);
    const t = this.active();

    const btn = (ic, title, fn, cls) =>
      el('button', { class: 'br-btn' + (cls ? ' ' + cls : ''), title, onclick: fn }, uiSpan(ic));

    bar.appendChild(el('div', { class: 'br-nav' },
      btn('back', '后退', () => this.back(), (t && t.canBack === false) ? 'off' : ''),
      btn('forward', '前进', () => this.forward(), (t && t.canForward === false) ? 'off' : ''),
      t && t.loading ? btn('stop', '停止加载', () => this.stop()) : btn('refresh', '刷新', () => this.reload()),
      btn('home', '主页', () => this.home())
    ));

    const input = el('input', {
      class: 'br-addr', id: 'brAddr', spellcheck: false,
      value: (t && t.url && t.url !== NEW_TAB) ? t.url : '',
      placeholder: '输入网址或搜索内容，回车打开',
      onkeydown: (e) => { if (e.key === 'Enter') this.go(e.target.value); },
      onfocus: (e) => { try { e.target.select(); } catch { /* ignore */ } }
    });
    this.addrEl = input;

    const starred = !!(t && t.url && this.bookmarks.some((b) => b.url === t.url));
    bar.appendChild(el('div', { class: 'br-addr-wrap' },
      el('span', { class: 'br-addr-ic' }, uiSpan('search')),
      input,
      el('button', {
        class: 'br-star' + (starred ? ' on' : ''), title: starred ? '已收藏（点一下取消）' : '收藏这个页面',
        onclick: () => this.toggleStar()
      }, uiSpan(starred ? 'star' : 'bookmark'))
    ));

    /* 页面缩放：Ctrl+滚轮 或 Ctrl + +/-/0（主进程在 guest 上处理，见 initZoom）。
       这里只做**显示**，点一下回到 100%。⚠️ 只改这一个按钮，不整条重画（地址栏会失焦）。 */
    let zf = 1;
    try { if (t && t.wv) zf = t.wv.getZoomFactor(); } catch { /* 还没附加 */ }
    const pct = Math.round(zf * 100);

    const nightOn = (this.settings.nightMode || 'off') !== 'off';
    const NIGHT_NAME = { off: '关闭', dark: '夜间', warm: '护眼', both: '夜间+护眼' };
    const blocked = (this._adStats && this._adStats.count) || 0;

    bar.appendChild(el('div', { class: 'br-extra' },
      el('button', {
        class: 'br-zoom' + (pct !== 100 ? ' on' : ''),
        title: `页面缩放 ${pct}%（Ctrl+滚轮 / Ctrl + + - 缩放，Ctrl+0 或点这里回到 100%）`,
        onclick: () => this.resetZoom()
      }, pct + '%'),

      /* 广告过滤：盾牌上带「本次拦了多少条」，点一下看明细 */
      el('button', {
        class: 'br-btn br-ic' + (this.settings.adblock === false ? ' off' : ''),
        title: this.settings.adblock === false ? '广告过滤已关闭 · 点一下看规则' : `广告过滤已拦 ${blocked} 条 · 点一下看规则`,
        onclick: (e) => this.adblockMenu(e)
      }, uiSpan('shield'), blocked > 0 ? el('span', { class: 'br-badge', text: blocked > 99 ? '99+' : String(blocked) }) : null),

      /* 找字 / 阅读 / 截图 —— 浏览器里用得最勤的三个 */
      btn('search', '在页面中查找（Ctrl+F）', () => this.toggleFind(), this._findOpen ? 'on' : ''),
      btn('read', '阅读模式（F9）：只留正文，去掉广告和侧栏', () => this.readMode(), this._reading ? 'on' : ''),
      btn('crop', '截图（Ctrl+Shift+P）：可见区域 / 框选 / 整页长图', (e) => this.shotMenu(e)),
      btn('incognito', '开一个隐身标签页（Ctrl+Shift+N）：不进历史、不留 cookie', () => this.incognitoTab()),
      btn('palette', `页面配色：${NIGHT_NAME[this.settings.nightMode || 'off']}（点一下换一种）`, () => this.nightMenu(), nightOn ? 'on' : ''),
      btn('more', '更多菜单', (e) => this.menu(e))
    ));
  },

  /* ---------------- 工具栏上的小菜单 ---------------- */

  /** 菜单锚点：可能来自工具栏按钮的点击事件，也可能是「更多菜单」里点进来的（没有事件对象） */
  _anchor(e, fallbackRight, fallbackW) {
    const t = e && e.currentTarget;
    if (t && t.getBoundingClientRect) {
      const r = t.getBoundingClientRect();
      return { left: r.left, bottom: r.bottom };
    }
    const b = this.barEl;
    const w = fallbackW || 180;
    if (b) { const r = b.getBoundingClientRect(); return { left: r.right - w, bottom: r.bottom }; }
    return { left: Math.max(8, window.innerWidth - fallbackRight), bottom: 56 };
  },

  /** 截图：三种模式的二级菜单 */
  shotMenu(e) {
    const a = this._anchor(e, 300, 200);
    window.Shell.contextMenu(a.left, a.bottom + 6, [
      { label: '截取可见区域', icon: 'crop', onClick: () => this.shot('visible') },
      { label: '框选一块区域', icon: 'grid', onClick: () => this.shot('region') },
      { label: '整页长图（自己拼接）', icon: 'image', onClick: () => this.shot('full') },
      { divider: true },
      { label: '截完直接取字（OCR）', icon: 'type', onClick: () => this.shot('visible', true) }
    ]);
  },

  /** 广告过滤：明细 + 开关 + 自定义规则 */
  adblockMenu(e) {
    const a = this._anchor(e, 320, 260);
    const st = this._adStats || { count: 0, byRule: {} };
    const rules = Object.keys(st.byRule || {}).sort((a, b) => st.byRule[b] - st.byRule[a]).slice(0, 6);
    const items = [
      { label: `本次已拦 ${st.count || 0} 条`, icon: 'shield', onClick: () => {} }
    ];
    for (const k of rules) items.push({ label: `　${k} × ${st.byRule[k]}`, onClick: () => {} });
    items.push(
      { divider: true },
      { label: this.settings.adblock === false ? '打开广告过滤' : '关掉广告过滤', icon: 'shield',
        onClick: () => this.setAdblock(this.settings.adblock === false) },
      { label: '自定义规则…', icon: 'edit', onClick: () => this.adblockRulesDialog() },
      { label: '拦截计数归零', icon: 'refresh', onClick: () => this.resetAdStats() }
    );
    window.Shell.contextMenu(a.left, a.bottom + 6, items);
  },

  /** 页面配色：关 / 夜间 / 护眼 / 两个都要 */
  nightMenu() {
    const cur = this.settings.nightMode || 'off';
    const opts = [
      ['off', '关闭', '原色显示'],
      ['dark', '夜间模式', '整页压暗，夜里刷网页不刺眼'],
      ['warm', '护眼模式', '暖色降蓝光，偏黄一点'],
      ['both', '夜间 + 护眼', '又暗又暖']
    ];
    const a = this._anchor(null, 300, 240);
    window.Shell.contextMenu(a.left, a.bottom + 6,
      opts.map(([id, name, desc]) => ({
        label: (id === cur ? '✓ ' : '　') + name + '　（' + desc + '）',
        onClick: () => this.setNight(id)
      })));
  },

  renderMain() {
    // ⚠️ 只重画侧栏和覆盖层 —— mainEl / stageEl / viewsEl 一律不动，webview 保持挂载
    /* 切换标签 / 离开新标签页时把「页面设置」面板收掉，免得下次回到新标签页还是设置界面 */
    const t0 = this.tabs.find((x) => x.id === this.activeId) || this.tabs[0] || null;
    if (this._ntpCfg && (!t0 || t0.url !== NEW_TAB)) this._ntpCfg = false;

    const railOn = this.settings.sidebar !== false;
    this.railEl.hidden = !railOn;
    if (this.railOpenEl) this.railOpenEl.hidden = railOn;   // 收起时把那根「展开」窄条露出来
    if (railOn) this.fillRail(this.railEl);

    // 只有当前标签的 webview 可见（见文件头 ①：不能用 display:none）
    for (const t of this.tabs) {
      if (!t.wv) continue;
      t.wv.classList.toggle('on', t.id === this.activeId && this.panel === 'web');
    }

    const t = this.active();
    const ov = clear(this.overlayEl);
    let showOverlay = false;

    if (this.panel === 'web' && t && t.url === NEW_TAB) { ov.appendChild(this.buildNewTab()); showOverlay = true; }
    if (this.panel === 'web' && t && t.failed) {
      showOverlay = true;
      ov.appendChild(el('div', { class: 'br-fail' },
        el('div', { class: 'br-fail-ic' }, uiSpan('globe')),
        el('h3', { text: '这个页面打不开' }),
        el('p', { text: t.failText || '' }),
        el('div', { class: 'row', style: { justifyContent: 'center' } },
          el('button', { class: 'btn', onclick: () => this.reload() }, uiSpan('refresh'), '重试'),
          el('button', { class: 'btn', onclick: () => this.go(this.settings.home) }, uiSpan('home'), '回主页'))
      ));
    }
    if (this.panel === 'bookmarks') { ov.appendChild(this.buildBookmarks()); showOverlay = true; }
    if (this.panel === 'history') { ov.appendChild(this.buildHistory()); showOverlay = true; }
    if (this.panel === 'plugins') { ov.appendChild(this.buildPlugins()); showOverlay = true; }
    if (this.panel === 'settings') { ov.appendChild(this.buildSettings()); showOverlay = true; }

    ov.classList.toggle('on', showOverlay);
  },

  /* ---------------- 侧栏 ---------------- */
  /** 收起 / 展开侧栏（写进设置，下次进来还是这个状态） */
  async toggleRail(on) {
    const want = on === undefined ? this.settings.sidebar === false : !!on;
    this.settings = await API.raw.browser.setSettings({ sidebar: want })
      .catch((e) => { this.toastErr(e); return this.settings; });
    this.render();     // 设置面板里的勾选框也要跟上
    window.Shell.toast(want ? '侧栏已展开' : '侧栏已收起（左侧窄条可以再点开）');
  },

  fillRail(rail) {
    clear(rail);
    rail.appendChild(el('div', { class: 'br-rail-head' },
      el('span', { class: 'br-rail-title', text: '侧栏' }),
      el('button', {
        class: 'br-rail-fold', title: '收起侧栏（收起后点左侧窄条再打开）',
        onclick: () => this.toggleRail(false)
      }, uiSpan('back'))
    ));
    const items = [
      ['bookmarks', 'bookmark', '收藏'],
      ['history', 'clock', '历史'],
      ['plugins', 'plug', '插件'],
      ['settings', 'settings', '设置']
    ];
    for (const [k, ic, label] of items) {
      rail.appendChild(el('div', {
        class: 'br-ri' + (this.panel === k ? ' on' : ''),
        onclick: () => { this.panel = (this.panel === k ? 'web' : k); this.renderMain(); }
      }, uiSpan(ic), el('span', { text: label })));
    }
    rail.appendChild(el('div', { class: 'br-rail-t', text: '收藏夹' }));
    const favs = this.bookmarks.slice(0, 40);
    if (!favs.length) {
      rail.appendChild(el('div', { class: 'br-rail-empty', text: '还没有收藏，点地址栏右边的星星加一个。' }));
    } else {
      for (const b of favs) {
        rail.appendChild(el('div', {
          class: 'br-ri sub', title: b.url,
          onclick: () => { this.panel = 'web'; this.go(b.url); }
        },
          b.favicon ? el('img', { class: 'br-tab-fav', src: b.favicon, onerror: (e) => { e.target.style.display = 'none'; } }) : null,
          el('span', { class: 'ellipsis', text: b.title })
        ));
      }
    }
    return rail;
  },

  /* ---------------- 新标签页（含「页面设置」自定义） ---------------- */
  buildNewTab() {
    if (this._ntpCfg) return this.buildNtpCfg();

    const ntp = (this.settings && this.settings.ntp) || {};
    const bg = ntp.bgUrl || '';
    const preset = !bg && ntp.bgPreset ? (NTP_PRESETS[ntp.bgPreset] || '') : '';
    const hasBg = !!(bg || preset);
    const fit = ntp.bgFit || 'cover';
    const size = fit === 'contain' ? 'contain' : (fit === 'repeat' ? 'auto' : 'cover');
    const repeat = fit === 'repeat' ? 'repeat' : 'no-repeat';
    const blur = Number(ntp.bgBlur) || 0;
    const dim = Number(ntp.bgDim) || 0;
    const rows = Number(ntp.quickRows) === 2 ? 2 : 1;

    const box = el('div', { class: 'br-ntp' + (hasBg ? ' has-bg' : '') });

    if (hasBg) {
      /* ⚠️ 背景单独一层：模糊必须加在这一层上，加在父元素会把搜索框一起糊掉。
         模糊到边缘会露白 → 顺手放大一点点补回来。 */
      const bgStyle = {
        backgroundSize: size, backgroundRepeat: repeat, backgroundPosition: 'center',
        filter: blur ? `blur(${blur}px)` : '', transform: blur ? 'scale(1.06)' : ''
      };
      if (bg) bgStyle.backgroundImage = `url("${String(bg).replace(/"/g, '%22')}")`;
      else bgStyle.background = preset;
      box.appendChild(el('div', { class: 'br-ntp-bg', style: bgStyle }));
      if (dim) box.appendChild(el('div', { class: 'br-ntp-dim', style: { background: `rgba(6,10,18,${(dim / 100).toFixed(2)})` } }));
    }

    const input = el('input', { class: 'br-ntp-input', placeholder: '搜索或输入网址', onkeydown: (e) => { if (e.key === 'Enter') this.go(e.target.value); } });
    setTimeout(() => { try { input.focus(); } catch { /* ignore */ } }, 60);

    const chips = el('div', { class: 'br-ntp-chips' }, this.engines.map((g) =>
      el('span', {
        class: 'chip' + (g.id === this.settings.engine ? ' accent' : ''),
        onclick: async () => {
          this.settings = await API.raw.browser.setSettings({ engine: g.id });
          this.renderMain();
        }
      }, g.name)));

    const inner = el('div', { class: 'br-ntp-inner' },
      el('div', { class: 'br-ntp-logo' }, uiSpan('globe')),
      el('h1', { text: '拾光集浏览器' }),
      el('div', { class: 'br-ntp-search' }, uiSpan('search'), input),
      chips
    );

    /* 快速链接：行数 1 行 = 一行放 8 个，2 行 = 放 16 个 */
    const maxSites = rows * 8;
    if (this.settings.newTabSites !== false && this.sites.length) {
      inner.appendChild(el('div', { class: 'br-ntp-sec' }, el('h3', { text: '常用站点' }),
        el('div', { class: 'br-ntp-grid rows-' + rows }, this.sites.slice(0, maxSites).map((s, i) =>
          el('div', { class: 'br-ntp-site', title: (s.title || '') + '\n' + s.url + '\n右键：编辑 / 删除', onclick: () => this.go(s.url), oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); this.ntpSiteMenu(e, s, i); } },
            s.favicon ? el('img', { class: 'br-ntp-fav', src: s.favicon, onerror: (ev) => { ev.target.style.display = 'none'; } }) : el('div', { class: 'br-ntp-ico', text: (s.title || '?').slice(0, 1) }),
            el('div', { class: 'ellipsis', text: s.title })
          )))));
    }
    if (ntp.showTop !== false && this.topSites.length) {
      inner.appendChild(el('div', { class: 'br-ntp-sec' }, el('h3', { text: '最常访问' }),
        el('div', { class: 'br-ntp-grid rows-' + rows }, this.topSites.slice(0, maxSites).map((s) =>
          el('div', { class: 'br-ntp-site', title: s.url + '（' + s.count + ' 次）', onclick: () => this.go(s.url) },
            el('div', { class: 'br-ntp-ico', text: (s.title || '?').slice(0, 1) }),
            el('div', { class: 'ellipsis', text: s.title }),
            el('div', { class: 'br-ntp-n', text: s.count + ' 次' })
          )))));
    }

    box.appendChild(inner);
    /* 右上角齿轮 —— 就是 Edge 那个「页面设置」入口 */
    box.appendChild(el('button', {
      class: 'br-ntp-gear', title: '页面设置：背景图、快速链接、自定义站点',
      onclick: () => { this._ntpCfg = true; this.renderMain(); }
    }, uiSpan('settings')));
    return box;
  },

  /**
   * 新标签页的「页面设置」面板。
   * 参考 Edge 那个面板的版式，但**去掉了**推广链接 / 必应热点 / 网站导航 / 信息流 / 天气
   * —— 那些跟拾光集自己的风格不搭，也会把本来干净的首页塞满。
   */
  buildNtpCfg() {
    const ntp = (this.settings && this.settings.ntp) || {};
    const rows = Number(ntp.quickRows) === 2 ? 2 : 1;
    const box = el('div', { class: 'br-ntpc' });

    box.appendChild(el('div', { class: 'br-ntpc-head' },
      el('span', { class: 'br-ntpc-title' }, uiSpan('palette'), '页面设置'),
      el('div', { class: 'spacer' }),
      el('button', { class: 'br-btn', title: '返回新标签页', onclick: () => { this._ntpCfg = false; this.renderMain(); } }, uiSpan('close'))
    ));

    /* ---- 背景图片 ---- */
    const thumb = ntp.bgUrl
      ? el('div', { class: 'br-ntpc-thumb', style: { backgroundImage: `url("${String(ntp.bgUrl).replace(/"/g, '%22')}")` } })
      : (ntp.bgPreset
        ? el('div', { class: 'br-ntpc-thumb', style: { background: NTP_PRESETS[ntp.bgPreset] } })
        : el('div', { class: 'br-ntpc-thumb empty' }, uiSpan('image'), el('span', { text: '暂无背景' })));

    const blurRange = el('input', { type: 'range', min: 0, max: 20, step: 1, value: String(Number(ntp.bgBlur) || 0), class: 'br-ntpc-range', oninput: (e) => { lblBlur.textContent = e.target.value + ' px'; }, onchange: (e) => this.saveNtp({ bgBlur: Number(e.target.value) }) });
    const lblBlur = el('span', { class: 'br-ntpc-val', text: (Number(ntp.bgBlur) || 0) + ' px' });
    const dimRange = el('input', { type: 'range', min: 0, max: 80, step: 5, value: String(Number(ntp.bgDim) || 0), class: 'br-ntpc-range', oninput: (e) => { lblDim.textContent = e.target.value + ' %'; }, onchange: (e) => this.saveNtp({ bgDim: Number(e.target.value) }) });
    const lblDim = el('span', { class: 'br-ntpc-val', text: (Number(ntp.bgDim) || 0) + ' %' });

    const fitSel = el('select', { class: 'inp br-ntpc-sel' },
      el('option', { value: 'cover' }, '铺满（裁掉多余部分）'),
      el('option', { value: 'contain' }, '完整显示（可能留边）'),
      el('option', { value: 'repeat' }, '平铺（小图适用）'));
    fitSel.value = ntp.bgFit || 'cover';
    fitSel.onchange = () => this.saveNtp({ bgFit: fitSel.value });

    /* 没有图片也能好看：一组内置渐变，点一下就换（不占磁盘） */
    const presetRow = el('div', { class: 'br-ntpc-presets' },
      Object.keys(NTP_PRESETS).map((id) => el('button', {
        class: 'br-ntpc-ps' + (ntp.bgPreset === id ? ' on' : ''),
        title: NTP_PRESET_NAME[id] || id,
        style: { background: NTP_PRESETS[id] },
        onclick: () => this.saveNtp({ bgPreset: id, bgPath: '' }, '已换成内置背景')
      })));

    box.appendChild(el('div', { class: 'br-ntpc-sec' },
      el('h3', { text: '背景图片' }),
      thumb,
      el('div', { class: 'br-ntpc-row' },
        el('button', { class: 'btn btn-sm', onclick: () => this.pickNtpBg() }, uiSpan('image'), ntp.bgUrl ? '换一张图' : '选一张图'),
        (ntp.bgUrl || ntp.bgPreset) ? el('button', { class: 'btn btn-sm', onclick: () => this.clearNtpBg() }, uiSpan('trash'), '移除背景') : null
      ),
      el('p', { class: 'hint', text: '或者直接用内置渐变（不占磁盘、瞬间切换）：' }),
      presetRow,
      el('div', { class: 'br-ntpc-row' }, el('span', { class: 'br-ntpc-lbl', text: '显示方式' }), fitSel),
      el('div', { class: 'br-ntpc-row' }, el('span', { class: 'br-ntpc-lbl', text: '背景模糊' }), blurRange, lblBlur),
      el('div', { class: 'br-ntpc-row' }, el('span', { class: 'br-ntpc-lbl', text: '压暗遮罩' }), dimRange, lblDim),
      el('p', { class: 'hint', text: '图片会被复制进软件自己的目录，原图挪走 / 删掉都不影响。' })
    ));

    /* ---- 快速链接 ---- */
    box.appendChild(el('div', { class: 'br-ntpc-sec' },
      el('h3', { text: '快速链接' }),
      el('div', { class: 'br-ntpc-row' }, el('span', { class: 'br-ntpc-lbl', text: '显示行数' }),
        el('div', { class: 'br-seg' },
          el('button', { class: 'br-seg-b' + (rows === 1 ? ' on' : ''), onclick: () => this.saveNtp({ quickRows: 1 }) }, '1 行'),
          el('button', { class: 'br-seg-b' + (rows === 2 ? ' on' : ''), onclick: () => this.saveNtp({ quickRows: 2 }) }, '2 行'))),
      el('div', { class: 'br-ntpc-row' }, el('span', { class: 'br-ntpc-lbl', text: '显示「最常访问」' }),
        el('input', { type: 'checkbox', checked: ntp.showTop !== false, onchange: (e) => this.saveNtp({ showTop: e.target.checked }) }))
    ));

    /* ---- 自定义站点 ---- */
    const list = el('div', { class: 'br-ntpc-sites' });
    const all = this.settings.ntp && this.settings.ntp.sites && this.settings.ntp.sites.length
      ? this.settings.ntp.sites : [];
    if (!all.length) {
      list.appendChild(el('p', { class: 'hint', text: '还没有自定义站点 —— 现在用的是内置的默认站点。加一个就会替换掉默认的那批。' }));
    }
    all.forEach((s, i) => {
      list.appendChild(el('div', { class: 'br-ntpc-site' },
        el('div', { class: 'br-ntpc-site-ic', text: (s.title || '?').slice(0, 1) }),
        el('div', { class: 'tt' },
          el('div', { class: 'n ellipsis', text: s.title }),
          el('div', { class: 'a ellipsis', text: s.url })),
        el('button', { class: 'br-btn', title: '编辑', onclick: () => this.ntpSiteDialog(i) }, uiSpan('edit')),
        el('button', { class: 'br-btn', title: '上移', onclick: () => this.moveNtpSite(i, -1) }, uiSpan('back')),
        el('button', { class: 'br-btn', title: '删除', onclick: () => this.delNtpSite(i) }, uiSpan('trash'))
      ));
    });
    const addBtn = el('button', { class: 'btn btn-sm btn-primary', onclick: () => this.ntpSiteDialog(-1) }, uiSpan('plus'), '添加站点');
    const resetBtn = el('button', { class: 'btn btn-sm', onclick: () => this.saveNtp({ sites: [] }, '已恢复成内置默认站点') }, uiSpan('refresh'), '恢复默认');
    box.appendChild(el('div', { class: 'br-ntpc-sec' },
      el('h3', { text: '自定义常用站点' }),
      list,
      el('div', { class: 'br-ntpc-row' }, addBtn, resetBtn,
        el('span', { class: 'hint', text: '最多 24 个' }))
    ));

    box.appendChild(el('div', { class: 'br-ntpc-foot' },
      el('button', { class: 'btn', onclick: () => { this._ntpCfg = false; this.renderMain(); } }, uiSpan('check'), '完成')));
    return box;
  },

  /** 新标签页设置：改一项存一项（不整页重画，滑块拖动会跳） */
  async saveNtp(patch, tip) {
    this.settings = await API.raw.browser.setSettings({ ntp: patch })
      .catch((e) => { this.toastErr(e); return this.settings; });
    this.sites = await API.raw.browser.ntpSites().catch(() => this.sites);
    this.renderMain();
    if (tip) window.Shell.toast(tip, 'ok');
  },

  async pickNtpBg() {
    const r = await API.raw.browser.pickNtpBg()
      .catch((e) => { this.toastErr(e); return null; });
    if (!r || r.canceled) return;
    this.settings = await API.raw.browser.settings().catch(() => this.settings);
    this.renderMain();
    window.Shell.toast('背景图已更新', 'ok');
  },

  async clearNtpBg() {
    await API.raw.browser.clearNtpBg().catch((e) => this.toastErr(e));
    this.settings = await API.raw.browser.settings().catch(() => this.settings);
    this.renderMain();
    window.Shell.toast('背景图已移除', 'ok');
  },

  /** 新标签页上右键一个站点 → 编辑 / 删除 */
  ntpSiteMenu(e, s, i) {
    const custom = !!(this.settings.ntp && this.settings.ntp.sites && this.settings.ntp.sites.length);
    const items = [
      { label: '打开', icon: 'globe', onClick: () => this.go(s.url) },
      { label: '编辑…', icon: 'edit', onClick: () => this.ntpSiteDialog(custom ? i : -1, custom ? null : s) },
      { label: '复制网址', icon: 'link', onClick: () => { try { navigator.clipboard.writeText(s.url); window.Shell.toast('已复制', 'ok'); } catch { /* ignore */ } } }
    ];
    if (custom) items.push({ label: '删除', icon: 'trash', danger: true, onClick: () => this.delNtpSite(i) });
    const r = e.currentTarget.getBoundingClientRect();
    window.Shell.contextMenu(Math.min(r.left, window.innerWidth - 220), r.bottom + 6, items);
  },

  /** 新增 / 编辑自定义站点（idx = -1 表示新增；seed 用来把内置站点「另存为」自定义） */
  ntpSiteDialog(idx, seed) {
    const all = (this.settings.ntp && this.settings.ntp.sites) ? this.settings.ntp.sites.slice() : [];
    const cur = idx >= 0 ? all[idx] : (seed || { title: '', url: '' });
    const nameInp = el('input', { class: 'inp', value: cur.title || '', placeholder: '名字（留空就用域名）' });
    const urlInp = el('input', { class: 'inp', value: cur.url || '', placeholder: 'https://example.com' });
    window.Shell.modal({
      title: idx >= 0 ? '编辑站点' : '添加常用站点',
      body: el('div', {},
        el('div', { class: 'row' }, el('span', { class: 'label', text: '名字' }), nameInp),
        el('div', { class: 'row' }, el('span', { class: 'label', text: '网址' }), urlInp),
        el('p', { class: 'hint', text: '网址可以只写 example.com，会自动补上 https://。' })
      ),
      okText: '保存',
      onOk: async () => {
        const url = String(urlInp.value || '').trim();
        if (!url) {
          /* ⚠️ Shell.modal 的 onOk 没有「返回 false 就不关」的约定（点完一定会关），
             所以校验失败时自己把弹窗重开一次，把用户已经填的带回去。 */
          window.Shell.toast('网址不能为空', 'err');
          const keep = String(nameInp.value || '');
          setTimeout(() => this.ntpSiteDialog(idx, { title: keep, url: '' }), 60);
          return;
        }
        let name = String(nameInp.value || '').trim();
        if (!name) { try { name = new URL(/^[a-z]+:/i.test(url) ? url : 'https://' + url).hostname.replace(/^www\./, ''); } catch { name = url; } }
        const item = { title: name.slice(0, 24), url };
        if (idx >= 0) all[idx] = item; else all.push(item);
        await this.saveNtp({ sites: all.slice(0, 24) }, idx >= 0 ? '站点已更新' : '站点已添加');
      }
    });
  },

  async delNtpSite(i) {
    const all = ((this.settings.ntp && this.settings.ntp.sites) || []).slice();
    all.splice(i, 1);
    await this.saveNtp({ sites: all }, '站点已删除');
  },

  async moveNtpSite(i, d) {
    const all = ((this.settings.ntp && this.settings.ntp.sites) || []).slice();
    const j = i + d;
    if (j < 0 || j >= all.length) return;
    const t = all[i]; all[i] = all[j]; all[j] = t;
    await this.saveNtp({ sites: all });
  },

  /* ---------------- 收藏 ---------------- */
  async toggleStar() {
    const t = this.active();
    if (!t || !t.url || !/^https?:/i.test(t.url)) return window.Shell.toast('当前页面没法收藏', 'err');
    const hit = this.bookmarks.find((b) => b.url === t.url);
    if (hit) {
      await API.raw.browser.removeBookmark([hit.id]).catch(() => {});
      window.Shell.toast('已取消收藏', 'ok');
    } else {
      await API.raw.browser.addBookmark({ url: t.url, title: t.title, favicon: t.favicon, folder: this._bmFolder || '默认' }).catch((e) => this.toastErr(e));
      window.Shell.toast('已加入收藏', 'ok');
    }
    await this.reloadData();
    this.render();
  },

  buildBookmarks() {
    const box = el('div', { class: 'br-panel' });
    box.appendChild(el('div', { class: 'br-panel-head' },
      el('h3', { text: '收藏' }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn-sm', onclick: () => this.addBookmarkDialog() }, uiSpan('plus'), '新增收藏'),
      el('button', { class: 'btn btn-sm', onclick: () => this.closePanel() }, uiSpan('close'), '关闭')
    ));

    box.appendChild(el('div', { class: 'chips' }, this.folders.map((f) =>
      el('span', {
        class: 'chip' + (f === this._bmFolder ? ' accent' : ''),
        oncontextmenu: (e) => { e.preventDefault(); this.folderMenu(e, f); }
      }, f))));

    const list = this.bookmarks.filter((b) => !this._bmFolder || b.folder === this._bmFolder);
    if (!list.length) {
      box.appendChild(el('div', { class: 'empty', style: { minHeight: '220px' } },
        el('h3', { text: '这个收藏夹还是空的' }),
        el('p', { text: '浏览网页时点地址栏右边的星星，或者直接在这新增。' })));
      return box;
    }
    const rows = el('div', { class: 'br-list' });
    for (const b of list) {
      rows.appendChild(el('div', { class: 'br-row', onclick: () => { this.panel = 'web'; this.go(b.url); } },
        b.favicon ? el('img', { class: 'br-fav', src: b.favicon, onerror: (e) => { e.target.style.display = 'none'; } }) : el('span', { class: 'br-fav ph' }, uiSpan('globe')),
        el('div', { class: 'tt' },
          el('div', { class: 'n ellipsis', text: b.title }),
          el('div', { class: 'a ellipsis', text: b.url })
        ),
        el('span', { class: 'chip', text: b.folder || '默认' }),
        el('button', { class: 'btn btn-sm btn-ghost', title: '编辑', onclick: (e) => { e.stopPropagation(); this.editBookmarkDialog(b); } }, uiSpan('edit')),
        el('button', { class: 'btn btn-sm btn-ghost', title: '删除', onclick: (e) => { e.stopPropagation(); this.delBookmark(b); } }, uiSpan('trash'))
      ));
    }
    box.appendChild(rows);
    return box;
  },

  async delBookmark(b) {
    const yes = await window.Shell.confirm({ title: '删除收藏', message: `删除「${b.title}」？`, okText: '删除', cancelText: '取消' });
    if (!yes) return;
    await API.raw.browser.removeBookmark([b.id]).catch(() => {});
    await this.reloadData();
    this.renderMain();
  },

  addBookmarkDialog() { this.editBookmarkDialog(null); },

  editBookmarkDialog(b) {
    const t = this.active();
    const nameInput = el('input', { class: 'inp', value: b ? b.title : (t ? t.title : ''), placeholder: '名称' });
    const urlInput = el('input', { class: 'inp', value: b ? b.url : (t && /^https?:/i.test(t.url || '') ? t.url : ''), placeholder: 'https://...' });
    const folderSel = el('select', { class: 'inp' }, this.folders.map((f) => el('option', { value: f }, f)));
    folderSel.value = b ? (b.folder || '默认') : (this._bmFolder || '默认');

    window.Shell.modal({
      title: b ? '编辑收藏' : '新增收藏',
      body: el('div', {},
        el('div', { class: 'row' }, el('span', { class: 'label', text: '名称' }), nameInput),
        el('div', { class: 'row' }, el('span', { class: 'label', text: '地址' }), urlInput),
        el('div', { class: 'row' }, el('span', { class: 'label', text: '收藏夹' }), folderSel)
      ),
      okText: '保存',
      onOk: async () => {
        const url = (urlInput.value || '').trim();
        if (!url) throw new Error('地址不能为空');
        if (b) await API.raw.browser.updateBookmark(b.id, { title: (nameInput.value || '').trim(), url, folder: folderSel.value });
        else await API.raw.browser.addBookmark({ title: (nameInput.value || '').trim(), url, folder: folderSel.value });
        this._bmFolder = folderSel.value;
        await this.reloadData();
        this.render();
        window.Shell.toast('已保存', 'ok');
      }
    });
  },

  folderMenu(e, folder) {
    window.Shell.contextMenu(e.clientX, e.clientY, [
      { label: '重命名收藏夹', icon: 'edit', onClick: async () => {
          const n = await window.Shell.prompt({ title: '重命名收藏夹', label: '名称', value: folder });
          if (!n || !n.trim()) return;
          for (const b of this.bookmarks.filter((x) => x.folder === folder)) {
            await API.raw.browser.updateBookmark(b.id, { folder: n.trim() }).catch(() => {});
          }
          this._bmFolder = n.trim();
          await this.reloadData();
          this.renderMain();
        } },
      { label: '删除收藏夹', icon: 'trash', onClick: async () => {
          const yes = await window.Shell.confirm({
            title: '删除收藏夹', message: `删除「${folder}」？`,
            detail: '里面的书签会一起删掉（想保留可以先把它们挪到别的夹子）。',
            okText: '删除', cancelText: '取消'
          });
          if (!yes) return;
          await API.raw.browser.removeFolder(folder, false);
          this._bmFolder = '';
          await this.reloadData();
          this.renderMain();
        } },
      { divider: true },
      { label: '新建收藏夹', icon: 'plus', onClick: async () => {
          const n = await window.Shell.prompt({ title: '新建收藏夹', label: '名称', value: '' });
          if (!n || !n.trim()) return;
          this._bmFolder = n.trim();
          await API.raw.browser.addFolder(n.trim()).catch((e) => this.toastErr(e));
          await this.reloadData();
          this.renderMain();
        } }
    ]);
  },

  /* ---------------- 历史 ---------------- */
  buildHistory() {
    const box = el('div', { class: 'br-panel' });
    box.appendChild(el('div', { class: 'br-panel-head' },
      el('h3', { text: '历史' }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn-sm btn-danger', onclick: () => this.clearHistory() }, uiSpan('trash'), '清空历史'),
      el('button', { class: 'btn btn-sm', onclick: () => this.closePanel() }, uiSpan('close'), '关闭')
    ));

    const search = el('input', { class: 'inp grow', placeholder: '搜索历史（标题或网址）', value: this._histQ });
    search.oninput = async () => {
      this._histQ = search.value || '';
      this.history = await API.raw.browser.history({ q: this._histQ }).catch(() => []);
      const list = box.querySelector('.br-list');
      if (list) { clear(list); this.paintHistory(list); }
    };
    box.appendChild(el('div', { class: 'row' }, search));

    const list = el('div', { class: 'br-list' });
    box.appendChild(list);
    this.paintHistory(list);
    return box;
  },

  paintHistory(list) {
    if (!this.history.length) {
      list.appendChild(el('div', { class: 'empty', style: { minHeight: '200px' } },
        el('h3', { text: '没有历史记录' }),
        el('p', { text: this._histQ ? '换个关键词试试。' : '浏览过的网页会出现在这里。' })));
      return;
    }
    // 按天分组
    const groups = new Map();
    for (const h of this.history) groups.set(this.dayLabel(h.visitedAt), [...(groups.get(this.dayLabel(h.visitedAt)) || []), h]);
    for (const [day, items] of groups) {
      list.appendChild(el('div', { class: 'br-group', text: day }));
      for (const h of items) {
        list.appendChild(el('div', { class: 'br-row', onclick: () => { this.panel = 'web'; this.go(h.url); } },
          h.favicon ? el('img', { class: 'br-fav', src: h.favicon, onerror: (e) => { e.target.style.display = 'none'; } }) : el('span', { class: 'br-fav ph' }, uiSpan('clock')),
          el('div', { class: 'tt' },
            el('div', { class: 'n ellipsis', text: h.title }),
            el('div', { class: 'a ellipsis', text: h.url })
          ),
          el('span', { class: 'br-time', text: this.timeLabel(h.visitedAt) }),
          h.count > 1 ? el('span', { class: 'chip', text: h.count + ' 次' }) : null,
          el('button', { class: 'btn btn-sm btn-ghost', title: '删除这条', onclick: (e) => { e.stopPropagation(); this.delHistory(h); } }, uiSpan('trash'))
        ));
      }
    }
  },

  async delHistory(h) {
    await API.raw.browser.removeHistory([h.id]).catch(() => {});
    await this.reloadData();
    this.renderMain();
  },

  async clearHistory() {
    const yes = await window.Shell.confirm({ title: '清空历史', message: `删除全部 ${this.history.length} 条历史记录？`, detail: '收藏不受影响。', okText: '清空', cancelText: '取消' });
    if (!yes) return;
    await API.raw.browser.clearHistory();
    await this.reloadData();
    this.renderMain();
    window.Shell.toast('历史已清空', 'ok');
  },

  dayLabel(ts) {
    const d = new Date(ts || 0);
    const now = new Date();
    const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const t0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((d0 - t0) / 86400000);
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff < 7) return diff + ' 天前';
    return d.toLocaleDateString('zh-CN');
  },
  timeLabel(ts) {
    const d = new Date(ts || 0);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  },

  /* ---------------- 插件 ---------------- */
  buildPlugins() {
    const box = el('div', { class: 'br-panel' });
    box.appendChild(el('div', { class: 'br-panel-head' },
      el('h3', { text: '插件' }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn-sm', onclick: () => this.pickScript() }, uiSpan('download'), '从文件导入'),
      el('button', { class: 'btn btn-sm', onclick: () => this.pluginDialog(null) }, uiSpan('plus'), '新建'),
      el('button', { class: 'btn btn-sm', onclick: () => this.pickExtension() }, uiSpan('plug'), '加载解压版扩展'),
      el('button', { class: 'btn btn-sm', onclick: () => this.closePanel() }, uiSpan('close'), '关闭')
    ));

    box.appendChild(el('div', { class: 'src-tip' },
      el('span', {}, '脚本 / 样式插件按网址匹配后自动注入，这个一定管用。'),
      el('span', { class: 'text-dim', style: { fontSize: '.82em' } },
        '「解压版扩展」走的是 Electron 的扩展接口 —— 它只实现了 Chrome 扩展 API 的一部分，' +
        '用到未实现接口的扩展会失效，这是内核限制，不是本软件的问题。')
    ));

    if (this.extensions.length) {
      box.appendChild(el('div', { class: 'br-group', text: '已加载的扩展' }));
      const ex = el('div', { class: 'br-list' });
      for (const e of this.extensions) {
        ex.appendChild(el('div', { class: 'br-row' },
          el('span', { class: 'br-fav ph' }, uiSpan('plug')),
          el('div', { class: 'tt' },
            el('div', { class: 'n ellipsis', text: e.name || e.id }),
            el('div', { class: 'a ellipsis', text: e.path || '' })
          ),
          e.version ? el('span', { class: 'chip', text: 'v' + e.version }) : null,
          el('button', { class: 'btn btn-sm btn-ghost', title: '卸载', onclick: () => this.unloadExt(e) }, uiSpan('trash'))
        ));
      }
      box.appendChild(ex);
    }

    box.appendChild(el('div', { class: 'br-group', text: '脚本与样式' }));
    const list = el('div', { class: 'br-list' });
    if (!this.plugins.length) {
      list.appendChild(el('div', { class: 'empty', style: { minHeight: '140px' } },
        el('p', { text: '还没有插件。点「新建」写一段 JS / CSS，或者从文件导入 .user.js / .css。' })));
    }
    const KIND = { script: 'JS 脚本', css: 'CSS 样式', extension: '扩展' };
    for (const p of this.plugins) {
      list.appendChild(el('div', { class: 'br-row' + (p.enabled ? '' : ' off') },
        el('span', { class: 'br-fav ph' }, uiSpan(p.kind === 'css' ? 'image' : 'plug')),
        el('div', { class: 'tt' },
          el('div', { class: 'n ellipsis' }, p.name, p.source === 'builtin' ? el('span', { class: 'chip', text: '内置' }) : null),
          el('div', { class: 'a ellipsis', text: p.desc || ((p.matches || []).join('、') || '全站生效') })
        ),
        el('span', { class: 'chip', text: KIND[p.kind] || p.kind }),
        el('button', {
          class: 'btn btn-sm' + (p.enabled ? '' : ' btn-primary'),
          onclick: async (e) => {
            e.stopPropagation();
            await API.raw.browser.togglePlugin(p.id).catch((err) => this.toastErr(err));
            await this.reloadData();
            this.renderMain();
            const t = this.active();
            if (t) this.injectPlugins(t);
          }
        }, p.enabled ? '停用' : '启用'),
        el('button', { class: 'btn btn-sm btn-ghost', title: '编辑', onclick: (e) => { e.stopPropagation(); this.pluginDialog(p); } }, uiSpan('edit')),
        el('button', { class: 'btn btn-sm btn-ghost', title: '删除', onclick: (e) => { e.stopPropagation(); this.delPlugin(p); } }, uiSpan('trash'))
      ));
    }
    box.appendChild(list);
    return box;
  },

  async delPlugin(p) {
    const yes = await window.Shell.confirm({ title: '删除插件', message: `删除「${p.name}」？`, okText: '删除', cancelText: '取消' });
    if (!yes) return;
    await API.raw.browser.removePlugin(p.id).catch((e) => this.toastErr(e));
    await this.reloadData();
    this.renderMain();
  },

  pluginDialog(p) {
    const kindSel = el('select', { class: 'inp' },
      el('option', { value: 'script' }, 'JS 脚本（页面加载完执行）'),
      el('option', { value: 'css' }, 'CSS 样式（页面加载时插入）'));
    kindSel.value = p ? p.kind : 'script';

    const nameInput = el('input', { class: 'inp', value: p ? p.name : '', placeholder: '例如：B 站去广告' });
    const descInput = el('input', { class: 'inp', value: p ? (p.desc || '') : '', placeholder: '一句话说明（可选）' });
    const matchInput = el('input', { class: 'inp', value: p ? (p.matches || []).join(', ') : '*://*/*', placeholder: '生效网址，逗号分隔，如 *://*.bilibili.com/*' });
    const codeArea = el('textarea', {
      class: 'inp', rows: 10, spellcheck: false,
      value: p ? (p.kind === 'css' ? (p.css || '') : (p.code || '')) : '',
      placeholder: kindSel.value === 'css' ? 'body { background: #111 }' : "(function(){ console.log('hello'); })();"
    });
    kindSel.onchange = () => {
      codeArea.placeholder = kindSel.value === 'css' ? 'body { background: #111 }' : "(function(){ console.log('hello'); })();";
    };

    window.Shell.modal({
      title: p ? '编辑插件' : '新建插件',
      wide: true,
      body: el('div', {},
        el('div', { class: 'row' }, el('span', { class: 'label', text: '名称' }), nameInput),
        el('div', { class: 'row' }, el('span', { class: 'label', text: '类型' }), kindSel),
        el('div', { class: 'row' }, el('span', { class: 'label', text: '生效网址' }), matchInput),
        el('div', { class: 'row' }, el('span', { class: 'label', text: '说明' }), descInput),
        el('div', { class: 'row', style: { alignItems: 'flex-start' } },
          el('span', { class: 'label', text: '内容' }), codeArea)
      ),
      okText: '保存',
      onOk: async () => {
        const name = (nameInput.value || '').trim();
        if (!name) throw new Error('名称不能为空');
        const body = codeArea.value || '';
        const payload = {
          name,
          desc: (descInput.value || '').trim(),
          kind: kindSel.value,
          matches: (matchInput.value || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean),
          code: kindSel.value === 'css' ? '' : body,
          css: kindSel.value === 'css' ? body : ''
        };
        if (p) await API.raw.browser.updatePlugin(p.id, payload);
        else await API.raw.browser.addPlugin(payload);
        await this.reloadData();
        this.renderMain();
        window.Shell.toast('已保存', 'ok');
      }
    });
  },

  /** 从 .js / .user.js / .css 导入（主进程已经把内容和 @match 一并解析好了） */
  async pickScript() {
    const files = await API.raw.browser.pickScript().catch(() => []);
    if (!files || !files.length) return;
    let n = 0;
    for (const f of files) {
      const isCss = /\.css$/i.test(f.path);
      const name = (f.name || window.util.baseName(f.path).replace(/\.(user\.)?(js|css)$/i, '') || '导入的插件').slice(0, 60);
      const okItem = await API.raw.browser.addPlugin({
        name,
        kind: isCss ? 'css' : 'script',
        code: isCss ? '' : (f.text || ''),
        css: isCss ? (f.text || '') : '',
        matches: (f.matches && f.matches.length) ? f.matches : ['*://*/*'],
        desc: f.path
      }).then(() => true).catch(() => false);
      if (okItem) n++;
    }
    await this.reloadData();
    this.renderMain();
    window.Shell.toast(n ? `已导入 ${n} 个插件（生效网址取自 @match，没有就是全站）` : '没有导入成功', n ? 'ok' : 'err');
  },

  async pickExtension() {
    const dir = await API.raw.browser.pickExtDir().catch(() => '');
    if (!dir) return;
    const r = await API.raw.browser.loadExtension(dir).catch((e) => { this.toastErr(e); return null; });
    if (!r) return;
    const nm = window.util.baseName(dir);
    await API.raw.browser.addPlugin({ name: nm, kind: 'extension', dir, desc: '解压版 Chrome 扩展：' + dir }).catch(() => {});
    await this.reloadData();
    this.renderMain();
    window.Shell.toast(`已加载扩展「${(r && r.name) || nm}」`, 'ok');
  },

  async unloadExt(e) {
    const dir = e.path || '';
    if (!dir) return;
    await API.raw.browser.unloadExtension(dir).catch((err) => this.toastErr(err));
    await this.reloadData();
    this.renderMain();
    window.Shell.toast('扩展已卸载', 'ok');
  },

  /* ---------------- 设置 ---------------- */
  buildSettings() {
    const box = el('div', { class: 'br-panel' });
    box.appendChild(el('div', { class: 'br-panel-head' },
      el('h3', { text: '浏览器设置' }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn-sm', onclick: () => this.closePanel() }, uiSpan('close'), '关闭')
    ));

    const homeInput = el('input', { class: 'inp', value: this.settings.home || '', placeholder: 'https://www.bing.com/' });
    const engineSel = el('select', { class: 'inp' }, this.engines.map((g) => el('option', { value: g.id }, g.name)));
    engineSel.value = this.settings.engine;
    const sideBox = el('input', { type: 'checkbox', id: 'brSide' });
    sideBox.checked = this.settings.sidebar !== false;
    const ntpBox = el('input', { type: 'checkbox', id: 'brNtp' });
    ntpBox.checked = this.settings.newTabSites !== false;

    // ⚠️ onchange 必须在 el() 外面挂：写进 children 里的话，赋值表达式返回的是函数，
    // 会被 el() 当成子节点去 appendChild。
    const save = async (patch) => {
      this.settings = await API.raw.browser.setSettings(patch).catch((e) => { this.toastErr(e); return this.settings; });
      this.render();
    };
    engineSel.onchange = () => save({ engine: engineSel.value });
    sideBox.onchange = () => save({ sidebar: sideBox.checked });
    ntpBox.onchange = () => save({ newTabSites: ntpBox.checked });

    box.appendChild(el('div', { class: 'card' },
      el('h3', { text: '常规' }),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '主页' }), homeInput,
        el('button', { class: 'btn', onclick: () => save({ home: (homeInput.value || '').trim() }) }, uiSpan('save'), '保存')),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '默认搜索引擎' }), engineSel,
        el('span', { class: 'text-dim', style: { fontSize: '.82em' } }, '地址栏里不是网址的内容就用它搜索')),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '侧边栏' }), sideBox,
        el('span', {}, '显示收藏夹侧栏（也可以点侧栏右上角那个 ‹ 就地收起，收起后点左侧窄条再打开）')),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '缩放' }),
        el('span', { class: 'text-dim', style: { fontSize: '.82em' } },
          '按住 Ctrl 滚鼠标滚轮缩放页面，Ctrl + + / - 微调，Ctrl + 0 回到 100%；工具栏右侧会显示当前百分比。')),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '新标签页' }), ntpBox,
        el('span', {}, '新标签页上显示常用站点'),
        el('button', { class: 'btn btn-sm', onclick: () => { this.panel = 'web'; this._ntpCfg = true; this.newTab(NEW_TAB, { active: true }); this.renderMain(); } },
          uiSpan('palette'), '页面设置（背景图 / 快速链接 / 自定义站点）'))
    ));

    /* ---------------- 广告过滤 ---------------- */
    const adBox = el('input', { type: 'checkbox' });
    adBox.checked = this.settings.adblock !== false;
    adBox.onchange = () => this.setAdblock(adBox.checked);
    const st = this._adStats || { count: 0, byRule: {} };
    const ruleList = Object.keys(st.byRule || {}).sort((a, b) => st.byRule[b] - st.byRule[a]).slice(0, 8);
    box.appendChild(el('div', { class: 'card' },
      el('h3', { text: '广告过滤' }),
      el('p', { class: 'hint', text: '在网络层拦掉主流广告 / 统计域名（约 60 条内置规则），不注入脚本、不改页面。改完对之后发出的请求生效。' }),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '开关' }), adBox,
        el('span', {}, '打开后新请求才会被拦（当前页面刷一下）')),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '本次已拦' }),
        el('span', { class: 'br-ad-num', text: String(st.count || 0) + ' 条' }),
        el('button', { class: 'btn btn-sm', onclick: () => this.resetAdStats() }, uiSpan('refresh'), '计数归零'),
        el('button', { class: 'btn btn-sm', onclick: () => this.adblockRulesDialog() }, uiSpan('edit'), '自定义规则'),
        el('span', { class: 'text-dim', style: { fontSize: '.82em' } }, `自定义 ${(this.settings.adblockRules || []).length} 条`)),
      ruleList.length ? el('div', { class: 'br-ad-list' }, ruleList.map((k) =>
        el('span', { class: 'chip' }, `${k} × ${st.byRule[k]}`))) : null
    ));

    /* ---------------- 夜间 / 护眼 ---------------- */
    const nightSel = el('select', { class: 'inp' },
      el('option', { value: 'off' }, '关闭（原色）'),
      el('option', { value: 'dark' }, '夜间模式（整页压暗）'),
      el('option', { value: 'warm' }, '护眼模式（暖色降蓝光）'),
      el('option', { value: 'both' }, '夜间 + 护眼'));
    nightSel.value = this.settings.nightMode || 'off';
    nightSel.onchange = () => this.setNight(nightSel.value);
    box.appendChild(el('div', { class: 'card' },
      el('h3', { text: '页面配色（夜间 / 护眼）' }),
      el('p', { class: 'hint', text: '往里注入一段 CSS，只影响显示、不改网页本身。每个已打开的标签都会立刻生效。' }),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '模式' }), nightSel)
    ));

    /* ---------------- 鼠标手势 ---------------- */
    const ghBox = el('input', { type: 'checkbox' });
    ghBox.checked = this.settings.gestures !== false;
    ghBox.onchange = () => this.setGestures(ghBox.checked);
    const kit = this._gestureKit || { map: {} };
    const DIR_NAME = { L: '← 左', R: '→ 右', U: '↑ 上', D: '↓ 下', DR: '↘ 右下', UR: '↗ 右上', LR: '←→ 左右', DU: '↓↑ 下上', DL: '↙ 左下' };
    const ACT_NAME = { back: '后退', forward: '前进', reload: '刷新', top: '到页首', bottom: '到页尾',
      closeTab: '关闭标签', reopenTab: '恢复刚关的标签', newTab: '新标签页', nextTab: '下一个标签' };
    const gmap = (this.settings.gestureMap || kit.map || {});
    box.appendChild(el('div', { class: 'card' },
      el('h3', { text: '鼠标手势' }),
      el('p', { class: 'hint', text: '在页面上**按住鼠标右键**画线，松手执行。轨迹会在页面里画出来。' }),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '开关' }), ghBox,
        el('span', {}, '关掉后页面不再注入手势脚本')),
      el('div', { class: 'br-gmap' }, Object.keys(gmap).map((dir) =>
        el('div', { class: 'br-gmap-row' },
          el('kbd', { text: DIR_NAME[dir] || dir }),
          el('span', { class: 'br-gmap-ar', text: '→' }),
          el('span', { text: ACT_NAME[gmap[dir]] || gmap[dir] || '（未绑定）' })
        )))
    ));

    /* ---------------- 标签页 ---------------- */
    box.appendChild(el('div', { class: 'card' },
      el('h3', { text: '标签页' }),
      el('p', { class: 'hint', text: '标签组、静音、恢复关闭都在标签条上：' }),
      el('ul', { class: 'br-tips' },
        el('li', { html: '<b>标签组</b>：在标签上<b>右键</b>→「新建标签组」，组名左键折叠 / 展开，右键改名换色。' }),
        el('li', { html: '<b>静音</b>：标签右键→静音这个标签；想一键全静音用下面的按钮。' }),
        el('li', { html: '<b>恢复关闭</b>：Ctrl+Shift+T，或者菜单里的「恢复刚关掉的标签」（最多记 25 个，隐身标签不进这个栈）。' }),
        el('li', { html: '<b>搜索标签</b>：标签条最右边那个放大镜，或 Ctrl+Shift+A。' })),
      el('div', { class: 'row' },
        el('button', { class: 'btn btn-sm', onclick: () => this.muteAll(true) }, uiSpan('volume-off'), '全部静音'),
        el('button', { class: 'btn btn-sm', onclick: () => this.muteAll(false) }, uiSpan('play'), '取消全部静音'),
        el('button', { class: 'btn btn-sm', onclick: () => this.reopenClosed() }, uiSpan('refresh'), `恢复关闭的标签（${this.closed.length}）`),
        el('button', { class: 'btn btn-sm', onclick: () => this.openTabSearch() }, uiSpan('search'), '搜索标签页'),
        el('button', { class: 'btn btn-sm', onclick: () => this.incognitoTab() }, uiSpan('incognito'), '隐身标签页'))
    ));

    /* ---------------- 书签导入导出 ---------------- */
    box.appendChild(el('div', { class: 'card' },
      el('h3', { text: '书签导入 / 导出' }),
      el('p', { class: 'hint', text: '用的是 Netscape 书签格式（Chrome / Edge / Firefox 导出出来的 .html 都是这个），文件夹层级会一起保留。' }),
      el('div', { class: 'row' },
        el('button', { class: 'btn', onclick: () => this.importBookmarks() }, uiSpan('download'), '从 HTML 文件导入'),
        el('button', { class: 'btn', onclick: () => this.exportBookmarks() }, uiSpan('save'), '导出成 HTML'),
        el('span', { class: 'text-dim', style: { fontSize: '.82em' } }, `当前 ${this.bookmarks.length} 条收藏`))
    ));

    /* ---------------- 快捷键 ---------------- */
    box.appendChild(el('div', { class: 'card' },
      el('h3', { text: '快捷键' }),
      el('p', { class: 'hint', text: 'Ctrl+T 新标签 · Ctrl+W 关闭 · Ctrl+Shift+T 恢复 · Ctrl+Shift+A 搜索标签 · Ctrl+Shift+N 隐身' }),
      el('p', { class: 'hint', text: 'Ctrl+F 页内查找 · F9 阅读模式 · Ctrl+Shift+P 截图 · Ctrl+滚轮 缩放' }),
      el('div', { class: 'row' }, el('button', { class: 'btn btn-sm', onclick: () => this.shortcutsDialog() }, uiSpan('grid'), '看全部快捷键'))
    ));

    box.appendChild(el('div', { class: 'card' },
      el('h3', { text: '隐私与数据' }),
      el('p', { class: 'hint', text: '只清理浏览器分区（persist:sgj-browser）的数据，不影响软件其它模块。隐身标签用的是内存分区，关掉软件什么都不留。' }),
      el('div', { class: 'row', style: { flexWrap: 'wrap' } },
        el('button', { class: 'btn', onclick: () => this.clearData({ cache: true }) }, uiSpan('shield'), '清除缓存'),
        el('button', { class: 'btn', onclick: () => this.clearData({ cookies: true, storage: true }) }, uiSpan('key'), '清除 Cookie 与站点数据'),
        el('button', { class: 'btn btn-danger', onclick: () => this.clearHistory() }, uiSpan('trash'), '清空浏览历史')
      ),
      el('p', { class: 'hint', style: { marginTop: '10px' } },
        '内核：Chromium（Electron 33 内置），伪装 UA 为 Chrome 130。下载会走「网盘」模块的队列。')
    ));
    return box;
  },

  async clearData(o) {
    await API.raw.browser.clearData(o).catch((e) => this.toastErr(e));
    window.Shell.toast('已清理', 'ok');
  },

  closePanel() { this.panel = 'web'; this.renderMain(); },

  /* ---------------- 页面缩放（Ctrl+滚轮 / Ctrl + ±0） ---------------- */
  /** 回到 100%（点工具栏那个百分比胶囊） */
  resetZoom() {
    const t = this.active();
    if (!t || !t.wv) return;
    try { t.wv.setZoomLevel(0); } catch { /* 还没附加 */ }
    t.zoom = 0;
    this.renderBar();
  },

  /**
   * 主进程改完缩放回报（browser:zoom）—— 按 wcId 认领，只更新那个百分比胶囊。
   * ⚠️ 不整条重画工具栏：地址栏会失焦（用户每滚一下都要重新点输入框）。
   */
  onZoom(d) {
    if (!d) return;
    const t = this.active();
    if (!t || !t.wv) return;
    let mine = false;
    try { mine = t.wv.getWebContentsId() === d.wcId; } catch { mine = false; }
    if (!mine) return;
    t.zoom = d.level || 0;
    const btn = this.barEl && this.barEl.querySelector('.br-zoom');
    if (!btn) return;
    const pct = Math.round((d.factor || 1) * 100);
    btn.textContent = pct + '%';
    btn.classList.toggle('on', pct !== 100);
    btn.title = `页面缩放 ${pct}%（Ctrl+滚轮 / Ctrl + + - 缩放，Ctrl+0 或点这里回到 100%）`;
  },

  /* ---------------- 快捷键 ----------------
   * 两条来源：
   *  ① 焦点在**页面里**（webview guest）→ 主进程 before-input-event 拦下来，
   *     经 `browser:key` 送回来（guest 的按键不会冒泡到宿主，见 main.js initShortcuts）
   *  ② 焦点在**界面里**（地址栏 / 新标签页搜索框 / 侧栏）→ 这里监听 document 的 keydown
   *     ⚠️ 两条都得有，只有其中一条的话用户「点一下页面」或「点一下地址栏」就失效了。
   */
  onKey(d) {
    if (!d || !d.id) return;
    // 焦点在 webview 上时，非当前标签的按键要忽略（后台标签不该抢快捷键）
    if (d.wcId) {
      const t = this.active();
      let mine = false;
      try { mine = !!(t && t.wv && t.wv.getWebContentsId() === d.wcId); } catch { mine = false; }
      if (!mine) return;
    }
    this.runShortcut(d.id);
  },

  runShortcut(id) {
    switch (id) {
      case 'find': this.openFind(); break;
      case 'newTab': this.newTab(NEW_TAB, { active: true }); break;
      case 'reopen': this.reopenClosed(); break;
      case 'tabSearch': this.openTabSearch(); break;
      case 'incognito': this.incognitoTab(); break;
      case 'shot': this.shot('visible'); break;
      case 'read': this.readMode(); break;
      case 'closeTab': { const t = this.active(); if (t && this.tabs.length > 1) this.closeTab(t.id); break; }
      case 'nextTab': this.cycleTab(1); break;
      case 'prevTab': this.cycleTab(-1); break;
    }
  },

  /** 焦点在界面上时的快捷键（见上面 ②） */
  hostKeys(e) {
    if (location.hash !== '#/browser') return;
    if (e.altKey || e.metaKey) return;
    const ctrl = e.ctrlKey;
    const k = String(e.key || '');
    const low = k.toLowerCase();
    let id = '';
    if (ctrl && !e.shiftKey && low === 'f') id = 'find';
    else if (ctrl && !e.shiftKey && low === 't') id = 'newTab';
    else if (ctrl && e.shiftKey && low === 't') id = 'reopen';
    else if (ctrl && e.shiftKey && low === 'a') id = 'tabSearch';
    else if (ctrl && e.shiftKey && low === 'n') id = 'incognito';
    else if (ctrl && e.shiftKey && low === 'p') id = 'shot';
    else if (ctrl && !e.shiftKey && low === 'w') id = 'closeTab';
    else if (ctrl && !e.shiftKey && k === 'Tab') id = 'nextTab';
    else if (ctrl && e.shiftKey && k === 'Tab') id = 'prevTab';
    else if (k === 'F9') id = 'read';
    else if (k === 'Escape' && this._findOpen) { e.preventDefault(); this.closeFind(); return; }
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    this.runShortcut(id);
  },

  /* ---------------- 右上菜单 ---------------- */
  menu(e) {
    const t = this.active();
    const r = e.currentTarget.getBoundingClientRect();
    let zf = 1;
    try { if (t && t.wv) zf = t.wv.getZoomFactor(); } catch { /* 还没附加 */ }
    const zPct = Math.round(zf * 100);
    const NIGHT_NAME = { off: '关闭', dark: '夜间', warm: '护眼', both: '夜间+护眼' };
    const night = this.settings.nightMode || 'off';
    const items = [
      { label: '新标签页　Ctrl+T', icon: 'plus', onClick: () => this.newTab(NEW_TAB, { active: true }) },
      { label: '隐身标签页　Ctrl+Shift+N', icon: 'incognito', onClick: () => this.incognitoTab() },
      { label: '恢复刚关掉的标签　Ctrl+Shift+T', icon: 'refresh', onClick: () => this.reopenClosed() },
      { label: '搜索标签页　Ctrl+Shift+A', icon: 'search', onClick: () => this.openTabSearch() },
      { divider: true },
      { label: '在页面中查找　Ctrl+F', icon: 'search', onClick: () => this.openFind() },
      { label: '阅读模式　F9', icon: 'read', onClick: () => this.readMode() },
      { label: `页面配色：${NIGHT_NAME[night]}`, icon: 'palette', onClick: () => this.nightMenu() },
      { label: '截图　Ctrl+Shift+P', icon: 'crop', onClick: (ev) => this.shotMenu(ev) },
      { divider: true },
      { label: '复制当前网址', icon: 'link', onClick: () => {
          if (!t || !t.url) return window.Shell.toast('没有可复制的地址', 'err');
          try { navigator.clipboard.writeText(t.url); window.Shell.toast('已复制', 'ok'); } catch { window.Shell.toast('复制失败', 'err'); }
        } },
      { label: '在系统浏览器打开', icon: 'globe', onClick: () => { if (t && /^https?:/i.test(t.url || '')) API.raw.shell.openUrl(t.url).catch(() => {}); } },
      { label: '用网盘模块下载当前链接', icon: 'download', onClick: async () => {
          if (!t || !/^https?:/i.test(t.url || '')) return window.Shell.toast('当前页面不是可下载的链接', 'err');
          await API.raw.browser.toNetdisk({ url: t.url, name: (t.title || '').replace(/[\\/:*?"<>|]/g, '_') })
            .then(() => window.Shell.toast('已交给网盘模块', 'ok'))
            .catch((err) => this.toastErr(err));
        } },
      { divider: true },
      { label: this.settings.adblock === false ? '打开广告过滤' : '广告过滤：已开', icon: 'shield',
        onClick: () => this.setAdblock(this.settings.adblock === false) },
      { label: '自定义过滤规则…', icon: 'edit', onClick: () => this.adblockRulesDialog() },
      { label: this.settings.gestures === false ? '打开鼠标手势' : '鼠标手势：已开', icon: 'wand',
        onClick: () => this.setGestures(this.settings.gestures === false) },
      { label: '快捷键一览', icon: 'grid', onClick: () => this.shortcutsDialog() },
      { divider: true },
      { label: this.settings.sidebar === false ? '展开侧栏' : '收起侧栏', icon: 'list',
        onClick: () => this.toggleRail(this.settings.sidebar === false) },
      { label: `缩放重置为 100%（当前 ${zPct}%）`, icon: 'refresh', onClick: () => this.resetZoom() },
      { divider: true },
      { label: '开发者工具', icon: 'settings', onClick: () => { if (t && t.wv) { try { t.wv.openDevTools(); } catch { /* ignore */ } } } },
      { divider: true },
      { label: '收藏', icon: 'bookmark', onClick: () => { this.panel = 'bookmarks'; this.renderMain(); } },
      { label: '历史', icon: 'clock', onClick: () => { this.panel = 'history'; this.renderMain(); } },
      { label: '插件', icon: 'plug', onClick: () => { this.panel = 'plugins'; this.renderMain(); } },
      { label: '设置', icon: 'settings', onClick: () => { this.panel = 'settings'; this.renderMain(); } }
    ];
    window.Shell.contextMenu(Math.max(8, r.left - 240), r.bottom + 6, items);
  },

  /** 快捷键一览（用户记不住，摊开给他看） */
  shortcutsDialog() {
    const rows = [
      ['Ctrl + T', '新建标签页'],
      ['Ctrl + W', '关闭当前标签'],
      ['Ctrl + Shift + T', '恢复刚关掉的标签'],
      ['Ctrl + Shift + A', '搜索标签页'],
      ['Ctrl + Shift + N', '开一个隐身标签页'],
      ['Ctrl + F', '页内查找（Enter 下一个 / Shift+Enter 上一个 / Esc 关闭）'],
      ['F9', '阅读模式（再按一次退出）'],
      ['Ctrl + Shift + P', '截图（可见区域 / 框选 / 整页长图）'],
      ['Ctrl + Tab / Ctrl + Shift + Tab', '下一个 / 上一个标签'],
      ['Ctrl + 滚轮 / Ctrl + + - / Ctrl + 0', '放大缩小 / 恢复 100%'],
      ['按住右键画线', '鼠标手势：L 后退 · R 前进 · U/D 到页首页尾 · LR 刷新 …']
    ];
    window.Shell.modal({
      title: '浏览器快捷键',
      wide: true,
      body: el('div', { class: 'br-keys' }, rows.map(([k, d]) =>
        el('div', { class: 'br-keys-row' }, el('kbd', { text: k }), el('span', { text: d })))),
      okText: '知道了',
      cancelText: ''
    });
  }
};

window.BrowserView = BrowserView;

/* ⚠️ 订阅必须放在这里（模块只加载一次），**不能放 mount() 里** ——
 *    mount 每次进模块都会跑，API.on 又不会自动去重，
 *    结果就是进几次模块就叠几层监听（下载提示会 toast 好几次）。
 *    以前 `browser:download` 就踩在这个坑上，一起挪出来。 */
API.on('browser:download', (d) => BrowserView.onDownload(d));
API.on('browser:open-tab', (d) => BrowserView.openFromPage(d));
/* Ctrl+滚轮 / Ctrl + ±0 缩放：主进程在 guest 上改完回报，这里只更新百分比显示 */
API.on('browser:zoom', (d) => BrowserView.onZoom(d));
/* 广告过滤拦了一条 → 盾牌上的数字动一下 */
API.on('browser:adblock', (d) => BrowserView.onAdBlock(d));
/* 页面里按的 Ctrl+F / Ctrl+T 这些键（guest 里的按键不会冒泡到宿主，主进程转回来的） */
API.on('browser:key', (d) => BrowserView.onKey(d));

/* 焦点在界面上（地址栏 / 新标签页搜索框 / 侧栏）时的快捷键。
   ⚠️ 放在 IIFE 末尾 = 只注册一次；放 mount() 里会随进模块次数叠加（见文件头注释）。 */
document.addEventListener('keydown', (e) => BrowserView.hostKeys(e));
})();
