// 予約表: 表の操作（空いている所を押す・ドラッグで時間を選ぶ・長押し）
'use strict';

// ---------------- タイムライン操作（クリック・ドラッグ・長押し） ----------------
function minuteAt(track, clientX) {
  const rect = track.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return state.geo.t0 + ratio * state.geo.total;
}

/** 指定時刻を含む空き区間 [開始, 終了]。予約済み・過去・利用不可なら null */
/**
 * 今の時刻からその部屋が空いている区間 {from, until}。30分以上（閉館が近ければ閉館まで）空いていなければ null。
 * 使用停止の部屋と、管理者モードでないときの「管理者のみ」の部屋は除く。
 */
function freeFromNow(room) {
  const s = state.settings;
  const open = toMin(s.openTime), close = toMin(s.closeTime);
  if (room.restriction === STOPPED || (room.restriction === ADMIN_ONLY && !isAdminMode())) return null;
  const today = todayStr();
  const from = Math.max(open, ceilTo(nowMin(), s.unitMinutes));
  if (from >= close) return null;
  const busy = visibleReservations().filter((r) => r.date === today && r.roomId === room.id)
    .map((r) => [toMin(r.start), toMin(r.end)])
    .concat(closuresFor(today, room.id).map((c) => [c.start, c.end]));
  let until = close;
  for (const [a, b] of busy) {
    if (a <= from && b > from) return null;
    if (a > from) until = Math.min(until, a);
  }
  return until - from >= Math.min(30, close - from) ? { from, until } : null;
}

function freeSpanAt(row, m) {
  const { open, close, unit } = state.geo;
  const today = todayStr();
  if (row.stopped || row.date < today) return null;
  let lo = open, hi = close;
  if (row.date === today) lo = Math.max(lo, ceilTo(nowMin(), unit));
  for (const [s, e] of row.busy) {
    if (m >= s && m < e) return null;
    if (e <= m) lo = Math.max(lo, e);
    if (s > m) hi = Math.min(hi, s);
  }
  return m >= lo && m < hi && hi - lo >= unit ? [lo, hi] : null;
}

let drag = null;
/**
 * ドラッグで新規予約するときの開始の刻み。指の太さで「17:00 のつもりが 17:05」とならないよう、
 * 開始だけは10分（予約単位で割り切れなければ予約単位）のいちばん近い区切りに吸い付かせる。終了は予約単位
 */
function dragStartStep() {
  const u = state.geo.unit;
  return u <= 10 && 10 % u === 0 ? 10 : u;
}
const roundTo = (m, step) => Math.round(m / step) * step;

// 予約の帯に残っている青い枠（詳細を閉じたあとのフォーカス）を外す
function blurBlock() {
  const a = document.activeElement;
  if (a && a.closest && a.closest('.blk')) a.blur();
}
function beginDrag(track, clientX) {
  clearPick();
  blurBlock();
  const row = state.rows[Number(track.dataset.i)];
  const m = minuteAt(track, clientX);
  const free = freeSpanAt(row, m);
  if (!free) return null;
  const anchor = Math.min(Math.max(roundTo(m, dragStartStep()), free[0]), free[1] - state.geo.unit);
  const ghost = document.createElement('div');
  ghost.className = 'ghost';
  track.appendChild(ghost);
  drag = { track, row, free, anchor, ghost, start: anchor, end: anchor + state.geo.unit };
  updateDrag(clientX);
  return drag;
}

// ドラッグ中に表の端（左は部屋名の列の右端、右は画面の右端）へ近づいたら、その向きへ自動でスクロールする。
// 端に近いほど速い。スクロールした分、指の下の時刻が変わるので、帯（影）も合わせて伸ばす
const edge = { timer: 0, x: 0, y: 0, update: null, vertical: false, leftToo: false };
function edgeFollow(x, y, update, vertical, leftToo) {
  edge.x = x; edge.y = y; edge.update = update; edge.vertical = !!vertical; edge.leftToo = !!leftToo;
  if (!edge.timer) edge.timer = setInterval(edgeStep, 30);
}
function edgeStop() { clearInterval(edge.timer); edge.timer = 0; edge.update = null; }
function edgeStep() {
  if (!edge.update) { edgeStop(); return; }
  const main = $('main');
  const r = main.getBoundingClientRect();
  const label = main.querySelector('.tl-label');
  const left = label ? label.getBoundingClientRect().right : r.left;
  const ZONE = 44, MAX = 16;
  const speed = (d) => Math.round(Math.min(MAX, 3 + (1 - Math.max(0, d) / ZONE) * (MAX - 3)));
  let dx = 0, dy = 0;
  if (edge.x > r.right - ZONE) dx = speed(r.right - edge.x);
  else if (edge.leftToo && edge.x < left + ZONE) dx = -speed(edge.x - left);
  if (edge.vertical) {
    const head = main.querySelector('.tl-head');
    const top = head ? head.getBoundingClientRect().bottom : r.top;
    if (edge.y > r.bottom - ZONE) dy = speed(r.bottom - edge.y);
    else if (edge.y < top + ZONE) dy = -speed(edge.y - top);
  }
  if (!dx && !dy) return;
  const bx = main.scrollLeft, by = main.scrollTop;
  main.scrollLeft += dx;
  main.scrollTop += dy;
  if (main.scrollLeft !== bx || main.scrollTop !== by) edge.update(edge.x, edge.y);
}

function updateDrag(clientX) {
  edgeFollow(clientX, 0, (x) => updateDragAt(x));
  updateDragAt(clientX);
}
function updateDragAt(clientX) {
  if (!drag) return;
  const { t0, total } = state.geo;
  const unit = state.geo.unit;
  const m = minuteAt(drag.track, clientX);
  let s, e;
  // 右向きだけに伸ばす（左へ引くと開始と終了の決まり方が入れ替わってわかりにくいので、押した所より左へは伸ばさない）
  s = drag.anchor;
  e = Math.max(drag.anchor + unit, ceilTo(m, unit));
  drag.start = Math.max(s, drag.free[0]);
  drag.end = Math.min(e, drag.free[1]);
  drag.ghost.style.left = `${((drag.start - t0) / total * 100).toFixed(4)}%`;
  drag.ghost.style.width = `${((drag.end - drag.start) / total * 100).toFixed(4)}%`;
  drag.ghost.textContent = `${hm(toHHMM(drag.start))}〜${hm(toHHMM(drag.end))}`;
}

function finishDrag() {
  edgeStop();
  const d = drag;
  drag = null;
  if (!d) return;
  morph(d.ghost, () => {
    d.ghost.remove();
    openBooking({ mode: 'create', roomId: d.row.roomId, date: d.row.date, start: d.start, end: d.end });
  }, () => $('bookDialog'));
}

function cancelDrag() { edgeStop(); if (drag) { drag.ghost.remove(); drag = null; } }

/** クリック・タップ: 30分単位（slotStep）の位置から1時間（空きが足りなければ空きの範囲）で予約画面を開く */
function slotAt(track, clientX) {
  const row = state.rows[Number(track.dataset.i)];
  if (row.stopped) { toast('この部屋は現在使用停止中です。', 'error'); return null; }
  const m = minuteAt(track, clientX);
  const free = freeSpanAt(row, m);
  if (!free) return null;
  const start = Math.max(free[0], floorTo(m, slotStep()));
  const end = Math.min(free[1], start + 60);
  return { mode: 'create', roomId: row.roomId, date: row.date, start, end };
}
function tapTrack(track, clientX) {
  const slot = slotAt(track, clientX);
  if (slot) openBooking(slot);
}

/**
 * スマホ: タップした所には「仮予約」の帯と「＋予約」を出すだけにし、もう一度その帯をタップしたら予約画面を開く
 * （触れただけで予約画面が開かないようにする）。スクロールしたら帯は消す。
 */
const PICK_TIMEOUT_MS = 5000; // 「＋予約」の帯は、押されないまましばらくたったら消す
let pickTimer = null;
function pickSlot(track, clientX) {
  blurBlock();
  state.pick = slotAt(track, clientX);
  renderDraft();
  clearTimeout(pickTimer);
  if (state.pick) pickTimer = setTimeout(fadePick, PICK_TIMEOUT_MS);
}
/** 帯を薄くしてから消す */
function fadePick() {
  const el = $('main').querySelector('.ghost.pick');
  if (!el) { clearPick(); return; }
  el.classList.add('fading');
  pickTimer = setTimeout(clearPick, 300);
}
function clearPick() {
  clearTimeout(pickTimer);
  if (!state.pick) return;
  state.pick = null;
  renderDraft();
}

// マウス: 押してそのまま横に動かすと時間指定、動かさなければクリック扱い
let mouse = null;
$('main').addEventListener('mousedown', (e) => {
  const track = e.target.closest('.tl-track');
  if (!track || e.button !== 0 || e.target.closest('.blk')) return;
  e.preventDefault();
  mouse = { track, x: e.clientX, dragging: false };
});
document.addEventListener('mousemove', (e) => {
  if (!mouse) return;
  // ウィンドウの外で離してから戻ってきた（mouseup が届いていない）: 取りやめる
  if (!(e.buttons & 1)) { if (mouse.dragging) cancelDrag(); mouse = null; return; }
  if (!mouse.dragging && Math.abs(e.clientX - mouse.x) > 5) {
    mouse.dragging = !!beginDrag(mouse.track, mouse.x);
    if (!mouse.dragging) { mouse = null; return; }
  }
  if (mouse.dragging) updateDrag(e.clientX);
});
document.addEventListener('mouseup', () => {
  if (!mouse) return;
  const m = mouse;
  mouse = null;
  if (m.dragging) finishDrag();
  else tapTrack(m.track, m.x);
});
// ウィンドウの外でボタンを離すと mouseup が届かず、端の自動スクロールが続くので、取りやめる
window.addEventListener('blur', () => { if (mouse && mouse.dragging) cancelDrag(); mouse = null; });


// タッチ: タップで予約画面、長押ししてからなぞると時間指定（通常のスワイプはスクロール）
let touch = null;
// スクロール中・直後のタップは、スクロールを止めるためのタップとみなして予約の操作にしない
const SCROLL_SETTLE_MS = 300;
let lastScrollAt = 0;
$('main').addEventListener('scroll', () => { lastScrollAt = Date.now(); clearPick(); }, { passive: true });
$('main').addEventListener('touchstart', (e) => {
  const track = e.target.closest('.tl-track');
  if (touch) clearTimeout(touch.timer); // 2本目の指（ピンチ）や次のタッチで、前の長押しを止める
  if (!track || e.touches.length !== 1 || e.target.closest('.blk')) { touch = null; return; }
  const t = e.touches[0];
  const me = touch = {
    track, x: t.clientX, y: t.clientY, moved: false, dragging: false,
    scrolling: Date.now() - lastScrollAt < SCROLL_SETTLE_MS,
    onPick: !!e.target.closest('.ghost.pick'),
  };
  touch.timer = setTimeout(() => {
    if (touch !== me || me.moved) return;
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
