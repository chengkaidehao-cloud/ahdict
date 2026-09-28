// 新编阿汉大词典 · 离线检索阅读器（PWA）
import * as pdfjsLib from './vendor/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs', location.href).href;

/* ============================ 常量与状态 ============================ */
const PDF_URL = new URL('./新编阿汉大词典.pdf', location.href).href;
const WASM_URL = new URL('./vendor/wasm/', location.href).href;
const TOTAL_PAGES = 2372;

const S = {
  doc: null,
  page: 1,
  zoom: 1,              // 视觉倍率（1 = 适配屏幕）；只进 CSS transform，不影响渲染
  tx: 0, ty: 0,
  rendering: false,
  pendingPage: null,
  index: null,          // { pages: [...], roots: [...] }
  outline: null,        // 原始三层树
  hlWords: new Map(),   // page -> { words, lines }（高亮用）
  hlQuery: '',
  rtlNormalize: true,
  highlight: true,
  objectUrl: null,      // 本地文件模式
  viewMode: 'column',   // 'column' 单栏阅读（默认，字大清晰）| 'page' 整页
  pagesReady: false,
  arIndex: null,        // 阿语 OCR 词形索引
  words: [],            // 生词本 [{ key, q, page, root, at }]
  history: [],          // 搜索历史 [{ q, at }]
  tab: 'tree',           // 抽屉当前 tab：tree | words | history
};

const DPR_MAX = 3;          // 用满手机物理分辨率（此前截断到 2 导致欠采样）
const SCAN_WIDTH = 2144;    // 原始扫描图宽度（渲染分辨率上限）
const MAX_CANVAS_PIXELS = 12e6;  // canvas 面积上限（iOS Safari 约 16.7M 硬限制，留余量）

// 缩放：S.zoom 是「视觉倍率」，由 #stage 的 CSS transform 承担 —— 捏合期间零重渲染。
// 位图倍率只由「适配屏幕」决定，见 优化方案-缩放跟手与历史扩容.md
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 6;
// 整页模式位图多渲染 1.5 倍：该模式 fit 位图仅约 1170px 宽 < 原扫描图 2144px，
// 有真实细节可提，放大到 1.5× 之前无需重渲染也保持锐利（单栏模式已超采样，无需此系数）
const PAGE_MODE_SHARP = 1.5;

/* ============================ DOM ============================ */
const $ = (id) => document.getElementById(id);
const el = {
  viewer: $('viewer'), stage: $('stage'), canvas: $('page-canvas'), hlLayer: $('highlight-layer'),
  search: $('search'), clear: $('btn-clear'), status: $('status'),
  pageInput: $('page-input'), pageTotal: $('page-total'),
  results: $('results'), resultsList: $('results-list'), resultsTitle: $('results-title'),
  drawer: $('drawer'), tree: $('tree'), treeSearch: $('tree-search'), scrim: $('scrim'),
  settings: $('settings'), cacheStatus: $('cache-status'), engineStatus: $('engine-status'),
  fileInput: $('file-input'),
  arkb: $('arkb'),            // 阿语软键盘面板
};

function toast(msg, ms = 2200) {
  el.status.textContent = msg;
  el.status.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.status.hidden = true; }, ms);
}

/* ============================ 阿拉伯语处理 ============================ */
const AR_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;
const AR_RANGE = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;

function hasArabic(s) { return AR_RANGE.test(s); }
function hasCJK(s) { return /[\u3400-\u4DBF\u4E00-\u9FFF]/.test(s); }

// 归一化：去变音符/tatweel，统一 alef/ya/ta-marbuta 形式
function normAr(s) {
  return (s || '')
    .replace(AR_DIACRITICS, '')
    // 同类字母的编码变体归一化：波斯/乌尔都语键盘、或从网页复制时很常见。
    // 不处理的话「کتاب」完全匹配不上「كتب」—— 这是实测可复现的失效场景。
    // 注意：گ پ چ ژ 属于不同字母，故意不映射，避免引入错误匹配。
    .replace(/[کڪ]/g, "ك")      // 波斯/信德语 kaf → 阿拉伯语 kaf
    .replace(/[یې]/g, "ي")      // 波斯/普什图语 yeh → 阿拉伯语 yeh
    .replace(/[ہھۀە]/g, "ه")    // 乌尔都/普什图语 heh → 阿拉伯语 heh
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627')
    .replace(/\u0649/g, '\u064A')
    .replace(/\u0629/g, '\u0647')
    .replace(/[^\u0600-\u06FF]/g, '');
}
// 弱字母剥离 → 辅音骨架（近似词根）
function skeleton(s) { return normAr(s).replace(/[\u0627\u0648\u064A]/g, ''); }

// 词根字符串 "أ-ب-ب" → 紧凑 "أبب"
function rootCompact(t) { return normAr((t || '').replace(/[-\s\u2010-\u2015]/g, '')); }

/* ============================ PDF 加载与渲染 ============================ */
async function loadDoc(url) {
  el.engineStatus.textContent = '正在加载 PDF…';
  const task = pdfjsLib.getDocument({
    url,
    wasmUrl: WASM_URL,
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: 0,
  });
  task.onProgress = (p) => {
    if (p && p.total) el.engineStatus.textContent = `加载 PDF ${Math.round(p.loaded / p.total * 100)}%`;
  };
  S.doc = await task.promise;
  el.pageTotal.textContent = `/ ${S.doc.numPages}`;
  el.engineStatus.textContent = `已就绪 · ${S.doc.numPages} 页`;
  await renderPage(S.page);
}

function fitScaleFor(page) {
  const base = page.getViewport({ scale: 1 });
  const availW = el.viewer.clientWidth;
  const availH = el.viewer.clientHeight;
  if (S.viewMode === 'column') {
    // 单栏阅读：一栏占满屏宽（双栏页面 → 视觉字号约放大 2 倍）
    return availW / (base.width / 2);
  }
  // 整页：完整页面塞进屏幕
  return Math.min(availW / base.width, availH / base.height);
}

// 单栏模式下按 RTL 习惯先定位到右栏
function resetScrollForMode() {
  S.ty = 0;
  if (S.viewMode === 'column') {
    const cw = el.canvas.clientWidth, vw = el.viewer.clientWidth;
    S.tx = -Math.max(0, cw - vw);
  } else {
    S.tx = 0;
  }
}

async function renderPage(n) {
  if (!S.doc) return;
  if (S.rendering) { S.pendingPage = n; return; }
  S.rendering = true;
  try {
    n = Math.min(Math.max(1, n), S.doc.numPages);
    const page = await S.doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const fit = fitScaleFor(page);
    // 用满设备物理像素（此前截断到 2 会欠采样）；上限允许约 1.6 倍超采样，
    // 否则在 dpr=3 的手机上单栏视图会因原图分辨率不足而字号偏小
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_MAX);
    const maxScale = (SCAN_WIDTH * 1.6) / base.width;
    // ★ 位图倍率不含 S.zoom：缩放改由 CSS transform 承担（GPU 合成，捏合即时跟手）。
    //   实测：单栏位图已达 2340px > 原扫描图 2144px，靠重渲染放大拿不到任何新细节，
    //   只换来 300-800ms 卡顿（这正是「缩放不流畅」的主因）。
    const sharp = S.viewMode === 'page' ? PAGE_MODE_SHARP : 1;
    let scale = Math.min(fit * sharp * dpr, maxScale);
    // canvas 面积上限：iOS Safari 对 canvas 像素数有硬限制，超了会变空白甚至崩溃
    const pxArea = base.width * scale * base.height * scale;
    if (pxArea > MAX_CANVAS_PIXELS) scale = Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height));
    // ★ 同一页且渲染比例几乎未变 → 跳过重绘。
    //   这是消除「持续闪烁」的关键：手机滚动时地址栏收起/展开会不断触发 resize，
    //   若无条件重绘，每次都会先把 canvas 清成白底再重画，画面就一直在闪。
    if (S.page === n && S.pageRenderScale && Math.abs(scale - S.pageRenderScale) / S.pageRenderScale < 0.004) {
      page.cleanup();
      if (S.resetScroll) { S.resetScroll = false; resetScrollForMode(); }
      applyTransform();
      await drawHighlights();
      return;
    }
    const vp = page.getViewport({ scale });
    const canvas = el.canvas;
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    canvas.style.width = Math.round(vp.width / dpr) + 'px';
    canvas.style.height = Math.round(vp.height / dpr) + 'px';
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvasContext: ctx,
      viewport: vp,
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high',
    }).promise;
    page.cleanup();
    S.page = n;
    S.pageRenderScale = scale;
    S.pageDpr = dpr;
    el.pageInput.value = n;
    // 书内页码：正文从 PDF 第 11 页 = 书内第 1 页（已用页眉 OCR 核对）
    el.pageTotal.textContent = n > 10 ? `/ ${S.doc.numPages} · 书内 ${n - 10}` : `/ ${S.doc.numPages}`;
    if (S.resetScroll) { S.resetScroll = false; resetScrollForMode(); }
    applyTransform();
    await drawHighlights();
  } catch (e) {
    console.error(e);
    toast('渲染失败：' + e.message);
  } finally {
    S.rendering = false;
    if (S.pendingPage != null) {
      const p = S.pendingPage; S.pendingPage = null;
      renderPage(p);
    }
  }
}

/* ============================ 视图变换（缩放/平移） ============================ */
function clampTransform() {
  // 可视尺寸 = 位图 CSS 尺寸 × 视觉倍率（transform: scale 不改变 clientWidth）
  const z = S.zoom;
  const cw = el.canvas.clientWidth * z, ch = el.canvas.clientHeight * z;
  const vw = el.viewer.clientWidth, vh = el.viewer.clientHeight;
  const maxX = Math.max(0, cw - vw), maxY = Math.max(0, ch - vh);
  S.tx = Math.min(0, Math.max(-maxX, S.tx));
  S.ty = Math.min(0, Math.max(-maxY, S.ty));
  if (cw <= vw) S.tx = (vw - cw) / 2;
  if (ch <= vh) S.ty = (vh - ch) / 2;
}
function applyTransform() {
  clampTransform();
  // 合成顺序 = 先 scale 后 translate，作用于内容点 p 得 p*z + t，
  // 故 (tx,ty) 始终是「screen = content × zoom + t」里的 t，下方锚点公式都基于此。
  el.stage.style.transform = `translate3d(${S.tx}px, ${S.ty}px, 0) scale(${S.zoom})`;
}

// 手势里的样式写入统一走 rAF 节流，避免每个 pointermove 都触发一次样式重算
let framePending = false;
function scheduleFrame() {
  if (framePending) return;
  framePending = true;
  requestAnimationFrame(() => { framePending = false; applyTransform(); });
}

// 以视口内某点为锚点缩放：该点下的内容保持不动
function zoomTo(z, ax, ay) {
  z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  const cx = (ax - S.tx) / S.zoom, cy = (ay - S.ty) / S.zoom;
  S.zoom = z;
  S.tx = ax - cx * z;
  S.ty = ay - cy * z;
  applyTransform();
}

let gesture = null;
function initGestures() {
  const v = el.viewer;
  v.addEventListener('pointerdown', (e) => {
    v.setPointerCapture(e.pointerId);
    if (!gesture) gesture = { pointers: new Map(), pinch: null, last: null, moved: false, startTx: 0, startTy: 0 };
    gesture.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture.pointers.size === 1) {
      gesture.last = { x: e.clientX, y: e.clientY };
      gesture.startTx = S.tx; gesture.startTy = S.ty; gesture.moved = false;
      gesture.downAt = Date.now();
    } else if (gesture.pointers.size === 2) {
      // 双指进入：定格捏合基准（中点、双指距离、当前变换），此后完全靠 CSS 缩放
      const [a, b] = [...gesture.pointers.values()];
      const r = v.getBoundingClientRect();
      gesture.pinch = {
        d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        k0: S.zoom,
        t0: { x: S.tx, y: S.ty },
        mid0: { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top },
      };
      gesture.moved = true;
    }
  });
  v.addEventListener('pointermove', (e) => {
    if (!gesture || !gesture.pointers.has(e.pointerId)) return;
    gesture.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture.pointers.size === 1 && gesture.last) {
      const dx = e.clientX - gesture.last.x, dy = e.clientY - gesture.last.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) gesture.moved = true;
      S.tx += dx; S.ty += dy;
      gesture.last = { x: e.clientX, y: e.clientY };
      scheduleFrame();
    } else if (gesture.pointers.size === 2) {
      const [a, b] = [...gesture.pointers.values()];
      const g = gesture.pinch;
      if (!g) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const r = v.getBoundingClientRect();
      const mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
      const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, g.k0 * (dist / g.d0)));
      // 基准中点下的那块内容，必须始终停在（跟着手指移动的）中点下 → 锚点缩放 + 双指平移
      const cx = (g.mid0.x - g.t0.x) / g.k0, cy = (g.mid0.y - g.t0.y) / g.k0;
      S.zoom = z;
      S.tx = mid.x - cx * z;
      S.ty = mid.y - cy * z;
      gesture.moved = true;
      scheduleFrame();
    }
  });
  const end = (e) => {
    if (!gesture) return;
    gesture.pointers.delete(e.pointerId);
    if (gesture.pointers.size === 0) {
      const quick = Date.now() - (gesture.downAt || 0) < 260 && !gesture.moved;
      gesture = null;
      // 松手后不做任何重渲染：没有 300-800ms 等待、没有尺寸跳变（「跟手」的另一半）
      if (quick) onTap(e);
    } else if (gesture.pointers.size === 1) {
      // 双指变单指：退出捏合态，剩下的那根手指接着拖动
      gesture.pinch = null;
      gesture.last = [...gesture.pointers.values()][0];
      gesture.startTx = S.tx; gesture.startTy = S.ty;
    }
  };
  v.addEventListener('pointerup', end);
  v.addEventListener('pointercancel', end);
  v.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = v.getBoundingClientRect();
    zoomTo(S.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  // 双击：锚定点击位置切换两档（原先只改 zoom，缩放中心会漂）
  v.addEventListener('dblclick', (e) => {
    const r = v.getBoundingClientRect();
    zoomTo(S.zoom > 1.6 ? 1 : 2.4, e.clientX - r.left, e.clientY - r.top);
  });
  // 左右滑动翻页（未放大时）
  let swipeX = null;
  v.addEventListener('touchstart', (e) => { if (S.zoom <= 1.02 && S.viewMode === 'page' && e.touches.length === 1) swipeX = e.touches[0].clientX; }, { passive: true });
  v.addEventListener('touchend', (e) => {
    if (swipeX == null || S.zoom > 1.02 || S.viewMode !== 'page') { swipeX = null; return; }
    const dx = (e.changedTouches[0]?.clientX ?? swipeX) - swipeX;
    swipeX = null;
    if (Math.abs(dx) > 60) go(dx < 0 ? S.page + 1 : S.page - 1);
  }, { passive: true });
}

function onTap(e) {
  const r = el.viewer.getBoundingClientRect();
  const x = (e.clientX - r.left - S.tx) / (S.pageDpr || 1);
  const y = (e.clientY - r.top - S.ty) / (S.pageDpr || 1);
  // 未放大时：点击屏幕边缘翻页。单栏模式页面宽于屏幕，热区收窄避免误触
  if (S.zoom <= 1.02) {
    const edge = S.viewMode === 'column' ? 0.12 : 0.25;
    const px = e.clientX - r.left;
    if (px > el.viewer.clientWidth * (1 - edge)) go(S.page + 1);
    else if (px < el.viewer.clientWidth * edge) go(S.page - 1);
  }
  void x; void y;
}

// 需要新位图的只剩三种情况：翻页、切视图模式、屏宽变化。
// 缩放已经不在其中（S.zoom 走 CSS transform），所以这里只保留「渲染后保持视口中心」。
function rerenderKeepingCenter() {
  const vw = el.viewer.clientWidth, vh = el.viewer.clientHeight;
  const z = S.zoom;
  const cx = (vw / 2 - S.tx) / (el.canvas.clientWidth * z || 1);
  const cy = (vh / 2 - S.ty) / (el.canvas.clientHeight * z || 1);
  return renderPage(S.page).then(() => {
    S.tx = vw / 2 - cx * el.canvas.clientWidth * z;
    S.ty = vh / 2 - cy * el.canvas.clientHeight * z;
    applyTransform();
  });
}

function go(n) {
  n = Math.min(Math.max(1, n), S.doc ? S.doc.numPages : TOTAL_PAGES);
  if (n === S.page) return;
  S.zoom = 1;
  S.resetScroll = true;
  renderPage(n);
  clearHighlights();
}

function setViewMode(mode) {
  S.viewMode = mode;
  S.zoom = 1;
  S.resetScroll = true;
  updateViewBtn();
  renderPage(S.page);
}

function updateViewBtn() {
  const b = $('btn-view');
  if (!b) return;
  b.textContent = S.viewMode === 'column' ? '▯' : '▭';
  b.title = S.viewMode === 'column' ? '单栏阅读（点击切整页）' : '整页视图（点击切单栏）';
  b.setAttribute('aria-label', b.title);
}

/* ============================ 高亮 ============================ */
function clearHighlights() { el.hlLayer.innerHTML = ''; }

async function drawHighlights() {
  clearHighlights();
  if (!S.highlight || !S.hlQuery) return;
  const pg = await loadPageWords(S.page);
  if (!pg) return;
  const q = S.hlQuery;
  const isAr = hasArabic(q);
  // 中文查询用中文 OCR 的坐标；阿语查询用阿语 OCR 的坐标（两次渲染 scale 不同）
  const src = isAr ? pg.ar : pg.cn;
  if (!src || !src.w) return;
  const nq = isAr ? normAr(q) : q;
  const sk = isAr ? skeleton(q) : '';
  const qc = q.replace(/\s+/g, '');
  const cssW = el.canvas.width / (S.pageDpr || 1);
  const ratio = cssW / src.w;
  const frag = document.createDocumentFragment();
  const paint = (b) => {
    const d = document.createElement('div');
    d.className = 'hl';
    d.style.left = (b.x * ratio) + 'px';
    d.style.top = (b.y * ratio) + 'px';
    d.style.width = (b.w * ratio) + 'px';
    d.style.height = (b.h * ratio) + 'px';
    frag.appendChild(d);
  };
  const matches = (t) => {
    if (!t) return false;
    if (isAr) return normAr(t).includes(nq) || (sk.length >= 3 && skeleton(t).includes(sk));
    return t.includes(q) || (qc.length >= 2 && t.replace(/\s+/g, '').includes(qc));
  };
  // 1) 词级
  let hit = 0;
  for (const w of (src.words || [])) {
    if (!matches(w.t)) continue;
    paint(w); hit++;
    if (hit > 300) break;
  }
  // 2) 词级零命中 → 行级回退
  if (hit === 0) {
    for (const ln of (src.lines || [])) {
      if (!matches(ln.t)) continue;
      paint(ln); hit++;
      if (hit > 120) break;
    }
  }
  el.hlLayer.appendChild(frag);
  return hit;
}

async function loadPageWords(p) {
  if (S.hlWords.has(p)) return S.hlWords.get(p);
  try {
    const r = await fetch(`./data/ocr/pages/p${String(p).padStart(4, '0')}.json`);
    if (!r.ok) return null;
    const j = await r.json();
    const pack = (s) => s ? { w: s.w, h: s.h, words: (s.words || []).filter((x) => (x.c ?? 0) >= 30), lines: s.lines || [] } : null;
    const pg = { page: j.page, cn: pack(j.cn), ar: pack(j.ar) };
    S.hlWords.set(p, pg);
    return pg;
  } catch { return null; }
}

/* ============================ 索引与搜索 ============================ */
async function loadIndex() {
  // 词根表很小（秒开）→ 阿语检索立即可用；页文本较大 → 后台异步加载
  try {
    const r = await fetch('./data/roots.json');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    S.index = { roots: j.roots || [], pages: [] };
    el.engineStatus.textContent = `词根索引就绪 · ${S.index.roots.length} 条（中文索引后台加载中…）`;
  } catch (e) {
    console.warn('词根索引加载失败', e);
    S.index = { roots: [], pages: [] };
    toast('索引加载失败：' + e.message);
  }
  loadPagesIndex();
}

async function loadPagesIndex() {
  try {
    const t0 = performance.now();
    const r = await fetch('./data/pages.json');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    S.index.pages = j.pages || [];
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    el.engineStatus.textContent = `索引就绪 · ${S.index.roots.length} 词根 / ${S.index.pages.length} 页文本`;
    S.pagesReady = true;
    toast(`中文检索索引已就绪（${S.index.pages.length} 页 · ${secs}s）`, 1800);
  } catch (e) {
    console.warn('页文本索引加载失败', e);
    toast('中文索引加载失败，阿语检索仍可用');
  }
  // 阿语 OCR 词形索引（后台加载，用于「该词形出现在哪些页」）
  try {
    const r = await fetch('./data/ar-index.json');
    if (r.ok) {
      const j = await r.json();
      S.arIndex = j.pages || [];
      console.log('阿语词形索引:', S.arIndex.length, '页');
    }
  } catch (e) { console.warn('阿语索引加载失败', e); }
}

function snippet(text, at, len) {
  const a = Math.max(0, at - 18), b = Math.min(text.length, at + len + 22);
  return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ') + (b < text.length ? '…' : '');
}

function searchArabic(q) {
  const out = [];
  const nq = normAr(q);
  if (!nq) return out;
  const sk = skeleton(q);
  const roots = S.index.roots || [];
  const seen = new Set();
  const push = (r, kind, score) => {
    const key = r.p + '|' + r.t;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ type: 'ar', page: r.p, root: r.t, kind, score, snippet: '' });
  };
  for (const r of roots) {
    const c = r.k;                       // 紧凑词根
    if (c === nq) push(r, '精确', 100);
    else if (c.startsWith(nq) && nq.length >= 2) push(r, '前缀', 80 - c.length);
    else if (nq.startsWith(c) && c.length >= 3) push(r, '包含', 60 - c.length);
  }
  if (sk.length >= 3) {
    for (const r of roots) {
      if (seen.has(r.p + '|' + r.t)) continue;
      const cs = skeleton(r.k);
      if (cs.length < 3) continue;
      let score = 0;
      if (cs === sk) score = 90;
      else if (cs.startsWith(sk)) score = 78 - Math.abs(cs.length - sk.length);
      else if (sk.startsWith(cs)) score = 70 - Math.abs(cs.length - sk.length);
      else if (sk.includes(cs)) score = 55 - Math.abs(cs.length - sk.length);
      else if (cs.includes(sk)) score = 48 - Math.abs(cs.length - sk.length);
      if (score > 0) push(r, '词根', score);
    }
  }
  // 阿语 OCR 词形索引：区分「精确词形」与「含该词根」，精确优先且部分匹配限量
  if (sk.length >= 3 && S.arIndex && S.arIndex.length) {
    const pagesIn = new Set(out.map((x) => x.page));
    const exact = [], partial = [];
    for (const p of S.arIndex) {
      if (pagesIn.has(p.p)) continue;
      let isExact = false, isPartial = false;
      for (const w of p.ws) {
        if (w === sk) { isExact = true; break; }
        if (w.length >= 4 && w.includes(sk)) isPartial = true;
        else if (sk.length >= 4 && sk.includes(w)) isPartial = true;
      }
      if (isExact) exact.push(p.p);
      else if (isPartial) partial.push(p.p);
    }
    for (const pg of exact.slice(0, 60)) out.push({ type: 'ar', page: pg, root: q, kind: '词形', score: 52, snippet: '' });
    for (const pg of partial.slice(0, 40)) out.push({ type: 'ar', page: pg, root: q, kind: '含词根', score: 22, snippet: '' });
  }
  return out.sort((a, b) => b.score - a.score || a.page - b.page).slice(0, 120);
}

// 紧凑索引位置 → 原文本位置（OCR 常在词内插入空格）
function mapCompactToRaw(t, ci) {
  let cnt = -1;
  for (let j = 0; j < t.length; j++) {
    if (!/\s/.test(t[j])) cnt++;
    if (cnt === ci) return j;
  }
  return 0;
}

function searchChinese(q) {
  const out = [];
  const qc = (q || '').replace(/\s+/g, '');
  if (!qc) return out;
  for (const p of (S.index.pages || [])) {
    const tc = p.tc || p.t.replace(/\s+/g, '');
    const i = tc.indexOf(qc);
    if (i < 0) continue;
    // 统计出现次数，多提及者优先
    let n = 0, k = 0;
    while ((k = tc.indexOf(qc, k)) >= 0) { n++; k += qc.length; if (n > 20) break; }
    const at = mapCompactToRaw(p.t, i);
    out.push({ type: 'cn', page: p.p, kind: n > 1 ? `×${n}` : '', snippet: snippet(p.t, at, q.length), score: n * 12 + (p.c || 0) / 20 - i / 5000 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 200);
}

function runSearch() {
  const q = el.search.value.trim();
  el.clear.hidden = !q;
  if (!q) { el.results.hidden = true; clearHighlights(); S.hlQuery = ''; return; }
  if (!S.index) { toast('索引尚未加载'); return; }

  let items = [];
  let title = '';
  const cnReady = (S.index.pages || []).length > 0;
  if (hasArabic(q)) {
    items = searchArabic(q);
    title = `阿拉伯语「${q}」· ${items.length} 条词根`;
    if (!items.length && hasCJK(q)) { items = searchChinese(q); title = `中文「${q}」· ${items.length} 页`; }
  } else if (hasCJK(q)) {
    if (!cnReady) toast('中文检索索引仍在后台加载，请稍候几秒…', 2600);
    items = searchChinese(q);
    title = `中文「${q}」· ${items.length} 页${cnReady ? '' : '（索引加载中，结果可能不全）'}`;
  } else {
    items = searchChinese(q);
    title = `「${q}」· ${items.length} 页`;
  }
  S.hlQuery = q;
  renderResults(items, title, q);
  scheduleHistory(q, items.length);
}

function renderResults(items, title, q) {
  el.resultsTitle.textContent = title;
  el.results.hidden = false;
  el.resultsList.innerHTML = '';
  if (!items.length) {
    el.resultsList.innerHTML = '<div class="res-item"><div class="muted">没有匹配结果。可尝试：去掉阿语前缀/后缀，或改用中文关键词。</div></div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of items) {
    const d = document.createElement('div');
    d.className = 'res-item';
    const head = document.createElement('div');
    head.className = 'res-head';
    const label = it.root || (it.type === 'cn' ? '中文释义' : '');
    if (label) {
      const r = document.createElement('div');
      r.className = 'res-root' + (it.root ? ' ar' : '');
      r.textContent = label;
      head.appendChild(r);
    }
    if (it.kind) {
      const b = document.createElement('span');
      b.className = 'res-badge';
      b.textContent = it.kind;
      head.appendChild(b);
    }
    const pg = document.createElement('span');
    pg.className = 'res-page';
    pg.textContent = `PDF ${it.page} 页`;
    head.appendChild(pg);
    // 收藏到生词本（点星标不触发跳页）
    const st = document.createElement('button');
    const saved = hasWord(q, it.page);
    st.className = 'star-btn' + (saved ? ' on' : '');
    st.textContent = saved ? '★' : '☆';
    st.setAttribute('aria-label', '收藏到生词本');
    st.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const on = toggleWord(q, it.page, it.root || '');
      st.classList.toggle('on', on);
      st.textContent = on ? '★' : '☆';
      toast(on ? '已加入生词本' : '已从生词本移除', 1400);
    });
    head.appendChild(st);
    d.appendChild(head);
    if (it.snippet) {
      const sn = document.createElement('div');
      sn.className = 'res-snippet';
      const at = it.snippet.indexOf(q);
      if (at >= 0) {
        sn.append(it.snippet.slice(0, at));
        const m = document.createElement('mark');
        m.textContent = q;
        sn.appendChild(m);
        sn.append(it.snippet.slice(at + q.length));
      } else sn.textContent = it.snippet;
      d.appendChild(sn);
    }
    // 词条级展开（实验性）：中文查询时，展示命中行「纵向邻近」的阿语词，供对照原图。
    // 实测结论：现有 OCR 质量（中文约 59 / 阿语 38–46）下只能做辅助对齐，
    // 不足以给出权威词条对应关系 —— 真正的词条级聚合需要先升级 OCR 引擎。
    if (hasCJK(q)) {
      const exp = document.createElement('button');
      exp.className = 'exp-btn';
      exp.textContent = '▸ 邻近阿语词';
      const box = document.createElement('div');
      box.className = 'entry-box';
      box.hidden = true;
      let loaded = false;
      exp.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!loaded) {
          loaded = true;
          box.innerHTML = '<div class="muted">正在按词条切分…</div>';
          box.hidden = false;
          exp.textContent = '▾ 收起';
          try {
            const list = await entriesForPage(it.page, q);
            box.innerHTML = '';
            if (!list.length) {
              box.innerHTML = '<div class="muted">该页未切出配对（版面噪声，或命中落在页眉页脚）。</div>';
            } else {
              for (const e of list) {
                const row = document.createElement('div');
                row.className = 'entry';
                const ar = document.createElement('span');
                ar.className = 'e-ar ar';
                ar.textContent = e.ar || '—';
                const cn = document.createElement('span');
                cn.className = 'e-cn';
                cn.textContent = e.cn;
                row.appendChild(ar);
                row.appendChild(cn);
                if (e.conf) {
                  const c = document.createElement('span');
                  c.className = 'e-conf';
                  c.textContent = 'OCR ' + e.conf;
                  row.appendChild(c);
                }
                row.addEventListener('click', (e2) => {
                  e2.stopPropagation();
                  el.results.hidden = true;
                  go(it.page);
                  setTimeout(() => drawHighlights(), 700);
                });
                box.appendChild(row);
              }
            }
          } catch {
            box.innerHTML = '<div class="muted">词条加载失败</div>';
          }
          return;
        }
        box.hidden = !box.hidden;
        exp.textContent = box.hidden ? '▸ 邻近阿语词' : '▾ 收起';
      });
      d.appendChild(exp);
      d.appendChild(box);
    }
    d.addEventListener('click', () => {
      el.results.hidden = true;
      pushHistory(q);
      go(it.page);
      setTimeout(() => drawHighlights(), 700);
    });
    frag.appendChild(d);
  }
  el.resultsList.appendChild(frag);
}

/* ---- 词条级展开：把「页命中」细化为「词条命中」 ---- */
// 版面规律：双栏 RTL 下，同一水平线上阿语词条与其中文释义成对出现。
// 因此可用 y 坐标把中文命中行与阿语词配对，还原出「阿语词 + 中文释义」。
// 局限：受 OCR 质量限制（中文约 59 / 阿语 38–46），释义可能含噪声，最终以原页为准。
// 至少两个阿语字母才算词（滤掉页码、标点等 OCR 噪声）
const AR_WORD_RE = /[ء-ي]{2,}/;

async function entriesForPage(page, q) {
  const j = await loadPageWords(page);
  const arW = (j && j.ar && j.ar.words) || [];
  const cnL = (j && j.cn && j.cn.lines) || [];
  const cnW = (j && j.cn && j.cn.words) || [];
  const hits = [];
  // 优先行级（整行更可读），退化到词级
  for (const l of cnL) if (l.t && l.t.indexOf(q) >= 0) hits.push({ t: l.t, y: l.y, h: l.h || 30 });
  if (!hits.length) {
    for (const w of cnW) if (w.t && w.t.indexOf(q) >= 0) hits.push({ t: w.t, y: w.y, h: w.h || 30 });
  }
  const out = [];
  for (const h of hits) {
    const cy = h.y + h.h / 2;
    // 容差收到 36px（约一个词条行高）+ 按纵向距离取最近 3 个 + 过滤非阿语噪声：
    // 早先用 70px 容差会把整栏阿语词都捞进来，实测不可用。
    const near = arW
      .map((w) => ({ w, d: Math.abs(w.y + (w.h || 30) / 2 - cy) }))
      .filter((x) => x.d < 36 && AR_WORD_RE.test(x.w.t))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .map((x) => x.w);
    const conf = near.length ? Math.round(near.reduce((s, w) => s + (w.c || 0), 0) / near.length) : 0;
    out.push({ cn: h.t, ar: near.map((w) => w.t).join(' · '), conf, page });
  }
  return out.slice(0, 12);
}

/* ============================ 词根目录树 ============================ */
async function loadOutline() {
  try {
    const r = await fetch('./data/outline.json');
    S.outline = await r.json();
  } catch { S.outline = []; }
}

// 过滤：只保留命中节点及其祖先路径
function filterTree(list, f) {
  if (!f) return list;
  const nf = normAr(f);
  const out = [];
  for (const n of list) {
    const title = n.title || '';
    const selfMatch = title.includes(f) || (nf && normAr(title).includes(nf));
    const kids = filterTree(n.children || [], f);
    if (selfMatch || kids.length) out.push({ ...n, children: kids });
  }
  return out;
}

function renderTree(filter = '') {
  const f = filter.trim();
  el.tree.innerHTML = '';
  const frag = document.createDocumentFragment();
  const build = (node, depth) => {
    const wrap = document.createElement('div');
    // 无过滤时全部折叠（30 个字母 + 547 组合太长）；有过滤时全部展开直达命中项
    wrap.className = 'tnode' + (f ? '' : ' collapsed');
    const row = document.createElement('div');
    row.className = 'trow lvl' + Math.min(depth, 2);
    const caret = document.createElement('span');
    caret.className = 'tcaret';
    caret.textContent = (node.children && node.children.length) ? '▼' : '';
    row.appendChild(caret);
    const w = document.createElement('span');
    w.className = 'tw ar';
    w.textContent = (node.title || '').trim();
    row.appendChild(w);
    const p = document.createElement('span');
    p.className = 'tp';
    p.textContent = node.page ? node.page : '';
    row.appendChild(p);
    wrap.appendChild(row);
    if (node.children && node.children.length) {
      const kids = document.createElement('div');
      kids.className = 'tchildren';
      for (const c of node.children) kids.appendChild(build(c, depth + 1));
      wrap.appendChild(kids);
    }
    row.addEventListener('click', (e) => {
      if (e.target === caret && node.children?.length) { wrap.classList.toggle('collapsed'); return; }
      if (node.children?.length) wrap.classList.toggle('collapsed');
      if (node.page) { closeDrawer(); go(node.page); }
    });
    return wrap;
  };
  const tree = filterTree(S.outline || [], f);
  for (const n of tree) frag.appendChild(build(n, 0));
  el.tree.appendChild(frag);
  if (f && !tree.length) el.tree.innerHTML = '<div class="trow"><span class="tw">无匹配词根</span></div>';
}

function openDrawer() { el.drawer.hidden = false; el.scrim.hidden = false; requestAnimationFrame(() => el.drawer.classList.add('open')); }
function closeDrawer() { el.drawer.classList.remove('open'); el.scrim.hidden = true; setTimeout(() => { el.drawer.hidden = true; }, 220); }

/* ============================ 离线缓存 ============================ */
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  // 浏览器只允许「安全上下文」注册 Service Worker：HTTPS 或 localhost。
  // 手机通过局域网 IP + HTTP 访问时不是安全上下文 → 离线缓存不可用（页面其余功能正常）。
  if (!window.isSecureContext) {
    S.insecure = true;
    console.warn('非安全上下文（HTTP + 局域网 IP）：Service Worker / Cache Storage 不可用，离线缓存已停用');
    return;
  }
  try { await navigator.serviceWorker.register('./sw.js'); } catch (e) { console.warn('SW 注册失败', e); }
}

async function cachePdf() {
  if (!window.isSecureContext) {
    toast('离线缓存需要 HTTPS 访问。当前是 HTTP 局域网地址，浏览器不允许缓存，详见「⋯ 设置」里的说明', 5000);
    return;
  }
  if (!('caches' in window)) { toast('浏览器不支持缓存'); return; }

  const btn = $('btn-cache-pdf');
  const setStatus = (t) => { if (el.cacheStatus) el.cacheStatus.textContent = t; };
  const setBtn = (t, dis) => { if (btn) { btn.textContent = t; btn.disabled = !!dis; } };

  try {
    // ① 申请持久化存储：否则浏览器在存储紧张时会自动清理缓存，
    //    表现就是「某天离线缓存突然没了」。这一步是可靠性的关键。
    let persisted = false;
    try {
      if (navigator.storage && navigator.storage.persist) persisted = await navigator.storage.persist();
    } catch { /* 不支持则不阻断 */ }

    // ② 配额预检：空间不足时提前告知，而不是下载到一半失败
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        const free = (est.quota || 0) - (est.usage || 0);
        if (free > 0 && free < 140 * 1048576) {
          toast('存储空间可能不足：剩余 ' + (free / 1048576).toFixed(0) + ' MB，本操作需要约 86 MB', 6000);
        }
      }
    } catch { /* ignore */ }

    setBtn('缓存中…', true);
    setStatus('正在缓存… 0%');
    toast('开始缓存 PDF（85 MB），请保持页面打开', 4000);

    // ③ 流式下载 + 实时进度：用 ReadableStream 边读边转发，
    //    既能看到进度，又不会把 85MB 全读进 JS 内存。
    const resp = await fetch(PDF_URL);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const total = Number(resp.headers.get('content-length') || 0);
    let got = 0;
    let shown = -1;
    const src = resp.body.getReader();
    const stream = new ReadableStream({
      async pull(controller) {
        const { value, done } = await src.read();
        if (done) { controller.close(); return; }
        got += value.byteLength;
        if (total) {
          const pct = Math.floor((got / total) * 100);
          const step = pct - (pct % 5);
          if (step > shown) {
            shown = step;
            setStatus('正在缓存… ' + step + '%（' + (got / 1048576).toFixed(0) + ' / ' + (total / 1048576).toFixed(0) + ' MB）');
          }
        }
        controller.enqueue(value);
      },
      cancel() { try { src.cancel(); } catch { /* ignore */ } },
    });

    const cache = await caches.open('ahdict-pdf-v1');
    await cache.put(PDF_URL, new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(total || got),
        'Accept-Ranges': 'bytes',
      },
    }));

    // ④ 缓存后校验：确认存入的是完整文件。
    //    若 content-length 缺失，离线时的 Range 切片会失效（退回返回完整文件）。
    const hit = await cache.match(PDF_URL, { ignoreSearch: true });
    const stored = hit ? Number(hit.headers.get('content-length') || 0) : 0;
    if (!stored || (total && stored !== total)) throw new Error('缓存校验失败（' + stored + ' / ' + total + '）');

    setStatus('已缓存整本 PDF（' + (stored / 1048576).toFixed(1) + ' MB）' + (persisted ? ' · 已申请持久化存储' : ' · 建议「添加到主屏幕」以防被浏览器清理'));
    setBtn('重新缓存', false);
    toast('PDF 已缓存（' + (stored / 1048576).toFixed(0) + ' MB），断网也能查词', 4000);
  } catch (e) {
    setStatus('缓存失败：' + e.message);
    setBtn('重试缓存', false);
    toast('缓存失败：' + e.message + '（可点「重试缓存」）', 6000);
  }
}
async function checkCache() {
  const note = $('secure-note');
  const btn = $('btn-cache-pdf');
  if (!window.isSecureContext) {
    el.cacheStatus.textContent = '当前 HTTP 访问：离线缓存不可用（需 HTTPS 或 localhost）';
    if (btn) { btn.disabled = true; btn.textContent = '需要 HTTPS'; }
    if (note) {
      note.textContent = '浏览器规定：只有 HTTPS 或 localhost 才允许 Service Worker 与离线缓存。'
        + '现在通过局域网 IP（HTTP）访问，因此「离线缓存」与「安装为独立 App」不可用，但查词、阅读、检索全部正常。'
        + '想要离线使用，见 README 的「手机离线方案」。';
    }
    return;
  }
  if (btn) { btn.disabled = false; btn.textContent = '开始缓存'; }
  if (note) note.textContent = '当前为安全上下文，可离线缓存。';
  if (!('caches' in window)) return;
  const cache = await caches.open('ahdict-pdf-v1');
  const k = await cache.keys();
  el.cacheStatus.textContent = k.length ? '已缓存整本 PDF（离线可读）' : '未缓存（在线读取 PDF）';
}

/* ============================ 用户数据：生词本 / 搜索历史 ============================ */
// 数据量小（历史 ≤ 300 条、生词本通常几百条），localStorage 足够，无需 IndexedDB。
// 300 条历史约 18KB，离 5MB 配额很远，上限只是防止无限增长。
const LS_KEY = "ahdict.user.v1";
const HISTORY_MAX = 300;
const HISTORY_Q_MAX = 120;   // 单条查询长度上限，防止异常长文本撑爆存储

function loadUser() {
  try {
    const j = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    S.words = Array.isArray(j.words) ? j.words : [];
    S.history = Array.isArray(j.history) ? j.history : [];
  } catch {
    S.words = [];
    S.history = [];
  }
}

function saveUser() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ words: S.words, history: S.history }));
  } catch {
    toast("本地保存失败（可能处于隐私模式或空间已满）", 3000);
  }
}

function updateCounts() {
  const cw = $("cnt-words");
  const ch = $("cnt-history");
  if (cw) cw.textContent = S.words.length;
  if (ch) ch.textContent = S.history.length;
}

function fmtTime(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/* ---- 搜索历史 ---- */
// 输入停止 1.8s 后把「稳定查询」记入历史：手机用户通常不按回车，
// 若只在 Enter 时记录，历史等于失效；而逐字记录又会塞满无意义前缀。
let _histTimer = null;
function scheduleHistory(q, n) {
  if (!q || !n) return;
  clearTimeout(_histTimer);
  _histTimer = setTimeout(() => {
    pushHistory(q);
    if (S.tab === 'history') renderHistory();
  }, 1800);
}

function pushHistory(q) {
  q = (q || "").trim().slice(0, HISTORY_Q_MAX);
  if (!q) return;
  S.history = S.history.filter((h) => h.q !== q);
  S.history.unshift({ q, at: Date.now() });
  if (S.history.length > HISTORY_MAX) S.history.length = HISTORY_MAX;
  saveUser();
  updateCounts();
  if (S.tab === "history") renderHistory();
}

function renderHistory() {
  const box = $("history-list");
  if (!box) return;
  box.innerHTML = "";
  if (!S.history.length) {
    box.innerHTML = "<div class=\"res-item\"><div class=\"muted\">还没有搜索记录。搜到结果后会自动记下（最多保留 " + HISTORY_MAX + " 条）。</div></div>";
    return;
  }
  const frag = document.createDocumentFragment();
  for (const h of S.history) {
    const d = document.createElement("div");
    d.className = "res-item";
    const head = document.createElement("div");
    head.className = "res-head";
    const t = document.createElement("div");
    t.className = "res-root" + (hasArabic(h.q) ? " ar" : "");
    t.textContent = h.q;
    head.appendChild(t);
    const tm = document.createElement("span");
    tm.className = "res-page";
    tm.textContent = fmtTime(h.at);
    head.appendChild(tm);
    const del = document.createElement("button");
    del.className = "row-del";
    del.textContent = "✕";
    del.setAttribute("aria-label", "删除这条记录");
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      S.history = S.history.filter((x) => x.q !== h.q);
      saveUser();
      renderHistory();
      updateCounts();
    });
    head.appendChild(del);
    d.appendChild(head);
    d.addEventListener("click", () => {
      closeDrawer();
      el.search.value = h.q;
      el.clear.hidden = false;
      runSearch();
    });
    frag.appendChild(d);
  }
  box.appendChild(frag);
}

/* ---- 生词本 ---- */
function wordKey(q, page) { return q + "|" + page; }
function hasWord(q, page) { return S.words.some((w) => w.key === wordKey(q, page)); }

function toggleWord(q, page, root) {
  const key = wordKey(q, page);
  const i = S.words.findIndex((w) => w.key === key);
  if (i >= 0) {
    S.words.splice(i, 1);
    saveUser();
    updateCounts();
    renderWords();
    return false;
  }
  S.words.unshift({ key, q, page, root: root || "", at: Date.now() });
  saveUser();
  updateCounts();
  renderWords();
  return true;
}

function renderWords() {
  const box = $("words-list");
  if (!box) return;
  box.innerHTML = "";
  if (!S.words.length) {
    box.innerHTML = "<div class=\"res-item\"><div class=\"muted\">生词本还是空的。搜索后在结果条目右侧点 ☆ 即可收藏；收藏后可在这里跳回原页。</div></div>";
    return;
  }
  const frag = document.createDocumentFragment();
  for (const w of S.words) {
    const d = document.createElement("div");
    d.className = "res-item";
    const head = document.createElement("div");
    head.className = "res-head";
    const t = document.createElement("div");
    t.className = "res-root" + (hasArabic(w.q) ? " ar" : "");
    t.textContent = w.q;
    head.appendChild(t);
    if (w.root) {
      const b = document.createElement("span");
      b.className = "res-badge";
      b.textContent = w.root;
      head.appendChild(b);
    }
    const pg = document.createElement("span");
    pg.className = "res-page";
    pg.textContent = "PDF " + w.page + " 页";
    head.appendChild(pg);
    const del = document.createElement("button");
    del.className = "row-del";
    del.textContent = "✕";
    del.setAttribute("aria-label", "从生词本移除");
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      S.words = S.words.filter((x) => x.key !== w.key);
      saveUser();
      renderWords();
      updateCounts();
      toast("已从生词本移除", 1400);
    });
    head.appendChild(del);
    d.appendChild(head);
    d.addEventListener("click", () => {
      closeDrawer();
      go(w.page);
      setTimeout(() => drawHighlights(), 700);
    });
    frag.appendChild(d);
  }
  box.appendChild(frag);
}

function exportWords() {
  if (!S.words.length) { toast("生词本为空"); return; }
  const L = ["# 新编阿汉大词典 · 生词本", "", "导出时间：" + new Date().toLocaleString("zh-CN"), "共 " + S.words.length + " 条", ""];
  for (const w of S.words) {
    const inBook = Math.max(1, (w.page || 0) - 10);
    L.push("- **" + w.q + "**" + (w.root ? "（词根 " + w.root + "）" : "") + " → PDF p" + w.page + " · 书内 " + inBook);
  }
  L.push("");
  const blob = new Blob([L.join("\n")], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "阿汉词典生词本.md";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast("已导出 " + S.words.length + " 条");
}

/* ---- 抽屉 tab 切换 ---- */
function switchTab(name) {
  S.tab = name;
  for (const b of document.querySelectorAll(".dtab")) b.classList.toggle("active", b.dataset.tab === name);
  const panes = { tree: "pane-tree", words: "pane-words", history: "pane-history" };
  for (const k of Object.keys(panes)) $(panes[k]).hidden = k !== name;
  if (name === "words") renderWords();
  if (name === "history") renderHistory();
}

/* ---- 阿拉伯语软键盘 ---- */
// 手机系统键盘通常打不出阿拉伯语，这是手机端查词的主要障碍
const AR_ROWS = [
  ["ض", "ص", "ث", "ق", "ف", "غ", "ع", "ه", "خ", "ح", "ج"],
  ["ش", "س", "ي", "ب", "ل", "ا", "ت", "ن", "م", "ك", "ط"],
  ["ئ", "ء", "ؤ", "ر", "ى", "ة", "و", "ز", "ظ", "ذ", "د"],
  ["أ", "إ", "آ", "لا", "空格", "⌫", "清空"],
];

function renderArkb() {
  const box = $("arkb-keys");
  if (!box || box.dataset.built) return;
  const frag = document.createDocumentFragment();
  for (const row of AR_ROWS) {
    const r = document.createElement("div");
    r.className = "arkb-row";
    for (const k of row) {
      const b = document.createElement("button");
      b.className = "arkb-key";
      if (k === "空格") { b.classList.add("wide", "fn"); b.textContent = "空格"; }
      else if (k === "⌫") { b.classList.add("wide", "fn"); b.textContent = "⌫"; }
      else if (k === "清空") { b.classList.add("wide", "fn"); b.textContent = "清空"; }
      else b.textContent = k;
      b.addEventListener("click", () => onArKey(k));
      r.appendChild(b);
    }
    frag.appendChild(r);
  }
  box.appendChild(frag);
  box.dataset.built = "1";
}

// 插入到搜索框光标处；backspace=true 时删一个字符
function insertToSearch(text, backspace) {
  const inp = el.search;
  const s = inp.selectionStart ?? inp.value.length;
  const e = inp.selectionEnd ?? inp.value.length;
  if (backspace) {
    if (s === e && s > 0) inp.value = inp.value.slice(0, s - 1) + inp.value.slice(s);
    else inp.value = inp.value.slice(0, s) + inp.value.slice(e);
  } else {
    inp.value = inp.value.slice(0, s) + text + inp.value.slice(e);
  }
  const pos = backspace ? Math.max(0, s - 1) : s + text.length;
  el.clear.hidden = !inp.value;
  inp.focus();
  try { inp.setSelectionRange(pos, pos); } catch { /* ignore */ }
  clearTimeout(S._searchT);
  S._searchT = setTimeout(runSearch, 260);
}

function onArKey(k) {
  if (k === "⌫") return insertToSearch("", true);
  if (k === "清空") {
    el.search.value = "";
    el.clear.hidden = true;
    el.results.hidden = true;
    S.hlQuery = "";
    clearHighlights();
    return;
  }
  insertToSearch(k === "空格" ? " " : k);
}

function setArkb(on) {
  renderArkb();
  el.arkb.hidden = !on;
  const b = $("btn-arkb");
  if (b) b.classList.toggle("on", on);
  if (on) el.search.focus();
}

function toggleArkb() { setArkb(el.arkb.hidden); }

/* ============================ 事件绑定 ============================ */
function bind() {
  el.search.addEventListener('input', () => { el.clear.hidden = !el.search.value; clearTimeout(bind._t); bind._t = setTimeout(runSearch, 260); });
  el.search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); pushHistory(el.search.value); el.search.blur(); } });
  el.clear.addEventListener('click', () => { el.search.value = ''; el.clear.hidden = true; el.results.hidden = true; S.hlQuery = ''; clearHighlights(); });
  $('btn-close-results').addEventListener('click', () => { el.results.hidden = true; });
  $('btn-menu').addEventListener('click', openDrawer);
  $('btn-close-drawer').addEventListener('click', closeDrawer);
  el.scrim.addEventListener('click', closeDrawer);
  el.treeSearch.addEventListener('input', () => renderTree(el.treeSearch.value));
  $('btn-more').addEventListener('click', () => { el.settings.hidden = false; el.scrim.hidden = false; checkCache(); });
  $('btn-close-settings').addEventListener('click', () => { el.settings.hidden = true; el.scrim.hidden = true; });
  $('btn-prev').addEventListener('click', () => go(S.page - 1));
  $('btn-next').addEventListener('click', () => go(S.page + 1));
  el.pageInput.addEventListener('change', () => go(parseInt(el.pageInput.value, 10) || 1));
  // 按钮以视口中心为锚点缩放（手指够不到的地方交给捏合与双击）
  $('btn-zoom-in').addEventListener('click', () => zoomTo(S.zoom * 1.35, el.viewer.clientWidth / 2, el.viewer.clientHeight / 2));
  $('btn-zoom-out').addEventListener('click', () => zoomTo(S.zoom / 1.35, el.viewer.clientWidth / 2, el.viewer.clientHeight / 2));
  $('btn-view').addEventListener('click', () => setViewMode(S.viewMode === 'column' ? 'page' : 'column'));
  $('btn-cache-pdf').addEventListener('click', cachePdf);
  $('btn-open-file').addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', async () => {
    const f = el.fileInput.files?.[0];
    if (!f) return;
    if (S.objectUrl) URL.revokeObjectURL(S.objectUrl);
    S.objectUrl = URL.createObjectURL(f);
    el.settings.hidden = true; el.scrim.hidden = true;
    S.hlWords.clear();
    await loadDoc(S.objectUrl);
    toast('已打开本地 PDF：' + f.name);
  });
  $('opt-rtl').addEventListener('change', (e) => { S.rtlNormalize = e.target.checked; });
  $('opt-hl').addEventListener('change', (e) => { S.highlight = e.target.checked; if (!e.target.checked) clearHighlights(); else drawHighlights(); });
  // B：抽屉 tab / 生词本 / 历史 / 阿语键盘
  for (const b of document.querySelectorAll('.dtab')) b.addEventListener('click', () => switchTab(b.dataset.tab));
  $('btn-export-words').addEventListener('click', exportWords);
  $('btn-clear-words').addEventListener('click', () => {
    if (!S.words.length) { toast('生词本已是空的'); return; }
    if (confirm('清空生词本？共 ' + S.words.length + ' 条，此操作不可撤销。')) {
      S.words = []; saveUser(); renderWords(); updateCounts(); toast('生词本已清空');
    }
  });
  $('btn-clear-history').addEventListener('click', () => {
    if (!S.history.length) { toast('历史已是空的'); return; }
    S.history = []; saveUser(); renderHistory(); updateCounts(); toast('历史已清空');
  });
  $('btn-arkb').addEventListener('click', toggleArkb);
  $('btn-close-arkb').addEventListener('click', () => setArkb(false));
  // 视口变化处理：只有「宽度」真正变化才需要重绘。
  // 手机滚动时地址栏收起/展开会持续改变视口高度，若也跟着重绘就会一直闪。
  let vpW = 0, vpResizeTimer = null;
  function onViewportResize() {
    const w = el.viewer.clientWidth;
    if (vpW === 0) { vpW = w; return; }
    if (w === vpW) { applyTransform(); return; }   // 仅高度变化 → 只重算平移
    vpW = w;
    clearTimeout(vpResizeTimer);
    vpResizeTimer = setTimeout(() => { applyTransform(); rerenderKeepingCenter(); }, 300);
  }
  window.addEventListener('resize', onViewportResize);
  window.addEventListener('orientationchange', () => setTimeout(onViewportResize, 350));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onViewportResize);
  document.addEventListener('keydown', (e) => {
    if (document.activeElement === el.search || document.activeElement === el.pageInput) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') go(S.page + 1);
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(S.page - 1);
    if (e.key === '/') { e.preventDefault(); el.search.focus(); }
  });
  // 目录树点击跳页后高亮当前词根
}

/* ============================ 启动 ============================ */
// 诊断上报：URL 带 ?diag=1 时，把首屏状态 POST 回服务器（便于远程排查真机问题）
async function reportDiag(extra = {}) {
  if (!/[?&]diag=1/.test(location.search)) return;
  try {
    await fetch('/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        at: new Date().toISOString(),
        ua: navigator.userAgent,
        viewport: `${innerWidth}x${innerHeight}`,
        dpr: devicePixelRatio,
        doc: S.doc ? { pages: S.doc.numPages } : null,
        page: S.page,
        zoom: S.zoom,
        canvas: { w: el.canvas.width, h: el.canvas.height, cssW: el.canvas.clientWidth, cssH: el.canvas.clientHeight },
        renderScale: S.pageRenderScale,
        roots: S.index?.roots?.length ?? null,
        indexedPages: S.index?.pages?.length ?? null,
        outlineTop: S.outline?.length ?? null,
        ...extra,
      }, null, 1),
    });
  } catch { /* ignore */ }
}

(async function main() {
  loadUser();
  bind();
  updateCounts();
  initGestures();
  updateViewBtn();
  registerSW();
  el.pageTotal.textContent = `/ ${TOTAL_PAGES}`;
  const t0 = performance.now();
  await Promise.all([loadOutline(), loadIndex()]);
  renderTree();
  await reportDiag({ stage: 'index-loaded', ms: Math.round(performance.now() - t0) });
  S.resetScroll = true;
  await loadDoc(PDF_URL);
  // 首屏渲染结果（用于真机诊断）
  await reportDiag({
    stage: 'first-page-rendered',
    ms: Math.round(performance.now() - t0),
    darkSamples: (() => {
      try {
        const ctx = el.canvas.getContext('2d');
        const d = ctx.getImageData(0, 0, el.canvas.width, el.canvas.height).data;
        let dark = 0;
        for (let i = 0; i < d.length; i += 4 * 13) if (d[i] < 128) dark++;
        return dark;
      } catch { return null; }
    })(),
  });
  toast('单栏阅读模式（字更大）· 点底栏 ▯ 可切换整页视图', 3200);
})();
