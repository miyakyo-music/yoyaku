// 管理画面（admin.html）の動き。HTML の最後で config.js・api.js のあとに読み込む
(() => {
  'use strict';

  const SESSION_KEY = 'prr.adminPw';
  // 管理画面を開いた印。予約表に戻ったとき、前回の表を使わずに最新を読み込ませる（部屋・設定の変更をすぐ反映するため）
  try { sessionStorage.setItem('prr.fromAdmin', '1'); } catch (e) { /* 保存できない環境では何もしない */ }
  const WEEKDAYS = '日月火水木金土';
  const RESTRICTIONS = [['', '制限なし'], ['管理者のみ', '管理者のみ'], ['限定公開', '限定公開'], ['使用停止', '使用停止']];
  const $ = (id) => document.getElementById(id);
  const state = {
    pw: sessionGet(),
    data: null,
    rooms: [],       // 編集中の部屋一覧
    closures: [],
    dirty: { rooms: false, settings: false },
  };

  // ---------------- 汎用 ----------------
  function sessionGet() { try { return sessionStorage.getItem(SESSION_KEY) || ''; } catch (e) { return ''; } }
  function sessionSet(v) { try { if (v) sessionStorage.setItem(SESSION_KEY, v); else sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* 保存できない環境では毎回ログイン */ } }
  function pad(n) { return String(n).padStart(2, '0'); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function toMin(t) { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; }
  function toHHMM(min) { return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`; }
  function hm(t) { return String(t).replace(/^0(\d)/, '$1'); }
  function dateLabel(s) {
    const [y, m, d] = s.split('-').map(Number);
    const w = new Date(y, m - 1, d).getDay();
    return { text: `${y}/${m}/${d}(${WEEKDAYS[w]})`, cls: w === 6 ? 'sat' : w === 0 ? 'sun' : '' };
  }
  let toastTimer;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
  }

  async function api(fn, payload) {
    const res = await callApi(fn, Object.assign({ adminPassword: state.pw }, payload)); // web/api.js
    if (res && res.code === 'ADMIN_AUTH') { logout(res.message); throw new Error(res.message); }
    return res;
  }
  function errMessage(e) { return (e && e.message) || String(e) || '通信に失敗しました。'; }

  function timeSelects(hSel, mSel, maxHour) {
    hSel.innerHTML = '';
    for (let h = 0; h <= maxHour; h++) hSel.add(new Option(String(h), String(h)));
    mSel.innerHTML = '';
    for (let m = 0; m < 60; m += 5) mSel.add(new Option(pad(m), String(m)));
  }
  function setTime(hSel, mSel, t) { const m = toMin(t); hSel.value = String(Math.floor(m / 60)); mSel.value = String(m % 60); }
  function getTime(hSel, mSel) { return toHHMM(Number(hSel.value) * 60 + Number(mSel.value)); }

  // ---------------- ログイン ----------------
  async function login(pw) {
    state.pw = pw;
    $('loginBtn').disabled = true;
    $('loginError').textContent = '';
    try {
      const res = await api('adminGetData', {});
      if (!res.ok) throw new Error(res.message);
      sessionSet(pw);
      state.data = res;
      showAdmin();
    } catch (e) {
      $('loginError').textContent = errMessage(e);
      state.pw = '';
    } finally {
      $('loginBtn').disabled = false;
    }
  }

  function logout(message) {
    state.pw = '';
    sessionSet('');
    $('adminView').hidden = true;
    $('logoutBtn').hidden = true;
    $('sheetLink').hidden = true;
    $('loginView').hidden = false;
    $('loginError').textContent = message || '';
    $('loginPw').value = '';
    hideSecrets(document);
  }

  function showAdmin() {
    const d = state.data;
    $('loginView').hidden = true;
    $('adminView').hidden = false;
    $('logoutBtn').hidden = false;
    $('appName').textContent = d.settings.title;
    if (d.spreadsheetUrl) { $('sheetLink').href = d.spreadsheetUrl; $('sheetLink').hidden = false; }
    setBugBadge(d.openBugs);
    document.title = d.settings.title + '（管理画面）';
    state.rooms = d.rooms.map((r) => ({ ...r }));
    state.closures = d.closures.slice();
    renderRooms();
    fillSettings(d.settings);
    renderClosureForm();
    renderExportForm();
    renderClosures();
    setDirty('rooms', false);
    setDirty('settings', false);
  }

  // 「未保存の変更があります」は、保存した時点の内容と今の内容を比べて出す（変えて元に戻したら消える）
  const savedSnap = { rooms: '', settings: '' };
  function snapshot(key) {
    if (key === 'rooms') return JSON.stringify(state.rooms.map((r) => Object.keys(r).sort().map((k) => [k, String(r[k] ?? '')])));
    return JSON.stringify([...$('settingsForm').elements].map((el) => (el.type === 'checkbox' ? el.checked : el.value)));
  }
  function checkDirty(key) {
    setDirty(key, snapshot(key) !== savedSnap[key]);
  }
  function setDirty(key, value) {
    if (!value) savedSnap[key] = snapshot(key);
    state.dirty[key] = value;
    $('dotSetup').hidden = !(state.dirty.rooms || state.dirty.settings); // 一般も練習室も「設定」タブにある
    $(key + 'Dirty').hidden = !value;
  }

  // ---------------- 練習室 ----------------
  // パスワード欄すべてに「表示」ボタンを付ける（web/api.js。演習室など・予約表全体のパスワードは専用のボタンがある）
  addRevealButtons(document);


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

  // ---------------- 利用時間・制限 ----------------
  function fillSettings(s) {
    $('sTitle').value = s.title;
    $('sNotice').value = s.notice || '';
    $('sNoticeLevel').value = s.noticeLevel === '重要' ? '重要' : '通常';
    timeSelects($('sOpenH'), $('sOpenM'), 23);
    timeSelects($('sCloseH'), $('sCloseM'), 24);
    setTime($('sOpenH'), $('sOpenM'), s.openTime);
    setTime($('sCloseH'), $('sCloseM'), s.closeTime);
    $('sUnit').innerHTML = state.data.unitOptions.map((u) => `<option value="${u}">${u}</option>`).join('');
    $('sUnit').value = String(s.unitMinutes);
    $('sMaxDur').value = s.maxDurationMinutes;
    $('sMaxDays').value = s.maxDaysAhead;
    $('sMaxBulk').value = s.maxBulkCount;
    $('sWeekdays').innerHTML = [...WEEKDAYS].map((w, i) =>
      `<label class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}"><input type="checkbox" value="${i}"${s.closedWeekdays.includes(i) ? ' checked' : ''}>${w}</label>`).join('');
    $('sBulkAdmin').checked = !!s.bulkRequiresAdmin;
    fillPasswords(s);
    $('settingsError').textContent = '';
    $('settingsWarn').textContent = '';
  }
  $('settingsForm').addEventListener('input', () => checkDirty('settings'));
  $('settingsForm').addEventListener('change', () => checkDirty('settings'));
  $('settingsForm').addEventListener('submit', (e) => e.preventDefault());
  $('saveSettingsBtn').addEventListener('click', async () => {
    const err = $('settingsError');
    err.textContent = '';
    $('settingsWarn').textContent = '';
    const settings = {
      title: $('sTitle').value,
      notice: $('sNotice').value,
      noticeLevel: $('sNoticeLevel').value,
      openTime: getTime($('sOpenH'), $('sOpenM')),
      closeTime: getTime($('sCloseH'), $('sCloseM')),
      unitMinutes: Number($('sUnit').value),
      maxDurationMinutes: Number($('sMaxDur').value || 0),
      maxDaysAhead: Number($('sMaxDays').value || 0),
      maxBulkCount: Number($('sMaxBulk').value || 0),
      closedWeekdays: [...$('sWeekdays').querySelectorAll('input:checked')].map((c) => Number(c.value)),
      bulkRequiresAdmin: $('sBulkAdmin').checked,
      // パスワード類は「パスワード」タブで保存する。ここでは保存済みの値をそのまま送る
      viewPassword: state.data.settings.viewPassword || '',
      limitedPassword: state.data.settings.limitedPassword || '',
    };
    if (toMin(settings.closeTime) <= toMin(settings.openTime)) { err.textContent = '利用終了時刻は利用開始時刻より後にしてください。'; return; }
    const btn = $('saveSettingsBtn');
    btn.disabled = true;
    try {
      const res = await api('adminSaveSettings', { settings });
      if (!res.ok) throw new Error(res.message);
      state.data.settings = res.settings;
      $('appName').textContent = res.settings.title;
      fillSettings(res.settings);
      renderClosureForm();
      renderExportForm();
      setDirty('settings', false);
      $('settingsWarn').textContent = (res.warnings || []).join('\n');
      toast('設定を保存しました');
    } catch (ex) {
      err.textContent = errMessage(ex);
    } finally {
      btn.disabled = false;
    }
  });

  // ---------------- 休館・利用停止 ----------------
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
    const w = new Date(y, m - 1, d).getDay();
    display.innerHTML = `${y}/${pad(m)}/${pad(d)}<span class="${w === 6 ? 'sat' : w === 0 ? 'sun' : ''}">(${WEEKDAYS[w]})</span>`;
  }
  function dateField(id) {
    const show = () => showDate($(id), $(id + 'Display'));
    $(id).addEventListener('input', show);
    $(id).addEventListener('change', show);
    return show;
  }
  const showClosureDate = dateField('cDate');

  /**
   * 部屋を複数選べる欄（何も選ばなければ全室）。選択欄と同じ見た目のボタンを押すと、部屋のチェックの一覧が下に開く。
   * 休館の「対象」と、予約の一覧の「部屋」で使う
   */
  function roomPicker(prefix) {
    const pick = $(prefix + 'Pick'), btn = $(prefix + 'Btn'), pop = $(prefix + 'Pop');
    const chosen = new Set();
    function show() {
      pop.querySelectorAll('input').forEach((c) => { c.checked = c.value ? chosen.has(c.value) : !chosen.size; });
      const names = state.data.rooms.filter((r) => chosen.has(r.id)).map((r) => roomName(r.id));
      btn.textContent = !names.length ? '全室' : names.length === 1 ? names[0] : `${names[0].replace(/（.*$/, '')} ほか${names.length - 1}室`;
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
  // 休館の対象: 追加すると部屋ごとに1件ずつ登録する
  const closurePick = roomPicker('cRoom');
  function renderClosureForm() {
    const s = state.data.settings;
    closurePick.render();
    if (!$('cDate').value) $('cDate').value = state.data.today;
    showClosureDate();
    timeSelects($('cStartH'), $('cStartM'), 24);
    timeSelects($('cEndH'), $('cEndM'), 24);
    setTime($('cStartH'), $('cStartM'), s.openTime);
    setTime($('cEndH'), $('cEndM'), s.closeTime);
  }

  function renderClosures() {
    const today = state.data.today;
    const showPast = $('showPast').checked;
    const list = state.closures
      .map((c, i) => ({ ...c, i }))
      .filter((c) => showPast || c.date >= today)
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    $('closureList').innerHTML = list.length ? list.map((c) => {
      const d = dateLabel(c.date);
      return `<tr class="${c.date < today ? 'past' : ''}">
        <td class="${d.cls}">${esc(d.text)}</td>
        <td>${esc(roomName(c.roomId))}</td>
        <td>${c.allDay ? '終日' : esc(hm(c.start)) + '〜' + esc(hm(c.end))}</td>
        <td class="reason">${esc(c.reason)}</td>
        <td><button type="button" class="btn small danger-text" data-del="${c.i}">削除</button></td>
      </tr>`;
    }).join('') : `<tr><td colspan="5" class="empty">${showPast ? '登録はありません。' : '今日以降の登録はありません。'}</td></tr>`;
  }

  async function saveClosures(next, message) {
    $('closureError').textContent = '';
    $('closureWarn').textContent = '';
    const res = await api('adminSaveClosures', { closures: next });
    if (!res.ok) throw new Error(res.message);
    state.closures = res.closures;
    state.data.closures = res.closures;
    renderClosures();
    $('closureWarn').textContent = (res.warnings || []).join('\n');
    toast(message);
  }

  $('cAllDay').addEventListener('change', (e) => { $('cTimeField').hidden = e.target.checked; });
  $('showPast').addEventListener('change', renderClosures);
  $('closureForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const item = {
      date: $('cDate').value,
      allDay: $('cAllDay').checked,
      start: getTime($('cStartH'), $('cStartM')),
      end: getTime($('cEndH'), $('cEndM')),
      reason: $('cReason').value.trim(),
    };
    if (!item.date) { $('closureError').textContent = '日付を指定してください。'; return; }
    if (!item.allDay && toMin(item.end) <= toMin(item.start)) { $('closureError').textContent = '終了は開始より後にしてください。'; return; }
    const btn = $('addClosureBtn');
    btn.disabled = true;
    try {
      const picked = closurePick.ids();
      const ids = picked.length ? picked : [''];
      closurePick.close();
      await saveClosures(state.closures.concat(ids.map((roomId) => ({ ...item, roomId }))), ids.length > 1 ? `${ids.length}室に追加しました` : '追加しました');
      $('cReason').value = '';
    } catch (ex) {
      $('closureError').textContent = errMessage(ex);
    } finally {
      btn.disabled = false;
    }
  });
  $('closureList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    const c = state.closures[Number(b.dataset.del)];
    if (!confirm(`${dateLabel(c.date).text} ${roomName(c.roomId)}「${c.reason || '利用停止'}」を削除しますか？`)) return;
    b.disabled = true;
    try {
      await saveClosures(state.closures.filter((_, i) => i !== Number(b.dataset.del)), '削除しました');
    } catch (ex) {
      $('closureError').textContent = errMessage(ex);
      b.disabled = false;
    }
  });

  // ---------------- パスワード ----------------
  function fillPasswords(s) {
    for (const [id, v] of [['sLimitedPw', s.limitedPassword], ['sViewPw', s.viewPassword]]) {
      $(id).value = v || '';
      reveal(id, false); // 開いたときは伏せ字に戻す
    }
    $('limitedUrl').value = new URL('./?limited', location.href).href;
    $('viewPwBox').open = !!s.viewPassword; // 設定されているときだけ最初から開いておく
    $('limitedError').textContent = '';
    $('viewPwError').textContent = '';
  }
  /** パスワード欄の表示・伏せ字を切り替える */
  function reveal(id, show) {
    $(id).type = show ? 'text' : 'password';
    document.querySelector(`[data-reveal="${id}"]`).textContent = show ? '隠す' : '表示';
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-reveal]');
    if (b) reveal(b.dataset.reveal, $(b.dataset.reveal).type === 'password');
  });
  $('limitedUrl').addEventListener('focus', (e) => e.target.select());
  $('copyLimitedUrl').addEventListener('click', async () => {
    const input = $('limitedUrl');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch (e) {
      input.select(); // クリップボードを使えない環境では選択だけして、手動でコピーしてもらう
      document.execCommand && document.execCommand('copy');
    }
    toast('入口の URL をコピーしました');
  });
  /** 保存済みの設定のうち、指定したパスワードだけを差し替えて保存する（「利用時間・制限」の未保存の変更は含めない） */
  async function savePassword(key, inputId, btnId, errId, message) {
    const err = $(errId);
    err.textContent = '';
    const settings = Object.assign({}, state.data.settings, { [key]: $(inputId).value });
    $(btnId).disabled = true;
    try {
      const res = await api('adminSaveSettings', { settings });
      if (!res.ok) throw new Error(res.message);
      state.data.settings = res.settings;
      fillPasswords(res.settings);
      toast(message);
    } catch (ex) {
      err.textContent = errMessage(ex);
    } finally {
      $(btnId).disabled = false;
    }
  }
  $('limitedForm').addEventListener('submit', (e) => {
    e.preventDefault();
    savePassword('limitedPassword', 'sLimitedPw', 'limitedBtn', 'limitedError', '演習室などのパスワードを保存しました');
  });
  $('viewPwForm').addEventListener('submit', (e) => {
    e.preventDefault();
    savePassword('viewPassword', 'sViewPw', 'viewPwBtn', 'viewPwError', '予約表全体のパスワードを保存しました');
  });
  $('pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('pwError');
    err.textContent = '';
    const pw = $('pwNew').value;
    if (pw.length < 6) { err.textContent = '6文字以上にしてください。'; return; }
    if (pw !== $('pwNew2').value) { err.textContent = '確認用のパスワードが一致しません。'; return; }
    $('pwBtn').disabled = true;
    try {
      const res = await api('adminChangePassword', { newPassword: pw });
      if (!res.ok) throw new Error(res.message);
      state.pw = pw;
      sessionSet(pw);
      $('pwNew').value = $('pwNew2').value = '';
      toast('管理用パスワードを変更しました');
    } catch (ex) {
      err.textContent = errMessage(ex);
    } finally {
      $('pwBtn').disabled = false;
    }
  });

  // ---------------- タブ・共通 ----------------
  for (const t of document.querySelectorAll('.tabs [data-tab]')) {
    t.addEventListener('click', () => {
      for (const x of document.querySelectorAll('.tabs [data-tab]')) x.setAttribute('aria-selected', String(x === t));
      for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== t.dataset.tab || p.dataset.unsupported === '1';
      placeTabThumb();
      if (t.dataset.tab === 'bugs') loadBugs();
      if (t.dataset.tab === 'setup') pkRefresh();
      if (t.dataset.tab === 'stats') loadStats();
    });
  }
  // タブの白いつまみを、選択中のタブの位置・幅に合わせる（最初に置くときだけは滑らせない）
  function placeTabThumb() {
    const tabs = document.querySelector('.tabs');
    const on = tabs.querySelector('[aria-selected="true"]');
    if (!on || !on.offsetWidth) return; // 管理画面が非表示（ログイン前）のときは測れない
    tabs.classList.toggle('no-anim', !tabs.classList.contains('has-thumb'));
    tabs.style.setProperty('--thumb-x', `${on.offsetLeft}px`);
    tabs.style.setProperty('--thumb-w', `${on.offsetWidth}px`);
    tabs.classList.add('has-thumb');
  }
  if (window.ResizeObserver) new ResizeObserver(placeTabThumb).observe(document.querySelector('.tabs'));
  window.addEventListener('resize', placeTabThumb);

  // ---------------- i ボタン（説明の吹き出し） ----------------
  // マウスのある端末: macOS の説明（ヘルプタグ）のように、ボタンの上にしばらく止めると、マウスの右下に小さく出る。
  //   ボタンから外れるとすぐ消える。
  // 指の端末: 押すと出て、もう一度押すか、ほかを押すと消える。
  let tipFor = null, tipTimer = 0;
  const tipPop = document.createElement('div');
  tipPop.className = 'tip-pop';
  tipPop.setAttribute('role', 'tooltip');
  tipPop.hidden = true;
  document.body.appendChild(tipPop);
  function showTip(b, x, y) {
    tipFor = b; b.setAttribute('aria-expanded', 'true');
    tipPop.textContent = b.dataset.tip; tipPop.hidden = false;
    const w = tipPop.offsetWidth, h = tipPop.offsetHeight;
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    let left = x + 10, top = y + 18;           // マウスの右下
    if (left + w > vw - 8) left = Math.max(8, vw - w - 8);
    if (top + h > vh - 8) top = y - h - 10;    // 下に入らなければ上に
    tipPop.style.left = `${window.scrollX + left}px`;
    tipPop.style.top = `${window.scrollY + top}px`;
  }
  function closeTip() { clearTimeout(tipTimer); if (tipFor) tipFor.setAttribute('aria-expanded', 'false'); tipFor = null; tipPop.hidden = true; }
  const canHover = window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (canHover) {
    document.addEventListener('mouseover', (e) => {
      const b = e.target.closest && e.target.closest('.info');
      if (!b || b === tipFor) return;
      closeTip();
      const { clientX: x, clientY: y } = e;
      tipTimer = setTimeout(() => showTip(b, x, y), 500);
    });
    document.addEventListener('mouseout', (e) => {
      const b = e.target.closest && e.target.closest('.info');
      if (b && !b.contains(e.relatedTarget)) closeTip();
    });
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.info');
    if (!b) { closeTip(); return; }
    e.preventDefault(); e.stopPropagation(); // ラベルや details の開け閉めを起こさない
    if (canHover) return; // マウスでは、止めておくだけで出る
    if (tipFor === b) { closeTip(); return; }
    closeTip();
    const r = b.getBoundingClientRect();
    showTip(b, r.left, r.bottom - 10);
  }, true);
  window.addEventListener('scroll', closeTip, { passive: true });
  window.addEventListener('resize', closeTip);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTip(); });

  // ---------------- 利用状況 ----------------
  // 予約表と同じ getSchedule（管理者なので限定公開の部屋も含む）で期間の予約を読み、ここで集計する。
  // GAS は一度に42日分までしか返さないので、期間を区切って3つずつ並べて読む。個人ごとの集計は作らない。
  const WD = '日月火水木金土';
  let statsPeriod = 'month';
  const statsCache = {};
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
    const range = statsRange(statsPeriod);
    $('statsRange').textContent = `${range.label}: ${range.from.replace(/-/g, '/')} 〜 ${range.to.replace(/-/g, '/')}`;
    const msg = $('statsMsg');
    if (!statsCache[statsPeriod]) {
      msg.hidden = false; msg.className = 'msg'; msg.textContent = '集計しています…（今年度は少し時間がかかります）';
      $('statsBody').hidden = true;
      try {
        statsCache[statsPeriod] = await fetchReservations(range.from, range.to);
      } catch (e) {
        msg.className = 'msg error'; msg.textContent = errMessage(e);
        return;
      }
    }
    msg.hidden = true;
    renderStats(range, statsCache[statsPeriod]);
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
    $('stRooms').innerHTML = roomRows.map((x) => {
      const r = openMin ? (x.min / openMin) * 100 : 0;
      const pct = r && r < 10 ? r.toFixed(1) : Math.round(r); // 小さい割合は小数1けたまで
      // 棒の長さは右の％と同じ（利用時間のうち埋まっていた割合。0〜100％）
      return `<div class="bar"><span class="bn">${esc(x.name)}</span><span class="bt"><i style="width:${Math.min(100, r)}%"></i></span><span class="bv">${hoursText(x.min)}・${pct}%</span></div>`;
    }).join('');
    const byEq = new Map();
    const eqOf = new Map(rooms.map((r) => [r.id, r.equipment || 'その他']));
    for (const r of list) { const e = eqOf.get(r.roomId) || 'その他'; byEq.set(e, (byEq.get(e) || 0) + toMin(r.end) - toMin(r.start)); }
    const eqRows = [...byEq.entries()].sort((a, b) => b[1] - a[1]);
    $('stEquip').innerHTML = eqRows.length ? eqRows.map(([name, min]) =>
      `<div class="bar"><span class="bn">${esc(name)}</span><span class="bt"><i style="width:${total ? (min / total) * 100 : 0}%"></i></span><span class="bv">${hoursText(min)}・${total ? Math.round((min / total) * 100) : 0}%</span></div>`).join('')
      : '<p class="help">この期間の予約はありません。</p>';
  }
  for (const b of document.querySelectorAll('[data-period]')) {
    b.addEventListener('click', () => {
      statsPeriod = b.dataset.period;
      for (const x of document.querySelectorAll('[data-period]')) x.setAttribute('aria-pressed', String(x === b));
      loadStats();
    });
  }

  // ---------------- 予約の一覧（印刷・エクスポート） ----------------
  // 期間・部屋を選び、利用状況と同じ getSchedule（管理者なので限定公開の部屋も含む）で読んで、印刷するか、
  // CSV・Excel（.xlsx）・PDF のファイルにする。ファイルづくりは外部の部品を使わず、この画面の中で行う
  const EXPORT_MAX_DAYS = 731; // 一度に書き出せる期間（2年）
  const EXPORT_HEAD = ['日付', '曜日', '開始', '終了', '部屋', '学籍番号/所属', '氏名・団体名', '備考'];
  const exportPick = roomPicker('xRoom');
  const showExportFrom = dateField('xFrom');
  const showExportTo = dateField('xTo');
  function renderExportForm() {
    exportPick.render();
    const t = state.data.today;
    if (!$('xFrom').value) $('xFrom').value = t.slice(0, 8) + '01'; // 今月の1日から
    if (!$('xTo').value) { const [y, m] = t.split('-').map(Number); $('xTo').value = ymd(new Date(y, m, 0)); } // 今月の末日まで
    showExportFrom();
    showExportTo();
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
    const list = (await fetchReservations(from, to)).filter((r) => !want || want.has(r.roomId));
    list.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start) || (order.get(a.roomId) ?? 999) - (order.get(b.roomId) ?? 999));
    const now = new Date();
    return {
      from, to, ids, list,
      rooms: ids.length ? ids.map(roomName).join('、') : '全室',
      stamp: `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
    };
  }
  function wdOf(d) { const [y, m, dd] = d.split('-').map(Number); return WD[new Date(y, m - 1, dd).getDay()]; }
  const slash = (d) => d.replace(/-/g, '/');
  /** 表の1行（CSV・Excel の列の順） */
  const exportCells = (r) => [slash(r.date), wdOf(r.date), r.start, r.end, roomName(r.roomId), r.affiliation, r.name, r.memo];

  /** 押している間は、印刷・エクスポートのボタンを止めて「読み込み中…」にする */
  async function withExport(btn, fn) {
    const err = $('exportError');
    err.textContent = '';
    exportPick.close();
    toggleFmt(false);
    const label = btn.textContent;
    $('xShowBtn').disabled = $('xPrintBtn').disabled = $('xFmtBtn').disabled = true;
    btn.textContent = '読み込み中…';
    try {
      await fn(await exportRows());
    } catch (e) {
      err.textContent = errMessage(e);
    } finally {
      btn.textContent = label;
      $('xShowBtn').disabled = $('xPrintBtn').disabled = $('xFmtBtn').disabled = false;
    }
  }
  function saveFile(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // エクスポートの形式の一覧（ボタンの下に開く）
  function toggleFmt(open) {
    $('xFmtPop').hidden = !open;
    $('xFmtBtn').setAttribute('aria-expanded', String(open));
  }
  $('xFmtBtn').addEventListener('click', () => toggleFmt($('xFmtPop').hidden));
  document.addEventListener('pointerdown', (e) => { if (!$('xFmtPop').hidden && !$('xFmtPick').contains(e.target)) toggleFmt(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('xFmtPop').hidden) { toggleFmt(false); $('xFmtBtn').focus(); } });
  const EXPORTERS = { csv: exportCsv, xlsx: exportXlsx, pdf: exportPdf };
  $('xFmtPop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fmt]');
    if (!b) return;
    withExport($('xFmtBtn'), async (data) => {
      if (!data.list.length) throw new Error('この期間・部屋の予約はありません。');
      const name = await EXPORTERS[b.dataset.fmt](data);
      toast(`${data.list.length}件を ${name} に書き出しました`);
    });
  });

  // CSV: Excel で文字化けしないよう、先頭に BOM を付けた UTF-8。数式として読まれる先頭文字（= + - @）には ' を付ける
  function csvCell(v) {
    let t = String(v == null ? '' : v);
    if (/^[=+\-@]/.test(t)) t = "'" + t;
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  }
  function exportCsv({ from, to, list }) {
    const text = '﻿' + [EXPORT_HEAD].concat(list.map(exportCells)).map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    saveFile(new Blob([text], { type: 'text/csv;charset=utf-8' }), `予約一覧_${from}_${to}.csv`);
    return 'CSV';
  }

  // Excel（.xlsx）: 中身は XML のファイルをまとめた ZIP。文字はすべて文字列のまま入れる（日付・時刻が勝手に変わらないように）
  function exportXlsx({ from, to, list, rooms, stamp }) {
    const x = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''); // XML に入れられない文字は除く
    const col = (i) => String.fromCharCode(65 + i);
    const cell = (v, ref, s) => `<c r="${ref}" t="inlineStr"${s ? ` s="${s}"` : ''}><is><t xml:space="preserve">${x(v)}</t></is></c>`;
    const rows = [
      `<row r="1">${cell(`${state.data.settings.title} 予約一覧　${slash(from)}〜${slash(to)}　部屋: ${rooms}　${list.length}件　出力: ${stamp}`, 'A1', 1)}</row>`,
      `<row r="2">${EXPORT_HEAD.map((h, i) => cell(h, col(i) + 2, 1)).join('')}</row>`,
      ...list.map((r, n) => `<row r="${n + 3}">${exportCells(r).map((v, i) => cell(v, col(i) + (n + 3))).join('')}</row>`),
    ];
    const widths = [12, 5, 7, 7, 22, 14, 22, 30];
    const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
      `<sheetData>${rows.join('')}</sheetData>` +
      `<autoFilter ref="A2:H${list.length + 2}"/></worksheet>`;
    const files = {
      '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
      '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="予約一覧" sheetId="1" r:id="rId1"/></sheets>' +
        `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'予約一覧'!$A$2:$H$${list.length + 2}</definedName></definedNames></workbook>`,
      'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
      'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="Yu Gothic"/></font><font><b/><sz val="11"/><name val="Yu Gothic"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '</styleSheet>',
      'xl/worksheets/sheet1.xml': sheet,
    };
    saveFile(new Blob([zipStore(files)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `予約一覧_${from}_${to}.xlsx`);
    return 'Excel';
  }

  /** ZIP（圧縮なし）を作る。files は {名前: 文字列} */
  function zipStore(files) {
    const enc = new TextEncoder();
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const parts = [], central = [];
    let offset = 0;
    for (const [name, text] of Object.entries(files)) {
      const nameB = enc.encode(name), data = enc.encode(text), crc = crc32(data);
      const head = new DataView(new ArrayBuffer(30));
      [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, 0, 2], [12, 0x21, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, nameB.length, 2], [28, 0, 2]]
        .forEach(([o, v, n]) => (n === 4 ? head.setUint32(o, v, true) : head.setUint16(o, v, true)));
      const dir = new DataView(new ArrayBuffer(46));
      [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, 0, 2], [14, 0x21, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4],
        [28, nameB.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, offset, 4]]
        .forEach(([o, v, n]) => (n === 4 ? dir.setUint32(o, v, true) : dir.setUint16(o, v, true)));
      parts.push(new Uint8Array(head.buffer), nameB, data);
      central.push(new Uint8Array(dir.buffer), nameB);
      offset += 30 + nameB.length + data.length;
    }
    const size = central.reduce((a, b) => a + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    const count = Object.keys(files).length;
    [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, count, 2], [10, count, 2], [12, size, 4], [16, offset, 4], [20, 0, 2]]
      .forEach(([o, v, n]) => (n === 4 ? end.setUint32(o, v, true) : end.setUint16(o, v, true)));
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)]);
  }

  // PDF: 印刷と同じ表を A4 縦で。文字は文字のまま入れ（小さく、検索・コピーもできる）、日本語の書体はファイルに入れず、
  // 開く端末のゴシック体を使う（PDF の決まりにある日本語の標準書体 HeiseiKakuGo-W5 を指定。Mac・iPhone・Windows・Chrome で表示できる）
  const PAGE = { w: 595.28, h: 841.89, m: 34 }; // A4（pt）と余白（12mm）
  const PDF_COLS = [{ k: '日付', w: 60 }, { k: '時間', w: 86 }, { k: '部屋', w: 104 }, { k: '氏名・団体名', w: 100 }, { k: '学籍番号/所属', w: 72 }, { k: '備考', w: 0 }];
  /** 文字の幅（pt）。半角は文字の大きさの半分、全角は同じ（PDF の中の決まり /W と合わせる） */
  const halfWidth = (c) => c < 0x7f || (c >= 0xff61 && c <= 0xff9f);
  const textWidth = (t, size) => [...String(t)].reduce((a, ch) => a + (halfWidth(ch.codePointAt(0)) ? 0.5 : 1), 0) * size;
  /** 幅に収まらない文字は、末尾を「…」にして縮める */
  function fit(text, width, size) {
    let t = String(text || '');
    if (textWidth(t, size) <= width) return t;
    while (t && textWidth(t + '…', size) > width) t = [...t].slice(0, -1).join('');
    return t + '…';
  }
  /** PDF の中の文字（UTF-16 の16進。BMP の外の文字は〓にする） */
  const pdfHex = (t) => '<' + [...String(t)].map((ch) => { const c = ch.codePointAt(0); return (c > 0xffff ? 0x3013 : c).toString(16).padStart(4, '0'); }).join('') + '>';

  /** 各ページの描画の命令（PDF の content stream）を作る */
  function pdfPages({ from, to, list, rooms, stamp }) {
    const usable = PAGE.w - PAGE.m * 2;
    PDF_COLS[PDF_COLS.length - 1].w = usable - PDF_COLS.slice(0, -1).reduce((a, c) => a + c.w, 0);
    const crossYear = from.slice(0, 4) !== to.slice(0, 4);
    const ROW = 16, HEAD_Y = PAGE.m + 44, FOOT = 20, FS = 9.5;
    const perPage = Math.floor((PAGE.h - HEAD_Y - ROW - PAGE.m - FOOT) / ROW);
    const pageCount = Math.max(1, Math.ceil(list.length / perPage));
    const Y = (y) => (PAGE.h - y).toFixed(2); // PDF は下が 0
    const pages = [];
    for (let p = 0; p < pageCount; p++) {
      const ops = [];
      // bold: 文字の縁もなぞって太く見せる（書体は1種類だけのため）
      const text = (t, x, y, size, opt) => {
        opt = opt || {};
        ops.push(`${opt.color || '0 0 0'} rg ${opt.color || '0 0 0'} RG ${opt.bold ? `2 Tr ${(size * 0.035).toFixed(3)} w` : '0 Tr'}`);
        ops.push(`BT /F1 ${size} Tf ${x.toFixed(2)} ${Y(y)} Td ${pdfHex(t)} Tj ET`);
      };
      const rule = (y, width, gray) => ops.push(`${gray} G ${width} w ${PAGE.m} ${Y(y)} m ${(PAGE.w - PAGE.m).toFixed(2)} ${Y(y)} l S`);
      text(`${state.data.settings.title} 予約一覧`, PAGE.m, PAGE.m + 14, 14, { bold: true });
      const stampText = `出力: ${stamp}`;
      text(`期間: ${slash(from)}(${wdOf(from)}) 〜 ${slash(to)}(${wdOf(to)})　部屋: ${fit(rooms, usable - 220, 9)}　${list.length}件`, PAGE.m, PAGE.m + 30, 9);
      text(stampText, PAGE.w - PAGE.m - textWidth(stampText, 9), PAGE.m + 30, 9, { color: '.33 .33 .33' });
      let y = HEAD_Y, x = PAGE.m;
      for (const c of PDF_COLS) { text(c.k, x + 4, y + 11, FS, { bold: true }); x += c.w; }
      rule(y + ROW, 1, 0);
      y += ROW;
      const rows = list.slice(p * perPage, (p + 1) * perPage);
      rows.forEach((r, i) => {
        const first = !i || rows[i - 1].date !== r.date; // ページの最初の行にも日付を出す
        if (first && i) rule(y, 1, .47);
        const w = wdOf(r.date);
        const cells = [null, `${hm(r.start)}〜${hm(r.end)}`, roomName(r.roomId), r.name, r.affiliation, r.memo];
        x = PAGE.m;
        PDF_COLS.forEach((c, k) => {
          if (k === 0) {
            if (first) {
              const d = crossYear ? slash(r.date) : slash(r.date).slice(5);
              text(d, x + 4, y + 11, FS);
              text(`(${w})`, x + 4 + textWidth(d, FS), y + 11, FS, { color: w === '土' ? '.11 .31 .85' : w === '日' ? '.78 .16 .16' : '0 0 0' });
            }
          } else {
            text(fit(cells[k], c.w - 8, FS), x + 4, y + 11, FS);
          }
          x += c.w;
        });
        y += ROW;
        rule(y, .5, .78);
      });
      if (!list.length) text('この期間・部屋の予約はありません。', PAGE.m, y + 14, FS);
      const no = `${p + 1} / ${pageCount}`;
      text(no, (PAGE.w - textWidth(no, 8)) / 2, PAGE.h - PAGE.m + 6, 8, { color: '.33 .33 .33' });
      pages.push(ops.join('\n'));
    }
    return pages;
  }

  async function exportPdf(data) {
    const pages = pdfPages(data);
    const streams = [];
    for (const p of pages) streams.push(await deflate(new TextEncoder().encode(p)));
    saveFile(pdfFile(streams), `予約一覧_${data.from}_${data.to}.pdf`);
    return 'PDF';
  }
  /** 使える端末では縮める（使えない古い端末は、縮めずにそのまま入れる） */
  async function deflate(bytes) {
    if (typeof CompressionStream !== 'function') return { data: bytes, filter: '' };
    const out = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer();
    return { data: new Uint8Array(out), filter: '/Filter /FlateDecode ' };
  }
  /** PDF（1.4）を作る。1〜4番は共通（目次・ページの束・書体）、そのあとにページと描画の命令が2つずつ並ぶ */
  function pdfFile(streams) {
    const enc = new TextEncoder();
    const chunks = [];
    const offsets = [];
    let size = 0;
    const put = (b) => { const u = typeof b === 'string' ? enc.encode(b) : b; chunks.push(u); size += u.length; };
    const obj = (n, body, stream) => {
      offsets[n] = size;
      put(`${n} 0 obj\n${body}\n`);
      if (stream) { put('stream\n'); put(stream); put('\nendstream\n'); }
      put('endobj\n');
    };
    put('%PDF-1.4\n%âãÏÓ\n');
    const first = 6;
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${streams.map((_, i) => `${first + i * 2} 0 R`).join(' ')}] /Count ${streams.length} >>`);
    // 日本語の標準書体（ファイルには入れない）。半角の文字（CID 231〜389）は幅 500、それ以外は 1000
    obj(3, '<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiKakuGo-W5 /Encoding /UniJIS-UCS2-HW-H /DescendantFonts [4 0 R] >>');
    obj(4, '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiKakuGo-W5 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 4 >> ' +
      '/FontDescriptor 5 0 R /DW 1000 /W [231 389 500] >>');
    obj(5, '<< /Type /FontDescriptor /FontName /HeiseiKakuGo-W5 /Flags 4 /FontBBox [-92 -250 1010 922] /ItalicAngle 0 /Ascent 752 /Descent -221 /CapHeight 737 /StemV 114 >>');
    streams.forEach((s, i) => {
      const n = first + i * 2;
      obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${n + 1} 0 R >>`);
      obj(n + 1, `<< ${s.filter}/Length ${s.data.length} >>`, s.data);
    });
    const count = first + streams.length * 2;
    const xref = size;
    put(`xref\n0 ${count}\n0000000000 65535 f \n`);
    for (let n = 1; n < count; n++) put(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
    put(`trailer\n<< /Size ${count} /Root 1 0 R /Info << /Producer (practice-room-reservation) >> >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(chunks, { type: 'application/pdf' });
  }

  /** 一覧の表（画面の表示と印刷で共通）。日付は日ごとに最初の行だけ。年をまたぐ期間では年も出す */
  const SHOW_MAX = 2000; // 画面に並べる上限（それより多いときは、印刷・エクスポートで全部を見てもらう）
  function listTable({ from, to, list }, max) {
    const crossYear = from.slice(0, 4) !== to.slice(0, 4);
    let prev = '';
    const body = list.slice(0, max || list.length).map((r) => {
      const first = r.date !== prev;
      prev = r.date;
      const w = wdOf(r.date);
      return `<tr class="${first ? 'day' : ''}"><td class="d">${first ? `${crossYear ? slash(r.date) : slash(r.date).slice(5)}<span class="${w === '土' ? 'sat' : w === '日' ? 'sun' : ''}">(${w})</span>` : ''}</td>` +
        `<td class="t">${hm(r.start)}〜${hm(r.end)}</td><td>${esc(roomName(r.roomId))}</td><td>${esc(r.name)}</td><td>${esc(r.affiliation)}</td><td class="m">${esc(r.memo)}</td></tr>`;
    }).join('');
    return `<table class="list-table"><thead><tr><th>日付</th><th>時間</th><th>部屋</th><th>氏名・団体名</th><th>学籍番号/所属</th><th>備考</th></tr></thead><tbody>${body}</tbody></table>`;
  }

  // 表示: この画面の、欄の下に表を出す
  $('xShowBtn').addEventListener('click', () => withExport($('xShowBtn'), async (data) => {
    const { from, to, list, rooms } = data;
    $('xResultHead').textContent = `${slash(from)}(${wdOf(from)}) 〜 ${slash(to)}(${wdOf(to)})　${rooms}　${list.length}件` +
      (list.length > SHOW_MAX ? `（先頭の${SHOW_MAX}件を表示。すべては印刷・エクスポートで）` : '');
    $('xResultBody').innerHTML = list.length ? listTable(data, SHOW_MAX) : '<p class="empty">この期間・部屋の予約はありません。</p>';
    $('xResult').hidden = false;
  }));

  // 印刷: 印刷用の表（#printArea）を作り、印刷のときはそれだけを出す（admin.css の @media print）
  $('xPrintBtn').addEventListener('click', () => withExport($('xPrintBtn'), async (data) => {
    const { from, to, list, rooms, stamp } = data;
    let area = $('printArea');
    if (!area) { area = document.createElement('div'); area.id = 'printArea'; document.body.appendChild(area); }
    area.innerHTML = `<h1>${esc(state.data.settings.title)} 予約一覧</h1>` +
      `<p class="meta">期間: ${slash(from)}(${wdOf(from)}) 〜 ${slash(to)}(${wdOf(to)})　部屋: ${esc(rooms)}　${list.length}件<span>出力: ${stamp}</span></p>` +
      (list.length ? listTable(data) : '<p>この期間・部屋の予約はありません。</p>');
    window.print();
  }));

  // ---------------- 不具合報告 ----------------
  let bugData = null;
  // 件数バッジは、まだ片付いていない報告（未対応・対応中）を数える
  const CLOSED_BUG = ['対応済み', '対応しない'];
  function openCount(reports) { return reports.filter((b) => CLOSED_BUG.indexOf(b.status) < 0).length; }
  function setBugBadge(n) {
    n = Number(n) || 0;
    $('bugBadge').hidden = !n;
    $('bugBadge').textContent = n > 99 ? '99+' : String(n);
    $('bugBadge').setAttribute('aria-label', `未対応・対応中 ${n} 件`);
    placeTabThumb(); // バッジの有無でタブの幅が変わるため
  }
  async function loadBugs() {
    $('bugsError').textContent = '';
    $('bugList').innerHTML = '<p class="empty">読み込み中…</p>';
    try {
      const res = await api('adminGetBugReports', {});
      if (!res.ok) throw new Error(res.message);
      bugData = res;
      setBugBadge(openCount(res.reports));
      renderBugs();
    } catch (ex) {
      $('bugList').innerHTML = '';
      $('bugsError').textContent = errMessage(ex);
    }
  }
  function renderBugs() {
    const closed = ['対応済み', '対応しない'];
    const list = bugData.reports.filter((b) => $('showDone').checked || closed.indexOf(b.status) < 0);
    $('bugList').innerHTML = list.length ? list.map((b) => {
      let env = b.env;
      try { env = Object.entries(JSON.parse(b.env)).map(([k, v]) => `${k}: ${v}`).join('\n'); } catch (e) { /* そのまま表示 */ }
      return `<div class="bug${closed.indexOf(b.status) >= 0 ? ' done' : ''}">
        <div class="bug-head"><span>${esc(b.receivedAt)}</span><span>${esc(b.page)}</span>
          <select data-bug-id="${esc(b.id)}" aria-label="状態">${bugData.statuses.map((st) => `<option${st === b.status ? ' selected' : ''}>${esc(st)}</option>`).join('')}</select></div>
        <div class="bug-msg">${esc(b.message)}</div>
        ${b.contact ? `<div class="bug-meta">連絡先: ${esc(b.contact)}</div>` : ''}
        <div class="bug-meta">${esc(b.screen)}</div>
        <details><summary class="bug-meta">端末・環境の詳細</summary><pre>${esc(env)}</pre></details>
      </div>`;
    }).join('') : '<p class="empty">表示する報告はありません。</p>';
  }
  $('showDone').addEventListener('change', () => { if (bugData) renderBugs(); });
  $('bugReload').addEventListener('click', loadBugs);
  $('bugList').addEventListener('change', async (e) => {
    const sel = e.target.closest('select[data-bug-id]');
    if (!sel) return;
    sel.disabled = true;
    try {
      const res = await api('adminSetBugStatus', { id: sel.dataset.bugId, status: sel.value });
      if (!res.ok) throw new Error(res.message);
      const b = bugData.reports.find((x) => x.id === sel.dataset.bugId);
      if (b) b.status = sel.value;
      setBugBadge(openCount(bugData.reports));
      renderBugs();
      toast('状態を変更しました');
    } catch (ex) {
      $('bugsError').textContent = errMessage(ex);
      sel.disabled = false;
    }
  });
  $('loginForm').addEventListener('submit', (e) => { e.preventDefault(); login($('loginPw').value); });

  // ---------------- パスキー（Face ID / Touch ID でログイン） ----------------
  // 署名の確認は高速キャッシュ（Cloudflare、cache/worker.js）が行い、確かめられたら「ログインの印」を返す。
  // 画面はその印を管理用パスワードの代わりに使う（GAS が同じ合言葉で確かめる）。
  const PK_URL = String(window.CACHE_API_URL || '').replace(/\/+$/, '');
  const pkSupported = !!(PK_URL && window.PublicKeyCredential && navigator.credentials);
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  async function pkCall(op, body) {
    let res;
    try {
      const r = await fetch(`${PK_URL}/passkey/${op}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body || {}) });
      res = await r.json();
    } catch (e) { throw new Error('通信に失敗しました。'); }
    if (!res || !res.ok) throw new Error((res && res.message) || 'パスキーの処理に失敗しました。');
    return res;
  }
  /** 端末の操作（Face ID など）を取りやめたときは、何も知らせない */
  const pkCancelled = (e) => e && (e.name === 'NotAllowedError' || e.name === 'AbortError');

  async function pkLogin() {
    const btn = $('pkLoginBtn');
    btn.disabled = true;
    $('loginError').textContent = '';
    try {
      const c = await pkCall('challenge');
      const cred = await navigator.credentials.get({ publicKey: {
        challenge: new TextEncoder().encode(c.challenge), rpId: c.rpId, userVerification: 'required', timeout: 60000,
      } });
      const r = cred.response;
      const res = await pkCall('login', {
        id: cred.id, clientDataJSON: b64url(r.clientDataJSON), authenticatorData: b64url(r.authenticatorData), signature: b64url(r.signature),
      });
      await login(res.token);
    } catch (e) {
      if (!pkCancelled(e)) $('loginError').textContent = errMessage(e);
    } finally {
      btn.disabled = false;
    }
  }

  /** 登録するパスキーの名前（一覧で見分けるため）: 端末の種類と登録日 */
  function pkDeviceName() {
    const ua = navigator.userAgent;
    const kind = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
      : /Macintosh/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : 'この端末';
    const d = new Date();
    return `${kind}（${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} 登録）`;
  }

  async function pkTicket() {
    const t = await api('adminPasskeyTicket', {});
    if (!t.ok) throw new Error(t.message);
    return t.ticket;
  }

  async function pkRefresh() {
    if (!pkSupported) return;
    $('pkError').textContent = '';
    try {
      const res = await pkCall('list', { ticket: await pkTicket() });
      $('pkList').innerHTML = res.passkeys.map((k) => `<li><span class="pk-body"><span class="pk-name">${esc(k.name)}</span>` +
        `<span class="pk-meta">${k.lastUsed ? `最後に使った日時 ${esc(k.lastUsed)}` : '未使用'}</span></span>` +
        `<button type="button" class="btn small danger-text" data-pk="${esc(k.id)}" data-name="${esc(k.name)}">削除</button></li>`).join('') ||
        '<li class="empty">登録されていません</li>';
    } catch (e) {
      $('pkError').textContent = errMessage(e);
    }
  }

  async function pkRegister() {
    const btn = $('pkAddBtn');
    btn.disabled = true;
    $('pkError').textContent = '';
    try {
      const ticket = await pkTicket();
      const c = await pkCall('challenge');
      const name = pkDeviceName();
      const cred = await navigator.credentials.create({ publicKey: {
        challenge: new TextEncoder().encode(c.challenge),
        rp: { id: c.rpId, name: '練習室予約 管理画面' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: `管理者（${name}）`, displayName: `管理者（${name}）` },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        attestation: 'none', timeout: 60000,
      } });
      const r = cred.response;
      if (typeof r.getPublicKey !== 'function') throw new Error('このブラウザではパスキーを登録できません。Safari・Chrome を新しくしてからお試しください。');
      await pkCall('register', {
        ticket, name, id: cred.id, publicKey: b64url(r.getPublicKey()), alg: r.getPublicKeyAlgorithm(),
        clientDataJSON: b64url(r.clientDataJSON), authenticatorData: b64url(r.getAuthenticatorData()),
      });
      toast('この端末をパスキーに登録しました');
      pkRefresh();
    } catch (e) {
      if (!pkCancelled(e)) $('pkError').textContent = errMessage(e);
    } finally {
      btn.disabled = false;
    }
  }

  $('pkLoginBtn').hidden = !pkSupported;
  $('pkCard').dataset.unsupported = pkSupported ? '' : '1';
  $('pkLoginBtn').addEventListener('click', pkLogin);
  $('pkAddBtn').addEventListener('click', pkRegister);
  $('pkList').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-pk]');
    if (!b || !confirm(`パスキー「${b.dataset.name}」を削除します。この端末（アカウント）では、パスキーで入れなくなります。`)) return;
    b.disabled = true;
    try {
      await pkCall('delete', { ticket: await pkTicket(), id: b.dataset.pk });
      toast('パスキーを削除しました');
      pkRefresh();
    } catch (ex) {
      $('pkError').textContent = errMessage(ex);
      b.disabled = false;
    }
  });
  $('logoutBtn').addEventListener('click', () => {
    if ((state.dirty.rooms || state.dirty.settings) && !confirm('保存していない変更があります。ログアウトしますか？')) return;
    logout('');
    state.dirty.rooms = state.dirty.settings = false; // 未保存の確認は済んでいる
    location.reload(); // 管理画面で読み込んだデータが画面に残らないよう、読み込み直す
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty.rooms || state.dirty.settings) { e.preventDefault(); e.returnValue = ''; }
  });

  // このタブで一度ログインしていれば、自動でログインし直す。確かめている間はパスワード欄を出さない
  // （入力の途中で確認が終わり、画面が勝手に切り替わらないように）
  if (state.pw) {
    $('loginForm').hidden = true;
    $('loginChecking').hidden = false;
    login(state.pw).finally(() => {
      $('loginChecking').hidden = true;
      $('loginForm').hidden = false;
      if (!state.pw) $('loginPw').focus();
    });
  } else $('loginPw').focus();
})();
