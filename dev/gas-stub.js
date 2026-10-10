/**
 * ローカル動作確認用: Google Apps Script のサービスをブラウザ上で模擬する。
 * 本物の Code.gs をそのまま読み込み、スプレッドシートの代わりに localStorage へ保存する。
 * 本番（GAS）では使用しない。
 */
(function () {
  'use strict';
  const KEY = 'gasStub.sheets';
  const PROPS_KEY = 'gasStub.props';
  let book = JSON.parse(localStorage.getItem(KEY) || 'null') || { order: [], sheets: {} };
  const save = () => localStorage.setItem(KEY, JSON.stringify(book));

  const colNum = (letters) => letters.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

  class Range {
    constructor(sheet, row, col, rows, cols) { Object.assign(this, { sheet, row, col, rows, cols }); }
    _grid() { return book.sheets[this.sheet.name]; }
    getDisplayValues() {
      const g = this._grid();
      return Array.from({ length: this.rows }, (_, i) =>
        Array.from({ length: this.cols }, (_, j) => String(((g[this.row - 1 + i] || [])[this.col - 1 + j]) ?? '')));
    }
    getValues() { return this.getDisplayValues(); }
    getValue() { return this.getDisplayValues()[0][0]; }
    setValues(values) {
      const g = this._grid();
      values.forEach((r, i) => {
        const ri = this.row - 1 + i;
        while (g.length <= ri) g.push([]);
        r.forEach((v, j) => { g[ri][this.col - 1 + j] = v == null ? '' : String(v); });
      });
      return this;
    }
    clearContent() { return this.setValues(Array.from({ length: this.rows }, () => Array(this.cols).fill(''))); }
    setNumberFormat() { return this; }
    setFontWeight() { return this; }
    setBackground() { return this; }
    setDataValidation() { return this; }
  }

  class Sheet {
    constructor(name) { this.name = name; }
    getName() { return this.name; }
    getLastRow() {
      const g = book.sheets[this.name];
      for (let i = g.length - 1; i >= 0; i--) if ((g[i] || []).some((v) => v !== '' && v != null)) return i + 1;
      return 0;
    }
    getRange(a, b, c, d) {
      if (typeof a === 'string') {
        const m = a.match(/^([A-Z]+)(\d*):([A-Z]+)(\d*)$/);
        const c1 = colNum(m[1]), c2 = colNum(m[3]);
        const r1 = Number(m[2] || 1), r2 = Number(m[4] || 1000);
        return new Range(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1);
      }
      return new Range(this, a, b, c || 1, d || 1);
    }
    deleteRow(row) { book.sheets[this.name].splice(row - 1, 1); }
    setFrozenRows() { return this; }
    setColumnWidth() { return this; }
  }

  const spreadsheet = {
    getUrl: () => 'https://docs.google.com/spreadsheets/d/dev-stub/edit',
    getSheetByName: (name) => (book.sheets[name] ? new Sheet(name) : null),
    insertSheet: (name) => { book.sheets[name] = []; book.order.push(name); return new Sheet(name); },
    getSheets: () => book.order.map((n) => new Sheet(n)),
    deleteSheet: (s) => { delete book.sheets[s.name]; book.order = book.order.filter((n) => n !== s.name); },
    setSpreadsheetTimeZone() {},
  };

  const chain = () => new Proxy({}, { get: () => () => chain() });

  window.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
    openById: () => spreadsheet,
    flush: save,
    getUi() { throw new Error('UI is not available in the stub'); },
    newDataValidation: chain,
  };

  // SHA-256 / HMAC-SHA256（GAS の Utilities.computeHmacSha256Signature の代わり。同期で計算する必要があるので自前）
  function sha256(bytes) {
    const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const l = bytes.length;
    const padded = new Uint8Array(((l + 9 + 63) >> 6) << 6);
    padded.set(bytes); padded[l] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 4, l * 8); dv.setUint32(padded.length - 8, Math.floor(l / 0x20000000));
    const w = new Uint32Array(64);
    const rot = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < padded.length; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rot(w[i - 15], 7) ^ rot(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rot(w[i - 2], 17) ^ rot(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) | 0; });
    }
    const out = new Uint8Array(32);
    H.forEach((v, i) => new DataView(out.buffer).setUint32(i * 4, v >>> 0));
    return out;
  }
  function hmacSha256(keyBytes, msgBytes) {
    let k = keyBytes.length > 64 ? sha256(keyBytes) : keyBytes;
    const kp = new Uint8Array(64); kp.set(k);
    const ipad = kp.map((b) => b ^ 0x36), opad = kp.map((b) => b ^ 0x5c);
    const inner = new Uint8Array(64 + msgBytes.length); inner.set(ipad); inner.set(msgBytes, 64);
    const outer = new Uint8Array(96); outer.set(opad); outer.set(sha256(inner), 64);
    return sha256(outer);
  }
  const utf8 = (t) => new TextEncoder().encode(String(t));

  window.Utilities = {
    Charset: { UTF_8: 'UTF-8' },
    // GAS と同じく、-128〜127 の数の配列で返す
    computeHmacSha256Signature: (value, key) => [...hmacSha256(utf8(key), utf8(value))].map((b) => (b > 127 ? b - 256 : b)),
    base64EncodeWebSafe: (bytes) => btoa(String.fromCharCode(...bytes.map((b) => b & 255))).replace(/\+/g, '-').replace(/\//g, '_'),
    getUuid: () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()),
    formatDate(date, tz, pattern) {
      const parts = {};
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      }).formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
      const map = { yyyy: parts.year, MM: parts.month, M: String(Number(parts.month)), dd: parts.day, HH: parts.hour, mm: parts.minute, ss: parts.second };
      return pattern.replace(/yyyy|MM|M|dd|HH|mm|ss/g, (t) => map[t]);
    },
  };

  window.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };

  const cache = new Map();
  window.CacheService = {
    getScriptCache: () => ({
      get: (k) => (cache.has(k) ? cache.get(k) : null),
      put: (k, v) => cache.set(k, v),
      remove: (k) => cache.delete(k),
    }),
  };

  // 高速キャッシュ（Cloudflare）の送り先と合言葉は、dev/cf-stub.js（ブラウザの中の Cloudflare）に向ける
  const props = JSON.parse(localStorage.getItem(PROPS_KEY) ||
    '{"ADMIN_PASSWORD":"admin123","CACHE_PUSH_URL":"http://dev-cf.test/push","CACHE_PUSH_TOKEN":"devtoken"}');
  window.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
      getProperties: () => Object.assign({}, props),
      setProperty: (k, v) => { props[k] = v; localStorage.setItem(PROPS_KEY, JSON.stringify(props)); },
      deleteProperty: (k) => { delete props[k]; localStorage.setItem(PROPS_KEY, JSON.stringify(props)); },
    }),
  };
  window.Logger = { log: console.log };

  // UrlFetchApp: ブラウザの中の Cloudflare（dev/cf-stub.js）にだけつなぐ。/push（高速キャッシュの写し）は受け取ったことにする
  window.UrlFetchApp = {
    fetch(url, opts) {
      opts = opts || {};
      if (!String(url).startsWith('http://dev-cf.test')) throw new Error('UrlFetchApp: dev では ' + url + ' には接続しない');
      if (/\/push$/.test(url)) return { getResponseCode: () => 200, getContentText: () => '{"ok":true}' };
      const auth = (opts.headers && opts.headers.Authorization) || '';
      return window.devCf.httpSync(opts.method || 'get', url, auth, opts.payload ? JSON.parse(opts.payload) : {});
    },
  };

  window.ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput: (text) => ({ setMimeType() { return this; }, getContent: () => text }),
  };

  // GAS ウェブアプリへの fetch を横取りし、Code.gs の doPost に渡す（本番と同じく本文は JSON 文字列）
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, init) => {
    if (String(url) !== window.GAS_API_URL) return realFetch(url, init);
    return new Promise((resolve) => setTimeout(() => {
      let text;
      try {
        text = window.doPost({ postData: { contents: init.body, type: 'text/plain' } }).getContent();
        save();
      } catch (e) {
        console.error(e);
        book = JSON.parse(localStorage.getItem(KEY) || 'null') || book;
        resolve(new Response('<html>Error</html>', { status: 500 }));
        return;
      }
      resolve(new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }, 200));
  };

  window.gasStub = {
    reset() { localStorage.removeItem(KEY); localStorage.removeItem(PROPS_KEY); location.reload(); },
    sheet: (name) => book.sheets[name],
    isEmpty: () => !book.order.length,
    save,
  };
})();
