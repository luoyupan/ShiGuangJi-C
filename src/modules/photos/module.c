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

/* ---------------- 地点搜索（离线常用地名 + 天地图 / OpenStreetMap） ----------------
   用户只输入「上海」「京都」这种地名时，先查内置表；表里没有再联网。
   天地图有 tk 就优先用（国内快），否则用 Nominatim。联网失败时离线结果照样能用。 */
typedef struct { const char *name; const char *addr; double lat, lng; } GeoBuiltin;
static const GeoBuiltin k_geo[] = {
  { "北京", "北京市 · Beijing", 39.9042, 116.4074 },
  { "天安门", "北京市 · Tiananmen", 39.9087, 116.3975 },
  { "故宫", "北京市 · Forbidden City", 39.9163, 116.3972 },
  { "八达岭长城", "北京市 · Great Wall", 40.3620, 116.0160 },
  { "颐和园", "北京市 · Summer Palace", 39.9999, 116.2755 },
  { "上海", "上海市 · Shanghai", 31.2304, 121.4737 },
  { "外滩", "上海市 · The Bund", 31.2400, 121.4900 },
  { "东方明珠", "上海市 · Oriental Pearl", 31.2397, 121.4998 },
  { "陆家嘴", "上海市 · Lujiazui", 31.2390, 121.5000 },
  { "迪士尼", "上海市 · Shanghai Disney", 31.1443, 121.6570 },
  { "天津", "天津市 · Tianjin", 39.3434, 117.3616 },
  { "重庆", "重庆市 · Chongqing", 29.5630, 106.5516 },
  { "洪崖洞", "重庆市 · Hongyadong", 29.5620, 106.5790 },
  { "广州", "广东省 · Guangzhou", 23.1291, 113.2644 },
  { "深圳", "广东省 · Shenzhen", 22.5431, 114.0579 },
  { "杭州", "浙江省 · Hangzhou", 30.2741, 120.1551 },
  { "西湖", "浙江省 · West Lake", 30.2431, 120.1500 },
  { "灵隐寺", "浙江省 · Lingyin Temple", 30.2409, 120.1012 },
  { "南京", "江苏省 · Nanjing", 32.0603, 118.7969 },
  { "苏州", "江苏省 · Suzhou", 31.2989, 120.5853 },
  { "周庄", "江苏省 · Zhouzhuang", 31.1100, 120.8500 },
  { "同里", "江苏省 · Tongli", 31.1500, 120.7200 },
  { "南浔", "浙江省 · Nanxun", 30.8800, 120.4300 },
  { "成都", "四川省 · Chengdu", 30.5728, 104.0668 },
  { "宽窄巷子", "四川省 · Kuanzhai Alley", 30.6690, 104.0550 },
  { "武汉", "湖北省 · Wuhan", 30.5928, 114.3055 },
  { "宜昌", "湖北省 · Yichang", 30.6910, 111.2860 },
  { "三峡大坝", "湖北省 · Three Gorges Dam", 30.8230, 111.0030 },
  { "恩施", "湖北省 · Enshi", 30.2720, 109.4880 },
  { "神农架", "湖北省 · Shennongjia", 31.7450, 110.6750 },
  { "武当山", "湖北省 · Wudangshan", 32.4000, 111.0040 },
  { "西安", "陕西省 · Xi'an", 34.3416, 108.9398 },
  { "兵马俑", "陕西省 · Terracotta Army", 34.3841, 109.2785 },
  { "大雁塔", "陕西省 · Giant Wild Goose Pagoda", 34.2189, 108.9640 },
  { "长沙", "湖南省 · Changsha", 28.2282, 112.9388 },
  { "岳阳", "湖南省 · Yueyang", 29.3570, 113.1290 },
  { "岳阳楼", "湖南省 · Yueyang Tower", 29.3830, 113.0960 },
  { "衡山", "湖南省 · Mount Heng", 27.2500, 112.7300 },
  { "韶山", "湖南省 · Shaoshan", 27.9100, 112.5300 },
  { "洞庭湖", "湖南省 · Dongting Lake", 29.3000, 112.9500 },
  { "郑州", "河南省 · Zhengzhou", 34.7466, 113.6254 },
  { "济南", "山东省 · Jinan", 36.6512, 117.1201 },
  { "青岛", "山东省 · Qingdao", 36.0671, 120.3826 },
  { "蓬莱阁", "山东省 · Penglai Pavilion", 37.8300, 120.7600 },
  { "威海", "山东省 · Weihai", 37.5100, 122.1200 },
  { "烟台", "山东省 · Yantai", 37.4600, 121.4400 },
  { "日照", "山东省 · Rizhao", 35.4200, 119.5300 },
  { "大连", "辽宁省 · Dalian", 38.9140, 121.6147 },
  { "沈阳", "辽宁省 · Shenyang", 41.8057, 123.4315 },
  { "哈尔滨", "黑龙江省 · Harbin", 45.8038, 126.5350 },
  { "镜泊湖", "黑龙江省 · Jingpo Lake", 43.9000, 128.9000 },
  { "五大连池", "黑龙江省 · Wudalianchi", 48.7000, 126.1000 },
  { "漠河", "黑龙江省 · Mohe", 52.9700, 122.5300 },
  { "长白山", "吉林省 · Changbai Mountain", 42.0000, 128.0600 },
  { "长春", "吉林省 · Changchun", 43.8171, 125.3235 },
  { "呼伦贝尔", "内蒙古 · Hulunbuir", 49.2100, 119.7600 },
  { "阿尔山", "内蒙古 · Arxan", 47.1800, 119.9400 },
  { "额济纳胡杨林", "内蒙古 · Ejina Poplar Forest", 41.9600, 101.0700 },
  { "石家庄", "河北省 · Shijiazhuang", 38.0428, 114.5149 },
  { "承德避暑山庄", "河北省 · Chengde Mountain Resort", 40.9900, 117.9400 },
  { "北戴河", "河北省 · Beidaihe", 39.8300, 119.4800 },
  { "白洋淀", "河北省 · Baiyangdian", 38.9300, 115.9900 },
  { "太原", "山西省 · Taiyuan", 37.8706, 112.5489 },
  { "呼和浩特", "内蒙古 · Hohhot", 40.8426, 111.7492 },
  { "乌鲁木齐", "新疆 · Urumqi", 43.8256, 87.6168 },
  { "天山天池", "新疆 · Tianchi Lake", 43.8900, 88.1200 },
  { "喀纳斯", "新疆 · Kanas", 48.7000, 87.0000 },
  { "赛里木湖", "新疆 · Sayram Lake", 44.6000, 81.2000 },
  { "那拉提", "新疆 · Nalati", 43.3000, 84.0000 },
  { "喀什古城", "新疆 · Kashgar", 39.4700, 75.9900 },
  { "拉萨", "西藏 · Lhasa", 29.6520, 91.1721 },
  { "大昭寺", "西藏 · Jokhang Temple", 29.6530, 91.1320 },
  { "纳木错", "西藏 · Namtso", 30.7000, 90.6000 },
  { "羊卓雍措", "西藏 · Yamdrok Lake", 28.9500, 90.7000 },
  { "布达拉宫", "西藏 · Potala Palace", 29.6570, 91.1170 },
  { "西宁", "青海省 · Xining", 36.6171, 101.7782 },
  { "青海湖", "青海省 · Qinghai Lake", 36.9000, 100.2000 },
  { "茶卡盐湖", "青海省 · Chaka Salt Lake", 36.7000, 99.0800 },
  { "兰州", "甘肃省 · Lanzhou", 36.0611, 103.8343 },
  { "银川", "宁夏 · Yinchuan", 38.4872, 106.2309 },
  { "昆明", "云南省 · Kunming", 25.0389, 102.7183 },
  { "贵阳", "贵州省 · Guiyang", 26.6470, 106.6302 },
  { "黄果树瀑布", "贵州省 · Huangguoshu Falls", 25.9900, 105.6670 },
  { "荔波小七孔", "贵州省 · Libo Xiaoqikong", 25.4120, 107.8790 },
  { "梵净山", "贵州省 · Fanjingshan", 27.9100, 108.6900 },
  { "镇远古镇", "贵州省 · Zhenyuan", 27.0500, 108.4250 },
  { "南宁", "广西 · Nanning", 22.8170, 108.3665 },
  { "海口", "海南省 · Haikou", 20.0440, 110.1999 },
  { "三亚", "海南省 · Sanya", 18.2528, 109.5119 },
  { "福州", "福建省 · Fuzhou", 26.0745, 119.2965 },
  { "厦门", "福建省 · Xiamen", 24.4798, 118.0894 },
  { "鼓浪屿", "福建省 · Gulangyu", 24.4470, 118.0670 },
  { "南昌", "江西省 · Nanchang", 28.6820, 115.8579 },
  { "九江", "江西省 · Jiujiang", 29.7051, 116.0019 },
  { "庐山", "江西省九江市 · Mount Lu / Lushan", 29.5581, 115.9820 },
  { "庐山风景区", "江西省九江市 · Lushan Scenic Area", 29.5581, 115.9820 },
  { "三叠泉", "江西省九江市 · Sandie Spring", 29.5500, 115.9900 },
  { "景德镇", "江西省 · Jingdezhen", 29.2687, 117.1784 },
  { "婺源", "江西省 · Wuyuan", 29.2480, 117.8610 },
  { "三清山", "江西省 · Sanqingshan", 28.9150, 118.0700 },
  { "龙虎山", "江西省 · Longhushan", 28.1200, 116.9800 },
  { "井冈山", "江西省 · Jinggangshan", 26.7450, 114.1600 },
  { "合肥", "安徽省 · Hefei", 31.8206, 117.2272 },
  { "九华山", "安徽省 · Jiuhuashan", 30.4770, 117.8050 },
  { "天柱山", "安徽省 · Tianzhushan", 30.7330, 116.4590 },
  { "宏村", "安徽省 · Hongcun", 30.0030, 117.9860 },
  { "西递", "安徽省 · Xidi", 29.9050, 117.9870 },
  { "宁波", "浙江省 · Ningbo", 29.8683, 121.5440 },
  { "千岛湖", "浙江省 · Qiandao Lake", 29.6050, 119.0420 },
  { "普陀山", "浙江省 · Putuoshan", 30.0090, 122.3860 },
  { "雁荡山", "浙江省 · Yandangshan", 28.3720, 121.0570 },
  { "乌镇", "浙江省 · Wuzhen", 30.7450, 120.4870 },
  { "西塘", "浙江省 · Xitang", 30.9430, 120.8850 },
  { "温州", "浙江省 · Wenzhou", 27.9949, 120.6994 },
  { "无锡", "江苏省 · Wuxi", 31.4912, 120.3119 },
  { "常州", "江苏省 · Changzhou", 31.8107, 119.9741 },
  { "南通", "江苏省 · Nantong", 31.9802, 120.8943 },
  { "扬州", "江苏省 · Yangzhou", 32.3942, 119.4129 },
  { "镇江", "江苏省 · Zhenjiang", 32.1878, 119.4250 },
  { "绍兴", "浙江省 · Shaoxing", 30.0303, 120.5802 },
  { "嘉兴", "浙江省 · Jiaxing", 30.7461, 120.7555 },
  { "湖州", "浙江省 · Huzhou", 30.8927, 120.0868 },
  { "金华", "浙江省 · Jinhua", 29.0784, 119.6474 },
  { "台州", "浙江省 · Taizhou", 28.6560, 121.4207 },
  { "珠海", "广东省 · Zhuhai", 22.2710, 113.5767 },
  { "佛山", "广东省 · Foshan", 23.0215, 113.1214 },
  { "东莞", "广东省 · Dongguan", 23.0207, 113.7518 },
  { "中山", "广东省 · Zhongshan", 22.5176, 113.3926 },
  { "惠州", "广东省 · Huizhou", 23.1115, 114.4161 },
  { "汕头", "广东省 · Shantou", 23.3541, 116.6819 },
  { "泉州", "福建省 · Quanzhou", 24.8741, 118.6757 },
  { "武夷山", "福建省 · Wuyishan", 27.7560, 118.0350 },
  { "太姥山", "福建省 · Taimushan", 27.1000, 120.2000 },
  { "湄洲岛", "福建省 · Meizhou Island", 25.0900, 119.1200 },
  { "莆田", "福建省 · Putian", 25.4541, 119.0078 },
  { "桂林", "广西 · Guilin", 25.2736, 110.2900 },
  { "漓江", "广西 · Li River", 25.2000, 110.4500 },
  { "阳朔", "广西 · Yangshuo", 24.7785, 110.4966 },
  { "龙脊梯田", "广西 · Longji Rice Terraces", 25.7500, 110.1000 },
  { "涠洲岛", "广西 · Weizhou Island", 21.0400, 109.1000 },
  { "张家界", "湖南省 · Zhangjiajie", 29.1170, 110.4792 },
  { "张家界国家森林公园", "湖南省 · Zhangjiajie Forest Park", 29.3150, 110.4340 },
  { "凤凰古城", "湖南省 · Fenghuang", 27.9480, 109.5990 },
  { "黄山", "安徽省 · Huangshan", 29.7147, 118.3376 },
  { "黄山风景区", "安徽省 · Huangshan Scenic Area", 30.1330, 118.1670 },
  { "丽江", "云南省 · Lijiang", 26.8721, 100.2299 },
  { "泸沽湖", "云南省 · Lugu Lake", 27.7000, 100.7800 },
  { "玉龙雪山", "云南省 · Jade Dragon Snow Mountain", 27.1000, 100.1800 },
  { "梅里雪山", "云南省 · Meili Snow Mountain", 28.4500, 98.6800 },
  { "腾冲", "云南省 · Tengchong", 25.0200, 98.4900 },
  { "元阳梯田", "云南省 · Yuanyang Rice Terraces", 23.1000, 102.7500 },
  { "大理", "云南省 · Dali", 25.6065, 100.2676 },
  { "香格里拉", "云南省 · Shangri-La", 27.8268, 99.7009 },
  { "西双版纳", "云南省 · Xishuangbanna", 22.0017, 100.7979 },
  { "九寨沟", "四川省 · Jiuzhaigou", 33.2600, 103.9186 },
  { "稻城亚丁", "四川省 · Daocheng Yading", 28.4500, 100.3300 },
  { "四姑娘山", "四川省 · Siguniang Mountain", 31.0800, 102.9000 },
  { "色达", "四川省 · Seda", 32.2700, 100.3300 },
  { "若尔盖", "四川省 · Zoige", 33.5800, 102.9600 },
  { "峨眉山", "四川省 · Emeishan", 29.6012, 103.4845 },
  { "乐山", "四川省 · Leshan", 29.5521, 103.7656 },
  { "都江堰", "四川省 · Dujiangyan", 31.0026, 103.6172 },
  { "泰山", "山东省 · Mount Tai", 36.2550, 117.1000 },
  { "曲阜", "山东省 · Qufu", 35.5800, 116.9865 },
  { "洛阳", "河南省 · Luoyang", 34.6197, 112.4540 },
  { "开封", "河南省 · Kaifeng", 34.7972, 114.3076 },
  { "大同", "山西省 · Datong", 40.0768, 113.3001 },
  { "云冈石窟", "山西省 · Yungang Grottoes", 40.1100, 113.1200 },
  { "悬空寺", "山西省 · Hanging Temple", 39.6600, 113.7000 },
  { "五台山", "山西省 · Wutaishan", 39.0000, 113.5900 },
  { "壶口瀑布", "山西省 · Hukou Falls", 36.1500, 110.4400 },
  { "平遥", "山西省 · Pingyao", 37.1896, 112.1749 },
  { "敦煌", "甘肃省 · Dunhuang", 40.1421, 94.6619 },
  { "莫高窟", "甘肃省 · Mogao Caves", 40.0420, 94.8090 },
  { "鸣沙山月牙泉", "甘肃省 · Crescent Lake", 40.0900, 94.6800 },
  { "张掖", "甘肃省 · Zhangye", 38.9259, 100.4498 },
  { "张掖丹霞", "甘肃省 · Zhangye Danxia", 38.9500, 100.1000 },
  { "嘉峪关", "甘肃省 · Jiayuguan", 39.8000, 98.2900 },
  { "酒泉", "甘肃省 · Jiuquan", 39.7325, 98.4943 },
  { "格尔木", "青海省 · Golmud", 36.4064, 94.9033 },
  { "林芝", "西藏 · Nyingchi", 29.6489, 94.3615 },
  { "日喀则", "西藏 · Shigatse", 29.2670, 88.8800 },
  { "珠穆朗玛峰", "西藏 · Mount Everest", 27.9881, 86.9250 },
  { "香港", "香港 · Hong Kong", 22.3193, 114.1694 },
  { "澳门", "澳门 · Macau", 22.1987, 113.5439 },
  { "台北", "台湾 · Taipei", 25.0330, 121.5654 },
  { "高雄", "台湾 · Kaohsiung", 22.6273, 120.3014 },
  { "东京", "日本 · Tokyo", 35.6762, 139.6503 },
  { "富士山", "日本 · Mount Fuji", 35.3606, 138.7274 },
  { "大阪", "日本 · Osaka", 34.6937, 135.5023 },
  { "京都", "日本 · Kyoto", 35.0116, 135.7681 },
  { "清水寺", "日本 · Kiyomizu-dera", 34.9949, 135.7850 },
  { "奈良公园", "日本 · Nara Park", 34.6851, 135.8430 },
  { "札幌", "日本 · Sapporo", 43.0618, 141.3545 },
  { "冲绳", "日本 · Okinawa", 26.2124, 127.6809 },
  { "首尔", "韩国 · Seoul", 37.5665, 126.9780 },
  { "釜山", "韩国 · Busan", 35.1796, 129.0756 },
  { "曼谷", "泰国 · Bangkok", 13.7563, 100.5018 },
  { "清迈", "泰国 · Chiang Mai", 18.7883, 98.9853 },
  { "普吉", "泰国 · Phuket", 7.8804, 98.3923 },
  { "新加坡", "新加坡 · Singapore", 1.3521, 103.8198 },
  { "吉隆坡", "马来西亚 · Kuala Lumpur", 3.1390, 101.6869 },
  { "巴厘岛", "印度尼西亚 · Bali", -8.4095, 115.1889 },
  { "河内", "越南 · Hanoi", 21.0278, 105.8342 },
  { "胡志明市", "越南 · Ho Chi Minh City", 10.8231, 106.6297 },
  { "暹粒", "柬埔寨 · Siem Reap", 13.3671, 103.8448 },
  { "马尼拉", "菲律宾 · Manila", 14.5995, 120.9842 },
  { "巴黎", "法国 · Paris", 48.8566, 2.3522 },
  { "埃菲尔铁塔", "法国 · Eiffel Tower", 48.8584, 2.2945 },
  { "卢浮宫", "法国 · Louvre", 48.8606, 2.3376 },
  { "伦敦", "英国 · London", 51.5074, -0.1278 },
  { "罗马", "意大利 · Rome", 41.9028, 12.4964 },
  { "威尼斯", "意大利 · Venice", 45.4408, 12.3155 },
  { "佛罗伦萨", "意大利 · Florence", 43.7696, 11.2558 },
  { "米兰", "意大利 · Milan", 45.4642, 9.1900 },
  { "巴塞罗那", "西班牙 · Barcelona", 41.3874, 2.1686 },
  { "马德里", "西班牙 · Madrid", 40.4168, -3.7038 },
  { "柏林", "德国 · Berlin", 52.5200, 13.4050 },
  { "慕尼黑", "德国 · Munich", 48.1351, 11.5820 },
  { "阿姆斯特丹", "荷兰 · Amsterdam", 52.3676, 4.9041 },
  { "维也纳", "奥地利 · Vienna", 48.2082, 16.3738 },
  { "布拉格", "捷克 · Prague", 50.0755, 14.4378 },
  { "苏黎世", "瑞士 · Zurich", 47.3769, 8.5417 },
  { "日内瓦", "瑞士 · Geneva", 46.2044, 6.1432 },
  { "因特拉肯", "瑞士 · Interlaken", 46.6863, 7.8632 },
  { "雅典", "希腊 · Athens", 37.9838, 23.7275 },
  { "圣托里尼", "希腊 · Santorini", 36.3932, 25.4615 },
  { "里斯本", "葡萄牙 · Lisbon", 38.7223, -9.1393 },
  { "纽约", "美国 · New York", 40.7128, -74.0060 },
  { "自由女神像", "美国 · Statue of Liberty", 40.6892, -74.0445 },
  { "洛杉矶", "美国 · Los Angeles", 34.0522, -118.2437 },
  { "旧金山", "美国 · San Francisco", 37.7749, -122.4194 },
  { "西雅图", "美国 · Seattle", 47.6062, -122.3321 },
  { "芝加哥", "美国 · Chicago", 41.8781, -87.6298 },
  { "温哥华", "加拿大 · Vancouver", 49.2827, -123.1207 },
  { "多伦多", "加拿大 · Toronto", 43.6532, -79.3832 },
  { "悉尼", "澳大利亚 · Sydney", -33.8688, 151.2093 },
  { "悉尼歌剧院", "澳大利亚 · Sydney Opera House", -33.8568, 151.2153 },
  { "墨尔本", "澳大利亚 · Melbourne", -37.8136, 144.9631 },
  { "奥克兰", "新西兰 · Auckland", -36.8509, 174.7645 },
  { "开罗", "埃及 · Cairo", 30.0444, 31.2357 },
  { "迪拜", "阿联酋 · Dubai", 25.2048, 55.2708 },
  { "伊斯坦布尔", "土耳其 · Istanbul", 41.0082, 28.9784 },
  { "莫斯科", "俄罗斯 · Moscow", 55.7558, 37.6173 },
  { "雷克雅未克", "冰岛 · Reykjavik", 64.1466, -21.9426 },
  { "开普敦", "南非 · Cape Town", -33.9249, 18.4241 },
  { "里约热内卢", "巴西 · Rio de Janeiro", -22.9068, -43.1729 },
  { "布宜诺斯艾利斯", "阿根廷 · Buenos Aires", -34.6037, -58.3816 },
  { "墨西哥城", "墨西哥 · Mexico City", 19.4326, -99.1332 },
  { "檀香山", "美国 · Honolulu", 21.3069, -157.8583 },
  { "马尔代夫", "马尔代夫 · Maldives", 3.2028, 73.2207 }
};

static double geo_num(cJSON *o, const char *k) {
  cJSON *v = o ? cJSON_GetObjectItemCaseSensitive(o, k) : NULL;
  if (cJSON_IsNumber(v)) return v->valuedouble;
  if (cJSON_IsString(v) && v->valuestring && *v->valuestring) return atof(v->valuestring);
  return 0;
}
static void geo_add(cJSON *arr, const char *name, const char *addr, double lat, double lng, const char *source) {
  if (!name || !*name) return;
  if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) return;
  if (lat == 0 && lng == 0) return;
  cJSON *it = NULL;
  cJSON_ArrayForEach(it, arr) {
    if (fabs(geo_num(it, "lat") - lat) < 0.0005 && fabs(geo_num(it, "lng") - lng) < 0.0005) return;
  }
  cJSON *o = cJSON_CreateObject();
  cJSON_AddStringToObject(o, "name", name);
  cJSON_AddStringToObject(o, "address", addr ? addr : name);
  cJSON_AddNumberToObject(o, "lat", lat);
  cJSON_AddNumberToObject(o, "lng", lng);
  cJSON_AddStringToObject(o, "source", source ? source : "offline");
  cJSON_AddItemToArray(arr, o);
}
static int u8_len(unsigned char c) {
  if (c >= 0xF0) return 4;
  if (c >= 0xE0) return 3;
  if (c >= 0xC0) return 2;
  return 1;
}
/* 查询里的每个字都在名字里出现过（顺序不严）→ 允许「庐山景区」命中「庐山风景区」 */
static int geo_subseq(const char *q, const char *name) {
  const char *p = q;
  int total = 0;
  while (*p) {
    int l = u8_len((unsigned char)*p);
    const char *s = name;
    int found = 0;
    while (*s) {
      int sl = u8_len((unsigned char)*s);
      if (sl == l && !memcmp(s, p, (size_t)l)) { found = 1; break; }
      s += sl;
    }
    if (!found) return 0;
    total++; p += l;
  }
  return total >= 2;
}
static int u8_decode(const char *s, unsigned int *cp, int max) {
  int n = 0;
  const unsigned char *p = (const unsigned char *)s;
  while (*p && n < max) {
    unsigned int c = *p;
    int l = 1;
    if (c >= 0xF0) { c &= 0x07; l = 4; }
    else if (c >= 0xE0) { c &= 0x0F; l = 3; }
    else if (c >= 0xC0) { c &= 0x1F; l = 2; }
    for (int i = 1; i < l; i++) {
      if (!p[i]) { l = i; break; }
      c = (c << 6) | (p[i] & 0x3F);
    }
    cp[n++] = c;
    p += l;
  }
  return n;
}
/* 允许一个字的错别字 / 多字少字：芦山 → 庐山，北就 → 北京 */
static int geo_edit1(const char *q, const char *name) {
  unsigned int a[32], b[32];
  int na = u8_decode(q, a, 32), nb = u8_decode(name, b, 32);
  /* 两个字的查询做“错一个字”会太宽（芦山→衡山/韶山/庐山…），只对 3 字以上启用 */
  if (na < 3 || nb < 3 || abs(na - nb) > 1) return 0;
  if (na == nb) {
    int diff = 0;
    for (int i = 0; i < na; i++) if (a[i] != b[i]) diff++;
    return diff == 1;
  }
  const unsigned int *sm = na < nb ? a : b, *lg = na < nb ? b : a;
  int ns = na < nb ? na : nb, nl = na < nb ? nb : na;
  int i = 0, j = 0, diff = 0;
  while (i < ns && j < nl) {
    if (sm[i] == lg[j]) { i++; j++; }
    else { diff++; j++; if (diff > 1) return 0; }
  }
  if (j < nl) diff++;
  return diff == 1;
}
typedef struct { int score; int idx; } GeoHit;
static int geo_hit_cmp(const void *a, const void *b) {
  const GeoHit *x = (const GeoHit *)a, *y = (const GeoHit *)b;
  if (y->score != x->score) return y->score - x->score;
  /* 同分时短名字优先：lushan 应该先回「庐山」而不是「庐山风景区」 */
  return (int)strlen(k_geo[x->idx].name) - (int)strlen(k_geo[y->idx].name);
}
static int geo_text_score(const char *ql, const char *name, const char *addr) {
  char *n = str_lower(name), *a = str_lower(addr);
  size_t qn = strlen(ql);
  int score = 0;
  if (!strcmp(n, ql)) score = 100;
  else if (!strncmp(n, ql, qn)) score = 85;
  else if (strstr(n, ql)) score = 70;
  else if (strstr(a, ql)) score = 50;
  else if (geo_edit1(ql, n)) score = 35;
  else if (geo_subseq(ql, n)) score = 30;
  free(n); free(a);
  return score;
}
/* 返回最高匹配分，0 表示一个都没有；调用方据此决定要不要联网 */
static int geo_offline(cJSON *arr, const char *q) {
  char *low = str_lower(q);
  int count = (int)(sizeof(k_geo) / sizeof(k_geo[0]));
  GeoHit *hits = (GeoHit *)xmalloc(sizeof(GeoHit) * (size_t)count);
  int n = 0;
  for (int i = 0; i < count; i++) {
    int s = geo_text_score(low, k_geo[i].name, k_geo[i].addr);
    if (s > 0) { hits[n].score = s; hits[n].idx = i; n++; }
  }
  qsort(hits, (size_t)n, sizeof(GeoHit), geo_hit_cmp);
  int added = 0;
  for (int i = 0; i < n && added < 8; i++) {
    int k = hits[i].idx;
    geo_add(arr, k_geo[k].name, k_geo[k].addr, k_geo[k].lat, k_geo[k].lng, "离线");
    added++;
  }
  int top = n ? hits[0].score : 0;
  free(hits); free(low);
  return top;
}
static void geo_nominatim(cJSON *arr, const char *q) {
  char *enc = url_encode(q);
  if (!enc) return;
  size_t cap = strlen(enc) + 256;
  char *url = (char *)xmalloc(cap);
  snprintf(url, cap, "https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&accept-language=zh-CN&q=%s", enc);
  const char *headers = "User-Agent: ShiGuangJi/1.0 (Windows desktop app; local photo map)\r\nAccept: application/json\r\n";
  int status = 0;
  char *body = g_host->http_request("GET", url, headers, NULL, 0, 7000, &status, NULL);
  free(url); free(enc);
  if (!body || status != 200) { if (body) g_host->dealloc(body); return; }
  cJSON *j = cJSON_Parse(body);
  g_host->dealloc(body);
  if (!cJSON_IsArray(j)) { cJSON_Delete(j); return; }
  cJSON *it = NULL;
  cJSON_ArrayForEach(it, j) {
    const char *addr = json_str(it, "display_name", "");
    const char *nm = json_str(it, "name", "");
    double lat = geo_num(it, "lat"), lng = geo_num(it, "lon");
    if (!*nm) {
      const char *comma = strchr(addr, ',');
      size_t n = comma ? (size_t)(comma - addr) : strlen(addr);
      char *tmp = xstrndup(addr, n);
      geo_add(arr, tmp, addr, lat, lng, "OpenStreetMap");
      free(tmp);
    } else geo_add(arr, nm, addr, lat, lng, "OpenStreetMap");
  }
  cJSON_Delete(j);
}
static void geo_tianditu(cJSON *arr, const char *q, const char *tk) {
  if (!tk || !*tk) return;
  char safe[256];
  snprintf(safe, sizeof(safe), "%s", q);
  for (char *p = safe; *p; p++) if (*p == '"' || *p == '\\' || *p == '\n' || *p == '\r') *p = ' ';
  char ds[1024];
  snprintf(ds, sizeof(ds), "{\"keyWord\":\"%s\"}", safe);
  char *denc = url_encode(ds), *tenc = url_encode(tk);
  if (!denc || !tenc) { free(denc); free(tenc); return; }
  size_t cap = strlen(denc) + strlen(tenc) + 128;
  char *url = (char *)xmalloc(cap);
  snprintf(url, cap, "https://api.tianditu.gov.cn/geocoder?ds=%s&tk=%s", denc, tenc);
  int status = 0;
  char *body = g_host->http_request("GET", url, "Accept: application/json\r\n", NULL, 0, 7000, &status, NULL);
  free(url); free(denc); free(tenc);
  if (!body || status != 200) { if (body) g_host->dealloc(body); return; }
  cJSON *j = cJSON_Parse(body);
  g_host->dealloc(body);
  if (!cJSON_IsObject(j)) { cJSON_Delete(j); return; }
  cJSON *loc = cJSON_GetObjectItemCaseSensitive(j, "location");
  if (cJSON_IsObject(loc)) {
    double lat = geo_num(loc, "lat"), lng = geo_num(loc, "lon");
    const char *addr = json_str(j, "formatted_address", "");
    geo_add(arr, *addr ? addr : q, addr, lat, lng, "天地图");
  }
  cJSON_Delete(j);
}
static int photos_geocode(cJSON *args, char **out_json, char **out_error) {
  const char *raw = mod_arg_str(args, 0, "");
  char q[256];
  snprintf(q, sizeof(q), "%s", raw ? raw : "");
  char *s = q;
  while (*s == ' ' || *s == '\t') s++;
  size_t n = strlen(s);
  while (n && (s[n - 1] == ' ' || s[n - 1] == '\t')) s[--n] = 0;
  if (!*s) { *out_error = mod_ret_error("先输入一个地点名，比如：上海 / 京都"); return -1; }
  cJSON *arr = cJSON_CreateArray();
  int top = geo_offline(arr, s);
  /* 常见地名 / 模糊命中直接离线返回，不联网等 7 秒；完全没命中才查天地图 / OSM */
  if (top < 30) {
    cJSON *st = P_state_root();
    cJSON *map = cJSON_GetObjectItemCaseSensitive(st, "map");
    const char *tk = map ? json_str(map, "tk", "") : "";
    if (tk && *tk) geo_tianditu(arr, s, tk);
    else geo_nominatim(arr, s);
    cJSON_Delete(st);
  }
  if (!cJSON_GetArraySize(arr)) {
    cJSON_Delete(arr);
    *out_error = mod_ret_error("没找到「%s」。试试更完整的名字，或在设置里填天地图 tk。", s);
    return -1;
  }
  *out_json = mod_ret_json(arr);
  return 0;
}

/* ---------------- 分发 ---------------- */
static int photos_invoke(const char *channel, const char *args_json, char **out_json, char **out_error) {
  cJSON *args = mod_parse_args(args_json);
  int rc = 0;
  cJSON *res = NULL;
  /* 地点搜索要走网络，不能占着照片的锁（否则地图/缩略图会卡住） */
  if (!strcmp(channel, "photos:geocode")) {
    int r = photos_geocode(args, out_json, out_error);
    cJSON_Delete(args);
    return r;
  }
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
    double lat = place ? geo_num(place, "lat") : 0;
    double lng = place ? geo_num(place, "lng") : 0;
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
  } else if (!strcmp(channel, "photos:setPlaces")) {
    cJSON *o = mod_arg_obj(args, 0);
    cJSON *ids = o ? cJSON_GetObjectItemCaseSensitive(o, "ids") : NULL;
    cJSON *place = o ? cJSON_GetObjectItemCaseSensitive(o, "place") : NULL;
    double lat = place ? geo_num(place, "lat") : 0;
    double lng = place ? geo_num(place, "lng") : 0;
    if (!cJSON_IsArray(ids) || !cJSON_GetArraySize(ids) || !place) { rc = -1; *out_error = mod_ret_error("先选照片，再填坐标"); goto done; }
    if (lat == 0 && lng == 0) { rc = -1; *out_error = mod_ret_error("0,0 不是有效坐标（那是「没拿到坐标」）"); goto done; }
    if (fabs(lat) > 90 || fabs(lng) > 180) { rc = -1; *out_error = mod_ret_error("纬度超过 ±90 或经度超过 ±180"); goto done; }
    cJSON *st = P_state_root();
    cJSON *places = cJSON_GetObjectItemCaseSensitive(st, "places");
    const char *nm = json_str(place, "name", "");
    int count = 0;
    cJSON *it = NULL;
    cJSON_ArrayForEach(it, ids) {
      if (!cJSON_IsString(it) || !it->valuestring || !*it->valuestring) continue;
      cJSON *p = cJSON_CreateObject();
      cJSON_AddNumberToObject(p, "lat", lat);
      cJSON_AddNumberToObject(p, "lng", lng);
      cJSON_AddStringToObject(p, "name", nm);
      cJSON_DeleteItemFromObjectCaseSensitive(places, it->valuestring);
      cJSON_AddItemToObject(places, it->valuestring, p);
      count++;
    }
    mod_store_set("photos", st);
    res = cJSON_CreateObject();
    cJSON_AddNumberToObject(res, "count", count);
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
