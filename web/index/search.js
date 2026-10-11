// 予約表: 予約の検索
'use strict';

// ---------------- 予約の検索 ----------------
// 今日から予約を受け付けている先まで（30〜180日）の予約を、予約表と同じ読み方（高速キャッシュ → GAS）で42日ずつ読み、
// 画面の中で探す。全角・半角、大文字・小文字、ひらがな・カタカナ、空白の違いは区別しない
const normText = (t) => String(t || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '')
  .replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
async function openSearch() {
  $('searchDialog').showModal();
  $('searchInput').focus();
  const s = state.settings;
  const days = Math.min(180, Math.max(30, Number(s && s.maxDaysAhead) || 60));
  const from = todayStr(), to = addDays(from, days);
  if (state.search && state.search.from === from && Date.now() - state.search.at < 60 * 1000) { runSearch(); return; }
  state.search = null;
  $('searchInfo').textContent = '読み込み中…';
  try {
    const ranges = [];
    for (let d = from; d <= to; d = addDays(d, 42)) ranges.push({ from: d, to: addDays(d, 41) < to ? addDays(d, 41) : to });
    const results = await Promise.all(ranges.map((r) => fetchRange(r)));
    const seen = new Set();
    const list = [];
    for (const res of results) for (const r of res.reservations) if (!seen.has(r.id)) { seen.add(r.id); list.push(r); }
    list.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    state.search = { from, to, at: Date.now(), list, rooms: results[0] ? results[0].rooms : state.rooms };
    runSearch();
  } catch (e) {
    if (!(e instanceof AuthError)) $('searchInfo').textContent = errMessage(e);
  }
}
function runSearch() {
  const sr = state.search;
  if (!sr) return;
  const q = normText($('searchInput').value);
  const range = `${mdLabel(sr.from)}〜${mdLabel(sr.to)}`;
  if (!q) { $('searchInfo').textContent = `${range}の予約から探します`; $('searchList').innerHTML = ''; return; }
  const now = nowMin(), today = todayStr();
  const roomOf = (id) => sr.rooms.find((x) => x.id === id) || roomById(id);
  const hits = sr.list.filter((r) => {
    if (r.date === today && toMin(r.end) <= now) return false; // 今日の終わった予約は出さない
    const rm = roomOf(r.roomId);
    return normText([r.name, r.affiliation, r.memo, rm ? roomText(rm) : ''].join(' ')).includes(q);
  });
  $('searchInfo').textContent = hits.length ? `${hits.length}件（${range}）` : `見つかりません（${range}）`;
  const mark = (t) => {
    // 一致した所に印を付ける（文字の並びが同じときだけ。表記ゆれで一致したときは印なし）
    const raw = String(t || '');
    const i = raw.toLowerCase().indexOf($('searchInput').value.trim().toLowerCase());
    const n = $('searchInput').value.trim().length;
    return i >= 0 && n ? esc(raw.slice(0, i)) + `<mark>${esc(raw.slice(i, i + n))}</mark>` + esc(raw.slice(i + n)) : esc(raw);
  };
  $('searchList').innerHTML = hits.slice(0, 200).map((r) => {
    const rm = roomOf(r.roomId);
    return `<li><button type="button" data-date="${r.date}" data-id="${esc(r.id)}">` +
      `<b>${esc(mdLabel(r.date))} ${esc(hm(r.start))}〜${esc(hm(r.end))}　${esc(rm ? roomText(rm) : r.roomId)}</b>` +
      `<span>${mark(r.name)}${r.affiliation ? `（${mark(r.affiliation)}）` : ''}${r.memo ? `　${mark(r.memo)}` : ''}</span></button></li>`;
  }).join('');
}
let searchTimer = 0;
$('searchInput').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 120); });
$('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
$('searchBtn').addEventListener('click', openSearch);
$('searchList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-id]');
  if (!b) return;
  $('searchDialog').close();
  state.view = 'day';
  save_(LS.view, 'day');
  state.date = b.dataset.date;
  if (state.data) applySettings();
  updateChrome();
  load({ then: () => openDetail(b.dataset.id) });
});
