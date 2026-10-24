/* ============================================================
 * 拾光集 · 图片模块 (photos.dll)
 * ------------------------------------------------------------
 * 扫描本地照片 / 读 EXIF（拍摄时间 + GPS）/ 按需生成缩略图（WIC）/
 * 手动标地点 / 排序与地图配置。地图绘制在渲染层（photos-map.js）。
 * ============================================================ */
#include "../module_common.h"
#include <wincodec.h>
#include <shlwapi.h>
#include <wincrypt.h>

#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "shlwapi.lib")
#pragma comment(lib, "ole32.lib")

static const char *g_manifest = NULL;
static const char *g_js = NULL;
static SgjModule g_mod;
static CRITICAL_SECTION g_cs;
static int g_cs_init = 0;
static void lock_init(void) { if (!g_cs_init) { InitializeCriticalSection(&g_cs); g_cs_init = 1; } }

static unsigned be32(const unsigned char *p) { return ((unsigned)p[0] << 24) | ((unsigned)p[1] << 16) | ((unsigned)p[2] << 8) | p[3]; }
static unsigned le32(const unsigned char *p) { return ((unsigned)p[3] << 24) | ((unsigned)p[2] << 16) | ((unsigned)p[1] << 8) | p[0]; }

/* 只读文件开头一段（EXIF 在 JPEG 头部，不需要整张图） */
static int read_prefix_raw(const char *path, size_t max, unsigned char **out, size_t *out_len) {
  *out = NULL; *out_len = 0;
  wchar_t *w = u8_to_w(path);
  HANDLE h = CreateFileW(w, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  free(w);
  if (h == INVALID_HANDLE_VALUE) return 0;
  LARGE_INTEGER sz; GetFileSizeEx(h, &sz);
  size_t n = (size_t)(sz.QuadPart < (int64_t)max ? sz.QuadPart : (int64_t)max);
  unsigned char *p = (unsigned char *)xmalloc(n + 1);
  DWORD got = 0;
  ReadFile(h, p, (DWORD)n, &got, NULL);
  CloseHandle(h);
  p[got] = 0;
  *out = p; *out_len = got;
  return 1;
}

/* ---------------- 路径 / ID ---------------- */
static char *index_path(void) { return path_join(mod_data_dir(), "photo-index.json"); }
static char *thumbs_dir(void) { return path_join(mod_data_dir(), "photo-thumbs"); }
static char *photo_id(const char *path) {
  unsigned long long h = 1469598103934665603ULL;
  for (const unsigned char *p = (const unsigned char *)path; *p; p++) { h ^= *p; h *= 1099511628211ULL; }
  char b[32]; snprintf(b, sizeof(b), "%016llx", h);
  return xstrdup(b);
}

/* ---------------- 小端/大端 EXIF 读取 ---------------- */
static unsigned exif_u16(const unsigned char *p, int be) { return be ? ((unsigned)p[0] << 8 | p[1]) : (p[0] | ((unsigned)p[1] << 8)); }
static unsigned exif_u32(const unsigned char *p, int be) { return be ? be32(p) : le32(p); }

/* 读一个 rational 值（8 字节）到 double；支持 SHORT/LONG 直接值 */
static double exif_value(const unsigned char *tiff, size_t tlen, int be, unsigned type, unsigned count, const unsigned char *valptr) {
  size_t unit = type == 3 ? 2 : type == 4 ? 4 : type == 5 ? 8 : type == 9 ? 4 : 1;
  unsigned off = (unsigned)(valptr - tiff);
  if (type == 3) {
    if (off + 2 <= tlen) return (double)exif_u16(tiff + off, be);
  } else if (type == 4) {
    if (off + 4 <= tlen) return (double)exif_u32(tiff + off, be);
  } else if (type == 5 || type == 10) {
    if (off + 8 <= tlen) {
      unsigned a = exif_u32(tiff + off, be), b = exif_u32(tiff + off + 4, be);
      return b ? (double)a / b : 0;
    }
  } else if (type == 9) {
    if (off + 4 <= tlen) return (double)(int)exif_u32(tiff + off, be);
  }
  (void)count; (void)unit;
  return 0;
}

/* 解析 IFD，找需要的 tag；返回 tag 值指针 */
static const unsigned char *ifd_find(const unsigned char *tiff, size_t tlen, int be, unsigned ifd_off, unsigned want, unsigned *type, unsigned *count, unsigned *valoff) {
  if (ifd_off + 2 > tlen) return NULL;
  unsigned n = exif_u16(tiff + ifd_off, be);
  for (unsigned i = 0; i < n; i++) {
    unsigned e = ifd_off + 2 + i * 12;
    if (e + 12 > tlen) break;
    unsigned tag = exif_u16(tiff + e, be);
    if (tag != want) continue;
    *type = exif_u16(tiff + e + 2, be);
    *count = exif_u32(tiff + e + 4, be);
    *valoff = e + 8;
    return tiff + e + 8;
  }
  return NULL;
}
static void exif_string(const unsigned char *tiff, size_t tlen, int be, unsigned ifd, unsigned tag, char *out, size_t n) {
  unsigned type = 0, count = 0, vo = 0;
  if (!ifd_find(tiff, tlen, be, ifd, tag, &type, &count, &vo) || !count) return;
  size_t len = count;
  const unsigned char *p = (len <= 4) ? tiff + vo : tiff + exif_u32(tiff + vo, be);
  if ((size_t)(p - tiff) + len > tlen) return;
  if (len >= n) len = n - 1;
  memcpy(out, p, len);
  out[len] = 0;
  str_trim(out);
}

static double exif_gps_coord(const unsigned char *tiff, size_t tlen, int be, unsigned ifd, unsigned tag) {
  unsigned type = 0, count = 0, vo = 0;
  if (!ifd_find(tiff, tlen, be, ifd, tag, &type, &count, &vo)) return 0;
  if (count < 3) return 0;
  unsigned off = exif_u32(tiff + vo, be);
  double v[3] = {0, 0, 0};
  for (int i = 0; i < 3; i++) {
    if (off + (unsigned)i * 8 + 8 > tlen) break;
    unsigned a = exif_u32(tiff + off + i * 8, be), b = exif_u32(tiff + off + i * 8 + 4, be);
    v[i] = b ? (double)a / b : 0;
  }
  return v[0] + v[1] / 60.0 + v[2] / 3600.0;
}

typedef struct {
  char taken[32];     /* YYYY-MM-DDTHH:MM:SS */
  int taken_from_exif;
  double lat, lng;
  int has_gps;
  char make[128], model[128];
  int orientation;
} ExifData;

static void exif_read(const char *path, ExifData *out) {
  memset(out, 0, sizeof(*out));
  out->orientation = 1;
  unsigned char *b = NULL; size_t n = 0;
  if (!read_prefix_raw(path, 8 * 1024 * 1024, &b, &n)) return;
  size_t pos = 2;
  while (pos + 4 <= n) {
    if (b[pos] != 0xFF) break;
    unsigned char marker = b[pos + 1];
    if (marker == 0xD8 || marker == 0xD9) { pos += 2; continue; }
    if (marker == 0xDA) break;
    unsigned seglen = ((unsigned)b[pos + 2] << 8) | b[pos + 3];
    if (seglen < 2) break;
    if (marker == 0xE1 && seglen > 8 && !memcmp(b + pos + 4, "Exif\0\0", 6)) {
      const unsigned char *tiff = b + pos + 10;
      size_t tlen = seglen - 8;
      if (tlen < 8) break;
      int be = tiff[0] == 'M';
      unsigned ifd0 = exif_u32(tiff + 4, be);
      char dt[64] = "";
      exif_string(tiff, tlen, be, ifd0, 0x0132, dt, sizeof(dt));
      exif_string(tiff, tlen, be, ifd0, 0x010F, out->make, sizeof(out->make));
      exif_string(tiff, tlen, be, ifd0, 0x0110, out->model, sizeof(out->model));
      unsigned type = 0, count = 0, vo = 0;
      if (ifd_find(tiff, tlen, be, ifd0, 0x0112, &type, &count, &vo)) out->orientation = (int)exif_u16(tiff + vo, be);
      unsigned exif_ifd = 0, gps_ifd = 0;
      if (ifd_find(tiff, tlen, be, ifd0, 0x8769, &type, &count, &vo)) exif_ifd = exif_u32(tiff + vo, be);
      if (ifd_find(tiff, tlen, be, ifd0, 0x8825, &type, &count, &vo)) gps_ifd = exif_u32(tiff + vo, be);
      char sub[64] = "";
      if (exif_ifd) exif_string(tiff, tlen, be, exif_ifd, 0x9003, sub, sizeof(sub));
      if (!sub[0] && exif_ifd) exif_string(tiff, tlen, be, exif_ifd, 0x9004, sub, sizeof(sub));
      if (!sub[0]) snprintf(sub, sizeof(sub), "%s", dt);
      if (sub[0]) {
        int y = 0, m = 0, d = 0, hh = 0, mm = 0, ss = 0;
        if (sscanf(sub, "%d:%d:%d %d:%d:%d", &y, &m, &d, &hh, &mm, &ss) == 6) {
          snprintf(out->taken, sizeof(out->taken), "%04d-%02d-%02dT%02d:%02d:%02d", y, m, d, hh, mm, ss);
          out->taken_from_exif = 1;
        } else if (sscanf(sub, "%d-%d-%dT%d:%d:%d", &y, &m, &d, &hh, &mm, &ss) == 6) {
          snprintf(out->taken, sizeof(out->taken), "%04d-%02d-%02dT%02d:%02d:%02d", y, m, d, hh, mm, ss);
          out->taken_from_exif = 1;
        }
      }
      if (gps_ifd) {
        double lat = exif_gps_coord(tiff, tlen, be, gps_ifd, 2);
        double lng = exif_gps_coord(tiff, tlen, be, gps_ifd, 4);
        char ref[8] = "";
        exif_string(tiff, tlen, be, gps_ifd, 1, ref, sizeof(ref));
        if (ref[0] == 'S') lat = -lat;
        exif_string(tiff, tlen, be, gps_ifd, 3, ref, sizeof(ref));
        if (ref[0] == 'W') lng = -lng;
        if (lat != 0 && lng != 0 && fabs(lat) <= 90 && fabs(lng) <= 180) {
          out->lat = lat; out->lng = lng; out->has_gps = 1;
        }
      }
      break;
    }
    pos += 2 + seglen;
  }
  free(b);
}

/* ---------------- store ---------------- */
static cJSON *P_state_root(void) {
  cJSON *p = mod_store_get("photos");
  if (!cJSON_IsObject(p)) { if (p) cJSON_Delete(p); p = cJSON_CreateObject(); }
  if (!cJSON_IsArray(cJSON_GetObjectItemCaseSensitive(p, "roots"))) {
    cJSON_DeleteItemFromObjectCaseSensitive(p, "roots");
    cJSON_AddItemToObject(p, "roots", cJSON_CreateArray());
  }
  if (!cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(p, "places"))) {
    cJSON_DeleteItemFromObjectCaseSensitive(p, "places");
    cJSON_AddItemToObject(p, "places", cJSON_CreateObject());
  }
  if (!cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(p, "map"))) {
    cJSON_DeleteItemFromObjectCaseSensitive(p, "map");
    cJSON *m = cJSON_CreateObject();
    cJSON_AddStringToObject(m, "source", "tianditu");
    cJSON_AddStringToObject(m, "tk", "");
    cJSON_AddStringToObject(m, "style", "auto");
    cJSON_AddStringToObject(m, "view", "china");
    cJSON_AddItemToObject(m, "layers", cJSON_CreateArray());
    cJSON_AddItemToObject(p, "map", m);
  }
  if (!cJSON_GetObjectItemCaseSensitive(p, "sort")) cJSON_AddStringToObject(p, "sort", "time-desc");
  return p;
}
static cJSON *load_index(void) {
  char *p = index_path();
  cJSON *j = json_from_file(p);
  free(p);
  if (!cJSON_IsObject(j)) { if (j) cJSON_Delete(j); j = cJSON_CreateObject(); }
  if (!cJSON_IsArray(cJSON_GetObjectItemCaseSensitive(j, "items"))) {
    cJSON_DeleteItemFromObjectCaseSensitive(j, "items");
    cJSON_AddItemToObject(j, "items", cJSON_CreateArray());
  }
  return j;
}
static void save_index(cJSON *idx) {
  char *p = index_path();
  json_to_file(p, idx);
  free(p);
}
static int is_photo_ext(const char *e) {
  const char *ok[] = { "jpg", "jpeg", "png", "webp", "gif", "bmp", "avif", NULL };
  for (int i = 0; ok[i]; i++) if (!_stricmp(e, ok[i])) return 1;
  return 0;
}
static int skip_dir(const char *name) {
  return !_stricmp(name, "node_modules") || !_stricmp(name, ".git") || !_stricmp(name, "$RECYCLE.BIN") ||
         !_stricmp(name, "System Volume Information") || !_stricmp(name, "Windows") || !_stricmp(name, "AppData");
}

/* ---------------- WIC 缩略图 ---------------- */
static int make_thumb(const char *src, const char *dst, int maxdim) {
  IWICImagingFactory *fac = NULL;
  IWICBitmapDecoder *dec = NULL;
  IWICBitmapFrameDecode *frame = NULL;
  IWICBitmapScaler *scaler = NULL;
  IWICFormatConverter *conv = NULL;
  IWICStream *stream = NULL;
  IWICBitmapEncoder *enc = NULL;
  IWICBitmapFrameEncode *ef = NULL;
  IPropertyBag2 *props = NULL;
  int ok = 0;
  if (FAILED(CoCreateInstance(&CLSID_WICImagingFactory, NULL, CLSCTX_INPROC_SERVER, &IID_IWICImagingFactory, (void **)&fac))) return 0;
  wchar_t *wsrc = u8_to_w(src);
  if (FAILED(fac->lpVtbl->CreateDecoderFromFilename(fac, wsrc, NULL, GENERIC_READ, WICDecodeMetadataCacheOnDemand, &dec))) { free(wsrc); goto done; }
  free(wsrc);
  if (FAILED(dec->lpVtbl->GetFrame(dec, 0, &frame))) goto done;
  UINT w = 0, h = 0;
  frame->lpVtbl->GetSize(frame, &w, &h);
  if (!w || !h) goto done;
  double sc = 1.0;
  if ((int)w > maxdim || (int)h > maxdim) sc = (double)maxdim / (double)(w > h ? w : h);
  UINT nw = (UINT)(w * sc), nh = (UINT)(h * sc);
  if (!nw) nw = 1; if (!nh) nh = 1;
  if (FAILED(fac->lpVtbl->CreateBitmapScaler(fac, &scaler))) goto done;
  if (FAILED(scaler->lpVtbl->Initialize(scaler, (IWICBitmapSource *)frame, nw, nh, WICBitmapInterpolationModeFant))) goto done;
  if (FAILED(fac->lpVtbl->CreateFormatConverter(fac, &conv))) goto done;
  if (FAILED(conv->lpVtbl->Initialize(conv, (IWICBitmapSource *)scaler, &GUID_WICPixelFormat24bppBGR,
      WICBitmapDitherTypeNone, NULL, 0, WICBitmapPaletteTypeCustom))) goto done;
  if (FAILED(fac->lpVtbl->CreateStream(fac, &stream))) goto done;
  wchar_t *wdst = u8_to_w(dst);
  HRESULT hr = stream->lpVtbl->InitializeFromFilename(stream, wdst, GENERIC_WRITE);
  free(wdst);
  if (FAILED(hr)) goto done;
  if (FAILED(fac->lpVtbl->CreateEncoder(fac, &GUID_ContainerFormatJpeg, NULL, &enc))) goto done;
  if (FAILED(enc->lpVtbl->Initialize(enc, (IStream *)stream, WICBitmapEncoderNoCache))) goto done;
  if (FAILED(enc->lpVtbl->CreateNewFrame(enc, &ef, &props))) goto done;
  if (props) {
    PROPBAG2 opt; memset(&opt, 0, sizeof(opt));
    opt.pstrName = (LPOLESTR)L"ImageQuality";
    VARIANT v; memset(&v, 0, sizeof(v));
    v.vt = VT_R4; v.fltVal = 0.82f;
    props->lpVtbl->Write(props, 1, &opt, &v);
  }
  if (FAILED(ef->lpVtbl->Initialize(ef, props))) goto done;
  ef->lpVtbl->SetSize(ef, nw, nh);
  WICPixelFormatGUID fmt = GUID_WICPixelFormat24bppBGR;
  ef->lpVtbl->SetPixelFormat(ef, &fmt);
  if (FAILED(ef->lpVtbl->WriteSource(ef, (IWICBitmapSource *)conv, NULL))) goto done;
  if (FAILED(ef->lpVtbl->Commit(ef))) goto done;
  if (FAILED(enc->lpVtbl->Commit(enc))) goto done;
  ok = 1;
done:
  if (props) props->lpVtbl->Release(props);
  if (ef) ef->lpVtbl->Release(ef);
  if (enc) enc->lpVtbl->Release(enc);
  if (stream) stream->lpVtbl->Release(stream);
  if (conv) conv->lpVtbl->Release(conv);
  if (scaler) scaler->lpVtbl->Release(scaler);
  if (frame) frame->lpVtbl->Release(frame);
  if (dec) dec->lpVtbl->Release(dec);
  if (fac) fac->lpVtbl->Release(fac);
  return ok;
}

/* ---------------- 扫描 ---------------- */
typedef struct { cJSON *idx; cJSON *items; } ScanCtx;
static void scan_walk(const char *dir, ScanCtx *ctx, int depth, int *added) {
  if (depth > 16) return;
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
      if (!skip_dir(nm)) scan_walk(full, ctx, depth + 1, added);
    } else if (is_photo_ext(path_ext(nm))) {
      /* 找已有记录 */
      char *id = photo_id(full);
      cJSON *old = NULL;
      cJSON *it = NULL;
      cJSON_ArrayForEach(it, ctx->items) if (!strcmp(json_str(it, "id", ""), id)) { old = it; break; }
      int64_t sz = ((int64_t)fd.nFileSizeHigh << 32) | fd.nFileSizeLow;
      int64_t mt = file_mtime_ms(full);
      if (old) {
        json_set_int(old, "size", sz);
        json_set_int(old, "mtime", mt);
        cJSON_DeleteItemFromObjectCaseSensitive(old, "missing");
      } else {
        ExifData ex; exif_read(full, &ex);
        cJSON *o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "id", id);
        cJSON_AddStringToObject(o, "path", full);
        cJSON_AddStringToObject(o, "name", nm);
        cJSON_AddStringToObject(o, "ext", path_ext(nm));
        json_set_int(o, "size", sz);
        json_set_int(o, "mtime", mt);
        if (ex.taken[0]) { cJSON_AddStringToObject(o, "takenAt", ex.taken); cJSON_AddStringToObject(o, "takenFrom", "exif"); }
        else {
          SYSTEMTIME st; FILETIME ft; ULARGE_INTEGER u; u.QuadPart = (ULONGLONG)(mt + INT64_C(11644473600000)) * 10000ULL; ft.dwLowDateTime = u.LowPart; ft.dwHighDateTime = u.HighPart; FileTimeToLocalFileTime(&ft, &ft); FileTimeToSystemTime(&ft, &st);
          char t[32]; snprintf(t, sizeof(t), "%04d-%02d-%02dT%02d:%02d:%02d", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
          cJSON_AddStringToObject(o, "takenAt", t);
          cJSON_AddStringToObject(o, "takenFrom", "file");
        }
        if (ex.has_gps) {
          cJSON *g = cJSON_CreateObject();
          cJSON_AddNumberToObject(g, "lat", ex.lat);
          cJSON_AddNumberToObject(g, "lng", ex.lng);
          cJSON_AddItemToObject(o, "gps", g);
        } else cJSON_AddItemToObject(o, "gps", cJSON_CreateNull());
        cJSON_AddStringToObject(o, "make", ex.make);
        cJSON_AddStringToObject(o, "model", ex.model);
        json_set_int(o, "orientation", ex.orientation);
        cJSON_AddItemToArray(ctx->items, o);
        (*added)++;
      }
      free(id);
    }
    free(full); free(nm);
  } while (FindNextFileW(h, &fd));
  FindClose(h);
}

/* ---------------- 分发 ---------------- */
static int photos_invoke(const char *channel, const char *args_json, char **out_json, char **out_error) {
  cJSON *args = mod_parse_args(args_json);
  int rc = 0;
  cJSON *res = NULL;
  lock_init();
  EnterCriticalSection(&g_cs);
  if (!strcmp(channel, "photos:state")) {
    cJSON *st = P_state_root();
    cJSON *idx = load_index();
    res = cJSON_CreateObject();
    cJSON *roots = cJSON_GetObjectItemCaseSensitive(st, "roots");
    cJSON *places = cJSON_GetObjectItemCaseSensitive(st, "places");
    cJSON *map = cJSON_GetObjectItemCaseSensitive(st, "map");
    cJSON_AddItemToObject(res, "roots", cJSON_Duplicate(roots, 1));
    cJSON_AddItemToObject(res, "places", cJSON_Duplicate(places, 1));
    cJSON_AddStringToObject(res, "sort", json_str(st, "sort", "time-desc"));
    cJSON_AddItemToObject(res, "map", cJSON_Duplicate(map, 1));
    cJSON_AddNumberToObject(res, "count", cJSON_GetArraySize(cJSON_GetObjectItemCaseSensitive(idx, "items")));
    json_set_int(res, "scannedAt", (int64_t)json_num(idx, "at", 0));
    cJSON_Delete(idx); cJSON_Delete(st);
  } else if (!strcmp(channel, "photos:items")) {
    cJSON *idx = load_index();
    res = cJSON_Duplicate(cJSON_GetObjectItemCaseSensitive(idx, "items"), 1);
    cJSON_Delete(idx);
  } else if (!strcmp(channel, "photos:addRoot")) {
    char *dir = mod_path_from_arg(args, 0);
    cJSON *st = P_state_root();
    cJSON *roots = cJSON_GetObjectItemCaseSensitive(st, "roots");
    int has = 0;
    cJSON *it = NULL;
    cJSON_ArrayForEach(it, roots) if (cJSON_IsString(it) && !_stricmp(it->valuestring, dir)) has = 1;
    if (!has && *dir) cJSON_AddItemToArray(roots, cJSON_CreateString(dir));
    mod_store_set("photos", st);
    res = cJSON_Duplicate(roots, 1);
    cJSON_Delete(st); free(dir);
  } else if (!strcmp(channel, "photos:removeRoot")) {
    char *dir = mod_path_from_arg(args, 0);
    cJSON *st = P_state_root();
    cJSON *roots = cJSON_GetObjectItemCaseSensitive(st, "roots");
    cJSON *out = cJSON_CreateArray();
    cJSON *it = NULL;
    cJSON_ArrayForEach(it, roots) if (cJSON_IsString(it) && _stricmp(it->valuestring, dir)) cJSON_AddItemToArray(out, cJSON_CreateString(it->valuestring));
    cJSON_DeleteItemFromObjectCaseSensitive(st, "roots");
    cJSON_AddItemToObject(st, "roots", out);
    mod_store_set("photos", st);
    res = cJSON_Duplicate(out, 1);
    cJSON_Delete(st); free(dir);
  } else if (!strcmp(channel, "photos:scan")) {
    cJSON *st = P_state_root();
    cJSON *roots = cJSON_GetObjectItemCaseSensitive(st, "roots");
    cJSON *idx = load_index();
    cJSON *items = cJSON_GetObjectItemCaseSensitive(idx, "items");
    /* 没有根目录 / 根目录全掉线时**一首都不删**（外接盘没插上不能当照片被删了） */
    int live_roots = 0;
    cJSON *rr = NULL;
    cJSON_ArrayForEach(rr, roots) if (cJSON_IsString(rr) && path_is_dir(rr->valuestring)) live_roots++;
    if (!live_roots) {
      int withGps0 = 0;
      cJSON *it0 = NULL;
      cJSON_ArrayForEach(it0, items) if (cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(it0, "gps"))) withGps0++;
      res = cJSON_CreateObject();
      cJSON_AddNumberToObject(res, "total", cJSON_GetArraySize(items));
      cJSON_AddNumberToObject(res, "withGps", withGps0);
      cJSON_AddNumberToObject(res, "added", 0);
      cJSON_AddStringToObject(res, "note", "没有可用的照片文件夹，这次什么都没删");
      json_set_int(res, "at", (int64_t)json_num(idx, "at", 0));
      cJSON_Delete(idx); cJSON_Delete(st);
      goto done;
    }
    /* 标记旧记录 missing，再扫 */
    cJSON *it = NULL;
    cJSON_ArrayForEach(it, items) json_set_bool(it, "missing", 1);
    int added = 0;
    ScanCtx ctx = { idx, items };
    cJSON *r = NULL;
    cJSON_ArrayForEach(r, roots) if (cJSON_IsString(r)) scan_walk(r->valuestring, &ctx, 0, &added);
    /* 去掉不存在的；但如果这次一张新照片都没扫到，保守起见保留旧索引 */
    cJSON *keep = cJSON_CreateArray();
    cJSON_ArrayForEach(it, items) {
      if (added > 0 && json_bool(it, "missing", 0)) continue;
      cJSON_DeleteItemFromObjectCaseSensitive(it, "missing");
      cJSON_AddItemToArray(keep, cJSON_Duplicate(it, 1));
    }
    cJSON_DeleteItemFromObjectCaseSensitive(idx, "items");
    cJSON_AddItemToObject(idx, "items", keep);
    json_set_int(idx, "at", now_ms());
    save_index(idx);
    int withGps = 0;
    cJSON_ArrayForEach(it, keep) if (cJSON_IsObject(cJSON_GetObjectItemCaseSensitive(it, "gps"))) withGps++;
    res = cJSON_CreateObject();
    cJSON_AddNumberToObject(res, "total", cJSON_GetArraySize(keep));
    cJSON_AddNumberToObject(res, "withGps", withGps);
    cJSON_AddNumberToObject(res, "added", added);
    json_set_int(res, "at", now_ms());
    cJSON_Delete(idx); cJSON_Delete(st);
    mod_emit_json("photos:changed", "{}");
  } else if (!strcmp(channel, "photos:setPlace")) {
    cJSON *o = mod_arg_obj(args, 0);
    const char *id = o ? json_str(o, "id", "") : "";
    cJSON *place = o ? cJSON_GetObjectItemCaseSensitive(o, "place") : NULL;
    double lat = place ? json_num(place, "lat", 0) : 0;
    double lng = place ? json_num(place, "lng", 0) : 0;
    if (!*id || !place) { rc = -1; *out_error = mod_ret_error("参数不完整"); goto done; }
    if (lat == 0 && lng == 0) { rc = -1; *out_error = mod_ret_error("0,0 不是有效坐标（那是「没拿到坐标」）"); goto done; }
    if (fabs(lat) > 90 || fabs(lng) > 180) { rc = -1; *out_error = mod_ret_error("纬度超过 ±90 或经度超过 ±180"); goto done; }
    cJSON *st = P_state_root();
    cJSON *places = cJSON_GetObjectItemCaseSensitive(st, "places");
    cJSON *p = cJSON_CreateObject();
    cJSON_AddNumberToObject(p, "lat", lat);
    cJSON_AddNumberToObject(p, "lng", lng);
    cJSON_AddStringToObject(p, "name", json_str(place, "name", ""));
    cJSON_DeleteItemFromObjectCaseSensitive(places, id);
    cJSON_AddItemToObject(places, id, p);
    mod_store_set("photos", st);
    res = cJSON_Duplicate(places, 1);
    cJSON_Delete(st);
    mod_emit_json("photos:changed", "{}");
  } else if (!strcmp(channel, "photos:clearPlace")) {
    const char *id = mod_arg_str(args, 0, "");
    cJSON *st = P_state_root();
    cJSON *places = cJSON_GetObjectItemCaseSensitive(st, "places");
    cJSON_DeleteItemFromObjectCaseSensitive(places, id);
    mod_store_set("photos", st);
    res = cJSON_CreateBool(1);
    cJSON_Delete(st);
    mod_emit_json("photos:changed", "{}");
  } else if (!strcmp(channel, "photos:setSort")) {
    cJSON *st = P_state_root();
    cJSON_DeleteItemFromObjectCaseSensitive(st, "sort");
    cJSON_AddStringToObject(st, "sort", mod_arg_str(args, 0, "time-desc"));
    mod_store_set("photos", st);
    res = cJSON_CreateString(json_str(st, "sort", "time-desc"));
    cJSON_Delete(st);
  } else if (!strcmp(channel, "photos:mapConfig")) {
    cJSON *st = P_state_root();
    cJSON *map = cJSON_GetObjectItemCaseSensitive(st, "map");
    cJSON *patch = mod_arg_obj(args, 0);
    if (patch) json_deep_merge(map, patch);
    mod_store_set("photos", st);
    res = cJSON_Duplicate(map, 1);
    cJSON_Delete(st);
  } else if (!strcmp(channel, "photos:thumb")) {
    char *file = mod_path_from_arg(args, 0);
    char *id = photo_id(file);
    char *td = thumbs_dir();
    path_mkdirs(td);
    char fn[64]; snprintf(fn, sizeof(fn), "%s.jpg", id);
    char *dst = path_join(td, fn);
    int ok = path_exists(dst);
    if (!ok && path_exists(file)) ok = make_thumb(file, dst, 480);
    if (ok) res = cJSON_CreateString(dst);
    else res = cJSON_CreateString(file);
    free(dst); free(td); free(id); free(file);
  } else if (!strcmp(channel, "photos:reveal")) {
    char *file = mod_path_from_arg(args, 0);
    reveal_in_explorer(file);
    free(file);
    res = cJSON_CreateBool(1);
  } else {
    rc = -1;
    *out_error = mod_ret_error("图片模块没有这个方法：%s", channel);
  }
done:
  LeaveCriticalSection(&g_cs);
  cJSON_Delete(args);
  if (rc == 0) *out_json = mod_ret_json(res ? res : cJSON_CreateNull());
  return rc;
}

static int photos_init(const SgjHostApi *h) { mod_set_host(h); lock_init(); return 0; }
static void photos_shutdown(void) {}

SGJ_MODULE_EXPORT const SgjModule *sgj_module_entry(void) {
  if (!g_manifest) { g_manifest = mod_res_dup(L"MANIFEST"); g_js = mod_res_dup(L"UI_JS"); }
  g_mod.abi = SGJ_ABI;
  g_mod.id = "photos";
  g_mod.manifest_json = g_manifest;
  g_mod.renderer_js = g_js;
  g_mod.style_css = NULL;
  g_mod.init = photos_init;
  g_mod.shutdown = photos_shutdown;
  g_mod.invoke = photos_invoke;
  return &g_mod;
}
