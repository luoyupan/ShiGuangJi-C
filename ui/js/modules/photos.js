/**
 * ============================================================
 *  拾光集 · 图片模块（界面层）(modules/photos.js)
 *  ------------------------------------------------------------
 *  第五十七轮新增，第七个模块。四件事：
 *    ① 读用户指定的若干文件夹，把里面的图片收进来（扫描在主进程）
 *    ② 按拍摄时间 / 文件名 / 地点排序（排序规则在 js/photo-lib.js，纯函数）
 *    ③ 「足迹」地图：中国 / 世界一键切换，有坐标的照片在对应位置显示别针，
 *       点别针看照片；底图**只用国家地理信息公共服务平台（天地图）**，
 *       密钥由用户自己填，没填就用内置的离线矢量兜底图
 *    ④ 没有 GPS 的照片可以自己标坐标（手填，或在地图上点一下取点）
 *
 *  地图引擎在 js/photos-map.js，对外留了自定义接口（window.SGJMap）：
 *    SGJMap.registerSource({ id, name, kind:'tiles', url:'…{z}/{x}/{y}', … })
 *    SGJMap.registerStyle({ id, name, colors:{ land, sea, border, grate, pin, dot } })
 *  模块设置里那张「自定义底图」表单写的就是这个结构（存进 photos.map.layers[0]），
 *  所以**别人不碰本文件也能换底图和配色**。
 *
 *  ⚠️ 全程只读用户的照片：不改名、不移动、不回写 EXIF。
 * ============================================================ */
(function () {
  'use strict';

  /* 🔴 必须这样取：`el/clear/toFileUrl` 在 `window.util`，图标在 `window.ICON`。
     写 `window.el` 会拿到 undefined，IIFE 一执行就炸 → 路由对、面包屑对、内容区全空白。 */
  const { el, clear, toFileUrl } = window.util;
  const { uiSpan } = window.ICON;

  /** 排序下拉的项（值就是落库的 photos.sort） */
  const SORTS = [
    ['time-desc', '拍摄时间（新 → 旧）'],
    ['time-asc', '拍摄时间（旧 → 新）'],
    ['name', '文件名'],
    ['place', '地点（按省份聚在一起）']
  ];

  const PhotosView = {
    root: null,
    sideEl: null,
    mainEl: null,

    st: { roots: [], places: {}, sort: 'time-desc', map: {}, count: 0, scannedAt: 0 },
    items: [],          // 库里全部
    shown: [],          // 当前排序后的（查看器靠它定位上一张/下一张）
    view: 'wall',       // wall | map
    mapView: 'china',   // china | world
    mapInst: null,
    picking: null,      // 自定义坐标时「在地图上取点」的回调
    selecting: false,   // 批量标地点：选择模式
    selected: new Set(),
    kw: '',
    _seq: 0,            // 代次守卫：异步回来先问「还是这一屏吗」
    _scanning: false,
    _thumbs: new Map(),
    _io: null,

    /* ============================================================
       挂载 / 卸载
       ============================================================ */
    async mount(container) {
      this.root = container;
      this.bindEvents();
      container.innerHTML = '';
      const wrap = el('div', { class: 'games photos' });
      this.sideEl = el('aside', { class: 'gside' });
      this.mainEl = el('section', { class: 'gmain' });
      wrap.appendChild(this.sideEl);
      wrap.appendChild(this.mainEl);
      container.appendChild(wrap);

      this.kw = '';
      await this.reload();
      return this;
    },

    /** 离场清理：地图实例一定要 destroy（它有 ResizeObserver / rAF / 定时器） */
    detach() {
      this.selecting = false;
      this.selected.clear();
      this.picking = null;
      this.closeViewer();
      if (this.mapInst) { try { this.mapInst.destroy(); } catch { /* 已经没了 */ } }
      this.mapInst = null;
      if (this._io) { try { this._io.disconnect(); } catch { /* 同上 */ } }
      this._io = null;
    },

    /** 主进程推送的事件只绑一次（mount 会被反复调用，绑多次就是泄漏） */
    bindEvents() {
      if (this._bound) return;
      this._bound = true;
      API.on('photos:progress', (p) => {
        const t = document.getElementById('phProgT');
        if (t) t.textContent = '已扫到 ' + ((p && p.n) || 0) + ' 张…';
      });
      /* 扫完了主进程会推这条 —— 但如果**是本界面自己发起的扫描**，
         scan() 的 finally 里已经 reload 过一次了，这里再刷就是白做一遍工 */
      API.on('photos:changed', () => {
        if (!window.PhotosView || window.PhotosView._scanning) return;
        window.PhotosView.reload();
      });
    },

    async reload() {
      const seq = ++this._seq;
      this.st = await API.raw.photos.state().catch(() => this.st);
      this.items = await API.raw.photos.items().catch(() => []);
      if (seq !== this._seq) return;
      this.applySort();
      this.renderSide();
      this.renderMain();
    },

    applySort() {
      const PL = window.PhotoLib;
      const mode = this.st.sort || 'time-desc';
      this.shown = PL ? PL.sortItems(this.items, mode, { places: this.st.places || {} }) : this.items.slice();
    },

    /* ============================================================
       左侧：文件夹 + 统计
       ============================================================ */
    renderSide() {
      const side = clear(this.sideEl);
      side.appendChild(el('div', { class: 'mods-side-head' },
        el('button', { class: 'back-btn', title: '回主界面', onclick: () => window.Shell.go('#/') },
          uiSpan('back'), '返回'),
        el('h2', { text: '图片' })));

      side.appendChild(el('div', { class: 'ph-side-act' },
        el('button', { class: 'btn btn-primary btn-sm', onclick: () => this.addFolder() },
          uiSpan('plus'), '添加文件夹'),
        el('button', { class: 'btn btn-sm' + (this._scanning ? ' is-busy' : ''), onclick: () => this.scan() },
          uiSpan('refresh'), this._scanning ? '扫描中…' : '重新扫描')));

      const list = el('div', { class: 'gside-list' });
      side.appendChild(list);

      const roots = this.st.roots || [];
      if (!roots.length) {
        list.appendChild(el('div', { class: 'empty', style: { minHeight: '80px' } },
          el('p', { class: 'text-dim', text: '还没有添加文件夹' })));
      } else {
        for (const r of roots) {
          /* 显示「文件夹名 + 上级路径」而不是整条路径：整条太长，一上来就被省略号吃掉，
             反而看不出这是哪个文件夹（`C:\Users\LIUYUH~1\AppData\L…` 就是反面教材） */
          const seg = String(r).replace(/[\\/]+$/, '').split(/[\\/]/);
          const leaf = seg[seg.length - 1] || r;
          const parent = seg.slice(0, -1).join('\\');
          list.appendChild(el('div', { class: 'ph-root', title: r },
            uiSpan('folder'),
            el('div', { class: 'ph-root-m' },
              el('div', { class: 'ph-root-n', text: leaf }),
              el('div', { class: 'ph-root-s', text: this.countIn(r) + ' 张 · ' + parent })),
            el('button', {
              class: 'ph-root-x', title: '移除这个文件夹',
              onclick: async () => {
                await API.raw.photos.removeRoot(r).catch((e) => window.Shell.toast(e.message, 'err'));
                window.Shell.toast('已移除：' + r);
                this.reload();
              }
            }, uiSpan('close'))));
        }
      }

      /* 底部统计：有坐标 / 没坐标 一眼看到（「能不能标」全靠这个数） */
      const withGps = this.items.filter((x) => x.gps).length;
      const manual = Object.keys(this.st.places || {}).length;
      side.appendChild(el('div', { class: 'ph-stat' },
        el('div', { class: 'ph-stat-l' },
          el('span', { class: 'text-dim', text: '共' }), el('b', { text: String(this.items.length) }), el('span', { class: 'text-dim', text: '张' })),
        el('div', { class: 'ph-stat-l' }, el('span', { class: 'ph-dot exif' }), el('span', { text: '照片自带坐标 ' + withGps })),
        el('div', { class: 'ph-stat-l' }, el('span', { class: 'ph-dot manual' }), el('span', { text: '手动标注 ' + manual })),
        this.st.scannedAt
          ? el('div', { class: 'ph-stat-l' }, el('span', { class: 'text-dim', text: '上次扫描 ' + this.fmtTime(this.st.scannedAt) }))
          : null));
    },

    countIn(root) {
      const r = String(root).toLowerCase();
      return this.items.filter((x) => String(x.path || '').toLowerCase().startsWith(r)).length;
    },

    fmtTime(ts) {
      const d = new Date(Number(ts) || 0);
      const p = (n) => String(n).padStart(2, '0');
      return d.getFullYear() ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` : '';
    },

    async addFolder() {
      const d = await API.raw.dialog.pickFolder().catch(() => '');
      if (!d) return;
      await API.raw.photos.addRoot(d).catch((e) => window.Shell.toast(e.message, 'err'));
      window.Shell.toast('已添加：' + d);
      await this.reload();
      await this.scan();
    },

    async scan() {
      if (this._scanning) return;
      this._scanning = true;
      this.renderSide();
      const bar = document.getElementById('phProg');
      if (bar) bar.hidden = false;
      try {
        const r = await API.raw.photos.scan();
        window.Shell.toast(`扫完了：共 ${r.total} 张，其中 ${r.withGps} 张带坐标`, 'ok');
      } catch (e) {
        window.Shell.toast(e.message || String(e), 'err');
      } finally {
        this._scanning = false;
        if (bar) bar.hidden = true;
        await this.reload();
      }
    },

    /* ============================================================
       右侧：工具行 + 内容（图片墙 / 足迹地图）
       ============================================================ */
    renderMain() {
      /* 重画足迹页前先销毁旧地图：它有 ResizeObserver / rAF，不能只把 DOM 删掉 */
      if (this.mapInst) { try { this.mapInst.destroy(); } catch { /* 已经没了 */ } this.mapInst = null; }
      const main = clear(this.mainEl);

      /* ---- 工具行 ---- */
      const bar = el('div', { class: 'ph-bar' },
        el('div', { class: 'ph-tabs' },
          el('button', {
            class: 'ph-tab' + (this.view === 'wall' ? ' on' : ''),
            onclick: () => { this.view = 'wall'; this.renderMain(); }
          }, uiSpan('grid'), '图片墙'),
          el('button', {
            class: 'ph-tab' + (this.view === 'map' ? ' on' : ''),
            onclick: () => { this.view = 'map'; this.renderMain(); }
          }, uiSpan('pin'), '足迹')),
        el('button', {
          class: 'btn btn-sm' + (this.selecting ? ' btn-primary' : ''),
          title: '批量给多张照片标同一个地点',
          onclick: () => this.toggleSelecting()
        }, uiSpan('pin'), this.selecting ? '退出批量' : '批量标注'),
        this.view === 'wall' ? el('div', { class: 'ph-bar-right' },
          uiSpan('search'),
          el('input', {
            class: 'ph-kw', type: 'text', placeholder: '搜文件名…', value: this.kw,
            oninput: (e) => { this.kw = e.target.value; this.drawWall(document.getElementById('phBody')); }
          })) : null,
        this.view === 'wall' ? el('select', {
          class: 'ph-sel', title: '排序方式',
          onchange: async (e) => {
            await API.raw.photos.setSort(e.target.value).catch(() => {});
            this.st.sort = e.target.value;
            this.applySort();
            this.drawWall(document.getElementById('phBody'));
          }
        }, SORTS.map(([v, t]) => el('option', { value: v, selected: (this.st.sort || 'time-desc') === v, text: t }))) : null);

      /* 扫描进度条：平时藏着，扫的时候才露出来 */
      const prog = el('div', { class: 'ph-prog', id: 'phProg', hidden: true },
        el('div', { class: 'ph-prog-bar' }),
        el('span', { class: 'ph-prog-t', id: 'phProgT', text: '正在扫描…' }));
      main.appendChild(bar);
      main.appendChild(prog);

      /* 批量选择条 */
      const selbar = el('div', { class: 'ph-selbar', id: 'phSelBar', hidden: !this.selecting },
        el('span', { class: 'ph-sel-n' }, el('b', { id: 'phSelCount', text: String(this.selected.size) }), ' 张已选'),
        el('span', { class: 'ph-sel-tip', text: this.selecting ? '点照片选择；批量标同一个地点' : '' }),
        el('button', { class: 'btn btn-sm btn-ghost', onclick: () => this.selectMissing() }, '全选未标'),
        el('button', { class: 'btn btn-sm btn-ghost', onclick: () => this.clearSelection() }, '清空'),
        el('button', { class: 'btn btn-sm btn-primary', onclick: () => this.openBatchPlace() }, '批量标地点'),
        el('button', { class: 'btn btn-sm', onclick: () => this.toggleSelecting(false) }, '退出'));
      main.appendChild(selbar);

      const body = el('div', { class: 'ph-body' + (this.view === 'map' ? ' is-map' : ''), id: 'phBody' });
      main.appendChild(body);

      if (this.view === 'map') this.drawMap(body);
      else this.drawWall(body);
      this.updateSelBar();
    },

    /* ---------------- 批量选择 ---------------- */
    toggleSelecting(force) {
      this.selecting = force === undefined ? !this.selecting : !!force;
      if (!this.selecting) this.selected.clear();
      this.renderMain();
    },
    toggleSelect(item, cardEl) {
      const id = String(item.id);
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
      const on = this.selected.has(id);
      if (cardEl) {
        cardEl.classList.toggle('sel', on);
        const ch = cardEl.querySelector('.ph-check');
        if (ch) { ch.classList.toggle('on', on); ch.textContent = on ? '✓' : ''; }
      }
      this.updateSelBar();
    },
    updateSelBar() {
      const n = document.getElementById('phSelCount');
      if (n) n.textContent = String(this.selected.size);
      const b = document.getElementById('phSelBar');
      if (b) b.hidden = !this.selecting;
    },
    clearSelection() {
      this.selected.clear();
      for (const c of document.querySelectorAll('.ph-card.sel, .ph-miss-i.sel')) {
        c.classList.remove('sel');
        const ch = c.querySelector('.ph-check');
        if (ch) { ch.classList.remove('on'); ch.textContent = ''; }
      }
      this.updateSelBar();
    },
    selectMissing() {
      const PL = window.PhotoLib;
      for (const it of this.items) {
        if (!PL.pointOf(it, this.st.places || {})) this.selected.add(String(it.id));
      }
      for (const c of document.querySelectorAll('.ph-card[data-pid], .ph-miss-i[data-pid]')) {
        const on = this.selected.has(String(c.dataset.pid));
        c.classList.toggle('sel', on);
        const ch = c.querySelector('.ph-check');
        if (ch) { ch.classList.toggle('on', on); ch.textContent = on ? '✓' : ''; }
      }
      this.updateSelBar();
      window.Shell.toast(`已选 ${this.selected.size} 张没有坐标的照片`);
    },

    /* ---------------- 图片墙 ---------------- */
    drawWall(body) {
      const box = clear(body);
      if (!this.items.length) {
        box.appendChild(el('div', { class: 'empty', style: { marginTop: '40px' } },
          el('p', { class: 'text-dim', text: '还没有照片。先在左边添加一个放着照片的文件夹。' }),
          el('button', { class: 'btn btn-primary btn-sm', onclick: () => this.addFolder() }, '添加文件夹')));
        return;
      }
      const kw = String(this.kw || '').trim().toLowerCase();
      const list = kw ? this.shown.filter((x) => String(x.name || '').toLowerCase().includes(kw)) : this.shown;
      if (!list.length) {
        box.appendChild(el('div', { class: 'empty' }, el('p', { class: 'text-dim', text: '没有匹配的文件名' })));
        return;
      }

      /* 按天分组只在时间排序下有意义（按地点排序时分组标签会是乱的） */
      const byDay = (this.st.sort || 'time-desc').startsWith('time');
      if (byDay) {
        for (const g of window.PhotoLib.groupByDay(list)) {
          box.appendChild(el('div', { class: 'ph-day' },
            el('div', { class: 'ph-day-t', text: g.day === '未知日期' ? '未知日期' : g.day }),
            this.grid(g.items)));
        }
      } else {
        box.appendChild(this.grid(list));
      }
      this.ensureThumbs(box);
    },

    grid(list) {
      const g = el('div', { class: 'ph-grid' });
      for (const it of list) {
        const kind = window.PhotoLib.placeKind(it, this.st.places || {});
        const on = this.selected.has(String(it.id));
        g.appendChild(el('div', {
          class: 'ph-card' + (kind ? ' has-pos' : '') + (this.selecting ? ' selecting' : '') + (on ? ' sel' : ''),
          dataset: { pid: String(it.id) },
          title: it.name,
          onclick: (e) => {
            if (this.selecting) this.toggleSelect(it, e.currentTarget);
            else this.openViewer(it);
          }
        },
          el('div', { class: 'ph-thumb' },
            el('img', { dataset: { file: it.path, id: String(it.id) }, alt: it.name, loading: 'lazy' }),
            kind ? el('span', { class: 'ph-badge ' + kind, title: kind === 'exif' ? '照片自带坐标' : '手动标注的坐标' },
              uiSpan('pin')) : null,
            this.selecting ? el('span', { class: 'ph-check' + (on ? ' on' : ''), text: on ? '✓' : '' }) : null),
          el('div', { class: 'ph-meta' },
            el('div', { class: 'ph-name', text: it.name }),
            el('div', { class: 'ph-sub', text: this.subOf(it) })),
          el('button', {
            class: 'ph-edit', title: kind ? '改坐标' : '给这张标个地点',
            onclick: (e) => { e.stopPropagation(); this.editPlace(it); }
          }, uiSpan(kind === 'exif' ? 'info' : 'pin'))));
      }
      return g;
    },

    subOf(it) {
      const t = String(it.takenAt || '');
      const d = t.replace('T', ' ').slice(0, 16);
      const PL = window.PhotoLib;
      const p = PL.pointOf(it, this.st.places || {});
      if (!p) return d + (it.takenFrom === 'file' ? '（文件时间）' : '');
      const name = (this.st.places && this.st.places[it.id] && this.st.places[it.id].name) || '';
      return d + (name ? ' · ' + name : '');
    },

    /* ---- 缩略图：进视口才生成（一屏几百张原图会把内存吃光） ---- */
    ensureThumbs(box) {
      if (!this._io) {
        this._io = new IntersectionObserver((entries) => {
          for (const en of entries) {
            if (!en.isIntersecting) continue;
            this._io.unobserve(en.target);
            this.loadThumb(en.target);
          }
        }, { rootMargin: '320px 0px' });
      }
      for (const img of box.querySelectorAll('img[data-file]')) {
        if (img.dataset.done) continue;
        this._io.observe(img);
      }
    },

    async loadThumb(img) {
      const file = img.dataset.file;
      img.dataset.done = '1';
      const key = String(img.dataset.id || '') + '|' + String(img.dataset.file || '');
      try {
        let url = this._thumbs.get(key);
        if (!url) {
          /* 主进程按需生成并落盘缓存，这里只拿路径 → 走 toFileUrl 编码（文件名带 # 也不怕） */
          url = toFileUrl(await API.raw.photos.thumb(file));
          this._thumbs.set(key, url);
        }
        img.src = url;
        img.classList.add('on');
      } catch {
        img.classList.add('bad');
      }
    },

    /* ---------------- 足迹地图 ---------------- */
    drawMap(body) {
      const box = clear(body);
      const m = this.st.map || {};
      const PL = window.PhotoLib;

      /* ⚠️ 切视野只重画地图、不重画整页（重画整页会把「没坐标那一排」的缩略图
         重新清空再加载，闪一下）。所以高亮必须**自己搬**——否则点完世界地图，
         按钮还停在中国地图上，看着像没生效。 */
      const setSw = (v) => {
        this.mapView = v;
        for (const b of box.querySelectorAll('.ph-sw-b')) b.classList.toggle('on', b.dataset.v === v);
        this.syncMap();
      };
      const ctrl = el('div', { class: 'ph-map-bar' },
        el('div', { class: 'ph-sw' },
          el('button', {
            class: 'ph-sw-b' + (this.mapView === 'china' ? ' on' : ''), dataset: { v: 'china' },
            onclick: () => setSw('china')
          }, '中国地图'),
          el('button', {
            class: 'ph-sw-b' + (this.mapView === 'world' ? ' on' : ''), dataset: { v: 'world' },
            onclick: () => setSw('world')
          }, '世界地图')),
        el('span', { class: 'ph-map-hint', text: m.tk ? '' : '没填天地图密钥 → 现在用的是离线示意底图' }),
        el('button', {
          class: 'btn btn-sm btn-ghost',
          onclick: () => { if (window.Shell) window.Shell.openModuleSettings('photos'); }
        }, '底图 / 风格设置'));

      const host = el('div', { class: 'ph-map', id: 'phMapHost' });
      box.appendChild(ctrl);
      box.appendChild(host);

      if (!window.PhotoMap) {
        box.appendChild(el('div', { class: 'empty' }, el('p', { class: 'text-dim', text: '地图组件没加载上' })));
        return;
      }

      const me = this;
      this.mapInst = window.PhotoMap.create(host, {
        getConfig: () => me.st.map || {},
        getStyle: () => (me.st.map && me.st.map.style) || 'auto',
        getItems: () => me.points(),
        onPick: (items, ll) => {
          if (me.picking) { const f = me.picking; me.picking = null; f(ll); return; }
          if (items && items.length) me.openCluster(items);
        }
      });
      this.mapInst.setView(this.mapView, true);

      /* 下面一排：没坐标的照片（「标一下就能上地图」的入口） */
      const noPos = this.items.filter((x) => !PL.pointOf(x, this.st.places || {}));
      if (noPos.length) {
        const miss = el('div', { class: 'ph-miss' },
          el('div', { class: 'ph-miss-t' }, el('span', { text: `${noPos.length} 张照片没有地点信息` }),
            el('span', { class: 'text-dim', text: '标一个坐标，它就会出现在地图上' })));
        const row = el('div', { class: 'ph-miss-row' });
        for (const it of noPos.slice(0, 24)) {
          const on = me.selected.has(String(it.id));
          row.appendChild(el('button', {
            class: 'ph-miss-i' + (me.selecting ? ' selecting' : '') + (on ? ' sel' : ''),
            title: it.name, dataset: { pid: String(it.id) },
            onclick: (e) => me.selecting ? me.toggleSelect(it, e.currentTarget) : me.editPlace(it)
          },
            el('img', { dataset: { file: it.path, id: String(it.id) }, alt: it.name }),
            el('span', { class: 'ph-miss-n', text: it.name }),
            me.selecting ? el('span', { class: 'ph-check' + (on ? ' on' : ''), text: on ? '✓' : '' }) : null));
        }
        miss.appendChild(row);
        box.appendChild(miss);
        this.ensureThumbs(row);
      }
    },

    /** 地图上的点：EXIF 优先，没有就用手动标的 */
    points() {
      const PL = window.PhotoLib;
      const out = [];
      for (const it of this.items) {
        const p = PL.pointOf(it, this.st.places || {});
        if (!p) continue;
        out.push({ id: it.id, lat: p.lat, lng: p.lng, name: it.name, path: it.path, item: it });
      }
      return out;
    },

    syncMap() {
      if (!this.mapInst) return;
      this.mapInst.refresh();
      this.mapInst.setView(this.mapView, false);
    },

    /** 点开一个聚合气泡 */
    openCluster(items) {
      const one = items.length === 1 ? items[0].item : null;
      if (one) { this.openViewer(one); return; }
      const layer = this.layer();
      const box = el('div', { class: 'pv-box pv-cluster' },
        el('div', { class: 'pv-head' },
          el('span', { class: 'pv-title', text: `${items.length} 张照片` }),
          el('button', { class: 'pv-x', onclick: () => this.closeViewer() }, uiSpan('close'))));
      const grid = el('div', { class: 'pv-grid' });
      for (const p of items) {
        const it = p.item || p;
        grid.appendChild(el('button', {
          class: 'pv-gi', title: it.name, onclick: () => this.openViewer(it)
        }, el('img', { dataset: { file: it.path, id: String(it.id) }, alt: it.name }),
          el('span', { class: 'pv-gn', text: it.name })));
      }
      box.appendChild(grid);
      layer.appendChild(box);
      layer.onclick = (e) => { if (e.target === layer) this.closeViewer(); };
      this.ensureThumbs(grid);
    },

    /* ---------------- 大图查看器 ---------------- */
    openViewer(item) {
      const layer = this.layer();
      const idx = this.shown.findIndex((x) => String(x.id) === String(item.id));
      const img = el('img', { src: toFileUrl(item.path), alt: item.name });
      img.draggable = false;
      const imgWrap = el('div', { class: 'pv-img', title: '滚轮缩放 · 拖动查看细节 · 双击复位' }, img);
      const zoomEl = el('span', { class: 'pv-zoom', text: '100%', title: '双击图片或点这里复位' });
      const state = { scale: 1, tx: 0, ty: 0 };
      let dragging = false, drag = null;

      const clampPan = () => {
        const mx = imgWrap.clientWidth * (state.scale - 1) / 2;
        const my = imgWrap.clientHeight * (state.scale - 1) / 2;
        state.tx = Math.max(-mx, Math.min(mx, state.tx));
        state.ty = Math.max(-my, Math.min(my, state.ty));
      };
      const apply = () => {
        img.style.transform = state.scale === 1 ? 'none'
          : `translate3d(${state.tx.toFixed(1)}px, ${state.ty.toFixed(1)}px, 0) scale(${state.scale.toFixed(4)})`;
        zoomEl.textContent = Math.round(state.scale * 100) + '%';
        imgWrap.classList.toggle('zoomed', state.scale > 1);
        imgWrap.style.cursor = state.scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in';
      };
      const resetZoom = () => {
        state.scale = 1; state.tx = 0; state.ty = 0;
        apply();
      };

      /* 滚轮以鼠标位置为中心缩放，最大 8 倍 */
      imgWrap.addEventListener('wheel', (e) => {
        e.preventDefault();
        const old = state.scale;
        const next = Math.max(1, Math.min(8, old * Math.exp(-e.deltaY * 0.0016)));
        if (next === old) return;
        const rect = imgWrap.getBoundingClientRect();
        const mx = e.clientX - rect.left - rect.width / 2;
        const my = e.clientY - rect.top - rect.height / 2;
        state.tx = mx - (mx - state.tx) * (next / old);
        state.ty = my - (my - state.ty) * (next / old);
        state.scale = next;
        if (next === 1) { state.tx = 0; state.ty = 0; }
        clampPan(); apply();
      }, { passive: false });

      /* 放大后按住拖动看边角 */
      imgWrap.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || state.scale <= 1) return;
        e.preventDefault();
        dragging = true;
        drag = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty };
        try { imgWrap.setPointerCapture(e.pointerId); } catch { /* 不支持就算了 */ }
        apply();
      });
      imgWrap.addEventListener('pointermove', (e) => {
        if (!drag) return;
        state.tx = drag.tx + (e.clientX - drag.x);
        state.ty = drag.ty + (e.clientY - drag.y);
        clampPan(); apply();
      });
      const endDrag = (e) => {
        if (!drag) return;
        drag = null; dragging = false;
        try { imgWrap.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
        apply();
      };
      imgWrap.addEventListener('pointerup', endDrag);
      imgWrap.addEventListener('pointercancel', endDrag);

      imgWrap.addEventListener('dblclick', (e) => { e.preventDefault(); resetZoom(); });
      zoomEl.onclick = resetZoom;

      const box = el('div', { class: 'pv-box pv-viewer' },
        el('div', { class: 'pv-head' },
          el('span', { class: 'pv-title', text: item.name }),
          el('div', { class: 'pv-head-r' },
            el('button', { class: 'btn btn-sm btn-ghost', onclick: () => this.editPlace(item) }, uiSpan('pin'), '标地点'),
            el('button', { class: 'btn btn-sm btn-ghost', onclick: () => API.raw.photos.reveal(item.path).catch(() => {}) }, uiSpan('folder'), '在文件夹里显示'),
            el('button', { class: 'pv-x', onclick: () => this.closeViewer() }, uiSpan('close')))),
        imgWrap,
        el('div', { class: 'pv-foot' },
          el('button', { class: 'btn btn-sm', onclick: () => this.step(-1) }, uiSpan('prev')),
          el('span', { class: 'pv-idx', text: (idx >= 0 ? idx + 1 : '—') + ' / ' + this.shown.length }),
          zoomEl,
          el('button', { class: 'btn btn-sm', onclick: () => this.step(1) }, uiSpan('next'))),
        el('div', { class: 'pv-info', text: this.infoOf(item) + ' · 滚轮缩放 / 拖动查看' }));
      layer.appendChild(box);
      layer.onclick = (e) => { if (e.target === layer) this.closeViewer(); };
      this._cur = idx;
      resetZoom();
    },

    infoOf(item) {
      const bits = [];
      bits.push('拍摄时间：' + String(item.takenAt || '未知').replace('T', ' '));
      if (item.takenFrom === 'file') bits.push('（照片里没写时间，用的是文件时间）');
      const PL = window.PhotoLib;
      const p = PL.pointOf(item, this.st.places || {});
      const kind = PL.placeKind(item, this.st.places || {});
      if (p) {
        bits.push(' · 坐标：' + PL.fmtLatLng(p.lat, p.lng) + (kind === 'manual' ? '（手动标注）' : '（照片自带）'));
        const nm = this.st.places && this.st.places[item.id] && this.st.places[item.id].name;
        if (nm) bits.push(' · ' + nm);
      } else bits.push(' · 没有地点信息');
      if (item.model) bits.push(' · ' + item.model);
      return bits.join('');
    },

    step(d) {
      if (!this.shown.length) return;
      const i = ((this._cur || 0) + d + this.shown.length) % this.shown.length;
      this._cur = i;
      const layer = this.layer();
      clear(layer);
      this.openViewer(this.shown[i]);
    },

    layer() {
      let l = document.getElementById('pvLayer');
      if (!l) {
        l = el('div', { class: 'pv-layer', id: 'pvLayer' });
        document.body.appendChild(l);
      }
      clear(l);
      l.hidden = false;
      /* Esc 关掉 —— 大图盖住整屏时，右上角那个叉太远了 */
      if (!this._keyBound) {
        this._keyBound = true;
        document.addEventListener('keydown', (e) => {
          const layer = document.getElementById('pvLayer');
          if (!layer || layer.hidden) return;
          if (e.key === 'Escape') this.closeViewer();
          else if (e.key === 'ArrowLeft') this.step(-1);
          else if (e.key === 'ArrowRight') this.step(1);
        });
      }
      return l;
    },

    closeViewer() {
      const l = document.getElementById('pvLayer');
      if (l) { l.hidden = true; clear(l); }
      const f = document.getElementById('phPlaceForm');
      if (f) { f.hidden = true; }
    },

    /* ---------------- 地点搜索 / 批量标地点 ---------------- */
    geoPicker(onPick) {
      const q = el('input', { class: 'ph-inp', type: 'text', placeholder: '输入地名，支持模糊，如 庐山 / 京都' });
      const label = el('span', { text: '搜索' });
      const btn = el('button', { class: 'btn btn-sm', type: 'button' }, uiSpan('search'), label);
      const out = el('div', { class: 'ph-geo-res' });
      const run = async () => {
        const text = String(q.value || '').trim();
        if (!text) { q.focus(); return; }
        btn.disabled = true; label.textContent = '搜索中…'; out.innerHTML = '';
        try {
          const list = await API.raw.photos.geocode(text);
          if (!Array.isArray(list) || !list.length) {
            out.appendChild(el('p', { class: 'ph-geo-empty', text: '没找到，换个写法试试（如「杭州市」「Kyoto」）' }));
            return;
          }
          for (const r of list.slice(0, 8)) {
            out.appendChild(el('button', {
              class: 'ph-geo-i', type: 'button', title: r.address || r.name,
              onclick: (e) => {
                for (const b of out.querySelectorAll('.on')) b.classList.remove('on');
                e.currentTarget.classList.add('on');
                onPick(r);
              }
            },
              el('b', { text: r.name || r.address }),
              el('span', { text: [r.address, r.source].filter(Boolean).join(' · ') })));
          }
        } catch (e) {
          out.appendChild(el('p', { class: 'ph-geo-empty', text: (e && e.message) || '搜索失败，检查一下网络' }));
        } finally {
          btn.disabled = false; label.textContent = '搜索';
        }
      };
      btn.onclick = run;
      q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
      return {
        wrap: el('div', { class: 'ph-geo' }, el('div', { class: 'ph-row' },
          el('span', { class: 'label', text: '搜地点' }), q, btn), out),
        q
      };
    },

    openBatchPlace(prefill) {
      if (!this.selected.size) { window.Shell.toast('先点选要标地点的照片'); return; }
      const ids = [...this.selected];
      const items = this.items.filter((x) => this.selected.has(String(x.id)));
      const p = prefill || {};
      const lat = el('input', { class: 'ph-inp', type: 'text', inputmode: 'decimal', placeholder: '纬度，如 39.9042', value: p.lat !== undefined ? Number(p.lat).toFixed(5) : '' });
      const lng = el('input', { class: 'ph-inp', type: 'text', inputmode: 'decimal', placeholder: '经度，如 116.4074', value: p.lng !== undefined ? Number(p.lng).toFixed(5) : '' });
      const nm = el('input', { class: 'ph-inp', type: 'text', placeholder: '地点名（可留空）', value: p.name || '' });
      const err = el('p', { class: 'ph-err', hidden: true });
      const layer = this.layer();
      const geo = this.geoPicker((r) => {
        lat.value = Number(r.lat).toFixed(5);
        lng.value = Number(r.lng).toFixed(5);
        if (!nm.value) nm.value = r.name || '';
        err.hidden = true;
      });

      const prev = el('div', { class: 'pv-batch-prev' });
      for (const it of items.slice(0, 8)) {
        prev.appendChild(el('div', { class: 'pv-batch-th', title: it.name },
          el('img', { dataset: { file: it.path, id: String(it.id) }, alt: it.name }),
          el('span', { text: it.name })));
      }

      const box = el('div', { class: 'pv-box pv-place pv-batch' },
        el('div', { class: 'pv-head' },
          el('span', { class: 'pv-title', text: `给 ${items.length} 张照片标地点` }),
          el('button', { class: 'pv-x', onclick: () => this.closeViewer() }, uiSpan('close'))),
        el('div', { class: 'pv-place-body pv-batch-body' },
          el('div', { class: 'pv-batch-side' }, prev,
            el('p', { class: 'hint', text: `已选 ${items.length} 张。带 GPS 的照片仍以照片自带坐标为优先。` })),
          el('div', { class: 'pv-place-form' },
            el('p', { class: 'hint', text: '输入地名搜索，或直接填经纬度；保存后所有选中的照片都会标到同一个点。' }),
            geo.wrap,
            el('div', { class: 'ph-row' }, el('span', { class: 'label', text: '地点名' }), nm),
            el('div', { class: 'ph-row' }, el('span', { class: 'label', text: '纬度' }), lat),
            el('div', { class: 'ph-row' }, el('span', { class: 'label', text: '经度' }), lng),
            el('div', { class: 'ph-row' },
              el('button', {
                class: 'btn btn-sm',
                onclick: () => {
                  const keep = [...this.selected];
                  this.closeViewer();
                  this.view = 'map';
                  this.renderMain();
                  this.picking = (ll) => {
                    this.selected = new Set(keep);
                    this.openBatchPlace({ lat: ll.lat, lng: ll.lng, name: nm.value });
                  };
                  window.Shell.toast('在地图上点一下，就取那个位置的坐标', 'ok');
                }
              }, uiSpan('map'), '在地图上点一下取点')),
            err)));

      box.appendChild(el('div', { class: 'pv-foot', style: { justifyContent: 'flex-end' } },
        el('button', { class: 'btn btn-sm', onclick: () => this.closeViewer() }, '取消'),
        el('button', {
          class: 'btn btn-sm btn-primary', onclick: async () => {
            err.hidden = true;
            try {
              if (!lat.value.trim() && !lng.value.trim() && nm.value.trim()) {
                const list = await API.raw.photos.geocode(nm.value.trim());
                if (!list || !list[0]) throw new Error('没找到「' + nm.value.trim() + '」，请先搜索并选一个结果');
                lat.value = Number(list[0].lat).toFixed(5);
                lng.value = Number(list[0].lng).toFixed(5);
              }
              const r = await API.raw.photos.setPlaces(ids, { lat: lat.value, lng: lng.value, name: nm.value });
              window.Shell.toast(`已给 ${r.count} 张照片标上地点`, 'ok');
              this.selecting = false;
              this.selected.clear();
              this.closeViewer();
              await this.reload();
            } catch (e) {
              err.textContent = (e && e.message) || '坐标不合法';
              err.hidden = false;
            }
          }
        }, '保存到这些照片')));
      layer.appendChild(box);
      layer.onclick = (e) => { if (e.target === layer) this.closeViewer(); };
      this.ensureThumbs(prev);
    },

    /* ---------------- 自定义坐标 ---------------- */
    editPlace(item) {
      const places = this.st.places || {};
      const cur = places[item.id] || null;
      const hasExif = !!(item && item.gps);
      const layer = this.layer();
      const lat = el('input', { class: 'ph-inp', type: 'text', inputmode: 'decimal', placeholder: '纬度，如 39.9042', value: cur ? String(cur.lat) : '' });
      const lng = el('input', { class: 'ph-inp', type: 'text', inputmode: 'decimal', placeholder: '经度，如 116.4074', value: cur ? String(cur.lng) : '' });
      const nm = el('input', { class: 'ph-inp', type: 'text', placeholder: '地点名（可留空）', value: cur ? String(cur.name || '') : '' });
      const err = el('p', { class: 'ph-err', hidden: true });
      const geo = this.geoPicker((r) => {
        lat.value = Number(r.lat).toFixed(5);
        lng.value = Number(r.lng).toFixed(5);
        if (!nm.value) nm.value = r.name || '';
        err.hidden = true;
      });

      const box = el('div', { class: 'pv-box pv-place' },
        el('div', { class: 'pv-head' },
          el('span', { class: 'pv-title', text: '给这张照片标地点' }),
          el('button', { class: 'pv-x', onclick: () => this.closeViewer() }, uiSpan('close'))),
        el('div', { class: 'pv-place-body' },
          el('div', { class: 'pv-place-img' }, el('img', { src: '', alt: item.name, dataset: { file: item.path, id: String(item.id) } })),
          el('div', { class: 'pv-place-form' },
            el('p', { class: 'ph-name', text: item.name }),
            hasExif
              ? el('p', { class: 'hint', text: '这张照片自带坐标 ' + window.PhotoLib.fmtLatLng(item.gps.lat, item.gps.lng) + '，地图上按自带的显示。这里填的是「你自己记的地点」，一般不用填。' })
              : el('p', { class: 'hint', text: '照片里没有 GPS 信息。可以搜地名自动填坐标，也可以手填或在地图上点一下。' }),
            geo.wrap,
            el('div', { class: 'ph-row' }, el('span', { class: 'label', text: '地点名' }), nm),
            el('div', { class: 'ph-row' }, el('span', { class: 'label', text: '纬度' }), lat),
            el('div', { class: 'ph-row' }, el('span', { class: 'label', text: '经度' }), lng),
            el('div', { class: 'ph-row' },
              el('button', { class: 'btn btn-sm', onclick: () => this.pickOnMap(item, lat, lng, nm) }, uiSpan('map'), '在地图上点一下取点'),
              cur ? el('button', {
                class: 'btn btn-sm btn-ghost', onclick: async () => {
                  await API.raw.photos.clearPlace(item.id);
                  window.Shell.toast('已清掉这个坐标');
                  this.closeViewer();
                  await this.reload();
                }
              }, '清除') : null),
            err)));

      box.appendChild(el('div', { class: 'pv-foot', style: { justifyContent: 'flex-end' } },
        el('button', { class: 'btn btn-sm', onclick: () => this.closeViewer() }, '取消'),
        el('button', {
          class: 'btn btn-sm btn-primary', onclick: async () => {
            err.hidden = true;
            try {
              if (!lat.value.trim() && !lng.value.trim() && nm.value.trim()) {
                const list = await API.raw.photos.geocode(nm.value.trim());
                if (!list || !list[0]) throw new Error('没找到「' + nm.value.trim() + '」，请先搜索并选一个结果');
                lat.value = Number(list[0].lat).toFixed(5);
                lng.value = Number(list[0].lng).toFixed(5);
              }
              await API.raw.photos.setPlace(item.id, { lat: lat.value, lng: lng.value, name: nm.value });
              window.Shell.toast('已标上地点', 'ok');
              this.closeViewer();
              await this.reload();
            } catch (e) {
              err.textContent = (e && e.message) || '坐标不合法';
              err.hidden = false;
            }
          }
        }, '保存')));
      layer.appendChild(box);
      layer.onclick = (e) => { if (e.target === layer) this.closeViewer(); };
      this.ensureThumbs(box);
    },

    /** 「在地图上点一下取点」：切到足迹视图，下一次点地图把坐标带回来 */
    pickOnMap(item, latEl, lngEl, nmEl) {
      const fill = (ll) => {
        latEl.value = ll.lat.toFixed(5);
        lngEl.value = ll.lng.toFixed(5);
        if (!nmEl.value) nmEl.value = String(item.name || '').slice(0, 20);
        this.closeViewer();
        this.editPlace(item);
      };
      this.closeViewer();
      this.view = 'map';
      this.renderMain();
      this.picking = fill;
      window.Shell.toast('在地图上点一下，就取那个位置的坐标', 'ok');
    }
  };

  window.PhotosView = PhotosView;
})();
