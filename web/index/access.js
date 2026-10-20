// 予約表: 閲覧パスワードと限定公開の部屋
'use strict';

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

// ---------------- 限定公開の部屋（演習室など） ----------------
// 一般の利用者には存在を知らせないため、入口は …/yoyaku/?limited の URL だけ。パスワードを確かめてから端末に記憶する。
function endLimited(message) {
  state.limitedKey = '';
  save_(LS.limitedKey, '');
  forgetSnapshot();
  $('limitedMode').hidden = true;
  invalidate();
  if (message) toast(message, 'error');
}
/** URL から ?limited を外す */
function dropLimitedQuery() {
  if (/[?&]limited\b/.test(location.search)) history.replaceState(null, '', location.pathname + location.hash);
}
/** パスワードの小窓を開く（閉じたとき・パスワードが通ったときに URL から ?limited を外す） */
function askLimited() {
  $('limPass').value = '';
  $('limError').textContent = '';
  $('limitedDialog').showModal();
}
$('limitedDialog').addEventListener('close', dropLimitedQuery);
$('limitedForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = $('limPass').value.trim();
  if (!key) { $('limError').textContent = 'パスワードを入力してください。'; return; }
  $('limSubmit').disabled = true;
  $('limError').textContent = '';
  try {
    const res = await api('getSchedule', Object.assign(currentRange(), { limitedKey: key }));
    if (res && res.limitedLocked) throw new Error('しばらくしてからもう一度お試しください。');
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
