// 管理画面: パスワード（限定公開・閲覧・管理用）と、パスワード欄の「表示」ボタン
'use strict';

// パスワード欄すべてに「表示」ボタンを付ける（web/api.js。演習室など・予約表全体のパスワードは専用のボタンがある）
addRevealButtons(document);

// ---------------- パスワード ----------------
function fillPasswords(s) {
  for (const [id, v] of [['sLimitedPw', s.limitedPassword], ['sViewPw', s.viewPassword]]) {
    $(id).value = v || '';
    reveal(id, false); // 開いたときは伏せ字に戻す
  }
  $('limitedUrl').value = new URL('./?limited', location.href).href;
  $('viewPwBox').open = !!s.viewPassword; // 設定されているときだけ最初から開いておく
  $('limitedError').textContent = '';
  $('viewPwError').textContent = '';
}
/** パスワード欄の表示・伏せ字を切り替える */
function reveal(id, show) {
  $(id).type = show ? 'text' : 'password';
  document.querySelector(`[data-reveal="${id}"]`).textContent = show ? '隠す' : '表示';
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-reveal]');
  if (b) reveal(b.dataset.reveal, $(b.dataset.reveal).type === 'password');
});
$('limitedUrl').addEventListener('focus', (e) => e.target.select());
$('copyLimitedUrl').addEventListener('click', async () => {
  const input = $('limitedUrl');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch (e) {
    input.select(); // クリップボードを使えない環境では選択だけして、手動でコピーしてもらう
    document.execCommand && document.execCommand('copy');
  }
  toast('入口の URL をコピーしました');
});
/**
 * 指定したパスワードだけを差し替えて保存する（「設定」タブの「一般」の未保存の変更は含めない）。
 * ほかの画面で変えたお知らせなどを戻さないよう、保存の直前に最新の設定を読み直し、その上に重ねる
 */
async function savePassword(key, inputId, btnId, errId, message) {
  const err = $(errId);
  err.textContent = '';
  const value = $(inputId).value;
  $(btnId).disabled = true;
  try {
    const latest = await fetchLatest();
    const settings = Object.assign({}, latest.settings, { [key]: value });
    const res = await api('adminSaveSettings', { settings });
    if (!res.ok) throw new Error(res.message);
    state.data.settings = res.settings;
    fillPasswords(res.settings);
    toast(message);
  } catch (ex) {
    err.textContent = errMessage(ex);
  } finally {
    $(btnId).disabled = false;
  }
}
$('limitedForm').addEventListener('submit', (e) => {
  e.preventDefault();
  savePassword('limitedPassword', 'sLimitedPw', 'limitedBtn', 'limitedError', '演習室などのパスワードを保存しました');
});
$('viewPwForm').addEventListener('submit', (e) => {
  e.preventDefault();
  savePassword('viewPassword', 'sViewPw', 'viewPwBtn', 'viewPwError', '予約表全体のパスワードを保存しました');
});
$('pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('pwError');
  err.textContent = '';
  const pw = $('pwNew').value;
  if (pw.length < 6) { err.textContent = '6文字以上にしてください。'; return; }
  if (pw !== $('pwNew2').value) { err.textContent = '確認用のパスワードが一致しません。'; return; }
  $('pwBtn').disabled = true;
  try {
    const res = await api('adminChangePassword', { newPassword: pw });
    if (!res.ok) throw new Error(res.message);
    state.pw = pw;
    sessionSet(pw);
    $('pwNew').value = $('pwNew2').value = '';
    toast('管理用パスワードを変更しました');
  } catch (ex) {
    err.textContent = errMessage(ex);
  } finally {
    $('pwBtn').disabled = false;
  }
});
