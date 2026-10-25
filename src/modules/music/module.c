/* ============================================================
 * 拾光集 · 音乐模块 (music.dll)
 * ------------------------------------------------------------
 * C 后端负责：扫描本地曲库 / 读标签与内嵌封面 / LRC 歌词匹配 /
 * 歌单 / 听歌统计 / 播放记帐。播放由渲染层的 <audio> 完成，
 * 音频通过宿主的 /local 代理（带 Range）流式读取。
 * ============================================================ */
#include "../module_common.h"
#include <wincrypt.h>
#include <shlobj.h>

static const char *g_manifest = NULL;
static const char *g_js = NULL;
static SgjModule g_mod;
static cJSON *get_defaults(const char *key);

/* ---------------- 小工具 ---------------- */
static char *M_id(void) {
  static volatile LONG seq = 0;
  LONG n = InterlockedIncrement(&seq);
  char b[64];
  snprintf(b, sizeof(b), "m_%llx%x", (unsigned long long)(now_ms() & 0xFFFFFFFFFFFFULL), (unsigned)n);
  return xstrdup(b);
}
static cJSON *ms_get_root(void) {
  cJSON *r = mod_store_get("music");
  if (!cJSON_IsObject(r)) { if (r) cJSON_Delete(r); r = cJSON_CreateObject(); }
  const char *keys[] = { "roots", "tracks", "playlists", NULL };
  for (int i = 0; keys[i]; i++) {
    if (!cJSON_IsArray(cJSON_GetObjectItemCaseSensitive(r, keys[i]))) {
      cJSON *a = cJSON_CreateArray();
      cJSON_DeleteItemFromObjectCaseSensitive(r, keys[i]);
      cJSON_AddItemToObject(r, keys[i], a);
    }
  }
  if (!cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(r, "plays"))) {
    cJSON_DeleteItemFromObjectCaseSensitive(r, "plays");
    cJSON_AddItemToObject(r, "plays", cJSON_CreateObject());
  }
  if (!cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(r, "logins"))) {
    cJSON_DeleteItemFromObjectCaseSensitive(r, "logins");
    cJSON_AddItemToObject(r, "logins", cJSON_CreateObject());
  }
  return r;
}
static void ms_save(cJSON *r) { mod_store_set("music", r); }
static void m_set(cJSON *o, const char *k, cJSON *v) {
  if (!o || !k) { cJSON_Delete(v); return; }
  cJSON_DeleteItemFromObjectCaseSensitive(o, k);
  if (v) cJSON_AddItemToObject(o, k, v);
}
static void ms_emit(const char *reason) {
  cJSON *o = cJSON_CreateObject();
  cJSON_AddStringToObject(o, "reason", reason ? reason : "update");
  mod_emit("music:changed", o);
}

/* ---------------- 二进制读取 ---------------- */
static int read_prefix(const char *path, size_t max, unsigned char **out, size_t *out_len) {
  *out = NULL; *out_len = 0;
  wchar_t *w = u8_to_w(path);
  HANDLE h = CreateFileW(w, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  free(w);
  if (h == INVALID_HANDLE_VALUE) return 0;
  LARGE_INTEGER sz; GetFileSizeEx(h, &sz);
  size_t n = (size_t)(sz.QuadPart < 0 ? 0 : (sz.QuadPart < (int64_t)max ? sz.QuadPart : (int64_t)max));
  unsigned char *p = (unsigned char *)xmalloc(n + 1);
  size_t got = 0;
  while (got < n) {
    DWORD r = 0;
    if (!ReadFile(h, p + got, (DWORD)(n - got > 1 << 20 ? 1 << 20 : n - got), &r, NULL) || !r) break;
    got += r;
  }
  CloseHandle(h);
  p[got] = 0;
  *out = p; *out_len = got;
  return 1;
}
static int read_tail(const char *path, size_t max, unsigned char **out, size_t *out_len) {
  *out = NULL; *out_len = 0;
  wchar_t *w = u8_to_w(path);
  HANDLE h = CreateFileW(w, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  free(w);
  if (h == INVALID_HANDLE_VALUE) return 0;
  LARGE_INTEGER sz; GetFileSizeEx(h, &sz);
  size_t n = (size_t)(sz.QuadPart < (int64_t)max ? sz.QuadPart : (int64_t)max);
  LARGE_INTEGER pos; pos.QuadPart = sz.QuadPart - (int64_t)n;
  SetFilePointerEx(h, pos, NULL, FILE_BEGIN);
  unsigned char *p = (unsigned char *)xmalloc(n + 1);
  size_t got = 0;
  while (got < n) {
    DWORD r = 0;
    if (!ReadFile(h, p + got, (DWORD)(n - got), &r, NULL) || !r) break;
    got += r;
  }
  CloseHandle(h);
  p[got] = 0;
  *out = p; *out_len = got;
  return 1;
}
static unsigned be32(const unsigned char *p) { return ((unsigned)p[0] << 24) | ((unsigned)p[1] << 16) | ((unsigned)p[2] << 8) | p[3]; }
static unsigned le32(const unsigned char *p) { return ((unsigned)p[3] << 24) | ((unsigned)p[2] << 16) | ((unsigned)p[1] << 8) | p[0]; }
static unsigned be24(const unsigned char *p) { return ((unsigned)p[0] << 16) | ((unsigned)p[1] << 8) | p[2]; }
static unsigned le16(const unsigned char *p) { return ((unsigned)p[1] << 8) | p[0]; }

/* UTF-16 → UTF-8 */
static char *u16_to_u8(const unsigned char *p, size_t bytes, int be) {
  size_t n = bytes / 2;
  wchar_t *w = (wchar_t *)xmalloc((n + 1) * sizeof(wchar_t));
  for (size_t i = 0; i < n; i++) {
    unsigned u = be ? ((unsigned)p[i * 2] << 8 | p[i * 2 + 1]) : (p[i * 2] | ((unsigned)p[i * 2 + 1] << 8));
    w[i] = (wchar_t)u;
  }
  w[n] = 0;
  char *r = w_to_u8(w);
  free(w);
  /* 去掉结尾 0 字符（有些标签带） */
  size_t l = strlen(r);
  while (l && r[l - 1] == 0) r[--l] = 0;
  return r;
}
static char *decode_tag_text(const unsigned char *p, size_t n) {
  if (!n) return xstrdup("");
  int enc = p[0];
  const unsigned char *d = p + 1;
  size_t len = n - 1;
  if (enc == 0 || enc == 3) {
    char *r = (char *)xmalloc(len + 1);
    memcpy(r, d, len); r[len] = 0;
    if (enc == 0) {
      /* ISO-8859-1 → UTF-8 */
      char *u = (char *)xmalloc(len * 2 + 1); size_t o = 0;
      for (size_t i = 0; i < len; i++) {
        unsigned char c = d[i];
        if (c < 0x80) u[o++] = (char)c;
        else { u[o++] = (char)(0xC0 | (c >> 6)); u[o++] = (char)(0x80 | (c & 0x3F)); }
      }
      u[o] = 0; free(r); r = u;
    }
    size_t l = strlen(r); while (l && r[l - 1] == 0) r[--l] = 0;
    return r;
  }
  if (enc == 1) {
    int be = 0;
    if (len >= 2) {
      if (d[0] == 0xFF && d[1] == 0xFE) { be = 0; d += 2; len -= 2; }
      else if (d[0] == 0xFE && d[1] == 0xFF) { be = 1; d += 2; len -= 2; }
    }
    char *r = u16_to_u8(d, len, be);
    return r;
  }
  if (enc == 2) return u16_to_u8(d, len, 1);
  return xstrdup("");
}

static char *cover_path_for(const char *hash, const unsigned char *data, size_t n, const char *mime) {
  const char *ext = "jpg";
  if (mime && strstr(mime, "png")) ext = "png";
  else if (mime && strstr(mime, "webp")) ext = "webp";
  else if (n > 8 && data[0] == 0x89 && data[1] == 'P') ext = "png";
  else if (n > 12 && !memcmp(data, "RIFF", 4) && !memcmp(data + 8, "WEBP", 4)) ext = "webp";
  char *dir = path_join(mod_data_dir(), "music-covers");
  path_mkdirs(dir);
  char fn[128];
  snprintf(fn, sizeof(fn), "%s.%s", hash, ext);
  char *file = path_join(dir, fn);
  free(dir);
  if (!path_exists(file)) file_write_all(file, data, n);
  return file;
}

/* ---------------- 标签解析 ---------------- */
typedef struct {
  char title[512], artist[512], album[512];
  int duration;
  char format[32];
  int lossless;
  int sample_rate;
  int bits;
  int bitrate;
  char cover[1024];
} TrackMeta;

static void meta_init(TrackMeta *m) { memset(m, 0, sizeof(*m)); }

static void parse_id3v2(const unsigned char *b, size_t n, TrackMeta *m, const char *cache_key) {
  if (n < 10 || memcmp(b, "ID3", 3)) return;
  int ver = b[3];
  unsigned sz = ((unsigned)(b[6] & 0x7F) << 21) | ((unsigned)(b[7] & 0x7F) << 14) | ((unsigned)(b[8] & 0x7F) << 7) | (b[9] & 0x7F);
  size_t pos = 10;
  if (b[5] & 0x40) {
    if (ver == 4) { unsigned ext = ((unsigned)(b[pos] & 0x7F) << 21) | ((unsigned)(b[pos+1] & 0x7F) << 14) | ((unsigned)(b[pos+2] & 0x7F) << 7) | (b[pos+3] & 0x7F); pos += ext; }
    else { unsigned ext = be32(b + pos); pos += ext; }
  }
  size_t end = 10 + sz;
  if (end > n) end = n;
  while (pos + 10 <= end) {
    if (b[pos] == 0) break;
    char fid[5] = { (char)b[pos], (char)b[pos+1], (char)b[pos+2], (char)b[pos+3], 0 };
    unsigned fsz;
    if (ver == 4) fsz = ((unsigned)(b[pos+4] & 0x7F) << 21) | ((unsigned)(b[pos+5] & 0x7F) << 14) | ((unsigned)(b[pos+6] & 0x7F) << 7) | (b[pos+7] & 0x7F);
    else fsz = be32(b + pos + 4);
    if (fsz == 0 || pos + 10 + fsz > end) break;
    const unsigned char *d = b + pos + 10;
    if (!strcmp(fid, "TIT2")) { char *t = decode_tag_text(d, fsz); snprintf(m->title, sizeof(m->title), "%s", t); free(t); }
    else if (!strcmp(fid, "TPE1")) { char *t = decode_tag_text(d, fsz); snprintf(m->artist, sizeof(m->artist), "%s", t); free(t); }
    else if (!strcmp(fid, "TALB")) { char *t = decode_tag_text(d, fsz); snprintf(m->album, sizeof(m->album), "%s", t); free(t); }
    else if (!strcmp(fid, "APIC") && fsz > 4 && !m->cover[0]) {
      size_t p = 1;
      int enc = d[0];
      /* mime 以 0 结尾 */
      while (p < fsz && d[p]) p++;
      p++;
      size_t start_mime = 1;
      char mime[64] = "";
      size_t ml = p - 1 - start_mime;
      if (ml < sizeof(mime)) { memcpy(mime, d + start_mime, ml); mime[ml] = 0; }
      p++; /* picture type */
      if (enc == 1 || enc == 2) {
        while (p + 1 < fsz && !(d[p] == 0 && d[p+1] == 0)) p += 2;
        p += 2;
      } else {
        while (p < fsz && d[p]) p++;
        p++;
      }
      if (p < fsz) {
        size_t ilen = fsz - p;
        char *cp = cover_path_for(cache_key, d + p, ilen, mime);
        snprintf(m->cover, sizeof(m->cover), "file:///%s", cp);
        for (char *q = m->cover + 8; *q; q++) if (*q == '\\') *q = '/';
        free(cp);
      }
    }
    pos += 10 + fsz;
  }
}

static void parse_flac(const unsigned char *b, size_t n, TrackMeta *m, const char *cache_key) {
  size_t pos = 4;
  while (pos + 4 <= n) {
    int last = b[pos] & 0x80;
    int type = b[pos] & 0x7F;
    unsigned len = be24(b + pos + 1);
    pos += 4;
    if (pos + len > n) break;
    const unsigned char *d = b + pos;
    if (type == 0 && len >= 34) {
      unsigned sr = ((unsigned)d[10] << 12) | ((unsigned)d[11] << 4) | (d[12] >> 4);
      int ch = (int)(((d[12] >> 1) & 0x07) + 1);
      int bits = (int)((((d[12] & 1) << 4) | (d[13] >> 4)) + 1);
      unsigned long long total = ((unsigned long long)(d[13] & 0x0F) << 32) | be32(d + 14);
      snprintf(m->format, sizeof(m->format), "FLAC");
      m->lossless = 1; m->sample_rate = (int)sr; m->bits = bits;
      if (sr) m->duration = (int)(total / sr);
      (void)ch;
    } else if (type == 4) {
      size_t p = 0;
      unsigned vl = le32(d + p); p += 4 + vl;
      if (p + 4 > len) { pos += len; if (last) break; continue; }
      unsigned cnt = le32(d + p); p += 4;
      for (unsigned i = 0; i < cnt && p + 4 <= len; i++) {
        unsigned l = le32(d + p); p += 4;
        if (p + l > len) break;
        char *kv = xstrndup((const char *)(d + p), l);
        char *eq = strchr(kv, '=');
        if (eq) {
          *eq = 0;
          const char *k = kv, *v = eq + 1;
          if (!_stricmp(k, "TITLE")) snprintf(m->title, sizeof(m->title), "%s", v);
          else if (!_stricmp(k, "ARTIST")) snprintf(m->artist, sizeof(m->artist), "%s", v);
          else if (!_stricmp(k, "ALBUM")) snprintf(m->album, sizeof(m->album), "%s", v);
        }
        free(kv);
        p += l;
      }
    } else if (type == 6 && !m->cover[0]) {
      size_t p = 0;
      unsigned ptype = be32(d + p); p += 4; (void)ptype;
      unsigned ml = be32(d + p); p += 4;
      if (p + ml + 4 > len) { pos += len; if (last) break; continue; }
      p += ml;
      unsigned dl = be32(d + p); p += 4;
      if (p + dl + 16 <= len) {
        /* desc */
        unsigned dlen = be32(d + p); p += 4 + dlen;
        p += 16; /* w/h/depth/colors */
        unsigned imglen = be32(d + p); p += 4;
        if (p + imglen <= len && imglen > 0) {
          char *cp = cover_path_for(cache_key, d + p, imglen, NULL);
          snprintf(m->cover, sizeof(m->cover), "file:///%s", cp);
          for (char *q = m->cover + 8; *q; q++) if (*q == '\\') *q = '/';
          free(cp);
        }
      }
    }
    pos += len;
    if (last) break;
  }
}

static void parse_mp3_duration(const unsigned char *b, size_t n, int64_t fsize, TrackMeta *m) {
  size_t pos = 0;
  if (n > 10 && !memcmp(b, "ID3", 3)) {
    unsigned sz = ((unsigned)(b[6] & 0x7F) << 21) | ((unsigned)(b[7] & 0x7F) << 14) | ((unsigned)(b[8] & 0x7F) << 7) | (b[9] & 0x7F);
    pos = 10 + sz;
  }
  for (size_t i = pos; i + 4 < n && i < pos + 65536; i++) {
    if (b[i] != 0xFF || (b[i + 1] & 0xE0) != 0xE0) continue;
    int ver = (b[i+1] >> 3) & 3;      /* 3=MPEG1, 2=MPEG2, 0=MPEG2.5 */
    int layer = (b[i+1] >> 1) & 3;    /* 1=III,2=II,3=I */
    int br_idx = (b[i+2] >> 4) & 0x0F;
    int sr_idx = (b[i+2] >> 2) & 3;
    if (br_idx == 0 || br_idx == 15 || sr_idx == 3 || layer == 0) continue;
    static const int br_v1l3[] = {0,32,40,48,56,64,80,96,112,128,160,192,224,256,320};
    static const int br_v2l3[] = {0,8,16,24,32,40,48,56,64,80,96,112,128,144,160};
    static const int sr_v1[] = {44100,48000,32000};
    int kbps = (ver == 3) ? br_v1l3[br_idx] : br_v2l3[br_idx];
    int sr = sr_v1[sr_idx];
    if (ver == 2) sr /= 2; else if (ver == 0) sr /= 4;
    int spf = (layer == 1) ? 1152 : (layer == 3 ? 384 : 1152);
    m->sample_rate = sr;
    m->bitrate = kbps * 1000;
    snprintf(m->format, sizeof(m->format), "MP3");
    if (kbps > 0 && fsize > 0) {
      m->duration = (int)((fsize - (int64_t)pos) * 8 / (kbps * 1000));
    }
    (void)spf;
    return;
  }
}

static void parse_m4a(const char *path, const unsigned char *b, size_t n, TrackMeta *m, const char *cache_key) {
  (void)path;
  snprintf(m->format, sizeof(m->format), "M4A");
  /* 顶层 atoms */
  size_t pos = 0;
  size_t moov = 0, moov_len = 0;
  while (pos + 8 <= n) {
    unsigned sz = be32(b + pos);
    if (sz < 8) break;
    if (!memcmp(b + pos + 4, "moov", 4)) { moov = pos; moov_len = sz; }
    pos += sz;
  }
  if (!moov) return;
  /* mvhd: 找 moov 内 */
  for (size_t p = moov + 8; p + 8 < moov + moov_len && p + 8 <= n;) {
    unsigned sz = be32(b + p);
    if (sz < 8) break;
    if (!memcmp(b + p + 4, "mvhd", 4) && p + 32 < n) {
      int ver = b[p+8];
      if (ver == 0) {
        unsigned ts = be32(b + p + 20), dur = be32(b + p + 24);
        if (ts) m->duration = (int)((unsigned long long)dur / ts);
      } else {
        unsigned ts = be32(b + p + 28);
        unsigned long long dur = ((unsigned long long)be32(b + p + 32) << 32) | be32(b + p + 36);
        if (ts) m->duration = (int)(dur / ts);
      }
      break;
    }
    p += sz;
  }
  /* 标签：在 moov 里搜 ilst 与常见 atom */
  for (size_t p = moov; p + 8 < n && p < moov + moov_len;) {
    if (!memcmp(b + p + 4, "ilst", 4)) {
      unsigned sz = be32(b + p);
      size_t end = p + sz;
      size_t q = p + 8;
      while (q + 8 <= end && q + 8 <= n) {
        unsigned isz = be32(b + q);
        if (isz < 8) break;
        const unsigned char *tag = b + q + 4;
        size_t d = q + 8;
        unsigned dsz = (d + 8 <= n) ? be32(b + d) : 0;
        if (dsz >= 16 && dsz < n) {
          const unsigned char *data = b + d + 16;
          size_t dlen = dsz - 16;
          if (!memcmp(tag, "\xA9""nam", 4) && !m->title[0]) {
            char *s = xstrndup((const char *)data, dlen); snprintf(m->title, sizeof(m->title), "%s", s); free(s);
          } else if (!memcmp(tag, "\xA9""ART", 4) && !m->artist[0]) {
            char *s = xstrndup((const char *)data, dlen); snprintf(m->artist, sizeof(m->artist), "%s", s); free(s);
          } else if (!memcmp(tag, "\xA9""alb", 4) && !m->album[0]) {
            char *s = xstrndup((const char *)data, dlen); snprintf(m->album, sizeof(m->album), "%s", s); free(s);
          } else if (!memcmp(tag, "covr", 4) && !m->cover[0] && dlen > 0) {
            const char *mime = (data[0] == 0x89) ? "image/png" : "image/jpeg";
            char *cp = cover_path_for(cache_key, data, dlen, mime);
            snprintf(m->cover, sizeof(m->cover), "file:///%s", cp);
            for (char *x = m->cover + 8; *x; x++) if (*x == '\\') *x = '/';
            free(cp);
          }
        }
        q += isz;
      }
      break;
    }
    unsigned sz = be32(b + p);
    if (sz < 8) break;
    p += sz;
  }
  if (m->duration > 0) m->bitrate = (int)(file_size(path) * 8 / m->duration);
}

static void parse_ogg(const char *path, const unsigned char *b, size_t n, TrackMeta *m, const char *cache_key) {
  (void)cache_key;
  if (n < 64 || memcmp(b, "OggS", 4)) return;
  int is_opus = 0;
  size_t p = 27 + b[26];
  if (p + 16 > n) return;
  if (!memcmp(b + p, "OpusHead", 8)) { is_opus = 1; snprintf(m->format, sizeof(m->format), "Opus"); m->sample_rate = 48000; }
  else if (!memcmp(b + p, "\x01vorbis", 7)) {
    snprintf(m->format, sizeof(m->format), "OGG");
    if (p + 28 <= n) { m->sample_rate = (int)le32(b + p + 12); }
  } else return;
  /* comments: 第二页 */
  size_t q = 27 + b[26];
  unsigned seg = b[26];
  size_t page2 = q;
  for (unsigned i = 0; i < seg; i++) page2 += b[27 + i];
  page2 = (page2 + 255) & ~255u; /* not exact; fallback search */
  /* 简单搜索 vorbis/OpusTags */
  for (size_t i = 0; i + 8 < n; i++) {
    if (!memcmp(b + i, "\x03vorbis", 7) || !memcmp(b + i, "OpusTags", 8)) {
      size_t t = i + (b[i + 1] == 'p' ? 8 : 7);
      if (t + 4 > n) break;
      unsigned vl = le32(b + t); t += 4 + vl;
      if (t + 4 > n) break;
      unsigned cnt = le32(b + t); t += 4;
      for (unsigned k = 0; k < cnt && t + 4 <= n; k++) {
        unsigned l = le32(b + t); t += 4;
        if (t + l > n) break;
        char *kv = xstrndup((const char *)(b + t), l);
        char *eq = strchr(kv, '=');
        if (eq) {
          *eq = 0;
          if (!_stricmp(kv, "TITLE")) snprintf(m->title, sizeof(m->title), "%s", eq + 1);
          else if (!_stricmp(kv, "ARTIST")) snprintf(m->artist, sizeof(m->artist), "%s", eq + 1);
          else if (!_stricmp(kv, "ALBUM")) snprintf(m->album, sizeof(m->album), "%s", eq + 1);
        }
        free(kv);
        t += l;
      }
      break;
    }
  }
  /* 时长：最后一页的 granule */
  unsigned char *tail = NULL; size_t tn = 0;
  if (read_tail(path, 65536, &tail, &tn) && tn > 27) {
    for (size_t i = tn - 27; i > 0; i--) {
      if (!memcmp(tail + i, "OggS", 4)) {
        unsigned long long gran = 0;
        for (int k = 7; k >= 0; k--) gran = (gran << 8) | tail[i + 6 + k];
        if (m->sample_rate && gran) m->duration = (int)(gran / (is_opus ? 48000 : m->sample_rate));
        break;
      }
    }
  }
  if (tail) free(tail);
}

static void parse_wav(const unsigned char *b, size_t n, TrackMeta *m) {
  snprintf(m->format, sizeof(m->format), "WAV");
  if (n < 12) return;
  unsigned sr = 0, bits = 0, ch = 0;
  size_t pos = 12;
  unsigned data = 0;
  while (pos + 8 <= n) {
    unsigned sz = le32(b + pos);
    if (!memcmp(b + pos + 4, "fmt ", 4) && pos + 8 + 16 <= n) {
      ch = le16(b + pos + 10); sr = le32(b + pos + 12); bits = le16(b + pos + 22);
      m->sample_rate = (int)sr; m->bits = (int)bits;
    } else if (!memcmp(b + pos + 4, "data", 4)) { data = sz; }
    pos += 8 + sz + (sz & 1);
  }
  if (sr && ch && bits) {
    unsigned long long bytes_per_sec = (unsigned long long)sr * ch * (bits / 8);
    if (bytes_per_sec) m->duration = (int)(data / bytes_per_sec);
    m->bitrate = (int)(bytes_per_sec * 8);
    m->lossless = 1;
  }
}

/* 嗅探格式 + 解析 */
static void sniff_meta(const char *path, TrackMeta *m) {
  meta_init(m);
  unsigned char *b = NULL; size_t n = 0;
  if (!read_prefix(path, 6 * 1024 * 1024, &b, &n) || !n) return;
  int64_t fsize = file_size(path);
  char key[64];
  {
    unsigned long long h = 1469598103934665603ULL;
    const char *p = path;
    for (; *p; p++) { h ^= (unsigned char)*p; h *= 1099511628211ULL; }
    h ^= (unsigned long long)file_mtime_ms(path); h *= 1099511628211ULL;
    snprintf(key, sizeof(key), "%016llx", h);
  }
  if (n > 4 && !memcmp(b, "fLaC", 4)) parse_flac(b, n, m, key);
  else if (n > 3 && !memcmp(b, "ID3", 3)) { parse_id3v2(b, n, m, key); parse_mp3_duration(b, n, fsize, m); }
  else if (n > 2 && b[0] == 0xFF && (b[1] & 0xE0) == 0xE0) parse_mp3_duration(b, n, fsize, m);
  else if (n > 12 && !memcmp(b + 4, "ftyp", 4)) parse_m4a(path, b, n, m, key);
  else if (n > 4 && !memcmp(b, "OggS", 4)) parse_ogg(path, b, n, m, key);
  else if (n > 12 && !memcmp(b, "RIFF", 4) && !memcmp(b + 8, "WAVE", 4)) parse_wav(b, n, m);
  else {
    /* 按扩展名兜底 */
    const char *e = path_ext(path);
    if (!_stricmp(e, "mp3")) snprintf(m->format, sizeof(m->format), "MP3");
    else if (!_stricmp(e, "flac")) snprintf(m->format, sizeof(m->format), "FLAC");
    else if (!_stricmp(e, "m4a") || !_stricmp(e, "aac")) snprintf(m->format, sizeof(m->format), "M4A");
    else if (!_stricmp(e, "ogg")) snprintf(m->format, sizeof(m->format), "OGG");
    else if (!_stricmp(e, "wav")) snprintf(m->format, sizeof(m->format), "WAV");
    else snprintf(m->format, sizeof(m->format), "%s", e);
  }
  free(b);
  if (!m->title[0]) {
    const char *base = path_basename(path);
    char stem[512]; snprintf(stem, sizeof(stem), "%s", base);
    char *dot = strrchr(stem, '.'); if (dot) *dot = 0;
    snprintf(m->title, sizeof(m->title), "%s", stem);
  }
  if (!m->album[0]) snprintf(m->album, sizeof(m->album), "未知专辑");
  if (!m->artist[0]) snprintf(m->artist, sizeof(m->artist), "未知歌手");
}
static int is_audio_ext(const char *e) {
  const char *ok[] = { "mp3","flac","m4a","aac","ogg","opus","wav","wma","ape","alac","aiff","aif","dsf","dff","mka","webm","mp2","ac3","wv","tta","caf","m4b","mp4a","oga","spx","mid","midi","amr","au","snd", NULL };
  for (int i = 0; ok[i]; i++) if (!_stricmp(e, ok[i])) return 1;
  return 0;
}
static int is_encrypted_ext(const char *e) {
  return !_stricmp(e, "ncm") || !_stricmp(e, "kgm") || !_stricmp(e, "kgma") || !_stricmp(e, "qmc0") ||
         !_stricmp(e, "qmc3") || !_stricmp(e, "qmcflac") || !_stricmp(e, "qmcogg") || !_stricmp(e, "tm0") ||
         !_stricmp(e, "tm2") || !_stricmp(e, "tm3") || !_stricmp(e, "tm6");
}

/* ---------------- LRC ---------------- */
typedef struct { double t; char *text; } LrcLine;
static int lrc_line_cmp(const void *a, const void *b) {
  const LrcLine *x = (const LrcLine *)a, *y = (const LrcLine *)b;
  return x->t < y->t ? -1 : x->t > y->t ? 1 : 0;
}
static cJSON *parse_lrc_file(const char *path, int *out_offset, cJSON **out_meta) {
  char *txt = file_read_text(path);
  if (!txt) return NULL;
  LrcLine lines[4096]; int n = 0; int offset = 0;
  cJSON *meta = cJSON_CreateObject();
  char *save = NULL;
  for (char *line = strtok_r(txt, "\r\n", &save); line && n < 4096; line = strtok_r(NULL, "\r\n", &save)) {
    while (*line == ' ' || *line == '\t' || (unsigned char)*line == 0xEF) line++;
    if (line[0] == '[') {
      /* 元数据 [ti:..] */
      if (isalpha((unsigned char)line[1]) && strchr(line, ':')) {
        char key[16] = ""; char val[512] = "";
        if (sscanf(line, "[%15[^:]:%511[^]]]", key, val) == 2) {
          if (!_stricmp(key, "offset")) offset = atoi(val);
          else { char *t = val; str_trim(t); cJSON_AddStringToObject(meta, key, t); }
        }
        continue;
      }
    }
    /* 一行可能带多个时间标签 */
    const char *p = line;
    double times[16]; int nt = 0;
    while (*p == '[') {
      int mm = 0, ss = 0, ms = 0;
      if (sscanf(p, "[%d:%d.%d]", &mm, &ss, &ms) == 3) {
        times[nt++] = mm * 60.0 + ss + ms / (ms >= 100 ? 1000.0 : 100.0);
      } else if (sscanf(p, "[%d:%d]", &mm, &ss) == 2) times[nt++] = mm * 60.0 + ss;
      else break;
      const char *e = strchr(p, ']'); if (!e) break; p = e + 1;
      if (nt >= 16) break;
    }
    if (!nt) continue;
    char *body = xstrdup(p);
    str_trim(body);
    for (int i = 0; i < nt; i++) {
      lines[n].t = times[i];
      lines[n].text = xstrdup(body);
      n++;
    }
    free(body);
  }
  free(txt);
  qsort(lines, (size_t)n, sizeof(LrcLine), lrc_line_cmp);
  cJSON *arr = cJSON_CreateArray();
  for (int i = 0; i < n; i++) {
    if (i && fabs(lines[i].t - lines[i-1].t) < 0.001) {
      /* 合并同一时间戳 */
      cJSON *last = cJSON_GetArrayItem(arr, cJSON_GetArraySize(arr) - 1);
      const char *old = json_str(last, "text", "");
      char *merged = (char *)xmalloc(strlen(old) + strlen(lines[i].text) + 3);
      sprintf(merged, "%s  %s", old, lines[i].text);
      cJSON_DeleteItemFromArray(arr, cJSON_GetArraySize(arr) - 1);
      cJSON *o = cJSON_CreateObject();
      cJSON_AddNumberToObject(o, "t", lines[i].t);
      cJSON_AddStringToObject(o, "text", merged);
      cJSON_AddItemToArray(arr, o);
      free(merged);
    } else {
      cJSON *o = cJSON_CreateObject();
      cJSON_AddNumberToObject(o, "t", lines[i].t);
      cJSON_AddStringToObject(o, "text", lines[i].text);
      cJSON_AddItemToArray(arr, o);
    }
    free(lines[i].text);
  }
  if (out_offset) *out_offset = offset;
  if (out_meta) *out_meta = meta; else cJSON_Delete(meta);
  return arr;
}
static char *norm_name(const char *s) {
  char *o = (char *)xmalloc(strlen(s) + 1);
  size_t k = 0;
  for (const char *p = s; *p; p++) {
    unsigned char c = (unsigned char)*p;
    if (c >= 'A' && c <= 'Z') c = (unsigned char)(c + 32);
    if (c == ' ' || c == '-' || c == '_' || c == '.' || c == '(' || c == ')' || c == '[' || c == ']') continue;
    o[k++] = (char)c;
  }
  o[k] = 0;
  return o;
}
typedef struct { char *norm; char *path; } LrcEnt;
static LrcEnt *g_lrc_idx = NULL;
static int g_lrc_n = 0, g_lrc_cap = 0;
static void lrc_idx_add(const char *path) {
  const char *base = path_basename(path);
  char stem[512]; snprintf(stem, sizeof(stem), "%s", base);
  char *dot = strrchr(stem, '.'); if (dot) *dot = 0;
  char *nm = norm_name(stem);
  if (g_lrc_n == g_lrc_cap) { g_lrc_cap = g_lrc_cap ? g_lrc_cap * 2 : 256; g_lrc_idx = (LrcEnt *)xrealloc(g_lrc_idx, sizeof(LrcEnt) * (size_t)g_lrc_cap); }
  g_lrc_idx[g_lrc_n].norm = nm;
  g_lrc_idx[g_lrc_n].path = xstrdup(path);
  g_lrc_n++;
}
static void lrc_idx_clear(void) {
  for (int i = 0; i < g_lrc_n; i++) { free(g_lrc_idx[i].norm); free(g_lrc_idx[i].path); }
  g_lrc_n = 0;
}
static void walk_index_lrc(const char *dir, int depth) {
  if (depth > 3) return;
  char *pat = path_join(dir, "*");
  wchar_t *wp = u8_to_w(pat);
  WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW(wp, &fd);
  free(wp); free(pat);
  if (h == INVALID_HANDLE_VALUE) return;
  do {
    if (!wcscmp(fd.cFileName, L".") || !wcscmp(fd.cFileName, L"..")) continue;
    char *nm = w_to_u8(fd.cFileName);
    char *full = path_join(dir, nm);
    if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
      if (nm[0] != '.') walk_index_lrc(full, depth + 1);
    } else if (str_ends_ci(nm, ".lrc")) lrc_idx_add(full);
    free(full); free(nm);
  } while (FindNextFileW(h, &fd));
  FindClose(h);
}
static char *match_lrc(const char *audio, const char *title, const char *artist) {
  /* 1) 同目录同名 */
  char stem[512]; snprintf(stem, sizeof(stem), "%s", path_basename(audio));
  char *dot = strrchr(stem, '.'); if (dot) *dot = 0;
  char *dir = path_dirname(audio);
  char *p = path_join(dir, stem);
  char *lrc = (char *)xmalloc(strlen(p) + 5);
  sprintf(lrc, "%s.lrc", p);
  if (path_exists(lrc)) { free(p); free(dir); return lrc; }
  free(lrc); free(p);
  /* 2) 库级索引：同名 / 标题 / 标题-歌手 */
  char *n1 = norm_name(stem);
  char *n2 = title && *title ? norm_name(title) : NULL;
  char *n3 = NULL;
  if (title && *title && artist && *artist) {
    char buf[1024]; snprintf(buf, sizeof(buf), "%s%s", title, artist);
    n3 = norm_name(buf);
  }
  char *hit = NULL;
  for (int i = 0; i < g_lrc_n && !hit; i++) {
    if (!strcmp(g_lrc_idx[i].norm, n1) || (n2 && !strcmp(g_lrc_idx[i].norm, n2)) || (n3 && !strcmp(g_lrc_idx[i].norm, n3))) {
      /* 优先同盘/同目录附近的，这里简单取第一个 */
      hit = xstrdup(g_lrc_idx[i].path);
    }
  }
  free(n1); free(n2); free(n3);
  free(dir);
  return hit;
}
static char *find_lrc_for_track(cJSON *t) {
  const char *lp = json_str(t, "lrcPath", "");
  if (*lp && path_exists(lp)) return xstrdup(lp);
  return match_lrc(json_str(t, "path", ""), json_str(t, "title", ""), json_str(t, "artist", ""));
}

/* ---------------- 扫描 ---------------- */
typedef struct { char **v; int n, cap; } StrList;
static void sl_add(StrList *l, char *s) {
  if (l->n == l->cap) { l->cap = l->cap ? l->cap * 2 : 64; l->v = (char **)xrealloc(l->v, sizeof(char *) * (size_t)l->cap); }
  l->v[l->n++] = s;
}
static void walk_audio(const char *dir, StrList *out, int depth) {
  if (depth > 12) return;
  char *pat = path_join(dir, "*");
  wchar_t *wp = u8_to_w(pat);
  WIN32_FIND_DATAW fd; HANDLE h = FindFirstFileW(wp, &fd);
  free(wp); free(pat);
  if (h == INVALID_HANDLE_VALUE) return;
  do {
    if (!wcscmp(fd.cFileName, L".") || !wcscmp(fd.cFileName, L"..")) continue;
    char *nm = w_to_u8(fd.cFileName);
    char *full = path_join(dir, nm);
    if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
      if (nm[0] != '.' && _stricmp(nm, "node_modules") && _stricmp(nm, "$RECYCLE.BIN") && _stricmp(nm, "System Volume Information"))
        walk_audio(full, out, depth + 1);
    } else {
      const char *e = path_ext(nm);
      if (is_encrypted_ext(e)) { /* 跳过加密格式 */ }
      else if (is_audio_ext(e)) sl_add(out, xstrdup(full));
    }
    free(full); free(nm);
  } while (FindNextFileW(h, &fd));
  FindClose(h);
}
static int path_under(const char *path, const char *root) {
  if (!path || !root || !*root) return 0;
  size_t n = strlen(root);
  if (_strnicmp(path, root, n)) return 0;
  return path[n] == 0 || path[n] == '\\' || path[n] == '/';
}

/* ---------------- 封面兜底：同目录图片 → 网易云专辑图 ----------------
   内嵌封面由 sniff_meta 读；很多从网盘/网站下的 FLAC 没有内嵌图，
   这时先找同目录 cover/folder/front，再按 歌名+歌手 查一次专辑封面。 */
static char *cover_url_of(const char *path) {
  size_t n = strlen(path);
  char *u = (char *)xmalloc(n + 12);
  sprintf(u, "file:///%s", path);
  for (char *p = u + 8; *p; p++) if (*p == '\\') *p = '/';
  return u;
}
static char *folder_cover_for(const char *audio_path) {
  char *dir = path_dirname(audio_path);
  const char *names[] = { "cover.jpg", "folder.jpg", "front.jpg", "album.jpg",
    "Cover.jpg", "Folder.jpg", "封面.jpg", "cover.png", "folder.png", "front.png", NULL };
  for (int i = 0; names[i]; i++) {
    char *p = path_join(dir, names[i]);
    if (path_exists(p)) { char *u = cover_url_of(p); free(p); free(dir); return u; }
    free(p);
  }
  free(dir);
  return NULL;
}
static char *online_cover_for(const char *path, const char *title, const char *artist) {
  if (!title || !*title) return NULL;
  char q[512];
  snprintf(q, sizeof(q), "%s %s", title, artist ? artist : "");
  char *enc = url_encode(q);
  if (!enc) return NULL;
  size_t cap = strlen(enc) + 128;
  char *url = (char *)xmalloc(cap);
  snprintf(url, cap, "https://music.163.com/api/search/get/web?s=%s&type=1&limit=3&offset=0", enc);
  int status = 0;
  char *body = g_host->http_request("GET", url,
      "Accept: application/json\r\nReferer: https://music.163.com/\r\nUser-Agent: Mozilla/5.0\r\n",
      NULL, 0, 3500, &status, NULL);
  free(url); free(enc);
  if (!body) return NULL;
  long album_id = 0;
  if (status == 200) {
    cJSON *j = cJSON_Parse(body);
    cJSON *songs = j ? cJSON_GetObjectItemCaseSensitive(cJSON_GetObjectItemCaseSensitive(j, "result"), "songs") : NULL;
    cJSON *s0 = cJSON_GetArrayItem(songs, 0);
    cJSON *al = s0 ? cJSON_GetObjectItemCaseSensitive(s0, "album") : NULL;
    album_id = (long)json_num(al, "id", 0);
    cJSON_Delete(j);
  }
  g_host->dealloc(body);
  if (album_id <= 0) return NULL;
  url = (char *)xmalloc(cap);
  snprintf(url, cap, "https://music.163.com/api/v1/album/%ld", album_id);
  status = 0;
  body = g_host->http_request("GET", url,
      "Accept: application/json\r\nReferer: https://music.163.com/\r\nUser-Agent: Mozilla/5.0\r\n",
      NULL, 0, 3500, &status, NULL);
  free(url);
  if (!body) return NULL;
  char *pic = NULL;
  if (status == 200) {
    cJSON *j = cJSON_Parse(body);
    cJSON *al = j ? cJSON_GetObjectItemCaseSensitive(j, "album") : NULL;
    const char *p = al ? json_str(al, "picUrl", "") : "";
    if (*p) pic = xstrdup(p);
    cJSON_Delete(j);
  }
  g_host->dealloc(body);
  if (!pic) return NULL;
  status = 0;
  size_t ilen = 0;
  unsigned char *img = (unsigned char *)g_host->http_request("GET", pic,
      "Accept: image/*\r\nReferer: https://music.163.com/\r\nUser-Agent: Mozilla/5.0\r\n",
      NULL, 0, 5000, &status, &ilen);
  free(pic);
  if (!img || status != 200 || ilen < 500) { if (img) g_host->dealloc(img); return NULL; }
  char key[160];
  unsigned long long h = 1469598103934665603ULL;
  for (const char *p = path; *p; p++) { h ^= (unsigned char)*p; h *= 1099511628211ULL; }
  snprintf(key, sizeof(key), "online_%016llx", h);
  char *cp = cover_path_for(key, img, ilen, "image/jpeg");
  g_host->dealloc(img);
  char *u = cp ? cover_url_of(cp) : NULL;
  free(cp);
  return u;
}

static cJSON *track_json(const char *path, TrackMeta *m, const char *lrc_path) {
  cJSON *o = cJSON_CreateObject();
  char *id = M_id();
  cJSON_AddStringToObject(o, "id", id); free(id);
  cJSON_AddStringToObject(o, "path", path);
  cJSON_AddStringToObject(o, "title", m->title);
  cJSON_AddStringToObject(o, "artist", m->artist);
  cJSON_AddStringToObject(o, "album", m->album);
  json_set_int(o, "duration", m->duration);
  cJSON_AddStringToObject(o, "cover", m->cover);
  cJSON_AddStringToObject(o, "format", m->format);
  json_set_bool(o, "lossless", m->lossless);
  json_set_int(o, "sampleRate", m->sample_rate);
  json_set_int(o, "bitsPerSample", m->bits);
  json_set_int(o, "bitrate", m->bitrate);
  json_set_int(o, "addedAt", now_ms());
  cJSON_AddStringToObject(o, "lrcPath", lrc_path ? lrc_path : "");
  return o;
}
static cJSON *M_scan(void) {
  cJSON *root = ms_get_root();
  cJSON *roots = cJSON_GetObjectItemCaseSensitive(root, "roots");
  cJSON *tracks = cJSON_GetObjectItemCaseSensitive(root, "tracks");
  StrList files = {0};
  StrList live = {0}, dead = {0};
  int nr = cJSON_GetArraySize(roots);
  lrc_idx_clear();
  for (int i = 0; i < nr; i++) {
    cJSON *r = cJSON_GetArrayItem(roots, i);
    if (!cJSON_IsString(r)) continue;
    StrList one = {0};
    walk_audio(r->valuestring, &one, 0);
    walk_index_lrc(r->valuestring, 0);
    if (one.n) sl_add(&live, xstrdup(r->valuestring));
    else sl_add(&dead, xstrdup(r->valuestring));
    for (int k = 0; k < one.n; k++) sl_add(&files, one.v[k]);
    free(one.v);
  }
  /* 已有路径集合 */
  cJSON *keep = cJSON_CreateArray();
  int pruned = 0, pending = 0;
  cJSON *t = NULL;
  cJSON_ArrayForEach(t, tracks) {
    const char *p = json_str(t, "path", "");
    int in_live = 0;
    for (int i = 0; i < live.n; i++) if (path_under(p, live.v[i])) { in_live = 1; break; }
    if (in_live && !path_exists(p)) { pruned++; continue; }
    if (!in_live && !path_exists(p)) pending++;
    cJSON_AddItemToArray(keep, cJSON_Duplicate(t, 1));
  }
  /* 新文件 */
  int added = 0;
  for (int i = 0; i < files.n; i++) {
    int exists = 0;
    cJSON *x = NULL;
    cJSON_ArrayForEach(x, keep) if (!strcmp(json_str(x, "path", ""), files.v[i])) { exists = 1; break; }
    if (exists) continue;
    TrackMeta m; sniff_meta(files.v[i], &m);
    char *lrc = match_lrc(files.v[i], m.title, m.artist);
    cJSON *o = track_json(files.v[i], &m, lrc ? lrc : "");
    cJSON_AddItemToArray(keep, o);
    free(lrc);
    added++;
  }
  /* 补封面（库里空封面 / 缓存被清） */
  int covers = 0;
  int online_budget = 8;
  cJSON_ArrayForEach(t, keep) {
    const char *cv = json_str(t, "cover", "");
    int need = 0;
    if (!*cv || str_starts(cv, "http")) need = !*cv;
    else {
      char *p = mod_path_from_url(cv);
      if (!path_exists(p)) need = 1;
      free(p);
    }
    if (!need) continue;
    const char *tp = json_str(t, "path", "");
    TrackMeta m; sniff_meta(tp, &m);
    char *gotcv = m.cover[0] ? xstrdup(m.cover) : folder_cover_for(tp);
    if (!gotcv && online_budget > 0) {
      gotcv = online_cover_for(tp, m.title[0] ? m.title : json_str(t, "title", ""),
                               m.artist[0] ? m.artist : json_str(t, "artist", ""));
      online_budget--;
    }
    if (gotcv) {
      cJSON_DeleteItemFromObjectCaseSensitive(t, "cover");
      cJSON_AddStringToObject(t, "cover", gotcv);
      covers++;
      free(gotcv);
    }
  }
  cJSON_DeleteItemFromObjectCaseSensitive(root, "tracks");
  cJSON_AddItemToObject(root, "tracks", keep);
  ms_save(root);
  int total = cJSON_GetArraySize(keep);
  cJSON_Delete(root);
  /* 释放扫描表 */
  for (int i = 0; i < files.n; i++) free(files.v[i]);
  free(files.v);
  for (int i = 0; i < live.n; i++) free(live.v[i]);
  free(live.v);
  for (int i = 0; i < dead.n; i++) free(dead.v[i]);
  free(dead.v);
  ms_emit("scan");
  cJSON *out = cJSON_CreateObject();
  cJSON_AddNumberToObject(out, "added", added);
  cJSON_AddNumberToObject(out, "total", total);
  cJSON_AddNumberToObject(out, "pruned", pruned);
  cJSON_AddNumberToObject(out, "pending", pending);
  cJSON_AddNumberToObject(out, "covers", covers);
  return out;
}

/* ---------------- 网站抓取 / 服务器浏览 / 下载 ---------------- */
static int url_audio_ext(const char *u) {
  if (!u) return 0;
  char tmp[2048];
  size_t n = 0;
  for (const char *p = u; *p && n + 1 < sizeof(tmp); p++) {
    if (*p == '?' || *p == '#') break;
    tmp[n++] = *p;
  }
  tmp[n] = 0;
  const char *e = path_ext(tmp);
  const char *ok[] = { "mp3", "flac", "m4a", "aac", "ogg", "opus", "wav", "ape", "wma", "aiff", "aif", "dsf", "dff", "alac", NULL };
  for (int i = 0; ok[i]; i++) if (!_stricmp(e, ok[i])) return 1;
  return 0;
}
static int url_netdisk(const char *u) {
  const char *hosts[] = { "pan.baidu.com", "pan.quark.cn", "aliyundrive.com", "alipan.com",
    "pan.xunlei.com", "115.com", "lanzou", "cloud.189.cn", "weiyun.com", "mega.nz",
    "drive.google.com", "1drv.ms", "dropbox.com", NULL };
  for (int i = 0; hosts[i]; i++) if (u && strstr(u, hosts[i])) return 1;
  return 0;
}
static char *url_resolve(const char *base, const char *href) {
  if (!href || !*href) return NULL;
  if (!_strnicmp(href, "http://", 7) || !_strnicmp(href, "https://", 8)) return xstrdup(href);
  if (!strncmp(href, "//", 2)) {
    const char *sc = strstr(base, "://");
    if (!sc) return NULL;
    char *r = (char *)xmalloc(strlen(base) + strlen(href) + 4);
    size_t n = (size_t)(sc - base) + 1;
    memcpy(r, base, n); r[n] = 0;
    strcat(r, href);
    return r;
  }
  const char *sc = strstr(base, "://");
  if (!sc) return xstrdup(href);
  const char *host = sc + 3;
  const char *slash = strchr(host, '/');
  if (href[0] == '/') {
    size_t n = slash ? (size_t)(slash - base) : strlen(base);
    char *r = (char *)xmalloc(n + strlen(href) + 2);
    memcpy(r, base, n); r[n] = 0;
    strcat(r, href);
    return r;
  }
  char *b = xstrdup(base);
  char *q = strpbrk(b, "?#");
  if (q) *q = 0;
  char *last = strrchr(b, '/');
  if (!last || (slash && last < slash)) {
    free(b); b = (char *)xmalloc(strlen(base) + 2);
    snprintf(b, strlen(base) + 2, "%s/", base);
    last = b + strlen(b) - 1;
  }
  last[1] = 0;
  while (!strncmp(href, "./", 2)) href += 2;
  char *r = (char *)xmalloc(strlen(b) + strlen(href) + 2);
  sprintf(r, "%s%s", b, href);
  free(b);
  return r;
}
static int audio_has(cJSON *arr, const char *url) {
  cJSON *it = NULL;
  cJSON_ArrayForEach(it, arr) if (!strcmp(json_str(it, "url", ""), url)) return 1;
  return 0;
}
static void add_audio_link(cJSON *audio, cJSON *netdisk, const char *base, const char *href) {
  if (!href || !*href) return;
  char *u = url_resolve(base, href);
  if (!u) return;
  if (url_audio_ext(u)) {
    if (!audio_has(audio, u)) {
      char *clean = xstrdup(u);
      char *q = strpbrk(clean, "?#"); if (q) *q = 0;
      const char *bn = path_basename(clean);
      char *dn = url_decode(bn && *bn ? bn : "track");
      cJSON *o = cJSON_CreateObject();
      cJSON_AddStringToObject(o, "url", u);
      cJSON_AddStringToObject(o, "name", dn && *dn ? dn : "track");
      cJSON_AddItemToArray(audio, o);
      free(dn); free(clean);
    }
  } else if (url_netdisk(u)) {
    cJSON *it = NULL;
    int dup = 0;
    cJSON_ArrayForEach(it, netdisk) if (!strcmp(json_str(it, "url", ""), u)) { dup = 1; break; }
    if (!dup) {
      cJSON *o = cJSON_CreateObject();
      cJSON_AddStringToObject(o, "url", u);
      cJSON_AddItemToArray(netdisk, o);
    }
  }
  free(u);
}
static void collect_links(const char *base, const char *body, cJSON *audio, cJSON *netdisk) {
  if (!body) return;
  const char *keys[] = { "href=", "src=", "data-src=", "data-url=", "file:", NULL };
  for (int k = 0; keys[k]; k++) {
    const char *p = body;
    while ((p = strstr(p, keys[k])) != NULL) {
      p += strlen(keys[k]);
      while (*p == ' ' || *p == '\t' || *p == '"' || *p == '\'') p++;
      const char *e = p;
      while (*e && *e != '"' && *e != '\'' && *e != ' ' && *e != '<' && *e != '>' && *e != '\n' && *e != '\r') e++;
      if (e > p) {
        char *v = xstrndup(p, (size_t)(e - p));
        /* HTML 实体 */
        for (char *x = v; *x; x++) if (!strncmp(x, "&amp;", 5)) { *x = '&'; memmove(x + 1, x + 5, strlen(x + 5) + 1); }
        add_audio_link(audio, netdisk, base, v);
        free(v);
      }
      p = e;
    }
  }
  /* SPA / JS 里的裸 URL */
  const char *p = body;
  while ((p = strstr(p, "http")) != NULL) {
    if (_strnicmp(p, "http://", 7) && _strnicmp(p, "https://", 8)) { p += 4; continue; }
    const char *e = p;
    while (*e && *e != '"' && *e != '\'' && *e != ' ' && *e != '<' && *e != '>' && *e != ')' && *e != ']' && *e != '\n' && *e != '\r') e++;
    if (e > p) {
      char *v = xstrndup(p, (size_t)(e - p));
      add_audio_link(audio, netdisk, base, v);
      free(v);
    }
    p = e;
  }
}
static int crawl_one(const char *url, cJSON *audio, cJSON *netdisk, char **err) {
  int status = 0;
  char *body = g_host->http_request("GET", url,
      "Accept: text/html,application/json,application/xml;q=0.9,*/*;q=0.8\r\nUser-Agent: Mozilla/5.0\r\n",
      NULL, 0, 15000, &status, NULL);
  if (!body) { if (err) *err = xstrdup("打不开"); return 0; }
  int reached = status == 200;
  if (reached) collect_links(url, body, audio, netdisk);
  g_host->dealloc(body);
  if (!reached && err) { char b[64]; snprintf(b, sizeof(b), "HTTP %d", status); *err = xstrdup(b); }
  return reached;
}
static void sanitize_filename(char *s) {
  for (char *p = s; *p; p++) if (strchr("<>:\"/\\|?*", *p) || (unsigned char)*p < 32) *p = '_';
  if (!*s) strcpy(s, "track");
}
static char *download_dir(void) {
  cJSON *src = get_defaults("source");
  char *d = *json_str(src, "dir", "") ? xstrdup(json_str(src, "dir", "")) : NULL;
  cJSON_Delete(src);
  if (d) return d;
  cJSON *root = ms_get_root();
  cJSON *roots = cJSON_GetObjectItemCaseSensitive(root, "roots");
  cJSON *r0 = cJSON_GetArrayItem(roots, 0);
  if (cJSON_IsString(r0) && r0->valuestring[0]) d = xstrdup(r0->valuestring);
  cJSON_Delete(root);
  if (d) return d;
  char *music = special_folder(CSIDL_MYMUSIC);
  d = path_join(music && *music ? music : mod_data_dir(), "拾光集下载");
  free(music);
  return d;
}
static void add_downloaded_track(const char *path) {
  cJSON *root = ms_get_root();
  cJSON *tracks = cJSON_GetObjectItemCaseSensitive(root, "tracks");
  cJSON *it = NULL;
  cJSON_ArrayForEach(it, tracks) if (!strcmp(json_str(it, "path", ""), path)) { cJSON_Delete(root); return; }
  TrackMeta m; sniff_meta(path, &m);
  char *lrc = match_lrc(path, m.title, m.artist);
  cJSON *o = track_json(path, &m, lrc ? lrc : "");
  free(lrc);
  if (!m.cover[0]) {
    char *fc = folder_cover_for(path);
    if (!fc) fc = online_cover_for(path, m.title[0] ? m.title : path_basename(path),
                                   m.artist[0] ? m.artist : "");
    if (fc) { cJSON_DeleteItemFromObjectCaseSensitive(o, "cover"); cJSON_AddStringToObject(o, "cover", fc); free(fc); }
  }
  cJSON_AddItemToArray(tracks, o);
  ms_save(root);
  cJSON_Delete(root);
  ms_emit("download");
}
static int download_one(const char *url, const char *name, const char *dir) {
  int status = 0;
  size_t len = 0;
  unsigned char *body = (unsigned char *)g_host->http_request("GET", url,
      "Accept: audio/*,*/*;q=0.8\r\nUser-Agent: Mozilla/5.0\r\n", NULL, 0, 180000, &status, &len);
  if (!body) return 0;
  int ok = status == 200 && len > 1024;
  if (ok) {
    unsigned char c0 = body[0];
    if (c0 == '<' || (len > 4 && !memcmp(body, "<?xml", 5)) || (len > 15 && !memcmp(body, "<!DOCTYPE", 9))) ok = 0;
  }
  if (!ok) { g_host->dealloc(body); return 0; }
  char fn[MAX_PATH];
  snprintf(fn, sizeof(fn), "%s", name && *name ? name : path_basename(url));
  sanitize_filename(fn);
  const char *ext = path_ext(fn);
  if (!*ext) {
    const char *ue = path_ext(url);
    if (*ue) { size_t n = strlen(fn); snprintf(fn + n, sizeof(fn) - n, ".%s", ue); }
    else strncat(fn, ".mp3", sizeof(fn) - strlen(fn) - 1);
  }
  char *dest = path_join(dir, fn);
  if (path_exists(dest)) {
    /* 防重名：加序号 */
    for (int i = 2; i < 100; i++) {
      char base[MAX_PATH]; snprintf(base, sizeof(base), "%s", fn);
      char *dot = strrchr(base, '.');
      char cand[MAX_PATH];
      if (dot) { *dot = 0; snprintf(cand, sizeof(cand), "%s (%d).%s", base, i, dot + 1); }
      else snprintf(cand, sizeof(cand), "%s (%d)", base, i);
      char *nd = path_join(dir, cand);
      if (!path_exists(nd)) { free(dest); dest = nd; break; }
      free(nd);
    }
  }
  int wrote = file_write_all(dest, body, len);
  g_host->dealloc(body);
  if (!wrote) { free(dest); return 0; }
  add_downloaded_track(dest);
  free(dest);
  return 1;
}

/* ---------------- 公开歌单（网易云分享链接，不需要登录） ---------------- */
static int text_same(const char *a, const char *b) {
  if (!a || !b) return 0;
  char *x = str_lower(a), *y = str_lower(b);
  for (char *p = x; *p; p++) if (*p == ' ' || *p == '\t') memmove(p, p + 1, strlen(p));
  for (char *p = y; *p; p++) if (*p == ' ' || *p == '\t') memmove(p, p + 1, strlen(p));
  int same = !strcmp(x, y);
  free(x); free(y);
  return same;
}
static cJSON *local_track_match(const char *title, const char *artist, const char **how) {
  cJSON *root = ms_get_root();
  cJSON *tracks = cJSON_GetObjectItemCaseSensitive(root, "tracks");
  cJSON *best = NULL;
  cJSON *t = NULL;
  cJSON_ArrayForEach(t, tracks) {
    const char *lt = json_str(t, "title", "");
    const char *la = json_str(t, "artist", "");
    if (text_same(title, lt)) {
      if (!*artist || text_same(artist, la) || strstr(la, artist) || strstr(artist, la)) {
        best = cJSON_Duplicate(t, 1);
        if (how) *how = "标题 + 歌手";
        break;
      }
      if (!best) { best = cJSON_Duplicate(t, 1); if (how) *how = "标题"; }
    }
  }
  cJSON_Delete(root);
  return best;
}
static char *login_cookie(const char *platform) {
  cJSON *root = ms_get_root();
  cJSON *logins = cJSON_GetObjectItemCaseSensitive(root, "logins");
  cJSON *lg = cJSON_GetObjectItemCaseSensitive(logins, platform);
  char *cookie = *json_str(lg, "cookie", "") ? xstrdup(json_str(lg, "cookie", "")) : NULL;
  cJSON_Delete(root);
  return cookie;
}
static char *playlist_id_of(const char *link) {
  const char *p = link ? strstr(link, "id=") : NULL;
  if (p) p += 3;
  else if (link) p = strstr(link, "playlist/");
  if (p && !strncmp(p, "playlist/", 9)) p += 9;
  if (!p) return NULL;
  int n = 0;
  while (p[n] >= '0' && p[n] <= '9') n++;
  return n ? xstrndup(p, (size_t)n) : NULL;
}
static cJSON *online_playlist_preview(const char *link) {
  char *pid = playlist_id_of(link);
  if (!pid) return NULL;
  size_t cap = strlen(pid) + 160;
  char *url = (char *)xmalloc(cap);
  snprintf(url, cap, "https://music.163.com/api/v6/playlist/detail?id=%s&n=1000", pid);
  int status = 0;
  char *ck = login_cookie("netease");
  size_t hcap = (ck ? strlen(ck) : 0) + 160;
  char *headers = (char *)xmalloc(hcap);
  if (ck && *ck) snprintf(headers, hcap, "Cookie: %s\r\nAccept: application/json\r\nReferer: https://music.163.com/\r\nUser-Agent: Mozilla/5.0\r\n", ck);
  else snprintf(headers, hcap, "Accept: application/json\r\nReferer: https://music.163.com/\r\nUser-Agent: Mozilla/5.0\r\n");
  free(ck);
  char *body = g_host->http_request("GET", url, headers,
      NULL, 0, 8000, &status, NULL);
  free(headers);
  free(url); free(pid);
  if (!body || status != 200) { if (body) g_host->dealloc(body); return NULL; }
  cJSON *j = cJSON_Parse(body);
  g_host->dealloc(body);
  cJSON *pl = j ? cJSON_GetObjectItemCaseSensitive(j, "playlist") : NULL;
  if (!cJSON_IsObject(pl)) { cJSON_Delete(j); return NULL; }
  cJSON *out = cJSON_CreateObject();
  cJSON_AddStringToObject(out, "name", json_str(pl, "name", "在线歌单"));
  cJSON_AddStringToObject(out, "cover", json_str(pl, "coverImgUrl", ""));
  cJSON *cr = cJSON_GetObjectItemCaseSensitive(pl, "creator");
  cJSON_AddStringToObject(out, "creator", cr ? json_str(cr, "nickname", "") : "");
  cJSON *src = cJSON_CreateObject();
  cJSON_AddStringToObject(src, "link", link);
  cJSON_AddStringToObject(src, "platform", "netease");
  cJSON_AddStringToObject(src, "platformName", "网易云音乐");
  cJSON_AddItemToObject(out, "source", src);
  cJSON *tracks = cJSON_GetObjectItemCaseSensitive(pl, "tracks");
  int total = cJSON_GetArraySize(tracks);
  cJSON_AddNumberToObject(out, "total", total);
  cJSON *items = cJSON_CreateArray();
  int matched = 0;
  cJSON *t = NULL;
  cJSON_ArrayForEach(t, tracks) {
    const char *title = json_str(t, "name", "");
    if (!*title) continue;
    cJSON *ars = cJSON_GetObjectItemCaseSensitive(t, "ar");
    char artist[512] = "";
    cJSON *a = NULL;
    cJSON_ArrayForEach(a, ars) {
      const char *an = json_str(a, "name", "");
      if (*an) {
        if (*artist) strncat(artist, "/", sizeof(artist) - strlen(artist) - 1);
        strncat(artist, an, sizeof(artist) - strlen(artist) - 1);
      }
    }
    cJSON *al = cJSON_GetObjectItemCaseSensitive(t, "al");
    const char *album = al ? json_str(al, "name", "") : "";
    int dur = (int)(json_num(t, "dt", 0) / 1000);
    const char *how = "";
    cJSON *local = local_track_match(title, artist, &how);
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "title", title);
    cJSON_AddStringToObject(o, "artist", artist);
    cJSON_AddStringToObject(o, "album", album);
    json_set_int(o, "duration", dur);
    json_set_bool(o, "matched", local ? 1 : 0);
    if (local) {
      cJSON_AddStringToObject(o, "trackId", json_str(local, "id", ""));
      cJSON_AddStringToObject(o, "matchHow", how);
      matched++;
      cJSON_Delete(local);
    }
    cJSON_AddItemToArray(items, o);
  }
  cJSON_Delete(j);
  cJSON_AddItemToObject(out, "items", items);
  cJSON_AddNumberToObject(out, "matched", matched);
  cJSON_AddNumberToObject(out, "missing", total - matched);
  json_set_bool(out, "partial", total >= 1000);
  return out;
}

/* ---------------- 播放列表 / 统计 ---------------- */
static cJSON *pl_find(cJSON *playlists, const char *id) {
  cJSON *it = NULL;
  cJSON_ArrayForEach(it, playlists) if (!strcmp(json_str(it, "id", ""), id)) return it;
  return NULL;
}
static cJSON *M_add_playlist(const char *name, cJSON *opts) {
  cJSON *root = ms_get_root();
  cJSON *pls = cJSON_GetObjectItemCaseSensitive(root, "playlists");
  cJSON *o = cJSON_CreateObject();
  char *id = M_id();
  cJSON_AddStringToObject(o, "id", id); free(id);
  cJSON_AddStringToObject(o, "name", name && *name ? name : "新歌单");
  cJSON *tracks = cJSON_CreateArray();
  if (opts) {
    cJSON *tr = cJSON_GetObjectItemCaseSensitive(opts, "tracks");
    if (cJSON_IsArray(tr)) {
      cJSON *x = NULL;
      cJSON_ArrayForEach(x, tr) if (cJSON_IsString(x)) cJSON_AddItemToArray(tracks, cJSON_CreateString(x->valuestring));
    }
  }
  cJSON_AddItemToObject(o, "tracks", tracks);
  cJSON_AddStringToObject(o, "cover", opts ? json_str(opts, "cover", "") : "");
  json_set_int(o, "createdAt", now_ms());
  json_set_int(o, "updatedAt", now_ms());
  cJSON_AddItemToArray(pls, o);
  ms_save(root);
  cJSON *res = cJSON_Duplicate(o, 1);
  cJSON_Delete(root);
  ms_emit("playlist");
  return res;
}
static cJSON *M_update_playlist(const char *id, cJSON *patch) {
  cJSON *root = ms_get_root();
  cJSON *pls = cJSON_GetObjectItemCaseSensitive(root, "playlists");
  cJSON *p = pl_find(pls, id);
  if (!p) { cJSON_Delete(root); return NULL; }
  if (patch) {
    cJSON *it = NULL;
    cJSON_ArrayForEach(it, patch) {
      if (!it->string) continue;
      cJSON_DeleteItemFromObjectCaseSensitive(p, it->string);
      cJSON_AddItemToObject(p, it->string, cJSON_Duplicate(it, 1));
    }
  }
  json_set_int(p, "updatedAt", now_ms());
  ms_save(root);
  cJSON *res = cJSON_Duplicate(p, 1);
  cJSON_Delete(root);
  ms_emit("playlist");
  return res;
}
static cJSON *M_add_to_playlist(const char *id, cJSON *ids) {
  cJSON *root = ms_get_root();
  cJSON *pls = cJSON_GetObjectItemCaseSensitive(root, "playlists");
  cJSON *p = pl_find(pls, id);
  if (!p) { cJSON_Delete(root); return NULL; }
  cJSON *tr = cJSON_GetObjectItemCaseSensitive(p, "tracks");
  if (!cJSON_IsArray(tr)) { tr = cJSON_CreateArray(); cJSON_AddItemToObject(p, "tracks", tr); }
  cJSON *x = NULL;
  cJSON_ArrayForEach(x, ids) {
    if (!cJSON_IsString(x)) continue;
    int has = 0;
    cJSON *y = NULL;
    cJSON_ArrayForEach(y, tr) if (cJSON_IsString(y) && !strcmp(y->valuestring, x->valuestring)) has = 1;
    if (!has) cJSON_AddItemToArray(tr, cJSON_CreateString(x->valuestring));
  }
  json_set_int(p, "updatedAt", now_ms());
  ms_save(root);
  cJSON *res = cJSON_Duplicate(p, 1);
  cJSON_Delete(root);
  ms_emit("playlist");
  return res;
}

static void day_key(int64_t ms, char *out, size_t n) { local_date_str(ms, out, n); }
static cJSON *M_stats(const char *period, int offset) {
  if (!period) period = "week";
  SYSTEMTIME now_st; GetLocalTime(&now_st);
  int64_t now = now_ms();
  int64_t start = 0, end = 0, prev_start = 0, prev_end = 0;
  int day_count = 0;
  char label[64] = "";
  if (!strcmp(period, "year")) {
    int y = now_st.wYear + offset;
    start = local_day_start_ms_ymd(y, 1, 1);
    end = local_day_start_ms_ymd(y + 1, 1, 1);
    prev_start = local_day_start_ms_ymd(y - 1, 1, 1);
    prev_end = start;
    day_count = 365;
    snprintf(label, sizeof(label), "%d 年", y);
  } else if (!strcmp(period, "month")) {
    int y = now_st.wYear, m = now_st.wMonth + offset;
    while (m <= 0) { m += 12; y--; }
    while (m > 12) { m -= 12; y++; }
    start = local_day_start_ms_ymd(y, m, 1);
    int ny = y, nm = m + 1; if (nm > 12) { nm = 1; ny++; }
    end = local_day_start_ms_ymd(ny, nm, 1);
    int py = y, pm = m - 1; if (pm < 1) { pm = 12; py--; }
    prev_start = local_day_start_ms_ymd(py, pm, 1);
    prev_end = start;
    day_count = (int)((end - start) / 86400000);
    snprintf(label, sizeof(label), "%d 年 %d 月", y, m);
  } else {
    int64_t day = local_day_start_ms(now);
    SYSTEMTIME ds; FILETIME ft; ULARGE_INTEGER u; u.QuadPart = (ULONGLONG)(day + INT64_C(11644473600000)) * 10000ULL; ft.dwLowDateTime = u.LowPart; ft.dwHighDateTime = u.HighPart; FileTimeToSystemTime(&ft, &ds);
    int wd = ds.wDayOfWeek; /* 0=Sun */
    int monday_off = (wd + 6) % 7;
    start = day - (int64_t)monday_off * 86400000 + (int64_t)offset * 7 * 86400000;
    end = start + 7 * 86400000;
    prev_start = start - 7 * 86400000;
    prev_end = start;
    day_count = 7;
    char a[16], b[16]; local_date_str(start, a, sizeof(a)); local_date_str(end - 1, b, sizeof(b));
    snprintf(label, sizeof(label), "%.5s - %.5s", a + 5, b + 5);
  }
  cJSON *root = ms_get_root();
  cJSON *plays = cJSON_GetObjectItemCaseSensitive(root, "plays");
  cJSON *tracks = cJSON_GetObjectItemCaseSensitive(root, "tracks");
  /* 日/月桶 */
  int nb = !strcmp(period, "year") ? 12 : day_count;
  long long *secs = (long long *)xcalloc((size_t)nb, sizeof(long long));
  double total = 0, prev_total = 0;
  int listened = 0;
  int64_t latest = 0, first_ts = 0, last_ts = 0;
  int64_t lifetime = 0;
  cJSON *day = NULL;
  cJSON_ArrayForEach(day, plays) {
    if (!day->string) continue;
    double dsec = json_num(day, "sec", 0);
    lifetime += (int64_t)dsec;
    int y = 0, m = 0, d = 0;
    if (sscanf(day->string, "%d-%d-%d", &y, &m, &d) != 3) continue;
    int64_t t = local_day_start_ms_ymd(y, m, d);
    if (t >= start && t < end) {
      total += dsec;
      int bi;
      if (!strcmp(period, "year")) bi = m - 1; else bi = (int)((t - start) / 86400000);
      if (bi >= 0 && bi < nb) secs[bi] += (long long)dsec;
      if (dsec > 0) listened++;
      int64_t ft = (int64_t)json_num(day, "first", 0), lt = (int64_t)json_num(day, "last", 0);
      if (ft && (!first_ts || ft < first_ts)) first_ts = ft;
      if (lt > last_ts) last_ts = lt;
      if (lt > latest) latest = lt;
    } else if (t >= prev_start && t < prev_end) prev_total += dsec;
  }
  long long maxb = 0;
  for (int i = 0; i < nb; i++) if (secs[i] > maxb) maxb = secs[i];
  cJSON *buckets = cJSON_CreateArray();
  for (int i = 0; i < nb; i++) {
    cJSON *b = cJSON_CreateObject();
    char key[32], lab[16];
    if (!strcmp(period, "year")) { snprintf(key, sizeof(key), "%d-%02d", now_st.wYear + offset, i + 1); snprintf(lab, sizeof(lab), "%d", i + 1); }
    else {
      int64_t t = start + (int64_t)i * 86400000;
      local_date_str(t, key, sizeof(key));
      SYSTEMTIME ds; FILETIME ft; ULARGE_INTEGER u; u.QuadPart = (ULONGLONG)(t + INT64_C(11644473600000)) * 10000ULL; ft.dwLowDateTime = u.LowPart; ft.dwHighDateTime = u.HighPart; FileTimeToSystemTime(&ft, &ds);
      snprintf(lab, sizeof(lab), "%d", ds.wDay);
      cJSON_AddNumberToObject(b, "wd", (ds.wDayOfWeek + 6) % 7);
      char today[16]; local_date_str(now, today, sizeof(today));
      cJSON_AddBoolToObject(b, "isToday", !strcmp(key, today));
    }
    cJSON_AddStringToObject(b, "key", key);
    cJSON_AddStringToObject(b, "label", lab);
    cJSON_AddStringToObject(b, "unit", !strcmp(period, "year") ? "月" : "日");
    cJSON_AddNumberToObject(b, "sec", (double)secs[i]);
    int lvl = 0;
    if (maxb > 0) { double f = (double)secs[i] / (double)maxb; lvl = secs[i] == 0 ? 0 : f > 0.75 ? 4 : f > 0.5 ? 3 : f > 0.25 ? 2 : 1; }
    cJSON_AddNumberToObject(b, "level", lvl);
    cJSON_AddItemToArray(buckets, b);
  }
  free(secs);
  /* 曲目聚合 */
  cJSON *agg = cJSON_CreateObject(); /* id -> {n,sec} */
  cJSON_ArrayForEach(day, plays) {
    if (!day->string) continue;
    int y = 0, m = 0, d = 0;
    if (sscanf(day->string, "%d-%d-%d", &y, &m, &d) != 3) continue;
    int64_t t = local_day_start_ms_ymd(y, m, d);
    if (t < start || t >= end) continue;
    cJSON *tr = cJSON_GetObjectItemCaseSensitive(day, "tracks");
    cJSON *tt = NULL;
    cJSON_ArrayForEach(tt, tr) {
      if (!tt->string) continue;
      double n = json_num(tt, "n", 0), sec = json_num(tt, "sec", 0);
      cJSON *a = cJSON_GetObjectItemCaseSensitive(agg, tt->string);
      if (!a) { a = cJSON_CreateObject(); cJSON_AddNumberToObject(a, "n", 0); cJSON_AddNumberToObject(a, "sec", 0); cJSON_AddItemToObject(agg, tt->string, a); }
      cJSON_GetObjectItemCaseSensitive(a, "n")->valuedouble += n;
      cJSON_GetObjectItemCaseSensitive(a, "sec")->valuedouble += sec;
    }
  }
  cJSON *topTracks = cJSON_CreateArray(), *topArtists = cJSON_CreateArray(), *wall = cJSON_CreateArray();
  cJSON *artistAgg = cJSON_CreateObject();
  cJSON *at = NULL;
  cJSON_ArrayForEach(at, agg) {
    const char *tid = at->string;
    cJSON *tr = NULL, *found = NULL;
    cJSON_ArrayForEach(tr, tracks) if (!strcmp(json_str(tr, "id", ""), tid)) { found = tr; break; }
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "id", tid);
    cJSON_AddStringToObject(o, "title", found ? json_str(found, "title", "") : "");
    cJSON_AddStringToObject(o, "artist", found ? json_str(found, "artist", "") : "");
    cJSON_AddStringToObject(o, "album", found ? json_str(found, "album", "") : "");
    cJSON_AddStringToObject(o, "cover", found ? json_str(found, "cover", "") : "");
    cJSON_AddNumberToObject(o, "n", json_num(at, "n", 0));
    cJSON_AddNumberToObject(o, "sec", json_num(at, "sec", 0));
    cJSON_AddItemToArray(wall, cJSON_Duplicate(o, 1));
    if (found) {
      const char *ar = json_str(found, "artist", "");
      cJSON *ao = cJSON_GetObjectItemCaseSensitive(artistAgg, ar);
      if (!ao) { ao = cJSON_CreateObject(); cJSON_AddStringToObject(ao, "artist", ar); cJSON_AddNumberToObject(ao, "n", 0); cJSON_AddStringToObject(ao, "cover", json_str(found, "cover", "")); cJSON_AddItemToObject(artistAgg, ar, ao); }
      cJSON_GetObjectItemCaseSensitive(ao, "n")->valuedouble += json_num(at, "n", 0);
    }
    cJSON_Delete(o);
  }
  /* 排序（简单插入排序） */
  cJSON *arrs[2] = { wall, topTracks };
  (void)arrs;
  int wn = cJSON_GetArraySize(wall);
  for (int i = 0; i < wn; i++) for (int j = i + 1; j < wn; j++) {
    cJSON *a = cJSON_GetArrayItem(wall, i), *b = cJSON_GetArrayItem(wall, j);
    if (json_num(b, "n", 0) > json_num(a, "n", 0)) {
      cJSON *ta = cJSON_Duplicate(a, 1), *tb = cJSON_Duplicate(b, 1);
      cJSON_ReplaceItemInArray(wall, i, tb); cJSON_ReplaceItemInArray(wall, j, ta);
    }
  }
  for (int i = 0; i < wn && i < 3; i++) cJSON_AddItemToArray(topTracks, cJSON_Duplicate(cJSON_GetArrayItem(wall, i), 1));
  int an = cJSON_GetArraySize(artistAgg);
  for (int i = 0; i < an; i++) {
    cJSON *best = NULL;
    cJSON *x = NULL;
    cJSON_ArrayForEach(x, artistAgg) {
      if (json_bool(x, "__used", 0)) continue;
      if (!best || json_num(x, "n", 0) > json_num(best, "n", 0)) best = x;
    }
    if (!best) break;
    json_set_bool(best, "__used", 1);
    cJSON *o = cJSON_Duplicate(best, 1);
    cJSON_DeleteItemFromObjectCaseSensitive(o, "__used");
    cJSON_AddItemToArray(topArtists, o);
    if (cJSON_GetArraySize(topArtists) >= 3) break;
  }
  cJSON_Delete(artistAgg);
  cJSON_Delete(agg);

  /* 语言占比（按曲目数，猜字符集） */
  const char *langNames[] = { "华语", "日语", "韩语", "英语", "其他" };
  int langCnt[5] = {0, 0, 0, 0, 0};
  cJSON *wl = NULL;
  cJSON_ArrayForEach(wl, wall) {
    const char *txt = json_str(wl, "title", "");
    int kana = 0, hangul = 0, han = 0, latin = 0;
    for (const unsigned char *p = (const unsigned char *)txt; *p;) {
      unsigned c = *p;
      if (c < 0x80) { if (isalpha(c)) latin++; p++; }
      else if ((c & 0xF0) == 0xE0) {
        unsigned u = ((c & 0x0F) << 12) | ((p[1] & 0x3F) << 6) | (p[2] & 0x3F);
        if (u >= 0x3040 && u <= 0x30FF) kana++;
        else if (u >= 0x4E00 && u <= 0x9FFF) han++;
        p += 3;
      } else if ((c & 0xF0) == 0xF0) p += 4;
      else p += 2;
    }
    int idx = kana ? 1 : han ? 0 : latin ? 3 : 4;
    (void)hangul;
    langCnt[idx]++;
  }
  int totalTracks = cJSON_GetArraySize(wall);
  cJSON *langs = cJSON_CreateArray();
  for (int i = 0; i < 5; i++) {
    if (!langCnt[i]) continue;
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "key", langNames[i]);
    cJSON_AddNumberToObject(o, "n", langCnt[i]);
    cJSON_AddNumberToObject(o, "pct", totalTracks ? (int)(langCnt[i] * 100.0 / totalTracks + 0.5) : 0);
    cJSON_AddItemToArray(langs, o);
  }
  /* 年代：按专辑名里的年份猜，猜不到就不列 */
  cJSON *eras = cJSON_CreateArray();
  char clock[16] = "";
  if (latest) {
    SYSTEMTIME st; FILETIME ft; ULARGE_INTEGER u; u.QuadPart = (ULONGLONG)(latest + INT64_C(11644473600000)) * 10000ULL; ft.dwLowDateTime = u.LowPart; ft.dwHighDateTime = u.HighPart; FileTimeToSystemTime(&ft, &st);
    snprintf(clock, sizeof(clock), "%02d:%02d", (st.wHour + 8) % 24, st.wMinute);
  }
  cJSON *out = cJSON_CreateObject();
  cJSON_AddStringToObject(out, "period", period);
  cJSON_AddNumberToObject(out, "offset", offset);
  cJSON_AddStringToObject(out, "label", label);
  json_set_int(out, "start", start);
  json_set_int(out, "end", end);
  cJSON_AddNumberToObject(out, "dayCount", day_count);
  cJSON_AddBoolToObject(out, "isCurrent", offset == 0);
  cJSON_AddNumberToObject(out, "totalSec", total);
  cJSON_AddNumberToObject(out, "listenedDays", listened);
  json_set_int(out, "firstTs", first_ts);
  json_set_int(out, "lastTs", last_ts);
  json_set_int(out, "latestAt", latest);
  cJSON_AddNumberToObject(out, "latestMin", (latest ? (int)((latest / 60000) % 1440) : 0));
  cJSON_AddItemToObject(out, "buckets", buckets);
  cJSON_AddNumberToObject(out, "maxBucketSec", (double)maxb);
  cJSON_AddItemToObject(out, "wall", wall);
  cJSON_AddNumberToObject(out, "wallCount", totalTracks);
  cJSON_AddItemToObject(out, "topTracks", topTracks);
  cJSON_AddItemToObject(out, "topArtists", topArtists);
  cJSON_AddItemToObject(out, "eras", eras);
  cJSON_AddItemToObject(out, "langs", langs);
  json_set_int(out, "lifetimeSec", lifetime);
  cJSON_AddNumberToObject(out, "prevTotalSec", prev_total);
  cJSON_AddNumberToObject(out, "deltaSec", total - prev_total);
  cJSON_AddStringToObject(out, "clock", clock);
  cJSON_AddBoolToObject(out, "hasData", total > 0);
  cJSON_AddItemToObject(out, "tracks", cJSON_CreateArray());
  cJSON_Delete(root);
  return out;
}

/* 把 yyyy-mm-dd 的天桶写回 */
static void M_log_play(cJSON *o) {
  const char *id = o ? json_str(o, "trackId", json_str(o, "id", "")) : "";
  int sec = o ? json_int(o, "sec", 0) : 0;
  if (!*id || sec <= 0) return;
  if (sec > 6 * 3600) sec = 6 * 3600;
  int64_t at = o && json_num(o, "at", 0) > 0 ? (int64_t)json_num(o, "at", 0) : now_ms();
  cJSON *root = ms_get_root();
  cJSON *plays = cJSON_GetObjectItemCaseSensitive(root, "plays");
  char k[16]; day_key(at, k, sizeof(k));
  cJSON *d = cJSON_GetObjectItemCaseSensitive(plays, k);
  if (!d) { d = cJSON_CreateObject(); cJSON_AddItemToObject(plays, k, d); }
  double ds = json_num(d, "sec", 0) + sec;
  json_set_num(d, "sec", ds);
  double first = json_num(d, "first", 0);
  if (!first || at < first) json_set_int(d, "first", at);
  double last = json_num(d, "last", 0);
  if (at > last) json_set_int(d, "last", at);
  cJSON *tr = cJSON_GetObjectItemCaseSensitive(d, "tracks");
  if (!cJSON_IsObject(tr)) { tr = cJSON_CreateObject(); cJSON_DeleteItemFromObjectCaseSensitive(d, "tracks"); cJSON_AddItemToObject(d, "tracks", tr); }
  cJSON *rec = cJSON_GetObjectItemCaseSensitive(tr, id);
  if (!rec) { rec = cJSON_CreateObject(); cJSON_AddNumberToObject(rec, "n", 0); cJSON_AddNumberToObject(rec, "sec", 0); cJSON_AddItemToObject(tr, id, rec); }
  cJSON_GetObjectItemCaseSensitive(rec, "n")->valuedouble += 1;
  cJSON_GetObjectItemCaseSensitive(rec, "sec")->valuedouble += sec;
  ms_save(root);
  cJSON_Delete(root);
}

/* ---------------- 配置类 ---------------- */
static cJSON *get_defaults(const char *key) {
  cJSON *m = mod_store_get("music");
  cJSON *v = m ? cJSON_GetObjectItemCaseSensitive(m, key) : NULL;
  cJSON *out = v ? cJSON_Duplicate(v, 1) : cJSON_CreateObject();
  if (m) cJSON_Delete(m);
  if (!cJSON_IsObject(out)) { cJSON_Delete(out); out = cJSON_CreateObject(); }
  return out;
}
static void set_defaults(const char *key, cJSON *v) {
  cJSON *m = ms_get_root();
  cJSON_DeleteItemFromObjectCaseSensitive(m, key);
  cJSON_AddItemToObject(m, key, cJSON_Duplicate(v, 1));
  ms_save(m);
  cJSON_Delete(m);
}
static cJSON *daily_config(void) {
  cJSON *c = get_defaults("daily");
  if (!cJSON_GetObjectItemCaseSensitive(c, "dir")) cJSON_AddStringToObject(c, "dir", "");
  if (!cJSON_GetObjectItemCaseSensitive(c, "enabled")) cJSON_AddBoolToObject(c, "enabled", 0);
  if (!cJSON_GetObjectItemCaseSensitive(c, "autoClean")) cJSON_AddBoolToObject(c, "autoClean", 1);
  if (!cJSON_GetObjectItemCaseSensitive(c, "quality")) cJSON_AddStringToObject(c, "quality", "highest");
  if (!cJSON_GetObjectItemCaseSensitive(c, "limit")) cJSON_AddNumberToObject(c, "limit", 30);
  if (!cJSON_GetObjectItemCaseSensitive(c, "sources")) cJSON_AddItemToObject(c, "sources", cJSON_CreateArray());
  if (!cJSON_GetObjectItemCaseSensitive(c, "base")) cJSON_AddStringToObject(c, "base", "");
  if (!cJSON_GetObjectItemCaseSensitive(c, "lastRun")) cJSON_AddStringToObject(c, "lastRun", "");
  if (!cJSON_GetObjectItemCaseSensitive(c, "batch")) cJSON_AddItemToObject(c, "batch", cJSON_CreateNull());
  return c;
}

/* ---------------- 分发 ---------------- */
static int music_invoke(const char *channel, const char *args_json, char **out_json, char **out_error) {
  cJSON *args = mod_parse_args(args_json);
  int rc = 0;
  cJSON *res = NULL;

  if (!strcmp(channel, "music:list")) {
    cJSON *root = ms_get_root();
    res = cJSON_Duplicate(cJSON_GetObjectItemCaseSensitive(root, "tracks"), 1);
    cJSON_Delete(root);
  } else if (!strcmp(channel, "music:roots")) {
    cJSON *root = ms_get_root();
    res = cJSON_Duplicate(cJSON_GetObjectItemCaseSensitive(root, "roots"), 1);
    cJSON_Delete(root);
  } else if (!strcmp(channel, "music:setRoots")) {
    cJSON *r = mod_arg_at(args, 0);
    cJSON *root = ms_get_root();
    cJSON *arr = cJSON_CreateArray();
    cJSON *x = NULL;
    cJSON_ArrayForEach(x, r) if (cJSON_IsString(x) && *x->valuestring) {
      int has = 0;
      cJSON *y = NULL;
      cJSON_ArrayForEach(y, arr) if (cJSON_IsString(y) && !_stricmp(y->valuestring, x->valuestring)) has = 1;
      if (!has) cJSON_AddItemToArray(arr, cJSON_CreateString(x->valuestring));
    }
    cJSON_DeleteItemFromObjectCaseSensitive(root, "roots");
    cJSON_AddItemToObject(root, "roots", arr);
    ms_save(root);
    cJSON_Delete(root);
    res = cJSON_Duplicate(arr, 1);
    ms_emit("roots");
  } else if (!strcmp(channel, "music:scan")) {
    res = M_scan();
  } else if (!strcmp(channel, "music:importFiles")) {
    cJSON *files = mod_arg_at(args, 0);
    cJSON *root = ms_get_root();
    cJSON *tracks = cJSON_GetObjectItemCaseSensitive(root, "tracks");
    int added = 0;
    cJSON *x = NULL;
    cJSON_ArrayForEach(x, files) {
      if (!cJSON_IsString(x)) continue;
      char *p = mod_path_from_url(x->valuestring);
      if (!path_exists(p)) { free(p); continue; }
      int has = 0;
      cJSON *t = NULL;
      cJSON_ArrayForEach(t, tracks) if (!strcmp(json_str(t, "path", ""), p)) has = 1;
      if (!has) {
        TrackMeta m; sniff_meta(p, &m);
        char *lrc = match_lrc(p, m.title, m.artist);
        cJSON_AddItemToArray(tracks, track_json(p, &m, lrc ? lrc : ""));
        free(lrc);
        added++;
      }
      free(p);
    }
    ms_save(root);
    cJSON_Delete(root);
    ms_emit("import");
    res = cJSON_CreateObject();
    cJSON_AddNumberToObject(res, "added", added);
  } else if (!strcmp(channel, "music:removeTrack")) {
    const char *id = mod_arg_str(args, 0, "");
    cJSON *root = ms_get_root();
    cJSON *tracks = cJSON_GetObjectItemCaseSensitive(root, "tracks");
    cJSON *out = cJSON_CreateArray();
    cJSON *t = NULL;
    cJSON_ArrayForEach(t, tracks) if (strcmp(json_str(t, "id", ""), id)) cJSON_AddItemToArray(out, cJSON_Duplicate(t, 1));
    cJSON_DeleteItemFromObjectCaseSensitive(root, "tracks");
    cJSON_AddItemToObject(root, "tracks", out);
    cJSON *pls = cJSON_GetObjectItemCaseSensitive(root, "playlists");
    cJSON *p = NULL;
    cJSON_ArrayForEach(p, pls) {
      cJSON *pt = cJSON_GetObjectItemCaseSensitive(p, "tracks");
      if (!cJSON_IsArray(pt)) continue;
      cJSON *keep = cJSON_CreateArray();
      cJSON *x = NULL;
      cJSON_ArrayForEach(x, pt) if (!(cJSON_IsString(x) && !strcmp(x->valuestring, id))) cJSON_AddItemToArray(keep, cJSON_Duplicate(x, 1));
      cJSON_DeleteItemFromObjectCaseSensitive(p, "tracks");
      cJSON_AddItemToObject(p, "tracks", keep);
    }
    ms_save(root);
    cJSON_Delete(root);
    ms_emit("remove");
    res = cJSON_CreateBool(1);
  } else if (!strcmp(channel, "music:playlists")) {
    cJSON *root = ms_get_root();
    res = cJSON_Duplicate(cJSON_GetObjectItemCaseSensitive(root, "playlists"), 1);
    cJSON_Delete(root);
  } else if (!strcmp(channel, "music:addPlaylist")) {
    res = M_add_playlist(mod_arg_str(args, 0, "新歌单"), mod_arg_obj(args, 1));
  } else if (!strcmp(channel, "music:updatePlaylist")) {
    cJSON *r = M_update_playlist(mod_arg_str(args, 0, ""), mod_arg_obj(args, 1));
    res = r ? r : cJSON_CreateNull();
  } else if (!strcmp(channel, "music:addToPlaylist")) {
    cJSON *r = M_add_to_playlist(mod_arg_str(args, 0, ""), mod_arg_at(args, 1));
    res = r ? r : cJSON_CreateNull();
  } else if (!strcmp(channel, "music:removePlaylist")) {
    const char *id = mod_arg_str(args, 0, "");
    cJSON *root = ms_get_root();
    cJSON *pls = cJSON_GetObjectItemCaseSensitive(root, "playlists");
    cJSON *out = cJSON_CreateArray();
    cJSON *p = NULL;
    cJSON_ArrayForEach(p, pls) if (strcmp(json_str(p, "id", ""), id)) cJSON_AddItemToArray(out, cJSON_Duplicate(p, 1));
    cJSON_DeleteItemFromObjectCaseSensitive(root, "playlists");
    cJSON_AddItemToObject(root, "playlists", out);
    ms_save(root);
    cJSON_Delete(root);
    ms_emit("playlist");
    res = cJSON_CreateBool(1);
  } else if (!strcmp(channel, "music:logPlay")) {
    M_log_play(mod_arg_obj(args, 0));
    res = cJSON_CreateObject();
    cJSON_AddBoolToObject(res, "ok", 1);
  } else if (!strcmp(channel, "music:stats")) {
    res = M_stats(mod_arg_str(args, 0, "week"), mod_arg_int(args, 1, 0));
  } else if (!strcmp(channel, "music:lrc")) {
    const char *id = mod_arg_str(args, 0, "");
    cJSON *root = ms_get_root();
    cJSON *tracks = cJSON_GetObjectItemCaseSensitive(root, "tracks");
    cJSON *t = NULL, *found = NULL;
    cJSON_ArrayForEach(t, tracks) if (!strcmp(json_str(t, "id", ""), id)) { found = t; break; }
    if (!found) {
      cJSON_Delete(root);
      rc = -1; *out_error = mod_ret_error("曲目不存在");
      goto done;
    }
    int offset = json_int(found, "lrcOffset", 0);
    char *lp = find_lrc_for_track(found);
    if (!lp) {
      res = cJSON_CreateObject();
      cJSON_AddBoolToObject(res, "found", 0);
      cJSON_AddStringToObject(res, "id", id);
      cJSON_AddNumberToObject(res, "offset", offset);
      cJSON_AddStringToObject(res, "reason", "这首歌没有找到同名的 .lrc 歌词文件");
      cJSON_Delete(root);
      goto done;
    }
    int foff = 0; cJSON *meta = NULL;
    cJSON *lines = parse_lrc_file(lp, &foff, &meta);
    if (!lines || !cJSON_GetArraySize(lines)) {
      res = cJSON_CreateObject();
      cJSON_AddBoolToObject(res, "found", 0);
      cJSON_AddStringToObject(res, "id", id);
      cJSON_AddStringToObject(res, "path", lp);
      cJSON_AddStringToObject(res, "reason", "歌词文件里没有可识别的时间轴（不像标准 LRC）");
      if (lines) cJSON_Delete(lines);
      if (meta) cJSON_Delete(meta);
      free(lp); cJSON_Delete(root);
      goto done;
    }
    res = cJSON_CreateObject();
    cJSON_AddBoolToObject(res, "found", 1);
    cJSON_AddStringToObject(res, "id", id);
    cJSON_AddStringToObject(res, "path", lp);
    cJSON_AddStringToObject(res, "name", path_basename(lp));
    cJSON_AddItemToObject(res, "lines", lines);
    cJSON_AddItemToObject(res, "meta", meta ? meta : cJSON_CreateObject());
    cJSON_AddNumberToObject(res, "fileOffset", foff);
    cJSON_AddNumberToObject(res, "offset", offset);
    cJSON_AddNumberToObject(res, "shift", offset + foff);
    free(lp);
    cJSON_Delete(root);
  } else if (!strcmp(channel, "music:lrcFile")) {
    char *p = mod_path_from_arg(args, 0);
    cJSON *meta = mod_arg_obj(args, 1);
    char *lp = match_lrc(p, meta ? json_str(meta, "title", "") : "", meta ? json_str(meta, "artist", "") : "");
    if (!lp) {
      res = cJSON_CreateObject();
      cJSON_AddBoolToObject(res, "found", 0);
      cJSON_AddStringToObject(res, "reason", "这首歌没有找到同名的 .lrc 歌词文件");
    } else {
      int foff = 0; cJSON *lm = NULL;
      cJSON *lines = parse_lrc_file(lp, &foff, &lm);
      res = cJSON_CreateObject();
      cJSON_AddBoolToObject(res, "found", lines && cJSON_GetArraySize(lines));
      cJSON_AddStringToObject(res, "path", lp);
      cJSON_AddStringToObject(res, "name", path_basename(lp));
      cJSON_AddItemToObject(res, "lines", lines ? lines : cJSON_CreateArray());
      cJSON_AddItemToObject(res, "meta", lm ? lm : cJSON_CreateObject());
      cJSON_AddNumberToObject(res, "fileOffset", foff);
      cJSON_AddNumberToObject(res, "offset", 0);
      cJSON_AddNumberToObject(res, "shift", foff);
      if (!lines || !cJSON_GetArraySize(lines)) cJSON_AddStringToObject(res, "reason", "歌词文件里没有可识别的时间轴");
      free(lp);
    }
    free(p);
  } else if (!strcmp(channel, "music:lrcMap")) {
    cJSON *root = ms_get_root();
    cJSON *tracks = cJSON_GetObjectItemCaseSensitive(root, "tracks");
    res = cJSON_CreateObject();
    cJSON *t = NULL;
    cJSON_ArrayForEach(t, tracks) {
      const char *lp = json_str(t, "lrcPath", "");
      if (*lp && path_exists(lp)) cJSON_AddStringToObject(res, json_str(t, "id", ""), lp);
    }
    cJSON_Delete(root);
  } else if (!strcmp(channel, "music:setLrc")) {
    const char *id = mod_arg_str(args, 0, "");
    cJSON *patch = mod_arg_obj(args, 1);
    cJSON *root = ms_get_root();
    cJSON *tracks = cJSON_GetObjectItemCaseSensitive(root, "tracks");
    cJSON *t = NULL, *found = NULL;
    cJSON_ArrayForEach(t, tracks) if (!strcmp(json_str(t, "id", ""), id)) { found = t; break; }
    if (!found) { cJSON_Delete(root); rc = -1; *out_error = mod_ret_error("曲目不存在"); goto done; }
    if (patch && json_bool(patch, "clear", 0)) {
      cJSON_DeleteItemFromObjectCaseSensitive(found, "lrcPath");
      cJSON_AddStringToObject(found, "lrcPath", "");
      json_set_bool(found, "lrcManual", 0);
      json_set_int(found, "lrcOffset", 0);
    }
    if (patch && json_str(patch, "lrcPath", "")[0]) {
      char *p = mod_path_from_url(json_str(patch, "lrcPath", ""));
      if (!path_exists(p)) { free(p); cJSON_Delete(root); rc = -1; *out_error = mod_ret_error("选择的歌词文件不存在"); goto done; }
      cJSON_DeleteItemFromObjectCaseSensitive(found, "lrcPath");
      cJSON_AddStringToObject(found, "lrcPath", p);
      json_set_bool(found, "lrcManual", 1);
      free(p);
    }
    if (patch && cJSON_GetObjectItemCaseSensitive(patch, "offset")) {
      int off = json_int(patch, "offset", 0);
      if (off < -60000) off = -60000;
      if (off > 60000) off = 60000;
      json_set_int(found, "lrcOffset", off);
    }
    ms_save(root);
    res = cJSON_Duplicate(found, 1);
    cJSON_Delete(root);
    ms_emit("lrc");
  } else if (!strcmp(channel, "music:relinkLrc")) {
    cJSON *root = ms_get_root();
    cJSON *tracks = cJSON_GetObjectItemCaseSensitive(root, "tracks");
    cJSON *roots = cJSON_GetObjectItemCaseSensitive(root, "roots");
    lrc_idx_clear();
    cJSON *r = NULL;
    cJSON_ArrayForEach(r, roots) if (cJSON_IsString(r)) walk_index_lrc(r->valuestring, 0);
    int n = 0;
    cJSON *t = NULL;
    cJSON_ArrayForEach(t, tracks) {
      if (json_bool(t, "lrcManual", 0)) continue;
      char *lp = match_lrc(json_str(t, "path", ""), json_str(t, "title", ""), json_str(t, "artist", ""));
      if (lp) {
        cJSON_DeleteItemFromObjectCaseSensitive(t, "lrcPath");
        cJSON_AddStringToObject(t, "lrcPath", lp);
        free(lp);
        n++;
      }
    }
    ms_save(root);
    cJSON_Delete(root);
    ms_emit("lrc");
    res = cJSON_CreateNumber(n);
  } else if (!strcmp(channel, "music:pickLrc")) {
    char *p = g_host->pick_file("*.lrc", 0, NULL);
    char *nl = p ? strchr(p, '\n') : NULL;
    if (nl) *nl = 0;
    res = cJSON_CreateString(p ? p : "");
    if (p) g_host->dealloc(p);
  } else if (!strcmp(channel, "music:pickCover")) {
    char *p = g_host->pick_file("*.jpg;*.jpeg;*.png;*.webp", 0, NULL);
    char *nl = p ? strchr(p, '\n') : NULL;
    if (nl) *nl = 0;
    res = cJSON_CreateString(p ? p : "");
    if (p) g_host->dealloc(p);
  } else if (!strcmp(channel, "music:pickPlaylistFile")) {
    char *p = g_host->pick_file("*.m3u;*.m3u8;*.pls;*.txt;*.json", 0, NULL);
    cJSON *arr = cJSON_CreateArray();
    if (p) {
      char *save = NULL;
      for (char *line = strtok_r(p, "\r\n", &save); line; line = strtok_r(NULL, "\r\n", &save)) {
        str_trim(line);
        if (*line) cJSON_AddItemToArray(arr, cJSON_CreateString(line));
      }
      g_host->dealloc(p);
    }
    res = arr;
  } else if (!strcmp(channel, "music:pickDailyDir") || !strcmp(channel, "music:pickSourceDir")) {
    char *p = g_host->pick_folder(0, NULL);
    char *nl = p ? strchr(p, '\n') : NULL;
    if (nl) *nl = 0;
    res = cJSON_CreateString(p ? p : "");
    if (p) g_host->dealloc(p);
  } else if (!strcmp(channel, "music:exportPlaylist")) {
    const char *id = mod_arg_str(args, 0, "");
    cJSON *root = ms_get_root();
    cJSON *pls = cJSON_GetObjectItemCaseSensitive(root, "playlists");
    cJSON *p = pl_find(pls, id);
    if (!p) { cJSON_Delete(root); rc = -1; *out_error = mod_ret_error("歌单不存在"); goto done; }
    char *target = g_host->pick_file("*.m3u8", 1, "playlist.m3u8");
    char *nl = target ? strchr(target, '\n') : NULL;
    if (nl) *nl = 0;
    if (!target || !*target) {
      if (target) g_host->dealloc(target);
      cJSON_Delete(root);
      res = cJSON_CreateObject();
      cJSON_AddBoolToObject(res, "ok", 0);
      cJSON_AddBoolToObject(res, "canceled", 1);
      goto done;
    }
    Buf b; buf_init(&b);
    buf_adds(&b, "#EXTM3U\n");
    cJSON *tracks = cJSON_GetObjectItemCaseSensitive(root, "tracks");
    cJSON *ids = cJSON_GetObjectItemCaseSensitive(p, "tracks");
    cJSON *x = NULL;
    cJSON_ArrayForEach(x, ids) {
      if (!cJSON_IsString(x)) continue;
      cJSON *t = NULL;
      cJSON_ArrayForEach(t, tracks) if (!strcmp(json_str(t, "id", ""), x->valuestring)) {
        buf_addf(&b, "#EXTINF:%d,%s - %s\n%s\n", json_int(t, "duration", 0), json_str(t, "artist", ""), json_str(t, "title", ""), json_str(t, "path", ""));
        break;
      }
    }
    file_write_all(target, b.p, b.len);
    buf_free(&b);
    res = cJSON_CreateObject();
    cJSON_AddBoolToObject(res, "ok", 1);
    cJSON_AddStringToObject(res, "file", target);
    g_host->dealloc(target);
    cJSON_Delete(root);
  } else if (!strcmp(channel, "music:importPlaylist") || !strcmp(channel, "music:importPlaylistFromDirs")) {
    const char *name = mod_arg_str(args, 0, "导入的歌单");
    cJSON *files = mod_arg_at(args, 1);
    cJSON *root = ms_get_root();
    cJSON *tracks = cJSON_GetObjectItemCaseSensitive(root, "tracks");
    cJSON *ids = cJSON_CreateArray();
    cJSON *f = NULL;
    cJSON_ArrayForEach(f, files) {
      if (!cJSON_IsString(f)) continue;
      char *p = mod_path_from_url(f->valuestring);
      /* 直接是音频 */
      const char *e = path_ext(p);
      if (is_audio_ext(e)) {
        cJSON *t = NULL; int has = 0;
        cJSON_ArrayForEach(t, tracks) if (!_stricmp(json_str(t, "path", ""), p)) { cJSON_AddItemToArray(ids, cJSON_CreateString(json_str(t, "id", ""))); has = 1; break; }
        if (!has && path_exists(p)) {
          TrackMeta m; sniff_meta(p, &m);
          char *lrc = match_lrc(p, m.title, m.artist);
          cJSON *nt = track_json(p, &m, lrc ? lrc : "");
          cJSON_AddItemToArray(tracks, nt);
          cJSON_AddItemToArray(ids, cJSON_CreateString(json_str(nt, "id", "")));
          free(lrc);
        }
      } else if (path_exists(p)) {
        /* 文本歌单 */
        char *txt = file_read_text(p);
        if (txt) {
          char *save = NULL;
          for (char *line = strtok_r(txt, "\r\n", &save); line; line = strtok_r(NULL, "\r\n", &save)) {
            str_trim(line);
            if (!*line || line[0] == '#') continue;
            char *path2 = NULL;
            if (line[0] == '{') {
              cJSON *j = cJSON_Parse(line);
              if (j) { path2 = xstrdup(json_str(j, "path", json_str(j, "url", ""))); cJSON_Delete(j); }
            } else if (!strncmp(line, "File", 4)) {
              char *eq = strchr(line, '=');
              if (eq) path2 = xstrdup(eq + 1);
            } else path2 = xstrdup(line);
            if (path2) {
              if (!path_is_absolute(path2)) {
                char *dir = path_dirname(p);
                char *full = path_join(dir, path2);
                free(dir); free(path2); path2 = full;
              }
              cJSON *t = NULL;
              cJSON_ArrayForEach(t, tracks) if (!_stricmp(json_str(t, "path", ""), path2)) {
                cJSON_AddItemToArray(ids, cJSON_CreateString(json_str(t, "id", "")));
                break;
              }
              free(path2);
            }
          }
          free(txt);
        }
      }
      free(p);
    }
    cJSON *opts = cJSON_CreateObject();
    cJSON_AddItemToObject(opts, "tracks", cJSON_Duplicate(ids, 1));
    cJSON *pl = M_add_playlist(name, opts);
    cJSON_Delete(opts);
    cJSON_Delete(ids);
    ms_save(root);
    cJSON_Delete(root);
    res = pl;
  } else if (!strcmp(channel, "music:dailyConfig")) {
    res = daily_config();
  } else if (!strcmp(channel, "music:setDailyConfig")) {
    cJSON *cur = daily_config();
    cJSON *patch = mod_arg_obj(args, 0);
    if (patch) {
      cJSON *it = NULL;
      cJSON_ArrayForEach(it, patch) {
        if (!it->string) continue;
        cJSON_DeleteItemFromObjectCaseSensitive(cur, it->string);
        cJSON_AddItemToObject(cur, it->string, cJSON_Duplicate(it, 1));
      }
    }
    set_defaults("daily", cur);
    res = cur;
  } else if (!strcmp(channel, "music:dailyStatus")) {
    cJSON *c = daily_config();
    res = cJSON_CreateObject();
    cJSON_AddItemToObject(res, "config", cJSON_Duplicate(c, 1));
    cJSON *batch = cJSON_GetObjectItemCaseSensitive(c, "batch");
    cJSON_AddItemToObject(res, "batch", batch ? cJSON_Duplicate(batch, 1) : cJSON_CreateNull());
    cJSON_Delete(c);
  } else if (!strcmp(channel, "music:dailyPull")) {
    rc = -1; *out_error = mod_ret_error("C 版还没有接入「每日推荐」的在线下载（需要平台登录 + 下载源）");
  } else if (!strcmp(channel, "music:dailyMove") || !strcmp(channel, "music:dailyKeep") || !strcmp(channel, "music:dailyClean")) {
    res = cJSON_CreateObject();
    cJSON_AddNumberToObject(res, "count", 0);
  } else if (!strcmp(channel, "music:sourceConfig")) {
    cJSON *c = get_defaults("source");
    if (!cJSON_GetObjectItemCaseSensitive(c, "urls")) cJSON_AddItemToObject(c, "urls", cJSON_CreateArray());
    if (!cJSON_GetObjectItemCaseSensitive(c, "quality")) cJSON_AddStringToObject(c, "quality", "auto");
    res = c;
  } else if (!strcmp(channel, "music:setSourceConfig")) {
    cJSON *cur = get_defaults("source");
    cJSON *patch = mod_arg_obj(args, 0);
    if (patch) json_deep_merge(cur, patch);
    set_defaults("source", cur);
    res = cur;
  } else if (!strcmp(channel, "music:crawlConfig")) {
    res = get_defaults("crawl");
  } else if (!strcmp(channel, "music:setCrawlConfig")) {
    cJSON *cur = get_defaults("crawl");
    cJSON *patch = mod_arg_obj(args, 0);
    if (patch) json_deep_merge(cur, patch);
    set_defaults("crawl", cur);
    res = cur;
  } else if (!strcmp(channel, "music:platforms")) {
    cJSON *root = ms_get_root();
    cJSON *logins = cJSON_GetObjectItemCaseSensitive(root, "logins");
    const char *ids[] = { "netease", "qq", NULL };
    const char *names[] = { "网易云音乐", "QQ 音乐", NULL };
    cJSON *arr = cJSON_CreateArray();
    for (int i = 0; ids[i]; i++) {
      cJSON *o = cJSON_CreateObject();
      cJSON_AddStringToObject(o, "id", ids[i]);
      cJSON_AddStringToObject(o, "name", names[i]);
      cJSON *lg = cJSON_GetObjectItemCaseSensitive(logins, ids[i]);
      json_set_bool(o, "logged", cJSON_IsObject(lg));
      cJSON_AddStringToObject(o, "nickname", cJSON_IsObject(lg) ? json_str(lg, "nickname", "") : "");
      cJSON_AddItemToArray(arr, o);
    }
    cJSON_Delete(root);
    res = arr;
  } else if (!strcmp(channel, "music:logout")) {
    const char *p = mod_arg_str(args, 0, "");
    cJSON *root = ms_get_root();
    cJSON *logins = cJSON_GetObjectItemCaseSensitive(root, "logins");
    cJSON_DeleteItemFromObjectCaseSensitive(logins, p);
    ms_save(root);
    cJSON_Delete(root);
    res = cJSON_CreateBool(1);
  } else if (!strcmp(channel, "music:onlinePlaylist")) {
    const char *link = mod_arg_str(args, 0, "");
    cJSON *pv = online_playlist_preview(link);
    if (!pv) { rc = -1; *out_error = mod_ret_error("解析失败：目前支持网易云公开歌单链接（music.163.com/playlist?id=…）"); goto done; }
    res = pv;
  } else if (!strcmp(channel, "music:importOnlinePlaylist")) {
    const char *link = mod_arg_str(args, 0, "");
    cJSON *opts = mod_arg_obj(args, 1);
    cJSON *pv = opts ? cJSON_GetObjectItemCaseSensitive(opts, "preview") : NULL;
    cJSON *owned = NULL;
    if (!cJSON_IsObject(pv)) { owned = online_playlist_preview(link); pv = owned; }
    if (!cJSON_IsObject(pv)) { cJSON_Delete(owned); rc = -1; *out_error = mod_ret_error("解析失败：只支持网易云公开歌单"); goto done; }
    const char *nm = opts ? json_str(opts, "name", "") : "";
    if (!*nm) nm = json_str(pv, "name", "在线歌单");
    cJSON *tracks = cJSON_CreateArray();
    int matched = 0, missing = 0;
    cJSON *items = cJSON_GetObjectItemCaseSensitive(pv, "items");
    cJSON *it = NULL;
    cJSON_ArrayForEach(it, items) {
      const char *tid = json_str(it, "trackId", "");
      if (*tid) { cJSON_AddItemToArray(tracks, cJSON_CreateString(tid)); matched++; }
      else missing++;
    }
    cJSON *popts = cJSON_CreateObject();
    cJSON_AddItemToObject(popts, "tracks", tracks);
    cJSON *pl = M_add_playlist(nm, popts);
    cJSON_Delete(popts);
    const char *pid = pl ? json_str(pl, "id", "") : "";
    if (*pid) {
      cJSON *root = ms_get_root();
      cJSON *pls = cJSON_GetObjectItemCaseSensitive(root, "playlists");
      cJSON *real = pl_find(pls, pid);
      if (real) {
        json_set_str(real, "source", link);
        json_set_str(real, "platform", "netease");
        json_set_str(real, "cover", json_str(pv, "cover", ""));
        m_set(real, "onlineItems", cJSON_Duplicate(items, 1));
        ms_save(root);
      }
      cJSON_Delete(root);
    }
    res = cJSON_CreateObject();
    cJSON *plout = cJSON_CreateObject();
    cJSON_AddStringToObject(plout, "id", pid);
    cJSON_AddStringToObject(plout, "name", pl ? json_str(pl, "name", nm) : nm);
    cJSON_AddItemToObject(res, "playlist", plout);
    cJSON_AddNumberToObject(res, "matched", matched);
    cJSON_AddNumberToObject(res, "missing", missing);
    cJSON_Delete(pl);
    cJSON_Delete(owned);
  } else if (!strcmp(channel, "music:resyncOnlinePlaylist")) {
    const char *pid = mod_arg_str(args, 0, "");
    cJSON *root = ms_get_root();
    cJSON *pls = cJSON_GetObjectItemCaseSensitive(root, "playlists");
    cJSON *pl = pl_find(pls, pid);
    const char *link = pl ? json_str(pl, "source", "") : "";
    cJSON_Delete(root);
    if (!*link) { rc = -1; *out_error = mod_ret_error("这个歌单没有在线来源"); goto done; }
    cJSON *pv = online_playlist_preview(link);
    if (!pv) { rc = -1; *out_error = mod_ret_error("重新解析在线歌单失败"); goto done; }
    cJSON *tracks = cJSON_CreateArray();
    int matched = 0, missing = 0;
    cJSON *items = cJSON_GetObjectItemCaseSensitive(pv, "items");
    cJSON *it = NULL;
    cJSON_ArrayForEach(it, items) {
      const char *tid = json_str(it, "trackId", "");
      if (*tid) { cJSON_AddItemToArray(tracks, cJSON_CreateString(tid)); matched++; }
      else missing++;
    }
    root = ms_get_root();
    pls = cJSON_GetObjectItemCaseSensitive(root, "playlists");
    pl = pl_find(pls, pid);
    if (pl) {
      m_set(pl, "tracks", tracks);
      m_set(pl, "onlineItems", cJSON_Duplicate(items, 1));
      json_set_int(pl, "updatedAt", now_ms());
      ms_save(root);
    } else cJSON_Delete(tracks);
    cJSON_Delete(root);
    cJSON_Delete(pv);
    res = cJSON_CreateObject();
    cJSON_AddNumberToObject(res, "matched", matched);
    cJSON_AddNumberToObject(res, "missing", missing);
  } else if (!strcmp(channel, "music:myPlaylists")) {
    const char *platform = mod_arg_str(args, 0, "netease");
    if (strcmp(platform, "netease")) { rc = -1; *out_error = mod_ret_error("目前只接入了网易云「我的歌单」"); goto done; }
    cJSON *root = ms_get_root();
    cJSON *logins = cJSON_GetObjectItemCaseSensitive(root, "logins");
    cJSON *lg = cJSON_GetObjectItemCaseSensitive(logins, "netease");
    char *cookie = *json_str(lg, "cookie", "") ? xstrdup(json_str(lg, "cookie", "")) : NULL;
    const char *uid = json_str(lg, "uid", "");
    char uids[32]; snprintf(uids, sizeof(uids), "%s", uid);
    cJSON_Delete(root);
    if (!cookie) { rc = -1; *out_error = mod_ret_error("还没有登录网易云（先在浏览器模块登录，再回来点一次）"); goto done; }
    if (!*uids) { free(cookie); rc = -1; *out_error = mod_ret_error("登录信息里没有账号 UID，请重新登录一次"); goto done; }
    char url[512];
    snprintf(url, sizeof(url), "https://music.163.com/api/user/playlist?uid=%s&limit=1000&offset=0", uids);
    size_t hcap = strlen(cookie) + 160;
    char *headers = (char *)xmalloc(hcap);
    snprintf(headers, hcap, "Cookie: %s\r\nAccept: application/json\r\nReferer: https://music.163.com/\r\nUser-Agent: Mozilla/5.0\r\n", cookie);
    int status = 0;
    char *body = g_host->http_request("GET", url, headers, NULL, 0, 8000, &status, NULL);
    free(headers); free(cookie);
    if (!body || status != 200) { if (body) g_host->dealloc(body); rc = -1; *out_error = mod_ret_error("读取网易云歌单失败"); goto done; }
    cJSON *j = cJSON_Parse(body);
    g_host->dealloc(body);
    cJSON *pls = j ? cJSON_GetObjectItemCaseSensitive(j, "playlist") : NULL;
    cJSON *list = cJSON_CreateArray();
    cJSON *p = NULL;
    cJSON_ArrayForEach(p, pls) {
      cJSON *o = cJSON_CreateObject();
      cJSON_AddStringToObject(o, "id", "");
      char b[32]; snprintf(b, sizeof(b), "%.0f", json_num(p, "id", 0));
      cJSON_DeleteItemFromObjectCaseSensitive(o, "id");
      cJSON_AddStringToObject(o, "id", b);
      cJSON_AddStringToObject(o, "name", json_str(p, "name", "歌单"));
      cJSON_AddStringToObject(o, "cover", json_str(p, "coverImgUrl", ""));
      cJSON_AddNumberToObject(o, "trackCount", json_num(p, "trackCount", 0));
      cJSON_AddStringToObject(o, "platform", "netease");
      cJSON_AddItemToArray(list, o);
    }
    cJSON_Delete(j);
    res = cJSON_CreateObject();
    cJSON_AddItemToObject(res, "list", list);
  } else if (!strcmp(channel, "music:testCrawlSites")) {
    cJSON *urls = mod_arg_at(args, 0);
    cJSON *details = cJSON_CreateArray();
    int n = cJSON_IsArray(urls) ? cJSON_GetArraySize(urls) : 0;
    for (int i = 0; i < n; i++) {
      cJSON *u = cJSON_GetArrayItem(urls, i);
      if (!cJSON_IsString(u)) continue;
      cJSON *audio = cJSON_CreateArray(), *netdisk = cJSON_CreateArray();
      char *err = NULL;
      int reached = crawl_one(u->valuestring, audio, netdisk, &err);
      cJSON *d = cJSON_CreateObject();
      cJSON_AddStringToObject(d, "url", u->valuestring);
      json_set_bool(d, "reached", reached);
      cJSON_AddNumberToObject(d, "audio", cJSON_GetArraySize(audio));
      cJSON_AddNumberToObject(d, "netdisk", cJSON_GetArraySize(netdisk));
      json_set_bool(d, "ok", reached && cJSON_GetArraySize(audio) > 0);
      if (err) cJSON_AddStringToObject(d, "error", err);
      free(err);
      cJSON_AddItemToArray(details, d);
      cJSON_Delete(audio); cJSON_Delete(netdisk);
    }
    res = cJSON_CreateObject();
    cJSON_AddItemToObject(res, "details", details);
  } else if (!strcmp(channel, "music:crawl") || !strcmp(channel, "music:crawlSites")) {
    cJSON *urls = mod_arg_at(args, 0);
    if (cJSON_IsString(urls)) {
      cJSON *arr = cJSON_CreateArray();
      cJSON_AddItemToArray(arr, cJSON_CreateString(urls->valuestring));
      urls = arr;
    }
    cJSON *allAudio = cJSON_CreateArray(), *allNetdisk = cJSON_CreateArray();
    cJSON *sources = cJSON_CreateArray();
    int n = cJSON_IsArray(urls) ? cJSON_GetArraySize(urls) : 0;
    for (int i = 0; i < n; i++) {
      cJSON *u = cJSON_GetArrayItem(urls, i);
      if (!cJSON_IsString(u)) continue;
      cJSON *audio = cJSON_CreateArray(), *netdisk = cJSON_CreateArray();
      char *err = NULL;
      int reached = crawl_one(u->valuestring, audio, netdisk, &err);
      cJSON *src = cJSON_CreateObject();
      cJSON_AddStringToObject(src, "url", u->valuestring);
      json_set_bool(src, "reached", reached);
      json_set_bool(src, "ok", reached && cJSON_GetArraySize(audio) > 0);
      cJSON_AddNumberToObject(src, "audio", cJSON_GetArraySize(audio));
      cJSON_AddNumberToObject(src, "netdisk", cJSON_GetArraySize(netdisk));
      if (err) cJSON_AddStringToObject(src, "error", err);
      free(err);
      cJSON_AddItemToArray(sources, src);
      cJSON *a = NULL;
      cJSON_ArrayForEach(a, audio) {
        const char *au = json_str(a, "url", "");
        if (!*au || audio_has(allAudio, au)) continue;
        cJSON_AddItemToArray(allAudio, cJSON_Duplicate(a, 1));
      }
      cJSON_ArrayForEach(a, netdisk) {
        const char *au = json_str(a, "url", "");
        int dup = 0;
        cJSON *x = NULL;
        cJSON_ArrayForEach(x, allNetdisk) if (!strcmp(json_str(x, "url", ""), au)) { dup = 1; break; }
        if (!dup) cJSON_AddItemToArray(allNetdisk, cJSON_Duplicate(a, 1));
      }
      cJSON_Delete(audio); cJSON_Delete(netdisk);
    }
    res = cJSON_CreateObject();
    cJSON_AddNumberToObject(res, "total", n);
    cJSON_AddItemToObject(res, "sources", sources);
    cJSON_AddItemToObject(res, "audio", allAudio);
    cJSON_AddItemToObject(res, "netdisk", allNetdisk);
    cJSON_AddNumberToObject(res, "forwarded", 0);
  } else if (!strcmp(channel, "music:browseServer")) {
    cJSON *a = mod_arg_at(args, 0);
    const char *url = cJSON_IsString(a) ? a->valuestring : (cJSON_IsObject(a) ? json_str(a, "url", "") : "");
    if (!*url) { rc = -1; *out_error = mod_ret_error("请填写服务器 / 网盘地址"); goto done; }
    int status = 0;
    char *body = g_host->http_request("GET", url,
        "Accept: application/json,text/html,application/xml;q=0.9,*/*;q=0.8\r\nUser-Agent: Mozilla/5.0\r\n",
        NULL, 0, 15000, &status, NULL);
    if (!body || status != 200) { if (body) g_host->dealloc(body); rc = -1; *out_error = mod_ret_error("服务器打不开（HTTP %d）", status); goto done; }
    cJSON *items = cJSON_CreateArray();
    const char *p = body;
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    if (*p == '[' || *p == '{') {
      cJSON *j = cJSON_Parse(body);
      cJSON *arr = cJSON_IsArray(j) ? j : (j ? cJSON_GetObjectItemCaseSensitive(j, "items") : NULL);
      if (!arr && j) arr = cJSON_GetObjectItemCaseSensitive(j, "files");
      if (cJSON_IsArray(arr)) {
        cJSON *it = NULL;
        cJSON_ArrayForEach(it, arr) {
          const char *u = cJSON_IsString(it) ? it->valuestring : json_str(it, "url", "");
          if (!*u) u = json_str(it, "href", "");
          if (!*u) continue;
          char *full = url_resolve(url, u);
          if (full && url_audio_ext(full)) {
            cJSON *o = cJSON_CreateObject();
            cJSON_AddStringToObject(o, "url", full);
            cJSON_AddStringToObject(o, "name", cJSON_IsObject(it) ? json_str(it, "name", path_basename(full)) : path_basename(full));
            cJSON_AddItemToArray(items, o);
          }
          free(full);
        }
      }
      cJSON_Delete(j);
    } else {
      cJSON *audio = cJSON_CreateArray(), *nd = cJSON_CreateArray();
      collect_links(url, body, audio, nd);
      /* WebDAV 的 <d:href> 不是 href=，单独扫 */
      const char *q = body;
      while ((q = strstr(q, "<d:href>")) != NULL) {
        q += 8;
        const char *e = strstr(q, "</d:href>");
        if (!e) break;
        char *v = xstrndup(q, (size_t)(e - q));
        add_audio_link(audio, nd, url, v);
        free(v); q = e + 9;
      }
      cJSON *x = NULL;
      cJSON_ArrayForEach(x, audio) cJSON_AddItemToArray(items, cJSON_Duplicate(x, 1));
      cJSON_Delete(audio); cJSON_Delete(nd);
    }
    g_host->dealloc(body);
    res = cJSON_CreateObject();
    cJSON_AddItemToObject(res, "items", items);
  } else if (!strcmp(channel, "music:downloadAudio")) {
    cJSON *items = mod_arg_at(args, 0);
    char *dir = NULL;
    const char *argdir = mod_arg_str(args, 1, "");
    if (*argdir) dir = xstrdup(argdir);
    else dir = download_dir();
    path_mkdirs(dir);
    int n = 0;
    int total = cJSON_IsArray(items) ? cJSON_GetArraySize(items) : 0;
    for (int i = 0; i < total && i < 200; i++) {
      cJSON *it = cJSON_GetArrayItem(items, i);
      const char *u = cJSON_IsString(it) ? it->valuestring : json_str(it, "url", "");
      const char *nm = cJSON_IsObject(it) ? json_str(it, "name", "") : "";
      if (!*u) continue;
      if (download_one(u, nm, dir)) n++;
    }
    free(dir);
    res = cJSON_CreateNumber(n);
  } else if (!strcmp(channel, "music:fillMissing")) {
    /* 没有可靠的免费直链，不假装下载；把原因返回给界面 */
    cJSON *failed = cJSON_CreateArray();
    cJSON *items = mod_arg_at(args, 0);
    int n = cJSON_IsArray(items) ? cJSON_GetArraySize(items) : 0;
    for (int i = 0; i < n; i++) {
      cJSON *it = cJSON_GetArrayItem(items, i);
      cJSON *o = cJSON_CreateObject();
      cJSON_AddStringToObject(o, "title", json_str(it, "title", ""));
      cJSON_AddStringToObject(o, "reason", "没有可用的免费下载直链（需要平台会员/下载源）");
      cJSON_AddItemToArray(failed, o);
    }
    res = cJSON_CreateObject();
    cJSON_AddItemToObject(res, "queued", cJSON_CreateArray());
    cJSON_AddItemToObject(res, "failed", failed);
  } else if (!strcmp(channel, "music:testSource")) {
    const char *kw = mod_arg_str(args, 0, "");
    cJSON *cfg = get_defaults("source");
    cJSON *urls = cJSON_GetObjectItemCaseSensitive(cfg, "urls");
    cJSON *details = cJSON_CreateArray();
    cJSON *u = NULL;
    cJSON_ArrayForEach(u, urls) {
      if (!cJSON_IsString(u) || !u->valuestring[0]) continue;
      char target[2048];
      const char *raw = u->valuestring;
      char *enc = url_encode(kw);
      if (strstr(raw, "{kw}")) {
        const char *p = strstr(raw, "{kw}");
        snprintf(target, sizeof(target), "%.*s%s%s", (int)(p - raw), raw, enc ? enc : "", p + 4);
      } else if (strstr(raw, "%s")) {
        const char *p = strstr(raw, "%s");
        snprintf(target, sizeof(target), "%.*s%s%s", (int)(p - raw), raw, enc ? enc : "", p + 2);
      } else snprintf(target, sizeof(target), "%s", raw);
      free(enc);
      cJSON *audio = cJSON_CreateArray(), *nd = cJSON_CreateArray();
      char *err = NULL;
      int reached = crawl_one(target, audio, nd, &err);
      cJSON *d = cJSON_CreateObject();
      cJSON_AddStringToObject(d, "site", raw);
      json_set_bool(d, "ok", reached);
      cJSON_AddNumberToObject(d, "count", cJSON_GetArraySize(audio));
      if (err) cJSON_AddStringToObject(d, "error", err);
      free(err);
      cJSON_AddItemToArray(details, d);
      cJSON_Delete(audio); cJSON_Delete(nd);
    }
    cJSON_Delete(cfg);
    res = cJSON_CreateObject();
    cJSON_AddItemToObject(res, "details", details);
  } else if (!strcmp(channel, "music:shotStats")) {
    rc = -1; *out_error = mod_ret_error("统计海报导出还没接");
  } else {
    rc = -1; *out_error = mod_ret_error("音乐模块没有这个方法：%s", channel);
    goto done;
  }

  *out_json = mod_ret_json(res ? res : cJSON_CreateNull());
done:
  cJSON_Delete(args);
  return rc;
}

static int music_init(const SgjHostApi *h) { mod_set_host(h); return 0; }
static void music_shutdown(void) { lrc_idx_clear(); free(g_lrc_idx); g_lrc_idx = NULL; g_lrc_n = g_lrc_cap = 0; }

SGJ_MODULE_EXPORT const SgjModule *sgj_module_entry(void) {
  if (!g_manifest) { g_manifest = mod_res_dup(L"MANIFEST"); g_js = mod_res_dup(L"UI_JS"); }
  g_mod.abi = SGJ_ABI;
  g_mod.id = "music";
  g_mod.manifest_json = g_manifest;
  g_mod.renderer_js = g_js;
  g_mod.style_css = NULL;
  g_mod.init = music_init;
  g_mod.shutdown = music_shutdown;
  g_mod.invoke = music_invoke;
  return &g_mod;
}
