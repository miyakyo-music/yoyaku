// 予約表: 予約の詳細（変更・取消・カレンダーに追加）
'use strict';

/** 予約の詳細を閉じる（その帯が見えていれば、帯へ縮んで戻る） */
function closeDetail() {
  const dlg = $('detailDialog');
  if (!dlg.open) return;
  morph(dlg, () => dlg.close(), () => bandEl(state.detail && state.detail.id));
}

// ---------------- 詳細ダイアログ ----------------
function personText(r) { return r.affiliation ? `${r.name}（${r.affiliation}）` : r.name; }

function openDetail(id) {
  const r = visibleReservations().find((x) => x.id === id);
  if (!r) { toast('この予約は見つかりませんでした。'); return; }
  if (r.pending || r.settling) { toast('予約を送信中です。少し待ってから操作してください。'); return; }
  state.detail = r;
  const room = roomById(r.roomId);
  $('dRoom').textContent = room ? roomText(room) : r.roomId;
  $('dDate').textContent = fullDateLabel(r.date);
  $('dTime').textContent = `${hm(r.start)} 〜 ${hm(r.end)}（${durationLabel(toMin(r.end) - toMin(r.start))}）`;
  $('dName').textContent = personText(r);
  $('dMemo').textContent = r.memo;
  $('dMemo').hidden = $('dMemoDt').hidden = !r.memo;
  $('dError').textContent = '';

  const ended = isEnded(r);
  const mine = isMine(r.id);
  const admin = isAdminMode();
  // 終了した予約は変更できない（管理者でも、過去の時刻のままだとサーバーが断る。仕様 2.6）。
  // 取消だけは、サーバーが管理者に許しているので出す
  const canCancel = !ended || admin;
  // 編集用パスワード欄は「編集用パスワードが設定された予約」を管理者モード以外で操作するときだけ出す
  $('dOps').hidden = ended || admin || !r.hasPin;
  $('dEdit').hidden = ended;
  $('dCancel').hidden = !canCancel;
  $('dCancel').disabled = $('dEdit').disabled = false;
  $('dSeriesArea').hidden = !canCancel || !r.groupId;
  $('dSeries').checked = false;
  const notes = [];
  if (ended) notes.push('この予約は終了しています。');
  if (r.groupId) notes.push('まとめて登録された予約（くり返し・複数部屋）の1件です。');
  if (mine) notes.push('この端末で作成した予約です。');
  if (admin) notes.push(ended ? '管理者モード: 終了した予約は取り消せます（変更はできません）。' : '管理者モード: 編集用パスワードなしで変更・取消できます。');
  if (!admin && room && room.restriction === ADMIN_ONLY && !ended) notes.push('この部屋の予約の変更・取消は管理者のみ行えます。');
  $('dNote').hidden = !notes.length;
  $('dNote').textContent = notes.join(' ');
  $('dPin').value = mine ? (load_(LS.profile, {}).pin || '') : '';
  // カレンダーに追加（終わっていない予約だけ）
  $('dCal').hidden = ended;
  // コピー（まとめて予約ができる人だけ。終わった予約もコピーできる）
  $('dCopy').hidden = !(isAdminMode() || !state.settings.bulkRequiresAdmin) || !room || room.restriction === STOPPED;
  if (!ended) {
    // Android は Google カレンダーの追加画面、それ以外（iPhone など）はカレンダーのファイルの URL を開く
    const add = $('dCalAdd');
    if (IS_ANDROID) { add.href = googleCalendarUrl(r, room); add.target = '_blank'; add.rel = 'noopener'; }
    else { add.href = icsUrl(r, room) || '#'; add.removeAttribute('target'); }
  }
  $('detailDialog').showModal();
  // 詳細を開いている間も、閉じた後と同じ青い枠でその帯を囲む
  const band = bandEl(r.id);
  if (band) band.classList.add('viewing');
}
// Esc で予約の詳細を閉じるときも、帯へ縮んで戻る
$('detailDialog').addEventListener('cancel', (e) => { if (VT_OK) { e.preventDefault(); closeDetail(); } });
$('detailDialog').addEventListener('close', () => {
  for (const el of $('main').querySelectorAll('.blk.viewing')) el.classList.remove('viewing');
});

$('dCopy').addEventListener('click', () => {
  const r = state.detail;
  $('detailDialog').close();
  openBooking({ mode: 'create', copyFrom: r });
});

function editFromDetail() {
  const pin = $('dPin').value.trim();
  if (!$('dOps').hidden && !pin) { $('dError').textContent = '変更するには編集用パスワードを入力してください。'; $('dPin').focus(); return; }
  $('detailDialog').close();
  openBooking({ mode: 'edit', reservation: state.detail, pin });
}

async function submitCancel(e) {
  e.preventDefault();
  const pin = $('dPin').value.trim();
  const err = $('dError');
  if (isOffline()) { err.textContent = OFFLINE_MSG; return; }
  if (!$('dOps').hidden && !pin) { err.textContent = '編集用パスワードを入力してください。'; $('dPin').focus(); return; }
  const series = !$('dSeriesArea').hidden && $('dSeries').checked;

  const r = state.detail;
  const scope = series ? 'following' : 'single';
  // 確かめの小窓は出さずに、すぐ画面から消す。サーバーへは UNDO_MS 待ってから送り、その間は「元に戻す」で取りやめられる
  const targets = series
    ? visibleReservations().filter((x) => x.groupId === r.groupId && x.date >= r.date)
    : [r];
  targets.forEach((x) => state.hidden.set(x.id, x.date));
  $('detailDialog').close();
  render();
  if (pendingCancel) pendingCancel.send(); // 前の取消がまだ待っていれば、先に送る
  const job = { sent: false };
  job.send = (keepalive) => {
    if (job.sent) return;
    job.sent = true;
    clearTimeout(job.timer);
    if (pendingCancel === job) pendingCancel = null;
    sendCancel(r, pin, scope, series, targets, keepalive);
  };
  job.timer = setTimeout(() => job.send(), UNDO_MS);
  pendingCancel = job;
  toast(series ? 'この日以降の予約を取り消しました' : '予約を取り消しました', '', UNDO_MS, {
    label: '元に戻す',
    run: () => {
      if (job.sent) return; // 送ったあとは戻せない（ちょうど時間切れのとき）
      job.sent = true;
      clearTimeout(job.timer);
      pendingCancel = null;
      targets.forEach((x) => state.hidden.delete(x.id));
      render();
      toast('予約を元に戻しました');
    },
  });
}

// 取消は、「元に戻す」を押せる間（5秒）待ってから送る。画面を閉じる・裏に回すときは、待たずにすぐ送る
// （iPhone は裏に回すと JS が止まり、そのまま閉じられると送られないため）
const UNDO_MS = 5000;
let pendingCancel = null;
document.addEventListener('visibilitychange', () => { if (document.hidden && pendingCancel) pendingCancel.send(true); });
window.addEventListener('pagehide', () => { if (pendingCancel) pendingCancel.send(true); });

async function sendCancel(r, pin, scope, series, targets, keepalive) {
  try {
    const res = await api('cancelReservation', { id: r.id, pin, scope }, { keepalive });
    if (!res || !res.ok) throw Object.assign(new Error((res && res.message) || '取り消しに失敗しました。'), { code: res && res.code });
    removeMine(res.cancelledIds);
    // 管理者のみの部屋・見えない部屋・終わった分は、サーバーが取り消さずに残す。画面にも戻して知らせる
    const kept = targets.filter((x) => !(res.cancelledIds || []).includes(x.id));
    if (res.cancelledIds && kept.length) {
      kept.forEach((x) => state.hidden.delete(x.id));
      render();
      toast(`${kept.length}件は取り消せないため、残しました`);
    }
    invalidate(series ? undefined : [r.date]); // くり返し予約は他の日にもまたがるのですべて取り直す
    load({ force: true });
  } catch (ex) {
    targets.forEach((x) => state.hidden.delete(x.id)); // 画面を取消前の状態に戻す
    if (ex instanceof AuthError) { render(); return; }
    const message = errMessage(ex);
    if (ex.code === 'NOT_FOUND') {
      removeMine([r.id]);
      toast(message);
      invalidate([r.date]);
      load({ force: true });
      return;
    }
    render();
    toast(message, 'error');
    if (!anyDialogOpen()) {
      openDetail(r.id);
      $('dPin').value = pin;
      $('dError').textContent = message;
    }
  }
}

// ---------------- カレンダーに追加 ----------------
// ボタンは1つ。iPhone はカレンダーのファイル（.ics）の URL を開くと標準のカレンダーに入る。Android は標準が Google カレンダーなので、その追加画面を開く
// 予約者の名前などは入れず、部屋と時間だけを書く（Google の URL に個人の情報を載せないため）
// 題名は部屋の名前だけ（設備のかっこ書きは付けない）。例: 練習室1の予約
const calRoom = (r, room) => (room ? room.name : r.roomId);
function calTitle(r, room) { return `${calRoom(r, room)}の予約`; }
const CAL_PLACE = '宮城教育大学 音楽棟';
/** 日本時間の日付と時刻を、カレンダーの書式（世界標準時 YYYYMMDDTHHMMSSZ）にする */
function calStamp(date, hhmm) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h - 9, mi)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
function googleCalendarUrl(r, room) {
  const q = new URLSearchParams({
    action: 'TEMPLATE', text: calTitle(r, room),
    dates: `${calStamp(r.date, r.start)}/${calStamp(r.date, r.end)}`,
    location: CAL_PLACE, details: location.origin + location.pathname,
  });
  return 'https://calendar.google.com/calendar/render?' + q.toString();
}
/**
 * iPhone 用: 高速キャッシュ（Cloudflare）の /ics の URL。Safari でこの URL を開くと、ダウンロードを挟まずに
 * 「カレンダーに追加」の画面がそのまま出る。高速キャッシュを使っていないときは '' を返し、下のファイル作成に切り替える
 */
function icsUrl(r, room) {
  if (!window.CACHE_API_URL) return '';
  const q = new URLSearchParams({ id: r.id, room: calRoom(r, room), date: r.date, start: r.start, end: r.end, site: location.origin + location.pathname });
  return window.CACHE_API_URL.replace(/\/$/, '') + '/ics?' + q.toString();
}
/** iPhone のカレンダーに読み込めるファイル（.ics）を作って開く（高速キャッシュがないときの予備）。開始15分前に知らせる */
function downloadIcs(r, room) {
  const icsText = (t) => String(t).replace(/[\\;,]/g, (c) => '\\' + c);
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//miyakyo-music//yoyaku//JA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${r.id}@miyakyo-music.github.io`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
    `DTSTART:${calStamp(r.date, r.start)}`, `DTEND:${calStamp(r.date, r.end)}`,
    `SUMMARY:${icsText(calTitle(r, room))}`, `LOCATION:${icsText(CAL_PLACE)}`,
    `DESCRIPTION:${icsText(location.origin + location.pathname)}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:練習室の予約', 'TRIGGER:-PT15M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = `練習室予約_${r.date}.ics`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const IS_ANDROID = /Android/i.test(navigator.userAgent);
$('dCalAdd').addEventListener('click', (e) => {
  const r = state.detail;
  if (!r || $('dCalAdd').getAttribute('href') !== '#') return; // URL があれば、そのまま開く
  e.preventDefault();
  downloadIcs(r, state.rooms.find((x) => x.id === r.roomId));
});

$('detailForm').addEventListener('submit', submitCancel);
$('dEdit').addEventListener('click', editFromDetail);
