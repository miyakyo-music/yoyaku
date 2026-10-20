// 管理画面: ログイン・ログアウトと、ログインしたあと画面に中身を入れる処理
'use strict';

// ---------------- ログイン ----------------
async function login(pw) {
  state.pw = pw;
  $('loginBtn').disabled = true;
  $('loginError').textContent = '';
  try {
    const res = await api('adminGetData', {});
    if (!res.ok) throw new Error(res.message);
    sessionSet(pw);
    state.data = res;
    showAdmin();
  } catch (e) {
    $('loginError').textContent = errMessage(e);
    state.pw = '';
  } finally {
    $('loginBtn').disabled = false;
  }
}

function logout(message) {
  state.pw = '';
  sessionSet('');
  $('adminView').hidden = true;
  $('logoutBtn').hidden = true;
  $('sheetLink').hidden = true;
  $('loginView').hidden = false;
  $('loginError').textContent = message || '';
  $('loginPw').value = '';
  hideSecrets(document);
}

function showAdmin() {
  const d = state.data;
  $('loginView').hidden = true;
  $('adminView').hidden = false;
  $('logoutBtn').hidden = false;
  $('appName').textContent = d.settings.title;
  if (d.spreadsheetUrl) { $('sheetLink').href = d.spreadsheetUrl; $('sheetLink').hidden = false; }
  setBugBadge(d.openBugs);
  document.title = d.settings.title + '（管理画面）';
  // ログインの印が切れてログインし直したときは、保存していない練習室・一般の編集をそのまま残す
  if (!state.dirty.rooms) loadRooms(d.rooms);
  state.closures = d.closures.slice();
  renderRooms();
  if (!state.dirty.settings) fillSettings(d.settings);
  else { fillPasswords(d.settings); $('settingsError').textContent = ''; $('settingsWarn').textContent = ''; }
  renderClosureForm();
  renderExportForm();
  renderClosures();
  if (!state.dirty.rooms) setDirty('rooms', false);
  if (!state.dirty.settings) setDirty('settings', false);
}
$('loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const pw = $('loginPw').value;
  if (!pw) { $('loginError').textContent = '管理用パスワードを入力してください。'; $('loginPw').focus(); return; }
  login(pw);
});
