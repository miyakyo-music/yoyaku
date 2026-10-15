// 管理画面: 統計
'use strict';

// ---------------- 統計 ----------------
// 予約表と同じ getSchedule（管理者なので限定公開の部屋も含む）で期間の予約を読み、ここで集計する。
// GAS は一度に42日分までしか返さないので、期間を区切って3つずつ並べて読む。個人ごとの集計は作らない。
const WD = '日月火水木金土';
let statsPeriod = 'month';
const statsCache = {}; // 期間ごとの読み込み（読み込み中のものも入れ、同じ期間を続けて押しても二重に読まない）
let statsSeq = 0;
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function statsRange(period) {
  const now = new Date();
  if (period === 'week') { // 月曜〜日曜
    const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    return { from: ymd(mon), to: ymd(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6)), label: '今週' };
  }
  if (period === 'month') return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0)), label: '今月' };
  if (period === 'last') return { from: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: ymd(new Date(now.getFullYear(), now.getMonth(), 0)), label: '先月' };
  const fyStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return { from: `${fyStart}-04-01`, to: ymd(now), label: `${fyStart}年度（今日まで）` };
}
function addDaysStr(s, n) { const [y, m, d] = s.split('-').map(Number); return ymd(new Date(y, m - 1, d + n)); }
function daysIn(from, to) { const out = []; for (let d = from; d <= to; d = addDaysStr(d, 1)) out.push(d); return out; }

async function fetchReservations(from, to) {
  const chunks = [];
  for (let d = from; d <= to; d = addDaysStr(d, 42)) {
    const end = addDaysStr(d, 41);
    chunks.push({ from: d, to: end < to ? end : to });
  }
  const all = [];
  for (let i = 0; i < chunks.length; i += 3) {
    const got = await Promise.all(chunks.slice(i, i + 3).map((c) => api('getSchedule', c)));
    for (const res of got) {
      if (!res.ok) throw new Error(res.message);
      all.push(...res.reservations);
    }
  }
  return all;
}

async function loadStats() {
  const seq = ++statsSeq; // 期間をすばやく切り替えたとき、あとから届いた前の期間の結果は描かない
  const period = statsPeriod;
  const range = statsRange(period);
  $('statsRange').textContent = `${range.label}: ${range.from.replace(/-/g, '/')} 〜 ${range.to.replace(/-/g, '/')}`;
  const msg = $('statsMsg');
  // 読み込み済みなら、待たずに続きへ進むので「集計しています…」は画面に出ない
  msg.hidden = false; msg.className = 'msg'; msg.textContent = '集計しています…（今年度は少し時間がかかります）';
  $('statsBody').hidden = true;
  if (!statsCache[period]) statsCache[period] = fetchReservations(range.from, range.to);
  const req = statsCache[period];
  let list;
  try {
    list = await req;
  } catch (e) {
    if (statsCache[period] === req) delete statsCache[period]; // 次に押したときは読み直す
    if (seq !== statsSeq) return;
    msg.className = 'msg error'; msg.textContent = errMessage(e);
    return;
  }
  if (seq !== statsSeq) return;
  msg.hidden = true;
  renderStats(range, list);
  $('statsBody').hidden = false;
}

function hoursText(min) { const h = Math.floor(min / 60), m = Math.round(min % 60); return (h ? `${h}時間` : '') + (m || !h ? `${m}分` : ''); }

function renderStats(range, list) {
  const s = state.data.settings;
  const open = toMin(s.openTime), close = toMin(s.closeTime);
  const rooms = state.data.rooms;
  const days = daysIn(range.from, range.to).filter((d) => !s.closedWeekdays.includes(new Date(d + 'T00:00').getDay()));
  const total = list.reduce((a, r) => a + (toMin(r.end) - toMin(r.start)), 0);
  $('stCount').textContent = `${list.length}件`;
  $('stHours').textContent = hoursText(total);
  $('stAvg').textContent = list.length ? hoursText(total / list.length) : '—';

  // 曜日 × 時間（1時間ごと）に、使われていた分を足す。曜日ごとの日数で割って「平均で何部屋」にする
  const h0 = Math.floor(open / 60), h1 = Math.ceil(close / 60);
  const grid = Array.from({ length: 7 }, () => new Array(h1 - h0).fill(0));
  const dayCount = new Array(7).fill(0);
  for (const d of daysIn(range.from, range.to)) dayCount[new Date(d + 'T00:00').getDay()]++;
  for (const r of list) {
    const wd = new Date(r.date + 'T00:00').getDay();
    const a = toMin(r.start), b = toMin(r.end);
    for (let h = h0; h < h1; h++) {
      const ov = Math.min(b, (h + 1) * 60) - Math.max(a, h * 60);
      if (ov > 0) grid[wd][h - h0] += ov / 60;
    }
  }
  const avg = grid.map((row, wd) => row.map((v) => (dayCount[wd] ? v / dayCount[wd] : 0)));
  const max = Math.max(0.0001, ...avg.flat());
  let peak = null;
  avg.forEach((row, wd) => row.forEach((v, i) => { if (!peak || v > peak.v) peak = { v, wd, h: h0 + i }; }));
  $('stPeak').textContent = peak && peak.v > 0 ? `${WD[peak.wd]}曜 ${peak.h}時台` : '—';
  const order = [1, 2, 3, 4, 5, 6, 0]; // 月曜はじまり
  let html = '<div class="hc"></div>' + Array.from({ length: h1 - h0 }, (_, i) => `<div class="hh">${(h0 + i) % 3 === 0 ? h0 + i : ''}</div>`).join('');
  for (const wd of order) {
    html += `<div class="hd ${wd === 0 ? 'sun' : wd === 6 ? 'sat' : ''}">${WD[wd]}</div>`;
    html += avg[wd].map((v, i) => `<div class="hx" style="--v:${(v / max).toFixed(3)}" title="${WD[wd]}曜 ${h0 + i}時台: 平均 ${v.toFixed(1)}部屋"></div>`).join('');
  }
  const heat = $('stHeat');
  heat.style.setProperty('--cols', h1 - h0);
  heat.innerHTML = html;

  // 部屋ごと・設備ごと
  const openMin = days.length * (close - open);
  const byRoom = new Map(rooms.map((r) => [r.id, 0]));
  for (const r of list) byRoom.set(r.roomId, (byRoom.get(r.roomId) || 0) + toMin(r.end) - toMin(r.start));
  const roomRows = rooms.filter((r) => r.restriction !== '使用停止').map((r) => ({ name: r.name + (r.tags ? `（${r.tags}）` : ''), min: byRoom.get(r.id) || 0 }));
  const roomMax = Math.max(1, ...roomRows.map((x) => x.min));
  $('stRooms').innerHTML = roomRows.map((x) => {
    const r = openMin ? (x.min / openMin) * 100 : 0;
    const pct = r && r < 10 ? r.toFixed(1) : Math.round(r); // 小さい割合は小数1けたまで
    // 棒の長さはいちばん使われた部屋を端までとした長さ（％は数％どうしで棒が短すぎ、比べられないため）
    return `<div class="bar"><span class="bn">${esc(x.name)}</span><span class="bt"><i style="width:${(x.min / roomMax) * 100}%"></i></span><span class="bv">${hoursText(x.min)}</span><span class="bp">${pct}%</span></div>`;
  }).join('');
  const byEq = new Map();
  const eqOf = new Map(rooms.map((r) => [r.id, r.equipment || 'その他']));
  for (const r of list) { const e = eqOf.get(r.roomId) || 'その他'; byEq.set(e, (byEq.get(e) || 0) + toMin(r.end) - toMin(r.start)); }
  const eqRows = [...byEq.entries()].sort((a, b) => b[1] - a[1]);
  $('stEquip').innerHTML = eqRows.length ? eqRows.map(([name, min]) =>
    `<div class="bar"><span class="bn">${esc(name)}</span><span class="bt"><i style="width:${total ? (min / total) * 100 : 0}%"></i></span><span class="bv">${hoursText(min)}</span><span class="bp">${total ? Math.round((min / total) * 100) : 0}%</span></div>`).join('')
    : '<p class="help">この期間の予約はありません。</p>';
}
for (const b of document.querySelectorAll('[data-period]')) {
  b.addEventListener('click', () => {
    statsPeriod = b.dataset.period;
    for (const x of document.querySelectorAll('[data-period]')) x.setAttribute('aria-pressed', String(x === b));
    loadStats();
  });
}
