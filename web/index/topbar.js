// 予約表: 上部のボタン（日付の移動・表示の切り替え・設備の絞り込み・新規予約など）
'use strict';

// ---------------- イベント ----------------
$('prevBtn').addEventListener('click', () => shift(-1));
$('nextBtn').addEventListener('click', () => shift(1));
$('todayBtn').addEventListener('click', () => setDate(todayStr()));
$('datePicker').addEventListener('change', (e) => setDate(e.target.value));
$('refreshBtn').addEventListener('click', () => { invalidate(); load({ force: true }); });
$('fabBtn').addEventListener('click', () => $('newBtn').click());
$('newBtn').addEventListener('click', () => {
  if (!state.settings) return;
  const date = state.view === 'day' && state.date >= todayStr() ? state.date : todayStr();
  openBooking({ mode: 'create', date, roomId: state.view === 'day' ? '' : state.roomId });
});
$('myBtn').addEventListener('click', openMyList);
$('adminMode').addEventListener('click', () => {
  if (!confirm('管理者モードを終了しますか？（管理画面からもログアウトします）')) return;
  exitAdminMode();
  location.reload(); // 管理者モードでだけ見えていた部屋（限定公開など）が画面に残らないよう、読み込み直す
});
for (const b of document.querySelectorAll('.tabs .btn')) b.addEventListener('click', () => setView(b.dataset.view));
$('equipFilter').addEventListener('change', (e) => {
  const v = e.target.value;
  if (v === FAV_EDIT || (v === FAV && !getFavs().size)) {
    // 選ぶ画面を開く。選び終わったら「★ お気に入り」で絞り込む（1つも選ばなければ元に戻す）
    e.target.value = load_(LS.filter, '');
    openFavs();
    return;
  }
  state.equipOnce = null; save_(LS.filter, v); if (state.data) render();
});
