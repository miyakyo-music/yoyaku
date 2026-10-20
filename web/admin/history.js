// 管理画面: 予約履歴（条件で絞り込んだ一覧と、行を押したときの詳細）
'use strict';

// ---------------- 予約履歴（表示・印刷・エクスポート） ----------------
// 期間・部屋を選び、統計と同じ getSchedule（管理者なので限定公開の部屋も含む）で読んで、印刷するか、
// CSV・Excel（.xlsx）・PDF のファイルにする。ファイルづくりは外部の部品を使わず、この画面の中で行う
const EXPORT_MAX_DAYS = 731; // 一度に書き出せる期間（2年）
const EXPORT_HEAD = ['日付', '曜日', '開始', '終了', '部屋', '学籍番号/所属', '氏名・団体名', '備考'];
const exportPick = roomPicker('xRoom', { chip: '部屋', onChange: () => refilter() });
const showExportFrom = dateField('xFrom');
const showExportTo = dateField('xTo');
function renderExportForm() {
  exportPick.render();
  const t = state.data.today;
  if (!$('xFrom').value) $('xFrom').value = t.slice(0, 8) + '01'; // 今月の1日から
  if (!$('xTo').value) { const [y, m] = t.split('-').map(Number); $('xTo').value = ymd(new Date(y, m, 0)); } // 今月の末日まで
  showExportFrom();
  showExportTo();
  if (!$('xWdPop').children.length) {
    $('xWdPop').innerHTML = `<label class="check"><input type="checkbox" value="">すべての曜日</label>` + [1, 2, 3, 4, 5, 6, 0].map((i) =>
      `<label class="check ${wdClass(i)}"><input type="checkbox" value="${i}">${WEEKDAY_NAMES[i]}曜日</label>`).join('');
    showWeekdays();
  }
  refilter(); // 一覧を出す（同じ期間は1分間読み直さない）
}

// 曜日（丸いボタンを押すと一覧が開く。何も選ばなければすべて）
const exportWds = new Set();
function showWeekdays() {
  $('xWdPop').querySelectorAll('input').forEach((c) => { c.checked = c.value ? exportWds.has(Number(c.value)) : !exportWds.size; });
  const list = [1, 2, 3, 4, 5, 6, 0].filter((i) => exportWds.has(i));
  $('xWdBtn').textContent = list.length ? list.map((i) => WEEKDAY_NAMES[i]).join('・') : '曜日';
  $('xWdBtn').classList.toggle('on', !!list.length);
}
function toggleWd(open) {
  $('xWdPop').hidden = !open;
  $('xWdBtn').setAttribute('aria-expanded', String(open));
}
$('xWdBtn').addEventListener('click', () => toggleWd($('xWdPop').hidden));
$('xWdPop').addEventListener('change', (e) => {
  const c = e.target;
  if (!c.value) exportWds.clear();
  else if (c.checked) exportWds.add(Number(c.value));
  else exportWds.delete(Number(c.value));
  showWeekdays();
  refilter();
});
document.addEventListener('pointerdown', (e) => { if (!$('xWdPop').hidden && !$('xWdPick').contains(e.target)) toggleWd(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('xWdPop').hidden) { toggleWd(false); $('xWdBtn').focus(); } });
// 並び順（押すたびに古い順・新しい順を切り替える）
$('xSort').addEventListener('click', () => {
  const desc = $('xSort').dataset.dir !== 'desc';
  $('xSort').dataset.dir = desc ? 'desc' : 'asc';
  $('xSort').textContent = desc ? '新しい順' : '古い順';
  refilter();
});
// 重要な予定（押すたびに入・切）
$('xColor').addEventListener('click', () => {
  $('xColor').setAttribute('aria-pressed', String($('xColor').getAttribute('aria-pressed') !== 'true'));
  $('xColor').classList.toggle('on', $('xColor').getAttribute('aria-pressed') === 'true');
  refilter();
});

// 検索は、全角・半角、大文字・小文字、ひらがな・カタカナ、空白の違いを区別しない（予約表の検索と同じ）
const normText = (t) => String(t || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '')
  .replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
/** 検索・絞り込みの条件（何も指定がなければ null） */
function exportFilter() {
  const q = normText($('xQuery').value);
  const wds = [1, 2, 3, 4, 5, 6, 0].filter((i) => exportWds.has(i));
  const color = $('xColor').getAttribute('aria-pressed') === 'true';
  if (!q && !wds.length && !color) return null;
  const label = [q ? `検索「${$('xQuery').value.trim()}」` : '', wds.length ? `曜日: ${wds.map((i) => WEEKDAY_NAMES[i]).join('')}` : '', color ? '重要な予定だけ' : '']
    .filter(Boolean).join('・');
  return {
    label,
    test: (r) => (!wds.length || wds.includes(weekdayOf(r.date))) && (!color || !!r.color) &&
      (!q || normText([r.name, r.affiliation, r.memo, roomName(r.roomId)].join(' ')).includes(q)),
  };
}
// 同じ期間を続けて読むときは、1分間は読み直さない（検索・絞り込みを変えるたびに待たせない）
let exportCache = null;
async function fetchForExport(from, to) {
  const key = from + '|' + to;
  if (exportCache && exportCache.key === key && Date.now() - exportCache.at < 60 * 1000) return exportCache.list;
  const list = await fetchReservations(from, to);
  exportCache = { key, list, at: Date.now() };
  return list;
}

/** 選んだ期間・部屋の予約（日付・開始・部屋の並び順）。期間がおかしいときは例外 */
async function exportRows() {
  const from = $('xFrom').value, to = $('xTo').value;
  if (!from || !to) throw new Error('開始日と終了日を選んでください。');
  if (from > to) throw new Error('終了日は開始日と同じか、それより後にしてください。');
  if (daysIn(from, to).length > EXPORT_MAX_DAYS) throw new Error('一度に書き出せるのは2年分までです。');
  const ids = exportPick.ids();
  const want = ids.length ? new Set(ids) : null;
  const order = new Map(state.data.rooms.map((r, i) => [r.id, i]));
  const filter = exportFilter();
  const list = (await fetchForExport(from, to)).filter((r) => (!want || want.has(r.roomId)) && (!filter || filter.test(r)));
  // 並び: 古い順（日付・開始時刻）か新しい順。同じ時刻の中は、どちらも部屋の並び順
  const dir = $('xSort').dataset.dir === 'desc' ? -1 : 1;
  list.sort((a, b) => dir * (a.date + a.start).localeCompare(b.date + b.start) || (order.get(a.roomId) ?? 999) - (order.get(b.roomId) ?? 999));
  const now = new Date();
  return {
    from, to, ids, list,
    rooms: (ids.length ? ids.map(roomName).join('、') : '全室') + (filter ? `　${filter.label}` : ''),
    stamp: `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
  };
}
const wdOf = (d) => WEEKDAY_NAMES[weekdayOf(d)];
const slash = (d) => d.replace(/-/g, '/');
/** 表の1行（CSV・Excel の列の順） */
const exportCells = (r) => [slash(r.date), wdOf(r.date), r.start, r.end, roomName(r.roomId), r.affiliation, r.name, r.memo];

const SHOW_MAX = 2000; // 画面に並べる上限（それより多いときは、印刷・エクスポートで全部を見てもらう）
/**
 * 一覧の表（画面と印刷で共通）。cols は出す項目（LIST_COLS の k）。日付は日ごとに最初の行だけ。年をまたぐ期間では年も出す。
 * clickable: 画面用。行を押すと、その予約の情報を全部その下に開く（data-i に list の番号）
 */
function listTable({ from, to, list }, opt) {
  opt = opt || {};
  const cols = LIST_COLS.filter((c) => (opt.cols || LIST_COLS.map((x) => x.k)).includes(c.k));
  const crossYear = from.slice(0, 4) !== to.slice(0, 4);
  let prev = '';
  const body = list.slice(0, opt.max || list.length).map((r, i) => {
    const first = r.date !== prev;
    prev = r.date;
    const w = wdOf(r.date);
    const cells = cols.map((c) => (c.k === 'date'
      ? `<td class="d">${first ? `${crossYear ? slash(r.date) : slash(r.date).slice(5)}<span class="${wdClass(weekdayOf(r.date))}">(${w})</span>` : ''}</td>`
      : c.k === 'time'
        // 開始を右揃えにして「〜」の位置をそろえる（「9:25」と「10:00」で桁数が違うため）
        ? `<td class="c-time"><span class="t-s">${hm(r.start)}</span>〜${hm(r.end)}</td>`
        : c.k === 'room' && opt.clickable
          ? `<td class="c-room">${esc(shortRoom(r.roomId)).replace(/（.*$/, (t) => `<wbr><span class="tg">${t}</span>`)}</td>` // 長いときは「（」の前で折り返す
          : `<td class="c-${c.k}">${esc(cellOf(r, c.k))}</td>`)).join('');
    const sel = opt.select ? `<td class="sel"><input type="checkbox" tabindex="-1" aria-label="選ぶ"${opt.select.has(r.id) ? ' checked' : ''}></td>` : '';
    return `<tr class="${first ? 'day' : ''}${opt.select && opt.select.has(r.id) ? ' picked' : ''}"${opt.clickable ? ` data-i="${i}" tabindex="0"` : ''}>${sel}${cells}</tr>`;
  }).join('');
  const selHead = opt.select ? '<th class="sel"><input type="checkbox" id="xSelAll" aria-label="すべて選ぶ"></th>' : '';
  return `<table class="list-table${opt.clickable ? ' clickable' : ''}${opt.select ? ' selecting' : ''}"><thead><tr>${selHead}${cols.map((c) => `<th>${c.label}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
}
const COLOR_NAMES = { red: '赤', purple: '紫', green: '緑' };
/** 行を押したときに開く、その予約の情報（備考・まとめ予約・編集用パスワード・重要な予定） */
function detailHtml(r) {
  const row = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
  return `<dl class="res-detail">` +
    row('日時', `${esc(slash(r.date))}(${wdOf(r.date)}) ${hm(r.start)}〜${hm(r.end)}`) +
    row('部屋', esc(roomName(r.roomId))) +
    row('氏名・団体名', esc(r.name)) +
    row('学籍番号/所属', esc(r.affiliation) || '<span class="none">なし</span>') +
    row('備考', esc(r.memo) || '<span class="none">なし</span>') +
    row('まとめ予約', r.groupId ? 'くり返し・複数部屋でまとめて作った予約の1件' : '<span class="none">いいえ</span>') +
    row('編集用パスワード', r.hasPin ? '設定あり' : '<span class="none">なし</span>') +
    row('重要な予定', r.color ? `<span class="swatch c-${r.color}"></span>${COLOR_NAMES[r.color] || r.color}` : '<span class="none">なし</span>') +
    `</dl>`;
}
let shownList = [];
function toggleDetail(tr) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('detail')) { next.remove(); tr.classList.remove('open'); tr.setAttribute('aria-expanded', 'false'); return; }
  const r = shownList[Number(tr.dataset.i)];
  if (!r) return;
  tr.insertAdjacentHTML('afterend', `<tr class="detail"><td colspan="${tr.children.length}">${detailHtml(r)}</td></tr>`);
  tr.classList.add('open');
  tr.setAttribute('aria-expanded', 'true');
}
$('xResultBody').addEventListener('click', (e) => {
  if (e.target.id === 'xSelAll') { pickAll(e.target.checked); return; }
  const tr = e.target.closest('tr[data-i]');
  if (!tr) return;
  if (pickedIds) pickRow(tr, e.shiftKey, e.target.type === 'checkbox' ? e.target.checked : null);
  else toggleDetail(tr);
});
$('xResultBody').addEventListener('keydown', (e) => {
  const tr = e.target.closest('tr[data-i]');
  if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); if (pickedIds) pickRow(tr, e.shiftKey, null); else toggleDetail(tr); }
});

// ---------------- 選んで削除する ----------------
// 「選択」を押すと各行に印の欄が出る。行を押すと選ぶ・外す。Shift を押しながら押すと、前に押した行との間をまとめて同じにする
let pickedIds = null; // 選んでいる予約の ID（選ぶ状態でないときは null）
let lastPick = -1;
function setPicking(on) {
  pickedIds = on ? new Set() : null;
  lastPick = -1;
  $('xSelect').setAttribute('aria-pressed', String(on));
  $('xSelect').textContent = on ? '完了' : '選択';
  $('xFmtPick').hidden = on;
  $('xDelBtn').hidden = !on;
  showHistory();
}
$('xSelect').addEventListener('click', () => setPicking(!pickedIds));
function shownRows() { return [...$('xResultBody').querySelectorAll('tr[data-i]')]; }
function pickRow(tr, range, want) {
  const i = Number(tr.dataset.i);
  const on = want == null ? !pickedIds.has(shownList[i].id) : want;
  const from = range && lastPick >= 0 ? Math.min(lastPick, i) : i;
  const to = range && lastPick >= 0 ? Math.max(lastPick, i) : i;
  for (let k = from; k <= to; k++) { if (on) pickedIds.add(shownList[k].id); else pickedIds.delete(shownList[k].id); }
  lastPick = i;
  syncPicks();
}
function pickAll(on) {
  shownList.slice(0, SHOW_MAX).forEach((r) => { if (on) pickedIds.add(r.id); else pickedIds.delete(r.id); });
  syncPicks();
}
/** 印・行の色・すべて選ぶの印・削除ボタンの件数を、選んでいる内容に合わせる */
function syncPicks() {
  if (!pickedIds) return;
  for (const tr of shownRows()) {
    const on = pickedIds.has(shownList[Number(tr.dataset.i)].id);
    tr.classList.toggle('picked', on);
    tr.querySelector('td.sel input').checked = on;
  }
  const all = $('xSelAll');
  const n = Math.min(shownList.length, SHOW_MAX);
  if (all) { all.checked = n > 0 && pickedIds.size === n; all.indeterminate = pickedIds.size > 0 && pickedIds.size < n; }
  $('xDelBtn').disabled = !pickedIds.size;
  $('xDelBtn').innerHTML = pickedIds.size ? `${pickedIds.size}件を削除` : '削除';
}
$('xDelBtn').addEventListener('click', async () => {
  if (!pickedIds || !pickedIds.size) return;
  const ids = [...pickedIds];
  if (!confirm(`${ids.length}件の予約を削除します。元に戻せません。`)) return;
  const btn = $('xDelBtn');
  btn.disabled = true;
  btn.textContent = '削除中…';
  $('exportError').textContent = '';
  try {
    const res = await api('adminDeleteReservations', { ids });
    if (!res.ok) throw new Error(res.message);
    exportCache = null; // 次の表示は読み直す
    for (const k of Object.keys(statsCache)) delete statsCache[k]; // 統計も読み直す
    toast(`${res.deletedIds.length}件を削除しました`);
    setPicking(false);
  } catch (e) {
    $('exportError').textContent = errMessage(e);
    syncPicks();
  }
});

// 一覧: 条件を変えるたびに、欄の下の表を出し直す（入力の途中は少し待つ。古い読み込みの結果は捨てる）
let historySeq = 0;
async function showHistory() {
  const seq = ++historySeq;
  const head = $('xResultHead');
  $('exportError').textContent = '';
  head.textContent = '読み込み中…';
  let data;
  try {
    data = await exportRows();
  } catch (e) {
    if (seq !== historySeq) return;
    head.textContent = '';
    $('xResultBody').innerHTML = '';
    $('exportError').textContent = errMessage(e);
    // 表が消えたので、選んでいた予約も外し、削除ボタンを押せなくする（見えない予約を消さないように）
    shownList = [];
    if (pickedIds) { pickedIds.clear(); lastPick = -1; $('xDelBtn').disabled = true; $('xDelBtn').innerHTML = '削除'; }
    return;
  }
  if (seq !== historySeq) return;
  const { list } = data;
  const cond = exportFilter();
  head.innerHTML = `<b>${list.length}件</b>` + (cond ? `<span class="cond">${esc(cond.label)}</span>` : '') +
    (list.length > SHOW_MAX ? `<span>先頭の${SHOW_MAX}件を表示（すべては印刷・エクスポートで）</span>` : '');
  shownList = list;
  if (pickedIds) { const ids = new Set(list.slice(0, SHOW_MAX).map((r) => r.id)); for (const id of [...pickedIds]) if (!ids.has(id)) pickedIds.delete(id); lastPick = -1; } // 条件で見えなくなった予約は選ばない
  // 画面では備考を出さない（行を押すと、その予約の情報を全部開く）
  $('xResultBody').innerHTML = list.length ? listTable(data, { max: SHOW_MAX, cols: ['date', 'time', 'room', 'name', 'aff'], clickable: true, select: pickedIds })
    : '<p class="empty">条件に合う予約はありません。</p>';
  // スマホの1行表示: 部屋の列は、この一覧でいちばん長い部屋名の幅にして、氏名をできるだけ左に寄せる（8文字分まで）。
  // タグ付きの部屋名（練習室6（電子P.2）など）は「（」の前で折り返すので、名前とタグの長い方で測る
  const em = (t) => [...t].reduce((n, ch) => n + (ch.codePointAt(0) < 0x7f ? 0.55 : 1), 0);
  const roomW = Math.min(8, Math.max(3, ...list.slice(0, SHOW_MAX).map((r) => Math.max(...shortRoom(r.roomId).split(/(?=（)/).map(em))))) + 0.4;
  $('xResultBody').style.setProperty('--room-w', `${roomW.toFixed(2)}em`);
  syncPicks();
}
// 一覧の上の行と表の見出しを留める位置（上部の帯と、その行の高さ。admin/history.css）
if (window.ResizeObserver) {
  const syncStick = () => {
    const s = document.documentElement.style;
    // 高さは小数まで測る（整数に丸めると 0.5px の隙間ができ、後ろの一覧が透けて見えた）
    s.setProperty('--top-h', `${document.querySelector('.topbar').getBoundingClientRect().height}px`);
    s.setProperty('--hxbar-h', `${document.querySelector('.hx-bar').getBoundingClientRect().height}px`);
  };
  const ro = new ResizeObserver(syncStick);
  ro.observe(document.querySelector('.topbar'));
  ro.observe(document.querySelector('.hx-bar'));
}
let refilterTimer = 0;
function refilter(wait) {
  clearTimeout(refilterTimer);
  refilterTimer = setTimeout(showHistory, wait == null ? 0 : wait);
}
$('xQuery').addEventListener('input', () => refilter(250));
$('xQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); refilter(0); } });
$('xFrom').addEventListener('change', () => refilter(300));
$('xTo').addEventListener('change', () => refilter(300));
