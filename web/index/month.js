// 予約表: カレンダー（月表示）の描画
'use strict';

function renderMonth() {
  const { from, to } = state.data;
  const reservations = visibleReservations();
  const month = state.date.slice(0, 7);
  const today = todayStr();
  const roomId = state.roomId;
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
    if (d.slice(0, 7) !== month) cls.push('other');
    if (d === today) cls.push('today');
    if (d === state.date) cls.push('selected');
    if (closedLabel) cls.push('closed-day');
    html += `<div class="${cls.join(' ')}" data-date="${d}" role="button" tabindex="0">` +
      `<div class="d"><span class="n">${Number(d.slice(8))}</span>${closedLabel ? `<small>${esc(closedLabel)}</small>` : ''}</div>`;
    if (roomId) {
      const max = 4;
      html += '<ul>' + list.slice(0, max).map((r) =>
        `<li class="${Object.prototype.hasOwnProperty.call(mine, r.id) ? 'mine' : ''}${RES_COLORS.includes(r.color) ? ' c-' + r.color : ''}" title="${esc(hm(r.start))}〜${esc(hm(r.end))} ${esc(r.affiliation)} ${esc(r.name)}">` +
        `${esc(hm(r.start))} ${esc(r.name || r.affiliation)}</li>`).join('') +
        (list.length > max ? `<li class="more">ほか${list.length - max}件</li>` : '') + '</ul>';
    } else if (list.length) {
      const own = list.filter((r) => Object.prototype.hasOwnProperty.call(mine, r.id)).length;
      html += `<div class="count"><span class="wide-only">予約 </span>${list.length}件</div>` + (own ? `<ul><li class="mine">自分 ${own}件</li></ul>` : '');
    }
    html += '</div>';
  }
  $('main').classList.remove('has-tl');
  $('main').innerHTML = html + '</div>' + footHtml('日付を押すと、その日の一覧を表示します');
}
