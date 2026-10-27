// 予約表: 自動更新とリアルタイム同期
'use strict';

// ---------------- 自動更新（操作の邪魔をしない） ----------------
const IDLE_MS = 3000; // 最後の操作からこの時間が過ぎるまでは、画面を描き直さない
let lastActive = 0;
for (const type of ['pointerdown', 'pointermove', 'touchstart', 'touchmove', 'wheel', 'scroll', 'keydown', 'input']) {
  window.addEventListener(type, () => { lastActive = Date.now(); }, { capture: true, passive: true });
}
/** 操作中か（指やマウスで触れている・ダイアログを開いている・直前に操作した） */
function userBusy() {
  return !!(touch || pinch || mouse || drag || move || moveMouse || moveTouch) || anyDialogOpen() || Date.now() - lastActive < IDLE_MS;
}
setInterval(() => {
  if (!document.hidden && state.data && !userBusy()) load({ force: true, background: true });
}, AUTO_REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.data && !anyDialogOpen()) load({ force: true, background: true });
});

// ---------------- リアルタイム同期（高速キャッシュの /live） ----------------
// 誰かが予約・変更・取消をすると、GAS が写しを高速キャッシュに送り、高速キャッシュが開いている画面すべてに
// 「表が変わった」と知らせる。受けたら、上の自動更新と同じやり方（操作中は待つ）で読み直す。
// 画面が裏に回ったら切り、戻ったらつなぎ直す。切れたら少しずつ間をあけてつなぎ直す
const LIVE_URL = window.CACHE_API_URL ? String(window.CACHE_API_URL).replace(/\/+$/, '').replace(/^http/, 'ws') + '/live' : '';
let live = null, liveRetry = 0, livePing = 0, liveTimer = 0, liveReload = 0;
const liveInfo = { state: LIVE_URL ? '未接続' : '使わない', openedAt: '', lastChange: '', closes: 0 };
const hhmmss = () => new Date().toTimeString().slice(0, 8);
function connectLive() {
  if (!LIVE_URL || live || document.hidden || typeof WebSocket !== 'function') return;
  let ws;
  try { ws = new WebSocket(LIVE_URL); } catch (e) { return; }
  live = ws;
  ws.onopen = () => {
    liveRetry = 0;
    liveInfo.state = '接続中'; liveInfo.openedAt = hhmmss();
    clearInterval(livePing);
    livePing = setInterval(() => { try { ws.send('ping'); } catch (e) { /* 切れていれば onclose でつなぎ直す */ } }, 45 * 1000);
    // 見るだけ（Cloudflare に届かなかった）の間につなぎ直せた: Cloudflare が戻ったかもしれないので、すぐ読み直す
    if (state.readOnly && state.data) load({ force: true, background: true });
  };
  ws.onmessage = (e) => {
    let m = null;
    try { m = JSON.parse(e.data); } catch (x) { return; } // 「pong」など
    if (!m || m.type !== 'changed' || !state.data) return;
    liveInfo.lastChange = hhmmss();
    invalidate(); // 覚えている期間はすべて古くなった
    clearTimeout(liveReload);
    // 全員が同じ瞬間に読みに来ないよう、少しずらす
    liveReload = setTimeout(() => { if (!document.hidden) load({ force: true, background: true }); }, Math.random() * 400);
  };
  ws.onclose = () => {
    if (live !== ws) return; // 前の接続が遅れて閉じたときは、今の接続の ping や状態に触れない
    clearInterval(livePing);
    liveInfo.state = '切断'; liveInfo.closes++;
    live = null;
    if (!document.hidden) liveTimer = setTimeout(connectLive, Math.min(60 * 1000, 2000 * 2 ** liveRetry++));
  };
  ws.onerror = () => { /* onclose に任せる */ };
}
function disconnectLive() {
  clearTimeout(liveTimer);
  clearInterval(livePing);
  const ws = live;
  live = null;
  if (ws) { try { ws.close(); } catch (e) { /* すでに閉じている */ } }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) disconnectLive(); else { liveRetry = 0; connectLive(); } });
connectLive();

// ---------------- 電波がないとき ----------------
// 更新ボタンの絵を「電波なし」に変え、文字を「オフライン（17:40 時点）」にする。戻ったら、すぐつなぎ直して最新を読む
function updateOffline() {
  const off = isOffline();
  document.body.classList.toggle('offline', off);
  $('refreshBtn').setAttribute('aria-label', off ? 'オフライン（前回の予約表を表示中）' : '最新の予約に更新');
  if (state.data) stampStatus();
}
window.addEventListener('offline', () => { updateOffline(); if (state.data) render(); });
window.addEventListener('online', () => {
  updateOffline();
  clearTimeout(liveTimer); liveRetry = 0; connectLive();
  // 一度も表を読めていなくても読み直す（オフラインで開いたまま電波が戻ったとき）
  invalidate();
  load({ force: true, background: !!state.data && state.shownKey === `${state.view}|${rangeKey(currentRange())}` });
});
updateOffline();
