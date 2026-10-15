// 予約表: PC で予約の帯にマウスを乗せたときの詳細カード
'use strict';

// ---------------- 予約の帯の詳細カード（PC でマウスを乗せたとき） ----------------
// スマホ（タップ）では出さず、今までどおり予約の詳細画面を開く。表示する項目と書き方は詳細画面とそろえる
if (window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches) {
  const card = $('hoverCard');
  let hoverTimer = null;
  let hoverBlk = null;
  const hideCard = () => { clearTimeout(hoverTimer); hoverBlk = null; card.hidden = true; };
  const showCard = (blk, x, y) => {
    const r = state.data && visibleReservations().find((v) => v.id === blk.dataset.id);
    if (!r || anyDialogOpen() || drag || mouse || move) return;
    const room = roomById(r.roomId);
    const mine = Object.prototype.hasOwnProperty.call(getMine(), r.id) || r.pending;
    card.innerHTML =
      `<div class="hc-time">${esc(mdLabel(r.date))} ${esc(hm(r.start))} 〜 ${esc(hm(r.end))}（${esc(durationLabel(toMin(r.end) - toMin(r.start)))}）</div>` +
      `<div class="hc-name">${r.groupId ? '↻ ' : ''}${esc(r.name)}</div>` +
      (r.affiliation ? `<div class="hc-aff">${esc(r.affiliation)}</div>` : '') +
      '<dl class="summary">' +
      `<dt>部屋</dt><dd><span class="hc-dot${mine ? ' mine' : ''}"></span>${esc(room ? roomText(room) : r.roomId)}${mine ? '・この端末の予約' : ''}</dd>` +
      (r.memo ? `<dt>備考</dt><dd>${esc(r.memo)}</dd>` : '') +
      (r.pending ? '<dt>状態</dt><dd>送信中</dd>' : '') +
      '</dl>';
    card.hidden = false;
    placeCard(x, y);
  };
  // マウスの右下に出し、画面からはみ出す場合は反対側に回す（マウスを動かすとついてくる）
  let lastX = 0, lastY = 0;
  const placeCard = (x, y) => {
    const w = card.offsetWidth, h = card.offsetHeight, m = 8;
    const left = x + 14 + w > window.innerWidth - m ? Math.max(m, x - 14 - w) : x + 14;
    const top = y + 18 + h > window.innerHeight - m ? Math.max(m, y - 12 - h) : y + 18;
    card.style.transform = `translate(${left}px, ${top}px)`;
  };
  $('main').addEventListener('mousemove', (e) => {
    lastX = e.clientX; lastY = e.clientY;
    if (!card.hidden) placeCard(lastX, lastY);
  }, { passive: true });
  $('main').addEventListener('mouseover', (e) => {
    const blk = e.target.closest('.blk.res');
    if (blk === hoverBlk) return;
    hideCard();
    if (!blk) return;
    hoverBlk = blk;
    lastX = e.clientX; lastY = e.clientY;
    hoverTimer = setTimeout(() => showCard(blk, lastX, lastY), 300); // 300ms の間に動いた先に出す
  });
  $('main').addEventListener('mouseleave', hideCard);
  $('main').addEventListener('mousedown', hideCard);
  $('main').addEventListener('scroll', hideCard, { passive: true });
  $('main').addEventListener('wheel', hideCard, { passive: true });
}
