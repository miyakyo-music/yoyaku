// 管理画面: 不具合報告の一覧と状態の変更
'use strict';

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
    renderBugs(); // 選択欄を元の状態に戻す
  }
});
$('loginForm').addEventListener('submit', (e) => { e.preventDefault(); login($('loginPw').value); });
