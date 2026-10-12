// 管理画面: タブの切り替え（白いつまみ）と、「未保存の変更があります」の印
'use strict';

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

// ---------------- タブ・共通 ----------------
for (const t of document.querySelectorAll('.tabs [data-tab]')) {
  t.addEventListener('click', () => {
    for (const x of document.querySelectorAll('.tabs [data-tab]')) x.setAttribute('aria-selected', String(x === t));
    for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== t.dataset.tab || p.dataset.unsupported === '1';
    placeTabThumb();
    if (t.dataset.tab === 'bugs') loadBugs();
    if (t.dataset.tab === 'setup') pkRefresh();
    if (t.dataset.tab === 'stats') loadStats();
    if (t.dataset.tab === 'oplog') loadOplog(false);
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
