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
    renderClosures();
    setDirty('rooms', false);
    setDirty('settings', false);
  }

  function setDirty(key, value) {
    state.dirty[key] = value;
    const cap = key === 'rooms' ? 'Rooms' : 'Settings';
    $('dot' + cap).hidden = !value;
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
    setDirty('rooms', true);
  });
  $('roomList').addEventListener('change', (e) => {
    const el = e.target.closest('select[data-f]');
    if (!el) return;
    const row = el.closest('.room');
    const r = state.rooms[Number(row.dataset.i)];
    r[el.dataset.f] = el.value;
    row.querySelector('.room-sum').innerHTML = roomSumHtml(r);
    setDirty('rooms', true);
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
    setDirty('rooms', true);
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
    setDirty('rooms', true);
    renderRooms();
  }
  $('roomList').addEventListener('pointerup', endSort);
  $('roomList').addEventListener('pointercancel', endSort);

  $('addRoomBtn').addEventListener('click', () => {
    state.rooms.push({ id: '', name: '', tags: '', equipment: '', restriction: '', note: '' });
    openRooms.add(state.rooms[state.rooms.length - 1]);
    setDirty('rooms', true);
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
  $('settingsForm').addEventListener('input', () => setDirty('settings', true));
  $('settingsForm').addEventListener('change', () => setDirty('settings', true));
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

  function renderClosureForm() {
    const s = state.data.settings;
    $('cRoom').innerHTML = '<option value="">全室</option>' + state.data.rooms.map((r) => `<option value="${esc(r.id)}">${esc(roomName(r.id))}</option>`).join('');
    if (!$('cDate').value) $('cDate').value = state.data.today;
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
      roomId: $('cRoom').value,
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
      await saveClosures(state.closures.concat([item]), '追加しました');
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
      for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== t.dataset.tab;
      placeTabThumb();
      if (t.dataset.tab === 'bugs') loadBugs();
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
