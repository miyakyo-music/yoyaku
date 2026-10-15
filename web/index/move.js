// 予約表: 予約の帯をつかんで、別の時間・部屋へ動かす
'use strict';

// ---------------- 既存の予約を動かす（スマホは長押し、PC はつかんで動かす） ----------------
// 帯の影が指（マウス）について動き、横は時刻（予約単位の刻み）、縦は行（一覧は部屋、部屋別は日付）が変わる。
// 離すと、新しい部屋・日・時刻を入れた「予約の変更」画面を開き、「変更を保存」で確定する
// （うっかり動かしても確定しない。編集用パスワードの確認も今まで通り）
let move = null;
let moveClickBlockUntil = 0;
function hideHoverCard() { $('hoverCard').hidden = true; }
function canMove(r) {
  if (!r || r.pending || r.settling) return false;
  const room = roomById(r.roomId);
  const ended = r.date < todayStr() || (r.date === todayStr() && toMin(r.end) <= nowMin());
  return !ended && !(room && room.restriction === ADMIN_ONLY && !isAdminMode());
}
function beginMove(blk, clientX) {
  const r = visibleReservations().find((x) => x.id === blk.dataset.id);
  if (!canMove(r) || !state.geo) return false;
  const track = blk.closest('.tl-track');
  const grab = minuteAt(track, clientX) - toMin(r.start); // つかんだ所と開始の差（指の下の位置を保つ）
  const ghost = document.createElement('div');
  ghost.className = 'ghost move';
  blk.classList.add('moving-src');
  move = { r, blk, grab, len: toMin(r.end) - toMin(r.start), ghost, row: null, start: toMin(r.start), ok: false };
  hideHoverCard();
  return true;
}
function updateMove(clientX, clientY) {
  edgeFollow(clientX, clientY, (x, y) => { if (move) updateMoveAt(x, y); }, true, true);
  updateMoveAt(clientX, clientY);
}
function updateMoveAt(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  let track = el && el.closest && el.closest('.tl-track');
  if (!track && move.track) track = move.track; // 行の外に出たときは、直前の行のまま
  if (!track) return;
  move.track = track;
  const row = state.rows[Number(track.dataset.i)];
  const { open, close, t0, total } = state.geo;
  // 動かすときは予約単位（5分など）で刻む。長さは変わらないので、指とのずれは変更画面で直さずに済む
  const step = state.geo.unit;
  let start = roundTo(minuteAt(track, clientX) - move.grab, step);
  start = Math.max(open, Math.min(close - move.len, start));
  const end = start + move.len;
  const r = move.r;
  const today = todayStr();
  const clash = visibleReservations().some((x) => x.id !== r.id && x.date === row.date && x.roomId === row.roomId && toMin(x.start) < end && start < toMin(x.end))
    || closuresFor(row.date, row.roomId).some((c) => c.start < end && start < c.end);
  const past = row.date < today || (row.date === today && start < nowMin());
  move.ok = !clash && !past && !row.stopped;
  move.row = row; move.start = start;
  if (move.ghost.parentNode !== track) track.appendChild(move.ghost);
  move.ghost.classList.toggle('bad', !move.ok);
  move.ghost.style.left = `${((start - t0) / total * 100).toFixed(4)}%`;
  move.ghost.style.width = `${(move.len / total * 100).toFixed(4)}%`;
  move.ghost.textContent = `${hm(toHHMM(start))}〜${hm(toHHMM(end))}`;
}
function endMove(commit) {
  edgeStop();
  const m = move;
  move = null;
  if (!m) return;
  m.ghost.remove();
  m.blk.classList.remove('moving-src');
  moveClickBlockUntil = Date.now() + 400;
  if (!commit || !m.row) return;
  const r = m.r;
  const same = m.row.date === r.date && m.row.roomId === r.roomId && m.start === toMin(r.start);
  if (same) return;
  if (!m.ok) { toast('その時間には動かせません（重なり・利用不可・過去）。', 'error'); return; }
  const pin = isMine(r.id) ? (load_(LS.profile, {}).pin || '') : '';
  // 利用時間は元のまま（開始だけを刻みに合わせ、終了は開始＋元の長さ）
  openBooking({ mode: 'edit', reservation: r, pin, at: { roomId: m.row.roomId, date: m.row.date, start: m.start, end: m.start + m.len } });
}
// PC: 帯を押したまま5px以上動かすと、つかんで動かす（動かさなければ今まで通りクリックで詳細）
let moveMouse = null;
$('main').addEventListener('mousedown', (e) => {
  const blk = e.target.closest('.blk.res');
  if (!blk || e.button !== 0 || !blk.closest('.tl-track')) return;
  moveMouse = { blk, x: e.clientX, y: e.clientY };
});
document.addEventListener('mousemove', (e) => {
  if (!moveMouse) return;
  if (!move) {
    if (Math.hypot(e.clientX - moveMouse.x, e.clientY - moveMouse.y) < 5) return;
    if (!beginMove(moveMouse.blk, moveMouse.x)) { moveMouse = null; return; }
    document.body.classList.add('moving');
  }
  e.preventDefault();
  updateMove(e.clientX, e.clientY);
});
document.addEventListener('mouseup', () => {
  if (!moveMouse) return;
  moveMouse = null;
  document.body.classList.remove('moving');
  if (move) endMove(true);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && move) { document.body.classList.remove('moving'); moveMouse = null; endMove(false); } });
// スマホ: 帯を長押しすると持ち上がり、そのまま指を動かす（長押しの前に動かせば、今まで通りスクロール）
let moveTouch = null;
$('main').addEventListener('touchstart', (e) => {
  const blk = e.target.closest('.blk.res');
  if (!blk || e.touches.length !== 1 || !blk.closest('.tl-track')) { moveTouch = null; return; }
  const t = e.touches[0];
  moveTouch = { blk, x: t.clientX, y: t.clientY };
  moveTouch.timer = setTimeout(() => {
    if (!moveTouch || !beginMove(blk, moveTouch.x)) return;
    if (navigator.vibrate) navigator.vibrate(15);
    updateMove(moveTouch.x, moveTouch.y);
  }, LONG_PRESS_MS);
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (!moveTouch) return;
  const t = e.touches[0];
  if (move) { e.preventDefault(); updateMove(t.clientX, t.clientY); return; }
  if (Math.abs(t.clientX - moveTouch.x) > 10 || Math.abs(t.clientY - moveTouch.y) > 10) { clearTimeout(moveTouch.timer); moveTouch = null; }
}, { passive: false });
document.addEventListener('touchend', (e) => {
  if (!moveTouch) return;
  clearTimeout(moveTouch.timer);
  moveTouch = null;
  if (move) { e.preventDefault(); endMove(true); }
}, { passive: false });
document.addEventListener('touchcancel', () => { if (moveTouch) clearTimeout(moveTouch.timer); moveTouch = null; endMove(false); });
