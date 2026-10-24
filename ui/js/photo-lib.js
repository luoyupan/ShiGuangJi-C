/**
 * ============================================================
 *  拾光集 · 图片模块纯逻辑 (photo-lib.js)
 * ------------------------------------------------------------
 *  这里**不碰 DOM、不碰 fs**，只做「算」。地图、图片墙、单测都用它：
 *    · 排序（时间 / 地点 / 距离）
 *    · 地点归一（自定义坐标的校验）
 *    · 省份推断（拿省级中心点算最近的省，用来给照片写「在哪个省」）
 *    · 屏幕聚合（一堆别针挤在一起时合成一个数字气泡）
 *
 *  第五十七轮新增。
 * ============================================================ */
(function () {
  'use strict';

  const EARTH_R = 6371;   // km

  /** 两点球面距离（km）——排序用，精度不需要太高 */
  function haversine(a, b) {
    if (!a || !b) return Infinity;
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLng = (b.lng - a.lng) * rad;
    const la1 = a.lat * rad; const la2 = b.lat * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /**
   * 自定义地点的归一。
   * 🔴 宁可返回 null 也不要「差不多」的坐标：写进存档的错坐标，
   *    下次打开就是一张出现在大西洋里的照片，用户只会说「它坏了」。
   */
  function normPlace(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const lat = Number(raw.lat);
    const lng = Number(raw.lng);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    if (lat === 0 && lng === 0) return null;              // 0,0 是「没拿到坐标」，不是几内亚湾
    const name = String(raw.name == null ? '' : raw.name).trim().slice(0, 40);
    return { lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5, name };
  }

  /** 照片有没有坐标：EXIF 的优先，没有就用用户自己标的 */
  function pointOf(item, places) {
    if (!item) return null;
    if (item.gps && isFinite(item.gps.lat) && isFinite(item.gps.lng)) return item.gps;
    const p = places && item.id ? places[item.id] : null;
    if (!p) return null;
    return normPlace(p);
  }

  /** 照片的来源标记：exif / 手动 / 无 */
  function placeKind(item, places) {
    if (item && item.gps) return 'exif';
    const p = places && item.id ? places[item.id] : null;
    return p ? 'manual' : '';
  }

  /**
   * 最近省份。`provinces` = [{name, center:[lng,lat]}]（来自 assets/geo/china.json）。
   * 只在「离最近的中心点 < 6°」时才认，否则返回 ''（境外 / 海上不要瞎猜）。
   */
  function provinceOf(lat, lng, provinces) {
    if (!isFinite(lat) || !isFinite(lng) || !Array.isArray(provinces) || !provinces.length) return '';
    let best = null; let bestD = Infinity;
    for (const p of provinces) {
      const c = p && p.center;
      if (!c || !isFinite(c[0]) || !isFinite(c[1])) continue;
      const d = haversine({ lat, lng }, { lat: c[1], lng: c[0] });
      if (d < bestD) { bestD = d; best = p; }
    }
    /* 6° 大概 660km：省会级中心点之间通常没这么远，境外照片不会被硬塞进某个省 */
    return best && bestD <= 660 ? String(best.name || '') : '';
  }

  /** 排序。返回**新数组**，不动原数组（播放/查看器靠原索引） */
  function sortItems(items, mode, ctx) {
    const arr = Array.isArray(items) ? items.slice() : [];
    const m = String(mode || 'time-desc');
    const c = ctx || {};
    const t = (x) => String((x && x.takenAt) || '') || String((x && x.mtime) || '');

    if (m === 'time-asc') arr.sort((a, b) => (t(a) < t(b) ? -1 : t(a) > t(b) ? 1 : 0));
    else if (m === 'name') arr.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh'));
    else if (m === 'near') {
      const anchor = normPlace(c.anchor) || null;
      arr.sort((a, b) => {
        const da = anchor ? haversine(anchor, pointOf(a, c.places)) : Infinity;
        const db = anchor ? haversine(anchor, pointOf(b, c.places)) : Infinity;
        if (da !== db) return da - db;
        return t(a) < t(b) ? 1 : -1;
      });
    } else if (m === 'place') {
      /* 按「省份 / 坐标」聚合：有地点的在前，同一个地方按时间倒序 */
      const label = (x) => {
        const p = pointOf(x, c.places);
        if (!p) return '\uffff';                          // 没地点的沉到最后
        return provinceOf(p.lat, p.lng, c.provinces) || (p.lat.toFixed(1) + ',' + p.lng.toFixed(1));
      };
      arr.sort((a, b) => {
        const la = label(a); const lb = label(b);
        if (la !== lb) return la < lb ? -1 : 1;
        return t(a) < t(b) ? 1 : -1;
      });
    } else arr.sort((a, b) => (t(a) < t(b) ? 1 : t(a) > t(b) ? -1 : 0));   // time-desc
    return arr;
  }

  /** 按天分组（时间倒序的数组进来，出去是 [{day:'2024-05-01', items:[]}]） */
  function groupByDay(items) {
    const out = [];
    let cur = null;
    for (const it of (Array.isArray(items) ? items : [])) {
      const day = String((it && it.takenAt) || '').slice(0, 10) || '未知日期';
      if (!cur || cur.day !== day) { cur = { day, items: [] }; out.push(cur); }
      cur.items.push(it);
    }
    return out;
  }

  /**
   * 屏幕聚合：把挨得很近的点合成一个气泡。
   * pts 必须是**屏幕坐标**（{x,y,...}），cell 是格子边长（px）。
   * 用格子而不是「两两距离」，避免 O(n²) 和链式聚合把半个国家连成一坨。
   */
  function cluster(pts, cell) {
    const c = Math.max(8, Number(cell) || 46);
    const map = new Map();
    const out = [];
    for (const p of (Array.isArray(pts) ? pts : [])) {
      if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
      const k = Math.floor(p.x / c) + ':' + Math.floor(p.y / c);
      let g = map.get(k);
      if (!g) { g = { x: 0, y: 0, n: 0, items: [] }; map.set(k, g); out.push(g); }
      g.x += p.x; g.y += p.y; g.n++;
      for (const it of (p.items || [p])) g.items.push(it);
    }
    for (const g of out) { g.x /= g.n; g.y /= g.n; }
    return out;
  }

  /** 距离文案 */
  function fmtDist(km) {
    if (!isFinite(km)) return '';
    if (km < 1) return Math.round(km * 1000) + ' m';
    if (km < 1000) return Math.round(km) + ' km';
    return Math.round(km / 100) / 10 + ' 千 km';
  }

  /** 坐标文案：38.9123°N 116.4001°E */
  function fmtLatLng(lat, lng) {
    if (!isFinite(lat) || !isFinite(lng)) return '';
    const f = (v, pos, neg) => Math.abs(v).toFixed(4) + '°' + (v >= 0 ? pos : neg);
    return f(lat, 'N', 'S') + ' ' + f(lng, 'E', 'W');
  }

  const PhotoLib = {
    haversine, normPlace, pointOf, placeKind, provinceOf,
    sortItems, groupByDay, cluster, fmtDist, fmtLatLng
  };
  if (typeof window !== 'undefined') window.PhotoLib = PhotoLib;
  if (typeof module !== 'undefined' && module.exports) module.exports = PhotoLib;
})();
