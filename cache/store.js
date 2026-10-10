/**
 * 練習室予約の「正本」（Cloudflare の Durable Object に置く SQLite）
 *
 * 予約・部屋・設定・休館・不具合報告の正本をここに置き、画面からの呼び出し（予約・変更・取消・管理画面の操作）を
 * ここで受ける。中身は gas/Code.gs の同じ名前の処理を移したもの（確かめる内容・返す形・文言は同じ）。
 *
 * - 書き込みは1つずつ順番に処理される（Durable Object は1つだけで、同時に1件しか動かない）。重なりの確認から
 *   書き込みまでを、途中で待たずに一気に行うので、2人が同じ枠を同時に取っても二重予約にならない。
 * - 変わった内容は changes の表に積んでおき、GAS がそれを読んでスプレッドシートに写す（写しは閲覧・控え用）。
 *   書き込みのあとに GAS へ「写して」と合図を送る。届かなくても、GAS の5分ごとのトリガーが写す。
 * - スプレッドシートからの最初の移し替え（/migrate）と、GAS へ戻すとき（op: 'disable'）も、ここで受ける。
 *
 * このファイルは Cloudflare（worker.js が読み込む）と、手元のテスト環境（dev/serve.py。ブラウザの中で動かす）の
 * 両方で使う。そのため import / export を使わず、globalThis.StoreCore に置く。
 * データベースの操作は db.exec(SQL, ...値) → 行の配列、db.txn(関数) → 1つの取引としてまとめる、の2つだけを使う。
 */
(function (g) {
  'use strict';

  const API_VERSION = 1; // gas/Code.gs・web/api.js と同じにする

  const SYSTEM = {
    MAX_AFFILIATION_LENGTH: 30,
    MAX_NAME_LENGTH: 50,
    MAX_MEMO_LENGTH: 100,
    MAX_RANGE_DAYS: 42,
    MAX_PIN_FAILURES: 5,
    MAX_LIMITED_FAILURES: 30,
    FAILURE_LOCK_SECONDS: 600,
    MAX_WRITES_PER_MINUTE: 60, // GAS のときより速いので、上限は GAS の倍にする（いたずらで埋め尽くされないための上限）
    MAX_ADMIN_DEVICES: 30,
    PBKDF2_ROUNDS: 20000, // 管理用パスワードを、元に戻せない形（ハッシュ）にして置くときの計算回数
  };

  const SETTINGS = [
    { key: 'title', def: '練習室予約' },
    { key: 'notice', def: '' },
    { key: 'noticeLevel', def: '通常' },
    { key: 'openTime', def: '07:00' },
    { key: 'closeTime', def: '22:00' },
    { key: 'unitMinutes', def: '5' },
    { key: 'maxDurationMinutes', def: '0' },
    { key: 'maxDaysAhead', def: '0' },
    { key: 'closedWeekdays', def: '' },
    { key: 'maxBulkCount', def: '100' },
    { key: 'bulkRequiresAdmin', def: 'はい' },
    { key: 'viewPassword', def: '' },
    { key: 'limitedPassword', def: '' },
  ];
  const SECRET_SETTINGS = ['viewPassword', 'limitedPassword'];
  const ROOM_RESTRICTIONS = { ADMIN_ONLY: '管理者のみ', STOPPED: '使用停止', LIMITED: '限定公開' };
  const RESERVATION_COLORS = ['red', 'purple', 'green'];
  const BUG_STATUSES = ['未対応', '対応中', '対応済み', '対応しない'];
  const UNIT_OPTIONS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60];
  const WEEKDAYS = '日月火水木金土';
  const RES_COLS = 'id, date, room_id, st, en, affiliation, name, pin, created_at, group_id, memo, updated_at, color';

  const MOVED = {
    ok: false, code: 'MOVED', primary: 'gas',
    message: '予約システムの保存先が切り替わりました。ページを再読み込みしてください。',
  };

  class StoreCore {
    /**
     * @param db {exec(sql, ...binds): object[], txn(fn): any}
     * @param env {PUSH_TOKEN}
     * @param hooks {changed(): void} 書き込みのあとに呼ぶ（開いている画面への合図と、GAS への「写して」の合図）
     */
    constructor(db, env, hooks) {
      this.db = db;
      this.env = env || {};
      this.hooks = hooks || {};
      this.memo = {};
      this.device = '';
      this.init();
    }

    init() {
      const x = (q) => this.db.exec(q);
      x(`CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, date TEXT NOT NULL, room_id TEXT NOT NULL, st TEXT NOT NULL, en TEXT NOT NULL,
        affiliation TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', pin TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '',
        group_id TEXT NOT NULL DEFAULT '', memo TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '')`);
      x('CREATE INDEX IF NOT EXISTS res_day ON reservations (date, room_id)');
      x('CREATE INDEX IF NOT EXISTS res_group ON reservations (group_id)');
      x(`CREATE TABLE IF NOT EXISTS rooms (ord INTEGER NOT NULL, id TEXT PRIMARY KEY, name TEXT NOT NULL, equipment TEXT NOT NULL DEFAULT '',
        restriction TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '')`);
      x(`CREATE TABLE IF NOT EXISTS closures (n INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, room_id TEXT NOT NULL DEFAULT '',
        st TEXT NOT NULL DEFAULT '', en TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '')`);
      x('CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
      x(`CREATE TABLE IF NOT EXISTS bugs (id TEXT PRIMARY KEY, received_at TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL,
        contact TEXT NOT NULL, user_agent TEXT NOT NULL, screen TEXT NOT NULL, page TEXT NOT NULL, env TEXT NOT NULL)`);
      x(`CREATE TABLE IF NOT EXISTS oplog (n INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL, res_id TEXT, date TEXT,
        room_id TEXT, time TEXT, who TEXT, detail TEXT)`);
      // 写し待ちの変更（GAS が読んだら消す）
      x('CREATE TABLE IF NOT EXISTS changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, data TEXT NOT NULL)');
      // 小さな値（正本かどうか・管理用パスワード・誤入力の回数など）。exp は期限（ミリ秒。0 は無期限）
      x('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER NOT NULL DEFAULT 0)');
    }

    // ---------------- 小さな値 ----------------
    kget(k) {
      const row = this.db.exec('SELECT v, exp FROM kv WHERE k = ?', k)[0];
      if (!row) return null;
      if (row.exp && row.exp < Date.now()) { this.db.exec('DELETE FROM kv WHERE k = ?', k); return null; }
      return row.v;
    }
    kput(k, v, seconds) {
      this.db.exec('INSERT OR REPLACE INTO kv (k, v, exp) VALUES (?, ?, ?)', k, String(v), seconds ? Date.now() + seconds * 1000 : 0);
    }
    kdel(k) { this.db.exec('DELETE FROM kv WHERE k = ?', k); }
    isPrimary() { return this.kget('primary') === '1'; }

    // ---------------- 画面からの呼び出し（POST /api） ----------------
    async api(req) {
      const action = String((req && req.action) || '');
      const p = (req && req.params && typeof req.params === 'object') ? req.params : {};
      this.memo = { admin: {} };
      this.device = String(p.adminDevice || '').slice(0, 64);
      if (!this.isPrimary()) return withVersion(Object.assign({}, MOVED));
      const fn = Object.prototype.hasOwnProperty.call(API, action) ? API[action] : null;
      if (!fn) return withVersion(fail('不明な操作です。', 'BAD_REQUEST'));

      // 合言葉・パスワードの確認は時間のかかる計算（待ちが入る）なので、先に済ませておく。
      // このあとの処理は待たずに一気に行う（その間に別の書き込みが割り込まない）
      await this.upgradePassword();
      await this.prepareAdmin(p.adminPassword);
      const pin = String(p.pin || '').trim();
      if (pin && !/^\d{4}$/.test(pin)) await this.prepareAdmin(pin);
      // 新しいパスワードの計算（時間がかかる）は、管理者だと確かめてからにする（誰でも重い計算を起こせないように）
      if (action === 'adminChangePassword' && this.memo.admin[String(p.adminPassword || '')] === null && String(p.newPassword || '').length >= 6) {
        this.memo.newHash = await hashPassword(String(p.newPassword));
      }
      if (action === 'adminPasskeyTicket' && this.passkeyKey()) {
        const exp = Math.floor(Date.now() / 1000) + 300;
        this.memo.ticket = 'pkt.' + exp + '.' + await hmac(this.passkeyKey(), 'pkt.' + exp);
      }

      let result;
      try {
        result = this.db.txn(() => {
          this.memo.wrote = false;
          return fn.call(this, p);
        });
      } catch (e) {
        console.error(e);
        result = fail('サーバーでエラーが発生しました。時間をおいて再度お試しください。', 'SERVER_ERROR');
      }
      if (result && result.ok && this.memo.wrote && this.hooks.changed) {
        try { this.hooks.changed(); } catch (e) { /* 合図の失敗で処理を失敗させない */ }
      }
      return withVersion(result || { ok: true });
    }

    /**
     * スプレッドシートから移したときの管理用パスワード（plain$…。元の文字のまま）を、元に戻せない形（PBKDF2）に置き換える。
     * 移す処理（sync）は待ちのない処理なのでそこでは計算できず、移したあと最初の呼び出しで行う（パスキーだけで入る人がいても残らない）
     */
    async upgradePassword() {
      const stored = this.kget('adminPw') || '';
      if (stored.indexOf('plain$') !== 0) return;
      const hashed = await hashPassword(stored.slice(6));
      if (this.kget('adminPw') === stored) this.kput('adminPw', hashed); // 計算の間に変わっていなければ
    }

    /** 管理用パスワード（またはパスキーでのログインの印）を確かめ、結果を覚えておく（verifyAdmin が使う） */
    async prepareAdmin(password) {
      const k = String(password || '');
      if (!k || Object.prototype.hasOwnProperty.call(this.memo.admin, k)) return;
      if (/^pk1\./.test(k)) { this.memo.admin[k] = await this.verifyPasskeyToken(k); return; }
      const stored = this.kget('adminPw') || '';
      if (!stored) { this.memo.admin[k] = '管理用パスワードが設定されていません。管理者に連絡してください。'; return; }
      // 誤入力の回数は全体で数える。管理画面にログインしたことのある端末は、その端末だけの回数で数える
      const trusted = this.isTrustedDevice(this.device);
      const failKey = trusted ? 'adminfail_' + this.device : 'adminfail';
      const failures = Number(this.kget(failKey) || 0);
      if (failures >= SYSTEM.MAX_PIN_FAILURES * 2) {
        this.memo.admin[k] = '管理用パスワードの誤入力が続いたため、一時的に利用できません。10分ほど待ってから再度お試しください。';
        return;
      }
      // 誤入力の回数は、確かめる「前」に1つ増やしておく。確かめる計算は待ちが入るので、後で増やすと、
      // 同時に大量に送られたとき全部が同じ回数を読み、回数がほとんど増えずにいくらでも試せてしまう
      this.kput(failKey, failures + 1, SYSTEM.FAILURE_LOCK_SECONDS);
      let ok;
      if (stored.indexOf('plain$') === 0) {
        ok = safeEqual(k, stored.slice(6)); // 古い形（元に戻せない形に置き換える前）。upgradePassword が置き換える
      } else {
        ok = await checkPassword(k, stored);
      }
      if (!ok) {
        this.memo.admin[k] = '管理用パスワードが一致しません。';
        return;
      }
      // 合っていたら、先に増やした1回を取り消す
      const now = Number(this.kget(failKey) || 0);
      if (now > 1) this.kput(failKey, now - 1, SYSTEM.FAILURE_LOCK_SECONDS); else this.kdel(failKey);
      this.memo.admin[k] = null;
    }

    async verifyPasskeyToken(token) {
      const m = /^pk1\.(\d+)\.([\w-]{1,64})\.([\w-]+)$/.exec(token);
      const key = this.passkeyKey();
      if (!m || !key || !safeEqual(await hmac(key, 'pk1.' + m[1] + '.' + m[2]), m[3])) return '管理用パスワードが一致しません。';
      if (Number(m[1]) < Date.now() / 1000) return 'パスキーでのログインの有効期限が切れました。もう一度ログインしてください（パスキーか管理用パスワード）。';
      return null;
    }
    passkeyKey() { return String(this.env.PUSH_TOKEN || '').trim(); }

    /** 先に確かめておいた結果を返す。一致すれば null、違えばメッセージ */
    verifyAdmin(password) {
      const k = String(password || '');
      if (Object.prototype.hasOwnProperty.call(this.memo.admin, k)) return this.memo.admin[k];
      return '管理用パスワードが一致しません。';
    }
    resolveAdmin(password) {
      if (!password) return { ok: false };
      const error = this.verifyAdmin(password);
      return error ? { error } : { ok: true };
    }
    requireAdmin(p) {
      const error = this.verifyAdmin(p && p.adminPassword);
      return error ? fail(error, 'ADMIN_AUTH') : null;
    }

    isTrustedDevice(token) {
      if (!token) return false;
      const list = JSON.parse(this.kget('adminDevices') || '{}');
      return Object.prototype.hasOwnProperty.call(list, token);
    }
    rememberDevice(token) {
      const list = JSON.parse(this.kget('adminDevices') || '{}');
      const id = token && Object.prototype.hasOwnProperty.call(list, token) ? token : uuid();
      list[id] = nowStr('yyyy-MM-dd');
      const keys = Object.keys(list).sort((x, y) => list[y].localeCompare(list[x]));
      keys.slice(SYSTEM.MAX_ADMIN_DEVICES).forEach((k) => delete list[k]);
      this.kput('adminDevices', JSON.stringify(list));
      return id;
    }

    writeLimit() {
      const key = 'writes_' + Math.floor(Date.now() / 60000);
      const n = Number(this.kget(key) || 0);
      if (n >= SYSTEM.MAX_WRITES_PER_MINUTE) return fail('予約の操作が集中しています。1分ほど待ってから、もう一度お試しください。', 'BUSY');
      this.kput(key, n + 1, 120);
      return null;
    }

    // ---------------- 読み込み ----------------
    master() {
      if (this.memo.master) return this.memo.master;
      const raw = {};
      for (const r of this.db.exec('SELECT k, v FROM settings')) raw[r.k] = r.v;
      this.memo.master = { settings: parseSettings(raw), rooms: this.readRooms(), closures: this.readClosures() };
      return this.memo.master;
    }
    readRooms() {
      return this.db.exec('SELECT * FROM rooms ORDER BY ord, rowid').map((r) => ({
        order: Number(r.ord) || 9999, id: r.id, name: r.name || r.id, equipment: r.equipment, restriction: r.restriction, note: r.note, tags: r.tags,
      }));
    }
    readClosures() {
      return this.db.exec('SELECT * FROM closures ORDER BY n').map((r) => closureOf(r.date, r.room_id, r.st, r.en, r.reason)).filter((c) => isValidDate(c.date));
    }
    resWhere(where, ...binds) {
      return this.db.exec(`SELECT ${RES_COLS} FROM reservations ${where}`, ...binds).map(fromDb);
    }

    context(p) {
      const m = this.master();
      const isAdmin = !!(p && p.adminPassword) && !this.verifyAdmin(p.adminPassword);
      const limited = this.limitedAccess(m.settings, p || {}, isAdmin);
      const rooms = limited.ok ? m.rooms : m.rooms.filter((r) => r.restriction !== ROOM_RESTRICTIONS.LIMITED);
      return { settings: m.settings, rooms, limited, isAdmin, closures: m.closures };
    }
    limitedAccess(settings, p, isAdmin) {
      const pw = settings.limitedPassword;
      const key = String(p.limitedKey || '');
      if (key) {
        const failures = Number(this.kget('limitedFailures') || 0);
        if (pw && failures < SYSTEM.MAX_LIMITED_FAILURES && safeEqual(key, pw)) return { ok: true };
        this.kput('limitedFailures', failures + 1, SYSTEM.FAILURE_LOCK_SECONDS);
      }
      if (isAdmin) return { ok: true };
      return key ? { ok: false, denied: true } : { ok: false };
    }

    openBugCount() {
      const row = this.db.exec("SELECT COUNT(*) AS n FROM bugs WHERE status NOT IN ('対応済み', '対応しない')")[0];
      return row ? Number(row.n) : 0;
    }

    // ---------------- 書き込みの共通処理 ----------------
    insertRes(r) {
      this.db.exec(`INSERT OR REPLACE INTO reservations (${RES_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...toRow(r));
      this.change('res', toRow(r));
    }
    deleteRes(ids) {
      for (const id of ids) this.db.exec('DELETE FROM reservations WHERE id = ?', id);
      this.change('resdel', ids);
    }
    change(kind, data) {
      this.db.exec('INSERT INTO changes (kind, data) VALUES (?, ?)', kind, JSON.stringify(data));
      this.memo.wrote = true;
    }
    log(action, r, detail) {
      const row = [nowStr('yyyy-MM-dd HH:mm:ss'), action, r.id, r.date, r.roomId, r.start + '〜' + r.end,
        (r.affiliation ? r.affiliation + ' ' : '') + r.name, detail || r.memo || ''];
      this.addLog(row);
    }
    logAdmin(action, detail) {
      this.addLog([nowStr('yyyy-MM-dd HH:mm:ss'), action, '', '', '', '', '管理者', detail]);
    }
    addLog(row) {
      this.db.exec('INSERT INTO oplog (at, action, res_id, date, room_id, time, who, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ...row);
      this.change('log', row);
    }

    // ---------------- 公開されている予約表（GET /schedule） ----------------
    /** 誰でも見られる形の予約表。正本でない・閲覧パスワードを使っている・範囲が広すぎるときは null */
    publicSchedule(from, to) {
      this.memo = { admin: {} };
      if (!this.isPrimary()) return null;
      if (!isValidDate(from) || !isValidDate(to) || from > to || daysBetween(from, to) >= SYSTEM.MAX_RANGE_DAYS) return null;
      const ctx = this.context({});
      if (ctx.settings.viewPassword) return null;
      const res = scheduleOf.call(this, ctx, from, to);
      return withVersion(Object.assign(res, { serverNow: nowStr('yyyy-MM-dd HH:mm'), primary: true }));
    }

    // ---------------- GAS とのやりとり（合言葉つき。待ちのない処理だけ） ----------------
    /**
     * @param op 'begin' | 'reservations' | 'master' | 'finish' | 'disable' | 'status' | 'changes' | 'full'
     */
    sync(op, body) {
      body = body || {};
      const res = this.syncTxn(op, body);
      // 受付を始めたら、開いている画面と GAS に知らせる（取引の外で。取引の中では通信を始めない）
      if (op === 'finish' && res.ok && this.hooks.changed) { try { this.hooks.changed(); } catch (e) { /* 無視 */ } }
      return res;
    }

    syncTxn(op, body) {
      return this.db.txn(() => {
        if (op === 'status') return this.status();
        if (op === 'changes') return this.mirrorChanges(Number(body.after) || 0);
        if (op === 'full') return this.mirrorFull();
        if (op === 'disable') { this.kput('primary', '0'); return { ok: true }; }
        if (op === 'finish') { this.kput('primary', '1'); return this.status(); }
        if (this.isPrimary()) return fail('すでに Cloudflare が正本になっています。先に GAS へ戻してから移し直してください。', 'ALREADY');
        if (op === 'begin') {
          for (const t of ['reservations', 'rooms', 'closures', 'settings', 'bugs', 'changes']) this.db.exec(`DELETE FROM ${t}`);
          return { ok: true };
        }
        if (op === 'reservations') {
          let n = 0;
          for (const row of Array.isArray(body.rows) ? body.rows : []) {
            const r = fromSheetRow(row);
            if (!r.id) continue;
            this.db.exec(`INSERT OR REPLACE INTO reservations (${RES_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...toRow(r));
            n++;
          }
          return { ok: true, count: n };
        }
        if (op === 'master') {
          (body.rooms || []).forEach((r) => {
            const id = str(r[1]);
            if (!id) return;
            this.db.exec('INSERT OR REPLACE INTO rooms (ord, id, name, equipment, restriction, note, tags) VALUES (?, ?, ?, ?, ?, ?, ?)',
              Number(r[0]) || 9999, id, str(r[2]), str(r[3]), str(r[4]), str(r[5]), str(r[6]));
          });
          (body.closures || []).forEach((c) => {
            const x = closureOf(c[0], c[1], c[2], c[3], c[4]);
            if (!isValidDate(x.date)) return;
            this.db.exec('INSERT INTO closures (date, room_id, st, en, reason) VALUES (?, ?, ?, ?, ?)', x.date, x.roomId, x.start, x.end, x.reason);
          });
          Object.keys(body.settings || {}).forEach((k) => {
            if (SETTINGS.some((s) => s.key === k)) this.db.exec('INSERT OR REPLACE INTO settings (k, v) VALUES (?, ?)', k, str(body.settings[k]));
          });
          (body.bugs || []).forEach((b) => {
            if (!str(b[0])) return;
            this.db.exec('INSERT OR REPLACE INTO bugs (id, received_at, status, message, contact, user_agent, screen, page, env) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
              ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (i === 2 ? str(b[i]) || BUG_STATUSES[0] : String(b[i] == null ? '' : b[i]))));
          });
          if (body.adminPassword) this.kput('adminPw', 'plain$' + String(body.adminPassword));
          if (body.adminDevices) this.kput('adminDevices', String(body.adminDevices));
          if (body.spreadsheetUrl) this.kput('spreadsheetUrl', String(body.spreadsheetUrl));
          return { ok: true };
        }
        return fail('不明な操作です。', 'BAD_REQUEST');
      });
    }

    status() {
      const count = (t) => Number((this.db.exec(`SELECT COUNT(*) AS n FROM ${t}`)[0] || {}).n || 0);
      return {
        ok: true, primary: this.isPrimary(),
        reservations: count('reservations'), rooms: count('rooms'), closures: count('closures'), bugs: count('bugs'),
        pendingChanges: count('changes'),
      };
    }

    /** after より後の変更を返す（after までは GAS が写し終えたので消す） */
    mirrorChanges(after) {
      this.db.exec('DELETE FROM changes WHERE seq <= ?', after);
      const rows = this.db.exec('SELECT seq, kind, data FROM changes WHERE seq > ? ORDER BY seq LIMIT 500', after);
      const last = rows.length ? rows[rows.length - 1].seq : after;
      const more = !!this.db.exec('SELECT 1 AS x FROM changes WHERE seq > ? LIMIT 1', last).length;
      return { ok: true, seq: last, more, changes: rows.map((r) => ({ seq: r.seq, kind: r.kind, data: JSON.parse(r.data) })) };
    }

    /** すべてを返す（スプレッドシートを丸ごと写し直すとき。GAS へ戻す前にも使う） */
    mirrorFull() {
      const seqRow = this.db.exec('SELECT MAX(seq) AS s FROM changes')[0];
      const raw = {};
      for (const r of this.db.exec('SELECT k, v FROM settings')) raw[r.k] = r.v;
      return {
        ok: true,
        seq: Number(seqRow && seqRow.s) || 0,
        reservations: this.resWhere('ORDER BY date, st, room_id').map(toRow),
        rooms: this.readRooms().map(roomRow),
        closures: this.db.exec('SELECT * FROM closures ORDER BY n').map((c) => [c.date, c.room_id, c.st, c.en, c.reason]),
        settings: raw,
        bugs: this.db.exec('SELECT * FROM bugs ORDER BY received_at, id').map((b) => [b.id, b.received_at, b.status, b.message, b.contact, b.user_agent, b.screen, b.page, b.env]),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // 画面から呼べる処理（中身は gas/Code.gs の同じ名前の処理と同じ。this は StoreCore）
  // ---------------------------------------------------------------------------

  function checkView(ctx, viewKey) {
    const pw = ctx.settings.viewPassword;
    if (!pw || safeEqual(String(viewKey || ''), pw)) return null;
    return fail(viewKey ? '閲覧パスワードが違います。' : '閲覧パスワードを入力してください。', 'AUTH_REQUIRED');
  }
  function visibleIn(ctx) {
    const ids = new Set(ctx.rooms.map((r) => r.id));
    return (x) => !x.roomId || ids.has(x.roomId);
  }
  function limitedInfo(ctx) {
    if (ctx.limited.ok) return { limitedAccess: true };
    if (ctx.limited.denied) return { limitedDenied: true };
    return {};
  }
  function roomOf(ctx, roomId) { return ctx.rooms.find((r) => r.id === roomId) || {}; }

  function scheduleOf(ctx, from, to) {
    const visible = visibleIn(ctx);
    return {
      ok: true, from, to,
      rooms: ctx.rooms,
      reservations: this.resWhere('WHERE date >= ? AND date <= ? ORDER BY date, st', from, to).filter(visible).map(toPublic),
      closures: ctx.closures.filter((c) => c.date >= from && c.date <= to && visible(c)),
      settings: publicSettings(ctx.settings),
    };
  }

  function getSchedule(p) {
    const ctx = this.context(p);
    const denied = checkView(ctx, p.viewKey);
    if (denied) return denied;
    const from = normDate(p.from);
    const to = normDate(p.to || p.from);
    if (!isValidDate(from) || !isValidDate(to) || from > to) return fail('日付の指定が正しくありません。');
    if (daysBetween(from, to) >= SYSTEM.MAX_RANGE_DAYS) return fail('一度に表示できる期間は' + SYSTEM.MAX_RANGE_DAYS + '日までです。');
    return Object.assign(scheduleOf.call(this, ctx, from, to), { serverNow: nowStr('yyyy-MM-dd HH:mm') },
      limitedInfo(ctx), ctx.isAdmin ? { openBugs: this.openBugCount() } : {});
  }

  function getReservationsByIds(p) {
    const ctx = this.context(p);
    const denied = checkView(ctx, p.viewKey);
    if (denied) return denied;
    const ids = Array.from(new Set((Array.isArray(p.ids) ? p.ids : []).slice(0, 300).map(String)));
    const visible = visibleIn(ctx);
    const list = [];
    for (let i = 0; i < ids.length; i += 50) {
      const part = ids.slice(i, i + 50);
      list.push(...this.resWhere(`WHERE id IN (${part.map(() => '?').join(',')})`, ...part));
    }
    return {
      ok: true, rooms: ctx.rooms, serverNow: nowStr('yyyy-MM-dd HH:mm'),
      reservations: list.filter(visible).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)).map(toPublic),
    };
  }

  function createReservation(p) {
    const limited = this.writeLimit();
    if (limited) return limited;
    const ctx = this.context(p);
    const denied = checkView(ctx, p.viewKey);
    if (denied) return denied;
    const admin = this.resolveAdmin(p.adminPassword);
    if (admin.error) return fail(admin.error);
    const v = validateBooking(ctx, p, admin.ok);
    if (v.error) return fail(v.error);
    const r = v.value;
    if (r.pin && !/^\d{4}$/.test(r.pin)) return fail('編集用パスワードは4桁の数字で入力してください（設定しない場合は空欄）。');
    const ruleError = checkDateRules(ctx, r, admin.ok) || closureError(ctx, r);
    if (ruleError) return fail(ruleError);
    const conflict = findConflict.call(this, r, null);
    if (conflict) return fail('すでに存在する予約と時間が重複しています（' + describe(conflict) + '）。', 'CONFLICT');
    const created = Object.assign({}, r, { id: newId('res'), groupId: '', createdAt: nowStr('yyyy-MM-dd HH:mm:ss'), updatedAt: '', color: colorOf(ctx, p, admin.ok, '') });
    this.insertRes(created);
    this.log('予約', created, '');
    return { ok: true, reservation: toPublic(created) };
  }

  function createBulkReservations(p) {
    const limited = this.writeLimit();
    if (limited) return limited;
    const ctx = this.context(p);
    const denied = checkView(ctx, p.viewKey);
    if (denied) return denied;
    // 件数の上限は、一覧を作る前に確かめる（非常に長い一覧を送られても、重い処理をしないように）
    const maxN = ctx.settings.maxBulkCount;
    const roughN = Array.isArray(p.pairs) && p.pairs.length ? p.pairs.length
      : (Array.isArray(p.dates) ? p.dates.length : 0) * (Array.isArray(p.roomIds) && p.roomIds.length ? p.roomIds.length : 1);
    if (roughN > maxN * 3) return fail('まとめて予約できるのは最大' + maxN + '件です（今回: ' + roughN + '件）。');
    let combos;
    if (Array.isArray(p.pairs) && p.pairs.length) {
      const seen = {};
      combos = p.pairs.map((x) => ({ date: normDate(x && x.date), roomId: String((x && x.roomId) || '').trim() }))
        .filter((x) => !seen[x.date + '|' + x.roomId] && (seen[x.date + '|' + x.roomId] = true));
    } else {
      if (!Array.isArray(p.dates) || !p.dates.length) return fail('予約する日付が指定されていません。');
      const ds = p.dates.map(normDate);
      const rs = (Array.isArray(p.roomIds) && p.roomIds.length ? p.roomIds : [p.roomId]).map((id) => String(id || '').trim());
      combos = [];
      Array.from(new Set(ds)).forEach((d) => Array.from(new Set(rs)).forEach((id) => combos.push({ date: d, roomId: id })));
    }
    combos.sort((a, b) => a.date.localeCompare(b.date));
    const dates = Array.from(new Set(combos.map((x) => x.date))).sort();
    if (!dates.length) return fail('予約する日付が指定されていません。');
    if (dates.some((d) => !isValidDate(d))) return fail('日付の形式が正しくありません。');
    const roomIds = Array.from(new Set(combos.map((x) => x.roomId)));
    const total = combos.length;
    if (total > ctx.settings.maxBulkCount) return fail('まとめて予約できるのは最大' + ctx.settings.maxBulkCount + '件です（今回: ' + total + '件）。');
    const admin = this.resolveAdmin(p.adminPassword);
    if (admin.error) return fail(admin.error);
    if (ctx.settings.bulkRequiresAdmin && total > 1 && !admin.ok) return fail('くり返し予約・複数部屋の同時予約には管理用パスワードが必要です。');

    const bases = {};
    for (const roomId of roomIds) {
      const v = validateBooking(ctx, Object.assign({}, p, { date: dates[0], roomId }), admin.ok);
      if (v.error) return fail(v.error);
      bases[roomId] = v.value;
    }
    if (bases[roomIds[0]].pin && !/^\d{4}$/.test(bases[roomIds[0]].pin)) return fail('編集用パスワードは4桁の数字で入力してください（設定しない場合は空欄）。');

    const conflicts = [];
    const available = [];
    combos.forEach((c) => {
      const r = Object.assign({}, bases[c.roomId], { date: c.date });
      const reason = checkDateRules(ctx, r, admin.ok) || closureError(ctx, r);
      const conflict = reason ? null : findConflict.call(this, r, null);
      if (reason || conflict) conflicts.push({ date: c.date, roomId: r.roomId, reason: reason || '既存の予約と重複（' + describe(conflict) + '）' });
      else available.push(r);
    });
    if (conflicts.length && !p.skipConflicts) {
      return Object.assign(fail('予約できない日・部屋が含まれています。', 'PARTIAL_CONFLICT'), { conflicts, availableCount: available.length });
    }
    if (!available.length) return fail('指定したすべての日・部屋で予約できませんでした。', 'CONFLICT');

    const groupId = newId('grp');
    const now = nowStr('yyyy-MM-dd HH:mm:ss');
    const color = colorOf(ctx, p, admin.ok, '');
    const created = available.map((r) => Object.assign({}, r, { id: newId('res'), groupId, createdAt: now, updatedAt: '', color }));
    created.forEach((r) => this.insertRes(r));
    this.log('まとめて予約', created[0], created.length + '件（' + roomIds.length + '部屋・' + dates.length + '日: ' + dates.join(', ') + '）');
    return { ok: true, groupId, reservations: created.map(toPublic), skipped: conflicts };
  }

  function updateReservation(p) {
    const limited = this.writeLimit();
    if (limited) return limited;
    const ctx = this.context(p);
    const denied = checkView(ctx, p.viewKey);
    if (denied) return denied;
    const id = String(p.id || '').trim();
    if (!id) return fail('予約IDが指定されていません。');
    const target = this.resWhere('WHERE id = ?', id)[0];
    if (!target || !visibleIn(ctx)(target)) return fail('この予約は既に取り消されているか、存在しません。', 'NOT_FOUND');
    const auth = checkPin.call(this, target, p.pin, p.adminPassword);
    if (auth.error) return fail(auth.error);
    if (!auth.admin && isPast(target.date, target.end)) return fail('終了した予約は変更できません。');
    if (!auth.admin && roomOf(ctx, target.roomId).restriction === ROOM_RESTRICTIONS.ADMIN_ONLY) return fail('この部屋の予約は管理者のみ変更できます。');

    if (p.scope === 'following' && target.groupId) return updateSeries.call(this, ctx, target, p, auth.admin);

    const v = validateBooking(ctx, Object.assign({}, p, { pin: target.pin }), auth.admin);
    if (v.error) return fail(v.error);
    const r = v.value;
    const ruleError = checkDateRules(ctx, r, auth.admin) || closureError(ctx, r);
    if (ruleError) return fail(ruleError);
    const conflict = findConflict.call(this, r, id);
    if (conflict) return fail('変更後の時間帯が、すでに存在する予約と重複しています（' + describe(conflict) + '）。', 'CONFLICT');
    const updated = Object.assign({}, target, r, {
      id: target.id, pin: target.pin, createdAt: target.createdAt, groupId: target.groupId,
      updatedAt: nowStr('yyyy-MM-dd HH:mm:ss'), color: colorOf(ctx, p, auth.admin, target.color),
    });
    this.insertRes(updated);
    this.log(auth.admin ? '変更（管理者）' : '変更', updated, '変更前: ' + target.date + ' ' + target.roomId + ' ' + describe(target));
    return { ok: true, reservation: toPublic(updated) };
  }

  function updateSeries(ctx, target, p, isAdmin) {
    const members = this.resWhere('WHERE group_id = ? AND date >= ? ORDER BY date, st', target.groupId, target.date)
      .filter((r) => r.id === target.id || isAdmin || !isPast(r.date, r.end));
    const updates = [];
    const problems = [];
    const now = nowStr('yyyy-MM-dd HH:mm:ss');
    for (const m of members) {
      const v = validateBooking(ctx, Object.assign({}, p, { date: m.date, roomId: m.roomId, pin: m.pin }), isAdmin);
      if (v.error) return fail(v.error);
      const r = v.value;
      const reason = checkDateRules(ctx, r, isAdmin) || closureError(ctx, r);
      const conflict = reason ? null : findConflict.call(this, r, m.id);
      if (reason || conflict) {
        problems.push(m.date + ' ' + roomOf(ctx, m.roomId).name + ': ' + (reason || '既存の予約と重複（' + describe(conflict) + '）'));
        continue;
      }
      updates.push({ before: m, after: Object.assign({}, m, r, { id: m.id, pin: m.pin, createdAt: m.createdAt, groupId: m.groupId, updatedAt: now, color: colorOf(ctx, p, isAdmin, m.color) }) });
    }
    if (problems.length) return Object.assign(fail('まとめて変更できない日があるため、変更しませんでした。'), { code: 'SERIES_CONFLICT', conflicts: problems });
    updates.forEach((u) => this.insertRes(u.after));
    this.log(isAdmin ? 'まとめて変更（管理者）' : 'まとめて変更', updates[0].after,
      updates.length + '件（' + updates.map((u) => u.after.date).join(', ') + '）変更前: ' + describe(target));
    return { ok: true, reservation: toPublic(updates[0].after), reservations: updates.map((u) => toPublic(u.after)) };
  }

  function cancelReservation(p) {
    const limited = this.writeLimit();
    if (limited) return limited;
    const ctx = this.context(p);
    const denied = checkView(ctx, p.viewKey);
    if (denied) return denied;
    const id = String(p.id || '').trim();
    if (!id) return fail('予約IDが指定されていません。');
    const target = this.resWhere('WHERE id = ?', id)[0];
    if (!target || !visibleIn(ctx)(target)) return fail('この予約は既に取り消されているか、存在しません。', 'NOT_FOUND');
    const auth = checkPin.call(this, target, p.pin, p.adminPassword);
    if (auth.error) return fail(auth.error);
    if (!auth.admin && roomOf(ctx, target.roomId).restriction === ROOM_RESTRICTIONS.ADMIN_ONLY) return fail('この部屋の予約は管理者のみ取り消せます。');
    const targets = p.scope === 'following' && target.groupId
      ? this.resWhere('WHERE group_id = ? AND date >= ? ORDER BY date, st', target.groupId, target.date)
      : [target];
    this.deleteRes(targets.map((r) => r.id));
    this.log(auth.admin ? '取消（管理者）' : '取消', target, targets.length > 1 ? targets.length + '件（' + targets.map((t) => t.date).join(', ') + '）' : '');
    return { ok: true, cancelledIds: targets.map((r) => r.id) };
  }

  function submitBugReport(p) {
    const message = String(p.message || '').trim();
    const contact = String(p.contact || '').trim();
    if (!message) return fail('不具合の内容を入力してください。');
    if (message.length > 2000) return fail('内容は2000文字以内で入力してください。');
    if (contact.length > 100) return fail('連絡先は100文字以内で入力してください。');
    const count = Number(this.kget('bugreports') || 0);
    if (count >= 30) return fail('現在、報告が集中しています。しばらくしてから再度お試しください。');
    this.kput('bugreports', count + 1, 600);
    const env = p.env && typeof p.env === 'object' ? p.env : {};
    const text = (v, max) => {
      const t = String(v == null ? '' : v).slice(0, max);
      return /^[=+\-@]/.test(t) ? ' ' + t : t; // スプレッドシートに写したとき、数式として解釈されないように
    };
    const row = [newId('bug'), nowStr('yyyy-MM-dd HH:mm:ss'), BUG_STATUSES[0], text(message, 2000), text(contact, 100),
      text(env.userAgent, 400), text(env.screen, 100), text(env.page, 200), text(JSON.stringify(env), 3000)];
    this.db.exec('INSERT INTO bugs (id, received_at, status, message, contact, user_agent, screen, page, env) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ...row);
    this.change('bug', row);
    this.memo.wrote = false; // 予約表には関係しないので、開いている画面には知らせない（写しは5分ごとのトリガーで）
    this.memo.mirrorOnly = true;
    return { ok: true, id: row[0] };
  }

  function adminGetData(p) {
    const denied = this.requireAdmin(p);
    if (denied) return denied;
    const m = this.master();
    return {
      ok: true,
      settings: m.settings,
      rooms: m.rooms,
      closures: m.closures,
      unitOptions: UNIT_OPTIONS,
      today: nowStr('yyyy-MM-dd'),
      spreadsheetUrl: this.kget('spreadsheetUrl') || '',
      openBugs: this.openBugCount(),
      adminDevice: this.rememberDevice(this.device),
    };
  }

  function adminSaveSettings(p) {
    const denied = this.requireAdmin(p);
    if (denied) return denied;
    const v = validateSettings(p.settings || {});
    if (v.error) return fail(v.error);
    SETTINGS.forEach((def) => this.db.exec('INSERT OR REPLACE INTO settings (k, v) VALUES (?, ?)', def.key, v.value[def.key]));
    this.change('settings', v.value);
    this.memo.master = null;
    const settings = this.master().settings;
    this.logAdmin('設定変更', SETTINGS.filter((d) => SECRET_SETTINGS.indexOf(d.key) < 0).map((d) => d.key + '=' + v.value[d.key]).join(' / '));
    return { ok: true, settings, warnings: settingsWarnings.call(this, settings) };
  }

  function adminSetNotice(p) {
    const denied = this.requireAdmin(p);
    if (denied) return denied;
    const current = this.master().settings;
    const res = adminSaveSettings.call(this, {
      adminPassword: p.adminPassword,
      settings: Object.assign({}, current, {
        notice: String(p.notice || ''), noticeLevel: String(p.noticeLevel || current.noticeLevel),
        closedWeekdays: current.closedWeekdays, // validateSettings は曜日の番号の配列を受け取る
      }),
    });
    return res.ok ? { ok: true, settings: publicSettings(res.settings) } : res;
  }

  function adminSaveRooms(p) {
    const denied = this.requireAdmin(p);
    if (denied) return denied;
    const input = Array.isArray(p.rooms) ? p.rooms : [];
    if (!input.length) return fail('部屋を1つ以上登録してください。');
    if (input.length > 200) return fail('登録できる部屋は200室までです。');
    const rooms = [];
    for (let i = 0; i < input.length; i++) {
      const r = input[i] || {};
      const room = {
        id: String(r.id || '').trim(), name: String(r.name || '').trim(), equipment: String(r.equipment || '').trim(),
        restriction: String(r.restriction || '').trim(), note: String(r.note || '').trim(), tags: String(r.tags || '').trim(),
      };
      const label = (i + 1) + '行目';
      if (!room.name || room.name.length > 30) return fail(label + ': 部屋名を30文字以内で入力してください。');
      if (room.equipment.length > 20) return fail(label + ': 設備区分は20文字以内で入力してください。');
      if (room.note.length > 100) return fail(label + ': 備考は100文字以内で入力してください。');
      if (room.tags.length > 30) return fail(label + ': 特徴タグは30文字以内で入力してください。');
      if (['', ROOM_RESTRICTIONS.ADMIN_ONLY, ROOM_RESTRICTIONS.STOPPED, ROOM_RESTRICTIONS.LIMITED].indexOf(room.restriction) < 0) return fail(label + ': 予約制限の値が正しくありません。');
      if ([room.name, room.equipment, room.note, room.tags].some((t) => /^[=+\-@]/.test(t))) return fail(label + ': 先頭に「= + - @」は使用できません。');
      rooms.push(room);
    }
    const current = this.readRooms();
    const currentIds = new Set(current.map((r) => r.id));
    const seen = new Set();
    for (const r of rooms) {
      if (!r.id) continue;
      if (!currentIds.has(r.id)) return fail('部屋ID「' + r.id + '」が見つかりません。画面を再読み込みしてやり直してください。');
      if (seen.has(r.id)) return fail('部屋ID「' + r.id + '」が重複しています。');
      seen.add(r.id);
    }
    const today = nowStr('yyyy-MM-dd');
    const removed = current.filter((r) => !seen.has(r.id));
    for (const r of removed) {
      const n = Number((this.db.exec('SELECT COUNT(*) AS n FROM reservations WHERE room_id = ? AND date >= ?', r.id, today)[0] || {}).n || 0);
      if (n) {
        return fail('「' + r.name + '」には今日以降の予約が' + n + '件あるため削除できません。' +
          '先に予約を取り消すか、予約制限を「使用停止」にしてください。', 'ROOM_IN_USE');
      }
    }
    // 新しい部屋ID: 過去の予約・休館で使われたことのない番号
    const used = new Set(current.map((r) => r.id)
      .concat(this.db.exec('SELECT DISTINCT room_id FROM reservations').map((x) => x.room_id))
      .concat(this.db.exec('SELECT DISTINCT room_id FROM closures').map((x) => x.room_id)));
    let n = 1;
    rooms.forEach((r) => {
      if (r.id) return;
      while (used.has('room_' + pad2(n))) n++;
      r.id = 'room_' + pad2(n);
      used.add(r.id);
    });
    this.db.exec('DELETE FROM rooms');
    rooms.forEach((r, i) => this.db.exec('INSERT INTO rooms (ord, id, name, equipment, restriction, note, tags) VALUES (?, ?, ?, ?, ?, ?, ?)',
      i + 1, r.id, r.name, r.equipment, r.restriction, r.note, r.tags));
    this.memo.master = null;
    const saved = this.readRooms();
    this.change('rooms', saved.map(roomRow));
    const added = rooms.filter((r) => !currentIds.has(r.id)).map((r) => r.name);
    this.logAdmin('部屋変更', '全' + rooms.length + '室' +
      (added.length ? ' / 追加: ' + added.join('、') : '') +
      (removed.length ? ' / 削除: ' + removed.map((r) => r.name).join('、') : ''));
    return { ok: true, rooms: saved };
  }

  function adminSaveClosures(p) {
    const denied = this.requireAdmin(p);
    if (denied) return denied;
    const input = Array.isArray(p.closures) ? p.closures : [];
    const roomIds = new Set(this.readRooms().map((r) => r.id));
    const closures = [];
    for (let i = 0; i < input.length; i++) {
      const c = input[i] || {};
      const item = {
        date: normDate(c.date), roomId: String(c.roomId || '').trim(), allDay: !!c.allDay,
        start: c.allDay ? '' : normTime(c.start), end: c.allDay ? '' : normTime(c.end), reason: String(c.reason || '').trim(),
      };
      const label = (item.date || (i + 1) + '件目') + ': ';
      if (!isValidDate(item.date)) return fail(label + '日付が正しくありません。');
      if (item.roomId && !roomIds.has(item.roomId)) return fail(label + '部屋が見つかりません。');
      if (!item.allDay && (!isTime(item.start) || !isTime(item.end) || toMin(item.start) >= toMin(item.end))) {
        return fail(label + '時間帯が正しくありません（終了は開始より後にしてください）。');
      }
      if (item.reason.length > 50) return fail(label + '理由は50文字以内で入力してください。');
      if (/^[=+\-@]/.test(item.reason)) return fail(label + '理由の先頭に「= + - @」は使用できません。');
      closures.push(item);
    }
    closures.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    this.db.exec('DELETE FROM closures');
    closures.forEach((c) => this.db.exec('INSERT INTO closures (date, room_id, st, en, reason) VALUES (?, ?, ?, ?, ?)', c.date, c.roomId, c.start, c.end, c.reason));
    this.change('closures', closures.map((c) => [c.date, c.roomId, c.start, c.end, c.reason]));
    this.memo.master = null;
    this.logAdmin('休館・利用停止の変更', closures.length + '件');
    const today = nowStr('yyyy-MM-dd');
    const m = this.master();
    const ctx = { closures: m.closures, settings: m.settings };
    const overlaps = this.resWhere('WHERE date >= ? ORDER BY date, st', today).filter((r) => closureError(ctx, r));
    const warnings = overlaps.length ? ['休館・利用停止と重なる予約が' + overlaps.length + '件あります（自動では取り消されません）:'].concat(
      overlaps.slice(0, 20).map((r) => r.date + ' ' + ((m.rooms.find((x) => x.id === r.roomId) || {}).name || r.roomId) + ' ' + describe(r))) : [];
    return { ok: true, closures: m.closures, warnings };
  }

  function adminGetBugReports(p) {
    const denied = this.requireAdmin(p);
    if (denied) return denied;
    const reports = this.db.exec('SELECT * FROM bugs ORDER BY received_at DESC, id DESC LIMIT 200').map((b) => ({
      id: b.id, receivedAt: b.received_at, status: b.status || BUG_STATUSES[0], message: b.message, contact: b.contact,
      userAgent: b.user_agent, screen: b.screen, page: b.page, env: b.env,
    }));
    return { ok: true, reports, statuses: BUG_STATUSES };
  }

  function adminSetBugStatus(p) {
    const denied = this.requireAdmin(p);
    if (denied) return denied;
    const id = String(p.id || '');
    const status = String(p.status || '');
    if (BUG_STATUSES.indexOf(status) < 0) return fail('状態の値が正しくありません。');
    const b = this.db.exec('SELECT * FROM bugs WHERE id = ?', id)[0];
    if (!b) return fail('報告が見つかりません。');
    this.db.exec('UPDATE bugs SET status = ? WHERE id = ?', status, id);
    this.change('bug', [b.id, b.received_at, status, b.message, b.contact, b.user_agent, b.screen, b.page, b.env]);
    this.memo.wrote = false;
    this.memo.mirrorOnly = true;
    return { ok: true };
  }

  function adminChangePassword(p) {
    const denied = this.requireAdmin(p);
    if (denied) return denied;
    const next = String(p.newPassword || '');
    if (next.length < 6 || !this.memo.newHash) return fail('新しいパスワードは6文字以上にしてください。');
    this.kput('adminPw', this.memo.newHash);
    this.logAdmin('管理用パスワード変更', '');
    return { ok: true };
  }

  function adminPasskeyTicket(p) {
    const denied = this.requireAdmin(p);
    if (denied) return denied;
    if (!this.memo.ticket) return fail('高速キャッシュの合言葉（PUSH_TOKEN）が設定されていないため、パスキーは使えません。');
    return { ok: true, ticket: this.memo.ticket };
  }

  const API = {
    getSchedule, getReservationsByIds, createReservation, createBulkReservations, updateReservation, cancelReservation,
    submitBugReport, adminGetData, adminSaveSettings, adminSetNotice, adminSaveRooms, adminSaveClosures,
    adminGetBugReports, adminSetBugStatus, adminChangePassword, adminPasskeyTicket,
  };

  // ---------------------------------------------------------------------------
  // 確かめる処理（gas/Code.gs と同じ）
  // ---------------------------------------------------------------------------

  function checkPin(target, pin, adminPassword) {
    if (adminPassword) {
      const error = this.verifyAdmin(adminPassword);
      return error ? { error } : { admin: true };
    }
    const code = String(pin || '').trim();
    if (code && !/^\d{4}$/.test(code)) {
      const error = this.verifyAdmin(code);
      if (!error) return { admin: true };
      return { error: /誤入力が続いた/.test(error) ? error : '編集用パスワードが一致しません。' };
    }
    if (!target.pin) return { admin: false };
    if (!code) return { error: 'この予約には編集用パスワードが設定されています。編集用パスワードを入力してください。' };
    const failKey = 'pinfail_' + target.id;
    const failures = Number(this.kget(failKey) || 0);
    if (failures >= SYSTEM.MAX_PIN_FAILURES) {
      return { error: '編集用パスワードの誤入力が続いたため、この予約は一時的に操作できません。10分ほど待ってから再度お試しください。' };
    }
    if (code === target.pin) { this.kdel(failKey); return { admin: false }; }
    this.kput(failKey, failures + 1, SYSTEM.FAILURE_LOCK_SECONDS);
    return { error: '編集用パスワードが一致しません。' };
  }

  function validateBooking(ctx, input, isAdmin) {
    const s = ctx.settings;
    const value = {
      date: normDate(input.date),
      roomId: String(input.roomId || '').trim(),
      start: normTime(input.start),
      end: normTime(input.end),
      affiliation: String(input.affiliation || '').trim(),
      name: String(input.name || '').trim(),
      memo: String(input.memo || '').trim().replace(/\s+/g, ' '),
      pin: String(input.pin || '').trim(),
    };
    if (!isValidDate(value.date)) return { error: '日付の形式が正しくありません。' };
    const room = roomOf(ctx, value.roomId);
    if (!room.id) return { error: '指定された部屋が存在しません。' };
    if (room.restriction === ROOM_RESTRICTIONS.STOPPED) return { error: room.name + ' は現在使用停止中です。' };
    if (room.restriction === ROOM_RESTRICTIONS.ADMIN_ONLY && !isAdmin) return { error: room.name + ' は管理者のみ予約できます（管理用パスワードが必要です）。' };
    const st = toMin(value.start);
    const en = toMin(value.end);
    if (!isTime(value.start) || !isTime(value.end)) return { error: '時刻の指定が正しくありません。' };
    if (st % s.unitMinutes || en % s.unitMinutes) return { error: '時刻は' + s.unitMinutes + '分単位で指定してください。' };
    if (st < toMin(s.openTime) || en > toMin(s.closeTime) || st >= en) {
      return { error: '利用可能時間（' + s.openTime + '〜' + s.closeTime + '）の範囲で、終了を開始より後にしてください。' };
    }
    if (!isAdmin && s.maxDurationMinutes && en - st > s.maxDurationMinutes) return { error: '1回に予約できるのは' + durationText(s.maxDurationMinutes) + 'までです。' };
    if (value.affiliation.length > SYSTEM.MAX_AFFILIATION_LENGTH) return { error: '学籍番号/所属は' + SYSTEM.MAX_AFFILIATION_LENGTH + '文字以内で入力してください。' };
    if (!value.name || value.name.length > SYSTEM.MAX_NAME_LENGTH) return { error: '氏名／団体名を' + SYSTEM.MAX_NAME_LENGTH + '文字以内で入力してください。' };
    if (value.memo.length > SYSTEM.MAX_MEMO_LENGTH) return { error: '備考は' + SYSTEM.MAX_MEMO_LENGTH + '文字以内で入力してください。' };
    // スプレッドシートに写したとき数式として解釈される先頭文字は使わせない
    if ([value.affiliation, value.name, value.memo].some((t) => /^[=+\-@]/.test(t))) return { error: '学籍番号/所属・氏名・備考の先頭に「= + - @」は使用できません。' };
    return { value };
  }

  function checkDateRules(ctx, r, isAdmin) {
    const s = ctx.settings;
    if (isPast(r.date, r.end)) return '過去の時間帯は予約できません。';
    if (s.closedWeekdays.indexOf(weekday(r.date)) >= 0) return '定休日（' + WEEKDAYS[weekday(r.date)] + '曜日）のため予約できません。';
    if (!isAdmin && s.maxDaysAhead && r.date > addDays(nowStr('yyyy-MM-dd'), s.maxDaysAhead)) return '予約できるのは' + s.maxDaysAhead + '日先までです。';
    return null;
  }

  function closureError(ctx, r) {
    const s = toMin(r.start);
    const e = toMin(r.end);
    const hit = ctx.closures.find((c) => c.date === r.date && (!c.roomId || c.roomId === r.roomId) &&
      (c.allDay || (toMin(c.start) < e && s < toMin(c.end))));
    if (!hit) return null;
    return (hit.allDay ? '終日' : hm(hit.start) + '〜' + hm(hit.end) + ' は') + '利用できません' + (hit.reason ? '（' + hit.reason + '）' : '') + '。';
  }

  function findConflict(r, excludeId) {
    // 時刻は「09:05」のように2桁でそろえてあるので、文字の大小で前後を比べられる
    return this.resWhere('WHERE date = ? AND room_id = ? AND id <> ? AND st < ? AND en > ? ORDER BY st LIMIT 1',
      r.date, r.roomId, excludeId || '', r.end, r.start)[0] || null;
  }

  function settingsWarnings(settings) {
    const today = nowStr('yyyy-MM-dd');
    const open = toMin(settings.openTime);
    const close = toMin(settings.closeTime);
    const future = this.resWhere('WHERE date >= ?', today);
    const outside = future.filter((r) => toMin(r.start) < open || toMin(r.end) > close).length;
    const holiday = future.filter((r) => settings.closedWeekdays.indexOf(weekday(r.date)) >= 0).length;
    const warnings = [];
    if (outside) warnings.push('新しい利用時間の外にかかる予約が' + outside + '件あります（自動では取り消されません）。');
    if (holiday) warnings.push('定休日に入っている予約が' + holiday + '件あります（自動では取り消されません）。');
    return warnings;
  }

  function validateSettings(s) {
    const title = String(s.title || '').trim();
    const notice = String(s.notice || '').trim().replace(/\s+/g, ' ');
    const noticeLevel = s.noticeLevel === '重要' ? '重要' : '通常';
    const open = normTime(s.openTime);
    const close = normTime(s.closeTime);
    const unit = Number(s.unitMinutes);
    const int = (v, min, max) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : null; };
    const maxDuration = int(s.maxDurationMinutes, 0, 24 * 60);
    const maxDays = int(s.maxDaysAhead, 0, 730);
    const maxBulk = int(s.maxBulkCount, 1, 300);
    const weekdays = (Array.isArray(s.closedWeekdays) ? s.closedWeekdays : []).map(Number).filter((n) => n >= 0 && n <= 6);
    const viewPassword = String(s.viewPassword || '').trim();
    const limitedPassword = String(s.limitedPassword || '').trim();
    if (!title || title.length > 40) return { error: 'タイトルを40文字以内で入力してください。' };
    if (notice.length > 200) return { error: 'お知らせは200文字以内で入力してください。' };
    if ([title, notice, viewPassword, limitedPassword].some((t) => /^[=+\-@]/.test(t))) return { error: '先頭に「= + - @」は使用できません。' };
    if (UNIT_OPTIONS.indexOf(unit) < 0) return { error: '予約単位は ' + UNIT_OPTIONS.join(', ') + ' 分のいずれかにしてください。' };
    if (!isTime(open) || !isTime(close) || toMin(open) >= toMin(close)) return { error: '利用終了時刻は利用開始時刻より後にしてください。' };
    if (toMin(open) % unit || toMin(close) % unit) return { error: '利用開始・終了時刻は予約単位（' + unit + '分）の区切りにしてください。' };
    if (maxDuration === null) return { error: '最大予約時間は0〜1440分の整数で入力してください。' };
    if (maxDuration && maxDuration % unit) return { error: '最大予約時間は予約単位（' + unit + '分）の倍数にしてください。' };
    if (maxDays === null) return { error: '予約受付期間は0〜730日の整数で入力してください。' };
    if (maxBulk === null) return { error: 'まとめて予約の最大件数は1〜300の整数で入力してください。' };
    if (viewPassword.length > 50) return { error: '閲覧パスワードは50文字以内で入力してください。' };
    if (limitedPassword && (limitedPassword.length < 6 || limitedPassword.length > 50)) return { error: '限定公開の部屋のパスワードは6〜50文字で入力してください。' };
    return {
      value: {
        title, notice, noticeLevel, openTime: open, closeTime: close,
        unitMinutes: String(unit), maxDurationMinutes: String(maxDuration), maxDaysAhead: String(maxDays),
        closedWeekdays: Array.from(new Set(weekdays)).sort().map((i) => WEEKDAYS[i]).join(','),
        maxBulkCount: String(maxBulk), bulkRequiresAdmin: s.bulkRequiresAdmin ? 'はい' : 'いいえ',
        viewPassword, limitedPassword,
      },
    };
  }

  function parseSettings(raw) {
    const v = {};
    SETTINGS.forEach((s) => { v[s.key] = Object.prototype.hasOwnProperty.call(raw, s.key) ? String(raw[s.key]).trim() : s.def; });
    const unit = Number(v.unitMinutes);
    let open = normTime(v.openTime);
    let close = normTime(v.closeTime);
    if (!isTime(open) || !isTime(close) || toMin(open) >= toMin(close)) { open = '07:00'; close = '22:00'; }
    return {
      title: v.title || '練習室予約',
      notice: v.notice,
      noticeLevel: v.noticeLevel === '重要' ? '重要' : '通常',
      openTime: open,
      closeTime: close,
      unitMinutes: unit > 0 && 60 % unit === 0 ? unit : 5,
      maxDurationMinutes: Math.max(0, Number(v.maxDurationMinutes) || 0),
      maxDaysAhead: Math.max(0, Number(v.maxDaysAhead) || 0),
      closedWeekdays: String(v.closedWeekdays).split('').map((ch) => WEEKDAYS.indexOf(ch)).filter((i) => i >= 0),
      maxBulkCount: Math.max(1, Number(v.maxBulkCount) || 100),
      bulkRequiresAdmin: !/^(いいえ|no|false|0|off)$/i.test(String(v.bulkRequiresAdmin).trim()),
      viewPassword: v.viewPassword,
      limitedPassword: v.limitedPassword,
    };
  }

  function publicSettings(s) {
    const copy = Object.assign({}, s);
    copy.viewPasswordRequired = !!s.viewPassword;
    SECRET_SETTINGS.forEach((k) => delete copy[k]);
    return copy;
  }

  function colorOf(ctx, p, isAdmin, current) {
    if (!(isAdmin || ctx.limited.ok) || p.color === undefined) return current || '';
    const c = String(p.color || '');
    return RESERVATION_COLORS.indexOf(c) >= 0 ? c : '';
  }

  // ---------------------------------------------------------------------------
  // 形の変換
  // ---------------------------------------------------------------------------

  /** スプレッドシートの台帳と同じ列の順番（予約ID, 予約日, 部屋ID, 開始, 終了, 学籍番号/所属, 氏名, 編集用パスワード, 作成日時, まとめ予約ID, 備考, 更新日時, 色） */
  function toRow(r) {
    return [r.id, r.date, r.roomId, r.start, r.end, r.affiliation || '', r.name || '', r.pin || '', r.createdAt || '', r.groupId || '', r.memo || '', r.updatedAt || '', r.color || ''];
  }
  function fromDb(x) {
    return {
      id: x.id, date: x.date, roomId: x.room_id, start: x.st, end: x.en, affiliation: x.affiliation, name: x.name, pin: x.pin,
      createdAt: x.created_at, groupId: x.group_id, memo: x.memo, updatedAt: x.updated_at, color: x.color,
    };
  }
  /** スプレッドシートの行（表示どおりの文字）を、正本の形にそろえる（gas/Code.gs の readReservations_ と同じ） */
  function fromSheetRow(r) {
    const c = (i) => str(r[i]);
    return {
      id: c(0), date: normDate(r[1]), roomId: c(2), start: normTime(r[3]), end: normTime(r[4]), affiliation: c(5), name: c(6),
      pin: normPin(r[7]), createdAt: c(8), groupId: c(9), memo: c(10), updatedAt: c(11),
      color: RESERVATION_COLORS.indexOf(c(12)) >= 0 ? c(12) : '',
    };
  }
  function toPublic(r) {
    return {
      id: r.id, date: r.date, roomId: r.roomId, start: r.start, end: r.end,
      affiliation: r.affiliation, name: r.name, memo: r.memo || '', groupId: r.groupId || '',
      hasPin: !!r.pin, color: r.color || '',
    };
  }
  function roomRow(r) { return [r.order, r.id, r.name, r.equipment, r.restriction, r.note, r.tags]; }
  function closureOf(date, roomId, start, end, reason) {
    const s = normTime(start);
    const e = normTime(end);
    const allDay = !isTime(s) || !isTime(e) || toMin(s) >= toMin(e);
    return { date: normDate(date), roomId: str(roomId), allDay, start: allDay ? '' : s, end: allDay ? '' : e, reason: str(reason) };
  }
  function describe(r) { return hm(r.start) + '〜' + hm(r.end) + ' ' + (r.affiliation ? r.affiliation + ' ' : '') + r.name; }

  // ---------------------------------------------------------------------------
  // 日付・時刻（日本時間）
  // ---------------------------------------------------------------------------

  function str(v) { return String(v == null ? '' : v).trim(); }
  function normDate(v) {
    const s = str(v);
    const m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    return m ? m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]) : s;
  }
  function normTime(v) {
    const s = str(v);
    const m = s.match(/^(\d{1,2}):(\d{2})/);
    return m ? pad2(m[1]) + ':' + m[2] : s;
  }
  function normPin(v) {
    const s = str(v);
    return /^\d{1,4}$/.test(s) ? ('0000' + s).slice(-4) : s;
  }
  function isValidDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const p = s.split('-').map(Number);
    const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
  }
  function isTime(t) { return /^\d{2}:\d{2}$/.test(t) && toMin(t) <= 24 * 60 && Number(t.slice(3)) < 60; }
  function toMin(t) {
    const m = String(t).match(/^(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  }
  function hm(t) { return String(t).replace(/^0(\d)/, '$1'); }
  function pad2(n) { return ('0' + n).slice(-2); }
  function weekday(dateStr) {
    const p = dateStr.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
  }
  function addDays(dateStr, n) {
    const p = dateStr.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
  }
  function daysBetween(a, b) {
    const pa = a.split('-').map(Number);
    const pb = b.split('-').map(Number);
    return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
  }
  function durationText(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return (h ? h + '時間' : '') + (m ? m + '分' : '');
  }
  function isPast(date, endTime) { return (date + ' ' + endTime) <= nowStr('yyyy-MM-dd HH:mm'); }
  /** 日本時間の今。pattern は 'yyyy-MM-dd' / 'yyyy-MM-dd HH:mm' / 'yyyy-MM-dd HH:mm:ss' */
  function nowStr(pattern) {
    const iso = new Date(Date.now() + 9 * 3600 * 1000).toISOString(); // 2026-10-10T21:30:05.123Z
    const t = iso.slice(0, 10) + ' ' + iso.slice(11, 19);
    return pattern === 'yyyy-MM-dd' ? t.slice(0, 10) : pattern === 'yyyy-MM-dd HH:mm' ? t.slice(0, 16) : t;
  }
  function uuid() {
    return crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  function newId(prefix) { return prefix + '_' + Date.now() + '_' + uuid().slice(0, 8); }
  function fail(message, code) { return { ok: false, code: code || 'ERROR', message }; }
  function withVersion(res) { res.apiVersion = API_VERSION; return res; }

  // ---------------------------------------------------------------------------
  // 合言葉・パスワード
  // ---------------------------------------------------------------------------

  function safeEqual(a, b) {
    a = String(a); b = String(b);
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }
  function b64url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  async function hmac(key, message) {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message))));
  }
  async function pbkdf2(password, salt, rounds) {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds }, k, 256);
    return b64url(new Uint8Array(bits));
  }
  /** 管理用パスワードを、元に戻せない形にする（「pbkdf2$回数$塩$結果」） */
  async function hashPassword(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    return 'pbkdf2$' + SYSTEM.PBKDF2_ROUNDS + '$' + b64url(salt) + '$' + await pbkdf2(password, salt, SYSTEM.PBKDF2_ROUNDS);
  }
  async function checkPassword(password, stored) {
    const m = /^pbkdf2\$(\d+)\$([\w-]+)\$([\w-]+)$/.exec(stored);
    if (!m) return false;
    const t = m[2].replace(/-/g, '+').replace(/_/g, '/');
    const salt = Uint8Array.from(atob(t + '==='.slice((t.length + 3) % 4)), (c) => c.charCodeAt(0));
    return safeEqual(await pbkdf2(password, salt, Number(m[1])), m[3]);
  }

  // ---------------------------------------------------------------------------
  // HTTP の入口（Cloudflare の Durable Object と、手元のテスト環境で共通）
  // ---------------------------------------------------------------------------

  /**
   * @param core StoreCore
   * @param req {method, path, query: URLSearchParams, auth: string, body: object}
   * @returns {status, body}
   */
  async function handleHttp(core, req) {
    if (req.path === '/api' && req.method === 'POST') return { status: 200, body: await core.api(req.body) };
    return routeSync(core, req);
  }

  /** /api 以外（待ちのない処理）。手元のテスト環境では、GAS の UrlFetchApp（待たずに結果を返す）からこれを呼ぶ */
  function routeSync(core, req) {
    if (req.path === '/schedule' && req.method === 'GET') {
      const res = core.publicSchedule(req.query.get('from') || '', req.query.get('to') || req.query.get('from') || '');
      return { status: 200, body: res || { ok: false, code: 'MISS' } };
    }
    // ここから下は GAS 専用（合言葉が要る）
    const token = String(core.env.PUSH_TOKEN || '').trim();
    if (!token || !safeEqual(req.auth || '', 'Bearer ' + token)) return { status: 401, body: { ok: false, code: 'UNAUTHORIZED' } };
    if (req.path === '/migrate' && req.method === 'POST') return { status: 200, body: core.sync(String(req.body.op || ''), req.body) };
    if (req.path === '/mirror/changes' && req.method === 'GET') return { status: 200, body: core.sync('changes', { after: req.query.get('after') }) };
    if (req.path === '/mirror/full' && req.method === 'GET') return { status: 200, body: core.sync('full') };
    if (req.path === '/store/status' && req.method === 'GET') return { status: 200, body: core.sync('status') };
    return { status: 404, body: { ok: false, code: 'NOT_FOUND' } };
  }

  g.StoreCore = StoreCore;
  g.StoreCore.handleHttp = handleHttp;
  g.StoreCore.routeSync = routeSync;
})(globalThis);
