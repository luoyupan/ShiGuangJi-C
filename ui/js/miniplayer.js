/**
 * 拾光集 · 常驻迷你播放卡片 (miniplayer.js)
 * ------------------------------------------------------------
 * 第二十六轮：音乐「切出去到其他模块不暂停播放」，所以需要一个**跨路由常驻**
 * 的遥控器 —— 不管停在哪一页，右下角都有一张小卡片显示正在播放的歌，
 * 能暂停 / 上一首 / 下一首，还能**收起来**只留一个小圆钮。
 *
 * 为什么要单独一个文件、挂 `.app` 而不是 `#view`：
 *   `shell.route()` 每次切页都 `clear(view)`，模块内浮层活不过一次路由。
 *   这里是 `.app` 的兄弟节点，和标题栏 / Toast 一样常驻。
 *
 * 数据只有**一个来源**：`window.MusicView`（它持有跨 mount 复用的媒体元素）。
 * 本文件不创建媒体元素、也不重画音乐页的播放条 —— 只读不写，避免互相触发重画。
 * 反过来，音乐模块的 `renderPlayer()/updateSeek()` 会调 `MiniPlayer.sync()/seek()`
 * 把状态推过来（见 modules/music.js）。
 */
'use strict';
(function () {
const { el, clear } = window.util;
const { uiSpan } = window.ICON;

const MiniPlayer = {
  el: null,            // 展开态卡片
  fab: null,           // 收起态小圆钮
  ready: false,
  collapsed: false,    // 收起来了没（落 store.settings.miniCollapsed）
  _cover: '\u0000',    // 上一次画过的封面（用不可能的值占位，保证首帧一定画）
  _playIcon: '',

  init() {
    if (this.ready) return this;
    this.ready = true;

    const s = (window.State && window.State.settings) || {};
    this.collapsed = !!s.miniCollapsed;

    /* 🔴 页面上已经写了这两个节点（index.html）就**复用**，别再 append 一个同 id 的：
       `getElementById` 只认文档里**第一个**匹配，多造一个就会变成
       「节点存在但永远 hidden、里面永远是空的」—— 界面上什么都看不见，
       而代码里 this.el 指向另一个孤儿节点，查起来非常费劲。 */
    const app = document.getElementById('app');
    let host = document.getElementById('miniPlayer');
    if (!host) { host = el('div', { class: 'mini-player', hidden: true }); host.id = 'miniPlayer'; app.appendChild(host); }
    let fabNode = document.getElementById('miniFab');
    if (!fabNode) { fabNode = el('button', { class: 'mini-fab', hidden: true }); fabNode.id = 'miniFab'; app.appendChild(fabNode); }
    this.el = host;
    this.fab = fabNode;

    /* 展开态：内容**建一次**，之后只改字段（重画会把 hover / focus 断掉） */
    this.coverBox = el('div', { class: 'mp-cover' });
    this.nameEl = el('div', { class: 'mp-name ellipsis' });
    this.subEl = el('div', { class: 'mp-sub ellipsis' });
    this.playBtn = el('button', {
      class: 'mp-btn mp-toggle', 'aria-label': '播放 / 暂停',
      onclick: (e) => { e.stopPropagation(); this.act('toggle'); }
    });
    this.seekFill = el('i');

    clear(this.el);
    this.el.appendChild(this.coverBox);
    this.el.appendChild(el('div', { class: 'mp-txt', title: '回到音乐模块', onclick: () => this.openMusic() },
      this.nameEl, this.subEl));
    this.el.appendChild(el('div', { class: 'mp-act' },
      this.mkBtn('prev', '上一首'),
      this.playBtn,
      this.mkBtn('next', '下一首')));
    this.el.appendChild(el('button', {
      class: 'mp-fold', title: '收起迷你播放器', 'aria-label': '收起迷你播放器',
      onclick: (e) => { e.stopPropagation(); this.fold(true); }
    }, uiSpan('chevron')));
    this.el.appendChild(el('div', { class: 'mp-seek' }, this.seekFill));

    /* 收起态：一个小圆钮，随时能点回来 */
    clear(this.fab);
    this.fab.appendChild(uiSpan('musicNote'));
    this.fab.appendChild(el('span', { class: 'mp-dot' }));
    this.fab.onclick = () => this.fold(false);

    /* 别处改了这个设置（设置页 / 另一处代码）也要认 */
    if (window.API && typeof API.on === 'function') {
      API.on('settings:changed', (next) => {
        if (!next) return;
        const c = !!next.miniCollapsed;
        if (c !== this.collapsed) { this.collapsed = c; this.sync(); }
      });
    }

    this.sync();
    return this;
  },

  mkBtn(act, title) {
    return el('button', {
      class: 'mp-btn', title, 'aria-label': title,
      onclick: (e) => { e.stopPropagation(); this.act(act); }
    }, uiSpan(act));
  },

  /** 卡片上的控制：全部转给音乐模块（媒体元素只有它那一份） */
  act(what) {
    const MV = window.MusicView;
    if (!MV) return;
    try {
      if (what === 'toggle') MV.toggle();
      else if (what === 'next') MV.next();
      else if (what === 'prev') MV.prev();
    } catch (e) { if (window.Shell) window.Shell.toast((e && e.message) || String(e), 'err'); }
    this.sync();
  },

  openMusic() { if (location.hash !== '#/music') location.hash = '#/music'; },

  /** 收起 / 展开；收起状态落 store，下次启动还是收着的 */
  fold(v) {
    this.collapsed = !!v;
    if (window.State && typeof State.set === 'function') State.set({ miniCollapsed: this.collapsed }).catch(() => {});
    this.sync();
  },

  /**
   * 把音乐模块的当前状态同步到卡片上。
   * 由 music.js 的 renderPlayer()（曲目 / 播放状态变化）与 shell.route()（切页）触发。
   */
  sync() {
    if (!this.ready) return;
    const MV = window.MusicView;
    const t = (MV && typeof MV.current === 'function') ? MV.current() : null;

    /* ⚠️ 音乐模块里不摆这张卡片：那一页底部本来就是完整的播放条，
       再叠一个小卡片纯属重复（用户要的是「切出去以后」还能控制）。 */
    const show = !!t && location.hash !== '#/music';
    const expanded = show && !this.collapsed;

    document.body.classList.toggle('has-mini', expanded);
    document.body.classList.toggle('has-mini-fab', show && this.collapsed);
    this.el.hidden = !expanded;
    this.fab.hidden = !(show && this.collapsed);
    if (!show) return;

    const playing = !!(MV.audio && !MV.audio.paused);

    this.nameEl.textContent = t.title || window.util.baseName(t.path) || '未在播放';
    this.subEl.textContent = (typeof MV.nowLyric === 'function' && MV.nowLyric())
      || t.artist || (playing ? '正在播放' : '已暂停');

    /* 封面 / 播放键图标都只在**变了的时候**才重建节点，别每帧换 ——
       每帧重建 img 会让封面闪、也会把正在按的按钮从 DOM 上换掉。 */
    const cov = t.cover || '';
    if (cov !== this._cover) {
      this._cover = cov;
      clear(this.coverBox);
      this.coverBox.appendChild(cov
        ? el('img', { src: cov, alt: '' })
        : el('span', { class: 'mp-ph' }, uiSpan('musicNote')));
    }
    const icon = playing ? 'pause' : 'play';
    if (icon !== this._playIcon) {
      this._playIcon = icon;
      clear(this.playBtn);
      this.playBtn.appendChild(uiSpan(icon));
    }
    this.playBtn.title = playing ? '暂停' : '播放';
    this.fab.classList.toggle('playing', playing);

    this.seek();
  },

  /** 只要进度（timeupdate 每 ~250ms 一次，别在这里做重活） */
  seek() {
    if (!this.ready || !this.seekFill || this.el.hidden) return;
    const a = window.MusicView && window.MusicView.audio;
    const d = (a && Number.isFinite(a.duration)) ? a.duration : 0;
    this.seekFill.style.width = (d ? (a.currentTime / d * 100) : 0) + '%';
  }
};

window.MiniPlayer = MiniPlayer;
})();
