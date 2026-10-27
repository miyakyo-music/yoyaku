/**
 * 予約表を「アプリのように」使うための仕組み（Service Worker）。ホーム画面に追加したときなどに働く。
 *
 * 方針:
 * - 画面（HTML）と、版の付いていないもの: いつもネットから取り、取れなかったとき（電波がない・弱い）だけ、前に保存したものを出す。
 *   こうすると、更新のたびに古い画面が残る心配がない。保存の名前は ?… を除いたファイルの場所。
 * - 公開のときに版（?v=…）を付けた CSS・JS・アイコン: 中身は版ごとに決まっていて変わらないので、URL ごと（?v= を含めて）
 *   保存し、保存があればネットに行かずにそれを出す（起動が速くなる）。なければネットから取って保存する。
 *   新しい版を公開すると HTML が新しい ?v= を指すので、古いものが出ることはない。
 * - 古い版の保存が貯まらないよう、HTML を取れたときに、保存しているどの HTML も指していない ?v= 付きのものを消す。
 * 予約のデータ（GAS・高速キャッシュ）はここでは扱わない（画面側が「前回の表」を端末に覚えていて、それを出す）。
 * やめるときは、このファイルを「自分を消す」内容に差し替える（保守マニュアル 03 の「アプリのように使う仕組み」）。
 */
const CACHE = 'yoyaku-shell-v2';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // 消すのはこの予約表の古い保存だけ（同じサイトの別のアプリの保存は消さない）
    for (const key of await caches.keys()) if (key.startsWith('yoyaku-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

const keyOf = (url) => url.origin + url.pathname;

/** 保存している HTML のどれも指していない ?v= 付きの保存を消す */
async function prune(cache) {
  const keys = await cache.keys();
  const keep = new Set();
  for (const req of keys) {
    if (new URL(req.url).search) continue;
    const res = await cache.match(req);
    if (!res || !(res.headers.get('content-type') || '').includes('text/html')) continue;
    const html = await res.text();
    for (const m of html.matchAll(/(?:src|href)="([^"]*[?&]v=[^"]*)"/g)) keep.add(new URL(m[1].replace(/&amp;/g, '&'), req.url).href);
  }
  for (const req of keys) if (new URL(req.url).searchParams.has('v') && !keep.has(req.url)) await cache.delete(req);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // GAS・Cloudflare などへの通信は触らない

  // 版の付いた CSS・JS・アイコン: 保存があればそれを出す
  if (req.mode !== 'navigate' && url.searchParams.has('v')) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(url.href);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) e.waitUntil(cache.put(url.href, res.clone()));
      return res;
    })());
    return;
  }

  // 画面と、版の付いていないもの: いつもネットから。取れなかったときだけ保存したもの
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok) {
        // 保存し終えるまで Service Worker を止めさせない。画面を取れたときは、古い版の保存も片付ける
        const saved = cache.put(keyOf(url), res.clone());
        e.waitUntil(req.mode === 'navigate' ? saved.then(() => prune(cache)).catch(() => {}) : saved);
      }
      return res;
    } catch (err) {
      const hit = await cache.match(keyOf(url));
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const home = await cache.match(new URL('./', self.registration.scope).href) || await cache.match(new URL('./index.html', self.registration.scope).href);
        if (home) return home;
      }
      throw err;
    }
  })());
});
