/**
 * 予約表を「アプリのように」使うための仕組み（Service Worker）。ホーム画面に追加したときなどに働く。
 *
 * 方針: いつもネットから最新の画面を取り、取れなかったとき（電波がない・弱い）だけ、前に保存した画面を出す。
 *       こうすると、更新のたびに古い画面が残る心配がない。
 * 予約のデータ（GAS・高速キャッシュ）はここでは扱わない（画面側が「前回の表」を端末に覚えていて、それを出す）。
 * やめるときは、このファイルを「自分を消す」内容に差し替える（保守マニュアル 03 の「アプリのように使う仕組み」）。
 */
const CACHE = 'yoyaku-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

// 保存するときの名前は、?v=… などを除いたファイルの場所にする（版が変わっても、最後に取れたものを1つだけ持つ）
const keyOf = (url) => url.origin + url.pathname;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // GAS・Cloudflare などへの通信は触らない
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(keyOf(url), res.clone());
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
