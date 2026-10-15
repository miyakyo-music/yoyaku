// 管理画面: 部屋を複数選べる欄と、曜日付きの日付欄（休館と予約履歴で使う）
'use strict';

function roomName(id) {
  if (!id) return '全室';
  const r = state.data.rooms.find((x) => x.id === id);
  return r ? (r.tags ? `${r.name}（${r.tags}）` : r.name) : id;
}

// 日付の欄は曜日付きで見せる（本物の日付欄は透明にして上に重ね、押すと端末のカレンダーが開く）
function showDate(input, display) {
  const v = input.value;
  if (!v) { display.textContent = '日付を選択'; return; }
  const [y, m, d] = v.split('-').map(Number);
  const w = weekdayOf(v);
  display.innerHTML = `${y}/${pad(m)}/${pad(d)}<span class="${wdClass(w)}">(${WEEKDAY_NAMES[w]})</span>`;
}
function dateField(id) {
  const show = () => showDate($(id), $(id + 'Display'));
  $(id).addEventListener('input', show);
  $(id).addEventListener('change', show);
  return show;
}

/**
 * 部屋を複数選べる欄（何も選ばなければ全室）。選択欄と同じ見た目のボタンを押すと、部屋のチェックの一覧が下に開く。
 * 休館の「対象」と、予約履歴の「部屋」で使う
 */
function roomPicker(prefix, opts) {
  opts = opts || {};
  const pick = $(prefix + 'Pick'), btn = $(prefix + 'Btn'), pop = $(prefix + 'Pop');
  const chosen = new Set();
  function show() {
    pop.querySelectorAll('input').forEach((c) => { c.checked = c.value ? chosen.has(c.value) : !chosen.size; });
    const names = state.data.rooms.filter((r) => chosen.has(r.id)).map((r) => roomName(r.id));
    const text = names.length === 1 ? names[0] : `${(names[0] || '').replace(/（.*$/, '')} ほか${names.length - 1}室`;
    // 丸いボタン（opts.chip）のときは、何も選んでいなければ項目名だけを出し、選んでいれば青くする
    btn.textContent = !names.length ? (opts.chip || '全室') : text;
    btn.classList.toggle('on', !!names.length);
    btn.title = names.join('、');
  }
  function toggle(open) {
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  }
  btn.addEventListener('click', () => toggle(pop.hidden));
  pop.addEventListener('change', (e) => {
    const c = e.target;
    if (!c.value) chosen.clear();
    else if (c.checked) chosen.add(c.value);
    else chosen.delete(c.value);
    show();
    if (opts.onChange) opts.onChange();
  });
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pick.contains(e.target)) toggle(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { toggle(false); btn.focus(); } });
  return {
    close: () => toggle(false),
    /** 選んだ部屋の ID（部屋の並び順）。何も選んでいなければ空 */
    ids: () => state.data.rooms.map((r) => r.id).filter((id) => chosen.has(id)),
    /** 部屋の一覧を作り直す（消えた部屋は選択から外す） */
    render() {
      const ids = new Set(state.data.rooms.map((r) => r.id));
      [...chosen].forEach((id) => { if (!ids.has(id)) chosen.delete(id); });
      pop.innerHTML = `<label class="check"><input type="checkbox" value="">全室</label>` +
        state.data.rooms.map((r) => `<label class="check"><input type="checkbox" value="${esc(r.id)}">${esc(roomName(r.id))}</label>`).join('');
      show();
    },
  };
}
