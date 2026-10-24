/**
 * ============================================================
 *  拾光集 · 足迹地图引擎 (js/photos-map.js)
 * ------------------------------------------------------------
 *  为什么自己画、不引 Leaflet / Mapbox：
 *    合规白名单只认**天地图 / 腾讯 / 高德 / 百度**这几家国内服务，
 *    而 Leaflet + OpenStreetMap 那套（以及 Mapbox）都不在名单里。
 *    所以这里只做一件干净的事：**自己按墨卡托投影取官方瓦片**，
 *    需要联网时走天地图（国家地理信息公共服务平台），
 *    拿不到密钥 / 断网时退回内置矢量底图（assets/geo/*.js）。
 *
 *  给第三方留的接口（都在 window.SGJMap 上）：
 *    SGJMap.registerSource({ id, name, kind:'tiles', url, subdomains, attribution })
 *    SGJMap.registerStyle({ id, name, colors:{...} })
 *    SGJMap.sources() / SGJMap.styles() / SGJMap.setSource(id) / SGJMap.setStyle(id)
 *  也就是说「地图来源」和「地图配色」都能被用户 / 插件替换，不用改本文件。
 *
 *  ⚠️ 三层要分清：
 *    ① 投影与世界坐标（0..1 的墨卡托归一化）
 *    ② 底图（瓦片 / 矢量）
 *    ③ 覆盖物（别针、聚合气泡、当前位置）
 * ============================================================ */
(function () {
  'use strict';

  const { el } = window.util;
  const TILE = 256;
  const MAX_LAT = 85.05112878;

  /* ---------------- 投影 ---------------- */
  const mercX = (lng) => (Number(lng) + 180) / 360;
  const mercY = (lat) => {
    const s = Math.sin(Math.max(-MAX_LAT, Math.min(MAX_LAT, Number(lat))) * Math.PI / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  };
  const invX = (x) => x * 360 - 180;
  const invY = (y) => {
    const n = Math.PI * (1 - 2 * y);
    return Math.atan(Math.sinh(n)) * 180 / Math.PI;
  };

  /* ---------------- 内置底图源 ---------------- */
  /* 天地图：国家地理信息公共服务平台（自然资源部），官方审图底图。
     🔴 仓库里**不带任何密钥**；用户要在设置里填自己申请（免费）的 tk。 */
  const TIANDITU = {
    id: 'tianditu', name: '天地图（官方）', kind: 'tianditu',
    attribution: '底图 © 国家地理信息公共服务平台 · 天地图',
    subdomains: ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7'],
    minZoom: 1, maxZoom: 18,
    tileUrl: (sub, layer, z, x, y, tk) =>
      `https://${sub}.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
      `&LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&tk=${encodeURIComponent(tk)}`,
    /* 一层底图 + 一层注记（天地图的 cva 是注记层，叠在 vec 上才有人话地名） */
    layers: ['vec', 'cva']
  };

  /* 注册表：内置 + 用户 / 插件注册的 */
  const SOURCES = new Map([[TIANDITU.id, TIANDITU]]);
  const STYLES = new Map([
    ['auto', { id: 'auto', name: '跟随软件', colors: null }],
    ['light', { id: 'light', name: '浅色', colors: { land: '#eef1f6', sea: '#f7f9fc', border: '#d3d9e4', grate: '#e2e7f0', pin: '#c20c0c', dot: '#8c1c1c' } }],
    ['dark', { id: 'dark', name: '深色', colors: { land: '#252a36', sea: '#171b24', border: '#333a49', grate: '#2a303d', pin: '#ff5a5a', dot: '#ffb4b4' } }]
  ]);

  function normSource(s) {
    if (!s || typeof s !== 'object') return null;
    const id = String(s.id || '').trim();
    if (!/^[a-z0-9][a-z0-9._-]{1,31}$/i.test(id)) return null;
    const kind = ['tianditu', 'tiles', 'none'].indexOf(s.kind) >= 0 ? s.kind : 'tiles';
    if (kind === 'tiles' && !/^https?:\/\//i.test(String(s.url || ''))) return null;
    return {
      id,
      name: String(s.name || id).slice(0, 40),
      kind,
      url: String(s.url || ''),
      subdomains: Array.isArray(s.subdomains) && s.subdomains.length ? s.subdomains.map(String) : [''],
      attribution: String(s.attribution || '').slice(0, 120),
      minZoom: Number.isFinite(s.minZoom) ? s.minZoom : 1,
      maxZoom: Number.isFinite(s.maxZoom) ? s.maxZoom : 18,
      layers: Array.isArray(s.layers) ? s.layers.map(String) : []
    };
  }

  const SGJMap = {
    version: 1,
    tidanditu: TIANDITU,
    registerSource(s) {
      const n = normSource(s);
      if (!n) throw new Error('地图源不合法：需要 id（小写字母数字）和 http(s) 瓦片地址模板');
      SOURCES.set(n.id, n);
      return n;
    },
    registerStyle(s) {
      if (!s || !s.id) throw new Error('样式需要 id');
      const colors = Object.assign({}, (STYLES.get('light') || {}).colors, s.colors || {});
      const n = { id: String(s.id), name: String(s.name || s.id), colors };
      STYLES.set(n.id, n);
      return n;
    },
    unregisterSource(id) { return SOURCES.delete(String(id)); },
    unregisterStyle(id) { return STYLES.delete(String(id)); },
    sources() { return Array.from(SOURCES.values()).map((x) => ({ id: x.id, name: x.name, kind: x.kind })); },
    styles() { return Array.from(STYLES.values()).map((x) => ({ id: x.id, name: x.name })); },
    /** 把一个「瓦片地址模板」当成源：支持 {z} {x} {y} {s} 占位 */
    sourceOf(id) { return SOURCES.get(String(id)) || null; }
  };
  window.SGJMap = SGJMap;

  /* ---------------- 离线矢量数据（按需加载） ---------------- */
  const GEO = { china: null, world: null };
  let geoLoading = null;

  function ensureGeo() {
    if (GEO.china && GEO.world) return Promise.resolve(GEO);
    if (geoLoading) return geoLoading;
    const load = (src, key) => new Promise((resolve) => {
      if (GEO[key]) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => resolve();      // 加载失败就画空底图，不能把整个地图搞挂
      document.head.appendChild(s);
    });
    geoLoading = Promise.all([
      load('assets/geo/china.js', 'china'),
      load('assets/geo/world.js', 'world')
    ]).then(() => {
      GEO.china = window.SGJ_GEO_CHINA || { features: [] };
      GEO.world = window.SGJ_GEO_WORLD || { rings: [] };
      return GEO;
    });
    return geoLoading;
  }

  /* ---------------- 视图预设 ---------------- */
  const VIEWS = {
    /* 中国：走到能看全疆域（含南海诸岛）的视野 */
    china: { bounds: [[73.2, 3.2], [135.5, 53.8]], minZoom: 2.6 },
    /* 世界：留一点余量，别让南极撑爆画布 */
    world: { bounds: [[-178, -58], [178, 80]], minZoom: 0.2 }
  };

  /* ---------------- 地图实例 ---------------- */
  function create(host, opts) {
    const o = opts || {};
    const canvas = el('canvas', { class: 'pm-canvas' });
    const wrap = el('div', { class: 'pm-wrap' }, canvas);
    const tip = el('div', { class: 'pm-tip' });
    const attr = el('div', { class: 'pm-attr' });
    const ctrl = el('div', { class: 'pm-ctrl' },
      el('button', { class: 'pm-btn', title: '放大', onclick: () => zoomBy(0.7) }, '+'),
      el('button', { class: 'pm-btn', title: '缩小', onclick: () => zoomBy(-0.7) }, '−'),
      el('button', { class: 'pm-btn pm-btn-txt', title: '回到当前范围', onclick: () => setView(state.view, true) }, '复位'));
    host.appendChild(wrap);
    host.appendChild(tip);
    host.appendChild(ctrl);
    host.appendChild(attr);

    const ctx = canvas.getContext('2d');
    const state = {
      cx: 0.5, cy: 0.4, zoom: 1.4,       // 世界坐标中心 + 瓦片级缩放（256px/级）
      view: 'china',
      drag: null,
      hover: null,
      points: [],                        // [{id, lat, lng, name, thumb, items}]
      clusters: [],
      anim: null,
      animFallback: 0,
      colors: null,
      source: null,
      tk: ''
    };

    function size() {
      const r = wrap.getBoundingClientRect();
      return { w: Math.max(120, Math.round(r.width)), h: Math.max(120, Math.round(r.height)) };
    }

    function scale() { return TILE * Math.pow(2, state.zoom); }

    /** 世界坐标 → 屏幕坐标 */
    function toScreen(wx, wy) {
      const { w, h } = size();
      const S = scale();
      return { x: (wx - state.cx) * S + w / 2, y: (wy - state.cy) * S + h / 2 };
    }
    function toWorld(px, py) {
      const { w, h } = size();
      const S = scale();
      return { x: state.cx + (px - w / 2) / S, y: state.cy + (py - h / 2) / S };
    }
    /** 屏幕坐标 → 经纬度 */
    function inv(fx, fy, px, py) { const w = toWorld(px, py); return { lat: fy(w.y), lng: fx(w.x) }; }

    /* ---------------- 配色 ---------------- */
    function colors() {
      const forced = (o.getStyle && o.getStyle()) || 'auto';
      if (forced !== 'auto' && STYLES.get(forced) && STYLES.get(forced).colors) return STYLES.get(forced).colors;
      const cs = getComputedStyle(document.documentElement);
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      const get = (k, fb) => (cs.getPropertyValue(k) || '').trim() || fb;
      return {
        land: get('--surface-2', dark ? '#252a36' : '#eef1f6'),
        sea: get('--surface', dark ? '#171b24' : '#f7f9fc'),
        border: get('--border', dark ? '#333a49' : '#d3d9e4'),
        grate: get('--border', dark ? '#2a303d' : '#e2e7f0'),
        pin: get('--accent', '#c20c0c'),
        dot: dark ? '#ffb4b4' : '#8c1c1c'
      };
    }

    /* ---------------- 底图：瓦片 ---------------- */
    const tileCache = new Map();      // key → {img, ok, at}
    const TILE_CAP = 420;

    function pickSource() {
      const cfg = (o.getConfig && o.getConfig()) || {};
      const custom = cfg.layers && cfg.layers.length ? cfg.layers[0] : null;
      const id = custom && custom.id ? custom.id : cfg.source;
      const builtin = SOURCES.get(String(id || '')) || TIANDITU;
      const src = custom ? (normSource(custom) || builtin) : builtin;
      state.source = src;
      state.tk = String(cfg.tk || '');
      return src;
    }

    function tileImg(url, depth) {
      let hit = tileCache.get(url);
      if (hit) return hit;
      if (tileCache.size > TILE_CAP) {
        /* 简单 LRU：删最早的一批（照片地图一屏几十块，够用） */
        const keys = Array.from(tileCache.keys()).slice(0, 80);
        for (const k of keys) tileCache.delete(k);
      }
      const rec = { img: new Image(), ok: false, at: Date.now() };
      rec.img.onload = () => { rec.ok = true; scheduleDraw(); };
      rec.img.onerror = () => { rec.ok = false; };
      rec.img.src = url;
      tileCache.set(url, rec);
      return rec;
    }

    function drawTiles(src) {
      if (!src || src.kind === 'none') return false;
      if (src.kind === 'tianditu' && !state.tk) return false;
      const { w, h } = size();
      const z = Math.max(0, Math.min(18, Math.round(state.zoom)));
      if (z < (src.minZoom || 0) || z > (src.maxZoom || 18)) return false;
      const S = TILE * Math.pow(2, state.zoom);
      const n = Math.pow(2, z);
      const scaleRatio = S / (TILE * n);       // 当前缩放相对该层瓦片的放大倍率

      /* 用世界坐标算覆盖范围，别用像素反推（层缩放不一致时会算错） */
      const tl = toWorld(0, 0);
      const br = toWorld(w, h);
      const minX = Math.floor(tl.x * n); const maxX = Math.floor(br.x * n);
      const minY = Math.floor(tl.y * n); const maxY = Math.floor(br.y * n);
      let any = false;
      const subs = src.subdomains && src.subdomains.length ? src.subdomains : [''];

      for (const layer of (src.layers.length ? src.layers : ['vec'])) {
        for (let tx = minX; tx <= maxX; tx++) {
          for (let ty = minY; ty <= maxY; ty++) {
            if (ty < 0 || ty >= n) continue;
            const wrapX = ((tx % n) + n) % n;
            const sub = subs[Math.abs(tx + ty) % subs.length];
            const url = src.kind === 'tianditu'
              ? src.tileUrl(sub, layer, z, wrapX, ty, state.tk)
              : String(src.url)
                .replace(/\{z\}/g, z).replace(/\{x\}/g, wrapX).replace(/\{y\}/g, ty)
                .replace(/\{s\}/g, sub).replace(/\{layer\}/g, layer);
            const rec = tileImg(url);
            if (!rec.ok) continue;
            const p = toScreen(wrapX / n, ty / n);
            const side = TILE * scaleRatio + 0.6;   // +0.6 消掉瓦片之间的缝
            /* 深色主题下把官方浅色瓦片压暗 —— 这是「风格和软件一致」的关键一步 */
            const dark = document.documentElement.getAttribute('data-theme') === 'dark';
            const forced = (o.getStyle && o.getStyle()) || 'auto';
            const wantDark = forced === 'dark' || (forced === 'auto' && dark);
            if (wantDark) {
              ctx.save();
              ctx.filter = 'invert(0.91) hue-rotate(180deg) saturate(0.62) brightness(0.95)';
              ctx.drawImage(rec.img, p.x, p.y, side, side);
              ctx.restore();
            } else {
              ctx.drawImage(rec.img, p.x, p.y, side, side);
            }
            any = true;
          }
        }
      }
      return any;
    }

    /* ---------------- 底图：离线矢量 ---------------- */
    function ringPath(ring) {
      const p = new Path2D();
      for (let i = 0; i < ring.length; i++) {
        const pt = toScreen(mercX(ring[i][0]), mercY(ring[i][1]));
        if (i === 0) p.moveTo(pt.x, pt.y); else p.lineTo(pt.x, pt.y);
      }
      p.closePath();
      return p;
    }

    function drawVectors() {
      const c = state.colors || colors();
      const { w, h } = size();
      /* 海 / 底 */
      ctx.fillStyle = c.sea;
      ctx.fillRect(0, 0, w, h);

      /* 经纬网：先画细线，陆地压在上面 */
      ctx.strokeStyle = c.grate;
      ctx.lineWidth = 1;
      const stepLng = state.zoom > 4 ? 5 : state.zoom > 2.5 ? 15 : 30;
      for (let lng = -180; lng <= 180; lng += stepLng) {
        const x = toScreen(mercX(lng), 0).x;
        if (x < -2 || x > w + 2) continue;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
      for (let lat = -70; lat <= 80; lat += 20) {
        const y = toScreen(0, mercY(lat)).y;
        if (y < -2 || y > h + 2) continue;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }

      const world = GEO.world;
      const china = GEO.china;
      if (!world && !china) return;

      ctx.fillStyle = c.land;
      ctx.strokeStyle = c.border;
      ctx.lineWidth = 1;

      /* 世界陆地（只有轮廓，不画国界） */
      if (world && world.rings) {
        for (const ring of world.rings) {
          const p = ringPath(ring);
          ctx.fill(p); ctx.stroke(p);
        }
      }
      /* 中国省级边界：权威数据，且比世界陆地细，单独描一遍更清楚 */
      if (china && china.features) {
        for (const f of china.features) {
          for (const ring of (f.p || [])) {
            const p = ringPath(ring);
            ctx.fill(p); ctx.stroke(p);
          }
        }
      }
    }

    /* ---------------- 覆盖物：别针 ---------------- */
    function projectPoints() {
      const list = (o.getItems && o.getItems()) || [];
      const out = [];
      for (const it of list) {
        if (!it || !isFinite(it.lat) || !isFinite(it.lng)) continue;
        const s = toScreen(mercX(it.lng), mercY(it.lat));
        out.push({ x: s.x, y: s.y, items: [it], n: 1 });
      }
      return out;
    }

    function drawPins() {
      const c = state.colors || colors();
      const pts = projectPoints();
      const groups = window.PhotoLib ? window.PhotoLib.cluster(pts, 46) : pts;
      const { w, h } = size();
      state.clusters = groups.filter((g) => g.x > -60 && g.x < w + 60 && g.y > -60 && g.y < h + 60);

      /* 单点画成**真的别针**（水滴形：圆头 + 落在坐标上的尖），不是一圈圆点 ——
         用户要的是「在对应地区显示一个小别针」，圆点看着像数据点，不像地图标记。
         多点聚合还是圆气泡（里面写数字），那样才看得出「这里有一堆」。 */
      const pinPath = (x, y, r) => {
        const p = new Path2D();
        p.arc(x, y - r * 0.62, r, Math.PI * 0.86, Math.PI * 0.14, false);
        p.lineTo(x, y + r * 1.55);          // 尖头正好落在 (x, y)
        p.closePath();
        return p;
      };

      for (const g of state.clusters) {
        const many = g.items.length > 1;
        if (many) {
          const r = Math.min(22, 12 + Math.log2(g.items.length) * 2.2);
          ctx.beginPath(); ctx.arc(g.x, g.y + 1.5, r + 2, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fill();
          ctx.beginPath(); ctx.arc(g.x, g.y, r, 0, Math.PI * 2);
          ctx.fillStyle = c.pin; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.92)'; ctx.stroke();
          ctx.fillStyle = '#fff';
          ctx.font = '600 12px "Segoe UI",system-ui,sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(g.items.length > 99 ? '99+' : String(g.items.length), g.x, g.y + 0.5);
        } else {
          const r = 7.5;
          const shadow = pinPath(g.x, g.y + 1.5, r);
          ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.fill(shadow);
          const body = pinPath(g.x, g.y, r);
          ctx.fillStyle = c.pin; ctx.fill(body);
          ctx.lineWidth = 1.8; ctx.strokeStyle = 'rgba(255,255,255,.94)'; ctx.stroke(body);
          /* 圆头里的白心 */
          ctx.beginPath();
          ctx.arc(g.x, g.y - r * 0.62, 2.6, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,.96)';
          ctx.fill();
        }
      }
    }

    /* ---------------- 绘制主循环 ---------------- */
    let dirty = false;
    let rafId = 0;
    let drawTimer = 0;
    /**
     * 合并重绘。
     * 🔴🔴 必须带一条定时器兜底：requestAnimationFrame 在**窗口被遮住 / 最小化 /
     *    后台**时会被浏览器直接停摆（不是变慢，是不来）。只靠 rAF 的话，
     *    地图会永远停在第一帧 —— 画布连尺寸都还是默认的 300×150，
     *    用户切回桌面看到的就是「一片空白，点哪儿都没反应」。
     */
    function scheduleDraw() {
      if (dirty) return;
      dirty = true;
      rafId = requestAnimationFrame(() => {
        dirty = false; rafId = 0;
        if (drawTimer) { clearTimeout(drawTimer); drawTimer = 0; }
        draw();
      });
      if (drawTimer) clearTimeout(drawTimer);
      drawTimer = setTimeout(() => {
        drawTimer = 0;
        if (!dirty) return;
        dirty = false;
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        draw();
      }, 160);
    }

    function draw() {
      const { w, h } = size();
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
        canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      state.colors = colors();
      const src = state.source || pickSource();
      /* 瓦片优先；没有密钥 / 加载不出来 → 矢量兜底 */
      let ok = false;
      if (src && src.kind !== 'none') {
        ctx.fillStyle = state.colors.sea;
        ctx.fillRect(0, 0, w, h);
        ok = drawTiles(src);
      }
      if (!ok) drawVectors();
      drawPins();
      /* 底图来源署名（合规要求：用官方底图要标出来） */
      attr.textContent = ok
        ? (src.attribution || '')
        : '离线示意底图（仅陆地轮廓，不含界址）· 底图数据：DataV / Natural Earth';
      attr.hidden = !attr.textContent;
      updateTip();
    }

    /* ---------------- 视图 ---------------- */
    function fit(bounds) {
      const { w, h } = size();
      const [a, b] = bounds;
      const x1 = mercX(a[0]); const x2 = mercX(b[0]);
      const y1 = mercY(b[1]); const y2 = mercY(a[1]);
      const dx = Math.max(1e-6, x2 - x1); const dy = Math.max(1e-6, y2 - y1);
      const S = Math.min(w / dx, h / dy) * 0.92;
      state.zoom = Math.log2(S / TILE);
      state.cx = (x1 + x2) / 2;
      state.cy = (y1 + y2) / 2;
    }

    function setView(v, instant) {
      const name = VIEWS[v] ? v : 'china';
      state.view = name;
      const from = { cx: state.cx, cy: state.cy, zoom: state.zoom };
      fit(VIEWS[name].bounds);
      const to = { cx: state.cx, cy: state.cy, zoom: state.zoom };
      /* 先把 state 还原成起点，动画里再插值 —— 不然 fit() 已经把终点写进去了，第一帧就跳过去 */
      state.cx = from.cx; state.cy = from.cy; state.zoom = from.zoom;

      if (instant || prefersReduced()) {
        state.cx = to.cx; state.cy = to.cy; state.zoom = to.zoom;
        if (o.onViewChange) o.onViewChange(name);
        scheduleDraw();
        return;
      }
      state.anim = { from, to, t0: performance.now(), dur: 460 };
      /* 🔴🔴 rAF 在窗口被遮住 / 最小化 / 后台标签时会被浏览器**停摆** ——
         只靠 requestAnimationFrame 驱动，动画会永远停在第一帧：用户切到桌面再回来，
         看到的是「点了世界地图没反应，镜头还停在中国」，而按钮已经高亮成世界了。
         补一条定时器兜底：到点直接把镜头设到终点（画不出来不要紧，rAF 恢复后照样画）。 */
      if (state.animFallback) clearTimeout(state.animFallback);
      state.animFallback = setTimeout(() => {
        state.animFallback = 0;
        const a = state.anim;
        if (!a || a.to !== to) return;          // 已经飞完 / 又被切走了，别插一脚
        state.cx = to.cx; state.cy = to.cy; state.zoom = to.zoom;
        state.anim = null;
        scheduleDraw();
      }, 460 + 200);
      if (o.onViewChange) o.onViewChange(name);
      tick();
    }

    function prefersReduced() {
      try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
    }

    function tick() {
      const a = state.anim;
      if (!a) return;
      const t = Math.min(1, (performance.now() - a.t0) / a.dur);
      const e = 1 - Math.pow(1 - t, 3);       // easeOutCubic
      state.cx = a.from.cx + (a.to.cx - a.from.cx) * e;
      state.cy = a.from.cy + (a.to.cy - a.from.cy) * e;
      state.zoom = a.from.zoom + (a.to.zoom - a.from.zoom) * e;
      draw();
      if (t < 1) requestAnimationFrame(tick);
      else { state.anim = null; if (state.animFallback) { clearTimeout(state.animFallback); state.animFallback = 0; } }
    }

    function zoomAt(px, py, delta) {
      const before = toWorld(px, py);
      state.zoom = Math.max(0.2, Math.min(17.5, state.zoom + delta));
      const after = toWorld(px, py);
      state.cx += before.x - after.x;
      state.cy += before.y - after.y;
      scheduleDraw();
    }

    function zoomBy(delta) {
      const { w, h } = size();
      zoomAt(w / 2, h / 2, delta);
    }

    /* ---------------- 交互 ---------------- */
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      state.anim = null;
      drag = { x: e.clientX, y: e.clientY, cx: state.cx, cy: state.cy, moved: 0 };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* 合成事件不支持就算了 */ }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (drag) {
        const S = scale();
        const dx = e.clientX - drag.x; const dy = e.clientY - drag.y;
        drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
        state.cx = drag.cx - dx / S;
        state.cy = drag.cy - dy / S;
        canvas.classList.add('grabbing');
        scheduleDraw();
        return;
      }
      const hit = hitTest(e.offsetX, e.offsetY);
      state.hover = hit;
      canvas.classList.toggle('pointing', !!hit);
      showTip(hit, e.offsetX, e.offsetY);
    });
    const endDrag = (e) => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      canvas.classList.remove('grabbing');
      try { if (e && e.pointerId != null) canvas.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
      /* 拖过就不算点击：否则「拖地图」会顺手弹出照片 */
      if (moved > 4) return;
      const px = e ? e.offsetX : 0; const py = e ? e.offsetY : 0;
      const hit = hitTest(px, py);
      /* 把点击处的经纬度一起回传：自定义坐标时要「在地图上点一下取点」 */
      if (o.onPick) {
        const ll = hit ? null : inv(invX, invY, px, py);
        o.onPick(hit ? hit.items : null, ll || { lat: 0, lng: 0 });
      }
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', () => { drag = null; canvas.classList.remove('grabbing'); });
    canvas.addEventListener('pointerleave', () => { tip.hidden = true; });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      state.anim = null;
      zoomAt(e.offsetX, e.offsetY, e.deltaY > 0 ? -0.32 : 0.32);
    }, { passive: false });
    canvas.addEventListener('dblclick', (e) => { zoomAt(e.offsetX, e.offsetY, 0.8); });

    function hitTest(px, py) {
      let best = null; let bestD = Infinity;
      for (const g of state.clusters) {
        const r = g.items.length > 1 ? 20 : 14;
        const d = Math.hypot(px - g.x, py - g.y);
        if (d <= r && d < bestD) { bestD = d; best = g; }
      }
      return best;
    }

    function showTip(g, px, py) {
      if (!g) { tip.hidden = true; return; }
      const first = g.items[0] || {};
      tip.textContent = g.items.length > 1
        ? `${g.items.length} 张照片 · 点开看看`
        : `${first.name || ''}`;
      tip.style.left = Math.round(px + 14) + 'px';
      tip.style.top = Math.round(py + 14) + 'px';
      tip.hidden = false;
    }

    function updateTip() {
      if (!state.hover) tip.hidden = true;
    }

    /* ---------------- 尺寸 / 主题变化 ---------------- */
    const ro = new ResizeObserver(() => scheduleDraw());
    try { ro.observe(wrap); } catch { /* 老环境没有 */ }
    let themeTimer = 0;
    const mo = new MutationObserver(() => {
      if (themeTimer) return;
      themeTimer = setTimeout(() => { themeTimer = 0; scheduleDraw(); }, 60);
    });
    try { mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); } catch { /* 同上 */ }

    /* ---------------- 对外 ---------------- */
    const api = {
      el: wrap,
      setView,
      getView: () => state.view,
      setPoints(list) { state.points = Array.isArray(list) ? list : []; scheduleDraw(); },
      refresh() { pickSource(); scheduleDraw(); },
      /** 世界坐标中心与缩放（测试 / 外部联动用） */
      getCamera: () => ({ cx: state.cx, cy: state.cy, zoom: state.zoom }),
      setCamera(c) { if (c) { state.cx = c.cx; state.cy = c.cy; state.zoom = c.zoom; scheduleDraw(); } },
      /** 屏幕坐标 → 经纬度（自定义坐标时用「点地图取点」） */
      pickLatLng(px, py) { const w = toWorld(px, py); return { lat: invY(w.y), lng: invX(w.x) }; },
      clusters: () => state.clusters,
      destroy() {
        state.anim = null;
        if (state.animFallback) { clearTimeout(state.animFallback); state.animFallback = 0; }
        if (drawTimer) { clearTimeout(drawTimer); drawTimer = 0; }
        if (rafId) cancelAnimationFrame(rafId);
        try { ro.disconnect(); } catch { /* 忽略 */ }
        try { mo.disconnect(); } catch { /* 忽略 */ }
        tileCache.clear();
        host.innerHTML = '';
      }
    };

    /* 先按中国视野摆好，等几何数据回来再画（不然第一帧是空白） */
    fit(VIEWS.china.bounds);
    state.view = 'china';
    ensureGeo().then(() => { pickSource(); scheduleDraw(); });

    return api;
  }

  window.PhotoMap = { create, mercX, mercY, invX, invY, VIEWS, TIANDITU };
})();
