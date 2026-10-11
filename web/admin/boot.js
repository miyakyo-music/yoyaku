// 管理画面: ログアウトのボタン・閉じるときの確認・起動（自動ログイン）。いちばん最後に読み込む
'use strict';

$('logoutBtn').addEventListener('click', () => {
  if ((state.dirty.rooms || state.dirty.settings) && !confirm('保存していない変更があります。ログアウトしますか？')) return;
  logout('');
  state.dirty.rooms = state.dirty.settings = false; // 未保存の確認は済んでいる
  location.reload(); // 管理画面で読み込んだデータが画面に残らないよう、読み込み直す
});
window.addEventListener('beforeunload', (e) => {
  if (state.dirty.rooms || state.dirty.settings) { e.preventDefault(); e.returnValue = ''; }
});

// このタブで一度ログインしていれば、自動でログインし直す。確かめている間はパスワード欄を出さない
// （入力の途中で確認が終わり、画面が勝手に切り替わらないように）
if (state.pw) {
  $('loginForm').hidden = true;
  $('loginChecking').hidden = false;
  login(state.pw).finally(() => {
    $('loginChecking').hidden = true;
    $('loginForm').hidden = false;
    if (!state.pw) $('loginPw').focus();
  });
} else $('loginPw').focus();
