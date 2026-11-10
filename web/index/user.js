// 予約表: 利用者のログイン・新規登録（任意。仕様書 2.12）
// 登録は学籍番号（G1234 の形）・氏名・パスワード。ログインのトークンを端末に保存し（LS.user）、
// 予約・変更・取消と自分の予約の読み込みに添える（index/data.js の api）。
// ログインして作った予約は、ログイン中なら編集用パスワードなしで変更・取消できる
'use strict';

state.user = (() => { const u = load_(LS.user, null); return u && u.token ? u : null; })();
state.userMine = {}; // ログインして作った自分の予約 { [予約ID]: 'YYYY-MM-DD' }（終わって7日以内まで。core.js の getMine が合わせて使う）

const STUDENT_ID_FORM = /^[A-Z]\d{4}$/; // 登録できる学籍番号の形（G1234。大学院の 26E02 などは当面登録しない）
const normSid = (v) => String(v || '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();

/** ログインして作った自分の予約の一覧を読み直す。userGetMine の応答を返す（ログインしていなければ null） */
async function refreshUserMine() {
  if (!state.user) return null;
  const res = await api('userGetMine', {});
  if (!res || !res.ok) return res;
  const limit = addDays(todayStr(), -7);
  const m = {};
  for (const r of res.reservations) if (r.mine && r.date >= limit) m[r.id] = r.date;
  state.userMine = m;
  return res;
}
/** ログインして作った予約か（ログイン中の本人の分） */
function isUserMine(id) { return !!state.user && Object.prototype.hasOwnProperty.call(state.userMine, id); }
/** 作った・変えた予約を、自分の予約に足す（読み直しを待たずに青い帯にするため） */
function addUserMine(list) {
  if (!state.user) return;
  for (const r of list) if (r && r.owned) state.userMine[r.id] = r.date;
}

function loginUser(res) {
  state.user = { token: res.token, studentId: res.user.studentId, name: res.user.name };
  save_(LS.user, state.user);
}
/** ログアウトする（message があれば知らせる。トークンが通らなかったときは index/data.js から呼ぶ） */
function logoutUser(message) {
  if (!state.user) return;
  state.user = null;
  state.userMine = {};
  try { localStorage.removeItem(LS.user); } catch (e) { /* 保存できない環境では何もしない */ }
  if (message) toast(message, 'error');
  if ($('myDialog').open) openMyList();
  if (state.data) render();
}

// ---------------- ログイン・新規登録の小窓 ----------------
function setUserMode(mode) {
  const reg = mode === 'register';
  for (const b of $('userMode').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  $('userDialogTitle').textContent = reg ? '新規登録' : 'ログイン';
  $('uSubmit').textContent = reg ? '登録' : 'ログイン';
  $('uNameField').hidden = !reg;
  $('uPass').autocomplete = reg ? 'new-password' : 'current-password';
  $('uPass').placeholder = reg ? 'ほかで使っていないもの（4文字以上）' : '';
  $('uError').textContent = '';
}
const userMode = () => (($('userMode').querySelector('[aria-pressed="true"]') || {}).dataset || {}).mode || 'login';
function openUserDialog() {
  $('uSid').value = '';
  $('uName').value = '';
  $('uPass').value = '';
  hideSecrets($('userDialog'));
  setUserMode('login');
  $('userDialog').showModal();
}
$('userMode').addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (b) setUserMode(b.dataset.mode); });
$('userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const reg = userMode() === 'register';
  const err = $('uError');
  const studentId = normSid($('uSid').value);
  const name = $('uName').value.trim();
  const password = $('uPass').value;
  err.textContent = '';
  if (!studentId) { err.textContent = '学籍番号を入力してください。'; $('uSid').focus(); return; }
  if (reg && !STUDENT_ID_FORM.test(studentId)) { err.textContent = '登録できるのは、G1234 のような学籍番号（英字1文字と数字4桁）の学生だけです。'; $('uSid').focus(); return; }
  if (reg && !name) { err.textContent = '氏名を入力してください。'; $('uName').focus(); return; }
  if (!password) { err.textContent = 'パスワードを入力してください。'; $('uPass').focus(); return; }
  if (reg && password.length < 4) { err.textContent = 'パスワードは4文字以上にしてください。'; $('uPass').focus(); return; }
  if (isOffline()) { err.textContent = OFFLINE_MSG; return; }
  $('uSubmit').disabled = true;
  try {
    const res = reg ? await api('userRegister', { studentId, name, password }) : await api('userLogin', { studentId, password });
    if (!res || !res.ok) throw new Error((res && res.message) || 'ログインできませんでした。');
    loginUser(res);
    $('uSid').blur();
    $('userDialog').close();
    toast(reg ? '登録しました' : 'ログインしました');
    try { await refreshUserMine(); } catch (ex) { /* 読めなくても、ログインはできている */ }
    if ($('myDialog').open) openMyList();
    if (state.data) render();
  } catch (ex) {
    if (!(ex instanceof AuthError)) err.textContent = errMessage(ex);
  } finally {
    $('uSubmit').disabled = false;
  }
});
$('myLogin').addEventListener('click', openUserDialog);
$('myLogout').addEventListener('click', () => {
  if (!confirm('ログアウトしますか？')) return;
  logoutUser();
  toast('ログアウトしました');
});
addRevealButtons($('userDialog'));
