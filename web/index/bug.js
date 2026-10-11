// 予約表: 不具合報告
'use strict';

// ---------------- 不具合報告 ----------------
/** 報告に添える実行環境の情報 */
function collectEnv() {
  let storage = 'ok';
  try { localStorage.setItem('prr.test', '1'); localStorage.removeItem('prr.test'); } catch (e) { storage = '使用不可'; }
  const viewName = { day: '一覧', room: '部屋別', month: 'カレンダー' }[state.view];
  const room = shownRoomId() ? roomById(shownRoomId()) : null;
  return {
    appVersion: APP_VERSION,
    live: liveInfo, // リアルタイム同期の様子（つながっているか・最後に知らせを受けた時刻）
    reportedAt: new Date().toLocaleString('ja-JP'),
    userAgent: navigator.userAgent,
    language: navigator.language,
    screen: `画面 ${screen.width}×${screen.height}（${window.devicePixelRatio}倍）/ 表示領域 ${window.innerWidth}×${window.innerHeight}`,
    page: `${viewName} ${state.date}${room ? ' ' + roomText(room) : ''}`,
    touch: !!(window.matchMedia && matchMedia('(pointer: coarse)').matches),
    adminMode: isAdminMode(),
    localStorage: storage,
    profileSaved: !!load_(LS.profile, null),
    myReservations: Object.keys(getMine()).length,
    online: navigator.onLine,
    lastError: state.lastError,
  };
}
function openBug() {
  $('bugMsg').value = '';
  $('bugError').textContent = '';
  $('bugEnv').textContent = Object.entries(collectEnv()).map(([k, v]) => `${k}: ${v}`).join('\n');
  $('bugDialog').showModal();
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-bug]')) openBug(); });
$('bugForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = $('bugMsg').value.trim();
  if (!message) { $('bugError').textContent = '内容を入力してください。'; $('bugMsg').focus(); return; }
  const btn = $('bugSubmit');
  btn.disabled = true;
  $('bugError').textContent = '';
  try {
    const res = await api('submitBugReport', { message, contact: $('bugContact').value.trim(), env: collectEnv() });
    if (!res || !res.ok) throw new Error((res && res.message) || '送信できませんでした。');
    $('bugDialog').close();
    toast('報告を送信しました。ご協力ありがとうございます。');
  } catch (ex) {
    if (!(ex instanceof AuthError)) $('bugError').textContent = errMessage(ex);
  } finally {
    btn.disabled = false;
  }
});
