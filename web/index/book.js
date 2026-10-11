// 予約表: 予約画面（新規・変更・コピー・まとめて予約）
'use strict';

function defaultStart(date) {
  const s = state.settings;
  const open = toMin(s.openTime);
  if (date !== todayStr()) return open;
  return Math.max(open, ceilTo(nowMin(), 30));
}

/**
 * @param {{mode:'create'|'edit', roomId?, date?, start?, end?, reservation?, pin?, copyFrom?}} o
 *   copyFrom: コピーのもとの予約（時間・氏名などを引き継ぎ、日と部屋を選んで予約する。元と同じ日・部屋の組み合わせは除く）
 */
function openBooking(o) {
  const s = state.settings;
  const edit = o.mode === 'edit';
  const r = o.reservation;
  const cp = !edit && o.copyFrom ? o.copyFrom : null;
  if (cp) {
    o = Object.assign({}, o, { roomId: cp.roomId, start: toMin(cp.start), end: toMin(cp.end), date: cp.date < todayStr() ? todayStr() : cp.date });
  }
  state.booking = { mode: o.mode, id: r ? r.id : null, origDate: r ? r.date : null, orig: r || null, keepLen: o.at ? o.at.end - o.at.start : null,
    // コピー: 選んだ日（日付の文字列）× 選んだ部屋。初めは元の日・元の部屋を選んだ状態（そのままでは0件）
    copy: cp ? { orig: { date: cp.date, roomId: cp.roomId }, start: o.date,
      days: new Set(cp.date >= todayStr() ? [cp.date] : []), rooms: new Set([cp.roomId]) } : null };
  $('bTitle').textContent = edit ? '予約の変更' : cp ? '予約のコピー' : '新規予約';
  $('bSubmit').textContent = edit ? '変更を保存' : '予約確定';

  const roomSel = $('bRoom');
  // 一覧で設備を絞り込んでいるときは、新規予約の部屋の選択肢も同じ設備に絞る（変更時は今の部屋を必ず含める）
  const eqFilter = state.view === 'day' ? $('equipFilter').value : '';
  roomSel.innerHTML = state.rooms.filter((x) => x.restriction !== STOPPED)
    .filter((x) => roomInFilter(x, eqFilter) || (edit && x.id === r.roomId))
    .map((x) => `<option value="${esc(x.id)}">${esc(roomText(x))}${x.restriction === ADMIN_ONLY ? '［管理者のみ］' : ''}</option>`).join('');
  const firstRoom = roomSel.options[0] ? roomSel.options[0].value : '';
  // 部屋の初期値: 指定があればその部屋、部屋別・カレンダー表示中は選んでいる部屋、一覧からは先頭の部屋
  // at: 帯を動かしたときの行き先（部屋・日・開始・終了）。最初からこの値で開く（開いてから回し直すと、
  // iPhone ではホイールが元の位置を拾い直して、時刻の一部だけが元に戻ることがあったため）
  const at = edit && o.at ? o.at : null;
  roomSel.value = at ? at.roomId : edit ? r.roomId : (o.roomId || shownRoomId() || firstRoom);
  if (!roomSel.value) roomSel.value = firstRoom;
  // 一覧の「新規予約」から開いたときは、まず部屋を選ぶことが多いので、部屋の一覧を広げて見せる。
  // 部屋を押すと、いつもの選択欄に戻る（ドラッグや空き枠から開いたとき・部屋別表示・変更時は広げない）
  const quick = !edit && !o.roomId && state.view === 'day' && roomSel.options.length > 1;
  $('bRoomQuick').innerHTML = quick ? [...roomSel.options].map((op) => {
    const rm = state.rooms.find((x) => x.id === op.value) || { name: op.textContent };
    const sub = [rm.tags, rm.restriction === ADMIN_ONLY ? '管理者のみ' : ''].filter(Boolean).join('・');
    return `<button type="button" class="rq ${rm.tags ? tagClass(rm.tags) : ''}" data-id="${esc(op.value)}" aria-label="${esc(op.textContent)}"><b>${esc(rm.name)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</button>`;
  }).join('') : '';
  $('bRoomQuickField').hidden = !quick;
  $('bRoomField').hidden = quick;

  const date = at ? at.date : edit ? r.date : (o.date || state.date);
  $('bDate').value = date;
  $('bDate').min = edit ? '' : todayStr();
  fillTimeSelects($('bStartH'), $('bStartM'));
  fillTimeSelects($('bEndH'), $('bEndM'));
  const start = at ? at.start : edit ? toMin(r.start) : (o.start != null ? o.start : defaultStart(date));
  const end = at ? at.end : edit ? toMin(r.end) : (o.end != null ? o.end : Math.min(start + 60, toMin(s.closeTime)));
  setTime($('bStartH'), $('bStartM'), start);
  setTime($('bEndH'), $('bEndM'), end);

  const profile = load_(LS.profile, {});
  const from = edit ? r : cp;
  $('bAff').value = from ? from.affiliation : (profile.affiliation || '');
  $('bPerson').value = from ? from.name : (profile.name || '');
  $('bMemo').value = from ? (from.memo || '') : '';
  $('bPin').value = edit ? (o.pin || '') : (profile.pin || '');
  // 変更時: 編集用パスワードのない予約・管理者モードでは編集用パスワード欄を出さない
  $('bPinField').hidden = edit && (!r.hasPin || isAdminMode());
  $('bPinLabel').textContent = edit ? '編集用パスワード（予約時に設定した4桁）' : '編集用パスワード（4桁の数字）';
  $('bPinReq').hidden = !edit;
  $('bPinHint').hidden = edit;
  $('bHint').hidden = edit;
  // まとめ予約（くり返し・複数部屋）の1件を変更するときは、この日以降の分もまとめて変更できる
  $('bSeriesBox').hidden = !(edit && r.groupId);
  $('bSeries').checked = false;

  // くり返し予約・複数部屋の同時予約は、管理者モードか、管理者が全員に許可しているときだけ出す
  const showBulk = !edit && (isAdminMode() || !s.bulkRequiresAdmin);
  $('bRepeatBox').hidden = !showBulk;
  $('bRepeat').checked = false;
  $('bRepeatArea').hidden = true;
  $('bInterval').value = '7';
  $('bInterval').querySelector('option[value="1"]').disabled = !!cp; // コピーは曜日を選ぶので「毎日」は使わない
  $('bCopyField').hidden = !cp;
  // コピーでは、部屋と日付の欄・「他の部屋も同時に予約」の代わりに、日と部屋のボタンで選ぶ
  $('bookDialog').querySelector('.room-date').hidden = !!cp;
  // 件数の表示は、コピーでは部屋の欄のすぐ下に、それ以外は「くり返し予約」の下に置く
  if (cp) $('bCopyField').appendChild($('bBulkSummary'));
  else $('bAdminField').before($('bBulkSummary'));
  if (cp) {
    const rm = roomById(cp.roomId);
    $('bCopySrc').textContent = `元の予約: ${mdLabel(cp.date)} ${rm ? roomText(rm) : ''} ${hm(cp.start)}〜${hm(cp.end)}`;
  }
  // 重要な予定の色: 管理者モードか、限定公開に入っているときだけ選べる（GAS でも確かめている）
  $('bColorField').hidden = !(isAdminMode() || state.limitedKey);
  setColorChoice(edit ? (r.color || '') : cp ? (cp.color || '') : '');
  $('bUntil').value = addDays(date, 7 * 14);
  $('bMultiBox').hidden = !showBulk || !!cp;
  $('bMulti').checked = false;
  $('bMultiArea').hidden = true;
  state.extraRooms = new Set();
  renderRoomPicker();
  $('bAdmin').value = '';
  $('bError').textContent = '';
  resetConflicts();
  updateBookingUi();
  $('bookDialog').showModal();
  placeUnderBtn($('bookDialog'), o.fromBtn ? $('newBtn') : null);
  // 閉じている間はホイールの位置を合わせられないので、開いてから合わせ直す
  for (const sel of $('bookDialog').querySelectorAll('.time select')) syncWheel(sel);
  renderDraft();
  // 新規予約は氏名／団体名の欄から入力できるようにする。
  // 変更時は入力欄に触れない（iPhoneでは部屋の選択肢やキーボードが勝手に開いてしまうため、見出しを選択状態にしている）
  // 名前が保存済み（自動入力された）ときは、キーボードを出さずに内容を見せる
  if (!edit && !quick && !$('bPerson').value) $('bPerson').focus();
}

const RES_COLORS = ['red', 'purple', 'green'];
function setColorChoice(c) {
  for (const b of $('bColor').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.c === c));
}
$('bColor').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-c]');
  if (b) setColorChoice(b.dataset.c);
});

/** コピー: 日のボタン（7日分。‹ › で1週間ずつ動かす。今日より前・定休日は選べない） */
function renderCopyDays() {
  const c = state.booking && state.booking.copy;
  if (!c) { $('bCopyDays').innerHTML = ''; return; }
  const today = todayStr();
  $('bCopyDays').innerHTML = Array.from({ length: 7 }, (_, i) => addDays(c.start, i)).map((d) => {
    const w = weekday(d);
    const dd = parseDate(d);
    const off = d < today || isClosedWeekday(d);
    return `<button type="button" data-d="${d}" class="${w === 0 ? 'sun' : w === 6 ? 'sat' : ''}${d === c.orig.date ? ' orig' : ''}" aria-pressed="${c.days.has(d) && !off}"${off ? ' disabled' : ''}>` +
      `${WEEKDAY_NAMES[w]}<small>${dd.getMonth() + 1}/${dd.getDate()}</small></button>`;
  }).join('');
  $('bCopyPrev').disabled = c.start <= today;
}
$('bCopyDays').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-d]');
  const c = state.booking && state.booking.copy;
  if (!b || !c) return;
  if (c.days.has(b.dataset.d)) c.days.delete(b.dataset.d); else c.days.add(b.dataset.d);
  resetConflicts();
  updateBookingUi();
});
for (const [id, step] of [['bCopyPrev', -7], ['bCopyNext', 7]]) {
  $(id).addEventListener('click', () => {
    const c = state.booking && state.booking.copy;
    if (!c) return;
    const next = addDays(c.start, step);
    c.start = next < todayStr() ? todayStr() : next;
    renderCopyDays();
  });
}

function updateBookingUi() {
  $('bDateDisplay').innerHTML = dateDisplayHtml($('bDate').value);
  renderCopyDays();
  $('bUntilDisplay').innerHTML = dateDisplayHtml($('bUntil').value);
  const s = state.settings;
  const edit = state.booking.mode === 'edit';
  // まとめて変更するときは、日付と部屋はそれぞれのままなので選べないようにする
  const series = edit && !$('bSeriesBox').hidden && $('bSeries').checked;
  $('bRoom').disabled = series;
  $('bDate').disabled = series;
  $('bDate').closest('.date-field').classList.toggle('disabled', series);
  $('bSeriesHint').hidden = !series;
  const start = getTime($('bStartH'), $('bStartM'));
  const end = getTime($('bEndH'), $('bEndM'));
  const dur = $('bDuration');
  dur.textContent = end > start ? `利用時間: ${durationLabel(end - start)}` : '終了は開始より後にしてください';
  dur.style.color = end > start ? '' : 'var(--danger)';

  const rooms = selectedRooms().map(roomById).filter(Boolean);
  const dates = bookingDates();
  const pairs = bookingPairs();
  const total = pairs.length;
  const adminOnly = rooms.some((x) => x.restriction === ADMIN_ONLY);
  const needAdmin = !edit && !isAdminMode() && (adminOnly || (total > 1 && s.bulkRequiresAdmin));
  $('bAdminField').hidden = !needAdmin;
  $('bAdminLabel').textContent = adminOnly ? '管理用パスワード（管理者のみ予約できる部屋が含まれています）' : '管理用パスワード（まとめて予約は管理者のみ）';

  // まとめて予約の件数（部屋数 × 日数）
  const el = $('bBulkSummary');
  const copy = state.booking.copy;
  el.hidden = edit || (copy ? false : total <= 1);
  if (copy) {
    // コピー: 予約する日・部屋をそのまま並べる（多いときは件数だけ）
    const name = (id) => { const rm = roomById(id); return rm ? rm.name + (state.rooms.filter((x) => x.name === rm.name).length > 1 && rm.tags ? `（${rm.tags}）` : '') : id; };
    el.textContent = !total ? '日と部屋を選んでください（元の予約と同じ組み合わせは除きます）'
      : (total <= 4 ? pairs.map((x) => `${mdLabel(x.date)} ${name(x.roomId)}`).join('・') + `　計${total}件` : `${dates.length}日 × ${rooms.length}部屋のうち 計${total}件`)
        + (total > s.maxBulkCount ? `　※最大${s.maxBulkCount}件までです` : '');
    el.style.color = !total || total > s.maxBulkCount ? 'var(--danger)' : '';
  } else if (!el.hidden) {
    const parts = [];
    if (rooms.length > 1) parts.push(`${rooms.length}部屋`);
    if (dates.length > 1) {
      const label = { 7: '毎週', 14: '隔週', 1: '毎日' }[$('bInterval').value];
      const dow = $('bInterval').value === '1' ? '' : WEEKDAY_NAMES[weekday(dates[0])] + '曜日';
      parts.push(`${label}${dow} ${dates.length}回（${mdLabel(dates[0])}〜${mdLabel(dates[dates.length - 1])}）`);
    }
    el.textContent = `${parts.join(' × ')}　計${total}件` + (total > s.maxBulkCount ? `　※最大${s.maxBulkCount}件までです` : '');
    el.style.color = total > s.maxBulkCount ? 'var(--danger)' : '';
  }
  if ($('bRepeat').checked && !edit && !repeatDates().length) {
    el.hidden = false;
    el.textContent = '最終日は開始日以降の日付を指定してください。';
    el.style.color = 'var(--danger)';
  }
  renderDraft();
}

/** スマホで1回タップした所の「仮予約」の帯（もう一度タップすると予約画面を開く） */
function renderPick() {
  const p = state.pick;
  if (!p || $('bookDialog').open || !state.geo || !state.rows) return;
  const i = state.rows.findIndex((row) => row.roomId === p.roomId && row.date === p.date);
  const track = i >= 0 && $('main').querySelector(`.tl-track[data-i="${i}"]`);
  if (!track) return;
  const { t0, total } = state.geo;
  const el = document.createElement('div');
  el.className = 'ghost pick';
  el.style.left = `${((p.start - t0) / total * 100).toFixed(4)}%`;
  el.style.width = `${((p.end - p.start) / total * 100).toFixed(4)}%`;
  el.innerHTML = '<b>＋予約</b>';
  el.title = `${hm(toHHMM(p.start))}〜${hm(toHHMM(p.end))} を予約`;
  track.appendChild(el);
}

/** 新規予約の入力中は、背景の予約表に「仮予約」の帯（選んでいる部屋・日付・時間）を出す */
function renderDraft() {
  for (const el of $('main').querySelectorAll('.ghost.draft, .ghost.pick')) el.remove();
  renderPick();
  const b = state.booking;
  if (!b || b.mode !== 'create' || !$('bookDialog').open || !state.geo || !state.rows) return;
  if (!$('bRoomQuickField').hidden) return; // 部屋をまだ選んでいないときは仮予約の帯を出さない
  const start = getTime($('bStartH'), $('bStartM'));
  const end = getTime($('bEndH'), $('bEndM'));
  if (!(end > start)) return;
  const { t0, total } = state.geo;
  const keys = new Set(bookingPairs().map((x) => x.date + '|' + x.roomId));
  const s = Math.max(start, t0), e = Math.min(end, t0 + total);
  if (e <= s) return;
  state.rows.forEach((row, i) => {
    if (!keys.has(row.date + '|' + row.roomId)) return;
    const track = $('main').querySelector(`.tl-track[data-i="${i}"]`);
    if (!track) return;
    const el = document.createElement('div');
    el.className = 'ghost draft';
    el.style.left = `${((s - t0) / total * 100).toFixed(4)}%`;
    el.style.width = `${((e - s) / total * 100).toFixed(4)}%`;
    el.textContent = `${hm(toHHMM(start))}〜${hm(toHHMM(end))}`;
    track.appendChild(el);
  });
}

/** 予約する日付（くり返しなしなら1日だけ） */
function bookingDates() {
  const c = state.booking.mode === 'create' && state.booking.copy;
  if (c) {
    // コピー: 選んだ日。くり返すときは、それぞれを最終日まで毎週（隔週）
    const firsts = [...c.days].filter((d) => d >= todayStr() && !isClosedWeekday(d)).sort();
    if (!$('bRepeat').checked) return firsts;
    const until = $('bUntil').value;
    const step = Number($('bInterval').value) === 14 ? 14 : 7;
    const out = new Set();
    for (const f of firsts) for (let d = f; until && d <= until && out.size <= 400; d = addDays(d, step)) out.add(d);
    return [...out].sort();
  }
  if (state.booking.mode === 'create' && $('bRepeat').checked) return repeatDates();
  return $('bDate').value ? [$('bDate').value] : [];
}

/** 予約する部屋（選択中の部屋 + 「他の部屋も同時に予約」で選んだ部屋、部屋マスタの順） */
function selectedRooms() {
  const main = $('bRoom').value;
  const c = state.booking.mode === 'create' && state.booking.copy;
  if (c) return state.rooms.map((r) => r.id).filter((id) => c.rooms.has(id));
  if (state.booking.mode !== 'create' || !$('bMulti').checked) return [main];
  return state.rooms.map((r) => r.id).filter((id) => id === main || state.extraRooms.has(id));
}

/** くり返し予約の対象日（毎日の場合は定休日を除く） */
function repeatDates() {
  const first = $('bDate').value;
  const until = $('bUntil').value;
  const step = Number($('bInterval').value);
  const dates = [];
  if (!first || !until) return dates;
  for (let d = first; d <= until && dates.length <= 400; d = addDays(d, step)) {
    if (step === 1 && isClosedWeekday(d)) continue;
    dates.push(d);
  }
  return dates;
}

/** 一覧の絞り込み（設備区分、または「★ お気に入り」）に当てはまる部屋か */
function roomInFilter(room, filter) {
  if (!filter || filter === FAV_EDIT) return true;
  if (filter === FAV) return getFavs().has(room.id);
  return room.equipment === filter;
}

/** 予約する日と部屋の組み合わせ（コピーでは、元の予約と同じ日・部屋を除く） */
function bookingPairs() {
  const c = state.booking.mode === 'create' && state.booking.copy;
  const out = [];
  for (const date of bookingDates()) {
    for (const roomId of selectedRooms()) {
      if (c && date === c.orig.date && roomId === c.orig.roomId) continue;
      out.push({ date, roomId });
    }
  }
  return out;
}

/**
 * 部屋を複数選ぶ欄（新規予約の部屋の一覧を小さくしたもの）。押すと選択・解除。
 * 同じ名前の部屋（練習室6の電子P.1〜5 など）は、先頭の「全◯室」でまとめて選べる。
 * lock: 選んだまま外せない部屋（他の部屋も同時に予約するときの、上で選んだ部屋）、orig: 元の予約の部屋（点を付ける）
 */
function roomGridHtml(selected, lock, orig) {
  const rooms = state.rooms.filter((r) => r.restriction !== STOPPED);
  const count = {};
  for (const r of rooms) count[r.name] = (count[r.name] || 0) + 1;
  let html = '';
  let prev = '';
  for (const r of rooms) {
    if (count[r.name] > 1 && r.name !== prev) {
      html += `<button type="button" class="rq rq-group" data-group="${esc(r.name)}"><b>${esc(r.name)}</b><small>全${count[r.name]}室</small></button>`;
    }
    prev = r.name;
    const sub = [count[r.name] > 1 ? r.tags || '' : r.tags, r.restriction === ADMIN_ONLY ? '管理者のみ' : ''].filter(Boolean).join('・');
    html += `<button type="button" class="rq ${r.tags ? tagClass(r.tags) : ''}${r.id === orig ? ' orig' : ''}" data-id="${esc(r.id)}"` +
      ` aria-pressed="${selected.has(r.id) || r.id === lock}"${r.id === lock ? ' disabled' : ''} aria-label="${esc(roomText(r))}">` +
      `<b>${esc(r.name)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</button>`;
  }
  return html;
}
function renderRoomPicker() {
  const c = state.booking && state.booking.copy;
  if (c) $('bCopyRooms').innerHTML = roomGridHtml(c.rooms, '', c.orig.roomId);
  else $('bRoomPicker').innerHTML = roomGridHtml(state.extraRooms, $('bRoom').value, '');
}
/** 部屋のボタンを押したとき（1部屋 or 同じ名前の全部屋を切り替える） */
function onRoomGridClick(e, set, lock) {
  const b = e.target.closest('button[data-id], button[data-group]');
  if (!b || b.disabled) return;
  const ids = b.dataset.group
    ? state.rooms.filter((r) => r.name === b.dataset.group && r.restriction !== STOPPED && r.id !== lock).map((r) => r.id)
    : [b.dataset.id];
  const allOn = ids.every((id) => set.has(id));
  ids.forEach((id) => (allOn ? set.delete(id) : set.add(id)));
  renderRoomPicker();
  resetConflicts();
  updateBookingUi();
}
$('bMulti').addEventListener('change', (e) => { $('bMultiArea').hidden = !e.target.checked; resetConflicts(); updateBookingUi(); });
$('bRoomPicker').addEventListener('click', (e) => onRoomGridClick(e, state.extraRooms, $('bRoom').value));
$('bCopyRooms').addEventListener('click', (e) => { if (state.booking && state.booking.copy) onRoomGridClick(e, state.booking.copy.rooms, ''); });

function resetConflicts() {
  state.skipConflicts = false;
  $('bConflicts').innerHTML = '';
  if (state.booking) $('bSubmit').textContent = state.booking.mode === 'edit' ? '変更を保存' : '予約確定';
  $('bSubmit').disabled = false;
}

async function submitBooking(e) {
  e.preventDefault();
  const s = state.settings;
  const edit = state.booking.mode === 'edit';
  const err = $('bError');
  const fail = (msg, focusId) => { err.textContent = msg; if (focusId) ($(focusId).wheel || $(focusId)).focus(); };
  if (!$('bRoomQuickField').hidden) return fail('部屋を選んでください。');
  const payload = {
    roomId: $('bRoom').value,
    date: $('bDate').value,
    start: toHHMM(getTime($('bStartH'), $('bStartM'))),
    end: toHHMM(getTime($('bEndH'), $('bEndM'))),
    affiliation: $('bAff').value.trim(),
    name: $('bPerson').value.trim(),
    memo: $('bMemo').value.trim(),
    pin: $('bPin').value.trim(),
  };
  // 帯を動かして開いた変更画面で、時刻の欄に触れていなければ、利用時間は必ず元の長さにする（念のため）
  const keep = state.booking.keepLen;
  if (keep && !state.booking.timeTouched && toMin(payload.end) - toMin(payload.start) !== keep) {
    payload.end = toHHMM(toMin(payload.start) + keep);
  }
  if (!$('bColorField').hidden) {
    const on = $('bColor').querySelector('button[aria-pressed="true"]');
    payload.color = on ? on.dataset.c : '';
  }
  if (!payload.date) return fail('日付を指定してください。', 'bDate');
  if (toMin(payload.end) <= toMin(payload.start)) return fail('終了は開始より後にしてください。', 'bEndH');
  if (!payload.name) return fail('氏名／団体名を入力してください。', 'bPerson');
  if (!edit && payload.pin && !/^\d{4}$/.test(payload.pin)) return fail('編集用パスワードは4桁の数字で入力してください（設定しない場合は空欄）。', 'bPin');
  if (edit && !$('bPinField').hidden && !payload.pin) return fail('編集用パスワードを入力してください。', 'bPin');

  if (!$('bAdminField').hidden) {
    if (!$('bAdmin').value) return fail('管理用パスワードを入力してください。', 'bAdmin');
    payload.adminPassword = $('bAdmin').value;
  }
  const roomIds = selectedRooms();
  const dates = bookingDates();
  const pairs = bookingPairs();
  if (state.booking.copy) {
    if (!pairs.length) return fail('コピー先の日と部屋を選んでください（元の予約と同じ組み合わせは除きます）。');
    payload.date = pairs[0].date;
    payload.roomId = pairs[0].roomId;
  }
  const total = pairs.length;
  const bulk = !edit && total > 1;
  if (!edit && $('bRepeat').checked && !dates.length) return fail('最終日を正しく指定してください。', 'bUntil');
  if (bulk && total > s.maxBulkCount) return fail(`まとめて予約は最大${s.maxBulkCount}件までです（今回${total}件）。部屋か期間を減らしてください。`);
  if (!edit) save_(LS.profile, { affiliation: payload.affiliation, name: payload.name, pin: payload.pin }); // 予約確定時にこの端末へ保存

  // 1件の変更（まとめて変更でないもの）も、サーバーの結果を待たずに画面へ反映する（失敗したら元に戻す）
  const seriesEdit = edit && !$('bSeriesBox').hidden && $('bSeries').checked;
  if (edit && !seriesEdit && state.booking.orig) {
    if (state.data && payload.date >= state.data.from && payload.date <= state.data.to) {
      const clash = visibleReservations().find((r) => r.id !== state.booking.id && r.date === payload.date && r.roomId === payload.roomId &&
        toMin(r.start) < toMin(payload.end) && toMin(payload.start) < toMin(r.end));
      if (clash) return fail(`すでに存在する予約と時間が重複しています（${hm(clash.start)}〜${hm(clash.end)} ${clash.name}）。`);
    }
    updateOptimistic(payload, state.booking.orig);
    return;
  }
  // 1件の新規予約は、サーバーの結果を待たずに画面へ反映する（失敗したら元に戻す）
  if (!edit && !bulk) {
    if (state.data && payload.date >= state.data.from && payload.date <= state.data.to) {
      const clash = visibleReservations().find((r) => r.date === payload.date && r.roomId === payload.roomId &&
        toMin(r.start) < toMin(payload.end) && toMin(payload.start) < toMin(r.end));
      if (clash) return fail(`すでに存在する予約と時間が重複しています（${hm(clash.start)}〜${hm(clash.end)} ${clash.name}）。`);
      // 休館・定休日と重なる時間は、画面に反映せずにその場で知らせる
      const closed = closuresFor(payload.date, payload.roomId)
        .find((c) => c.start < toMin(payload.end) && toMin(payload.start) < c.end);
      if (closed) return fail(`${hm(toHHMM(closed.start))}〜${hm(toHHMM(closed.end))} は利用できません（${closed.reason}）。`);
    }
    createOptimistic(payload);
    return;
  }

  const btn = $('bSubmit');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '送信中…';
  err.textContent = '';
  try {
    let res;
    const series = edit && !$('bSeriesBox').hidden && $('bSeries').checked;
    if (edit) res = await api('updateReservation', Object.assign(payload, { id: state.booking.id }, series ? { scope: 'following' } : {}));
    else if (bulk) res = await api('createBulkReservations', Object.assign(payload, { roomIds, dates, skipConflicts: state.skipConflicts }, state.booking.copy ? { pairs } : {}));
    else res = await api('createReservation', payload);

    if (res && res.ok) {
      const list = res.reservations || [res.reservation];
      if (!edit) addMine(list);
      $('bookDialog').close();
      const skipped = res.skipped && res.skipped.length ? `（予約できなかった${res.skipped.length}件を除く）` : '';
      toast(edit ? (list.length > 1 ? `${list.length}件の予約をまとめて変更しました` : '予約を変更しました') : `${list.length}件予約しました${skipped}`);
      invalidate(list.length > 1 ? undefined : list.map((r) => r.date).concat(edit ? [state.booking.origDate] : []));
      if (!edit && list[0].date !== state.date && state.view === 'day') setDate(list[0].date);
      else load({ force: true });
      return;
    }
    if (res && res.code === 'PARTIAL_CONFLICT') {
      err.textContent = `${total}件中${res.conflicts.length}件は予約できません。`;
      $('bConflicts').innerHTML = res.conflicts.map((c) =>
        `<li>${esc(mdLabel(c.date))} ${roomIds.length > 1 ? esc(roomText(roomById(c.roomId))) + ' ' : ''}${esc(c.reason)}</li>`).join('');
      state.skipConflicts = true;
      btn.textContent = `予約できる${res.availableCount}件だけ予約`;
      btn.disabled = res.availableCount === 0;
      return;
    }
    err.textContent = (res && res.message) || '処理に失敗しました。';
    if (res && res.code === 'SERIES_CONFLICT') $('bConflicts').innerHTML = res.conflicts.map((c) => `<li>${esc(c)}</li>`).join('');
    if (res && res.code === 'CONFLICT') { invalidate([payload.date]); load({ force: true }); }
    btn.textContent = label;
  } catch (ex) {
    if (!(ex instanceof AuthError)) err.textContent = errMessage(ex);
    btn.textContent = label;
  }
  btn.disabled = false;
}

for (const id of ['bRoom', 'bDate', 'bStartH', 'bStartM', 'bEndH', 'bEndM', 'bInterval', 'bUntil']) {
  $(id).addEventListener('change', () => { resetConflicts(); updateBookingUi(); });
}
$('bRepeat').addEventListener('change', (e) => { $('bRepeatArea').hidden = !e.target.checked; resetConflicts(); updateBookingUi(); });
$('bPin').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
});
