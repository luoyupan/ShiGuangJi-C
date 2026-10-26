/* ============================================================
 *  拾光集 · 播放器模块（player.dll）
 * ------------------------------------------------------------
 *  纯内嵌播放器：界面用 WebView2 的 <video>，后端只做「文件与数据」的活：
 *  选文件 / 扫文件夹 / 读字幕转 VTT / 存播放进度 / 截图落盘 / 设置。
 *
 *  🔴 为什么解码不在 C 里做：WebView2 自带 H.264/VP8/VP9/AV1 与 AAC/Opus，
 *     自己接 FFmpeg 会让 dll 从 200KB 变成 60MB，而且要和界面抢渲染。
 *     内嵌播不了的封装（部分 avi/wmv/rmvb/HEVC）在前端会提示「用系统播放器打开」。
 *
 *  🔴 视频走 /local/<path>（http://127.0.0.1:<port>），宿主那层支持 Range，
 *     所以能拖动进度；同源也意味着 canvas 截图不会被污染。
 * ============================================================ */
#include "../module_common.h"
#include <shlobj.h>

static const char *g_manifest = NULL;
static const char *g_js = NULL;
static const char *g_css = NULL;
static SgjModule g_mod;

/* ============================================================
 *  存储
 * ============================================================ */
static cJSON *P_state(void) {
  cJSON *st = mod_store_get("player");
  if (!cJSON_IsObject(st)) { if (st) cJSON_Delete(st); st = cJSON_CreateObject(); }
  if (!cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(st, "settings"))) {
    cJSON_DeleteItemFromObjectCaseSensitive(st, "settings");
    cJSON_AddItemToObject(st, "settings", cJSON_CreateObject());
  }
  if (!cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(st, "progress"))) {
    cJSON_DeleteItemFromObjectCaseSensitive(st, "progress");
    cJSON_AddItemToObject(st, "progress", cJSON_CreateObject());
  }
  if (!cJSON_IsArray(cJSON_GetObjectItemCaseSensitive(st, "recent"))) {
    cJSON_DeleteItemFromObjectCaseSensitive(st, "recent");
    cJSON_AddItemToObject(st, "recent", cJSON_CreateArray());
  }
  if (!cJSON_IsArray(cJSON_GetObjectItemCaseSensitive(st, "playlist"))) {
    cJSON_DeleteItemFromObjectCaseSensitive(st, "playlist");
    cJSON_AddItemToObject(st, "playlist", cJSON_CreateArray());
  }
  return st;
}
static void P_save(cJSON *st) { mod_store_set("player", st); }

/* 设置项缺省值：只补不覆盖（用户改过的值要留住） */
static cJSON *P_settings(cJSON *st) {
  cJSON *s = cJSON_GetObjectItemCaseSensitive(st, "settings");
  if (!cJSON_IsObject(s)) {
    cJSON_DeleteItemFromObjectCaseSensitive(st, "settings");
    s = cJSON_CreateObject();
    cJSON_AddItemToObject(st, "settings", s);
  }
  if (!cJSON_GetObjectItemCaseSensitive(s, "volume")) cJSON_AddNumberToObject(s, "volume", 0.8);
  if (!cJSON_GetObjectItemCaseSensitive(s, "muted")) json_set_bool(s, "muted", 0);
  if (!cJSON_GetObjectItemCaseSensitive(s, "rate")) cJSON_AddNumberToObject(s, "rate", 1.0);
  if (!cJSON_GetObjectItemCaseSensitive(s, "mode")) cJSON_AddStringToObject(s, "mode", "list");
  if (!cJSON_GetObjectItemCaseSensitive(s, "resume")) json_set_bool(s, "resume", 1);
  if (!cJSON_GetObjectItemCaseSensitive(s, "shotDir")) cJSON_AddStringToObject(s, "shotDir", "");
  if (!cJSON_GetObjectItemCaseSensitive(s, "lastDir")) cJSON_AddStringToObject(s, "lastDir", "");
  if (!cJSON_GetObjectItemCaseSensitive(s, "subScale")) cJSON_AddNumberToObject(s, "subScale", 1.0);
  return s;
}

/* ============================================================
 *  小工具
 * ============================================================ */
static int ends_ci(const char *s, const char *suf) {
  if (!s || !suf) return 0;
  size_t a = strlen(s), b = strlen(suf);
  if (b > a) return 0;
  return _stricmp(s + a - b, suf) == 0;
}
static int is_video(const char *name) {
  static const char *ext[] = {
    ".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".flv", ".wmv",
    ".ts", ".m2ts", ".mpg", ".mpeg", ".rmvb", ".rm", ".3gp", ".ogv", ".ogg", ".asf", NULL
  };
  const char *e = path_ext(name);
  if (!e || !*e) return 0;
  /* 🔴 path_ext() 返回的**不带点**（"mp4" 不是 ".mp4"） */
  for (int i = 0; ext[i]; i++) if (!_stricmp(e, ext[i] + 1)) return 1;
  return 0;
}
static int is_sub(const char *name) {
  return ends_ci(name, ".srt") || ends_ci(name, ".vtt") ||
         ends_ci(name, ".ass") || ends_ci(name, ".ssa");
}
static void sanitize_fn(char *s) {
  static const char *bad = "\\/:*?\"<>|";
  for (char *p = s; *p; p++) if (strchr(bad, *p)) *p = '_';
  str_trim(s);
  if (!*s) snprintf(s, 8, "shot");
}
/* 自然序：EP2 排在 EP10 前面（按数字块比较，纯字典序会把 10 排到 2 前面） */
static int natural_cmp(const char *a, const char *b) {
  const char *p = a, *q = b;
  while (*p && *q) {
    if (isdigit((unsigned char)*p) && isdigit((unsigned char)*q)) {
      const char *ps = p, *qs = q;
      while (*ps == '0') ps++;
      while (*qs == '0') qs++;
      const char *pe = ps, *qe = qs;
      while (isdigit((unsigned char)*pe)) pe++;
      while (isdigit((unsigned char)*qe)) qe++;
      size_t lp = (size_t)(pe - ps), lq = (size_t)(qe - qs);
      if (lp != lq) return lp < lq ? -1 : 1;
      int c = strncmp(ps, qs, lp);
      if (c) return c < 0 ? -1 : 1;
      p = pe; q = qe;
      continue;
    }
    unsigned char ca = (unsigned char)tolower((unsigned char)*p);
    unsigned char cb = (unsigned char)tolower((unsigned char)*q);
    if (ca != cb) return ca < cb ? -1 : 1;
    p++; q++;
  }
  return *p ? 1 : (*q ? -1 : 0);
}
static char *item_json(const char *path) {
  cJSON *o = cJSON_CreateObject();
  cJSON_AddStringToObject(o, "path", path);
  cJSON_AddStringToObject(o, "name", path_basename(path));
  char *url = mod_host_local(path);
  cJSON_AddStringToObject(o, "url", url ? url : "");
  free(url);
  cJSON_AddNumberToObject(o, "size", (double)file_size(path));
  cJSON_AddNumberToObject(o, "mtime", (double)file_mtime_ms(path));
  char *d = path_dirname(path);
  cJSON_AddStringToObject(o, "dir", d ? d : "");
  free(d);
  char *out = cJSON_PrintUnformatted(o);
  cJSON_Delete(o);
  return out;
}

/* ============================================================
 *  目录扫描
 * ============================================================ */
typedef struct { char **v; int n, cap; } FNList;
static void fn_add(FNList *l, char *s) {
  if (l->n == l->cap) { l->cap = l->cap ? l->cap * 2 : 64; l->v = (char **)xrealloc(l->v, sizeof(char *) * (size_t)l->cap); }
  l->v[l->n++] = s;
}
static void fn_free(FNList *l) {
  for (int i = 0; i < l->n; i++) free(l->v[i]);
  free(l->v);
  l->v = NULL; l->n = l->cap = 0;
}
static void fn_sort(FNList *l) {
  if (l->n < 2) return;
  /* 简单插入排序：文件名数量一般几百，够用且不用写比较器闭包 */
  for (int i = 1; i < l->n; i++) {
    char *k = l->v[i];
    int j = i - 1;
    while (j >= 0 && natural_cmp(l->v[j], k) > 0) { l->v[j + 1] = l->v[j]; j--; }
    l->v[j + 1] = k;
  }
}
/* 递归扫描；深度和条数都封顶，别让「选错盘符」把界面卡死 */
static void scan_dir(const char *dir, FNList *out, int depth, int *budget) {
  if (depth > 4 || *budget <= 0) return;
  char *pat = path_join(dir, "*");
  wchar_t *wp = u8_to_w(pat);
  free(pat);
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileW(wp, &fd);
  free(wp);
  if (h == INVALID_HANDLE_VALUE) return;
  do {
    if (!wcscmp(fd.cFileName, L".") || !wcscmp(fd.cFileName, L"..")) continue;
    char *nm = w_to_u8(fd.cFileName);
    if (!nm || !*nm) { free(nm); continue; }
    char *full = path_join(dir, nm);
    if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
      /* 跳过系统目录和隐藏目录：$RECYCLE.BIN 里可能有几万个文件 */
      if (nm[0] != '.' && _stricmp(nm, "$RECYCLE.BIN") && _stricmp(nm, "System Volume Information")) {
        scan_dir(full, out, depth + 1, budget);
      }
    } else if (is_video(nm)) {
      fn_add(out, xstrdup(full));
      (*budget)--;
    }
    free(full);
    free(nm);
  } while (FindNextFileW(h, &fd) && *budget > 0);
  FindClose(h);
}

/* ============================================================
 *  字幕：读文本（UTF-8 / UTF-16 / GBK 都认）
 * ============================================================ */
static char *u16_to_u8(const unsigned char *b, size_t n, int big_endian) {
  size_t chars = n / 2;
  wchar_t *w = (wchar_t *)xmalloc(sizeof(wchar_t) * (chars + 1));
  for (size_t i = 0; i < chars; i++) {
    unsigned char lo = b[i * 2], hi = b[i * 2 + 1];
    w[i] = big_endian ? (wchar_t)((lo << 8) | hi) : (wchar_t)((hi << 8) | lo);
  }
  w[chars] = 0;
  char *u = w_to_u8(w);
  free(w);
  return u;
}
static char *gbk_to_u8(const unsigned char *b, size_t n) {
  int wn = MultiByteToWideChar(936, 0, (const char *)b, (int)n, NULL, 0);
  if (wn <= 0) return NULL;
  wchar_t *w = (wchar_t *)xmalloc(sizeof(wchar_t) * (size_t)(wn + 1));
  MultiByteToWideChar(936, 0, (const char *)b, (int)n, w, wn);
  w[wn] = 0;
  char *u = w_to_u8(w);
  free(w);
  return u;
}
static char *sub_read_text(const char *path) {
  char *raw = NULL;
  size_t n = 0;
  if (!file_read_all(path, &raw, &n) || !raw) { free(raw); return NULL; }
  if (n > 4u * 1024 * 1024) { free(raw); return NULL; } /* 字幕不该这么大 */
  unsigned char *b = (unsigned char *)raw;
  char *out = NULL;
  if (n >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF) {
    out = xstrdup((char *)b + 3);
  } else if (n >= 2 && b[0] == 0xFF && b[1] == 0xFE) {
    out = u16_to_u8(b + 2, n - 2, 0);
  } else if (n >= 2 && b[0] == 0xFE && b[1] == 0xFF) {
    out = u16_to_u8(b + 2, n - 2, 1);
  } else {
    /* 先按 UTF-8 试一次：非法字节数 > 0 就改按 GBK 解（国内字幕大多是 GBK） */
    int bad = 0;
    for (size_t i = 0; i < n; i++) {
      unsigned char c = b[i];
      if (c < 0x80) continue;
      int more = (c >= 0xF0) ? 3 : (c >= 0xE0) ? 2 : (c >= 0xC0) ? 1 : -1;
      if (more < 0) { bad++; continue; }
      if (i + (size_t)more >= n) { bad++; break; }
      for (int k = 1; k <= more; k++) if ((b[i + k] & 0xC0) != 0x80) { bad++; break; }
      i += (size_t)more;
    }
    if (!bad) out = xstrdup((char *)b);
    else out = gbk_to_u8(b, n);
    if (!out) out = xstrdup((char *)b);
  }
  free(raw);
  return out;
}

/* ============================================================
 *  字幕：SRT / ASS → WebVTT（<track> 只认 VTT）
 * ============================================================ */
static void buf_add_line(Buf *b, const char *s) { buf_adds(b, s); buf_addc(b, '\n'); }
/* 按逗号切列，**空列保留**。
   🔴 不能用 strtok：ASS 里 `0,0,0,,文本` 有连续逗号（Name/Effect 常为空），
      strtok 会把连续分隔符当一个，列号整体左移，Text 列拿到的是别的字段。
   切到第 n 列为止，第 n-1 列拿到「剩余整段」—— Text 里本身就可能带逗号。
   返回实际切出的列数；小于 n 说明字段不够。 */
static int split_cols(char *s, char **cols, int n) {
  int c = 1;
  cols[0] = s;
  for (; *s && c < n; s++) if (*s == ',') { *s = 0; cols[c++] = s + 1; }
  return c;
}
/* "00:00:01,200" → "00:00:01.200"；顺带处理 "0:00:01.2" 这种短写 */
static void vtt_time(char *dst, size_t cap, const char *src) {
  int h = 0, m = 0, sec = 0, ms = 0;
  const char *p = src;
  while (*p == ' ') p++;
  /* 允许 hh:mm:ss 或 mm:ss */
  const char *c1 = strchr(p, ':');
  const char *c2 = c1 ? strchr(c1 + 1, ':') : NULL;
  if (c2) { h = atoi(p); m = atoi(c1 + 1); p = c2 + 1; }
  else if (c1) { m = atoi(p); p = c1 + 1; }
  sec = atoi(p);
  const char *dot = strpbrk(p, ".,");
  if (dot) {
    int v = atoi(dot + 1);
    size_t nd = strspn(dot + 1, "0123456789");
    if (nd == 1) v *= 100; else if (nd == 2) v *= 10; else if (nd > 3) v /= (int)pow(10.0, (double)(nd - 3));
    ms = v;
  }
  if (ms < 0) ms = 0;
  if (ms > 999) ms = 999;
  snprintf(dst, cap, "%02d:%02d:%02d.%03d", h, m, sec, ms);
}
static char *srt_to_vtt(const char *txt) {
  Buf b;
  buf_init(&b);
  buf_add_line(&b, "WEBVTT");
  buf_addc(&b, '\n');
  const char *p = txt;
  while (*p) {
    const char *eol = strchr(p, '\n');
    size_t len = eol ? (size_t)(eol - p) : strlen(p);
    char line[2048];
    size_t cp = len < sizeof(line) - 1 ? len : sizeof(line) - 1;
    memcpy(line, p, cp);
    line[cp] = 0;
    if (cp && line[cp - 1] == '\r') line[--cp] = 0;
    if (strstr(line, "-->")) {
      char a[64] = "", b2[64] = "";
      const char *arr = strstr(line, "-->");
      size_t alen = (size_t)(arr - line);
      if (alen > 63) alen = 63;
      memcpy(a, line, alen);
      a[alen] = 0;
      const char *rhs = arr + 3;
      while (*rhs == ' ') rhs++;
      size_t blen = strcspn(rhs, " \t");
      if (blen > 63) blen = 63;
      memcpy(b2, rhs, blen);
      b2[blen] = 0;
      char va[64], vb[64];
      vtt_time(va, sizeof(va), a);
      vtt_time(vb, sizeof(vb), b2);
      buf_adds(&b, va);
      buf_adds(&b, " --> ");
      buf_add_line(&b, vb);
    } else if (cp && !isdigit((unsigned char)line[0])) {
      /* 纯数字行是 SRT 的序号，VTT 里不要 */
      buf_add_line(&b, line);
    } else if (!cp) {
      buf_addc(&b, '\n');
    }
    if (!eol) break;
    p = eol + 1;
  }
  return buf_take(&b);
}
static char *ass_to_vtt(const char *txt) {
  Buf b;
  buf_init(&b);
  buf_add_line(&b, "WEBVTT");
  buf_addc(&b, '\n');
  int in_events = 0, fmt_done = 0;
  int i_start = 1, i_end = 2, i_text = 9; /* ASS 默认格式 */
  const char *p = txt;
  while (*p) {
    const char *eol = strchr(p, '\n');
    size_t len = eol ? (size_t)(eol - p) : strlen(p);
    char line[4096];
    size_t cp = len < sizeof(line) - 1 ? len : sizeof(line) - 1;
    memcpy(line, p, cp);
    line[cp] = 0;
    if (cp && line[cp - 1] == '\r') line[--cp] = 0;
    if (line[0] == '[') {
      in_events = !_stricmp(line, "[Events]");
      fmt_done = 0;
    } else if (in_events && !str_starts(line, "Format:") && !str_starts(line, "format:")) {
      /* 老格式：Layer,Start,End,... */
      if (!fmt_done) { i_start = 1; i_end = 2; i_text = 9; }
    } else if (in_events && (str_starts(line, "Format:") || str_starts(line, "format:"))) {
      /* 按列名定位 Start / End / Text，不同字幕组列序不一样 */
      const char *cols = strchr(line, ':');
      cols = cols ? cols + 1 : "";
      char buf2[1024];
      snprintf(buf2, sizeof(buf2), "%s", cols);
      char *fcol[32] = {0};
      int fn = split_cols(buf2, fcol, 32);
      for (int i = 0; i < fn; i++) {
        str_trim(fcol[i]);
        if (!_stricmp(fcol[i], "Start")) i_start = i;
        else if (!_stricmp(fcol[i], "End")) i_end = i;
        else if (!_stricmp(fcol[i], "Text")) i_text = i;
      }
      fmt_done = 1;
    }
    if (in_events && !_strnicmp(line, "Dialogue:", 9)) {
      /* Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,文本 */
      char work[4096];
      snprintf(work, sizeof(work), "%s", line + 9);
      char *cols2[32] = {0};
      int need = i_text + 1;
      if (need < 3) need = 3;         /* 至少 Layer/Start/End 要有 */
      if (need > 32) need = 32;
      int nc = split_cols(work, cols2, need);
      if (nc == need && nc > i_end && i_text < nc) {
        char va[64], vb[64];
        vtt_time(va, sizeof(va), cols2[i_start] ? cols2[i_start] : "0:00:00.00");
        vtt_time(vb, sizeof(vb), cols2[i_end] ? cols2[i_end] : "0:00:00.00");
        buf_adds(&b, va);
        buf_adds(&b, " --> ");
        buf_add_line(&b, vb);
        /* 去掉 {\pos(...)\c&H..} 这类覆盖标签，\N 换成换行 */
        char clean[4096];
        size_t k = 0;
        int in_tag = 0;
        for (const char *s = cols2[i_text]; *s && k + 2 < sizeof(clean); s++) {
          if (*s == '{') { in_tag = 1; continue; }
          if (*s == '}') { in_tag = 0; continue; }
          if (in_tag) continue;
          if (*s == '\\' && (s[1] == 'N' || s[1] == 'n')) { clean[k++] = '\n'; s++; continue; }
          clean[k++] = *s;
        }
        clean[k] = 0;
        str_trim(clean);
        if (*clean) buf_add_line(&b, clean);
        buf_addc(&b, '\n');
      }
    }
    if (!eol) break;
    p = eol + 1;
  }
  return buf_take(&b);
}
static char *sub_to_vtt(const char *path) {
  char *txt = sub_read_text(path);
  if (!txt) return NULL;
  char *vtt = NULL;
  if (ends_ci(path, ".vtt")) vtt = xstrdup(txt);
  else if (ends_ci(path, ".ass") || ends_ci(path, ".ssa")) vtt = ass_to_vtt(txt);
  else vtt = srt_to_vtt(txt);
  free(txt);
  return vtt;
}
/* 视频旁边找同名（或唯一一份）字幕 */
static char *find_sub(const char *video) {
  char stem[MAX_PATH];
  snprintf(stem, sizeof(stem), "%s", path_basename(video));
  char *dot = strrchr(stem, '.');
  if (dot) *dot = 0;
  char *dir = path_dirname(video);
  static const char *ext[] = { ".srt", ".ass", ".ssa", ".vtt", NULL };
  for (int i = 0; ext[i]; i++) {
    char nm[MAX_PATH];
    snprintf(nm, sizeof(nm), "%s%s", stem, ext[i]);
    char *p = path_join(dir, nm);
    if (path_exists(p)) { free(dir); return p; }
    free(p);
  }
  /* 没有同名的：目录里**只有唯一一份**字幕时就当它是；有两份以上不猜 */
  char *only = NULL;
  int subs = 0;
  char *pat = path_join(dir, "*");
  wchar_t *wp = u8_to_w(pat);
  free(pat);
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileW(wp, &fd);
  free(wp);
  if (h != INVALID_HANDLE_VALUE) {
    do {
      if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
      char *nm = w_to_u8(fd.cFileName);
      if (!nm) continue;
      if (is_sub(nm)) {
        subs++;
        if (subs == 1) only = path_join(dir, nm);
        else { free(only); only = NULL; }
      }
      free(nm);
    } while (FindNextFileW(h, &fd));
    FindClose(h);
  }
  free(dir);
  return only;
}

/* ============================================================
 *  base64（截图用）
 * ============================================================ */
static int b64_val(int c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+' || c == '-') return 62;
  if (c == '/' || c == '_') return 63;
  return -1;
}
static unsigned char *b64_decode(const char *s, size_t *out_n) {
  size_t n = strlen(s);
  unsigned char *out = (unsigned char *)xmalloc(n / 4 * 3 + 4);
  size_t k = 0;
  int acc = 0, bits = 0;
  for (size_t i = 0; i < n; i++) {
    if (s[i] == '=') break;
    int v = b64_val((unsigned char)s[i]);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[k++] = (unsigned char)((acc >> bits) & 0xFF);
    }
  }
  *out_n = k;
  return out;
}

/* ============================================================
 *  各频道
 * ============================================================ */
static cJSON *open_file(const char *path) {
  cJSON *o = cJSON_CreateObject();
  cJSON_AddStringToObject(o, "path", path);
  cJSON_AddStringToObject(o, "name", path_basename(path));
  char *url = mod_host_local(path);
  cJSON_AddStringToObject(o, "url", url ? url : "");
  free(url);
  char *d = path_dirname(path);
  cJSON_AddStringToObject(o, "dir", d ? d : "");
  free(d);
  return o;
}
static cJSON *do_scan(const char *dir, int *truncated, int *count) {
  FNList l = {0};
  int budget = 3000;
  scan_dir(dir, &l, 0, &budget);
  fn_sort(&l);
  cJSON *arr = cJSON_CreateArray();
  for (int i = 0; i < l.n; i++) {
    char *js = item_json(l.v[i]);
    if (js) {
      cJSON *it = cJSON_Parse(js);
      if (it) cJSON_AddItemToArray(arr, it);
      free(js);
    }
  }
  *count = l.n;
  *truncated = budget <= 0;
  fn_free(&l);
  return arr;
}

static int player_invoke(const char *channel, const char *args_json, char **out_json, char **out_error) {
  cJSON *args = mod_parse_args(args_json);
  cJSON *res = NULL;
  int rc = 0;

  if (!strcmp(channel, "player:openFile")) {
    char *p = g_host->pick_file(
        "*.mp4;*.m4v;*.mov;*.webm;*.mkv;*.avi;*.flv;*.wmv;*.ts;*.m2ts;*.mpg;*.mpeg;*.rmvb;*.rm;*.3gp;*.ogv;*.ogg",
        0, NULL);
    if (!p || !*p) { if (p) g_host->dealloc(p); cJSON_Delete(args); *out_json = mod_ret_json(cJSON_CreateNull()); return 0; }
    res = open_file(p);
    g_host->dealloc(p);
  } else if (!strcmp(channel, "player:openDir")) {
    char *d = g_host->pick_folder(0, "选择放视频的文件夹");
    if (!d || !*d) { if (d) g_host->dealloc(d); cJSON_Delete(args); *out_json = mod_ret_json(cJSON_CreateNull()); return 0; }
    int tr = 0, cnt = 0;
    res = cJSON_CreateObject();
    cJSON_AddStringToObject(res, "dir", d);
    cJSON_AddItemToObject(res, "items", do_scan(d, &tr, &cnt));
    cJSON_AddNumberToObject(res, "count", cnt);
    json_set_bool(res, "truncated", tr);
    /* 记住上次目录，下次「刷新」直接用 */
    cJSON *st = P_state();
    cJSON *s = P_settings(st);
    cJSON_DeleteItemFromObjectCaseSensitive(s, "lastDir");
    cJSON_AddStringToObject(s, "lastDir", d);
    P_save(st);
    cJSON_Delete(st);
    g_host->dealloc(d);
  } else if (!strcmp(channel, "player:scan")) {
    const char *d = mod_arg_str(args, 0, "");
    char *dir = *d ? xstrdup(d) : NULL;
    if (!dir) {
      cJSON *st = P_state();
      cJSON *s = P_settings(st);
      const char *ld = json_str(s, "lastDir", "");
      if (*ld) dir = xstrdup(ld);
      cJSON_Delete(st);
    }
    if (!dir) { rc = -1; *out_error = mod_ret_error("先选一个文件夹"); goto done; }
    int tr = 0, cnt = 0;
    res = cJSON_CreateObject();
    cJSON_AddStringToObject(res, "dir", dir);
    cJSON_AddItemToObject(res, "items", do_scan(dir, &tr, &cnt));
    cJSON_AddNumberToObject(res, "count", cnt);
    json_set_bool(res, "truncated", tr);
    free(dir);
  } else if (!strcmp(channel, "player:stat")) {
    const char *p = mod_arg_str(args, 0, "");
    res = cJSON_CreateObject();
    json_set_bool(res, "exists", path_exists(p));
    char *url = mod_host_local(p);
    cJSON_AddStringToObject(res, "url", url ? url : "");
    free(url);
    cJSON_AddStringToObject(res, "name", path_basename(p));
  } else if (!strcmp(channel, "player:subtitle")) {
    const char *v = mod_arg_str(args, 0, "");
    char *sp = find_sub(v);
    res = cJSON_CreateObject();
    if (!sp) {
      json_set_bool(res, "found", 0);
    } else {
      char *vtt = sub_to_vtt(sp);
      if (!vtt) {
        json_set_bool(res, "found", 0);
      } else {
        json_set_bool(res, "found", 1);
        cJSON_AddStringToObject(res, "vtt", vtt);
        cJSON_AddStringToObject(res, "path", sp);
        cJSON_AddStringToObject(res, "name", path_basename(sp));
      }
      free(vtt);
      free(sp);
    }
  } else if (!strcmp(channel, "player:pickSubtitle")) {
    char *p = g_host->pick_file("*.srt;*.ass;*.ssa;*.vtt", 0, NULL);
    res = cJSON_CreateObject();
    if (!p || !*p) {
      json_set_bool(res, "found", 0);
    } else {
      char *vtt = sub_to_vtt(p);
      if (!vtt) {
        json_set_bool(res, "found", 0);
        cJSON_AddStringToObject(res, "error", "字幕读不出来（可能是图片字幕或二进制格式）");
      } else {
        json_set_bool(res, "found", 1);
        cJSON_AddStringToObject(res, "vtt", vtt);
        cJSON_AddStringToObject(res, "path", p);
        cJSON_AddStringToObject(res, "name", path_basename(p));
      }
      free(vtt);
    }
    if (p) g_host->dealloc(p);
  } else if (!strcmp(channel, "player:shot")) {
    const char *video = mod_arg_str(args, 0, "");
    const char *data = mod_arg_str(args, 1, "");
    const char *comma = strstr(data, "base64,");
    if (!comma) { rc = -1; *out_error = mod_ret_error("截图数据不对"); goto done; }
    size_t n = 0;
    unsigned char *bin = b64_decode(comma + 7, &n);
    if (!n) { free(bin); rc = -1; *out_error = mod_ret_error("截图数据为空"); goto done; }
    cJSON *st = P_state();
    cJSON *s = P_settings(st);
    const char *sd = json_str(s, "shotDir", "");
    char *dir = NULL;
    if (*sd) dir = xstrdup(sd);
    else {
      char *vd = path_dirname(video);
      dir = path_join(vd && *vd ? vd : mod_data_dir(), "screenshots");
      free(vd);
    }
    cJSON_Delete(st);
    path_mkdirs(dir);
    char stem[MAX_PATH];
    snprintf(stem, sizeof(stem), "%s", path_basename(video));
    char *dot = strrchr(stem, '.');
    if (dot) *dot = 0;
    sanitize_fn(stem);
    time_t t = time(NULL);
    struct tm lt;
    localtime_s(&lt, &t);
    char nm[MAX_PATH];
    snprintf(nm, sizeof(nm), "%s_%04d%02d%02d_%02d%02d%02d.png", stem,
             lt.tm_year + 1900, lt.tm_mon + 1, lt.tm_mday, lt.tm_hour, lt.tm_min, lt.tm_sec);
    char *dest = path_join(dir, nm);
    int ok = file_write_all(dest, bin, n);
    free(bin);
    free(dir);
    if (!ok) { free(dest); rc = -1; *out_error = mod_ret_error("截图写不进去（目录可能没权限）"); goto done; }
    res = cJSON_CreateObject();
    cJSON_AddStringToObject(res, "path", dest);
    cJSON_AddNumberToObject(res, "size", (double)n);
    free(dest);
  } else if (!strcmp(channel, "player:settings")) {
    cJSON *st = P_state();
    cJSON *s = P_settings(st);
    res = cJSON_Duplicate(s, 1);
    cJSON_Delete(st);
  } else if (!strcmp(channel, "player:setSettings")) {
    cJSON *st = P_state();
    cJSON *s = P_settings(st);
    cJSON *patch = mod_arg_obj(args, 0);
    if (patch) json_deep_merge(s, patch);
    P_save(st);
    res = cJSON_Duplicate(s, 1);
    cJSON_Delete(st);
  } else if (!strcmp(channel, "player:progress:save")) {
    const char *p = mod_arg_str(args, 0, "");
    cJSON *o2 = mod_arg_obj(args, 1);
    double pos = o2 ? json_num(o2, "pos", 0) : 0;
    double dur = o2 ? json_num(o2, "dur", 0) : 0;
    if (!*p) { rc = -1; *out_error = mod_ret_error("缺路径"); goto done; }
    cJSON *st = P_state();
    cJSON *prog = cJSON_GetObjectItemCaseSensitive(st, "progress");
    cJSON_DeleteItemFromObjectCaseSensitive(prog, p);
    cJSON *e = cJSON_CreateObject();
    cJSON_AddNumberToObject(e, "pos", pos);
    cJSON_AddNumberToObject(e, "dur", dur);
    cJSON_AddNumberToObject(e, "at", (double)now_sec());
    cJSON_AddItemToObject(prog, p, e);
    /* 只留最近 300 条：多了会让 shiguangji.json 越滚越大 */
    while (cJSON_GetArraySize(prog) > 300) {
      cJSON *oldest = NULL;
      double best = 1e18;
      cJSON *it = NULL;
      cJSON_ArrayForEach(it, prog) {
        double at = json_num(it, "at", 0);
        if (at < best) { best = at; oldest = it; }
      }
      if (!oldest) break;
      char key[1024];
      snprintf(key, sizeof(key), "%s", oldest->string ? oldest->string : "");
      if (!*key) break;
      cJSON_DeleteItemFromObjectCaseSensitive(prog, key);
    }
    P_save(st);
    cJSON_Delete(st);
    res = cJSON_CreateBool(1);
  } else if (!strcmp(channel, "player:progress:get")) {
    const char *p = mod_arg_str(args, 0, "");
    cJSON *st = P_state();
    cJSON *prog = cJSON_GetObjectItemCaseSensitive(st, "progress");
    cJSON *v = cJSON_GetObjectItemCaseSensitive(prog, p);
    res = v ? cJSON_Duplicate(v, 1) : cJSON_CreateObject();
    cJSON_Delete(st);
  } else if (!strcmp(channel, "player:mark")) {
    const char *p = mod_arg_str(args, 0, "");
    if (!*p) { rc = -1; *out_error = mod_ret_error("缺路径"); goto done; }
    cJSON *st = P_state();
    cJSON *recent = cJSON_GetObjectItemCaseSensitive(st, "recent");
    /* 去重：同一路径只留最新一条 */
    for (int i = cJSON_GetArraySize(recent) - 1; i >= 0; i--) {
      cJSON *it = cJSON_GetArrayItem(recent, i);
      if (it && !strcmp(json_str(it, "path", ""), p)) cJSON_DeleteItemFromArray(recent, i);
    }
    cJSON *e = cJSON_CreateObject();
    cJSON_AddStringToObject(e, "path", p);
    cJSON_AddStringToObject(e, "name", path_basename(p));
    cJSON_AddNumberToObject(e, "at", (double)now_sec());
    cJSON_InsertItemInArray(recent, 0, e);
    while (cJSON_GetArraySize(recent) > 30) cJSON_DeleteItemFromArray(recent, cJSON_GetArraySize(recent) - 1);
    P_save(st);
    cJSON_Delete(st);
    res = cJSON_CreateBool(1);
  } else if (!strcmp(channel, "player:recent")) {
    cJSON *st = P_state();
    res = cJSON_Duplicate(cJSON_GetObjectItemCaseSensitive(st, "recent"), 1);
    cJSON_Delete(st);
  } else if (!strcmp(channel, "player:reveal")) {
    const char *p = mod_arg_str(args, 0, "");
    if (*p) g_host->reveal(p);
    res = cJSON_CreateBool(1);
  } else if (!strcmp(channel, "player:openExternal")) {
    const char *p = mod_arg_str(args, 0, "");
    if (*p) g_host->open_path(p);
    res = cJSON_CreateBool(1);
  } else if (!strcmp(channel, "player:info")) {
    /* 探测失败原因时用：告诉界面这文件到底是什么格式、多大 */
    const char *p = mod_arg_str(args, 0, "");
    res = cJSON_CreateObject();
    cJSON_AddStringToObject(res, "ext", path_ext(p));
    cJSON_AddNumberToObject(res, "size", (double)file_size(path_exists(p) ? p : ""));
    json_set_bool(res, "exists", path_exists(p));
  } else {
    rc = -1;
    *out_error = mod_ret_error("没有这个方法：%s", channel);
    goto done;
  }

  *out_json = mod_ret_json(res ? res : cJSON_CreateNull());
done:
  cJSON_Delete(args);
  return rc;
}

static int player_init(const SgjHostApi *host) {
  mod_set_host(host);
  LOGI("player 初始化");
  return 0;
}

/* 模块没有需要常驻的内存（状态每次都从 store 读），关掉时什么都不用留 */
static void player_shutdown(void) {}

SGJ_MODULE_EXPORT const SgjModule *sgj_module_entry(void) {
  if (!g_manifest) {
    g_manifest = mod_res_dup(L"MANIFEST");
    g_js = mod_res_dup(L"UI_JS");
    g_css = mod_res_dup(L"UI_CSS");
  }
  g_mod.abi = SGJ_ABI;
  g_mod.id = "player";
  g_mod.manifest_json = g_manifest;
  g_mod.renderer_js = g_js;
  g_mod.style_css = g_css;
  g_mod.init = player_init;
  g_mod.shutdown = player_shutdown;
  g_mod.invoke = player_invoke;
  return &g_mod;
}
