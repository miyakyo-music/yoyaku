// 予約表: マイページ（ログイン中の人の全画面のダッシュボード。仕様書 2.12）
// 上部の人型のボタン（ログイン中）から開き、URL に #my を付ける（ブラウザの「戻る」で閉じる）。
// 練習時間の期間別の集計、これからの予約、月ごとの練習時間、部屋・曜日ごとの内訳、これまでの予約、パスキー、ログアウト。
// 予約は userGetMine（本人の予約。過去の分も含む）を開くたびに読み直す。パスキーは高速キャッシュが動いているときだけ
// （index/user.js の userPkSupported）で、一覧・追加・削除には正本の許可証（userPasskeyTicket）を Worker に添える
'use strict';

state.me = null; // { reservations, rooms } 開いている間の読み込み結果
let mePeriod = 'month';
let mePastShown = 10;

const meDur = (r) => toMin(r.end) - toMin(r.start);
/** 時間の数字だけ（グラフの上に出す。1.5 のように小数1桁まで） */
const meHours = (m) => String(Math.round(m / 6) / 10);
const meTime = (m) => (m ? durationLabel(m) : '0分');

function openMePage() {
  const u = state.user;
  if (!u) return;
  $('meName').textContent = u.name;
  $('meSid').textContent = u.studentId;
  $('mePkSec').hidden = !userPkSupported;
  mePastShown = 10;
  if ($('mePage').hidden) {
    $('mePage').hidden = false;
    document.documentElement.classList.add('me-open');
    $('mePage').scrollTop = 0;
    if (location.hash !== '#my') history.pushState({ me: 1 }, '', '#my');
  }
  $('meTitle').focus({ preventScroll: true });
  meLoad();
  if (userPkSupported) meLoadPasskeys();
}
/** 閉じる（自分で開いた履歴なら「戻る」で閉じ、URL の #my も消す） */
function closeMePage() {
  if ($('mePage').hidden) return;
  if (history.state && history.state.me) { history.back(); return; }
  meHide();
  if (location.hash === '#my') history.replaceState(null, '', location.pathname + location.search);
}
function meHide() {
  $('mePage').hidden = true;
  document.documentElement.classList.remove('me-open');
}
window.addEventListener('popstate', () => {
  if (location.hash === '#my' && state.user) openMePage();
  else if (!$('mePage').hidden) meHide();
});
$('meBack').addEventListener('click', closeMePage);
// URL に #my を付けて開いたとき（ホーム画面から戻ったときなど）。ほかの部品を読み終えてから開く
if (location.hash === '#my') setTimeout(() => { if (state.user) openMePage(); else history.replaceState(null, '', location.pathname + location.search); }, 0);

async function meLoad() {
  if (!state.me) for (const id of ['meUpcoming', 'mePast']) $(id).innerHTML = '<li class="me-note">読み込み中…</li>';
  try {
    const res = await refreshUserMine(); // index/user.js（予約表の青い帯も合わせて読み直す）
    if (!res) return;
    if (!res.ok) throw new Error(res.message);
    state.me = { reservations: res.reservations, rooms: res.rooms };
    meRender();
  } catch (ex) {
    if (ex instanceof AuthError) return;
    $('meUpcoming').innerHTML = `<li class="me-note">${esc(errMessage(ex))}</li>`;
    $('mePast').innerHTML = '';
  }
}

function meRender() {
  const f = state.me;
  if (!f) return;
  const today = todayStr(), now = nowMin();
  const list = f.reservations;
  const ended = list.filter((r) => isEnded(r, today, now));
  const upcoming = list.filter((r) => !isEnded(r, today, now));

  // 期間ごとの練習時間（終わった分）と、前の期間の練習時間。押した期間で、下の内訳を切り替える。
  // 最後のタイルはこれからの予約の合計（期間ごとに残りの予定を出すと、どの期間も同じ数字が並ぶため1か所にまとめる）
  const inRange = (rs, { from, to }) => rs.filter((r) => r.date >= from && r.date <= to);
  const total = (rs) => rs.reduce((a, r) => a + meDur(r), 0);
  const periods = [['week', '今週', '先週'], ['month', '今月', '先月'], ['fy', '今年度', '前年度']];
  $('meTiles').innerHTML = periods.map(([p, label, prevLabel]) => {
    const done = inRange(ended, myPeriodRange(p)); // index/my.js
    const prev = total(inRange(ended, mePrevRange(p)));
    return `<button type="button" class="me-tile" data-p="${p}" aria-pressed="${p === mePeriod}"><span>${label}</span>` +
      `<b>${esc(meTime(total(done)))}</b>` +
      `<small>${done.length}回${prev ? `・${prevLabel} ${esc(meTime(prev))}` : ''}</small></button>`;
  }).join('') +
    `<div class="me-tile me-tile-plan"><span>これから</span><b>${esc(meTime(total(upcoming)))}</b><small>${upcoming.length}回</small></div>`;

  $('meUpcoming').innerHTML = upcoming.length ? upcoming.map((r) => meItem(r, f.rooms)).join('') : '<li class="me-note">予約はありません。</li>';
  meRenderMonthly(ended, today);
  meRenderBreak(ended);
  meRenderPast(ended.slice().reverse(), f.rooms);
}

/** 1つ前の期間（先週・先月・前年度） */
function mePrevRange(p) {
  const { from, to } = myPeriodRange(p);
  if (p === 'week') return { from: addDays(from, -7), to: addDays(to, -7) };
  if (p === 'month') return { from: addMonths(from, -1), to: addDays(from, -1) };
  return { from: `${Number(from.slice(0, 4)) - 1}-04-01`, to: `${Number(to.slice(0, 4)) - 1}-03-31` };
}

/** 予約1件の行（押すと予約表のその日を開いて詳細を出す） */
function meItem(r, rooms) {
  const room = rooms.find((x) => x.id === r.roomId);
  const self = state.user && r.name.replace(/\s+/g, '') === state.user.name;
  const sub = [room ? roomText(room) : r.roomId, self ? '' : r.name, r.groupId ? '↻まとめ予約' : ''].filter(Boolean).map(esc).join('　');
  return `<li><button type="button" data-date="${r.date}" data-id="${esc(r.id)}">` +
    `<b>${esc(mdLabel(r.date))} ${esc(hm(r.start))}〜${esc(hm(r.end))}</b><span>${sub}</span></button></li>`;
}

/** 月ごとの練習時間（今月までの12か月の縦棒） */
function meRenderMonthly(ended, today) {
  const months = [];
  for (let i = 11; i >= 0; i--) months.push(addMonths(today.slice(0, 8) + '01', -i).slice(0, 7));
  const sum = Object.fromEntries(months.map((m) => [m, 0]));
  for (const r of ended) { const m = r.date.slice(0, 7); if (m in sum) sum[m] += meDur(r); }
  const max = Math.max(1, ...Object.values(sum));
  $('meMonthly').innerHTML = '<div class="me-month">' + months.map((m) => {
    const v = sum[m];
    const mo = Number(m.slice(5));
    return `<div title="${esc(m.slice(0, 4))}年${mo}月 ${esc(meTime(v))}"><em>${v ? meHours(v) : ''}</em>` +
      `<i style="height:${(v / max * 100).toFixed(1)}%"></i><span${m === today.slice(0, 7) ? ' class="cur"' : ''}>${mo}</span></div>`;
  }).join('') + '</div><p class="me-unit">時間</p>';
}

/** 選んだ期間の内訳（部屋ごと・曜日ごと。終わった分） */
function meRenderBreak(ended) {
  const label = { week: '今週', month: '今月', fy: '今年度' }[mePeriod];
  $('meBreakTitle').textContent = `${label}の内訳`;
  const { from, to } = myPeriodRange(mePeriod);
  const done = ended.filter((r) => r.date >= from && r.date <= to);
  if (!done.length) { $('meBreak').innerHTML = '<p class="me-note">この期間に終わった予約はありません。</p>'; return; }
  const rooms = state.me.rooms;
  const byRoom = {};
  for (const r of done) byRoom[r.roomId] = (byRoom[r.roomId] || 0) + meDur(r);
  const roomRows = Object.entries(byRoom).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxRoom = roomRows[0][1];
  const byDow = [0, 0, 0, 0, 0, 0, 0];
  for (const r of done) byDow[weekday(r.date)] += meDur(r);
  const maxDow = Math.max(1, ...byDow);
  // 見た目は自分の予約の「練習時間」と同じ部品（index/my.css の ms-*）
  $('meBreak').innerHTML =
    '<p class="ms-h">部屋ごと</p><div class="ms-bars">' + roomRows.map(([id, m]) => {
      const rm = rooms.find((x) => x.id === id);
      return `<div class="ms-bar"><span>${esc(rm ? roomText(rm) : id)}</span><i style="width:${(m / maxRoom * 100).toFixed(1)}%"></i><em>${esc(meTime(m))}</em></div>`;
    }).join('') + '</div>' +
    '<p class="ms-h">曜日ごと</p><div class="ms-week">' + [1, 2, 3, 4, 5, 6, 0].map((w) =>
      `<div class="${w === 0 ? 'sun' : w === 6 ? 'sat' : ''}" title="${WEEKDAY_NAMES[w]}曜 ${esc(meTime(byDow[w]))}"><i style="height:${(byDow[w] / maxDow * 70).toFixed(1)}px"></i>${WEEKDAY_NAMES[w]}</div>`).join('') + '</div>';
}

/** これまでの予約（新しい順。月の変わり目に見出し。最初は10件、「さらに表示」で30件ずつ） */
function meRenderPast(past, rooms) {
  let month = '';
  $('mePast').innerHTML = !past.length ? '<li class="me-note">まだありません。</li>' : past.slice(0, mePastShown).map((r) => {
    const m = r.date.slice(0, 7);
    const head = m !== month ? `<li class="me-sep">${esc(m.slice(0, 4))}年${Number(m.slice(5))}月</li>` : '';
    month = m;
    return head + meItem(r, rooms);
  }).join('');
  $('meMore').hidden = past.length <= mePastShown;
}
$('meMore').addEventListener('click', () => {
  mePastShown += 30;
  const today = todayStr(), now = nowMin();
  meRenderPast(state.me.reservations.filter((r) => isEnded(r, today, now)).reverse(), state.me.rooms);
});
$('meTiles').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-p]');
  if (!b || !state.me) return;
  mePeriod = b.dataset.p;
  for (const x of $('meTiles').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
  const today = todayStr(), now = nowMin();
  meRenderBreak(state.me.reservations.filter((r) => isEnded(r, today, now)));
});
for (const id of ['meUpcoming', 'mePast']) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    // マイページを閉じ、予約表のその日を開いて詳細を出す（index/my.js）
    if (b) openReservationAt({ close: closeMePage }, b.dataset.date, b.dataset.id);
  });
}

// ---------------- パスキー ----------------
/** 正本から、パスキーの操作に使う許可証をもらう（有効5分） */
async function meTicket() {
  const t = await api('userPasskeyTicket', {});
  if (!t || !t.ok) throw new Error((t && t.message) || 'パスキーを扱えませんでした。');
  return t.ticket;
}
/** 登録したパスキーの一覧を読み直して出す */
async function meLoadPasskeys() {
  const ul = $('mePkList');
  ul.innerHTML = '<li class="me-note">読み込み中…</li>';
  try {
    const res = await upkCall('userList', { ticket: await meTicket() });
    const mine = load_(LS.userPk, '');
    const day = (t) => esc(String(t || '').slice(0, 10).replace(/-/g, '/'));
    // 名前は「iPhone（2026/11/10 登録）」の形で保存しているので、端末の種類だけを大きく出し、日付と「この端末」は下の行に
    ul.innerHTML = res.passkeys.map((p) =>
      `<li><div><b>${esc(String(p.name).replace(/（[^（]*登録）$/, '') || p.name)}</b>` +
      `<small>${[p.id === mine ? 'この端末' : '', p.created ? day(p.created) + ' 登録' : '', p.lastUsed ? '最後の使用 ' + day(p.lastUsed) : ''].filter(Boolean).join(' · ')}</small></div>` +
      `<button type="button" data-id="${esc(p.id)}" data-name="${esc(p.name)}">削除</button></li>`).join('');
  } catch (ex) {
    if (ex instanceof AuthError) { ul.innerHTML = ''; return; }
    ul.innerHTML = `<li class="me-note">${esc(errMessage(ex))}</li>`;
  }
}
$('mePkList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-id]');
  if (!btn || !state.user) return;
  if (!confirm(`パスキー「${btn.dataset.name}」を削除しますか？\nこのパスキーではログインできなくなります。端末に残ったパスキーは、端末の設定から削除してください。`)) return;
  if (isOffline()) { toast(OFFLINE_MSG, 'error'); return; }
  btn.disabled = true;
  try {
    await upkCall('userDelete', { ticket: await meTicket(), id: btn.dataset.id });
    if (btn.dataset.id === load_(LS.userPk, '')) { try { localStorage.removeItem(LS.userPk); } catch (ex) { /* 保存できない環境では何もしない */ } }
    toast('パスキーを削除しました');
    await meLoadPasskeys();
  } catch (ex) {
    btn.disabled = false;
    if (!(ex instanceof AuthError)) toast(errMessage(ex), 'error');
  }
});
$('mePkAdd').addEventListener('click', async () => {
  if (!state.user) return;
  const btn = $('mePkAdd');
  if (isOffline()) { toast(OFFLINE_MSG, 'error'); return; }
  btn.disabled = true;
  try {
    const ticket = await meTicket();
    const c = await upkCall('challenge');
    const label = `${state.user.name}（${state.user.studentId}）`; // パスキーの一覧に出る名前（ID は学籍番号と氏名）
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: new TextEncoder().encode(c.challenge),
      rp: { id: c.rpId, name: '練習室予約' },
      // 同じ人が同じ端末で登録し直したときは置き換わるよう、学籍番号から作る
      user: { id: new TextEncoder().encode('user:' + state.user.studentId), name: label, displayName: label },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none', timeout: 60000,
    } });
    const r = cred.response;
    if (typeof r.getPublicKey !== 'function') throw new Error('このブラウザではパスキーを登録できません。Safari・Chrome を新しくしてからお試しください。');
    await upkCall('userRegister', {
      ticket, name: upkDeviceName(), id: cred.id, publicKey: upkB64(r.getPublicKey()), alg: r.getPublicKeyAlgorithm(),
      clientDataJSON: upkB64(r.clientDataJSON), authenticatorData: upkB64(r.getAuthenticatorData()),
    });
    save_(LS.userPk, cred.id);
    toast('パスキーを登録しました');
    await meLoadPasskeys();
  } catch (ex) {
    if (!upkCancelled(ex) && !(ex instanceof AuthError)) toast(errMessage(ex), 'error');
  } finally {
    btn.disabled = false;
  }
});

$('meLogout').addEventListener('click', () => {
  if (!confirm('ログアウトしますか？')) return;
  logoutUser();
  toast('ログアウトしました');
});
