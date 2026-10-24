/**
 * 拾光集 · 壳体 (shell.js)
 * 路由、主界面 Hub、设置页，以及 Toast / Modal / 右键菜单 等公共浮层。
 */
'use strict';
(function () {
const { el, clear } = window.util;
const { uiSpan } = window.ICON;

const Shell = {
  view: null,

  /* ============================================================
     启动
     ============================================================ */
  /** 第五十八轮：已加载的 dll 模块（界面上能显示「这个模块是真 dll」） */
  dllModules: [],
  dllErrors: [],

  /**
   * 把 dll 模块里的**渲染层代码**装进来。
   *
   * ⚠️ 为什么走自定义协议而不是 eval / 内联 <script>：
   *    CSP 是 `script-src 'self' sgj-plugin: sgj-mod:`，**没有 unsafe-eval 也没有
   *    unsafe-inline**。内联脚本和 `new Function` 都会被浏览器直接拦掉。
   *    第三方插件早就踩过同一个坑，解法一致：注册受控协议，用正常 <script src> 加载。
   *
   * ⚠️ 一个 dll 挂了不许拖垮启动：少一个模块只是少一张卡，主界面必须还在。
   */
  async loadDllModules() {
    const r = await API.raw.modules.list().catch(() => null);
    const list = (r && r.modules) || [];
    this.dllModules = list;
    this.dllErrors = (r && r.errors) || [];
    for (const m of list) {
      const id = m && m.manifest && m.manifest.id;
      if (!id) continue;
      try {
        /* C 版：渲染层与样式由 dll 自己带着，宿主用本地 http 服务出来 */
        if (m.hasStyles && m.styleUrl) await this._loadLink(m.styleUrl);
        await this._loadScript(m.rendererUrl || `${window.__SGJ_BASE}mod/${id}/renderer.js`);
      } catch (e) {
        console.error('[modules] ' + id + ' 渲染层加载失败：' + (e && e.message));
        this.dllErrors.push({ file: id + '.dll', error: '渲染层加载失败' });
      }
    }
  },

  _loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve(true);
      s.onerror = () => reject(new Error('script 加载失败：' + src));
      document.head.appendChild(s);
    });
  },

  /** CSS 挂了不拦路（页面照样能用，只是不好看） */
  _loadLink(href) {
    return new Promise((resolve) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      l.onload = () => resolve(true);
      l.onerror = () => resolve(false);
      document.head.appendChild(l);
    });
  },

  async boot() {
    this.view = document.getElementById('view');

    // 标题栏交互
    document.getElementById('winMin').onclick = () => API.raw.win.minimize();
    document.getElementById('winMax').onclick = () => API.raw.win.maximize();
    document.getElementById('winClose').onclick = () => API.raw.win.close();
    document.getElementById('brand').onclick = () => this.go('#/');
    document.getElementById('btnTheme').onclick = () => this.toggleTheme();
    // 标题栏的齿轮 → 当前模块的独立设置（只在模块页显示，见 renderTitlebar）
    document.getElementById('btnModSet').onclick = () => this.openModuleSettings();

    await State.load();
    /* 第五十八轮：dll 模块。功能不再全内嵌 —— `modules/*.dll` 里带着各模块的
       渲染层代码，靠 `sgj-mod://<id>/renderer.js` 加载进来。
       ⚠️ 必须在 route() **之前**：路由一进来就会找 window.XXXView，
       晚一步就是「路由对、内容区全空」。
       ⚠️ 一个 dll 加载失败不许拖垮启动 —— 少一个模块只是少一张卡。 */
    await this.loadDllModules();
    this.renderTitlebar();
    // 常驻迷你播放卡片（跨路由；内容自己建，这里只负责初始化）
    if (window.MiniPlayer) window.MiniPlayer.init();

    // 全局事件
    API.on('settings:changed', (s) => { State.settings = s; State.applyTheme(); this.renderTitlebar(); });
    API.on('appearance:changed', async () => {
      const bg = await API.raw.appearance.urls().catch(() => ({}));
      State.settings.background = { content: (bg.content || '').replace(/^file:\/\//, ''), opacity: bg.opacity };
      State.applyTheme();
    });
    /* 第四十九轮：插件开关变了（设置页点的，也可能是另一处入口）→
       重取插件表 + 标题栏；如果正停在被关掉的那个页面上，route() 会 toast 并回主界面。
       ⚠️ 主进程 `plugins:set` 之后一定会广播这一条，所以设置页那边**不用自己重画**
          （自己再画一次会和这条打架，出现闪一下或叠加一页）。 */
    API.on('hub:modules-changed', () => { this.onModulesChanged(); });
    /* 后台（或手动）查到了新版本 → 先弹一条提示；细节与下载按钮在 设置 → 更新 里。 */
    API.on('update:available', (info) => this.onUpdateAvailable(info));

    window.addEventListener('hashchange', () => this.route());
    // 隐藏空间活动计时（隐藏空间现在挂在游戏模块内）
    window.addEventListener('click', () => { if (location.hash.startsWith('#/games')) API.raw.hidden.activity().catch(() => {}); });

    document.getElementById('modals').addEventListener('click', (e) => { if (e.target.classList.contains('modal-mask')) this.closeModal(); });
    document.getElementById('ctxMenu').addEventListener('click', () => this.hideContextMenu());
    window.addEventListener('click', (e) => { if (!e.target.closest('#ctxMenu')) this.hideContextMenu(); });

    this.route();
  },

  renderTitlebar() {
    const bread = document.getElementById('tbBread');
    clear(bread);
    /* 第四十九轮：模块名不再写死成一张 map —— **插件清单就是唯一来源**。
       写死有两个坑：以后加插件只改后端会「标题栏空白」；删插件忘了删 map 又不报错。
       联机也在清单里，所以「主界面 / 联机」照样显示（它的设置齿轮仍不登记，见 moduleKeyFromHash）。 */
    const name = this.crumbOf(location.hash || '#/');
    if (name) bread.appendChild(el('span', { class: 'crumb', onclick: () => this.go('#/') }, '主界面'));
    if (name) bread.appendChild(el('span', { class: 'sep', text: '/' }));
    if (name) bread.appendChild(el('span', { style: { color: 'var(--text)' }, text: name }));
    // 模块设置齿轮：只在模块页出现（主界面 / 全局设置页不该有它）
    const key = this.moduleKeyFromHash();
    const gear = document.getElementById('btnModSet');
    if (gear) {
      const m = key ? this.MOD_SETTINGS.find((x) => x.key === key) : null;
      gear.hidden = !m;
      gear.title = m ? `${m.name} 模块设置` : '当前模块设置';
    }
  },

  /** 当前 hash 对应的中文名（'' = 主界面 / 未知） */
  crumbOf(hash) {
    const h = String(hash || '');
    if (!h || h === '#/') return '';
    if (h === '#/settings') return '设置';
    const hit = this.pluginOf(h);
    return hit ? hit.title : '';
  },

  /**
   * 这一串 hash 属于哪个插件（清单里查，**不管有没有启用**）。
   * 第四十九轮：以前是 `moduleKeyFromHash` 那种硬编码，现在统一从 State.plugins 里找 ——
   * 按 route 长度倒序比，将来出现 #/link 和 #/link2 也不会串。
   */
  pluginOf(hash) {
    const h = String(hash || '');
    const list = (State.plugins && State.plugins.list) || [];
    return list
      .filter((p) => h === p.route || h.startsWith(p.route + '/'))
      .sort((a, b) => b.route.length - a.route.length)[0] || null;
  },

  /** 这串 hash 属于「被关掉的插件」时返回那个插件，否则 null（route() 用它拦路） */
  disabledPluginOf(hash) {
    const p = this.pluginOf(hash);
    return p && p.enabled === false ? p : null;
  },

  /* ============================================================
     路由
     ============================================================ */
  route() {
    const hash = location.hash || '#/';
    this.renderTitlebar();
    // ⚠️ 离开浏览器模块前先把 webview 挪到隐藏容器，否则 clear() 会把浏览状态一起销毁
    if (window.BrowserView && typeof window.BrowserView.detach === 'function') window.BrowserView.detach();
    /* ⚠️ 离开音乐模块**不再暂停**（第二十六轮改）。
       以前之所以「离开即暂停」：播放条只存在于音乐页里，走了就没有按钮能停它，
       在后台一直响就成了「关不掉的音乐」。现在右下角有一个**跨路由常驻**的
       迷你播放卡片（js/miniplayer.js），任何界面都能暂停 / 切歌 —— 那条理由不成立了，
       而用户明确要求「切出去到其他模块不暂停播放」。
       detach() 保留为「离场清理」（只复位歌词浮层状态，不碰媒体元素）。 */
    if (window.MusicView && typeof window.MusicView.detach === 'function') window.MusicView.detach();
    if (window.LinkView && typeof window.LinkView.detach === 'function') window.LinkView.detach();
    /* MOD 模块里有内嵌 Nexus 小浏览器（webview）—— 离场先收掉，否则下次进来是白框 */
    if (window.ModsView && typeof window.ModsView.detach === 'function') window.ModsView.detach();
    /* 图片模块里有地图实例（ResizeObserver + rAF + 瓦片缓存），离场必须 destroy */
    if (window.PhotosView && typeof window.PhotosView.detach === 'function') window.PhotosView.detach();
    /* 第五十轮：离开第三方插件页 → 先跑插件自己的清理函数（解绑事件 / 停定时器）。
       ⚠️ 必须在 clear() 之前：清理函数里可能还要读一下自己的 DOM 做收尾。 */
    if (window.SGJPlugin && typeof window.SGJPlugin.unmount === 'function') window.SGJPlugin.unmount();
    const container = clear(this.view);
    container.className = 'view';

    /* 第四十九轮：访问一个**没启用**的插件 → 说清楚原因并回主界面。
       不做「静默跳回」：用户点了卡片或收藏了 hash，得知道为什么打不开。
       ⚠️ 地址也要一起改回 `#/`，否则「画面是主界面、hash 还是 #/music」，
          鼠标一动面包屑/标题又对不上，下次 route() 还会再拦一次。
          用 replaceState 而不是 `location.hash = '#/'`：后者会再触发一次
          hashchange → route() → 同一套逻辑跑两遍。 */
    const off = this.disabledPluginOf(hash);
    if (off) {
      this.toast(`「${off.title}」插件没启用（设置 → 插件）`, 'err');
      try { history.replaceState(null, '', '#/'); } catch { location.hash = '#/'; }
      this.renderHub(container);
      this.renderTitlebar();
      if (window.MiniPlayer) window.MiniPlayer.sync();
      return;
    }

    if (hash.startsWith('#/games')) { container.classList.add('anim-in'); GamesView.mount(container); }
    else if (hash.startsWith('#/mods')) { container.classList.add('anim-in'); window.ModsView.mount(container); }
    else if (hash === '#/music') { container.classList.add('anim-in'); MusicView.mount(container); }
    else if (hash === '#/netdisk') { container.classList.add('anim-in'); NetdiskView.mount(container); }
    else if (hash === '#/browser') { BrowserView.mount(container); }
    else if (hash === '#/link') { container.classList.add('anim-in'); window.LinkView.mount(container); }
    else if (hash.startsWith('#/photos')) { container.classList.add('anim-in'); window.PhotosView.mount(container); }
    /* 第五十轮：第三方插件页。id 里允许 `.` `_` `-`，所以 decode 一次再用 */
    else if (hash.startsWith('#/p/')) {
      container.classList.add('anim-in');
      if (window.SGJPlugin) window.SGJPlugin.mount(container, decodeURIComponent(hash.slice(4)));
    }
    else if (hash === '#/settings') { container.classList.add('anim-in'); this.renderSettings(container); }
    else { this.renderHub(container); }

    /* 迷你播放卡片的可见性跟着路由走：音乐模块里藏起来（那页有完整播放条），
       其它页面只要有正在播的歌就摆出来。 */
    if (window.MiniPlayer) window.MiniPlayer.sync();
  },
  /* ⚠️ 第五十轮修正：**先比，再赋值**。
     原来写的是 `location.hash = hash; if (location.hash === hash) this.route();`
     —— 赋完值这个条件恒真，于是 route() 立刻跑一次、紧接着 hashchange 事件再跑一次，
     一次跳转画两遍界面。内置模块只是白做一遍工（滚动位置、输入框焦点被抖掉，
     设置页那种 append 型的渲染还会叠出两页），第三方插件则更糟：
     第二遍挂载时它的 renderer.js 还在加载、define 还没跑，会被判成「加载失败」。
     只有「本来就在这个地址」时才手动补一次 route()（那时不会触发 hashchange）。 */
  go(hash) {
    const h = hash || '#/';
    if ((location.hash || '#/') === h) { this.route(); return; }
    location.hash = h;          // 地址变了 → hashchange 会触发 route()
  },

  /* ============================================================
     插件 / 更新 的界面侧反应（第四十九轮）
     ============================================================ */

  /**
   * 插件开关变了。
   * 重取插件表（State.plugins + State.modules 一起更新），然后按当前页面决定要不要重画：
   *   · 正停在被关掉的插件页 → route() 会 toast + 回主界面
   *   · 主界面 / 设置页 → 重画（卡片数、开关状态都要变）
   *   · 别的模块页 → 什么都不动，别把人正在做的事掀了
   */
  async onModulesChanged() {
    await State.refreshPlugins();
    this.renderTitlebar();
    const hash = location.hash || '#/';
    if (this.disabledPluginOf(hash) || hash === '#/' || hash === '#/settings') this.route();
  },

  /** 后台查到了新版本：弹一条提示，并把结果记下来给设置页用 */
  onUpdateAvailable(info) {
    if (!info || !info.ok || !info.hasUpdate) return;
    this.pendingUpdate = info;
    this.toast(`发现新版本 ${verText(info.latest)} —— 设置 → 更新 里可以下载`, 'ok');
  },

  /* ============================================================
     主界面 Hub
     ============================================================ */
  renderHub(container) {
    const s = State.settings || {};
    const hub = el('div', { class: 'hub' });
    if (s.background && s.background.content) hub.style.backgroundImage = `url("${window.util.toFileUrl(s.background.content)}")`;

    hub.appendChild(el('div', { class: 'hub-top' },
      el('button', { class: 'hub-action', onclick: () => this.go('#/settings') }, uiSpan('settings'), '设置'),
      el('button', { class: 'hub-action', onclick: () => this.renderUserMenu() }, uiSpan('user'), State.profile.nickname || '用户')
    ));

    const nick = (State.profile && State.profile.nickname) || '主人';
    const mid = el('div', { class: 'hub-mid' },
      el('div', { class: 'hub-hello' },
        el('h1', { text: `你好，${nick}` }),
        el('p', { text: new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }) })
      )
    );

    /* 第五十四轮：卡片顺序按用户拖出来的用（`settings.hubOrder`）。
       清单里新出现的插件自动追加在末尾 —— 见 HubOrder.apply 的三条兜底 */
    const mods = window.HubOrder
      ? window.HubOrder.apply(State.modules || [], s.hubOrder)
      : (State.modules || []);
    const cards = el('div', { class: 'modules' },
      mods.map((m, i) => el('div', {
        class: 'module-card', style: { '--mc': m.accent || 'var(--accent)', animationDelay: (i * .05) + 's' },
        title: m.desc || '',
        /* 拖动排序要认得住是哪张卡 → id 落在 dataset 上。
           ⚠️ 用 dataset.mid 而不是 dataset.id：`id` 在 HTML 里是元素 id，容易和 #app 之类撞 */
        dataset: { mid: String(m.id || '') },
        /* 第四十九轮：卡片跳到插件自己声明的 route（后端 plugins.js 的清单），
           不再靠拼 '#/' + name —— 两者以后可能不一致 */
        onclick: () => this.go(m.route || ('#/' + m.name))
      },
        el('div', { class: 'module-icon', html: (window.ICON.ui[m.icon] || window.ICON.ui.grid) }),
        el('div', { class: 'module-title', text: m.title }),
        el('div', { class: 'module-desc', text: m.desc || '' })
      )),
      /* 「更多」改成「插件」：以前点了只弹一句「敬请期待」，现在是真入口。
         ⚠️ 它**不参与拖动排序**（没有 data-mid），永远钉在最后 */
      el('div', { class: 'module-card plugin-entry', style: { '--mc': 'var(--text-mute)' }, onclick: () => this.go('#/settings') },
        el('div', { class: 'module-icon', html: window.ICON.ui.plus }),
        el('div', { class: 'module-title', text: '插件' }),
        el('div', { class: 'module-desc', text: '选择要哪些模块' })
      )
    );
    mid.appendChild(cards);
    if (mods.length) this.bindHubDrag(cards);
    /* 全关掉时给一句人话 + 入口 —— 否则主界面只剩一张「插件」卡，看着像坏了 */
    if (!mods.length) {
      mid.appendChild(el('div', { class: 'hub-empty' },
        el('p', { text: '还没有启用任何插件。' }),
        el('button', { class: 'btn btn-primary btn-sm', onclick: () => this.go('#/settings') }, '去设置里挑一个')));
    } else {
      /* 原来这行是五个假的分页点（卡片区从来不分页，纯装饰，还骗人以为能翻页）。
         现在换成一句真提示：顺序能改，模块能增减。 */
      mid.appendChild(el('div', { class: 'hub-tip' },
        el('span', { text: '长按卡片可以拖动排序' }),
        el('span', { class: 'dot-sep', text: '·' }),
        el('span', { class: 'hub-tip-link', text: '增减模块去 设置 → 插件', onclick: () => this.go('#/settings') })));
    }

    hub.appendChild(mid);

    // 快速粘贴链接（主界面即可下载）
    hub.appendChild(el('div', { class: 'hub-hidden-fab', onclick: () => this.go('#/netdisk') },
      uiSpan('link'), '粘贴网盘链接下载'));

    container.appendChild(hub);
  },

  /**
   * 主界面卡片：**长按后拖动换位置**（第五十四轮；第五十五轮改成真跟手）。
   *
   * 为什么是长按而不是「按住就拖」：卡片的正常动作是**点一下进模块**，
   * 直接跟手拖会让「想进游戏却不小心拖了一下」变成常态。
   * 380ms 是个折中（低于 250ms 容易误触，高于 500ms 用户以为没反应）。
   *
   * 手感三件事（缺一个就「死板」）：
   *   ① **跟手**：卡片真的抬起来跟着指针走（inline transform），不是留在原地描个框；
   *   ② **换位会滑**：别的卡片用 FLIP 从旧格子滑到新格子（260ms，起步快收尾柔）；
   *   ③ **松手滑落**：卡片不是「啪」地弹回格子，而是滑回去。
   *
   * 数据落在 `settings.hubOrder`（见 huborder.js 的三条兜底）。
   * 🔴 拖动结束**只信 DOM 顺序**，不拿内存里那份算 —— 用户看到的就是它。
   */
  bindHubDrag(box) {
    const LONG_PRESS = 380;   // 长按时长
    const SLOP = 8;           // 这段时间内允许的手抖像素（超过就当成「不是长按」）
    const LIFT = 1.045;       // 拖起来时放大一点点（「拿起来了」的暗示）
    const FLIP_MS = 260;      // 其它卡片让位的滑动时长
    const FLIP_EASE = 'cubic-bezier(.22,.68,.24,1)';   // 起步快、收尾柔 —— 就是「滑」的手感
    const SNAP_MS = 220;      // 松手滑回格子的时长
    let timer = null;
    let src = null;           // 正在拖的那张卡
    let startX = 0; let startY = 0;
    let pid = null;
    /* 按下去那一刻，指针在卡片内的相对位置 —— 跟手全靠它。
       少了它卡片会在长按生效时「跳到指针下面」，很难受。 */
    let grabX = 0; let grabY = 0;
    /* 卡片「没有 transform 时」的视口左上角。🔴 每次换位（格子变了）都必须重算，
       否则跟手的位移会以旧格子为基准，卡片会歪到别处去。 */
    let baseX = 0; let baseY = 0;
    let lastX = 0; let lastY = 0;   // 指针最新位置（松手前最后一次）
    let snapTimer = null;
    let suppressClick = false;   // 拖完松手会派发一次 click，得吃掉
    /* 卡片浮起来会飞出内容区（比如拖到问候选上方），内容区是 overflow-y:auto 的，
       会把它裁掉一半 → 拖动期间临时放开，让外层的 .hub 圆角去裁。 */
    const midEl = box.closest ? box.closest('.hub-mid') : null;

    const pickables = () => Array.from(box.querySelectorAll('.module-card[data-mid]'));

    /**
     * 把卡片摆到指针下面：视觉位置 = 指针 - 抓取偏移。
     * 🔴 `.drag-src` 上写了 `transition: none` —— 跟手的属性一旦带过渡，卡片就会「拖着走」、黏手。
     */
    const follow = () => {
      if (!src) return;
      const dx = lastX - grabX - baseX;
      const dy = lastY - grabY - baseY;
      src.style.transform = 'translate3d(' + dx.toFixed(2) + 'px, ' + dy.toFixed(2) + 'px, 0) scale(' + LIFT + ')';
    };

    const enter = () => {
      timer = null;
      if (!src) return;
      const r = src.getBoundingClientRect();
      grabX = startX - r.left;
      grabY = startY - r.top;
      baseX = r.left; baseY = r.top;
      lastX = startX; lastY = startY;
      src.classList.add('drag-src');
      box.classList.add('dragging');
      if (midEl) midEl.classList.add('hub-drag-free');
      document.body.classList.add('hub-dragging');
      follow();
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 500);   // 万一没派发 click，别一直挂着
    };

    const reset = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (snapTimer) { clearTimeout(snapTimer); snapTimer = null; }
      if (src) {
        src.classList.remove('drag-src', 'drag-snap');
        src.style.transform = '';
      }
      box.classList.remove('dragging');
      if (midEl) midEl.classList.remove('hub-drag-free');
      document.body.classList.remove('hub-dragging');
      src = null;
      pid = null;
    };

    /**
     * 被拖的卡片压到哪张上，就把自己的**格子**挪过去。
     *
     * 判定用「被拖卡片的视觉中心」而不是指针：卡片已经跟手浮起来了，指针在卡内的相对位置是固定的，
     * 用中心判定换位时机更符合直觉（抓着卡边拖也不会提前半格就换，来回抖）。
     */
    const moveTo = () => {
      if (!src) return;
      const sr = src.getBoundingClientRect();
      const cx = sr.left + sr.width / 2;
      const cy = sr.top + sr.height / 2;
      const over = pickables().find((c) => {
        if (c === src) return false;
        const r = c.getBoundingClientRect();
        return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
      });
      if (!over) return;

      /* FLIP 第一步：换位前把所有卡片（src 除外）的位置记下来 */
      const prev = new Map();
      for (const c of Array.from(box.children)) {
        if (c === src) continue;
        prev.set(c, c.getBoundingClientRect());
      }
      const r = over.getBoundingClientRect();
      const before = cx < r.left + r.width / 2;
      box.insertBefore(src, before ? over : over.nextSibling);

      /* 换位后卡片的「格子」变了，但它得继续停在指针下：
         先清 transform 量出新格子位置，再把视觉偏移补回去（同一个任务里做完，中间不会绘制，看不出来）。 */
      src.style.transform = 'none';
      const nr = src.getBoundingClientRect();
      baseX = nr.left; baseY = nr.top;
      follow();

      /* FLIP 第二步：别的卡片从旧位置**滑**到新位置（就是「让位」那一下的滑动感） */
      for (const c of Array.from(box.children)) {
        if (c === src) continue;
        const b = prev.get(c);
        if (!b) continue;
        const a = c.getBoundingClientRect();
        const dx = b.left - a.left; const dy = b.top - a.top;
        if (!dx && !dy) continue;
        if (typeof c.animate !== 'function') continue;
        try {
          c.animate([{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'none' }],
            { duration: FLIP_MS, easing: FLIP_EASE });
        } catch { /* 不支持 WAAPI：直接到位，顺序照样是对的 */ }
      }
    };

    const onDown = (e) => {
      if (e.button != null && e.button !== 0) return;
      const card = e.target && e.target.closest ? e.target.closest('.module-card[data-mid]') : null;
      if (!card || !box.contains(card)) return;
      reset();
      src = card;
      pid = e.pointerId;
      startX = e.clientX; startY = e.clientY;
      lastX = startX; lastY = startY;
      timer = setTimeout(enter, LONG_PRESS);
      try { card.setPointerCapture(pid); } catch { /* 不支持就算了，不影响主流程 */ }
    };

    const onMove = (e) => {
      if (!src) return;
      /* 长按还没生效：手一动就取消 —— 用户可能只是想在卡片上滑动 / 点别处 */
      if (timer) {
        if (Math.abs(e.clientX - startX) > SLOP || Math.abs(e.clientY - startY) > SLOP) {
          clearTimeout(timer); timer = null;
          src = null;
        }
        return;
      }
      if (!src.classList.contains('drag-src')) return;
      if (e.cancelable) e.preventDefault();
      lastX = e.clientX; lastY = e.clientY;
      follow();        // ① 先跟手（每帧都跟）
      moveTo();        // ② 再看要不要换位（换位里会再 follow 一次校正基准）
    };

    const onUp = () => {
      if (!src) return;
      const card = src;
      const dragging = card.classList.contains('drag-src');
      try {
        if (pid != null && card.hasPointerCapture && card.hasPointerCapture(pid)) card.releasePointerCapture(pid);
      } catch { /* 已经释放过 */ }
      /* 顺序要趁 DOM 还在原位时读（只信 DOM，不拿内存那份算） */
      const ids = dragging ? window.HubOrder.fromNodes(pickables()) : null;

      if (timer) { clearTimeout(timer); timer = null; }
      box.classList.remove('dragging');
      if (midEl) midEl.classList.remove('hub-drag-free');
      document.body.classList.remove('hub-dragging');
      pid = null;
      src = null;

      if (!dragging) {                 // 只是点了一下，没拖成
        card.classList.remove('drag-snap');
        card.style.transform = '';
      } else {
        /* 松手不「啪」地弹回格子，而是滑回去：交给 CSS 过渡，
           起点就是现在这个 inline transform，终点是归零（= 自己格子）。 */
        card.classList.remove('drag-src');
        card.classList.add('drag-snap');
        card.style.transform = 'none';
        if (snapTimer) clearTimeout(snapTimer);
        snapTimer = setTimeout(() => {
          snapTimer = null;
          card.classList.remove('drag-snap');
          card.style.transform = '';
        }, SNAP_MS + 40);
      }
      if (ids && ids.length) this.saveHubOrder(ids);
    };

    box.addEventListener('pointerdown', onDown);
    box.addEventListener('pointermove', onMove);
    box.addEventListener('pointerup', onUp);
    box.addEventListener('pointercancel', onUp);
    /* 捕获阶段吃掉「拖完松手」那一次 click，否则一松手就跳进模块了 */
    box.addEventListener('click', (e) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);
  },

  /** 卡片顺序落库（失败就算了，别弹错 —— 下次进来还是老顺序，不算数据事故） */
  saveHubOrder(ids) {
    if (!Array.isArray(ids) || !ids.length) return;
    const cur = (State.settings && State.settings.hubOrder) || [];
    if (cur.length === ids.length && cur.every((v, i) => String(v) === String(ids[i]))) return;
    State.set({ hubOrder: ids }).catch(() => {});
  },

  renderUserMenu() {
    const r = document.getElementById('brand').getBoundingClientRect();
    this.contextMenu(window.innerWidth - 240, 60, [
      { label: '修改昵称', icon: 'edit', onClick: async () => {
          const n = await this.prompt({ title: '修改昵称', label: '昵称', value: State.profile.nickname || '' });
          if (n) { await State.setProfile({ nickname: n }); this.route(); this.toast('昵称已更新', 'ok'); }
        } },
      { label: '用户数据目录', icon: 'folder', onClick: () => API.raw.shell.openPath(State.info.dataDir).catch(() => {}) },
      { divider: true },
      { label: '打开开发者工具', icon: 'settings', onClick: () => API.raw.win.devtools() }
    ]);
  },

  toggleTheme() {
    const next = (State.settings.theme === 'dark') ? 'light' : 'dark';
    State.set({ theme: next }).then(() => this.renderTitlebar());
  },

  /* ============================================================
     设置页
     ============================================================ */
  async renderSettings(container) {
    const s = State.settings || {};
    const info = State.info || {};
    const page = el('div', { class: 'page' });
    page.appendChild(el('div', { class: 'page-head' },
      el('button', { class: 'back-btn', onclick: () => this.go('#/') }, uiSpan('back'), '返回'),
      el('h2', { text: '设置' })
    ));
    const body = el('div', { class: 'page-body' });
    const wrap = el('div', { class: 'settings-wrap' });
    body.appendChild(wrap);
    page.appendChild(body);
    container.appendChild(page);

    /* 外观 */
    const accents = ['#4f7cff', '#22a06b', '#c20c0c', '#8b46ff', '#f59e0b', '#0ea5e9', '#ec4899', '#111827'];
    const appearance = el('div', { class: 'card' },
      el('h3', { text: '外观' }),
      el('p', { class: 'hint', text: '主题、主题色与背景，随时可改。' }),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '主题' }),
        el('select', { class: 'inp', style: { width: '160px' }, onchange: (e) => State.set({ theme: e.target.value }) },
          el('option', { value: 'light', selected: s.theme !== 'dark' }, '浅色'),
          el('option', { value: 'dark', selected: s.theme === 'dark' }, '深色'))),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '主题色' }),
        el('div', { class: 'swatches' }, accents.map((c) =>
          el('div', { class: 'swatch' + (s.accent === c ? ' on' : ''), style: { background: c }, onclick: () => { State.set({ accent: c }); this.renderSettings(container); } })))),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '字号' }),
        el('input', { type: 'range', min: 0.85, max: 1.3, step: 0.05, value: s.fontScale || 1, style: { width: '220px' }, oninput: (e) => State.set({ fontScale: Number(e.target.value) }) })),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '主界面背景' }),
        el('button', { class: 'btn btn-sm', onclick: () => this.pickBg('content') }, uiSpan('folder'), '选择图片'),
        el('button', { class: 'btn btn-sm btn-ghost', onclick: async () => { await API.raw.appearance.clearImage({ slot: 'content' }); State.set({ background: { content: '' } }); this.toast('已清除背景'); } }, '清除')),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '背景不透明度' }),
        el('input', { type: 'range', min: 0.05, max: 1, step: 0.05, value: s.background && s.background.opacity != null ? s.background.opacity : 1, style: { width: '220px' },
          oninput: async (e) => { const bg = await API.raw.appearance.urls().catch(() => ({})); State.settings.background = { content: (bg.content || '').replace(/^file:\/\//, ''), opacity: Number(e.target.value) }; State.applyTheme(); } }))
    );
    wrap.appendChild(appearance);

    /* 通用 */
    const general = el('div', { class: 'card' },
      el('h3', { text: '通用' }),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '下载目录' }),
        el('span', { class: 'grow mono ellipsis', text: s.downloadDir || '（默认：系统下载目录 / 拾光集）' }),
        el('button', { class: 'btn btn-sm', onclick: async () => { const d = await API.raw.dialog.pickFolder(); if (d) { await State.set({ downloadDir: d }); this.renderSettings(container); } } }, '选择')),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '昵称' }),
        el('input', { class: 'inp grow', value: State.profile.nickname || '', onchange: (e) => State.setProfile({ nickname: e.target.value }) }))
    );
    wrap.appendChild(general);

    /* 插件（第四十九轮；第五十轮加「第三方插件」分组）
       ------------------------------------------------------------
       内置五个模块和第三方插件在这里是**同一种东西**：都是可开关的插件。
       差别只有两点（必须让用户看得出来）：
         ① 内置的「关掉只是不给入口，代码还在内存里」；
         ② 第三方是**你装的别人的代码**，拥有本机完整权限（Node），不是沙箱。
       所以第三方那组单独一块，标「第三方」+ 作者 + 版本，并在组标题上写清风险。 */
    const pl = State.plugins || { list: [], total: 0 };
    const builtin = pl.builtin || pl.list || [];
    const extList = pl.ext || [];
    const all = builtin.concat(extList);
    const onCount = all.filter((p) => p.enabled).length;
    /* 第五十二轮：模块版安装包的打包预设（普通版为 null）。
       用户下的是「音乐版」却只看见一张卡时，必须在这里说清「其余随时能开」，
       否则第一反应是「装坏了 / 少了功能」。 */
    const preset = Array.isArray(pl.preset) && pl.preset.length ? pl.preset : null;
    const presetTitle = preset
      ? builtin.filter((p) => preset.indexOf(p.id) >= 0).map((p) => p.title).join(' + ')
      : '';

    /** 一行开关（内置 / 第三方共用，只是开关走不同的 IPC） */
    const prow = (p) => el('div', { class: 'prow' + (p.enabled ? '' : ' off') },
      el('div', { class: 'prow-ico' },
        el('span', { html: (window.ICON.ui[p.icon] || window.ICON.ui[p.kind === 'ext' ? 'extension' : 'grid']) })),
      el('div', { class: 'prow-main' },
        el('div', { class: 'prow-t' }, el('span', { text: p.title }),
          p.kind === 'ext' ? el('span', { class: 'prow-tag ext', text: '第三方' }) : null,
          p.enabled ? null : el('span', { class: 'prow-tag', text: '已关闭' })),
        el('div', { class: 'prow-s', text: p.kind === 'ext'
          ? `v${p.version} · ${p.author}` + (p.detail ? ' —— ' + (p.detail || '') : '')
          : (p.detail || p.desc || '') })),
      this.switchEl(p.enabled, async (next) => {
        try {
          if (p.kind === 'ext') await API.raw.plugin.set(p.id, next);
          else await API.raw.plugins.set(p.id, next);
          /* 主进程已经广播 hub:modules-changed，界面由 onModulesChanged 统一重画 ——
             这里只弹一句人话，**不再自己 renderSettings**（会重画两次）。 */
          this.toast(next ? `已启用「${p.title}」` : `已关闭「${p.title}」（代码还在内存里，重启后才不加载）`, next ? 'ok' : 'info');
        } catch (e) { this.toast(e.message || '切换失败', 'err'); }
      }));

    /* 扫描插件目录时报的错，逐条照实列出来。静默吞掉 = 用户「装了却看不见也不知道为什么」 */
    const errRows = (pl.errors || []).map((e2) => el('div', { class: 'prow bad' },
      el('div', { class: 'prow-ico' }, el('span', { html: window.ICON.ui.info })),
      el('div', { class: 'prow-main' },
        el('div', { class: 'prow-t' }, el('span', { text: '加载不了' + (e2.dir ? '：' + e2.dir : '') })),
        el('div', { class: 'prow-s', text: e2.error }))));

    const pluginCard = el('div', { class: 'card' },
      el('h3', { text: '插件' }),
      el('p', { class: 'hint', text: '主界面是容器，模块是插件 —— 只留你用得上的。关掉的插件：主界面没卡片、地址也进不去；重新启用立刻恢复。' }),
      preset ? el('p', { class: 'hint', text: `这个安装包是「${presetTitle}版」：首次启动只开了 ${presetTitle}，其余模块下面随时可以打开，功能一个都不少。` }) : null,
      el('div', { class: 'prows' }, builtin.map(prow)),
      el('div', { class: 'row' },
        el('span', { class: 'label', text: '已启用' }),
        el('span', { class: 'grow', text: `${onCount} / ${all.length} 个（含第三方 ${extList.length} 个）` }),
        el('button', { class: 'btn btn-sm btn-ghost', title: preset ? `恢复到「${presetTitle}版」的默认开关` : '把所有内置插件都打开', onclick: async () => {
          try {
            await API.raw.plugins.reset();
            /* ⚠️ 模块版里 reset 恢复的是**预设默认**（不是全开），文案不能写「全部启用」 */
            this.toast(preset ? `已恢复「${presetTitle}版」的默认（只开 ${presetTitle}）` : '内置插件已全部启用', 'ok');
          }
          catch (e) { this.toast(e.message || '恢复失败', 'err'); }
        } }, preset ? '恢复默认' : '全部启用')),

      /* ---- 第三方 ---- */
      el('div', { class: 'ext-head' },
        el('div', { class: 'ext-head-t' }, '第三方插件'),
        el('span', { class: 'prow-tag ext', text: String(extList.length) }),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn btn-sm btn-ghost', title: '打开插件目录（放进去后点「重新扫描」）',
          onclick: () => API.raw.plugin.openDir().catch((e) => this.toast(e.message, 'err')) }, '打开插件目录'),
        el('button', { class: 'btn btn-sm', title: '重新扫一遍插件目录（不用重启）', onclick: async (e) => {
          const b = e.currentTarget; const t = b.textContent;
          b.disabled = true; b.textContent = '扫描中…';
          try {
            const r = await API.raw.plugin.rescan();
            await State.refreshPlugins();
            this.toast(`扫描完成：${(r && r.list || []).length} 个插件`, 'ok');
            this.renderSettings(container);
          } catch (err) {
            b.disabled = false; b.textContent = t;
            this.toast(err.message || '扫描失败', 'err');
          }
        } }, '重新扫描')),
      el('p', { class: 'hint ext-risk', text: '⚠️ 第三方插件的代码由插件作者提供，运行在本机、拥有完整权限（能读写文件、联网）—— 相当于普通程序。只装你信得过的来源。' }),
      extList.length
        ? el('div', { class: 'prows' }, extList.map(prow))
        : el('div', { class: 'ext-empty' },
          '还没有装第三方插件。点「打开插件目录」，把插件文件夹放进去，再点「重新扫描」。',
          el('br'), '开发方法见仓库里的 docs/插件开发指南.md。'),
      errRows.length ? el('div', { class: 'prows' }, errRows) : null
    );
    wrap.appendChild(pluginCard);

    /* MOD 下载 —— 对应 MOD 模块里那块内嵌 Nexus 小浏览器
       （第五十三轮 MOD 独立成插件；这张是**全局默认**，模块齿轮里还有一份同样的设置） */
    const md = s.modDownload || {};
    const mdMode = md.mode === 'folder' ? 'folder' : 'install';
    const mdSeg = (k, label, desc) => el('div', {
      class: 'md-opt' + (mdMode === k ? ' on' : ''),
      title: mdMode === k ? '当前就是这个' : '切换到这个',
      onclick: async () => { await State.set({ modDownload: { mode: k } }); this.renderSettings(container); }
    },
      el('div', { class: 'md-t', text: label }),
      el('div', { class: 'md-s', text: desc }));

    const mdDefaultDir = '（默认：拾光集数据目录 / mod-downloads）';
    wrap.appendChild(el('div', { class: 'card' },
      el('h3', { text: 'MOD 下载' }),
      el('p', { class: 'hint', text: '在 MOD 模块里点「Nexus 搜索」，会用一块内嵌小浏览器打开 Nexus（可搜索、可下载，和浏览器模块共用登录状态）。从那里下载的 MOD 按下面这条规则处理。' }),
      el('div', { class: 'md-opts' },
        mdSeg('install', '装进游戏的 MOD 目录',
          '下载完自动解压进这款游戏的 MOD 目录（目录由 MOD 规则推断，也可以在某款游戏里手动指定）。装完删掉压缩包。'),
        mdSeg('folder', '只下载到文件夹',
          '不自动安装，文件就放在下面这个目录里，剩下的事你自己来。')),
      el('div', { class: 'row' }, el('span', { class: 'label', text: 'MOD 下载目录' }),
        el('span', {
          class: 'grow mono ellipsis', title: md.dir || '',
          text: md.dir || (s.downloadDir ? s.downloadDir + '（沿用通用下载目录）' : mdDefaultDir)
        }),
        el('button', { class: 'btn btn-sm', onclick: async () => {
          const d = await API.raw.dialog.pickFolder();
          if (!d) return;
          await State.set({ modDownload: { dir: d } });
          this.renderSettings(container);
          this.toast('MOD 下载目录已更新', 'ok');
        } }, '选择'),
        md.dir ? el('button', { class: 'btn btn-sm btn-ghost', onclick: async () => {
          await State.set({ modDownload: { dir: '' } });
          this.renderSettings(container);
          this.toast('已恢复默认目录');
        } }, '恢复默认') : null),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '安装包' }),
        el('div', { class: 'chips', style: { marginBottom: '0' } },
          el('span', { class: 'chip' + (md.keepArchive ? '' : ' on'),
            title: '装进 MOD 目录之后把压缩包删掉',
            onclick: async () => { await State.set({ modDownload: { keepArchive: false } }); this.renderSettings(container); } }, '装好后删掉'),
          el('span', { class: 'chip' + (md.keepArchive ? ' on' : ''),
            title: '装进 MOD 目录之后也留着安装包',
            onclick: async () => { await State.set({ modDownload: { keepArchive: true } }); this.renderSettings(container); } }, '装好后保留'))),
      el('p', { class: 'hint', text: '注：少数游戏本身没有 MOD 目录 —— 女神异闻录 5 皇家版 / 4 黄金版走 Reloaded-II，城市天际线 2 走 Paradox Mods。这类游戏会自动下载好再提示你用它的管理器安装，不会硬塞进游戏目录。' })
    ));

    /* 更新（第四十九轮）
       ------------------------------------------------------------
       只做「检查 + 提示 + 一键打开下载」：便携版是单文件 exe，运行中替换自己
       要绕开「文件被占用 + 杀软锁文件」，第一期不做自替换（口径和主人确认过）。
       「屏蔽」是真的**不联网**，不是查了不提示。 */
    /* 探针接缝：`API.raw` 是 contextBridge 冻结对象桩不动，而「有新版本」那块界面
       在真的没有新版本时压根画不出来 —— 只留这一个**只读覆盖位**给 --probe 用。
       平时是 undefined，走正常 IPC。 */
    const up = this._upOverride || await API.raw.update.status().catch(() => null);
    const curVer = (up && up.current) || info.version || '';
    const upMode = (up && up.mode) || 'auto';
    const last = (up && up.last) || null;
    const upCard = el('div', { class: 'card' },
      el('h3', { text: '更新' }),
      el('p', { class: 'hint', text: `从 GitHub 的 Releases 检查新版本（${(up && up.repo) || 'luoyupan/ShiGuangJi'}）。只提示并打开下载页，不会在后台偷偷替换正在运行的程序。` }),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '当前版本' }),
        el('span', { class: 'grow mono', text: 'v' + curVer })),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '更新方式' }),
        el('select', { class: 'inp', style: { width: '230px' }, onchange: async (e) => {
          const m = e.target.value;
          try {
            await API.raw.update.setMode(m);
            this.toast('更新方式：' + (UP_MODE_TEXT[m] || m), 'ok');
            this.renderSettings(container);
          } catch (err) { this.toast(err.message || '切换失败', 'err'); this.renderSettings(container); }
        } },
          UP_MODES.map((m) => el('option', { value: m, selected: upMode === m }, UP_MODE_TEXT[m])))),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '手动检查' }),
        el('button', { class: 'btn btn-sm', onclick: async (e) => {
          const btn = e.currentTarget;
          const old = btn.textContent;
          btn.disabled = true; btn.textContent = '检查中…';
          const r = await API.raw.update.check().catch((err) => ({ ok: false, error: err.message }));
          btn.disabled = false; btn.textContent = old;
          if (!r || !r.ok) this.toast((r && r.error) || '检查失败', 'err');
          else if (r.hasUpdate) this.toast(`发现新版本 ${verText(r.latest)}`, 'ok');
          else this.toast('已经是最新版本', 'ok');
          this.renderSettings(container);
        } }, uiSpan('refresh'), '检查更新'),
        el('span', { class: 'grow sub', style: { color: 'var(--text-mute)', fontSize: '.86em' }, text: upSummary(last) })),
      (last && last.ok && last.hasUpdate) ? el('div', { class: 'up-new' },
        el('div', { class: 'up-new-t' }, uiSpan('download'), `发现新版本 ${verText(last.latest)}`,
          last.prerelease ? el('span', { class: 'up-tag', text: '预发布' }) : null),
        el('div', { class: 'up-new-s', text: [last.name || '', last.publishedAt ? '发布于 ' + fmtDate(last.publishedAt) : ''].filter(Boolean).join(' · ') }),
        last.notes ? el('pre', { class: 'up-notes', text: clip(last.notes, 900) }) : null,
        el('div', { class: 'up-acts' },
          el('button', { class: 'btn btn-sm btn-primary', onclick: async () => {
            try { await API.raw.update.open(last.assetUrl || last.pageUrl); this.toast('已在浏览器打开下载地址', 'ok'); }
            catch (e) { this.toast(e.message || '打开失败', 'err'); }
          } }, uiSpan('download'), last.assetName ? '下载 ' + shortName(last.assetName) : '打开下载页'),
          el('button', { class: 'btn btn-sm btn-ghost', onclick: async () => {
            try { await API.raw.update.open(last.pageUrl); } catch (e) { this.toast(e.message || '打开失败', 'err'); }
          } }, '打开 Release 页面')))
        : null
    );
    wrap.appendChild(upCard);

    /* 关于 */
    wrap.appendChild(el('div', { class: 'card' },
      el('h3', { text: '关于' }),
      el('p', { class: 'hint', text: '拾光集 · 综合体桌面软件' }),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '版本' }), el('span', { class: 'grow', text: info.version || '0.1.0' })),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '运行环境' }), el('span', { class: 'grow', text: 'Electron ' + (info.electron || '') + ' · ' + (info.platform || '') })),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '数据目录' }),
        el('span', { class: 'grow mono ellipsis', text: info.dataDir || '' }),
        el('button', { class: 'btn btn-sm', onclick: () => API.raw.shell.openPath(info.dataDir) }, '打开'))
    ));
  },

  /* ============================================================
     模块设置（标题栏齿轮 → 各模块自己的设置）
     ------------------------------------------------------------
     入口在标题栏、主题按钮左边（只在模块页出现）。弹层左边是模块列表，右边是
     该模块**自己**的设置 —— 和全局「设置」页刻意分开：全局管外观 / 下载目录 /
     关于，这里管「这个模块怎么工作」。
     ============================================================ */
  MOD_SETTINGS: [
    { key: 'games',   name: '游戏',   icon: 'game' },
    /* 第五十三轮：MOD 独立成模块 → 它自己那块「下载落点」设置也得跟着搬过来，
       不然用户点 MOD 模块的齿轮，只能看到「游戏」的设置，还得去别处找 */
    { key: 'mods',    name: 'MOD',    icon: 'extension' },
    { key: 'music',   name: '音乐',   icon: 'musicNote' },
    { key: 'netdisk', name: '网盘',   icon: 'cloud' },
    { key: 'browser', name: '浏览器', icon: 'globe' },
    /* 第五十七轮：图片模块有自己的底图设置（天地图密钥 / 风格 / 自定义底图源） */
    { key: 'photos', name: '图片', icon: 'image' }
  ],

  /** 当前 hash 属于哪个模块（不在模块页就返回 ''） */
  moduleKeyFromHash(h = location.hash) {
    if (h === '#/music') return 'music';
    if (h === '#/netdisk') return 'netdisk';
    if (h === '#/browser') return 'browser';
    if (h === '#/games' || h.startsWith('#/games/')) return 'games';
    if (h === '#/mods' || h.startsWith('#/mods/')) return 'mods';
    if (h === '#/photos' || h.startsWith('#/photos/')) return 'photos';
    /* ⚠️ 联机**故意不登记**：它的设置（端口 / 中转 / STUN / 对外地址）全在页面表单里，
       没有 mset_link 面板。把 key 加进来只会让齿轮弹出「暂时还没有独立设置」的空壳。
       但上面 renderTitlebar 的 map **必须**有它 —— 否则标题栏连「主界面 / 联机」都不显示。 */
    return '';
  },

  openModuleSettings(key) {
    let active = this.MOD_SETTINGS.some((m) => m.key === key)
      ? key : (this.moduleKeyFromHash() || 'games');
    const root = document.getElementById('modals');

    const head = el('h3', { text: '模块设置' });
    const nav = el('div', { class: 'mset-nav' });
    const panel = el('div', { class: 'mset-panel' });

    /* ⚠️ 左侧条目**建一次就复用**，切模块只翻 `.on` ——
       整体 clear + 重建会让 hover / focus 状态断掉（而且「只重画右半边」这句话就成了假的）。 */
    const items = new Map();
    const paintNav = () => {
      for (const m of this.MOD_SETTINGS) {
        let node = items.get(m.key);
        if (!node) {
          node = el('div', {
            class: 'mset-item', title: m.name + ' 模块的设置',
            onclick: () => { if (m.key === active) return; active = m.key; paintNav(); paintPanel(); }
          }, uiSpan(m.icon), el('span', { text: m.name }));
          items.set(m.key, node);
          nav.appendChild(node);
        }
        node.classList.toggle('on', m.key === active);
      }
    };

    const paintPanel = () => {
      clear(panel);
      const m = this.MOD_SETTINGS.find((x) => x.key === active) || this.MOD_SETTINGS[0];
      head.textContent = m.name + ' · 模块设置';
      panel.appendChild(el('div', { class: 'mset-head' },
        el('h4', { text: m.name + ' 设置' }),
        el('span', { class: 'mset-sub', text: '只影响「' + m.name + '」模块，和全局设置分开' })));
      const body = el('div', { class: 'mset-body' });
      panel.appendChild(body);
      const fn = this['mset_' + m.key];
      if (typeof fn !== 'function') {
        body.appendChild(el('p', { class: 'hint', text: '这个模块暂时还没有独立设置。' }));
        return;
      }
      // ⚠️ 面板里要读主进程设置（拿不到就整块空白），异常必须兜住并显示出来
      const fail = (e) => body.appendChild(el('p', { class: 'hint', text: '读取设置失败：' + ((e && e.message) || e) }));
      try {
        const r = fn.call(this, body);
        if (r && typeof r.catch === 'function') r.catch(fail);
      } catch (e) { fail(e); }
    };

    /* ⚠️ 自己搭弹层而不是用 Shell.modal()：切模块要**只重画右半边**，
       走 Shell.modal 得整层重建 —— 点一下闪一下，滚动位置也丢。 */
    this._msetRepaint = paintPanel;
    this._onModalClose = null;

    clear(root);
    root.classList.add('on');
    root.appendChild(el('div', { class: 'modal-mask' }));
    root.appendChild(el('div', { class: 'modal mset' },
      el('div', { class: 'modal-head' }, head, el('button', { class: 'close-x', onclick: () => this.closeModal() }, '✕')),
      el('div', { class: 'mset-wrap' }, nav, panel)));

    paintNav();
    paintPanel();
  },

  /** 设置项改完之后重画当前面板（值变了要立刻看得见） */
  _msetRepaintNow() { if (typeof this._msetRepaint === 'function') this._msetRepaint(); },

  _msetCards(host) {
    const box = el('div', { class: 'mset-cards' });
    host.appendChild(box);
    return box;
  },
  _msetCard(box, title, hint) {
    const c = el('div', { class: 'card' },
      el('h3', { text: title }),
      hint ? el('p', { class: 'hint', text: hint }) : null);
    box.appendChild(c);
    return c;
  },
  /** 一行只读路径（长路径省略号 + 悬浮看全） */
  _msetPath(text, title) { return el('span', { class: 'grow mono ellipsis', title: title || text, text }); },
  /** 小开关 */
  _msetChips(cur, opts, onPick) {
    return el('div', { class: 'chips', style: { marginBottom: '0' } },
      opts.map(([v, t, tip]) => el('span', {
        class: 'chip' + (cur === v ? ' on' : ''), title: tip || '',
        onclick: () => onPick(v)
      }, t)));
  },

  /* ---------------- 音乐 ---------------- */
  async mset_music(host) {
    const box = this._msetCards(host);
    const me = this;

    /* 音乐库目录 */
    const lib = this._msetCard(box, '音乐库目录',
      '扫描这几个目录里的音频。曲名、歌手、时长、内嵌封面都从这里读（.ncm / .kgm 这类加密容器按你的要求一律跳过）。');
    const list = el('div', { class: 'mset-list mset-roots' });
    lib.appendChild(list);
    const scanLabel = el('span', { text: '重新扫描' });
    const scanBtn = el('button', { class: 'btn btn-sm btn-ghost' }, uiSpan('refresh'), scanLabel);
    scanBtn.onclick = async () => {
      scanBtn.disabled = true;
      const old = scanLabel.textContent;
      // ⚠️ 只改文字那个 span：直接 `btn.textContent = '扫描中…'` 会把图标 span 一起清掉，改完就再也回不来
      scanLabel.textContent = '扫描中…';
      try {
        const r = await API.raw.music.scan();
        /* 第四十一轮：重扫会顺手清掉「文件已经不在了」的曲目，结果要如实报出来 */
        me.toast('扫描完成：新增 ' + r.added + ' 首'
          + (r.pruned ? '，清理 ' + r.pruned + ' 首找不到文件的' : '')
          + '，共 ' + r.total + ' 首'
          + (r.pending ? `（另有 ${r.pending} 首所在目录像是掉线了，为安全没删）` : ''), 'ok');
        drawRoots();
      } catch (e) { me.toast(e.message, 'err'); } finally { scanBtn.disabled = false; scanLabel.textContent = old; }
    };
    lib.appendChild(el('div', { class: 'row' },
      el('button', { class: 'btn btn-sm', onclick: async () => {
        const d = await API.raw.dialog.pickFolder();
        if (!d) return;
        const cur = await API.raw.music.roots().catch(() => []);
        if (!cur.includes(d)) cur.push(d);
        await API.raw.music.setRoots(cur);
        me.toast('已加入音乐库，点「重新扫描」就能看到歌', 'ok');
        drawRoots();
      } }, uiSpan('plus'), '添加目录'),
      scanBtn));

    const drawRoots = async () => {
      const roots = await API.raw.music.roots().catch(() => []);
      clear(list);
      if (!roots.length) {
        list.appendChild(el('p', { class: 'hint', style: { margin: '0' }, text: '还没添加目录 —— 现在本地音乐是空的。' }));
        return;
      }
      for (const r of roots) {
        list.appendChild(el('div', { class: 'mset-line' },
          this._msetPath(r),
          el('button', { class: 'btn btn-icon', title: '在资源管理器里打开', onclick: () => API.raw.shell.openPath(r) }, uiSpan('folder')),
          el('button', { class: 'btn btn-icon', title: '移出音乐库（已入库的歌曲记录会保留）', onclick: async () => {
            const next = (await API.raw.music.roots()).filter((x) => x !== r);
            await API.raw.music.setRoots(next);
            me.toast('已移出音乐库');
            drawRoots();
          } }, uiSpan('close'))));
      }
    };
    drawRoots();

    /* 歌词 */
    const lrc = this._msetCard(box, '歌词（.lrc）',
      '自动匹配同名歌词文件。除了音频**自己所在目录**，还会在音乐库范围里递归找 —— 歌词放在子目录（比如「VipSongsDownload」）也能配上。');
    const lrcOut = el('p', { class: 'hint', style: { margin: '0 0 10px' }, text: '点下面的按钮可以整库重配一次。手动指定过的歌词不会被覆盖。' });
    lrc.appendChild(lrcOut);
    const relinkLabel = el('span', { text: '重新匹配歌词' });
    const relinkBtn = el('button', { class: 'btn btn-sm' }, uiSpan('read'), relinkLabel);
    relinkBtn.onclick = async () => {
      relinkBtn.disabled = true;
      const old = relinkLabel.textContent;
      relinkLabel.textContent = '匹配中…';
      try {
        const r = await API.raw.music.relinkLrc();
        lrcOut.className = 'hint ok';
        lrcOut.textContent = `共 ${r.total} 首，配到歌词 ${r.matched} 首`
          + `（新配上 ${r.added > 0 ? '+' + r.added : r.added} 首，更新指向 ${r.renewed} 首）。`
          + (r.matched === r.total ? '' : '没配上的多半是库里确实没有对应的 .lrc。');
        me.toast(`歌词已重新匹配：${r.matched}/${r.total}`, 'ok');
      } catch (e) { me.toast(e.message, 'err'); } finally { relinkBtn.disabled = false; relinkLabel.textContent = old; }
    };
    lrc.appendChild(el('div', { class: 'row' }, relinkBtn));

    /* 下载与来源（摘要 + 跳去模块里细配） */
    const src = this._msetCard(box, '下载与订阅',
      '搜索源要填「一行一个地址」，可以从多个站同时搜、同时抓。这里只显示摘要，详细配置在音乐模块的「下载与订阅」里。');
    const sum = el('div', { class: 'mset-list mset-sum' });
    src.appendChild(sum);
    src.appendChild(el('div', { class: 'row' },
      el('button', { class: 'btn btn-sm', onclick: () => {
        me.closeModal();
        // 先把视图切到「下载与订阅」，再进音乐模块 —— mount 时就会直接渲染那一页
        if (window.MusicView) window.MusicView.view = 'downloads';
        me.go('#/music');
      } }, uiSpan('settings'), '去「下载与订阅」里配置')));

    const cfg = await API.raw.music.sourceConfig().catch(() => null) || {};
    const cr = await API.raw.music.crawlConfig().catch(() => null) || {};
    const n1 = (cfg.sites || []).length;
    const n2 = (cr.sites || []).length;
    sum.appendChild(el('div', { class: 'mset-line' },
      uiSpan('download'),
      el('span', { class: 'grow', text: `音乐搜索地址：${n1 ? n1 + ' 个' : '未配置'}` }),
      el('span', { class: 'chip' + (n1 ? ' accent' : ' warn'), text: n1 ? '可用' : '未配置' })));
    sum.appendChild(el('div', { class: 'mset-line' },
      uiSpan('globe'),
      el('span', { class: 'grow', text: `网站抓取地址：${n2 ? n2 + ' 个' : '未配置'}` }),
      el('span', { class: 'chip' + (n2 ? ' accent' : ''), text: n2 ? '可用' : '未配置' })));
    const plats = await API.raw.music.platforms().catch(() => []);
    const logged = plats.filter((p) => p.logged).map((p) => p.nickname || p.name);
    sum.appendChild(el('div', { class: 'mset-line' },
      uiSpan('user'),
      el('span', { class: 'grow', text: `外部歌单账号：${logged.length ? logged.join('、') : '未登录'}` })));

    /* 每日音乐推荐（第三十五轮） */
    const PLAT_NAME = { netease: '网易云', qq: 'QQ 音乐' };
    const dl = this._msetCard(box, '每日音乐推荐',
      '每天从网易云 / QQ 的「每日推荐」拉一批歌，自动下到下面这个文件夹；第二天没勾选保留的歌会自动删掉。'
      + '曲目需要先在「登录国内音乐平台」登录对应账号；下载走你自己填的下载源。界面在音乐模块的「每日推荐」页。');
    const dlist = el('div', { class: 'mset-list' });
    dl.appendChild(dlist);
    const drawDaily = (st) => {
      const c = (st && st.config) || {};
      const logged = (st && st.logged) || {};
      const srcs = (c.sources && c.sources.length) ? c.sources : ['netease', 'qq'];
      clear(dlist);

      /* 文件夹 */
      dlist.appendChild(el('div', { class: 'mset-line' },
        this._msetPath(c.dir || '（未设置 —— 不知道往哪下）'),
        el('button', { class: 'btn btn-icon', title: '在资源管理器里打开', onclick: () => c.dir && API.raw.shell.openPath(c.dir) }, uiSpan('folder')),
        el('button', { class: 'btn btn-sm', onclick: async () => {
          const d = await API.raw.music.pickDailyDir();
          if (!d) return;
          await API.raw.music.setDailyConfig({ dir: d });
          await refreshDaily();
          me.toast('已设置每日音乐文件夹', 'ok');
        } }, uiSpan('folder'), '选择文件夹')));

      /* 下载源地址 —— 🔴 本软件**不内置任何下载站**，谁用谁自己填。
         填的值存 `music.daily.base`，主进程会做规范化（补协议 / 去尾斜杠 / 只留 origin）。 */
      dlist.appendChild(el('div', { class: 'mset-line' },
        el('span', { class: 'grow', title: '支持 act=search / getUrl / getLyric 那套接口的站点根地址' }, '下载源地址'),
        el('input', {
          class: 'inp', type: 'text', value: c.base || '',
          style: { width: '260px' },
          placeholder: 'https://example.com',
          title: '留空 = 不下载。填站点根地址即可，不用带 /ajax.php',
          onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
          onchange: async (e) => {
            const v = String(e.target.value || '').trim();
            await API.raw.music.setDailyConfig({ base: v });
            await refreshDaily();
            me.toast(v ? '下载源已保存' : '已清空下载源（每日推荐将无法下载）', v ? 'ok' : 'err');
          }
        })));
      dlist.appendChild(el('div', { class: 'mset-line' },
        el('span', { class: 'hint', text: c.base
          ? '已配置下载源；留空则不下载（本软件不内置任何下载站）。'
          : '还没填下载源 —— 不填就没法下载每日推荐。本软件不内置下载站，填一个你能用的站点根地址即可。' })));

      /* 推荐来源（多选）—— 用户明确要求「能选拉哪个软件的每日推荐」 */
      dlist.appendChild(el('div', { class: 'mset-line' },
        el('span', { class: 'grow', title: '勾几个就按顺序试几个，取第一个能拿到的；只勾一个就只用那个' }, '推荐来源'),
        el('div', { class: 'chips', style: { marginBottom: '0' } },
          ['netease', 'qq'].map((p) => el('span', {
            class: 'chip' + (srcs.includes(p) ? ' on' : ''),
            title: logged[p] ? '已登录' : '还没登录 —— 勾了也拿不到（会退回另一个）',
            onclick: async () => {
              const next = srcs.includes(p) ? srcs.filter((x) => x !== p) : [...srcs, p];
              if (!next.length) return me.toast('至少要留一个来源', 'err');
              await API.raw.music.setDailyConfig({ sources: next });
              await refreshDaily();
            }
          }, PLAT_NAME[p] + (logged[p] ? '' : '（未登录）'))))));
      dlist.appendChild(el('div', { class: 'mset-line' },
        el('span', { class: 'hint', text: '按顺序尝试，取第一个能拿到的平台；两个都勾就先用网易云。' })));

      /* 开关 / 音质 / 数量 */
      dlist.appendChild(el('div', { class: 'mset-line' },
        el('span', { class: 'grow', text: '每天自动拉取每日推荐' }),
        this._msetChips(c.enabled ? 'on' : 'off', [['off', '关'], ['on', '开']], async (v) => {
          await API.raw.music.setDailyConfig({ enabled: v === 'on' });
          await refreshDaily();
        })));
      dlist.appendChild(el('div', { class: 'mset-line' },
        el('span', { class: 'grow', text: '第二天自动清理（只删上一批未保留的）' }),
        this._msetChips(c.autoClean ? 'on' : 'off', [['on', '开'], ['off', '关']], async (v) => {
          await API.raw.music.setDailyConfig({ autoClean: v === 'on' });
          await refreshDaily();
        })));
      dlist.appendChild(el('div', { class: 'mset-line' },
        el('span', { class: 'grow', text: '音质偏好' }),
        this._msetChips(c.quality, [['highest', '最高'], ['lossless', '无损'], ['high', '高'], ['normal', '标准']], async (v) => {
          await API.raw.music.setDailyConfig({ quality: v });
          await refreshDaily();
        })));
      dlist.appendChild(el('div', { class: 'mset-line' },
        el('span', { class: 'grow', text: '每天拉取数量' }),
        this._msetChips(String(c.limit), [['10', '10'], ['20', '20'], ['30', '30'], ['50', '50']], async (v) => {
          await API.raw.music.setDailyConfig({ limit: Number(v) });
          await refreshDaily();
        })));
    };
    /* ⚠️ 用 dailyStatus()（带登录态）而不是 dailyConfig()：来源那一行要显示「未登录」，
       否则用户勾了没登录的平台，只会看到「拿不到推荐」而不知道为什么。 */
    const refreshDaily = async () => {
      const st = await API.raw.music.dailyStatus().catch(() => null);
      drawDaily(st || { config: { dir: '', enabled: false, autoClean: true, quality: 'lossless', limit: 30, sources: ['netease', 'qq'] }, logged: {} });
    };
    await refreshDaily();
  },

  /* ---------------- 游戏 ---------------- */
  mset_games(host) {
    const box = this._msetCards(host);
    const me = this;

    /* 游戏库扫描 */
    const lib = this._msetCard(box, '游戏库', '从这里把本机已有的游戏找出来。扫描是增量的，已经在库里的不会重复添加。');
    lib.appendChild(el('div', { class: 'row' },
      el('button', { class: 'btn btn-sm', onclick: async (e) => {
        const b = e.currentTarget; b.disabled = true;
        try { const r = await API.raw.games.scan(); me.toast(r && r.added != null ? `扫描完成：新增 ${r.added} 款` : '扫描完成', 'ok'); }
        catch (err) { me.toast(err.message, 'err'); } finally { b.disabled = false; }
      } }, uiSpan('refresh'), '扫描 Steam 库'),
      el('button', { class: 'btn btn-sm btn-ghost', onclick: async (e) => {
        const dirs = await API.raw.dialog.pickFolders();
        if (!dirs || !dirs.length) return;
        const b = e.currentTarget; b.disabled = true;
        try { const r = await API.raw.games.scanFolder(dirs); me.toast(r && r.added != null ? `扫描完成：新增 ${r.added} 款` : '扫描完成', 'ok'); }
        catch (err) { me.toast(err.message, 'err'); } finally { b.disabled = false; }
      } }, uiSpan('folder'), '扫描本地文件夹')));

    /* 隐藏空间 */
    const hs = this._msetCard(box, '隐藏空间',
      '名字 + 密码保护。挂上「18+」分类的游戏会自动进这里，在游戏库里看不到。');
    const hsState = el('span', { class: 'grow text-dim', text: '读取中…' });
    hs.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: '状态' }), hsState));
    hs.appendChild(el('div', { class: 'row' },
      el('button', { class: 'btn btn-sm', onclick: () => {
        me.closeModal();
        me.go('#/games');
        // 路由挂载是异步的，等它挂完再翻页
        setTimeout(() => { if (window.GamesView && window.GamesView.setPage) window.GamesView.setPage('hidden'); }, 60);
      } }, uiSpan('lock'), '进入隐藏空间')));
    API.raw.hidden.info().then((i) => {
      const on = !!(i && i.enabled);
      hsState.textContent = on ? '已启用（进入需要名字 + 密码）' : '未启用 —— 进隐藏空间会引导你设置';
      hsState.className = 'grow ' + (on ? 'text-ok' : 'text-dim');
    }).catch(() => { hsState.textContent = '读取失败'; });
  },

  /* ---------------- MOD（第五十三轮从游戏里独立出来） ---------------- */
  mset_mods(host) {
    const box = this._msetCards(host);
    const me = this;
    const s = State.settings || {};

    /* MOD 下载：内嵌 Nexus 浏览器抓到的东西按这套规则落地 */
    const md = s.modDownload || {};
    const mode = md.mode === 'folder' ? 'folder' : 'install';
    const card = this._msetCard(box, 'MOD 下载',
      'MOD 模块里那块内嵌 Nexus 浏览器下载下来的 MOD，按这里的规则处理。');
    const seg = (k, label, desc) => el('div', {
      class: 'md-opt' + (mode === k ? ' on' : ''),
      onclick: async () => { await State.set({ modDownload: { mode: k } }); me._msetRepaintNow(); }
    }, el('div', { class: 'md-t', text: label }), el('div', { class: 'md-s', text: desc }));
    card.appendChild(el('div', { class: 'md-opts' },
      seg('install', '装进游戏的 MOD 目录', '下载完自动解压进这款游戏的 MOD 目录，装完把压缩包删掉。'),
      seg('folder', '只下载到文件夹', '不自动安装，文件就放在下面这个目录里，剩下的事你自己来。')));
    const dflt = '（默认：拾光集数据目录 / mod-downloads）';
    card.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: 'MOD 下载目录' }),
      this._msetPath(md.dir || (s.downloadDir ? s.downloadDir + '（沿用通用下载目录）' : dflt), md.dir || ''),
      el('button', { class: 'btn btn-sm', onclick: async () => {
        const d = await API.raw.dialog.pickFolder();
        if (!d) return;
        await State.set({ modDownload: { dir: d } });
        me.toast('MOD 下载目录已更新', 'ok');
        me._msetRepaintNow();
      } }, '选择'),
      md.dir ? el('button', { class: 'btn btn-sm btn-ghost', onclick: async () => {
        await State.set({ modDownload: { dir: '' } });
        me.toast('已恢复默认目录');
        me._msetRepaintNow();
      } }, '恢复默认') : null));
    card.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: '安装包' }),
      this._msetChips(md.keepArchive ? 'keep' : 'del',
        [['del', '装好后删掉', '装进 MOD 目录之后把压缩包删掉'],
         ['keep', '装好后保留', '装进 MOD 目录之后也留着安装包']],
        async (v) => { await State.set({ modDownload: { keepArchive: v === 'keep' } }); me._msetRepaintNow(); })));

    /* 每款游戏的 MOD 目录是各自的，统一在这里改不了 → 给个门 */
    const per = this._msetCard(box, '每款游戏的 MOD 目录',
      '认目录的规则按游戏走（Skyrim 认 Data、Minecraft 认 mods…），在 MOD 模块里选一款游戏就能看到当前目录、也能手动改。');
    per.appendChild(el('div', { class: 'row' },
      el('button', { class: 'btn btn-sm', onclick: () => { me.closeModal(); me.go('#/mods'); } },
        uiSpan('extension'), '去 MOD 模块')));
  },

  /* ---------------- 图片（第五十七轮） ----------------
     底图**只用国家地理信息公共服务平台（天地图）**；密钥默认空，用户自己填 ——
     🔴 项目硬规则：绝不内置任何第三方密钥/站点。没填就画内置的离线矢量底图。
     最下面那张「自定义底图」表单写的是 window.SGJMap.registerSource 的结构，
     别人想换自己的瓦片服务，填一次就行，不用改代码。 */
  async mset_photos(host) {
    const box = this._msetCards(host);
    const me = this;
    const cfg = await API.raw.photos.mapConfig({}).catch(() => null) || {};
    const save = async (patch) => {
      await API.raw.photos.mapConfig(patch);
      /* 地图还开着就让它立刻重画（换密钥 / 换风格要马上看得见） */
      if (window.PhotosView && window.PhotosView.mapInst) {
        window.PhotosView.st.map = Object.assign({}, window.PhotosView.st.map, patch);
        window.PhotosView.syncMap();
      }
      me._msetRepaintNow();
    };

    /* 天地图密钥 */
    const tkCard = this._msetCard(box, '天地图密钥',
      '足迹地图的官方底图来自国家地理信息公共服务平台（天地图）。去那里申请一个浏览器端密钥填进来；不填也能用，只是底图是软件内置的离线示意底图（只有陆地轮廓）。');
    const tkIn = el('input', {
      class: 'ph-inp grow', type: 'text', placeholder: '留空 = 用离线示意底图', value: cfg.tk || ''
    });
    tkCard.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: 'tk' }), tkIn,
      el('button', { class: 'btn btn-sm btn-primary', onclick: async () => { await save({ tk: String(tkIn.value || '').trim() }); me.toast('已保存', 'ok'); } }, '保存')));
    tkCard.appendChild(el('p', { class: 'hint', style: { marginBottom: '0' },
      text: '密钥只存在你自己的电脑里（软件数据目录），不会跟着软件发出去。' }));

    /* 风格：跟随主题 / 浅色 / 深色 */
    const styleCard = this._msetCard(box, '地图风格',
      '「跟随软件主题」时，深色模式下会把官方底图压暗、配色换成软件的深色变量 —— 这是让地图看起来像软件的一部分，而不是贴一张别人的图。');
    styleCard.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: '配色' }),
      this._msetChips(cfg.style || 'auto',
        [['auto', '跟随软件主题', '软件深色它深色、软件浅色它浅色'],
         ['light', '始终浅色', '不管软件什么主题都用浅色底图'],
         ['dark', '始终深色', '不管软件什么主题都压成深色']],
        async (v) => { await save({ style: v }); })));

    /* 自定义底图源（对外接口：window.SGJMap.registerSource） */
    const layers = Array.isArray(cfg.layers) ? cfg.layers : [];
    const mine = layers.length ? layers[0] : null;
    const cCard = this._msetCard(box, '自定义底图（给会用的人）',
      '想换成自己的瓦片服务就填这里：地址模板支持 {z} {x} {y} {s}（{s} 会轮流替换成下面的子域）。留空 = 用天地图。第三方插件也能走同一个接口换底图：SGJMap.registerSource({ id, name, kind:"tiles", url, subdomains, attribution })。');
    const uIn = el('input', { class: 'ph-inp grow', type: 'text', placeholder: 'https://example.com/tiles/{z}/{x}/{y}.png', value: mine ? String(mine.url || '') : '' });
    const nIn = el('input', { class: 'ph-inp', type: 'text', placeholder: '名称（可留空）', value: mine ? String(mine.name || '') : '' });
    const sIn = el('input', { class: 'ph-inp', type: 'text', placeholder: '子域，逗号分隔（可留空）', value: mine ? String((mine.subdomains || []).join(',')) : '' });
    const aIn = el('input', { class: 'ph-inp', type: 'text', placeholder: '署名（可留空）', value: mine ? String(mine.attribution || '') : '' });
    const cErr = el('p', { class: 'ph-err', hidden: true });
    cCard.appendChild(el('div', { class: 'ph-col' },
      el('div', { class: 'row' }, el('span', { class: 'label', text: '地址' }), uIn),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '名称' }), nIn),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '子域' }), sIn),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '署名' }), aIn),
      el('div', { class: 'row' }, cErr,
        el('span', { class: 'grow' }),
        mine ? el('button', { class: 'btn btn-sm btn-ghost', onclick: async () => { await save({ layers: [] }); me.toast('已恢复天地图'); } }, '清除') : null,
        el('button', {
          class: 'btn btn-sm btn-primary', onclick: async () => {
            cErr.hidden = true;
            const url = String(uIn.value || '').trim();
            if (!url) { await save({ layers: [] }); me.toast('已恢复天地图'); return; }
            /* 🔴 只认 http(s)，别让 file: / javascript: 混进瓦片地址 */
            if (!/^https?:\/\//i.test(url)) { cErr.textContent = '地址要用 http:// 或 https:// 开头'; cErr.hidden = false; return; }
            if (!/\{z\}/.test(url) || !/\{x\}/.test(url) || !/\{y\}/.test(url)) {
              cErr.textContent = '地址里必须带 {z} {x} {y} 这三个占位符'; cErr.hidden = false; return;
            }
            await save({
              layers: [{
                id: 'custom', name: String(nIn.value || '').trim() || '自定义底图', kind: 'tiles', url,
                subdomains: String(sIn.value || '').split(',').map((x) => x.trim()).filter(Boolean),
                attribution: String(aIn.value || '').trim(), minZoom: 1, maxZoom: 18, layers: []
              }]
            });
            me.toast('已换成自定义底图', 'ok');
          }
        }, '保存'))));

    /* 默认打开哪个视野 */
    const vCard = this._msetCard(box, '打开足迹时先看哪张地图',
      '中国地图走到能看全疆域（含南海诸岛）的视野，世界地图看整块大陆。两个按钮在页面上随时能切。');
    vCard.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: '默认' }),
      this._msetChips(cfg.view || 'china',
        [['china', '中国地图'], ['world', '世界地图']],
        async (v) => {
          await save({ view: v });
          if (window.PhotosView) { window.PhotosView.mapView = v; }
        })));

    /* 图片文件夹（跟左边栏同一个设置，这里给个门） */
    const fCard = this._msetCard(box, '图片文件夹',
      '在图片模块左边添加或移除要看的文件夹。这里只显示数量 —— 改完点「重新扫描」才会去读新照片。');
    const st = await API.raw.photos.state().catch(() => null);
    fCard.appendChild(el('div', { class: 'row' },
      el('span', { class: 'label', text: '已收录' }),
      el('span', { class: 'grow', text: st ? `${st.count} 张 · ${(st.roots || []).length} 个文件夹` : '—' }),
      el('button', { class: 'btn btn-sm', onclick: () => { me.closeModal(); me.go('#/photos'); } }, '去图片模块')));
  },

  /* ---------------- 网盘 ---------------- */
  async mset_netdisk(host) {
    const box = this._msetCards(host);
    const me = this;
    const s = State.settings || {};

    /* 下载 */
    const dl = this._msetCard(box, '下载',
      '网盘模块的下载任务都落到通用下载目录里（全局「设置 → 通用」里改）。');
    dl.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: '下载目录' }),
      this._msetPath(s.downloadDir || '（默认：系统下载目录 / 拾光集）', s.downloadDir || ''),
      el('button', { class: 'btn btn-sm', onclick: async () => {
        const d = await API.raw.dialog.pickFolder();
        if (!d) return;
        await State.set({ downloadDir: d });
        me.toast('下载目录已更新', 'ok');
        me._msetRepaintNow();
      } }, '选择')));

    /* 账号 */
    const acc = this._msetCard(box, '账号',
      '和浏览器模块共用同一套 Cookie —— 在任一边登过，另一边直接认得。');
    const list = el('div', { class: 'mset-list mset-acc' });
    acc.appendChild(list);
    const plats = await API.raw.netdisk.platforms().catch(() => []);
    if (!plats.length) list.appendChild(el('p', { class: 'hint', style: { margin: '0' }, text: '没有可用的网盘平台。' }));
    for (const p of plats) {
      if (!p.needLogin) continue;   // 无需登录的直接跳过，省得一屏都是「无需登录」
      list.appendChild(el('div', { class: 'mset-line' },
        el('span', { class: 'mset-dot', style: { background: p.color || 'var(--text-mute)' } }),
        el('span', { class: 'grow', text: p.name }),
        el('span', { class: 'chip' + (p.logged ? ' accent' : ''), text: p.logged ? (p.nickname || '已登录') : '未登录' }),
        p.logged
          ? el('button', { class: 'btn btn-sm btn-ghost', onclick: () => {
            me.closeModal();
            me.go('#/netdisk');
            setTimeout(() => { if (window.NetdiskView && window.NetdiskView.reload) window.NetdiskView.reload(); }, 80);
          } }, '去退出')
          : el('button', { class: 'btn btn-sm', onclick: async () => {
            // ⚠️ 不能嵌套弹窗：登录弹窗会 clear #modals，把这一层拆掉 → 先关自己再开
            me.closeModal();
            await me.openLoginDialog({ kind: 'netdisk', id: p.id, name: p.name, url: p.loginUrl });
          } }, '登录')));
    }
  },

  /* ---------------- 浏览器 ---------------- */
  async mset_browser(host) {
    const box = this._msetCards(host);
    const me = this;
    const bs = await API.raw.browser.settings().catch(() => null);
    const engines = await API.raw.browser.engines().catch(() => []);
    if (!bs) { host.appendChild(el('p', { class: 'hint', text: '浏览器设置读取失败。' })); return; }

    const save = async (patch) => {
      try {
        const next = await API.raw.browser.setSettings(patch);
        Object.assign(bs, next);
        me.toast('已保存', 'ok');
      } catch (e) { me.toast(e.message, 'err'); }
      me._msetRepaintNow();
    };

    const card = this._msetCard(box, '浏览',
      '改完立即生效。这些设置只作用于浏览器模块里的页面。');
    card.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: '主页' }),
      el('input', {
        class: 'inp grow', value: bs.home || '', placeholder: 'https://…',
        onchange: (e) => save({ home: e.target.value.trim() })
      })));
    card.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: '搜索引擎' }),
      el('select', {
        class: 'inp', style: { width: '190px' },
        onchange: (e) => save({ engine: e.target.value })
      }, (engines.length ? engines : [{ id: 'bing', name: 'Bing' }]).map((g) =>
        el('option', { value: g.id, selected: bs.engine === g.id }, g.name)))));
    card.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: '夜间模式' }),
      this._msetChips(bs.nightMode || 'off',
        [['off', '关闭'], ['dark', '深色'], ['warm', '暖色'], ['both', '深色 + 暖色']],
        (v) => save({ nightMode: v }))));
    card.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: '功能' }),
      el('div', { class: 'chips', style: { marginBottom: '0' } },
        el('span', { class: 'chip' + (bs.sidebar ? ' on' : ''), title: '左侧书签 / 历史侧栏', onclick: () => save({ sidebar: !bs.sidebar }) }, '侧栏'),
        el('span', { class: 'chip' + (bs.newTabSites ? ' on' : ''), title: '新标签页显示常用站点', onclick: () => save({ newTabSites: !bs.newTabSites }) }, '新标签页常用站点'),
        el('span', { class: 'chip' + (bs.adblock ? ' on' : ''), title: '广告拦截', onclick: () => save({ adblock: !bs.adblock }) }, '广告拦截'),
        el('span', { class: 'chip' + (bs.gestures ? ' on' : ''), title: '鼠标手势', onclick: () => save({ gestures: !bs.gestures }) }, '鼠标手势'))));

    const info = this._msetCard(box, '环境',
      'UA 伪装与分区是固定策略，避免站点识别出 Electron。');
    info.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: 'User-Agent' }),
      this._msetPath(bs.ua || '', bs.ua || '')));
    info.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: '会话分区' }),
      this._msetPath(bs.partition || '', bs.partition || '')));
    info.appendChild(el('div', { class: 'row' }, el('span', { class: 'label', text: '更多' }),
      el('button', { class: 'btn btn-sm btn-ghost', onclick: () => {
        me.closeModal();
        me.go('#/browser');
      } }, uiSpan('globe'), '书签 / 历史 / 扩展 / 注入都在浏览器模块里')));
  },

  async pickBg(slot) {
    const r = await API.raw.appearance.setImage({ slot }).catch((e) => { this.toast(e.message, 'err'); return null; });
    if (r && r.ok) {
      const bg = await API.raw.appearance.urls().catch(() => ({}));
      State.settings.background = { content: (bg.content || '').replace(/^file:\/\//, ''), opacity: bg.opacity };
      State.applyTheme();
      this.toast('背景已更新', 'ok');
      if (location.hash === '#/settings') this.renderSettings(this.view);
    }
  },

  /* ============================================================
     Toast / 状态
     ============================================================ */
  /**
   * 开关控件（第四十九轮）。
   * @param {boolean} on 当前状态
   * @param {(next:boolean)=>void} onToggle 回调给的是「点完应该是」的状态
   */
  switchEl(on, onToggle, o) {
    const opts = o || {};
    const box = el('div', {
      class: 'switch' + (on ? ' on' : ''),
      role: 'switch',
      'aria-checked': on ? 'true' : 'false',
      title: opts.title || (on ? '点击关闭' : '点击启用'),
      /* ⚠️ 必须挡住冒泡：以后要把整行做成可点的话，行上的 click 会和这里打两枪 */
      onclick: (e) => { e.stopPropagation(); onToggle(!on); }
    });
    box.appendChild(el('div', { class: 'switch-knob' }));
    return box;
  },

  toast(msg, type = 'info') {
    const stack = document.getElementById('toasts');
    const t = el('div', { class: 'toast ' + type },
      el('span', { class: 'dot' }), el('span', { text: msg }));
    stack.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 220); }, 2600);
  },
  status(text) {
    const c = document.getElementById('tbCenter');
    clear(c);
    if (text) c.appendChild(el('span', { class: 'sub text-dim', style: { fontSize: '.88em' }, text }));
    else c.appendChild(el('span'));
  },

  /* ============================================================
     内置登录（音乐 / 网盘共用）
     ------------------------------------------------------------
     以前这里是 openExternal 打开系统浏览器 + 一个「标记为已登录」按钮 ——
     那根本没拿到任何登录凭证。现在改成软件内开登录窗，主进程监听
     `persist:sgj-browser` 分区里的 cookie，命中就自动落盘并广播 login:done。
     ============================================================ */
  async openLoginDialog({ kind, id, name, url }) {
    const label = name || id;
    this.toast(`正在打开 ${label} 登录窗口…`);

    const r = await API.raw.login.open({ kind, platform: id, url, name: label })
      .catch((e) => { this.toast(e.message, 'err'); return null; });
    if (!r) return false;

    // 分区里本来就有登录态（比如先在「浏览器」模块登过）→ 直接算完成
    if (r.ok) {
      this.toast(`${label}：已复用现有登录状态${r.nickname ? ' · ' + r.nickname : ''}`, 'ok');
      return true;
    }

    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    // ⚠️ 这里没用 modal 自带的 ok/cancel 按钮：它一按就无条件关弹窗，
    //    而「检查一下但还没登录成功」必须把弹窗和登录窗都留着。所以按钮自己画。
    return new Promise((resolve) => {
      let done = false;
      let off1 = () => {}, off2 = () => {};
      const dot = el('span', { class: 'login-dot wait' });
      const t1 = el('div', { class: 'login-t', text: '等待你在登录窗口里完成登录…' });
      const t2 = el('div', { class: 'login-s', text: '登录成功后会自动完成，不用再点任何东西。' });

      const paint = (cls, title, sub) => {
        dot.className = 'login-dot ' + cls;
        t1.textContent = title;
        t2.textContent = sub || '';
      };

      /** 收尾；fromEvent=自动完成（要自己关弹窗），否则是按钮触发的 */
      const settle = async (ok, title, sub, fromEvent) => {
        if (done) return;
        done = true;
        off1(); off2();
        paint(ok ? 'ok' : 'err', title, sub);
        await wait(ok ? 700 : 1200);
        if (fromEvent) window.Shell.closeModal();
        resolve(!!ok);
      };

      const checkBtn = el('button', {
        class: 'btn btn-primary',
        text: '我已完成登录，检查一下',
        onclick: async () => {
          paint('wait', '正在检查登录状态…', '');
          let rr = await API.raw.login.check({}).catch((e) => ({ ok: false, error: e.message }));
          if (!rr || !rr.ok) {
            // 有些站点（阿里云盘 / 123 云盘等）把凭证放 localStorage，或用的是私有 cookie 名，
            // 关键 cookie 猜不准 —— 这时做「强确认」：把该站点确实拿到的 cookie 全部存下来。
            // ⚠️ 这不是假装标记，是真的抓到了凭证；界面上也如实说是「已保存登录信息」，
            //    不会谎报「已登录：某某」。
            rr = await API.raw.login.check({ force: true }).catch((e) => ({ ok: false, error: e.message }));
            if (rr && rr.ok) {
              return settle(true, '已保存登录信息', '这个平台的关键 Cookie 名认不准，已把站点发下来的登录凭证全部保存。');
            }
          }
          if (rr && rr.ok) {
            return settle(true, rr.nickname ? `登录成功 · ${rr.nickname}` : '登录成功', '账号信息已保存在本机。');
          }
          paint('err', '还没检测到登录状态', (rr && rr.error) || '请先在登录窗口里完成登录，再点一次「检查一下」。');
        }
      });

      const cancelBtn = el('button', {
        class: 'btn',
        text: '放弃登录',
        onclick: () => {
          done = true; off1(); off2();
          API.raw.login.cancel().catch(() => {});
          window.Shell.closeModal();
          resolve(false);
        }
      });

      off1 = API.on('login:done', (d) => {
        if (!d || d.platform !== id) return;
        settle(true, d.nickname ? `登录成功 · ${d.nickname}` : '登录成功',
          `已在本机保存 ${d.count || 0} 项登录信息${d.reused ? '（复用了浏览器里的登录状态）' : ''}。`, true);
      });
      off2 = API.on('login:fail', (d) => {
        if (!d || d.platform !== id) return;
        if (d.reason === 'closed') {
          paint('err', '登录窗口已关闭', '如果其实已经登好了，点「检查一下」再看一遍。');
          return;
        }
        settle(false, '登录没完成', d.message || '请重试。', true);
      });

      window.Shell.modal({
        title: `登录 ${label}`,
        body: el('div', { class: 'login-box' },
          el('div', { class: 'login-row' }, dot, el('div', { class: 'login-lines' }, t1, t2)),
          el('p', { class: 'hint', text: '登录页开在软件内的独立窗口里，用的是和「浏览器」模块同一套 Cookie —— 在任一边登过，另一边直接认得。' }),
          el('div', { class: 'login-acts' }, checkBtn, cancelBtn)
        ),
        // ⚠️ 传空串把 modal 自带的「取消 / 确定」那一行去掉：
        //    它的「确定」无脑关弹窗，而这里的「检查一下但还没登好」必须把弹窗留着。
        okText: '', cancelText: '',
        onClose: () => {
          off1(); off2();
          if (!done) API.raw.login.cancel().catch(() => {});
        }
      });
    });
  },

  /* ============================================================
     Modal / Prompt / Confirm
     ============================================================ */
  modal({ title, body, okText = '确定', cancelText = '取消', onOk, onClose, wide }) {
    const root = document.getElementById('modals');
    clear(root);
    root.classList.add('on');
    this._onModalClose = typeof onClose === 'function' ? onClose : null;
    const close = () => this.closeModal();
    const m = el('div', { class: 'modal' + (wide ? ' wide' : '') },
      el('div', { class: 'modal-head' }, el('h3', { text: title || '' }), el('button', { class: 'close-x', onclick: close }, '✕')),
      el('div', { class: 'modal-body' }, body),
      (cancelText || okText) ? el('div', { class: 'modal-foot' },
        cancelText ? el('button', { class: 'btn', onclick: close }, cancelText) : null,
        okText ? el('button', { class: 'btn btn-primary', onclick: async () => { try { if (onOk) await onOk(); } catch (e) { this.toast(e.message, 'err'); } close(); } }, okText) : null
      ) : null
    );
    root.appendChild(el('div', { class: 'modal-mask' }));
    root.appendChild(m);
  },
  closeModal() {
    const root = document.getElementById('modals');
    root.classList.remove('on');
    clear(root);
    // 模块设置弹层自己搭了壳，记得把重画回调一起清掉（否则会往已摘下来的节点上重画）
    this._msetRepaint = null;
    const cb = this._onModalClose;
    this._onModalClose = null;
    if (cb) { try { cb(); } catch { /* ignore */ } }
  },

  prompt({ title, label, placeholder = '', value = '', password = false }) {
    return new Promise((resolve) => {
      this.modal({
        title: title || '输入',
        body: el('div', {},
          label ? el('label', { class: 'text-dim', style: { display: 'block', marginBottom: '8px', fontSize: '.9em' }, text: label }) : null,
          el('input', { class: 'inp', id: 'pmInput', type: password ? 'password' : 'text', placeholder, value }),
          password ? el('p', { class: 'hint', style: { marginTop: '8px' }, text: '密码仅用于本机校验。' }) : null
        ),
        okText: '确定',
        onOk: () => resolve((document.getElementById('pmInput') || {}).value || ''),
        cancelText: '取消'
      });
      setTimeout(() => { const i = document.getElementById('pmInput'); if (i) { i.focus(); i.select(); i.onkeydown = (e) => { if (e.key === 'Enter') { const v = i.value; this.closeModal(); resolve(v); } }; } }, 60);
      // 关闭时若未确定，等到 resolve 默认值
      const root = document.getElementById('modals');
      const obs = new MutationObserver(() => { if (!root.classList.contains('on')) { obs.disconnect(); resolve(null); } });
      obs.observe(root, { attributes: true });
    });
  },

  confirm({ title, message, detail = '', okText = '确定', cancelText = '取消' }) {
    return new Promise((resolve) => {
      this.modal({
        title: title || '确认',
        body: el('div', {},
          el('p', { style: { marginTop: 0 }, text: message }),
          detail ? el('p', { class: 'text-dim', style: { fontSize: '.88em' }, text: detail }) : null),
        okText, cancelText,
        onOk: () => resolve(true)
      });
      const root = document.getElementById('modals');
      const obs = new MutationObserver(() => { if (!root.classList.contains('on')) { obs.disconnect(); resolve(false); } });
      obs.observe(root, { attributes: true });
    });
  },

  /* ============================================================
     右键菜单
     ============================================================ */
  contextMenu(x, y, items) {
    const menu = document.getElementById('ctxMenu');
    clear(menu);
    for (const it of items) {
      if (it.divider) { menu.appendChild(el('div', { class: 'divider' })); continue; }
      menu.appendChild(el('div', { class: 'mi' + (it.danger ? ' danger' : ''), onclick: () => { this.hideContextMenu(); it.onClick && it.onClick(); } },
        it.icon ? uiSpan(it.icon) : null, it.label));
    }
    menu.hidden = false;
    const w = menu.offsetWidth || 180, h = menu.offsetHeight || 200;
    menu.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
  },
  hideContextMenu() { const m = document.getElementById('ctxMenu'); if (m) m.hidden = true; }
};

/* ============================================================
   更新卡用的小工具（第四十九轮）
   ------------------------------------------------------------
   ⚠️ 这些是**纯显示**逻辑，真正的版本比较在主进程 `src/main/update.js` 里。
      渲染层不许自己判「有没有新版」—— 两套规则迟早会打架（一个说 0.2.10
      比 0.2.9 小，一个说大），只信主进程回来的 hasUpdate。
   ============================================================ */
const UP_MODES = ['auto', 'manual', 'off'];
const UP_MODE_TEXT = { auto: '自动检查更新', manual: '仅手动检查', off: '屏蔽更新（不联网）' };

/** 'v0.2.1' / '0.2.1' → '0.2.1'；空 → '—'（界面上一律带 v 前缀，这里不带） */
function verText(v) {
  const s = String(v == null ? '' : v).trim().replace(/^v/i, '');
  return s || '—';
}

/** 一句话说清「上次检查」的结果 */
function upSummary(last) {
  if (!last) return '还没检查过';
  if (last.blocked) return '已屏蔽，不会联网';
  if (!last.ok) return '上次检查失败：' + (last.error || '未知原因');
  const when = last.at ? fmtDate(last.at, true) : '';
  const head = when ? '上次检查 ' + when + ' · ' : '';
  return head + (last.hasUpdate ? `有新版本 ${verText(last.latest)}` : `已是最新（${verText(last.current)}）`);
}

/** 时间戳 / ISO 串 → '2026-10-22 21:00'（second=true 时带时分） */
function fmtDate(v, withTime) {
  const d = v instanceof Date ? v : new Date(typeof v === 'number' ? v : String(v));
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  const day = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  return withTime ? day + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) : day;
}

/** 截断长文本（更新说明可能几千字，塞满整页不好看） */
function clip(text, max) {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max) + '\n…（还有 ' + (s.length - max) + ' 字，去 Release 页面看完整说明）' : s;
}

/** 资产名太长，按钮上只显示版本部分：ShiGuangJi-0.2.1-portable.exe → 0.2.1-portable.exe */
function shortName(name) {
  return String(name || '').replace(/^ShiGuangJi-/i, '');
}

window.Shell = Shell;
document.addEventListener('DOMContentLoaded', () => Shell.boot());
})();
