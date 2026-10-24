/**
 * ============================================================
 *  拾光集 · 本地音乐排序 / 筛选 (music-sort.js)
 * ------------------------------------------------------------
 *  用户原话：「在本地音乐加上一个排序筛选的功能：根据时间，歌手来筛选/排序」
 *
 *  为什么单独一个文件：跟 playmode.js 一样是**纯函数**，不碰 DOM、不碰音频，
 *  所以能脱离 Electron 在 Node 里直接单测（tools/music-sort-test.js）。
 *
 *  🔴 两个坑（都吃过）：
 *    ① **下拉框的 value ≠ 记录里的字段名**。这里 `added:desc` 对应的是
 *       `t.addedAt` —— 直接 `t[key]` 会拿到 undefined、比较恒等于 0、
 *       排序**静默失效**（不报错、顺序还看着挺正常）。映射表就是 FIELDS。
 *    ② **`sortTracks` 永远返回新数组**。调用方拿 `this.tracks.indexOf(t)`
 *       把行还原成曲库原索引去播放，要是把原数组就地排了，播的就成了别的歌。
 * ============================================================
 */
'use strict';
(function () {
/* 下拉框的值 → 记录里的真实字段（🔴 见文件头坑①） */
const FIELDS = {
  added: 'addedAt',
  artist: 'artist',
  title: 'title',
  dur: 'duration'
};

/* 排序项。id 是对外契约（落 settings.localSort），动它要考虑兼容 */
const SPECS = [
  { id: 'added:desc', label: '最近添加', field: FIELDS.added, dir: -1, numeric: true },
  { id: 'added:asc', label: '最早添加', field: FIELDS.added, dir: 1, numeric: true },
  { id: 'artist:asc', label: '歌手 A → Z', field: FIELDS.artist, dir: 1 },
  { id: 'artist:desc', label: '歌手 Z → A', field: FIELDS.artist, dir: -1 },
  { id: 'title:asc', label: '歌名 A → Z', field: FIELDS.title, dir: 1 },
  { id: 'dur:desc', label: '时长 长 → 短', field: FIELDS.dur, dir: -1, numeric: true },
  { id: 'dur:asc', label: '时长 短 → 长', field: FIELDS.dur, dir: 1, numeric: true },
  { id: 'none', label: '默认（导入顺序）', field: null, dir: 0 }
];

const DEFAULT_SPEC = 'added:desc';

/* 歌手筛选：空串 = 全部；UNKNOWN = 「没写歌手」那一档（不能也用空串，
   否则「全部」和「未知歌手」两个选项的 value 撞车） */
const ALL_ARTISTS = '';
const UNKNOWN_ARTIST = '__none__';

const byId = (id) => SPECS.find((s) => s.id === id) || null;

/** 不认识的值一律回默认，别让脏设置把列表排成随机顺序 */
function normalizeSpec(id) {
  return byId(id) ? id : DEFAULT_SPEC;
}
function specLabel(id) {
  const s = byId(normalizeSpec(id));
  return s ? s.label : DEFAULT_SPEC;
}

/** 归一化文本：null / undefined / 数字都当字符串，去首尾空白 */
function toText(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/** 中文按拼音排，数字段按数值（「第2集」排在「第10集」前面） */
function cmpText(a, b) {
  return String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

function artistOf(t) {
  const a = toText(t && t.artist);
  return a || UNKNOWN_ARTIST;
}
function artistName(key) {
  return key === UNKNOWN_ARTIST ? '未知歌手' : key;
}

/**
 * 排序。**返回新数组，原数组一个元素都不动**（🔴 见文件头坑②）。
 * 主键相同 → 歌名升序 → id 兜底（保证结果稳定，两次排序结果一样）。
 */
function sortTracks(list, specId) {
  const spec = byId(normalizeSpec(specId));
  const out = (Array.isArray(list) ? list : []).slice();
  if (!spec || !spec.field) return out;          // 默认：保持导入顺序
  const dir = spec.dir;
  const isArtist = spec.field === FIELDS.artist;
  out.sort((a, b) => {
    const va = a ? a[spec.field] : undefined;
    const vb = b ? b[spec.field] : undefined;
    /* 按歌手排时，**没写歌手的永远沉底**（两个方向都是）：
       否则「歌手 A→Z」里那一堆空歌手会霸占列表最前面，看着像排序坏了。 */
    if (isArtist) {
      const ea = toText(va) === '';
      const eb = toText(vb) === '';
      if (ea !== eb) return ea ? 1 : -1;
    }
    if (spec.numeric) {
      /* ⚠️ 缺字段（老数据没有 addedAt）当 0：算「最老」，
         所以「最近添加」里它们沉到最后，不会冒充新歌插到最前面 */
      const r = (Number(va) || 0) - (Number(vb) || 0);
      if (r) return r * dir;
    } else {
      const r = cmpText(toText(va), toText(vb));
      if (r) return r * dir;
    }
    return cmpText(toText(a && a.title), toText(b && b.title))
      || cmpText(toText(a && a.id), toText(b && b.id));
  });
  return out;
}

/** 歌手筛选列表：[{ key, name, count }]，按名字排；「未知歌手」永远压最后 */
function artistBuckets(list) {
  const m = new Map();
  for (const t of (Array.isArray(list) ? list : [])) {
    const k = artistOf(t);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()]
    .map(([key, count]) => ({ key, name: artistName(key), count }))
    .sort((a, b) => {
      if (a.key === UNKNOWN_ARTIST) return 1;
      if (b.key === UNKNOWN_ARTIST) return -1;
      return cmpText(a.name, b.name);
    });
}

/** 只看某个歌手（`ALL_ARTISTS` / 空 = 不过滤）。同样返回新数组 */
function byArtist(list, key) {
  const src = Array.isArray(list) ? list : [];
  if (!key || key === ALL_ARTISTS) return src.slice();
  return src.filter((t) => artistOf(t) === key);
}

/** 这个歌手筛选条件还有没有效（老设置里存了个已经不存在的歌手 → 自动当「全部」） */
function hasArtist(list, key) {
  if (!key || key === ALL_ARTISTS) return false;
  return (Array.isArray(list) ? list : []).some((t) => artistOf(t) === key);
}

const MusicSort = {
  SPECS, FIELDS, DEFAULT_SPEC,
  ALL_ARTISTS, UNKNOWN_ARTIST,
  normalizeSpec, specLabel,
  sortTracks, artistBuckets, byArtist, hasArtist,
  artistOf, artistName, cmpText
};

window.MusicSort = MusicSort;
})();
