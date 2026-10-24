/**
 * 拾光集 · 前端错误收集（必须是第一个脚本）
 * 自检 / 探针会读取 window.__errs 来定位问题。
 */
'use strict';
window.__errs = [];
window.addEventListener('error', (e) => {
  try {
    window.__errs.push({
      msg: e.message,
      src: (e.filename || '').split('/').pop() + ':' + (e.lineno || 0) + ':' + (e.colno || 0),
      stack: e.error && e.error.stack ? String(e.error.stack).split('\n').slice(0, 3).join(' | ') : ''
    });
  } catch { /* ignore */ }
});
window.addEventListener('unhandledrejection', (e) => {
  try { window.__errs.push({ msg: 'unhandledrejection: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)) }); }
  catch { /* ignore */ }
});
