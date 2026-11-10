// 予約表: 利用者のログイン・新規登録（任意。仕様書 2.12）
// 登録は学籍番号（G1234 の形式）・姓・名・PIN（数字4桁。氏名はサーバーが空白なしの「姓名」に正規化する）。ログインは学籍番号か氏名と、PIN かパスキー。ログインのトークンを端末に保存し（LS.user）、
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
  if ($('meDialog').open) $('meDialog').close();
  state.userMine = {};
  try { localStorage.removeItem(LS.user); } catch (e) { /* 保存できない環境では何もしない */ }
  if (message) toast(message, 'error');
  if ($('myDialog').open) openMyList();
  if (state.data) render();
}

// ---------------- ログイン・新規登録の小窓 ----------------
let userModeNow = 'login';
function setUserMode(mode) {
  const reg = mode === 'register';
  userModeNow = mode;
  $('uSwitch').textContent = reg ? 'ログインに戻る' : '新規登録';
  // 学内の認証システムと混同しないよう、登録では見出しと PIN の欄に「予約表」を付ける
  $('userDialogTitle').textContent = reg ? '予約表の新規登録' : 'ログイン';
  $('uPassLabel').textContent = reg ? '予約表用の PIN' : 'PIN';
  $('uSubmit').textContent = reg ? '登録' : 'ログイン';
  $('uSidLabel').textContent = reg ? '学籍番号' : '学籍番号または氏名';
  $('uSid').placeholder = reg ? 'G1234' : '';
  $('uSid').autocapitalize = reg ? 'characters' : 'off';
  $('uNameField').hidden = !reg;
  $('uPkLogin').hidden = reg || !userPkSupported;
  // パスキーが使えるときは、ログインではパスキーのボタンを青くし、PIN のログインは控えめにする（管理画面と同じ）
  $('uPkLogin').classList.toggle('primary', !reg && userPkSupported);
  $('uSubmit').classList.toggle('primary', reg || !userPkSupported);
  $('uPass').autocomplete = reg ? 'new-password' : 'current-password';
  $('uError').textContent = '';
}
const userMode = () => userModeNow;
function openUserDialog() {
  $('uSid').value = '';
  $('uFamily').value = '';
  $('uGiven').value = '';
  $('uPass').value = '';
  hideSecrets($('userDialog'));
  setUserMode('login');
  $('userDialog').showModal();
}
/** ログイン・登録できたあと（小窓を閉じ、自分の予約を読み直す） */
async function afterUserLogin(res, message) {
  loginUser(res);
  $('uSid').blur();
  $('userDialog').close();
  toast(message);
  try { await refreshUserMine(); } catch (ex) { /* 読めなくても、ログインはできている */ }
  if ($('myDialog').open) openMyList();
  if (state.data) render();
}
$('uSwitch').addEventListener('click', () => { setUserMode(userModeNow === 'register' ? 'login' : 'register'); $('uSid').focus(); });
$('userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const reg = userMode() === 'register';
  const err = $('uError');
  const loginId = $('uSid').value.trim();
  const studentId = normSid(loginId);
  const familyName = $('uFamily').value.trim();
  const givenName = $('uGiven').value.trim();
  const password = $('uPass').value.normalize('NFKC').trim(); // 全角の数字も受け付ける
  err.textContent = '';
  if (!loginId) { err.textContent = reg ? '学籍番号を入力してください。' : '学籍番号か氏名を入力してください。'; $('uSid').focus(); return; }
  if (reg && !STUDENT_ID_FORM.test(studentId)) { err.textContent = '登録できるのは、G1234 のような学籍番号（英字1文字と数字4桁）の学生だけです。'; $('uSid').focus(); return; }
  if (reg && !familyName) { err.textContent = '姓を入力してください。'; $('uFamily').focus(); return; }
  if (reg && !givenName) { err.textContent = '名を入力してください。'; $('uGiven').focus(); return; }
  if (!/^\d{4}$/.test(password)) { err.textContent = 'PIN を数字4桁で入力してください。'; $('uPass').focus(); return; }
  if (isOffline()) { err.textContent = OFFLINE_MSG; return; }
  $('uSubmit').disabled = true;
  try {
    const res = reg ? await api('userRegister', { studentId, familyName, givenName, password }) : await api('userLogin', { loginId, password });
    if (!res || !res.ok) throw new Error((res && res.message) || 'ログインできませんでした。');
    await afterUserLogin(res, reg ? '登録しました' : 'ログインしました');
  } catch (ex) {
    if (!(ex instanceof AuthError)) err.textContent = errMessage(ex);
  } finally {
    $('uSubmit').disabled = false;
  }
});
$('myLogin').addEventListener('click', openUserDialog);
addRevealButtons($('userDialog'));

// ---------------- パスキー（Face ID / Touch ID。高速キャッシュが動いているときだけ） ----------------
// 署名は高速キャッシュ（cache/worker.js の /passkey/userRegister・userLogin）が確かめる。登録には GAS（正本）の許可証
// （userPasskeyTicket）が要り、ログインは高速キャッシュが返す短い許可証を userPasskeyLogin で普段のトークンに換える
const USER_PK_URL = String(window.CACHE_API_URL || '').replace(/\/+$/, '');
const userPkSupported = !!(USER_PK_URL && window.PublicKeyCredential && navigator.credentials);
const upkB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function upkCall(op, body) {
  let res;
  try {
    const r = await fetch(`${USER_PK_URL}/passkey/${op}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body || {}) });
    res = await r.json();
  } catch (e) { throw new Error('通信に失敗しました。'); }
  if (!res || !res.ok) throw new Error((res && res.message) || 'パスキーの処理に失敗しました。');
  return res;
}
/** 端末の操作（Face ID など）を取りやめたときは、何も知らせない */
const upkCancelled = (e) => e && (e.name === 'NotAllowedError' || e.name === 'AbortError');
/** 登録するパスキーの名前: 端末の種類と登録日 */
function upkDeviceName() {
  const ua = navigator.userAgent;
  const kind = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
    : /Macintosh/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'その他の端末';
  const d = new Date();
  return `${kind}（${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} 登録）`;
}

$('uPkLogin').addEventListener('click', async () => {
  const btn = $('uPkLogin');
  const err = $('uError');
  err.textContent = '';
  if (isOffline()) { err.textContent = OFFLINE_MSG; return; }
  btn.disabled = true;
  try {
    const c = await upkCall('challenge');
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: new TextEncoder().encode(c.challenge), rpId: c.rpId, userVerification: 'required', timeout: 60000,
    } });
    const r = cred.response;
    const t = await upkCall('userLogin', {
      id: cred.id, clientDataJSON: upkB64(r.clientDataJSON), authenticatorData: upkB64(r.authenticatorData), signature: upkB64(r.signature),
    });
    const res = await api('userPasskeyLogin', { ticket: t.ticket });
    if (!res || !res.ok) throw new Error((res && res.message) || 'ログインできませんでした。');
    save_(LS.userPk, cred.id); // マイページで「この端末」と示すため
    await afterUserLogin(res, 'ログインしました');
  } catch (ex) {
    if (!upkCancelled(ex) && !(ex instanceof AuthError)) err.textContent = errMessage(ex);
  } finally {
    btn.disabled = false;
  }
});
