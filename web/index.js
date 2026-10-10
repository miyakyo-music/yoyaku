// 予約表（index.html）の動き。HTML の最後で config.js・api.js のあとに読み込む。
// 「// ---------------- 名前 ----------------」の見出しで区切ってある。主な見出し:
//   汎用 / この端末で作成した予約 / API呼び出し / 表示範囲 / 予約データの取得とキャッシュ /
//   ガラスの見た目の補助 / 光の屈折 / 描画 / タイムライン操作 / 時間軸の拡大・縮小 / 詳細カード /
//   予約・変更ダイアログ / 詳細ダイアログ / この端末の予約一覧 / 閲覧パスワード / 限定公開の部屋 /
//   イベント / お知らせをその場で変更 / 自動更新 / 不具合報告 / 起動
(() => {
  'use strict';

  const LS = {
    profile: 'prr.profile',        // { affiliation, name, pin }
    snapshot: 'prr.snapshot',      // { key, res, at }  前回表示した予約表（開いた直後にすぐ出し、裏で最新に差し替える）
    mine: 'prr.myReservations',    // { [reservationId]: 'YYYY-MM-DD' }
    filter: 'prr.equipFilter',
    view: 'prr.view',
    zoom: 'prr.zoom',              // 時間軸の拡大率（ピンチ操作）
    room: 'prr.room',
    viewKey: 'prr.viewKey',
    limitedKey: 'prr.limitedKey',  // 限定公開の部屋（演習室など）のパスワード
    history: 'prr.myHistory',      // { [reservationId]: 'YYYY-MM-DD' } この端末で予約した記録（練習時間の集計用。約13か月残す）
    fav: 'prr.favRooms',           // [roomId] お気に入りの練習室
  };
  const APP_VERSION = window.APP_VERSION; // web/api.js
  const CACHE_TTL_MS = 3 * 60 * 1000; // 取得済みの予約データをこの時間は再取得せずに使う
  const ADMIN_SESSION_KEY = 'prr.adminPw'; // 管理画面と共通（このタブで管理画面にログインしている間は管理者モード）
  const ADMIN_ONLY = '管理者のみ';
  const FAV = '★fav', FAV_EDIT = '★edit'; // 絞り込みの欄の「★ お気に入り」「★ お気に入りを選ぶ…」
  const STOPPED = '使用停止';
  const LIMITED = '限定公開';
  const WEEKDAYS = '日月火水木金土';
  const AUTO_REFRESH_MS = 60 * 1000;
  const LONG_PRESS_MS = 400;
  const MIN_HOUR_W = 16;  // 時間軸を縮めたときの1時間の最小幅（px）
  const MAX_HOUR_W = 480; // 時間軸を広げたときの1時間の最大幅（px）

  const $ = (id) => document.getElementById(id);
  // ダークモード: 端末の設定が途中で変わったら（日没で自動切替など）追従する
  const darkMq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  const applyDark = () => document.documentElement.classList.toggle('dark', /[?&]dark\b/.test(location.search) || (!/[?&]light\b/.test(location.search) && !!(darkMq && darkMq.matches)));
  applyDark();
  if (darkMq && darkMq.addEventListener) darkMq.addEventListener('change', applyDark);
  $('betaBand').hidden = !/beta/i.test(APP_VERSION);
  const state = {
    view: load_(LS.view, 'day'),
    date: todayStr(),
    roomId: load_(LS.room, ''),
    data: null,           // 直近の getSchedule 応答
    settings: null,
    rooms: [],
    rows: [],             // タイムラインの各行（空き判定に使う）
    geo: null,            // タイムラインの時間軸
    seq: 0,
    noCacheUntil: 0,      // この時刻までは高速キャッシュを使わない（自分が書き込んだ直後）
    viewKey: load_(LS.viewKey, ''),
    limitedKey: load_(LS.limitedKey, ''),
    booking: null,        // 予約ダイアログの状態
    zoom: Math.min(10, Math.max(0.05, Number(load_(LS.zoom, 1)) || 1)), // 時間軸の拡大率
    hourBase: 0, hourMin: MIN_HOUR_W, hourW: 0,
    detail: null,
    skipConflicts: false,
    adminPw: sessionGet(ADMIN_SESSION_KEY),
    cache: new Map(),     // 期間（"from|to"）→ { res, at }  取得済みの予約データ
    cacheGen: 0,          // キャッシュを破棄した回数（破棄前に始まった取得結果を保存しないため）
    inflight: new Map(),  // 取得中の期間 → Promise
    shownKey: '',         // いま表示しているデータの表示形式と期間
    pending: [],          // 楽観的に画面へ反映した新規予約 { r, status: 'sending' | 'done' }
    hidden: new Map(),    // 楽観的に画面から消した予約 id → 予約日
    lastError: '',
  };

  // ---------------- 汎用 ----------------
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function todayStr() { return fmtDate(new Date()); }
  function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return fmtDate(d); }
  /** nか月後の同じ日（その月に無い日なら月末） */
  function addMonths(s, n) {
    const d = parseDate(s);
    const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate();
    return fmtDate(new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last)));
  }
  function monthStart(s) { return s.slice(0, 8) + '01'; }
  function toMin(t) { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; }
  function toHHMM(min) { return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`; }
  function hm(t) { return String(t).replace(/^0(\d)/, '$1'); }
  function nowMin() { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); }
  function weekday(s) { return parseDate(s).getDay(); }
  function dayClass(s) { const w = weekday(s); return w === 6 ? 'sat' : w === 0 ? 'sun' : ''; }
  function mdLabel(s) { const d = parseDate(s); return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`; }
  function fullDateLabel(s) { const d = parseDate(s); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${WEEKDAYS[d.getDay()]})`; }
  function durationLabel(min) {
    const h = Math.floor(min / 60), m = min % 60;
    return h && m ? `${h}時間${m}分` : h ? `${h}時間` : `${m}分`;
  }
  function floorTo(m, u) { return Math.floor(m / u) * u; }
  function ceilTo(m, u) { return Math.ceil(m / u) * u; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function load_(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function save_(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 保存できない環境では無視 */ }
  }
  function sessionGet(key) { try { return sessionStorage.getItem(key) || ''; } catch (e) { return ''; } }
  function isAdminMode() { return !!state.adminPw; }
  function exitAdminMode(message) {
    state.adminPw = '';
    try { sessionStorage.removeItem(ADMIN_SESSION_KEY); } catch (e) { /* 無視 */ }
    $('adminMode').hidden = true;
    if (message) toast(message, 'error');
  }

  /** 部屋の表示名（特徴タグ付き）: 選択肢や詳細表示で使う。例「練習室16（大・GP）」 */
  function roomText(room) {
    if (!room) return '';
    return room.tags ? `${room.name}（${room.tags}）` : room.name;
  }
  function tagList(tags) { return String(tags || '').split(/[・、,，\s／/]+/).filter(Boolean); }
  function tagClass(t) {
    if (/電子/.test(t)) return 't-ep';
    if (/GP/i.test(t)) return 't-gp';
    if (/UP/i.test(t)) return 't-up';
    if (/^大/.test(t)) return 't-large';
    return '';
  }

  let toastTimer;
  function toast(message, type, ms) {
    if (type === 'error') state.lastError = `${new Date().toLocaleString('ja-JP')} ${message}`;
    const el = $('toast');
    el.textContent = message;
    el.className = 'toast show' + (type === 'error' ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, ms || (type === 'error' ? 5000 : 2800));
  }

  // ---------------- この端末で作成した予約 ----------------
  function getMine() { return load_(LS.mine, {}); }
  function isMine(id) { return Object.prototype.hasOwnProperty.call(getMine(), id); }
  function addMine(list) {
    const mine = getMine();
    const limit = addDays(todayStr(), -7);
    for (const k of Object.keys(mine)) if (mine[k] < limit) delete mine[k];
    for (const r of list) mine[r.id] = r.date;
    save_(LS.mine, mine);
    addHistory(list);
  }
  function removeMine(ids) { const mine = getMine(); ids.forEach((id) => delete mine[id]); save_(LS.mine, mine); }
  // 練習時間の集計用の記録。「自分の予約」は終わって7日で消すが、こちらは約13か月残す
  // （取り消しは、集計のときにサーバーから読み直して除く）
  function addHistory(list) {
    const h = load_(LS.history, {});
    const limit = addDays(todayStr(), -400);
    for (const k of Object.keys(h)) if (h[k] < limit) delete h[k];
    for (const r of list) h[r.id] = r.date;
    save_(LS.history, h);
  }
  addHistory(Object.entries(getMine()).map(([id, date]) => ({ id, date }))); // この記録を作る前の予約も入れておく
  const getFavs = () => new Set(load_(LS.fav, []));

  // ---------------- API呼び出し ----------------
  class AuthError extends Error {}
  async function api(fn, payload) {
    const body = Object.assign({}, payload, { viewKey: state.viewKey });
    if (state.limitedKey && !body.limitedKey) body.limitedKey = state.limitedKey;
    // 管理者モードでは読み込みにも管理用パスワードを添える（限定公開の部屋も表示するため）
    const adminOps = ['getSchedule', 'getReservationsByIds', 'createReservation', 'createBulkReservations', 'updateReservation', 'cancelReservation', 'adminSetNotice'];
    if (state.adminPw && adminOps.includes(fn) && !body.adminPassword) body.adminPassword = state.adminPw;
    const res = await callApi(fn, body); // web/api.js
    // 予約・変更・取消などの書き込みが通ったら、しばらくは高速キャッシュを使わずサーバーから読む
    if (res && res.ok && fn !== 'getSchedule' && fn !== 'getReservationsByIds') state.noCacheUntil = Date.now() + 2 * 60 * 1000;
    if (res && res.code === 'AUTH_REQUIRED') { showLogin(res.message); throw new AuthError(res.message); }
    if (res && !res.ok && state.adminPw && /管理用パスワード/.test(res.message || '')) {
      exitAdminMode('管理者モードを終了しました（管理用パスワードが変更された可能性があります）。');
    }
    return res;
  }
  function errMessage(e) { return (e && e.message) || String(e) || '通信に失敗しました。'; }

  // ---------------- 表示範囲 ----------------
  function currentRange() { return rangeFor(state.view, state.date); }
  function rangeFor(view, date) {
    // 部屋別: 選んだ日から1か月分（例：10/8〜11/7）
    if (view === 'room') return { from: date, to: addDays(addMonths(date, 1), -1) };
    if (view === 'month') {
      const first = parseDate(monthStart(date));
      const from = addDays(fmtDate(first), -first.getDay());
      const last = parseDate(addDays(monthStart(addMonths(date, 1)), -1));
      return { from, to: addDays(fmtDate(last), 6 - last.getDay()) };
    }
    return { from: date, to: date };
  }

  // ---------------- 予約データの取得とキャッシュ ----------------
  function rangeKey(r) { return `${r.from}|${r.to}`; }

  /**
   * 予約表のデータを読む。高速キャッシュ（Cloudflare）が使えるときはそこから、使えないときは GAS から。
   * 管理者モード・限定公開、そして自分が予約・変更した直後（2分間）は、必ず GAS から読む
   * （写しの更新が遅れていても、自分の変更が消えて見えないように）
   */
  async function getScheduleFast(range) {
    const usable = window.CACHE_API_URL && !state.adminPw && !state.limitedKey && Date.now() > state.noCacheUntil;
    if (usable) {
      const res = await fetchCacheSchedule(range); // web/api.js
      if (res) { setDataSource('cache'); return res; }
    }
    const res = await api('getSchedule', range);
    if (res && res.ok) setDataSource('gas');
    return res;
  }
  /** どちらから読んだかを、更新ボタンの説明（マウスを乗せると出る文字）に書いておく（不具合の切り分け用） */
  function setDataSource(src) {
    $('refreshBtn').title = '押すと最新の予約に更新します（読み込み元: ' + (src === 'cache' ? '高速キャッシュ' : 'サーバー') + '）';
  }

  /** GAS から期間の予約データを取得してキャッシュに入れる（同じ期間を取得中なら、その結果を共用する） */
  function fetchRange(range, force) {
    const key = rangeKey(range);
    if (!force && state.inflight.has(key)) return state.inflight.get(key);
    const gen = state.cacheGen;
    const p = getScheduleFast(range).then((res) => {
      if (!res || !res.ok) throw new Error(res && res.message);
      if (gen === state.cacheGen) state.cache.set(key, { res, at: Date.now() });
      return res;
    });
    state.inflight.set(key, p);
    p.catch(() => {}).then(() => { if (state.inflight.get(key) === p) state.inflight.delete(key); });
    return p;
  }

  /** 指定した日を含むキャッシュを捨てる（日付を省略するとすべて） */
  function invalidate(dates) {
    state.cacheGen++;
    for (const key of [...state.cache.keys()]) {
      const [from, to] = key.split('|');
      if (!dates || dates.some((d) => d >= from && d <= to)) state.cache.delete(key);
    }
  }

  /**
   * いまの表示に必要なデータを表示する。キャッシュがあれば通信せずに即座に描画する。
   * @param {{force?:boolean, then?:Function}} opts force: キャッシュを使わず取り直す
   */
  async function load(opts) {
    opts = opts || {};
    const seq = ++state.seq;
    const range = currentRange();
    const key = rangeKey(range);
    const hit = state.cache.get(key);
    if (!opts.force && hit && Date.now() - hit.at < CACHE_TTL_MS) {
      document.body.classList.remove('loading');
      show(hit, key);
      afterShow(opts);
      return;
    }
    // 開いた直後: 前回と同じ表示なら、端末に覚えておいた予約表をすぐ出し、最新の取得は裏で行って差し替える
    if (!state.data && !hit && !state.skipSnapshot) {
      const snap = load_(LS.snapshot, null);
      if (snap && snap.key === `${state.view}|${key}` && Date.now() - snap.at < 24 * 3600 * 1000) {
        show({ res: snap.res, at: snap.at }, key);
        $('statusText').textContent = '更新中…';
        opts = Object.assign({}, opts, { background: true });
      }
    }
    // 管理者モード・限定公開は、限定公開の部屋も出すために GAS から読む（2〜4秒かかる）。待たせないよう、
    // 高速キャッシュの写しがあれば先にそれを出し（限定公開の部屋は後から現れる）、GAS の結果で差し替える
    let quick = false;
    if (!hit && !opts.background && (state.adminPw || state.limitedKey) && !state.limitedEntry && window.CACHE_API_URL && Date.now() > state.noCacheUntil) {
      let res = await fetchCacheSchedule(range).catch(() => null); // web/api.js
      if (seq !== state.seq) return;
      if (res && res.ok) {
        // 写しには無い札の情報（限定公開を表示中か・不具合の件数）は、今の表示のものを引き継ぐ
        res = Object.assign({}, res, { limitedAccess: !!state.limitedKey, openBugs: state.data ? state.data.openBugs : 0 });
        show({ res, at: Date.now() }, key);
        quick = true;
        $('statusText').textContent = '更新中…';
      }
    }
    // 自動更新（opts.background）は裏で取得し、画面を薄くしない
    if (!opts.background && !quick) document.body.classList.add('loading');
    try {
      const res = await fetchRange(range, opts.force);
      if (seq !== state.seq) return; // 表示切替を連続で行った場合は古い応答を捨てる
      const entry = state.cache.get(key) || { res, at: Date.now() };
      if (opts.background) { showInBackground(entry, key, seq); return; }
      show(entry, key);
      afterShow(opts);
    } catch (e) {
      if (opts.background) return; // 自動更新の失敗は知らせない（次の更新で取り直す）
      if (seq === state.seq && !(e instanceof AuthError)) {
        toast(errMessage(e), 'error');
        if (!state.data) $('main').innerHTML = `<p class="empty">${esc(errMessage(e))}</p>`;
      }
    } finally {
      if (seq === state.seq) document.body.classList.remove('loading');
    }
  }

  function show(entry, key) {
    const res = entry.res;
    const shownKey = `${state.view}|${key}`;
    const keyChanged = state.shownKey !== shownKey;
    state.shownKey = shownKey;
    if (res.limitedDenied && state.limitedKey) endLimited('限定公開の部屋のパスワードが変更されたため、表示を終了しました。');
    if (state.limitedEntry && res.ok) {
      // 入口の URL から来たとき: 見られれば設備の絞り込みを演習室などに合わせ、見られなければパスワードを尋ねる
      state.limitedEntry = false;
      if (res.limitedAccess) focusLimitedRooms(res.rooms);
      else { $('limPass').value = ''; $('limError').textContent = ''; $('limitedDialog').showModal(); }
    }
    $('limitedMode').hidden = !(state.limitedKey && res.limitedAccess);
    // 管理者モードでは、未対応の不具合報告の件数を「管理」に出す
    const bugs = isAdminMode() ? Number(res.openBugs) || 0 : 0;
    $('bugBadge').hidden = !bugs;
    $('bugBadge').textContent = bugs > 99 ? '99+' : String(bugs);
    $('adminLink').setAttribute('aria-label', bugs ? `管理画面（未対応・対応中の不具合報告 ${bugs} 件）` : '管理画面');
    state.data = res;
    state.settings = res.settings;
    state.rooms = res.rooms;
    // サーバーの台帳に反映された楽観的更新を片付ける
    const ids = new Set(res.reservations.map((r) => r.id));
    state.pending = state.pending.filter((p) => p.status === 'sending' || !ids.has(p.r.id));
    for (const [id, date] of state.hidden) if (date >= res.from && date <= res.to && !ids.has(id)) state.hidden.delete(id);
    applySettings();
    render();
    if (keyChanged) scrollToNow();
    const t = new Date(entry.at);
    $('statusText').textContent = `${t.getHours()}:${pad(t.getMinutes())} 更新`;
    // 次に開いたときにすぐ出せるよう、端末に覚えておく（閲覧パスワードが必要な予約表では覚えない）
    if (!res.settings.viewPasswordRequired) save_(LS.snapshot, { key: shownKey, res, at: entry.at });
  }

  /**
   * 自動更新の結果を反映する。内容が変わっていなければ描き直さず、
   * 操作中（スクロール・タップ・ピンチ・入力など）なら、操作が終わるまで待ってから描き直す。
   */
  function showInBackground(entry, key, seq) {
    const sig = (r) => JSON.stringify([r.reservations, r.closures, r.rooms, r.settings]);
    if (state.data && state.shownKey === `${state.view}|${key}` && sig(entry.res) === sig(state.data)) {
      const t = new Date(entry.at);
      $('statusText').textContent = `${t.getHours()}:${pad(t.getMinutes())} 更新`;
      return;
    }
    const tryShow = () => {
      if (seq !== state.seq) return; // その間に別の日付・表示へ移った
      if (userBusy()) { setTimeout(tryShow, 500); return; }
      show(entry, key);
    };
    tryShow();
  }

  function afterShow(opts) {
    if (opts.then) opts.then();
    prefetchNext();
  }

  /** 「‹」「›」で次に開きそうな前後の期間を裏で取得しておき、押したときにすぐ表示できるようにする
   * （一覧は前日・翌日、部屋別・カレンダーは前月・翌月）。翌日（翌月）を先に取る */
  function prefetchNext() {
    const step = state.view === 'day' ? (d, n) => addDays(d, n) : (d, n) => addMonths(d, n);
    for (const dir of [1, -1]) {
      const range = rangeFor(state.view, step(state.date, dir));
      const hit = state.cache.get(rangeKey(range));
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) continue;
      fetchRange(range).catch(() => { /* 先読みの失敗は無視（表示時に取り直す） */ });
    }
  }

  /** 表示中の予約（サーバーのデータ + 送信中・確定直後の予約 − 取消中の予約） */
  function visibleReservations() {
    const { from, to, reservations } = state.data;
    const ids = new Set(reservations.map((r) => r.id));
    const list = reservations.filter((r) => !state.hidden.has(r.id));
    for (const p of state.pending) if (p.r.date >= from && p.r.date <= to && !ids.has(p.r.id)) list.push(p.r);
    return list;
  }

  function applySettings() {
    const s = state.settings;
    $('title').textContent = s.title;
    document.title = s.title;
    // お知らせを書き換えている間は、裏の自動更新で入力中の内容を消さない
    if (!state.noticeEditing) {
      $('noticeRow').hidden = !s.notice;
      $('noticeText').textContent = s.notice || '';
      $('notice').classList.toggle('important', s.noticeLevel === '重要');
    }
    $('notice').classList.toggle('editable', isAdminMode());
    $('notice').title = isAdminMode() ? '押すとお知らせを変更できます' : '';
    $('adminMode').hidden = !isAdminMode();

    const eq = $('equipFilter');
    const kinds = [...new Set(state.rooms.map((r) => r.equipment).filter(Boolean))];
    // 入口の URL から来た直後だけ、限定公開の部屋の設備区分（例：演習室）で絞り込む（端末には記憶しない）。
    // 記憶されている絞り込みが限定公開の部屋にしかない設備区分なら、次からは使わない
    const limitedOnly = (k) => state.rooms.some((r) => r.equipment === k) && state.rooms.every((r) => r.equipment !== k || r.restriction === LIMITED);
    let curEq = load_(LS.filter, '');
    if (curEq && limitedOnly(curEq)) { curEq = ''; save_(LS.filter, ''); }
    if (state.equipOnce) curEq = state.equipOnce;
    const allLabel = window.matchMedia && matchMedia('(max-width: 600px)').matches ? '全設備' : 'すべての設備'; // スマホでは欄が狭いので短く
    // お気に入り（端末に保存）で絞り込む。「★ お気に入りを選ぶ…」で部屋を選ぶ
    eq.innerHTML = `<option value="">${allLabel}</option><option value="${FAV}">★ お気に入り</option>` +
      kinds.map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join('') + `<option value="${FAV_EDIT}">★ お気に入りを選ぶ…</option>`;
    eq.value = kinds.includes(curEq) || curEq === FAV ? curEq : '';

    const rs = $('roomSelect');
    const allOpt = state.view === 'month' ? '<option value="">すべての部屋</option>' : '';
    rs.innerHTML = allOpt + state.rooms.map((r) => `<option value="${esc(r.id)}">${esc(roomText(r))}</option>`).join('');
    if (state.view === 'room' && !state.rooms.some((r) => r.id === state.roomId)) state.roomId = state.rooms[0] ? state.rooms[0].id : '';
    rs.value = state.roomId;
    if (rs.value !== state.roomId) rs.value = '';
  }

  /** 日付欄の表示（例：2026/10/09(金) とカレンダーのアイコン） */
  function dateDisplayHtml(date) {
    if (!date) return '<span>日付を選択</span>';
    const dd = parseDate(date);
    const w = dd.getDay();
    return `<span><span class="yr">${dd.getFullYear()}/</span>${pad(dd.getMonth() + 1)}/${pad(dd.getDate())}` +
      `<span class="${w === 6 ? 'sat' : w === 0 ? 'sun' : ''}">(${WEEKDAYS[w]})</span></span>` +
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/></svg>';
  }

  // ---------------- ガラスの見た目の補助 ----------------
  // 表示の切り替えのつまみ（.seg::before）を、選択中のボタンの位置・幅に合わせる（CSS の transition で滑る）
  // 最初に置くときだけは滑らせない
  function placeSegThumb() {
    for (const seg of document.querySelectorAll('.seg')) {
      const on = seg.querySelector('[aria-pressed="true"]');
      if (!on) continue;
      seg.classList.toggle('no-anim', !seg.style.getPropertyValue('--thumb-w'));
      seg.style.setProperty('--thumb-x', `${on.offsetLeft}px`);
      seg.style.setProperty('--thumb-w', `${on.offsetWidth}px`);
    }
  }
  // 上部のガラスの帯の高さを実測し、予約表をその下に潜り込ませる余白（--hdr-h）にする
  function measureHeader() {
    const h = document.querySelector('.topbar').offsetHeight;
    document.documentElement.style.setProperty('--hdr-h', `${h}px`);
    // 切り替えで上部の高さが変わったときもここに来る。つまみは止めずに滑らせたまま位置を合わせ直す
    placeSegThumb();
  }
  if (window.ResizeObserver) new ResizeObserver(measureHeader).observe(document.querySelector('.topbar'));
  window.addEventListener('resize', measureHeader);

  // ---------------- 光の屈折（ガラスの縁で、下の予約表が曲がって見える） ----------------
  // 縁の近くほど強く内側の像を引き込む「ずらし地図」を Canvas で作り、SVG フィルタ（feDisplacementMap）として
  // backdrop-filter に使う。これに対応しているのは Chrome・Edge などだけ。Safari（iPhone）では今まで通りぼかしのみ。
  const canRefract = !!(navigator.userAgentData && navigator.userAgentData.brands.some((b) => /Chromium/.test(b.brand)))
    && !matchMedia('(prefers-reduced-transparency: reduce)').matches;
  if (canRefract) {
    document.documentElement.classList.add('refract');
    const NS = 'http://www.w3.org/2000/svg';
    const defs = document.createElementNS(NS, 'svg');
    defs.setAttribute('width', '0'); defs.setAttribute('height', '0'); defs.setAttribute('aria-hidden', 'true');
    defs.style.position = 'absolute';
    document.body.appendChild(defs);

    // 角丸の四角の内側で、縁からの距離に応じた「内向きのずれ」を赤（横）・緑（縦）に入れた画像
    function lensMap(w, h, radius, bezel) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(w, h);
      const hw = w / 2, hh = h / 2, r = Math.min(radius, hw, hh);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          // 角丸の四角までの符号付き距離（内側が負）と、外向きの向き
          const px = x + 0.5 - hw, py = y + 0.5 - hh;
          const qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r);
          let nx, ny, dist;
          if (qx > 0 && qy > 0) { const l = Math.hypot(qx, qy) || 1; dist = l - r; nx = qx / l; ny = qy / l; }
          else if (qx > qy) { dist = qx - r; nx = 1; ny = 0; }
          else { dist = qy - r; nx = 0; ny = 1; }
          nx *= Math.sign(px) || 1; ny *= Math.sign(py) || 1;
          const d = -dist; // 縁からの深さ
          const k = d < bezel ? Math.pow(1 - Math.max(0, d) / bezel, 2) : 0;
          const i = (y * w + x) * 4;
          img.data[i] = 128 - nx * k * 127;     // 内側の像を引き込む
          img.data[i + 1] = 128 - ny * k * 127;
          img.data[i + 2] = 128;
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return c.toDataURL();
    }

    const lenses = new Map(); // 要素 → { id, w, h }
    let seq = 0;
    function applyLens(el, { radius, bezel, strength, blur }) {
      const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
      if (!w || !h) return;
      let L = lenses.get(el);
      if (L && L.w === w && L.h === h) return;
      if (!L) { L = { id: `lens${++seq}` }; lenses.set(el, L); }
      L.w = w; L.h = h;
      defs.querySelector(`#${L.id}`)?.remove();
      const f = document.createElementNS(NS, 'filter');
      f.id = L.id;
      f.setAttribute('x', '0'); f.setAttribute('y', '0'); f.setAttribute('width', String(w)); f.setAttribute('height', String(h));
      f.setAttribute('filterUnits', 'userSpaceOnUse'); f.setAttribute('color-interpolation-filters', 'sRGB');
      f.innerHTML = `<feImage href="${lensMap(w, h, radius, bezel)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map"/>` +
        `<feDisplacementMap in="SourceGraphic" in2="map" scale="${strength}" xChannelSelector="R" yChannelSelector="G"/>`;
      defs.appendChild(f);
      el.style.setProperty('backdrop-filter', `url(#${L.id}) blur(${blur}px) saturate(180%)`);
    }
    const LENS = {
      topbar: { radius: 0, bezel: 30, strength: 80, blur: 3 },
      dialog: { radius: 22, bezel: 34, strength: 90, blur: 5 },
      card: { radius: 14, bezel: 22, strength: 60, blur: 2 },
    };
    const topbar = document.querySelector('.topbar');
    const refreshLenses = () => {
      applyLens(topbar, LENS.topbar);
      for (const d of document.querySelectorAll('dialog[open]')) applyLens(d, LENS.dialog);
      const hc = $('hoverCard');
      if (!hc.hidden) applyLens(hc, LENS.card);
    };
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(refreshLenses);
      ro.observe(topbar);
      for (const d of document.querySelectorAll('dialog')) ro.observe(d);
      ro.observe($('hoverCard'));
    }
    new MutationObserver(refreshLenses).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open', 'hidden'] });
    refreshLenses();
  }

  function updateChrome() {
    for (const b of document.querySelectorAll('.tabs .btn')) b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
    placeSegThumb();
    // 矢印だけのボタンなので、何日（何か月）動くかは説明と読み上げで伝える
    const [prev, next] = state.view === 'day' ? ['前日', '翌日'] : ['前月', '翌月'];
    $('prevBtn').title = prev; $('prevBtn').setAttribute('aria-label', prev);
    $('nextBtn').title = next; $('nextBtn').setAttribute('aria-label', next);
    $('datePicker').value = state.date;
    $('dateDisplay').innerHTML = dateDisplayHtml(state.date);
    // 「今日」は、今日（カレンダーでは今月）を表示しているときだけ青、それ以外は黒
    const t = todayStr();
    $('todayBtn').classList.toggle('on-today', state.view === 'month' ? monthStart(state.date) === monthStart(t) : state.date === t);
    $('equipFilter').hidden = state.view !== 'day';
    $('freeBtn').hidden = state.view !== 'day';
    if (state.freeNow && (state.view !== 'day' || state.date !== todayStr())) state.freeNow = false;
    $('freeBtn').setAttribute('aria-pressed', String(!!state.freeNow));
    $('roomSelect').hidden = state.view === 'day';
    const label = $('rangeLabel');
    const d = parseDate(state.date);
    if (state.view === 'day') {
      label.textContent = `${d.getMonth() + 1}月${d.getDate()}日(${WEEKDAYS[d.getDay()]})`;
      label.className = 'range-label redundant';
    } else if (state.view === 'room') {
      const { from, to } = currentRange();
      label.textContent = `${mdLabel(from)}〜${mdLabel(to)}`;
      label.className = 'range-label redundant';
    } else {
      label.textContent = `${d.getFullYear()}年${d.getMonth() + 1}月`;
      label.className = 'range-label';
    }
  }

  function setDate(s) {
    if (!s) return;
    state.date = s;
    updateChrome();
    load();
  }

  function setView(view) {
    state.view = view;
    save_(LS.view, view);
    if (view === 'room' && !state.roomId && state.rooms[0]) state.roomId = state.rooms[0].id;
    if (state.data) applySettings();
    updateChrome();
    load();
  }

  function shift(dir) {
    state.slide = dir; // 次の描画で、表を進む向きからすべり込ませる
    if (state.view === 'day') setDate(addDays(state.date, dir));
    else if (state.view === 'room') setDate(addMonths(state.date, dir));
    else setDate(addMonths(state.date, dir));
  }

  // ---------------- 帯と小窓をつなぐ動き（View Transitions） ----------------
  // 予約の帯を押すと、その帯が形を変えながら小窓になり、閉じると帯へ戻る。予約を確定すると、小窓が新しい帯へ縮む。
  // 対応していない端末（iOS 17 以前など）や「視差効果を減らす」の端末では、今まで通りの開き方・閉じ方になる。
  const VT_OK = typeof document.startViewTransition === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  function onScreen(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  }
  function bandEl(id) { return id ? $('main').querySelector(`.blk.res[data-id="${CSS.escape(id)}"]`) : null; }
  /** from（いまの画面の要素）が、update したあとの getTo() の要素へ形を変えて移る。from が見えていなければ普通に切り替える */
  function morph(from, update, getTo) {
    if (!VT_OK || !onScreen(from)) { update(); return; }
    let to = null;
    from.style.viewTransitionName = 'morph';
    document.body.classList.add('vt-morph');
    document.documentElement.classList.toggle('vt-close', from.tagName === 'DIALOG'); // 小窓 → 帯の向き
    const t = document.startViewTransition(() => {
      from.style.viewTransitionName = '';
      update();
      to = getTo();
      if (to && (to.tagName === 'DIALOG' ? to.open : onScreen(to))) to.style.viewTransitionName = 'morph';
    });
    t.ready.catch(() => {}); // 画面が隠れているときなどは動きだけ省かれる（切り替えそのものは行われる）
    t.finished.finally(() => {
      from.style.viewTransitionName = '';
      if (to) to.style.viewTransitionName = '';
      document.body.classList.remove('vt-morph');
      document.documentElement.classList.remove('vt-close');
    });
  }
  /** 予約の詳細を閉じる（その帯が見えていれば、帯へ縮んで戻る） */
  function closeDetail() {
    const dlg = $('detailDialog');
    if (!dlg.open) return;
    morph(dlg, () => dlg.close(), () => bandEl(state.detail && state.detail.id));
  }

  // ---------------- 描画 ----------------
  function roomById(id) { return state.rooms.find((r) => r.id === id); }
  function isClosedWeekday(date) { return state.settings.closedWeekdays.indexOf(weekday(date)) >= 0; }

  function closuresFor(date, roomId) {
    const s = state.settings;
    const list = state.data.closures
      .filter((c) => c.date === date && (!c.roomId || c.roomId === roomId))
      .map((c) => ({ start: c.allDay ? toMin(s.openTime) : toMin(c.start), end: c.allDay ? toMin(s.closeTime) : toMin(c.end), reason: c.reason || '利用不可' }));
    if (isClosedWeekday(date)) list.push({ start: toMin(s.openTime), end: toMin(s.closeTime), reason: '定休日' });
    return list;
  }

  function render() {
    if (state.view === 'month') renderMonth();
    else renderTimeline();
    // 「‹」「›」で日付（月）を切り替えたときだけ、表を進む向きから軽くすべり込ませる
    if (state.slide) {
      const cls = state.slide > 0 ? 'slide-next' : 'slide-prev';
      state.slide = 0;
      for (const el of $('main').querySelectorAll('.tl-track, .month')) el.classList.add(cls);
    }
  }

  /** 空室ランプ: 今この部屋が 空き / まもなく予約あり / 使用中 / 利用時間外・使用停止 のどれか（今日の一覧のときだけ） */
  const LAMP_TEXT = { free: '空き', soon: 'まもなく予約', busy: '使用中', off: '利用不可' };
  function lampOf(room) {
    if (state.view !== 'day' || !state.data || state.data.from !== todayStr()) return null;
    const s = state.settings;
    const now = nowMin();
    if (room.restriction === STOPPED || now < toMin(s.openTime) || now >= toMin(s.closeTime)) return 'off';
    const today = todayStr();
    const spans = visibleReservations().filter((r) => r.date === today && r.roomId === room.id)
      .map((r) => [toMin(r.start), toMin(r.end), 'busy'])
      .concat(closuresFor(today, room.id).map((c) => [c.start, c.end, 'off']));
    const cur = spans.find(([a, b]) => a <= now && now < b);
    if (cur) return cur[2];
    return spans.some(([a]) => a > now && a - now <= 30) ? 'soon' : 'free';
  }
  function lampHtml(room) {
    const st = lampOf(room);
    return st ? `<i class="lamp lamp-${st}" role="img" aria-label="${LAMP_TEXT[st]}" title="${LAMP_TEXT[st]}"></i>` : '';
  }
  function roomLabelHtml(room, extraHtml) {
    const tags = tagList(room.tags).map((t) => `<span class="tag ${tagClass(t)}">${esc(t)}</span>`);
    if (room.restriction === ADMIN_ONLY) tags.push('<span class="tag t-admin">管理者のみ</span>');
    if (room.restriction === STOPPED) tags.push('<span class="tag t-admin">使用停止</span>');
    if (room.restriction === LIMITED) tags.push('<span class="tag t-limited">限定</span>');
    const title = [roomText(room), room.equipment, room.note].filter(Boolean).join(' / ');
    const name = `<span class="nm" title="${esc(title)}">${esc(room.name)}</span>`;
    // 「○時まで空き」を出すときは、タグを部屋名の横に寄せて2行目に置き、列の幅を節約する
    const body = extraHtml ? `<span class="nm-line">${name}${tags.join('')}</span>${extraHtml}`
      : name + (tags.length ? `<span class="sub">${tags.join('')}</span>` : '');
    // 空室ランプは部屋名とタグの左に置き、欄の上下中央にそろえる（タグの左端は部屋名の左端とそろう）
    const lamp = lampHtml(room);
    return lamp ? `<span class="lbl-lamp">${lamp}<span class="lbl-body">${body}</span></span>` : body;
  }

  function renderTimeline() {
    const s = state.settings;
    const open = toMin(s.openTime), close = toMin(s.closeTime);
    const t0 = floorTo(open, 60), t1 = ceilTo(close, 60), total = t1 - t0;
    state.geo = { open, close, t0, t1, total, unit: s.unitMinutes };
    document.documentElement.style.setProperty('--hours', String(total / 60));
    const pct = (m) => `${((m - t0) / total * 100).toFixed(4)}%`;
    const span = (a, b) => `left:${pct(a)};width:${((b - a) / total * 100).toFixed(4)}%`;
    const today = todayStr();
    const now = nowMin();
    const mine = getMine();

    // 行の構成: 一覧 = 部屋ごと / 部屋別 = 7日分
    let rows;
    let corner;
    if (state.view === 'day') {
      const filter = $('equipFilter').value;
      rows = state.rooms.filter((r) => roomInFilter(r, filter))
        .map((room) => ({ date: state.data.from, room, label: roomLabelHtml(room), cls: '' }));
      if (state.freeNow) {
        // 「空室」: 今から30分以上（閉館が近ければ閉館まで）空いている部屋だけにし、いつまで空いているかを添える
        rows = rows.map((row) => Object.assign(row, { free: freeFromNow(row.room) })).filter((row) => row.free);
        for (const row of rows) {
          const until = row.free.until >= close ? '閉館まで空き' : `${hm(toHHMM(row.free.until))}まで空き`;
          row.label = roomLabelHtml(row.room, `<span class="free-until">${until}</span>`);
        }
      }
      corner = '部屋<span class="lg"> ＼ 時刻</span>'; // スマホでは「部屋」だけにして列を細くする
    } else {
      const room = roomById(state.roomId);
      rows = [];
      for (let date = state.data.from; room && date <= state.data.to; date = addDays(date, 1)) {
        // 日曜日の行の上に区切り線を引き、週のまとまりを分かるようにする
        const cls = (date === today ? ' today' : '') + (weekday(date) === 0 && date !== state.data.from ? ' week-start' : '');
        rows.push({ date, room, label: `<span class="nm ${dayClass(date)}">${esc(mdLabel(date))}</span>`, cls });
      }
      corner = '日付<span class="lg"> ＼ 時刻</span>'; // 部屋名は上の部屋選択欄に表示している
    }

    const all = visibleReservations();
    let html = `<div class="tl"><div class="tl-head"><div class="tl-corner"><span class="corner-text">${corner}</span><button type="button" class="zoom-reset" data-zoom-reset hidden><span class="lg">幅を</span>リセット</button></div><div class="tl-scale">`;
    const nowHourShown = state.view === 'day' && state.data.from === today;
    for (let h = t0; h < t1; h += 60) {
      html += `<span${nowHourShown && now >= h && now < h + 60 ? ' class="now"' : ''}>${h / 60}:00</span>`;
    }
    html += '</div></div>';

    state.rows = rows.map((row, i) => {
      const reservations = all
        .filter((r) => r.date === row.date && r.roomId === row.room.id)
        .sort((a, b) => a.start.localeCompare(b.start));
      const closures = closuresFor(row.date, row.room.id);
      const busy = reservations.map((r) => [toMin(r.start), toMin(r.end)]).concat(closures.map((c) => [c.start, c.end]));
      const stopped = row.room.restriction === STOPPED;

      // 一覧では部屋名を押すと、その部屋の部屋別表示（この日から1か月分）へ移動する。
      // 部屋別では日付を押すと、その日の一覧へ移動する
      const labelAttrs = state.view === 'day'
        ? ` data-room="${esc(row.room.id)}" role="button" tabindex="0" title="${esc(roomText(row.room))} の予約を1か月分表示"`
        : ` data-date="${row.date}" role="button" tabindex="0" title="${esc(mdLabel(row.date))} の一覧を表示"`;
      html += `<div class="tl-row${row.cls}"><div class="tl-label"${labelAttrs}>${row.label}</div>` +
        `<div class="tl-track${stopped ? ' stopped' : ''}" data-i="${i}">`;
      if (open > t0) html += `<div class="blk off" style="${span(t0, open)}"></div>`;
      if (close < t1) html += `<div class="blk off" style="${span(close, t1)}"></div>`;
      if (row.date < today) html += '<div class="past" style="width:100%"></div>';
      else if (row.date === today && now > t0) {
        html += `<div class="past" style="width:${pct(Math.min(now, t1))}"></div>`;
        if (now < t1) html += `<div class="now-line" style="left:${pct(now)}"></div>`;
      }
      for (const c of closures) {
        html += `<div class="blk closed" style="${span(c.start, c.end)}" title="${esc(c.reason)}"><span>${esc(c.reason)}</span></div>`;
      }
      for (const r of reservations) {
        const cls = ['blk', 'res'];
        if (Object.prototype.hasOwnProperty.call(mine, r.id)) cls.push('mine');
        if (r.date < today || (r.date === today && toMin(r.end) <= now)) cls.push('ended');
        if (r.pending) cls.push('mine', 'pending'); // 送信中の予約も自分の予約の色で表示する
        if (RES_COLORS.includes(r.color)) cls.push('c-' + r.color); // 重要な予定の色（自分の予約の青より優先）
        const title = `${hm(r.start)}〜${hm(r.end)} ${personText(r)}${r.memo ? '　' + r.memo : ''}${r.pending ? '（送信中）' : ''}`;
        // 予約者名を太字で先に、学籍番号/所属は2行目に細字で
        html += `<div class="${cls.join(' ')}" data-id="${esc(r.id)}" role="button" tabindex="0" style="${span(toMin(r.start), toMin(r.end))}" aria-label="${esc(title)}">` +
          `<div class="txt"><b>${r.groupId ? '↻' : ''}${esc(r.name)}</b>${r.affiliation ? `<span>${esc(r.affiliation)}</span>` : ''}</div></div>`;
      }
      html += '</div></div>';
      return { date: row.date, roomId: row.room.id, stopped, busy };
    });
    html += '</div>';
    if (!rows.length) {
      const msg = !state.rooms.length ? '部屋が登録されていません（部屋マスタを確認してください）。'
        : state.freeNow ? (now >= close ? '本日の利用時間は終了しました。' : '今すぐ使える部屋はありません。') : '該当する部屋がありません。';
      html += `<p class="empty">${msg}</p>`;
    }
    html += footHtml('');
    $('main').innerHTML = html;
    $('main').classList.add('has-tl');
    fitLabelColumn();
    renderDraft();
  }

  /** 予約表の下端（操作の案内・不具合報告） */
  function footHtml(text) {
    // 「不具合を報告」はフッタに常に出す（試験運用中は上端の帯にも出す）
    return `<footer class="main-foot">${text ? `<p class="foot-text">${esc(text)}</p>` : ''}` +
      `<p class="site-foot"><span>${esc(APP_VERSION)}</span><button type="button" data-bug>不具合を報告</button>` +
      '<a href="privacy.html">プライバシーポリシー</a></p></footer>';
  }

  /**
   * 部屋名（日付）の列幅を、いちばん長い表示内容にぴったり合わせる。極端に長い名前は上限幅で折り返す。
   * 画面が広いときは、時間軸を画面の右端まで広げる。
   */
  function fitLabelColumn() {
    const tl = $('main').querySelector('.tl');
    if (!tl) return;
    tl.classList.add('measuring');
    let max = 0;
    for (const el of tl.querySelectorAll('.tl-corner, .tl-label')) max = Math.max(max, el.offsetWidth);
    // 左上の「幅をリセット」も入る幅にしておく（ピンチの途中で列幅が変わらないように）
    const reset = tl.querySelector('.zoom-reset');
    const resetHidden = reset.hidden;
    reset.hidden = false;
    max = Math.max(max, reset.offsetWidth + 14);
    reset.hidden = resetHidden;
    tl.classList.remove('measuring');
    if (max < 40) return; // 画面が非表示などで計測できないときは既定の幅のまま
    const cap = window.innerWidth <= 600 ? 140 : 240;
    const labelW = Math.min(cap, Math.ceil(max) + 2);
    tl.style.setProperty('--label-w', `${labelW}px`);
    tl.style.removeProperty('--hour-w');
    const base = parseFloat(getComputedStyle(tl).getPropertyValue('--hour-w')) || 96;
    const hours = state.geo ? state.geo.total / 60 : 15;
    const fit = ($('main').clientWidth - labelW - 1) / hours; // 時間軸全体がちょうど画面に入る幅
    state.hourBase = Math.max(base, Math.floor(fit / 2) * 2);
    state.hourMin = Math.max(MIN_HOUR_W, Math.min(state.hourBase, Math.floor(fit / 2) * 2));
    applyHourWidth(state.hourBase * state.zoom);
  }

  /** 時間軸の1時間の幅を設定する。拡大率は「既定の幅（画面に合わせた幅）」に対する比で覚えておく */
  function applyHourWidth(w) {
    const tl = $('main').querySelector('.tl');
    if (!tl || !state.hourBase) return;
    // 1時間の幅は偶数px にして、30分の線が半端な位置でぼやけたり消えたりしないようにする
    const hourW = Math.round(Math.min(MAX_HOUR_W, Math.max(state.hourMin, w)) / 2) * 2;
    tl.style.setProperty('--hour-w', `${hourW}px`);
    tl.classList.toggle('narrow', hourW < 44);
    tl.classList.toggle('tiny', hourW < 28);
    state.hourW = hourW;
    state.zoom = hourW === state.hourBase ? 1 : hourW / state.hourBase;
    // 幅を変えている間は、左上の「部屋 ＼ 時刻」の所に「幅をリセット」を出す
    tl.querySelector('[data-zoom-reset]').hidden = state.zoom === 1;
    tl.querySelector('.corner-text').hidden = state.zoom !== 1;
  }

  /** 画面上の x 座標 clientX にある時刻を、拡大・縮小の後も同じ位置に保つ */
  function zoomAround(clientX, w) {
    const track = $('main').querySelector('.tl-track');
    if (!track || !state.geo) return;
    let rect = track.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    applyHourWidth(w);
    rect = track.getBoundingClientRect();
    $('main').scrollLeft += rect.left + ratio * rect.width - clientX;
  }
  function saveZoom() { save_(LS.zoom, state.zoom); }
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitLabelColumn, 150);
  });

  function renderMonth() {
    const { from, to } = state.data;
    const reservations = visibleReservations();
    const month = state.date.slice(0, 7);
    const today = todayStr();
    const roomId = state.roomId;
    const mine = getMine();
    const byDate = {};
    for (const r of reservations) {
      if (roomId && r.roomId !== roomId) continue;
      (byDate[r.date] = byDate[r.date] || []).push(r);
    }
    let html = '<div class="month">' + [...WEEKDAYS].map((w, i) => `<div class="dow ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</div>`).join('');
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const list = (byDate[d] || []).sort((a, b) => a.start.localeCompare(b.start));
      const allDayClosure = state.data.closures.find((c) => c.date === d && c.allDay && (!c.roomId || c.roomId === roomId));
      const closedLabel = isClosedWeekday(d) ? '定休日' : allDayClosure && (!allDayClosure.roomId || roomId) ? allDayClosure.reason || '利用不可' : '';
      const cls = ['mc', dayClass(d)];
      if (d.slice(0, 7) !== month) cls.push('other');
      if (d === today) cls.push('today');
      if (d === state.date) cls.push('selected');
      if (closedLabel) cls.push('closed-day');
      html += `<div class="${cls.join(' ')}" data-date="${d}" role="button" tabindex="0">` +
        `<div class="d"><span class="n">${Number(d.slice(8))}</span>${closedLabel ? `<small>${esc(closedLabel)}</small>` : ''}</div>`;
      if (roomId) {
        const max = 4;
        html += '<ul>' + list.slice(0, max).map((r) =>
          `<li class="${Object.prototype.hasOwnProperty.call(mine, r.id) ? 'mine' : ''}${RES_COLORS.includes(r.color) ? ' c-' + r.color : ''}" title="${esc(hm(r.start))}〜${esc(hm(r.end))} ${esc(r.affiliation)} ${esc(r.name)}">` +
          `${esc(hm(r.start))} ${esc(r.name || r.affiliation)}</li>`).join('') +
          (list.length > max ? `<li class="more">ほか${list.length - max}件</li>` : '') + '</ul>';
      } else if (list.length) {
        const own = list.filter((r) => Object.prototype.hasOwnProperty.call(mine, r.id)).length;
        html += `<div class="count"><span class="wide-only">予約 </span>${list.length}件</div>` + (own ? `<ul><li class="mine">自分 ${own}件</li></ul>` : '');
      }
      html += '</div>';
    }
    $('main').classList.remove('has-tl');
    $('main').innerHTML = html + '</div>' + footHtml('日付を押すと、その日の一覧を表示します');
  }

  function scrollToNow() {
    const main = $('main');
    if (state.view === 'month' || !state.geo) { main.scrollTop = 0; main.scrollLeft = 0; return; }
    const isToday = state.view === 'day' ? state.data.from === todayStr() : true;
    const track = main.querySelector('.tl-track');
    if (!isToday || !track) { main.scrollLeft = 0; return; }
    const ratio = (nowMin() - state.geo.t0) / state.geo.total;
    main.scrollLeft = Math.max(0, ratio * track.offsetWidth - track.offsetWidth / state.geo.total * 60);
  }

  // ---------------- タイムライン操作（クリック・ドラッグ・長押し） ----------------
  function minuteAt(track, clientX) {
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return state.geo.t0 + ratio * state.geo.total;
  }

  /** 指定時刻を含む空き区間 [開始, 終了]。予約済み・過去・利用不可なら null */
  /**
   * 今の時刻からその部屋が空いている区間 {from, until}。30分以上（閉館が近ければ閉館まで）空いていなければ null。
   * 使用停止の部屋と、管理者モードでないときの「管理者のみ」の部屋は除く。
   */
  function freeFromNow(room) {
    const s = state.settings;
    const open = toMin(s.openTime), close = toMin(s.closeTime);
    if (room.restriction === STOPPED || (room.restriction === ADMIN_ONLY && !isAdminMode())) return null;
    const today = todayStr();
    const from = Math.max(open, ceilTo(nowMin(), s.unitMinutes));
    if (from >= close) return null;
    const busy = visibleReservations().filter((r) => r.date === today && r.roomId === room.id)
      .map((r) => [toMin(r.start), toMin(r.end)])
      .concat(closuresFor(today, room.id).map((c) => [c.start, c.end]));
    let until = close;
    for (const [a, b] of busy) {
      if (a <= from && b > from) return null;
      if (a > from) until = Math.min(until, a);
    }
    return until - from >= Math.min(30, close - from) ? { from, until } : null;
  }

  function freeSpanAt(row, m) {
    const { open, close, unit } = state.geo;
    const today = todayStr();
    if (row.stopped || row.date < today) return null;
    let lo = open, hi = close;
    if (row.date === today) lo = Math.max(lo, ceilTo(nowMin(), unit));
    for (const [s, e] of row.busy) {
      if (m >= s && m < e) return null;
      if (e <= m) lo = Math.max(lo, e);
      if (s > m) hi = Math.min(hi, s);
    }
    return m >= lo && m < hi && hi - lo >= unit ? [lo, hi] : null;
  }

  let drag = null;
  /**
   * ドラッグで新規予約するときの開始の刻み。指の太さで「17:00 のつもりが 17:05」とならないよう、
   * 開始だけは10分（予約単位で割り切れなければ予約単位）のいちばん近い区切りに吸い付かせる。終了は予約単位
   */
  function dragStartStep() {
    const u = state.geo.unit;
    return u <= 10 && 10 % u === 0 ? 10 : u;
  }
  const roundTo = (m, step) => Math.round(m / step) * step;

  // 予約の帯に残っている青い枠（詳細を閉じたあとのフォーカス）を外す
  function blurBlock() {
    const a = document.activeElement;
    if (a && a.closest && a.closest('.blk')) a.blur();
  }
  function beginDrag(track, clientX) {
    clearPick();
    blurBlock();
    const row = state.rows[Number(track.dataset.i)];
    const m = minuteAt(track, clientX);
    const free = freeSpanAt(row, m);
    if (!free) return null;
    const anchor = Math.min(Math.max(roundTo(m, dragStartStep()), free[0]), free[1] - state.geo.unit);
    const ghost = document.createElement('div');
    ghost.className = 'ghost';
    track.appendChild(ghost);
    drag = { track, row, free, anchor, ghost, start: anchor, end: anchor + state.geo.unit };
    updateDrag(clientX);
    return drag;
  }

  function updateDrag(clientX) {
    const { t0, total } = state.geo;
    const unit = state.geo.unit;
    const m = minuteAt(drag.track, clientX);
    let s, e;
    if (m >= drag.anchor) { s = drag.anchor; e = Math.max(drag.anchor + unit, ceilTo(m, unit)); }
    else { s = Math.min(roundTo(m, dragStartStep()), drag.anchor - unit); e = drag.anchor + unit; }
    drag.start = Math.max(s, drag.free[0]);
    drag.end = Math.min(e, drag.free[1]);
    drag.ghost.style.left = `${((drag.start - t0) / total * 100).toFixed(4)}%`;
    drag.ghost.style.width = `${((drag.end - drag.start) / total * 100).toFixed(4)}%`;
    drag.ghost.textContent = `${hm(toHHMM(drag.start))}〜${hm(toHHMM(drag.end))}`;
  }

  function finishDrag() {
    const d = drag;
    drag = null;
    if (!d) return;
    morph(d.ghost, () => {
      d.ghost.remove();
      openBooking({ mode: 'create', roomId: d.row.roomId, date: d.row.date, start: d.start, end: d.end });
    }, () => $('bookDialog'));
  }

  function cancelDrag() { if (drag) { drag.ghost.remove(); drag = null; } }

  /** クリック・タップ: 30分単位の位置から1時間（空きが足りなければ空きの範囲）で予約画面を開く */
  function slotAt(track, clientX) {
    const row = state.rows[Number(track.dataset.i)];
    if (row.stopped) { toast('この部屋は現在使用停止中です。', 'error'); return null; }
    const m = minuteAt(track, clientX);
    const free = freeSpanAt(row, m);
    if (!free) return null;
    const start = Math.max(free[0], floorTo(m, 30));
    const end = Math.min(free[1], start + 60);
    return { mode: 'create', roomId: row.roomId, date: row.date, start, end };
  }
  function tapTrack(track, clientX) {
    const slot = slotAt(track, clientX);
    if (slot) openBooking(slot);
  }

  /**
   * スマホ: タップした所には「仮予約」の帯と「＋予約」を出すだけにし、もう一度その帯をタップしたら予約画面を開く
   * （触れただけで予約画面が開かないようにする）。スクロールしたら帯は消す。
   */
  const PICK_TIMEOUT_MS = 5000; // 「＋予約」の帯は、押されないまましばらくたったら消す
  let pickTimer = null;
  function pickSlot(track, clientX) {
    blurBlock();
    state.pick = slotAt(track, clientX);
    renderDraft();
    clearTimeout(pickTimer);
    if (state.pick) pickTimer = setTimeout(fadePick, PICK_TIMEOUT_MS);
  }
  /** 帯を薄くしてから消す */
  function fadePick() {
    const el = $('main').querySelector('.ghost.pick');
    if (!el) { clearPick(); return; }
    el.classList.add('fading');
    pickTimer = setTimeout(clearPick, 300);
  }
  function clearPick() {
    clearTimeout(pickTimer);
    if (!state.pick) return;
    state.pick = null;
    renderDraft();
  }

  // マウス: 押してそのまま横に動かすと時間指定、動かさなければクリック扱い
  let mouse = null;
  $('main').addEventListener('mousedown', (e) => {
    const track = e.target.closest('.tl-track');
    if (!track || e.button !== 0 || e.target.closest('.blk')) return;
    e.preventDefault();
    mouse = { track, x: e.clientX, dragging: false };
  });
  document.addEventListener('mousemove', (e) => {
    if (!mouse) return;
    if (!mouse.dragging && Math.abs(e.clientX - mouse.x) > 5) {
      mouse.dragging = !!beginDrag(mouse.track, mouse.x);
      if (!mouse.dragging) { mouse = null; return; }
    }
    if (mouse.dragging) updateDrag(e.clientX);
  });
  document.addEventListener('mouseup', () => {
    if (!mouse) return;
    const m = mouse;
    mouse = null;
    if (m.dragging) finishDrag();
    else tapTrack(m.track, m.x);
  });

  // ---------------- 時間軸の拡大・縮小（ピンチ） ----------------
  let pinch = null;
  const touchDist = (ts) => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
  const touchMidX = (ts) => (ts[0].clientX + ts[1].clientX) / 2;
  $('main').addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2 || !$('main').querySelector('.tl')) return;
    // 1本目の指で始めたタップ・長押しは取りやめて、拡大・縮小に切り替える
    if (touch) { clearTimeout(touch.timer); touch = null; }
    cancelDrag();
    pinch = { dist: touchDist(e.touches) || 1, w: state.hourW };
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    zoomAround(touchMidX(e.touches), pinch.w * touchDist(e.touches) / pinch.dist);
  }, { passive: false });
  document.addEventListener('touchend', (e) => {
    if (pinch && e.touches.length < 2) { pinch = null; saveZoom(); }
  });
  document.addEventListener('touchcancel', () => { if (pinch) { pinch = null; saveZoom(); } });
  // iPhone の Safari が独自に行うページの拡大を止める（時間軸の上だけ）
  for (const type of ['gesturestart', 'gesturechange']) {
    $('main').addEventListener(type, (e) => { if ($('main').querySelector('.tl')) e.preventDefault(); }, { passive: false });
  }
  // PC: Ctrl＋ホイール（トラックパッドのピンチも Ctrl＋ホイールとして届く）
  let wheelSaveTimer;
  $('main').addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !$('main').querySelector('.tl')) return;
    e.preventDefault();
    // マウスのホイール1目盛り（deltaY ≒ 100）で約1.35倍。トラックパッドは小刻みに届くので滑らかに変わる
    const dy = Math.max(-60, Math.min(60, e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY));
    zoomAround(e.clientX, state.hourW * Math.exp(-dy * 0.005));
    clearTimeout(wheelSaveTimer);
    wheelSaveTimer = setTimeout(saveZoom, 300);
  }, { passive: false });
  // Mac の Safari: トラックパッドのピンチは gesture イベントで届く
  if (!('ontouchstart' in window)) {
    let gesture = null;
    $('main').addEventListener('gesturestart', (e) => { gesture = { w: state.hourW }; });
    $('main').addEventListener('gesturechange', (e) => { if (gesture) zoomAround(e.clientX, gesture.w * e.scale); });
    $('main').addEventListener('gestureend', () => { gesture = null; saveZoom(); });
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-zoom-reset]')) return;
    const main = $('main');
    zoomAround(main.getBoundingClientRect().left + main.clientWidth / 2, state.hourBase);
    saveZoom();
  });

  // タッチ: タップで予約画面、長押ししてからなぞると時間指定（通常のスワイプはスクロール）
  let touch = null;
  // スクロール中・直後のタップは、スクロールを止めるためのタップとみなして予約の操作にしない
  const SCROLL_SETTLE_MS = 300;
  let lastScrollAt = 0;
  $('main').addEventListener('scroll', () => { lastScrollAt = Date.now(); clearPick(); }, { passive: true });
  $('main').addEventListener('touchstart', (e) => {
    const track = e.target.closest('.tl-track');
    if (!track || e.touches.length !== 1 || e.target.closest('.blk')) { touch = null; return; }
    const t = e.touches[0];
    touch = {
      track, x: t.clientX, y: t.clientY, moved: false, dragging: false,
      scrolling: Date.now() - lastScrollAt < SCROLL_SETTLE_MS,
      onPick: !!e.target.closest('.ghost.pick'),
    };
    touch.timer = setTimeout(() => {
      if (!touch || touch.moved) return;
      if (beginDrag(track, touch.x)) {
        touch.dragging = true;
        if (navigator.vibrate) navigator.vibrate(15);
      }
    }, LONG_PRESS_MS);
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!touch) return;
    const t = e.touches[0];
    if (touch.dragging) { e.preventDefault(); updateDrag(t.clientX); return; }
    if (Math.abs(t.clientX - touch.x) > 10 || Math.abs(t.clientY - touch.y) > 10) { touch.moved = true; clearTimeout(touch.timer); }
  }, { passive: false });
  document.addEventListener('touchend', (e) => {
    if (!touch) return;
    const t = touch;
    touch = null;
    clearTimeout(t.timer);
    if (t.dragging) { e.preventDefault(); finishDrag(); return; }
    if (t.moved) return;
    e.preventDefault();
    if (t.scrolling || Date.now() - lastScrollAt < SCROLL_SETTLE_MS) return;
    if (t.onPick && state.pick) {
      const slot = state.pick;
      morph($('main').querySelector('.ghost.pick'), () => { clearPick(); openBooking(slot); }, () => $('bookDialog'));
      return;
    }
    pickSlot(t.track, t.x);
  }, { passive: false });
  document.addEventListener('touchcancel', () => { if (touch) clearTimeout(touch.timer); touch = null; cancelDrag(); });

  // ---------------- 既存の予約を動かす（スマホは長押し、PC はつかんで動かす） ----------------
  // 帯の影が指（マウス）について動き、横は時刻（予約単位の刻み）、縦は行（一覧は部屋、部屋別は日付）が変わる。
  // 離すと、新しい部屋・日・時刻を入れた「予約の変更」画面を開き、「変更を保存」で確定する
  // （うっかり動かしても確定しない。編集用パスワードの確認も今まで通り）
  let move = null;
  let moveClickBlockUntil = 0;
  function hideHoverCard() { $('hoverCard').hidden = true; }
  function canMove(r) {
    if (!r || r.pending) return false;
    const room = roomById(r.roomId);
    const ended = r.date < todayStr() || (r.date === todayStr() && toMin(r.end) <= nowMin());
    return !ended && !(room && room.restriction === ADMIN_ONLY && !isAdminMode());
  }
  function beginMove(blk, clientX) {
    const r = visibleReservations().find((x) => x.id === blk.dataset.id);
    if (!canMove(r) || !state.geo) return false;
    const track = blk.closest('.tl-track');
    const grab = minuteAt(track, clientX) - toMin(r.start); // つかんだ所と開始の差（指の下の位置を保つ）
    const ghost = document.createElement('div');
    ghost.className = 'ghost move';
    blk.classList.add('moving-src');
    move = { r, blk, grab, len: toMin(r.end) - toMin(r.start), ghost, row: null, start: toMin(r.start), ok: false };
    hideHoverCard();
    return true;
  }
  function updateMove(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    let track = el && el.closest && el.closest('.tl-track');
    if (!track && move.track) track = move.track; // 行の外に出たときは、直前の行のまま
    if (!track) return;
    move.track = track;
    const row = state.rows[Number(track.dataset.i)];
    const { open, close, t0, total } = state.geo;
    // 動かすときは予約単位（5分など）で刻む。長さは変わらないので、指とのずれは変更画面で直さずに済む
    const step = state.geo.unit;
    let start = roundTo(minuteAt(track, clientX) - move.grab, step);
    start = Math.max(open, Math.min(close - move.len, start));
    const end = start + move.len;
    const r = move.r;
    const today = todayStr();
    const clash = visibleReservations().some((x) => x.id !== r.id && x.date === row.date && x.roomId === row.roomId && toMin(x.start) < end && start < toMin(x.end))
      || closuresFor(row.date, row.roomId).some((c) => c.start < end && start < c.end);
    const past = row.date < today || (row.date === today && start < nowMin());
    move.ok = !clash && !past && !row.stopped;
    move.row = row; move.start = start;
    if (move.ghost.parentNode !== track) track.appendChild(move.ghost);
    move.ghost.classList.toggle('bad', !move.ok);
    move.ghost.style.left = `${((start - t0) / total * 100).toFixed(4)}%`;
    move.ghost.style.width = `${(move.len / total * 100).toFixed(4)}%`;
    move.ghost.textContent = `${hm(toHHMM(start))}〜${hm(toHHMM(end))}`;
  }
  function endMove(commit) {
    const m = move;
    move = null;
    if (!m) return;
    m.ghost.remove();
    m.blk.classList.remove('moving-src');
    moveClickBlockUntil = Date.now() + 400;
    if (!commit || !m.row) return;
    const r = m.r;
    const same = m.row.date === r.date && m.row.roomId === r.roomId && m.start === toMin(r.start);
    if (same) return;
    if (!m.ok) { toast('その時間には動かせません（重なり・利用不可・過去）。', 'error'); return; }
    const pin = isMine(r.id) ? (load_(LS.profile, {}).pin || '') : '';
    // 利用時間は元のまま（開始だけを刻みに合わせ、終了は開始＋元の長さ）
    openBooking({ mode: 'edit', reservation: r, pin, at: { roomId: m.row.roomId, date: m.row.date, start: m.start, end: m.start + m.len } });
  }
  // PC: 帯を押したまま5px以上動かすと、つかんで動かす（動かさなければ今まで通りクリックで詳細）
  let moveMouse = null;
  $('main').addEventListener('mousedown', (e) => {
    const blk = e.target.closest('.blk.res');
    if (!blk || e.button !== 0 || !blk.closest('.tl-track')) return;
    moveMouse = { blk, x: e.clientX, y: e.clientY };
  });
  document.addEventListener('mousemove', (e) => {
    if (!moveMouse) return;
    if (!move) {
      if (Math.hypot(e.clientX - moveMouse.x, e.clientY - moveMouse.y) < 5) return;
      if (!beginMove(moveMouse.blk, moveMouse.x)) { moveMouse = null; return; }
      document.body.classList.add('moving');
    }
    e.preventDefault();
    updateMove(e.clientX, e.clientY);
  });
  document.addEventListener('mouseup', () => {
    if (!moveMouse) return;
    moveMouse = null;
    document.body.classList.remove('moving');
    if (move) endMove(true);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && move) { document.body.classList.remove('moving'); moveMouse = null; endMove(false); } });
  // スマホ: 帯を長押しすると持ち上がり、そのまま指を動かす（長押しの前に動かせば、今まで通りスクロール）
  let moveTouch = null;
  $('main').addEventListener('touchstart', (e) => {
    const blk = e.target.closest('.blk.res');
    if (!blk || e.touches.length !== 1 || !blk.closest('.tl-track')) { moveTouch = null; return; }
    const t = e.touches[0];
    moveTouch = { blk, x: t.clientX, y: t.clientY };
    moveTouch.timer = setTimeout(() => {
      if (!moveTouch || !beginMove(blk, moveTouch.x)) return;
      if (navigator.vibrate) navigator.vibrate(15);
      updateMove(moveTouch.x, moveTouch.y);
    }, LONG_PRESS_MS);
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!moveTouch) return;
    const t = e.touches[0];
    if (move) { e.preventDefault(); updateMove(t.clientX, t.clientY); return; }
    if (Math.abs(t.clientX - moveTouch.x) > 10 || Math.abs(t.clientY - moveTouch.y) > 10) { clearTimeout(moveTouch.timer); moveTouch = null; }
  }, { passive: false });
  document.addEventListener('touchend', (e) => {
    if (!moveTouch) return;
    clearTimeout(moveTouch.timer);
    moveTouch = null;
    if (move) { e.preventDefault(); endMove(true); }
  }, { passive: false });
  document.addEventListener('touchcancel', () => { if (moveTouch) clearTimeout(moveTouch.timer); moveTouch = null; endMove(false); });

  // ---------------- 予約の帯の詳細カード（PC でマウスを乗せたとき） ----------------
  // スマホ（タップ）では出さず、今までどおり予約の詳細画面を開く。表示する項目と書き方は詳細画面とそろえる
  if (window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches) {
    const card = $('hoverCard');
    let hoverTimer = null;
    let hoverBlk = null;
    const hideCard = () => { clearTimeout(hoverTimer); hoverBlk = null; card.hidden = true; };
    const showCard = (blk, x, y) => {
      const r = state.data && visibleReservations().find((v) => v.id === blk.dataset.id);
      if (!r || anyDialogOpen() || drag || mouse || move) return;
      const room = roomById(r.roomId);
      const mine = Object.prototype.hasOwnProperty.call(getMine(), r.id) || r.pending;
      card.innerHTML =
        `<div class="hc-time">${esc(mdLabel(r.date))} ${esc(hm(r.start))} 〜 ${esc(hm(r.end))}（${esc(durationLabel(toMin(r.end) - toMin(r.start)))}）</div>` +
        `<div class="hc-name">${r.groupId ? '↻ ' : ''}${esc(r.name)}</div>` +
        (r.affiliation ? `<div class="hc-aff">${esc(r.affiliation)}</div>` : '') +
        '<dl class="summary">' +
        `<dt>部屋</dt><dd><span class="hc-dot${mine ? ' mine' : ''}"></span>${esc(room ? roomText(room) : r.roomId)}${mine ? '・この端末の予約' : ''}</dd>` +
        (r.memo ? `<dt>備考</dt><dd>${esc(r.memo)}</dd>` : '') +
        (r.pending ? '<dt>状態</dt><dd>送信中</dd>' : '') +
        '</dl>';
      card.hidden = false;
      placeCard(x, y);
    };
    // マウスの右下に出し、画面からはみ出す場合は反対側に回す（マウスを動かすとついてくる）
    let lastX = 0, lastY = 0;
    const placeCard = (x, y) => {
      const w = card.offsetWidth, h = card.offsetHeight, m = 8;
      const left = x + 14 + w > window.innerWidth - m ? Math.max(m, x - 14 - w) : x + 14;
      const top = y + 18 + h > window.innerHeight - m ? Math.max(m, y - 12 - h) : y + 18;
      card.style.transform = `translate(${left}px, ${top}px)`;
    };
    $('main').addEventListener('mousemove', (e) => {
      lastX = e.clientX; lastY = e.clientY;
      if (!card.hidden) placeCard(lastX, lastY);
    }, { passive: true });
    $('main').addEventListener('mouseover', (e) => {
      const blk = e.target.closest('.blk.res');
      if (blk === hoverBlk) return;
      hideCard();
      if (!blk) return;
      hoverBlk = blk;
      lastX = e.clientX; lastY = e.clientY;
      hoverTimer = setTimeout(() => showCard(blk, lastX, lastY), 300); // 300ms の間に動いた先に出す
    });
    $('main').addEventListener('mouseleave', hideCard);
    $('main').addEventListener('mousedown', hideCard);
    $('main').addEventListener('scroll', hideCard, { passive: true });
    $('main').addEventListener('wheel', hideCard, { passive: true });
  }

  $('main').addEventListener('click', (e) => {
    const blk = e.target.closest('.blk.res');
    if (blk && Date.now() < moveClickBlockUntil) return; // 動かし終えた直後のクリックでは詳細を開かない
    if (blk) { morph(blk, () => openDetail(blk.dataset.id), () => $('detailDialog')); return; }
    const cell = e.target.closest('.mc');
    if (cell) { state.date = cell.dataset.date; setView('day'); return; }
    const dayLabel = e.target.closest('.tl-label[data-date]');
    if (dayLabel) { state.date = dayLabel.dataset.date; setView('day'); return; }
    const label = e.target.closest('.tl-label[data-room]');
    if (label) {
      state.roomId = label.dataset.room;
      save_(LS.room, state.roomId);
      setView('room');
    }
  });
  $('main').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest('.blk.res, .mc, .tl-label[data-room], .tl-label[data-date]');
    if (el) { e.preventDefault(); el.click(); }
  });

  // ---------------- 予約・変更ダイアログ ----------------
  function fillTimeSelects(hSel, mSel) {
    const s = state.settings;
    const open = toMin(s.openTime), close = toMin(s.closeTime);
    hSel.innerHTML = '';
    for (let h = Math.floor(open / 60); h <= Math.floor(close / 60); h++) hSel.add(new Option(String(h), String(h)));
    mSel.innerHTML = '';
    for (let m = 0; m < 60; m += s.unitMinutes) mSel.add(new Option(pad(m), String(m)));
    syncWheel(hSel); syncWheel(mSel);
  }

  // ---------------- 時刻のホイール（予約画面の開始・終了） ----------------
  // 選択欄（select）はデータの入れ物として残して隠し、その隣に指・マウス・キーで回せるホイールを置く。
  // ホイールを回すと選択欄の値を変えて change を送るので、ほかの処理は選択欄だけを見ればよい。
  // 表示する段の数は、画面の高さに合わせて CSS で 5段／3段を切り替える（--wheel-rows）。
  const WHEEL_ITEM = 34; // 1段の高さ（CSS の .twheel .item と同じ）
  function syncWheel(sel) { if (sel.wheel) sel.wheel.sync(); }
  function makeWheel(sel) {
    const el = document.createElement('div');
    el.className = 'twheel';
    el.tabIndex = 0;
    el.setAttribute('role', 'spinbutton');
    el.setAttribute('aria-label', sel.getAttribute('aria-label') || '');
    sel.after(el);
    sel.hidden = true;
    sel.parentNode.classList.add('has-wheel');
    let items = [], index = -1, raf = 0, sig = '';

    const setScroll = (i, smooth) => el.scrollTo({ top: i * WHEEL_ITEM, behavior: smooth ? 'smooth' : 'auto' });
    function paint() {
      raf = 0;
      const pos = el.scrollTop / WHEEL_ITEM;
      const now = Math.round(pos);
      items.forEach((it, i) => {
        // 真ん中から離れた数字ほど奥へ傾けて薄くし、ドラムのように見せる。
        // 円筒に巻いたときの位置まで真ん中へ寄せる（傾けて小さくなった分、端の段だけ間が空いて見えないように）
        const d = i - pos;
        const a = Math.max(-1, Math.min(1, d / 2.6));
        const R = 2.72; // 円筒の半径（段の高さの何倍か）。1段あたり約21度
        const ty = (R * Math.sin(Math.max(-1.45, Math.min(1.45, d / R))) - d) * WHEEL_ITEM;
        it.style.transform = `translateY(${ty.toFixed(2)}px) perspective(300px) rotateX(${-a * 55}deg) scale(${1 - Math.abs(a) * .12})`;
        it.style.opacity = String(1 - Math.min(1, Math.abs(i - pos) / 3) * .75);
        it.classList.toggle('sel', i === now);
      });
      if (now !== index && now >= 0 && now < items.length) {
        index = now;
        el.setAttribute('aria-valuetext', items[now].textContent);
        if (sel.selectedIndex !== now) {
          sel.selectedIndex = now;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }
    el.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(paint); }, { passive: true });
    // 数字を押すと、その数字まで回る
    let dragY = null, startTop = 0, moved = false;
    el.addEventListener('click', (e) => {
      if (moved) return;
      const it = e.target.closest('.item');
      if (it) setScroll(items.indexOf(it), true);
    });
    // PC: マウスでつかんで上下にドラッグ（指はふつうのスクロールでそのまま回る）
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      dragY = e.clientY; startTop = el.scrollTop; moved = false;
      el.setPointerCapture(e.pointerId); el.classList.add('dragging');
    });
    el.addEventListener('pointermove', (e) => {
      if (dragY === null) return;
      if (Math.abs(e.clientY - dragY) > 3) moved = true;
      el.scrollTop = startTop - (e.clientY - dragY);
    });
    const endDrag = () => {
      if (dragY === null) return;
      dragY = null; el.classList.remove('dragging');
      setScroll(Math.round(el.scrollTop / WHEEL_ITEM), true);
      setTimeout(() => { moved = false; }, 0);
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    // キー: ↑↓ で1つ、PageUp/PageDown で3つ、Home/End で端まで
    el.addEventListener('keydown', (e) => {
      const step = { ArrowUp: -1, ArrowDown: 1, PageUp: -3, PageDown: 3 }[e.key];
      let to = step ? index + step : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null;
      if (to === null) return;
      e.preventDefault();
      setScroll(Math.max(0, Math.min(items.length - 1, to)), true);
    });

    sel.wheel = {
      /** 選択欄の選択肢・値に合わせて、ホイールを作り直す・回し直す（change は送らない） */
      sync() {
        const nextSig = [...sel.options].map((o) => o.text).join('|');
        if (nextSig !== sig) {
          sig = nextSig;
          el.innerHTML = '<div class="pad"></div>' + [...sel.options].map((o) => `<div class="item">${esc(o.text)}</div>`).join('') + '<div class="pad"></div>';
          items = [...el.querySelectorAll('.item')];
        }
        index = sel.selectedIndex;
        el.setAttribute('aria-valuetext', items[index] ? items[index].textContent : '');
        // 予約画面が閉じている間は回せない（位置が 0 のまま読めてしまい、値を書き戻すおそれがある）ので、開いてから合わせる
        if (!el.offsetParent) return;
        setScroll(Math.max(0, index), false);
        paint();
      },
      focus() { el.focus(); },
    };
    sel.wheel.sync();
  }
  for (const sel of document.querySelectorAll('#bookDialog .time select')) makeWheel(sel);
  // 時刻の欄を自分で回したか（帯を動かしたときの利用時間の確認に使う）
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    $('bookDialog').addEventListener(type, (e) => { if (state.booking && e.target.closest && e.target.closest('.twheel')) state.booking.timeTouched = true; }, { passive: true });
  }

  function setTime(hSel, mSel, min) {
    hSel.value = String(Math.floor(min / 60)); mSel.value = String(min % 60);
    syncWheel(hSel); syncWheel(mSel);
  }
  function getTime(hSel, mSel) { return Number(hSel.value) * 60 + Number(mSel.value); }

  function defaultStart(date) {
    const s = state.settings;
    const open = toMin(s.openTime);
    if (date !== todayStr()) return open;
    return Math.max(open, ceilTo(nowMin(), 30));
  }

  /**
   * @param {{mode:'create'|'edit', roomId?, date?, start?, end?, reservation?, pin?, copyFrom?}} o
   *   copyFrom: コピーのもとの予約（時間・氏名などを引き継ぎ、日と部屋を選んで予約する。元と同じ日・部屋の組み合わせは除く）
   */
  function openBooking(o) {
    const s = state.settings;
    const edit = o.mode === 'edit';
    const r = o.reservation;
    const cp = !edit && o.copyFrom ? o.copyFrom : null;
    if (cp) {
      o = Object.assign({}, o, { roomId: cp.roomId, start: toMin(cp.start), end: toMin(cp.end), date: cp.date < todayStr() ? todayStr() : cp.date });
    }
    state.booking = { mode: o.mode, id: r ? r.id : null, origDate: r ? r.date : null, orig: r || null, keepLen: o.at ? o.at.end - o.at.start : null,
      // コピー: 選んだ日（日付の文字列）× 選んだ部屋。初めは元の日・元の部屋を選んだ状態（そのままでは0件）
      copy: cp ? { orig: { date: cp.date, roomId: cp.roomId }, start: o.date,
        days: new Set(cp.date >= todayStr() ? [cp.date] : []), rooms: new Set([cp.roomId]) } : null };
    $('bTitle').textContent = edit ? '予約の変更' : cp ? '予約のコピー' : '新規予約';
    $('bSubmit').textContent = edit ? '変更を保存' : '予約確定';

    const roomSel = $('bRoom');
    // 一覧で設備を絞り込んでいるときは、新規予約の部屋の選択肢も同じ設備に絞る（変更時は今の部屋を必ず含める）
    const eqFilter = state.view === 'day' ? $('equipFilter').value : '';
    roomSel.innerHTML = state.rooms.filter((x) => x.restriction !== STOPPED)
      .filter((x) => roomInFilter(x, eqFilter) || (edit && x.id === r.roomId))
      .map((x) => `<option value="${esc(x.id)}">${esc(roomText(x))}${x.restriction === ADMIN_ONLY ? '［管理者のみ］' : ''}</option>`).join('');
    const firstRoom = roomSel.options[0] ? roomSel.options[0].value : '';
    // 部屋の初期値: 指定があればその部屋、部屋別・カレンダー表示中は選んでいる部屋、一覧からは先頭の部屋
    // at: 帯を動かしたときの行き先（部屋・日・開始・終了）。最初からこの値で開く（開いてから回し直すと、
    // iPhone ではホイールが元の位置を拾い直して、時刻の一部だけが元に戻ることがあったため）
    const at = edit && o.at ? o.at : null;
    roomSel.value = at ? at.roomId : edit ? r.roomId : (o.roomId || (state.view !== 'day' && state.roomId) || firstRoom);
    if (!roomSel.value) roomSel.value = firstRoom;
    // 一覧の「新規予約」から開いたときは、まず部屋を選ぶことが多いので、部屋の一覧を広げて見せる。
    // 部屋を押すと、いつもの選択欄に戻る（ドラッグや空き枠から開いたとき・部屋別表示・変更時は広げない）
    const quick = !edit && !o.roomId && state.view === 'day' && roomSel.options.length > 1;
    $('bRoomQuick').innerHTML = quick ? [...roomSel.options].map((op) => {
      const rm = state.rooms.find((x) => x.id === op.value) || { name: op.textContent };
      const sub = [rm.tags, rm.restriction === ADMIN_ONLY ? '管理者のみ' : ''].filter(Boolean).join('・');
      return `<button type="button" class="rq ${rm.tags ? tagClass(rm.tags) : ''}" data-id="${esc(op.value)}" aria-label="${esc(op.textContent)}"><b>${esc(rm.name)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</button>`;
    }).join('') : '';
    $('bRoomQuickField').hidden = !quick;
    $('bRoomField').hidden = quick;

    const date = at ? at.date : edit ? r.date : (o.date || state.date);
    $('bDate').value = date;
    $('bDate').min = edit ? '' : todayStr();
    fillTimeSelects($('bStartH'), $('bStartM'));
    fillTimeSelects($('bEndH'), $('bEndM'));
    const start = at ? at.start : edit ? toMin(r.start) : (o.start != null ? o.start : defaultStart(date));
    const end = at ? at.end : edit ? toMin(r.end) : (o.end != null ? o.end : Math.min(start + 60, toMin(s.closeTime)));
    setTime($('bStartH'), $('bStartM'), start);
    setTime($('bEndH'), $('bEndM'), end);

    const profile = load_(LS.profile, {});
    const from = edit ? r : cp;
    $('bAff').value = from ? from.affiliation : (profile.affiliation || '');
    $('bPerson').value = from ? from.name : (profile.name || '');
    $('bMemo').value = from ? (from.memo || '') : '';
    $('bPin').value = edit ? (o.pin || '') : (profile.pin || '');
    // 変更時: 編集用パスワードのない予約・管理者モードでは編集用パスワード欄を出さない
    $('bPinField').hidden = edit && (!r.hasPin || isAdminMode());
    $('bPinLabel').textContent = edit ? '編集用パスワード（予約時に設定した4桁）' : '編集用パスワード（4桁の数字）';
    $('bPinReq').hidden = !edit;
    $('bPinHint').hidden = edit;
    $('bHint').hidden = edit;
    // まとめ予約（くり返し・複数部屋）の1件を変更するときは、この日以降の分もまとめて変更できる
    $('bSeriesBox').hidden = !(edit && r.groupId);
    $('bSeries').checked = false;

    // くり返し予約・複数部屋の同時予約は、管理者モードか、管理者が全員に許可しているときだけ出す
    const showBulk = !edit && (isAdminMode() || !s.bulkRequiresAdmin);
    $('bRepeatBox').hidden = !showBulk;
    $('bRepeat').checked = false;
    $('bRepeatArea').hidden = true;
    $('bInterval').value = '7';
    $('bInterval').querySelector('option[value="1"]').disabled = !!cp; // コピーは曜日を選ぶので「毎日」は使わない
    $('bCopyField').hidden = !cp;
    // コピーでは、部屋と日付の欄・「他の部屋も同時に予約」の代わりに、日と部屋のボタンで選ぶ
    $('bookDialog').querySelector('.room-date').hidden = !!cp;
    // 件数の表示は、コピーでは部屋の欄のすぐ下に、それ以外は「くり返し予約」の下に置く
    if (cp) $('bCopyField').appendChild($('bBulkSummary'));
    else $('bAdminField').before($('bBulkSummary'));
    if (cp) {
      const rm = roomById(cp.roomId);
      $('bCopySrc').textContent = `元の予約: ${mdLabel(cp.date)} ${rm ? roomText(rm) : ''} ${hm(cp.start)}〜${hm(cp.end)}`;
    }
    // 重要な予定の色: 管理者モードか、限定公開に入っているときだけ選べる（GAS でも確かめている）
    $('bColorField').hidden = !(isAdminMode() || state.limitedKey);
    setColorChoice(edit ? (r.color || '') : cp ? (cp.color || '') : '');
    $('bUntil').value = addDays(date, 7 * 14);
    $('bMultiBox').hidden = !showBulk || !!cp;
    $('bMulti').checked = false;
    $('bMultiArea').hidden = true;
    state.extraRooms = new Set();
    renderRoomPicker();
    $('bAdmin').value = '';
    $('bError').textContent = '';
    resetConflicts();
    updateBookingUi();
    $('bookDialog').showModal();
    // 閉じている間はホイールの位置を合わせられないので、開いてから合わせ直す
    for (const sel of $('bookDialog').querySelectorAll('.time select')) syncWheel(sel);
    renderDraft();
    // 新規予約は氏名／団体名の欄から入力できるようにする。
    // 変更時は入力欄に触れない（iPhoneでは部屋の選択肢やキーボードが勝手に開いてしまうため、見出しを選択状態にしている）
    // 名前が保存済み（自動入力された）ときは、キーボードを出さずに内容を見せる
    if (!edit && !quick && !$('bPerson').value) $('bPerson').focus();
  }

  const RES_COLORS = ['red', 'purple', 'green'];
  function setColorChoice(c) {
    for (const b of $('bColor').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.c === c));
  }
  $('bColor').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-c]');
    if (b) setColorChoice(b.dataset.c);
  });

  /** コピー: 日のボタン（7日分。‹ › で1週間ずつ動かす。今日より前・定休日は選べない） */
  function renderCopyDays() {
    const c = state.booking && state.booking.copy;
    if (!c) { $('bCopyDays').innerHTML = ''; return; }
    const today = todayStr();
    $('bCopyDays').innerHTML = Array.from({ length: 7 }, (_, i) => addDays(c.start, i)).map((d) => {
      const w = weekday(d);
      const dd = parseDate(d);
      const off = d < today || isClosedWeekday(d);
      return `<button type="button" data-d="${d}" class="${w === 0 ? 'sun' : w === 6 ? 'sat' : ''}${d === c.orig.date ? ' orig' : ''}" aria-pressed="${c.days.has(d) && !off}"${off ? ' disabled' : ''}>` +
        `${WEEKDAYS[w]}<small>${dd.getMonth() + 1}/${dd.getDate()}</small></button>`;
    }).join('');
    $('bCopyPrev').disabled = c.start <= today;
  }
  $('bCopyDays').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-d]');
    const c = state.booking && state.booking.copy;
    if (!b || !c) return;
    if (c.days.has(b.dataset.d)) c.days.delete(b.dataset.d); else c.days.add(b.dataset.d);
    resetConflicts();
    updateBookingUi();
  });
  for (const [id, step] of [['bCopyPrev', -7], ['bCopyNext', 7]]) {
    $(id).addEventListener('click', () => {
      const c = state.booking && state.booking.copy;
      if (!c) return;
      const next = addDays(c.start, step);
      c.start = next < todayStr() ? todayStr() : next;
      renderCopyDays();
    });
  }

  function updateBookingUi() {
    $('bDateDisplay').innerHTML = dateDisplayHtml($('bDate').value);
    renderCopyDays();
    $('bUntilDisplay').innerHTML = dateDisplayHtml($('bUntil').value);
    const s = state.settings;
    const edit = state.booking.mode === 'edit';
    // まとめて変更するときは、日付と部屋はそれぞれのままなので選べないようにする
    const series = edit && !$('bSeriesBox').hidden && $('bSeries').checked;
    $('bRoom').disabled = series;
    $('bDate').disabled = series;
    $('bDate').closest('.date-field').classList.toggle('disabled', series);
    $('bSeriesHint').hidden = !series;
    const start = getTime($('bStartH'), $('bStartM'));
    const end = getTime($('bEndH'), $('bEndM'));
    const dur = $('bDuration');
    dur.textContent = end > start ? `利用時間: ${durationLabel(end - start)}` : '終了は開始より後にしてください';
    dur.style.color = end > start ? '' : 'var(--danger)';

    const rooms = selectedRooms().map(roomById).filter(Boolean);
    const dates = bookingDates();
    const pairs = bookingPairs();
    const total = pairs.length;
    const adminOnly = rooms.some((x) => x.restriction === ADMIN_ONLY);
    const needAdmin = !edit && !isAdminMode() && (adminOnly || (total > 1 && s.bulkRequiresAdmin));
    $('bAdminField').hidden = !needAdmin;
    $('bAdminLabel').textContent = adminOnly ? '管理用パスワード（管理者のみ予約できる部屋が含まれています）' : '管理用パスワード（まとめて予約は管理者のみ）';

    // まとめて予約の件数（部屋数 × 日数）
    const el = $('bBulkSummary');
    const copy = state.booking.copy;
    el.hidden = edit || (copy ? false : total <= 1);
    if (copy) {
      // コピー: 予約する日・部屋をそのまま並べる（多いときは件数だけ）
      const name = (id) => { const rm = roomById(id); return rm ? rm.name + (state.rooms.filter((x) => x.name === rm.name).length > 1 && rm.tags ? `（${rm.tags}）` : '') : id; };
      el.textContent = !total ? '日と部屋を選んでください（元の予約と同じ組み合わせは除きます）'
        : (total <= 4 ? pairs.map((x) => `${mdLabel(x.date)} ${name(x.roomId)}`).join('・') + `　計${total}件` : `${dates.length}日 × ${rooms.length}部屋のうち 計${total}件`)
          + (total > s.maxBulkCount ? `　※最大${s.maxBulkCount}件までです` : '');
      el.style.color = !total || total > s.maxBulkCount ? 'var(--danger)' : '';
    } else if (!el.hidden) {
      const parts = [];
      if (rooms.length > 1) parts.push(`${rooms.length}部屋`);
      if (dates.length > 1) {
        const label = { 7: '毎週', 14: '隔週', 1: '毎日' }[$('bInterval').value];
        const dow = $('bInterval').value === '1' ? '' : WEEKDAYS[weekday(dates[0])] + '曜日';
        parts.push(`${label}${dow} ${dates.length}回（${mdLabel(dates[0])}〜${mdLabel(dates[dates.length - 1])}）`);
      }
      el.textContent = `${parts.join(' × ')}　計${total}件` + (total > s.maxBulkCount ? `　※最大${s.maxBulkCount}件までです` : '');
      el.style.color = total > s.maxBulkCount ? 'var(--danger)' : '';
    }
    if ($('bRepeat').checked && !edit && !repeatDates().length) {
      el.hidden = false;
      el.textContent = '最終日は開始日以降の日付を指定してください。';
      el.style.color = 'var(--danger)';
    }
    renderDraft();
  }

  /** スマホで1回タップした所の「仮予約」の帯（もう一度タップすると予約画面を開く） */
  function renderPick() {
    const p = state.pick;
    if (!p || $('bookDialog').open || !state.geo || !state.rows) return;
    const i = state.rows.findIndex((row) => row.roomId === p.roomId && row.date === p.date);
    const track = i >= 0 && $('main').querySelector(`.tl-track[data-i="${i}"]`);
    if (!track) return;
    const { t0, total } = state.geo;
    const el = document.createElement('div');
    el.className = 'ghost pick';
    el.style.left = `${((p.start - t0) / total * 100).toFixed(4)}%`;
    el.style.width = `${((p.end - p.start) / total * 100).toFixed(4)}%`;
    el.innerHTML = '<b>＋予約</b>';
    el.title = `${hm(toHHMM(p.start))}〜${hm(toHHMM(p.end))} を予約`;
    track.appendChild(el);
  }

  /** 新規予約の入力中は、背景の予約表に「仮予約」の帯（選んでいる部屋・日付・時間）を出す */
  function renderDraft() {
    for (const el of $('main').querySelectorAll('.ghost.draft, .ghost.pick')) el.remove();
    renderPick();
    const b = state.booking;
    if (!b || b.mode !== 'create' || !$('bookDialog').open || !state.geo || !state.rows) return;
    if (!$('bRoomQuickField').hidden) return; // 部屋をまだ選んでいないときは仮予約の帯を出さない
    const start = getTime($('bStartH'), $('bStartM'));
    const end = getTime($('bEndH'), $('bEndM'));
    if (!(end > start)) return;
    const { t0, total } = state.geo;
    const keys = new Set(bookingPairs().map((x) => x.date + '|' + x.roomId));
    const s = Math.max(start, t0), e = Math.min(end, t0 + total);
    if (e <= s) return;
    state.rows.forEach((row, i) => {
      if (!keys.has(row.date + '|' + row.roomId)) return;
      const track = $('main').querySelector(`.tl-track[data-i="${i}"]`);
      if (!track) return;
      const el = document.createElement('div');
      el.className = 'ghost draft';
      el.style.left = `${((s - t0) / total * 100).toFixed(4)}%`;
      el.style.width = `${((e - s) / total * 100).toFixed(4)}%`;
      el.textContent = `${hm(toHHMM(start))}〜${hm(toHHMM(end))}`;
      track.appendChild(el);
    });
  }

  /** 予約する日付（くり返しなしなら1日だけ） */
  function bookingDates() {
    const c = state.booking.mode === 'create' && state.booking.copy;
    if (c) {
      // コピー: 選んだ日。くり返すときは、それぞれを最終日まで毎週（隔週）
      const firsts = [...c.days].filter((d) => d >= todayStr() && !isClosedWeekday(d)).sort();
      if (!$('bRepeat').checked) return firsts;
      const until = $('bUntil').value;
      const step = Number($('bInterval').value) === 14 ? 14 : 7;
      const out = new Set();
      for (const f of firsts) for (let d = f; until && d <= until && out.size <= 400; d = addDays(d, step)) out.add(d);
      return [...out].sort();
    }
    if (state.booking.mode === 'create' && $('bRepeat').checked) return repeatDates();
    return $('bDate').value ? [$('bDate').value] : [];
  }

  /** 予約する部屋（選択中の部屋 + 「他の部屋も同時に予約」で選んだ部屋、部屋マスタの順） */
  function selectedRooms() {
    const main = $('bRoom').value;
    const c = state.booking.mode === 'create' && state.booking.copy;
    if (c) return state.rooms.map((r) => r.id).filter((id) => c.rooms.has(id));
    if (state.booking.mode !== 'create' || !$('bMulti').checked) return [main];
    return state.rooms.map((r) => r.id).filter((id) => id === main || state.extraRooms.has(id));
  }

  /** くり返し予約の対象日（毎日の場合は定休日を除く） */
  function repeatDates() {
    const first = $('bDate').value;
    const until = $('bUntil').value;
    const step = Number($('bInterval').value);
    const dates = [];
    if (!first || !until) return dates;
    for (let d = first; d <= until && dates.length <= 400; d = addDays(d, step)) {
      if (step === 1 && isClosedWeekday(d)) continue;
      dates.push(d);
    }
    return dates;
  }

  /** 一覧の絞り込み（設備区分、または「★ お気に入り」）に当てはまる部屋か */
  function roomInFilter(room, filter) {
    if (!filter || filter === FAV_EDIT) return true;
    if (filter === FAV) return getFavs().has(room.id);
    return room.equipment === filter;
  }

  /** 予約する日と部屋の組み合わせ（コピーでは、元の予約と同じ日・部屋を除く） */
  function bookingPairs() {
    const c = state.booking.mode === 'create' && state.booking.copy;
    const out = [];
    for (const date of bookingDates()) {
      for (const roomId of selectedRooms()) {
        if (c && date === c.orig.date && roomId === c.orig.roomId) continue;
        out.push({ date, roomId });
      }
    }
    return out;
  }

  /**
   * 部屋を複数選ぶ欄（新規予約の部屋の一覧を小さくしたもの）。押すと選択・解除。
   * 同じ名前の部屋（練習室6の電子P.1〜5 など）は、先頭の「全◯室」でまとめて選べる。
   * lock: 選んだまま外せない部屋（他の部屋も同時に予約するときの、上で選んだ部屋）、orig: 元の予約の部屋（点を付ける）
   */
  function roomGridHtml(selected, lock, orig) {
    const rooms = state.rooms.filter((r) => r.restriction !== STOPPED);
    const count = {};
    for (const r of rooms) count[r.name] = (count[r.name] || 0) + 1;
    let html = '';
    let prev = '';
    for (const r of rooms) {
      if (count[r.name] > 1 && r.name !== prev) {
        html += `<button type="button" class="rq rq-group" data-group="${esc(r.name)}"><b>${esc(r.name)}</b><small>全${count[r.name]}室</small></button>`;
      }
      prev = r.name;
      const sub = [count[r.name] > 1 ? r.tags || '' : r.tags, r.restriction === ADMIN_ONLY ? '管理者のみ' : ''].filter(Boolean).join('・');
      html += `<button type="button" class="rq ${r.tags ? tagClass(r.tags) : ''}${r.id === orig ? ' orig' : ''}" data-id="${esc(r.id)}"` +
        ` aria-pressed="${selected.has(r.id) || r.id === lock}"${r.id === lock ? ' disabled' : ''} aria-label="${esc(roomText(r))}">` +
        `<b>${esc(r.name)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</button>`;
    }
    return html;
  }
  function renderRoomPicker() {
    const c = state.booking && state.booking.copy;
    if (c) $('bCopyRooms').innerHTML = roomGridHtml(c.rooms, '', c.orig.roomId);
    else $('bRoomPicker').innerHTML = roomGridHtml(state.extraRooms, $('bRoom').value, '');
  }
  /** 部屋のボタンを押したとき（1部屋 or 同じ名前の全部屋を切り替える） */
  function onRoomGridClick(e, set, lock) {
    const b = e.target.closest('button[data-id], button[data-group]');
    if (!b || b.disabled) return;
    const ids = b.dataset.group
      ? state.rooms.filter((r) => r.name === b.dataset.group && r.restriction !== STOPPED && r.id !== lock).map((r) => r.id)
      : [b.dataset.id];
    const allOn = ids.every((id) => set.has(id));
    ids.forEach((id) => (allOn ? set.delete(id) : set.add(id)));
    renderRoomPicker();
    resetConflicts();
    updateBookingUi();
  }
  $('bMulti').addEventListener('change', (e) => { $('bMultiArea').hidden = !e.target.checked; resetConflicts(); updateBookingUi(); });
  $('bRoomPicker').addEventListener('click', (e) => onRoomGridClick(e, state.extraRooms, $('bRoom').value));
  $('bCopyRooms').addEventListener('click', (e) => { if (state.booking && state.booking.copy) onRoomGridClick(e, state.booking.copy.rooms, ''); });

  function resetConflicts() {
    state.skipConflicts = false;
    $('bConflicts').innerHTML = '';
    if (state.booking) $('bSubmit').textContent = state.booking.mode === 'edit' ? '変更を保存' : '予約確定';
    $('bSubmit').disabled = false;
  }

  async function submitBooking(e) {
    e.preventDefault();
    const s = state.settings;
    const edit = state.booking.mode === 'edit';
    const err = $('bError');
    const fail = (msg, focusId) => { err.textContent = msg; if (focusId) ($(focusId).wheel || $(focusId)).focus(); };
    if (!$('bRoomQuickField').hidden) return fail('部屋を選んでください。');
    const payload = {
      roomId: $('bRoom').value,
      date: $('bDate').value,
      start: toHHMM(getTime($('bStartH'), $('bStartM'))),
      end: toHHMM(getTime($('bEndH'), $('bEndM'))),
      affiliation: $('bAff').value.trim(),
      name: $('bPerson').value.trim(),
      memo: $('bMemo').value.trim(),
      pin: $('bPin').value.trim(),
    };
    // 帯を動かして開いた変更画面で、時刻の欄に触れていなければ、利用時間は必ず元の長さにする（念のため）
    const keep = state.booking.keepLen;
    if (keep && !state.booking.timeTouched && toMin(payload.end) - toMin(payload.start) !== keep) {
      payload.end = toHHMM(toMin(payload.start) + keep);
    }
    if (!$('bColorField').hidden) {
      const on = $('bColor').querySelector('button[aria-pressed="true"]');
      payload.color = on ? on.dataset.c : '';
    }
    if (!payload.date) return fail('日付を指定してください。', 'bDate');
    if (toMin(payload.end) <= toMin(payload.start)) return fail('終了は開始より後にしてください。', 'bEndH');
    if (!payload.name) return fail('氏名／団体名を入力してください。', 'bPerson');
    if (!edit && payload.pin && !/^\d{4}$/.test(payload.pin)) return fail('編集用パスワードは4桁の数字で入力してください（設定しない場合は空欄）。', 'bPin');
    if (edit && !$('bPinField').hidden && !payload.pin) return fail('編集用パスワードを入力してください。', 'bPin');

    if (!$('bAdminField').hidden) {
      if (!$('bAdmin').value) return fail('管理用パスワードを入力してください。', 'bAdmin');
      payload.adminPassword = $('bAdmin').value;
    }
    const roomIds = selectedRooms();
    const dates = bookingDates();
    const pairs = bookingPairs();
    if (state.booking.copy) {
      if (!pairs.length) return fail('コピー先の日と部屋を選んでください（元の予約と同じ組み合わせは除きます）。');
      payload.date = pairs[0].date;
      payload.roomId = pairs[0].roomId;
    }
    const total = pairs.length;
    const bulk = !edit && total > 1;
    if (!edit && $('bRepeat').checked && !dates.length) return fail('最終日を正しく指定してください。', 'bUntil');
    if (bulk && total > s.maxBulkCount) return fail(`まとめて予約は最大${s.maxBulkCount}件までです（今回${total}件）。部屋か期間を減らしてください。`);
    if (!edit) save_(LS.profile, { affiliation: payload.affiliation, name: payload.name, pin: payload.pin }); // 予約確定時にこの端末へ保存

    // 1件の変更（まとめて変更でないもの）も、サーバーの結果を待たずに画面へ反映する（失敗したら元に戻す）
    const seriesEdit = edit && !$('bSeriesBox').hidden && $('bSeries').checked;
    if (edit && !seriesEdit && state.booking.orig) {
      if (state.data && payload.date >= state.data.from && payload.date <= state.data.to) {
        const clash = visibleReservations().find((r) => r.id !== state.booking.id && r.date === payload.date && r.roomId === payload.roomId &&
          toMin(r.start) < toMin(payload.end) && toMin(payload.start) < toMin(r.end));
        if (clash) return fail(`すでに存在する予約と時間が重複しています（${hm(clash.start)}〜${hm(clash.end)} ${clash.name}）。`);
      }
      updateOptimistic(payload, state.booking.orig);
      return;
    }
    // 1件の新規予約は、サーバーの結果を待たずに画面へ反映する（失敗したら元に戻す）
    if (!edit && !bulk) {
      if (state.data && payload.date >= state.data.from && payload.date <= state.data.to) {
        const clash = visibleReservations().find((r) => r.date === payload.date && r.roomId === payload.roomId &&
          toMin(r.start) < toMin(payload.end) && toMin(payload.start) < toMin(r.end));
        if (clash) return fail(`すでに存在する予約と時間が重複しています（${hm(clash.start)}〜${hm(clash.end)} ${clash.name}）。`);
        // 休館・定休日と重なる時間は、画面に反映せずにその場で知らせる
        const closed = closuresFor(payload.date, payload.roomId)
          .find((c) => c.start < toMin(payload.end) && toMin(payload.start) < c.end);
        if (closed) return fail(`${hm(toHHMM(closed.start))}〜${hm(toHHMM(closed.end))} は利用できません（${closed.reason}）。`);
      }
      createOptimistic(payload);
      return;
    }

    const btn = $('bSubmit');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '送信中…';
    err.textContent = '';
    try {
      let res;
      const series = edit && !$('bSeriesBox').hidden && $('bSeries').checked;
      if (edit) res = await api('updateReservation', Object.assign(payload, { id: state.booking.id }, series ? { scope: 'following' } : {}));
      else if (bulk) res = await api('createBulkReservations', Object.assign(payload, { roomIds, dates, skipConflicts: state.skipConflicts }, state.booking.copy ? { pairs } : {}));
      else res = await api('createReservation', payload);

      if (res && res.ok) {
        const list = res.reservations || [res.reservation];
        if (!edit) addMine(list);
        $('bookDialog').close();
        const skipped = res.skipped && res.skipped.length ? `（予約できなかった${res.skipped.length}件を除く）` : '';
        toast(edit ? (list.length > 1 ? `${list.length}件の予約をまとめて変更しました` : '予約を変更しました') : `${list.length}件予約しました${skipped}`);
        invalidate(list.length > 1 ? undefined : list.map((r) => r.date).concat(edit ? [state.booking.origDate] : []));
        if (!edit && list[0].date !== state.date && state.view === 'day') setDate(list[0].date);
        else load({ force: true });
        return;
      }
      if (res && res.code === 'PARTIAL_CONFLICT') {
        err.textContent = `${total}件中${res.conflicts.length}件は予約できません。`;
        $('bConflicts').innerHTML = res.conflicts.map((c) =>
          `<li>${esc(mdLabel(c.date))} ${roomIds.length > 1 ? esc(roomText(roomById(c.roomId))) + ' ' : ''}${esc(c.reason)}</li>`).join('');
        state.skipConflicts = true;
        btn.textContent = `予約できる${res.availableCount}件だけ予約`;
        btn.disabled = res.availableCount === 0;
        return;
      }
      err.textContent = (res && res.message) || '処理に失敗しました。';
      if (res && res.code === 'SERIES_CONFLICT') $('bConflicts').innerHTML = res.conflicts.map((c) => `<li>${esc(c)}</li>`).join('');
      if (res && res.code === 'CONFLICT') { invalidate([payload.date]); load({ force: true }); }
      btn.textContent = label;
    } catch (ex) {
      if (!(ex instanceof AuthError)) err.textContent = errMessage(ex);
      btn.textContent = label;
    }
    btn.disabled = false;
  }

  /** 新規予約（1件）を楽観的に反映してから送信する。失敗したら表示を戻し、入力内容を残したまま予約画面を開き直す。 */
  async function createOptimistic(payload) {
    const temp = Object.assign({}, payload, { id: `tmp_${Date.now()}`, groupId: '', hasPin: !!payload.pin, pending: true });
    delete temp.pin;
    delete temp.adminPassword;
    const entry = { r: temp, status: 'sending' };
    state.pending.push(entry);
    morph($('bookDialog'), () => {
      $('bookDialog').close();
      if (state.view === 'day' && payload.date !== state.date) setDate(payload.date);
      else if (state.data) render();
    }, () => bandEl(temp.id));
    try {
      const res = await api('createReservation', payload);
      if (!res || !res.ok) {
        throw Object.assign(new Error((res && res.message) || '予約できませんでした。'), { code: res && res.code });
      }
      // 確定した予約は、再取得で台帳のデータに現れるまでこのまま表示しておく
      entry.r = res.reservation;
      entry.status = 'done';
      addMine([res.reservation]);
      toast('予約しました');
      invalidate([payload.date]);
      if (state.data) render();
      load({ force: true });
    } catch (ex) {
      state.pending = state.pending.filter((x) => x !== entry); // 画面を予約前の状態に戻す
      if (state.data) render();
      if (ex instanceof AuthError) return;
      const message = errMessage(ex);
      toast(message, 'error');
      if (ex.code === 'CONFLICT') { invalidate([payload.date]); load({ force: true }); }
      if (!anyDialogOpen()) {
        openBooking({ mode: 'create', roomId: payload.roomId, date: payload.date, start: toMin(payload.start), end: toMin(payload.end) });
        $('bAff').value = payload.affiliation;
        $('bPerson').value = payload.name;
        $('bMemo').value = payload.memo;
        $('bPin').value = payload.pin;
        if (payload.color !== undefined) setColorChoice(payload.color);
        $('bError').textContent = message;
      }
    }
  }

  /** 予約の変更（1件）を楽観的に反映してから送信する。元の予約を隠して変更後の姿を出し、失敗したら元に戻して変更画面を開き直す。 */
  async function updateOptimistic(payload, orig) {
    const temp = Object.assign({}, orig, payload, { id: `tmpedit_${orig.id}`, pending: true });
    delete temp.pin;
    delete temp.adminPassword;
    const entry = { r: temp, status: 'sending' };
    state.pending.push(entry);
    state.hidden.set(orig.id, orig.date);
    morph($('bookDialog'), () => {
      $('bookDialog').close();
      if (state.view === 'day' && payload.date !== state.date) setDate(payload.date);
      else if (state.data) render();
    }, () => bandEl(temp.id));
    const restore = () => {
      state.pending = state.pending.filter((x) => x !== entry);
      state.hidden.delete(orig.id);
      if (state.data) render();
    };
    try {
      const res = await api('updateReservation', Object.assign({}, payload, { id: orig.id }));
      if (!res || !res.ok) throw Object.assign(new Error((res && res.message) || '変更できませんでした。'), { code: res && res.code });
      entry.status = 'done';
      entry.r = Object.assign({}, res.reservation, { id: temp.id }); // 再取得で台帳に反映されるまで、変更後の姿を出しておく
      toast('予約を変更しました');
      invalidate([orig.date, payload.date]);
      await load({ force: true });
      restore(); // 最新の台帳に変更後の予約が入ったので、仮の表示を片付ける
    } catch (ex) {
      restore();
      if (ex instanceof AuthError) return;
      const message = errMessage(ex);
      toast(message, 'error');
      if (ex.code === 'CONFLICT' || ex.code === 'NOT_FOUND') { invalidate([orig.date, payload.date]); load({ force: true }); }
      if (!anyDialogOpen() && ex.code !== 'NOT_FOUND') {
        openBooking({ mode: 'edit', reservation: orig, pin: payload.pin });
        $('bRoom').value = payload.roomId;
        $('bDate').value = payload.date;
        setTime($('bStartH'), $('bStartM'), toMin(payload.start));
        setTime($('bEndH'), $('bEndM'), toMin(payload.end));
        $('bAff').value = payload.affiliation;
        $('bPerson').value = payload.name;
        $('bMemo').value = payload.memo;
        if (payload.color !== undefined) setColorChoice(payload.color);
        updateBookingUi();
        $('bError').textContent = message;
      }
    }
  }

  // ---------------- 詳細ダイアログ ----------------
  function personText(r) { return r.affiliation ? `${r.name}（${r.affiliation}）` : r.name; }

  function openDetail(id) {
    const r = visibleReservations().find((x) => x.id === id);
    if (!r) return;
    if (r.pending) { toast('予約を送信中です。少し待ってから操作してください。'); return; }
    state.detail = r;
    const room = roomById(r.roomId);
    $('dRoom').textContent = room ? roomText(room) : r.roomId;
    $('dDate').textContent = fullDateLabel(r.date);
    $('dTime').textContent = `${hm(r.start)} 〜 ${hm(r.end)}（${durationLabel(toMin(r.end) - toMin(r.start))}）`;
    $('dName').textContent = personText(r);
    $('dMemo').textContent = r.memo;
    $('dMemo').hidden = $('dMemoDt').hidden = !r.memo;
    $('dError').textContent = '';

    const ended = r.date < todayStr() || (r.date === todayStr() && toMin(r.end) <= nowMin());
    const mine = isMine(r.id);
    const admin = isAdminMode();
    // 編集用パスワード欄は「編集用パスワードが設定された予約」を管理者モード以外で操作するときだけ出す
    $('dOps').hidden = ended || admin || !r.hasPin;
    $('dEdit').hidden = $('dCancel').hidden = ended;
    $('dCancel').disabled = $('dEdit').disabled = false;
    $('dSeriesArea').hidden = ended || !r.groupId;
    $('dSeries').checked = false;
    const notes = [];
    if (ended) notes.push('この予約は終了しています。');
    if (r.groupId) notes.push('まとめて登録された予約（くり返し・複数部屋）の1件です。');
    if (mine) notes.push('この端末で作成した予約です。');
    if (!ended && admin) notes.push('管理者モード: 編集用パスワードなしで変更・取消できます。');
    if (!admin && room && room.restriction === ADMIN_ONLY && !ended) notes.push('この部屋の予約の変更・取消は管理者のみ行えます。');
    $('dNote').hidden = !notes.length;
    $('dNote').textContent = notes.join(' ');
    $('dPin').value = mine ? (load_(LS.profile, {}).pin || '') : '';
    // カレンダーに追加（終わっていない予約だけ）
    $('dCal').hidden = ended;
    // コピー（まとめて予約ができる人だけ。終わった予約もコピーできる）
    $('dCopy').hidden = !(isAdminMode() || !state.settings.bulkRequiresAdmin) || !room || room.restriction === STOPPED;
    if (!ended) {
      // Android は Google カレンダーの追加画面、それ以外（iPhone など）はカレンダーのファイルの URL を開く
      const add = $('dCalAdd');
      if (IS_ANDROID) { add.href = googleCalendarUrl(r, room); add.target = '_blank'; add.rel = 'noopener'; }
      else { add.href = icsUrl(r, room) || '#'; add.removeAttribute('target'); }
    }
    $('detailDialog').showModal();
  }

  $('dCopy').addEventListener('click', () => {
    const r = state.detail;
    $('detailDialog').close();
    openBooking({ mode: 'create', copyFrom: r });
  });

  function editFromDetail() {
    const pin = $('dPin').value.trim();
    if (!$('dOps').hidden && !pin) { $('dError').textContent = '変更するには編集用パスワードを入力してください。'; $('dPin').focus(); return; }
    $('detailDialog').close();
    openBooking({ mode: 'edit', reservation: state.detail, pin });
  }

  async function submitCancel(e) {
    e.preventDefault();
    const pin = $('dPin').value.trim();
    const err = $('dError');
    if (!$('dOps').hidden && !pin) { err.textContent = '編集用パスワードを入力してください。'; $('dPin').focus(); return; }
    const series = !$('dSeriesArea').hidden && $('dSeries').checked;
    if (!confirm(series ? '同じまとめ予約のうち、この日以降の分をすべて取り消しますか？' : 'この予約を取り消しますか？')) return;

    const r = state.detail;
    const scope = series ? 'following' : 'single';
    // サーバーの結果を待たずに画面から消す（失敗したら元に戻す）
    const targets = series
      ? visibleReservations().filter((x) => x.groupId === r.groupId && x.date >= r.date)
      : [r];
    targets.forEach((x) => state.hidden.set(x.id, x.date));
    $('detailDialog').close();
    render();
    try {
      const res = await api('cancelReservation', { id: r.id, pin, scope });
      if (!res || !res.ok) throw Object.assign(new Error((res && res.message) || '取り消しに失敗しました。'), { code: res && res.code });
      removeMine(res.cancelledIds);
      toast(res.cancelledIds.length > 1 ? `${res.cancelledIds.length}件の予約を取り消しました` : '予約を取り消しました');
      invalidate(series ? undefined : [r.date]); // くり返し予約は他の日にもまたがるのですべて取り直す
      load({ force: true });
    } catch (ex) {
      targets.forEach((x) => state.hidden.delete(x.id)); // 画面を取消前の状態に戻す
      if (ex instanceof AuthError) { render(); return; }
      const message = errMessage(ex);
      if (ex.code === 'NOT_FOUND') {
        removeMine([r.id]);
        toast(message);
        invalidate([r.date]);
        load({ force: true });
        return;
      }
      render();
      toast(message, 'error');
      if (!anyDialogOpen()) {
        openDetail(r.id);
        $('dPin').value = pin;
        $('dError').textContent = message;
      }
    }
  }

  // ---------------- カレンダーに追加 ----------------
  // ボタンは1つ。iPhone はカレンダーのファイル（.ics）の URL を開くと標準のカレンダーに入る。Android は標準が Google カレンダーなので、その追加画面を開く
  // 予約者の名前などは入れず、部屋と時間だけを書く（Google の URL に個人の情報を載せないため）
  // 題名は部屋の名前だけ（設備のかっこ書きは付けない）。例: 練習室1の予約
  const calRoom = (r, room) => (room ? room.name : r.roomId);
  function calTitle(r, room) { return `${calRoom(r, room)}の予約`; }
  const CAL_PLACE = '宮城教育大学 音楽棟';
  /** 日本時間の日付と時刻を、カレンダーの書式（世界標準時 YYYYMMDDTHHMMSSZ）にする */
  function calStamp(date, hhmm) {
    const [y, mo, d] = date.split('-').map(Number);
    const [h, mi] = hhmm.split(':').map(Number);
    return new Date(Date.UTC(y, mo - 1, d, h - 9, mi)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }
  function googleCalendarUrl(r, room) {
    const q = new URLSearchParams({
      action: 'TEMPLATE', text: calTitle(r, room),
      dates: `${calStamp(r.date, r.start)}/${calStamp(r.date, r.end)}`,
      location: CAL_PLACE, details: location.origin + location.pathname,
    });
    return 'https://calendar.google.com/calendar/render?' + q.toString();
  }
  /**
   * iPhone 用: 高速キャッシュ（Cloudflare）の /ics の URL。Safari でこの URL を開くと、ダウンロードを挟まずに
   * 「カレンダーに追加」の画面がそのまま出る。高速キャッシュを使っていないときは '' を返し、下のファイル作成に切り替える
   */
  function icsUrl(r, room) {
    if (!window.CACHE_API_URL) return '';
    const q = new URLSearchParams({ id: r.id, room: calRoom(r, room), date: r.date, start: r.start, end: r.end, site: location.origin + location.pathname });
    return window.CACHE_API_URL.replace(/\/$/, '') + '/ics?' + q.toString();
  }
  /** iPhone のカレンダーに読み込めるファイル（.ics）を作って開く（高速キャッシュがないときの予備）。開始15分前に知らせる */
  function downloadIcs(r, room) {
    const icsText = (t) => String(t).replace(/[\\;,]/g, (c) => '\\' + c);
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//miyakyo-music//yoyaku//JA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${r.id}@miyakyo-music.github.io`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
      `DTSTART:${calStamp(r.date, r.start)}`, `DTEND:${calStamp(r.date, r.end)}`,
      `SUMMARY:${icsText(calTitle(r, room))}`, `LOCATION:${icsText(CAL_PLACE)}`,
      `DESCRIPTION:${icsText(location.origin + location.pathname)}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:練習室の予約', 'TRIGGER:-PT15M', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n');
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `練習室予約_${r.date}.ics`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  const IS_ANDROID = /Android/i.test(navigator.userAgent);
  $('dCalAdd').addEventListener('click', (e) => {
    const r = state.detail;
    if (!r || $('dCalAdd').getAttribute('href') !== '#') return; // URL があれば、そのまま開く
    e.preventDefault();
    downloadIcs(r, state.rooms.find((x) => x.id === r.roomId));
  });

  // ---------------- アプリのように使う（ホーム画面に追加したとき。sw.js） ----------------
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* 使えない環境では何もしない */ }); });
  }

  // ---------------- この端末の予約一覧 ----------------
  // ---------------- 練習時間（この端末で予約した分の集計） ----------------
  // 「自分の予約」の小窓の「練習時間」。端末の記録（LS.history）の予約をサーバーから読み直して数える
  // （取り消された予約はサーバーに無いので数えない）。終わった分を「練習した時間」、これからの分を「予定」とする
  function setMyTab(tab) {
    for (const b of $('myTabs').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.my === tab));
    $('myListPane').hidden = tab !== 'list';
    $('myStatsPane').hidden = tab !== 'stats';
    if (tab === 'stats') loadMyStats();
  }
  $('myTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-my]'); if (b) setMyTab(b.dataset.my); });
  $('myPeriod').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-p]');
    if (!b) return;
    for (const x of $('myPeriod').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    renderMyStats();
  });
  /** 期間（今週＝月〜日、今月、今年度＝4月1日〜3月31日） */
  function myPeriodRange(p) {
    const t = todayStr();
    const d = parseDate(t);
    if (p === 'week') { const from = addDays(t, -((d.getDay() + 6) % 7)); return { from, to: addDays(from, 6) }; }
    if (p === 'month') { const from = t.slice(0, 8) + '01'; return { from, to: addDays(addMonths(from, 1), -1) }; }
    const fy = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    return { from: `${fy}-04-01`, to: `${fy + 1}-03-31` };
  }
  async function loadMyStats() {
    const body = $('myStatsBody');
    const h = load_(LS.history, {});
    const ids = Object.keys(h);
    if (!ids.length) { state.myStats = []; renderMyStats(); return; }
    body.innerHTML = '<p class="ms-empty">読み込み中…</p>';
    try {
      const list = [];
      for (let i = 0; i < ids.length; i += 300) { // サーバーは1回300件まで
        const res = await api('getReservationsByIds', { ids: ids.slice(i, i + 300) });
        if (!res.ok) throw new Error(res.message);
        list.push(...res.reservations);
        state.myStatsRooms = res.rooms;
      }
      state.myStats = list;
      renderMyStats();
    } catch (e) {
      if (!(e instanceof AuthError)) body.innerHTML = `<p class="ms-empty">${esc(errMessage(e))}</p>`;
    }
  }
  function renderMyStats() {
    const body = $('myStatsBody');
    const list = state.myStats;
    if (!list) return;
    const p = ($('myPeriod').querySelector('[aria-pressed="true"]') || {}).dataset.p || 'month';
    const { from, to } = myPeriodRange(p);
    const today = todayStr(), now = nowMin();
    const inRange = list.filter((r) => r.date >= from && r.date <= to);
    const ended = (r) => r.date < today || (r.date === today && toMin(r.end) <= now);
    const dur = (r) => toMin(r.end) - toMin(r.start);
    const done = inRange.filter(ended);
    const planned = inRange.filter((r) => !ended(r));
    const total = done.reduce((a, r) => a + dur(r), 0);
    const plan = planned.reduce((a, r) => a + dur(r), 0);
    if (!done.length && !planned.length) { body.innerHTML = '<p class="ms-empty">この期間の、この端末からの予約はありません。</p>'; return; }
    const hh = (m) => (m ? durationLabel(m) : '0分');
    // 部屋ごと（多い順、上位6つ）と曜日ごと（終わった分）
    const rooms = state.myStatsRooms || state.rooms;
    const byRoom = {};
    for (const r of done) byRoom[r.roomId] = (byRoom[r.roomId] || 0) + dur(r);
    const roomRows = Object.entries(byRoom).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const maxRoom = roomRows.length ? roomRows[0][1] : 1;
    const byDow = [0, 0, 0, 0, 0, 0, 0];
    for (const r of done) byDow[weekday(r.date)] += dur(r);
    const maxDow = Math.max(1, ...byDow);
    const order = [1, 2, 3, 4, 5, 6, 0]; // 月曜はじまり
    body.innerHTML =
      `<div class="ms-total"><b>${hh(total)}</b><span>${done.length}回${plan ? `・このあと予定 ${hh(plan)}` : ''}</span></div>` +
      (roomRows.length ? `<p class="ms-h">部屋ごと</p><div class="ms-bars">` + roomRows.map(([id, m]) => {
        const rm = rooms.find((x) => x.id === id);
        return `<div class="ms-bar"><span>${esc(rm ? roomText(rm) : id)}</span><i style="width:${(m / maxRoom * 100).toFixed(1)}%"></i><em>${hh(m)}</em></div>`;
      }).join('') + '</div>' : '') +
      (done.length ? `<p class="ms-h">曜日ごと</p><div class="ms-week">` + order.map((w) =>
        `<div class="${w === 0 ? 'sun' : w === 6 ? 'sat' : ''}" title="${WEEKDAYS[w]}曜 ${hh(byDow[w])}"><i style="height:${(byDow[w] / maxDow * 70).toFixed(1)}px"></i>${WEEKDAYS[w]}</div>`).join('') + '</div>' : '') +
      '<p class="hint">この端末から予約した分です（取り消した予約は数えません）。</p>';
  }

  async function openMyList() {
    setMyTab('list');
    state.myStats = null;
    const mine = getMine();
    const today = todayStr();
    const ids = Object.keys(mine).filter((id) => mine[id] >= today);
    const list = $('myList');
    list.innerHTML = '<li class="hint">読み込み中…</li>';
    $('myDialog').showModal();
    if (!ids.length) { list.innerHTML = '<li class="hint">予約はありません。</li>'; return; }
    try {
      const res = await api('getReservationsByIds', { ids });
      if (!res.ok) throw new Error(res.message);
      const found = new Set(res.reservations.map((r) => r.id));
      removeMine(ids.filter((id) => !found.has(id))); // 取り消された予約は一覧から消す
      const now = nowMin();
      const upcoming = res.reservations.filter((r) => r.date > today || toMin(r.end) > now);
      list.innerHTML = upcoming.length ? upcoming.map((r) => {
        const room = res.rooms.find((x) => x.id === r.roomId);
        return `<li><button type="button" data-date="${r.date}" data-id="${esc(r.id)}">` +
          `<b>${esc(mdLabel(r.date))} ${esc(hm(r.start))}〜${esc(hm(r.end))}</b>` +
          `<span>${esc(room ? roomText(room) : r.roomId)}　${esc(personText(r))}${r.groupId ? '　↻まとめ予約' : ''}</span></button></li>`;
      }).join('') : '<li class="hint">予約はありません。</li>';
    } catch (e) {
      if (!(e instanceof AuthError)) list.innerHTML = `<li class="error">${esc(errMessage(e))}</li>`;
    }
  }

  $('myList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    $('myDialog').close();
    state.view = 'day';
    save_(LS.view, 'day');
    state.date = b.dataset.date;
    if (state.data) applySettings();
    updateChrome();
    load({ then: () => openDetail(b.dataset.id) });
  });

  // ---------------- 閲覧パスワード ----------------
  function showLogin(message) {
    if ($('loginDialog').open) { $('lError').textContent = message; return; }
    $('lError').textContent = state.viewKey ? message : '';
    $('lPass').value = '';
    $('loginDialog').showModal();
  }
  $('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    state.viewKey = $('lPass').value;
    save_(LS.viewKey, state.viewKey);
    $('loginDialog').close();
    invalidate();
    load({ force: true });
  });
  $('loginDialog').addEventListener('cancel', (e) => e.preventDefault());
  // Esc で予約の詳細を閉じるときも、帯へ縮んで戻る
  $('detailDialog').addEventListener('cancel', (e) => { if (VT_OK) { e.preventDefault(); closeDetail(); } });

  // ---------------- 限定公開の部屋（演習室など） ----------------
  // 一般の利用者には存在を知らせないため、入口は …/yoyaku/?limited の URL だけ。パスワードを確かめてから端末に記憶する。
  function endLimited(message) {
    state.limitedKey = '';
    save_(LS.limitedKey, '');
    $('limitedMode').hidden = true;
    invalidate();
    if (message) toast(message, 'error');
  }
  $('limitedForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = $('limPass').value.trim();
    if (!key) { $('limError').textContent = 'パスワードを入力してください。'; return; }
    $('limSubmit').disabled = true;
    $('limError').textContent = '';
    try {
      const res = await api('getSchedule', Object.assign(currentRange(), { limitedKey: key }));
      if (!res || !res.limitedAccess) throw new Error((res && !res.ok && res.message) || 'パスワードが違います。');
      state.limitedKey = key;
      save_(LS.limitedKey, key);
      $('limitedDialog').close();
      focusLimitedRooms(res.rooms);
      invalidate();
      load({ force: true });
      toast('この端末で、限定公開の部屋を表示します。');
    } catch (ex) {
      if (!(ex instanceof AuthError)) $('limError').textContent = errMessage(ex);
    } finally {
      $('limSubmit').disabled = false;
    }
  });
  /** 設備の絞り込みを、限定公開の部屋の設備区分（例：演習室）にする。一覧表示に切り替える */
  function focusLimitedRooms(rooms) {
    const counts = {};
    for (const r of rooms) if (r.restriction === LIMITED && r.equipment) counts[r.equipment] = (counts[r.equipment] || 0) + 1;
    const equip = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    if (equip) state.equipOnce = equip;
    if (state.view !== 'day') { state.view = 'day'; save_(LS.view, 'day'); updateChrome(); }
  }
  $('limitedMode').addEventListener('click', () => {
    if (!confirm('限定公開の部屋の表示を終了しますか？（再び表示するには、パスワードの入力が必要です）')) return;
    endLimited();
    location.reload(); // 表示中の演習室などが画面に残らないよう、読み込み直す
  });

  // ---------------- イベント ----------------
  $('prevBtn').addEventListener('click', () => shift(-1));
  $('nextBtn').addEventListener('click', () => shift(1));
  $('todayBtn').addEventListener('click', () => setDate(todayStr()));
  $('datePicker').addEventListener('change', (e) => setDate(e.target.value));
  $('refreshBtn').addEventListener('click', () => { invalidate(); load({ force: true }); });
  $('fabBtn').addEventListener('click', () => $('newBtn').click());
  $('newBtn').addEventListener('click', () => {
    if (!state.settings) return;
    const date = state.view === 'day' && state.date >= todayStr() ? state.date : todayStr();
    openBooking({ mode: 'create', date, roomId: state.view === 'day' ? '' : state.roomId });
  });
  $('myBtn').addEventListener('click', openMyList);
  $('adminMode').addEventListener('click', () => {
    if (!confirm('管理者モードを終了しますか？（管理画面からもログアウトします）')) return;
    exitAdminMode();
    location.reload(); // 管理者モードでだけ見えていた部屋（限定公開など）が画面に残らないよう、読み込み直す
  });
  for (const b of document.querySelectorAll('.tabs .btn')) b.addEventListener('click', () => setView(b.dataset.view));
  $('equipFilter').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v === FAV_EDIT || (v === FAV && !getFavs().size)) {
      // 選ぶ画面を開く。選び終わったら「★ お気に入り」で絞り込む（1つも選ばなければ元に戻す）
      e.target.value = load_(LS.filter, '');
      openFavs();
      return;
    }
    state.equipOnce = null; save_(LS.filter, v); if (state.data) render();
  });

  // ---------------- 予約の検索 ----------------
  // 今日から予約を受け付けている先まで（30〜180日）の予約を、予約表と同じ読み方（高速キャッシュ → GAS）で42日ずつ読み、
  // 画面の中で探す。全角・半角、大文字・小文字、ひらがな・カタカナ、空白の違いは区別しない
  const normText = (t) => String(t || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '')
    .replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  async function openSearch() {
    $('searchDialog').showModal();
    $('searchInput').focus();
    const s = state.settings;
    const days = Math.min(180, Math.max(30, Number(s && s.maxDaysAhead) || 60));
    const from = todayStr(), to = addDays(from, days);
    if (state.search && state.search.from === from && Date.now() - state.search.at < 60 * 1000) { runSearch(); return; }
    state.search = null;
    $('searchInfo').textContent = '読み込み中…';
    try {
      const ranges = [];
      for (let d = from; d <= to; d = addDays(d, 42)) ranges.push({ from: d, to: addDays(d, 41) < to ? addDays(d, 41) : to });
      const results = await Promise.all(ranges.map((r) => fetchRange(r)));
      const seen = new Set();
      const list = [];
      for (const res of results) for (const r of res.reservations) if (!seen.has(r.id)) { seen.add(r.id); list.push(r); }
      list.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
      state.search = { from, to, at: Date.now(), list, rooms: results[0] ? results[0].rooms : state.rooms };
      runSearch();
    } catch (e) {
      if (!(e instanceof AuthError)) $('searchInfo').textContent = errMessage(e);
    }
  }
  function runSearch() {
    const sr = state.search;
    if (!sr) return;
    const q = normText($('searchInput').value);
    const range = `${mdLabel(sr.from)}〜${mdLabel(sr.to)}`;
    if (!q) { $('searchInfo').textContent = `${range}の予約から探します`; $('searchList').innerHTML = ''; return; }
    const now = nowMin(), today = todayStr();
    const roomOf = (id) => sr.rooms.find((x) => x.id === id) || roomById(id);
    const hits = sr.list.filter((r) => {
      if (r.date === today && toMin(r.end) <= now) return false; // 今日の終わった予約は出さない
      const rm = roomOf(r.roomId);
      return normText([r.name, r.affiliation, r.memo, rm ? roomText(rm) : ''].join(' ')).includes(q);
    });
    $('searchInfo').textContent = hits.length ? `${hits.length}件（${range}）` : `見つかりません（${range}）`;
    const mark = (t) => {
      // 一致した所に印を付ける（文字の並びが同じときだけ。表記ゆれで一致したときは印なし）
      const raw = String(t || '');
      const i = raw.toLowerCase().indexOf($('searchInput').value.trim().toLowerCase());
      const n = $('searchInput').value.trim().length;
      return i >= 0 && n ? esc(raw.slice(0, i)) + `<mark>${esc(raw.slice(i, i + n))}</mark>` + esc(raw.slice(i + n)) : esc(raw);
    };
    $('searchList').innerHTML = hits.slice(0, 200).map((r) => {
      const rm = roomOf(r.roomId);
      return `<li><button type="button" data-date="${r.date}" data-id="${esc(r.id)}">` +
        `<b>${esc(mdLabel(r.date))} ${esc(hm(r.start))}〜${esc(hm(r.end))}　${esc(rm ? roomText(rm) : r.roomId)}</b>` +
        `<span>${mark(r.name)}${r.affiliation ? `（${mark(r.affiliation)}）` : ''}${r.memo ? `　${mark(r.memo)}` : ''}</span></button></li>`;
    }).join('');
  }
  let searchTimer = 0;
  $('searchInput').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 120); });
  $('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
  $('searchBtn').addEventListener('click', openSearch);
  $('searchList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    $('searchDialog').close();
    state.view = 'day';
    save_(LS.view, 'day');
    state.date = b.dataset.date;
    if (state.data) applySettings();
    updateChrome();
    load({ then: () => openDetail(b.dataset.id) });
  });

  // ---------------- お気に入りの練習室 ----------------
  function openFavs() {
    state.favDraft = getFavs();
    $('favRooms').innerHTML = roomGridHtml(state.favDraft, '', '');
    $('favDialog').showModal();
  }
  $('favRooms').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id], button[data-group]');
    if (!b) return;
    const set = state.favDraft;
    const ids = b.dataset.group ? state.rooms.filter((r) => r.name === b.dataset.group && r.restriction !== STOPPED).map((r) => r.id) : [b.dataset.id];
    const allOn = ids.every((id) => set.has(id));
    ids.forEach((id) => (allOn ? set.delete(id) : set.add(id)));
    $('favRooms').innerHTML = roomGridHtml(set, '', '');
  });
  $('favDialog').addEventListener('close', () => {
    const favs = [...(state.favDraft || [])];
    save_(LS.fav, favs);
    const next = favs.length ? FAV : (load_(LS.filter, '') === FAV ? '' : load_(LS.filter, ''));
    save_(LS.filter, next);
    $('equipFilter').value = next;
    state.equipOnce = null;
    if (state.data) render();
  });
  $('freeBtn').addEventListener('click', () => {
    state.freeNow = !state.freeNow;
    $('freeBtn').setAttribute('aria-pressed', String(state.freeNow));
    // 今日以外を表示しているときは今日に移る
    if (state.freeNow && state.date !== todayStr()) { setDate(todayStr()); return; }
    if (state.data) { render(); scrollToNow(); }
  });
  $('roomSelect').addEventListener('change', (e) => { state.roomId = e.target.value; save_(LS.room, state.roomId); updateChrome(); if (state.data) render(); });

  $('bookForm').addEventListener('submit', submitBooking);
  $('bookDialog').addEventListener('close', renderDraft); // 閉じたら仮予約の帯を消す
  $('bRoom').addEventListener('change', () => { state.extraRooms.delete($('bRoom').value); renderRoomPicker(); });
  $('bRoomQuick').addEventListener('click', (e) => {
    const b = e.target.closest('.rq');
    if (!b) return;
    $('bRoom').value = b.dataset.id;
    $('bRoom').dispatchEvent(new Event('change'));
    $('bRoomQuickField').hidden = true;
    $('bRoomField').hidden = false;
    renderDraft();
    $('bError').textContent = '';
    if (!$('bPerson').value) $('bPerson').focus();
  });
  $('bSeries').addEventListener('change', updateBookingUi);

  // ---------------- お知らせをその場で変更（管理者モードのとき、お知らせを押す） ----------------
  function openNoticeEditor() {
    if (!isAdminMode() || state.noticeEditing) return;
    state.noticeEditing = true;
    $('noticeInput').value = state.settings.notice || '';
    $('noticeLevel').value = state.settings.noticeLevel === '重要' ? '重要' : '通常';
    $('notice').hidden = true;
    $('noticeEditor').hidden = false;
    $('noticeRow').hidden = false;
    $('noticeInput').focus();
  }
  function closeNoticeEditor() {
    state.noticeEditing = false;
    $('noticeEditor').hidden = true;
    $('notice').hidden = false;
    applySettings();
  }
  $('notice').addEventListener('click', openNoticeEditor);
  $('noticeCancel').addEventListener('click', closeNoticeEditor);
  $('noticeEditor').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNoticeEditor(); });
  $('noticeEditor').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('noticeSave');
    btn.disabled = true;
    try {
      const res = await api('adminSetNotice', { notice: $('noticeInput').value.trim(), noticeLevel: $('noticeLevel').value });
      if (!res || !res.ok) throw new Error((res && res.message) || '保存できませんでした。');
      state.settings = Object.assign({}, state.settings, { notice: res.settings.notice, noticeLevel: res.settings.noticeLevel });
      if (state.data) state.data.settings = state.settings;
      closeNoticeEditor();
      toast(res.settings.notice ? 'お知らせを変更しました' : 'お知らせを非表示にしました');
      invalidate();
    } catch (ex) {
      if (!(ex instanceof AuthError)) toast(errMessage(ex), 'error');
    } finally {
      btn.disabled = false;
    }
  });
  for (const id of ['bRoom', 'bDate', 'bStartH', 'bStartM', 'bEndH', 'bEndM', 'bInterval', 'bUntil']) {
    $(id).addEventListener('change', () => { resetConflicts(); updateBookingUi(); });
  }
  $('bRepeat').addEventListener('change', (e) => { $('bRepeatArea').hidden = !e.target.checked; resetConflicts(); updateBookingUi(); });
  $('bPin').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  });
  $('detailForm').addEventListener('submit', submitCancel);
  $('dEdit').addEventListener('click', editFromDetail);

  // 小窓の中身のうち、下端のボタン（.actions）より前を .dlg-main に包む（スクロールするのはこの中だけ）
  for (const box of document.querySelectorAll('dialog > form, dialog > .body')) {
    const act = box.querySelector(':scope > .actions');
    if (!act) continue;
    const main = document.createElement('div');
    main.className = 'dlg-main';
    while (box.firstChild !== act) main.appendChild(box.firstChild);
    box.insertBefore(main, act);
  }
  // <dialog> 非対応ブラウザ（iOS/iPadOS 15.3以前の Safari など）では簡易的な代替実装を使う
  const dialogs = [...document.querySelectorAll('dialog')];
  if (typeof HTMLDialogElement !== 'function' || !HTMLDialogElement.prototype.showModal || location.hash === '#nodialog') {
    document.body.classList.add('dialog-fallback');
    const syncBackdrop = () => document.body.classList.toggle('modal-open', dialogs.some((d) => d.hasAttribute('open')));
    for (const d of dialogs) {
      Object.defineProperty(d, 'open', { configurable: true, get() { return this.hasAttribute('open'); } });
      d.showModal = function () { this.setAttribute('open', ''); syncBackdrop(); };
      d.close = function () { if (!this.hasAttribute('open')) return; this.removeAttribute('open'); syncBackdrop(); this.dispatchEvent(new Event('close')); };
    }
    $('dialogBackdrop').addEventListener('click', () => dialogs.filter((d) => d.id !== 'loginDialog').forEach((d) => d.close()));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dialogs.filter((d) => d.id !== 'loginDialog').forEach((d) => d.close()); });
  }
  // 小窓を開くとき、直前に押した位置（1.5秒以内）から広がるように、画面中央からのずれを渡す。
  // キーボード操作などで押した位置がないときは、中央から広がる。
  let lastPoint = null;
  const notePoint = (e) => { lastPoint = { x: e.clientX, y: e.clientY, t: Date.now() }; };
  document.addEventListener('pointerdown', notePoint, true);
  document.addEventListener('pointerup', notePoint, true);
  if (!document.body.classList.contains('dialog-fallback')) {
    for (const d of dialogs) {
      const show = d.showModal;
      d.showModal = function () {
        const p = lastPoint && Date.now() - lastPoint.t < 1500 ? lastPoint : null;
        this.style.setProperty('--dx', p ? `${Math.round(p.x - innerWidth / 2)}px` : '0px');
        this.style.setProperty('--dy', p ? `${Math.round(p.y - innerHeight / 2)}px` : '0px');
        return show.call(this);
      };
    }
  }
  for (const dlg of dialogs) {
    dlg.addEventListener('click', (e) => {
      if ((e.target === dlg && dlg.id !== 'loginDialog') || (e.target.hasAttribute && e.target.hasAttribute('data-close'))) {
        if (dlg.id === 'detailDialog') closeDetail(); else dlg.close();
      }
    });
  }

  // 入力欄で改行キー（iPhone のキーボードの「改行」も含む）を押しても送信しない。
  // 予約・取消・不具合報告は、ボタンを押したときだけ送信する（入力途中で予約が確定してしまうのを防ぐ）。
  // 予約画面では次の入力欄へ移り、最後の欄ではキーボードを閉じる。
  for (const form of [$('bookForm'), $('detailForm'), $('bugForm')]) {
    const fields = () => [...form.querySelectorAll('input:not([type=checkbox]):not([type=radio]), select, textarea')]
      .filter((el) => !el.disabled && el.offsetParent !== null);
    for (const el of form.querySelectorAll('input:not([type=checkbox]):not([type=radio])')) el.enterKeyHint = 'next';
    for (const id of ['bPin', 'bAdmin', 'dPin', 'bugContact']) $(id).enterKeyHint = 'done';
    form.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT' || ['checkbox', 'radio'].includes(e.target.type)) return;
      if (e.isComposing || e.keyCode === 229) return; // 日本語入力の変換確定
      e.preventDefault();
      const list = fields().filter((el) => el.tagName === 'INPUT' && el.type !== 'date'); // 日付欄に移ると選択画面が開くので飛ばす
      const next = list[list.indexOf(e.target) + 1];
      if (next && form.id === 'bookForm') next.focus();
      else e.target.blur();
    });
  }

  // パスワード欄に「表示」ボタンを付け、ダイアログを閉じたら伏せ字に戻す（web/api.js）
  addRevealButtons(document);
  for (const dlg of dialogs) dlg.addEventListener('close', () => hideSecrets(dlg));

  const anyDialogOpen = () => dialogs.some((d) => d.open);
  // ---------------- 自動更新（操作の邪魔をしない） ----------------
  const IDLE_MS = 3000; // 最後の操作からこの時間が過ぎるまでは、画面を描き直さない
  let lastActive = 0;
  for (const type of ['pointerdown', 'pointermove', 'touchstart', 'touchmove', 'wheel', 'scroll', 'keydown', 'input']) {
    window.addEventListener(type, () => { lastActive = Date.now(); }, { capture: true, passive: true });
  }
  /** 操作中か（指やマウスで触れている・ダイアログを開いている・直前に操作した） */
  function userBusy() {
    return !!(touch || pinch || mouse || drag) || anyDialogOpen() || Date.now() - lastActive < IDLE_MS;
  }
  setInterval(() => {
    if (!document.hidden && state.data && !userBusy()) load({ force: true, background: true });
  }, AUTO_REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.data && !anyDialogOpen()) load({ force: true, background: true });
  });

  // ---------------- 不具合報告 ----------------
  /** 報告に添える実行環境の情報 */
  function collectEnv() {
    let storage = 'ok';
    try { localStorage.setItem('prr.test', '1'); localStorage.removeItem('prr.test'); } catch (e) { storage = '使用不可'; }
    const viewName = { day: '一覧', room: '部屋別', month: 'カレンダー' }[state.view];
    const room = state.view !== 'day' ? roomById(state.roomId) : null;
    return {
      appVersion: APP_VERSION,
      reportedAt: new Date().toLocaleString('ja-JP'),
      userAgent: navigator.userAgent,
      language: navigator.language,
      screen: `画面 ${screen.width}×${screen.height}（${window.devicePixelRatio}倍）/ 表示領域 ${window.innerWidth}×${window.innerHeight}`,
      page: `${viewName} ${state.date}${room ? ' ' + roomText(room) : ''}`,
      touch: !!(window.matchMedia && matchMedia('(pointer: coarse)').matches),
      adminMode: isAdminMode(),
      localStorage: storage,
      profileSaved: !!load_(LS.profile, null),
      myReservations: Object.keys(getMine()).length,
      online: navigator.onLine,
      lastError: state.lastError,
    };
  }
  function openBug() {
    $('bugMsg').value = '';
    $('bugError').textContent = '';
    $('bugEnv').textContent = Object.entries(collectEnv()).map(([k, v]) => `${k}: ${v}`).join('\n');
    $('bugDialog').showModal();
  }
  document.addEventListener('click', (e) => { if (e.target.closest('[data-bug]')) openBug(); });
  $('bugForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = $('bugMsg').value.trim();
    if (!message) { $('bugError').textContent = '内容を入力してください。'; $('bugMsg').focus(); return; }
    const btn = $('bugSubmit');
    btn.disabled = true;
    $('bugError').textContent = '';
    try {
      const res = await api('submitBugReport', { message, contact: $('bugContact').value.trim(), env: collectEnv() });
      if (!res || !res.ok) throw new Error((res && res.message) || '送信できませんでした。');
      $('bugDialog').close();
      toast('報告を送信しました。ご協力ありがとうございます。');
    } catch (ex) {
      if (!(ex instanceof AuthError)) $('bugError').textContent = errMessage(ex);
    } finally {
      btn.disabled = false;
    }
  });

  // ---------------- 起動 ----------------
  if (!['day', 'room', 'month'].includes(state.view)) state.view = 'day';
  // 限定公開の部屋の入口（…/yoyaku/?limited）。URL からは外し、ブックマークや共有で広まらないようにする。
  // 記憶済みのパスワードで見られればそのまま演習室などを表示し、見られなければ最初の表示のあとでパスワードを尋ねる
  if (/[?&]limited\b/.test(location.search)) {
    history.replaceState(null, '', location.pathname + location.hash);
    state.limitedEntry = true;
    state.view = 'day';
  }
  // 管理画面から戻ったとき（このタブで管理画面を開いた印があるとき）は、部屋や設定が変わっているかもしれないので、
  // 前回の表を出さずに最初から読み込む。ブラウザの「戻る」で古い画面がそのまま出たときは、ページごと読み直す
  try {
    state.skipSnapshot = sessionStorage.getItem('prr.fromAdmin') === '1';
    sessionStorage.removeItem('prr.fromAdmin');
  } catch (e) { /* 保存できない環境では何もしない */ }
  window.addEventListener('pageshow', (e) => {
    let fromAdmin = false;
    try { fromAdmin = sessionStorage.getItem('prr.fromAdmin') === '1'; } catch (err) { /* 何もしない */ }
    if (e.persisted && fromAdmin) location.reload();
  });
  updateChrome();
  load(state.skipSnapshot ? { force: true } : undefined);
})();
