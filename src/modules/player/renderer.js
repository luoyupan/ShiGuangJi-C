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
        seeking: false, err: '', saving: 0, listOpen: true, fs: false, started: false
      };

      /* ---------------- DOM ---------------- */
      const video = el('video', { class: 'pl-video', preload: 'metadata', playsinline: '' });

      const title = el('div', { class: 'pl-title ellipsis', text: '没有打开的影片' });
      const subChip = el('span', { class: 'pl-chip pl-subchip', style: { display: 'none' } });

      const btnFile = el('button', { class: 'pl-btn pl-txt', onclick: () => openFile() }, '打开文件');
      const btnDir = el('button', { class: 'pl-btn pl-txt', onclick: () => openDir() }, '打开文件夹');
      const btnRefresh = el('button', { class: 'pl-btn', title: '重新扫描当前文件夹', onclick: () => rescan() },
        api.icon('refresh'));
      const btnSub = el('button', { class: 'pl-btn', title: '选择字幕文件（也可以自动找同名 .srt/.ass）', onclick: () => pickSub() },
        api.icon('type'));
      const btnList = el('button', { class: 'pl-btn', title: '播放列表', onclick: () => toggleList() },
        api.icon('list'));

      const top = el('div', { class: 'pl-top' },
        btnFile, btnDir, btnRefresh,
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

      const listBox = el('div', { class: 'pl-list' });
      const listWrap = el('div', { class: 'pl-aside' },
        el('div', { class: 'pl-aside-hd' },
          el('span', { text: '播放列表' }),
          el('span', { class: 'pl-count', text: '0' }),
          el('button', { class: 'pl-btn pl-mini', title: '清空列表', onclick: () => clearList() }, api.icon('trash'))),
        listBox);

      const wrap = el('div', { class: 'pl-wrap' }, top, el('div', { class: 'pl-body' }, stage, listWrap), ctrl);
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
        const cnt = listWrap.querySelector('.pl-count');
        if (cnt) cnt.textContent = String(S.list.length);
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

      /* ---------------- 打开 ---------------- */
      async function openFile() {
        try {
          const r = await call('openFile');
          if (!r || !r.path) return;
          setList([r], r.dir);
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
        try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
      };
    }
  });
})();
