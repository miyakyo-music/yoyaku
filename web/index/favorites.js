// 予約表: お気に入りの練習室
'use strict';

// ---------------- お気に入りの練習室 ----------------
function openFavs() {
  state.favDraft = getFavs();
  $('favRooms').innerHTML = roomGridHtml(state.favDraft, '', '');
  $('favDialog').showModal();
}
$('favRooms').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id], button[data-group]');
  if (!b) return;
  const set = state.favDraft;
  const ids = b.dataset.group ? state.rooms.filter((r) => r.name === b.dataset.group && r.restriction !== STOPPED).map((r) => r.id) : [b.dataset.id];
  const allOn = ids.every((id) => set.has(id));
  ids.forEach((id) => (allOn ? set.delete(id) : set.add(id)));
  $('favRooms').innerHTML = roomGridHtml(set, '', '');
});
$('favDialog').addEventListener('close', () => {
  const favs = [...(state.favDraft || [])];
  save_(LS.fav, favs);
  const next = favs.length ? FAV : (load_(LS.filter, '') === FAV ? '' : load_(LS.filter, ''));
  save_(LS.filter, next);
  $('equipFilter').value = next;
  state.equipOnce = null;
  if (state.data) render();
});
$('freeBtn').addEventListener('click', () => {
  state.freeNow = !state.freeNow;
  $('freeBtn').setAttribute('aria-pressed', String(state.freeNow));
  // 今日以外を表示しているときは今日に移る
  if (state.freeNow && state.date !== todayStr()) { setDate(todayStr()); return; }
  if (state.data) { render(); scrollToNow(); }
});
$('roomSelect').addEventListener('change', (e) => { state.roomId = e.target.value; save_(LS.room, state.roomId); updateChrome(); if (state.data) render(); });

$('bookForm').addEventListener('submit', submitBooking);
$('bookDialog').addEventListener('close', renderDraft); // 閉じたら仮予約の帯を消す
$('bRoom').addEventListener('change', () => { state.extraRooms.delete($('bRoom').value); renderRoomPicker(); });
$('bRoomQuick').addEventListener('click', (e) => {
  const b = e.target.closest('.rq');
  if (!b) return;
  $('bRoom').value = b.dataset.id;
  $('bRoom').dispatchEvent(new Event('change'));
  $('bRoomQuickField').hidden = true;
  $('bRoomField').hidden = false;
  renderDraft();
  $('bError').textContent = '';
  if (!$('bPerson').value) $('bPerson').focus();
});
$('bSeries').addEventListener('change', updateBookingUi);
