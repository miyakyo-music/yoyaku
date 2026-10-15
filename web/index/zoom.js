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
