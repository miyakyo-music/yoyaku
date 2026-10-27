// 予約表: 共通の土台。端末に覚える項目の名前・定数・画面の状態（state）・日付や時刻の道具・この端末で作った予約の記録
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
  mySrc: 'prr.mySrc',            // 「自分の予約」の探し方（'device' この端末 / 'name' 名前で探す）
  myName: 'prr.myName',          // 「名前で探す」で最後に探した言葉
  fav: 'prr.favRooms',           // [roomId] お気に入りの練習室
  closeTime: 'prr.closeTime',    // 利用終了時刻（開いた直後、設定を読む前に「翌日を出すか」を決めるため）
};
const APP_VERSION = window.APP_VERSION; // web/api.js
const CACHE_TTL_MS = 3 * 60 * 1000; // 取得済みの予約データをこの時間は再取得せずに使う
const ADMIN_SESSION_KEY = 'prr.adminPw'; // 管理画面と共通（このタブで管理画面にログインしている間は管理者モード）
const ADMIN_ONLY = '管理者のみ';
const FAV = '★fav', FAV_EDIT = '★edit'; // 絞り込みの欄の「★ お気に入り」「★ お気に入りを選ぶ…」
const STOPPED = '使用停止';
const LIMITED = '限定公開';
const WEEKDAY_NAMES = '日月火水木金土';
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
/** 開いたときに出す日: 利用終了時刻（前回読んだ設定。最初は 23:00）を過ぎていれば、終わった今日ではなく翌日 */
function homeDate() {
  const t = todayStr();
  return nowMin() >= toMin(load_(LS.closeTime, '23:00')) ? addDays(t, 1) : t;
}
const state = {
  view: load_(LS.view, 'day'),
  date: homeDate(),
  roomId: load_(LS.room, ''),  // 部屋別で表示している部屋
  monthRoomId: '',      // カレンダーで表示している部屋（空＝すべての部屋。開くたびに「すべての部屋」から）
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
  loadFailed: false,    // いまの表示の期間を読み込めなかった（前の期間の表を出さないため）
  bookSending: false,   // まとめて予約・まとめて変更を送っている間（送信ボタンを押せないままにする）
  adminPw: sessionGet(ADMIN_SESSION_KEY),
  cache: new Map(),     // 期間（"from|to"）→ { res, at }  取得済みの予約データ
  cacheGen: 0,          // キャッシュを破棄した回数（破棄前に始まった取得結果を保存しないため）
  inflight: new Map(),  // 取得中の期間 → Promise
  shownKey: '',         // いま表示しているデータの表示形式と期間
  pending: [],          // 楽観的に画面へ反映した新規予約 { r, status: 'sending' | 'done' }
  hidden: new Map(),    // 楽観的に画面から消した予約 id → 予約日
  lastError: '',
  renderedAt: '',       // 最後に表を描いた日と時刻（分）
  limitedLockedAt: 0,   // 限定公開のパスワードを受け付けない知らせを最後に出した時刻（くり返さないため）
};

// ---------------- 汎用 ----------------
/** いま表示している部屋（一覧は空。カレンダーの「すべての部屋」も空） */
function shownRoomId() { return state.view === 'month' ? state.monthRoomId : state.view === 'room' ? state.roomId : ''; }
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
/** 予約が終わっているか（終了の時刻を過ぎた）。today・now を先に取っている所は渡す */
function isEnded(r, today = todayStr(), now = nowMin()) { return r.date < today || (r.date === today && toMin(r.end) <= now); }
function weekday(s) { return parseDate(s).getDay(); }
function dayClass(s) { const w = weekday(s); return w === 6 ? 'sat' : w === 0 ? 'sun' : ''; }
function mdLabel(s) { const d = parseDate(s); return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAY_NAMES[d.getDay()]})`; }
function fullDateLabel(s) { const d = parseDate(s); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${WEEKDAY_NAMES[d.getDay()]})`; }
function durationLabel(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h && m ? `${h}時間${m}分` : h ? `${h}時間` : `${m}分`;
}
function floorTo(m, u) { return Math.floor(m / u) * u; }
function ceilTo(m, u) { return Math.ceil(m / u) * u; }
/** 押した所・今の時刻から予約画面を開くときの刻み: 30分。予約単位が30分を割り切れない（12・20・60分）ときは1時間（予約単位はどれも60を割り切る） */
function slotStep() { return 30 % state.settings.unitMinutes === 0 ? 30 : 60; }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function load_(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
}
function save_(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 保存できない環境では無視 */ }
}
/** 端末に覚えた前回の表を消す（管理者モード・限定公開で見た部屋や予約を、次に開いたときに出さないため） */
function forgetSnapshot() {
  try { localStorage.removeItem(LS.snapshot); } catch (e) { /* 保存できない環境では何もしない */ }
}
function sessionGet(key) { try { return sessionStorage.getItem(key) || ''; } catch (e) { return ''; } }
function isAdminMode() { return !!state.adminPw; }
function exitAdminMode(message) {
  state.adminPw = '';
  try { sessionStorage.removeItem(ADMIN_SESSION_KEY); } catch (e) { /* 無視 */ }
  forgetSnapshot();
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

// ---------------- 電波がないとき ----------------
// 端末が「つながっていない」と言うときだけオフラインとみなす（つながっていると言うのに届かないときは、今までどおり送って失敗を知らせる）
function isOffline() { return navigator.onLine === false; }
const OFFLINE_MSG = 'オフラインのため送信できません。電波の届く所で、もう一度押してください。';

let toastTimer;
/** 画面の下に短く知らせる。action（{ label, run }）を渡すと右にボタンを付ける（例: 取消の「元に戻す」） */
function toast(message, type, ms, action) {
  if (type === 'error') state.lastError = `${new Date().toLocaleString('ja-JP')} ${message}`;
  const el = $('toast');
  el.textContent = message;
  el.className = 'toast show' + (type === 'error' ? ' error' : '') + (action ? ' has-act' : '');
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-act';
    b.textContent = action.label;
    b.addEventListener('click', () => { clearTimeout(toastTimer); el.className = 'toast'; action.run(); });
    el.appendChild(b);
  }
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

// マウスで使う広い画面では押したボタンの真下に出す（マウスの移動を短く）。タッチ端末（iPad など）・狭い画面・ボタン以外から開いたときは中央
function placeUnderBtn(dlg, btn) {
  const st = dlg.style;
  if (!btn || innerWidth < 700 || !matchMedia('(pointer: fine)').matches) { st.margin = st.top = st.left = st.maxHeight = ''; return; }
  const b = btn.getBoundingClientRect();
  st.margin = '0';
  st.top = (b.bottom + 8) + 'px';
  st.maxHeight = `calc(100dvh - ${b.bottom + 18}px)`;
  st.left = Math.max(10, Math.min(b.right - dlg.offsetWidth, innerWidth - dlg.offsetWidth - 10)) + 'px';
}
