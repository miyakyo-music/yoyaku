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
