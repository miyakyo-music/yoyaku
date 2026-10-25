/**
 * 試験用: テスト環境（dev/serve.py ＋ ブラウザ）と同じものを、ブラウザなしで Node の中に組み立てる。
 * dev/fixed-time.js・dev/gas-stub.js・gas/Code.gs・cache/store.js・dev/cf-stub.js・dev/seed.js・web/api.js を
 * そのまま1つの「画面」（vm の入れ物）に読み込む。違うのは次の3つだけ。
 *   - localStorage・location・document などのブラウザの部品は、ここで用意した簡単な代わりを使う
 *   - dev/serve.py の /dev-sql（Cloudflare の正本のデータベース）は、Node の node:sqlite で受ける
 *   - 待ち時間（模擬の通信の遅れ）は短くする（台本が数分かからないように。順番は変えない）
 * 使い方: const w = createWorld({ now: '2026-10-10T09:00:00+09:00' }); w.run('migrateToCloudflare()');
 */
'use strict';
// テスト環境はふだん日本の Mac で動かしているので、時刻の解釈をそろえる（GitHub Actions は UTC）。
// Node は TZ を書き換えると、その場で時刻の計算に使う。
process.env.TZ = 'Asia/Tokyo';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '../..');
const GAS_URL = 'https://script.google.com/macros/s/dev-stub/exec'; // dev/serve.py の DEV_CONFIG と同じ
const CF_URL = 'http://dev-cf.test';

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

/** dev/serve.py の /dev-sql と同じ働き（1つの SQL を実行して行を返す。__RESET__ でデータベースを作り直す） */
function sqlServer() {
  let db = new DatabaseSync(':memory:');
  return (text) => {
    const req = JSON.parse(text || '{}');
    try {
      if (req.q === '__RESET__') { db.close(); db = new DatabaseSync(':memory:'); return { rows: [] }; }
      // Python の sqlite3 と同じく、true / false は 1 / 0 として入れる
      const b = (req.b || []).map((v) => (v === true ? 1 : v === false ? 0 : v));
      return { rows: db.prepare(req.q).all(...b) };
    } catch (e) {
      return { error: e.message };
    }
  };
}

function createWorld(opts) {
  opts = opts || {};
  const sql = sqlServer();
  const errors = [];
  const search = opts.now ? '?now=' + encodeURIComponent(opts.now) : '';

  // 同期の XMLHttpRequest は /dev-sql（dev/cf-stub.js が使う）だけを受ける
  class XMLHttpRequest {
    open(method, url) { this.url = url; }
    send(body) {
      if (this.url !== '/dev-sql') throw new Error('試験では ' + this.url + ' には接続しない');
      this.responseText = JSON.stringify(sql(body));
    }
  }

  const ctx = {
    console: opts.quiet === false ? console : { log() {}, info() {}, warn() {}, error: (...a) => errors.push(a.map(String).join(' ')) },
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    location: { search, pathname: '/', href: 'http://127.0.0.1:8765/' + search, reload() {}, replace() {} },
    document: { querySelectorAll: () => [], createElement: () => ({ style: {}, appendChild() {}, addEventListener() {}, setAttribute() {} }), body: { appendChild() {} } },
    XMLHttpRequest,
    // 模擬の通信の遅れ（gas-stub は 200ms、cf-stub は 30ms と 50ms）は 1/20 にする。api.js の60秒の打ち切りなど長いものはそのまま
    setTimeout: (fn, ms, ...a) => { const t = setTimeout(fn, ms > 1000 ? ms : (ms || 0) / 20, ...a); if (t.unref && ms > 1000) t.unref(); return t; },
    clearTimeout,
    setInterval, clearInterval, queueMicrotask,
    fetch: (url) => Promise.reject(new Error('試験では ' + url + ' には接続しない')),
    Response, URL, URLSearchParams, AbortController, TextEncoder, TextDecoder, crypto: globalThis.crypto, btoa, atob, Intl,
    GAS_API_URL: GAS_URL,
    CACHE_API_URL: CF_URL,
  };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);

  const load = (file) => vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
  // dev/serve.py が画面に差し込む順（INJECT）のあとに、画面の api.js
  for (const f of ['dev/fixed-time.js', 'dev/gas-stub.js', 'gas/Code.gs', 'cache/store.js', 'dev/cf-stub.js', 'dev/seed.js', 'web/api.js']) load(f);

  return {
    ctx,
    errors,
    /** 入れ物の中で JS を実行する（開発者ツールのコンソールに貼るのと同じ） */
    run: (code) => vm.runInContext(code, ctx),
    load,
    /** 模擬の通信の遅れで後回しになった処理（写しの合図など）が終わるまで待つ */
    settle: () => new Promise((r) => setTimeout(r, 100)),
  };
}

module.exports = { createWorld, ROOT };
