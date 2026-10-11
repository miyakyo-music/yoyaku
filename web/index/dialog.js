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
