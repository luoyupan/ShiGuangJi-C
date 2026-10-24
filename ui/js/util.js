/**
 * 拾光集 · 前端工具 (util.js)
 */
'use strict';

/** 极简 hyperscript：el('div', {class:'x', onclick:fn}, child, ...) */
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
      else node.setAttribute(k, v);
    }
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) return c.forEach(add);
    node.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return node;
}
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n >= 100 ? 0 : 1) + ' ' + u[i];
}
function formatSpeed(n) { return formatBytes(n) + '/s'; }
function formatDuration(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
/**
 * 游玩时长格式化。
 * 入参单位是「分钟」——Steam 的 localconfig.vdf / Playtime 以及游戏库里
 * 存的 playTime 都是分钟，别按秒传进来。
 */
function formatPlayTime(min) {
  min = Math.floor(Number(min) || 0);
  if (!min) return '未玩过';
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

function debounce(fn, ms = 250) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function throttle(fn, ms = 120) {
  let last = 0; return (...a) => { const now = Date.now(); if (now - last >= ms) { last = now; fn(...a); } };
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 相对时间 */
function timeAgo(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  if (d < 2592000000) return Math.floor(d / 86400000) + ' 天前';
  return new Date(ts).toLocaleDateString('zh-CN');
}

/** 取文件名 */
function baseName(p) { return String(p || '').replace(/\\/g, '/').split('/').pop() || ''; }

/**
 * 本地路径 → 可用的 file:// URL（按段做百分号编码）。
 *
 * ⚠️ 绝对不要写 `'file://' + path.replace(/\\/g,'/')`：文件名里只要出现
 * `#`（URL 片段分隔符）、`?`（查询分隔符）或裸 `%`，浏览器就会把后面的部分
 * 当片段/查询丢掉，或者直接解析失败。
 * 实测：`無人区-Vacuum Track#ADD8E6- - NoKANY.mp3` 就是这么播不出来的 ——
 * 实际请求到的是 `.../無人区-Vacuum Track`，报 MEDIA_ELEMENT_ERROR: Format error。
 * 空格、中文同样需要编码，统一交给 encodeURIComponent 处理。
 */
function toFileUrl(p) {
  /* C 版：本地文件由内嵌 HTTP 服务代理（WebView2 里 file:// 会被拦） */
  if (window.__sgjLocalUrl) return window.__sgjLocalUrl(p);
  let s = String(p == null ? '' : p).replace(/\\/g, '/');
  if (!s) return '';
  if (/^(data|blob|https?):/i.test(s)) return s;                 // 已经是可用的 URL
  if (!/^file:/i.test(s)) {
    if (s.startsWith('//')) s = 'file:' + s;                     // UNC：//server/share/x
    else if (/^[a-zA-Z]:/.test(s)) s = 'file:///' + s;           // Windows 盘符
    else if (s.startsWith('/')) s = 'file://' + s;               // POSIX 绝对路径
    else s = 'file:///' + s;
  }
  const parts = s.split('/');
  // 前几段是协议/空段/主机名（含盘符）—— 原样保留，其余逐段编码
  const keep = /^file:\/\/\/[a-zA-Z]:/i.test(s) ? 4 : 3;
  return parts.map((seg, i) => (i < keep || /^[a-zA-Z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/');
}

window.util = { el, $, $$, clear, escapeHtml, formatBytes, formatSpeed, formatDuration, formatPlayTime, debounce, throttle, sleep, timeAgo, baseName, toFileUrl };
