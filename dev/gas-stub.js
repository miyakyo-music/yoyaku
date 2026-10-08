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

  window.Utilities = {
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

  const props = JSON.parse(localStorage.getItem(PROPS_KEY) || '{"ADMIN_PASSWORD":"admin123"}');
  window.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = v; localStorage.setItem(PROPS_KEY, JSON.stringify(props)); },
      deleteProperty: (k) => { delete props[k]; localStorage.setItem(PROPS_KEY, JSON.stringify(props)); },
    }),
  };
  window.Logger = { log: console.log };
  window.ScriptApp = { getService: () => ({ getUrl: () => location.origin + '/' }) };

  // google.script.run の模擬。引数・戻り値はJSONで受け渡す（GASと同様に Date 等は渡せない）
  const runner = (onSuccess, onFailure) => new Proxy({}, {
    get(_, prop) {
      if (prop === 'withSuccessHandler') return (fn) => runner(fn, onFailure);
      if (prop === 'withFailureHandler') return (fn) => runner(onSuccess, fn);
      return (...args) => setTimeout(() => {
        try {
          const result = window[prop](...JSON.parse(JSON.stringify(args)));
          save();
          if (onSuccess) onSuccess(result === undefined ? null : JSON.parse(JSON.stringify(result)));
        } catch (e) {
          book = JSON.parse(localStorage.getItem(KEY) || 'null') || book; // 失敗時は書き込みを破棄
          if (onFailure) onFailure(e);
        }
      }, 200);
    },
  });
  window.google = { script: { run: runner() } };

  window.gasStub = {
    reset() { localStorage.removeItem(KEY); localStorage.removeItem(PROPS_KEY); location.reload(); },
    sheet: (name) => book.sheets[name],
    isEmpty: () => !book.order.length,
    save,
  };
})();
