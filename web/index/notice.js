// 予約表: お知らせの全文表示と、管理者モードでの変更（小窓）
'use strict';

// ---------------- お知らせの変更（管理者モードのとき、お知らせを押すと小窓を出す） ----------------
function setNoticeLevel(level) {
  for (const b of $('noticeLevel').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.level === level));
}
function openNoticeEditor() {
  if (!isAdminMode()) return;
  $('noticeInput').value = state.settings.notice || '';
  setNoticeLevel(state.settings.noticeLevel === '重要' ? '重要' : '通常');
  $('noticeError').textContent = '';
  $('noticeEditDialog').showModal();
  $('noticeInput').focus();
}
// 1行に収まらないお知らせ（末尾が「…」）は、押すと全文を小窓で出す。管理者モードでは押すと書き換え
function openNotice() {
  if (isAdminMode()) { openNoticeEditor(); return; }
  const t = $('noticeText');
  if (t.scrollWidth <= t.clientWidth) return;
  $('noticeFull').textContent = t.textContent;
  $('noticeDialog').showModal();
}
function markNoticeOverflow() {
  const t = $('noticeText');
  $('notice').classList.toggle('overflow', !isAdminMode() && t.scrollWidth > t.clientWidth);
}
$('notice').addEventListener('click', openNotice);
if (typeof ResizeObserver === 'function') new ResizeObserver(markNoticeOverflow).observe($('noticeText'));
$('noticeLevel').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-level]');
  if (b) setNoticeLevel(b.dataset.level);
});
// お知らせは1行で出すので、改行は入れない（貼り付けた改行は保存時に空白へ）
$('noticeInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) e.preventDefault();
});
$('noticeEditor').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (isOffline()) { $('noticeError').textContent = OFFLINE_MSG; return; }
  const btn = $('noticeSave');
  const level = $('noticeLevel').querySelector('[aria-pressed="true"]').dataset.level;
  btn.disabled = true;
  $('noticeError').textContent = '';
  try {
    const notice = $('noticeInput').value.replace(/\s*\n\s*/g, ' ').trim();
    const res = await api('adminSetNotice', { notice, noticeLevel: level });
    if (!res || !res.ok) throw new Error((res && res.message) || '保存できませんでした。');
    state.settings = Object.assign({}, state.settings, { notice: res.settings.notice, noticeLevel: res.settings.noticeLevel });
    if (state.data) state.data.settings = state.settings;
    applySettings();
    $('noticeEditDialog').close();
    toast(res.settings.notice ? 'お知らせを変更しました' : 'お知らせを非表示にしました');
    invalidate();
  } catch (ex) {
    if (!(ex instanceof AuthError)) $('noticeError').textContent = errMessage(ex);
  } finally {
    btn.disabled = false;
  }
});
