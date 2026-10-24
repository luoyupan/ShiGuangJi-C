/**
 * ============================================================
 *  拾光集 · MOD 模块（界面层）(mods.js)
 * ------------------------------------------------------------
 *  第五十三轮：**MOD 从游戏模块里独立出来**，成为第六个可开关的插件。
 *
 *  为什么只做界面层：MOD 的数据本来就是游戏库的一部分（每款游戏自己的
 *  MOD 目录、已装列表、工坊订阅），IPC 也全在 `games:*` 下。这一轮要拆的是
 *  **入口与页面**，不是数据。所以：
 *    · 数据/动作 → 照旧走 `API.raw.games.*`
 *    · 面板本身 → 调 `GamesView.buildModsPane(game, rerender)`（那一大坨
 *      「目录卡 / 工具行 / MOD 卡片墙 / Nexus 小浏览器」搬一遍只会漂移）
 *    · 本文件负责：左右布局、选哪款游戏、空态、`#/mods/<游戏 id>` 直达
 *
 *  入口（都在游戏模块里）：
 *    · 卡片悬浮条上的「打开 MOD」→ `Shell.go('#/mods/<id>')`
 *    · 详情页「模组」标签     → 同上（不再原地渲染）
 *  MOD 插件被关掉时这两个入口都要消失 —— 那才叫「插件能关掉」。
 * ============================================================ */
(function () {
  'use strict';

  /* ⚠️ 取值方式必须和 games.js 一致：`el/clear` 在 `window.util`，图标在 `window.ICON`。
     写成 `window.el` 会拿到 undefined，IIFE 一执行就顺着往下炸 → 整页空白、路由却是对的。 */
  const { el, clear } = window.util;
  const { uiSpan } = window.ICON;

  const ModsView = {
    root: null,
    sideEl: null,
    mainEl: null,
    games: [],
    currentId: '',
    kw: '',
    _seq: 0,          // 代次守卫：异步画面板回来时，先确认还是同一款游戏

    async mount(container) {
      this.root = container;
      container.innerHTML = '';
      /* 复用游戏模块的布局类（.games / .gside / .gmain / .glist-item）：
         两边都是「左边一串游戏、右边一块内容」，样式一模一样；
         复制一份 200 行 CSS 只会让两处慢慢长歪。专属样式见 css/modules/mods.css */
      const wrap = el('div', { class: 'games mods' });
      this.sideEl = el('aside', { class: 'gside' });
      this.mainEl = el('section', { class: 'gmain' });
      wrap.appendChild(this.sideEl);
      wrap.appendChild(this.mainEl);
      container.appendChild(wrap);

      /* 直达：#/mods/<游戏 id> —— 游戏卡片「打开 MOD」就是这条 */
      const m = /^#\/mods\/(.+)$/.exec(String(location.hash || ''));
      this.pendingId = m ? decodeURIComponent(m[1]) : '';
      this.kw = '';
      await this.reload();
      return this;
    },

    /**
     * 离开模块时的清理。
     * ⚠️ 内嵌的 Nexus 小浏览器是个 `<webview>`，挂在面板里 —— 不先收掉，
     *    `clear()` 会把它的媒体 / 会话一起带走，下次进来就是一个白框。
     */
    detach() {
      if (window.GamesView && typeof window.GamesView.closeModBrowser === 'function') {
        try { window.GamesView.closeModBrowser(); } catch { /* 没开就无所谓 */ }
      }
    },

    async reload() {
      /* 隐藏空间里的游戏不在这里列（那是游戏模块自己的事，而且进来要密码） */
      this.games = await API.raw.games.list({ scope: 'normal' }).catch(() => []);
      this.renderSide();

      const want = String(this.pendingId || this.currentId || '');
      this.pendingId = '';
      const hit = this.games.find((g) => String(g.id) === want);
      if (hit) this.open(hit.id);
      else if (this.games.length) this.open(this.games[0].id);
      else this.renderEmpty();
    },

    /* ---------------- 左侧：游戏列表 ---------------- */
    renderSide() {
      const side = clear(this.sideEl);
      const prev = this.sideEl.querySelector('.gside-list');
      const keepTop = prev ? prev.scrollTop : 0;

      /* 顶部：「返回」+ 标题。模块页头必须有 .back-btn（没有就等于把用户关在这一页） */
      side.appendChild(el('div', { class: 'mods-side-head' },
        el('button', { class: 'back-btn', title: '回主界面', onclick: () => window.Shell.go('#/') },
          uiSpan('back'), '返回'),
        el('h2', { text: 'MOD' })));

      /* 搜索框：只重画列表，**不重建输入框**（否则每敲一个字就失焦）。外层类名复用游戏模块的。 */
      side.appendChild(el('div', { class: 'gside-search' },
        el('div', { class: 'field' },
          uiSpan('search'),
          el('input', {
            type: 'text', placeholder: '搜索游戏…', value: this.kw,
            oninput: (e) => { this.kw = e.target.value; this.drawList(listBox); }
          }))));

      const listBox = el('div', { class: 'gside-list' });
      side.appendChild(listBox);
      this.drawList(listBox);
      if (keepTop) listBox.scrollTop = keepTop;
    },

    /** 只重画列表（搜索时用） */
    drawList(listBox) {
      clear(listBox);
      const kw = String(this.kw || '').trim().toLowerCase();
      const list = kw ? this.games.filter((g) => String(g.name || '').toLowerCase().includes(kw)) : this.games;

      if (!list.length) {
        listBox.appendChild(el('div', { class: 'empty', style: { minHeight: '90px' } },
          el('p', { class: 'text-dim', text: kw ? '没有匹配的游戏' : '游戏库里还没有游戏' })));
        return;
      }

      for (const g of list) {
        listBox.appendChild(el('div', {
          class: 'glist-item' + (String(g.id) === String(this.currentId) ? ' on' : ''),
          dataset: { gid: String(g.id) },
          title: g.name,
          onclick: () => this.open(g.id)
        },
          el('div', { class: 'glist-thumb' },
            window.GamesView.coverImg(g, { placeholder: () => el('span', { class: 'text-dim', text: '🎮' }) })),
          el('div', { class: 'glist-main' },
            el('div', { class: 'glist-name' }, el('span', { class: 't', text: g.name })),
            el('div', { class: 'glist-sub' },
              el('span', { text: g.missing ? '目录丢失' : (g.platformName || '本地') })))));
      }
    },

    /** 选中一款游戏：只改高亮 + 画右侧，不重建整条列表（滚动位置别跳） */
    open(id) {
      this.currentId = id;
      if (this.sideEl) {
        for (const n of this.sideEl.querySelectorAll('.glist-item[data-gid]')) {
          n.classList.toggle('on', n.dataset.gid === String(id));
        }
      }
      /* 地址栏跟着走，刷新 / 回退都能回到这一款。⚠️ 用 replaceState：
         在模块内部换游戏不该往历史里堆一串记录（返回键只想回主界面） */
      const h = '#/mods/' + encodeURIComponent(id);
      if (location.hash !== h) history.replaceState(null, '', h);
      this.renderMain();
    },

    /* ---------------- 右侧：MOD 面板 ---------------- */
    async renderMain() {
      const seq = ++this._seq;                       // 代次守卫（异步回来先问“还是这款吗”）
      const g = this.games.find((x) => String(x.id) === String(this.currentId));
      const main = clear(this.mainEl);
      if (!g) { this.renderEmpty(); return; }

      main.appendChild(el('div', { class: 'mods-head' },
        /* ⚠️ 占位里别塞整串游戏名：46px 宽塞「上古卷轴5：天际特别版」会折成 3 行小字，
           看着像坏掉的图。给个 🎮 就行（和左列表一致）。 */
        el('div', { class: 'mods-head-cover' },
          window.GamesView.coverImg(g, { placeholder: () => el('span', { class: 'ph-ic', text: '🎮' }) })),
        el('div', { class: 'mods-head-main' },
          el('h2', { class: 'mods-head-title', text: g.name }),
          el('p', { class: 'mods-head-sub', text: '给这款游戏装 MOD；换游戏点左边。' }))));

      const body = el('div', { class: 'mods-body' });
      main.appendChild(body);

      let pane = null;
      try { pane = await window.GamesView.buildModsPane(g, () => this.renderMain()); }
      catch (e) {
        if (seq !== this._seq) return;               // 已经换游戏了，别往旧页面里画
        body.appendChild(el('div', { class: 'card danger-card' },
          el('h3', { text: 'MOD 面板打不开' }),
          el('p', { class: 'hint', text: (e && e.message) || String(e) })));
        return;
      }
      /* 🔴 异步 + 可能重入 → 回来先确认这页还是同一款游戏（否则会画到别人的面板里） */
      if (seq !== this._seq) return;
      clear(body);
      body.appendChild(pane);
    },

    renderEmpty() {
      const main = clear(this.mainEl);
      main.appendChild(el('div', { class: 'mods-head' },
        el('div', { class: 'mods-head-main' },
          el('h2', { class: 'mods-head-title', text: 'MOD' }),
          el('p', { class: 'mods-head-sub', text: '左边选一款游戏，这里就是它的 MOD 面板。' }))));
      main.appendChild(el('div', { class: 'empty', style: { marginTop: '18px' } },
        el('p', { class: 'text-dim', text: '游戏库里还没有游戏。先去游戏模块扫描或添加一款。' }),
        el('button', { class: 'btn btn-primary btn-sm', onclick: () => window.Shell.go('#/games') }, '去游戏模块')));
    }
  };

  window.ModsView = ModsView;
})();
