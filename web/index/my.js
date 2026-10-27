// 予約表: 自分の予約（この端末で作った予約、または名前・学籍番号で探した予約の一覧と練習時間）
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
  else loadMyList();
}
const myTab = () => ($('myTabs').querySelector('[aria-pressed="true"]') || {}).dataset.my || 'list';
const byName = () => state.mySrc === 'name';

// ---------------- 探し方（この端末 / 名前で探す） ----------------
// 「名前で探す」は、名前・団体名か学籍番号/所属が一致する予約を、過去の分も含めてサーバーから読む（findMyReservations）。
// 予約表で誰でも見られる内容なので本人確認はしない。読んだ結果は小窓を開いている間だけ覚える（state.myFound）
function setMySrc(src) {
  state.mySrc = src;
  save_(LS.mySrc, src);
  for (const b of $('mySrc').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.src === src));
  $('myNameForm').hidden = src !== 'name';
  state.myStats = null;
  setMyTab(myTab());
}
$('mySrc').addEventListener('click', (e) => { const b = e.target.closest('button[data-src]'); if (b && b.dataset.src !== state.mySrc) setMySrc(b.dataset.src); });
$('myNameForm').addEventListener('submit', (e) => {
  e.preventDefault();
  $('myNameInput').blur(); // スマホのキーボードを閉じて結果を見せる
  save_(LS.myName, $('myNameInput').value.trim());
  state.myFound = null;
  state.myStats = null;
  setMyTab(myTab());
});
/** 名前で探した予約（同じ言葉なら読み直さない）。言葉が空なら null */
async function findByName() {
  const q = $('myNameInput').value.trim();
  if (!q) return null;
  if (state.myFound && state.myFound.q === q) return state.myFound;
  const res = await api('findMyReservations', { name: q });
  if (!res.ok) throw new Error(res.message);
  state.myFound = { q, reservations: res.reservations, rooms: res.rooms };
  return state.myFound;
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
/** 予約を id で読み直す（サーバーは1回300件までなので、分けて読む）。部屋の一覧も返す */
async function fetchByIds(ids) {
  const reservations = [];
  let rooms = null;
  for (let i = 0; i < ids.length; i += 300) {
    const res = await api('getReservationsByIds', { ids: ids.slice(i, i + 300) });
    if (!res.ok) throw new Error(res.message);
    reservations.push(...res.reservations);
    rooms = res.rooms;
  }
  return { reservations, rooms };
}
async function loadMyStats() {
  const body = $('myStatsBody');
  if (byName()) {
    body.innerHTML = '<p class="ms-empty">読み込み中…</p>';
    try {
      const f = await findByName();
      if (!byName() || myTab() !== 'stats') return; // 読む間に切り替えた
      if (!f) { body.innerHTML = ''; return; }
      state.myStatsRooms = f.rooms;
      state.myStats = f.reservations;
      renderMyStats();
    } catch (e) {
      if (!(e instanceof AuthError)) body.innerHTML = `<p class="ms-empty">${esc(errMessage(e))}</p>`;
    }
    return;
  }
  const h = load_(LS.history, {});
  const ids = Object.keys(h);
  if (!ids.length) { state.myStats = []; renderMyStats(); return; }
  body.innerHTML = '<p class="ms-empty">読み込み中…</p>';
  try {
    const res = await fetchByIds(ids);
    if (byName()) return; // 読む間に切り替えた
    state.myStatsRooms = res.rooms;
    state.myStats = res.reservations;
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
  const { from, to } = p === 'all' ? { from: '', to: '9999' } : myPeriodRange(p);
  const today = todayStr(), now = nowMin();
  const inRange = list.filter((r) => r.date >= from && r.date <= to);
  const ended = (r) => isEnded(r, today, now);
  const dur = (r) => toMin(r.end) - toMin(r.start);
  const done = inRange.filter(ended);
  const planned = inRange.filter((r) => !ended(r));
  const total = done.reduce((a, r) => a + dur(r), 0);
  const plan = planned.reduce((a, r) => a + dur(r), 0);
  if (!done.length && !planned.length) { body.innerHTML = `<p class="ms-empty">この期間の${byName() ? '' : '、この端末からの'}予約はありません。</p>`; return; }
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

function openMyList() {
  state.myStats = null;
  state.myFound = null;
  const src = load_(LS.mySrc, 'device') === 'name' ? 'name' : 'device';
  if (!$('myNameInput').value) $('myNameInput').value = load_(LS.myName, '') || (load_(LS.profile, {}).name || '');
  $('myDialog').showModal();
  placeUnderBtn($('myDialog'), $('myBtn'));
  for (const b of $('myTabs').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.my === 'list'));
  setMySrc(src);
}
const myItem = (r, rooms) => {
  const room = rooms.find((x) => x.id === r.roomId);
  return `<li><button type="button" data-date="${r.date}" data-id="${esc(r.id)}">` +
    `<b>${esc(mdLabel(r.date))} ${esc(hm(r.start))}〜${esc(hm(r.end))}</b>` +
    `<span>${esc(room ? roomText(room) : r.roomId)}　${esc(personText(r))}${r.groupId ? '　↻まとめ予約' : ''}</span></button></li>`;
};
async function loadMyList() {
  const list = $('myList');
  const today = todayStr();
  if (byName()) {
    list.innerHTML = '<li class="hint">読み込み中…</li>';
    try {
      const f = await findByName();
      if (!byName() || myTab() !== 'list') return; // 読む間に切り替えた
      if (!f) { list.innerHTML = ''; return; }
      const now = nowMin();
      const upcoming = f.reservations.filter((r) => !isEnded(r, today, now));
      const past = f.reservations.filter((r) => isEnded(r, today, now)).reverse(); // これまでの分は新しい順
      // 年の違う日付が混ざるので、これまでの分は年の変わり目に見出しを入れる
      let year = today.slice(0, 4);
      list.innerHTML = !f.reservations.length ? '<li class="hint">見つかりませんでした。</li>' :
        upcoming.map((r) => myItem(r, f.rooms)).join('') +
        (past.length ? '<li class="my-sep">これまで</li>' + past.map((r) => {
          const y = r.date.slice(0, 4);
          const head = y !== year ? `<li class="my-sep">${esc(y)}年</li>` : '';
          year = y;
          return head + myItem(r, f.rooms);
        }).join('') : '');
    } catch (e) {
      if (!(e instanceof AuthError)) list.innerHTML = `<li class="error">${esc(errMessage(e))}</li>`;
    }
    return;
  }
  const mine = getMine();
  const ids = Object.keys(mine).filter((id) => mine[id] >= today);
  list.innerHTML = '<li class="hint">読み込み中…</li>';
  if (!ids.length) { list.innerHTML = '<li class="hint">予約はありません。</li>'; return; }
  try {
    const res = await fetchByIds(ids);
    if (byName()) return;
    const found = new Set(res.reservations.map((r) => r.id));
    removeMine(ids.filter((id) => !found.has(id))); // 取り消された予約は一覧から消す
    const now = nowMin();
    const upcoming = res.reservations.filter((r) => !isEnded(r, today, now));
    list.innerHTML = upcoming.length ? upcoming.map((r) => myItem(r, res.rooms)).join('') : '<li class="hint">予約はありません。</li>';
  } catch (e) {
    if (!(e instanceof AuthError)) list.innerHTML = `<li class="error">${esc(errMessage(e))}</li>`;
  }
}

/** 一覧の結果（自分の予約・検索）を押したとき: 小窓を閉じ、その日の一覧を出して予約の詳細を開く */
function openReservationAt(dlg, date, id) {
  dlg.close();
  state.view = 'day';
  save_(LS.view, 'day');
  state.date = date;
  if (state.data) applySettings();
  updateChrome();
  load({ then: () => openDetail(id) });
}
$('myList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (b) openReservationAt($('myDialog'), b.dataset.date, b.dataset.id);
});
