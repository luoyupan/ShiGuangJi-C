/**
 * 拾光集 · 网盘模块视图 (modules/netdisk.js)
 */
'use strict';
(function () {
const { el, clear, formatBytes, formatSpeed } = window.util;
const { uiSpan } = window.ICON;

const NetdiskView = {
  root: null,
  platforms: [],
  tasks: [],

  async mount(container) {
    this.root = container;
    container.innerHTML = '';
    const page = el('div', { class: 'page netdisk' });
    page.appendChild(el('div', { class: 'page-head' },
      el('h2', { text: '网盘' }),
      el('span', { class: 'sub', text: '多平台登录 · 链接自动识别 · 下载后自动解压' }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn-sm', onclick: () => this.reload() }, uiSpan('refresh'), '刷新')
    ));
    this.bodyEl = el('div', { class: 'page-body' });
    page.appendChild(this.bodyEl);
    container.appendChild(page);

    API.on('netdisk:task', () => this.reloadTasks());
    API.on('netdisk:removed', () => this.reloadTasks());
    await this.reload();
    return this;
  },

  async reload() {
    this.platforms = await API.raw.netdisk.platforms().catch(() => []);
    await this.reloadTasks();
    this.render();
  },
  async reloadTasks() {
    this.tasks = await API.raw.netdisk.list().catch(() => []);
    if (this.bodyEl && this.bodyEl.querySelector('.dl-row')) {
      const box = this.bodyEl.querySelector('.dl-section');
      if (box) { clear(box); this.renderTasks(box); }
    }
  },

  render() {
    const body = clear(this.bodyEl);

    // 粘贴链接
    body.appendChild(el('div', { class: 'card' },
      el('h3', { text: '粘贴网盘链接下载' }),
      el('p', { class: 'hint', text: '支持百度 / 夸克 / 123 / 阿里云盘 / 迅雷 / 115 / 蓝奏 / 天翼 / 微云 等；会自动识别平台。压缩包下载完成后自动解压。' }),
      el('div', { class: 'paste-box' },
        el('textarea', { class: 'inp', id: 'ndText', placeholder: '在这里粘贴链接（可整段粘贴，会自动提取链接、提取码、解压码）' }),
        el('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } },
          el('div', { class: 'field', style: { width: '180px' } }, el('span', { class: 'label', text: '提取码' }), el('input', { id: 'ndExtract', placeholder: '自动识别' })),
          el('div', { class: 'field', style: { width: '180px' } }, el('span', { class: 'label', text: '解压码' }), el('input', { id: 'ndUnzip', placeholder: '没有可不填' })),
          el('button', { class: 'btn', onclick: () => this.recognize() }, uiSpan('eye'), '识别'),
          el('button', { class: 'btn btn-primary', onclick: () => this.enqueue() }, uiSpan('download'), '加入下载')
        ),
        el('div', { id: 'ndHint', class: 'hint' })
      )
    ));

    // 平台登录
    const platCard = el('div', { class: 'card' },
      el('h3', { text: '网盘账号' }),
      el('p', { class: 'hint', text: '点一下会在软件内开一个官方登录窗口，登完自动抓取该网盘的 Cookie 并保存到本机（和「浏览器」模块共用），再点一次退出登录。' }),
      el('div', { class: 'plat-grid' },
        this.platforms.map((p) => el('div', { class: 'pcard' + (p.logged ? ' on' : ''), onclick: () => this.toggleLogin(p) },
          el('div', { class: 'pico', style: { background: p.color }, text: p.name.slice(0, 2) }),
          el('div', { class: 'pmeta' },
            el('div', { class: 'pname', text: p.name }),
            el('div', { class: 'pstate' + (p.logged ? '' : ' off') },
              el('span', { class: 'dot' }),
              p.logged ? (p.nickname || '已登录') : (p.needLogin ? '未登录' : '免登录'))
          )
        ))
      )
    );
    body.appendChild(platCard);

    // 下载队列
    const dlCard = el('div', { class: 'card' },
      el('h3', { style: { display: 'flex', alignItems: 'center' } },
        '下载队列',
        el('div', { style: { flex: 1 } }),
        el('button', { class: 'btn btn-sm btn-ghost', onclick: async () => { await API.raw.netdisk.clearDone(); this.reload(); } }, '清除已完成')
      )
    );
    const dlSection = el('div', { class: 'dl-section' });
    dlCard.appendChild(dlSection);
    body.appendChild(dlCard);
    this.renderTasks(dlSection);
  },

  renderTasks(box) {
    clear(box);
    if (!this.tasks.length) {
      box.appendChild(el('p', { class: 'text-dim', text: '暂无下载任务。' }));
      return;
    }
    for (const t of this.tasks) box.appendChild(this.taskRow(t));
  },

  taskRow(t) {
    const pct = Math.round((t.progress || 0) * 100);
    const statusText = {
      queued: '排队中', downloading: `下载中 ${pct}%`, paused: '已暂停', done: '已完成',
      error: '失败', extracting: '解压中', 'need-login': '需登录', 'need-resolve': '待解析'
    }[t.status] || t.status;
    return el('div', { class: 'dl-row' },
      el('div', { class: 'di', style: { background: 'var(--accent)' }, text: (t.platformName || '网').slice(0, 2) }),
      el('div', { class: 'dmain' },
        el('div', { class: 'dname' },
          el('span', { class: 'ellipsis', style: { maxWidth: '360px' }, text: t.name }),
          el('span', { class: 'st-pill ' + t.status, text: statusText })
        ),
        el('div', { class: 'dsub ellipsis', title: t.url, text: t.error || (t.platformName + (t.total ? ' · ' + formatBytes(t.received) + ' / ' + formatBytes(t.total) : '')) }),
        el('div', { class: 'bar' }, el('i', { style: { width: pct + '%' } }))
      ),
      el('div', { class: 'dact' },
        t.status === 'downloading' ? el('button', { class: 'btn btn-sm', onclick: () => API.raw.netdisk.pause(t.id).then(() => this.reloadTasks()) }, '暂停') : null,
        (t.status === 'paused' || t.status === 'error' || t.status === 'need-login' || t.status === 'need-resolve') ? el('button', { class: 'btn btn-sm btn-primary', onclick: () => API.raw.netdisk.resume(t.id).then(() => this.reloadTasks()) }, '开始') : null,
        t.status === 'done' ? el('button', { class: 'btn btn-sm', onclick: () => API.raw.shell.openPath(t.saveDir) }, '打开') : null,
        el('button', { class: 'btn btn-sm btn-danger', onclick: () => API.raw.netdisk.remove(t.id).then(() => this.reloadTasks()) }, uiSpan('trash'))
      )
    );
  },

  recognize() {
    const text = (document.getElementById('ndText') || {}).value || '';
    const hint = document.getElementById('ndHint');
    if (!text.trim()) return;
    API.raw.netdisk.recognize(text).then((r) => {
      if (!r.hits.length) { hint.textContent = '没有识别到链接。'; return; }
      const names = r.hits.map((h) => h.platformName || '普通网页').join('、');
      hint.textContent = `识别到 ${r.hits.length} 个链接：${names}` + (r.extractCode ? ` ｜ 提取码 ${r.extractCode}` : '') + (r.unzipCode ? ` ｜ 解压码 ${r.unzipCode}` : '');
      if (r.extractCode) document.getElementById('ndExtract').value = r.extractCode;
      if (r.unzipCode) document.getElementById('ndUnzip').value = r.unzipCode;
      this.lastRec = r;
    }).catch((e) => { hint.textContent = e.message; });
  },

  async enqueue() {
    const text = (document.getElementById('ndText') || {}).value || '';
    if (!text.trim()) return window.Shell.toast('请先粘贴链接', 'err');
    const extractCode = (document.getElementById('ndExtract') || {}).value || '';
    const unzipCode = (document.getElementById('ndUnzip') || {}).value || '';
    const r = await API.raw.netdisk.recognize(text).catch(() => null);
    if (!r || !r.hits.length) return window.Shell.toast('没有识别到链接', 'err');
    let n = 0;
    for (const h of r.hits) {
      await API.raw.netdisk.enqueue({
        url: h.url, platform: h.kind === 'netdisk' ? h.platform : 'direct',
        extractCode, unzipCode, origin: 'hub', autoExtract: true
      }).then(() => n++).catch((e) => window.Shell.toast(e.message, 'err'));
    }
    window.Shell.toast(`已加入下载队列：${n} 个`, 'ok');
    document.getElementById('ndText').value = '';
    this.reload();
  },

  async toggleLogin(p) {
    if (p.logged) {
      const yes = await window.Shell.confirm({
        title: p.name,
        message: `已登录${p.nickname ? '：' + p.nickname : ''}。确定退出登录？`,
        detail: '退出会同时清掉「浏览器」里这个网盘的登录状态。',
        okText: '退出'
      });
      if (yes) {
        await API.raw.netdisk.logout(p.id).catch((e) => window.Shell.toast(e.message, 'err'));
        window.Shell.toast(`${p.name} 已退出登录`, 'ok');
        this.reload();
      }
      return;
    }
    if (!p.needLogin) return window.Shell.toast(`${p.name} 无需登录`, 'ok');
    const ok = await window.Shell.openLoginDialog({ kind: 'netdisk', id: p.id, name: p.name, url: p.loginUrl });
    if (ok) this.reload();
  }
};

window.NetdiskView = NetdiskView;
})();
