/* ============================================================
 *  播放器插件界面（编进 player.dll 的 UI_JS 资源）
 * ------------------------------------------------------------
 *  解码交给 WebView2 的 <video>，这里只做「播放器该有的一切」：
 *  打开文件/文件夹、播放列表、进度、音量、倍速、全屏、截图、
 *  字幕（SRT/ASS 由后端转 VTT）、播放模式、记忆续播、快捷键。
 *
 *  🔴 video 的 src 是 http://127.0.0.1:<port>/local/…（同源 + 支持 Range），
 *     所以进度能拖、canvas 截图不会被跨域污染。
 * ============================================================ */
(function () {
  const { el } = window.util;

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  const MODES = [
    { id: 'list', name: '列表循环', icon: 'repeat' },
    { id: 'single', name: '单曲循环', icon: 'repeatOne' },
    { id: 'shuffle', name: '随机播放', icon: 'shuffle' }
  ];
  const SORTS = [
    ['name', '文件名（自然序）'],
    ['added', '最近添加'],
    ['size', '文件大小'],
    ['duration', '时长（短→长）']
  ];

  function fmtTime(t) {
    if (!isFinite(t) || t < 0) t = 0;
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
      : m + ':' + String(s).padStart(2, '0');
  }
  function baseName(p) {
    const s = String(p || '');
    const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function extOf(p) {
    const b = baseName(p);
    const i = b.lastIndexOf('.');
    return i >= 0 ? b.slice(i).toLowerCase() : '';
  }

  SGJPlugin.define({
    id: 'player',
    apiVersion: 1,
    mount(container, api) {
      const call = (m, ...a) => api.call(m, ...a);
      const S = {
        list: [], idx: -1, mode: 'list', rate: 1, volume: 0.8, muted: false,
        resume: true, subScale: 1, subName: '', subUrl: '', dir: '',
        seeking: false, err: '', saving: 0, listOpen: true, fs: false, started: false,
        /* 视图：lib = 视频库（左栏文件夹 + 右栏网格，和图片模块一个套路）/ play = 播放 */
        view: 'lib',
        roots: [], items: [], recent: [], scannedAt: 0, truncated: false,
        kw: '', sort: 'name', scope: 'all', scanning: false,
        thumbCache: Object.create(null),   /* path → dataURL / 'fail' */
        durCache: Object.create(null)      /* path → 秒（抽帧顺带量出来的） */
      };

      /* ---------------- DOM ---------------- */
      const video = el('video', { class: 'pl-video', preload: 'metadata', playsinline: '' });

      const title = el('div', { class: 'pl-title ellipsis', text: '没有打开的影片' });
      const subChip = el('span', { class: 'pl-chip pl-subchip', style: { display: 'none' } });

      const btnBack = el('button', { class: 'pl-btn', title: '回到视频库（Esc）', onclick: () => exitPlay() },
        api.icon('back'));
      const btnFile = el('button', { class: 'pl-btn pl-txt', onclick: () => openFile() }, '打开文件');
      const btnDir = el('button', { class: 'pl-btn pl-txt', onclick: () => openDir() }, '打开文件夹');
      const btnRefresh = el('button', { class: 'pl-btn', title: '重新扫描当前文件夹', onclick: () => rescan() },
        api.icon('refresh'));
      const btnSub = el('button', { class: 'pl-btn', title: '选择字幕文件（也可以自动找同名 .srt/.ass）', onclick: () => pickSub() },
        api.icon('type'));
      const btnList = el('button', { class: 'pl-btn', title: '显示/隐藏播放列表', onclick: () => toggleList() },
        api.icon('list'));

      const top = el('div', { class: 'pl-top' },
        btnBack, btnFile, btnDir, btnRefresh,
        el('div', { class: 'pl-grow' }, title),
        subChip, btnSub, btnList);

      const bigPlay = el('button', { class: 'pl-bigplay', title: '播放/暂停', onclick: () => toggle() }, api.icon('play'));
      const hint = el('div', { class: 'pl-hint', text: '把影片拖进来，或点左上角「打开文件 / 打开文件夹」' });
      const errBox = el('div', { class: 'pl-err', style: { display: 'none' } });
      const overlay = el('div', { class: 'pl-overlay' }, bigPlay, hint, errBox);

      const stage = el('div', { class: 'pl-stage' }, video, overlay);

      const seek = el('input', { class: 'pl-seek', type: 'range', min: '0', max: '1000', value: '0', step: '1' });
      const tCur = el('span', { class: 'pl-time', text: '0:00' });
      const tDur = el('span', { class: 'pl-time dim', text: '0:00' });
      const btnPrev = el('button', { class: 'pl-btn', title: '上一个（PgUp）', onclick: () => step(-1) }, api.icon('prev'));
      const btnPlay = el('button', { class: 'pl-btn pl-main', title: '播放/暂停（空格）', onclick: () => toggle() }, api.icon('play'));
      const btnNext = el('button', { class: 'pl-btn', title: '下一个（PgDn）', onclick: () => step(1) }, api.icon('next'));
      const btnStop = el('button', { class: 'pl-btn', title: '停止', onclick: () => stop() }, api.icon('stop'));
      const btnMode = el('button', { class: 'pl-btn', title: '播放模式', onclick: () => cycleMode() }, api.icon('repeat'));
      const btnMute = el('button', { class: 'pl-btn', title: '静音（M）', onclick: () => toggleMute() }, api.icon('music'));
      const vol = el('input', { class: 'pl-vol', type: 'range', min: '0', max: '100', value: '80', step: '1' });
      const btnRate = el('button', { class: 'pl-btn pl-txt', title: '倍速（[ 减速 / ] 加速）', onclick: () => cycleRate() }, '1.0x');
      const btnShot = el('button', { class: 'pl-btn', title: '截图（S）', onclick: () => shot() }, api.icon('crop'));
      const btnFs = el('button', { class: 'pl-btn', title: '全屏（F / 双击画面）', onclick: () => toggleFs() }, api.icon('grid'));

      const ctrl = el('div', { class: 'pl-ctrl' },
        el('div', { class: 'pl-seekrow' }, seek),
        el('div', { class: 'pl-btnrow' },
          btnPrev, btnPlay, btnNext, btnStop,
          el('span', { class: 'pl-times' }, tCur, el('span', { class: 'pl-slash', text: ' / ' }), tDur),
          el('div', { class: 'pl-grow' }),
          btnMode,
          el('span', { class: 'pl-volwrap' }, btnMute, vol),
          btnRate, btnShot, btnFs));

      /* ---------------- 播放视图：右侧播放列表 ---------------- */
      const listBox = el('div', { class: 'pl-list' });
      const hdCount = el('span', { class: 'pl-count', text: '0' });
      const listWrap = el('div', { class: 'pl-aside' },
        el('div', { class: 'pl-aside-hd' },
          el('span', { text: '播放列表' }), el('div', { class: 'pl-grow' }), hdCount,
          el('button', { class: 'pl-btn pl-mini', title: '清空播放列表', onclick: () => clearList() },
            api.icon('trash'))),
        listBox);

      const playView = el('div', { class: 'pl-wrap' },
        top, el('div', { class: 'pl-body' }, stage, listWrap), ctrl);

      /* ---------------- 库视图：左栏文件夹 + 右栏网格（和图片模块一个套路） ---------------- */
      const sideEl = el('aside', { class: 'gside' });
      const mainEl = el('section', { class: 'gmain' });
      const libView = el('div', { class: 'games pl-libview' }, sideEl, mainEl);

      const wrap = el('div', { class: 'pl-root' }, libView, playView);
      container.appendChild(wrap);

      /* ---------------- 基础操作 ---------------- */
      function setTitle(t) { title.textContent = t || '没有打开的影片'; title.title = t || ''; }
      function showHint(on) { hint.style.display = on ? '' : 'none'; }
      function showErr(msg, withExternal) {
        S.err = msg || '';
        if (!msg) { errBox.style.display = 'none'; return; }
        errBox.textContent = '';
        errBox.appendChild(el('div', { class: 'pl-err-t', text: msg }));
        if (withExternal && S.list[S.idx]) {
          errBox.appendChild(el('button', {
            class: 'btn btn-sm', onclick: () => call('openExternal', S.list[S.idx].path).catch(() => {}),
            text: '用系统播放器打开'
          }));
        }
        errBox.style.display = '';
      }
      function current() { return S.idx >= 0 ? S.list[S.idx] : null; }

      function paintList() {
        listBox.textContent = '';
        hdCount.textContent = String(S.list.length);
        if (!S.list.length) {
          listBox.appendChild(el('div', { class: 'pl-empty', text: '列表是空的' }));
          return;
        }
        S.list.forEach((it, i) => {
          const row = el('div', {
            class: 'pl-item' + (i === S.idx ? ' on' : ''),
            title: it.path,
            onclick: () => playAt(i)
          },
            el('span', { class: 'pl-idx', text: String(i + 1) }),
            el('div', { class: 'pl-nm ellipsis', text: it.name || baseName(it.path) }),
            el('button', {
              class: 'pl-x', title: '从列表移除',
              onclick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); removeAt(i); }
            }, '×'));
          listBox.appendChild(row);
        });
        const on = listBox.querySelector('.pl-item.on');
        if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
      }
      function setList(items, dir) {
        S.list = (items || []).slice();
        S.dir = dir || '';
        S.idx = -1;
        paintList();
      }
      function removeAt(i) {
        if (i < 0 || i >= S.list.length) return;
        const wasCur = i === S.idx;
        S.list.splice(i, 1);
        if (i < S.idx) S.idx--;
        else if (wasCur) { S.idx = Math.min(i, S.list.length - 1); }
        paintList();
        if (wasCur) { if (S.list.length) playAt(S.idx); else stop(); }
      }
      function clearList() {
        stop();
        S.list = [];
        S.idx = -1;
        paintList();
        setTitle('');
      }
      function toggleList() {
        S.listOpen = !S.listOpen;
        listWrap.style.display = S.listOpen ? '' : 'none';
      }

      /* ============================================================
         库视图：左栏文件夹 + 右栏网格
         跟图片模块一个套路（.games/.gside/.gmain 外壳直接复用），
         只是卡片是视频：首帧当封面、角上标时长、底部一条观看进度。
         ============================================================ */
      function setView(v) {
        S.view = v === 'play' ? 'play' : 'lib';
        libView.style.display = S.view === 'lib' ? '' : 'none';
        playView.style.display = S.view === 'play' ? '' : 'none';
        if (S.view === 'lib') { renderSide(); renderMain(); }
      }
      function exitPlay() {
        saveNow(true);
        try { video.pause(); } catch { /* 没 src 时 pause 会抛 */ }
        setView('lib');
      }
      function progOf(p) {
        const r = S.recent.find((x) => x.path === p);
        return r ? { pos: r.pos || 0, dur: r.dur || 0 } : { pos: 0, dur: 0 };
      }
      function durOf(it) { return S.durCache[it.path] || progOf(it.path).dur || 0; }
      function countIn(root) {
        const r = String(root).toLowerCase();
        return S.items.filter((x) => String(x.path || '').toLowerCase().startsWith(r)).length;
      }
      function fmtClock(ts) {
        const d = new Date(Number(ts) || 0);
        const p = (n) => String(n).padStart(2, '0');
        return d.getFullYear()
          ? d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
          : '';
      }

      /* ---------------- 左栏 ---------------- */
      function renderSide() {
        sideEl.textContent = '';
        sideEl.appendChild(el('div', { class: 'mods-side-head' },
          el('button', { class: 'back-btn', title: '回主界面', onclick: () => window.Shell.go('#/') },
            api.icon('back'), '返回'),
          el('h2', { text: '播放器' })));

        sideEl.appendChild(el('div', { class: 'pv-act' },
          el('button', { class: 'btn btn-primary btn-sm', title: '添加一个放着视频的文件夹', onclick: () => addRoot() },
            api.icon('plus'), '添加文件夹'),
          el('button', { class: 'btn btn-sm' + (S.scanning ? ' is-busy' : ''), title: '重新扫描所有文件夹', onclick: () => rescanLib() },
            api.icon('refresh'), S.scanning ? '扫描中…' : '重新扫描')));

        const list = el('div', { class: 'gside-list' });
        sideEl.appendChild(list);
        if (!S.roots.length) {
          list.appendChild(el('div', { class: 'pv-side-empty' },
            el('p', { class: 'text-dim', text: '还没有添加文件夹' })));
        } else {
          S.roots.forEach((r) => {
            /* 显示「文件夹名 + 上级路径」而不是整条：整条一上来就被省略号吃掉 */
            const seg = String(r).replace(/[\\/]+$/, '').split(/[\\/]/);
            const leaf = seg[seg.length - 1] || r;
            const parent = seg.slice(0, -1).join('\\');
            list.appendChild(el('div', { class: 'pv-root', title: r },
              api.icon('folder'),
              el('div', { class: 'pv-root-m' },
                el('div', { class: 'pv-root-n', text: leaf }),
                el('div', { class: 'pv-root-s', text: countIn(r) + ' 个 · ' + parent })),
              el('button', {
                class: 'pv-root-x', title: '移除这个文件夹（不动文件）',
                onclick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); removeRoot(r); }
              }, api.icon('close'))));
          });
        }

        /* 底部统计：一共多少、看过多少 —— 一眼判断库有没有扫进来。
           ⚠️ 不显示「总时长」：时长是抽帧时顺手量出来的，只覆盖已经滚到的卡片，
              写个偏小的总数比不写更误导。 */
        const watched = S.items.filter((x) => progOf(x.path).pos > 5).length;
        sideEl.appendChild(el('div', { class: 'pv-stat' },
          el('div', { class: 'pv-stat-l' },
            el('span', { class: 'text-dim', text: '共' }), el('b', { text: String(S.items.length) }),
            el('span', { class: 'text-dim', text: '个视频' })),
          el('div', { class: 'pv-stat-l' }, el('span', { class: 'pv-dot' }), el('span', { text: '看过 ' + watched })),
          S.scannedAt ? el('div', { class: 'pv-stat-l' },
            el('span', { class: 'text-dim', text: '上次扫描 ' + fmtClock(S.scannedAt) })) : null));
      }

      /* ---------------- 右栏：工具行 + 网格 ---------------- */
      function renderMain() {
        mainEl.textContent = '';
        const bar = el('div', { class: 'pv-bar' },
          el('div', { class: 'pv-tabs' },
            el('button', {
              class: 'pv-tab' + (S.scope === 'all' ? ' on' : ''), title: '文件夹里的全部视频',
              onclick: () => { S.scope = 'all'; renderMain(); }
            }, api.icon('grid'), '全部'),
            el('button', {
              class: 'pv-tab' + (S.scope === 'recent' ? ' on' : ''), title: '播放过的（接着看）',
              onclick: () => { S.scope = 'recent'; renderMain(); }
            }, api.icon('clock'), '最近看过')),
          el('div', { class: 'pv-bar-right' },
            api.icon('search'),
            el('input', {
              class: 'pv-kw', type: 'text', placeholder: '搜文件名…', value: S.kw,
              oninput: (e) => { S.kw = e.target.value; paintWall(); }
            })),
          el('select', {
            class: 'pv-sel', title: '排序方式',
            onchange: (e) => { S.sort = e.target.value; paintWall(); }
          }, SORTS.map(([v, t]) => el('option', { value: v, selected: S.sort === v, text: t }))),
          S.scope === 'recent' && S.recent.length
            ? el('button', {
              class: 'btn btn-sm', title: '清空「最近看过」记录（不动文件）', onclick: () => clearRecent()
            }, api.icon('trash'), '清空')
            : null,
          el('button', { class: 'btn btn-sm btn-primary', title: '直接挑一个视频播', onclick: () => openFile() },
            api.icon('play'), '打开文件'));
        mainEl.appendChild(bar);
        const body = el('div', { class: 'pv-body' });
        mainEl.appendChild(body);
        paintWallTo(body);
      }

      function sourceList() {
        return S.scope === 'recent'
          ? S.recent.map((r) => ({ path: r.path, name: r.name || baseName(r.path), size: 0, mtime: (r.at || 0) * 1000 }))
          : S.items;
      }
      function sortedList() {
        const src = sourceList();
        const kw = String(S.kw || '').trim().toLowerCase();
        const out = kw ? src.filter((x) => String(x.name || '').toLowerCase().includes(kw)) : src.slice();
        /* 自然序：数字感知（EP2 在 EP10 前）+ 拉丁/数字打头的排在前、中文名的排在后。
           只靠 localeCompare('zh', {numeric:true}) 会把「番外」排到 EP 系列前面 ——
           按集数命名的剧集列表里那样很反直觉。 */
        const nat = (a, b) => {
          const A = String(a || ''), B = String(b || '');
          const aAscii = /^[\x00-\x7f]/.test(A), bAscii = /^[\x00-\x7f]/.test(B);
          if (aAscii !== bAscii) return aAscii ? -1 : 1;
          return A.localeCompare(B, 'zh', { numeric: true, sensitivity: 'base' });
        };
        if (S.sort === 'added') out.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
        else if (S.sort === 'size') out.sort((a, b) => (b.size || 0) - (a.size || 0));
        else if (S.sort === 'duration') out.sort((a, b) => durOf(a) - durOf(b));
        else out.sort((a, b) => nat(a.name, b.name));
        return out;
      }
      function paintWall() {
        const body = mainEl.querySelector('.pv-body');
        if (body) paintWallTo(body);
      }
      function paintWallTo(body) {
        body.textContent = '';
        const items = sortedList();
        if (!S.items.length && !S.recent.length) {
          body.appendChild(el('div', { class: 'pv-empty' },
            el('div', { class: 'pv-empty-ic' }, api.icon('folder')),
            el('p', { class: 'text-dim', text: '还没有视频。先在左边添加一个放着视频的文件夹。' }),
            el('button', { class: 'btn btn-primary btn-sm', onclick: () => addRoot() }, '添加文件夹')));
          return;
        }
        if (!items.length) {
          body.appendChild(el('div', { class: 'pv-empty' },
            el('p', { class: 'text-dim', text: S.scope === 'recent' ? '还没有播放记录' : '没有匹配的视频' })));
          return;
        }
        const grid = el('div', { class: 'pv-grid' });
        items.forEach((it) => grid.appendChild(card(it, items)));
        body.appendChild(grid);
        ensureThumbs(body);
      }

      function card(it, list) {
        const pr = progOf(it.path);
        const d = durOf(it);
        const pct = (pr.dur > 0 && pr.pos > 0) ? Math.max(0, Math.min(100, pr.pos / pr.dur * 100)) : 0;
        return el('div', {
          class: 'pv-card', title: it.path, dataset: { path: it.path },
          onclick: () => enterPlay(list, it)
        },
          el('div', { class: 'pv-thumb' },
            el('img', { dataset: { file: it.path }, alt: it.name || '' }),
            el('span', { class: 'pv-play' }, api.icon('play')),
            d ? el('span', { class: 'pv-dur', text: fmtTime(d) }) : null,
            pct ? el('div', { class: 'pv-prog' }, el('i', { style: { width: pct.toFixed(1) + '%' } })) : null),
          el('div', { class: 'pv-meta' },
            el('div', { class: 'pv-name', text: it.name || baseName(it.path) }),
            el('div', { class: 'pv-sub', text: subOf(pr, d) })),
          S.scope === 'recent' ? el('button', {
            class: 'pv-x', title: '从「最近看过」移除（不删文件）',
            onclick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); removeRecent(it.path); }
          }, api.icon('close')) : null);
      }
      function subOf(pr, d) {
        if (pr.pos > 5 && pr.dur > 0) return '看到 ' + fmtTime(pr.pos) + ' / ' + fmtTime(pr.dur);
        if (d > 0) return fmtTime(d);
        return '还没看过';
      }

      /* ---- 封面：自己抽首帧（WebView2 解不了的就留占位块，不报错） ---- */
      const TH_MAX = 3;              /* 同时解码 3 个够了，再多会把界面拖卡 */
      let thBusy = 0;
      const thQueue = [];
      function ensureThumbs(box) {
        if (!S.io) {
          S.io = new IntersectionObserver((ents) => {
            ents.forEach((en) => {
              if (!en.isIntersecting) return;
              S.io.unobserve(en.target);
              thQueue.push(en.target);
              pumpThumbs();
            });
          }, { rootMargin: '260px 0px' });
        }
        box.querySelectorAll('img[data-file]').forEach((img) => {
          const p = img.dataset.file;
          const hit = S.thumbCache[p];
          if (hit === 'fail') { img.classList.add('bad'); img.removeAttribute('data-file'); return; }
          if (hit) { img.src = hit; img.classList.add('on'); img.removeAttribute('data-file'); return; }
          if (!img.dataset.queued) { img.dataset.queued = '1'; S.io.observe(img); }
        });
      }
      function pumpThumbs() {
        while (thBusy < TH_MAX && thQueue.length) {
          const img = thQueue.shift();
          if (!img || !img.isConnected) continue;
          const path = img.dataset.file;
          thBusy++;
          grabFrame(path).then((res) => {
            if (res && res.data) {
              S.thumbCache[path] = res.data;
              if (res.dur) { S.durCache[path] = res.dur; paintDurOn(path, res.dur); }
              if (img.isConnected) { img.src = res.data; img.classList.add('on'); }
            } else {
              S.thumbCache[path] = 'fail';
              if (img.isConnected) img.classList.add('bad');
            }
          }).catch(() => { /* 抽帧失败就是没封面，不影响列表 */ })
            .finally(() => { thBusy--; pumpThumbs(); });
        }
      }
      function grabFrame(path) {
        return new Promise((resolve) => {
          call('stat', path).then((st) => {
            if (!st || !st.url) return resolve(null);
            const v = document.createElement('video');
            v.preload = 'auto';
            v.muted = true;
            v.playsInline = true;
            let done = false;
            const finish = (r) => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              try { v.removeAttribute('src'); v.load(); } catch { /* ignore */ }
              resolve(r);
            };
            const timer = setTimeout(() => finish(null), 9000);
            v.addEventListener('loadeddata', () => {
              /* 跳到 12% 处抽，避开片头黑场；太长的片子最多跳 5 分钟处 */
              try { v.currentTime = Math.min(Math.max(0.2, (v.duration || 0) * 0.12), 300); }
              catch { finish({ data: snapFrame(v), dur: v.duration || 0 }); }
            }, { once: true });
            v.addEventListener('seeked', () => finish({ data: snapFrame(v), dur: v.duration || 0 }), { once: true });
            v.addEventListener('error', () => finish(null), { once: true });
            v.src = st.url;
          }).catch(() => resolve(null));
        });
      }
      function snapFrame(v) {
        if (!v || !v.videoWidth) return null;
        const w = 320;
        const h = Math.max(1, Math.round(w * v.videoHeight / v.videoWidth));
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        try {
          cv.getContext('2d').drawImage(v, 0, 0, w, h);
          return cv.toDataURL('image/jpeg', 0.72);
        } catch { return null; }
      }
      function paintDurOn(path, dur) {
        Array.from(mainEl.querySelectorAll('.pv-card')).forEach((c) => {
          if (c.dataset.path !== path) return;
          let b = c.querySelector('.pv-dur');
          if (!b) {
            b = el('span', { class: 'pv-dur' });
            const th = c.querySelector('.pv-thumb');
            if (th) th.appendChild(b);
          }
          b.textContent = fmtTime(dur);
          const sub = c.querySelector('.pv-sub');
          const pr = progOf(path);
          if (sub && !(pr.pos > 5 && pr.dur > 0)) sub.textContent = fmtTime(dur);
        });
      }

      /* ---------------- 库数据 ---------------- */
      async function loadLib() {
        try {
          const r = await call('roots');
          if (r && Array.isArray(r.items)) {
            S.roots = Array.isArray(r.roots) ? r.roots : [];
            S.items = r.items;
            S.truncated = !!r.truncated;
            S.scannedAt = Date.now();
          }
        } catch (e) { api.toast('读取视频库失败：' + e.message, 'err'); }
        try {
          const rc = await call('recent');
          if (Array.isArray(rc)) S.recent = rc;
        } catch { /* 最近记录读不到不影响网格 */ }
        renderSide();
        renderMain();
      }
      async function addRoot() {
        try {
          const r = await call('pickRoot');
          if (!r) return;
          if (Array.isArray(r.roots)) S.roots = r.roots;
          if (Array.isArray(r.items)) S.items = r.items;
          S.scannedAt = Date.now();
          const rc = await call('recent').catch(() => null);
          if (Array.isArray(rc)) S.recent = rc;
          renderSide();
          renderMain();
          if (!S.items.length) api.toast('这个文件夹里没有找到视频文件', 'err');
          else api.toast('已添加：' + (r.dir || '') + '（共 ' + S.items.length + ' 个视频）', 'ok');
        } catch (e) { api.toast('添加失败：' + e.message, 'err'); }
      }
      async function removeRoot(p) {
        try { await call('removeRoot', p); } catch { /* ignore */ }
        const low = String(p).toLowerCase();
        S.roots = S.roots.filter((x) => String(x).toLowerCase() !== low);
        S.items = S.items.filter((x) => !String(x.path || '').toLowerCase().startsWith(low));
        renderSide();
        renderMain();
        api.toast('已移除文件夹（文件都还在）');
      }
      async function rescanLib() {
        if (S.scanning) return;
        S.scanning = true;
        renderSide();
        api.toast('正在扫描…', 'info');
        try {
          const r = await call('roots');
          if (r && Array.isArray(r.items)) {
            S.roots = Array.isArray(r.roots) ? r.roots : S.roots;
            S.items = r.items;
            S.truncated = !!r.truncated;
            S.scannedAt = Date.now();
          }
          const rc = await call('recent').catch(() => null);
          if (Array.isArray(rc)) S.recent = rc;
          api.toast('已刷新：' + S.items.length + ' 个视频', 'ok');
        } catch (e) { api.toast('刷新失败：' + e.message, 'err'); }
        S.scanning = false;
        renderSide();
        renderMain();
      }
      async function removeRecent(p) {
        try { await call('libRemove', p); } catch { /* ignore */ }
        S.recent = S.recent.filter((x) => x.path !== p);
        renderMain();
      }
      async function clearRecent() {
        try { await call('libClear'); } catch { /* ignore */ }
        S.recent = [];
        renderMain();
        api.toast('「最近看过」已清空（文件都还在）', 'ok');
      }
      /* 记一条「最近看过」（播放过的由 playAt 里的 mark 记，这里补「加进列表但还没播」的） */
      async function libTouch(paths) {
        const arr = (paths || []).filter((p) => !!p);
        if (!arr.length) return;
        try { await call('libTouch', arr); } catch { /* 记录失败不影响播放 */ }
        const rc = await call('recent').catch(() => null);
        if (Array.isArray(rc)) S.recent = rc;
      }
      async function enterPlay(items, it) {
        const arr = (items || []).filter((x) => x && x.path);
        const at = arr.findIndex((x) => x.path === it.path);
        if (at < 0) return;
        setList(arr.map((x) => ({ path: x.path, name: x.name, url: x.url || '' })), '');
        setView('play');
        await playAt(at);
      }

      /* ---------------- 打开 ---------------- */
      async function openFile() {
        try {
          const r = await call('openFile');
          if (!r || !r.path) return;
          setList([r], r.dir);
          setView('play');
          libTouch([r.path]);
          await playAt(0);
        } catch (e) { api.toast('打开失败：' + e.message, 'err'); }
      }
      async function openDir() {
        try {
          api.toast('正在扫描文件夹…', 'info');
          const r = await call('openDir');
          if (!r || !r.items) return;
          setList(r.items, r.dir);
          if (!S.list.length) { api.toast('这个文件夹里没有找到视频文件', 'err'); return; }
          api.toast('找到 ' + S.list.length + ' 个视频' + (r.truncated ? '（太多，只取了前 3000 个）' : ''), 'ok');
          setView('play');
          libTouch(S.list.map((x) => x.path));
          await playAt(0);
        } catch (e) { api.toast('扫描失败：' + e.message, 'err'); }
      }
      async function rescan() {
        if (!S.dir) return api.toast('还没有打开过文件夹', 'err');
        try {
          const keep = current();
          const r = await call('scan', S.dir);
          if (!r || !r.items) return;
          setList(r.items, r.dir);
          const at = keep ? S.list.findIndex((x) => x.path === keep.path) : -1;
          if (at >= 0) { S.idx = at; paintList(); }
          api.toast('已刷新：' + S.list.length + ' 个视频', 'ok');
        } catch (e) { api.toast('刷新失败：' + e.message, 'err'); }
      }

      /* ---------------- 播放 ---------------- */
      async function playAt(i, opts) {
        if (i < 0 || i >= S.list.length) return;
        saveNow(true);
        detachSub();
        const it = S.list[i];
        S.idx = i;
        paintList();
        setTitle(it.name || baseName(it.path));
        showErr('');
        showHint(false);
        S.started = false;
        /* 「最近看过」的条目只存了路径，播之前现问一次 url（/local/…，宿主支持 Range） */
        if (!it.url) {
          const st = await call('stat', it.path).catch(() => null);
          if (st && st.url) it.url = st.url;
        }
        video.src = it.url || '';
        video.load();
        try { await call('mark', it.path); } catch { /* 最近播放失败不影响播放 */ }
        /* 续播：只在「干净打开」时跳（用户自己拖过进度就别回跳了） */
        if (!opts || opts.resume !== false) {
          const pr = await call('progress:get', it.path).catch(() => null);
          if (pr && pr.pos > 5 && (!pr.dur || pr.pos < pr.dur * 0.95)) {
            const pos = pr.pos;
            const jump = () => {
              if (Math.abs(video.currentTime - pos) > 1.5) {
                video.currentTime = pos;
                api.toast('从上次的 ' + fmtTime(pos) + ' 继续', 'ok');
              }
            };
            video.addEventListener('loadedmetadata', jump, { once: true });
          }
        }
        /* 自动字幕：同名字幕 / 目录里唯一一份 */
        try {
          const sr = await call('subtitle', it.path);
          if (sr && sr.found) applySub(sr.vtt, sr.name);
        } catch { /* 没字幕很正常 */ }
        video.play().catch(() => { /* 自动播放被拦时用户点一下就好 */ });
      }
      function step(d) {
        if (!S.list.length) return;
        if (S.mode === 'shuffle') return playAt(Math.floor(Math.random() * S.list.length), { resume: false });
        let n = S.idx + d;
        if (n < 0) n = S.list.length - 1;
        if (n >= S.list.length) n = 0;
        playAt(n, { resume: false });
      }
      function onEnded() {
        if (S.mode === 'single') { video.currentTime = 0; video.play().catch(() => {}); return; }
        step(1);
      }
      function toggle() {
        if (!video.src) { if (!S.list.length) return openFile(); return playAt(Math.max(0, S.idx)); }
        if (video.paused) video.play().catch((e) => api.toast('播不了：' + e.message, 'err'));
        else video.pause();
      }
      function stop() {
        video.pause();
        video.removeAttribute('src');
        video.load();
        S.started = false;
        btnPlay.textContent = '';
        btnPlay.appendChild(api.icon('play'));
        bigPlay.style.display = '';
        showHint(true);
        tCur.textContent = '0:00';
        tDur.textContent = '0:00';
        seek.value = '0';
      }
      function setPlayIcon(playing) {
        btnPlay.textContent = '';
        btnPlay.appendChild(api.icon(playing ? 'pause' : 'play'));
        bigPlay.textContent = '';
        bigPlay.appendChild(api.icon(playing ? 'pause' : 'play'));
        bigPlay.style.display = playing ? 'none' : '';
      }

      /* ---------------- 进度 / 音量 / 倍速 ---------------- */
      video.addEventListener('loadedmetadata', () => {
        tDur.textContent = fmtTime(video.duration);
        seek.value = '0';
      });
      video.addEventListener('timeupdate', () => {
        if (!S.seeking && isFinite(video.duration) && video.duration > 0) {
          seek.value = String(Math.round(video.currentTime / video.duration * 1000));
          tCur.textContent = fmtTime(video.currentTime);
        }
        saveNow(false);
      });
      video.addEventListener('play', () => { setPlayIcon(true); showHint(false); S.started = true; });
      video.addEventListener('pause', () => { setPlayIcon(false); saveNow(true); });
      video.addEventListener('ended', onEnded);
      video.addEventListener('error', () => {
        const it = current();
        const ext = it ? extOf(it.path) : '';
        showErr('这个文件网页内核播不了' + (ext ? '（' + ext + '）' : '') +
          '：可能是 HEVC/H.265、AVI/WMV/RMVB 这类封装或缺少解码器。', true);
        setPlayIcon(false);
      });
      video.addEventListener('dblclick', () => toggleFs());

      seek.addEventListener('input', () => {
        S.seeking = true;
        if (isFinite(video.duration) && video.duration > 0) {
          tCur.textContent = fmtTime(video.currentTime = video.duration * (Number(seek.value) / 1000));
        }
      });
      seek.addEventListener('change', () => { S.seeking = false; });

      vol.addEventListener('input', () => {
        S.volume = Number(vol.value) / 100;
        S.muted = false;
        video.volume = S.volume;
        video.muted = false;
        paintVol();
        saveSettings({ volume: S.volume, muted: false });
      });
      function paintVol() {
        btnMute.textContent = '';
        btnMute.appendChild(api.icon(S.muted || S.volume === 0 ? 'lock' : 'music'));
        btnMute.title = S.muted ? '取消静音（M）' : '静音（M）';
        vol.value = String(Math.round((S.muted ? 0 : S.volume) * 100));
      }
      function toggleMute() {
        S.muted = !S.muted;
        video.muted = S.muted;
        paintVol();
        saveSettings({ muted: S.muted });
      }
      function applyRate(r) {
        S.rate = r;
        video.playbackRate = r;
        btnRate.textContent = r.toFixed(r % 1 === 0 ? 1 : 2) + 'x';
        saveSettings({ rate: r });
      }
      function cycleRate() {
        const i = SPEEDS.indexOf(S.rate);
        applyRate(SPEEDS[(i + 1) % SPEEDS.length]);
        api.toast('倍速 ' + S.rate + 'x', 'ok');
      }

      /* ---------------- 播放模式 ---------------- */
      function paintMode() {
        const m = MODES.find((x) => x.id === S.mode) || MODES[0];
        btnMode.textContent = '';
        btnMode.appendChild(api.icon(m.icon));
        btnMode.title = '播放模式：' + m.name + '（点击切换）';
      }
      function cycleMode() {
        const i = MODES.findIndex((x) => x.id === S.mode);
        S.mode = MODES[(i + 1) % MODES.length].id;
        paintMode();
        saveSettings({ mode: S.mode });
        api.toast('播放模式：' + (MODES.find((x) => x.id === S.mode) || MODES[0]).name, 'ok');
      }

      /* ---------------- 字幕 ---------------- */
      function detachSub() {
        [...video.querySelectorAll('track')].forEach((t) => t.remove());
        if (S.subUrl) { try { URL.revokeObjectURL(S.subUrl); } catch { /* ignore */ } }
        S.subUrl = '';
        S.subName = '';
        subChip.style.display = 'none';
      }
      function applySub(vtt, name) {
        if (!vtt) return;
        detachSub();
        try {
          const blob = new Blob([vtt], { type: 'text/vtt;charset=utf-8' });
          S.subUrl = URL.createObjectURL(blob);
          const tr = document.createElement('track');
          tr.kind = 'subtitles';
          tr.label = name || '字幕';
          tr.srclang = 'zh';
          tr.src = S.subUrl;
          tr.default = true;
          video.appendChild(tr);
          /* track 必须在加进 DOM 后手动点亮，否则默认不显示 */
          setTimeout(() => {
            const list = video.textTracks;
            for (let i = 0; i < list.length; i++) list[i].mode = 'showing';
          }, 60);
          S.subName = name || '字幕';
          subChip.textContent = '字幕 · ' + S.subName;
          subChip.style.display = '';
          subChip.title = '已加载：' + S.subName + '（点「字幕」按钮换一份）';
        } catch (e) { api.toast('字幕挂载失败：' + e.message, 'err'); }
      }
      async function pickSub() {
        const it = current();
        if (!it) return api.toast('先打开一个视频', 'err');
        try {
          const r = await call('pickSubtitle');
          if (!r || !r.found) return api.toast((r && r.error) || '这份字幕读不出来', 'err');
          applySub(r.vtt, r.name);
          api.toast('字幕已加载：' + r.name, 'ok');
        } catch (e) { api.toast('字幕加载失败：' + e.message, 'err'); }
      }
      /* 字幕字号缩放：直接改 video::cue 的样式表 */
      const cueStyle = document.createElement('style');
      document.head.appendChild(cueStyle);
      function applySubScale(k) {
        S.subScale = k;
        cueStyle.textContent = 'video::cue{font-size:' + Math.round((3.2 * k) * 100) / 100 + 'vh;' +
          'background:rgba(0,0,0,.45);color:#fff;text-shadow:0 1px 2px #000;}';
        saveSettings({ subScale: k });
      }

      /* ---------------- 截图 ---------------- */
      async function shot() {
        const it = current();
        if (!it || !video.videoWidth) return api.toast('还没有画面可截', 'err');
        try {
          const cv = document.createElement('canvas');
          cv.width = video.videoWidth;
          cv.height = video.videoHeight;
          cv.getContext('2d').drawImage(video, 0, 0, cv.width, cv.height);
          const data = cv.toDataURL('image/png');
          const r = await call('shot', it.path, data);
          api.toast('截图已保存：' + (r && r.path ? baseName(r.path) : '成功'), 'ok');
        } catch (e) { api.toast('截图失败：' + e.message, 'err'); }
      }

      /* ---------------- 全屏 ---------------- */
      function toggleFs() {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else if (wrap.requestFullscreen) wrap.requestFullscreen().catch(() => api.toast('这台机器不让全屏', 'err'));
      }
      document.addEventListener('fullscreenchange', onFsChange);
      function onFsChange() {
        S.fs = !!document.fullscreenElement;
        wrap.classList.toggle('is-fs', S.fs);
        btnFs.textContent = '';
        btnFs.appendChild(api.icon(S.fs ? 'close' : 'grid'));
      }

      /* ---------------- 设置 / 进度持久化 ---------------- */
      let settingsTimer = 0;
      function saveSettings(patch) {
        clearTimeout(settingsTimer);
        settingsTimer = setTimeout(() => { call('setSettings', patch).catch(() => {}); }, 400);
      }
      function saveNow(force) {
        const it = current();
        if (!it || !video.duration || !isFinite(video.duration)) return;
        const now = Date.now();
        if (!force && now - S.saving < 3000) return;
        S.saving = now;
        if (!S.resume) return;
        call('progress:save', it.path, { pos: video.currentTime, dur: video.duration }).catch(() => {});
      }

      /* ---------------- 快捷键 ---------------- */
      function onKey(e) {
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) {
          if (e.key !== 'Escape') return;
        }
        const k = e.key;
        /* 库视图里只认 Esc 和输入框，播放的快捷键别在网格上乱响应 */
        if (S.view === 'lib') return;
        if (k === 'Escape') { exitPlay(); return; }
        if (k === ' ' || k === 'Spacebar') { e.preventDefault(); toggle(); return; }
        if (k === 'ArrowLeft') { e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - (e.shiftKey ? 30 : 5)); return; }
        if (k === 'ArrowRight') { e.preventDefault(); video.currentTime = Math.min(video.duration || 0, video.currentTime + (e.shiftKey ? 30 : 5)); return; }
        if (k === 'ArrowUp') { e.preventDefault(); S.volume = Math.min(1, S.volume + 0.05); S.muted = false; video.volume = S.volume; video.muted = false; paintVol(); saveSettings({ volume: S.volume, muted: false }); return; }
        if (k === 'ArrowDown') { e.preventDefault(); S.volume = Math.max(0, S.volume - 0.05); video.volume = S.volume; paintVol(); saveSettings({ volume: S.volume }); return; }
        if (k === 'f' || k === 'F') { toggleFs(); return; }
        if (k === 'm' || k === 'M') { toggleMute(); return; }
        if (k === 's' || k === 'S') { shot(); return; }
        if (k === '[') { const i = SPEEDS.indexOf(S.rate); applyRate(SPEEDS[Math.max(0, i - 1)]); return; }
        if (k === ']') { const i = SPEEDS.indexOf(S.rate); applyRate(SPEEDS[Math.min(SPEEDS.length - 1, i + 1)]); return; }
        if (k === 'PageUp') { e.preventDefault(); step(-1); return; }
        if (k === 'PageDown') { e.preventDefault(); step(1); return; }
      }
      window.addEventListener('keydown', onKey);

      /* 页面切走 / 关闭前把进度存下来 */
      function onHide() { saveNow(true); }
      window.addEventListener('beforeunload', onHide);

      /* ---------------- 拖文件进来 ---------------- */
      function onDragOver(e) { e.preventDefault(); wrap.classList.add('drop'); }
      function onDragLeave() { wrap.classList.remove('drop'); }
      async function onDrop(e) {
        e.preventDefault();
        wrap.classList.remove('drop');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!f) return;
        /* 浏览器给的 File 对象**拿不到真实路径**，只能当临时文件播（不能记忆进度） */
        const url = URL.createObjectURL(f);
        S.list = [{ path: f.name, name: f.name, url }];
        S.idx = 0;
        paintList();
        setView('play');
        setTitle(f.name);
        showErr('');
        video.src = url;
        video.play().catch(() => {});
        api.toast('已加入：' + f.name + '（临时文件，不支持记忆进度）', 'ok');
      }
      wrap.addEventListener('dragover', onDragOver);
      wrap.addEventListener('dragleave', onDragLeave);
      wrap.addEventListener('drop', onDrop);

      /* ---------------- 初始化 ---------------- */
      (async function init() {
        paintMode();
        paintVol();
        paintList();
        setView('lib');
        try { await loadLib(); } catch { /* 库读不到就空着 */ }
        try {
          const st = await call('settings');
          if (st) {
            S.volume = typeof st.volume === 'number' ? st.volume : 0.8;
            S.muted = !!st.muted;
            S.rate = typeof st.rate === 'number' ? st.rate : 1;
            S.mode = st.mode || 'list';
            S.resume = st.resume !== false;
            if (st.subScale) applySubScale(st.subScale); else applySubScale(1);
            S.dir = st.lastDir || '';
          }
        } catch { /* 设置读不到就用默认值 */ }
        video.volume = S.volume;
        video.muted = S.muted;
        video.playbackRate = S.rate;
        btnRate.textContent = S.rate.toFixed(1) + 'x';
        paintMode();
        paintVol();
        api.log('player ready', { volume: S.volume, rate: S.rate, mode: S.mode });
      })();

      return () => {
        saveNow(true);
        detachSub();
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('beforeunload', onHide);
        document.removeEventListener('fullscreenchange', onFsChange);
        if (cueStyle && cueStyle.parentNode) cueStyle.parentNode.removeChild(cueStyle);
        /* IntersectionObserver 不 disconnect 会一直盯着已卸载的 img，抽帧队列也要清掉 */
        if (S.io) { try { S.io.disconnect(); } catch { /* ignore */ } S.io = null; }
        thQueue.length = 0;
        try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
      };
    }
  });
})();
