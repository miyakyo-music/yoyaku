// 予約表: 予約データの読み込み。GAS・高速キャッシュとの通信、表示する期間、読み込んだ予約の覚え
'use strict';

// ---------------- API呼び出し ----------------
class AuthError extends Error {}
/** 予約表の通信。管理画面の api（admin/core.js）と違い、閲覧パスワード・限定公開・管理者モードの印を添え、
 *  AUTH_REQUIRED は画面のログインに渡す（管理者モードの期限切れは、一般の見え方で読み直す） */
async function api(fn, payload, opts) {
  const body = Object.assign({}, payload, { viewKey: state.viewKey });
  if (state.limitedKey && !body.limitedKey) body.limitedKey = state.limitedKey;
  // 管理者モードでは読み込みにも管理用パスワードを添える（限定公開の部屋も表示するため）
  const adminOps = ['getSchedule', 'getReservationsByIds', 'findMyReservations', 'createReservation', 'createBulkReservations', 'updateReservation', 'cancelReservation', 'adminSetNotice'];
  if (state.adminPw && adminOps.includes(fn) && !body.adminPassword) body.adminPassword = state.adminPw;
  let res = await callApi(fn, body, opts); // web/api.js
  // 読み込みで管理者モードの印が通らなかった（期限切れ・パスワード変更）: 管理者モードを終えて、一般の見え方で読み直す
  if (res && res.code === 'ADMIN_AUTH' && body.adminPassword && (fn === 'getSchedule' || fn === 'getReservationsByIds' || fn === 'findMyReservations')) {
    exitAdminMode('管理者モードを終了しました（' + String(res.message || '管理用パスワードが変更された可能性があります').replace(/。$/, '') + '）。');
    delete body.adminPassword;
    res = await callApi(fn, body, opts);
  }
  // 予約・変更・取消などの書き込みが通ったら、しばらくは高速キャッシュを使わずサーバーから読む
  if (res && res.ok && fn !== 'getSchedule' && fn !== 'getReservationsByIds' && fn !== 'findMyReservations') state.noCacheUntil = Date.now() + 2 * 60 * 1000;
  if (res && res.code === 'AUTH_REQUIRED') { forgetSnapshot(); showLogin(res.message); throw new AuthError(res.message); }
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
  state.loadFailed = false;
  const range = currentRange();
  const key = rangeKey(range);
  const hit = state.cache.get(key);
  const offline = isOffline();
  // オフラインの間は、古くなっていても覚えている表を出す（通信はしない）
  if ((!opts.force || offline) && hit && (offline || Date.now() - hit.at < CACHE_TTL_MS)) {
    document.body.classList.remove('loading');
    show(hit, key);
    afterShow(opts);
    if (offline && opts.force && !opts.background) toast('オフラインです。電波が戻ると最新の予約に更新します。');
    return;
  }
  // 開いた直後: 前回と同じ表示なら、端末に覚えておいた予約表をすぐ出し、最新の取得は裏で行って差し替える
  if (!state.data && !hit && !state.skipSnapshot) {
    const snap = load_(LS.snapshot, null);
    if (snap && snap.key === `${state.view}|${key}` && (offline || Date.now() - snap.at < 24 * 3600 * 1000)) {
      show({ res: snap.res, at: snap.at, saved: true }, key);
      if (offline) return;
      $('statusText').textContent = '更新中…';
      opts = Object.assign({}, opts, { background: true });
    }
  }
  // オフラインで覚えていない期間: 前の表を残すと、別の日の予約が空いて見えるので、表を出さない（render が知らせを出す）
  if (offline) {
    render();
    if (!opts.background) toast('オフラインです。電波が戻ると最新の予約に更新します。');
    return;
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
    // 前回の表・高速キャッシュの写しを出して「更新中…」にしていたら、出している表の時刻に戻す
    if (seq === state.seq && state.data) stampStatus();
    if (opts.background) return; // 自動更新の失敗は知らせない（次の更新で取り直す）
    if (seq === state.seq && !(e instanceof AuthError)) {
      toast(errMessage(e), 'error');
      if (!state.data) $('main').innerHTML = `<p class="empty">${esc(errMessage(e))}</p>`;
      // 日付を移した直後に失敗したとき: 見出しは新しい日・中身は前の日、にならないよう、表を出さない（render が知らせを出す）
      else if (state.shownKey !== `${state.view}|${key}`) { state.loadFailed = true; render(); }
    }
  } finally {
    if (seq === state.seq) document.body.classList.remove('loading');
  }
}

/** 更新ボタンの文字（いつの表か）。オフラインの間は「オフライン（17:40 時点）」 */
function stampStatus(at) {
  if (at) state.shownAt = at;
  const t = new Date(state.shownAt || Date.now());
  const hm_ = `${t.getHours()}:${pad(t.getMinutes())}`;
  $('statusText').textContent = isOffline() ? (state.shownAt ? `オフライン（${hm_} 時点）` : 'オフライン') : `${hm_} 更新`;
}

function show(entry, key) {
  const res = entry.res;
  const shownKey = `${state.view}|${key}`;
  const keyChanged = state.shownKey !== shownKey;
  state.shownKey = shownKey;
  if (res.limitedDenied && state.limitedKey) endLimited('限定公開の部屋のパスワードが変更されたため、表示を終了しました。');
  // パスワードは合っているが、間違いが続いてサーバーがしばらく受け付けないとき: 端末のパスワードは残し、限定公開のまま知らせる
  // （限定公開の部屋はその間だけ表に出ない。自動更新のたびに知らせないよう、5分あける）
  const locked = !!(res.limitedLocked && state.limitedKey && !entry.saved);
  if (locked && !(Date.now() - (state.limitedLockedAt || 0) < 5 * 60 * 1000)) {
    state.limitedLockedAt = Date.now();
    toast('限定公開の部屋を表示できませんでした。しばらくしてからもう一度お試しください。', 'error');
  }
  if (locked && state.limitedEntry) { state.limitedEntry = false; dropLimitedQuery(); } // 入口の URL から来ても、パスワードは尋ねない
  if (state.limitedEntry && res.ok && !entry.saved) {
    // 入口の URL から来たとき: 見られれば設備の絞り込みを演習室などに合わせ、見られなければパスワードを尋ねる。
    // 端末に覚えておいた前回の表では決めない（管理者モードで覚えた表は「見られる」になっていて、尋ねずに終わっていた）
    state.limitedEntry = false;
    if (res.limitedAccess) { focusLimitedRooms(res.rooms); dropLimitedQuery(); } else askLimited();
  }
  $('limitedMode').hidden = !(state.limitedKey && (res.limitedAccess || res.limitedLocked));
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
  stampStatus(entry.at);
  // 次に開いたときにすぐ出せるよう、端末に覚えておく。閲覧パスワードが必要な予約表と、管理者モード・限定公開で見た表は
  // 覚えない（一般の人に見せない部屋や予約が、終了したあとや同じ端末の次の人に、開いた直後に一瞬出てしまうため）
  if (!res.settings.viewPasswordRequired && !state.adminPw && !state.limitedKey) save_(LS.snapshot, { key: shownKey, res, at: entry.at });
}

/**
 * 自動更新の結果を反映する。内容が変わっていなければ描き直さず、
 * 操作中（スクロール・タップ・ピンチ・入力など）なら、操作が終わるまで待ってから描き直す。
 */
function showInBackground(entry, key, seq) {
  const sig = (r) => JSON.stringify([r.reservations, r.closures, r.rooms, r.settings]);
  // 中身が同じなら描き直さない（ただし ?limited から来たときは、パスワードを尋ねるかをここで決めるので描き直す）
  if (!state.limitedEntry && state.data && state.shownKey === `${state.view}|${key}` && sig(entry.res) === sig(state.data)) {
    stampStatus(entry.at);
    // 現在時刻の線・過ぎた時間・空室ランプ・終わった帯は時刻で変わるので、今日を含む表は、描いた分から変わっていれば描き直す
    const today = todayStr();
    const showsToday = today >= state.data.from && today <= state.data.to;
    if ((showsToday || !String(state.renderedAt).startsWith(today)) && state.renderedAt !== `${today} ${nowMin()}` && !userBusy()) render();
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
  if (isOffline()) return;
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
  for (const p of state.pending) if (p.r.date >= from && p.r.date <= to && !ids.has(p.r.id) && !state.hidden.has(p.r.id)) list.push(p.r);
  return list;
}

/** その日・部屋で、時間（分）が重なる表示中の予約（exceptId の予約は除く）。なければ undefined */
function findClash(date, roomId, start, end, exceptId) {
  return visibleReservations().find((r) => r.id !== exceptId && r.date === date && r.roomId === roomId && toMin(r.start) < end && start < toMin(r.end));
}

function applySettings() {
  const s = state.settings;
  save_(LS.closeTime, s.closeTime);
  $('title').textContent = s.title;
  document.title = s.title;
  $('noticeRow').hidden = !s.notice;
  $('noticeText').textContent = s.notice || '';
  $('notice').classList.toggle('important', s.noticeLevel === '重要');
  $('notice').classList.toggle('editable', isAdminMode());
  $('notice').title = isAdminMode() ? '押すとお知らせを変更できます' : '';
  if (typeof markNoticeOverflow === 'function') markNoticeOverflow();
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
  rs.value = shownRoomId();
  if (rs.value !== shownRoomId()) rs.value = '';
}

/** 日付欄の表示（例：2026/10/09(金) とカレンダーのアイコン） */
function dateDisplayHtml(date) {
  if (!date) return '<span>日付を選択</span>';
  const dd = parseDate(date);
  const w = dd.getDay();
  return `<span><span class="yr">${dd.getFullYear()}/</span>${pad(dd.getMonth() + 1)}/${pad(dd.getDate())}` +
    `<span class="${w === 6 ? 'sat' : w === 0 ? 'sun' : ''}">(${WEEKDAY_NAMES[w]})</span></span>` +
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/></svg>';
}
