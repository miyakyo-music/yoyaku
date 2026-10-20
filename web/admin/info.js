// 管理画面: i ボタン（説明の吹き出し）
'use strict';

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
// 読み上げの名前を「項目名の説明」にする（全部「説明」だと、どの項目の説明か分からない）
function nameTip(b) {
  if (b.dataset.named) return;
  b.dataset.named = '1';
  const item = (b.parentElement ? b.parentElement.textContent : '').replace(b.textContent, '').trim();
  if (item) b.setAttribute('aria-label', item + 'の説明');
}
document.querySelectorAll('.info').forEach(nameTip);
// キーボード（Tab）で選んだときも説明を出す。ほかへ移ると消える
document.addEventListener('focusin', (e) => {
  const b = e.target.closest && e.target.closest('.info');
  if (!b) return;
  nameTip(b);
  if (!b.matches(':focus-visible') || tipFor === b) return;
  closeTip();
  const r = b.getBoundingClientRect();
  showTip(b, r.left, r.bottom - 10);
});
document.addEventListener('focusout', (e) => {
  if (tipFor && e.target === tipFor) closeTip();
});
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
