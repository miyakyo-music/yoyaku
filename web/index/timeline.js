// 予約表: 一覧・部屋別の描画（時間軸・部屋名の列・空室ランプ・時間軸の幅）
'use strict';

// ---------------- 描画 ----------------
function roomById(id) { return state.rooms.find((r) => r.id === id); }
function isClosedWeekday(date) { return state.settings.closedWeekdays.indexOf(weekday(date)) >= 0; }

function closuresFor(date, roomId) {
  const s = state.settings;
  const list = state.data.closures
    .filter((c) => c.date === date && (!c.roomId || c.roomId === roomId))
    .map((c) => ({ start: c.allDay ? toMin(s.openTime) : toMin(c.start), end: c.allDay ? toMin(s.closeTime) : toMin(c.end), reason: c.reason || '利用不可' }));
  if (isClosedWeekday(date)) list.push({ start: toMin(s.openTime), end: toMin(s.closeTime), reason: '定休日' });
  return list;
}

function render() {
  if (isOffline() && state.shownKey !== `${state.view}|${rangeKey(currentRange())}`) {
    $('main').innerHTML = '<p class="empty">オフラインのため、この期間の予約を表示できません。</p>';
    liftFab();
    return;
  }
  if (state.view === 'month') renderMonth();
  else renderTimeline();
  liftFab();
  // 「‹」「›」で日付（月）を切り替えたときだけ、表を進む向きから軽くすべり込ませる
  if (state.slide) {
    const cls = (state.slide > 0 ? 'slide-next' : 'slide-prev') + (Math.abs(state.slide) > 1 ? ' far' : '');
    state.slide = 0;
    for (const el of $('main').querySelectorAll('.tl-track, .month')) el.classList.add(...cls.split(' '));
  }
}

/** 空室ランプ: 今この部屋が 空き / まもなく予約あり / 使用中 / 利用時間外・使用停止 のどれか（今日の一覧のときだけ） */
const LAMP_TEXT = { free: '空き', soon: 'まもなく予約', busy: '使用中', off: '利用不可' };
function lampOf(room) {
  if (state.view !== 'day' || !state.data || state.data.from !== todayStr()) return null;
  const s = state.settings;
  const now = nowMin();
  if (room.restriction === STOPPED || now < toMin(s.openTime) || now >= toMin(s.closeTime)) return 'off';
  const today = todayStr();
  const spans = visibleReservations().filter((r) => r.date === today && r.roomId === room.id)
    .map((r) => [toMin(r.start), toMin(r.end), 'busy'])
    .concat(closuresFor(today, room.id).map((c) => [c.start, c.end, 'off']));
  const cur = spans.find(([a, b]) => a <= now && now < b);
  if (cur) return cur[2];
  return spans.some(([a]) => a > now && a - now <= 30) ? 'soon' : 'free';
}
function lampHtml(room) {
  const st = lampOf(room);
  return st ? `<i class="lamp lamp-${st}" role="img" aria-label="${LAMP_TEXT[st]}" title="${LAMP_TEXT[st]}"></i>` : '';
}
function roomLabelHtml(room, extraHtml) {
  const tags = tagList(room.tags).map((t) => `<span class="tag ${tagClass(t)}">${esc(t)}</span>`);
  if (room.restriction === ADMIN_ONLY) tags.push('<span class="tag t-admin">管理者のみ</span>');
  if (room.restriction === STOPPED) tags.push('<span class="tag t-admin">使用停止</span>');
  if (room.restriction === LIMITED) tags.push('<span class="tag t-limited">限定</span>');
  const title = [roomText(room), room.equipment, room.note].filter(Boolean).join(' / ');
  const name = `<span class="nm" title="${esc(title)}">${esc(room.name)}</span>`;
  // 「○時まで空き」を出すときは、タグを部屋名の横に寄せて2行目に置き、列の幅を節約する
  const body = extraHtml ? `<span class="nm-line">${name}${tags.join('')}</span>${extraHtml}`
    : name + (tags.length ? `<span class="sub">${tags.join('')}</span>` : '');
  // 空室ランプは部屋名とタグの左に置き、欄の上下中央にそろえる（タグの左端は部屋名の左端とそろう）
  const lamp = lampHtml(room);
  return lamp ? `<span class="lbl-lamp">${lamp}<span class="lbl-body">${body}</span></span>` : body;
}

function renderTimeline() {
  const s = state.settings;
  const open = toMin(s.openTime), close = toMin(s.closeTime);
  const t0 = floorTo(open, 60), t1 = ceilTo(close, 60), total = t1 - t0;
  state.geo = { open, close, t0, t1, total, unit: s.unitMinutes };
  document.documentElement.style.setProperty('--hours', String(total / 60));
  const pct = (m) => `${((m - t0) / total * 100).toFixed(4)}%`;
  const span = (a, b) => `left:${pct(a)};width:${((b - a) / total * 100).toFixed(4)}%`;
  const today = todayStr();
  const now = nowMin();
  const mine = getMine();

  // 行の構成: 一覧 = 部屋ごと / 部屋別 = 7日分
  let rows;
  let corner;
  if (state.view === 'day') {
    const filter = $('equipFilter').value;
    rows = state.rooms.filter((r) => roomInFilter(r, filter))
      .map((room) => ({ date: state.data.from, room, label: roomLabelHtml(room), cls: '' }));
    if (state.freeNow) {
      // 「空室」: 今から30分以上（閉館が近ければ閉館まで）空いている部屋だけにし、いつまで空いているかを添える
      rows = rows.map((row) => Object.assign(row, { free: freeFromNow(row.room) })).filter((row) => row.free);
      for (const row of rows) {
        const until = row.free.until >= close ? '閉館まで空き' : `${hm(toHHMM(row.free.until))}まで空き`;
        row.label = roomLabelHtml(row.room, `<span class="free-until">${until}</span>`);
      }
    }
    corner = '部屋<span class="lg"> ＼ 時刻</span>'; // スマホでは「部屋」だけにして列を細くする
  } else {
    const room = roomById(state.roomId);
    rows = [];
    for (let date = state.data.from; room && date <= state.data.to; date = addDays(date, 1)) {
      // 日曜日の行の上に区切り線を引き、週のまとまりを分かるようにする
      const cls = (date === today ? ' today' : '') + (weekday(date) === 0 && date !== state.data.from ? ' week-start' : '');
      rows.push({ date, room, label: `<span class="nm ${dayClass(date)}">${esc(mdLabel(date))}</span>`, cls });
    }
    corner = '日付<span class="lg"> ＼ 時刻</span>'; // 部屋名は上の部屋選択欄に表示している
  }

  const all = visibleReservations();
  let html = `<div class="tl"><div class="tl-head"><div class="tl-corner"><span class="corner-text">${corner}</span><button type="button" class="zoom-reset" data-zoom-reset hidden><span class="lg">幅を</span>リセット</button></div><div class="tl-scale">`;
  const nowHourShown = state.view === 'day' && state.data.from === today;
  for (let h = t0; h < t1; h += 60) {
    html += `<span${nowHourShown && now >= h && now < h + 60 ? ' class="now"' : ''}>${h / 60}:00</span>`;
  }
  html += '</div></div>';

  state.rows = rows.map((row, i) => {
    const reservations = all
      .filter((r) => r.date === row.date && r.roomId === row.room.id)
      .sort((a, b) => a.start.localeCompare(b.start));
    const closures = closuresFor(row.date, row.room.id);
    const busy = reservations.map((r) => [toMin(r.start), toMin(r.end)]).concat(closures.map((c) => [c.start, c.end]));
    const stopped = row.room.restriction === STOPPED;

    // 一覧では部屋名を押すと、その部屋の部屋別表示（この日から1か月分）へ移動する。
    // 部屋別では日付を押すと、その日の一覧へ移動する
    const labelAttrs = state.view === 'day'
      ? ` data-room="${esc(row.room.id)}" role="button" tabindex="0" title="${esc(roomText(row.room))} の予約を1か月分表示"`
      : ` data-date="${row.date}" role="button" tabindex="0" title="${esc(mdLabel(row.date))} の一覧を表示"`;
    html += `<div class="tl-row${row.cls}"><div class="tl-label"${labelAttrs}>${row.label}</div>` +
      `<div class="tl-track${stopped ? ' stopped' : ''}" data-i="${i}">`;
    if (open > t0) html += `<div class="blk off" style="${span(t0, open)}"></div>`;
    if (close < t1) html += `<div class="blk off" style="${span(close, t1)}"></div>`;
    if (row.date < today) html += '<div class="past" style="width:100%"></div>';
    else if (row.date === today && now > t0) {
      html += `<div class="past" style="width:${pct(Math.min(now, t1))}"></div>`;
      if (now < t1) html += `<div class="now-line" style="left:${pct(now)}"></div>`;
    }
    for (const c of closures) {
      html += `<div class="blk closed" style="${span(c.start, c.end)}" title="${esc(c.reason)}"><span>${esc(c.reason)}</span></div>`;
    }
    for (const r of reservations) {
      const cls = ['blk', 'res'];
      if (Object.prototype.hasOwnProperty.call(mine, r.id)) cls.push('mine');
      if (r.date < today || (r.date === today && toMin(r.end) <= now)) cls.push('ended');
      if (r.pending) cls.push('mine', 'pending'); // 送信中の予約も自分の予約の色で表示する
      if (RES_COLORS.includes(r.color)) cls.push('c-' + r.color); // 重要な予定の色（自分の予約の青より優先）
      // 取れたばかりの予約は一度だけ弾ませる。描き直しても動きが最初からやり直しにならないよう、経過時間ぶん先へ進めて始める
      let pop = '';
      const cel = state.celebrate;
      if (cel && cel.ids.has(r.id)) {
        const t = performance.now() - cel.start;
        if (t < 900) { cls.push('booked'); pop = `;--bk-delay:${Math.round(-t)}ms`; }
      }
      const title = `${hm(r.start)}〜${hm(r.end)} ${personText(r)}${r.memo ? '　' + r.memo : ''}${r.pending ? '（送信中）' : ''}`;
      // 予約者名を太字で先に、学籍番号/所属は2行目に細字で
      html += `<div class="${cls.join(' ')}" data-id="${esc(r.id)}" role="button" tabindex="0" style="${span(toMin(r.start), toMin(r.end))}${pop}" aria-label="${esc(title)}">` +
        `<div class="txt"><b>${r.groupId ? '↻' : ''}${esc(r.name)}</b>${r.affiliation ? `<span>${esc(r.affiliation)}</span>` : ''}</div></div>`;
    }
    html += '</div></div>';
    return { date: row.date, roomId: row.room.id, stopped, busy };
  });
  html += '</div>';
  if (!rows.length) {
    const msg = !state.rooms.length ? '部屋が登録されていません（部屋マスタを確認してください）。'
      : state.freeNow ? (now >= close ? '本日の利用時間は終了しました。' : '今すぐ使える部屋はありません。') : '該当する部屋がありません。';
    html += `<p class="empty">${msg}</p>`;
  }
  html += footHtml('');
  $('main').innerHTML = html;
  $('main').classList.add('has-tl');
  fitLabelColumn();
  renderDraft();
}

/** 予約表の下端（操作の案内・版〈押すと更新情報〉・不具合報告） */
function footHtml(text) {
  // 「不具合を報告」はフッタに常に出す（試験運用中は上端の帯にも出す）
  return `<footer class="main-foot">${text ? `<p class="foot-text">${esc(text)}</p>` : ''}` +
    `<p class="site-foot"><button type="button" data-releases>${esc(APP_VERSION)}</button><button type="button" data-bug>不具合を報告</button>` +
    '<a href="privacy.html">プライバシーポリシー</a></p></footer>';
}

/**
 * 部屋名（日付）の列幅を、いちばん長い表示内容にぴったり合わせる。極端に長い名前は上限幅で折り返す。
 * 画面が広いときは、時間軸を画面の右端まで広げる。
 */
function fitLabelColumn() {
  const tl = $('main').querySelector('.tl');
  if (!tl) return;
  tl.classList.add('measuring');
  let max = 0;
  for (const el of tl.querySelectorAll('.tl-corner, .tl-label')) max = Math.max(max, el.offsetWidth);
  // 左上の「幅をリセット」も入る幅にしておく（ピンチの途中で列幅が変わらないように）
  const reset = tl.querySelector('.zoom-reset');
  const resetHidden = reset.hidden;
  reset.hidden = false;
  max = Math.max(max, reset.offsetWidth + 14);
  reset.hidden = resetHidden;
  tl.classList.remove('measuring');
  if (max < 40) return; // 画面が非表示などで計測できないときは既定の幅のまま
  const cap = window.innerWidth <= 600 ? 140 : 240;
  const labelW = Math.min(cap, Math.ceil(max) + 2);
  tl.style.setProperty('--label-w', `${labelW}px`);
  tl.style.removeProperty('--hour-w');
  const base = parseFloat(getComputedStyle(tl).getPropertyValue('--hour-w')) || 96;
  const hours = state.geo ? state.geo.total / 60 : 15;
  const fit = ($('main').clientWidth - labelW - 1) / hours; // 時間軸全体がちょうど画面に入る幅
  state.hourBase = Math.max(base, Math.floor(fit / 2) * 2);
  state.hourMin = Math.max(MIN_HOUR_W, Math.min(state.hourBase, Math.floor(fit / 2) * 2));
  applyHourWidth(state.hourBase * state.zoom);
}

let scaleTextCache = { key: '', w: 0 };
/** 時刻の見出し（12px のとき）でいちばん長い文字の幅。書体と時刻の並びが同じ間は覚えておく */
function scaleTextWidth(tl) {
  const spans = [...tl.querySelectorAll('.tl-scale span')];
  if (!spans.length) return 36;
  const cs = getComputedStyle(spans[0]);
  const font = `${cs.fontWeight} 12px ${cs.fontFamily}`;
  const key = font + spans.map((s) => s.textContent).join();
  if (scaleTextCache.key !== key) {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = font;
    scaleTextCache = { key, w: Math.max(...spans.map((s) => ctx.measureText(s.textContent).width)) };
  }
  return scaleTextCache.w;
}

/** 時間軸の1時間の幅を設定する。拡大率は「既定の幅（画面に合わせた幅）」に対する比で覚えておく */
function applyHourWidth(w) {
  const tl = $('main').querySelector('.tl');
  if (!tl || !state.hourBase) return;
  // 1時間の幅は偶数px にして、30分の線が半端な位置でぼやけたり消えたりしないようにする
  const hourW = Math.round(Math.min(MAX_HOUR_W, Math.max(state.hourMin, w)) / 2) * 2;
  tl.style.setProperty('--hour-w', `${hourW}px`);
  // 時刻の文字が隣の線にかかり始めたら、2時間おき・3時間おきに減らす（文字の幅は実際の書体で測る）
  const textW = scaleTextWidth(tl);
  tl.classList.toggle('narrow', hourW < textW + 8);
  tl.classList.toggle('tiny', hourW * 2 < textW * 11 / 12 + 6);
  state.hourW = hourW;
  state.zoom = hourW === state.hourBase ? 1 : hourW / state.hourBase;
  // 幅を変えている間は、左上の「部屋 ＼ 時刻」の所に「幅をリセット」を出す
  tl.querySelector('[data-zoom-reset]').hidden = state.zoom === 1;
  tl.querySelector('.corner-text').hidden = state.zoom !== 1;
}

/** 画面上の x 座標 clientX にある時刻を、拡大・縮小の後も同じ位置に保つ */
function zoomAround(clientX, w) {
  const track = $('main').querySelector('.tl-track');
  if (!track || !state.geo) return;
  let rect = track.getBoundingClientRect();
  const ratio = (clientX - rect.left) / rect.width;
  applyHourWidth(w);
  rect = track.getBoundingClientRect();
  $('main').scrollLeft += rect.left + ratio * rect.width - clientX;
}
function saveZoom() { save_(LS.zoom, state.zoom); }
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(fitLabelColumn, 150);
});

function scrollToNow() {
  const main = $('main');
  if (state.view === 'month' || !state.geo) { main.scrollTop = 0; main.scrollLeft = 0; return; }
  const isToday = state.view === 'day' ? state.data.from === todayStr() : true;
  const track = main.querySelector('.tl-track');
  if (!isToday || !track) { main.scrollLeft = 0; return; }
  const ratio = (nowMin() - state.geo.t0) / state.geo.total;
  main.scrollLeft = Math.max(0, ratio * track.offsetWidth - track.offsetWidth / state.geo.total * 60);
}
