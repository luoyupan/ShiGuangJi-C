/**
 * 拾光集 · 音乐模块视图 (modules/music.js)
 * 参考网易云主页结构：左侧导航 / 中间内容 / 底部播放条。
 */
'use strict';
(function () {
const { el, clear, formatDuration } = window.util;
const { uiSpan } = window.ICON;

/* ---------------- 听歌统计用的小工具 ---------------- */
/** 秒 → { 小时, 分 } */
function hmSec(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) };
}
/** 秒 → 「3 小时 28 分」/「12 分钟」 */
function humSec(sec) {
  const { h, m } = hmSec(sec);
  if (!h) return m + ' 分钟';
  return m ? h + ' 小时 ' + m + ' 分' : h + ' 小时';
}
const PERIOD_WORD = { week: '本周', month: '本月', year: '本年' };

/* ---------------- 音量 ---------------- */
/**
 * 音量归一化：夹到 0..1，非法值（undefined / NaN / 字符串乱填）退回 0.8。
 * ⚠️ 0 是**合法值**（用户就是想静音），别用 `x || 0.8` —— 那样拖到最左会弹回 80%。
 */
function normVolume(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return 0.8;
  return Math.min(1, Math.max(0, v));
}
/** 0.8 → 「80%」（滑块的悬浮提示用，让「记住了」这件事肉眼可见） */
const volumeText = (v) => Math.round(normVolume(v) * 100) + '%';

const MusicView = {
  root: null,
  tracks: [],
  playlists: [],
  platforms: [],
  lrcMap: {},           // trackId → lrc 路径（列表里打「词」标记）
  srcCfg: null,         // 音乐下载源配置（下载与订阅页 / 补全缺失曲目用）
  crawlCfg: null,       // 网站抓取的网址列表（和下载源一样可以填多个）
  onlinePreview: null,  // 外部歌单解析结果（导入弹窗里复用，避免重复抓网）
  dailyStatus: null,    // 每日音乐：{ config, batch, logged }（主进程算好的口径，界面只显示）
  dailySel: null,       // 每日音乐：勾选的文件路径集合（只重画列表，不整页重画）
  dailyBusy: false,     // 每日音乐：正在拉取
  dailyProg: null,      // 每日音乐：拉取进度 { phase, index, total, title }
  view: 'discover',     // discover | local | downloads | playlist | stats | daily
  localQuery: '',       // 本地音乐的搜索词（只重画列表，不整页重画 —— 否则输入框失焦）
  localListEl: null,    // 本地音乐列表容器（搜索时只重画它）
  currentPlaylistId: '',
  statPeriod: 'month',  // 统计周期：week | month | year
  statOffset: 0,        // 0 本期 / -1 上一期 / +1 下一期
  statRootEl: null,     // 统计页根节点（异步回来时判断用户有没有切走）
  scanning: null,       // 扫描进度 { done, total, name }
  queue: [],
  index: -1,
  playMode: 'order',    // order 列表播放 | loop 列表循环 | single 单曲循环 | shuffle 随机播放
  plOpen: false,        // 播放列表面板开着没
  modeOpen: false,      // 播放顺序菜单开着没
  audio: null,
  lyric: null,          // 当前曲目的歌词 { lines, shift, path, ... }
  lyricErr: '',
  lyricOpen: false,
  _lrcIdx: -1,          // 已经高亮到第几行（避免每 250ms 重排 DOM）
  _failStreak: 0,       // 连续播放失败次数（防「坏文件串」无限跳歌）
  /* 听歌打点：当前这首已经真正听了多少秒（详见 _beginListen / _flushListen）
     ⚠️ 不在 mount() 里重置 —— 音频元素跨模块复用，歌还在放，计时不能断 */
  _listen: { id: '', sec: 0, lastAt: 0 },

  async mount(container) {
    this.root = container;
    container.innerHTML = '';
    this.lyricOpen = false;
    this.lyric = null;
    this.lyricErr = '';
    // 重进模块：两个浮层的 DOM 是新建的，状态也归零，免得出现「状态说开着、实际没有」
    this.plOpen = false;
    this.modeOpen = false;
    const wrap = el('div', { class: 'music' });
    this.wrapEl = wrap;               // 两个浮层的定位基准（.music 是 position:relative）
    this.topEl = el('div', { class: 'music-top' });
    this.railEl = el('div', { class: 'music-rail' });
    this.mainEl = el('div', { class: 'music-main' });
    this.topEl.appendChild(this.railEl);
    this.topEl.appendChild(this.mainEl);
    this.playerEl = el('div', { class: 'player' });
    wrap.appendChild(this.topEl);
    wrap.appendChild(this.playerEl);

    /* 播放列表面板 / 播放顺序菜单：**必须是播放条的兄弟节点**，不能塞进 playerEl。
       原因：音频 play/pause/切歌 都会 `renderPlayer()` 重画整条播放条，
       面板要是它的子节点，一按下一首就被连根拔掉 —— 面板跟着歌一起闪没了。
       挂在这层还有个好处：`.music` 是 position:relative，面板按播放条按钮的
       位置算 left/right 直接摆就行（见 openPanelAt）。 */
    this.plPanelEl = el('div', { class: 'pl-panel', hidden: true });
    this.modeMenuEl = el('div', { class: 'mode-menu', hidden: true });
    wrap.appendChild(this.plPanelEl);
    wrap.appendChild(this.modeMenuEl);

    /* 点空白处收起浮层。⚠️ 只注册一次 —— mount() 每次进模块都跑，
       写在这里不过脑子就会每进一次音乐多叠一个 document 监听（老坑）。 */
    if (!this._docBound) {
      this._docBound = true;
      document.addEventListener('click', (e) => this._outsideClick(e));
    }

    this.playMode = (window.PlayMode && State && State.settings)
      ? window.PlayMode.normalize(State.settings.playMode)
      : 'order';

    /* 本地音乐的排序 / 歌手筛选（纯逻辑在 js/music-sort.js，有单测）。
       ⚠️ 这里**只读原始值**，不在这里校验 —— mount() 跑的时候 this.tracks 还没加载完，
          拿空库去校验会把用户存的歌手筛选误判成「已失效」而清掉。校验放到 activeArtist()。 */
    const MS = window.MusicSort;
    const st = (State && State.settings) || {};
    this.localSort = MS ? MS.normalizeSpec(st.localSort) : 'added:desc';
    this.localArtist = typeof st.localArtist === 'string' ? st.localArtist : '';

    container.appendChild(wrap);

    /* ⚠️⚠️ 媒体元素**整个生命周期只能创建一次**，重新 mount 必须复用。
       以前这里是无条件 `this.audio = new Audio()` —— 而 `shell.route()` 每次进「音乐」
       模块都会 mount 一次，于是：
         · 旧元素被丢掉，但它**还在响**（Chromium 不会因为没人引用就停掉正在播的媒体）
         · `this.audio` 指向新的空元素 → 界面上按「暂停」控制的是新元素（本来就是暂停的，
           于是 toggle() 反而去 play 它），旧元素照旧出声 —— 就是用户报的「明明暂停了还在播放」。
       辅助证据（tools/probe-music-pause.js）：再次进模块后创建了 2 个媒体元素，
       第 2 个 paused=true，第 1 个（时长 204s、已播到 4.0s）仍在播。
       顺带一个坑：音量（`a.volume`）也只能在建元素时设一次，否则每次进模块都会
       把用户拖过的音量重置掉 —— 见下面那三行（值本身还要落盘才算真记住）。 */
    /* 🔴 音量要从设置里**读回来**，而且要**在建媒体元素之前**读（initAudio 会用它）。
       以前这里什么都没做 → 每次启动 this.volume 都是 undefined → 落到兜底的 0.8，
       用户调多小都白调（「每次打开都固定到很高」）。每次 mount 都同步一次，
       这样别处改了音量、回到音乐模块也是对的。 */
    this.volume = normVolume((State.settings || {}).volume);
    if (!this.audio) this.initAudio();
    this.audio.volume = this.volume;

    // 扫描进度：主进程每 5 首推一次，这里只更新状态条，不整页重绘
    API.on('music:scan-progress', (p) => this.onScanProgress(p));
    // 补全的歌下完了 → 主进程已经入库并补进歌单，这里刷新一下让用户看见
    API.on('netdisk:done', (task) => this.onFillDone(task));
    // 每日音乐：拉取进度 / 拉完·移动·清理的结果 → 就地刷新那一块
    API.on('music:daily-progress', (p) => this.onDailyProgress(p));
    API.on('music:daily', () => this.onDailyChanged());

    await this.reload();
    return this;
  },

  /** 创建播放用的媒体元素（**只在第一次 mount 时调**，见 mount 里的说明） */
  initAudio() {
    const a = new Audio();
    a.volume = normVolume(this.volume);
    // ⚠️ 自然播完走 onTrackEnd（要看播放顺序：单曲循环在这里才重播自己），
    //    手点「下一首」走 next() —— 两者不能合成一个，否则单曲循环下按钮像坏的
    a.onended = () => this.onTrackEnd();
    a.ontimeupdate = () => { this.updateSeek(); this.updateLyrics(); this._tickListen(); };
    a.onloadedmetadata = () => { this.updateSeek(); this.updateLyrics(true); };
    a.oncanplay = () => { this._failStreak = 0; };
    a.onplay = () => { this.renderPlayer(); this._beginListen(this.current()); };
    // 暂停就落一次统计（用户随时可能关窗口，最后那段别丢）
    a.onpause = () => { this.renderPlayer(); this._flushListen(); };
    // ⚠️ 媒体加载/解码失败**不会**让 play() 的 promise reject（通常是 resolve 后立刻 error），
    // 所以必须单独接住 error，否则用户点了歌就是「没反应」—— 这正是「播放不了音乐」的观感来源。
    a.onerror = () => this.onAudioError();
    this.audio = a;
    /* 每 60 秒把当前这段先落一次（keep 模式：提交后继续记同一首）。
       长曲子听半小时才切歌，中间被强杀也不会一整个半小时都没了。 */
    if (!this._statTimer) this._statTimer = setInterval(() => this._flushListen(true), 60000);
  },

  /* ---------------- 音量 ----------------
     三件事一起管：媒体元素上的实时值 · 内存里的 this.volume · 落盘的 settings.volume。
     ⚠️ 落盘**防抖**（拖动时 input 会连发几十次，逐次写盘没必要），
        松手 / 停手 400ms 后写一次；**不能只在 change 上写** —— 键盘方向键在小步调时
        不一定会给 change，那样最后还是记不住。 */
  setVolume(v, persist) {
    const n = normVolume(v);
    this.volume = n;
    if (this.audio) { try { this.audio.volume = n; } catch { /* ignore */ } }
    const box = document.getElementById('pVolume');
    if (box) {
      box.value = String(n);
      box.title = '音量 ' + volumeText(n) + '（自动记住）';
    }
    if (persist) {
      clearTimeout(this._volTimer);
      this._volTimer = setTimeout(() => {
        State.set({ volume: this.volume }).catch(() => {});
      }, 400);
    }
    return n;
  },

  /* ---------------- 听歌打点 ----------------
     只在**真的在播**的时候累加：按 timeupdate 之间的真实时间差累加，
     dt ≥ 10 秒说明是卡顿 / 后台挂起 / 拖了进度条 —— 那一段不算，
     否则统计里会凭空多出很多没听的时长。 */
  _beginListen(t) {
    if (!t) return;
    const L = this._listen;
    if (L.id === t.id) { L.lastAt = Date.now(); return; }   // 暂停后恢复播放：接着累
    this._flushListen();
    this._listen = { id: t.id, sec: 0, lastAt: Date.now() };
  },

  _tickListen() {
    const a = this.audio, L = this._listen, t = this.current();
    if (!a || a.paused || !t || !L.id || L.id !== t.id) return;
    const now = Date.now();
    const dt = L.lastAt ? (now - L.lastAt) / 1000 : 0;
    L.lastAt = now;
    if (dt > 0 && dt < 10) L.sec += dt;
  },

  /**
   * 把当前这段提交给主进程。
   * @param {boolean} keep true = 提交后继续记同一首（定时落盘用）
   */
  _flushListen(keep) {
    const L = this._listen;
    if (!L || !L.id) return;
    const sec = Math.round(L.sec);
    if (sec < 5) {                       // 听了两秒就划走的不算一次收听
      if (!keep) { L.id = ''; L.sec = 0; L.lastAt = 0; }
      return;
    }
    const id = L.id;
    if (keep) { L.sec = 0; L.lastAt = Date.now(); }
    else { L.id = ''; L.sec = 0; L.lastAt = 0; }
    API.raw.music.logPlay({ trackId: id, sec, at: Date.now() }).catch(() => {});
  },

  /**
   * 离开「音乐」模块时调用（由 shell.route() 触发）。
   *
   * 🔴 第二十六轮起**不再暂停**。以前离开就 pause，理由是「播放条只存在于音乐模块里，
   *    走了就没有按钮能停它」—— 现在左下角有一个常驻的迷你播放卡片，任何界面都能
   *    暂停 / 切歌，那条理由不成立了，而用户明确要求「切出去到其他模块不暂停播放」。
   *
   * 这里只做**离场清理**：歌词浮层挂在 #view 上会被 route 的 clear() 摘掉，
   * 状态也要跟着复位，否则回到音乐模块时会以为歌词还开着。
   * 媒体元素本身跨 mount 复用（见 initAudio），继续播，位置也不动。
   */
  detach() {
    this.lyricOpen = false;
    this.plOpen = false;
    this.modeOpen = false;
    this.statRootEl = null;      // 统计页的 DOM 已经被 route 清掉了
    /* ⚠️ 离开模块**不暂停也不清打点**（第二十六轮起音乐跨模块继续播），
       这里只是顺手把「上一段」落一次，免得计时跨模块越拉越长还不上报。 */
    this._flushListen();
  },

  onScanProgress(p) {
    if (!p) return;
    if (p.phase === 'done') {
      this.scanning = null;
      this.renderMain();
      return;
    }
    this.scanning = { done: p.done || 0, total: p.total || 0, name: p.name || '' };
    const bar = document.getElementById('mScanBar');
    if (bar) {
      const pct = this.scanning.total ? Math.round(this.scanning.done / this.scanning.total * 100) : 0;
      bar.style.width = pct + '%';
      const tx = document.getElementById('mScanTxt');
      /* 第五十一轮：第二阶段是「补封面」，文案要说清是在干什么，别让人以为卡住了 */
      const label = p.phase === 'cover' ? '正在补封面' : '正在识别';
      if (tx) tx.textContent = `${label} ${this.scanning.done}/${this.scanning.total}${this.scanning.name ? ' · ' + this.scanning.name : ''}`;
    }
  },

  /**
   * 歌单补全的下载完成 → 刷新界面。
   * ⚠️ 只认 meta.kind === 'music-fill' 的任务：网盘模块自己的下载不该把音乐页顶回顶部。
   */
  onFillDone(task) {
    const meta = task && task.meta;
    if (!meta || meta.kind !== 'music-fill') return;
    if (task.status && task.status !== 'done') return;
    const pl = meta.playlistId ? this.playlistById(meta.playlistId) : null;
    window.Shell.toast(`「${meta.title || '这首歌'}」下载完成${pl ? '，已补进「' + pl.name + '」' : '，已加入本地音乐库'}`, 'ok');
    // 只在用户正盯着受影响的列表时重绘，别在别的页面把人顶回顶部
    const watching = pl
      ? (this.view === 'playlist' && this.currentPlaylistId === pl.id)
      : (this.view === 'local' || this.view === 'playlist');
    if (watching) this.reload();
  },

  async reload() {
    this.tracks = await API.raw.music.list().catch(() => []);
    this.playlists = await API.raw.music.playlists().catch(() => []);
    this.platforms = await API.raw.music.platforms().catch(() => []);
    this.lrcMap = await API.raw.music.lrcMap().catch(() => ({}));
    this.srcCfg = await API.raw.music.sourceConfig().catch(() => null);
    this.crawlCfg = await API.raw.music.crawlConfig().catch(() => null);
    this.dailyStatus = await API.raw.music.dailyStatus().catch(() => null);
    if (this.currentPlaylistId && !this.playlists.some((p) => p.id === this.currentPlaylistId)) {
      this.currentPlaylistId = '';   // 歌单被删了就退回发现页
      if (this.view === 'playlist') this.view = 'local';
    }
    this.renderRail();
    this.renderMain();
    this.renderPlayer();
  },

  playlistById(id) { return this.playlists.find((p) => p.id === id) || null; },
  trackById(id) { return this.tracks.find((t) => t.id === id) || null; },
  /** 歌单 id 列表 → 曲目对象（顺序保持歌单里的顺序） */
  tracksOf(pl) {
    const ids = (pl && pl.tracks) || [];
    const out = [];
    for (const id of ids) { const t = this.trackById(id); if (t) out.push(t); }
    return out;
  },

  renderRail() {
    const rail = clear(this.railEl);
    const items = [
      ['discover', 'home', '发现音乐'],
      ['daily', 'refresh', '每日推荐'],
      ['local', 'musicNote', '本地音乐'],
      ['stats', 'chart', '听歌统计']
    ];
    rail.appendChild(el('div', { class: 'rt', text: '在线音乐' }));
    items.forEach(([k, ic, t]) =>
      rail.appendChild(el('div', { class: 'ri' + (this.view === k ? ' on' : ''), onclick: () => { this.view = k; this.renderRail(); this.renderMain(); } }, uiSpan(ic), t)));

    /* 「下载与订阅」只在**配好下载源之后**才出现（没配的话这个页面全是空壳，
       放侧栏只是噪音）。但也不能把新用户堵死 —— 没配时留一个灰色小条目当入口。 */
    const ready = !!(this.srcCfg && this.srcCfg.configured);
    this.railSrcEl = el('div', {
      class: 'ri' + (this.view === 'downloads' ? ' on' : '') + (ready ? '' : ' off'),
      title: ready ? '音乐下载源与补全设置' : '还没配置音乐下载源，点这里去填',
      onclick: () => { this.view = 'downloads'; this.renderRail(); this.renderMain(); }
    }, uiSpan(ready ? 'download' : 'plus'), ready ? '下载与订阅' : '配置下载源');
    rail.appendChild(this.railSrcEl);

    rail.appendChild(el('div', { class: 'rt', text: '我的歌单' }));
    for (const p of this.playlists) {
      rail.appendChild(el('div', {
        class: 'ri' + (this.view === 'playlist' && this.currentPlaylistId === p.id ? ' on' : ''),
        onclick: () => this.openPlaylist(p.id)
      },
        p.cover ? el('img', { class: 'ri-cover', src: p.cover }) : uiSpan('list'),
        el('span', { class: 'ellipsis', text: p.name }),
        el('span', { class: 'ri-n', text: String((p.tracks || []).length) })
      ));
    }
    rail.appendChild(el('div', { class: 'ri', onclick: () => this.newPlaylist() }, uiSpan('plus'), '新建歌单'));
    rail.appendChild(el('div', { class: 'ri', onclick: () => this.importPlaylistDialog() }, uiSpan('link'), '导入 / 外部歌单'));
  },

  renderMain() {
    const main = clear(this.mainEl);
    this.statRootEl = null;                 // 每次重画主区都先解除统计页的绑定
    this.localListEl = null;                // 本地音乐那份列表也跟着作废（paintLocal 会判空）
    if (this.view === 'discover') return this.renderDiscover(main);
    if (this.view === 'daily') return this.renderDaily(main);
    if (this.view === 'local') return this.renderLocal(main);
    if (this.view === 'playlist') return this.renderPlaylist(main);
    if (this.view === 'stats') return this.renderStats(main);
    return this.renderDownloads(main);
  },

  openPlaylist(id) {
    this.view = 'playlist';
    this.currentPlaylistId = id;
    this.renderRail();
    this.renderMain();
  },

  renderDiscover(main) {
    const now = this.current();
    main.appendChild(el('div', { class: 'music-hero' },
      el('div', { class: 'mh-cover' }, now && now.cover ? el('img', { src: now.cover }) : uiSpan('musicNote')),
      el('div', {},
        el('h1', { text: now ? now.title : '拾光集音乐' }),
        el('p', { class: 'text-dim', text: now ? now.artist + ' · ' + (now.album || '') : '导入本地音乐，或从网盘 / 服务器获取曲目。' }),
        el('div', { class: 'chip accent', text: this.tracks.length + ' 首本地曲目' })
      )
    ));

    /* 🔴 每日音乐推荐**放在「本地最近添加」上面**（用户要求）。
       顺序：hero → 每日音乐推荐 → 本地最近添加。 */
    this.paintDailyDiscover(main);

    main.appendChild(el('div', { class: 'rail-title' }, el('h3', { text: '本地最近添加' }),
      el('span', { class: 'more', onclick: () => { this.view = 'local'; this.renderRail(); this.renderMain(); } }, '查看全部')));
    const recent = this.tracks.slice(-8).reverse();
    if (!recent.length) {
      main.appendChild(el('div', { class: 'empty', style: { minHeight: '200px' } },
        el('h3', { text: '还没有本地音乐' }),
        el('p', { text: '点右侧「导入文件夹」开始建立你的音乐库。' })));
    } else {
      main.appendChild(el('div', { class: 'music-cards' },
        recent.map((t) => el('div', { class: 'mcard', onclick: () => this.playAt(this.tracks.indexOf(t)) },
          el('div', { class: 'mc-cover' }, t.cover ? el('img', { src: t.cover }) : uiSpan('musicNote')),
          el('div', { class: 'mc-title ellipsis', text: t.title }),
          el('div', { class: 'mc-sub ellipsis', text: t.artist })
        ))));
    }
  },

  /* ============================================================
   *  每日音乐推荐（第三十五轮）
   * ------------------------------------------------------------
   *  发现页顶部一小块 + 侧栏「每日推荐」整页。数据全来自主进程
   *  （dailyStatus），界面只负责显示与勾选，口径（清理/移动）都在主进程。
   * ============================================================ */
  openDaily() { this.view = 'daily'; this.dailySel = new Set(); this.renderRail(); this.renderMain(); },

  /* 网易 / QQ 的显示名（每日推荐的来源、设置里的 chips 共用一份） */
  PLAT_NAME: { netease: '网易云', qq: 'QQ 音乐' },
  platName(p) { return this.PLAT_NAME[p] || (p === 'qq' ? 'QQ 音乐' : p === 'netease' ? '网易云' : '国内音乐平台'); },

  /**
   * 每日条目不是「曲库曲目」（还没入库，也就没有 id / duration / lrc），
   * 播放器要的是 `{ id, path, title, artist, cover }` —— 这里包一个最小形状给它。
   * ⚠️ `id` 故意留空：听歌统计靠 id 归并，每日推荐里的临时文件不该混进统计
   *    （没听过的临时歌算进「听歌统计」会污染数据）。
   */
  dailyTrack(it) {
    return { id: '', path: it.file, title: it.title || '', artist: it.artist || '', cover: it.cover || '' };
  },

  /** 当前可试听的每日条目（下到了才有文件） */
  dailyPlayable() {
    return ((((this.dailyStatus || {}).batch || {}).items) || []).filter((t) => t.ok && t.file);
  },

  /**
   * 点一下每日推荐里的某首 → **试听**。
   * 整批可播的歌当播放队列，所以「下一首」能顺着往下走；
   * 再点同一首 = 播放/暂停（和唱片 App 一致，不用去够播放条）。
   */
  playDaily(file) {
    if (!file) return;
    const cur = this.current();
    if (cur && cur.path === file) return this.toggle();
    const queue = this.dailyPlayable().map((t) => this.dailyTrack(t));
    const i = queue.findIndex((t) => t.path === file);
    if (i < 0) return;
    this.playQueue(queue, i);
  },

  /** 发现页顶部那一块 */
  paintDailyDiscover(main) {
    main.appendChild(el('div', { class: 'rail-title' },
      el('h3', { text: '每日音乐推荐' }),
      el('span', { class: 'more', onclick: () => this.openDaily() }, '查看全部')));
    const st = this.dailyStatus || {};
    const items = (st.batch && st.batch.items) || [];
    const ok = items.filter((i) => i.ok);
    /* 与每日页同一套口径：如实标出这批是官方每日推荐还是歌单兜底 */
    if (items.length && st.batch && st.batch.source) {
      main.appendChild(el('div', { class: 'daily-meta', style: { marginTop: '-6px' } },
        el('span', { class: 'text-dim ellipsis', text: (st.batch.source === 'playlist'
          ? '⚠ 歌单兜底 · ' + (st.batch.playlist || '未命名歌单') + '（不是平台每日推荐）'
          : '官方每日推荐') + (st.batch.date ? ' · ' + st.batch.date : '') })));
    }
    if (!items.length) {
      main.appendChild(el('div', { class: 'empty', style: { minHeight: '140px' } },
        el('h3', { text: '今天还没有每日推荐' }),
        el('p', { text: (st.config && st.config.dir)
          ? '点「查看全部」进去，点「立即拉取」下载今日推荐。'
          : '先在「设置 → 音乐 → 每日音乐推荐」里选好保存文件夹。' })));
      return;
    }
    main.appendChild(el('div', { class: 'music-cards' },
      ok.slice(0, 8).map((t) => {
        const isCur = !!(this.current() && this.current().path === t.file);
        return el('div', {
          class: 'mcard' + (isCur ? ' playing' : ''),
          title: '点一下试听（再点一次暂停）',
          onclick: () => this.playDaily(t.file)
        },
          el('div', { class: 'mc-cover' },
            t.cover ? el('img', { src: t.cover }) : uiSpan('musicNote'),
            el('span', { class: 'daily-play' + (isCur ? ' on' : '') },
              uiSpan(isCur && this.audio && !this.audio.paused ? 'pause' : 'play', ''))),
          el('div', { class: 'mc-title ellipsis', text: t.title }),
          el('div', { class: 'mc-sub ellipsis', text: t.artist })
        );
      })));
  },

  /** 侧栏「每日推荐」整页 */
  renderDaily(main) {
    const st = this.dailyStatus || { config: {}, batch: { items: [] }, logged: {} };
    const cfg = st.config || {};
    const items = (st.batch && st.batch.items) || [];
    const sel = this.dailySel || new Set();
    const okItems = items.filter((i) => i.ok);

    main.appendChild(el('div', { class: 'rail-title' },
      el('h3', { text: '每日音乐推荐' + (items.length ? ' · ' + okItems.length + '/' + items.length + ' 首' : '') }),
      el('span', { class: 'more', onclick: () => this.dailyConfigure() }, '⚙ 设置'),
      el('span', {
        class: 'more' + (this.dailyBusy ? ' off' : ''),
        onclick: () => { if (!this.dailyBusy) this.dailyPullNow(); }
      }, this.dailyBusy ? '⟳ 拉取中…' : '⟳ 立即拉取')));

    main.appendChild(el('div', { class: 'daily-meta' },
      el('span', { class: 'text-dim ellipsis', title: cfg.dir || '', text: cfg.dir ? '保存到 ' + cfg.dir : '还没设置「每日音乐保存文件夹」' })));

    /* 来源一眼可见：设置里勾了哪些平台、这一批实际是从哪个平台拿到的 */
    main.appendChild(el('div', { class: 'daily-meta' },
      el('div', { class: 'chips', style: { marginTop: '6px', marginBottom: '0' } },
        el('span', { class: 'chip', title: '在「设置 → 音乐 → 每日音乐推荐 → 推荐来源」里改' },
          '来源：' + (cfg.sources && cfg.sources.length ? cfg.sources : ['netease', 'qq']).map((s) => this.platName(s)).join(' / ')),
        (st.batch && st.batch.platform) ? el('span', { class: 'chip accent', text: '本批来自 ' + this.platName(st.batch.platform) }) : null,
        /* 🔴 如实标注这一批是「官方每日推荐」还是「歌单兜底」—— 兜底用警告色，
           否则用户会以为自己随手一个歌单就是平台的每日推荐（第三十七轮踩过）。 */
        (st.batch && st.batch.source) ? (st.batch.source === 'playlist'
          ? el('span', {
            class: 'chip warn',
            title: '官方「每日推荐」接口没拿到，这一批读的是你歌单《' + (st.batch.playlist || '未命名') + '》，不是每日推荐',
            text: '歌单兜底 · ' + (st.batch.playlist || '未命名歌单')
          })
          : el('span', { class: 'chip', title: '来自平台的官方「每日推荐」接口', text: '官方每日推荐' })) : null,
        (st.batch && st.batch.date) ? el('span', { class: 'chip', text: st.batch.date }) : null)));

    if (this.dailyProg) {
      const p = this.dailyProg;
      main.appendChild(el('div', { class: 'daily-prog', id: 'mDailyProg' },
        `正在下载 ${p.index + 1}/${p.total}${p.title ? ' · ' + p.title : ''}`));
    }

    main.appendChild(el('div', { class: 'daily-acts' },
      el('button', {
        class: 'btn btn-sm btn-primary', disabled: !sel.size,
        onclick: () => this.dailyMoveSel()
      }, uiSpan('musicNote'), '移到音乐库' + (sel.size ? '（' + sel.size + '）' : '')),
      el('button', { class: 'btn btn-sm', disabled: !sel.size, onclick: () => this.dailyKeepSel() }, '保留'),
      el('button', { class: 'btn btn-sm', disabled: !sel.size, onclick: () => this.dailyCleanSel() }, '删除'),
      el('span', { class: 'grow' }),
      okItems.length
        ? el('span', { class: 'more', onclick: () => this.dailySelAll() },
          sel.size === okItems.length ? '全不选' : '全选')
        : null));

    if (!items.length) {
      main.appendChild(el('div', { class: 'empty', style: { minHeight: '220px' } },
        el('h3', { text: '今天还没有每日推荐' }),
        el('p', { text: cfg.dir ? '点右上角「立即拉取」下载今日推荐。' : '先点右上角「设置」选好保存文件夹。' }),
        el('p', { class: 'hint', text: '曲目来自' + (cfg.sources && cfg.sources.length ? cfg.sources : ['netease', 'qq']).map((s) => this.platName(s)).join(' / ') + '的每日推荐（需要先登录）。'
          + (cfg.base ? '下载走你自己配置的下载源。' : '还没配置下载源 —— 到「设置 → 音乐 → 每日音乐推荐 → 下载源地址」填一个站点才能下载。') })));
      return;
    }

    /* ⚠️ 行的**主体是播放**，勾选只归左边那个方框 ——
       以前整行 onclick 只有「勾选」，用户点上去只觉得「选了但没声音」。
       （复选框要 stopPropagation，否则点勾选会连带触发试听。） */
    const cur = this.current();
    const curPath = cur ? cur.path : '';
    const playing = !!(this.audio && !this.audio.paused);

    const list = el('div', { class: 'daily-list' });
    for (const it of items) {
      const canPlay = !!(it.ok && it.file);
      const checked = !!(canPlay && sel.has(it.file));
      const isCur = !!(canPlay && curPath && it.file === curPath);
      list.appendChild(el('div', {
        class: 'daily-row' + (canPlay ? ' playable' : ' bad') + (checked ? ' on' : '') + (isCur ? ' playing' : ''),
        title: canPlay ? '点一下试听（再点一次暂停）' : '',
        onclick: () => { if (canPlay) this.playDaily(it.file); }
      },
        el('span', {
          class: 'daily-chk' + (checked ? ' on' : ''),
          title: '勾选（之后可「移到音乐库 / 保留 / 删除」）',
          onclick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); if (canPlay) this.toggleDailySel(it.file); }
        }, checked ? '✓' : ''),
        el('div', { class: 'daily-cover' },
          it.cover ? el('img', { src: it.cover }) : uiSpan('musicNote'),
          canPlay ? el('span', { class: 'daily-play' + (isCur ? ' on' : '') },
            uiSpan(isCur && playing ? 'pause' : 'play', '')) : null),
        el('div', { class: 'grow' },
          el('div', { class: 'gname ellipsis', text: it.title || '(未知)' }),
          el('div', { class: 'gsub ellipsis', text: (it.artist || '') + (it.ok ? '' : ' · 未下到：' + (it.error || '失败')) })),
        /* 「词」标记：这首歌的歌词跟着音频一起下下来了（站点没有的就没有） */
        it.lrc ? el('span', { class: 'chip', title: '歌词已下载（同名 .lrc，放在音频旁边）', text: '词' }) : null,
        it.moved ? el('span', { class: 'chip accent', text: '已入库' })
          : (it.kept ? el('span', { class: 'chip', text: '保留' })
            : (it.ok ? el('span', { class: 'chip', text: it.level || it.format || '' }) : el('span', { class: 'chip warn', text: '失败' })))));
    }
    main.appendChild(list);
  },

  toggleDailySel(file) {
    if (!this.dailySel) this.dailySel = new Set();
    if (this.dailySel.has(file)) this.dailySel.delete(file); else this.dailySel.add(file);
    this.renderMain();          // 只重画列表即可（列表容器没被复用，直接整页最省事且无输入框）
  },
  dailySelAll() {
    const ok = (((this.dailyStatus || {}).batch || {}).items || []).filter((i) => i.ok);
    if (this.dailySel && this.dailySel.size === ok.length) this.dailySel = new Set();
    else this.dailySel = new Set(ok.map((i) => i.file));
    this.renderMain();
  },
  dailyConfigure() {
    if (window.Shell && typeof window.Shell.openModuleSettings === 'function') window.Shell.openModuleSettings('music');
    else window.Shell.toast('打开「设置 → 音乐 → 每日音乐推荐」即可配置', 'ok');
  },
  async dailyPullNow() {
    if (this.dailyBusy) return;
    const cfg = (this.dailyStatus || {}).config || {};
    if (!cfg.dir) { this.dailyConfigure(); return window.Shell.toast('先选「每日音乐保存文件夹」', 'err'); }
    this.dailyBusy = true; this.dailyProg = null;
    this.renderMain();
    try {
      const r = await API.raw.music.dailyPull();
      window.Shell.toast(`每日推荐已拉取：下到 ${r.downloaded}/${r.total} 首`, 'ok');
    } catch (e) {
      window.Shell.toast(e.message || '拉取失败', 'err');
    } finally {
      this.dailyBusy = false; this.dailyProg = null;
      await this.reload();
    }
  },
  async dailyMoveSel() {
    const files = [...(this.dailySel || [])];
    if (!files.length) return;
    try {
      const r = await API.raw.music.dailyMove(files);
      window.Shell.toast(`已移到音乐库：${r.moved} 首`, 'ok');
      this.dailySel = new Set();
      await this.reload();
    } catch (e) { window.Shell.toast(e.message, 'err'); }
  },
  async dailyKeepSel() {
    const files = [...(this.dailySel || [])];
    if (!files.length) return;
    try {
      await API.raw.music.dailyKeep(files);
      window.Shell.toast('已标记保留（第二天不会被清掉）', 'ok');
      this.dailySel = new Set();
      await this.reload();
    } catch (e) { window.Shell.toast(e.message, 'err'); }
  },
  async dailyCleanSel() {
    const files = [...(this.dailySel || [])];
    if (!files.length) return;
    try {
      const r = await API.raw.music.dailyClean(files);
      window.Shell.toast(`已删除 ${r.deleted} 个文件`, 'ok');
      this.dailySel = new Set();
      await this.reload();
    } catch (e) { window.Shell.toast(e.message, 'err'); }
  },
  onDailyProgress(p) {
    if (!p) return;
    if (p.phase === 'start') this.dailyProg = { index: p.index, total: p.total, title: p.title };
    if (this.view !== 'daily') return;
    // 进度条就地更新，不整页重画（否则滚动位置会被顶回去）
    const node = document.getElementById('mDailyProg');
    if (node && this.dailyProg) {
      node.textContent = `正在下载 ${this.dailyProg.index + 1}/${this.dailyProg.total}${this.dailyProg.title ? ' · ' + this.dailyProg.title : ''}`;
    } else {
      this.renderMain();
    }
  },
  async onDailyChanged() {
    this.dailyStatus = await API.raw.music.dailyStatus().catch(() => this.dailyStatus);
    if (this.view === 'daily' || this.view === 'discover') this.renderMain();
  },

  renderLocal(main) {
    const kw = (this.localQuery || '').trim();
    const found = this.filteredTracks().length;
    const MS = window.MusicSort;

    main.appendChild(el('div', { class: 'rail-title' }, el('h3', { text: '本地音乐 · ' + this.tracks.length + ' 首' }),
      el('span', { class: 'more', onclick: () => this.importFolder() }, '＋ 导入文件夹'),
      el('span', { class: 'more', onclick: () => this.scan() }, '⟳ 重新扫描'),
      el('span', { class: 'more', onclick: () => this.locateCurrent() }, '◎ 定位正在播放'),
      /* 排序 / 筛选（第四十轮）。🔴 放在 `.msearch-wrap` **之前**：
         那一带有 `margin-left:auto`，谁先谁就吃掉左边的空白（截图里红框那块空地就是它）。
         ⚠️ 这两个 select 的 value 不是记录字段名 —— `added:desc` 对应 `addedAt`，
            映射在 music-sort.js 的 FIELDS 里（直接 a[key] 会拿到 undefined，排序静默失效）。 */
      MS ? el('div', { class: 'lfilter' },
        el('select', {
          class: 'inp lf-sel', id: 'mLocalSort', title: '排序方式',
          onchange: (e) => this.setLocalSort(e.target.value)
        }, MS.SPECS.map((s) => el('option', { value: s.id }, s.label))),
        el('select', {
          class: 'inp lf-sel', id: 'mLocalArtist', title: '只看某个歌手',
          onchange: (e) => this.setLocalArtist(e.target.value)
        }, [el('option', { value: MS.ALL_ARTISTS }, `全部歌手（${this.tracks.length}）`)]
          .concat(MS.artistBuckets(this.tracks).map((b) =>
            el('option', { value: b.key }, `${b.name}（${b.count}）`))))
      ) : null,
      el('div', { class: 'msearch-wrap' },
        /* ⚠️ 这个提示要**一直都在**（空着时靠 CSS :empty 藏起来）：
           打字后只重画列表、不重画这一行，节点不存在就没法把「找到 N 首」填进去 */
        el('span', { class: 'ms-count', text: (kw || found !== this.tracks.length) ? `找到 ${found} 首` : '' }),
        /* 🔴 搜索框打字**不能整页重画** —— 整页重画会把输入框本身换掉 → 失焦、光标丢失
           （渲染层的老坑，游戏模块那一版也栽过）。所以只重画下面的列表容器。 */
        el('div', { class: 'msearch' },
          uiSpan('search'),
          el('input', {
            class: 'ms-inp', id: 'mLocalSearch', type: 'search', spellcheck: 'false',
            placeholder: '搜索标题 / 歌手 / 专辑', value: this.localQuery || '',
            oninput: (e) => { this.localQuery = e.target.value; this.paintLocal(); },
            onkeydown: (e) => {
              if (e.key === 'Escape') { this.clearLocalSearch(); }
              else if (e.key === 'Enter') { const f = this.filteredTracks()[0]; if (f) this.playAt(this.tracks.indexOf(f)); }
            }
          }),
          el('button', {
            class: 'ms-x' + (kw ? '' : ' off'), title: '清空搜索（Esc）',
            onclick: () => this.clearLocalSearch()
          }, '✕')))));

    /* ⚠️ 下拉框的当前值要**在插进 DOM 之后**赋（select 上写 selected 属性在某些
       情况下会被后面的 appendChild 顺序改掉；直接写 value 最稳）。 */
    if (MS) {
      const ss = document.getElementById('mLocalSort');
      if (ss) ss.value = this.localSort;
      const sa = document.getElementById('mLocalArtist');
      if (sa) sa.value = this.activeArtist();
    }

    if (this.scanning) {
      const pct = this.scanning.total ? Math.round(this.scanning.done / this.scanning.total * 100) : 0;
      main.appendChild(el('div', { class: 'scan-progress' },
        el('div', { class: 'sp-bar' }, el('i', { id: 'mScanBar', style: { width: pct + '%' } })),
        el('span', { class: 'sp-txt ellipsis', id: 'mScanTxt', text: `正在识别 ${this.scanning.done}/${this.scanning.total}${this.scanning.name ? ' · ' + this.scanning.name : ''}` })
      ));
    }
    if (!this.tracks.length) {
      main.appendChild(el('div', { class: 'empty' }, el('h3', { text: '本地音乐为空' }), el('p', { text: '导入文件夹后自动读取标题 / 歌手 / 专辑 / 封面。' })));
      return;
    }
    this.localListEl = el('div', { class: 'local-list' });
    main.appendChild(this.localListEl);
    this.paintLocal();
  },

  /** 当前真正生效的歌手筛选：存的歌手已经不在库里（库被清过 / 换过盘）→ 当「全部」，自愈 */
  activeArtist() {
    const MS = window.MusicSort;
    if (!this.localArtist) return '';
    if (MS && !MS.hasArtist(this.tracks, this.localArtist)) return '';
    return this.localArtist;
  },

  /** 换排序：落设置 + **只重画列表**（整页重画会把搜索框和这两个下拉都换掉 → 失焦） */
  setLocalSort(v) {
    const MS = window.MusicSort;
    const next = MS ? MS.normalizeSpec(v) : v;
    if (next === this.localSort) return;
    this.localSort = next;
    /* ⚠️ 下拉框要**自己回写一次**：只有用户手动改下拉时它会自动跟着变，
       程序里调这个方法（截图场景 / 快捷键 / 别处跳回来）不改 value 的话，
       控件上显示的排序和真正生效的排序就对不上了。 */
    const sel = document.getElementById('mLocalSort');
    if (sel) sel.value = next;
    if (window.State && typeof State.set === 'function') State.set({ localSort: next }).catch(() => {});
    this.paintLocal();
  },

  /** 换歌手筛选：同上 */
  setLocalArtist(v) {
    /* 下拉的 value 只有三种：''（全部）、某个歌手名、'__none__'（未知歌手） */
    const next = typeof v === 'string' ? v : '';
    if (next === this.localArtist) return;
    this.localArtist = next;
    const sel = document.getElementById('mLocalArtist');
    if (sel) sel.value = next;
    if (window.State && typeof State.set === 'function') State.set({ localArtist: next }).catch(() => {});
    this.paintLocal();
  },

  /** 清掉歌手筛选（下拉也要跟着回到「全部歌手」） */
  clearLocalFilter() {
    this.setLocalArtist('');
  },

  /** 搜索命中的曲目（空格分词，多词要**全都**命中；标题 / 歌手 / 专辑任一）
   *  + 歌手筛选 + 排序（两个都在 js/music-sort.js 里，纯函数有单测）。
   *  ⚠️ 返回的是**新数组**，原 `this.tracks` 顺序不动 —— 行点击要用
   *     `this.tracks.indexOf(t)` 还原成曲库原索引去播放。 */
  filteredTracks() {
    const MS = window.MusicSort;
    const kw = (this.localQuery || '').trim().toLowerCase();
    let list = this.tracks;
    const artist = this.activeArtist();
    if (MS && artist) list = MS.byArtist(list, artist);
    if (kw) {
      const words = kw.split(/\s+/).filter(Boolean);
      list = list.filter((t) => {
        const hay = ((t.title || '') + ' ' + (t.artist || '') + ' ' + (t.album || '')).toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    return MS ? MS.sortTracks(list, this.localSort) : list;
  },

  /** 只重画本地音乐那份列表（搜索框在它外面，所以打字不会失焦） */
  paintLocal() {
    const box = this.localListEl;
    if (!box) return;
    box.innerHTML = '';
    const kw = (this.localQuery || '').trim();
    const artist = this.activeArtist();
    const list = this.filteredTracks();
    /* 顶上的「找到 N 首」和搜索框的清空按钮都要跟着变 → 单独更新，不重画整页 */
    const cnt = this.mainEl && this.mainEl.querySelector('.ms-count');
    // 没搜索也没筛选就空着（CSS :empty 会把它藏掉）
    if (cnt) cnt.textContent = (kw || artist) ? `找到 ${list.length} 首` : '';
    const x = this.mainEl && this.mainEl.querySelector('.msearch .ms-x');
    if (x) x.classList.toggle('off', !kw);

    if (!list.length) {
      /* 空态分两种：搜不到 / 筛选后没有。文案要指回**真正该改的那个控件**。 */
      box.appendChild(el('div', { class: 'empty' },
        el('h3', { text: kw ? '没有匹配的歌' : '这个歌手名下没有歌' }),
        el('p', {
          text: kw
            ? `「${kw}」在标题 / 歌手 / 专辑里都没找到。${artist ? '（当前还筛着歌手：' + (window.MusicSort ? window.MusicSort.artistName(artist) : artist) + '）' : ''}`
            : `当前只显示「${window.MusicSort ? window.MusicSort.artistName(artist) : artist}」，库里没有它的歌。`
        }),
        el('div', { class: 'row', style: { justifyContent: 'center' } },
          kw ? el('button', { class: 'btn', onclick: () => this.clearLocalSearch() }, '清空搜索') : null,
          artist ? el('button', { class: 'btn', onclick: () => this.clearLocalFilter() }, '取消歌手筛选') : null)));
      return;
    }
    const ul = el('div', { class: 'track-list' });
    list.forEach((t, i) => {
      /* ⚠️ 序号显示的是**结果里的第几首**，但播放要传回**曲库里的原索引** ——
         搜索状态下这两个数不是一回事，传错就播到别的歌去了。 */
      ul.appendChild(this.trackRow(t, i + 1, () => this.playAt(this.tracks.indexOf(t)), [
        el('button', { class: 'btn btn-sm btn-ghost', title: '从库中移除（不删文件）',
          onclick: (e) => { e.stopPropagation(); API.raw.music.removeTrack(t.id).then(() => this.reload()); } }, uiSpan('trash'))
      ]));
    });
    box.appendChild(ul);
  },

  clearLocalSearch() {
    this.localQuery = '';
    const inp = document.getElementById('mLocalSearch');
    if (inp) { inp.value = ''; inp.focus(); }
    this.paintLocal();
  },

  /* ==============================================================
   *  听歌统计（第三十轮）
   *  聚合全在主进程（src/main/music/stats.js，纯函数有单测），这里只管画。
   * ============================================================== */
  renderStats(main) {
    const root = el('div', { class: 'stats' });
    main.appendChild(root);
    this.statRootEl = root;
    this.paintStats();
  },

  async paintStats() {
    const root = this.statRootEl;
    if (!root) return;
    clear(root);
    root.appendChild(this.statsHead());
    const body = el('div', { class: 'stats-body' },
      el('div', { class: 'stats-loading', text: '正在统计…' }));
    root.appendChild(body);

    const d = await API.raw.music.stats(this.statPeriod, this.statOffset).catch(() => null);
    /* ⚠️ 异步回来时用户可能已经切到别的页面了 —— 这时 statRootEl 已经不指向这份 DOM，
       再往里写就会往「别人的页面」上乱画（和探针等页面就绪那个坑同源）。 */
    if (!this.statRootEl || this.statRootEl !== root) return;
    clear(body);
    if (!d) {
      body.appendChild(el('div', { class: 'empty', style: { minHeight: '200px' } },
        el('h3', { text: '统计读不出来' }),
        el('p', { text: '稍后再试。' })));
      return;
    }
    this.paintStatsBody(body, d);
  },

  statsHead() {
    const seg = (k, t) => el('span', {
      class: 'sg' + (this.statPeriod === k ? ' on' : ''),
      onclick: () => {
        if (this.statPeriod === k) return;
        this.statPeriod = k;
        this.statOffset = 0;          // 换周期就回到本期，别把「上个月的第 -3 周」这种状态带过去
        this.paintStats();
      }
    }, t);
    return el('div', { class: 'stats-head' },
      el('div', { class: 'sh-l' },
        el('h2', { text: '听歌足迹' }),
        el('p', { class: 'text-dim', id: 'statsTotal', text: '总时长 计算中…' })),
      el('div', { class: 'seg' }, seg('week', '周'), seg('month', '月'), seg('year', '年')));
  },

  statsNav(d) {
    return el('div', { class: 'stats-nav' },
      el('button', {
        class: 'sn-btn', title: '上一期',
        onclick: () => { this.statOffset -= 1; this.paintStats(); }
      }, uiSpan('back')),
      el('span', { class: 'sn-label', text: d.label }),
      el('button', {
        class: 'sn-btn', title: d.isCurrent ? '已经是本期了' : '下一期',
        disabled: d.isCurrent,
        onclick: () => { if (this.statOffset >= 0) return; this.statOffset += 1; this.paintStats(); }
      }, uiSpan('chevron')),
      el('span', { class: 'sn-tip', text: d.period === 'year' ? '按整年' : d.dayCount + ' 天' }));
  },

  paintStatsBody(body, d) {
    const totalEl = body.parentNode && body.parentNode.querySelector('#statsTotal');
    if (totalEl) totalEl.textContent = '总时长 ' + humSec(d.lifetimeSec || 0);

    body.appendChild(this.statsNav(d));

    if (!d.hasData) {
      body.appendChild(el('div', { class: 'empty', style: { minHeight: '220px' } },
        el('h3', { text: (PERIOD_WORD[d.period] || '本期') + '还没有听歌记录' }),
        el('p', { text: '播放几首之后回来看，这里会长出时长、唱片墙和榜单。' })));
      return;
    }

    const word = PERIOD_WORD[d.period] || '本期';
    const hm = hmSec(d.totalSec);

    /* ① 总时长 + 日历 */
    body.appendChild(el('div', { class: 'stats-card sc-big' },
      el('div', { class: 'sc-eyebrow', text: word + '收听时长' }),
      el('div', { class: 'sc-number' },
        el('b', { text: String(hm.h) }), el('i', { text: '小时' }),
        el('b', { text: String(hm.m) }), el('i', { text: '分' })),
      el('div', { class: 'sc-sub', text: '已听 ' + d.listenedDays + '/' + d.dayCount + ' 天' }),
      this.statsCal(d)));

    /* ② 最晚听歌 / 与上期对比 */
    const up = d.deltaSec > 0;
    const down = d.deltaSec < 0;
    body.appendChild(el('div', { class: 'stats-duo' },
      el('div', { class: 'stats-mini' },
        el('b', { text: d.clock || '—' }),
        el('span', { class: 'sm-tag' }, uiSpan('clock'), '最晚听歌')),
      el('div', { class: 'stats-mini' },
        el('b', { text: (up || down ? (down ? '−' : '') + humSec(Math.abs(d.deltaSec)) : '持平') }),
        el('span', { class: 'sm-tag' }, uiSpan('chart'),
          down ? '比上期少听' : up ? '比上期多听' : '和上期一样'))));

    /* ③ 唱片墙 */
    const wallItems = (d.wall.length ? d.wall : d.tracks).slice(0, 24);
    body.appendChild(el('div', { class: 'stats-card sc-wall' },
      el('h3', { text: word + '唱片墙' }),
      el('div', { class: 'wall' },
        el('div', { class: 'wall-grid' }, wallItems.map((t, i) => (t.cover
          ? el('div', { class: 'wg-cell', title: t.title + ' · ' + t.artist },
            el('img', { src: t.cover, alt: '' }))
          : el('div', { class: 'wg-cell ph p' + (i % 5), title: t.title + ' · ' + t.artist })))),
        el('div', { class: 'wall-num' }, el('b', { text: String(d.wallCount) }), el('span', { text: '首' }))),
      el('div', { class: 'row', style: { marginTop: '14px' } },
        el('button', { class: 'btn btn-primary', onclick: () => this.exportStatsPoster() },
          uiSpan('image'), '生成海报'),
        el('span', { class: 'hint', text: '把这一期统计存成一张图片' }))));

    /* ④ 单曲 TOP3 */
    body.appendChild(this.rankCard(word + '单曲', d.topTracks, '次收听', '收听'));
    /* ⑤ 音乐人 TOP3 */
    body.appendChild(this.artistCard(word + '音乐人', d.topArtists, '次收听'));
    /* ⑥ 听歌年代 */
    body.appendChild(this.eraCard(word + '听歌年代', d.eras));
    /* ⑦ 听歌语言 */
    body.appendChild(this.langCard(word + '听歌语言', d.langs));
  },

  /** 日历热力图：周/月按天（7 列 + 星期表头），年按月（12 格） */
  statsCal(d) {
    if (d.period === 'year') {
      return el('div', { class: 'cal-year' }, d.buckets.map((b) => el('div', {
        class: 'cy-cell l' + b.level,
        title: b.label + ' 月 · ' + (b.sec ? humSec(b.sec) : '没有听歌')
      },
        el('span', { class: 'cy-m', text: b.label }), el('span', { class: 'cy-v', text: b.sec ? Math.round(b.sec / 3600) + 'h' : '' }))));
    }
    const grid = el('div', { class: 'cal' });
    const first = d.buckets[0];
    if (first && first.wd > 0) for (let i = 0; i < first.wd; i++) grid.appendChild(el('div', { class: 'cal-cell pad' }));
    for (const b of d.buckets) {
      grid.appendChild(el('div', {
        class: 'cal-cell l' + b.level + (b.isToday ? ' today' : ''),
        title: b.key + ' · ' + (b.sec ? humSec(b.sec) : '没有听歌')
      }, b.label));
    }
    return el('div', { class: 'cal-wrap' },
      el('div', { class: 'cal-wd' }, ['一', '二', '三', '四', '五', '六', '日'].map((t) => el('span', { text: t }))),
      grid);
  },

  /** 通用榜单卡：第一名大图，2/3 名小行 */
  rankCard(title, list, unit, tagWord) {
    if (!list || !list.length) return null;
    const hero = list[0];
    const card = el('div', { class: 'stats-card sc-rank' },
      el('h3', { text: title }),
      el('div', { class: 'rk-hero' },
        el('div', { class: 'rk-cover' }, hero.cover ? el('img', { src: hero.cover, alt: '' }) : el('span', { class: 'ph', text: '♪' })),
        el('div', { class: 'rk-info' },
          el('div', { class: 'rk-tag', text: '✦ TOP' }),
          el('div', { class: 'rk-n' }, el('b', { text: String(hero.n) }), el('span', { text: unit })),
          el('div', { class: 'rk-title ellipsis', title: hero.title, text: hero.title }),
          hero.artist ? el('div', { class: 'rk-sub ellipsis', text: hero.artist }) : null)));
    const rest = list.slice(1);
    if (rest.length) {
      card.appendChild(el('div', { class: 'rk-rest' }, rest.map((t, i) => el('div', { class: 'rk-item' },
        el('div', { class: 'rk-thumb' }, t.cover ? el('img', { src: t.cover, alt: '' }) : el('span', { class: 'ph', text: '♪' })),
        el('div', { class: 'rk-meta' },
          el('div', { class: 'rk-tag2', text: tagWord + ' TOP' + (i + 2) }),
          el('div', { class: 'rk-n2' }, el('b', { text: String(t.n) }), el('span', { text: unit })),
          el('div', { class: 'rk-name ellipsis', title: t.title, text: t.title }),
          t.artist ? el('div', { class: 'rk-sub ellipsis', text: t.artist }) : null)))));
    }
    return card;
  },

  artistCard(title, list, unit) {
    if (!list || !list.length) return null;
    const hero = list[0];
    const card = el('div', { class: 'stats-card sc-rank sc-artist' },
      el('h3', { text: title }),
      el('div', { class: 'rk-hero' },
        el('div', { class: 'rk-cover round' }, hero.cover ? el('img', { src: hero.cover, alt: '' }) : el('span', { class: 'ph', text: '♬' })),
        el('div', { class: 'rk-info' },
          el('div', { class: 'rk-tag', text: '✦ TOP' }),
          el('div', { class: 'rk-n' }, el('b', { text: String(hero.n) }), el('span', { text: unit })),
          el('div', { class: 'rk-title ellipsis', title: hero.artist, text: hero.artist }))));
    const rest = list.slice(1);
    if (rest.length) {
      card.appendChild(el('div', { class: 'rk-rest' }, rest.map((t, i) => el('div', { class: 'rk-item' },
        el('div', { class: 'rk-thumb round' }, t.cover ? el('img', { src: t.cover, alt: '' }) : el('span', { class: 'ph', text: '♬' })),
        el('div', { class: 'rk-meta' },
          el('div', { class: 'rk-tag2', text: '收听 TOP' + (i + 2) }),
          el('div', { class: 'rk-n2' }, el('b', { text: String(t.n) }), el('span', { text: unit })),
          el('div', { class: 'rk-name ellipsis', title: t.artist, text: t.artist }))))));
    }
    return card;
  },

  eraCard(title, eras) {
    if (!eras || !eras.length) return null;
    return el('div', { class: 'stats-card' },
      el('h3', { text: title }),
      el('div', { class: 'eras' }, eras.map((e, i) => el('div', { class: 'era' + (i === 0 ? ' top' : '') },
        el('div', { class: 'era-y' },
          i === 0 ? el('span', { class: 'era-tag', text: 'TOP' }) : null,
          el('span', { text: e.key })),
        el('div', { class: 'era-c' }, e.top && e.top.cover ? el('img', { src: e.top.cover, alt: '' }) : el('span', { class: 'ph', text: '♪' })),
        el('div', { class: 'era-n' },
          el('b', { text: String(e.n) }), el('span', { text: '首' }),
          e.top ? el('div', { class: 'era-rep ellipsis', title: e.top.title, text: '代表曲目 ' + e.top.title }) : null)))));
  },

  langCard(title, langs) {
    if (!langs || !langs.length) return null;
    return el('div', { class: 'stats-card' },
      el('h3', { text: title }),
      el('div', { class: 'langs' }, langs.map((l, i) => el('div', {
        class: 'lang' + (i === 0 ? ' top' : ''),
        style: { flexGrow: String(Math.max(1, l.pct)) }
      },
        i === 0 ? el('span', { class: 'era-tag', text: 'TOP' }) : null,
        el('div', { class: 'lang-p' }, el('b', { text: l.pct + '%' }), el('span', { text: l.key })),
        el('div', { class: 'lang-t' }, l.top
          ? (l.top.cover ? el('img', { src: l.top.cover, alt: '' }) : el('span', { class: 'ph', text: '♪' }))
          : el('span', { class: 'ph', text: '♪' })),
        l.top ? el('div', { class: 'lang-rep ellipsis', title: l.top.title, text: l.top.title }) : null))));
  },

  /** 把统计页存成图片（主进程 capturePage，见 main.js 的 music:shotStats） */
  async exportStatsPoster() {
    const el2 = this.statRootEl && this.statRootEl.parentNode;
    const box = el2 ? el2.querySelector('.stats-body') : null;
    if (!box) return;
    const r = box.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const res = await API.raw.music.shotStats({
      x: Math.round(r.left), y: Math.round(r.top),
      width: Math.round(r.width), height: Math.round(Math.min(r.height, window.innerHeight - r.top)),
      label: (this.statPeriod || 'month')
    }).catch((e) => ({ ok: false, error: e && e.message }));
    if (res && res.ok) window.Shell.toast('已保存到 ' + res.file, 'ok');
    else if (res && res.canceled) { /* 用户自己取消的，不提示 */ }
    else window.Shell.toast('保存失败：' + ((res && res.error) || '未知原因'), 'err');
  },

  /**
   * 曲目行（本地音乐 / 歌单详情共用）。
   * 「词」标记 = 这首歌已经匹配到 LRC 歌词文件，点开歌词页就能看到时间轴。
   */
  trackRow(t, no, onPlay, actions) {
    const on = !!(this.current() && this.current().id === t.id);
    return el('div', { class: 'track' + (on ? ' on' : ''), dataset: { tid: t.id }, onclick: onPlay, ondblclick: onPlay },
      el('span', { class: 'no', text: String(no) }),
      el('div', { class: 'tt' },
        el('div', { class: 'n', text: t.title }),
        el('div', { class: 'a' },
          t.artist + ' · ' + t.album,
          this.lrcMap[t.id] ? el('span', { class: 'tag-lrc', title: '已匹配到 LRC 歌词' }, '词') : null
        )
      ),
      el('span', { class: 'dur', text: formatDuration(t.duration) }),
      ...(actions || [])
    );
  },

  renderDownloads(main) {
    main.appendChild(el('div', { class: 'rail-title' }, el('h3', { text: '下载音乐' })));
    main.appendChild(this.sourceCard());
    main.appendChild(this.crawlCard());
    main.appendChild(el('div', { class: 'card' },
      el('h3', { text: '方式二 · 从服务器 / NAS 获取' }),
      el('p', { class: 'hint', text: '填写服务器或 NAS 地址（支持目录索引页 / WebDAV / 返回 JSON 的接口），自动列出可下载曲目。' }),
      el('div', { class: 'row' },
        el('input', { class: 'inp grow', id: 'mSrvAddr', placeholder: 'http://192.168.1.10/music/ 或 nas.local' }),
        el('button', { class: 'btn btn-primary', onclick: () => this.browseServer() }, uiSpan('server'), '查询'))
    ));
    const mineReady = (this.platforms || []).some((p) => p.logged && (p.id === 'netease' || p.id === 'qq'));
    main.appendChild(el('div', { class: 'card' },
      el('h3', { text: '登录国内音乐平台' }),
      el('p', { class: 'hint', text: '点一下会在软件内开一个官方登录窗口，登完自动抓取凭证并保存到本机（和「浏览器」模块共用 Cookie），文件不会经过任何第三方。再点一次可以退出登录。' }),
      // ⚠️ 以前这里只写了「登录后可以导入自己的私密歌单」，却没告诉用户**去哪导** ——
      //    登录的价值就卡在这一步。所以登录后直接在卡片上给出入口。
      el('p', { class: 'hint' },
        mineReady
          ? el('span', {}, '已登录。你账号里的歌单（包括私密的、收藏的）可以直接导入：',
            el('button', { class: 'btn btn-sm btn-primary', style: { marginLeft: '8px' }, onclick: () => this.importPlaylistDialog('mine') },
              uiSpan('link'), '导入我的歌单'))
          : el('span', {}, '分享链接只能导入公开歌单；登录后可以导入你自己建的 / 收藏的私密歌单。导入入口在左侧「导入 / 外部歌单」。')
      ),
      el('div', { class: 'plat-grid' },
        this.platforms.map((p) => el('div', { class: 'pcard' + (p.logged ? ' on' : ''), onclick: () => this.loginPlatform(p) },
          el('div', { class: 'pico', style: { background: p.color }, text: p.name.slice(0, 1) }),
          el('div', { class: 'pmeta' },
            el('div', { class: 'pname', text: p.name }),
            el('div', { class: 'pstate' + (p.logged ? '' : ' off') }, el('span', { class: 'dot' }),
              p.logged ? (p.nickname || '已登录') : '未登录')
          )
        ))
      )
    ));
  },

  /**
   * 逐地址回报时用的短名：「域名 + 第一段路径」。
   * ⚠️ 只取域名是不行的 —— 用户很可能会填同一个站的多个网址
   * （`music.example.com/` 和 `music.example.com/search/x`），只显示域名的话
   * 逐行回报会长得一模一样，根本分不清哪一行是哪个。
   */
  shortSite(u) {
    const s = String(u || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (!s) return '';
    const parts = s.split('/').filter(Boolean);
    const host = parts[0] || '';
    const seg = parts[1] || '';
    return seg ? `${host}/${seg.length > 20 ? seg.slice(0, 20) + '…' : seg}` : host;
  },

  /* ==============================================================
   *  通用「多行地址编辑器」（下载源搜索地址 / 网站抓取网址 共用）
   * --------------------------------------------------------------
   *  rows 是唯一真源；每次加 / 删都**整段重画**这个列表
   *  （比手工插删 DOM 稳得多，也不会漏掉「删中间一行」的情况）。
   *  @param {string[]} rows 可变数组，直接就地改
   *  @param {Object} o cls / rowCls / inpCls / ph / plusTitle / delTitle
   *  @returns {{root:Element, paint:Function, read:Function, normalize:Function}}
   * ============================================================== */
  siteEditor(rows, o) {
    const root = el('div', { class: o.cls });
    const paint = (focusLast) => {
      clear(root);
      rows.forEach((v, i) => {
        const inp = el('input', { class: 'inp grow ' + o.inpCls, value: v, placeholder: o.ph });
        /* ⚠️ 用 oninput 而不是塞进 el() 的 children —— 那会把函数当子节点 appendChild。
           而且 rows 必须跟着输入实时更新，否则「加一行再删一行」会把刚打的字弄丢。 */
        inp.oninput = () => { rows[i] = inp.value; };
        const tail = [];
        if (rows.length > 1) {
          tail.push(el('button', {
            class: 'btn btn-icon', title: o.delTitle,
            onclick: () => { rows.splice(i, 1); paint(false); }
          }, uiSpan('close')));
        }
        if (i === rows.length - 1) {
          tail.push(el('button', {
            class: 'btn btn-icon', title: o.plusTitle,
            onclick: () => { rows.push(''); paint(true); }
          }, uiSpan('plus')));
        }
        root.appendChild(el('div', { class: 'row ' + o.rowCls }, inp, ...tail));
      });
      if (focusLast) {
        const all = root.querySelectorAll('.' + o.inpCls);
        const last = all[all.length - 1];
        if (last) last.focus();
      }
    };
    paint(false);
    return {
      root,
      paint,
      read: () => rows.map((s) => String(s || '').trim()).filter(Boolean),
      /* 把行规范化成「真正存下来的那几条」：空行 / 重复的消失；
         清空到一条不剩时补一个空行，否则用户没有输入框可填了。 */
      normalize: (list) => {
        const kept = (list || []).slice();
        rows.length = 0;
        rows.push(...(kept.length ? kept : ['']));
        paint(false);
      }
    };
  },

  /* ==============================================================
   *  音乐下载源（导入的外部歌单靠它补全缺失曲目）
   *  软件本身不内置任何音源 —— 用户填自己能用的搜索地址，
   *  我们只做「填关键词 → 抓结果 → 挑最高音质 → 下载 + 自动入库」。
   * ============================================================== */
  sourceCard() {
    const cfg = this.srcCfg || { sites: [], site: '', mode: 'page', prefer: 'highest', saveDir: '', defaultDir: '', configured: false };
    const status = el('div', { class: 'src-status', id: 'srcStatus' });

    /* ---- 搜索地址：可以填**多个**，从上到下依次尝试，谁先搜到就用谁 ----
       编辑器抽成 MusicView.siteEditor（「方式一 · 从网站抓取」那张卡共用一套）。 */
    const rows = (Array.isArray(cfg.sites) && cfg.sites.length) ? cfg.sites.slice() : (cfg.site ? [cfg.site] : ['']);
    const ed = this.siteEditor(rows, {
      cls: 'src-sites', rowCls: 'src-site-row', inpCls: 'src-site',
      ph: 'https://your-music-site.com/search?q={q}',
      plusTitle: '再加一个搜索地址（按顺序试，谁先搜到用谁）',
      delTitle: '删掉这一条'
    });
    const readSites = ed.read;

    const modeSel = el('select', { class: 'inp' },
      el('option', { value: 'page' }, '网页（HTML 搜索结果页）'),
      el('option', { value: 'json' }, '接口（返回 JSON）'));
    modeSel.value = cfg.mode;

    const prefSel = el('select', { class: 'inp' },
      el('option', { value: 'highest' }, '尽量最高（推荐）'),
      el('option', { value: 'lossless' }, '至少无损'),
      el('option', { value: 'high' }, '至少 320k'),
      el('option', { value: 'normal' }, '至少 128k'),
      el('option', { value: 'any' }, '有就行'));
    prefSel.value = cfg.prefer;

    const dir = el('input', { class: 'inp grow', id: 'srcDir', value: cfg.saveDir, placeholder: cfg.defaultDir || '留空 = 默认下载目录' });
    const test = el('input', { class: 'inp grow', id: 'srcTest', placeholder: '测试关键词，如：周杰伦 晴天' });

    const save = async () => {
      const list = readSites();
      const next = await API.raw.music.setSourceConfig({
        sites: list, mode: modeSel.value, prefer: prefSel.value, saveDir: (dir.value || '').trim()
      }).catch((e) => { window.Shell.toast(e.message || String(e), 'err'); return null; });
      if (!next) return;
      /* ⚠️ setSourceConfig 返回的是纯配置对象，**不带 `configured`** —— 直接展开
         会让角标和左侧栏停在旧状态（明明刚填好地址，却还显示「未配置」）。
         这里按地址数量自己算一遍，省一次 IPC。 */
      this.srcCfg = { ...cfg, ...next, configured: !!(next.sites && next.sites.length) };
      this.refreshSrcUi();
      /* 顺便把输入行规范化成「真正存下来的那几条」：空行 / 重复的会消失，
         免得界面显示 4 条、实际只有 2 条（但**保留每一行的原值**，不重画整张卡片）。 */
      const kept = (this.srcCfg.sites || []).slice();
      ed.normalize(kept);
      /* ⚠️ 文案要报 **kept** 而不是 list —— list 是用户点保存时界面上的行数，
         里面可能夹着空白行和重复行，报出去的数字和实际存的对不上。 */
      status.textContent = kept.length
        ? `已保存 ${kept.length} 个搜索地址。导入的外部歌单里缺的歌会按从上到下的顺序去这些地址找。`
        : '已保存（地址清空了，补全功能会停用）。';
      status.className = 'src-status' + (kept.length ? ' ok' : ' warn');
      window.Shell.toast('下载源已保存', 'ok');
    };

    const runTest = async () => {
      const kw = (test.value || '').trim();
      if (!kw) return window.Shell.toast('先填一个测试关键词', 'err');
      const list = readSites();
      if (!list.length) return window.Shell.toast('先填一个搜索地址', 'err');
      status.textContent = '正在测试…';
      status.className = 'src-status';
      // 测试直接用当前输入框里的配置，不用先保存
      await API.raw.music.setSourceConfig({ sites: list, mode: modeSel.value, prefer: prefSel.value, saveDir: (dir.value || '').trim() }).catch(() => {});
      const r = await API.raw.music.testSource(kw).catch((e) => {
        status.textContent = '测试失败：' + (e.message || String(e));
        status.className = 'src-status err';
        return null;
      });
      if (!r) return;
      this.srcCfg = { ...cfg, ...(await API.raw.music.sourceConfig().catch(() => ({}))) };
      this.refreshSrcUi();
      /* 填了多个地址就**逐个报** —— 用户最想知道的就是「哪个能用、哪个是坏的」 */
      const ds = Array.isArray(r.details) ? r.details : [];
      if (ds.length > 1) {
        const lines = ds.map((d, i) => {
          /* 只显示域名会在「同一个站填了多个网址」时长得一模一样 → 带上第一段路径 */
          const name = this.shortSite(d.site) || ('地址 ' + (i + 1));
          if (d.ok === false) return `✗ ${name}：${d.error || '打不开'}`;
          return d.count ? `✓ ${name}：${d.count} 条候选` : `— ${name}：通了，但没解析到音频`;
        });
        const hit = ds.find((d) => d.ok && d.count);
        if (hit) lines.push(`实际会用第 ${ds.indexOf(hit) + 1} 个：${hit.best ? hit.best.levelLabel + ' — ' + (hit.best.title || '（无标题）') : '（未知音质）'}`);
        status.textContent = lines.join('\n');
        status.className = 'src-status ' + (hit ? 'ok' : 'warn');
        return;
      }
      if (!r.count) {
        status.textContent = `通了，但这个关键词下没解析出音频（${r.count} 条候选）。检查地址对不对，或者把「返回类型」换成另一种试试。`;
        status.className = 'src-status warn';
        return;
      }
      status.textContent = `可用：解析到 ${r.count} 条候选，最高音质 ${r.best ? r.best.levelLabel + ' — ' + r.best.title : '（未知）'}`;
      status.className = 'src-status ok';
    };

    return el('div', { class: 'card src-card', id: 'mSrcCard' },
      el('div', { class: 'src-title' },
        el('h3', { text: '音乐下载源 · 自动补全歌单' }),
        /* ⚠️ 这个角标 save() 里要就地改，所以给它 id（别整张卡片重画，会丢输入框里的字） */
        el('span', { id: 'srcChip', class: 'chip ' + (cfg.configured ? 'accent' : 'warn'), text: cfg.configured ? '已配置' : '未配置' })),
      el('p', { class: 'hint', text: '导入 QQ 音乐 / 网易云歌单后，本地没有的歌会自动来这里搜。填你自己能用的搜索地址（自建音乐站、NAS、有授权的站点均可），软件只负责「填关键词 → 抓结果 → 挑最高音质 → 下载并入库」。' }),
      el('p', { class: 'hint', text: '搜索地址可以填多个（最多 8 个）：补全时会从上到下依次尝试，谁先搜到就用谁 —— 某个站挂了或者搜不到，会自动换下一个。' }),
      el('div', { class: 'row src-sites-row' }, el('span', { class: 'label', text: '搜索地址' }), ed.root),
      el('div', { class: 'row' },
        el('span', { class: 'label', text: '占位符' }),
        el('span', { class: 'src-ph', text: '{q}' }), el('span', { class: 'src-ph', text: '{title}' }), el('span', { class: 'src-ph', text: '{artist}' }),
        el('span', { class: 'text-dim', style: { fontSize: '.8em' } }, '（不填占位符就自动拼 ?q=关键词）')),
      el('div', { class: 'row' },
        el('span', { class: 'label', text: '返回类型' }), modeSel,
        el('span', { class: 'label', style: { width: 'auto', marginLeft: '12px' }, text: '音质偏好' }), prefSel),
      el('div', { class: 'row' },
        el('span', { class: 'label', text: '保存到' }), dir,
        el('button', { class: 'btn', onclick: async () => {
          const d = await API.raw.music.pickSourceDir().catch(() => '');
          if (d) dir.value = d;
        } }, uiSpan('folder'), '选择文件夹')),
      el('div', { class: 'row' },
        el('span', { class: 'label', text: '连通测试' }), test,
        el('button', { class: 'btn', onclick: runTest }, uiSpan('search'), '测试'),
        el('button', { class: 'btn btn-primary', onclick: save }, uiSpan('save'), '保存')),
      status
    );
  },

  /**
   * 方式一 · 从网站抓取
   * 和上面的下载源一样：**可以填多个网站**，但语义不同 ——
   * 抓取是「把每个站都抓一遍，结果合并去重」（不是谁先抓到用谁），
   * 因为几个站就是几份来源，一次抓全才有意义。
   * 某个站打不开只跳过它，绝不影响其他站。
   */
  crawlCard() {
    const cfg = this.crawlCfg || { sites: [], configured: false };
    const status = el('div', { class: 'src-status', id: 'crawlStatus' });

    /* ⚠️ 空列表必须兜一个空行 —— 否则一行都不画，用户连输入框和「＋」都看不到，
       这个功能等于进不去（第一版就是这样，被探针逮住了）。 */
    const rows = (Array.isArray(cfg.sites) && cfg.sites.length) ? cfg.sites.slice() : [''];
    const ed = this.siteEditor(rows, {
      cls: 'crawl-sites', rowCls: 'crawl-site-row', inpCls: 'crawl-site',
      ph: 'https://www.example.com/ 或某个歌单 / 专辑页',
      plusTitle: '再加一个网站（抓取时每个都抓一遍，结果合并去重）',
      delTitle: '删掉这一条'
    });
    /* ⚠️ 抽出来的读取函数要留给 crawl() 用（抓取时才取输入框里的最新值） */
    this._crawlEd = ed;

    /* 抓取和测试都用「当前输入框里的网址」，并顺手存下来 ——
       和下载源那张卡的「测试即保存」保持一致，用户不用再多点一次保存。 */
    const persist = async () => {
      const list = ed.read();
      const next = await API.raw.music.setCrawlConfig({ sites: list }).catch(() => null);
      if (next) this.crawlCfg = next;
      return list;
    };

    const runTest = async () => {
      const list = ed.read();
      if (!list.length) return window.Shell.toast('先填一个要抓取的网站', 'err');
      status.textContent = '正在逐个测试…';
      status.className = 'src-status';
      await persist();
      const r = await API.raw.music.testCrawlSites(list).catch((e) => {
        status.textContent = '测试失败：' + (e.message || String(e));
        status.className = 'src-status err';
        return null;
      });
      if (!r) return;
      const ds = Array.isArray(r.details) ? r.details : [];
      /* 逐站回报。⚠️ 「必须抓到音频才算通」（用户定的），但要把
         「打不开」和「打开了却没抓到音频」分开说，否则提示会误导。 */
      const lines = ds.map((d) => {
        const name = this.shortSite(d.url) || d.url;
        if (!d.reached) return `✗ ${name}：打不开 — ${d.error || '未知错误'}`;
        if (!d.audio) return `✗ ${name}：能打开，但没抓到音频直链${d.netdisk ? `（只有 ${d.netdisk} 个网盘链接）` : ''}`;
        return `✓ ${name}：${d.audio} 个音频直链${d.netdisk ? ` + ${d.netdisk} 个网盘链接` : ''}`;
      });
      const good = ds.filter((d) => d.ok).length;
      /* ⚠️ 这里**不**报「第一个能用的」—— 那是下载源（依次尝试、只用第一个）的说法。
         抓取是「每个都抓一遍」，说「第一个」反而误导。 */
      if (ds.length > 1) {
        lines.push(good
          ? `${good}/${ds.length} 个网站能抓到音频，抓取时每个都会抓一遍再合并。`
          : '没有一个网站抓到音频 —— 试试把网址改成**具体的歌曲 / 专辑页**，首页通常只有导航链接。');
      } else if (!good) {
        lines.push('提示：网站首页通常只有导航链接，换成**具体的歌曲 / 专辑页**再试。');
      }
      status.textContent = lines.join('\n');
      status.className = 'src-status ' + (good ? 'ok' : 'warn');
    };

    return el('div', { class: 'card crawl-card', id: 'mCrawlCard' },
      el('h3', { text: '方式一 · 从网站抓取' }),
      el('p', { class: 'hint', text: '填写网页地址，自动提取其中的音频直链与网盘链接；网盘链接会转交「网盘」模块下载。' }),
      el('p', { class: 'hint', text: '网址可以填多个（最多 8 个）：抓取时**每个都抓一遍**，结果合并去重（同一个文件只下一次）；某个站打不开只会跳过它，不影响其他站。' }),
      el('div', { class: 'row src-sites-row' }, el('span', { class: 'label', text: '网站' }), ed.root),
      el('div', { class: 'row crawl-test-row' },
        el('span', { class: 'label', text: '连通测试' }),
        el('span', { class: 'text-dim crawl-tip', text: '每个网址单独抓一次，能拿到音频直链才算通' }),
        el('button', { class: 'btn', onclick: runTest }, uiSpan('search'), '测试'),
        el('button', { class: 'btn btn-primary', onclick: () => this.crawl() }, uiSpan('globe'), '抓取')),
      status
    );
  },


  /**
   * 下载源配置变了（保存 / 测试）→ 就地刷新两处，**不重画整张卡片**
   * （重画会把用户正在输的地址、测试结果全清掉）：
   *   ① 卡片头上的「未配置 / 已配置」角标
   *   ② 左侧栏条目：「配置下载源」⇄「下载与订阅」
   */
  refreshSrcUi() {
    const ready = !!(this.srcCfg && this.srcCfg.configured);
    const chip = document.getElementById('srcChip');
    if (chip) {
      chip.className = 'chip ' + (ready ? 'accent' : 'warn');
      chip.textContent = ready ? '已配置' : '未配置';
    }
    this.renderRail();
  },

  /* ---------------- 播放 ---------------- */
  current() { return this.index >= 0 ? this.queue[this.index] : null; },

  playAt(i) {
    this.queue = this.tracks.slice();
    this.index = i;
    this.play();
  },

  /** 媒体元素给的错误码 → 人话 */
  errText(err) {
    const c = err && err.code;
    if (c === 1) return '播放被中止';
    if (c === 2) return '读取失败（文件被占用、被移动或没有权限）';
    if (c === 3) return '解码失败（文件可能损坏）';
    if (c === 4) return '打不开这个文件（格式不支持，或文件已不存在）';
    return (err && err.message) || '未知错误';
  },

  /**
   * ⚠️ 为什么必须单独接 error：媒体加载失败时 `play()` 的 promise 往往是
   * **resolve 而不是 reject**，错误只体现在元素上。以前没有 onerror，
   * 表现就是「点了歌没反应、也不报错」—— 正是「播放不了音乐」的观感。
   */
  onAudioError() {
    const t = this.current();
    const why = this.errText(this.audio.error);
    const name = t ? (t.title || window.util.baseName(t.path)) : '当前曲目';
    /* code 4 = 打不开（多半是文件已经不在了）→ 顺手告诉用户怎么一键清掉，
       省得他一个个手动删（第四十一轮）。 */
    const gone = !!(this.audio && this.audio.error && this.audio.error.code === 4);
    window.Shell.toast(`「${name}」播不了：${why}${gone ? ' · 点「重新扫描」会自动清掉这类曲子' : ''}`, 'err');
    this._failStreak += 1;
    // 一首坏就算了，整盘都是坏的（比如移动硬盘没插）别一直跳
    if (this._failStreak <= 5 && this.index >= 0 && this.index < this.queue.length - 1) {
      setTimeout(() => this.next(), 700);
    }
  },

  /** 切歌就重取歌词（记录上手工指定的 lrcPath 优先） */
  loadLyric(t) {
    this.lyric = null;
    this.lyricErr = '';
    this._lrcIdx = -1;
    if (!t) { this.updateLyrics(true); return; }
    /* 每日推荐里试听的临时文件**还没有 id**（没入库）→ 主进程按 id 查曲目记录会返回
       「曲目不存在」，那句话会显示到歌词页上误导用户。
       改成按**文件路径**找同名 .lrc —— 每日推荐下载时就把歌词一起下在了音频旁边。 */
    const ask = t.id
      ? API.raw.music.lrc(t.id)
      : API.raw.music.lrcFile(t.path, { title: t.title, artist: t.artist });
    ask.then((r) => {
      if (this.current() !== t) return;                 // 已经切歌了，结果丢掉
      this.lyric = r && r.found ? r : null;
      this.lyricErr = (r && r.reason) || '';
      this.updateLyrics(true);
      if (this.lyricOpen) this.renderLyricsLayer();
      this.renderPlayer();
    }).catch(() => { this.lyric = null; this.updateLyrics(true); });
  },

  play() {
    const t = this.current();
    if (!t) return;
    this._beginListen(t);                 // 先把上一首的听完时长交上去，再换源
    this.audio.src = window.util.toFileUrl(t.path);
    this.audio.play().catch((e) => {
      // 快速连点造成的 AbortError 是正常的，别吓用户
      if (e && e.name === 'AbortError') return;
      window.Shell.toast('播放失败：' + (e && e.message), 'err');
    });
    this.loadLyric(t);
    this.renderRail();
    this.renderMain();
    this.renderPlayer();
  },

  toggle() {
    const t = this.current();
    if (!t) { if (this.tracks[0]) this.playAt(0); return; }
    if (this.audio.paused) this.audio.play().catch(() => {});
    else this.audio.pause();
  },
  /* ==============================================================
   *  播放顺序（列表播放 / 列表循环 / 单曲循环 / 随机播放）
   *  规则全在 js/playmode.js 里（纯函数，单测覆盖），这里只负责
   *  「算出下标 → 改 index → play()」。返回 -1 就是不动。
   * ============================================================== */
  _pm() { return window.PlayMode || null; },

  /** 一首自然播完 */
  onTrackEnd() {
    // ⚠️ `ended` 之后 paused 会变 true 但 **pause 事件不触发**，这里必须自己落一次
    this._flushListen();
    const PM = this._pm();
    const i = PM
      ? PM.nextOnEnd(this.playMode, this.index, this.queue.length)
      : (this.index >= 0 && this.index < this.queue.length - 1 ? this.index + 1 : -1);
    if (i < 0) { this.renderPlayer(); return; }          // 顺序播放：最后一首播完就停在这
    if (i === this.index) {                              // 单曲循环：原地重来（不重画，省一次闪烁）
      try { this.audio.currentTime = 0; } catch { /* ignore */ }
      this.audio.play().catch(() => {});
      return;
    }
    this.index = i;
    this.play();
  },

  next() {
    const PM = this._pm();
    const i = PM
      ? PM.nextOnClick(this.playMode, this.index, this.queue.length)
      : (this.index < this.queue.length - 1 ? this.index + 1 : -1);
    if (i < 0) return;
    this.index = i;
    this.play();
  },

  prev() {
    const PM = this._pm();
    const i = PM
      ? PM.prevOnClick(this.playMode, this.index, this.queue.length)
      : (this.index > 0 ? this.index - 1 : -1);
    if (i < 0) return;
    this.index = i;
    this.play();
  },

  /** 换播放顺序：落设置 + 重画那条播放条 + 明确告诉用户现在是哪种 */
  setPlayMode(m) {
    const PM = this._pm();
    this.playMode = PM ? PM.normalize(m) : m;
    this.toggleModeMenu(false);
    if (window.State && typeof State.set === 'function') State.set({ playMode: this.playMode }).catch(() => {});
    this.renderPlayer();
    if (window.Shell) window.Shell.toast('播放顺序：' + (PM ? PM.label(this.playMode) : this.playMode));
  },

  /* ---------------- 两个浮层：播放顺序菜单 / 播放列表 ---------------- */
  /** 点浮层和开关按钮自己不算「点空白」，别一按就被收掉 */
  _outsideClick(e) {
    if (!this.plOpen && !this.modeOpen) return;
    const t = e.target;
    if (t && t.closest && t.closest('.pl-panel, .mode-menu, .pl-toggle, .mode-toggle')) return;
    if (this.plOpen) this.togglePlaylist(false);
    if (this.modeOpen) this.toggleModeMenu(false);
  },

  /** 把浮层摆到某个播放条按钮的正上方（按两边的 rect 差值算，别写死像素） */
  placeAbove(node, btn, align) {
    if (!node || !btn) return;
    // 🔴 基准要用浮层的 **offsetParent**（.music），不能用 #view ——
    //    两者平时框一样大，但一旦外面加了内边距，算出来的 left 就是错的
    const hr = (this.wrapEl || this.root).getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    node.style.bottom = Math.round(hr.bottom - br.top + 10) + 'px';
    if (align === 'center') {
      node.style.left = Math.round(br.left - hr.left + br.width / 2 - node.offsetWidth / 2) + 'px';
      node.style.right = 'auto';
    } else {
      node.style.right = Math.max(8, Math.round(hr.right - br.right - 8)) + 'px';
      node.style.left = 'auto';
    }
  },

  togglePlaylist(v) {
    this.plOpen = (typeof v === 'boolean') ? v : !this.plOpen;
    if (this.plOpen) {
      const btn = this.playerEl.querySelector('.pl-toggle');
      this.renderPlaylistPanel();
      this.plPanelEl.hidden = false;
      this.placeAbove(this.plPanelEl, btn, 'right');
      if (this.modeOpen) this.toggleModeMenu(false);
    } else {
      this.plPanelEl.hidden = true;
    }
    const btn = this.playerEl && this.playerEl.querySelector('.pl-toggle');
    if (btn) btn.classList.toggle('on', this.plOpen);
  },

  toggleModeMenu(v) {
    this.modeOpen = (typeof v === 'boolean') ? v : !this.modeOpen;
    if (this.modeOpen) {
      const btn = this.playerEl.querySelector('.mode-toggle');
      this.renderModeMenu();
      this.modeMenuEl.hidden = false;
      this.placeAbove(this.modeMenuEl, btn, 'center');
      if (this.plOpen) this.togglePlaylist(false);
    } else {
      this.modeMenuEl.hidden = true;
    }
    const btn = this.playerEl && this.playerEl.querySelector('.mode-toggle');
    if (btn) btn.classList.toggle('open', this.modeOpen);
  },

  renderModeMenu() {
    const PM = this._pm();
    const p = clear(this.modeMenuEl);
    p.appendChild(el('div', { class: 'mm-title', text: '播放顺序' }));
    for (const m of (PM ? PM.MODES : ['order'])) {
      const on = m === this.playMode;
      p.appendChild(el('div', {
        class: 'mm-item' + (on ? ' on' : ''),
        title: PM ? PM.desc(m) : '',
        onclick: (e) => { e.stopPropagation(); this.setPlayMode(m); }
      },
        uiSpan(PM ? PM.icon(m) : 'order', 'mm-ic'),
        el('div', { class: 'mm-txt' },
          el('span', { class: 'mm-name', text: PM ? PM.label(m) : m }),
          el('span', { class: 'mm-desc', text: PM ? PM.desc(m) : '' })),
        on ? el('span', { class: 'mm-tick', html: window.ICON.ui.check }) : null));
    }
  },

  /**
   * 播放列表 = **当前播放队列**（`this.queue`），不是某个歌单。
   * ⚠️ 只重画面板内容，**不重画播放条** —— 否则点一下歌，按钮会因为重画而失焦。
   */
  renderPlaylistPanel() {
    const p = clear(this.plPanelEl);
    const from = this.view === 'playlist' ? this.playlistById(this.currentPlaylistId) : null;
    p.appendChild(el('div', { class: 'pl-head' },
      el('span', { class: 'pl-title', text: '当前播放' }),
      el('span', { class: 'chip', text: this.queue.length + ' 首' }),
      el('div', { class: 'grow' }),
      from ? el('span', { class: 'pl-from ellipsis', title: from.name, text: '来自「' + from.name + '」' }) : null,
      el('button', {
        class: 'btn btn-sm btn-ghost', title: '清空播放列表（只是清掉这份队列，不动歌单里的歌）',
        onclick: (e) => {
          e.stopPropagation();
          this.queue = []; this.index = -1;
          if (this.audio) { this.audio.pause(); this.audio.removeAttribute('src'); }
          this.renderPlaylistPanel();
          window.Shell.toast('播放列表已清空');
        }
      }, uiSpan('trash'))
    ));

    if (!this.queue.length) {
      p.appendChild(el('div', { class: 'pl-empty' },
        el('p', { class: 'text-dim', text: '播放列表是空的。在本地音乐或歌单里点一首歌就会填进来。' })));
      return;
    }

    const box = el('div', { class: 'pl-list' });
    this.queue.forEach((t, i) => {
      const on = i === this.index;
      box.appendChild(el('div', {
        class: 'pl-row' + (on ? ' on' : ''),
        title: t.title,
        onclick: (e) => {
          e.stopPropagation();
          if (i === this.index) { this.toggle(); return; }   // 点正在播的那首 = 播放 / 暂停
          this.index = i; this.play();
          this.renderPlaylistPanel();                        // 只重画面板里的高亮
        }
      },
        el('span', { class: 'pl-no', text: on ? '♪' : String(i + 1) }),
        el('div', { class: 'pl-main' },
          el('span', { class: 'pl-name ellipsis', text: t.title || window.util.baseName(t.path) }),
          el('span', { class: 'pl-artist ellipsis', text: t.artist || '' })),
        el('span', { class: 'pl-dur', text: t.duration ? formatDuration(t.duration) : '' })
      ));
    });
    p.appendChild(box);
  },

  renderPlayer() {
    const p = clear(this.playerEl);
    const t = this.current();
    const playing = this.audio && !this.audio.paused;
    // ⚠️ 时间一律读音频元素当前值 —— 以前这里写死 '0:00'，暂停后进度条永远停在 0:00，
    // 看着就像「根本没在播」。
    const cur = this.audio ? this.audio.currentTime : 0;
    const dur = this.audio && Number.isFinite(this.audio.duration) ? this.audio.duration : 0;

    p.appendChild(el('div', {
      class: 'np np-click', title: '歌词（开着时再点一下就关）',
      onclick: () => (this.lyricOpen ? this.closeLyrics() : this.openLyrics())
    },
      el('div', { class: 'npc' }, t && t.cover ? el('img', { src: t.cover }) : uiSpan('musicNote')),
      el('div', { class: 'np-txt' },
        el('div', { class: 'gname ellipsis', text: t ? t.title : '未在播放' }),
        el('div', { class: 'gsub ellipsis', text: this.nowLyric() || (t ? t.artist : '选择一首歌开始') })
      )
    ));
    /* 播放条左起：播放顺序 · 上一首 · 播放/暂停 · 下一首 · 播放列表
       （顺序按钮在「上一首」左边、列表按钮在「下一首」右边 —— 跟常见播放器一致） */
    const PM = this._pm();
    const mode = PM ? PM.normalize(this.playMode) : 'order';
    p.appendChild(el('div', { class: 'ctrl' },
      el('button', {
        class: 'pbtn mode-toggle' + (mode !== 'order' ? ' on' : ''),
        title: (PM ? PM.label(mode) : mode) + '（点击选择播放顺序）',
        'aria-label': '播放顺序',
        onclick: (e) => { e.stopPropagation(); this.toggleModeMenu(); }
      }, uiSpan(PM ? PM.icon(mode) : 'order', '')),
      el('button', { class: 'pbtn', title: '上一首', onclick: () => this.prev() }, uiSpan('prev', '')),
      el('button', { class: 'pbtn play', title: playing ? '暂停' : '播放', onclick: () => this.toggle() }, uiSpan(playing ? 'pause' : 'play', '')),
      el('button', { class: 'pbtn', title: '下一首', onclick: () => this.next() }, uiSpan('next', '')),
      el('button', {
        class: 'pbtn pl-toggle' + (this.plOpen ? ' on' : ''),
        title: '播放列表（' + this.queue.length + ' 首）',
        'aria-label': '播放列表',
        onclick: (e) => { e.stopPropagation(); this.togglePlaylist(); }
      }, uiSpan('list', ''))
    ));
    this.seekFill = el('i', { style: { width: (dur ? cur / dur * 100 : 0) + '%' } });
    p.appendChild(el('div', { class: 'seek' },
      el('span', { class: 't', id: 'pCur', text: formatDuration(cur) }),
      el('div', { class: 'bar grow', style: { flex: 1, cursor: 'pointer' }, onclick: (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        if (this.audio && Number.isFinite(this.audio.duration)) {
          this.audio.currentTime = ((e.clientX - r.left) / r.width) * this.audio.duration;
          this.updateSeek();
        }
      } }, this.seekFill),
      el('span', { class: 't', id: 'pDur', text: formatDuration(dur) })
    ));
    p.appendChild(el('div', { class: 'seek', style: { flex: '0 0 auto', gap: '4px' } },
      el('button', {
        class: 'pbtn sm locate', title: '在列表里定位这首（滚动到可见并高亮）',
        onclick: () => this.locateCurrent()
      }, '定位'),
      el('button', {
        id: 'pLyricBtn',
        class: 'pbtn sm' + (this.lyricOpen || this.lyric ? ' on' : ''),
        title: '歌词（LRC 对齐）',
        /* 🔴 这是**开关**不是入口：第一次按打开歌词页，再按一次收回去
           （以前写死 openLyrics()，开着时再按只会把歌词层重画一遍，永远关不上）。 */
        onclick: () => (this.lyricOpen ? this.closeLyrics() : this.openLyrics())
      }, '词'),
      uiSpan('heart'),
      el('input', {
        /* ⚠️ 这个 id 是给 setVolume() 就地回写用的（拖的时候不重画播放条） */
        id: 'pVolume',
        type: 'range', min: 0, max: 1, step: 0.01,
        /* 🔴 值取 this.volume（**从设置读回来的那个**），不是 this.audio.volume 也不是写死的 0.8。
           以前这里是 `this.audio ? this.audio.volume : 0.8`，而 audio.volume 本身也是兜底的 0.8 →
           滑块永远画在 80%，用户每次打开看到的都是「固定到很高」。 */
        value: String(normVolume(this.volume)),
        title: '音量 ' + volumeText(this.volume) + '（自动记住）',
        style: { width: '110px' },
        oninput: (e) => this.setVolume(e.target.value, true),
        /* 松手再补一次（防抖那条万一被切歌重画打断，这里兜住） */
        onchange: (e) => this.setVolume(e.target.value, true)
      })
    ));
    /* 播放条画完 = 曲目 / 播放状态 / 歌词文案都定了 —— 顺手把常驻的迷你播放卡片
       同步一遍（它在别的模块里活着，不走这条渲染路径）。 */
    if (window.MiniPlayer) window.MiniPlayer.sync();
    // 面板开着时切歌 → 里面那行高亮也得跟着走（面板不重画，只重画它自己）
    if (this.plOpen) this.renderPlaylistPanel();
  },
  updateSeek() {
    const cur = document.getElementById('pCur');
    const dur = document.getElementById('pDur');
    if (cur) cur.textContent = formatDuration(this.audio.currentTime);
    if (dur) dur.textContent = formatDuration(Number.isFinite(this.audio.duration) ? this.audio.duration : 0);
    if (this.seekFill && Number.isFinite(this.audio.duration) && this.audio.duration) {
      this.seekFill.style.width = (this.audio.currentTime / this.audio.duration * 100) + '%';
    }
    // 常驻迷你卡片上的那条细进度线跟着走（它不在本模块里，得单独通知）
    if (window.MiniPlayer) window.MiniPlayer.seek();
  },

  /* ==============================================================
   *  正在听 → 定位
   *  播着哪首就把它滚到可见处并闪一下。歌单里找不到就退到本地音乐页。
   * ============================================================== */
  async locateCurrent() {
    const t = this.current();
    if (!t) return window.Shell.toast('现在没有在播放任何歌', 'err');

    // ① 当前就在这首歌所属的歌单页 → 直接滚
    if (this.view === 'playlist') {
      const cur = this.playlistById(this.currentPlaylistId);
      if (cur && (cur.tracks || []).includes(t.id)) return this.scrollToTrack(t.id);
    }
    // ①.5 本地音乐页正搜着东西时，「正在播放」那首多半被过滤掉了 → 先清空搜索再滚
    if (this.view === 'local' && (this.localQuery || '').trim()) {
      this.localQuery = '';
      const inp = document.getElementById('mLocalSearch');
      if (inp) inp.value = '';
      this.paintLocal();
    }
    // ①.8 正在播的是「每日推荐」里试听的临时文件 → 回每日推荐页（那行会自动高亮）
    const ddir = ((this.dailyStatus || {}).config || {}).dir || '';
    if (ddir && t.path && String(t.path).toLowerCase().startsWith(String(ddir).toLowerCase())) {
      if (this.view !== 'daily') { this.view = 'daily'; this.renderRail(); this.renderMain(); }
      return;
    }
    // ② 它在某个歌单里 → 打开那个歌单
    const home = this.playlists.find((p) => (p.tracks || []).includes(t.id));
    if (home) {
      this.openPlaylist(home.id);
    } else if (this.view !== 'local') {
      // ③ 只在本地库里 → 回本地音乐页
      this.view = 'local';
      this.renderRail();
      this.renderMain();
    }
    // 等一帧，列表画出来再滚
    setTimeout(() => this.scrollToTrack(t.id), 80);
  },

  scrollToTrack(id) {
    // ⚠️ 用属性选择器找行：trackRow 把 trackId 挂在 dataset.tid 上
    const n = this.root.querySelector(`.track[data-tid="${id}"]`);
    if (!n) return window.Shell.toast('这首不在当前列表里（可能在别的歌单）', 'err');
    n.scrollIntoView({ block: 'center', behavior: 'smooth' });
    n.classList.remove('flash');
    void n.offsetWidth;                    // 强制回流，动画才能重放
    n.classList.add('flash');
    setTimeout(() => { try { n.classList.remove('flash'); } catch { /* ignore */ } }, 1600);
  },

  /* ==============================================================
   *  歌词（LRC 对齐）
   *  对齐分两头：① 找对文件（同名 / 标题 / 标题+歌手 / 手工指定）
   *              ② 时间轴对得上（±0.5s 微调，落库到 track.lrcOffset）
   * ============================================================== */
  lyricIndexAt(t) {
    const lines = (this.lyric && this.lyric.lines) || [];
    if (!lines.length) return -1;
    const shift = ((this.lyric && this.lyric.shift) || 0) / 1000;
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].t + shift <= t + 0.0001) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  },
  /** 当前该显示的那一句（底部播放条用） */
  nowLyric() {
    const lines = (this.lyric && this.lyric.lines) || [];
    if (!lines.length) return '';
    const i = this.lyricIndexAt(this.audio ? this.audio.currentTime : 0);
    return i >= 0 && lines[i] ? (lines[i].text || '') : '';
  },
  offsetText() {
    const ms = this.lyric ? (this.lyric.shift || 0) : (this.current() && this.current().lrcOffset) || 0;
    return (ms > 0 ? '+' : '') + (ms / 1000).toFixed(1) + 's';
  },

  openLyrics() {
    if (!this.current()) return window.Shell.toast('先放一首歌，再看歌词', 'err');
    this.lyricOpen = true;
    /* 🔴 歌词页要铺满**整屏**（连播放条那块也归它），播放条则压成底部一条浮动半透明条
       （鼠标凑上去才变实）。所以：① 层挂到 `.music` 而不是 `#view`，inset:0 才是整块音乐区；
       ② 给 `.music` 挂 `lyric-on`，播放条靠它切成浮动样式。 */
    if (this.wrapEl) this.wrapEl.classList.add('lyric-on');
    if (this.plOpen) this.togglePlaylist(false);       // 面板会被压在播放条下面，先收掉
    this.renderLyricsLayer();
    /* 打开不重画播放条，就地给「词」按钮补上点亮态（再按一次就关） */
    const b = document.getElementById('pLyricBtn');
    if (b) b.classList.add('on');
  },
  closeLyrics() {
    this.lyricOpen = false;
    const n = document.getElementById('mLyricLayer');
    if (n) n.remove();
    if (this.wrapEl) this.wrapEl.classList.remove('lyric-on');
    this._lrcIdx = -99;
    /* 播放条没重画，「词」按钮的点亮态要就地退回去：这首歌有 LRC 就保留微亮，没有就全灭 */
    const b = document.getElementById('pLyricBtn');
    if (b) b.classList.toggle('on', !!this.lyric);
  },

  renderLyricsLayer() {
    if (!this.lyricOpen) return;
    const old = document.getElementById('mLyricLayer');
    if (old) old.remove();
    const t = this.current();
    if (!t) return;

    const lines = (this.lyric && this.lyric.lines) || [];
    const list = el('div', { class: 'll-list' });
    this.lrcLineEls = [];
    this._lrcIdx = -99;
    for (const l of lines) {
      const n = el('div', { class: 'll-line', onclick: () => this.seekToLine(l) }, l.text || '♪');
      list.appendChild(n);
      this.lrcLineEls.push(n);
    }

    const layer = el('div', { class: 'lyric-layer', id: 'mLyricLayer' },
      el('div', { class: 'll-bg', style: t.cover ? { backgroundImage: `url("${t.cover}")` } : {} }),
      el('div', { class: 'll-head' },
        el('div', { class: 'll-song' },
          el('h2', { class: 'ellipsis', text: t.title }),
          el('p', { class: 'ellipsis', text: t.artist + (this.lyric && this.lyric.path ? ' · ' + window.util.baseName(this.lyric.path) : '') })
        ),
        el('button', { class: 'll-x', title: '关闭歌词（Esc）', onclick: () => this.closeLyrics() }, '✕')
      ),
      el('div', { class: 'll-body' },
        /* 左边立一张封面（第四十五轮，用户「框起来的地方放封面，歌词往旁边挪一点」）：
           封面占住左侧固定宽度，歌词那块自然右移；没有封面就摆一个音符占位块，
           别让版面塌成「歌词贴屏幕左边」。 */
        el('div', { class: 'll-side' },
          t.cover
            ? el('img', { class: 'll-cover', src: t.cover, alt: '', draggable: 'false' })
            : el('div', { class: 'll-cover ll-cover-none' }, uiSpan('musicNote'))
        ),
        lines.length ? list : el('div', { class: 'll-none' },
          el('div', { class: 'll-none-ic' }, uiSpan('musicNote')),
          el('h3', { text: '这首歌还没对齐歌词' }),
          el('p', { text: this.lyricErr || '没有找到同名的 .lrc 歌词文件。' }),
          el('p', { class: 'hint', text: '两种对齐办法：① 把歌词文件放到歌曲旁边并改成同名；② 直接点下面手动指定。' }),
          el('div', { class: 'll-none-btns' },
            el('button', { class: 'btn btn-primary', onclick: () => this.pickLrcFile() }, uiSpan('folder'), '选择歌词文件'),
            el('button', { class: 'btn', onclick: () => this.rematchLrc() }, uiSpan('refresh'), '重新自动匹配')
          ))
      ),
      el('div', { class: 'll-foot' },
        el('span', { class: 'll-ok', text: lines.length ? `${lines.length} 行歌词` : '未匹配歌词' }),
        el('span', { class: 'll-sp' }),
        el('button', { class: 'btn btn-sm', onclick: () => this.pickLrcFile() }, uiSpan('folder'), '选择歌词文件'),
        el('button', { class: 'btn btn-sm', onclick: () => this.shiftLrc(-500) }, '提前 0.5s'),
        el('span', { class: 'll-off', id: 'mLlOff', text: this.offsetText() }),
        el('button', { class: 'btn btn-sm', onclick: () => this.shiftLrc(500) }, '延后 0.5s'),
        el('button', { class: 'btn btn-sm', onclick: () => this.resetLrc() }, '重置偏移')
      )
    );
    /* ⚠️ 挂 `.music`（wrapEl）不挂 `#view`：只有挂在音乐根节点上，inset:0 才等于
       「rail + 主区 + 播放条」这一整块，播放条才会被压在它下面。 */
    (this.wrapEl || this.root).appendChild(layer);
    this.updateLyrics(true);
  },

  /** 点歌词行 → 跳到那一句 */
  seekToLine(l) {
    if (!this.audio) return;
    const shift = ((this.lyric && this.lyric.shift) || 0) / 1000;
    this.audio.currentTime = Math.max(0, l.t + shift);
    this._lrcIdx = -99;
    this.updateLyrics(true);
  },

  /** 高亮 / 滚动。节流靠 _lrcIdx：同一句不重复碰 DOM */
  updateLyrics(force) {
    const lines = (this.lyric && this.lyric.lines) || [];
    const idx = lines.length ? this.lyricIndexAt(this.audio ? this.audio.currentTime : 0) : -1;

    // ① 底部播放条上的当前句
    const sub = document.querySelector('.player .np-txt .gsub');
    if (sub) {
      const txt = idx >= 0 && lines[idx] ? (lines[idx].text || '') : '';
      if (txt && sub.textContent !== txt) sub.textContent = txt;
    }

    // ② 歌词页
    if (!this.lyricOpen || !lines.length) return;
    if (!force && idx === this._lrcIdx) return;
    this._lrcIdx = idx;
    const els = this.lrcLineEls || [];
    els.forEach((e, i) => e.classList.toggle('on', i === idx));
    const cur = els[idx];
    const body = document.querySelector('#mLyricLayer .ll-body');
    const list = document.querySelector('#mLyricLayer .ll-list');
    if (cur && body && list) {
      const off = cur.offsetTop + cur.offsetHeight / 2 - body.clientHeight / 2;
      list.style.transform = `translateY(${-Math.max(0, off)}px)`;
    }
  },

  async shiftLrc(delta) {
    const t = this.current();
    if (!t) return;
    const next = Math.max(-60000, Math.min(60000, (Number(t.lrcOffset) || 0) + delta));
    const r = await API.raw.music.setLrc(t.id, { offset: next }).catch((e) => { window.Shell.toast(e.message, 'err'); return null; });
    if (!r) return;
    t.lrcOffset = next;
    const g = this.tracks.find((x) => x.id === t.id);
    if (g) g.lrcOffset = next;
    if (this.lyric) this.lyric.shift = (this.lyric.fileOffset || 0) + next;
    const lab = document.getElementById('mLlOff');
    if (lab) lab.textContent = this.offsetText();
    this._lrcIdx = -99;
    this.updateLyrics(true);
  },

  async resetLrc() {
    const t = this.current();
    if (!t) return;
    await API.raw.music.setLrc(t.id, { offset: 0 }).catch(() => {});
    t.lrcOffset = 0;
    if (this.lyric) this.lyric.shift = this.lyric.fileOffset || 0;
    const lab = document.getElementById('mLlOff');
    if (lab) lab.textContent = this.offsetText();
    this._lrcIdx = -99;
    this.updateLyrics(true);
  },

  async pickLrcFile() {
    const t = this.current();
    if (!t) return;
    const f = await API.raw.music.pickLrc().catch(() => '');
    if (!f) return;
    const r = await API.raw.music.setLrc(t.id, { lrcPath: f }).catch((e) => { window.Shell.toast(e.message, 'err'); return null; });
    if (!r) return;
    window.Shell.toast('歌词已对齐到 ' + window.util.baseName(f), 'ok');
    this.lrcMap[t.id] = f;
    await this.reload();
    this.loadLyric(t);
  },

  /** 清掉手工指定的歌词，让系统按文件名重新匹配一次 */
  async rematchLrc() {
    const t = this.current();
    if (!t) return;
    await API.raw.music.setLrc(t.id, { clear: true }).catch(() => {});
    delete this.lrcMap[t.id];
    await this.reload();
    this.loadLyric(t);
    window.Shell.toast('已重新匹配', 'ok');
  },

  /* ---------------- 动作 ---------------- */
  /** 起一次扫描：先切到本地页把进度条画出来，再发 IPC */
  /** 扫描结果一句话说清：新增 / 清理 / 没敢删的（第四十一轮） */
  scanSummary(res) {
    const r = res || {};
    const parts = [];
    if (r.added) parts.push(`新增 ${r.added} 首`);
    if (r.pruned) parts.push(`清理 ${r.pruned} 首找不到文件的`);
    /* 第五十一轮：顺手补回的封面也要说出来，否则用户不知道「封面怎么自己好了」 */
    if (r.covers) parts.push(`补回 ${r.covers} 张封面`);
    if (!r.added && !r.pruned && !r.covers) parts.push(r.total ? '没有变化' : '没找到音频文件');
    let s = parts.join('，');
    /* ⚠️ 这句必须说出来：外接盘没插 / NAS 掉线时**故意不删**，
       不解释的话用户会以为「自动清理没生效」。 */
    if (r.pending) s += `；另有 ${r.pending} 首所在目录是空的或掉线了，为安全没删`;
    return s;
  },

  async runScan(tip) {
    this.view = 'local';
    this.scanning = { done: 0, total: 0, name: '' };
    this.renderRail();
    this.renderMain();
    const res = await API.raw.music.scan().catch((e) => { window.Shell.toast(e.message, 'err'); return null; });
    this.scanning = null;
    if (res) window.Shell.toast(tip ? tip(res) : this.scanSummary(res), 'ok');
    this.reload();
  },
  async importFolder() {
    const dirs = await API.raw.dialog.pickFolders();
    if (!dirs || !dirs.length) return;
    const roots = await API.raw.music.roots().catch(() => []);
    await API.raw.music.setRoots([...roots, ...dirs]);
    await this.runScan((r) => (r.added ? `已导入 ${r.added} 首` : '没有发现新的音频文件'));
  },
  async scan() {
    await this.runScan();
  },

  /* ==============================================================
   *  歌单：详情 / 新建 / 改名 / 换封面 / 加歌 / 删歌单
   * ============================================================== */
  /* ==============================================================
   *  歌单曲目拖动排序（第三十轮）
   * --------------------------------------------------------------
   *  交互：**长按 180ms** 才进入拖动 —— 直接按住就拖的话，「点一下播放」
   *  会被误判成拖拽（手指/鼠标稍微一晃）。
   *
   *  为什么不用 HTML5 的 draggable/dragstart：
   *    · Chromium 拖起来会自带一张半透明的「拖动截图」，跟这里的设计不搭
   *    · dragover 拿不到精确的插入位置，判断落点还得自己算，等于白用
   *  所以走 pointer 事件 + setPointerCapture（指针移出列表也能收到事件）。
   *
   *  ⚠️ 监听器一律挂在 `list` 上，不挂 document —— renderPlaylist 每次重画都会
   *     新建一个 list，挂 list 上就随旧节点一起消失；挂 document 会每重画一次
   *     就多叠一层（和 mount 里那个老坑同源）。
   * ============================================================== */
  enableDragSort(list, ids, onCommit) {
    const rows = [...list.children].filter((n) => n.classList && n.classList.contains('track'));
    if (rows.length < 2) return;

    let holdTimer = null;
    let autoTimer = null;
    let down = null;              // { y, row, i, pid }
    let drag = null;              // { from, row, startY, idx, moved, lastCalc }
    const line = el('div', { class: 'drag-line', hidden: true });

    /** 把插入线摆到第 idx 行之前（idx === rows.length 就是摆到最后） */
    const placeLine = (idx) => {
      list.insertBefore(line, rows[idx] || null);
      line.hidden = false;
    };

    /**
     * 指针落在第几个「缝」里。
     * ⚠️ 故意**跳过被拖的那一行**：它被 transform 平移走了，rect 会跟着指针跑，
     *    不跳过的话判定会来回翻（线在两手之间疯狂抖）。
     */
    const gapAt = (clientY) => {
      let last = -1;
      for (let i = 0; i < rows.length; i++) {
        if (drag && i === drag.from) continue;
        const b = rows[i].getBoundingClientRect();
        if (clientY > b.top + b.height / 2) last = i;
      }
      return last + 1;
    };

    /** 拖到列表上下边缘时自动滚（拖到几百首的歌单末尾不用先松手再滚） */
    const autoScroll = (clientY) => {
      const sc = list.closest('.music-main') || list.parentElement;
      if (!sc || sc.scrollHeight <= sc.clientHeight) return;
      const b = sc.getBoundingClientRect();
      if (clientY < b.top + 64) sc.scrollTop -= 14;
      else if (clientY > b.bottom - 64) sc.scrollTop += 14;
    };

    const stopDrag = () => {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
      down = null;
      if (drag) {
        drag.row.style.transform = '';
        drag.row.classList.remove('dragging');
        list.classList.remove('dragging');
        document.body.style.cursor = '';
      }
      line.hidden = true;
      if (line.parentNode) line.parentNode.removeChild(line);
      const d = drag;
      drag = null;
      return d;
    };

    const onDown = (e) => {
      if (e.button !== 0 || drag) return;
      const row = e.target && e.target.closest ? e.target.closest('.track') : null;
      if (!row || !list.contains(row)) return;
      if (e.target.closest('button')) return;          // 行内的删除按钮不算拖拽
      const i = rows.indexOf(row);
      if (i < 0) return;
      down = { y: e.clientY, row, i, pid: e.pointerId };
      holdTimer = setTimeout(() => {
        holdTimer = null;
        drag = { from: i, row, startY: e.clientY, idx: i, moved: false, lastCalc: 0 };
        row.classList.add('dragging');
        list.classList.add('dragging');
        document.body.style.cursor = 'grabbing';
        placeLine(i);
        try { row.setPointerCapture(e.pointerId); } catch { /* 某些环境下不支持，不影响拖动 */ }
        autoTimer = setInterval(() => { if (drag && drag.lastY != null) autoScroll(drag.lastY); }, 70);
      }, 180);
    };

    const onMove = (e) => {
      if (!drag) {
        // 还没长按成功就先移开了 → 用户是在滚动 / 划，取消
        if (holdTimer && down && Math.abs(e.clientY - down.y) > 8) { clearTimeout(holdTimer); holdTimer = null; }
        return;
      }
      e.preventDefault();
      drag.lastY = e.clientY;
      const dy = e.clientY - drag.startY;
      if (Math.abs(dy) > 6) drag.moved = true;
      drag.row.style.transform = `translateY(${dy}px)`;
      const now = Date.now();
      if (now - drag.lastCalc >= 45) {                 // 节流：每帧都算 rect 会拖慢大歌单
        drag.lastCalc = now;
        const idx = gapAt(e.clientY);
        if (idx !== drag.idx) { drag.idx = idx; placeLine(idx); }
      }
    };

    const onUp = () => {
      const d = stopDrag();
      if (!d) return;
      if (!d.moved) return;                            // 长按了一下但没动 → 当普通点击（照常播放）
      /* 拖动结束会跟一个 click，不拦掉的话松手就跳到那首歌去 */
      this._suppressClick = Date.now();
      const next = ids.slice();
      const [moved] = next.splice(d.from, 1);
      const at = d.idx > d.from ? d.idx - 1 : d.idx;
      next.splice(at, 0, moved);
      if (next.join('\u0000') === ids.join('\u0000')) return;   // 顺序没变（拖回原位）
      onCommit(next);
    };

    list.addEventListener('pointerdown', onDown);
    list.addEventListener('pointermove', onMove);
    list.addEventListener('pointerup', onUp);
    list.addEventListener('pointercancel', onUp);
    list.addEventListener('click', (e) => {
      if (this._suppressClick && Date.now() - this._suppressClick < 400) {
        e.stopPropagation();
        e.preventDefault();
        this._suppressClick = 0;
      }
    }, true);
  },

  /** 拖动排序落库。⚠️ 本地缺失（灰显）的那些 id 要原样接回去，别拖一下就丢歌 */
  async saveTracksOrder(pl, ids) {
    const tail = (pl.tracks || []).filter((id) => !ids.includes(id));
    try {
      await API.raw.music.updatePlaylist(pl.id, { tracks: ids.concat(tail) });
      window.Shell.toast('已调整歌单顺序');
      await this.reload();
    } catch (e) {
      window.Shell.toast('顺序没保存上：' + ((e && e.message) || ''), 'err');
    }
  },

  renderPlaylist(main) {
    const pl = this.playlistById(this.currentPlaylistId);
    if (!pl) {
      main.appendChild(el('div', { class: 'empty' }, el('h3', { text: '歌单不存在' }),
        el('p', { text: '它可能已经被删除了。' })));
      return;
    }
    const songs = this.tracksOf(pl);
    const miss = pl.missing || [];
    const online = pl.origin && pl.origin.kind === 'online' ? pl.origin : null;
    const coverSrc = pl.cover || (songs[0] && songs[0].cover) || '';

    main.appendChild(el('div', { class: 'pl-head' },
      el('div', { class: 'pl-cover', onclick: () => this.changeCover(pl) },
        coverSrc ? el('img', { src: coverSrc }) : uiSpan('list'),
        el('span', { class: 'pl-cover-tip', text: '更换封面' })
      ),
      el('div', { class: 'pl-meta' },
        el('div', { class: 'pl-name-row' },
          el('h2', { class: 'ellipsis', text: pl.name }),
          online ? el('span', { class: 'chip accent', title: online.link || '' }, '来自 ' + (online.platformName || online.platform)) : null,
          miss.length ? el('span', { class: 'chip warn', text: `缺 ${miss.length} 首` }) : null,
          el('button', { class: 'btn btn-sm', onclick: () => this.renamePlaylist(pl) }, uiSpan('edit'), '重命名')
        ),
        el('p', { class: 'text-dim', text: `${songs.length} 首已匹配${miss.length ? ' · ' + miss.length + ' 首本地没有' : ''} · 创建于 ${new Date(pl.createdAt || Date.now()).toLocaleDateString('zh-CN')}` }),
        el('div', { class: 'pl-actions' },
          el('button', { class: 'btn btn-primary', onclick: () => { if (songs.length) this.playQueue(songs, 0); } }, uiSpan('play'), '播放全部'),
          el('button', { class: 'btn', onclick: () => this.addSongs(pl) }, uiSpan('plus'), '添加歌曲'),
          el('button', { class: 'btn', onclick: () => this.changeCover(pl) }, uiSpan('image'), '更换封面'),
          el('button', { class: 'btn', onclick: () => this.exportPlaylist(pl) }, uiSpan('download'), '导出歌单'),
          online ? el('button', { class: 'btn', title: '按原链接再抓一次，把新下载好的歌对上', onclick: () => this.resyncOnline(pl) }, uiSpan('refresh'), '重新匹配') : null,
          el('button', { class: 'btn btn-danger', onclick: () => this.deletePlaylist(pl) }, uiSpan('trash'), '删除歌单')
        )
      )
    ));

    if (!songs.length && !miss.length) {
      main.appendChild(el('div', { class: 'empty' }, el('h3', { text: '这个歌单还没有歌' }),
        el('p', { text: '可以从本地音乐里挑几首，也可以直接导入一个歌单文件（.m3u / .m3u8 / .pls / .txt）。' }),
        el('div', { class: 'row', style: { justifyContent: 'center' } },
          el('button', { class: 'btn btn-primary', onclick: () => this.addSongs(pl) }, uiSpan('plus'), '添加歌曲'),
          el('button', { class: 'btn', onclick: () => this.importPlaylistDialog() }, uiSpan('download'), '导入歌单'))));
      return;
    }
    main.appendChild(el('div', { class: 'rail-title' },
      el('h3', { text: `已匹配 · ${songs.length} 首` }),
      el('span', { class: 'hint', text: songs.length > 1 ? '长按行可拖动排序' : '' }),
      el('span', { class: 'more', onclick: () => this.locateCurrent() }, '◎ 定位正在播放')));

    const list = el('div', { class: 'track-list' });
    songs.forEach((t, i) => {
      list.appendChild(this.trackRow(t, i + 1, () => this.playQueue(songs, i), [
        el('button', { class: 'btn btn-sm btn-ghost', title: '从这个歌单里移除',
          onclick: (e) => { e.stopPropagation(); this.removeFromPlaylist(pl, t.id); } }, uiSpan('trash'))
      ]));
    });
    // 长按拖动排序（缺失曲目在下面单独一块，不参与）
    this.enableDragSort(list, songs.map((t) => t.id), (ids) => this.saveTracksOrder(pl, ids));
    if (!songs.length) {
      list.appendChild(el('div', { class: 'empty', style: { minHeight: '120px' } },
        el('p', { text: '本地曲库里还没有这个歌单的任何一首 —— 下面那些灰的就是缺的，可以一键下载补全。' })));
    }
    main.appendChild(list);
    this.appendMissingBlock(main, pl, miss);
  },

  /* ==============================================================
   *  缺失曲目（外部歌单里本地没有的）→ 灰显 + 提示下载
   * ============================================================== */
  appendMissingBlock(main, pl, miss) {
    if (!miss || !miss.length) return null;
    const ready = !!(this.srcCfg && this.srcCfg.configured);
    const head = el('div', { class: 'rail-title' },
      el('h3', { text: `本地没有 · ${miss.length} 首` }),
      ready
        ? el('span', { class: 'more', onclick: () => this.fillAll(pl) }, uiSpan('download'), '一键补全')
        : el('span', { class: 'more warn', onclick: () => this.openSourceConfig() }, '⚠ 先配置下载源')
    );
    main.appendChild(head);
    if (!ready) {
      main.appendChild(el('div', { class: 'src-tip' },
        el('span', {}, '还没有配置音乐下载源，所以这些歌只能手动找。'),
        el('button', { class: 'btn btn-sm', onclick: () => this.openSourceConfig() }, uiSpan('settings'), '去配置')));
    }
    const list = el('div', { class: 'track-list' });
    miss.forEach((it, i) => list.appendChild(this.missingRow(pl, it, i + 1)));
    main.appendChild(list);
    return list;
  },

  /** 灰显的缺失行：整行压暗 + 右侧「下载该歌曲」 */
  missingRow(pl, it, no) {
    return el('div', { class: 'track missing', title: '本地曲库里没有这首，可以下载补全' },
      el('span', { class: 'no', text: String(no) }),
      el('div', { class: 'tt' },
        el('div', { class: 'n', text: it.title }),
        el('div', { class: 'a' },
          (it.artist || '未知歌手') + (it.album ? ' · ' + it.album : ''),
          el('span', { class: 'tag-miss', text: '本地没有' })
        )
      ),
      el('span', { class: 'dur', text: formatDuration(it.duration) }),
      it.quality ? el('span', { class: 'tag-q', text: it.quality }) : null,
      el('button', {
        class: 'btn btn-sm', onclick: (e) => { e.stopPropagation(); this.fillOne(pl, it); }
      }, uiSpan('download'), '下载该歌曲')
    );
  },

  /** 单首补全 */
  async fillOne(pl, it) {
    if (!this.srcCfg || !this.srcCfg.configured) return this.openSourceConfig();
    window.Shell.toast(`正在搜索「${it.title}」…`);
    const r = await API.raw.music.fillMissing([it], { playlistId: pl.id })
      .catch((e) => { window.Shell.toast(e.message || String(e), 'err'); return null; });
    if (!r) return;
    if (!r.queued.length) {
      return window.Shell.toast(`没搜到「${it.title}」${r.failed[0] && r.failed[0].reason ? '：' + r.failed[0].reason : ''}`, 'err');
    }
    const q = r.queued[0];
    window.Shell.toast(`已加入下载队列：${q.name}${q.levelLabel ? ' · ' + q.levelLabel : ''}，下完自动进这个歌单`, 'ok');
  },

  /** 整批补全。⚠️ 这里是歌单详情页直接调 confirm，不嵌套在别的弹窗里，安全 */
  async fillAll(pl) {
    const miss = pl.missing || [];
    if (!miss.length) return;
    if (!this.srcCfg || !this.srcCfg.configured) return this.openSourceConfig();
    const yes = await window.Shell.confirm({
      title: '一键补全',
      message: `去下载源里找这 ${miss.length} 首歌，按最高音质下载？`,
      detail: '下载走「网盘」模块的队列；下完会自动入库并补进这个歌单。已配置音源：'
        + ((this.srcCfg.sites && this.srcCfg.sites.length) ? this.srcCfg.sites.join('、') : (this.srcCfg.site || '')),
      okText: '开始补全',
      cancelText: '取消'
    });
    if (!yes) return;
    window.Shell.toast(`正在补全 ${miss.length} 首…`);
    const r = await API.raw.music.fillMissing(miss, { playlistId: pl.id })
      .catch((e) => { window.Shell.toast(e.message || String(e), 'err'); return null; });
    if (!r) return;
    window.Shell.toast(
      `已入队 ${r.queued.length} 首` +
      (r.failed.length ? `，${r.failed.length} 首没搜到` : ''), r.failed.length ? 'err' : 'ok');
  },

  /** 按原链接重新抓一次，把新下载好的歌对上 */
  async resyncOnline(pl) {
    window.Shell.toast('正在重新匹配…');
    const r = await API.raw.music.resyncOnlinePlaylist(pl.id)
      .catch((e) => { window.Shell.toast(e.message || String(e), 'err'); return null; });
    if (!r) return;
    window.Shell.toast(`重新匹配完成：${r.matched} 首已匹配，${r.missing} 首还是缺`, r.missing ? 'err' : 'ok');
    this.reload();
  },

  /** 跳到「下载与订阅」页并聚焦下载源卡片 */
  openSourceConfig() {
    this.view = 'downloads';
    this.renderRail();
    this.renderMain();
    setTimeout(() => {
      const n = document.getElementById('mSrcCard');
      if (n) {
        n.scrollIntoView({ block: 'start', behavior: 'smooth' });
        n.classList.add('flash');
        setTimeout(() => { try { n.classList.remove('flash'); } catch { /* ignore */ } }, 1600);
      }
      const s = document.getElementById('srcSite');
      if (s) { try { s.focus(); } catch { /* ignore */ } }
    }, 80);
  },

  /** 可勾选的曲目选择器（新建歌单 / 添加歌曲共用） */
  buildPicker(selectedIds, excludeIds) {
    const picked = new Set(selectedIds || []);
    const skip = new Set(excludeIds || []);
    const listBox = el('div', { class: 'picker-list' });
    const counter = el('span', { class: 'pk-count' });
    const search = el('input', { class: 'inp grow', placeholder: '搜索歌曲 / 歌手 / 专辑' });

    const paint = () => {
      clear(listBox);
      const k = String(search.value || '').trim().toLowerCase();
      const src = this.tracks.filter((t) => !skip.has(t.id));
      const hits = k ? src.filter((t) => String(t.title + ' ' + t.artist + ' ' + t.album).toLowerCase().includes(k)) : src;
      counter.textContent = `已选 ${picked.size} 首`;
      if (!hits.length) {
        listBox.appendChild(el('div', { class: 'empty', style: { minHeight: '110px' } },
          el('p', { text: k ? '没有匹配的歌曲' : '本地曲库还是空的，先去「本地音乐」导入几首。' })));
        return;
      }
      for (const t of hits) {
        const row = el('div', { class: 'pk-row' + (picked.has(t.id) ? ' on' : ''), onclick: () => {
          if (picked.has(t.id)) picked.delete(t.id); else picked.add(t.id);
          row.classList.toggle('on');
          const box = row.querySelector('.pk-box');
          if (box) box.textContent = picked.has(t.id) ? '✓' : '';
          counter.textContent = `已选 ${picked.size} 首`;
        } },
          el('span', { class: 'pk-box', text: picked.has(t.id) ? '✓' : '' }),
          el('div', { class: 'tt' },
            el('div', { class: 'n ellipsis', text: t.title }),
            el('div', { class: 'a ellipsis', text: t.artist + ' · ' + t.album })
          ),
          el('span', { class: 'dur', text: formatDuration(t.duration) })
        );
        listBox.appendChild(row);
      }
    };
    search.oninput = paint;
    paint();

    const node = el('div', { class: 'picker' },
      el('div', { class: 'picker-head' },
        search,
        el('button', { class: 'btn btn-sm', onclick: () => {
          for (const t of this.tracks) if (!skip.has(t.id)) picked.add(t.id);
          paint();
        } }, '全选'),
        el('button', { class: 'btn btn-sm', onclick: () => { picked.clear(); paint(); } }, '清空'),
        counter
      ),
      listBox
    );
    return { node, ids: () => Array.from(picked) };
  },

  /** 封面编辑块：左边预览 + 两个按钮，返回 { node, get } */
  buildCoverEditor(initial) {
    let cover = initial || '';
    // ⚠️ 千万别用 .pick —— 那是批量管理勾选角标，`position:absolute; top/right:8px`，
    // 挂上来封面框会直接飞到弹窗右上角外面去。
    const box = el('div', { class: 'pl-cover pk-cover' });
    const draw = () => {
      box.innerHTML = '';
      box.appendChild(cover ? el('img', { src: cover }) : uiSpan('musicNote'));
      box.classList.toggle('has', !!cover);
    };
    const pickLocal = async () => {
      const d = await API.raw.music.pickCover().catch(() => '');
      if (d) { cover = d; draw(); }
    };
    draw();
    const node = el('div', { class: 'pe-left' },
      box,
      el('button', { class: 'btn btn-sm btn-block', onclick: pickLocal }, uiSpan('image'), '选择本地图片'),
      el('button', { class: 'btn btn-sm btn-block', onclick: () => { cover = ''; draw(); } }, '清除封面')
    );
    // ⚠️ 必须走同一个 cover 变量：别把封面另存到 DOM 上，否则「先选歌曲封面 → 再点清除」
    // 会出现旧值复活。
    return { node, get: () => cover, set: (u) => { cover = u || ''; draw(); } };
  },

  async newPlaylist() {
    const nameInput = el('input', { class: 'inp', placeholder: '例如：深夜循环', value: '' });
    const coverEd = this.buildCoverEditor('');
    const picker = this.buildPicker([]);

    window.Shell.modal({
      title: '新建歌单',
      wide: true,
      body: el('div', { class: 'pl-edit' },
        coverEd.node,
        el('div', { class: 'pe-right' },
          el('label', { class: 'text-dim', style: { display: 'block', marginBottom: '6px', fontSize: '.9em' }, text: '歌单名称' }),
          nameInput,
          el('label', { class: 'text-dim', style: { display: 'block', margin: '12px 0 6px', fontSize: '.9em' }, text: '选择歌曲' }),
          picker.node
        )
      ),
      okText: '创建歌单',
      cancelText: '取消',
      onOk: async () => {
        const name = (nameInput.value || '').trim() || '新建歌单';
        const ids = picker.ids();
        await API.raw.music.addPlaylist(name, { tracks: ids, cover: coverEd.get() });
        window.Shell.toast(`已创建「${name}」${ids.length ? '，' + ids.length + ' 首' : ''}`, 'ok');
        this.reload();
      }
    });
    setTimeout(() => { try { nameInput.focus(); } catch { /* ignore */ } }, 60);
  },

  /* ==============================================================
   *  外部歌单（QQ 音乐 / 网易云分享链接）
   *  流程：粘贴链接 → 解析预览 → 库里有正常显示 / 没有的灰显并可下载 → 导入
   * ============================================================== */

  /** 预览里的一行：匹配的正常显示，没匹配的压暗并给「下载该歌曲」 */
  onlineRow(it, no) {
    if (it.matched) {
      return el('div', { class: 'ol-row' },
        el('span', { class: 'ol-no', text: String(no) }),
        el('div', { class: 'tt' },
          el('div', { class: 'n ellipsis', text: it.title }),
          el('div', { class: 'a ellipsis', text: it.artist + (it.album ? ' · ' + it.album : '') })
        ),
        el('span', { class: 'dur', text: formatDuration(it.duration) }),
        el('span', { class: 'chip accent', title: '匹配方式：' + (it.matchHow || '') }, '本地已有')
      );
    }
    return el('div', { class: 'ol-row off', title: '本地曲库里没有这首' },
      el('span', { class: 'ol-no', text: String(no) }),
      el('div', { class: 'tt' },
        el('div', { class: 'n ellipsis', text: it.title }),
        el('div', { class: 'a ellipsis' },
          it.artist + (it.album ? ' · ' + it.album : ''),
          el('span', { class: 'tag-miss', text: '本地没有' })
        )
      ),
      el('span', { class: 'dur', text: formatDuration(it.duration) }),
      it.quality ? el('span', { class: 'tag-q', text: it.quality }) : null,
      el('button', { class: 'btn btn-sm', onclick: () => this.fillStandalone(it) }, uiSpan('download'), '下载该歌曲')
    );
  },

  /** 预览区：歌单头部 + 统计 + 曲目列表 */
  renderOnlinePreview(box, pv) {
    clear(box);
    if (!pv) return;
    const ready = !!(this.srcCfg && this.srcCfg.configured);
    box.appendChild(el('div', { class: 'ol-head' },
      el('div', { class: 'ol-cover' }, pv.cover ? el('img', { src: pv.cover }) : uiSpan('musicNote')),
      el('div', { class: 'ol-meta' },
        el('div', { class: 'ol-name ellipsis', text: pv.name }),
        el('div', { class: 'ol-sub ellipsis', text: `${pv.source.platformName} · ${pv.creator || '未知创建者'}${pv.total ? ' · ' + pv.total + ' 首' : ''}` }),
        el('div', { class: 'ol-chips' },
          el('span', { class: 'chip accent', text: `已匹配 ${pv.matched} 首` }),
          pv.missing ? el('span', { class: 'chip warn', text: `缺 ${pv.missing} 首` }) : null,
          pv.partial ? el('span', { class: 'chip', title: '歌单太大，只取到了前一部分', text: '部分' }) : null
        )
      )
    ));
    if (pv.missing && !ready) {
      box.appendChild(el('div', { class: 'src-tip' },
        el('span', {}, `有 ${pv.missing} 首本地没有。配好音乐下载源后，导入时可以直接自动补全。`),
        el('button', { class: 'btn btn-sm', onclick: () => { window.Shell.closeModal(); this.openSourceConfig(); } }, uiSpan('settings'), '去配置')));
    }
    const list = el('div', { class: 'ol-list' });
    pv.items.forEach((it, i) => list.appendChild(this.onlineRow(it, i + 1)));
    box.appendChild(list);
  },

  /**
   * 导入弹窗最上面那块「我的歌单」。
   * 分享链接只能拿到**公开**歌单；用户自己建 / 收藏的歌单是私密的、没有链接可粘贴，
   * 只能带着登录 Cookie 去问平台「我有哪些歌单」—— 这才是「登录」的用处。
   */
  mineBox(linkInput, run, status) {
    const logged = (this.platforms || []).filter((p) => p.logged && (p.id === 'netease' || p.id === 'qq'));
    const box = el('div', { class: 'mine-box' });

    if (!logged.length) {
      box.appendChild(el('div', { class: 'mine-head' }, el('b', { text: '我的歌单' })));
      box.appendChild(el('div', { class: 'mine-empty' },
        el('span', { class: 'text-dim', text: '还没登录任何平台。分享链接只能导入公开歌单；登录后可以导入你自己建的 / 收藏的私密歌单。' }),
        el('button', {
          class: 'btn btn-sm', onclick: () => {
            window.Shell.closeModal();
            this.view = 'downloads'; this.renderRail(); this.renderMain();
            // 等重绘完再把登录卡片滚到眼前，别让用户自己找
            setTimeout(() => {
              const h = [...document.querySelectorAll('.card h3')].find((n) => n.textContent.includes('登录国内音乐平台'));
              if (h) h.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }, 120);
          }
        }, uiSpan('user'), '去登录'))
      );
      return box;
    }

    box.appendChild(el('div', { class: 'mine-head' },
      el('b', { text: '我的歌单' }),
      el('span', { class: 'text-dim', style: { fontSize: '.82em' }, text: '（需要登录，读的是你自己账号里的歌单）' })));

    const listBox = el('div', { class: 'mine-list' });
    const platRow = el('div', { class: 'mine-plats' });
    logged.forEach((p) => {
      const btn = el('button', { class: 'btn btn-sm mine-go' }, uiSpan('download'),
        `读取「${p.name}」${p.nickname ? ' · ' + p.nickname : ''}`);
      btn.onclick = async () => {
        btn.disabled = true;
        clear(listBox);
        listBox.appendChild(el('div', { class: 'hint', text: `正在读取 ${p.name} 的歌单…` }));
        let r = null;
        try { r = await API.raw.music.myPlaylists(p.id); }
        catch (e) { r = null; clear(listBox); listBox.appendChild(el('div', { class: 'hint err', text: '读取失败：' + (e.message || e) })); btn.disabled = false; return; }
        btn.disabled = false;
        clear(listBox);
        const list = (r && r.list) || [];
        if (!list.length) {
          listBox.appendChild(el('div', { class: 'hint', text: `${p.name} 账号里没有读到歌单。` }));
          return;
        }
        list.forEach((pl) => {
          listBox.appendChild(el('div', { class: 'mine-row', onclick: () => {
            const link = pl.platform === 'qq'
              ? `https://y.qq.com/n/ryqq/playlist/${pl.id}`
              : `https://music.163.com/playlist?id=${pl.id}`;
            linkInput.value = link;
            status.textContent = `正在解析「${pl.name}」…`;
            run();
          } },
            pl.cover ? el('img', { class: 'mine-cover', src: pl.cover }) : el('div', { class: 'mine-cover ph' }),
            el('div', { class: 'mine-meta' },
              el('div', { class: 'mine-name', text: pl.name }),
              el('div', { class: 'mine-sub', text: `${pl.count || 0} 首${pl.subscribed ? ' · 收藏' : ''}` }))
          ));
        });
      };
      platRow.appendChild(btn);
    });
    box.appendChild(platRow);
    box.appendChild(listBox);
    return box;
  },

  /** 导入弹窗里的「外部歌单」页签 */
  paintOnlineTab(bodyBox, status, nameInput, getAuto, setAuto) {
    const linkInput = el('input', { class: 'inp grow', id: 'olLink', placeholder: '粘贴分享链接或整段分享文案，例如：https://music.163.com/playlist?id=123456' });
    const prevBox = el('div', { class: 'ol-wrap' });
    const goBtn = el('button', { class: 'btn btn-primary', onclick: () => run() }, uiSpan('search'), '解析歌单');

    const autoWrap = el('div', { class: 'ol-auto' });
    const autoBox = el('input', { type: 'checkbox', id: 'olAuto' });
    autoBox.checked = !!getAuto();
    autoBox.onchange = () => setAuto(autoBox.checked);
    autoWrap.appendChild(autoBox);
    autoWrap.appendChild(el('label', { for: 'olAuto', text: '导入后自动下载补全缺失的歌（按最高音质）' }));
    autoWrap.appendChild(el('span', { class: 'text-dim', style: { fontSize: '.8em' } }, '需要已配置下载源'));

    const run = async () => {
      const link = (linkInput.value || '').trim();
      if (!link) { status.textContent = '先粘贴一个链接'; return; }
      goBtn.disabled = true;
      status.textContent = '正在解析歌单…';
      const pv = await API.raw.music.onlinePlaylist(link).catch((e) => {
        status.textContent = '解析失败：' + (e.message || String(e));
        goBtn.disabled = false;
        return null;
      });
      goBtn.disabled = false;
      if (!pv) return;
      this.onlinePreview = pv;
      status.textContent = '';
      this.renderOnlinePreview(prevBox, pv);
      if (!nameInput.value) nameInput.value = pv.name || '';
      autoWrap.style.display = pv.missing ? 'flex' : 'none';
    };

    bodyBox.appendChild(this.mineBox(linkInput, run, status));
    bodyBox.appendChild(el('p', { class: 'hint', text: '支持网易云 / QQ 音乐的歌单分享链接（含短链）。只读取歌单元数据（歌名 / 歌手 / 专辑 / 时长），然后和本地曲库逐条对上。' }));
    bodyBox.appendChild(el('div', { class: 'row' }, linkInput, goBtn));
    bodyBox.appendChild(status);
    bodyBox.appendChild(autoWrap);
    bodyBox.appendChild(prevBox);

    // 上次解析过就先摆出来，切页签回来不丢
    if (this.onlinePreview) {
      linkInput.value = this.onlinePreview.source.link || '';
      if (!nameInput.value) nameInput.value = this.onlinePreview.name || '';
      this.renderOnlinePreview(prevBox, this.onlinePreview);
      autoWrap.style.display = this.onlinePreview.missing ? 'flex' : 'none';
    } else {
      autoWrap.style.display = 'none';
    }
    return { run, linkInput };
  },

  /** 预览阶段单独下载一首（还没建歌单，所以不带 playlistId；下完进本地库，导入时会自动对上） */
  async fillStandalone(it) {
    if (!this.srcCfg || !this.srcCfg.configured) return this.openSourceConfig();
    window.Shell.toast(`正在搜索「${it.title}」…`);
    const r = await API.raw.music.fillMissing([it])
      .catch((e) => { window.Shell.toast(e.message || String(e), 'err'); return null; });
    if (!r) return;
    if (!r.queued.length) return window.Shell.toast(`没搜到「${it.title}」`, 'err');
    window.Shell.toast(`已加入下载队列：${r.queued[0].name}，下完自动进本地音乐库`, 'ok');
  },

  /* ==============================================================
   *  歌单导入 / 导出
   * ============================================================== */
  importPlaylistDialog(preferMine) {
    let mode = 'online';        // 外部歌单排第一：这是最常用的入口
    let picked = null;          // { path, name, files }
    let dirs = [];
    let autoFill = true;        // 导入后自动把缺的歌丢给下载源

    const nameInput = el('input', { class: 'inp', id: 'ipName', placeholder: '歌单名称（留空就用原歌单名）' });
    const status = el('div', { class: 'ip-status' });
    const tabs = el('div', { class: 'ip-tabs' });
    const bodyBox = el('div', { class: 'ip-body' });
    const copySel = el('select', { class: 'inp' },
      this.playlists.length
        ? this.playlists.map((p) => el('option', { value: p.id }, `${p.name}（${(p.tracks || []).length} 首）`))
        : [el('option', { value: '' }, '还没有任何歌单')]);

    const paint = () => {
      clear(tabs); clear(bodyBox);
      [['online', '外部歌单（QQ / 网易云）'], ['file', '本地歌单文件'], ['dir', '从文件夹导入'], ['copy', '复制已有歌单']].forEach(([k, t]) => {
        tabs.appendChild(el('div', { class: 'ip-tab' + (mode === k ? ' on' : ''),
          onclick: () => { mode = k; status.textContent = ''; paint(); } }, t));
      });

      if (mode === 'online') { return this.paintOnlineTab(bodyBox, status, nameInput, () => autoFill, (v) => { autoFill = v; }); }

      if (mode === 'file') {
        bodyBox.appendChild(el('p', { class: 'hint', text: '支持 .m3u / .m3u8 / .pls / .txt / .json。相对路径按歌单文件所在目录解析；里面还没入库的曲子会自动补进本地音乐库。' }));
        bodyBox.appendChild(el('div', { class: 'row' },
          el('button', { class: 'btn', onclick: async () => {
            const r = await API.raw.music.pickPlaylistFile().catch((e) => { window.Shell.toast(e.message, 'err'); return null; });
            if (!r) return;
            picked = r;
            status.textContent = `已选 ${window.util.baseName(r.path)} · 解析到 ${r.files.length} 条曲目记录`;
            if (!nameInput.value) nameInput.value = r.name;
          } }, uiSpan('folder'), '选择歌单文件'),
          status));
      } else if (mode === 'dir') {
        bodyBox.appendChild(el('p', { class: 'hint', text: '选一个（或多个）文件夹，里面的音频会全部收进这个歌单并加入本地音乐库；该文件夹同时会被加进「本地音乐」的扫描目录。' }));
        bodyBox.appendChild(el('div', { class: 'row' },
          el('button', { class: 'btn', onclick: async () => {
            const d = await API.raw.dialog.pickFolders().catch(() => []);
            if (d && d.length) {
              dirs = d;
              status.textContent = `已选 ${d.length} 个文件夹：` + d.map((x) => window.util.baseName(x)).join('、');
            }
          } }, uiSpan('folder'), '选择文件夹'),
          status));
      } else {
        bodyBox.appendChild(el('p', { class: 'hint', text: '把已有歌单整体复制一份（曲目引用不变，原歌单不受影响）。' }));
        bodyBox.appendChild(el('div', { class: 'row' }, copySel));
      }
    };
    paint();

    window.Shell.modal({
      title: '导入歌单',
      wide: true,
      body: el('div', { class: 'ip-wrap' },
        tabs,
        bodyBox,
        el('label', { class: 'text-dim', style: { display: 'block', margin: '14px 0 6px', fontSize: '.9em' }, text: '歌单名称' }),
        nameInput
      ),
      okText: '开始导入',
      cancelText: '取消',
      onOk: async () => {
        const nm = (nameInput.value || '').trim();
        let r;
        if (mode === 'online') {
          const pv = this.onlinePreview;
          if (!pv || !pv.items || !pv.items.length) throw new Error('先粘贴链接并点「解析歌单」');
          r = await API.raw.music.importOnlinePlaylist(pv.source.link, { name: nm, preview: pv });
          await this.reload();
          const miss = pv.items.filter((x) => !x.matched);
          if (autoFill && miss.length) {
            if (this.srcCfg && this.srcCfg.configured) {
              const f = await API.raw.music.fillMissing(miss, { playlistId: r.playlist.id }).catch(() => null);
              if (f) {
                window.Shell.toast(
                  `「${r.playlist.name}」已导入：${r.matched} 首已在本地，${(f.queued || []).length} 首已开始下载` +
                  ((f.failed || []).length ? `，${f.failed.length} 首没搜到` : ''), 'ok');
                return;
              }
            } else {
              window.Shell.toast(`「${r.playlist.name}」已导入：${r.matched} 首已匹配，${miss.length} 首缺 —— 配好下载源后才能自动补全`, 'err');
              return;
            }
          }
          window.Shell.toast(`「${r.playlist.name}」已导入：${r.matched} 首已匹配${r.missing ? '，' + r.missing + ' 首缺' : ''}`, r.missing ? 'err' : 'ok');
          return;
        }
        if (mode === 'file') {
          if (!picked) throw new Error('先选一个歌单文件');
          r = await API.raw.music.importPlaylist(nm || picked.name, picked.files);
        } else if (mode === 'dir') {
          if (!dirs.length) throw new Error('先选一个文件夹');
          r = await API.raw.music.importPlaylistFromDirs(nm || window.util.baseName(dirs[0]), dirs);
        } else {
          const pl = this.playlistById(copySel.value);
          if (!pl) throw new Error('没有可复制的歌单');
          const np = await API.raw.music.addPlaylist(nm || pl.name + ' 副本', { tracks: pl.tracks || [], cover: pl.cover || '' });
          r = { playlist: np, matched: (np.tracks || []).length, added: 0, missed: [] };
        }
        await this.reload();
        const miss = (r.missed || []).length;
        window.Shell.toast(
          `「${r.playlist.name}」导入完成：${r.matched} 首` +
          (r.added ? `，其中新入库 ${r.added} 首` : '') +
          (miss ? `，${miss} 条找不到对应文件` : ''), miss ? 'err' : 'ok');
      }
    });

    // 从登录卡片上「导入我的歌单」进来的：自动读一次第一个登录平台的歌单，省得再点一遍
    if (preferMine) {
      setTimeout(() => {
        const b = document.querySelector('#modals .mine-box .mine-go');
        if (b) b.click();
      }, 140);
    }
  },

  async exportPlaylist(pl) {
    const r = await API.raw.music.exportPlaylist(pl.id).catch((e) => { window.Shell.toast(e.message, 'err'); return null; });
    if (!r) return;
    window.Shell.toast(`已导出 ${r.count} 首到 ${window.util.baseName(r.path)}`, 'ok');
  },

  async addSongs(pl) {
    const picker = this.buildPicker([], pl.tracks || []);
    window.Shell.modal({
      title: '添加歌曲到「' + pl.name + '」',
      wide: true,
      body: picker.node,
      okText: '添加',
      cancelText: '取消',
      onOk: async () => {
        const ids = picker.ids();
        if (!ids.length) return;
        await API.raw.music.addToPlaylist(pl.id, ids);
        window.Shell.toast(`已添加 ${ids.length} 首`, 'ok');
        this.reload();
      }
    });
  },

  async renamePlaylist(pl) {
    const name = await window.Shell.prompt({ title: '重命名歌单', label: '歌单名称', value: pl.name });
    if (!name) return;
    const v = name.trim();
    if (!v) return window.Shell.toast('名称不能为空', 'err');
    await API.raw.music.updatePlaylist(pl.id, { name: v });
    window.Shell.toast('已重命名', 'ok');
    this.reload();
  },

  async changeCover(pl) {
    const songs = this.tracksOf(pl);
    const coverEd = this.buildCoverEditor(pl.cover || '');
    const fromSongs = songs.filter((t) => t.cover).slice(0, 12);
    const grid = fromSongs.length
      ? el('div', { class: 'cov-grid' }, fromSongs.map((t) =>
          el('img', { class: 'cov-opt', src: t.cover, title: t.title, onclick: () => coverEd.set(t.cover) })))
      : el('p', { class: 'hint', text: '歌单里的歌曲都没有内嵌封面，可以从本地图片选一张。' });

    window.Shell.modal({
      title: '更换歌单封面',
      wide: true,
      body: el('div', { class: 'pl-edit' },
        coverEd.node,
        el('div', { class: 'pe-right' },
          el('p', { class: 'hint', text: '也可以直接点下面任意一张歌曲封面来用：' }),
          grid
        )
      ),
      okText: '保存封面',
      cancelText: '取消',
      onOk: async () => {
        await API.raw.music.updatePlaylist(pl.id, { cover: coverEd.get() });
        this.reload();
      }
    });
  },

  async removeFromPlaylist(pl, trackId) {
    await API.raw.music.updatePlaylist(pl.id, { tracks: (pl.tracks || []).filter((x) => x !== trackId) });
    this.reload();
  },

  async deletePlaylist(pl) {
    const yes = await window.Shell.confirm({
      title: '删除歌单',
      message: `确定删除「${pl.name}」吗？`,
      detail: '只删除歌单本身，本地的音乐文件不会受影响。',
      okText: '删除歌单',
      cancelText: '取消'
    });
    if (!yes) return;
    await API.raw.music.removePlaylist(pl.id);
    this.currentPlaylistId = '';
    this.view = 'local';
    window.Shell.toast('歌单已删除', 'ok');
    this.reload();
  },

  /** 用任意曲目列表作为播放队列（歌单内播放用） */
  playQueue(list, i) {
    this.queue = list.slice();
    this.index = i;
    this.play();
  },

  /**
   * 抓取**所有**填写的网站（每个都抓一遍、结果合并去重）。
   * 逐站回报谁抓到谁没抓到 —— 不然用户看到「0 个音频」根本不知道是哪个站的问题。
   */
  async crawl() {
    const ed = this._crawlEd;
    const list = ed ? ed.read() : [];
    if (!list.length) return window.Shell.toast('请填写要抓取的网站', 'err');
    window.Shell.toast(list.length > 1 ? `正在抓取 ${list.length} 个网站…` : '正在抓取…');
    /* 抓之前先把这份网址存下来（下次打开还在），和下载源那张卡一致 */
    await API.raw.music.setCrawlConfig({ sites: list })
      .then((next) => { this.crawlCfg = next; })
      .catch(() => {});

    const res = await API.raw.music.crawlSites(list).catch((e) => { window.Shell.toast(e.message, 'err'); return null; });
    if (!res) return;

    const okSites = (res.sources || []).filter((s) => s.ok).length;
    const badSites = (res.sources || []).filter((s) => !s.ok);
    const detail = [
      badSites.length ? `打不开的站：${badSites.map((s) => String(s.url).replace(/^https?:\/\//, '').split('/')[0]).join('、')}` : '',
      res.forwarded ? `已自动转交网盘模块下载 ${res.forwarded} 个网盘链接。` : ''
    ].filter(Boolean).join('\n');

    const pick = await window.Shell.confirm({
      title: '抓取结果',
      message: `${res.total} 个网站里 ${okSites} 个抓到了内容；共 ${res.audio.length} 个音频直链、${res.netdisk.length} 个网盘链接（已去重）`,
      detail,
      okText: res.audio.length ? '下载音频直链' : '好',
      cancelText: res.audio.length ? '取消' : '关闭'
    });
    if (pick && res.audio.length) {
      const n = await API.raw.music.downloadAudio(res.audio).catch(() => 0);
      window.Shell.toast(`已加入下载队列：${n} 个`, 'ok');
    }
  },

  async browseServer() {
    const addr = (document.getElementById('mSrvAddr') || {}).value || '';
    if (!addr) return window.Shell.toast('请填写服务器地址', 'err');
    window.Shell.toast('正在查询…');
    const res = await API.raw.music.browseServer(addr).catch((e) => { window.Shell.toast(e.message, 'err'); return null; });
    if (!res) return;
    if (!res.items.length) return window.Shell.toast('未找到可下载的音频', 'err');
    window.Shell.modal({
      title: `发现 ${res.items.length} 首曲目`,
      body: el('div', { class: 'track-list' }, res.items.map((it, i) =>
        el('div', { class: 'track' }, el('span', { class: 'no', text: String(i + 1) }),
          el('div', { class: 'tt' }, el('div', { class: 'n', text: it.name }), el('div', { class: 'a', text: it.url }))))),
      okText: '全部下载',
      onOk: async () => { const n = await API.raw.music.downloadAudio(res.items).catch(() => 0); window.Shell.toast(`已加入下载队列：${n} 个`, 'ok'); }
    });
  },

  async loginPlatform(p) {
    if (p.logged) {
      const yes = await window.Shell.confirm({
        title: p.name,
        message: `已登录${p.nickname ? '：' + p.nickname : ''}。是否退出登录？`,
        detail: '退出会同时清掉「浏览器」里这个站点的登录状态。',
        okText: '退出登录'
      });
      if (yes) {
        await API.raw.music.logout(p.id).catch((e) => window.Shell.toast(e.message, 'err'));
        window.Shell.toast(`${p.name} 已退出登录`, 'ok');
        this.reload();
      }
      return;
    }
    const ok = await window.Shell.openLoginDialog({ kind: 'music', id: p.id, name: p.name, url: p.loginUrl });
    if (ok) this.reload();
  }
};

window.MusicView = MusicView;

/* Esc 关闭歌词页。
   ⚠️ 关闭按钮的提示里一直写着「（Esc）」，但之前根本没接上 —— 这里补上。
   只在歌词页真开着的时候吞这个键，别去抢浏览器模块 / 其他页面的 Esc。 */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' && e.key !== 'Esc') return;
  if (!MusicView.lyricOpen) return;
  e.stopPropagation();
  MusicView.closeLyrics();
}, true);
})();
