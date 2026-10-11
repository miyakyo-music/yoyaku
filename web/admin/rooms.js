// 管理画面: 練習室の一覧（追加・削除・並べ替え・保存）
'use strict';

// スマホでは各部屋を1行に畳んで一覧しやすくし、押した部屋だけ開いて編集する（PC では常に全項目を表示）
const openRooms = new WeakSet();
function roomSumHtml(r) {
  const tags = String(r.tags || '').split(/[・,、\s]+/).filter(Boolean).map((t) => `<span class="chip">${esc(t)}</span>`).join('');
  const restr = r.restriction ? `<span class="chip warn">${esc(r.restriction)}</span>` : '';
  return `<span class="s-name">${esc(r.name) || '（名前未入力）'}</span>${tags}${restr}<span class="s-eq">${esc(r.equipment)}</span><span class="chev" aria-hidden="true">▾</span>`;
}
function renderRooms() {
  const equip = [...new Set(state.rooms.map((r) => r.equipment).concat(['グランドピアノ', 'アップライトピアノ', '電子ピアノ', '大部屋']).filter(Boolean))];
  $('equipList').innerHTML = equip.map((e) => `<option value="${esc(e)}">`).join('');
  $('roomList').innerHTML = state.rooms.map((r, i) => `
      <div class="room${r.id ? '' : ' new'}${openRooms.has(r) ? ' open' : ''}" data-i="${i}">
        <button type="button" class="room-sum" data-act="toggle" aria-expanded="${openRooms.has(r) ? 'true' : 'false'}">${roomSumHtml(r)}</button>
        <span class="no" data-drag title="ドラッグで並べ替え" aria-label="${i + 1}番目（ドラッグで並べ替え）"><span class="grip" aria-hidden="true">⠿</span>${i + 1}</span>
        <div class="c-name"><span class="lbl">部屋名</span><input class="in" data-f="name" value="${esc(r.name)}" maxlength="30" aria-label="部屋名" placeholder="新しい部屋の名前"></div>
        <div class="c-tags"><span class="lbl">特徴タグ</span><input class="in" data-f="tags" value="${esc(r.tags)}" maxlength="30" aria-label="特徴タグ"${r.id ? '' : ' placeholder="例：大・GP"'}></div>
        <div class="c-eq"><span class="lbl">設備区分</span><input class="in" data-f="equipment" value="${esc(r.equipment)}" maxlength="20" list="equipList" aria-label="設備区分"></div>
        <div class="c-restr"><span class="lbl">予約制限</span><select class="in" data-f="restriction" aria-label="予約制限">${RESTRICTIONS.map(([v, l]) => `<option value="${esc(v)}"${r.restriction === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="c-note"><span class="lbl">備考</span><input class="in" data-f="note" value="${esc(r.note)}" maxlength="100" aria-label="備考"></div>
        <div class="ops">
          <button type="button" class="btn small danger-text" data-act="del">削除</button>
        </div>
      </div>`).join('') || '<p class="empty">部屋がありません。「＋ 部屋を追加」から登録してください。</p>';
}

$('roomList').addEventListener('input', (e) => {
  const el = e.target.closest('[data-f]');
  if (!el) return;
  const row = el.closest('.room');
  const r = state.rooms[Number(row.dataset.i)];
  r[el.dataset.f] = el.value;
  row.querySelector('.room-sum').innerHTML = roomSumHtml(r);
  checkDirty('rooms');
});
$('roomList').addEventListener('change', (e) => {
  const el = e.target.closest('select[data-f]');
  if (!el) return;
  const row = el.closest('.room');
  const r = state.rooms[Number(row.dataset.i)];
  r[el.dataset.f] = el.value;
  row.querySelector('.room-sum').innerHTML = roomSumHtml(r);
  checkDirty('rooms');
});
$('roomList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const i = Number(b.closest('.room').dataset.i);
  const rooms = state.rooms;
  if (b.dataset.act === 'toggle') {
    const row = b.closest('.room');
    const open = !row.classList.contains('open');
    row.classList.toggle('open', open);
    b.setAttribute('aria-expanded', String(open));
    if (open) openRooms.add(rooms[i]); else openRooms.delete(rooms[i]);
    return;
  }
  if (b.dataset.act === 'del') {
    if (rooms[i].id && !confirm(`「${rooms[i].name}」を削除します。\n（「保存」を押すまで反映されません）`)) return;
    rooms.splice(i, 1);
  } else return;
  checkDirty('rooms');
  renderRooms();
});
// ドラッグで並べ替え（マウス・指の両方。左端の番号の列をつまんで上下に動かす）
let sort = null;
$('roomList').addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('[data-drag]');
  if (!handle || (e.pointerType === 'mouse' && e.button !== 0)) return;
  e.preventDefault();
  const row = handle.closest('.room');
  try { handle.setPointerCapture(e.pointerId); } catch (ex) { /* 取得できなくても並べ替えはできる */ }
  row.classList.add('dragging');
  document.body.classList.add('sorting');
  sort = { row, handle, y: e.clientY, moved: false };
  // 画面の上下の端で指（マウス）を止めていても、自動でスクロールし続ける
  sort.timer = setInterval(() => {
    if (!sort) return;
    const edge = 70;
    const dy = sort.y < edge ? -14 : sort.y > window.innerHeight - edge ? 14 : 0;
    if (dy) { window.scrollBy(0, dy); moveSortRow(); }
  }, 30);
});
$('roomList').addEventListener('pointermove', (e) => {
  if (!sort) return;
  sort.y = e.clientY;
  moveSortRow();
});
function moveSortRow() {
  const { row, y } = sort;
  // 速く動かして何行も飛び越えたときも追いつくよう、位置が決まるまで1行ずつ入れ替える
  for (;;) {
    const prev = row.previousElementSibling;
    const next = row.nextElementSibling;
    if (prev && y < prev.getBoundingClientRect().top + prev.offsetHeight / 2) row.after(prev);
    else if (next && y > next.getBoundingClientRect().top + next.offsetHeight / 2) row.before(next);
    else break;
    sort.moved = true;
  }
}
function endSort() {
  if (!sort) return;
  const { row, moved, timer } = sort;
  clearInterval(timer);
  sort = null;
  row.classList.remove('dragging');
  document.body.classList.remove('sorting');
  if (!moved) return;
  const order = [...$('roomList').querySelectorAll('.room')].map((el) => Number(el.dataset.i));
  state.rooms = order.map((i) => state.rooms[i]);
  checkDirty('rooms');
  renderRooms();
}
$('roomList').addEventListener('pointerup', endSort);
$('roomList').addEventListener('pointercancel', endSort);

$('addRoomBtn').addEventListener('click', () => {
  state.rooms.push({ id: '', name: '', tags: '', equipment: '', restriction: '', note: '' });
  openRooms.add(state.rooms[state.rooms.length - 1]);
  checkDirty('rooms');
  renderRooms();
  const inputs = $('roomList').querySelectorAll('[data-f="name"]');
  const last = inputs[inputs.length - 1];
  last.scrollIntoView({ block: 'center' });
  last.focus();
});
$('saveRoomsBtn').addEventListener('click', async () => {
  const err = $('roomsError');
  err.textContent = '';
  const empty = state.rooms.findIndex((r) => !r.name.trim());
  if (empty >= 0) { err.textContent = `${empty + 1}行目: 部屋名を入力してください。`; return; }
  const btn = $('saveRoomsBtn');
  btn.disabled = true;
  try {
    const res = await api('adminSaveRooms', { rooms: state.rooms });
    if (!res.ok) throw new Error(res.message);
    state.data.rooms = res.rooms;
    state.rooms = res.rooms.map((r) => ({ ...r }));
    renderRooms();
    renderClosureForm();
    renderExportForm();
    renderClosures();
    setDirty('rooms', false);
    toast('練習室を保存しました');
  } catch (ex) {
    err.textContent = errMessage(ex);
  } finally {
    btn.disabled = false;
  }
});
