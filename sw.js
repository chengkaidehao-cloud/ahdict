/* 新编阿汉大词典 · Service Worker：应用外壳离线 + 索引缓存 + PDF 可选缓存 */
// 约定：任何改动本文件内容都必须提升 VER，否则 activate 不会清理旧外壳缓存。
// v2 = 修复 PDF 缓存命中破坏 Range；v3 = 预缓存 roots.json；v4 = 离线 Range 流式切分；v5 = 按响应语义切片（不再依赖 onLine）
const VER = 'v5';
const SHELL = `ahdict-shell-${VER}`;
const DATA = `ahdict-data-${VER}`;
const PDFC = 'ahdict-pdf-v1';

const SHELL_ASSETS = [
  './', './index.html', './styles.css', './app.js', './manifest.webmanifest',
  // 121KB，首屏词根检索必需：不预缓存的话，用户首次打开后立刻断网就查不了词根。
  // pages.json（14MB）与 ar-index.json（2.78MB）故意不在此列 —— 它们走 data/ 分支按需 SWR 缓存。
  './data/roots.json',
  './vendor/pdf.mjs', './vendor/pdf.worker.mjs',
  './vendor/wasm/jbig2.wasm', './vendor/wasm/jbig2_nowasm_fallback.js',
  './vendor/wasm/openjpeg.wasm', './vendor/wasm/openjpeg_nowasm_fallback.js',
  './vendor/wasm/qcms_bg.wasm',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.allSettled(SHELL_ASSETS.map((u) => c.add(new Request(u, { cache: 'reload' }))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('ahdict-') && k !== SHELL && k !== DATA && k !== PDFC).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// 离线时从缓存里切出请求的字节范围：流式读取 + 跳过不需要的部分，
// 既不把整个 85MB 读进 SW 内存，也让 pdf.js 拿到合规的 206 响应
// （否则它会拿到 200 全量，退化为全量读取 → WebView JS heap 压力）。
async function sliceFromCache(hit, rangeHeader) {
  if (!rangeHeader) return hit;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!m) return hit;
  const size = Number(hit.headers.get("content-length") || 0);
  if (!size) return hit;
  let start, end;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (!n) return hit;
    start = Math.max(0, size - n);   // 后缀范围 bytes=-N
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (!(start >= 0) || !(end >= start) || start >= size) return hit;
  const need = end - start + 1;
  const reader = hit.body.getReader();
  const out = new Uint8Array(need);
  let pos = 0;                     // 已从源流消费的字节数
  let filled = 0;
  try {
    while (filled < need) {
      const { value, done } = await reader.read();
      if (done) break;
      const cs = pos;
      const ce = pos + value.byteLength - 1;
      pos += value.byteLength;
      if (ce < start) continue;    // 整块在范围之前 → 丢弃
      if (cs > end) break;         // 整块在范围之后 → 停止
      const from = Math.max(0, start - cs);
      const to = Math.min(value.byteLength, end - cs + 1);
      const part = value.subarray(from, to);
      out.set(part, filled);
      filled += part.byteLength;
    }
  } finally {
    try { reader.cancel().catch(() => {}); } catch {}
  }
  if (filled === 0) return hit;
  return new Response(out.subarray(0, filled), {
    status: 206,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Range": "bytes " + start + "-" + (start + filled - 1) + "/" + size,
      "Content-Length": String(filled),
      "Accept-Ranges": "bytes",
    },
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // PDF：保证 Range 请求始终得到合规的 206 响应。
  //
  // 两条实测教训：
  //  1) 缓存命中时 c.match() 返回「完整文件 + status 200」，不带 Content-Range，
  //     于是 pdf.js 的 Range 请求会拿到整个 85MB → 全量读入 JS heap → 可能 OOM。
  //  2) 不能只靠 navigator.onLine 判断在线/离线：serve.mjs 对 .pdf 设了
  //     Cache-Control: max-age=86400，离线时 fetch(req) 会命中浏览器 HTTP 缓存、
  //     返回 200 全量，从而绕过离线分支。
  // 因此改为检查「响应是否满足 Range 语义」：请求了 Range 却拿到 200 全量，
  // 就自己流式切片（不把整个文件读进内存）。证据：tools/verify_sw_range.mjs
  if (url.pathname.toLowerCase().endsWith(".pdf")) {
    e.respondWith((async () => {
      const range = req.headers.get("range");
      try {
        const r = await fetch(req);
        if (range && r.status === 200 && !r.headers.get("content-range")) {
          return await sliceFromCache(r, range);
        }
        return r;
      } catch (err) {
        const c = await caches.open(PDFC);
        const hit = await c.match(url.href, { ignoreSearch: true });
        if (!hit) throw err;
        return await sliceFromCache(hit, range);
      }
    })());
    return;
  }

  // 索引数据：缓存优先，后台更新
  if (url.pathname.includes('/data/')) {
    e.respondWith((async () => {
      const c = await caches.open(DATA);
      const hit = await c.match(req, { ignoreSearch: true });
      const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
      return hit || (await net) || new Response('{}', { headers: { 'content-type': 'application/json' } });
    })());
    return;
  }

  // 代码/外壳：network-first（保证更新能生效），离线回退缓存
  const isCode = /\.(html|js|mjs|css|webmanifest)$/i.test(url.pathname) || url.pathname === '/' || url.pathname.endsWith('/');
  if (isCode) {
    e.respondWith((async () => {
      try {
        const r = await fetch(req);
        if (r.ok) { const c = await caches.open(SHELL); await c.put(req, r.clone()); }
        return r;
      } catch {
        const c = await caches.open(SHELL);
        const hit = await c.match(req, { ignoreSearch: true });
        return hit || new Response('离线且未缓存：' + url.pathname, { status: 504 });
      }
    })());
    return;
  }

  // 其它静态资源（wasm / 图标 / 字体）：cache-first
  e.respondWith((async () => {
    const c = await caches.open(SHELL);
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const r = await fetch(req);
      if (r.ok) await c.put(req, r.clone());
      return r;
    } catch (err) {
      return new Response('离线且未缓存：' + url.pathname, { status: 504 });
    }
  })());
});
