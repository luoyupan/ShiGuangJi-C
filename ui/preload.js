/**
 * ============================================================
 *  拾光集 · 预加载脚本 (preload.js)
 * ------------------------------------------------------------
 *  渲染层与主进程之间唯一的通道。所有能力都在这里显式列出，
 *  渲染层只能调用这些方法，接触不到 Node / 文件系统。
 *  · contextIsolation 开 + nodeIntegration 关
 *  · 事件订阅走白名单
 *  · 统一拆包：主进程回 {ok,data|error}，这里把 data 取出、error 抛出
 * ============================================================
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 主进程 → 渲染层的单向事件白名单 */
const EVENTS = [
  'games:changed', 'games:state', 'games:size', 'games:scan-progress', 'games:scan-done', 'games:cover-progress',
  'games:run-state', 'games:notice',
  'games:sync-progress',
  'games:mod-import',
  'music:changed', 'music:login', 'music:scan-progress',
  'music:daily', 'music:daily-progress',
  /* 第五十七轮：图片扫描进度 / 扫完了（⚠️ main.js 的 PUSH_EVENTS 里也必须有） */
  'photos:progress', 'photos:changed',
  'netdisk:task', 'netdisk:removed', 'netdisk:changed', 'netdisk:done', 'netdisk:extracted', 'netdisk:error', 'netdisk:log', 'netdisk:extract-failed', 'netdisk:login',
  'browser:changed', 'browser:download', 'browser:open-tab', 'browser:zoom', 'browser:adblock', 'browser:key', 'browser:state',
  'games:mod-download', 'games:mod-browser-nav',
  'login:done', 'login:fail',
  'hidden:locked',
  'settings:changed', 'appearance:changed',
  'install:progress',
  'link:state', 'link:log', 'link:chat',
  /* 第四十九轮：插件开关变了 / 发现新版本。⚠️ main.js 的 PUSH_EVENTS 里也必须有 */
  'hub:modules-changed', 'update:available',
  'toast'
];

/** 统一拆包 */
async function inv(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (res && typeof res === 'object' && 'ok' in res) {
    if (!res.ok) throw new Error(res.error || '操作失败');
    return res.data;
  }
  return res;
}

contextBridge.exposeInMainWorld('SGJ', {
  /* ---------------- 基础 ---------------- */
  info: () => inv('app:info'),
  modules: () => inv('hub:modules'),

  /* ---------------- 插件与更新（第四十九轮） ---------------- */
  plugins: {
    list: () => inv('plugins:list'),
    set: (id, on) => inv('plugins:set', id, !!on),
    reset: () => inv('plugins:reset')
  },
  update: {
    status: () => inv('update:status'),
    check: () => inv('update:check'),
    setMode: (m) => inv('update:set-mode', m),
    /* 打开下载页：主进程用 shell.openExternal，渲染层不开新窗口 */
    open: (url) => inv('update:open', url)
  },

  win: {
    minimize: () => inv('win:minimize'),
    maximize: () => inv('win:maximize'),
    close: () => inv('win:close'),
    devtools: () => inv('win:devtools')
  },

  settings: {
    get: () => inv('settings:get'),
    set: (patch) => inv('settings:set', patch)
  },

  appearance: {
    urls: () => inv('appearance:urls'),
    setImage: (args) => inv('appearance:setImage', args || {}),
    clearImage: (args) => inv('appearance:clearImage', args || {}),
    fonts: () => inv('appearance:fonts')
  },

  profile: {
    get: () => inv('profile:get'),
    set: (p) => inv('profile:set', p || {})
  },

  dialog: {
    pickFolder: () => inv('dialog:pickFolder'),
    pickFolders: () => inv('dialog:pickFolders'),
    pickExe: () => inv('dialog:pickExe'),
    pickFiles: (args) => inv('dialog:pickFiles', args || {}),
    pickSave: (args) => inv('dialog:pickSave', args || {}),
    message: (opts) => inv('dialog:message', opts || {})
  },

  shell: {
    openPath: (p) => inv('shell:openPath', p),
    openUrl: (u) => inv('shell:openUrl', u)
  },

  games: {
    list: (o) => inv('games:list', o || {}),
    hiddenList: () => inv('games:hiddenList'),
    setHidden: (ids, hidden) => inv('games:setHidden', ids, hidden),
    add: (g) => inv('games:add', g),
    addManual: (g) => inv('games:addManual', g),
    update: (id, p, o) => inv('games:update', id, p, o),
    remove: (ids) => inv('games:remove', ids),
    clear: () => inv('games:clear'),
    launch: (id) => inv('games:launch', id),
    stop: (id) => inv('games:stop', id),
    openFolder: (id) => inv('games:openFolder', id),
    calcSize: (id) => inv('games:calcSize', id),
    categories: () => inv('games:categories'),
    addCategory: (name) => inv('games:addCategory', name),
    renameCategory: (from, to) => inv('games:renameCategory', from, to),
    removeCategory: (name) => inv('games:removeCategory', name),
    // 一个游戏可以挂多个分类
    setCategories: (id, cats) => inv('games:setCategories', id, cats || []),
    // 平台分类：平台上的游戏直接读平台自己的分类
    platformCatsInfo: () => inv('games:platformCatsInfo'),
    syncPlatformCats: (o) => inv('games:syncPlatformCats', o || {}),
    fetchSteamCover: (id) => inv('games:fetchSteamCover', id),
    resolveCover: (id, o) => inv('games:resolveCover', id, o || {}),
    resolveCovers: (ids, o) => inv('games:resolveCovers', ids, o || {}),
    setCover: (id, p) => inv('games:setCover', id, p),
    clearCover: (id) => inv('games:clearCover', id),
    stats: (period) => inv('games:stats', period || 'all'),
    sessions: (limit) => inv('games:sessions', limit || 60),
    patrol: () => inv('games:patrol'),
    cleanupCandidates: () => inv('games:cleanupCandidates'),
    cleanupApply: (ids) => inv('games:cleanupApply', ids),
    uninstallInfo: (id) => inv('games:uninstallInfo', id),
    uninstall: (id, o) => inv('games:uninstall', id, o || {}),
    mods: (id, o) => inv('games:mods', id, o || {}),
    workshop: (id) => inv('games:workshop', id),
    toggleMod: (id, p) => inv('games:toggleMod', id, p),
    setModDir: (id, dir) => inv('games:setModDir', id, dir),
    useSuggestedModDir: (id) => inv('games:useSuggestedModDir', id),
    importMods: (id, sources) => inv('games:importMods', id, sources),
    packMods: (id, out) => inv('games:packMods', id, out || ''),
    modCode: (id) => inv('games:modCode', id),
    compareMods: (id, code) => inv('games:compareMods', id, code),
    openWorkshop: (id, fid) => inv('games:openWorkshop', id, fid || ''),
    openStorePage: (id) => inv('games:openStorePage', id),
    openNexusSearch: (id) => inv('games:openNexusSearch', id),
    nexusTarget: (id, q) => inv('games:nexusTarget', id, q),
    modBrowser: (p) => inv('games:modBrowser', p || {}),
    modDownloadCfg: () => inv('games:modDownloadCfg'),
    modBrowserSystemOpen: (url) => inv('games:modBrowserSystemOpen', url),
    revealMod: (p) => inv('games:revealMod', p),
    deleteMod: (p) => inv('games:deleteMod', p),
    scan: (opts) => inv('games:scan', opts || {}),
    scanFolder: (roots) => inv('games:scanFolder', roots),
    scanCandidates: (opts) => inv('games:scanCandidates', opts || {}),
    importCandidates: (list) => inv('games:importCandidates', list),
    analyzeCandidate: (it) => inv('games:analyzeCandidate', it || {})
  },

  platform: {
    overview: (o) => inv('platform:overview', o || {}),
    openClient: (id) => inv('platform:openClient', id),
    applySteam: (accountId) => inv('platform:applySteam', accountId),
    detail: (o) => inv('platform:detail', o || {}),
    openApp: (appid, platform) => inv('platform:openApp', { appid, platform }),
    // 未安装的卡片点「安装」→ 主进程 shell.openExternal('steam://install/<appid>')
    install: (appid, platform) => inv('platform:install', { appid, platform })
  },

  music: {
    list: () => inv('music:list'),
    scan: () => inv('music:scan'),
    roots: () => inv('music:roots'),
    setRoots: (r) => inv('music:setRoots', r),
    importFiles: (f) => inv('music:importFiles', f),
    removeTrack: (id) => inv('music:removeTrack', id),
    // 听歌统计：logPlay 报「这次听了几秒」，stats 拉一个周期（周/月/年）的聚合结果
    logPlay: (o) => inv('music:logPlay', o || {}),
    stats: (period, offset) => inv('music:stats', period, offset || 0),
    shotStats: (rect) => inv('music:shotStats', rect || {}),
    playlists: () => inv('music:playlists'),
    addPlaylist: (n, o) => inv('music:addPlaylist', n, o || {}),
    updatePlaylist: (id, p) => inv('music:updatePlaylist', id, p),
    addToPlaylist: (id, ids) => inv('music:addToPlaylist', id, ids),
    removePlaylist: (id) => inv('music:removePlaylist', id),
    pickCover: () => inv('music:pickCover'),
    pickPlaylistFile: () => inv('music:pickPlaylistFile'),
    importPlaylist: (n, files, o) => inv('music:importPlaylist', n, files, o || {}),
    importPlaylistFromDirs: (n, dirs, o) => inv('music:importPlaylistFromDirs', n, dirs, o || {}),
    exportPlaylist: (id) => inv('music:exportPlaylist', id),
    lrc: (id) => inv('music:lrc', id),
    lrcFile: (file, meta) => inv('music:lrcFile', file, meta || {}),
    lrcMap: () => inv('music:lrcMap'),
    setLrc: (id, p) => inv('music:setLrc', id, p || {}),
    relinkLrc: () => inv('music:relinkLrc'),
    pickLrc: () => inv('music:pickLrc'),
    onlinePlaylist: (link) => inv('music:onlinePlaylist', link),
    myPlaylists: (platform) => inv('music:myPlaylists', platform),
    importOnlinePlaylist: (link, o) => inv('music:importOnlinePlaylist', link, o || {}),
    resyncOnlinePlaylist: (id) => inv('music:resyncOnlinePlaylist', id),
    sourceConfig: () => inv('music:sourceConfig'),
    setSourceConfig: (p) => inv('music:setSourceConfig', p || {}),
    testSource: (kw) => inv('music:testSource', kw),
    fillMissing: (items, o) => inv('music:fillMissing', items, o || {}),
    pickSourceDir: () => inv('music:pickSourceDir'),
    crawl: (u, o) => inv('music:crawl', u, o || {}),
    crawlConfig: () => inv('music:crawlConfig'),
    setCrawlConfig: (p) => inv('music:setCrawlConfig', p || {}),
    crawlSites: (us, o) => inv('music:crawlSites', us, o || {}),
    testCrawlSites: (us) => inv('music:testCrawlSites', us),
    browseServer: (a) => inv('music:browseServer', a),
    downloadAudio: (items, dir) => inv('music:downloadAudio', items, dir),
    /* 每日音乐推荐（第三十五轮） */
    dailyConfig: () => inv('music:dailyConfig'),
    setDailyConfig: (p) => inv('music:setDailyConfig', p || {}),
    dailyStatus: () => inv('music:dailyStatus'),
    pickDailyDir: () => inv('music:pickDailyDir'),
    dailyPull: () => inv('music:dailyPull'),
    dailyMove: (files) => inv('music:dailyMove', files || []),
    dailyKeep: (files) => inv('music:dailyKeep', files || []),
    dailyClean: (files) => inv('music:dailyClean', files || []),
    platforms: () => inv('music:platforms'),
    logout: (p) => inv('music:logout', p)
  },

  netdisk: {
    platforms: () => inv('netdisk:platforms'),
    list: () => inv('netdisk:list'),
    enqueue: (p) => inv('netdisk:enqueue', p),
    pause: (id) => inv('netdisk:pause', id),
    resume: (id) => inv('netdisk:resume', id),
    remove: (id) => inv('netdisk:remove', id),
    clearDone: () => inv('netdisk:clearDone'),
    recognize: (t) => inv('netdisk:recognize', t),
    logout: (p) => inv('netdisk:logout', p)
  },

  browser: {
    settings: () => inv('browser:settings'),
    setSettings: (p) => inv('browser:setSettings', p || {}),
    engines: () => inv('browser:engines'),
    resolveInput: (t, e) => inv('browser:resolveInput', t, e),
    sites: () => inv('browser:sites'),

    bookmarks: () => inv('browser:bookmarks'),
    addBookmark: (p) => inv('browser:addBookmark', p || {}),
    updateBookmark: (id, p) => inv('browser:updateBookmark', id, p || {}),
    removeBookmark: (ids) => inv('browser:removeBookmark', ids),
    folders: () => inv('browser:folders'),
    addFolder: (n) => inv('browser:addFolder', n),
    removeFolder: (n, k) => inv('browser:removeFolder', n, k),
    findBookmark: (u) => inv('browser:findBookmark', u),

    history: (o) => inv('browser:history', o || {}),
    addHistory: (p) => inv('browser:addHistory', p || {}),
    removeHistory: (ids) => inv('browser:removeHistory', ids),
    clearHistory: () => inv('browser:clearHistory'),
    topSites: (n) => inv('browser:topSites', n),

    plugins: () => inv('browser:plugins'),
    matchPlugins: (u) => inv('browser:matchPlugins', u),
    addPlugin: (p) => inv('browser:addPlugin', p || {}),
    updatePlugin: (id, p) => inv('browser:updatePlugin', id, p || {}),
    removePlugin: (id) => inv('browser:removePlugin', id),
    togglePlugin: (id, on) => inv('browser:togglePlugin', id, on),
    loadExtension: (dir) => inv('browser:loadExtension', dir),
    unloadExtension: (dir) => inv('browser:unloadExtension', dir),
    extensions: () => inv('browser:extensions'),
    clearData: (o) => inv('browser:clearData', o || {}),
    toNetdisk: (p) => inv('browser:toNetdisk', p || {}),
    pickExtDir: () => inv('browser:pickExtDir'),
    pickScript: () => inv('browser:pickScript'),

    /* ---- 第二十一轮 ---- */
    env: () => inv('browser:env'),
    ntpSites: () => inv('browser:ntpSites'),
    pickNtpBg: () => inv('browser:pickNtpBg'),
    clearNtpBg: () => inv('browser:clearNtpBg'),
    adblockInfo: () => inv('browser:adblockInfo'),
    adblockReset: () => inv('browser:adblockReset'),
    nightCss: (mode) => inv('browser:nightCss', mode),
    gestureKit: () => inv('browser:gestureKit'),
    importBookmarks: () => inv('browser:importBookmarks'),
    exportBookmarks: () => inv('browser:exportBookmarks'),
    saveShot: (p) => inv('browser:saveShot', p || {}),
    copyShot: (dataUrl) => inv('browser:copyShot', dataUrl),
    revealShot: (p) => inv('browser:revealShot', p),
    ocrShot: (p) => inv('browser:ocrShot', p || {})
  },

  /** 图片模块（第五十七轮）：读指定文件夹、按时间/地点排、足迹地图、手动标坐标 */
  photos: {
    state: () => inv('photos:state'),
    items: () => inv('photos:items'),
    scan: () => inv('photos:scan'),
    addRoot: (dir) => inv('photos:addRoot', dir),
    removeRoot: (dir) => inv('photos:removeRoot', dir),
    setPlace: (id, place) => inv('photos:setPlace', { id, place }),
    setPlaces: (ids, place) => inv('photos:setPlaces', { ids, place }),
    geocode: (q) => inv('photos:geocode', q),
    clearPlace: (id) => inv('photos:clearPlace', id),
    setSort: (mode) => inv('photos:setSort', mode),
    mapConfig: (patch) => inv('photos:mapConfig', patch || {}),
    thumb: (file) => inv('photos:thumb', file),
    reveal: (file) => inv('photos:reveal', file)
  },

  /** 联机：三种通道 + 邀请码 + 中转服务 + 内网发现 */
  link: {
    config: () => inv('link:config'),
    setConfig: (p) => inv('link:setConfig', p || {}),
    status: () => inv('link:status'),
    invite: (o) => inv('link:invite', o || {}),
    parse: (c) => inv('link:parse', c),
    host: (o) => inv('link:host', o || {}),
    join: (c) => inv('link:join', c),
    stop: () => inv('link:stop'),
    addresses: () => inv('link:addresses'),
    probe: (o) => inv('link:probe', o || {}),
    punch: (o) => inv('link:punch', o || null),
    relayStart: (p) => inv('link:relayStart', p),
    relayStop: () => inv('link:relayStop'),
    relayStatus: () => inv('link:relayStatus'),
    discover: (o) => inv('link:discover', o || {}),
    chat: (t) => inv('link:chat', t),
    chats: () => inv('link:chats'),
    netState: () => inv('link:netState'),
    netGrant: () => inv('link:netGrant'),
    netRevoke: () => inv('link:netRevoke'),
    netScan: () => inv('link:netScan')
  },

  /** 内置登录窗：音乐 / 网盘共用（真的开窗、真的抓 cookie） */
  login: {
    open: (p) => inv('login:open', p || {}),
    check: (o) => inv('login:check', o || {}),
    cancel: () => inv('login:cancel'),
    state: () => inv('login:state')
  },

  hidden: {
    info: () => inv('hidden:info'),
    setup: (p) => inv('hidden:setup', p || {}),
    unlock: (pwd) => inv('hidden:unlock', pwd),
    lock: () => inv('hidden:lock'),
    items: () => inv('hidden:items'),
    addItem: (item) => inv('hidden:addItem', item),
    removeItem: (id) => inv('hidden:removeItem', id),
    changePassword: (p) => inv('hidden:changePassword', p || {}),
    disable: (pwd) => inv('hidden:disable', pwd),
    activity: () => inv('hidden:activity')
  },

  /** 拖放拿真实路径（Electron≥32 必须经 webUtils） */
  pathForFile: (file) => {
    try { return require('electron').webUtils.getPathForFile(file); } catch { return ''; }
  },

  /** 事件订阅，返回取消函数 */
  /* ---------------- 第三方插件（第五十轮） ----------------
     🔴 通用通道：插件靠这一组就能跟自己的主进程代码通信，
        不需要改 preload、也不需要改本体任何代码。 */
  plugin: {
    list: () => inv('plugin:list'),
    rescan: () => inv('plugin:rescan'),
    set: (id, on) => inv('plugin:set', id, !!on),
    /** 调插件 main.js 里声明的方法：call(id, 'greet', ['名字']) */
    call: (id, method, args) => inv('plugin:call', id, method, Array.isArray(args) ? args : []),
    store: {
      get: (id) => inv('plugin:store:get', id),
      set: (id, patch) => inv('plugin:store:set', id, patch || {})
    },
    openDir: () => inv('plugin:openDir')
  },

  /* 第五十八轮：dll 模块清单（渲染层用它注入脚本 / 显示「这是真 dll」） */
  modules: {
    list: () => inv('modules:list')
  },

  on: (channel, handler) => {
    /* 第三方插件的事件名是动态的（plugin:<id>:<事件>），无法预先列进白名单 →
       按前缀放行。前缀必须收窄到 `plugin:`。
       同理给 dll 模块留一条 `mod:` 前缀（第三方 dll 用 `mod:<id>:<事件>`）。
       ⚠️ 两条前缀都必须收窄，写成「谁都能推」会把内部事件一起泄到界面上。 */
    const ch = String(channel || '');
    if (!EVENTS.includes(ch) && !ch.startsWith('plugin:') && !ch.startsWith('mod:')) return () => {};
    const wrapped = (_e, payload) => handler(payload);
    ipcRenderer.on(ch, wrapped);
    return () => ipcRenderer.removeListener(ch, wrapped);
  }
});
