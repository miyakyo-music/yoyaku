// 予約表: 帯と小窓をつなぐ動き（View Transitions）
'use strict';

// ---------------- 帯と小窓をつなぐ動き（View Transitions） ----------------
// 予約の帯を押すと、その帯が形を変えながら小窓になり、閉じると帯へ戻る。予約を確定すると、小窓が新しい帯へ縮む。
// 対応していない端末（iOS 17 以前など）や「視差効果を減らす」の端末では、今まで通りの開き方・閉じ方になる。
const VT_OK = typeof document.startViewTransition === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
function onScreen(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
}
function bandEl(id) { return id ? $('main').querySelector(`.blk.res[data-id="${CSS.escape(id)}"]`) : null; }
/** from（いまの画面の要素）が、update したあとの getTo() の要素へ形を変えて移る。from が見えていなければ普通に切り替える */
function morph(from, update, getTo) {
  if (!VT_OK || !onScreen(from)) { update(); return; }
  let to = null;
  from.style.viewTransitionName = 'morph';
  document.body.classList.add('vt-morph');
  document.documentElement.classList.add('vt-morph');
  document.documentElement.classList.toggle('vt-close', from.tagName === 'DIALOG'); // 小窓 → 帯の向き
  const t = document.startViewTransition(() => {
    from.style.viewTransitionName = '';
    update();
    to = getTo();
    if (to && (to.tagName === 'DIALOG' ? to.open : onScreen(to))) to.style.viewTransitionName = 'morph';
    else { to = null; document.documentElement.classList.add('vt-noto'); } // 行き先がないときは、その場で薄く消す（CSS）
  });
  t.ready.then(() => {
    if (!to) return; // 行き先がないときは、その場で薄く消す（CSS の vt-noto）
    // 外側の枠（group）に、角の丸みと影を足して育てる（CSS で group の animation を書くと、ブラウザが作る位置・大きさの動きを消してしまうため）
    const css = getComputedStyle(document.documentElement);
    const band = css.getPropertyValue('--morph-shadow-band').trim(), dlg = css.getPropertyValue('--morph-shadow-dialog').trim();
    const closing = from.tagName === 'DIALOG';
    try {
      document.documentElement.animate([
        { boxShadow: closing ? dlg : band, borderRadius: closing ? '22px' : '9px' },
        { boxShadow: closing ? band : dlg, borderRadius: closing ? '9px' : '22px' },
      ], { duration: 460, easing: 'cubic-bezier(.28, 1.12, .4, 1)', fill: 'both', pseudoElement: '::view-transition-group(morph)' });
    } catch (e) { /* 影を付けられない環境では、影なしで動かす */ }
  }).catch(() => {}); // 画面が隠れているときなどは動きだけ省かれる（切り替えそのものは行われる）
  t.finished.finally(() => {
    from.style.viewTransitionName = '';
    if (to) to.style.viewTransitionName = '';
    document.body.classList.remove('vt-morph');
    document.documentElement.classList.remove('vt-close', 'vt-noto', 'vt-morph');
  });
}
