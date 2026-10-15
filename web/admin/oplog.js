// 管理画面: 変更履歴（サーバーの操作ログを新しい順に。種類と検索語で絞り、日ごとにまとめて出す）
'use strict';

// ---------------- 変更履歴 ----------------
const oplog = { entries: [], next: 0, more: false, kind: '', q: '', seq: 0 };
const OPLOG_KIND_CLS = { book: 'k-book', change: 'k-change', cancel: 'k-cancel', admin: 'k-admin' };
// 種類の決め方は gas/Code.gs の logKind_ と同じ
function oplogKind(e) {
  if (!e.resId) return 'admin';
  if (/取消|削除/.test(e.action)) return 'cancel';
  if (/変更/.test(e.action)) return 'change';
  return 'book';
}
async function loadOplog(append) {
  const seq = ++oplog.seq; // 検索語を打ち変えている途中の、古い応答は捨てる
  $('oplogError').textContent = '';
  $('oplogMore').disabled = true;
  if (!append) $('oplogList').innerHTML = '<p class="empty">読み込み中…</p>';
  try {
    const res = await api('adminGetLog', { kind: oplog.kind, q: oplog.q, before: append ? oplog.next : 0 });
    if (seq !== oplog.seq) return;
    if (!res.ok) throw new Error(res.message);
    oplog.entries = append ? oplog.entries.concat(res.entries) : res.entries;
    oplog.next = res.next;
    oplog.more = res.more;
    renderOplog();
  } catch (ex) {
    if (seq !== oplog.seq) return;
    if (!append) $('oplogList').innerHTML = '';
    $('oplogError').textContent = errMessage(ex);
  }
  $('oplogMore').disabled = false;
}
function oplogRoomName(id) {
  const r = ((state.data && state.data.rooms) || state.rooms).find((x) => x.id === id);
  return r ? r.name : id;
}
// 詳細の中の部屋 ID と日付（2026-10-13）を、読みやすい形（部屋名・10/13）にする
function oplogDetail(t) {
  return String(t).replace(/\b(\d{4})-(\d\d)-(\d\d)\b/g, (m, y, mo, d) => `${Number(mo)}/${Number(d)}`)
    .replace(/[^\s:：/,、]+/g, (w) => oplogRoomName(w));
}
function renderOplog() {
  let day = '';
  let html = '';
  for (const e of oplog.entries) {
    const d = String(e.at).slice(0, 10);
    if (d !== day) {
      if (day) html += '</div>';
      day = d;
      const l = /^\d{4}-\d\d-\d\d$/.test(d) ? dateLabel(d) : { text: d, cls: '' };
      html += `<h3 class="log-day ${l.cls}">${esc(l.text)}</h3><div class="log-group">`;
    }
    const kind = oplogKind(e);
    let body;
    if (kind === 'admin') {
      body = e.detail ? `<div class="log-detail">${esc(e.detail)}</div>` : '';
    } else {
      const when = /^\d{4}-\d\d-\d\d$/.test(e.date) ? dateLabel(e.date).text.replace(/^\d+\//, '') : e.date;
      body = `<div class="log-res">${esc(when)} ${esc(oplogRoomName(e.roomId))} ${esc(String(e.time).replace(/(^|〜)0(\d)/g, '$1$2'))}</div>`
        + `<div class="log-who">${esc(e.who)}</div>`
        + (e.detail ? `<div class="log-detail">${esc(oplogDetail(e.detail))}</div>` : '');
    }
    html += `<div class="log-item"><span class="log-time">${esc(hm(String(e.at).slice(11, 16)))}</span>`
      + `<div class="log-body"><span class="log-tag ${OPLOG_KIND_CLS[kind]}">${esc(e.action)}</span>${body}</div></div>`;
  }
  if (day) html += '</div>';
  $('oplogList').innerHTML = html || `<p class="empty">${oplog.q || oplog.kind ? '当てはまる記録はありません。' : '記録はまだありません。'}</p>`;
  $('oplogMore').hidden = !oplog.more;
}
$('oplogKind').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-kind]');
  if (!b) return;
  for (const x of $('oplogKind').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
  oplog.kind = b.dataset.kind;
  loadOplog(false);
});
let oplogTimer;
$('oplogQuery').addEventListener('input', () => {
  clearTimeout(oplogTimer);
  oplogTimer = setTimeout(() => {
    const q = $('oplogQuery').value.trim();
    if (q === oplog.q) return;
    oplog.q = q;
    loadOplog(false);
  }, 400);
});
$('oplogQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('oplogMore').addEventListener('click', () => loadOplog(true));
$('oplogReload').addEventListener('click', () => loadOplog(false));
