// 予約表: お知らせをその場で変更（管理者モード）
'use strict';

// ---------------- お知らせをその場で変更（管理者モードのとき、お知らせを押す） ----------------
function openNoticeEditor() {
  if (!isAdminMode() || state.noticeEditing) return;
  state.noticeEditing = true;
  $('noticeInput').value = state.settings.notice || '';
  $('noticeLevel').value = state.settings.noticeLevel === '重要' ? '重要' : '通常';
  $('notice').hidden = true;
  $('noticeEditor').hidden = false;
  $('noticeRow').hidden = false;
  $('noticeInput').focus();
}
function closeNoticeEditor() {
  state.noticeEditing = false;
  $('noticeEditor').hidden = true;
  $('notice').hidden = false;
  applySettings();
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
$('noticeCancel').addEventListener('click', closeNoticeEditor);
$('noticeEditor').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNoticeEditor(); });
$('noticeEditor').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('noticeSave');
  btn.disabled = true;
  try {
    const res = await api('adminSetNotice', { notice: $('noticeInput').value.trim(), noticeLevel: $('noticeLevel').value });
    if (!res || !res.ok) throw new Error((res && res.message) || '保存できませんでした。');
    state.settings = Object.assign({}, state.settings, { notice: res.settings.notice, noticeLevel: res.settings.noticeLevel });
    if (state.data) state.data.settings = state.settings;
    closeNoticeEditor();
    toast(res.settings.notice ? 'お知らせを変更しました' : 'お知らせを非表示にしました');
    invalidate();
  } catch (ex) {
    if (!(ex instanceof AuthError)) toast(errMessage(ex), 'error');
  } finally {
    btn.disabled = false;
  }
});
