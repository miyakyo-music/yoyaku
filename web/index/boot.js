// 予約表: 起動（最初の読み込み）と、アプリのように使う仕組み（sw.js）の登録。いちばん最後に読み込む
'use strict';

// ---------------- アプリのように使う（ホーム画面に追加したとき。sw.js） ----------------
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* 使えない環境では何もしない */ }); });
}

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
