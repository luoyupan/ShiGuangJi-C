/**
 * 拾光集 · 游戏模块视图 (modules/games.js)
 *
 * 布局：左侧「搜索 + 主导航（游戏库 / 平台总览 / 隐藏空间）+ 游戏列表」，
 *       右侧按页面渲染：
 *         · library   —— 卡片墙 / 列表（标题后带平台图标）
 *         · platforms —— 平台总览（账号 / 游戏数 / 时长 / 成就 / 客户端）
 *         · hidden    —— 隐藏空间（密码门禁 + 只藏 18+ 游戏 + 网盘下载）
 *       点卡片进入富详情页（概览 / 模组 / 设置）。
 */
'use strict';
(function () {
const { el, clear, formatBytes, formatPlayTime, timeAgo } = window.util;
const { uiSpan } = window.ICON;

/* 平台下拉项（手动添加时用） */
const PLATFORM_OPTIONS = [
  ['auto', '自动识别'], ['steam', 'Steam'], ['epic', 'Epic Games'], ['gog', 'GOG Galaxy'],
  ['ubisoft', 'Ubisoft Connect'], ['ea', 'EA App'], ['battlenet', 'Battle.net'],
  ['xbox', 'Xbox'], ['rockstar', 'Rockstar'], ['riot', 'Riot Games'],
  ['wegame', 'WeGame'], ['local', '本地 / 其它']
];

/* ------------------------------------------------------------
 *  通关状态：与主进程 games/index.js 保持同一份枚举 / 顺序 / 文案。
 *  ⚠️ 没有「未标记」这一档 —— 入库即「未通关」，界面上永远有一个选中项。
 *  顺序固定「从强到弱」，扫一眼就知道自己在哪一档。
 * ------------------------------------------------------------ */
const CLEAR_META = {
  cleared: { label: '通关', icon: '✓' },
  multi: { label: '多结局通关', icon: '✦' },
  uncleared: { label: '未通关', icon: '○' }
};
const CLEAR_ORDER = ['cleared', 'multi', 'uncleared'];
const CLEAR_DEFAULT = 'uncleared';
const clearOf = (g) => (CLEAR_META[g && g.clearState] ? g.clearState : CLEAR_DEFAULT);

/* ------------------------------------------------------------
 *  分类：一个游戏可以挂**多个**分类。
 *  主进程侧 `categories` 是唯一真源，`category` 只是 `categories[0]` 的兼容别名 ——
 *  渲染层一律走 catsOf()，别再直接读 g.category。
 * ------------------------------------------------------------ */
const catsOf = (g) => {
  if (!g) return [];
  if (Array.isArray(g.categories)) return g.categories.filter(Boolean);
  const one = String(g.category || '').trim();
  return one && one !== '未分类' ? [one] : [];
};
const catText = (g, sep) => {
  const a = catsOf(g);
  return a.length ? a.join(sep || ' · ') : '未分类';
};
/** 输入框里的一串分类名 → 去重数组（分隔符与主进程 normCategories 保持一致） */
const parseCatInput = (s) => {
  const out = [];
  for (const x of String(s || '').split(/[,，、/|;；]+/)) {
    const t = x.trim();
    if (!t || t === '未分类' || out.includes(t)) continue;
    out.push(t);
  }
  return out;
};

/* ------------------------------------------------------------
 *  「18+」是个**特殊分类**：挂上它 = 这款游戏放进隐藏空间。
 *  主进程 games/index.js 里也守着同一条规则（分类里出现 18+ 就 hidden=true），
 *  所以不管从哪个入口加上这个标签，效果都一样。
 * ------------------------------------------------------------ */
const ADULT_CAT = '18+';
const isAdultOf = (o) => !!(o && ((o.categories || []).includes(ADULT_CAT) || o.hidden));
/** 打开 / 关掉 18+（同时维护 categories 与 hidden 两个字段）
 *  放在**最后**：第一个分类要留给有意义的那个（详情页 / 列表里展示的主分类）。 */
const setAdult = (o, on) => {
  if (!o) return o;
  const rest = (o.categories || []).filter((x) => x !== ADULT_CAT);
  o.categories = on ? rest.concat([ADULT_CAT]) : rest;
  o.categoryLocked = !!o.categories.length;
  o.hidden = !!on;
  return o;
};

/** 「数值 + 说明」的统计块（游玩时间 / 成就 / 启动次数） */
const statPill = (value, label, icon) => el('span', { class: 'stat-pill' },
  icon ? uiSpan(icon, 'sp-ic') : null,
  el('span', { class: 'sp-v', text: value }),
  el('span', { class: 'sp-k', text: label }));

/** 卡片 / 列表上的通关状态角标 */
const clearBadge = (g, variant) => {
  const k = clearOf(g);
  const m = CLEAR_META[k];
  return el('span', {
    class: (variant === 'chip' ? 'chip clear-chip ' : 'clear-badge ') + 'cc-' + k,
    title: '通关状态：' + m.label
  }, el('span', { class: 'cc-ic', text: k === 'uncleared' ? '○' : m.icon }), el('span', { text: m.label }));
};

/** 候选列表右侧那句日期（2024-06-25） */
const dateText = (ms) => {
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};

const GamesView = {
  root: null,
  list: [],                 // 当前库列表
  page: 'library',          // library | platforms | stats | hidden
  filter: 'all',            // all | recent | favorite
  category: 'all',          // 分类筛选
  sort: 'added:desc',
  layout: 'grid',           // grid | list
  cardSize: 'medium',
  search: '',
  currentId: '',
  selectMode: false,        // 批量管理：卡片 / 列表项可勾选
  selected: new Set(),      // 已勾选的游戏 id
  _detailTab: 'overview',    // 详情页当前标签（封面刷新后要回到原来那一页）
  hiddenCount: 0,
  hiddenInfo: null,         // 隐藏空间状态（enabled / unlocked / name），门禁用
  cats: [],                 // 分类列表（用户可自己增删改）
  platforms: null,          // 平台总览缓存
  platformId: '',           // 当前点进的平台（页面 = 'platform'）
  pfData: null,             // 平台详情缓存（该平台的游戏清单）
  pfFilter: 'all',          // 平台详情筛选：all / installed / notinstalled
  pfSort: 'playtime',       // 平台详情排序：playtime / name / lastPlayed
  pfSearch: '',             // 平台详情搜索
  statsData: null,          // 统计页缓存
  statsPeriod: 'all',
  _modsMemo: {},            // MOD 面板记录：游戏 id -> 上次读到的 MOD 数据（先出画面再去刷新）

  async mount(container) {
    this.root = container;
    container.innerHTML = '';
    const wrap = el('div', { class: 'games' });
    this.sideEl = el('aside', { class: 'gside' });
    this.mainEl = el('section', { class: 'gmain' });
    wrap.appendChild(this.sideEl);
    wrap.appendChild(this.mainEl);
    // ⚠️ 详情层挂在**右侧** mainEl 里，不是整个游戏模块上 ——
    //    这样点开游戏后左侧游戏列表还在（跟 Steam 一样），而不是整屏被详情盖掉。
    this.detailLayer = el('div', { class: 'gdetail', hidden: true });
    this.mainEl.appendChild(this.detailLayer);
    container.appendChild(wrap);

    // 支持 #/games/hidden 直达隐藏空间
    if (/hidden/.test(location.hash)) this.page = 'hidden';

    await this.refreshCounts();
    await this.reload();
    return this;
  },

  async refreshCounts() {
    this.hiddenCount = (await API.raw.games.hiddenList().catch(() => [])).length;
  },

  /** 分类列表：用户自己增删改的，存在主进程里 */
  async loadCategories() {
    this.cats = await API.raw.games.categories().catch(() => []);
    return this.cats;
  },

  /**
   * 封面候选表（按优先级）—— 🔴 **本地文件优先，网络直链兜底**。
   *
   * 为什么不是「网络优先」：CDN 直链**可能根本不存在**。实测 `PEAK`(3527290) 与
   * `Machine Party`(4108000) 的 `library_600x900.jpg` 在 Steam CDN 上就是 **404**，
   * 而本地 librarycache 里明明躺着 300×450 的真封面。以前这里 `cover || coverLocal`
   * 优先取网络 → `<img>` 拿到 404 → 浏览器把 `alt`（游戏名）**画成大字**，
   * 在 2:3 的封面框里就是「一块白底 + 顶部几个字」，看着像封面丢了。
   * 本地图不会 404、离线也在、还秒出，所以它必须排第一。
   */
  coverList(g) {
    if (!g) return [];
    const out = [];
    const push = (u) => { const s = String(u || ''); if (s && !out.includes(s)) out.push(s); };
    // 用户自己选的图排最前，轮到它的概率等于「本地文件没了」（那时再退网络）
    if (g.coverKind === 'custom') { push(g.coverLocal); push(g.cover); return out; }
    push(g.coverLocal);      // Steam 本地缓存封面 / exe 图标 / 用户选的图
    push(g.cover);           // 网络直链兜底
    return out;
  },

  /** 「有没有封面」用（编辑弹窗、更新结果提示） */
  coverSrc(g) { return this.coverList(g)[0] || ''; },

  /**
   * 画封面：候选按序试，**全挂光了才退回占位块**。
   * ⚠️ 必须自己接住 `onerror`：浏览器对加载失败的 `<img>` 会画「破图图标 + alt 文字」，
   * 那个观感比一块干净的占位惨得多，而且会把游戏名画得到处都是。
   * @param {object} opts { class, alt, eager, style, phClass, placeholder() }
   *        placeholder() 返回 null 表示「宁可什么都不放」（详情页的大图就是这么用的）
   */
  coverImg(g, opts = {}) {
    const list = this.coverList(g);
    const ph = () => (typeof opts.placeholder === 'function'
      ? opts.placeholder()
      : el('div', { class: opts.phClass || 'ph', text: g ? g.name : '' }));
    if (!list.length) return ph();
    const props = { alt: opts.alt || '' };
    if (opts.class) props.class = opts.class;
    if (opts.style) props.style = opts.style;
    if (!opts.eager) props.loading = 'lazy';
    const img = el('img', props);
    let i = 0;
    img.onerror = () => {
      i += 1;
      if (i < list.length) { img.src = list[i]; return; }   // 换下一个候选（本地 → 网络）
      img.onerror = null;
      const node = ph();
      if (!img.parentNode) return;
      if (node) img.parentNode.replaceChild(node, img);
      else img.remove();
    };
    img.src = list[0];
    return img;
  },

  /**
   * 隐藏空间那一页和游戏库**走同一套渲染**，只是圈定范围不同。
   * 判断只此一处，别到处写 `this.page === 'hidden'`。
   */
  inHidden() { return this.page === 'hidden'; },

  async reload() {
    if (this.page === 'library' || this.inHidden()) {
      this.list = await API.raw.games.list({
        scope: this.inHidden() ? 'hidden' : 'normal',
        view: this.filter, search: this.search, sort: this.sort, category: this.category
      }).catch(() => []);
    }
    await Promise.all([this.refreshCounts(), this.loadCategories()]);
    this.renderSide();
    this.renderMain();
  },

  setPage(page) {
    const changed = this.page !== page;
    if (changed) this.resetSelect(true);     // 换页就退出批量管理，别把勾选带到别的页面
    this.page = page;
    if (changed) {
      this.currentId = '';
      this.detailLayer.hidden = true;
    }
    // ⚠️ 回到「游戏库」一定要重新取一次列表。
    //    别处（比如平台总览的「同步到游戏库」）可能把 this.list 清过，
    //    而 setPage 只负责切页、不取数据 —— 之前就因此表现为「同步一下游戏全没了」。
    // 「隐藏空间」同理：两个页面的 list 范围不同（全部 vs hidden），必须重取。
    if (page === 'library' || page === 'hidden') { this.reload(); return; }
    // 「点进某个平台」：清掉上一个平台的缓存再进，别把上一个平台的清单带过来
    if (page === 'platform') { this.pfData = null; this.pfSearch = ''; this.pfFilter = 'all'; }
    if (!changed) {
      if (page === 'platforms') this.loadPlatforms(true);
      if (page === 'stats') this.loadStats(true);
      return;
    }
    this.renderSide();
    this.renderMain();
  },

  /* ============================================================
     左侧：搜索 + 主导航 + 筛选项 + 游戏列表
     ============================================================ */
  renderSide() {
    /* 重建 DOM 会把列表的滚动位置顶回最上面 —— 先记下来，画完再写回去。
       （列表变短时浏览器自己会夹到合法范围，不用我们兜） */
    const prevList = this.sideEl && this.sideEl.querySelector('.gside-list');
    const keepTop = prevList ? prevList.scrollTop : 0;
    const side = clear(this.sideEl);

    /* 搜索 */
    side.appendChild(el('div', { class: 'gside-search' },
      el('div', { class: 'field' },
        uiSpan('search'),
        el('input', {
          type: 'text', placeholder: '搜索游戏…', value: this.search,
          oninput: (e) => {
            this.search = e.target.value;
            this.resetSelect(true);
            if (this.page !== 'library' && !this.inHidden()) return;   // 平台 / 统计页有自己的搜索
            this.reloadDebounced();
          }
        })
      )
    ));

    /* 主导航 */
    const navItems = [
      ['library', '游戏库', 'grid'],
      ['platforms', '平台总览', 'globe'],
      ['stats', '游玩统计', 'chart'],
      ['hidden', '隐藏空间', 'lock']
    ];
    side.appendChild(el('div', { class: 'gside-rail' },
      navItems.map(([k, t, ic]) =>
        // 点进某个平台（page='platform'）时，「平台总览」仍然是高亮的那一栏
        el('div', {
          class: 'grail-item' + (this.page === k || (k === 'platforms' && this.page === 'platform') ? ' on' : ''),
          onclick: () => this.setPage(k)
        },
          uiSpan(ic),
          el('span', { class: 'gt', text: t }),
          k === 'hidden' && this.hiddenCount
            ? el('span', { class: 'chip', text: String(this.hiddenCount) })
            : null))
    ));

    /* 游戏库 / 隐藏空间都用这一套筛选 + 列表 —— 两个页面长得一样，
       差别只在于圈定的范围（全部游戏 vs hidden===true） */
    if (this.page === 'library' || this.inHidden()) {
      const filters = [['all', '全部'], ['recent', '最近'], ['favorite', '收藏']];
      side.appendChild(el('div', { class: 'gside-nav' },
        filters.map(([k, label]) =>
          el('span', { class: 'chip' + (this.filter === k ? ' on' : ''), onclick: () => { this.filter = k; this.resetSelect(true); this.reload(); } }, label))
      ));

      /* 分类筛选 —— 分类由用户自己维护，所以旁边给个「管理」入口 */
      /* 「18+」不放进筛选：挂了它的游戏都在隐藏空间里，在游戏库这筛必然是空的 */
      const catSel = el('select', { class: 'inp', onchange: (e) => { this.category = e.target.value; this.resetSelect(true); this.reload(); } },
        [['all', '全部分类'], ...this.cats.filter((c) => c !== ADULT_CAT).map((c) => [c, c])]
          .map(([v, t]) => el('option', { value: v, selected: this.category === v }, t)));
      side.appendChild(el('div', { class: 'gside-cat' },
        catSel,
        el('button', { class: 'btn btn-sm', title: '新建 / 改名 / 删除分类', onclick: () => this.categoryDialog() }, uiSpan('settings'))
      ));

      const listBox = el('div', { class: 'gside-list' });
      if (!this.list.length) {
        listBox.appendChild(el('div', { class: 'empty', style: { minHeight: '150px' } },
          el('p', { class: 'text-dim', text: this.search ? '没有匹配的游戏' : (this.inHidden() ? '隐藏空间里还没有游戏' : '游戏库还是空的') })));
      } else {
        for (const g of this.list) listBox.appendChild(this.listItem(g));
      }
      side.appendChild(listBox);
    } else {
      side.appendChild(el('div', { class: 'gside-list' }));
    }
    // 把重建前的滚动位置写回去（切筛选 / 搜索导致列表变短时会自动夹住）
    const nextList = side.querySelector('.gside-list');
    if (nextList && keepTop) nextList.scrollTop = keepTop;

    /* 底部动作 —— 位置和游戏库一致，只是「这一页能干什么」不同：
       游戏库是往库里**加**游戏，隐藏空间是**管**这个空间 */
    side.appendChild(this.inHidden() ? el('div', { class: 'gside-foot' },
      el('button', { class: 'btn btn-primary btn-block', title: '粘贴网盘链接下载游戏，完成后自动解压',
        onclick: () => window.HiddenSpace.openDownload() }, uiSpan('download'), '下载游戏'),
      el('button', { class: 'btn btn-block', title: '改名 / 改密码 / 改提示 / 关闭隐藏空间',
        onclick: () => window.HiddenSpace.openSettings() }, uiSpan('settings'), '隐藏空间设置'),
      el('button', { class: 'btn btn-block', title: '重新上锁（下次进来要再输密码）',
        onclick: () => { API.raw.hidden.lock(); window.Shell.toast('已上锁'); this.reload(); } }, uiSpan('lock'), '锁定')
    ) : el('div', { class: 'gside-foot' },
      el('button', { class: 'btn btn-primary btn-block', onclick: () => this.scan() },
        uiSpan('refresh'), '扫描本机游戏'),
      el('button', { class: 'btn btn-block', onclick: () => this.addDialog() },
        uiSpan('plus'), '添加游戏')
    ));
  },

  /**
   * 只搬左侧列表的「当前选中」高亮，**不重建 DOM**。
   *
   * 点一款游戏就 `renderSide()` 重建整条列表，会把滚动位置顶回最上面 ——
   * 在几百款的库里点第 30 款看详情、返回，就又得从头滚一遍。
   * 这里只改 class，滚动位置一动不动。
   */
  syncSideActive() {
    if (!this.sideEl) return;
    for (const node of this.sideEl.querySelectorAll('.glist-item[data-gid]')) {
      node.classList.toggle('on', node.dataset.gid === this.currentId);
    }
  },

  /** MOD 插件开着吗？关掉之后**所有 MOD 入口都要消失**（主界面卡片、详情页标签、右键菜单） */
  modsPluginOn() {
    const pl = (window.State && window.State.plugins) || null;
    if (!pl || !Array.isArray(pl.list) || !pl.list.length) return true;   // 还没加载完：先按“开着”，别闪一下
    const hit = pl.list.find((p) => p.id === 'mods');
    return !hit || hit.enabled !== false;
  },

  /** 「打开 MOD」：跳独立的 MOD 模块并选中这一款（不在这里画面板了） */
  openMods(g) {
    if (!g || !this.modsPluginOn()) {
      window.Shell.toast('MOD 模块已关闭 —— 设置 → 插件 里可以打开', 'info');
      return;
    }
    window.Shell.go('#/mods/' + encodeURIComponent(g.id));
  },

  listItem(g) {
    const plat = window.ICON.platform(g.platform);
    return el('div', {
      class: 'glist-item' + (this.currentId === g.id ? ' on' : ''),
      dataset: { gid: g.id },          // 给 syncSideActive() 就地改高亮用
      onclick: () => this.openDetail(g.id),
      oncontextmenu: (e) => { e.preventDefault(); this.ctxMenu(e, g); }
    },
      el('div', { class: 'glist-thumb' },
        this.coverImg(g, { placeholder: () => el('span', { class: 'text-dim', text: '🎮' }) })),
      el('div', { class: 'glist-main' },
        el('div', { class: 'glist-name' },
          el('span', { class: 't', text: g.name }),
          el('span', { class: 'glist-play', html: plat, title: g.platformName })
        ),
        el('div', { class: 'glist-sub' },
          g.missing ? el('span', { class: 'tag-missing', text: '目录丢失' }) : null,
          el('span', { text: (g.size ? formatBytes(g.size) + ' · ' : '') + (g.lastPlayed ? timeAgo(g.lastPlayed) : catText(g)) }),
          clearBadge(g)
        )
      )
    );
  },

  /* ============================================================
     主区域分发
     ============================================================ */
  renderMain() {
    if (this.page === 'platform') this.renderPlatform();
    else if (this.page === 'platforms') this.renderPlatforms();
    else if (this.page === 'stats') this.renderStats();
    else if (this.page === 'hidden') this.renderHidden();
    else this.renderLibrary();
    // clear() 会把详情层一并清掉，这里补回来 —— 详情层必须一直待在右侧
    if (this.detailLayer && this.detailLayer.parentNode !== this.mainEl) {
      this.mainEl.appendChild(this.detailLayer);
    }
  },

  /* ============================================================
     页面三：游玩统计（本周 / 本月 / 本季 / 今年 / 全部）
     ============================================================ */
  renderStats() {
    const main = clear(this.mainEl);
    const periods = [['week', '本周'], ['month', '本月'], ['quarter', '本季'], ['year', '今年'], ['all', '全部']];
    main.appendChild(el('div', { class: 'gmain-head' },
      el('h2', { style: { margin: 0, fontSize: '1.16rem' }, text: '游玩统计' }),
      el('div', { class: 'grow' }),
      el('div', { class: 'gside-nav', style: { margin: 0 } },
        periods.map(([k, t]) => el('span', {
          class: 'chip' + (this.statsPeriod === k ? ' on' : ''),
          onclick: () => { this.statsPeriod = k; this.loadStats(true); }
        }, t))),
      el('button', { class: 'btn btn-sm', onclick: () => this.loadStats(true) }, uiSpan('refresh'), '刷新')
    ));

    const body = el('div', { class: 'gmain-body' });
    main.appendChild(body);

    if (!this.statsData) {
      body.appendChild(el('div', { class: 'empty' },
        el('div', { class: 'spinner' }),
        el('p', { class: 'text-dim', text: '正在汇总游玩记录…' })));
      this.loadStats();
      return;
    }
    const s = this.statsData;
    const grid = el('div', { class: 'stat-grid' });
    const push = (label, value) => grid.appendChild(el('div', { class: 'stat-mini' },
      el('div', { class: 'v', text: value }), el('div', { class: 'k', text: label })));
    push(this.statsPeriod === 'all' ? '累计时长' : '本期时长', s.minutesText || '0 分钟');
    push('游玩场次', String(s.count || 0) + ' 次');
    push('库内总时长', s.totalText || '0 分钟');
    push('累计启动', String(s.playCount || 0) + ' 次');
    push('游戏总数', String(s.gameCount || 0) + ' 款');
    push('目录丢失', String(s.missing || 0) + ' 款');
    body.appendChild(grid);

    /* 本期时长排行 */
    const rank = el('div', { class: 'card stat-card' },
      el('h3', { text: '本期时长排行' }),
      el('p', { class: 'hint', text: '按本期游玩分钟数排序（来自每次启动的自动计时）' })
    );
    const games = Array.isArray(s.games) ? s.games : [];
    if (!games.length) rank.appendChild(el('p', { class: 'text-dim', text: '本期还没有游玩记录。启动任意游戏后会自动计时。' }));
    for (const g of games.slice(0, 12)) {
      rank.appendChild(el('div', { class: 'row' },
        el('span', { class: 'grow ellipsis', text: g.name || g.id }),
        el('span', { class: 'chip', text: g.count + ' 次' }),
        el('span', { class: 'chip accent', text: formatPlayTime(g.minutes) })
      ));
    }
    body.appendChild(rank);

    /* 库内时长总榜 */
    const tops = (s.topMinutes || []).filter((t) => t.minutes > 0);
    const topCard = el('div', { class: 'card stat-card' },
      el('h3', { text: '库内时长总榜' }),
      el('p', { class: 'hint', text: '包含从 Steam 本地数据同步过来的时长' }));
    if (!tops.length) topCard.appendChild(el('p', { class: 'text-dim', text: '还没有时长记录。' }));
    tops.forEach((t, i) => topCard.appendChild(el('div', { class: 'row' },
      el('span', { class: 'no', style: { width: '22px' }, text: String(i + 1) }),
      el('span', { class: 'grow ellipsis', text: t.name }),
      el('span', { class: 'chip', text: t.text })
    )));
    body.appendChild(topCard);
  },

  async loadStats(force) {
    if (this._loadingStats) return;
    if (this.statsData && !force) return;
    this._loadingStats = true;
    if (force) this.statsData = null;
    this.statsData = await API.raw.games.stats(this.statsPeriod).catch(() => null);
    this._loadingStats = false;
    if (this.page === 'stats') this.renderStats();
  },

  /* ============================================================
     页面一：游戏库（工具栏 + 卡片墙 / 列表）
     ============================================================ */
  renderLibrary() {
    const main = clear(this.mainEl);

    const sortSel = el('select', {
      class: 'inp', style: { width: '130px' },
      onchange: (e) => { this.sort = e.target.value; this.reload(); }
    }, [
      ['added:desc', '最近添加'], ['name:asc', '名称 A→Z'], ['name:desc', '名称 Z→A'],
      ['lastPlayed:desc', '最近游玩'], ['size:desc', '占用空间'], ['favorite:desc', '收藏优先']
    ].map(([v, t]) => el('option', { value: v, selected: this.sort === v }, t)));

    /* 工具栏：平时是筛选 / 排序 / 视图；进了批量管理就换成「勾选 → 移除」那一套。
       ⚠️ 批量管理时刻意不给排序 / 视图切换 —— 那些会打乱"我选了哪几个"的心智。 */
    const head = el('div', { class: 'gmain-head' });
    if (this.selectMode) {
      head.appendChild(el('h2', { style: { margin: 0, fontSize: '1.16rem' }, text: '批量管理' }));
      head.appendChild(el('span', { class: 'chip accent', text: '已选 ' + this.selected.size + ' 款' }));
      head.appendChild(el('div', { class: 'grow' }));
      head.appendChild(el('button', { class: 'btn btn-sm', onclick: () => this.selectAllVisible() }, uiSpan('check'), '全选'));
      head.appendChild(el('button', { class: 'btn btn-sm', onclick: () => { this.selected.clear(); this.syncSelectUI(); } }, '清空'));
      head.appendChild(el('button', {
        class: 'btn btn-sm btn-danger', onclick: () => this.removeSelected()
      }, uiSpan('trash'), this.inHidden() ? '批量移出隐藏空间' : '批量移除库'));
      head.appendChild(el('button', { class: 'btn btn-sm', onclick: () => this.exitSelect() }, uiSpan('close'), '退出'));
    } else {
      head.appendChild(el('h2', { style: { margin: 0, fontSize: '1.16rem' }, text: this.inHidden() ? '隐藏空间' : this.filterTitle() }));
      head.appendChild(el('span', { class: 'chip', text: this.list.length + ' 款' }));
      head.appendChild(el('div', { class: 'grow' }));
      head.appendChild(el('button', {
        class: 'btn btn-sm', onclick: () => this.enterSelect()
      }, uiSpan('list'), this.inHidden() ? '批量移出隐藏空间' : '批量移除库'));
      head.appendChild(sortSel);
      head.appendChild(el('div', { class: 'chip', style: { cursor: 'pointer' }, onclick: () => { this.layout = this.layout === 'grid' ? 'list' : 'grid'; this.redrawLibrary(); } },
        uiSpan(this.layout === 'grid' ? 'list' : 'grid'), this.layout === 'grid' ? '列表' : '封面墙'));
      head.appendChild(el('div', { class: 'chip', style: { cursor: 'pointer' }, onclick: () => this.cycleSize() }, '卡片大小'));
      // 「已隐藏 N」只在游戏库页给 —— 在隐藏空间里它没有意义
      if (this.hiddenCount && !this.inHidden()) {
        head.appendChild(el('div', { class: 'chip', style: { cursor: 'pointer' }, onclick: () => this.setPage('hidden') },
          uiSpan('lock'), '已隐藏 ' + this.hiddenCount));
      }
    }
    main.appendChild(head);

    const body = el('div', { class: 'gmain-body' });
    if (!this.list.length) {
      body.appendChild(el('div', { class: 'empty' },
        el('div', { class: 'big', text: this.inHidden() ? '🔐' : '🎮' }),
        el('h3', { text: this.search ? '没有找到匹配的游戏' : (this.inHidden() ? '隐藏空间还是空的' : '游戏库还是空的') }),
        el('p', {
          text: this.search ? '换个关键词试试'
            : (this.inHidden()
              ? '在游戏库里右键任意一款 → 「加入隐藏空间」，或给它挂上「18+」分类，它就会只出现在这里。'
              : '点左下角「扫描本机游戏」自动收录 Steam / Epic 库，或点「添加游戏」手动 / 自动添加。')
        })
      ));
    } else if (this.layout === 'grid') {
      body.appendChild(el('div', { class: 'game-grid', style: { '--card-w': this.cardWidth() } },
        this.list.map((g) => this.card(g))));
    } else {
      body.appendChild(this.listTable());
    }
    main.appendChild(body);
    this.keepDetail();       // clear(mainEl) 顺手把详情层摘了，补回来
  },

  filterTitle() {
    return { all: '全部游戏', recent: '最近游玩', favorite: '我的收藏' }[this.filter] || '游戏';
  },
  cardWidth() { return { small: '132px', medium: '168px', large: '212px', huge: '260px' }[this.cardSize] || '168px'; },
  cycleSize() {
    const order = ['small', 'medium', 'large', 'huge'];
    this.cardSize = order[(order.indexOf(this.cardSize) + 1) % order.length];
    this.redrawLibrary();
  },

  card(g) {
    const plat = window.ICON.platform(g.platform);
    const picked = this.selectMode && this.selected.has(g.id);
    return el('div', {
      class: 'gcard' + (g.missing ? ' missing' : '') + (this.selectMode ? ' selectable' : '') + (picked ? ' picked' : ''),
      dataset: { gid: g.id },          // 勾选时就地改这张卡，不用整页重绘
      title: g.name,
      onclick: (e) => {
        if (e.target.closest('.hb')) return;
        if (this.selectMode) return this.toggleSelect(g.id);
        this.openDetail(g.id);
      },
      ondblclick: (e) => { if (e.target.closest('.hb') || this.selectMode) return; this.launch(g.id); },
      oncontextmenu: (e) => { e.preventDefault(); this.ctxMenu(e, g); }
    },
      el('div', { class: 'gcover', style: { '--pc': g.platformColor } },
        this.coverImg(g, { alt: g.name }),
        // 批量管理：勾选角标（放在封面右上，避开左上角的平台徽标）
        this.selectMode ? el('div', { class: 'pick' + (picked ? ' on' : ''), text: picked ? '✓' : '' }) : null,
        el('div', { class: 'pc-badge', html: plat, title: g.platformName }),
        /* 「运行中」/「启动中…」：后者是协议启动的游戏在等进程出现（第三十二轮） */
        g.running ? el('div', { class: 'run-badge', text: '运行中' })
          : (g.pending ? el('div', { class: 'run-badge pending', text: '启动中…' }) : null),
        g.missing ? el('div', { class: 'miss-badge', text: '目录丢失' }) : null,
        g.coverKind === 'icon' ? el('div', { class: 'kind-badge', text: '图标' }) : null,
        el('div', { class: 'hover-bar' },
          el('button', {
            class: 'hb play' + (g.running || g.pending ? ' run' : ''),
            title: g.running ? '停止' : (g.pending ? '取消启动' : '启动'),
            onclick: (e) => {
              e.stopPropagation();
              if (g.running || g.pending) this.stop(g.id); else this.launch(g.id);
            }
          }, uiSpan(g.running ? 'stop' : 'play', '')),
          /* 第五十三轮：这里原来是「打开目录」，现在换成「打开 MOD」——
             直接跳到独立的 MOD 模块并选中这一款。MOD 插件关掉时退回打开目录，
             按钮名字跟着变（**不能留一个写着「打开 MOD」却打不开的按钮**）。 */
          this.modsPluginOn()
            ? el('button', { class: 'hb', title: '打开 MOD', onclick: (e) => { e.stopPropagation(); this.openMods(g); } }, uiSpan('extension', ''))
            : el('button', { class: 'hb', title: '打开目录', onclick: (e) => { e.stopPropagation(); API.raw.games.openFolder(g.id).catch((x) => window.Shell.toast(x.message, 'err')); } }, uiSpan('folder', '')),
          el('button', { class: 'hb', title: '更多', onclick: (e) => { e.stopPropagation(); this.ctxMenu(e, g); } }, uiSpan('more', ''))
        )
      ),
      el('div', { class: 'gmeta' },
        el('div', { class: 'gname ellipsis', text: g.name }),
        el('div', { class: 'gsub' },
          el('span', { text: g.platformName }),
          el('span', { text: '·' }),
          el('span', { text: g.playTime ? formatPlayTime(g.playTime) : (g.size ? formatBytes(g.size) : '未计算体积') }),
          clearBadge(g)
        )
      )
    );
  },

  listTable() {
    const table = el('div', { class: 'track-list' });
    this.list.forEach((g, i) => {
      const picked = this.selectMode && this.selected.has(g.id);
      table.appendChild(el('div', {
        class: 'track' + (this.selectMode ? ' selectable' : '') + (picked ? ' picked' : ''),
        dataset: { gid: g.id },
        onclick: () => (this.selectMode ? this.toggleSelect(g.id) : this.openDetail(g.id))
      },
        this.selectMode
          ? el('div', { class: 'pick' + (picked ? ' on' : ''), text: picked ? '✓' : '' })
          : el('span', { class: 'no', text: String(i + 1) }),
        el('div', { style: { width: '34px', height: '46px', borderRadius: '6px', overflow: 'hidden', flex: '0 0 auto', background: 'var(--surface-3)' } },
          this.coverImg(g, { style: { width: '100%', height: '100%', objectFit: 'cover' }, placeholder: () => null })),
        el('div', { class: 'tt' },
          el('div', { class: 'n', text: g.name }),
          el('div', { class: 'a', text: g.platformName + ' · ' + catText(g) + (g.missing ? ' · 目录丢失' : '') })
        ),
        el('span', { class: 'dur', html: window.ICON.platform(g.platform), style: { width: '22px', height: '22px' } }),
        el('span', { class: 'dur', text: g.playTime ? formatPlayTime(g.playTime) : (g.size ? formatBytes(g.size) : '—') })
      ));
    });
    return table;
  },

  /* ============================================================
     批量管理（勾选 → 批量移除库）
     ------------------------------------------------------------
     只是「从游戏库里去掉记录」，磁盘上的游戏一个字节都不动，
     所以确认框里写清楚了；移除完自动退出多选、回正常浏览。
     ============================================================ */
  enterSelect() {
    this.selectMode = true;
    this.selected = new Set();
    this.redrawLibrary();
  },
  exitSelect() {
    this.selectMode = false;
    this.selected = new Set();
    this.redrawLibrary();
  },
  /** 清空多选（silent=true 时不重绘，交给紧随其后的 reload） */
  resetSelect(silent) {
    if (!this.selectMode && !this.selected.size) return;
    this.selectMode = false;
    this.selected = new Set();
    if (!silent) this.redrawLibrary();
  },
  /**
   * 勾选 / 取消一个 —— **只改这一张卡 + 计数，不整页重绘**。
   * ⚠️ 整页重绘（`renderLibrary`）会把 `.gmain-body` 重建，滚动条被顶回最上面，
   *    在几十款游戏的长列表里每点一下都跳一次，根本没法连选。
   */
  toggleSelect(id) {
    if (!id) return;
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.syncSelectUI();
  },
  selectAllVisible() {
    for (const g of this.list) this.selected.add(g.id);
    this.syncSelectUI();
  },
  /** 把 `this.selected` 刷到已经画好的 DOM 上（勾选角标 + 「已选 N 款」），零重排 */
  syncSelectUI() {
    for (const node of this.mainEl.querySelectorAll('[data-gid]')) {
      const on = this.selected.has(node.dataset.gid);
      node.classList.toggle('picked', on);
      const p = node.querySelector('.pick');
      if (p) { p.classList.toggle('on', on); p.textContent = on ? '✓' : ''; }
    }
    const chip = this.mainEl.querySelector('.gmain-head .chip.accent');
    if (chip) chip.textContent = '已选 ' + this.selected.size + ' 款';
  },
  /** 重绘游戏库，但保住滚动位置（切视图 / 进退出批量管理时别把用户顶回最上面） */
  redrawLibrary() {
    const box = this.mainEl.querySelector('.gmain-body');
    const keep = box ? box.scrollTop : 0;
    this.renderLibrary();
    const next = this.mainEl.querySelector('.gmain-body');
    if (next) next.scrollTop = keep;
  },
  /**
   * ⚠️ 详情层是 `.gmain` 的子节点，而各处重绘都会先 `clear(mainEl)` ——
   * 一清就把详情层摘出文档，之后 `openDetail` 画在一个游离节点上，
   * 表现就是「点卡片没反应，要重进模块才好」。
   * 所以每处重绘之后都得把它补回来。
   */
  keepDetail() {
    if (this.detailLayer && this.detailLayer.parentNode !== this.mainEl) {
      this.mainEl.appendChild(this.detailLayer);
    }
  },
  async removeSelected() {
    const ids = [...this.selected];
    if (!ids.length) return window.Shell.toast('先勾选要处理的游戏', 'err');

    /* 隐藏空间里的「批量」是**移出隐藏空间**，不是从库里删记录 ——
       在藏东西的地方放一个「删库」按钮，误点的代价太大了。 */
    if (this.inHidden()) {
      const yes = await window.Shell.confirm({
        title: '批量移出隐藏空间',
        message: `把勾选的 ${ids.length} 款移出隐藏空间？`,
        detail: '它们会回到游戏库正常显示。「18+」分类会一起摘掉，游戏记录和磁盘文件都不会动。',
        okText: '移出', cancelText: '取消'
      });
      if (!yes) return;
      const ok = await API.raw.games.setHidden(ids, false).catch((e) => { window.Shell.toast(e.message, 'err'); return null; });
      if (!ok) return;
      window.Shell.toast(`已移出 ${ids.length} 款`, 'ok');
      this.selectMode = false;
      this.selected = new Set();
      await this.refreshCounts();
      await this.reload();
      return;
    }

    const yes = await window.Shell.confirm({
      title: '批量移除库记录',
      message: `把勾选的 ${ids.length} 款从游戏库移除？`,
      detail: '只移除拾光集里的记录，磁盘上的游戏文件一个都不会动，之后重新扫描还能扫回来。',
      okText: '移除', cancelText: '取消'
    });
    if (!yes) return;
    const ok = await API.raw.games.remove(ids).catch((e) => { window.Shell.toast(e.message, 'err'); return null; });
    if (!ok) return;
    window.Shell.toast(`已移除 ${ids.length} 条记录`, 'ok');
    for (const id of ids) delete this._modsMemo[id];
    this.selectMode = false;
    this.selected = new Set();
    await this.refreshCounts();
    await this.reload();
  },

  /* ============================================================
     页面二：平台总览
     ============================================================ */
  renderPlatforms() {
    const main = clear(this.mainEl);
    main.appendChild(el('div', { class: 'gmain-head' },
      el('h2', { style: { margin: 0, fontSize: '1.16rem' }, text: '平台总览' }),
      el('span', { class: 'chip', text: '账号 · 游戏 · 时长 · 成就' }),
      el('div', { class: 'grow' }),
      el('button', { class: 'btn btn-sm', title: '按 Steam 商店的官方分类给库里的 Steam 游戏打上分类（用户手动改过的不会被覆盖）',
        onclick: (e) => this.syncPlatformCats(e.currentTarget) }, uiSpan('download'), '从平台读取分类'),
      el('button', { class: 'btn btn-sm', onclick: () => this.loadPlatforms(true) }, uiSpan('refresh'), '重新检测')
    ));

    const body = el('div', { class: 'gmain-body' });
    main.appendChild(body);

    if (!this.platforms) {
      body.appendChild(el('div', { class: 'empty' },
        el('div', { class: 'spinner' }),
        el('p', { class: 'text-dim', text: '正在读取各平台数据（首次读取 Steam 成就稍慢）…' })));
      this.loadPlatforms();
      return;
    }
    if (this.platforms.__err) {
      body.appendChild(el('div', { class: 'empty' },
        el('div', { class: 'big', text: '⚠️' }),
        el('h3', { text: '读取平台数据失败' }),
        el('p', { text: this.platforms.__err }),
        el('button', { class: 'btn', onclick: () => this.loadPlatforms(true) }, '重试')));
      return;
    }
    const grid = el('div', { class: 'pf-grid' });
    for (const p of this.platforms) grid.appendChild(this.platformCard(p));
    body.appendChild(grid);
    this.keepDetail();
  },

  /* ============================================================
     从平台读取分类（批量）
     ------------------------------------------------------------
     平台（目前是 Steam）自己的分类在本地客户端里读不到 —— 已安装游戏的
     appinfo 里 genres 基本是空的，所以只能去 Steam 商店的公开接口取。
     只**补充**，不覆盖用户手动改过的（主进程 categoryLocked 兜着）。
     ============================================================ */
  async syncPlatformCats(btn) {
    if (!window.Shell) return;
    const info = await API.raw.games.platformCatsInfo().catch((e) => {
      window.Shell.toast(e.message, 'err');
      return null;
    });
    if (!info) return;
    if (!info.total) return window.Shell.toast('库里还没有可读取分类的 Steam 游戏，先去扫描一下', '');

    const yes = await window.Shell.confirm({
      title: '从 Steam 读取游戏分类？',
      message: `${info.total} 款 Steam 游戏等着按平台分类归类：${info.pending} 款要联网读取，${info.cached} 款已有缓存可直接套用。`,
      detail: '分类会**补充**到游戏上（一个游戏可以挂多个分类），你手动改过的不会被覆盖。'
        + (info.pending > 30 ? `\n首次读取 ${info.pending} 款可能要一两分钟。` : ''),
      okText: '开始读取', cancelText: '取消'
    });
    if (!yes) return;

    const old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '读取中…'; }
    window.Shell.status('正在从 Steam 读取游戏分类…');
    const r = await API.raw.games.syncPlatformCats({ force: true })
      .catch((e) => { window.Shell.toast(e.message, 'err'); return null; });
    window.Shell.status('');
    if (btn) { btn.disabled = false; btn.textContent = old; }
    if (!r) return;

    await this.loadCategories().catch(() => {});
    await this.reload();
    if (this.page === 'platforms') this.renderPlatforms();
    const parts = [`已按平台分类更新 ${r.updated || 0} 款`];
    if (r.skipped) parts.push(`${r.skipped} 款 Steam 上没标分类`);
    if (r.failed) parts.push(`${r.failed} 款读取失败`);
    window.Shell.toast(parts.join(' · '), r.updated ? 'ok' : '');
  },

  /** 拉取平台总览（force=true 时忽略缓存重新检测） */
  async loadPlatforms(force) {
    if (this._loadingPlatforms) return;
    if (this.platforms && !force) return;
    this._loadingPlatforms = true;
    if (force) this.platforms = null;
    const opts = force ? { force: true } : (this._steamAccountId ? { steamAccountId: this._steamAccountId } : {});
    const list = await API.raw.platform.overview(opts).catch((e) => ({ __err: e.message }));
    this.platforms = list;
    this._loadingPlatforms = false;
    if (this.page === 'platforms') this.renderPlatforms();
    if (!this._steamSyncTried) {
      this._steamSyncTried = true;
      this.syncSteamBackground();
    }
  },

  /** 缓慢的 Steam 账号库同步放后台做，先把本机记录画出来，成功后再刷一次 */
  async syncSteamBackground() {
    try {
      const r = await API.raw.platform.syncSteam();
      if (!r || !r.ok || !r.count) return;
      this.platforms = null;
      this.pfData = null;
      if (this.page === 'platforms') this.loadPlatforms(false);
      else if (this.page === 'platform') this.loadPlatformDetail(false);
    } catch { /* 私密资料 / 断网：保持本机记录 */ }
  },

  /**
   * 平台卡片
   * 🔴 整张卡片要能点进去（用户原话：「游戏平台点不进去」）——
   *    里面的按钮 / 下拉必须 stopPropagation，否则点「打开客户端」会顺带跳页。
   */
  platformCard(p) {
    const st = p.stats || {};
    const card = el('div', {
      class: 'pf-card pf-card-click' + (p.installed ? '' : ' off'),
      title: '查看 ' + p.name + ' 的游戏',
      onclick: () => this.openPlatform(p.id)
    });

    card.appendChild(el('div', { class: 'pf-head' },
      el('div', { class: 'pf-ico', html: window.ICON.platform(p.id) }),
      el('div', { class: 'pf-title' },
        el('div', { class: 'pf-name', text: p.name }),
        el('div', { class: 'pf-sub' },
          el('span', { class: 'pf-dot' + (p.installed ? '' : ' off') }),
          p.installed ? '已检测到' : '未检测到客户端')),
      el('div', { class: 'grow' }),
      p.clientPath
        ? el('button', {
            class: 'btn btn-sm', title: p.clientPath,
            onclick: (e) => { e.stopPropagation(); API.raw.platform.openClient(p.id).catch((er) => window.Shell.toast(er.message, 'err')); }
          }, uiSpan('rocket'), '打开')
        : null,
      el('span', { class: 'pf-go', text: '›' })
    ));

    /* 账号 */
    if (p.id === 'steam') {
      const accounts = p.accounts || [];
      const picked = p.account;
      if (accounts.length) {
        const sel = el('select', { class: 'inp', onclick: (e) => e.stopPropagation(), onchange: (e) => {
          e.stopPropagation();
          const id = e.target.value;
          this.loadPlatformsFor(id);
        } }, accounts.map((a) => el('option', {
          value: a.accountId, selected: picked && a.accountId === picked.accountId
        }, `${a.personaName}（${a.accountName || a.accountId}）${a.autoLogin ? ' · 自动登录' : ''}`)));
        card.appendChild(el('div', { class: 'pf-row', onclick: (e) => e.stopPropagation() },
          el('span', { class: 'pf-label', text: '账号' }), sel));
        if (picked) {
          card.appendChild(el('div', { class: 'pf-actions' },
            el('button', {
              class: 'btn btn-sm btn-primary',
              title: '时长 / 成就 / 封面 / 分类 / MOD 一起刷新',
              onclick: (e) => { e.stopPropagation(); this.syncSteamAccount(picked.accountId, e.currentTarget); }
            }, uiSpan('refresh'), '同步到游戏库'),
            el('span', { class: 'pf-hint text-dim', text: '时长 · 封面 · 分类 · MOD 一起刷新' })
          ));
        }
      } else {
        card.appendChild(el('div', { class: 'pf-row pf-empty', text: '未读到 Steam 登录账号（需要 config/loginusers.vdf）' }));
      }
    } else {
      card.appendChild(el('div', { class: 'pf-row pf-empty', text: p.note || '该平台不提供本机账号信息' }));
    }

    /* 统计 */
    const stats = el('div', { class: 'pf-stats' });
    const push = (label, value) => stats.appendChild(el('div', { class: 'pf-stat' },
      el('div', { class: 'v', text: value }), el('div', { class: 'k', text: label })));
    push('库内游戏', String(st.libraryGames != null ? st.libraryGames : st.games || 0));
    if (st.games != null && st.games !== st.libraryGames) push('本机安装', String(st.games));
    push('游玩时长', st.playtime ? formatPlayTime(st.playtime) : '—');
    push('成就', st.achievements ? `${st.achievements.unlocked}/${st.achievements.total}` : '—');
    push('占用空间', st.size ? formatBytes(st.size) : '—');
    card.appendChild(stats);

    /* 路径 */
    if (p.installPath) {
      card.appendChild(el('div', { class: 'pf-path mono ellipsis', title: p.installPath, text: p.installPath }));
    }
    return card;
  },

  async loadPlatformsFor(accountId) {
    this._steamAccountId = accountId;
    this.platforms = null;
    if (this.page === 'platforms') this.renderPlatforms();
    if (this.page === 'platform') this.loadPlatformDetail(true);
    await this.loadPlatforms();
  },

  /* ============================================================
     页面：平台详情（点平台卡片进来）
     ------------------------------------------------------------
     Steam 走**本机 Steam 库**（已安装 ∪ 本机有记录），所以没装的游戏也在列表里 ——
     「点进 Steam 只看到自己库里那几款」等于没点进去，用户要的就是这个。
     ============================================================ */
  openPlatform(id) {
    this.platformId = id;
    if (this.page === 'platform') { this.pfData = null; this.renderPlatform(); return; }
    this.setPage('platform');
  },

  async loadPlatformDetail(force) {
    if (this._loadingPf) return;
    this._loadingPf = true;
    if (force) this.pfData = null;
    if (force && this.platformId === 'steam') {
      await API.raw.platform.syncSteam().catch(() => null);
    }
    const opts = { platformId: this.platformId, force: !!force };
    if (this.platformId === 'steam' && this._steamAccountId) opts.steamAccountId = this._steamAccountId;
    const d = await API.raw.platform.detail(opts).catch((e) => ({ __err: e.message }));
    this.pfData = d;
    this._loadingPf = false;
    if (this.page === 'platform') this.renderPlatform();
    if (!force && this.platformId === 'steam' && !this._steamSyncTried) {
      this._steamSyncTried = true;
      this.syncSteamBackground();
    }
  },

  /** 平台详情里的筛 + 排 + 搜，全在前端做（数据已经拉全了，没必要来回问主进程） */
  _pfGames(d) {
    const kw = (this.pfSearch || '').trim().toLowerCase();
    let list = (d.games || []).slice();
    if (this.pfFilter === 'installed') list = list.filter((g) => g.installed);
    else if (this.pfFilter === 'notinstalled') list = list.filter((g) => !g.installed);
    if (kw) list = list.filter((g) => String(g.name || '').toLowerCase().includes(kw)
      || String(g.appid || '').includes(kw));
    const by = this.pfSort;
    list.sort((x, y) => (y.installed ? 1 : 0) - (x.installed ? 1 : 0)
      || (by === 'name' ? String(x.name).localeCompare(String(y.name))
        : by === 'lastPlayed' ? (y.lastPlayed || 0) - (x.lastPlayed || 0)
          : (y.playtime || 0) - (x.playtime || 0)));
    return list;
  },

  renderPlatform() {
    const main = clear(this.mainEl);
    const meta = (this.platforms || []).find((p) => p.id === this.platformId) || {};
    const name = meta.name || (this.platformId === 'steam' ? 'Steam' : this.platformId);

    main.appendChild(el('div', { class: 'gmain-head' },
      el('button', { class: 'btn btn-sm', onclick: () => this.setPage('platforms') }, '‹ 平台总览'),
      el('div', { class: 'pf-ico', html: window.ICON.platform(this.platformId) }),
      el('h2', { style: { margin: 0, fontSize: '1.16rem' }, text: name }),
      el('span', { class: 'chip', text: this.platformId === 'steam' ? '本机 Steam 库' : '拾光集游戏库' }),
      this.platformId === 'steam' && this.pfData
        ? el('span', {
          class: 'chip',
          title: this.pfData.accountLibrary ? '已同步 Steam 账号完整库' : '账号库未同步，当前只显示本机记录；点「重新读取」再试',
          text: this.pfData.accountLibrary ? '账号完整库' : '本机记录'
        }) : null,
      el('div', { class: 'grow' }),
      el('button', { class: 'btn btn-sm', onclick: () => this.loadPlatformDetail(true) }, uiSpan('refresh'), '重新读取')
    ));

    const body = el('div', { class: 'gmain-body' });
    main.appendChild(body);

    if (!this.pfData) {
      body.appendChild(el('div', { class: 'empty' },
        el('div', { class: 'spinner' }),
        el('p', { class: 'text-dim', text: '正在读取 ' + name + ' 的游戏清单…' })));
      this.loadPlatformDetail();
      this.keepDetail();
      return;
    }
    if (this.pfData.__err) {
      body.appendChild(el('div', { class: 'empty' },
        el('div', { class: 'big', text: '⚠️' }),
        el('h3', { text: '读取失败' }),
        el('p', { text: this.pfData.__err }),
        el('button', { class: 'btn', onclick: () => this.loadPlatformDetail(true) }, '重试')));
      this.keepDetail();
      return;
    }

    const d = this.pfData;

    /* 账号切换（Steam） */
    if (this.platformId === 'steam' && (d.accounts || []).length) {
      body.appendChild(el('div', { class: 'pf-detail-row' },
        el('span', { class: 'pf-label', text: '账号' }),
        el('select', { class: 'inp', onchange: (e) => this.loadPlatformsFor(e.target.value) },
          (d.accounts || []).map((a) => el('option', {
            value: a.accountId, selected: d.account && a.accountId === d.account.accountId
          }, `${a.personaName}（${a.accountName || a.accountId}）${a.autoLogin ? ' · 自动登录' : ''}`))),
        el('div', { class: 'grow' }),
        d.account ? el('button', {
          class: 'btn btn-sm', title: '把时长 / 成就 / 封面刷进拾光集库',
          onclick: (e) => this.syncSteamAccount(d.account.accountId, e.currentTarget)
        }, uiSpan('refresh'), '同步到游戏库') : null));
    }

    /* 概览数字 */
    const shown = this._pfGames(d);
    const stats = el('div', { class: 'pf-stats' });
    const push = (label, value) => {
      const v = el('div', { class: 'v', text: value });
      stats.appendChild(el('div', { class: 'pf-stat' }, v, el('div', { class: 'k', text: label })));
      return v;
    };
    push('库内游戏', String(d.total || 0));
    push('本机安装', String(d.installedCount || 0));
    this._pfCountNode = push('当前显示', String(shown.length));
    push('累计时长', d.playtime ? formatPlayTime(d.playtime) : '—');
    body.appendChild(el('div', { class: 'pf-detail-row' }, stats));

    /* 筛选 / 排序 / 搜索 */
    body.appendChild(el('div', { class: 'pf-detail-row pf-toolbar' },
      el('div', { class: 'gside-nav', style: { margin: 0 } },
        [['all', '全部'], ['installed', '已安装'], ['notinstalled', '未安装']].map(([k, t]) =>
          el('span', { class: 'chip' + (this.pfFilter === k ? ' on' : ''), onclick: () => { this.pfFilter = k; this.renderPlatform(); } }, t))),
      el('select', { class: 'inp', onchange: (e) => { this.pfSort = e.target.value; this.renderPlatform(); } },
        [['playtime', '按游玩时长'], ['lastPlayed', '按最近游玩'], ['name', '按名称']].map(([v, t]) =>
          el('option', { value: v, selected: this.pfSort === v }, t))),
      el('div', { class: 'field', style: { maxWidth: '280px' } },
        uiSpan('search'),
        el('input', {
          type: 'text', placeholder: '搜索游戏…', value: this.pfSearch,
          // 🔴 打字时只重画下面那张网格，绝不整页重画 ——
          //   整页重画会连这个输入框一起重建，打一个字就失焦一次（音乐模块栽过一次）
          oninput: (e) => { this.pfSearch = e.target.value; this._repaintPfGrid(); }
        }))
    ));

    if (d.note) body.appendChild(el('p', { class: 'text-dim', style: { margin: '4px 2px 0' }, text: d.note }));

    this._pfGrid = el('div', { class: 'pf-games' });
    this._pfBody = body;
    this._pfShown = shown;
    this._pfDataRef = d;
    this._paintPfGrid();
    body.appendChild(this._pfGrid);
    this.keepDetail();
  },

  /** 只重画平台详情的游戏网格（搜索 / 筛选后用，输入框不会失焦） */
  _repaintPfGrid() {
    if (!this._pfGrid || !this._pfDataRef) return;
    this._pfShown = this._pfGames(this._pfDataRef);
    if (this._pfCountNode) this._pfCountNode.textContent = String(this._pfShown.length);
    this._paintPfGrid();
  },

  _paintPfGrid() {
    const grid = clear(this._pfGrid);
    const list = this._pfShown || [];
    if (!list.length) {
      grid.appendChild(el('div', { class: 'empty', style: { gridColumn: '1/-1' } },
        el('div', { class: 'big', text: '🎮' }),
        el('p', { class: 'text-dim', text: '没有匹配的游戏' })));
      return;
    }
    for (const g of list) grid.appendChild(this.platformGameCard(g, this._pfDataRef));
  },

  platformGameCard(g, d) {
    const badge = g.installed
      ? el('span', { class: 'pg-badge on', text: '已安装' })
      : el('span', { class: 'pg-badge', text: '未安装' });
    const bits = [];
    if (g.playtime) bits.push(formatPlayTime(g.playtime));
    if (g.size) bits.push(formatBytes(g.size));
    if (g.achievements) bits.push(`成就 ${g.achievements.unlocked}/${g.achievements.total}`);
    /* 「未安装」的卡片：鼠标移上去在卡片**下面**滑出一条「安装」按钮，
       点一下就 `steam://install/<appid>` 把 Steam 的下载框拉起来。
       ⚠️ 只有 Steam 有这套协议 —— 别的平台不画这个条，免得点了没反应。 */
    const canInstall = !g.installed && d && d.id === 'steam';
    return el('div', {
      class: 'pg-card' + (g.installed ? '' : ' off'),
      title: g.name,
      onclick: () => {
        // 库里有的点进我们自己的详情；装了的直接让 Steam 拉起来；都没装就提示用悬停的「安装」
        if (g.gid) { this.openDetail(g.gid); return; }
        if (g.installed && d.id === 'steam') {
          API.raw.platform.openApp(g.appid, 'steam').catch((e) => window.Shell.toast(e.message, 'err'));
          return;
        }
        window.Shell.toast(canInstall ? '还没装到本机 —— 鼠标移到卡片上，点下面的「安装」让 Steam 开始下载' : '这款还没装到本机，也没加进拾光集游戏库', '');
      }
    },
      el('div', { class: 'pg-cover' },
        g.cover
          ? el('img', {
              src: g.cover, alt: '', loading: 'lazy',
              // 图挂了就退回占位，别留一块空白（平台库里 appid 与 CDN 对不上的款不少）
              onerror: (e) => {
                const p = e.target.parentElement;
                e.target.remove();
                if (p && !p.querySelector('.pg-ph')) p.appendChild(el('span', { class: 'pg-ph text-dim', text: '🎮' }));
              }
            })
          : el('span', { class: 'pg-ph text-dim', text: '🎮' }),
        badge),
      el('div', { class: 'pg-main' },
        el('div', { class: 'pg-name ellipsis', text: g.name }),
        el('div', { class: 'pg-sub ellipsis', text: bits.join(' · ') || '还没玩过' }),
        el('div', { class: 'pg-tail' },
          g.inLibrary ? el('span', { class: 'chip', text: '在拾光集库里' }) : null,
          g.lastPlayed ? el('span', { class: 'text-dim', text: timeAgo(g.lastPlayed) }) : null)),
      canInstall ? el('div', { class: 'pg-install' },
        el('button', {
          class: 'pg-install-btn', title: `用 Steam 下载安装「${g.name}」`,
          // ⚠️ 一定要 stopPropagation：卡片本身也绑了 click，不拦会顺带跳详情/弹提示
          onclick: (e) => { e.stopPropagation(); this.installGame(g); }
        }, uiSpan('download'), el('span', { text: '安装' }))
      ) : null
    );
  },

  /** 未安装卡片的「安装」：把 Steam 的下载框拉起来 */
  async installGame(g) {
    if (!g) return;
    try {
      const r = await API.raw.platform.install(g.appid, 'steam');
      window.Shell.toast(`已唤起 Steam 开始下载「${g.name}」`, 'ok');
      return r;
    } catch (e) {
      window.Shell.toast(`没能唤起 Steam：${(e && e.message) || e}`, 'err');
    }
  },


  /* ============================================================
     Steam「同步到游戏库」
     ------------------------------------------------------------
     一次刷全：时长 / 成就 → 封面 → 分类（标签）→ MOD。
     用户点的是「同步」，不可能只想要「时长是新的、封面和标签还是旧的」。
     主进程按阶段 fire `games:sync-progress`，这里把它显示到底部状态栏。
     ============================================================ */
  async syncSteamAccount(accountId, btn) {
    if (!window.Shell) return;
    if (this._syncing) return window.Shell.toast('正在同步中，稍等一下');
    this._syncing = true;
    const old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '同步中…'; }

    const PHASE = { covers: '封面', cats: '分类', mods: 'MOD' };
    const off = API.on('games:sync-progress', (p) => {
      if (!p || p.phase === 'done') return;
      const label = PHASE[p.phase] || '';
      window.Shell.status(`正在同步${label}${p.total ? `（${p.done || 0}/${p.total}）` : ''}${p.name ? '：' + p.name : ''}`);
    });

    window.Shell.status('正在同步 Steam 数据…');
    const r = await API.raw.platform.applySteam(accountId)
      .catch((e) => { window.Shell.toast(e.message, 'err'); return null; });
    if (typeof off === 'function') off();
    window.Shell.status('');
    this._syncing = false;
    if (btn) { btn.disabled = false; btn.textContent = old; }
    if (!r) return;

    // 不要在这里清 this.list —— 当前页是「平台总览」，reload() 不会重取列表，
    // 清了之后就一直是空的（曾经的表现：同步一下游戏全没了）。
    await this.reload();
    this.loadPlatforms(true);

    const m = r.mods || {};
    const bits = [
      r.updated ? `${r.updated} 款时长 / 成就更新` : '时长 / 成就已是最新',
      `封面 ${r.covers || 0} 张`,
      `分类 ${r.cats || 0} 款`,
      m.games ? (m.total ? `MOD ${m.total} 个${m.changed ? `（${m.changed} 款有变化）` : ''}` : 'MOD 已重扫') : ''
    ].filter(Boolean);
    window.Shell.toast(`同步完成：${bits.join(' · ')}`, 'ok');
  },

  /* ============================================================
     页面三：隐藏空间（内嵌，密码门禁，藏 18+ 游戏）
     ============================================================ */
  async renderHidden() {
    const main = clear(this.mainEl);

    /* 先问一句状态：没启用 / 锁着 → 摆门禁；已解锁 → **直接走游戏库那套渲染**。
       🔴 这里绝不能再自己画一套游戏列表 —— 隐藏空间不是独立模块，
          它「多出来的」只有一道密码（见 modules/hidden.js 顶部的说明）。 */
    const info = await API.raw.hidden.info().catch(() => null);
    this.hiddenInfo = info;

    if (!info || !info.enabled || !info.unlocked) {
      const box = el('div', { class: 'hs-embed' });
      main.appendChild(box);
      if (window.HiddenSpace && window.HiddenSpace.mountGate) {
        window.HiddenSpace.mountGate(box, {
          embedded: true,
          onBack: () => this.setPage('library'),
          // 解锁成功 / 自动上锁 → 回来重画一次（门禁 ↔ 游戏列表 的切换全靠它）
          onChange: () => this.reload()
        });
      } else {
        box.appendChild(el('div', { class: 'empty' },
          el('div', { class: 'big', text: '🔐' }),
          el('h3', { text: '隐藏空间不可用' }),
          el('p', { text: '组件未加载。' })));
      }
      // 门禁页没有列表，把详情层补回来（clear 顺手摘了它）
      if (this.detailLayer && this.detailLayer.parentNode !== this.mainEl) this.mainEl.appendChild(this.detailLayer);
      return;
    }

    this.renderLibrary();
  },

  /* ============================================================
     详情页
     ============================================================ */
  async openDetail(id) {
    /* 兜底：当前列表里没有就去全库捞。
       ⚠️ 范围必须和当前页一致 —— 隐藏空间里用 view:'all' 是**永远捞不到**的
       （那个视图会把 hidden 的滤掉），表现就是「点卡片没反应」。 */
    const g = this.list.find((x) => x.id === id)
      || (await API.raw.games.list({ scope: this.inHidden() ? 'hidden' : 'normal' }).catch(() => []))
        .find((x) => x.id === id);
    if (!g) return;
    // 同一款游戏重进详情（比如刚换完封面）时，保留原来的标签页，别把用户弹回概览
    const sameGame = this.currentId === id;
    this.currentId = id;
    if (!sameGame) this._detailTab = 'overview';
    // ⚠️ 这里**不能** renderSide()：重建左侧列表会把滚动位置顶回最上面，
    //    表现为「点一款游戏，左列表自己跳回顶部」。只搬高亮就够了。
    if (this.page === 'library') this.syncSideActive();
    const layer = clear(this.detailLayer);
    layer.hidden = false;
    layer.className = 'gdetail';
    const hero = el('div', { class: 'gdetail-hero' },
      this.coverImg(g, { class: 'bg', eager: true, placeholder: () => null }),
      el('div', { class: 'veil' }),
      el('div', { class: 'htop' },
        // 返回也一样：只撤高亮，别重建列表（否则滚动位置又被顶回最上面）
        el('button', { class: 'back-btn', onclick: () => { layer.hidden = true; this.currentId = ''; this.syncSideActive(); } }, uiSpan('back'), '返回')
      ),
      el('div', { class: 'gdetail-id' },
        el('div', { class: 'cover' }, this.coverImg(g, { placeholder: () => null })),
        el('div', { class: 'idtext' },
          el('h1', { text: g.name }),
          /* 游玩时间 / 成就 —— 参考图里这两个是「数值 + 说明」的独立统计块 */
          el('div', { class: 'dstats' },
            statPill(g.playTime ? formatPlayTime(g.playTime) : '未玩过', '游玩时间', 'clock'),
            statPill(g.achievements && g.achievements.total
              ? `${g.achievements.unlocked}/${g.achievements.total}` : '—', '成就', 'star'),
            g.playCount ? statPill(String(g.playCount) + ' 次', '启动次数', 'play') : null
          ),
          el('div', { class: 'meta' },
            el('span', { class: 'chip accent' }, el('span', { class: 'glist-play', html: window.ICON.platform(g.platform) }), g.platformName),
            /* 一个游戏可以挂多个分类 —— 每个分类一个 chip */
            ...catsOf(g).map((c) => el('span', { class: 'chip cat-chip-hero', text: c })),
            catsOf(g).length ? null : el('span', { class: 'chip', text: '未分类' }),
            g.missing ? el('span', { class: 'chip danger', text: '目录丢失' }) : null,
            el('span', { class: 'chip', text: g.size ? formatBytes(g.size) : '未计算体积' }),
            g.lastPlayed ? el('span', { class: 'chip', text: '最近 ' + timeAgo(g.lastPlayed) }) : null
          )
        )
      )
    );
    const tabsBar = el('div', { class: 'gdetail-tabs' });
    const body = el('div', { class: 'gdetail-body' });
    /* 第五十三轮：「模组」不再是详情页里的一个页签内容，而是**通往 MOD 模块的入口**。
       MOD 插件关掉时这个页签整个不出现 —— 否则点进去是一条死路。 */
    const modsOn = this.modsPluginOn();
    const tabs = [['overview', '概览']]
      .concat(modsOn ? [['mods', '模组']] : [])
      .concat([['settings', '设置']]);
    let active = this._detailTab || 'overview';
    /* 🔴 「模组」只负责跳转，详情页里没有它的内容 → 任何时候都不许停在它上面。
       （插件关掉时页签根本不画，`_detailTab` 却可能还是上次的 'mods'，所以这句两个场景都要） */
    if (active === 'mods') active = 'overview';

    /* 操作按钮行：紧贴横幅下方（跟 Steam 和参考图一致），不再吊在页面底部 */
    /* 通关状态分段控件：三档固定顺序，入库默认「未通关」，没有「未标记」这一档 */
    const clearSeg = el('div', { class: 'clear-seg', role: 'group', 'aria-label': '通关状态' });
    const drawClear = () => {
      clear(clearSeg);
      const cur = clearOf(g);
      for (const k of CLEAR_ORDER) {
        const m = CLEAR_META[k];
        const on = cur === k;
        clearSeg.appendChild(el('button', {
          class: 'cs-item cc-' + k + (on ? ' on' : ''),
          title: on ? `当前就是「${m.label}」` : `标记为「${m.label}」`,
          onclick: async () => {
            if (on) { window.Shell.toast(`已经是「${m.label}」了`); return; }
            const r = await API.raw.games.update(g.id, { clearState: k }, { silent: true })
              .catch((e) => { window.Shell.toast(e.message, 'err'); return null; });
            if (!r) return;
            g.clearState = r.clearState;
            drawClear();
            window.Shell.toast('已标记为' + m.label, 'ok');
            this.reload();          // 卡片 / 列表上的角标要跟着变
          }
        },
          // 只有当前档位带图标（参考图就是这样）—— 否则「✓通关」和「✓未通关」会同时出现，看着像两个都选中了
          on ? el('span', { class: 'cs-ic', text: m.icon }) : null,
          el('span', { class: 'cs-t', text: m.label })));
      }
    };
    drawClear();

    const bar = el('div', { class: 'gdetail-bar' },
      /* 运行中/启动中时这个按钮变成「停止 / 取消启动」—— 以前协议启动的游戏不进 running，
         按钮永远是「启动游戏」，点几次就开几个（用户反馈的那条） */
      el('button', {
        class: 'btn' + (g.running || g.pending ? '' : ' btn-primary'),
        id: 'gDetailRunBtn',
        onclick: () => { if (g.running || g.pending) this.stop(g.id); else this.launch(g.id); }
      }, uiSpan('play'), g.running ? '停止游戏' : (g.pending ? '取消启动' : '启动游戏')),
      clearSeg,
      el('button', { class: 'btn', onclick: () => API.raw.games.openFolder(g.id).catch((e) => window.Shell.toast(e.message, 'err')) }, uiSpan('folder'), '打开目录'),
      el('button', { class: 'btn', onclick: async () => {
        await API.raw.games.update(g.id, { favorite: !g.favorite }, { silent: true });
        g.favorite = !g.favorite;
        window.Shell.toast(g.favorite ? '已收藏' : '已取消收藏');
        await this.reload();
        this.openDetail(g.id);
      } }, g.favorite ? '★ 已收藏' : '☆ 收藏'),
      el('button', { class: 'btn', onclick: async () => {
        const s = await API.raw.games.calcSize(g.id).catch(() => 0);
        window.Shell.toast('占用 ' + formatBytes(s));
        this.reload();
      } }, uiSpan('save'), '计算体积'),
      el('button', { class: 'btn', onclick: () => { active = 'settings'; this._detailTab = 'settings'; renderTab(); renderBody(); } }, uiSpan('settings'), '编辑信息'),
      el('div', { class: 'grow', style: { flex: 1 } }),
      el('button', { class: 'btn btn-ghost', onclick: async () => {
        if (g.hidden) { window.Shell.toast('这款游戏已经在隐藏空间里了', 'ok'); return; }
        const yes = await window.Shell.confirm({
          title: '加入隐藏空间？',
          message: '加入后它只会在「隐藏空间」里出现，需要密码才能看到。'
        });
        if (!yes) return;
        await API.raw.games.setHidden([g.id], true).catch((e) => window.Shell.toast(e.message, 'err'));
        layer.hidden = true;
        this.currentId = '';
        await this.reload();
        window.Shell.toast('已加入隐藏空间', 'ok');
      } }, uiSpan('lock'), '加入隐藏空间')
    );
    const renderTab = () => {
      clear(tabsBar);
      tabs.forEach(([k, t]) => tabsBar.appendChild(el('button', {
        class: 'tab' + (active === k ? ' on' : ''),
        title: k === 'mods' ? 'MOD 已独立成一个模块，点这里带这款游戏过去' : '',
        onclick: () => {
          /* 「模组」= 跳转到 MOD 模块（带游戏 id）。⚠️ 跳之前把详情层收掉，
             否则回来时它还是开着的，看着像点错了。 */
          if (k === 'mods') {
            layer.hidden = true;
            this.openMods(g);
            return;
          }
          active = k; this._detailTab = k; renderTab(); renderBody();
        }
      }, t)));
    };
    const renderBody = async () => {
      clear(body);
      if (active === 'overview') {
        const cols = el('div', { class: 'gcols' });
        const colMain = el('div', { class: 'gcol-main' });
        const colSide = el('div', { class: 'gcol-side' });

        if (g.missing) {
          colMain.appendChild(el('div', { class: 'card danger-card' },
            el('h3', { text: '⚠️ 安装目录找不到了' }),
            el('p', { class: 'hint', text: '这个游戏记录指向的目录已不存在（可能被移动或删除了）。' }),
            el('div', { class: 'row' },
              el('button', { class: 'btn btn-sm', onclick: async () => { await API.raw.games.calcSize(g.id); const r = await API.raw.games.patrol().catch(() => null); if (r) window.Shell.toast(`巡检完成：${r.missing} 款目录丢失`); this.openDetail(g.id); } }, '重新巡检'),
              el('button', { class: 'btn btn-sm', onclick: () => this.openDetail(g.id) }, '知道了')
            )
          ));
        }

        colMain.appendChild(el('div', { class: 'card' },
          el('h3', { text: '路径信息' }),
          el('p', { class: 'hint', text: '游戏安装目录与启动程序' }),
          el('div', { class: 'row' }, el('span', { class: 'label', text: '安装目录' }), el('span', { class: 'grow mono ellipsis', title: g.path, text: g.path || '未设置' })),
          el('div', { class: 'row' }, el('span', { class: 'label', text: '启动程序' }), el('span', { class: 'grow mono ellipsis', title: g.launch, text: g.launch || '未设置' })),
          g.launchArgs ? el('div', { class: 'row' }, el('span', { class: 'label', text: '启动参数' }), el('span', { class: 'grow mono', text: g.launchArgs })) : null,
          g.note ? el('div', { class: 'row' }, el('span', { class: 'label', text: '备注' }), el('span', { class: 'grow', text: g.note })) : null
        ));

        const mine = await this.recentSessions(g.id);
        const sessCard = el('div', { class: 'card', style: { marginTop: '12px' } },
          el('h3', { text: '最近游玩记录' }),
          el('p', { class: 'hint', text: '每次启动自动计时，退出时结算分钟数' }));
        if (!mine.length) sessCard.appendChild(el('p', { class: 'text-dim', text: '还没有游玩记录。' }));
        for (const s of mine) {
          sessCard.appendChild(el('div', { class: 'row' },
            el('span', { class: 'grow', text: new Date(s.start).toLocaleString('zh-CN') }),
            el('span', { class: 'chip accent', text: formatPlayTime(s.minutes) })));
        }
        colMain.appendChild(sessCard);

        /* 右栏：详情信息（对应参考图右侧那块） */
        const infoRow = (label, value) => el('div', { class: 'info-row' },
          el('span', { class: 'il', text: label }),
          el('span', { class: 'iv', title: String(value == null ? '' : value), text: String(value == null || value === '' ? '—' : value) }));
        colSide.appendChild(el('div', { class: 'card' },
          el('h4', { class: 'card-title', text: '详情信息' }),
          infoRow('平台', g.platformName),
          infoRow('分类', catText(g, ' / ')),
          g.catSource ? infoRow('分类来源', { user: '手动指定', platform: '平台读取', auto: '自动归类' }[g.catSource] || g.catSource) : null,
          infoRow('通关状态', CLEAR_META[clearOf(g)].label),
          infoRow('来源', { steam: 'Steam 库', epic: 'Epic', registry: '注册表扫描', manual: '手动添加', archive: '压缩包安装', local: '本地扫描' }[g.source] || g.source || '—'),
          infoRow('占用空间', g.size ? formatBytes(g.size) : '未计算'),
          infoRow('游玩时长', formatPlayTime(g.playTime)),
          infoRow('启动次数', String(g.playCount || 0) + ' 次'),
          infoRow('成就', g.achievements && g.achievements.total ? `${g.achievements.unlocked} / ${g.achievements.total}` : '无'),
          infoRow('发行商', g.publisher || '—'),
          infoRow('版本', g.version || '—'),
          infoRow('安装日期', g.installDate || '—'),
          infoRow('封面来源', { custom: '自定义', local: '本地缓存', steam: 'Steam 官方', icon: 'exe 图标', none: '无' }[g.coverKind] || '无'),
          infoRow('最近游玩', g.lastPlayed ? timeAgo(g.lastPlayed) : '—')
        ));

        cols.appendChild(colMain);
        cols.appendChild(colSide);
        body.appendChild(cols);
      } else {
        /* ⚠️ 第五十三轮起这里**没有** 'mods' 分支了：模组已经是独立模块的页面，
           详情页只负责把用户送过去（见 renderTab 里那个跳转）。 */
        /* 分类是**多值**：已选的画成一排可删的 chip，右边一个下拉往里加。 */
        const catChips = el('div', { class: 'cat-picked' });
        const drawCatChips = () => {
          clear(catChips);
          const cur = g.categories && g.categories.length ? g.categories : [];
          if (!cur.length) catChips.appendChild(el('span', { class: 'text-dim', style: { fontSize: '.82em' }, text: '未分类' }));
          for (const c of cur) {
            const adult = c === ADULT_CAT;
            catChips.appendChild(el('span', {
              class: 'cat-tag' + (adult ? ' adult' : ''),
              title: adult ? '18+ 标记：这款游戏在隐藏空间里，点 × 就放回游戏库' : ''
            },
              el('span', { text: adult ? '🔞 18+' : c }),
              el('span', {
                class: 'x', title: adult ? '取消 18+（放回游戏库）' : '移出这个分类', text: '×',
                onclick: async () => {
                  const next = (g.categories || []).filter((x) => x !== c);
                  await saveCats(next, '已移出「' + c + '」');
                }
              })));
          }
        };
        const saveCats = async (next, tip) => {
          const wasAdult = (g.categories || []).includes(ADULT_CAT);
          const r = await API.raw.games.setCategories(g.id, next)
            .catch((e) => { window.Shell.toast(e.message, 'err'); return null; });
          if (!r) return;
          g.categories = r.categories || [];
          g.category = r.category || '未分类';
          g.categoryLocked = true;
          g.catSource = 'user';
          g.hidden = !!r.hidden;
          const isAdult = g.categories.includes(ADULT_CAT);
          const moved = wasAdult !== isAdult;
          drawCatChips(); drawCatAdd();
          await this.loadCategories();
          if (tip) window.Shell.toast(tip, 'ok');
          if (moved) {
            if (isAdult) {
              // 18+ = 进隐藏空间。游戏马上就不在游戏库列表里了，所以把详情页收掉并说清楚去哪找
              window.Shell.toast('已标记 18+，这款游戏已放进隐藏空间', 'ok');
              layer.hidden = true;
              this.currentId = '';
              await this.reload();
              this.renderSide();
              return;
            }
            window.Shell.toast('已取消 18+，这款游戏回到游戏库了', 'ok');
          }
          this.reload();
        };
        const catAdd = el('select', { class: 'inp', style: { width: '132px' } });
        const drawCatAdd = () => {
          clear(catAdd);
          catAdd.appendChild(el('option', { value: '' }, '＋ 添加分类'));
          for (const c of this.cats) {
            if (c === '未分类' || c === ADULT_CAT) continue;
            if ((g.categories || []).includes(c)) continue;
            catAdd.appendChild(el('option', { value: c }, c));
          }
          /* 「18+」永远在列表里（它就是隐藏空间的开关，不该等哪个游戏用过才出现），
             但放在普通分类**之后**：它不是个普通分类 —— 挂上等于把游戏丢进隐藏空间，
             摆在第一个太容易点错。 */
          if (!(g.categories || []).includes(ADULT_CAT)) {
            catAdd.appendChild(el('option', { value: ADULT_CAT }, '18+（放进隐藏空间）'));
          }
          catAdd.appendChild(el('option', { value: '__manage__' }, '＋ 管理分类…'));
        };
        catAdd.addEventListener('change', async () => {
          const v = catAdd.value;
          catAdd.value = '';
          if (!v) return;
          if (v === '__manage__') { this.categoryDialog(async () => { await this.loadCategories(); drawCatChips(); drawCatAdd(); }); return; }
          await saveCats((g.categories || []).concat([v]), '已加上「' + v + '」');
        });
        const platBtn = el('button', {
          class: 'btn btn-sm', title: '从 Steam 平台读取这款游戏的官方分类',
          onclick: async () => {
            if (platBtn.disabled) return;
            platBtn.disabled = true;
            const old = platBtn.textContent;
            platBtn.textContent = '读取中…';
            const r = await API.raw.games.syncPlatformCats({ ids: [g.id], force: true, forceLock: true })
              .catch((e) => { window.Shell.toast(e.message, 'err'); return null; });
            platBtn.disabled = false;
            platBtn.textContent = old;
            if (!r) return;
            if (r.updated) {
              await this.reload();
              const fresh = (this.list.find((x) => x.id === g.id) || {});
              g.categories = fresh.categories || [];
              g.category = fresh.category || '未分类';
              g.categoryLocked = !!fresh.categoryLocked;
              g.catSource = fresh.catSource || g.catSource;
              drawCatChips(); drawCatAdd();
              window.Shell.toast('已按平台分类更新（' + (g.categories.join(' / ') || '无') + '）', 'ok');
            } else if (r.failed) {
              window.Shell.toast('没能连上 Steam，稍后再试', 'err');
            } else {
              window.Shell.toast('Steam 上这款游戏没有分类数据');
            }
          }
        }, uiSpan('download'), '从平台读取');
        drawCatChips(); drawCatAdd();

        body.appendChild(el('div', { class: 'card' },
          el('h3', { text: '基本设置' }),
          el('div', { class: 'row' },
            el('span', { class: 'label', text: '分类' }),
            el('div', { class: 'grow cat-editor' },
              catChips,
              el('div', { class: 'cat-actions' }, catAdd, platBtn,
                g.categoryLocked
                  ? el('span', { class: 'chip', title: '手动改过分类，扫描和平台都只会补充、不会覆盖' }, '已锁定')
                  : el('span', { class: 'chip', title: '当前分类来自平台或自动归类' }, g.catSource === 'platform' ? '来自平台' : '自动归类')))),
          el('div', { class: 'row' }, el('span', { class: 'label', text: '通关状态' }),
            el('select', { class: 'inp grow', onchange: async (e) => {
              const v = e.target.value;
              await API.raw.games.update(g.id, { clearState: v }, { silent: true })
                .then((r) => { g.clearState = (r && r.clearState) || v; window.Shell.toast('已标记为' + CLEAR_META[v].label, 'ok'); this.reload(); })
                .catch((x) => window.Shell.toast(x.message, 'err'));
            } }, CLEAR_ORDER.map((k) => el('option', { value: k, selected: clearOf(g) === k }, CLEAR_META[k].label)))),
          el('div', { class: 'row' }, el('span', { class: 'label', text: '备注' }),
            el('input', { class: 'inp grow', value: g.note || '', placeholder: '例如：等 DLC 打折 / 装了汉化补丁',
              onchange: async (e) => { await API.raw.games.update(g.id, { note: e.target.value }, { silent: true }); g.note = e.target.value; window.Shell.toast('备注已保存'); } })),
          el('div', { class: 'row' }, el('span', { class: 'label', text: '启动参数' }),
            el('input', { class: 'inp grow mono', value: g.launchArgs || '', placeholder: '例如：-windowed -novid',
              onchange: async (e) => { await API.raw.games.update(g.id, { launchArgs: e.target.value }, { silent: true }); g.launchArgs = e.target.value; window.Shell.toast('启动参数已保存'); } })),
          el('div', { class: 'row' }, el('span', { class: 'label', text: '收藏' }),
            el('button', { class: 'btn', onclick: async () => { await API.raw.games.update(g.id, { favorite: !g.favorite }, { silent: true }); g.favorite = !g.favorite; window.Shell.toast(g.favorite ? '已收藏' : '已取消收藏'); this.reload(); } },
              g.favorite ? '★ 已收藏' : '☆ 收藏')),
          el('div', { class: 'row' }, el('span', { class: 'label', text: '隐藏空间' }),
            el('button', { class: 'btn', onclick: async () => {
              const on = !g.hidden;
              await API.raw.games.setHidden([g.id], on).catch((e) => window.Shell.toast(e.message, 'err'));
              window.Shell.toast(on ? '已加入隐藏空间' : '已移出隐藏空间', 'ok');
              layer.hidden = true;
              this.currentId = '';
              await this.reload();
            } }, uiSpan('lock'), g.hidden ? '移出隐藏空间' : '加入隐藏空间'),
            el('span', { class: 'text-dim', style: { fontSize: '.84em' }, text: '隐藏的游戏只会在「隐藏空间」里出现' })),
          el('div', { class: 'cover-box' },
            el('div', { class: 'cover-prev' },
              this.coverImg(g, { placeholder: () => el('span', { class: 'ph', text: '无封面' }) })),
            el('div', { class: 'cover-ops' },
              el('div', { class: 'row' },
                el('span', { class: 'label', text: '封面来源' }),
                el('span', { class: 'chip accent', text: { custom: '自定义', local: '本地缓存', steam: 'Steam 官方', icon: 'exe 图标', none: '无' }[g.coverKind] || '无' }),
                el('span', { class: 'text-dim', style: { fontSize: '.82em' }, text: '自定义封面不会被自动流程覆盖' })),
              el('div', { class: 'row wrap' },
                el('button', { class: 'btn btn-sm btn-primary', onclick: () => this.coverAction(g, 'search') }, uiSpan('search'), '联网搜索封面'),
                el('button', { class: 'btn btn-sm', onclick: () => this.coverAction(g, 'icon') }, uiSpan('image'), '提取程序图标'),
                el('button', { class: 'btn btn-sm', onclick: () => this.coverAction(g, 'refresh') }, uiSpan('refresh'), '重新抓取封面'),
                el('button', { class: 'btn btn-sm', onclick: () => this.pickCoverFile(g) }, uiSpan('folder'), '选择本地图片'),
                el('button', { class: 'btn btn-sm', onclick: () => this.coverAction(g, 'default') }, '恢复默认'))
            )
          ),
          el('div', { class: 'row' }, el('span', { class: 'label', text: '从库中移除' }),
            el('button', { class: 'btn btn-danger', onclick: async () => { await API.raw.games.remove([g.id]); window.Shell.toast('已从库中移除'); layer.hidden = true; this.reload(); } }, uiSpan('trash'), '仅移除记录'),
            el('span', { class: 'text-dim', style: { fontSize: '.84em' }, text: '不会删除任何文件' }))
        ));

        /* 卸载：三路分派，先弹确认，把「会怎么卸」讲清楚 */
        const unCard = el('div', { class: 'card', style: { marginTop: '12px' } },
          el('h3', { text: '卸载游戏' }),
          el('p', { class: 'hint', text: '按「谁装的谁卸」分派：Steam / Epic 交给平台，本地游戏优先跑自带卸载程序，没有卸载器才会把目录移进回收站。' }));
        const unInfo = el('div', { class: 'un-info' });
        unCard.appendChild(unInfo);
        unCard.appendChild(el('div', { class: 'row' },
          el('button', { class: 'btn btn-danger', onclick: async () => {
            const info = await API.raw.games.uninstallInfo(g.id).catch((e) => { window.Shell.toast(e.message, 'err'); return null; });
            if (!info) return;
            clear(unInfo);
            unInfo.appendChild(el('div', { class: 'chip accent', text: info.label }));
            unInfo.appendChild(el('p', { class: 'hint', text: info.detail }));
            if (!info.safe) { window.Shell.toast('这个游戏没有安全可用的卸载方式', 'err'); return; }
            const yes = await window.Shell.confirm({
              title: '确认卸载「' + g.name + '」？',
              message: info.detail,
              detail: info.warn || '',
              danger: true, okText: '执行卸载'
            });
            if (yes) runUninstall(g.id, info);
          } }, uiSpan('trash'), '卸载这款游戏'),
          el('button', { class: 'btn', onclick: async () => { const i = await API.raw.games.uninstallInfo(g.id).catch(() => null); clear(unInfo); if (i) { unInfo.appendChild(el('div', { class: 'chip accent', text: i.label })); unInfo.appendChild(el('p', { class: 'hint', text: i.detail })); } } }, '看看会怎么卸')
        ));
        body.appendChild(unCard);
      }
    };
    const runUninstall = async (id, info) => {
      const r = await API.raw.games.uninstall(id, { removeRecord: info.route === 'trash' }).catch((e) => ({ ok: false, message: e.message }));
      window.Shell.toast(r.message || (r.ok ? '已开始卸载' : '卸载失败'), r.ok ? 'ok' : 'err');
      setTimeout(() => { this.detailLayer.hidden = true; this.reload(); }, 900);
    };
    renderTab();
    layer.appendChild(hero);
    layer.appendChild(bar);
    layer.appendChild(tabsBar);
    layer.appendChild(body);
    renderBody();
  },

  /* ============================================================
     动作：启动 / 扫描 / 添加
     ============================================================ */
  async launch(id) {
    const r = await API.raw.games.launch(id).catch((e) => { window.Shell.toast(e.message, 'err'); return null; });
    if (!r) return;
    if (r.ok === false) {
      /* 已经在玩 / 正在等进程起来 —— 主进程会拦下来，这里把原因说清楚 */
      const nm = r.name || (this.games || []).filter((x) => x.id === id).map((x) => x.name)[0] || '这个游戏';
      if (r.reason === 'running') return window.Shell.toast(`${nm} 正在运行中`, 'err');
      if (r.reason === 'starting') return window.Shell.toast(`${nm} 正在启动，稍等一下`, 'err');
      return window.Shell.toast('启动失败：' + (r.reason || '未知原因'), 'err');
    }
    window.Shell.toast(r.pending ? '正在启动…（等游戏进程起来就开始计时）' : '正在启动…');
    /* 先乐观地亮出「启动中…」，主进程随后会用 games:run-state 校准成「运行中」 */
    if (r.pending) this.applyRunState({ id, running: false, pending: true });
    setTimeout(() => this.reload(), 900);
  },

  /** 停止游戏（协议启动的走 taskkill，关没关掉由主进程的守护循环发现） */
  async stop(id) {
    const r = await API.raw.games.stop(id).catch((e) => { window.Shell.toast(e.message, 'err'); return null; });
    if (r && r.ok === false) window.Shell.toast(r.reason || '停止失败', 'err');
    else this.applyRunState({ id, running: false, pending: false });
    setTimeout(() => this.reload(), 700);
  },

  /** 就地改运行状态：只动这一张卡 / 这一个按钮，绝不整页重画（会顶掉滚动位置） */
  applyRunState(p) {
    if (!p || !p.id) return;
    /* ⚠️ 一定要连 `this.list` 一起改：卡片上的按钮是 `card(g)` 里**闭包**住的那个对象，
       只改 DOM 不改它，就会出现「按钮写着『停止』、点下去却走启动分支」。
       （`this.games` 是老名字，留着是为了兼容，两边都扫一遍。） */
    for (const arr of [this.list, this.games]) {
      const g = (arr || []).find((x) => x.id === p.id);
      if (g) { g.running = !!p.running; g.pending = !!p.pending; }
    }
    const text = p.running ? '运行中' : (p.pending ? '启动中…' : '');

    const card = this.root && this.root.querySelector('.gcard[data-gid="' + p.id + '"]');
    const cover = card && card.querySelector('.gcover');
    if (cover) {
      let badge = cover.querySelector('.run-badge');
      if (text) {
        if (!badge) { badge = document.createElement('div'); badge.className = 'run-badge'; cover.appendChild(badge); }
        badge.textContent = text;
        badge.classList.toggle('pending', !p.running && !!p.pending);
      } else if (badge) badge.remove();
      const hb = card.querySelector('.hover-bar .hb.play');
      if (hb) {
        hb.title = p.running ? '停止' : (p.pending ? '取消启动' : '启动');
        hb.classList.toggle('run', !!(p.running || p.pending));
      }
    }

    if (this.detailLayer && this.currentId === p.id) {
      const btn = document.getElementById('gDetailRunBtn');
      if (btn) {
        btn.classList.toggle('btn-primary', !(p.running || p.pending));
        btn.textContent = '';
        btn.appendChild(uiSpan('play'));
        btn.appendChild(document.createTextNode(p.running ? '停止游戏' : (p.pending ? '取消启动' : '启动游戏')));
      }
      const listBadge = document.querySelector('.gdetail-run');
      if (listBadge) listBadge.textContent = text;
    }
  },

  /** 主进程的守护提示：开始计时 / 玩完结算 / 没盯到进程 */
  onRunNotice(p) {
    if (!p) return;
    const nm = p.name || '游戏';
    if (p.kind === 'started') window.Shell.toast(`${nm} 已开始，正在计时`, 'ok');
    else if (p.kind === 'finished') window.Shell.toast(`${nm} 本次玩了 ${formatPlayTime(p.minutes || 0)}`, 'ok');
    else if (p.kind === 'no-exe') window.Shell.toast(`没找到 ${nm} 的主程序，这次没法计时`, 'err');
    else if (p.kind === 'no-process') window.Shell.toast(`启动后没等到 ${nm} 的进程（${p.exe || '未知'}），这次没记时长`, 'err');
    else if (p.kind === 'no-probe') window.Shell.toast('读不到系统进程列表，这次没法计时', 'err');
    else if (p.kind === 'launch-error') window.Shell.toast(`启动 ${nm} 失败：${p.message || '系统拒绝了这次启动'}`, 'err');
  },

  async scan() {
    window.Shell.toast('开始扫描本机游戏…');
    const off = API.on('games:scan-progress', (p) => { if (p && p.name) window.Shell.status(`正在识别：${p.name}`); });
    const res = await API.raw.games.scan().catch((e) => { window.Shell.toast(e.message, 'err'); return null; });
    off();
    if (res) {
      window.Shell.status('');
      window.Shell.toast(
        `扫描完成：Steam ${res.steam} · Epic ${res.epic} · 注册表 ${res.registry || 0} · 文件夹 ${res.folder}，新增 ${res.added} 款`,
        'ok');
    }
    this.page = 'library';
    await this.reload();
  },

  /** 某款游戏最近的游玩记录（从全局流水里挑） */
  async recentSessions(id) {
    const all = await API.raw.games.sessions(300).catch(() => []);
    return all.filter((s) => s.id === id).slice(0, 10);
  },

  /* ============================================================
     分类管理：分类是用户自己的，内置 25 类只是自动归类的词表
     ============================================================ */
  async categoryDialog(onDone) {
    if (!window.Shell || !window.Shell.modal) return;
    await this.loadCategories();
    const body = el('div');
    const listBox = el('div', { class: 'cat-list' });
    const addInp = el('input', { class: 'inp grow', placeholder: '新建分类名，例如：魂类 / 联机开黑' });

    const drawList = async () => {
      clear(listBox);
      const cats = await this.loadCategories();
      const counts = {};
      /* ⚠️ view:'all' 是**不含隐藏游戏**的，而打了「18+」的游戏全都在隐藏空间里 ——
         只问它的话，18+ 那一行永远显示 0 款。两边都要取。 */
      const all = (await API.raw.games.list({ view: 'all' }).catch(() => []))
        .concat(await API.raw.games.list({ view: 'hidden' }).catch(() => []));
      /* 一个游戏挂多个分类时，**每个分类都要 +1**，所以「合计」会大于游戏总数 */
      for (const g of all) {
        const cs = catsOf(g);
        if (!cs.length) counts['未分类'] = (counts['未分类'] || 0) + 1;
        for (const c of cs) counts[c] = (counts[c] || 0) + 1;
      }
      for (const c of cats) {
        /* 「未分类」和「18+」都是**内建分类**：不能改名、不能删（18+ 还兼着隐藏空间开关） */
        const builtin = c === '未分类' || c === ADULT_CAT;
        const nameInp = el('input', { class: 'inp', value: c, disabled: builtin,
          onchange: async (e) => {
            const nv = e.target.value.trim();
            if (!nv || nv === c) { e.target.value = c; return; }
            await API.raw.games.renameCategory(c, nv)
              .then(() => { window.Shell.toast(`「${c}」已改名为「${nv}」`, 'ok'); drawList(); this.reload(); })
              .catch((x) => { window.Shell.toast(x.message, 'err'); e.target.value = c; });
          } });
        listBox.appendChild(el('div', { class: 'cat-row' },
          nameInp,
          el('span', { class: 'chip', text: (counts[c] || 0) + ' 款' }),
          builtin
            ? el('span', {
                class: 'text-dim', style: { fontSize: '.82em' },
                title: c === ADULT_CAT ? '挂上它的游戏会被放进隐藏空间；要放出来，从某款游戏上摘掉这个标签即可' : '',
                text: c === ADULT_CAT ? '内建 · 隐藏空间开关' : '固定分类'
              })
            : el('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
                const yes = await window.Shell.confirm({ title: '删除分类「' + c + '」？',
                  message: (counts[c] || 0) + ' 款游戏会摘掉这个分类；只挂这一个分类的会变成「未分类」，其余分类保留，游戏本身不会丢。' });
                if (!yes) return;
                await API.raw.games.removeCategory(c)
                  .then(() => { window.Shell.toast('已删除分类', 'ok'); drawList(); this.reload(); })
                  .catch((x) => window.Shell.toast(x.message, 'err'));
              } }, '删除')
        ));
      }
    };

    body.appendChild(el('p', { class: 'hint', style: { marginTop: 0 },
      text: '一个游戏可以挂多个分类，这里统计的是「各分类分别有多少款」，所以合计会大于游戏总数。分类随你增删改：内置的 25 个分类只是「自动归类」用的关键词表，你自己新建的分类只能手动指定或从平台读取；手动改过的游戏会被锁定，扫描不会再覆盖。「18+」是内建的特殊分类，加上它游戏就会被放进隐藏空间（要放出来，从某款游戏上摘掉这个标签就行），所以它跟「未分类」一样不能改名 / 删除。' }));
    body.appendChild(el('div', { class: 'row' }, addInp,
      el('button', { class: 'btn btn-primary', onclick: async () => {
        const v = addInp.value.trim();
        if (!v) return;
        await API.raw.games.addCategory(v)
          .then(() => { addInp.value = ''; window.Shell.toast('已新建分类「' + v + '」', 'ok'); drawList(); this.loadCategories(); })
          .catch((x) => window.Shell.toast(x.message, 'err'));
      } }, uiSpan('plus'), '新建')));
    body.appendChild(listBox);
    window.Shell.modal({
      title: '管理分类', body, cancelText: '关闭', okText: false,
      onClose: () => { this.loadCategories().then(() => { if (onDone) onDone(); }); }
    });
    drawList();
  },

  /* ---------------- 添加游戏（手动 + 自动） ----------------
     自动添加是**三步向导**，扫描完不会直接入库：
       ① 扫描（本弹窗「自动添加」页）→ 只列候选
       ② 确认导入 —— 分组勾选、单条删除、批量删除
       ③ 逐款自定义 —— 改名称 / 主程序 / 安装目录 / 分类
     最后一步「全部导入」才真正落库。
     opts: { mode?: 'manual'|'auto', candidates?: [] }
       —— 从向导「返回」时把候选带回来，省得重扫。 */
  addDialog(opts = {}) {
    if (!window.Shell || !window.Shell.modal) return;
    // 分类词表是向导第 ③ 步的快速点选 chips 的数据源，别让它空着
    if (!this.cats || !this.cats.length) this.loadCategories().catch(() => {});
    let mode = opts.mode === 'auto' ? 'auto' : 'manual';
    let cands = Array.isArray(opts.candidates) ? opts.candidates : null;
    const manual = { name: '', exe: '', path: '', platform: 'auto', category: '', cover: '' };

    const body = el('div');
    const tabBar = el('div', { class: 'mtabs' });
    const pane = el('div');

    const renderTabs = () => {
      clear(tabBar);
      [['manual', '手动添加'], ['auto', '自动添加']].forEach(([k, t]) =>
        tabBar.appendChild(el('button', { class: 'mtab' + (mode === k ? ' on' : ''), onclick: () => { mode = k; draw(); } }, t)));
    };

    /* ---- 手动添加 ---- */
    const manualPane = () => {
      const box = el('div');
      box.appendChild(el('p', { class: 'hint', style: { marginTop: 0 }, text: '指定游戏名字和启动程序，适合绿色版 / 独立游戏。' }));
      const nameInp = el('input', { class: 'inp', placeholder: '例如：我的世界', value: manual.name, oninput: (e) => { manual.name = e.target.value; } });
      box.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: '游戏名称' }), nameInp));

      const exeInp = el('input', { class: 'inp grow mono', placeholder: '未选择', value: manual.exe, oninput: (e) => { manual.exe = e.target.value; } });
      box.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: '启动程序' }),
        exeInp,
        el('button', { class: 'btn btn-sm', onclick: async () => {
          const f = await API.raw.dialog.pickExe();
          if (!f) return;
          manual.exe = f;
          exeInp.value = f;
          if (!manual.path) { manual.path = f.replace(/[\\/][^\\/]+$/, ''); pathInp.value = manual.path; }
          if (!manual.name) {
            const base = window.util.baseName(f).replace(/\.(exe|bat|cmd|lnk)$/i, '');
            manual.name = base; nameInp.value = base;
          }
        } }, uiSpan('folder'), '选择文件')));

      const pathInp = el('input', { class: 'inp grow mono', placeholder: '默认取启动程序所在目录', value: manual.path, oninput: (e) => { manual.path = e.target.value; } });
      box.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: '安装目录' }),
        pathInp,
        el('button', { class: 'btn btn-sm', onclick: async () => {
          const d = await API.raw.dialog.pickFolder();
          if (!d) return;
          manual.path = d; pathInp.value = d;
          if (!manual.name) { const base = window.util.baseName(d); manual.name = base; nameInp.value = base; }
        } }, uiSpan('folder'), '选择文件夹')));

      const platSel = el('select', { class: 'inp grow', onchange: (e) => { manual.platform = e.target.value; } },
        PLATFORM_OPTIONS.map(([v, t]) => el('option', { value: v, selected: manual.platform === v }, t)));
      box.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: '所属平台' }), platSel,
        el('span', { class: 'text-dim', style: { fontSize: '.84em' }, text: '不确定就留「自动识别」' })));

      box.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: '分类' }),
        el('input', { class: 'inp grow', placeholder: '可填多个，用逗号分隔；留空则按名字自动归类', value: manual.category, oninput: (e) => { manual.category = e.target.value; } }),
        el('button', { class: 'btn btn-sm', onclick: () => this.categoryDialog() }, '管理分类')));

      const coverHint = el('span', { class: 'text-dim ellipsis', style: { fontSize: '.84em' }, text: manual.cover ? manual.cover.split(/[\\/]/).pop() : '未选择' });
      box.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: '封面图' }),
        coverHint,
        el('button', { class: 'btn btn-sm', onclick: async () => {
          const f = await API.raw.dialog.pickFiles({ filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
          if (f && f[0]) { manual.cover = window.util.toFileUrl(f[0]); coverHint.textContent = window.util.baseName(f[0]); }
        } }, '选择图片')));

      box.appendChild(el('div', { class: 'row', style: { marginTop: '6px' } },
        el('button', { class: 'btn btn-primary', onclick: async () => {
          if (!manual.name.trim() && !manual.exe) return window.Shell.toast('至少填个名字或选个启动程序', 'err');
          const payload = {
            name: manual.name.trim() || window.util.baseName(manual.exe),
            exe: manual.exe, path: manual.path, launch: manual.exe,
            categories: parseCatInput(manual.category),
            categoryLocked: !!parseCatInput(manual.category).length,   // 手动填的分类＝用户指定，锁定
            source: 'manual',
            cover: manual.cover
          };
          if (manual.platform && manual.platform !== 'auto') payload.platform = manual.platform;
          await API.raw.games.addManual(payload).catch((e) => window.Shell.toast(e.message, 'err'));
          window.Shell.toast('已添加', 'ok');
          window.Shell.closeModal();
          this.page = 'library';
          await this.reload();
        } }, uiSpan('plus'), '添加到游戏库')));
      return box;
    };

    /* ---- 自动添加（第 ① 步：只扫描列候选，不入库） ---- */
    const autoPane = () => {
      const box = el('div');
      box.appendChild(el('p', { class: 'hint', style: { marginTop: 0 }, text: '自动扫描本机已安装的游戏：Steam 库、Epic 清单、Windows 注册表的卸载项（绿色版 / 免安装版也在这里），以及各个磁盘的常见游戏目录。扫描只列候选 —— 不删任何文件，也不自动入库。' }));

      const log = el('div', { class: 'scan-log' });
      const summary = el('div', { class: 'scan-sum' });
      const nextRow = el('div', { class: 'row', style: { marginTop: '12px', gap: '10px', flexWrap: 'wrap', alignItems: 'center' } });
      let busy = false;

      const appendLog = (t) => {
        const line = el('div', { class: 'ln', text: t });
        log.appendChild(line);
        log.scrollTop = log.scrollHeight;
      };

      const paintSummary = () => {
        clear(summary);
        if (!cands) return;
        const high = cands.filter((c) => c.confidence === 'high' && !c.inLibrary).length;
        summary.appendChild(el('span', { class: 'chip', text: '候选 ' + cands.length + ' 款' }));
        summary.appendChild(el('span', { class: 'chip accent', text: '可直接导入 ' + high + ' 款' }));
        summary.appendChild(el('span', { class: 'chip', text: '可能相关 ' + (cands.length - high) + ' 款' }));
      };

      const paintNext = () => {
        clear(nextRow);
        if (!cands) return;
        const n = cands.length;
        nextRow.appendChild(el('button', {
          class: 'btn btn-primary', disabled: !n,
          onclick: () => { window.Shell.closeModal(); this.confirmImportDialog(cands); }
        }, uiSpan('check'), n ? '下一步 · 确认导入（' + n + '）' : '没有候选'));
        nextRow.appendChild(el('span', { class: 'text-dim', style: { fontSize: '.86em' },
          text: n ? '下一步可以逐条勾选、删除，确认后才入库' : '换个目录再扫一次试试' }));
      };

      const run = async (label, fn) => {
        if (busy) return;
        busy = true;
        clear(nextRow);
        appendLog('▶ ' + label);
        const off = API.on('games:scan-progress', (p) => { if (p && p.name) window.Shell.status(p.name); });
        const r = await fn().catch((e) => { appendLog('✗ ' + e.message); return null; });
        off();
        window.Shell.status('');
        busy = false;
        if (!r) return;
        cands = r.list || [];
        paintSummary();
        const high = cands.filter((c) => c.confidence === 'high' && !c.inLibrary).length;
        appendLog(`✓ 扫描完成：候选 ${cands.length} 款（可直接导入 ${high} 款 / 可能相关 ${cands.length - high} 款）`);
        paintNext();
      };

      box.appendChild(el('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } },
        el('button', { class: 'btn btn-primary', onclick: () => run('扫描 Steam + Epic + 注册表 + 常见目录', () => API.raw.games.scanCandidates({})) },
          uiSpan('refresh'), '一键扫描全盘'),
        el('button', { class: 'btn', onclick: async () => {
          const d = await API.raw.dialog.pickFolder();
          if (!d) return;
          run('扫描文件夹：' + d, () => API.raw.games.scanCandidates({ roots: [d] }));
        } }, uiSpan('folder'), '扫描指定文件夹')));

      box.appendChild(summary);
      box.appendChild(log);

      if (cands) {
        // 「返回」带回上次的候选 —— 不重扫，直接接着走
        paintSummary();
        appendLog(`✓ 上次扫到的 ${cands.length} 款候选还在，可以直接进下一步`);
      } else {
        appendLog('提示：扫描只列候选。要不要、要哪些，都在下一步决定 —— 勾选进库，✕ 从列表删掉。');
      }
      box.appendChild(nextRow);
      paintNext();
      return box;
    };

    const draw = () => {
      renderTabs();
      clear(pane);
      pane.appendChild(mode === 'manual' ? manualPane() : autoPane());
    };
    draw();

    body.appendChild(tabBar);
    body.appendChild(pane);

    window.Shell.modal({
      title: '添加游戏', wide: true, body,
      cancelText: '关闭', okText: false
    });
  },

  /* ============================================================
     自动添加 · 向导外壳
     ------------------------------------------------------------
     复用 Shell.modal 的骨架，但自己接管底栏 —— 向导要
     「← 返回 / 取消 / 下一步」三个按钮，而且底栏得固定住，
     不能跟着中间的列表一起滚（.modal 自己就是 overflow:auto）。
     ============================================================ */
  wizard({ title, hint, tools, scroll, foot }) {
    const body = el('div', { class: 'wiz' },
      hint ? el('p', { class: 'wiz-hint' }, hint) : null,
      tools || null,
      scroll);
    window.Shell.modal({ title, body, cancelText: false, okText: false });
    const m = document.querySelector('#modals .modal');
    if (!m) return null;
    m.classList.add('wizard');
    // 底栏挂在 .modal 上（不在 .modal-body 里），这样它不会被列表带着滚
    if (foot) m.appendChild(foot);
    return { modal: m };
  },

  /* ---------------- 向导 ②：确认导入 ----------------
     items 就是扫描出来的候选数组，勾选态直接挂在元素上（c.checked），
     所以「返回 / 下一步」来回走不会丢勾选和删除。 */
  confirmImportDialog(items) {
    if (!window.Shell || !window.Shell.modal) return;
    const list = Array.isArray(items) ? items : [];
    for (const c of list) {
      // 首次进来：能直接导入、且不在库里的默认勾上，其余留给用户判断
      if (c.checked === undefined) c.checked = c.confidence === 'high' && !c.inLibrary;
    }

    const scroll = el('div', { class: 'wiz-scroll' });
    const selChip = el('span', { class: 'wiz-count' });
    const selSub = el('span', { class: 'sub' });
    const nextBtn = el('button', {
      class: 'btn btn-primary',
      onclick: () => {
        if (!list.some((c) => c.checked)) return window.Shell.toast('至少勾选一款', 'err');
        window.Shell.closeModal();
        this.customizeImportDialog(list);
      }
    }, '下一步 · 调整名称与分类');

    const syncCount = () => {
      const n = list.filter((c) => c.checked).length;
      clear(selChip);
      selChip.appendChild(el('span', { text: '已选 ' }));
      selChip.appendChild(el('b', { text: String(n) }));
      selChip.appendChild(el('span', { text: ' / ' + list.length }));
      selSub.textContent = n ? `已选 ${n} 款 · 下一步可调整名称` : '一款都还没选';
      nextBtn.disabled = !n;
    };

    const removeOne = (c) => {
      const i = list.indexOf(c);
      if (i >= 0) list.splice(i, 1);
      draw();
    };

    const row = (c) => {
      const inp = el('input', { class: 'wi-check', type: 'checkbox', checked: c.checked });
      const node = el('div', { class: 'wiz-item' + (c.checked ? ' on' : ''), title: c.path || c.exe || '' },
        inp,
        el('div', { class: 'wi-main' },
          el('div', { class: 'wi-name' },
            el('span', { class: 'wi-n ellipsis', text: c.name || '(未命名)' }),
            el('span', { class: 'chip', text: c.kind === 'installed' ? '已安装' : '文件夹' }),
            c.inLibrary ? el('span', { class: 'chip warn', text: '已在库中' }) : null,
            c.confidence === 'high' ? null : el('span', { class: 'chip warn', text: '待确认' })),
          el('div', { class: 'wi-sub mono ellipsis', text: (c.path || c.exe || '') + (c.note ? '　·　' + c.note : '') })),
        el('div', { class: 'wi-meta', text: c.mtime ? dateText(c.mtime) : '' }),
        el('button', { class: 'wi-del', title: '从候选里删掉这一条', onclick: (e) => { e.stopPropagation(); removeOne(c); } }, '✕'));
      node.addEventListener('click', () => {
        c.checked = !c.checked;
        inp.checked = c.checked;
        node.classList.toggle('on', c.checked);
        syncCount();
      });
      return node;
    };

    const draw = () => {
      const keep = scroll.scrollTop;
      clear(scroll);
      if (!list.length) {
        scroll.appendChild(el('div', { class: 'wiz-empty' },
          el('p', { class: 'text-dim', text: '候选都被删光了 —— 点「← 返回」重新扫描。' })));
        syncCount();
        return;
      }
      const groups = [
        { title: '可直接导入', items: list.filter((c) => c.confidence === 'high') },
        { title: '可能相关（请自行确认）', items: list.filter((c) => c.confidence !== 'high') }
      ];
      for (const gr of groups) {
        if (!gr.items.length) continue;
        scroll.appendChild(el('div', { class: 'wiz-ghead' },
          el('span', { class: 'wt', text: gr.title }),
          el('span', { class: 'chip', text: String(gr.items.length) }),
          el('span', { class: 'grow' }),
          el('button', { class: 'link-btn', onclick: () => { gr.items.forEach((c) => { c.checked = true; }); draw(); } }, '全选本组'),
          el('button', { class: 'link-btn', onclick: () => { gr.items.forEach((c) => { c.checked = false; }); draw(); } }, '取消本组')));
        const box = el('div', { class: 'wiz-list' });
        for (const c of gr.items) box.appendChild(row(c));
        scroll.appendChild(box);
      }
      scroll.scrollTop = keep;
      syncCount();
    }

    /* 批量删除：这里**不能用 Shell.confirm** —— 它会 clear(#modals)，
       把整个向导弹窗一起顶掉。改成按钮上的二次确认（3 秒不点自动复原）。 */
    const delLabel = el('span', { text: '批量删除' });
    const delBtn = el('button', { class: 'btn btn-sm btn-danger', onclick: (e) => {
      const b = e.currentTarget;
      const picked = list.filter((c) => c.checked);
      if (!picked.length) return window.Shell.toast('先勾选要删除的条目', 'err');
      if (b.dataset.arm !== '1') {
        b.dataset.arm = '1';
        delLabel.textContent = `再点一次 · 删除 ${picked.length} 条`;
        clearTimeout(b._t);
        b._t = setTimeout(() => { b.dataset.arm = ''; delLabel.textContent = '批量删除'; }, 3000);
        return;
      }
      clearTimeout(b._t);
      const drop = new Set(picked);
      for (let i = list.length - 1; i >= 0; i--) if (drop.has(list[i])) list.splice(i, 1);
      draw();
      window.Shell.toast(`已删除 ${picked.length} 条候选`, 'ok');
    } }, uiSpan('trash'), delLabel);

    const tools = el('div', { class: 'wiz-tools' },
      el('button', { class: 'btn btn-sm', onclick: () => {
        for (const c of list) c.checked = c.confidence === 'high' && !c.inLibrary;
        draw();
      } }, uiSpan('check'), '全选可导入'),
      el('button', { class: 'btn btn-sm', onclick: () => {
        for (const c of list) c.checked = c.confidence === 'high';
        draw();
      } }, '仅选高置信'),
      el('button', { class: 'btn btn-sm', onclick: () => { for (const c of list) c.checked = false; draw(); } }, '清空已选'),
      delBtn,
      el('span', { class: 'grow' }),
      selChip);

    const foot = el('div', { class: 'wiz-foot' },
      el('button', { class: 'btn btn-sm', onclick: () => {
        window.Shell.closeModal();
        this.addDialog({ mode: 'auto', candidates: list });
      } }, uiSpan('back'), '返回'),
      el('span', { class: 'grow' }),
      selSub,
      el('button', { class: 'btn btn-sm', onclick: () => window.Shell.closeModal() }, '取消'),
      nextBtn);

    this.wizard({
      title: '自动添加 · 确认导入',
      hint: ['从扫描结果里找到 ', el('b', { text: String(list.length) }), ' 个候选，勾选要加入游戏库的条目。取消勾选＝这次不导入，✕＝从列表里删掉。'],
      tools, scroll, foot
    });
    draw();
  },

  /* ---------------- 向导 ③：逐款自定义 ----------------
     传进来的是**完整候选数组**（含未勾选的），只遍历勾上的那些，
     所以从这页「返回」时确认页的勾选状态一点都不会丢。 */
  customizeImportDialog(items) {
    if (!window.Shell || !window.Shell.modal) return;
    const list = Array.isArray(items) ? items : [];
    let idx = 0;

    const picked = () => list.filter((c) => c.checked);
    const cur = () => {
      const arr = picked();
      if (!arr.length) return null;
      if (idx >= arr.length) idx = arr.length - 1;
      if (idx < 0) idx = 0;
      return arr[idx];
    };

    const tabs = el('div', { class: 'wiz-tabs' });
    const form = el('div', { class: 'wiz-scroll wiz-form' });
    const countSub = el('span', { class: 'sub' });
    const importBtn = el('button', { class: 'btn btn-primary', onclick: (e) => doImport(e) }, '全部导入');

    const drawTabs = () => {
      clear(tabs);
      const arr = picked();
      arr.forEach((c, i) => tabs.appendChild(el('button', {
        class: 'wtab' + (i === idx ? ' on' : ''),
        title: c.name || '',
        onclick: () => { idx = i; drawTabs(); drawForm(); }
      },
        el('span', { class: 'ellipsis', text: c.name || '(未命名)' }),
        /* 每条 tab 上的「取消」：这一款这次就不导入了（＝取消勾选，回上一页能看到，
           不是把候选从列表里删掉 —— 那个用上一页的 ✕）。 */
        el('span', {
          class: 'x', title: '取消这一款（这次不导入）', text: '×',
          onclick: (e) => {
            e.stopPropagation();          // 别让按钮的 onclick 抢走这次点击
            c.checked = false;
            idx = Math.max(0, Math.min(idx, picked().length - 1));
            drawTabs(); drawForm();
          }
        }))
      ));
      cur();                                   // 先夹一次下标，再报数量
      countSub.textContent = '共 ' + picked().length + ' 款待导入';
      importBtn.textContent = '全部导入 (' + picked().length + ')';
      importBtn.disabled = !picked().length;
    };

    // ⚠️ 必须是箭头函数：普通 function 声明的 this 在严格模式下是 undefined，
    //    这里要读 this.cats（分类词表），写成 function 会在 drawChips 处炸掉
    const drawForm = () => {
      clear(form);
      const c = cur();
      if (!c) {
        form.appendChild(el('div', { class: 'wiz-empty' },
          el('p', { class: 'text-dim', text: '没有要导入的条目了 —— 点「← 返回」重新勾选。' })));
        return;
      }

      form.appendChild(el('div', { class: 'wiz-prog' },
        el('span', { class: 'wp-i', text: `第 ${idx + 1} / ${picked().length} 款` }),
        el('span', { class: 'chip', text: c.kind === 'installed' ? '已安装' : '文件夹' }),
        c.mtime ? el('span', { class: 'chip', text: dateText(c.mtime) }) : null,
        el('span', { class: 'grow' }),
        el('button', { class: 'btn btn-sm', onclick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          const r = await API.raw.games.analyzeCandidate(c)
            .catch((x) => { window.Shell.toast(x.message, 'err'); return null; });
          b.disabled = false;
          if (!r) return;
          Object.assign(c, r);
          drawForm();
          window.Shell.toast(r.exe ? '已重新定位主程序' : '没找到更像主程序的文件', r.exe ? 'ok' : '');
        } }, uiSpan('refresh'), '重新分析此条')));

      const nameInp = el('input', { class: 'inp', value: c.name || '', placeholder: '游戏名称', oninput: (e) => { c.name = e.target.value; } });
      form.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: '游戏名称' }), nameInp));

      const exeInp = el('input', { class: 'inp grow mono', value: c.exe || '', placeholder: '未找到主程序', oninput: (e) => { c.exe = e.target.value; c.launch = e.target.value; } });
      const pathInp = el('input', { class: 'inp grow mono', value: c.path || '', placeholder: '安装目录', oninput: (e) => { c.path = e.target.value; } });

      form.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: '启动程序' }), exeInp,
        el('button', { class: 'btn btn-sm', onclick: async () => {
          const f = await API.raw.dialog.pickExe();
          if (!f) return;
          c.exe = f; c.launch = f; exeInp.value = f;
          if (!c.path) { c.path = f.replace(/[\\/][^\\/]+$/, ''); pathInp.value = c.path; }
        } }, uiSpan('folder'), '选择…')));

      form.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: '安装目录' }), pathInp,
        el('button', { class: 'btn btn-sm', onclick: async () => {
          const d = await API.raw.dialog.pickFolder();
          if (!d) return;
          c.path = d; pathInp.value = d;
        } }, uiSpan('folder'), '选择…')));

      /* 分类是**多值**：输入框里用逗号分隔，下面的 chips 点一下加/减一个 */
      const catInp = el('input', { class: 'inp grow', value: (c.categories || []).join('、'), placeholder: '留空则按名字自动归类；多个用逗号分隔',
        oninput: (e) => {
          c.categories = parseCatInput(e.target.value);
          c.categoryLocked = !!c.categories.length;
          drawChips();
        } });
      form.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: '分类' }), catInp));

      // 常用分类快速点选：只重画这一行，不整页重绘（免得别处的输入被打断）
      // 每次都现读 this.cats —— 词表加载晚到也不会一直空着
      // ⚠️ 点击是**切换**（加入 / 移出），不是单选 —— 一款游戏可以挂多个分类
      const chips = el('div', { class: 'wiz-cats' });
      /** 勾上「18+」＝同时挂上 18+ 分类 + 放进隐藏空间（主进程也守着这条规则） */
      const toggleAdult = (on) => {
        setAdult(c, on);
        catInp.value = (c.categories || []).join('、');
        drawChips();
      };
      const drawChips = () => {
        clear(chips);
        const cur = c.categories || [];
        // 跳过「未分类」—— 它不是个要点的分类，点它等于没分类
        for (const x of (this.cats || []).filter((n) => n !== '未分类' && n !== ADULT_CAT).slice(0, 18)) {
          const on = cur.includes(x);
          chips.appendChild(el('button', {
            class: 'cat-chip' + (on ? ' on' : ''),
            title: on ? '再点一下移出这个分类' : '点一下加上这个分类',
            onclick: () => {
              const next = on ? cur.filter((n) => n !== x) : cur.concat([x]);
              c.categories = next;
              c.categoryLocked = !!next.length;
              catInp.value = next.join('、');
              drawChips();
            }
          }, x));
        }
        // 「18+」放在最后（跟普通分类分开，用警示色）：勾上直接进隐藏空间
        const adult = isAdultOf(c);
        chips.appendChild(el('button', {
          class: 'cat-chip adult' + (adult ? ' on' : ''),
          title: adult ? '取消 18+，这款会回到游戏库' : '标成 18+：导入后直接放进隐藏空间',
          onclick: () => toggleAdult(!adult)
        }, '18+'));
      };
      drawChips();
      form.appendChild(chips);
      if (!(this.cats || []).length) {
        // 词表还没到位（向导可以从任何入口打开）→ 拉一次再补画；
        // 只重画 chips 这一行，不整页重绘，免得打断用户正在填的输入框
        this.loadCategories().then(() => drawChips()).catch(() => {});
      }
      form.appendChild(el('p', { class: 'hint', style: { marginTop: '4px' }, text: '一个游戏可以挂多个分类，点上面的分类可以叠加。标成「18+」的游戏导入后会直接放进隐藏空间（不在这里出现）。留空就按游戏名自动归类；手动填过 / 点选过分类的会被锁定，之后扫描不再覆盖。' }));
    }

    const doImport = async (e) => {
      const arr = picked();
      if (!arr.length) return window.Shell.toast('没有要导入的条目', 'err');
      const btn = (e && e.currentTarget) || importBtn;
      btn.disabled = true;
      // 18+ 的那几款会进隐藏空间，导入完成后得单独说一句（不然用户以为没导进去）
      const adultCount = arr.filter((c) => isAdultOf(c)).length;
      const r = await API.raw.games.importCandidates(arr.map((c) => ({
        name: c.name, path: c.path, exe: c.exe, launch: c.launch || c.exe,
        platform: c.platform, appid: c.appid,
        categories: c.categories || [], categoryLocked: !!c.categoryLocked,
        hidden: !!c.hidden,
        source: c.source, cover: c.cover, coverLocal: c.coverLocal, coverKind: c.coverKind
      }))).catch((x) => { window.Shell.toast(x.message, 'err'); return null; });
      btn.disabled = false;
      if (!r) return;
      const base = r.added ? `已导入 ${r.added} 款到游戏库` : '这些游戏之前就都在库里了（信息已补齐）';
      window.Shell.toast(adultCount ? `${base} · ${adultCount} 款标了 18+，已放进隐藏空间` : base, 'ok');
      window.Shell.closeModal();
      this.page = 'library';
      await this.refreshCounts();
      await this.reload();
    };

    const foot = el('div', { class: 'wiz-foot' },
      el('button', { class: 'btn btn-sm', onclick: () => {
        window.Shell.closeModal();
        this.confirmImportDialog(list);
      } }, uiSpan('back'), '返回'),
      countSub,
      el('span', { class: 'grow' }),
      el('button', { class: 'btn btn-sm', onclick: () => window.Shell.closeModal() }, '取消'),
      importBtn);

    this.wizard({
      title: '自动添加 · 逐款自定义',
      hint: '这些条目会逐款落库。可以改名称、主程序、安装目录和分类，改完点「全部导入」。',
      tools: tabs, scroll: form, foot
    });
    drawTabs();
    drawForm();
  },

  /* ============================================================
     MOD 面板（第五十三轮起由独立的 MOD 模块调用：ModsView.renderMain → 这里）
     ------------------------------------------------------------
     · 本地 MOD 目录 —— 由规则引擎（主进程 modpaths.js）推断，可一键采用建议目录
     · Steam 创意工坊 —— <库>/steamapps/workshop/content/<appid>/，
       目录名就是 PublishedFileId；本地缓存里没标题，靠 Steam 公开接口补，
       拿不到就退回显示 ID（功能不依赖联网）
     ============================================================ */
  async buildModsPane(game, rerender) {
    const pane = el('div', { class: 'mods-pane' });
    const dirBox = el('div', { class: 'mods-dir' });
    const tools = el('div', { class: 'mods-tools' });
    const gridBox = el('div', { class: 'mods-grid' });
    /* 内嵌小浏览器（点「Nexus 搜索」时接管列表区）—— 单独一个容器，
       ⚠️ 只在这里建一次；`draw()` 不碰它，否则 webview 会被重挂（dom-ready 丢失）。 */
    const browserBox = el('div', { class: 'mods-browser' });
    pane.appendChild(dirBox);
    pane.appendChild(tools);
    pane.appendChild(gridBox);
    pane.appendChild(browserBox);
    // 换页签回来会重建整个 pane → 把上一次还开着的 webview 收掉，别留下野指针
    if (this._modBrowser) this.closeModBrowser();

    let data = null;
    let refreshing = false;
    let kw = '';
    let origin = 'all';        // all | local | workshop
    let state = 'all';         // all | enabled | disabled

    /* 上一次的读取结果（主进程那边也有缓存）—— 直接先画出来，
       不用每次点进「模组」都对着「正在读取 MOD 目录…」等半天。 */
    const memo = (this._modsMemo && this._modsMemo[game.id]) || null;
    if (memo) data = memo;
    else {
      gridBox.appendChild(el('div', { class: 'empty', style: { minHeight: '140px' } },
        el('div', { class: 'spinner' }),
        el('p', { class: 'text-dim', text: '正在读取 MOD 目录…' })));
    }

    /* ---------- 目录信息卡 ---------- */
    const drawDir = () => {
      clear(dirBox);
      if (data.error) {
        dirBox.appendChild(el('div', { class: 'card danger-card' },
          el('h3', { text: '读取 MOD 信息失败' }),
          el('p', { class: 'hint', text: data.error })));
        return;
      }
      const srcLabel = {
        manual: '你手动指定的目录', probe: '在游戏目录里探测到的 MOD 目录',
        rule: '按这款游戏的常见布局推断', unknown: '还没法确定',
        external: '这款游戏用外置 MOD 管理器'
      }[data.source] || data.source || '未确定';

      const card = el('div', { class: 'card mods-dircard' },
        el('h3', { text: data.external ? '本地 MOD 目录（外置管理器）' : '本地 MOD 目录' }),
        el('p', {
          class: 'hint',
          text: data.external
            ? `这款游戏的 MOD 不由游戏目录管理，得用 ${data.external.tool} 装上（它有自己的 MOD 文件夹）。`
            : 'MOD 会被装到这个目录里；停用 / 启用靠改后缀名 .disabled 实现，不改游戏本体。'
        }),
        el('div', { class: 'row' },
          el('span', { class: 'label', text: '当前目录' }),
          el('span', {
            class: 'grow mono ellipsis', title: data.dir || '',
            text: data.dir || (data.external ? '（外置管理器自带目录）' : '（未确定）')
          }),
          data.hasDir ? el('span', { class: 'chip accent', text: '已就绪' }) : el('span', { class: 'chip danger', text: '未就绪' })),
        el('div', { class: 'row' },
          el('span', { class: 'label', text: '推断依据' }),
          el('span', { class: 'grow', text: srcLabel + (data.note ? ' —— ' + data.note : '') })));

      if (!data.hasDir && data.suggest) {
        card.appendChild(el('div', { class: 'row' },
          el('span', { class: 'label', text: '建议目录' }),
          el('span', { class: 'grow mono ellipsis', title: data.suggest, text: data.suggest })));
      }

      const ops = el('div', { class: 'row wrap mods-dirops' },
        data.hasDir
          ? el('button', { class: 'btn btn-sm', onclick: () => API.raw.shell.openPath(data.dir).catch((e) => window.Shell.toast(e.message, 'err')) }, uiSpan('folder'), '打开目录')
          : null,
        /* 外置管理器：给个「去下工具」的出口 —— 硬猜一个不存在的目录只会让用户白忙 */
        data.external
          ? el('button', { class: 'btn btn-sm', onclick: () => API.raw.shell.openUrl(data.external.url).catch((e) => window.Shell.toast(e.message, 'err')) }, uiSpan('download'), '去下载 ' + data.external.tool)
          : null,
        (!data.hasDir && data.suggest)
          ? el('button', { class: 'btn btn-sm btn-primary', onclick: async () => {
              await API.raw.games.useSuggestedModDir(game.id)
                .then(() => { window.Shell.toast('已创建并使用建议目录', 'ok'); reload(); })
                .catch((e) => window.Shell.toast(e.message, 'err'));
            } }, uiSpan('plus'), '采用建议目录')
          : null,
        el('button', { class: 'btn btn-sm', onclick: async () => {
          const d = await API.raw.dialog.pickFolder();
          if (!d) return;
          await API.raw.games.setModDir(game.id, d)
            .then(() => { window.Shell.toast('MOD 目录已更新', 'ok'); reload(); })
            .catch((e) => window.Shell.toast(e.message, 'err'));
        } }, uiSpan('edit'), '手动指定目录'),
        el('button', { class: 'btn btn-sm', onclick: () => reload() }, uiSpan('refresh'), '刷新'));
      card.appendChild(ops);
      dirBox.appendChild(card);
    };

    /* ---------- 工具行 + 统计 + 筛选 ---------- */
    /** 一组互斥筛选 chip；点一下只改自己的高亮，不重绘整行（否则搜索框会失焦） */
    const chipRow = (defs, getCur, onPick) => {
      const wrap = el('div', { class: 'mods-chips-group' });
      const nodes = defs.map(([k, t]) => {
        const c = el('span', { class: 'chip' + (getCur() === k ? ' on' : '') }, t);
        c.addEventListener('click', () => {
          onPick(k);
          nodes.forEach((n, i) => n.classList.toggle('on', defs[i][0] === k));
          drawGrid();
        });
        wrap.appendChild(c);
        return c;
      });
      return wrap;
    };

    const drawTools = () => {
      clear(tools);
      const c = data.counts || { total: 0, enabled: 0, workshop: 0, local: 0 };
      const bar = el('div', { class: 'mods-bar' },
        el('button', { class: 'btn btn-primary btn-sm', onclick: () => this.importModDialog(game, () => reload()) },
          uiSpan('download'), '快速导入'),
        el('button', { class: 'btn btn-sm', onclick: async () => {
          await API.raw.games.openWorkshop(game.id)
            .then((r) => { if (r && r.fellBack) window.Shell.toast('没检测到 Steam 客户端，已改用网页版创意工坊'); })
            .catch((e) => window.Shell.toast(e.message, 'err'));
        } }, uiSpan('globe'), '创意工坊'),
        el('button', { class: 'btn btn-sm', onclick: () => API.raw.games.openStorePage(game.id).catch((e) => window.Shell.toast(e.message, 'err')) },
          uiSpan('link'), 'Steam 商店'),
        el('button', { class: 'btn btn-sm', onclick: () => this.toggleModBrowser(game, { browserBox, gridBox, reload, rerender, getData: () => data }) },
          uiSpan('search'), 'Nexus 搜索'),
        el('button', { class: 'btn btn-sm', onclick: () => this.modToolkitDialog(game, () => reload()) },
          uiSpan('save'), '对齐工具'),
        /* 主动刷新：绕过所有缓存，重扫本地目录 + 重新取工坊标题 / 封面 */
        el('button', {
          class: 'btn btn-sm', style: { marginLeft: 'auto' },
          disabled: refreshing ? 'disabled' : null,
          title: '重新扫描 MOD 目录，并重新拉取创意工坊的标题与封面',
          onclick: async () => {
            if (refreshing) return;
            refreshing = true; drawTools();
            await reload(true);
            refreshing = false; drawTools();
            window.Shell.toast('MOD 列表已刷新', 'ok');
          }
        }, uiSpan('refresh'), refreshing ? '刷新中…' : '刷新'));
      tools.appendChild(bar);

      tools.appendChild(el('div', { class: 'mods-stats' },
        el('span', { class: 'chip', text: '共 ' + c.total + ' 个' }),
        el('span', { class: 'chip accent', text: '已启用 ' + c.enabled }),
        el('span', { class: 'chip', text: '本地 ' + c.local }),
        el('span', { class: 'chip', text: '创意工坊 ' + c.workshop })));

      const filterRow = el('div', { class: 'mods-filter' },
        el('div', { class: 'field', style: { height: '34px', maxWidth: '240px' } },
          uiSpan('search'),
          el('input', { type: 'text', placeholder: '筛选 MOD…', value: kw,
            oninput: (e) => { kw = e.target.value; drawGrid(); } })),
        el('div', { class: 'mods-chips' },
          chipRow([['all', '全部来源'], ['local', '本地'], ['workshop', '创意工坊']], () => origin, (k) => { origin = k; }),
          el('span', { class: 'mods-sep' }),
          chipRow([['all', '全部状态'], ['enabled', '已启用'], ['disabled', '已停用']], () => state, (k) => { state = k; })));
      tools.appendChild(filterRow);
    };

    const modCard = (m) => el('div', { class: 'mod-card' + (m.enabled ? '' : ' off') },
      // 左侧封面位：创意工坊 MOD 用 Steam 预览图，本地 MOD 没有图就给个渐变占位
      el('div', { class: 'mc-cover' },
        m.cover
          ? el('img', {
              src: m.cover, alt: m.name, loading: 'lazy',
              // 没网 / 图挂了就退回占位符，别留一块空白
              onerror: (e) => {
                const p = e.target.parentElement;
                e.target.remove();
                if (p && !p.querySelector('.mc-ph')) {
                  p.appendChild(el('span', { class: 'mc-ph', text: m.origin === 'workshop' ? '🧩' : '📦' }));
                }
              }
            })
          : el('span', { class: 'mc-ph', text: m.origin === 'workshop' ? '🧩' : '📦' })),
      el('div', { class: 'mc-body' },
        el('div', { class: 'mc-top' },
          el('span', { class: 'mc-badge ' + (m.origin === 'workshop' ? 'ws' : 'local'), text: m.origin === 'workshop' ? '创意工坊' : '本地' }),
          el('span', { class: 'mc-state' + (m.enabled ? ' on' : ''), text: m.enabled ? '启用' : '已停用' })),
        el('div', { class: 'mc-name', title: m.name, text: m.name }),
        el('div', { class: 'mc-meta' },
          el('span', { text: m.size ? formatBytes(m.size) : '—' }),
          m.mtime ? el('span', { class: 'text-dim', text: timeAgo(m.mtime) }) : null),
        el('div', { class: 'mc-ops' },
          m.toggleable
            ? el('button', {
                class: 'btn btn-sm',
                title: m.origin === 'workshop'
                  ? '把目录名加上 .disabled 后缀（Steam 可能会认为该条目缺失并重新下载）'
                  : '把目录 / 文件名加上 .disabled 后缀，不动游戏本体',
                onclick: async () => {
                  await API.raw.games.toggleMod(game.id, m.path)
                    .then(() => {
                      window.Shell.toast(
                        (m.enabled ? '已停用' : '已启用')
                        + (m.origin === 'workshop' ? '（创意工坊：Steam 可能会重新下载这条）' : '（改后缀 .disabled）'));
                      reload();
                    })
                    .catch((e) => window.Shell.toast(e.message, 'err'));
                }
              }, m.enabled ? '停用' : '启用')
            : null,
        m.origin === 'workshop'
          ? el('button', { class: 'btn btn-sm', onclick: () => API.raw.games.openWorkshop(game.id, m.id).catch((e) => window.Shell.toast(e.message, 'err')) }, '工坊页')
          : null,
        el('button', { class: 'btn btn-sm', onclick: () => API.raw.games.revealMod(m.path).catch((e) => window.Shell.toast(e.message, 'err')) }, '定位'),
        m.origin === 'local'
          ? el('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
              const yes = await window.Shell.confirm({ title: '删除「' + m.name + '」？', message: '会移进系统回收站，不是硬删除，可以从回收站恢复。' });
              if (!yes) return;
              await API.raw.games.deleteMod(m.path)
                .then(() => { window.Shell.toast('已移入回收站', 'ok'); reload(); })
                .catch((e) => window.Shell.toast(e.message, 'err'));
            } }, '删除')
          : null)));

    const drawGrid = () => {
      clear(gridBox);
      if (data.error) return;
      let list = (data.mods || []).slice();
      if (origin !== 'all') list = list.filter((m) => m.origin === origin);
      if (state !== 'all') list = list.filter((m) => (state === 'enabled' ? m.enabled : !m.enabled));
      if (kw.trim()) {
        const k = kw.trim().toLowerCase();
        list = list.filter((m) => String(m.name).toLowerCase().includes(k));
      }

      if (!list.length) {
        const noneAtAll = !(data.mods || []).length;
        gridBox.appendChild(el('div', { class: 'empty', style: { minHeight: '160px' } },
          el('div', { class: 'big', text: '🧩' }),
          el('h3', { text: noneAtAll ? '还没有 MOD' : '没有匹配的 MOD' }),
          el('p', { text: noneAtAll
            ? '把下载好的 MOD 拖进来就行 —— 点「快速导入」，支持 .zip / .7z / .rar，也可以直接拖整个文件夹。'
            : '换个筛选条件或清空搜索词试试。' }),
          noneAtAll
            ? el('button', { class: 'btn btn-primary', onclick: () => this.importModDialog(game, () => reload()) },
                uiSpan('download'), '快速导入 MOD')
            : null));
        return;
      }
      const grid = el('div', { class: 'mods-cards' });
      for (const m of list) grid.appendChild(modCard(m));
      gridBox.appendChild(grid);
    };

    const draw = () => { drawDir(); drawTools(); drawGrid(); };
    /** force=true 绕过主进程缓存（对应界面上的「刷新」按钮） */
    const reload = async (force) => {
      try { data = await API.raw.games.mods(game.id, force ? { force: true } : {}); }
      catch (e) { data = { error: e.message, mods: [], counts: { total: 0, enabled: 0, workshop: 0, local: 0 } }; }
      // 记住这次的结果，下次进「模组」标签先拿它直接出画面
      if (!data.error) {
        if (!this._modsMemo) this._modsMemo = {};
        this._modsMemo[game.id] = data;
      }
      draw();
    };
    /* 让「MOD 下载完成」这类外部事件能直接把当前这个面板重扫一遍
       （内嵌小浏览器里下完 → 主进程装好 → 卡片墙立刻能看到新 MOD） */
    this._modsReload = { gameId: game.id, fn: reload };

    if (memo) draw();          // 有记录就立刻画，下面再去拿一次最新的
    reload();
    return pane;
  },

  /* ============================================================
     内嵌 Nexus 小浏览器（模组面板里点「Nexus 搜索」）
     ------------------------------------------------------------
     以前这里是 `shell.openExternal()` —— 直接弹系统浏览器，下完还得用户自己
     找回来手动导入。现在改成在面板里用一块 webview 打开：
       · 和「浏览器」模块共用 `persist:sgj-browser` 分区 → 在任一边登过 Nexus，
         这里直接是登录态（Nexus 下载 MOD 要登录）；
       · 从这个 webview 里下来的文件会被主进程认成「MOD 下载」，
         按设置自动解压进这款游戏的 MOD 目录（或只丢进指定文件夹）。
     ⚠️ 首次导航**必须** `wv.src = url`（guest 是异步附加的，先 append 再 loadURL 会同步抛）。
     ============================================================ */
  async toggleModBrowser(game, ctx) {
    if (this._modBrowser) { this.closeModBrowser(); return; }
    const t = await API.raw.games.nexusTarget(game.id, '')
      .catch((e) => { window.Shell.toast(e.message, 'err'); return null; });
    if (!t) return;
    let cfg = await API.raw.games.modDownloadCfg().catch(() => ({ mode: 'install', dir: '' }));

    const wrap = el('div', { class: 'mb-wrap' });
    const urlInput = el('input', {
      class: 'inp mb-url', spellcheck: 'false', value: t.url,
      title: '可以直接改地址；也可以只输关键词，回车就在 Nexus 里搜'
    });
    const tipLine = el('div', { class: 'mb-tip' });
    const dlLine = el('div', { class: 'mb-dl' });
    const progLine = el('div', { class: 'mb-prog', hidden: true });
    /** 顶部说明：认得出专区就直说，认不出也老实交代是怎么找的 */
    const modBrowserTip = (x) => {
      if (!x) return '';
      if (x.known) return `已定位到本作的 Nexus 专区（${x.slug}）—— 下面就是这款游戏的 MOD。想换个关键词，在上面地址栏里输进去回车。`;
      return '没认出这款游戏的 Nexus 专区，先按游戏名做了全站搜索；想精确找，可在地址栏里直接粘专区地址。';
    };

    /* ---------- 下载落点说明 + 就地切换 ---------- */
    const redrawDl = () => {
      clear(dlLine);
      const d = (ctx.getData && ctx.getData()) || {};
      const fallback = cfg.dir || '拾光集数据目录里的 mod-downloads';
      let desc;
      if (cfg.mode === 'folder') desc = '只下载到：' + fallback;
      else if (d.external) desc = `这款游戏用 ${d.external.tool} 管理 MOD，装不进游戏目录 → 先下载到：` + fallback;
      else if (d.dir) desc = '下载后自动解压进：' + d.dir;
      else if (d.suggest) desc = '下载后自动解压进（会先建好）：' + d.suggest;
      else desc = '还没确定这款游戏的 MOD 目录 → 先下载好，再提示你指定目录';

      dlLine.appendChild(el('span', { class: 'mb-dl-label', text: 'MOD 下载：' }));
      dlLine.appendChild(el('span', { class: 'chip' + (cfg.mode === 'install' ? ' on' : ''),
        title: '下载完自动解压进这款游戏的 MOD 目录',
        onclick: () => setMode('install') }, '装进游戏 MOD 目录'));
      dlLine.appendChild(el('span', { class: 'chip' + (cfg.mode === 'folder' ? ' on' : ''),
        title: '只下载到指定文件夹，不自动安装',
        onclick: () => setMode('folder') }, '只下载到文件夹'));
      dlLine.appendChild(el('span', { class: 'grow mb-dl-desc', title: desc, text: desc }));
      dlLine.appendChild(el('button', { class: 'btn btn-sm btn-ghost',
        onclick: () => window.Shell.go('#/settings') }, '下载设置'));
    };
    const setMode = async (mode) => {
      if (cfg.mode === mode) return;
      cfg = Object.assign({}, cfg, { mode });
      await State.set({ modDownload: { mode } }).catch(() => {});
      redrawDl();
      window.Shell.toast(mode === 'install' ? '下载后会自动装进游戏的 MOD 目录' : '下载只保存到文件夹，不自动安装');
    };

    /* ---------- webview（工具条上的按钮都操作它，所以先建） ---------- */
    const wv = document.createElement('webview');
    /* ⚠️ guest 是**异步附加**的：只有设 src 之后它才 attach，attach 之前
       loadURL/executeJavaScript 会**同步抛**（不是 reject）。attached 就是这道闸。 */
    let attached = false;
    const safe = (fn) => { try { fn(); } catch { /* webview 还没就绪 */ } };
    const load = (url) => {
      safe(() => { if (attached) wv.loadURL(url); else { wv.src = url; attached = true; } });
    };
    /** 地址栏回车：像地址就直接跳，不像地址就在 Nexus 里搜 */
    const go = () => {
      const v = String(urlInput.value || '').trim();
      if (!v) return;
      if (/^https?:\/\//i.test(v)) return load(v);
      if (/^[\w-]+(\.[\w-]+)+([/?#]|$)/.test(v)) return load('https://' + v);
      const m = v.match(/nexusmods\.com\/([a-z0-9_-]+)(?:\/|$)/i);
      const slug = (m && m[1] && !/^(search|users|games)$/i.test(m[1])) ? m[1] : (t.slug || '');
      load(`https://www.nexusmods.com/${slug ? slug + '/' : ''}search/?gsearch=${encodeURIComponent(v)}`);
    };
    urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });

    /* ---------- 工具条 ---------- */
    const mkBtn = (label, title, fn) => el('button', { class: 'btn btn-sm', title, onclick: fn }, label);
    const bar = el('div', { class: 'mb-bar' },
      mkBtn('‹', '后退', () => safe(() => wv.canGoBack() && wv.goBack())),
      mkBtn('›', '前进', () => safe(() => wv.canGoForward() && wv.goForward())),
      mkBtn('⟳', '重新加载', () => safe(() => wv.reload())),
      urlInput,
      el('button', { class: 'btn btn-sm', style: { flex: 'none' }, onclick: go }, '转到'),
      el('span', { class: 'grow' }),
      mkBtn('用系统浏览器打开', '内嵌浏览器过不了人机验证时走这里', () => API.raw.games.modBrowserSystemOpen(urlInput.value)),
      el('button', { class: 'btn btn-sm btn-primary', style: { flex: 'none' }, onclick: () => this.closeModBrowser() }, '关闭'));

    /* ---------- webview 属性 + 事件 ---------- */
    wv.className = 'mb-wv';
    wv.setAttribute('partition', 'persist:sgj-browser');
    wv.setAttribute('webpreferences', 'contextIsolation=yes,nodeIntegration=no,webSecurity=yes');
    wv.setAttribute('allowpopups', 'on');
    wv.setAttribute('useragent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');

    const setUrl = (u) => { urlInput.value = u; urlInput.title = u; };
    wv.addEventListener('did-start-loading', () => { attached = true; tipLine.textContent = '正在打开 Nexus…'; });
    wv.addEventListener('did-stop-loading', () => {
      try { setUrl(wv.getURL()); } catch { /* ignore */ }
      tipLine.textContent = modBrowserTip(t);
    });
    wv.addEventListener('did-navigate', (e) => setUrl(e.url));
    wv.addEventListener('did-navigate-in-page', (e) => setUrl(e.url));
    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3) return;                 // -3 = 用户主动中断，不算错
      tipLine.textContent = `打不开（错误码 ${e.errorCode}）。Nexus 有 Cloudflare 人机验证，过不去就用「用系统浏览器打开」。`;
    });
    /* ⚠️ 主进程还没把这只 webview 登记成「MOD 下载来源」之前，
       它下的东西会落到普通下载目录 —— 所以 dom-ready 里第一件事就是登记。 */
    wv.addEventListener('dom-ready', () => {
      attached = true;
      let wcId = NaN;
      try { wcId = wv.getWebContentsId(); } catch { /* 还没附加 */ }
      API.raw.games.modBrowser({ open: true, gameId: game.id, gameName: game.name, wcId }).catch(() => {});
    });

    /* ---------- 下载进度 / 结果（由主进程 games:mod-download 推过来） ---------- */
    const setProg = (p) => {
      if (!p) return;
      progLine.hidden = false;
      if (p.ok === undefined) {
        const tot = Number(p.total) || 0;
        const got = Number(p.received) || 0;
        const pct = tot ? Math.round((got / tot) * 100) : 0;
        progLine.className = 'mb-prog run';
        progLine.textContent = `正在下载 ${p.name}` + (tot ? `（${pct}% · ${formatBytes(got)}/${formatBytes(tot)}）` : `（${formatBytes(got)}）`);
        return;
      }
      progLine.className = 'mb-prog ' + (p.ok ? 'ok' : 'err');
      if (p.ok && p.mode === 'folder') progLine.textContent = `已下载：${p.name}`;
      else if (p.ok) progLine.textContent = `已装进 MOD 目录：${p.name}`;
      else progLine.textContent = `没能完成：${p.name}（${p.error || p.state}）`;
    };

    wrap.appendChild(bar);
    wrap.appendChild(tipLine);
    wrap.appendChild(dlLine);
    wrap.appendChild(progLine);
    wrap.appendChild(wv);
    ctx.browserBox.appendChild(wrap);
    ctx.gridBox.style.display = 'none';
    redrawDl();
    tipLine.textContent = modBrowserTip(t);

    // ⚠️ 第一次只能靠 src 附加 guest（见文件头 / 浏览器模块的教训）
    wv.src = t.url;

    this._modBrowser = {
      game, wv, ctx, setProg,
      get wcId() { try { return wv.getWebContentsId(); } catch { return NaN; } }
    };
  },

  /** 内嵌小浏览器里的下载进度 / 结果（主进程 games:mod-download） */
  onModDownload(p) {
    if (!p) return;
    const mb = this._modBrowser;
    if (mb && mb.setProg && (!p.gameId || mb.game.id === p.gameId)) mb.setProg(p);
    if (p.ok === undefined) return;                    // 还在下，别打断用户
    const nm = p.name || 'MOD';
    const at = (d) => (d && this.currentId === p.gameId) ? '' : `（在「${mb && mb.game ? mb.game.name : '这款游戏'}」的 MOD 面板里看）`;
    if (p.ok && p.mode === 'folder') {
      window.Shell.toast(`已下载 ${nm}` + (p.path ? ` → ${p.path}` : ''), 'ok');
    } else if (p.ok) {
      window.Shell.toast(`已把 ${nm} 装进 MOD 目录` + (p.dir ? `（${p.dir}）` : ''), 'ok');
      // 装完立刻重扫一次，卡片墙马上能看到新 MOD（force 绕过缓存）
      if (this._modsReload && this._modsReload.gameId === p.gameId) this._modsReload.fn(true);
    } else {
      window.Shell.toast(`MOD 没装成功：${nm} —— ${p.error || p.state}` + (p.path ? `\n文件保留在：${p.path}` : '') + at(), 'err');
    }
  },

  closeModBrowser() {
    const m = this._modBrowser;
    if (!m) return;
    this._modBrowser = null;
    const wcId = m.wcId;
    API.raw.games.modBrowser({ open: false, wcId }).catch(() => {});
    try { m.wv.remove(); } catch { /* ignore */ }
    if (m.ctx.browserBox) clear(m.ctx.browserBox);
    if (m.ctx.gridBox) m.ctx.gridBox.style.display = '';
  },

  /** 小浏览器里点开的链接（主进程把 window.open 拦下来交回这里）→ 就地跳过去 */
  modBrowserNav(d) {
    const m = this._modBrowser;
    if (!m || !d || !d.url) return;
    try { if (m.wv.getURL()) m.wv.loadURL(d.url); else m.wv.src = d.url; }
    catch { m.wv.src = d.url; }
  },

  /* ============================================================
     MOD · 快速导入弹窗
     ------------------------------------------------------------
     ⚠️ Electron ≥32 已经删掉 File.path，拖进来的文件必须走
        preload 的 webUtils.getPathForFile，否则拿不到真实路径。
     ============================================================ */
  importModDialog(game, onDone) {
    if (!window.Shell || !window.Shell.modal) return;
    const ARC_RE = /\.(zip|7z|rar|tar|gz|tgz|bz2|xz)$/i;
    const sources = [];
    const body = el('div');
    const listBox = el('div', { class: 'drop-list' });
    const prog = el('div', { class: 'imp-progress' });

    const addPaths = (paths) => {
      let added = 0;
      for (const p of paths) {
        if (!p) continue;
        if (!sources.includes(p)) { sources.push(p); added++; }
      }
      if (added) drawList();
      else if (paths.length) window.Shell.toast('这些已经在列表里了');
    };

    const removeOne = (p) => { const i = sources.indexOf(p); if (i >= 0) sources.splice(i, 1); drawList(); };

    const drawList = () => {
      clear(listBox);
      if (!sources.length) {
        listBox.appendChild(el('p', { class: 'text-dim', style: { fontSize: '.86em', margin: '10px 0 0' }, text: '还没有选择任何文件。' }));
        return;
      }
      sources.forEach((p) => {
        listBox.appendChild(el('div', { class: 'drop-item' },
          el('span', { class: 'di-ic' }, uiSpan(ARC_RE.test(p) ? 'save' : 'folder')),
          el('span', { class: 'grow ellipsis', title: p, text: window.util.baseName(p) }),
          el('span', { class: 'chip', text: ARC_RE.test(p) ? '压缩包' : '文件夹 / 文件' }),
          el('button', { class: 'btn btn-sm', onclick: () => removeOne(p) }, '移除')));
      });
    };

    /* ---------- 拖放区 ---------- */
    const dz = el('div', { class: 'drop-zone' },
      el('span', { class: 'dz-ic' }, uiSpan('download')),
      el('div', { class: 'dz-t', text: '把 MOD 压缩包或文件夹拖到这里' }),
      el('div', { class: 'dz-s', text: '支持 .zip / .7z / .rar / .tar.gz，也可以直接拖整个 MOD 文件夹' }),
      el('div', { class: 'row', style: { justifyContent: 'center', gap: '10px' } },
        el('button', { class: 'btn btn-sm', onclick: async () => {
          const f = await API.raw.dialog.pickFiles({
            filters: [{ name: 'MOD 压缩包', extensions: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz'] }]
          });
          if (f && f.length) addPaths(f);
        } }, uiSpan('save'), '选择压缩包'),
        el('button', { class: 'btn btn-sm', onclick: async () => {
          const d = await API.raw.dialog.pickFolders ? await API.raw.dialog.pickFolders() : await API.raw.dialog.pickFolder();
          if (d) addPaths(Array.isArray(d) ? d : [d]);
        } }, uiSpan('folder'), '选择文件夹')));

    dz.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.add('on'); });
    dz.addEventListener('dragenter', (e) => { e.preventDefault(); dz.classList.add('on'); });
    dz.addEventListener('dragleave', (e) => { e.preventDefault(); if (e.target === dz) dz.classList.remove('on'); });
    dz.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      dz.classList.remove('on');
      const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
      addPaths(files.map((f) => API.raw.pathForFile(f)));
    });

    body.appendChild(el('p', { class: 'hint', style: { marginTop: 0 },
      text: '压缩包会被解到「以压缩包名命名的子目录」里（否则文件散落在 MOD 根目录，游戏认不出来）；文件夹会整份复制过去。重名会自动加序号，不会覆盖已有 MOD。' }));
    body.appendChild(dz);
    body.appendChild(listBox);
    body.appendChild(prog);
    drawList();

    window.Shell.modal({
      title: '快速导入 MOD · ' + game.name, wide: true, body,
      cancelText: '关闭', okText: '开始导入',
      onOk: async () => {
        if (!sources.length) { window.Shell.toast('先添加要导入的文件', 'err'); throw new Error('没有待导入的文件'); }
        clear(prog);
        prog.appendChild(el('div', { class: 'row' },
          el('div', { class: 'spinner' }),
          el('span', { class: 'grow', text: '正在导入…' })));
        const off = API.on('games:mod-import', (p) => {
          if (!p) return;
          clear(prog);
          prog.appendChild(el('div', { class: 'row' },
            el('div', { class: 'spinner' }),
            el('span', { class: 'grow ellipsis', text: '正在导入：' + p.name }),
            el('span', { class: 'chip accent', text: p.done + ' / ' + p.total })));
        });
        let r = null;
        try { r = await API.raw.games.importMods(game.id, sources); }
        catch (e) { off(); clear(prog); prog.appendChild(el('p', { class: 'text-dim', text: e.message })); throw e; }
        off();
        clear(prog);
        prog.appendChild(el('div', { class: 'row' },
          el('span', { class: 'chip accent', text: '成功 ' + r.ok }),
          r.failed ? el('span', { class: 'chip danger', text: '失败 ' + r.failed }) : null,
          el('span', { class: 'grow text-dim ellipsis', title: r.dir, text: '→ ' + r.dir })));
        for (const x of (r.results || []).filter((y) => !y.ok)) {
          prog.appendChild(el('div', { class: 'imp-err', text: '✗ ' + x.name + '：' + x.error }));
        }
        window.Shell.toast(r.failed ? `导入完成：成功 ${r.ok} 个，失败 ${r.failed} 个` : `导入完成：${r.ok} 个`, r.failed ? 'err' : 'ok');
        if (onDone) onDone();
        // 有失败就留在弹窗里让用户看清原因，全成功才自动关
        if (!r.failed) setTimeout(() => window.Shell.closeModal(), 700);
      }
    });
  },

  /* ============================================================
     MOD · 对齐工具（快速打包 / MOD 码 / 对比）
     ============================================================ */
  modToolkitDialog(game, onDone) {
    if (!window.Shell || !window.Shell.modal) return;
    let mode = 'pack';
    const body = el('div');
    const tabBar = el('div', { class: 'mtabs' });
    const pane = el('div');

    const renderTabs = () => {
      clear(tabBar);
      [['pack', '快速打包'], ['code', '生成 MOD 码'], ['diff', '对比别人的码']].forEach(([k, t]) =>
        tabBar.appendChild(el('button', { class: 'mtab' + (mode === k ? ' on' : ''), onclick: () => { mode = k; draw(); } }, t)));
    };

    /* ---- 快速打包：整个 MOD 目录压成一个 zip ---- */
    const packPane = () => {
      const box = el('div');
      box.appendChild(el('p', { class: 'hint', style: { marginTop: 0 },
        text: '把这款游戏的整个 MOD 目录压成一个 zip —— 换机器、备份、发给朋友都方便。目录里的点文件（.DS_Store 之类）会被跳过。' }));
      const out = el('div', { class: 'tk-out' });
      const run = async (toDefault) => {
        clear(out);
        out.appendChild(el('div', { class: 'row' }, el('div', { class: 'spinner' }), el('span', { text: '正在打包…' })));
        let target = '';
        if (!toDefault) {
          const p = await API.raw.dialog.pickSave({
            defaultPath: (game.name || 'mods') + '-mods.zip',
            filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }]
          });
          if (!p) { clear(out); return; }
          target = p;
        }
        try {
          const r = await API.raw.games.packMods(game.id, target);
          clear(out);
          // 主进程返回 { file, count, size, rawBytes, dir, name }
          const zip = r.file || '';
          out.appendChild(el('div', { class: 'row' },
            el('span', { class: 'chip accent', text: '打包完成' }),
            el('span', { class: 'grow ellipsis', title: zip, text: r.name || zip }),
            el('span', { class: 'chip', text: r.count + ' 项' }),
            r.size ? el('span', { class: 'chip', text: formatBytes(r.size) }) : null));
          out.appendChild(el('div', { class: 'row' },
            el('button', { class: 'btn btn-sm', onclick: () => API.raw.shell.openPath(zip.replace(/[\\/][^\\/]+$/, '')).catch(() => {}) }, uiSpan('folder'), '打开所在文件夹')));
          window.Shell.toast('已打包 ' + (r.name || ''), 'ok');
        } catch (e) {
          clear(out);
          out.appendChild(el('p', { class: 'text-dim', text: e.message }));
          window.Shell.toast(e.message, 'err');
        }
      };
      box.appendChild(el('div', { class: 'row wrap', style: { gap: '10px' } },
        el('button', { class: 'btn btn-primary', onclick: () => run(false) }, uiSpan('save'), '选择位置并打包'),
        el('button', { class: 'btn', onclick: () => run(true) }, uiSpan('download'), '打包到下载文件夹')));
      box.appendChild(out);
      return box;
    };

    /* ---- MOD 码：把当前清单压成一段短码，方便互相校对 ---- */
    const codePane = () => {
      const box = el('div');
      box.appendChild(el('p', { class: 'hint', style: { marginTop: 0 },
        text: 'MOD 码是当前 MOD 清单（名字+数量）的压缩指纹，确定性生成：只要清单一样，两台机器算出来的码就完全一样。把码发给朋友，他就能用「对比」看你少了什么。' }));
      const out = el('div', { class: 'tk-out' });
      box.appendChild(el('button', { class: 'btn btn-primary', onclick: async () => {
        clear(out);
        out.appendChild(el('div', { class: 'row' }, el('div', { class: 'spinner' }), el('span', { text: '正在生成…' })));
        try {
          const r = await API.raw.games.modCode(game.id);
          clear(out);
          // 注意：<textarea> 没有 value 属性，必须赋 value 属性值而不是 setAttribute
          const ta = el('textarea', { class: 'inp mono', rows: 3 });
          ta.value = r.code;
          ta.readOnly = true;
          out.appendChild(el('div', { class: 'row' },
            el('span', { class: 'chip accent', text: r.count + ' 个 MOD' }),
            el('span', { class: 'grow' }),
            el('button', { class: 'btn btn-sm', onclick: async () => {
              try { await navigator.clipboard.writeText(r.code); window.Shell.toast('已复制 MOD 码', 'ok'); }
              catch { ta.select(); document.execCommand('copy'); window.Shell.toast('已复制', 'ok'); }
            } }, uiSpan('save'), '复制')));
          out.appendChild(ta);
        } catch (e) {
          clear(out);
          out.appendChild(el('p', { class: 'text-dim', text: e.message }));
        }
      } }, uiSpan('save'), '生成 MOD 码'));
      box.appendChild(out);
      return box;
    };

    /* ---- 对比：粘别人的码，列出「你缺的 / 你多的」 ---- */
    const diffPane = () => {
      const box = el('div');
      box.appendChild(el('p', { class: 'hint', style: { marginTop: 0 },
        text: '把朋友的 MOD 码粘进来，看看你们差在哪 —— 码里自带数量与 CRC32 校验，抄错了会直接告诉你，不会给出错误的对比结果。' }));
      const inp = el('textarea', { class: 'inp mono', rows: 3, placeholder: '粘贴对方的 MOD 码（GHMOD1-…）' });
      const out = el('div', { class: 'tk-out' });
      box.appendChild(inp);
      box.appendChild(el('div', { class: 'row', style: { marginTop: '10px' } },
        el('button', { class: 'btn btn-primary', onclick: async () => {
          const code = inp.value.trim();
          if (!code) return window.Shell.toast('先粘贴一个 MOD 码', 'err');
          clear(out);
          out.appendChild(el('div', { class: 'row' }, el('div', { class: 'spinner' }), el('span', { text: '正在对比…' })));
          try {
            const r = await API.raw.games.compareMods(game.id, code);
            clear(out);
            out.appendChild(el('div', { class: 'row wrap', style: { gap: '8px' } },
              el('span', { class: 'chip', text: '你 ' + r.mineCount + ' 个' }),
              el('span', { class: 'chip', text: '对方 ' + r.theirsCount + ' 个' }),
              el('span', { class: 'chip accent', text: '一致 ' + (r.same || 0) })));
            const group = (title, arr, cls) => {
              out.appendChild(el('h4', { class: 'tk-h' + (cls ? ' ' + cls : ''), text: title + '（' + (arr || []).length + '）' }));
              if (!(arr || []).length) { out.appendChild(el('p', { class: 'text-dim', style: { fontSize: '.86em', margin: '2px 0 0' }, text: '无' })); return; }
              const ul = el('div', { class: 'tk-list' });
              for (const n of arr) ul.appendChild(el('div', { class: 'tk-li', text: n }));
              out.appendChild(ul);
            };
            group('你缺少的', r.missing, 'miss');
            group('你多出的', r.extra, 'extra');
          } catch (e) {
            clear(out);
            out.appendChild(el('p', { class: 'text-dim', text: 'MOD 码无效：' + e.message }));
          }
        } }, uiSpan('refresh'), '开始对比')));
      box.appendChild(out);
      return box;
    };

    const draw = () => {
      renderTabs();
      clear(pane);
      pane.appendChild(mode === 'pack' ? packPane() : mode === 'code' ? codePane() : diffPane());
    };
    draw();
    body.appendChild(tabBar);
    body.appendChild(pane);

    window.Shell.modal({ title: 'MOD 对齐工具 · ' + game.name, wide: true, body, cancelText: '关闭', okText: false });
  },

  /* ============================================================
     封面设置
     ------------------------------------------------------------
     mode: search（联网按名字搜 Steam AppID）/ icon（提 exe 图标）
           refresh（丢缓存重走完整链）/ default（连自定义封面一起清掉）
     ============================================================ */
  COVER_KIND_TEXT: { custom: '自定义', local: '本地缓存', steam: 'Steam 官方', icon: 'exe 图标', none: '无' },

  /** 重新取一份游戏记录（列表里那份可能是旧的） */
  async refreshGame(id) {
    const all = await API.raw.games.list({ view: 'all' }).catch(() => []);
    return all.find((x) => x.id === id) || null;
  },

  async coverAction(game, mode) {
    const busy = {
      search: '正在联网搜索封面…', icon: '正在提取程序图标…',
      refresh: '正在重新抓取封面…', default: '正在恢复默认封面…'
    }[mode] || '处理中…';
    window.Shell.toast(busy);
    try {
      await API.raw.games.resolveCover(game.id, { allowNetwork: true, mode });
    } catch (e) {
      return window.Shell.toast(e.message, 'err');
    }
    await this.reload();
    const fresh = (this.list || []).find((x) => x.id === game.id) || await this.refreshGame(game.id);
    if (fresh) Object.assign(game, fresh);
    const kind = (fresh || game).coverKind;
    const has = !!this.coverSrc(fresh || game);
    if (!has && mode === 'icon') window.Shell.toast('没能提取到图标 —— 这款游戏没记录启动程序（.exe）', 'err');
    else if (!has && mode === 'search') window.Shell.toast('联网没搜到对应封面', 'err');
    else window.Shell.toast('封面已更新（' + (this.COVER_KIND_TEXT[kind] || '无') + '）', 'ok');
    this.openDetail(game.id);
  },

  async pickCoverFile(game) {
    let files = null;
    try {
      files = await API.raw.dialog.pickFiles({
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
      });
    } catch (e) { return window.Shell.toast(e.message, 'err'); }
    const f = files && files[0];
    if (!f) return;
    try {
      await API.raw.games.setCover(game.id, f);
    } catch (e) { return window.Shell.toast(e.message, 'err'); }
    window.Shell.toast('已设为自定义封面（自动流程不会再覆盖它）', 'ok');
    await this.reload();
    const fresh = (this.list || []).find((x) => x.id === game.id) || await this.refreshGame(game.id);
    if (fresh) Object.assign(game, fresh);
    this.openDetail(game.id);
  },

  /* ============================================================
     右键菜单
     ============================================================ */
  ctxMenu(e, g) {
    const cur = clearOf(g);
    window.Shell.contextMenu(e.clientX, e.clientY, [
      { label: '启动游戏', icon: 'play', onClick: () => this.launch(g.id) },
      { label: '打开 MOD', icon: 'extension', onClick: () => this.openMods(g) },
      { label: '打开目录', icon: 'folder', onClick: () => API.raw.games.openFolder(g.id).catch(() => {}) },
      { label: g.favorite ? '取消收藏' : '加收藏', icon: 'star', onClick: () => API.raw.games.update(g.id, { favorite: !g.favorite }, { silent: true }).then(() => this.reload()) },
      { label: '重新获取封面', icon: 'image', onClick: async () => { await API.raw.games.resolveCover(g.id, { allowNetwork: true }).catch(() => {}); window.Shell.toast('已重新获取封面'); this.reload(); } },
      { divider: true },
      /* 通关状态：三档固定顺序，当前档位那一项打勾 */
      ...CLEAR_ORDER.map((k) => ({
        label: '标记为' + CLEAR_META[k].label,
        icon: cur === k ? 'check' : 'edit',
        onClick: async () => {
          if (cur === k) { window.Shell.toast(`已经是「${CLEAR_META[k].label}」了`); return; }
          await API.raw.games.update(g.id, { clearState: k }, { silent: true })
            .then(() => { window.Shell.toast('已标记为' + CLEAR_META[k].label, 'ok'); this.reload(); })
            .catch((x) => window.Shell.toast(x.message, 'err'));
        }
      })),
      { divider: true },
      { label: g.hidden ? '移出隐藏空间' : '加入隐藏空间（18+）', icon: 'lock', onClick: async () => {
          await API.raw.games.setHidden([g.id], !g.hidden).catch((x) => window.Shell.toast(x.message, 'err'));
          window.Shell.toast(g.hidden ? '已移出隐藏空间' : '已加入隐藏空间', 'ok');
          this.reload();
        } },
      { label: '管理分类…', icon: 'settings', onClick: () => this.categoryDialog(() => this.reload()) },
      { divider: true },
      { label: '卸载游戏', icon: 'trash', danger: true, onClick: async () => {
          const info = await API.raw.games.uninstallInfo(g.id).catch((x) => { window.Shell.toast(x.message, 'err'); return null; });
          if (!info) return;
          if (!info.safe) return window.Shell.toast('没有安全可用的卸载方式：' + info.detail, 'err');
          const yes = await window.Shell.confirm({ title: '确认卸载「' + g.name + '」？', message: info.detail, detail: info.warn || '', danger: true, okText: '执行卸载' });
          if (!yes) return;
          const r = await API.raw.games.uninstall(g.id, { removeRecord: info.route === 'trash' }).catch((x) => ({ ok: false, message: x.message }));
          window.Shell.toast(r.message || (r.ok ? '已开始卸载' : '卸载失败'), r.ok ? 'ok' : 'err');
          setTimeout(() => this.reload(), 900);
        } },
      { label: '从库中移除（不删文件）', icon: 'trash', onClick: () => API.raw.games.remove([g.id]).then(() => { window.Shell.toast('已移除记录'); this.reload(); }) }
    ]);
  },

  reloadDebounced: null,
  onEvent() {
    /* ⚠️ 这里原来订阅了 `games:changed` / `games:state` → reload()，但这两条**不在**
       主进程的 PUSH_EVENTS 白名单里（它们会整页重绘、顶掉滚动位置，从一开始就没转发过），
       所以那两个订阅从来是死代码，已删。
       运行状态改走语义很窄的 `games:run-state`：界面只就地改那一张卡（见 applyRunState）。 */
    API.on('games:run-state', (p) => this.applyRunState(p));
    API.on('games:notice', (p) => this.onRunNotice(p));
  }
};

GamesView.reloadDebounced = window.util.debounce(() => GamesView.reload(), 220);
window.GamesView = GamesView;

/* ------------------------------------------------------------
 *  事件订阅：⚠️ 一律写在 IIFE 末尾 —— 模块只加载一次，订阅也只注册一次。
 *  写进 mount() 里会「每进一次游戏模块就叠一层监听」（通知弹好几次），这坑踩过。
 *  对应主进程 PUSH_EVENTS 里的 'games:mod-download' / 'games:mod-browser-nav'。
 * ------------------------------------------------------------ */
GamesView.onEvent();        // ⚠️ 以前这个函数定义了却从没被调用 —— 里面两条订阅全是死代码
API.on('games:mod-download', (p) => GamesView.onModDownload(p));
API.on('games:mod-browser-nav', (d) => GamesView.modBrowserNav(d));
})();
