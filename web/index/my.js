// 予約表: 自分の予約（この端末で作った予約の一覧と練習時間）
'use strict';

// ---------------- この端末の予約一覧 ----------------
// ---------------- 練習時間（この端末で予約した分の集計） ----------------
// 「自分の予約」の小窓の「練習時間」。端末の記録（LS.history）の予約をサーバーから読み直して数える
// （取り消された予約はサーバーに無いので数えない）。終わった分を「練習した時間」、これからの分を「予定」とする
function setMyTab(tab) {
  for (const b of $('myTabs').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.my === tab));
  $('myListPane').hidden = tab !== 'list';
  $('myStatsPane').hidden = tab !== 'stats';
  if (tab === 'stats') loadMyStats();
}
$('myTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-my]'); if (b) setMyTab(b.dataset.my); });
$('myPeriod').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-p]');
  if (!b) return;
  for (const x of $('myPeriod').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
  renderMyStats();
});
/** 期間（今週＝月〜日、今月、今年度＝4月1日〜3月31日） */
function myPeriodRange(p) {
  const t = todayStr();
  const d = parseDate(t);
  if (p === 'week') { const from = addDays(t, -((d.getDay() + 6) % 7)); return { from, to: addDays(from, 6) }; }
  if (p === 'month') { const from = t.slice(0, 8) + '01'; return { from, to: addDays(addMonths(from, 1), -1) }; }
  const fy = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return { from: `${fy}-04-01`, to: `${fy + 1}-03-31` };
}
async function loadMyStats() {
  const body = $('myStatsBody');
  const h = load_(LS.history, {});
  const ids = Object.keys(h);
  if (!ids.length) { state.myStats = []; renderMyStats(); return; }
  body.innerHTML = '<p class="ms-empty">読み込み中…</p>';
  try {
    const list = [];
    for (let i = 0; i < ids.length; i += 300) { // サーバーは1回300件まで
      const res = await api('getReservationsByIds', { ids: ids.slice(i, i + 300) });
      if (!res.ok) throw new Error(res.message);
      list.push(...res.reservations);
      state.myStatsRooms = res.rooms;
    }
    state.myStats = list;
    renderMyStats();
  } catch (e) {
    if (!(e instanceof AuthError)) body.innerHTML = `<p class="ms-empty">${esc(errMessage(e))}</p>`;
  }
}
function renderMyStats() {
  const body = $('myStatsBody');
  const list = state.myStats;
  if (!list) return;
  const p = ($('myPeriod').querySelector('[aria-pressed="true"]') || {}).dataset.p || 'month';
  const { from, to } = myPeriodRange(p);
  const today = todayStr(), now = nowMin();
  const inRange = list.filter((r) => r.date >= from && r.date <= to);
  const ended = (r) => r.date < today || (r.date === today && toMin(r.end) <= now);
  const dur = (r) => toMin(r.end) - toMin(r.start);
  const done = inRange.filter(ended);
  const planned = inRange.filter((r) => !ended(r));
  const total = done.reduce((a, r) => a + dur(r), 0);
  const plan = planned.reduce((a, r) => a + dur(r), 0);
  if (!done.length && !planned.length) { body.innerHTML = '<p class="ms-empty">この期間の、この端末からの予約はありません。</p>'; return; }
  const hh = (m) => (m ? durationLabel(m) : '0分');
  // 部屋ごと（多い順、上位6つ）と曜日ごと（終わった分）
  const rooms = state.myStatsRooms || state.rooms;
  const byRoom = {};
  for (const r of done) byRoom[r.roomId] = (byRoom[r.roomId] || 0) + dur(r);
  const roomRows = Object.entries(byRoom).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxRoom = roomRows.length ? roomRows[0][1] : 1;
  const byDow = [0, 0, 0, 0, 0, 0, 0];
  for (const r of done) byDow[weekday(r.date)] += dur(r);
  const maxDow = Math.max(1, ...byDow);
  const order = [1, 2, 3, 4, 5, 6, 0]; // 月曜はじまり
  body.innerHTML =
    `<div class="ms-total"><b>${hh(total)}</b><span>${done.length}回${plan ? `・このあと予定 ${hh(plan)}` : ''}</span></div>` +
    (roomRows.length ? `<p class="ms-h">部屋ごと</p><div class="ms-bars">` + roomRows.map(([id, m]) => {
      const rm = rooms.find((x) => x.id === id);
      return `<div class="ms-bar"><span>${esc(rm ? roomText(rm) : id)}</span><i style="width:${(m / maxRoom * 100).toFixed(1)}%"></i><em>${hh(m)}</em></div>`;
    }).join('') + '</div>' : '') +
    (done.length ? `<p class="ms-h">曜日ごと</p><div class="ms-week">` + order.map((w) =>
      `<div class="${w === 0 ? 'sun' : w === 6 ? 'sat' : ''}" title="${WEEKDAY_NAMES[w]}曜 ${hh(byDow[w])}"><i style="height:${(byDow[w] / maxDow * 70).toFixed(1)}px"></i>${WEEKDAY_NAMES[w]}</div>`).join('') + '</div>' : '');
}

// 広い画面ではボタンの真下に出す（マウスの移動を短く）。狭い画面は中央のまま
function placeUnderBtn(dlg, btn) {
  const st = dlg.style;
  if (innerWidth < 700) { st.margin = st.top = st.left = st.maxHeight = ''; return; }
  const b = btn.getBoundingClientRect();
  st.margin = '0';
  st.top = (b.bottom + 8) + 'px';
  st.maxHeight = `calc(100dvh - ${b.bottom + 18}px)`;
  st.left = Math.max(10, Math.min(b.right - dlg.offsetWidth, innerWidth - dlg.offsetWidth - 10)) + 'px';
}

async function openMyList() {
  setMyTab('list');
  state.myStats = null;
  const mine = getMine();
  const today = todayStr();
  const ids = Object.keys(mine).filter((id) => mine[id] >= today);
  const list = $('myList');
  list.innerHTML = '<li class="hint">読み込み中…</li>';
  $('myDialog').showModal();
  placeUnderBtn($('myDialog'), $('myBtn'));
  if (!ids.length) { list.innerHTML = '<li class="hint">予約はありません。</li>'; return; }
  try {
    const res = await api('getReservationsByIds', { ids });
    if (!res.ok) throw new Error(res.message);
    const found = new Set(res.reservations.map((r) => r.id));
    removeMine(ids.filter((id) => !found.has(id))); // 取り消された予約は一覧から消す
    const now = nowMin();
    const upcoming = res.reservations.filter((r) => r.date > today || toMin(r.end) > now);
    list.innerHTML = upcoming.length ? upcoming.map((r) => {
      const room = res.rooms.find((x) => x.id === r.roomId);
      return `<li><button type="button" data-date="${r.date}" data-id="${esc(r.id)}">` +
        `<b>${esc(mdLabel(r.date))} ${esc(hm(r.start))}〜${esc(hm(r.end))}</b>` +
        `<span>${esc(room ? roomText(room) : r.roomId)}　${esc(personText(r))}${r.groupId ? '　↻まとめ予約' : ''}</span></button></li>`;
    }).join('') : '<li class="hint">予約はありません。</li>';
  } catch (e) {
    if (!(e instanceof AuthError)) list.innerHTML = `<li class="error">${esc(errMessage(e))}</li>`;
  }
}

$('myList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (!b) return;
  $('myDialog').close();
  state.view = 'day';
  save_(LS.view, 'day');
  state.date = b.dataset.date;
  if (state.data) applySettings();
  updateChrome();
  load({ then: () => openDetail(b.dataset.id) });
});
