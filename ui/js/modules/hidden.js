/**
 * ============================================================
 *  拾光集 · 隐藏空间 (modules/hidden.js)
 * ------------------------------------------------------------
 *  定位（第二十八轮明确，改之前先读这段）：
 *
 *  🔴 **隐藏空间是游戏模块的附属页，不是独立模块。**
 *     它和游戏库**共用同一套布局、卡片、工具栏、详情页、右键菜单**，
 *     只多两样东西：① 进门要过一次密码；② 列表里只放 `hidden === true` 的游戏。
 *
 *  所以本文件**只负责「多出来的那两样」**：
 *     · 密码门禁：首次启用（名字 + 密码 + 提示）/ 解锁
 *     · 隐藏空间自己的设置：改名 / 改密 / 改提示 / 关闭
 *     · 下载游戏：网盘链接转交网盘模块下载 + 自动解压
 *
 *  ⛔ 别再往这里加一套自己的游戏列表 / 卡片 / 深色主题 ——
 *     那是它以前「像个独立模块」的原因，已经拆掉了。
 *     游戏列表一律由 modules/games.js 的 renderLibrary() 画。
 *
 *  调用关系：games.js `renderHidden()` 先问 `hidden:info`；
 *    · 没启用 / 锁着  → `HiddenSpace.mountGate(box, { onChange })`
 *    · 已解锁         → 直接 `renderLibrary()`，本文件不参与
 *  解锁成功或自动上锁时，本文件通过 `opts.onChange()` 让游戏模块重画一次。
 * ============================================================
 */
'use strict';
(function () {
const { el, clear } = window.util;
const { uiSpan } = window.ICON;

const HiddenSpace = {
  root: null,
  opts: {},
  info: null,
  _offLock: null,
  _setBody: null,     // 设置弹窗的正文容器（保存后就地重画）
  _dlBody: null,      // 下载弹窗的正文容器

  /* ============================================================
     门禁（这一层才是隐藏空间真正「多出来的东西」）
     ============================================================ */
  async mountGate(container, opts = {}) {
    this.root = container;
    this.opts = opts || {};
    container.innerHTML = '';
    /* 自动上锁 / 被别处上锁 → 立刻把门禁挂回来。
       ⚠️ 只注册一次：mountGate 每次进隐藏空间都会跑，不过脑子就会越叠越多。 */
    if (!this._offLock && API.on) {
      this._offLock = API.on('hidden:locked', () => { this.info = null; this.reload(); });
    }
    await this.reload();
    return this;
  },

  /** 拉最新状态：没启用 → 启用表单；启用但锁着 → 解锁表单；已解锁 → 交还给游戏模块 */
  async reload() {
    if (!this.root) return;
    this.info = await API.raw.hidden.info().catch(() => null);
    if (!this.info) { this.renderGate(); return; }
    if (!this.info.enabled) { this.renderSetup(); return; }
    if (!this.info.unlocked) { this.renderGate(); return; }
    // 已经解锁：门禁退场，让游戏模块用游戏库那一套去画列表
    clear(this.root);
    if (this.opts.onChange) this.opts.onChange();
  },

  embedCls(base) { return base + (this.opts.embedded ? ' embed' : ''); },

  /* ---------------- 首次启用 ---------------- */
  renderSetup() {
    const root = clear(this.root);
    root.appendChild(el('div', { class: this.embedCls('gate') },
      el('div', { class: 'gate-card' },
        el('div', { class: 'lock', text: '🔐' }),
        el('h2', { text: '启用隐藏空间' }),
        el('p', { text: '给空间起个名字，再设一个只有你知道的密码。被标记为隐藏的游戏只会出现在这里。' }),
        el('input', { class: 'gate-input', id: 'hsName', placeholder: '空间名字（如：深夜书房）', style: { marginBottom: '10px' } }),
        el('input', { class: 'gate-input', id: 'hsPwd', type: 'password', placeholder: '设置密码（至少 4 位）' }),
        el('input', { class: 'gate-input', id: 'hsHint', placeholder: '提示语（可选）', style: { marginTop: '10px' } }),
        el('div', { class: 'gate-err', id: 'hsErr' }),
        el('button', { class: 'btn btn-primary btn-block', style: { marginTop: '8px' }, onclick: () => this.setup() }, '启用'),
        this.backBtn()
      )
    ));
  },

  async setup() {
    const name = (document.getElementById('hsName') || {}).value || '隐藏空间';
    const pwd = (document.getElementById('hsPwd') || {}).value || '';
    const hint = (document.getElementById('hsHint') || {}).value || '';
    const err = document.getElementById('hsErr');
    if (pwd.length < 4) { if (err) err.textContent = '密码至少 4 位'; return; }
    try {
      await API.raw.hidden.setup({ name, password: pwd, hint });
      window.Shell.toast('隐藏空间已启用', 'ok');
      await this.reload();                 // 启用后是「已解锁」态 → reload 会交回游戏模块
    } catch (e) { if (err) err.textContent = e.message; }
  },

  /* ---------------- 解锁门 ---------------- */
  renderGate() {
    const root = clear(this.root);
    const name = this.info && this.info.name ? this.info.name : '隐藏空间';
    root.appendChild(el('div', { class: this.embedCls('gate') },
      el('div', { class: 'gate-card' },
        el('div', { class: 'lock', text: '🔒' }),
        el('h2', { text: name }),
        el('p', { text: '输入密码解锁（这里存放标记为隐藏的游戏）' }),
        el('input', { class: 'gate-input', id: 'hsPwd', type: 'password', placeholder: '密码',
          onkeydown: (e) => { if (e.key === 'Enter') this.unlock(); } }),
        el('div', { class: 'gate-err', id: 'hsErr', text: (this.info && this.info.hint) ? '提示：' + this.info.hint : '' }),
        el('button', { class: 'btn btn-primary btn-block', style: { marginTop: '8px' }, onclick: () => this.unlock() }, '解锁'),
        this.backBtn()
      )
    ));
    const inp = document.getElementById('hsPwd');
    if (inp) setTimeout(() => inp.focus(), 80);
  },

  backBtn() {
    if (!this.opts.onBack) return null;
    return el('button', { class: 'btn btn-ghost btn-block', style: { marginTop: '8px' }, onclick: () => this.opts.onBack() }, '返回游戏库');
  },

  async unlock() {
    const pwd = (document.getElementById('hsPwd') || {}).value || '';
    const err = document.getElementById('hsErr');
    if (!pwd) return;
    try {
      await API.raw.hidden.unlock(pwd);
      await this.reload();                 // 解锁成功 → 交回游戏模块画游戏库那一套
    } catch (e) {
      if (err) err.textContent = e.message;
      const i = document.getElementById('hsPwd');
      if (i) i.value = '';
    }
  },

  /* ============================================================
     隐藏空间设置（改名 / 改密 / 提示 / 关闭）
     以前是空间内部的一个 tab，现在改从游戏工具栏弹窗打开 ——
     内容和以前一模一样，只是不再占着页面布局。
     ============================================================ */
  async openSettings() {
    const info = await API.raw.hidden.info().catch(() => null);
    if (!info || !info.enabled) return window.Shell.toast('隐藏空间还没启用', 'err');
    this.info = info;
    const body = el('div', { class: 'hs-modal-body' });
    this._setBody = body;
    this.renderSettings(body);
    window.Shell.modal({ title: '隐藏空间设置', body, okText: false, cancelText: '关闭' });
  },

  renderSettings(body) {
    const host = clear(body);
    host.appendChild(el('div', { class: 'hs-panel' },
      el('p', { class: 'hint', text: '空间名字只影响门禁页的标题；密码用 scrypt 加盐哈希存在本机，没有找回通道。' }),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '空间名字' }), el('input', { class: 'inp grow', id: 'hsSetName', value: (this.info && this.info.name) || '' })),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '原密码' }), el('input', { class: 'inp grow', id: 'hsOld', type: 'password', placeholder: '修改设置需验证' })),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '新密码' }), el('input', { class: 'inp grow', id: 'hsNew', type: 'password', placeholder: '留空则不改' })),
      el('div', { class: 'row' }, el('span', { class: 'label', text: '提示语' }), el('input', { class: 'inp grow', id: 'hsSetHint', value: (this.info && this.info.hint) || '' })),
      el('div', { class: 'row' },
        el('button', { class: 'btn btn-primary', onclick: () => this.saveSettings() }, uiSpan('save'), '保存'),
        el('button', { class: 'btn btn-danger', onclick: () => this.disable() }, '关闭隐藏空间')
      )
    ));
  },

  async saveSettings() {
    const name = (document.getElementById('hsSetName') || {}).value || '';
    const oldPwd = (document.getElementById('hsOld') || {}).value || '';
    const newPwd = (document.getElementById('hsNew') || {}).value || '';
    const hint = (document.getElementById('hsSetHint') || {}).value || '';
    try {
      if (newPwd) {
        await API.raw.hidden.changePassword({ oldPwd, newPwd, hint, name });
        window.Shell.toast('密码已修改', 'ok');
      } else {
        if (!oldPwd) { window.Shell.toast('请输入原密码以保存', 'err'); return; }
        await API.raw.hidden.changePassword({ oldPwd, newPwd: oldPwd, hint, name });
        window.Shell.toast('已保存', 'ok');
      }
      this.info = await API.raw.hidden.info().catch(() => this.info);
      if (this._setBody && this._setBody.parentNode) this.renderSettings(this._setBody);
      this.notifyChange();
    } catch (e) { window.Shell.toast(e.message, 'err'); }
  },

  async disable() {
    const pwd = await window.Shell.prompt({ title: '关闭隐藏空间', label: '请输入密码确认', password: true });
    if (!pwd) return;
    try {
      await API.raw.hidden.disable(pwd);
      window.Shell.toast('已关闭隐藏空间（隐藏标记已清除）');
      window.Shell.closeModal();
      this.notifyChange();
    } catch (e) { window.Shell.toast(e.message, 'err'); }
  },

  /** 通知游戏模块重画一次（改完设置 / 上锁 / 解锁之后都要） */
  notifyChange() { if (this.opts.onChange) this.opts.onChange(); },

  /* ============================================================
     下载游戏（网盘链接 → 网盘模块 → 自动解压）
     ============================================================ */
  openDownload() {
    const body = el('div', { class: 'hs-modal-body' });
    this._dlBody = body;
    this.renderDownload(body);
    window.Shell.modal({ title: '下载游戏', body, okText: false, cancelText: '关闭' });
  },

  renderDownload(body) {
    const host = clear(body);
    host.appendChild(el('div', { class: 'hs-panel' },
      el('p', { class: 'hint', text: '粘贴网盘链接，自动转交「网盘」模块下载；压缩包会自动解压（多重压缩会改后缀为 7z 继续解压，直到全部解开）。' }),
      el('textarea', { class: 'inp', id: 'hsDlText', placeholder: '粘贴网盘链接（可整段粘贴）', style: { minHeight: '80px' } }),
      el('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap', marginTop: '10px' } },
        el('div', { class: 'field', style: { width: '150px' } }, el('span', { class: 'label', text: '提取码' }), el('input', { id: 'hsExtract', placeholder: '自动识别' })),
        el('div', { class: 'field', style: { width: '150px' } }, el('span', { class: 'label', text: '解压码' }), el('input', { id: 'hsUnzip', placeholder: '没有可不填' })),
        el('div', { class: 'field', style: { width: '180px' } }, el('span', { class: 'label', text: '游戏名' }), el('input', { id: 'hsGName', placeholder: '可选' }))
      ),
      el('div', { class: 'row', style: { marginTop: '10px' } },
        el('button', { class: 'btn', onclick: () => this.hsRecognize() }, uiSpan('eye'), '识别'),
        el('button', { class: 'btn btn-primary', onclick: () => this.hsDownload() }, uiSpan('download'), '下载并解压')
      ),
      el('div', { id: 'hsDlHint', class: 'text-dim', style: { marginTop: '8px', fontSize: '.86em' } })
    ));

    const dl = el('div', { class: 'hs-panel', style: { marginTop: '14px' } }, el('h3', { text: '进行中的下载' }));
    host.appendChild(dl);
    API.raw.netdisk.list().then((tasks) => {
      const mine = (tasks || []).filter((t) => t.origin === 'hidden' || t.origin === 'games');
      if (!mine.length) { dl.appendChild(el('p', { class: 'text-dim', text: '暂无任务。' })); return; }
      for (const t of mine) {
        dl.appendChild(el('div', { class: 'dl-row' },
          el('div', { class: 'di', style: { background: 'var(--accent)' }, text: String(t.platformName || '网').slice(0, 2) }),
          el('div', { class: 'dmain' },
            el('div', { class: 'dname', text: t.name }),
            el('div', { class: 'dsub', text: t.error || (t.status + ' · ' + Math.round((t.progress || 0) * 100) + '%') }),
            el('div', { class: 'bar' }, el('i', { style: { width: Math.round((t.progress || 0) * 100) + '%' } }))),
          el('div', { class: 'dact' }, el('button', {
            class: 'btn btn-sm btn-danger',
            onclick: () => API.raw.netdisk.remove(t.id).then(() => this.renderDownload(this._dlBody))
          }, uiSpan('trash')))
        ));
      }
    }).catch(() => { dl.appendChild(el('p', { class: 'text-dim', text: '读取队列失败。' })); });
  },

  hsRecognize() {
    const text = (document.getElementById('hsDlText') || {}).value || '';
    const hint = document.getElementById('hsDlHint');
    API.raw.netdisk.recognize(text).then((r) => {
      if (!hint) return;
      if (!r.hits.length) { hint.textContent = '没有识别到链接。'; return; }
      hint.textContent = `识别到：${r.hits.map((h) => h.platformName || '网页').join('、')}` + (r.extractCode ? ` ｜ 提取码 ${r.extractCode}` : '');
      if (r.extractCode) document.getElementById('hsExtract').value = r.extractCode;
      if (r.unzipCode) document.getElementById('hsUnzip').value = r.unzipCode;
    }).catch((e) => { if (hint) hint.textContent = e.message; });
  },

  async hsDownload() {
    const text = (document.getElementById('hsDlText') || {}).value || '';
    if (!text.trim()) return window.Shell.toast('请粘贴链接', 'err');
    const extractCode = (document.getElementById('hsExtract') || {}).value || '';
    const unzipCode = (document.getElementById('hsUnzip') || {}).value || '';
    const name = (document.getElementById('hsGName') || {}).value || '';
    const r = await API.raw.netdisk.recognize(text).catch(() => null);
    if (!r || !r.hits.length) return window.Shell.toast('没有识别到链接', 'err');
    for (const h of r.hits) {
      await API.raw.netdisk.enqueue({
        url: h.url, platform: h.kind === 'netdisk' ? h.platform : 'direct',
        extractCode, unzipCode, name: name || undefined, origin: 'hidden', autoExtract: true
      }).catch((e) => window.Shell.toast(e.message, 'err'));
    }
    await API.raw.hidden.addItem({ kind: '游戏', name: name || '待解压游戏', desc: '来自网盘下载 · ' + new Date().toLocaleString('zh-CN') });
    window.Shell.toast('已开始下载，完成后自动解压', 'ok');
    this.renderDownload(this._dlBody);
  }
};

window.HiddenSpace = HiddenSpace;
window.HiddenView = HiddenSpace;   // 兼容旧引用
})();
