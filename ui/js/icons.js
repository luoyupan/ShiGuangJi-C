/**
 * 拾光集 · 图标库 (icons.js)
 * 全部内联 SVG（无外部资源），分两类：
 *   ICON.ui.*        —— 界面功能图标
 *   ICON.platform(id)—— 游戏平台图标（Steam/Epic/GOG…）
 */
'use strict';

const svg = (inner, vb = '0 0 24 24') => `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

const ICON = {
  ui: {
    game: svg('<path d="M7 6h10a5 5 0 015 5v3a5 5 0 01-5 5c-1.6 0-2.6-.9-3.4-1.8-.5-.6-.9-1.2-1.6-1.2h-4c-.7 0-1.1.6-1.6 1.2C5.6 18.1 4.6 19 3 19"/><path d="M7 6a5 5 0 00-5 5v3"/><circle cx="9" cy="11" r="0.9"/><circle cx="15" cy="11" r="0.9"/><path d="M10 14.5h4"/>'),
    music: svg('<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>'),
    cloud: svg('<path d="M7 18a4 4 0 01-.6-7.95 5.5 5.5 0 0110.6-1.4A4.5 4.5 0 0117 18H7z"/><path d="M12 11v5m0 0l-1.8-1.8M12 16l1.8-1.8" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/>'),
    lock: svg('<rect x="5" y="10" width="14" height="10" rx="2.4"/><path d="M8 10V7.5a4 4 0 018 0V10"/>'),
    unlock: svg('<rect x="5" y="10" width="14" height="10" rx="2.4"/><path d="M8 10V7.5a4 4 0 017.6-1.6"/>'),
    settings: svg('<path d="M12 15.4a3.4 3.4 0 100-6.8 3.4 3.4 0 000 6.8z"/><path d="M19.4 13a7.7 7.7 0 000-2l2-1.5-2-3.4-2.4.9a7.6 7.6 0 00-1.7-1L15 3.4h-4l-.3 2.6a7.6 7.6 0 00-1.7 1l-2.4-.9-2 3.4L6.6 11a7.7 7.7 0 000 2l-2 1.5 2 3.4 2.4-.9c.5.4 1.1.8 1.7 1l.3 2.6h4l.3-2.6c.6-.2 1.2-.6 1.7-1l2.4.9 2-3.4-2-1.5z"/>'),
    user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0116 0"/>'),
    search: svg('<path d="M10 2a8 8 0 105.3 14.3l4.7 4.7 1.4-1.4-4.7-4.7A8 8 0 0010 2zm0 2a6 6 0 110 12 6 6 0 010-12z"/>'),
    play: svg('<path d="M8 5v14l11-7z"/>'),
    pause: svg('<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>'),
    prev: svg('<path d="M6 5h2v14H6zM20 5v14L9 12z"/>'),
    next: svg('<path d="M16 5h2v14h-2zM4 5v14l11-7z"/>'),
    folder: svg('<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>'),
    plus: svg('<path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/>'),
    refresh: svg('<path d="M12 4V1L7 5l5 4V6a6 6 0 11-6 6H4a8 8 0 108-8z"/>'),
    trash: svg('<path d="M7 4h10l-1 2h4v2H4V6h4L7 4zm-1 6h12l-1 12a2 2 0 01-2 2H8a2 2 0 01-2-2L6 10z"/>'),
    download: svg('<path d="M11 3h2v9l3.5-3.5 1.4 1.4L12 16l-5.9-6.1 1.4-1.4L11 12V3zM5 19h14v2H5z"/>'),
    link: svg('<path d="M10 13a4 4 0 015.6 0l3-3a4 4 0 00-5.6-5.6l-2 2 1.4 1.4 2-2a2 2 0 012.8 2.8l-3 3A2 2 0 0111 11l-1 1zM14 11a4 4 0 01-5.6 0l-3 3a4 4 0 005.6 5.6l2-2-1.4-1.4-2 2a2 2 0 01-2.8-2.8l3-3A2 2 0 0113 13l1-1z"/>'),
    star: svg('<path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18.9 6.2 21l1.1-6.5L2.6 9.8l6.5-.9z"/>'),
    check: svg('<path d="M9 16.2l-3.5-3.5-1.4 1.4L9 19 20 8l-1.4-1.4z"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>'),
    edit: svg('<path d="M4 20h4l10-10-4-4L4 16v4zm12.7-12.7l1.6-1.6a1 1 0 000-1.4l-1.2-1.2a1 1 0 00-1.4 0l-1.6 1.6 2.6 2.6z"/>'),
    more: svg('<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>'),
    chevron: svg('<path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'),
    back: svg('<path d="M15 6l-6 6 6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'),
    grid: svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
    /* 第五十轮：第三方插件的默认图标（拼图块）。插件清单里 icon 可以填任意内置图标名，
       没填就用这个 —— 一眼能看出「这是装的插件」而不是内置模块。 */
    extension: svg('<path d="M10 3a2 2 0 014 0v1h3a1 1 0 011 1v3h1a2 2 0 010 4h-1v3a1 1 0 01-1 1h-3v1a2 2 0 01-4 0v-1H7a1 1 0 01-1-1v-3H5a2 2 0 010-4h1V5a1 1 0 011-1h3V3z"/>'),
    info: svg('<path d="M12 2a10 10 0 100 20 10 10 0 000-20zm-1 5h2v2h-2V7zm0 4h2v6h-2v-6z"/>'),
    list: svg('<rect x="3" y="4" width="18" height="3" rx="1.5"/><rect x="3" y="10.5" width="18" height="3" rx="1.5"/><rect x="3" y="17" width="18" height="3" rx="1.5"/>'),
    home: svg('<path d="M12 3l9 8h-3v9h-5v-6h-2v6H6v-9H3z"/>'),
    clock: svg('<path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 3a7 7 0 110 14 7 7 0 010-14zm-1 3v5l4 2 .8-1.6-3-1.6V8z"/>'),
    heart: svg('<path d="M12 20s-7-4.4-7-9.3A3.7 3.7 0 0112 7a3.7 3.7 0 017 .7C19 11.6 12 20 12 20z"/>'),
    musicNote: svg('<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>'),

    /* ---- 播放顺序（四种模式各一个图标，见 js/playmode.js） ---- */
    /** 列表播放：向右的箭头 + 终止竖条（播到最后一首就停） */
    order: svg('<path d="M2.5 11h11.3l-3.5-3.5 1.4-1.4L17.6 12l-5.9 5.9-1.4-1.4 3.5-3.5H2.5v-2z"/><rect x="19.4" y="5.4" width="2.2" height="13.2" rx="1.1"/>'),
    /** 列表循环：两条首尾相接的箭头 */
    repeat: svg('<path d="M4 10V9a4 4 0 014-4h10.6l-2.7-2.7 1.4-1.4L22 5.5l-4.7 4.6-1.4-1.4L18.6 6H8a2 2 0 00-2 2v2H4z"/><path d="M20 14v1a4 4 0 01-4 4H5.4l2.7 2.7-1.4 1.4L2 18.5l4.7-4.6 1.4 1.4L5.4 18H16a2 2 0 002-2v-2h2z"/>'),
    /** 单曲循环：列表循环 + 中间一个「1」 */
    repeatOne: svg('<path d="M4 10V9a4 4 0 014-4h10.6l-2.7-2.7 1.4-1.4L22 5.5l-4.7 4.6-1.4-1.4L18.6 6H8a2 2 0 00-2 2v2H4z"/><path d="M20 14v1a4 4 0 01-4 4H5.4l2.7 2.7-1.4 1.4L2 18.5l4.7-4.6 1.4 1.4L5.4 18H16a2 2 0 002-2v-2h2z"/><path d="M11.5 12.4v-1.6l1.8-1.2h1.2V16h-1.3v-4.3l-1.7.7z"/>'),
    /** 随机播放：两条交叉的箭头 */
    shuffle: svg('<path d="M16.6 2.6L22 8l-5.4 5.4-1.4-1.4L18.2 9h-1.8c-1.4 0-2.3.6-3.4 2l-.9 1.2-1.4-1.8.9-1.2C13.1 7.2 14.5 6.4 16.4 6.4h1.8l-3-3 1.4-1.4z"/><path d="M16.6 10.6L22 16l-5.4 5.4-1.4-1.4 3-3h-1.8c-1.9 0-3.3-.8-4.4-2.4l-.9-1.2 1.4-1.8.9 1.2c1.1 1.4 2 2 3.4 2h1.8l-3-3 1.4-1.4z"/><path d="M2 5.4h2.6c1.9 0 3.3.8 4.4 2.4l.6.8-1.4 1.8-.6-.8c-1.1-1.4-2-2-3.4-2H2V5.4z"/><path d="M2 15.4h2.6c1.4 0 2.3-.6 3.4-2l.6-.8 1.4 1.8-.6.8c-1.1 1.6-2.5 2.4-4.4 2.4H2v-2.2z"/>'),
    server: svg('<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><circle cx="7" cy="7.5" r="1"/><circle cx="7" cy="16.5" r="1"/>'),
    globe: svg('<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" fill="none" stroke="currentColor" stroke-width="1.6"/>'),
    eye: svg('<path d="M12 5c5 0 9 4 10 7-1 3-5 7-10 7S3 15 2 12c1-3 5-7 10-7zm0 3a4 4 0 100 8 4 4 0 000-8z"/>'),
    key: svg('<path d="M14 7a4 4 0 11-3.5 5.9L4 19.4V21h2.6l1-1H10v-2.4h2.4l1.1-1.1A4 4 0 0114 7zm2.2 3.8a1.3 1.3 0 100-2.6 1.3 1.3 0 000 2.6z"/>'),
    save: svg('<path d="M5 3h11l3 3v15H5V3zm3 0v6h7V5.6L13.4 3H8zm-1 10h10v6H7v-6z"/>'),
    rocket: svg('<path d="M14 3c3 0 5 2 5 5 0 3-4 7-6 9l-2-2c2-2 6-6 6-9 0-2-1-3-3-3zM7 13l4 4-2 2-4-4 2-2zm-2 4l2 2-3 2 1-4z"/>'),
    chart: svg('<path d="M4 20V10h3v10H4zm6.5 0V4h3v16h-3zM17 20v-6h3v6h-3z"/>'),
    image: svg('<path d="M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zm1 12h14l-4.5-6-3 4-2-2.4L5 17zm10-7.5a1.6 1.6 0 100-3.2 1.6 1.6 0 000 3.2z"/>'),
    /* ---- 第五十七轮：图片 / 足迹地图 ---- */
    /** 别针（水滴形，落地尖头朝下） */
    pin: svg('<path d="M12 2a7 7 0 00-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 00-7-7zm0 9.6a2.6 2.6 0 110-5.2 2.6 2.6 0 010 5.2z"/>'),
    /** 地图（折叠地图 + 折线） */
    map: svg('<path d="M9 3L3 5.4v15.6L9 18.6l6 2.4 6-2.4V3l-6 2.4L9 3z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 3v15.6M15 5.4V21" fill="none" stroke="currentColor" stroke-width="1.7"/>'),

    /* ---- 浏览器模块专用 ---- */
    /** 前进（back 的镜像） */
    forward: svg('<path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'),
    /** 停止加载 */
    stop: svg('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
    /** 插件 / 扩展（拼图块） */
    plug: svg('<path d="M10 3a2 2 0 014 0v1h3v3h-1v2h2v2h-2v2h1v3h-3v1a2 2 0 01-4 0v-1H7v-3h1v-2H6v-2h2V9H7V6h3V3z"/>'),
    /** 书签（描边星，跟实心的 star 区分） */
    bookmark: svg('<path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18.9 6.2 21l1.1-6.5L2.6 9.8l6.5-.9z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'),
    /** 新标签页 */
    newTab: svg('<path d="M4 5h16v14H4z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 9h16"/><path d="M8 5v4"/>'),
    /** 隐私 / 清理 */
    shield: svg('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/><path d="M9 12l2.2 2.2L15 10.5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'),
    /** 静音（喇叭 + 斜杠） */
    'volume-off': svg('<path d="M4 9.5h3.2L11.5 6v12l-4.3-3.5H4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>'),
    /** 阅读模式（翻开的书） */
    read: svg('<path d="M12 6.5C10.4 5.3 8.4 4.8 6 4.8c-1 0-1.9.1-2.7.3v12.4c.8-.2 1.7-.3 2.7-.3 2.4 0 4.4.5 6 1.7 1.6-1.2 3.6-1.7 6-1.7 1 0 1.9.1 2.7.3V5.1c-.8-.2-1.7-.3-2.7-.3-2.4 0-4.4.5-6 1.7z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 6.5v12.4" stroke="currentColor" stroke-width="1.7" fill="none"/>'),
    /** 截图（取景框） */
    crop: svg('<path d="M7 3v14h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M3 7h14v14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
    /** 鼠标手势 / 手 */
    wand: svg('<path d="M4.5 19.5L15 9l-1.5-1.5L3 18z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M13 7.5L15.5 5l1 1-2.5 2.5z"/><path d="M17 3l.9 2.1L20 6l-2.1.9L17 9l-.9-2.1L14 6l2.1-.9z"/>'),
    /** 取字 / OCR */
    type: svg('<path d="M4 6h16M8 6v12M16 6v12" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M6 18h12" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>'),
    /** 背景 / 画板 */
    palette: svg('<path d="M12 3.5a8.5 8.5 0 000 17c1.2 0 2-.9 2-2 0-.6-.2-1-.5-1.4-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8h1.5c2.3 0 4.2-1.9 4.2-4.2C19.7 6.2 16.3 3.5 12 3.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="8" cy="10" r="1.2"/><circle cx="12" cy="8" r="1.2"/><circle cx="7.4" cy="14.4" r="1.2"/>'),
    /** 隐身窗口（礼帽 + 墨镜，Chrome 那套意象） */
    incognito: svg('<path d="M7.6 5.2h8.8l1.5 4.1H6.1z"/><path d="M4.6 9.3h14.8a1.3 1.3 0 010 2.6H4.6a1.3 1.3 0 010-2.6z"/><circle cx="8" cy="15.6" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="16" cy="15.6" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M11 15.3h2" fill="none" stroke="currentColor" stroke-width="1.7"/>'),
    /** 闪电（手势 / 快捷动作） */
    bolt: svg('<path d="M13 2L4.5 13.2H11L10 22l8.5-11.2H12z"/>'),
    /** 折叠侧栏（箭头靠左 + 竖线） */
    'collapse-left': svg('<path d="M4 4v16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10 8l-4 4 4 4M14 5h6v14h-6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>')
  },

  /** 平台图标：统一 24x24，自带底色圆角 */
  platform(id) {
    const wrap = (bg, inner) => `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="22" height="22" rx="6" fill="${bg}"/>${inner}</svg>`;
    switch (id) {
      case 'steam':
        return wrap('#1b2838', '<path fill="#c7d5e0" d="M12 5.6a6.4 6.4 0 00-6.36 5.6l3.4 1.4a1.9 1.9 0 011.06-.33l1.5-2.18v-.03a2.54 2.54 0 112.54 2.54h-.06l-2.15 1.53c0 .05 0 .1.01.16a1.9 1.9 0 11-3.79-.24l-2.44-1.01A6.4 6.4 0 1012 5.6zm-2.66 9.64l.79.33a1.43 1.43 0 101.86-.78 1.43 1.43 0 00-1.9-.67l.82.34a1.05 1.05 0 11-.8 1.94l-.77-.32a1.08 1.08 0 000-.84zm5.72-5.92a1.7 1.7 0 100 3.4 1.7 1.7 0 000-3.4zm0 .63a1.06 1.06 0 110 2.12 1.06 1.06 0 010-2.12z"/>');
      case 'epic':
        return wrap('#2a2a2a', '<path fill="#fff" d="M12 4l6 2.2v6.1c0 3.5-2.6 6.2-6 7.7-3.4-1.5-6-4.2-6-7.7V6.2L12 4zm-2.6 4.6v6.2h1.1v-2.2h1.4c1.2 0 2-.8 2-2s-.8-2-2-2H9.4zm1.1 1h1.2c.6 0 1 .4 1 .97s-.4 1-1 1h-1.2v-1.97z"/>');
      case 'gog':
        return wrap('#8b46ff', '<path fill="#fff" d="M12 4a8 8 0 100 16 8 8 0 000-16zm-3.4 4.3h2.4c1 0 1.7.3 2.2.8l-1 .9c-.3-.3-.7-.5-1.2-.5H8.8v3h2.1V11h1.2v3.3H7.5V8.3zm6.2 0h1.5v6h-1.5z"/>');
      case 'ubisoft':
        return wrap('#0070ff', '<path fill="#fff" d="M12 4a8 8 0 100 16 8 8 0 000-16zm0 2.3c1.6 0 3 .6 4.1 1.7l-4.1 4.1-2-2c.5-.6 1.2-1 1.9-1.3l-1-1.8c-1.8.7-3 2.4-3 4.4 0 2.6 2.1 4.7 4.7 4.7 1.3 0 2.4-.5 3.3-1.3l-1.5-1.5c-.5.5-1.1.7-1.8.7-1.4 0-2.6-1.2-2.6-2.6 0-.3.1-.6.2-.9l4.7 4.7c-.7.5-1.5.8-2.3.8a6.4 6.4 0 110-12.8z"/>');
      case 'ea':
        return wrap('#ff4747', '<text x="12" y="16" font-size="9" font-weight="700" fill="#fff" text-anchor="middle" font-family="Arial">EA</text>');
      case 'battlenet':
        return wrap('#00aeff', '<path fill="#fff" d="M12 4c-2 0-3.4 1-3.4 1s1.3.1 2.5.7c-1.2.6-2 1.4-2 1.4s1.2-.4 2.6-.4c.6 0 1.2 1 1.2 2s-1 2-1.8 3.3c-.3.5-.6 1.1-.6 1.7 0 1.4.8 2.3.8 2.3s-.3-1 .2-1.9c.4-.8 1.2-1.6 2-2.5.8-.9 1.5-1.9 1.5-3.3 0-2.4-3-4.3-3-4.3zM8.5 9.4C6.5 10 5 12 5 14c0 3 3.6 5.4 3.6 5.4s-1.6-1.5-1.6-3.4c0-1.4 1-2.6 1.9-3.7.4-.5.8-1 .8-1.6 0-.5-.1-.9-.2-1.3z"/>');
      case 'xbox':
        return wrap('#107c10', '<path fill="#fff" d="M12 4a8 8 0 00-4.4 1.3c1 1.2 2.4 2.8 4.4 5 2-2.2 3.4-3.8 4.4-5A8 8 0 0012 4zM6.5 6.9A8 8 0 005 12c0 1.4.4 2.8 1 3.9 1.3-2 3.3-4.3 4.7-5.7-.5-.6-2.9-3.3-4.2-4.3zm11 0c-1.3 1-3.7 3.7-4.2 4.3 1.4 1.4 3.4 3.7 4.7 5.7.6-1.1 1-2.5 1-3.9 0-2-.6-3.8-1.5-6.1zM12.7 13c-1.6 1.6-3.6 4.2-4.5 5.4.9.4 2.1.6 3.3.6s2.4-.2 3.3-.6c-.9-1.2-2.9-3.8-4.5-5.4z"/>');
      case 'rockstar':
        return wrap('#fca700', '<text x="12" y="16.5" font-size="10" font-weight="800" fill="#1b1b1b" text-anchor="middle" font-family="Arial">R</text>');
      case 'riot':
        return wrap('#d13639', '<path fill="#fff" d="M6 5l2 14 3-1.5-1-8L6 5zm6 .5V13l-1.2-3.5L12 5.5zM14 12l4-6v9.5l-4 1.5z"/>');
      case 'wegame':
        return wrap('#ff6a00', '<text x="12" y="16.5" font-size="10" font-weight="800" fill="#fff" text-anchor="middle" font-family="Arial">W</text>');
      default:
        return wrap('#7a8699', '<path fill="#fff" d="M4 6.5A1.5 1.5 0 015.5 5h4l1.5 1.6h7.5A1.5 1.5 0 0120 8.1v9.4a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 17.5v-11z"/>');
    }
  },

  /** 把 UI 图标转成带 fill 的 span（不依赖 this，解构后仍可用） */
  uiSpan(name, cls = 'ic') {
    const s = document.createElement('span');
    s.className = cls;
    s.innerHTML = ICON.ui[name] || '';
    return s;
  }
};

window.ICON = ICON;
