/**
 * ============================================================
 *  拾光集 · 播放顺序 (playmode.js)
 * ------------------------------------------------------------
 *  四种模式（用户定的）：
 *    order   列表播放  —— 按列表顺序往下播，**播到最后一首就停**
 *    loop    列表循环  —— 播到最后一首回到第一首
 *    single  单曲循环  —— 一首播完自己重来
 *    shuffle 随机播放  —— 随机挑一首，且**绝不挑到当前这首**
 *
 *  为什么单独一个文件：这块是**纯函数**，不碰 DOM、不碰音频元素，
 *  所以可以脱离 Electron 在 Node 里直接单测（tools/playmode-test.js）。
 *
 *  🔴 两个入口分开，别合成一个：
 *    · `nextOnEnd`   —— 音频「自然播完」时该播哪首（单曲循环在这里才生效）
 *    · `nextOnClick` —— 用户**手点「下一首」**（单曲循环下也要真的换歌，
 *                       否则用户会觉得按钮坏了）
 *  返回值 `-1` = **停下来**（顺序播放的最后一首播完），调用方负责不要跳。
 * ============================================================
 */
'use strict';
(function () {
const MODES = ['order', 'loop', 'single', 'shuffle'];

const LABELS = {
  order: '列表播放',
  loop: '列表循环',
  single: '单曲循环',
  shuffle: '随机播放'
};

const DESCS = {
  order: '按列表顺序往下播，播到最后一首就停',
  loop: '播到最后一首自动回到第一首',
  single: '一首播完自己重来',
  shuffle: '随机挑一首，不会连着重复当前这首'
};

const ICONS = {
  order: 'order',
  loop: 'repeat',
  single: 'repeatOne',
  shuffle: 'shuffle'
};

/** 认不出来的模式一律当「列表播放」，别让脏设置把播放卡死 */
function normalize(m) {
  return MODES.indexOf(m) >= 0 ? m : 'order';
}

function label(m) { return LABELS[normalize(m)]; }
function icon(m) { return ICONS[normalize(m)]; }
function desc(m) { return DESCS[normalize(m)]; }

/** 下一个模式（按 MODES 顺序循环）—— 界面上「切换模式」用得上 */
function cycle(m) {
  const i = MODES.indexOf(normalize(m));
  return MODES[(i + 1) % MODES.length];
}

/**
 * 随机挑一首 ≠ 当前这首。
 * ⚠️ 用注入的 `rand` 才能测；万一 `rand` 一直返回同一个值（假的 / 极端情况），
 *    最多试 32 次就退化成「下一首」，绝不能死循环。
 */
function pickOther(index, len, rand) {
  if (len <= 1) return 0;
  const r = typeof rand === 'function' ? rand : Math.random;
  for (let k = 0; k < 32; k++) {
    let i = Math.floor(r() * len);
    if (!(i >= 0 && i < len)) i = 0;         // rand 返回 1 / NaN 之类的兜底
    if (i !== index) return i;
  }
  return (index + 1) % len;
}

/**
 * 一首**自然播完**之后该播第几首。
 * @returns {number} 下标；-1 = 停下来
 */
function nextOnEnd(mode, index, len, rand) {
  if (!(len > 0) || index < 0 || index >= len) return -1;
  switch (normalize(mode)) {
    case 'single': return index;                       // 自己重来
    case 'shuffle': return pickOther(index, len, rand);
    case 'loop': return (index + 1) % len;
    default: return index + 1 < len ? index + 1 : -1;   // 顺序：到底就停
  }
}

/**
 * 手点「下一首」。
 * 与 `nextOnEnd` 的唯一区别：`single` 也要真的换歌。
 * @returns {number} 下标；-1 = 不动
 */
function nextOnClick(mode, index, len, rand) {
  if (!(len > 0)) return -1;
  if (index < 0 || index >= len) return 0;             // 还没开始播 → 从第一首起
  const m = normalize(mode);
  if (m === 'shuffle') return pickOther(index, len, rand);
  if (index + 1 < len) return index + 1;
  return m === 'loop' ? 0 : -1;
}

/**
 * 手点「上一首」。
 * · 顺序 / 单曲：到头就停（返回 -1），不强行绕回去
 * · 列表循环：从第一首往回 → 最后一首
 * · 随机：随机挑（没有播放历史，不做「上一首」回溯）
 */
function prevOnClick(mode, index, len, rand) {
  if (!(len > 0)) return -1;
  if (index < 0 || index >= len) return 0;
  const m = normalize(mode);
  if (m === 'shuffle') return pickOther(index, len, rand);
  if (index > 0) return index - 1;
  return m === 'loop' ? len - 1 : -1;
}

const PlayMode = { MODES, LABELS, DESCS, ICONS, normalize, label, icon, desc, cycle, nextOnEnd, nextOnClick, prevOnClick };

window.PlayMode = PlayMode;
})();
