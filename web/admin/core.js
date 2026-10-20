// 管理画面: 共通の土台。画面の状態（state）・日付や時刻の道具・トースト・通信（管理用パスワードを添える）
'use strict';

const SESSION_KEY = 'prr.adminPw';
// 管理画面を開いた印。予約表に戻ったとき、前回の表を使わずに最新を読み込ませる（部屋・設定の変更をすぐ反映するため）
try { sessionStorage.setItem('prr.fromAdmin', '1'); } catch (e) { /* 保存できない環境では何もしない */ }
const WEEKDAY_NAMES = '日月火水木金土';
const RESTRICTIONS = [['', '制限なし'], ['管理者のみ', '管理者のみ'], ['限定公開', '限定公開'], ['使用停止', '使用停止']];
const $ = (id) => document.getElementById(id);
const state = {
  pw: sessionGet(),
  data: null,
  rooms: [],       // 編集中の部屋一覧
  closures: [],
  dirty: { rooms: false, settings: false },
  roomsBase: '',   // 練習室の一覧を最後にサーバーから読んだときの内容（ほかの画面での変更に気づくため）
  settingsBase: null, // 一般の欄を最後にサーバーの値で埋めたときの設定（画面で変えた項目を見分けるため）
};

// ---------------- 汎用 ----------------
function sessionGet() { try { return sessionStorage.getItem(SESSION_KEY) || ''; } catch (e) { return ''; } }
function sessionSet(v) { try { if (v) sessionStorage.setItem(SESSION_KEY, v); else sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* 保存できない環境では毎回ログイン */ } }
function pad(n) { return String(n).padStart(2, '0'); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toMin(t) { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; }
function toHHMM(min) { return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`; }
function hm(t) { return String(t).replace(/^0(\d)/, '$1'); }
/** 日付（2026-10-15）の曜日の番号（0 が日曜） */
function weekdayOf(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getDay(); }
/** 土日の色の class（平日は空） */
function wdClass(w) { return w === 6 ? 'sat' : w === 0 ? 'sun' : ''; }
function dateLabel(s) {
  const [y, m, d] = s.split('-').map(Number);
  const w = weekdayOf(s);
  return { text: `${y}/${m}/${d}(${WEEKDAY_NAMES[w]})`, cls: wdClass(w) };
}
let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

async function api(fn, payload) {
  const res = await callApi(fn, Object.assign({ adminPassword: state.pw }, payload)); // web/api.js
  if (res && res.code === 'ADMIN_AUTH') { logout(res.message); throw new Error(res.message); }
  return res;
}
/** 保存の直前に、サーバーの最新の設定・部屋・休館を読み直す（ほかのタブ・端末で変えた分を消さないため） */
async function fetchLatest() {
  const res = await api('adminGetData', {});
  if (!res.ok) throw new Error(res.message);
  return res;
}
/** 保存を待っている間、form などの中を触れなくする（見た目は変えない）。保存後の描き直しで、その間の入力が消えないように */
let frozenFocus = null;
function freezeWhileSaving(el, on) {
  if (on) { frozenFocus = document.activeElement; el.inert = true; return; }
  el.inert = false;
  // inert にするとフォーカスが外れるので、保存ボタンなど元の場所に戻す
  if (frozenFocus && el.contains(frozenFocus) && document.activeElement === document.body) frozenFocus.focus({ preventScroll: true });
  frozenFocus = null;
}
function errMessage(e) { return (e && e.message) || String(e) || '通信に失敗しました。'; }

function timeSelects(hSel, mSel, maxHour) {
  hSel.innerHTML = '';
  for (let h = 0; h <= maxHour; h++) hSel.add(new Option(String(h), String(h)));
  mSel.innerHTML = '';
  for (let m = 0; m < 60; m += 5) mSel.add(new Option(pad(m), String(m)));
}
function setTime(hSel, mSel, t) { const m = toMin(t); hSel.value = String(Math.floor(m / 60)); mSel.value = String(m % 60); }
function getTime(hSel, mSel) { return toHHMM(Number(hSel.value) * 60 + Number(mSel.value)); }
