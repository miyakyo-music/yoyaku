// 予約表: 予約画面の開始・終了の時刻を選ぶホイール
'use strict';

// ---------------- 予約・変更ダイアログ ----------------
function fillTimeSelects(hSel, mSel) {
  const s = state.settings;
  const open = toMin(s.openTime), close = toMin(s.closeTime);
  hSel.innerHTML = '';
  for (let h = Math.floor(open / 60); h <= Math.floor(close / 60); h++) hSel.add(new Option(String(h), String(h)));
  mSel.innerHTML = '';
  for (let m = 0; m < 60; m += s.unitMinutes) mSel.add(new Option(pad(m), String(m)));
  syncWheel(hSel); syncWheel(mSel);
}

// ---------------- 時刻のホイール（予約画面の開始・終了） ----------------
// 選択欄（select）はデータの入れ物として残して隠し、その隣に指・マウス・キーで回せるホイールを置く。
// ホイールを回すと選択欄の値を変えて change を送るので、ほかの処理は選択欄だけを見ればよい。
// 表示する段の数は、画面の高さに合わせて CSS で 5段／3段を切り替える（--wheel-rows）。
const WHEEL_ITEM = 34; // 1段の高さ（CSS の .twheel .item と同じ）
function syncWheel(sel) { if (sel.wheel) sel.wheel.sync(); }
function makeWheel(sel) {
  const el = document.createElement('div');
  el.className = 'twheel';
  el.tabIndex = 0;
  el.setAttribute('role', 'spinbutton');
  el.setAttribute('aria-label', sel.getAttribute('aria-label') || '');
  sel.after(el);
  sel.hidden = true;
  sel.parentNode.classList.add('has-wheel');
  let items = [], index = -1, raf = 0, sig = '', changeTimer = 0;
  // 回し直し中（sync で位置を合わせている最中）は、読み取った位置で値を書き戻さない。
  // 小窓が開く動きの最中などは、指定した位置へすぐには動かず、古い位置を読んで値が元に戻ることがあったため
  let syncing = false;

  const setScroll = (i, smooth) => el.scrollTo({ top: i * WHEEL_ITEM, behavior: smooth ? 'smooth' : 'auto' });
  // 指定した段へ、吸い付き（scroll-snap）を止めてから一気に動かす。iPhone の Safari は、前に止まっていた段を覚えていて、
  // 予約画面が開く動きの最中などに、その段へ勝手に戻すことがある（前回の「23時」に戻り、触れたときにその値が入っていた）
  let jumps = 0, settleTimer = 0;
  function jump(i) {
    el.style.scrollSnapType = 'none';
    el.scrollTop = i * WHEEL_ITEM;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.style.scrollSnapType = '';
      if (syncing) el.scrollTop = index * WHEEL_ITEM;
    }));
  }
  function paint() {
    raf = 0;
    const pos = el.scrollTop / WHEEL_ITEM;
    const now = Math.round(pos);
    items.forEach((it, i) => {
      // 真ん中から離れた数字ほど奥へ傾けて薄くし、ドラムのように見せる。
      // 円筒に巻いたときの位置まで真ん中へ寄せる（傾けて小さくなった分、端の段だけ間が空いて見えないように）
      const d = i - pos;
      const a = Math.max(-1, Math.min(1, d / 2.6));
      const R = 2.72; // 円筒の半径（段の高さの何倍か）。1段あたり約21度
      const ty = (R * Math.sin(Math.max(-1.45, Math.min(1.45, d / R))) - d) * WHEEL_ITEM;
      it.style.transform = `translateY(${ty.toFixed(2)}px) perspective(300px) rotateX(${-a * 55}deg) scale(${1 - Math.abs(a) * .12})`;
      it.style.opacity = String(1 - Math.min(1, Math.abs(i - pos) / 3) * .75);
      it.classList.toggle('sel', i === now);
    });
    if (syncing) {
      // 合わせ直しの間（開いてから少しの間）は値を書き戻さず、別の段へ戻されたら指定した段へ動かし直す
      if (now !== index && jumps < 20) { jumps++; jump(index); }
      return;
    }
    if (now !== index && now >= 0 && now < items.length) {
      index = now;
      el.setAttribute('aria-valuetext', items[now].textContent);
      if (sel.selectedIndex !== now) {
        sel.selectedIndex = now;
        // 遠い段へ一気に回すと、途中の段ごとに change が飛んで画面を何度も描き直してしまう。
        // 止まってから1回だけ送る（その前に次の段へ動いたら、やり直す）
        clearTimeout(changeTimer);
        changeTimer = setTimeout(() => sel.dispatchEvent(new Event('change', { bubbles: true })), 120);
      }
    }
  }
  // 回し終わったのに段の途中で止まっていたら、近い段へ寄せる（iPhone の Safari は、吸い付き〈scroll-snap〉を
  // いったん止めて戻したあとなどに、段の途中で止まったままになることがある）。指が触れている間は寄せない
  let touching = false, alignTimer = 0;
  function alignLater() {
    clearTimeout(alignTimer);
    alignTimer = setTimeout(() => {
      if (touching || dragY !== null || !el.offsetParent) return;
      const off = el.scrollTop / WHEEL_ITEM;
      if (Math.abs(off - Math.round(off)) > 0.02) setScroll(Math.max(0, Math.min(items.length - 1, Math.round(off))), true);
    }, 180);
  }
  el.addEventListener('touchstart', () => { touching = true; clearTimeout(alignTimer); }, { passive: true });
  el.addEventListener('touchend', () => { touching = false; alignLater(); }, { passive: true });
  el.addEventListener('touchcancel', () => { touching = false; alignLater(); }, { passive: true });
  el.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(paint); alignLater(); }, { passive: true });
  // 触れたら合わせ直しをやめて、指の動きに任せる。まだ指定した段に着いていなければ、先にそこへ動かす
  // （ずれた段のまま触れると、その段の値が書き込まれてしまうため）
  for (const type of ['pointerdown', 'touchstart', 'wheel', 'keydown']) {
    el.addEventListener(type, () => {
      if (syncing && index >= 0 && Math.round(el.scrollTop / WHEEL_ITEM) !== index) {
        el.style.scrollSnapType = '';
        el.scrollTop = index * WHEEL_ITEM;
      }
      syncing = false;
    }, { passive: true });
  }
  // 数字を押すと、その数字まで回る
  let dragY = null, startTop = 0, moved = false;
  el.addEventListener('click', (e) => {
    if (moved) return;
    const it = e.target.closest('.item');
    if (it) setScroll(items.indexOf(it), true);
  });
  // PC: マウスでつかんで上下にドラッグ（指はふつうのスクロールでそのまま回る）
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    dragY = e.clientY; startTop = el.scrollTop; moved = false;
    el.setPointerCapture(e.pointerId); el.classList.add('dragging');
  });
  el.addEventListener('pointermove', (e) => {
    if (dragY === null) return;
    if (Math.abs(e.clientY - dragY) > 3) moved = true;
    el.scrollTop = startTop - (e.clientY - dragY);
  });
  const endDrag = () => {
    if (dragY === null) return;
    dragY = null; el.classList.remove('dragging');
    setScroll(Math.round(el.scrollTop / WHEEL_ITEM), true);
    setTimeout(() => { moved = false; }, 0);
  };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
  // キー: ↑↓ で1つ、PageUp/PageDown で3つ、Home/End で端まで
  el.addEventListener('keydown', (e) => {
    const step = { ArrowUp: -1, ArrowDown: 1, PageUp: -3, PageDown: 3 }[e.key];
    let to = step ? index + step : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    setScroll(Math.max(0, Math.min(items.length - 1, to)), true);
  });

  sel.wheel = {
    /** 選択欄の選択肢・値に合わせて、ホイールを作り直す・回し直す（change は送らない） */
    sync() {
      clearTimeout(changeTimer); // 前の操作の change が、合わせ直しのあとに遅れて届かないように
      const nextSig = [...sel.options].map((o) => o.text).join('|');
      if (nextSig !== sig) {
        sig = nextSig;
        el.innerHTML = '<div class="pad"></div>' + [...sel.options].map((o) => `<div class="item">${esc(o.text)}</div>`).join('') + '<div class="pad"></div>';
        items = [...el.querySelectorAll('.item')];
      }
      index = sel.selectedIndex;
      el.setAttribute('aria-valuetext', items[index] ? items[index].textContent : '');
      // 予約画面が閉じている間は回せない（位置が 0 のまま読めてしまい、値を書き戻すおそれがある）ので、開いてから合わせる
      if (!el.offsetParent) return;
      syncing = true;
      jumps = 0;
      jump(Math.max(0, index));
      // 開く動き（0.4秒ほど）が終わって落ち着くまで見張り、指定した段にいることを確かめてから、指で回した値を受け付ける
      clearTimeout(settleTimer);
      const settle = (tries) => {
        if (!syncing) return;
        if (el.offsetParent && Math.round(el.scrollTop / WHEEL_ITEM) !== index && tries < 5) {
          jump(index);
          settleTimer = setTimeout(() => settle(tries + 1), 300);
          return;
        }
        syncing = false;
      };
      settleTimer = setTimeout(() => settle(0), 700);
      paint();
    },
    focus() { el.focus(); },
  };
  sel.wheel.sync();
}
for (const sel of document.querySelectorAll('#bookDialog .time select')) makeWheel(sel);
// 時刻の欄を自分で回したか（帯を動かしたときの利用時間の確認に使う）
for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
  $('bookDialog').addEventListener(type, (e) => { if (state.booking && e.target.closest && e.target.closest('.twheel')) state.booking.timeTouched = true; }, { passive: true });
}

function setTime(hSel, mSel, min) {
  // 選択肢にない時刻（予約単位の刻みでない・利用時間の外）は、欄が空になって0時と読まれるので、選べる時刻に寄せる
  const s = state.settings, u = s.unitMinutes;
  min = Math.max(ceilTo(toMin(s.openTime), u), Math.min(floorTo(toMin(s.closeTime), u), ceilTo(min, u)));
  hSel.value = String(Math.floor(min / 60)); mSel.value = String(min % 60);
  syncWheel(hSel); syncWheel(mSel);
}
function getTime(hSel, mSel) { return Number(hSel.value) * 60 + Number(mSel.value); }
