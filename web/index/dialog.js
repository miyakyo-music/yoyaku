// 予約表: 小窓の共通の動き（開き方・後ろを暗くする・改行キー・パスワードの表示・古いブラウザの代わり）
'use strict';

// 小窓の中身のうち、下端のボタン（.actions）より前を .dlg-main に包む（スクロールするのはこの中だけ）
for (const box of document.querySelectorAll('dialog > form, dialog > .body')) {
  const act = box.querySelector(':scope > .actions');
  if (!act) continue;
  const main = document.createElement('div');
  main.className = 'dlg-main';
  while (box.firstChild !== act) main.appendChild(box.firstChild);
  box.insertBefore(main, act);
}
// <dialog> 非対応ブラウザ（iOS/iPadOS 15.3以前の Safari など）では簡易的な代替実装を使う
const dialogs = [...document.querySelectorAll('dialog')];
if (typeof HTMLDialogElement !== 'function' || !HTMLDialogElement.prototype.showModal || location.hash === '#nodialog') {
  document.body.classList.add('dialog-fallback');
  const syncBackdrop = () => document.body.classList.toggle('modal-open', dialogs.some((d) => d.hasAttribute('open')));
  for (const d of dialogs) {
    Object.defineProperty(d, 'open', { configurable: true, get() { return this.hasAttribute('open'); } });
    d.showModal = function () { this.setAttribute('open', ''); syncBackdrop(); };
    d.close = function () { if (!this.hasAttribute('open')) return; this.removeAttribute('open'); syncBackdrop(); this.dispatchEvent(new Event('close')); };
  }
  $('dialogBackdrop').addEventListener('click', () => dialogs.filter((d) => d.id !== 'loginDialog').forEach((d) => d.close()));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dialogs.filter((d) => d.id !== 'loginDialog').forEach((d) => d.close()); });
}
// 小窓を開くとき、直前に押した位置（1.5秒以内）から広がるように、画面中央からのずれを渡す。
// キーボード操作などで押した位置がないときは、中央から広がる。
let lastPoint = null;
const notePoint = (e) => { lastPoint = { x: e.clientX, y: e.clientY, t: Date.now() }; };
document.addEventListener('pointerdown', notePoint, true);
document.addEventListener('pointerup', notePoint, true);
if (!document.body.classList.contains('dialog-fallback')) {
  for (const d of dialogs) {
    const show = d.showModal;
    d.showModal = function () {
      const p = lastPoint && Date.now() - lastPoint.t < 1500 ? lastPoint : null;
      this.style.setProperty('--dx', p ? `${Math.round(p.x - innerWidth / 2)}px` : '0px');
      this.style.setProperty('--dy', p ? `${Math.round(p.y - innerHeight / 2)}px` : '0px');
      return show.call(this);
    };
  }
}
for (const dlg of dialogs) {
  dlg.addEventListener('click', (e) => {
    if ((e.target === dlg && dlg.id !== 'loginDialog') || (e.target.hasAttribute && e.target.hasAttribute('data-close'))) {
      if (dlg.id === 'detailDialog') closeDetail(); else dlg.close();
    }
  });
}

// 入力欄で改行キー（iPhone のキーボードの「改行」も含む）を押しても送信しない。
// 予約・取消・不具合報告は、ボタンを押したときだけ送信する（入力途中で予約が確定してしまうのを防ぐ）。
// 予約画面では次の入力欄へ移り、最後の欄ではキーボードを閉じる。
for (const form of [$('bookForm'), $('detailForm'), $('bugForm')]) {
  const fields = () => [...form.querySelectorAll('input:not([type=checkbox]):not([type=radio]), select, textarea')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
  for (const el of form.querySelectorAll('input:not([type=checkbox]):not([type=radio])')) el.enterKeyHint = 'next';
  for (const id of ['bPin', 'bAdmin', 'dPin', 'bugContact']) $(id).enterKeyHint = 'done';
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT' || ['checkbox', 'radio'].includes(e.target.type)) return;
    if (e.isComposing || e.keyCode === 229) return; // 日本語入力の変換確定
    e.preventDefault();
    const list = fields().filter((el) => el.tagName === 'INPUT' && el.type !== 'date'); // 日付欄に移ると選択画面が開くので飛ばす
    const next = list[list.indexOf(e.target) + 1];
    if (next && form.id === 'bookForm') next.focus();
    else e.target.blur();
  });
}

// パスワード欄に「表示」ボタンを付け、ダイアログを閉じたら伏せ字に戻す（web/api.js）
addRevealButtons(document);
for (const dlg of dialogs) dlg.addEventListener('close', () => hideSecrets(dlg));

const anyDialogOpen = () => dialogs.some((d) => d.open);
// 小窓が開いている間は、画面の本体を少し暗くする（index/page.css の html.dlg-open .page）
// 上部は、閉じたあと帯へ戻る動き（0.46秒）と暗さの戻り（0.3秒）が終わるまで不透明のままにする（hdr-solid。
// 途中で半透明に戻すと、iPhone の Safari で上部のぼかしが効かず、表が透けて見えた。0.36秒では帯へ戻る動きの途中で透けた）
let solidTimer = 0;
const syncDepth = () => {
  const open = anyDialogOpen(), root = document.documentElement;
  root.classList.toggle('dlg-open', open);
  clearTimeout(solidTimer);
  if (open) root.classList.add('hdr-solid');
  else solidTimer = setTimeout(() => root.classList.remove('hdr-solid'), 520); // 帯へ戻る 0.46秒＋少し
};
const depthWatch = new MutationObserver(syncDepth);
for (const d of dialogs) depthWatch.observe(d, { attributes: true, attributeFilter: ['open'] });

// キーボードが出ている間は、開いている小窓を「見えている範囲」（visualViewport）に収め、下端の「予約確定」などを隠さない。
// iPhone の Safari は、キーボードを出すとページ全体を上へずらして入力欄を見せるが、小窓（position: fixed）は
// ずれる前の画面の真ん中に残るので、下端がキーボードの裏に入る。そこで小窓の高さを見えている範囲までに抑え、
// はみ出す分だけ上下に動かす（translate。開く動きの transform とは別の指定）。
// 縮めた分だけ中身（.dlg-main）をスクロールし、押した入力欄が画面の同じ位置に残るようにする
// （以前、小窓を縮めるだけにしたときは、入力欄が下のボタンの裏へずれて不評だった）。
let kbFit = null; // 収めている小窓
const fitKeyboard = () => {
  const vv = window.visualViewport;
  if (!vv || document.body.classList.contains('dialog-fallback')) return;
  const dlg = dialogs.find((d) => d.open) || null;
  const layoutH = document.documentElement.clientHeight;
  // キーボードが出ている（見えている高さが 80px 以上減った）ときだけ。指で拡大しているときは触らない
  const on = dlg && vv.scale < 1.01 && vv.height < layoutH - 80;
  if (kbFit && (kbFit !== dlg || !on)) {
    // 閉じた小窓は、縮んで消える動き（0.2秒）が終わってから元に戻す（途中で真ん中へ跳ばないように）
    const d = kbFit;
    kbFit = null;
    setTimeout(() => { if (kbFit !== d) { d.style.maxHeight = ''; d.style.translate = ''; } }, d.open ? 0 : 250);
  }
  if (!on) return;
  const field = dlg.contains(document.activeElement) && document.activeElement.closest('.dlg-main') ? document.activeElement : null;
  const before = field && !kbFit ? field.getBoundingClientRect().top : null;
  dlg.style.maxHeight = `${Math.floor(vv.height - 16)}px`;
  // 小窓は画面の真ん中に置かれている。見えている範囲からはみ出す分だけ動かす（収まっていれば動かさない）
  const h = dlg.offsetHeight, top0 = (layoutH - h) / 2;
  const visTop = vv.offsetTop + 8, visBottom = vv.offsetTop + vv.height - 8;
  const dy = top0 + h > visBottom ? visBottom - (top0 + h) : top0 < visTop ? visTop - top0 : 0;
  dlg.style.translate = dy ? `0 ${Math.round(dy)}px` : '';
  kbFit = dlg;
  if (!field) return;
  const main = field.closest('.dlg-main'), act = dlg.querySelector('.actions');
  const r = field.getBoundingClientRect();
  let shift = before === null ? 0 : r.top - before; // 押した欄を元の位置へ
  const bottom = (act ? act.getBoundingClientRect().top : main.getBoundingClientRect().bottom) - 8;
  if (r.bottom - shift > bottom) shift = r.bottom - bottom; // ボタンの裏に入るなら、その上まで
  const top = main.getBoundingClientRect().top + 8;
  if (r.top - shift < top) shift = r.top - top;
  if (shift) main.scrollTop += shift;
};
if (window.visualViewport) {
  visualViewport.addEventListener('resize', fitKeyboard);
  visualViewport.addEventListener('scroll', fitKeyboard);
  const kbWatch = new MutationObserver(fitKeyboard);
  for (const d of dialogs) kbWatch.observe(d, { attributes: true, attributeFilter: ['open'] });
}
