// 予約表: 時間軸の拡大・縮小（ピンチ・Ctrl＋ホイール）
'use strict';

// ---------------- 時間軸の拡大・縮小（ピンチ） ----------------
let pinch = null;
const touchDist = (ts) => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
const touchMidX = (ts) => (ts[0].clientX + ts[1].clientX) / 2;
$('main').addEventListener('touchstart', (e) => {
  if (e.touches.length !== 2 || !$('main').querySelector('.tl')) return;
  // 1本目の指で始めたタップ・長押しは取りやめて、拡大・縮小に切り替える
  if (touch) { clearTimeout(touch.timer); touch = null; }
  cancelDrag();
  pinch = { dist: touchDist(e.touches) || 1, w: state.hourW };
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  zoomAround(touchMidX(e.touches), pinch.w * touchDist(e.touches) / pinch.dist);
}, { passive: false });
document.addEventListener('touchend', (e) => {
  if (pinch && e.touches.length < 2) { pinch = null; saveZoom(); }
});
document.addEventListener('touchcancel', () => { if (pinch) { pinch = null; saveZoom(); } });
// iPhone の Safari が独自に行うページの拡大を止める（時間軸の上だけ）
for (const type of ['gesturestart', 'gesturechange']) {
  $('main').addEventListener(type, (e) => { if ($('main').querySelector('.tl')) e.preventDefault(); }, { passive: false });
}
// PC: Ctrl＋ホイール（トラックパッドのピンチも Ctrl＋ホイールとして届く）
let wheelSaveTimer;
$('main').addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !$('main').querySelector('.tl')) return;
  e.preventDefault();
  // マウスのホイール1目盛り（deltaY ≒ 100）で約1.35倍。トラックパッドは小刻みに届くので滑らかに変わる
  const dy = Math.max(-60, Math.min(60, e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY));
  zoomAround(e.clientX, state.hourW * Math.exp(-dy * 0.005));
  clearTimeout(wheelSaveTimer);
  wheelSaveTimer = setTimeout(saveZoom, 300);
}, { passive: false });
// Mac の Safari: トラックパッドのピンチは gesture イベントで届く
if (!('ontouchstart' in window)) {
  let gesture = null;
  $('main').addEventListener('gesturestart', (e) => { gesture = { w: state.hourW }; });
  $('main').addEventListener('gesturechange', (e) => { if (gesture) zoomAround(e.clientX, gesture.w * e.scale); });
  $('main').addEventListener('gestureend', () => { gesture = null; saveZoom(); });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-zoom-reset]')) return;
  const main = $('main');
  zoomAround(main.getBoundingClientRect().left + main.clientWidth / 2, state.hourBase);
  saveZoom();
});

// タッチ: タップで予約画面、長押ししてからなぞると時間指定（通常のスワイプはスクロール）
let touch = null;
// スクロール中・直後のタップは、スクロールを止めるためのタップとみなして予約の操作にしない
const SCROLL_SETTLE_MS = 300;
let lastScrollAt = 0;
$('main').addEventListener('scroll', () => { lastScrollAt = Date.now(); clearPick(); }, { passive: true });
// スマホの「＋」: 表の下のフッターが見えている分だけ持ち上げ、表の下端の上に乗せる
function liftFab() {
  const foot = $('main').querySelector('.main-foot');
  const lift = foot ? Math.max(0, $('main').getBoundingClientRect().bottom - foot.getBoundingClientRect().top) : 0;
  $('fabBtn').style.setProperty('--fab-lift', `${Math.round(lift)}px`);
}
$('main').addEventListener('scroll', liftFab, { passive: true });
window.addEventListener('resize', liftFab);
$('main').addEventListener('touchstart', (e) => {
  const track = e.target.closest('.tl-track');
  if (!track || e.touches.length !== 1 || e.target.closest('.blk')) { touch = null; return; }
  const t = e.touches[0];
  touch = {
    track, x: t.clientX, y: t.clientY, moved: false, dragging: false,
    scrolling: Date.now() - lastScrollAt < SCROLL_SETTLE_MS,
    onPick: !!e.target.closest('.ghost.pick'),
  };
  touch.timer = setTimeout(() => {
    if (!touch || touch.moved) return;
    if (beginDrag(track, touch.x)) {
      touch.dragging = true;
      if (navigator.vibrate) navigator.vibrate(15);
    }
  }, LONG_PRESS_MS);
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (!touch) return;
  const t = e.touches[0];
  if (touch.dragging) { e.preventDefault(); updateDrag(t.clientX); return; }
  if (Math.abs(t.clientX - touch.x) > 10 || Math.abs(t.clientY - touch.y) > 10) { touch.moved = true; clearTimeout(touch.timer); }
}, { passive: false });
document.addEventListener('touchend', (e) => {
  if (!touch) return;
  const t = touch;
  touch = null;
  clearTimeout(t.timer);
  if (t.dragging) { e.preventDefault(); finishDrag(); return; }
  if (t.moved) return;
  e.preventDefault();
  if (t.scrolling || Date.now() - lastScrollAt < SCROLL_SETTLE_MS) return;
  if (t.onPick && state.pick) {
    const slot = state.pick;
    morph($('main').querySelector('.ghost.pick'), () => { clearPick(); openBooking(slot); }, () => $('bookDialog'));
    return;
  }
  pickSlot(t.track, t.x);
}, { passive: false });
document.addEventListener('touchcancel', () => { if (touch) clearTimeout(touch.timer); touch = null; cancelDrag(); });
