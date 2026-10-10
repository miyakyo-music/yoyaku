/**
 * ローカル動作確認用: Cloudflare の「予約の正本」（cache/store.js）をブラウザの中で動かす。
 * データベースは dev/serve.py の /dev-sql（Mac の SQLite。Cloudflare の Durable Object と同じ SQLite）に、
 * 待ち合わせる通信（同期の XMLHttpRequest）で読み書きする。本番では使用しない。
 *   - 画面からの http://dev-cf.test/api・/schedule への fetch を横取りして StoreCore に渡す
 *   - GAS（Code.gs）の UrlFetchApp からの呼び出しは devCf.httpSync で受ける（dev/gas-stub.js）
 */
(function () {
  'use strict';
  const BASE = 'http://dev-cf.test';
  const TOKEN = 'devtoken'; // dev/gas-stub.js の CACHE_PUSH_TOKEN と同じ

  function exec(q, ...b) {
    const x = new XMLHttpRequest();
    x.open('POST', '/dev-sql', false);
    x.send(JSON.stringify({ q, b }));
    const r = JSON.parse(x.responseText);
    if (r.error) throw new Error(r.error + ' :: ' + q);
    return r.rows;
  }
  const db = {
    exec,
    txn(fn) {
      exec('BEGIN');
      try { const v = fn(); exec('COMMIT'); return v; } catch (e) { exec('ROLLBACK'); throw e; }
    },
  };
  const core = new StoreCore(db, { PUSH_TOKEN: TOKEN }, {
    // 本番では worker.js の Store が、開いている画面と GAS に合図する。ここでは GAS（Code.gs）に「写して」とだけ送る
    changed() {
      setTimeout(() => {
        fetch(window.GAS_API_URL, { method: 'POST', body: JSON.stringify({ action: 'mirrorNow', params: {} }) }).catch(() => {});
      }, 50);
    },
  });

  function request(method, url, auth, body) {
    const u = new URL(url);
    return { method, path: u.pathname, query: u.searchParams, auth: auth || '', body: body || {} };
  }

  window.devCf = {
    core,
    BASE,
    httpSync(method, url, auth, body) {
      const res = StoreCore.routeSync(core, request(method.toUpperCase(), url, auth, body));
      return { getResponseCode: () => res.status, getContentText: () => JSON.stringify(res.body) };
    },
    reset() { exec('__RESET__'); },
  };

  const prevFetch = window.fetch;
  window.fetch = (url, init) => {
    const s = String(url);
    if (!s.startsWith(BASE)) return prevFetch(url, init);
    init = init || {};
    return new Promise((resolve) => setTimeout(async () => {
      const method = (init.method || 'GET').toUpperCase();
      let out;
      try {
        out = await StoreCore.handleHttp(core, request(method, s, '', init.body ? JSON.parse(init.body) : {}));
      } catch (e) {
        console.error(e);
        out = { status: 500, body: { ok: false, code: 'ERROR', message: String(e) } };
      }
      resolve(new Response(JSON.stringify(out.body), { status: out.status, headers: { 'Content-Type': 'application/json' } }));
    }, 30));
  };
})();
