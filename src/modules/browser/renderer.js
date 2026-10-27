/* ============================================================
 * 拾光集 · 浏览器模块界面（browser.dll 里的 UI_JS）
 * ------------------------------------------------------------
 * 网页画布 = 宿主里的第二个 WebView2（browser:view*）。
 * 这里只画标签 / 地址栏 / 书签侧栏，并把画布位置实时报给宿主。
 * 说明：原版那些「查找 / 阅读模式 / 手势 / 广告过滤 / 截图 OCR」
 * 依赖 Electron <webview> 的私有 API，C 版先把「能真正上网」做扎实。
 * ============================================================ */
'use strict';
(function () {
  const { el, clear } = window.util;
  const icon = (n) => (window.ICON && window.ICON.uiSpan ? window.ICON.uiSpan(n) : document.createTextNode(''));

  function styleOnce() {
    if (document.getElementById('br2Style')) return;
    const s = document.createElement('style');
    s.id = 'br2Style';
    s.textContent = `
.br2{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--bg);}
.br2 svg{width:18px;height:18px;display:block}
.br2-addr svg{width:16px;height:16px;display:block;color:var(--text-dim)}
.br2 .btn-ic{font-size:1em}
.br2-tabs{display:flex;gap:6px;align-items:flex-end;padding:8px 12px 0;overflow-x:auto;flex:0 0 auto}
.br2-tab{display:flex;align-items:center;gap:8px;max-width:220px;min-width:120px;height:34px;padding:0 8px 0 12px;border:1px solid var(--border);border-bottom:0;border-radius:10px 10px 0 0;background:var(--bg-soft);cursor:pointer;font-size:.88em;color:var(--text-dim)}
.br2-tab.on{background:var(--bg);color:var(--text);font-weight:600}
.br2-tab .t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.br2-tab .x{opacity:.6;border:0;background:transparent;color:inherit;cursor:pointer;font-size:1em;padding:2px}
.br2-tab .x:hover{opacity:1}
.br2-new{border:0;background:transparent;color:var(--text-dim);cursor:pointer;font-size:1.2em;padding:4px 8px}
.br2-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);flex:0 0 auto;background:var(--bg)}
.br2-bar .btn-ic{width:34px;height:34px;border-radius:9px;border:1px solid var(--border);background:var(--bg-soft);color:var(--text-dim);cursor:pointer;display:grid;place-items:center}
.br2-bar .btn-ic:hover{color:var(--text)}
.br2-bar .btn-ic:disabled{opacity:.4;cursor:default}
.br2-addr{flex:1;display:flex;align-items:center;gap:8px;height:36px;border:1px solid var(--border);border-radius:10px;padding:0 12px;background:var(--bg-soft)}
.br2-addr input{flex:1;border:0;background:transparent;color:var(--text);font-size:.95em;outline:0}
.br2-main{flex:1;display:flex;min-height:0;position:relative}
.br2-stage{flex:1;position:relative;min-width:0;background:var(--bg-soft)}
.br2-hole{position:absolute;inset:0;}
.br2-hole .ph{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--text-dim);font-size:.9em}
.br2-side{width:280px;flex:0 0 auto;border-right:1px solid var(--border);display:flex;flex-direction:column;min-height:0}
.br2-side[hidden]{display:none}
.br2-side h4{margin:14px 14px 8px;font-size:.86em;color:var(--text-dim);font-weight:600}
.br2-list{overflow:auto;padding:0 8px 12px}
.br2-item{display:flex;gap:8px;align-items:center;padding:8px;border-radius:8px;cursor:pointer;font-size:.88em;color:var(--text)}
.br2-item:hover{background:var(--bg-soft)}
.br2-item .u{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-dim);font-size:.82em}
.br2-seg{display:flex;gap:6px;padding:10px 12px 0}
.br2-seg button{flex:1;border:1px solid var(--border);background:transparent;color:var(--text-dim);border-radius:8px;padding:6px;cursor:pointer}
.br2-seg button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.br2-seg .x{flex:0 0 auto;width:34px;display:grid;place-items:center}
.br2-bar .btn-ic.on{color:var(--accent);border-color:var(--accent);background:var(--accent-soft)}
.br2-empty{padding:20px;color:var(--text-dim);font-size:.86em;text-align:center}
`;
    document.head.appendChild(s);
  }

  const BrowserView = {
    root: null, hole: null, tabs: [], active: 0, seq: 0,
    settings: null, bms: [], hist: [], panel: '', timer: null, addr: null,

    async mount(container) {
      styleOnce();
      this.container = container;
      const [settings, bms, hist] = await Promise.all([
        API.raw.browser.settings().catch(() => null),
        API.raw.browser.bookmarks().catch(() => []),
        API.raw.browser.history({ limit: 120 }).catch(() => [])
      ]);
      this.settings = settings || { home: 'https://www.bing.com/', engine: 'bing', sidebar: true };
      this.bms = bms || []; this.hist = hist || [];
      if (!this.tabs.length) this.tabs = [{ id: 1, url: this.settings.home || 'https://www.bing.com/', title: '新标签页' }];
      this.active = 0;
      this.build();
      this.load();
    },

    build() {
      const page = el('div', { class: 'br2' });
      this.tabsEl = el('div', { class: 'br2-tabs' });
      page.appendChild(this.tabsEl);

      const bar = el('div', { class: 'br2-bar' });
      this.btnBack = el('button', { class: 'btn-ic', title: '后退', onclick: () => this.back() }, icon('back'));
      this.btnFwd = el('button', { class: 'btn-ic', title: '前进', onclick: () => this.forward() }, icon('chevron'));
      this.btnReload = el('button', { class: 'btn-ic', title: '刷新', onclick: () => this.reload() }, icon('refresh'));
      this.btnHome = el('button', { class: 'btn-ic', title: '主页', onclick: () => this.go(this.settings.home || 'https://www.bing.com/') }, icon('home'));
      bar.appendChild(this.btnBack); bar.appendChild(this.btnFwd); bar.appendChild(this.btnReload); bar.appendChild(this.btnHome);
      this.addr = el('input', {
        type: 'text', spellcheck: 'false', placeholder: '输入网址或搜索词，回车打开',
        onkeydown: (e) => { if (e.key === 'Enter') this.submit(); if (e.key === 'Escape') { this.addr.value = this.current().url || ''; this.addr.blur(); } }
      });
      bar.appendChild(el('div', { class: 'br2-addr' }, icon('search'), this.addr));
      this.btnStar = el('button', { class: 'btn-ic', title: '收藏这一页', onclick: () => this.toggleBookmark() }, icon('star'));
      this.btnSide = el('button', { class: 'btn-ic', title: '书签 / 历史（再点一次收起）', onclick: () => this.togglePanel(this.panel ? '' : 'bm') }, icon('folder'));
      bar.appendChild(this.btnStar); bar.appendChild(this.btnSide);
      page.appendChild(bar);

      const main = el('div', { class: 'br2-main' });
      this.sideEl = el('aside', { class: 'br2-side', hidden: true });
      this.stage = el('div', { class: 'br2-stage' });
      this.hole = el('div', { class: 'br2-hole' });
      this.hole.appendChild(el('div', { class: 'ph' }, icon('globe'), el('div', { text: '网页画布由本机 Edge 内核承载' }), el('div', { class: 'sub', text: '在地址栏输入网址，回车后这里会显示网页。' })));
      this.stage.appendChild(this.hole);
      main.appendChild(this.sideEl);
      main.appendChild(this.stage);
      page.appendChild(main);
      this.root = page;
      this.container.appendChild(page);

      this.renderTabs();
      this.timer = setInterval(() => this.syncBounds(), 500);
      API.on('browser:state', (s) => this.onState(s));
      /* 网页里点开的新窗口（target=_blank）→ 宿主发事件，这里开新标签页 */
      API.on('browser:newtab', (s) => { if (s && s.url) this.newTabTo(s.url); });
      /* Esc 收起侧栏（地址栏里的 Esc 另有用途，跳过） */
      window.addEventListener('keydown', this._onKey = (e) => {
        if (e.key === 'Escape' && this.panel && e.target !== this.addr) this.togglePanel('');
      });
      window.addEventListener('resize', this._onResize = () => this.syncBounds());
    },

    current() { return this.tabs[this.active] || { url: '', title: '' }; },
    renderTabs() {
      clear(this.tabsEl);
      this.tabs.forEach((t, i) => {
        const tab = el('div', { class: 'br2-tab' + (i === this.active ? ' on' : ''), onclick: () => this.switchTab(i) },
          el('span', { class: 't', text: t.title || t.url || '新标签页' }),
          this.tabs.length > 1 ? el('button', { class: 'x', onclick: (e) => { e.stopPropagation(); this.closeTab(i); } }, '×') : null);
        this.tabsEl.appendChild(tab);
      });
      this.tabsEl.appendChild(el('button', { class: 'br2-new', title: '新标签页', onclick: () => this.newTab() }, '+'));
    },
    switchTab(i) {
      this.active = i;
      this.renderTabs();
      this.hideView();
      this.load();
    },
    newTab() {
      this.tabs.push({ id: Date.now(), url: this.settings.home || 'https://www.bing.com/', title: '新标签页' });
      this.switchTab(this.tabs.length - 1);
    },
    /* 新标签页打开一个网址：搜索、书签、历史、网页点开的新窗口都走这里 */
    newTabTo(url) {
      if (!url) return;
      this.tabs.push({ id: Date.now(), url, title: url });
      this.switchTab(this.tabs.length - 1);
    },
    closeTab(i) {
      if (this.tabs.length <= 1) return;
      this.tabs.splice(i, 1);
      if (this.active >= this.tabs.length) this.active = this.tabs.length - 1;
      this.renderTabs();
      this.hideView();
      this.load();
    },
    hideView() { if (window.SGJ && SGJ.__call) SGJ.__call('browser:viewHide').catch(() => {}); },

    load() {
      const t = this.current();
      this.addr.value = t.url || '';
      this.hole.style.display = 'block';
      const r = this.stage.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return;
      const dpr = window.devicePixelRatio || 1;
      SGJ.__call('browser:viewShow', { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), dpr, url: t.url || '' })
        .then((s) => this.onState(s, true)).catch((e) => window.Shell.toast('网页画布：' + e.message, 'err'));
    },
    syncBounds() {
      if (!this.stage || !this.stage.isConnected) return;
      const r = this.stage.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return;
      const dpr = window.devicePixelRatio || 1;
      SGJ.__call('browser:viewShow', { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), dpr, url: '' }).catch(() => {});
    },
    onState(s, quiet) {
      if (!s) return;
      const t = this.current();
      if (s.url) { t.url = s.url; if (!this.addr.matches(':focus')) this.addr.value = s.url; }
      if (s.title) t.title = s.title;
      this.btnBack.disabled = !s.canBack; this.btnFwd.disabled = !s.canForward;
      this.renderTabs();
      if (!quiet && s.url) API.raw.browser.addHistory({ url: s.url, title: s.title || s.url }).catch(() => {});
    },
    submit() {
      const text = this.addr.value.trim();
      if (!text) return;
      /* 搜索 / 输网址：开新标签页，不覆盖当前页 */
      SGJ.browser.resolveInput(text, this.settings.engine).then((r) => {
        if (r && r.url) this.newTabTo(r.url);
      }).catch((e) => window.Shell.toast(e.message, 'err'));
    },
    go(url) {
      const t = this.current();
      t.url = url; t.title = url;
      this.addr.value = url;
      this.renderTabs();
      SGJ.__call('browser:viewNavigate', url).catch((e) => window.Shell.toast(e.message, 'err'));
      API.raw.browser.addHistory({ url, title: url }).catch(() => {});
    },
    back() { SGJ.__call('browser:viewBack').catch(() => {}); },
    forward() { SGJ.__call('browser:viewForward').catch(() => {}); },
    reload() { SGJ.__call('browser:viewReload').catch(() => {}); },

    toggleBookmark() {
      const u = this.current().url;
      if (!u) return;
      API.raw.browser.findBookmark(u).then(async (b) => {
        if (b) { await API.raw.browser.removeBookmark([b.id]); window.Shell.toast('已取消收藏'); }
        else { await API.raw.browser.addBookmark({ url: u, title: this.current().title || u }); window.Shell.toast('已收藏', 'ok'); }
        this.bms = await API.raw.browser.bookmarks().catch(() => []);
        if (this.panel) this.renderPanel();
      }).catch((e) => window.Shell.toast(e.message, 'err'));
    },
    togglePanel(which) {
      if (this.panel === which) which = '';
      this.panel = which;
      this.sideEl.hidden = !which;
      if (this.btnSide) this.btnSide.classList.toggle('on', !!which);
      if (which) this.renderPanel();
      setTimeout(() => this.syncBounds(), 50);
    },
    renderPanel() {
      clear(this.sideEl);
      this.sideEl.appendChild(el('div', { class: 'br2-seg' },
        el('button', { class: this.panel === 'bm' ? 'on' : '', onclick: () => { this.panel = 'bm'; this.renderPanel(); } }, '书签'),
        el('button', { class: this.panel === 'hist' ? 'on' : '', onclick: () => { this.panel = 'hist'; this.renderPanel(); API.raw.browser.history({ limit: 120 }).then((h) => { this.hist = h || []; this.renderPanel(); }); } }, '历史'),
        el('button', { class: 'x', title: '收起', onclick: () => this.togglePanel('') }, icon('close'))));
      const list = el('div', { class: 'br2-list' });
      if (this.panel === 'bm') {
        if (!this.bms.length) list.appendChild(el('div', { class: 'br2-empty', text: '还没有书签。点地址栏右边的星星收藏当前页。' }));
        this.bms.forEach((b) => list.appendChild(el('div', { class: 'br2-item', onclick: () => this.newTabTo(b.url) },
          icon('star'), el('div', { style: { flex: '1', minWidth: '0' } },
            el('div', { class: 'u', style: { color: 'var(--text)' }, text: b.title || b.url }),
            el('div', { class: 'u', text: b.url })))));
      } else {
        if (!this.hist.length) list.appendChild(el('div', { class: 'br2-empty', text: '还没有浏览记录。' }));
        this.hist.forEach((h) => list.appendChild(el('div', { class: 'br2-item', onclick: () => this.newTabTo(h.url) },
          icon('clock'), el('div', { style: { flex: '1', minWidth: '0' } },
            el('div', { class: 'u', style: { color: 'var(--text)' }, text: h.title || h.url }),
            el('div', { class: 'u', text: h.url })))));
      }
      this.sideEl.appendChild(list);
    },

    detach() {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      if (this._onResize) { window.removeEventListener('resize', this._onResize); this._onResize = null; }
      if (this._onKey) { window.removeEventListener('keydown', this._onKey); this._onKey = null; }
      if (window.SGJ && SGJ.__call) SGJ.__call('browser:viewHide').catch(() => {});
      this.stage = null;
    }
  };

  window.BrowserView = BrowserView;
})();
