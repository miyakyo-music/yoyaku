// 予約表: カレンダー（月表示）の描画
'use strict';

/** マスの日付。PC は「12日」、月の初日は「10月1日」（Mac のカレンダーと同じ）。スマホは数字だけ */
function dayNum(d) {
  const day = Number(d.slice(8));
  return (day === 1 ? `<span class="u">${Number(d.slice(5, 7))}月</span>` : '') + `<span class="n">${day}</span><span class="u">日</span>`;
}

function renderMonth() {
  const { from, to } = state.data;
  const reservations = visibleReservations();
  const month = state.date.slice(0, 7);
  const today = todayStr();
  const roomId = state.monthRoomId;
  const mine = getMine();
  const byDate = {};
  for (const r of reservations) {
    if (roomId && r.roomId !== roomId) continue;
    (byDate[r.date] = byDate[r.date] || []).push(r);
  }
  let html = '<div class="month">' + [...WEEKDAY_NAMES].map((w, i) => `<div class="dow ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</div>`).join('');
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const list = (byDate[d] || []).sort((a, b) => a.start.localeCompare(b.start));
    const allDayClosure = state.data.closures.find((c) => c.date === d && c.allDay && (!c.roomId || c.roomId === roomId));
    const closedLabel = isClosedWeekday(d) ? '定休日' : allDayClosure && (!allDayClosure.roomId || roomId) ? allDayClosure.reason || '利用不可' : '';
    const cls = ['mc', dayClass(d)];
    if (d.slice(0, 7) !== month) cls.push('other'); // 前後の月の日（スマホでは空欄）
    if (d === today) cls.push('today');
    if (d === state.date) cls.push('selected');
    if (closedLabel) cls.push('closed-day');
    // 前後の月の日は、キーボードの移動先にしない（スマホでは見えない。月を移れば選べる）
    html += `<div class="${cls.join(' ')}" data-date="${d}" role="button" tabindex="${d.slice(0, 7) !== month ? -1 : 0}">` +
      `<div class="d">${dayNum(d)}</div><ul>` +
      (closedLabel ? `<li class="closed">${esc(closedLabel)}</li>` : '');
    if (roomId) {
      const max = 4;
      html += list.slice(0, max).map((r) =>
        `<li class="res${Object.prototype.hasOwnProperty.call(mine, r.id) ? ' mine' : ''}${RES_COLORS.includes(r.color) ? ' c-' + r.color : ''}" title="${esc(hm(r.start))}〜${esc(hm(r.end))} ${esc(r.affiliation)} ${esc(r.name)}">` +
        `<span class="nm">${esc(r.name || r.affiliation)}</span><time>${esc(hm(r.start))}</time></li>`).join('') +
        (list.length > max ? `<li class="more">ほか${list.length - max}件</li>` : '');
    } else if (list.length) {
      const own = list.filter((r) => Object.prototype.hasOwnProperty.call(mine, r.id)).length;
      html += `<li><span class="nm"><span class="wide-only">予約 </span>${list.length}件</span></li>` + (own ? `<li class="mine"><span class="nm">自分 ${own}件</span></li>` : '');
    }
    html += '</ul></div>';
  }
  $('main').classList.remove('has-tl');
  $('main').innerHTML = html + '</div>' + footHtml('');
}

// スマホ: カレンダーを左右になぞると前の月・次の月へ（「‹」「›」と同じ）。
// 画面の端から始めたなぞりは Safari の「戻る」に任せる。縦の動きが大きいときはスクロールとみなす
let monthSwipe = null;
$('main').addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  monthSwipe = state.view === 'month' && e.touches.length === 1 && e.target.closest('.month') &&
    t.clientX > 24 && t.clientX < window.innerWidth - 24 ? { x: t.clientX, y: t.clientY } : null;
}, { passive: true });
$('main').addEventListener('touchend', (e) => {
  if (!monthSwipe) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - monthSwipe.x, dy = t.clientY - monthSwipe.y;
  monthSwipe = null;
  if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.5) swipeShift(dx < 0 ? 1 : -1);
}, { passive: true });
$('main').addEventListener('touchcancel', () => { monthSwipe = null; }, { passive: true });
