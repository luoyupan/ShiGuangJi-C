/**
 * ============================================================
 *  拾光集 · 联机模块视图 (modules/link.js)
 * ------------------------------------------------------------
 *  界面参考用户给的截图：
 *    · 上方三张通道卡（P2P 直连 / 内网穿透 / 中转服务器），点一下切换
 *    · 中间是建房表单（房间名、游戏、端口、中转、STUN）
 *    · 左下一个邀请码框（复制 / 粘贴加入）
 *    · 右栏：我的状态 / 房间成员 / 中转服务 / 日志
 *
 *  ⚠️ 这个模块里**所有数字都是主进程真给的**：本机地址来自网卡、延迟来自
 *     TCP/TCP 心跳、成员来自中转服务器、虚拟网卡状态来自 vnic.detect()。
 *     没有驱动就明写「不可用 + 还差什么」，不拿假状态糊界面。
 * ============================================================ */
'use strict';
(function () {
const { el, clear } = window.util;
const { uiSpan } = window.ICON;

const MODES = [
  {
    id: 'punch', icon: 'bolt', title: '内网穿透',
    tag: '推荐 · 双方都在 NAT 后面',
    desc: '用 STUN 查到你的公网出口，双方同时对打，把两边的 NAT 顶开，之后就是点对点直连。',
    note: '需要填一个 STUN 服务器（设置里）',
    badge: '需 STUN'
  },
  {
    id: 'p2p', icon: 'link', title: 'P2P 直连',
    tag: '同局域网 · 延迟最低',
    desc: '对方的电脑能被直接访问（同一个 WiFi / 有公网 IP / 已经做过端口映射）时用这个，不经过任何服务器。',
    note: '',
    badge: '零依赖'
  },
  {
    id: 'relay', icon: 'server', title: '中转服务器',
    tag: '最稳 · 打洞失败时用',
    desc: '双方都连到一台中转服务器，由它转发数据。公司网封 UDP、NAT 太严时只有这条路。',
    note: '需要填中转地址；没服务器可以点右栏「本机开中转」',
    badge: '需中转'
  }
];

const LinkView = {
  root: null,
  cfg: null,
  st: null,
  logs: [],
  busy: false,

  async mount(container) {
    this.root = container;
    container.innerHTML = '';
    const page = el('div', { class: 'page link' });
    /* ⚠️ 页头必须有「返回」：标题栏面包屑虽然也能点回主界面，但它**长得不像按钮**，
       用户在原图里圈的就是这一块（「联机模块的退出按钮没有」）。和设置页保持同一写法。 */
    page.appendChild(el('div', { class: 'page-head' },
      el('button', { class: 'back-btn', onclick: () => window.Shell.go('#/') }, uiSpan('back'), '返回'),
      el('h2', { text: '联机' }),
      el('span', { class: 'sub', text: 'P2P 直连 · 内网穿透 · 中转服务器' }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn-sm', onclick: () => this.reload() }, uiSpan('refresh'), '刷新')
    ));
    this.bodyEl = el('div', { class: 'page-body link-body' });
    /* 🔴 change 监听只能挂**一次**：挂在 bodyEl 上做委托。
       挂在渲染函数里会跟 render() 次数一起涨，改一个框触发好几次保存。 */
    this.bodyEl.addEventListener('change', (e) => {
      if (e.target && e.target.closest && e.target.closest('.lk-field')) this.saveForm();
    });
    /* 聊天框回车 = 发送（同样只挂一次，走委托） */
    this.bodyEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (!e.target || e.target.id !== 'lkChatInput') return;
      e.preventDefault();
      this.sendChat();
    });
    page.appendChild(this.bodyEl);
    container.appendChild(page);

    this._offState = API.on('link:state', (s) => { this.st = s; this.paintStatus(); this.paintChat(); });
    this._offLog = API.on('link:log', (l) => { this.logs.push(l); this.paintLog(); });
    this._offChat = API.on('link:chat', (m) => this.onChat(m));

    await this.reload();
    return this;
  },

  detach() {
    if (this._offState) { this._offState(); this._offState = null; }
    if (this._offLog) { this._offLog(); this._offLog = null; }
    if (this._offChat) { this._offChat(); this._offChat = null; }
  },

  async reload() {
    const [cfg, st] = await Promise.all([
      API.raw.link.config().catch(() => null),
      API.raw.link.status().catch(() => null)
    ]);
    if (cfg) this.cfg = cfg;
    if (st) { this.st = st; this.logs = (st.logs || []).slice(); }
    this.render();
  },

  /* ============================================================
     渲染
     ============================================================ */
  render() {
    const body = clear(this.bodyEl);
    if (!this.cfg) {
      body.appendChild(el('div', { class: 'empty' }, el('h3', { text: '读不到联机设置' }),
        el('p', { text: '点右上角「刷新」再试一次。' })));
      return;
    }
    const main = el('div', { class: 'link-main' });
    const side = el('div', { class: 'link-side' });
    body.appendChild(main);
    body.appendChild(side);

    main.appendChild(this.modeCards());
    main.appendChild(this.formCard());
    main.appendChild(this.inviteCard());
    const help = this.joinHelpCard();
    if (help) main.appendChild(help);
    main.appendChild(this.chatCard());
    main.appendChild(this.logCard());

    side.appendChild(this.statusCard());
    side.appendChild(this.membersCard());
    side.appendChild(this.netCard());
    side.appendChild(this.relayServerCard());
    side.appendChild(this.vnicCard());
  },

  /* ---- 三张通道卡 ---- */
  modeCards() {
    const cur = (this.cfg && this.cfg.mode) || 'p2p';
    return el('div', { class: 'link-modes' },
      MODES.map((m) => el('div', {
        class: 'lm-card' + (cur === m.id ? ' on' : ''),
        dataset: { mode: m.id },
        onclick: () => this.pickMode(m.id)
      },
        el('div', { class: 'lm-head' },
          el('span', { class: 'lm-ic' }, uiSpan(m.icon)),
          el('div', { class: 'lm-titles' },
            el('div', { class: 'lm-title', text: m.title }),
            el('div', { class: 'lm-tag', text: m.tag })
          ),
          el('span', { class: 'chip ' + (cur === m.id ? 'accent' : ''), text: cur === m.id ? '当前' : m.badge })
        ),
        el('p', { class: 'lm-desc', text: m.desc }),
        m.note ? el('p', { class: 'lm-note', text: m.note }) : null,
        el('div', { class: 'lm-foot' },
          el('span', { class: 'dot ' + (cur === m.id ? 'on' : '') }),
          el('span', { text: cur === m.id ? '正在用这个方式' : '点一下切换到这个方式' }))
      ))
    );
  },

  async pickMode(id) {
    if (!this.cfg || this.cfg.mode === id) return;
    await API.raw.link.setConfig({ mode: id }).catch(() => null);
    this.cfg.mode = id;
    const cards = this.bodyEl.querySelectorAll('.lm-card');
    cards.forEach((c) => {
      const on = c.dataset.mode === id;
      c.classList.toggle('on', on);
      const chip = c.querySelector('.chip');
      if (chip) {
        const m = MODES.find((x) => x.id === c.dataset.mode);
        chip.textContent = on ? '当前' : (m ? m.badge : '');
        chip.classList.toggle('accent', on);
      }
      const dot = c.querySelector('.dot');
      if (dot) dot.classList.toggle('on', on);
    });
    /* 🔴 换模式会多出/收起「中转地址」「STUN 地址」两组输入框 —— 必须重画表单。
       只换这一张卡（不整页重画），否则日志滚动位置、邀请码框都被重置。 */
    const oldForm = document.getElementById('lkFormCard');
    if (oldForm) oldForm.replaceWith(this.formCard());
    this.paintStatus();
  },

  /* ---- 建房表单 ---- */
  formCard() {
    const c = this.cfg;
    const mode = c.mode;
    const f = (label, id, value, opts) => el('div', { class: 'field lk-field' + ((opts && opts.wide) ? ' lk-wide' : '') },
      el('span', { class: 'label', text: label }),
      el('input', { id, value: value == null ? '' : String(value), placeholder: (opts && opts.ph) || '', type: (opts && opts.type) || 'text' })
    );
    const save = () => this.saveForm();

    const card = el('div', { class: 'card', id: 'lkFormCard' },
      el('h3', {}, '房间设置', el('span', { class: 'hint inline', text: mode === 'relay' ? '中转模式：双方都连中转' : (mode === 'punch' ? '打洞模式：先查公网出口再对打' : '直连模式：对方直接连你') })),
      el('div', { class: 'lk-grid' },
        f('房间名', 'lkRoomName', c.roomName, { ph: '对方会看到这个名字' }),
        f('游戏名（可不填）', 'lkGameName', c.gameName, { ph: '例如：Minecraft' }),
        f('游戏端口', 'lkGamePort', c.gamePort, { ph: '25565', type: 'number' }),
        f('本机映射端口', 'lkLocalPort', c.localPort, { ph: '加入后进游戏填 127.0.0.1:这个端口', type: 'number' }),
        f('隧道端口（房主）', 'lkTunnelPort', c.tunnelPort, { ph: '47788', type: 'number' }),
        f('控制端口（房主）', 'lkCtrlPort', c.ctrlPort, { ph: '留空 = 隧道端口 + 1', type: 'number' }),
        /* 🔴 对外地址占两格：这一行里它最需要宽度（IP / 域名都可能很长），
           挤在一格里文字被截断，用户看不清自己填了什么。 */
        f('对外地址（可不填）', 'lkPublicAddr', c.publicAddr, { ph: '留空自动用本机内网地址', wide: true })
      ),
      mode === 'relay'
        ? el('div', { class: 'lk-grid' },
          f('中转服务器', 'lkRelayHost', c.relayHost, { ph: '填 IP 或域名（不内置任何站点）', wide: true }),
          f('中转端口', 'lkRelayPort', c.relayPort, { ph: '47777', type: 'number' }))
        : null,
      mode === 'punch'
        ? el('div', { class: 'lk-grid' },
          f('STUN 服务器', 'lkStunHost', c.stunHost, { ph: '填你自己的 STUN 地址', wide: true }),
          f('STUN 端口', 'lkStunPort', c.stunPort, { ph: '3478', type: 'number' }))
        : null,
      el('div', { class: 'lk-actions' },
        el('button', { class: 'btn btn-primary', id: 'lkHostBtn', onclick: () => this.host() },
          uiSpan('play'), mode === 'relay' ? '创建 / 加入中转房间' : '创建房间'),
        el('button', { class: 'btn', id: 'lkStopBtn', onclick: () => this.stop() }, uiSpan('stop'), '停止'),
        mode === 'punch'
          ? el('button', { class: 'btn', onclick: () => this.punch() }, uiSpan('bolt'), '测试公网 / 打洞')
          : null,
        el('button', { class: 'btn', onclick: () => this.probeSelf() }, uiSpan('eye'), '测本机端口'),
        el('div', { class: 'spacer' }),
        el('span', { class: 'hint', text: '改完这些框会自动保存' })
      )
    );
    return card;
  },

  saveForm() {
    const g = (id) => { const n = document.getElementById(id); return n ? n.value : ''; };
    const patch = {
      roomName: g('lkRoomName').trim(),
      gameName: g('lkGameName').trim(),
      gamePort: Number(g('lkGamePort')) || 0,
      localPort: Number(g('lkLocalPort')) || 0,
      tunnelPort: Number(g('lkTunnelPort')) || 0,
      ctrlPort: Number(g('lkCtrlPort')) || 0,
      publicAddr: g('lkPublicAddr').trim()
    };
    if (document.getElementById('lkRelayHost')) {
      patch.relayHost = g('lkRelayHost').trim();
      patch.relayPort = Number(g('lkRelayPort')) || 0;
    }
    if (document.getElementById('lkStunHost')) {
      patch.stunHost = g('lkStunHost').trim();
      patch.stunPort = Number(g('lkStunPort')) || 0;
    }
    return API.raw.link.setConfig(patch).then((c) => { this.cfg = c; return c; }).catch(() => null);
  },

  /* ---- 邀请码 ---- */
  inviteCard() {
    const st = this.st || {};
    const code = st.invite || '';
    const card = el('div', { class: 'card lk-invite' },
      el('h3', {}, '邀请码', el('span', { class: 'hint inline', text: '软件加密 · 对方粘贴即可加入（带房间密码，24 小时有效）' })),
      el('textarea', {
        class: 'inp lk-code', id: 'lkInviteCode', readonly: 'readonly', rows: '3',
        placeholder: '点上面的「创建房间」后，这里会出现邀请码'
      }),
      el('div', { class: 'lk-actions' },
        el('button', { class: 'btn', onclick: () => this.copyInvite() }, uiSpan('save'), '复制邀请码'),
        el('button', { class: 'btn', onclick: () => this.regenerate() }, uiSpan('refresh'), '重新生成'),
        el('div', { class: 'spacer' }),
        el('span', { class: 'hint', id: 'lkInviteMeta', text: st.inviteData ? `房间 ${st.inviteData.roomId}` : '还没建房' })
      ),
      el('div', { class: 'lk-join' },
        el('div', { class: 'field lk-field grow' },
          el('span', { class: 'label', text: '加入别人的房间' }),
          el('input', { id: 'lkJoinCode', placeholder: '把对方的邀请码粘到这里（整段粘贴，空格换行都行）' })
        ),
        el('button', { class: 'btn btn-primary', id: 'lkJoinBtn', onclick: () => this.join() }, uiSpan('forward'), '加入')
      )
    );
    const ta = card.querySelector('#lkInviteCode');
    if (ta) ta.value = code;
    return card;
  },

  async regenerate() {
    const r = await API.raw.link.invite({}).catch((e) => { window.Shell.toast(e.message, 'err'); return null; });
    if (!r) return;
    const ta = document.getElementById('lkInviteCode');
    if (ta) ta.value = r.code;
    const meta = document.getElementById('lkInviteMeta');
    if (meta) meta.textContent = `房间 ${r.data.roomId}`;
    this.st = await API.raw.link.status().catch(() => this.st);
    window.Shell.toast('已重新生成邀请码（旧的立刻失效）', 'ok');
  },

  async copyInvite() {
    const ta = document.getElementById('lkInviteCode');
    const text = (ta && ta.value) || '';
    if (!text) { window.Shell.toast('还没有邀请码 —— 先点「创建房间」', 'err'); return; }
    try { await navigator.clipboard.writeText(text); window.Shell.toast('邀请码已复制', 'ok'); }
    catch { window.Shell.toast('复制失败，手动全选复制一下', 'err'); }
  },

  /* ---- 连上之后：游戏里到底填什么 ----
     🔴 这一张卡是用户**真金白银问过的问题**：「我开好房间，他点局域网联机
        输入 IP 不知道输入什么」。端口映射天生「加入方填 127.0.0.1」，
        但这话不写出来，谁也不可能猜到 —— 大多数人会去填服务器 IP。 */
  joinHelpCard() {
    const st = this.st || {};
    if (st.phase !== 'connected') return null;
    const c = this.cfg || {};
    const gamePort = c.gamePort || 0;
    const local = c.localPort || gamePort;
    const udp = st.udp || {};
    const row = (who, ...lines) => el('div', { class: 'lk-help-row' },
      el('span', { class: 'lk-help-who', text: who }),
      el('div', { class: 'lk-help-txt' }, lines)
    );
    return el('div', { class: 'card lk-help', id: 'lkHelpCard' },
      el('h3', {}, '游戏里填什么',
        el('span', { class: 'chip accent', text: '照着填就能连' })),
      row('房主',
        el('div', { text: `开游戏 → 「开房间 / 局域网联机」，端口保持 ${gamePort}，不用改` }),
        el('div', { class: 'hint', text: 'TCP 和 UDP 两条都已经接到房间里了，你什么都不用填' })
      ),
      row('加入方',
        el('div', {},
          '在游戏的「输入 IP / 直接连接」里填 ',
          el('b', { class: 'lk-code-inline', text: '127.0.0.1' }),
          '，端口填 ',
          el('b', { class: 'lk-code-inline', text: String(local) })
        ),
        el('div', { class: 'hint', text: '⚠️ 填的是 127.0.0.1，不是服务器 IP、也不是房主的 IP —— 本机已经把这两个端口接到房间里了' })
      ),
      el('p', { class: 'hint', text: '星露谷物语：加入 → 「加入局域网游戏」会自己扫，扫不到就在下面那栏输入 127.0.0.1 回车。泰拉瑞亚同理（端口 7777）。' }),
      udp.on
        ? null
        : el('p', { class: 'lk-help-warn', text: 'UDP 通道没起来：只走 UDP 的游戏（星露谷）会一直「连接中」——看日志里那句「UDP 端口…起不来」' })
    );
  },

  /* ---- 房间聊天 ---- */
  /**
   * 聊天栏。🔴 只有房间里有人（控制通道连上）才让输入：
   * 没连上却给一个能打字的框，用户打完才发现发不出去 —— 那是最差的一种交互。
   */
  chatCard() {
    const st = this.st || {};
    const chat = st.chat || {};
    const on = !!chat.enabled;
    const card = el('div', { class: 'card lk-chat', id: 'lkChatCard' },
      el('h3', {}, '房间聊天',
        el('span', { class: 'chip ' + (on ? 'accent' : ''), text: on ? '已连接' : '未连接' }),
        el('span', { class: 'hint inline', text: '只在房间里传，不保存到本地' })
      ),
      el('div', { class: 'lk-chat-list', id: 'lkChatList' }, this.chatRows((st.chats || []))),
      el('div', { class: 'lk-chat-send' },
        el('input', {
          id: 'lkChatInput', class: 'lk-chat-inp', maxlength: '500',
          placeholder: on ? '说点什么，回车发送' : ((chat.reason || '还没连上房间') + ' —— 建房或加入后才能聊'),
          disabled: on ? null : 'disabled'
        }),
        el('button', {
          class: 'btn btn-primary btn-sm', id: 'lkChatBtn',
          onclick: () => this.sendChat(), disabled: on ? null : 'disabled'
        }, uiSpan('forward'), '发送')
      )
    );
    return card;
  },

  chatRows(list) {
    if (!list || !list.length) {
      return [el('div', { class: 'lk-chat-empty', text: '还没有消息。连上房间后，这里能看到双方说的话。' })];
    }
    return list.map((m) => el('div', { class: 'lk-chat-row' + (m.self ? ' self' : '') },
      el('div', { class: 'lk-chat-meta' },
        el('span', { class: 'who', text: m.self ? '我' : (m.name || m.from || '对方') }),
        el('span', { class: 't', text: hhmm(m.at) })
      ),
      el('div', { class: 'lk-chat-bubble', text: m.text })
    ));
  },

  /** 收到一条新消息：先塞进内存那份，交给下一次 state 覆盖成权威列表 */
  onChat(m) {
    if (!m) return;
    this.st = this.st || {};
    const list = this.st.chats || [];
    if (!list.some((x) => x.at === m.at && x.text === m.text && x.from === m.from)) {
      this.st.chats = list.concat([m]);
    }
    this.paintChat();
  },

  async sendChat() {
    const inp = document.getElementById('lkChatInput');
    const text = (inp && inp.value || '').trim();
    if (!text) return;
    const r = await API.raw.link.chat(text).catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) { window.Shell.toast((r && r.error) || '发送失败', 'err'); return; }
    if (inp) { inp.value = ''; inp.focus(); }
  },

  /** 只重画消息列表（输入框是兄弟节点，不会被打断） */
  paintChat() {
    const box = document.getElementById('lkChatList');
    if (!box) return;
    const list = (this.st && this.st.chats) || [];
    const key = list.map((m) => m.at + '|' + (m.from || '') + '|' + m.text).join('\n');
    if (key === this._chatKey) return;
    this._chatKey = key;
    clear(box);
    for (const n of this.chatRows(list)) box.appendChild(n);
    box.scrollTop = box.scrollHeight;
    const card = document.getElementById('lkChatCard');
    if (card) {
      const chip = card.querySelector('.chip');
      const on = !!(this.st && this.st.chat && this.st.chat.enabled);
      if (chip) { chip.textContent = on ? '已连接' : '未连接'; chip.classList.toggle('accent', on); }
      const inp = document.getElementById('lkChatInput');
      const btn = document.getElementById('lkChatBtn');
      if (inp) inp.disabled = !on;
      if (btn) btn.disabled = !on;
    }
  },

  /* ---- 操作 ---- */
  async host() {
    if (this.busy) return;
    this.busy = true;
    this.btnBusy('lkHostBtn', '正在建房…');
    try {
      await this.saveForm();
      const r = await API.raw.link.host({});
      this.st = r;
      const ta = document.getElementById('lkInviteCode');
      if (ta) ta.value = r.invite || '';
      window.Shell.toast(`房间已开：${(r.forwarder && r.forwarder.listen) || ''} → 本机 ${this.cfg.gamePort}`, 'ok');
      this.paintStatus();
    } catch (e) {
      window.Shell.toast(e.message, 'err');
    } finally {
      this.busy = false;
      this.btnBusy('lkHostBtn', null);
    }
  },

  async join() {
    const inp = document.getElementById('lkJoinCode');
    const text = (inp && inp.value || '').trim();
    if (!text) { window.Shell.toast('先把邀请码粘进来', 'err'); return; }
    if (this.busy) return;
    this.busy = true;
    this.btnBusy('lkJoinBtn', '正在加入…');
    try {
      await this.saveForm();
      const r = await API.raw.link.join(text);
      this.st = r;
      const ta = document.getElementById('lkInviteCode');
      if (ta) ta.value = r.invite || text;
      window.Shell.toast('已加入房间', 'ok');
      this.paintStatus();
    } catch (e) {
      window.Shell.toast(e.message, 'err');
    } finally {
      this.busy = false;
      this.btnBusy('lkJoinBtn', null);
    }
  },

  async stop() {
    const st = await API.raw.link.stop().catch(() => null);
    if (st) this.st = st;
    const ta = document.getElementById('lkInviteCode');
    if (ta) ta.value = '';
    window.Shell.toast('已停止联机', 'ok');
    this.paintStatus();
  },

  async punch() {
    try {
      window.Shell.toast('正在查公网出口…');
      const r = await API.raw.link.punch(null);
      if (r && r.mine) window.Shell.toast(`公网出口：${r.mine.address}:${r.mine.port}`, 'ok');
      else window.Shell.toast('没拿到公网地址', 'err');
      this.st = await API.raw.link.status().catch(() => this.st);
      this.paintStatus();
    } catch (e) { window.Shell.toast(e.message, 'err'); }
  },

  async probeSelf() {
    const c = this.cfg || {};
    try {
      const r = await API.raw.link.probe({ host: '127.0.0.1', port: c.gamePort, timeout: 2500 });
      window.Shell.toast(r.ok ? `本机 ${c.gamePort} 端口有人在听（${r.ms}ms）—— 游戏服务已开` : `本机 ${c.gamePort} 端口没人听：${r.error}`, r.ok ? 'ok' : 'err');
    } catch (e) { window.Shell.toast(e.message, 'err'); }
  },

  btnBusy(id, label) {
    const b = document.getElementById(id);
    if (!b) return;
    if (label) { b.dataset.old = b.textContent; b.textContent = label; b.disabled = true; }
    else { if (b.dataset.old) b.textContent = b.dataset.old; b.disabled = false; }
  },

  /* ============================================================
     右栏
     ============================================================ */
  statusCard() {
    const st = this.st || {};
    const c = this.cfg || {};
    const phaseText = {
      idle: '未开始', hosting: '正在建房', connecting: '正在连接', connected: '已连接', error: '出错'
    }[st.phase] || '未开始';
    const fw = st.forwarder;
    /* p2p / 打洞模式下那条连接是**房主自己机器上开的控制通道**（只管成员和聊天），
       不是用户填的中转 —— 名字写混了，用户会以为数据经过了第三方。 */
    const isRelay = (st.mode || c.mode) === 'relay';
    const rl = st.relay;
    const rlOld = !!(rl && rl.connected && (rl.version || 0) < 2);
    const rlRow = [
      isRelay ? '中转' : '聊天通道',
      rl ? (rl.connected
        ? `已连接${rl.self ? '（本机）' : ''} · ${rl.rtt || 0}ms` + (rlOld ? ' · 服务端旧版' : '')
        : '未连接') : (isRelay ? '未使用' : '未开启'),
      rl && rl.connected ? (rlOld ? 'bad' : 'ok') : ''
    ];
    const udp = st.udp;
    const rows = [
      ['状态', phaseText, st.phase === 'error' ? 'bad' : (st.phase === 'connected' ? 'ok' : '')],
      ['方式', { p2p: 'P2P 直连', punch: '内网穿透', relay: '中转服务器' }[st.mode || c.mode] || '—', ''],
      ['本机内网地址', (c.local && c.local.recommend) || '—', ''],
      ['隧道', fw ? `${fw.listen} → ${fw.target}` : '未开启', fw ? 'ok' : ''],
      ['公网出口', st.publicEndpoint ? `${st.publicEndpoint.address}:${st.publicEndpoint.port}` : '未查询', ''],
      rlRow,
      /* UDP 那一格必须看得见：只走 UDP 的游戏（星露谷）全靠它，
         没起来却不说，用户只会看到「一直在连接中」。 */
      ['UDP 通道', udpText(udp, st.phase), udp && udp.on ? 'ok' : (st.phase === 'connected' ? 'bad' : '')]
    ];
    if (st.phase === 'connected') {
      rows.push(['进游戏填', `127.0.0.1:${c.localPort}`, 'ok']);
    }
    if (st.error) rows.push(['错误', st.error, 'bad']);
    return el('div', { class: 'card lk-status', id: 'lkStatusCard' },
      el('h3', {}, '我的状态'),
      el('div', { class: 'lk-kv' }, rows.map(([k, v, cls]) => el('div', { class: 'lk-kv-row' },
        el('span', { class: 'k', text: k }),
        el('span', { class: 'v ' + (cls || ''), text: v == null ? '' : String(v) })
      ))),
      st.phase === 'connected'
        ? el('div', { class: 'lk-tip' }, uiSpan('check'),
          '加入方在游戏里填 127.0.0.1 —— 房主直接开游戏就行（详见下面「游戏里填什么」）')
        : null
    );
  },

  membersCard() {
    const st = this.st || {};
    const room = st.room;
    const peers = (room && room.peers) || [];
    const selfId = (st.relay && st.relay.id) || '';
    /* 中转服务端版本 < 2 = 不认识点对点心跳 → 对方延迟收不到。
       这一格不能只显示「延迟测量中」让人干等，得说清是服务端太旧。 */
    const rttOk = !(st.relay && st.relay.connected) ? true : (st.relay.version || 0) >= 2;
    const card = el('div', { class: 'card lk-members' },
      el('h3', {}, '房间成员', el('span', { class: 'hint inline', text: peers.length ? `${peers.length} 人` : '' })),
      peers.length
        ? el('div', { class: 'lk-peer-list' }, peers.map((p) => el('div', { class: 'lk-peer' },
          el('span', { class: 'lk-avatar', text: (p.name || p.id || '?').slice(0, 1) }),
          el('div', { class: 'lk-peer-meta' },
            /* 房主身份右边那个 chip 已经在说了，名字里再写一遍是重复 */
            el('div', { class: 'lk-peer-name', text: p.name || p.id }),
            el('div', { class: 'lk-peer-sub', text: peerSub(p, selfId, rttOk) })
          ),
          p.host ? el('span', { class: 'chip accent', text: '房主' }) : null
        )))
        : el('div', { class: 'lk-empty' },
          el('p', { text: '还没有人进来。' }),
          el('p', { class: 'hint', text: '把邀请码发给朋友，他粘贴后就会出现在这里。' })),
      !rttOk
        ? el('p', { class: 'lk-help-warn', text: '这个中转服务端是旧版，收不到对方的延迟。把服务器上的 relay.js 换成新版、重启中转就好（自己开的房间不会有这个问题）。' })
        : null
    );
    return card;
  },

  /* ---- 本机网络信息（需同意 · 加密存本地 · 不联网） ---- */
  netCard() {
    const net = (this.cfg && this.cfg.net) || { consent: false, saved: null, file: false };
    const saved = net.saved;
    const head = el('h3', {}, '本机网络',
      el('span', { class: 'chip ' + (net.consent ? 'accent' : ''), text: net.consent ? (saved ? '已保存' : '已授权') : '未授权' }));

    /* ① 还没同意：这张卡就是「同意书」，没有别的按钮能绕过去 */
    if (!net.consent) {
      return el('div', { class: 'card lk-net', id: 'lkNetCard' }, head,
        el('p', { class: 'hint', text: '读一下本机网卡上的 IPv4 / IPv6 地址，看看你能不能被人连上。' }),
        el('div', { class: 'lk-consent' },
          el('p', { text: '开始前要先经过你同意：' }),
          el('ul', { class: 'lk-todo' },
            el('li', { text: '只读本机网卡上的地址 / 掩码 / 网卡名' }),
            el('li', { text: '加密后保存到本地，换台电脑解不开' }),
            el('li', { text: '不联网、不上传，不会发给任何人' })
          )
        ),
        el('div', { class: 'lk-actions' },
          el('button', { class: 'btn btn-sm btn-primary', id: 'lkNetGrantBtn', onclick: () => this.netGrant() },
            uiSpan('shield'), '我同意，读一下'),
          el('div', { class: 'spacer' }),
          el('span', { class: 'hint', text: '随时可以撤销' })
        )
      );
    }

    /* ② 同意了但还没检测 */
    if (!saved) {
      return el('div', { class: 'card lk-net', id: 'lkNetCard' }, head,
        el('p', { class: 'hint', text: '你已同意。点下面的按钮读一次本机网卡信息 —— 结果会加密后存在本机。' }),
        el('div', { class: 'lk-actions' },
          el('button', { class: 'btn btn-sm btn-primary', id: 'lkNetScanBtn', onclick: () => this.netScan() },
            uiSpan('globe'), '开始检测'),
          el('button', { class: 'btn btn-sm', onclick: () => this.netRevoke() }, uiSpan('trash'), '撤销并删除')
        )
      );
    }

    /* ③ 有数据：分 IPv4 / IPv6 两块列出来，每条带「别人能不能连」的标签 */
    const sum = saved.summary || {};
    const when = saved.at ? new Date(saved.at).toLocaleString('zh-CN', { hour12: false }) : '—';
    return el('div', { class: 'card lk-net', id: 'lkNetCard' }, head,
      el('div', { class: 'lk-kv' },
        el('div', { class: 'lk-kv-row' }, el('span', { class: 'k', text: '检测时间' }), el('span', { class: 'v', text: when })),
        el('div', { class: 'lk-kv-row' }, el('span', { class: 'k', text: 'IPv4' }),
          el('span', { class: 'v ' + (sum.ipv4 ? 'ok' : 'bad'), text: sum.ipv4 ? `可用 · ${saved.counts.v4Usable} 个` : '没有可用' })),
        el('div', { class: 'lk-kv-row' }, el('span', { class: 'k', text: 'IPv6' }),
          el('span', { class: 'v ' + (sum.ipv6 ? 'ok' : (sum.ipv6Local ? '' : 'bad')) }, netV6Text(sum)))
      ),
      el('div', { class: 'lk-net-group' },
        el('div', { class: 'lk-net-head', text: 'IPv4' }),
        this.netRows(saved.v4 || [], '没有 IPv4 地址')
      ),
      el('div', { class: 'lk-net-group' },
        el('div', { class: 'lk-net-head', text: 'IPv6' }),
        this.netRows(saved.v6 || [], '没有 IPv6 地址')
      ),
      el('p', { class: 'hint', text: '加密保存在本地 link-netinfo.enc，不上传到任何地方；停用会立刻删掉。' }),
      el('div', { class: 'lk-actions' },
        el('button', { class: 'btn btn-sm', id: 'lkNetScanBtn', onclick: () => this.netScan() }, uiSpan('refresh'), '重新检测'),
        el('button', { class: 'btn btn-sm', onclick: () => this.netRevoke() }, uiSpan('trash'), '撤销并删除')
      )
    );
  },

  netRows(list, emptyText) {
    if (!list.length) return el('div', { class: 'lk-net-empty', text: emptyText });
    return el('div', { class: 'lk-net-list' }, list.map((x) => el('div', { class: 'lk-net-row' },
      el('span', { class: 'lk-net-if', title: x.iface + (x.mac ? ' · ' + x.mac : ''), text: x.iface }),
      el('span', { class: 'lk-net-ip', text: x.address }),
      el('span', { class: 'lk-net-tag ' + (x.kind || 'other'), text: NET_KIND[x.kind] || x.kind })
    )));
  },

  async netGrant() {
    try {
      this.applyNet(await API.raw.link.netGrant());
      window.Shell.toast('已记下你的同意 —— 现在可以检测了', 'ok');
    } catch (e) { window.Shell.toast(e.message, 'err'); }
  },

  async netScan() {
    const btn = document.getElementById('lkNetScanBtn');
    if (btn) btn.disabled = true;
    try {
      const r = await API.raw.link.netScan();
      this.applyNet(r.state || await API.raw.link.netState());
      window.Shell.toast(`已检测：IPv4 ${r.data.counts.v4Usable} 个可用 · IPv6 ${r.data.counts.v6Usable} 个可用`, 'ok');
    } catch (e) {
      window.Shell.toast(e.message, 'err');
    } finally {
      const b = document.getElementById('lkNetScanBtn');
      if (b) b.disabled = false;
    }
  },

  async netRevoke() {
    try {
      this.applyNet(await API.raw.link.netRevoke());
      window.Shell.toast('已撤销同意，本地那份加密文件也删掉了', 'ok');
    } catch (e) { window.Shell.toast(e.message, 'err'); }
  },

  /** 只换这张卡（别整页重画：用户可能正在填表单） */
  applyNet(st) {
    if (!this.cfg) return;
    this.cfg.net = st;
    const old = document.getElementById('lkNetCard');
    if (old) old.replaceWith(this.netCard());
  },

  relayServerCard() {
    const rs = (this.st && this.st.relayServer) || (this.cfg && this.cfg.relayServer) || {};
    const running = !!rs.running;
    return el('div', { class: 'card lk-relay-srv' },
      el('h3', {}, '本机开中转', el('span', { class: 'chip ' + (running ? 'accent' : ''), text: running ? '运行中' : '未开启' })),
      el('p', { class: 'hint', text: '同一份代码起一个中转服务：你有公网机器时把它开着，别人填它的地址就能当中转用。' }),
      /* 🔴 右栏只有 322px。端口框 + 两个按钮硬塞一行（以前是 `120px 1fr` 两列）时，
         按钮放不下就换行，又因为 `align-items:end` 强行贴底 —— 结果「停止」压在输入框上。
         这里改成「一行标签+输入框、一行两个按钮」，各自占满，永远不会挤。 */
      el('div', { class: 'lk-srv-ctl' },
        el('div', { class: 'lk-srv-row' },
          el('span', { class: 'label', text: '监听端口' }),
          el('input', { id: 'lkRelayServePort', type: 'number', value: String((this.cfg && this.cfg.relayServePort) || 47777) })
        ),
        el('div', { class: 'lk-srv-btns' },
          el('button', { class: 'btn btn-sm', onclick: () => this.relayToggle(true) }, uiSpan('server'), running ? '重启' : '启动'),
          el('button', { class: 'btn btn-sm', onclick: () => this.relayToggle(false) }, uiSpan('stop'), '停止')
        )
      ),
      el('div', { class: 'lk-kv' },
        el('div', { class: 'lk-kv-row' }, el('span', { class: 'k', text: '房间数' }), el('span', { class: 'v', text: String(rs.rooms || 0) })),
        el('div', { class: 'lk-kv-row' }, el('span', { class: 'k', text: '在线人数' }), el('span', { class: 'v', text: String(rs.peers || 0) })),
        el('div', { class: 'lk-kv-row' }, el('span', { class: 'k', text: '转发字节' }), el('span', { class: 'v', text: fmtBytes((rs.bytesIn || 0) + (rs.bytesOut || 0)) }))
      )
    );
  },

  async relayToggle(on) {
    try {
      if (on) {
        const inp = document.getElementById('lkRelayServePort');
        const port = Number(inp && inp.value) || 47777;
        await API.raw.link.setConfig({ relayServePort: port });
        const st = await API.raw.link.relayStart(port);
        window.Shell.toast(`本机中转已启动：端口 ${st.port}`, 'ok');
      } else {
        await API.raw.link.relayStop();
        window.Shell.toast('本机中转已停止', 'ok');
      }
      this.st = await API.raw.link.status().catch(() => this.st);
      this.render();
    } catch (e) { window.Shell.toast(e.message, 'err'); }
  },

  vnicCard() {
    const v = (this.cfg && this.cfg.vnic) || { available: false, reason: '未探测', todo: [] };
    return el('div', { class: 'card lk-vnic' },
      el('h3', {}, '虚拟网卡（真·局域网）',
        el('span', { class: 'chip ' + (v.available ? 'accent' : 'warn'), text: v.available ? '就绪' : '不可用' })),
      el('p', { class: 'hint', text: v.reason }),
      v.todo && v.todo.length
        ? el('ul', { class: 'lk-todo' }, v.todo.map((t) => el('li', { text: t })))
        : null,
      el('p', { class: 'hint', text: '在它就绪之前，用上面的「端口映射」就够了：加入方进游戏填 127.0.0.1 即可。' })
    );
  },

  /* ---- 日志 ---- */
  logCard() {
    return el('div', { class: 'card lk-logcard' },
      el('h3', {}, '联机日志'),
      el('div', { class: 'lk-log', id: 'lkLog' }, this.logRows())
    );
  },

  logRows() {
    const list = this.logs.slice(-60);
    if (!list.length) return [el('div', { class: 'lk-log-empty', text: '还没有记录。' })];
    return list.map((l) => el('div', { class: 'lk-log-row' },
      el('span', { class: 't', text: new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false }) }),
      el('span', { class: 'm', text: l.text })
    ));
  },

  paintLog() {
    const box = document.getElementById('lkLog');
    if (!box) return;
    clear(box);
    for (const n of this.logRows()) box.appendChild(n);
    box.scrollTop = box.scrollHeight;
  },

  /** 只重画右栏「我的状态」，不整页重画（否则输入框会失焦） */
  paintStatus() {
    const old = document.getElementById('lkStatusCard');
    if (!old || !this.bodyEl) return;
    const fresh = this.statusCard();
    old.replaceWith(fresh);
    const members = this.bodyEl.querySelector('.lk-members');
    if (members) members.replaceWith(this.membersCard());
    /* 「游戏里填什么」只在连上以后出现 —— 也要跟着状态走动，
       否则建完房得点一次刷新才看得见。 */
    const oldHelp = document.getElementById('lkHelpCard');
    const help = this.joinHelpCard();
    if (oldHelp) { if (help) oldHelp.replaceWith(help); else oldHelp.remove(); }
    else if (help) {
      const chat = document.getElementById('lkChatCard');
      if (chat && chat.parentNode) chat.parentNode.insertBefore(help, chat);
    }
  }
};

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** 聊天气泡上那个 HH:MM（本地时区，按小时分钟补零） */
function hhmm(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 地址标签 → 人话。主进程那边也有一份 LABEL，这里只挑界面上用得着的几种 */
const NET_KIND = {
  public: '公网', private: '内网', cgnat: '运营商 NAT', ula: '内网 v6',
  mapped: 'v4 映射', linklocal: '链路本地', loopback: '回环', other: '其它'
};

/** 成员列表里那行小字：不要直接把 'p2p' 这种内部枚举名丢给用户看 */
const MODE_TEXT = { p2p: 'P2P 直连', punch: '内网穿透', relay: '中转' };

/**
 * 成员那一行：「中转 · 我 · 5ms」。
 * 🔴 这里的延迟是**我去问他、他打回来**的往返，所以每个人都有数字；
 *    以前所有人的数字其实都是「我到中转」那一份，别人的格子永远是空的。
 */
function peerSub(p, selfId, rttOk) {
  const me = selfId && p.id === selfId;
  /* 🔴 判「测过没有」用 `rttSeen`，不能用 `rttAvg` 真假 —— 本机环回真的会测出 0ms，
     那样一条会永远显示「延迟测量中」，看着像功能没做。
     别人那格还要看服务端版本：旧版中转不转 ping2/pong2，永远测不出来。 */
  const lat = (!rttOk && !me) ? '延迟不可用（服务端旧版）'
    : (p.rttSeen ? `${p.rttAvg}ms` : '延迟测量中');
  return [MODE_TEXT[p.mode] || p.mode, me ? '我' : '', lat].filter(Boolean).join(' · ');
}

/** 「UDP 通道」那一格：没起来要说清楚后果，别只写「未开」 */
function udpText(u, phase) {
  const on = !!(u && u.on);
  if (!on) return phase === 'connected' ? '未开（只走 UDP 的游戏连不上）' : '—';
  if (u.local) return `已开 · 127.0.0.1:${u.local}`;
  return u.peers ? `已开 · ${u.peers} 人` : '已开';
}

/** IPv6 一句话结论：能出公网 / 只有内网 / 只有链路本地 */
function netV6Text(sum) {
  if (sum.ipv6) return '能出公网';
  if (sum.ipv6Local) return '只有内网 v6';
  return '只有链路本地（等于没有）';
}

window.LinkView = LinkView;
})();
