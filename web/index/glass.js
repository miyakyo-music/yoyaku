// 予約表: ガラスの見た目の補助と、光の屈折（Chrome など）
'use strict';

// ---------------- ガラスの見た目の補助 ----------------
// 表示の切り替えのつまみ（.seg::before）を、選択中のボタンの位置・幅に合わせる（CSS の transition で滑る）
// 最初に置くときだけは滑らせない
function placeSegThumb() {
  for (const seg of document.querySelectorAll('.seg')) {
    const on = seg.querySelector('[aria-pressed="true"]');
    if (!on) continue;
    seg.classList.toggle('no-anim', !seg.style.getPropertyValue('--thumb-w'));
    seg.style.setProperty('--thumb-x', `${on.offsetLeft}px`);
    seg.style.setProperty('--thumb-w', `${on.offsetWidth}px`);
  }
}
// 上部のガラスの帯の高さを実測し、予約表をその下に潜り込ませる余白（--hdr-h）にする
function measureHeader() {
  const h = document.querySelector('.topbar').offsetHeight;
  document.documentElement.style.setProperty('--hdr-h', `${h}px`);
  // 切り替えで上部の高さが変わったときもここに来る。つまみは止めずに滑らせたまま位置を合わせ直す
  placeSegThumb();
}
if (window.ResizeObserver) new ResizeObserver(measureHeader).observe(document.querySelector('.topbar'));
window.addEventListener('resize', measureHeader);

// ---------------- 光の屈折（ガラスの縁で、下の予約表が曲がって見える） ----------------
// 縁の近くほど強く内側の像を引き込む「ずらし地図」を Canvas で作り、SVG フィルタ（feDisplacementMap）として
// backdrop-filter に使う。これに対応しているのは Chrome・Edge などだけ。Safari（iPhone）では今まで通りぼかしのみ。
const canRefract = !!(navigator.userAgentData && navigator.userAgentData.brands.some((b) => /Chromium/.test(b.brand)))
  && !matchMedia('(prefers-reduced-transparency: reduce)').matches;
if (canRefract) {
  document.documentElement.classList.add('refract');
  const NS = 'http://www.w3.org/2000/svg';
  const defs = document.createElementNS(NS, 'svg');
  defs.setAttribute('width', '0'); defs.setAttribute('height', '0'); defs.setAttribute('aria-hidden', 'true');
  defs.style.position = 'absolute';
  document.body.appendChild(defs);

  // 角丸の四角の内側で、縁からの距離に応じた「内向きのずれ」を赤（横）・緑（縦）に入れた画像
  function lensMap(w, h, radius, bezel) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    const hw = w / 2, hh = h / 2, r = Math.min(radius, hw, hh);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // 角丸の四角までの符号付き距離（内側が負）と、外向きの向き
        const px = x + 0.5 - hw, py = y + 0.5 - hh;
        const qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r);
        let nx, ny, dist;
        if (qx > 0 && qy > 0) { const l = Math.hypot(qx, qy) || 1; dist = l - r; nx = qx / l; ny = qy / l; }
        else if (qx > qy) { dist = qx - r; nx = 1; ny = 0; }
        else { dist = qy - r; nx = 0; ny = 1; }
        nx *= Math.sign(px) || 1; ny *= Math.sign(py) || 1;
        const d = -dist; // 縁からの深さ
        const k = d < bezel ? Math.pow(1 - Math.max(0, d) / bezel, 2) : 0;
        const i = (y * w + x) * 4;
        img.data[i] = 128 - nx * k * 127;     // 内側の像を引き込む
        img.data[i + 1] = 128 - ny * k * 127;
        img.data[i + 2] = 128;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL();
  }

  const lenses = new Map(); // 要素 → { id, w, h }
  let seq = 0;
  function applyLens(el, { radius, bezel, strength, blur }) {
    const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
    if (!w || !h) return;
    let L = lenses.get(el);
    if (L && L.w === w && L.h === h) return;
    if (!L) { L = { id: `lens${++seq}` }; lenses.set(el, L); }
    L.w = w; L.h = h;
    defs.querySelector(`#${L.id}`)?.remove();
    const f = document.createElementNS(NS, 'filter');
    f.id = L.id;
    f.setAttribute('x', '0'); f.setAttribute('y', '0'); f.setAttribute('width', String(w)); f.setAttribute('height', String(h));
    f.setAttribute('filterUnits', 'userSpaceOnUse'); f.setAttribute('color-interpolation-filters', 'sRGB');
    f.innerHTML = `<feImage href="${lensMap(w, h, radius, bezel)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map"/>` +
      `<feDisplacementMap in="SourceGraphic" in2="map" scale="${strength}" xChannelSelector="R" yChannelSelector="G"/>`;
    defs.appendChild(f);
    el.style.setProperty('backdrop-filter', `url(#${L.id}) blur(${blur}px) saturate(180%)`);
  }
  const LENS = {
    topbar: { radius: 0, bezel: 30, strength: 80, blur: 3 },
    dialog: { radius: 22, bezel: 34, strength: 90, blur: 5 },
    card: { radius: 14, bezel: 22, strength: 60, blur: 2 },
  };
  const topbar = document.querySelector('.topbar');
  const refreshLenses = () => {
    applyLens(topbar, LENS.topbar);
    for (const d of document.querySelectorAll('dialog[open]')) applyLens(d, LENS.dialog);
    const hc = $('hoverCard');
    if (!hc.hidden) applyLens(hc, LENS.card);
  };
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(refreshLenses);
    ro.observe(topbar);
    for (const d of document.querySelectorAll('dialog')) ro.observe(d);
    ro.observe($('hoverCard'));
  }
  new MutationObserver(refreshLenses).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open', 'hidden'] });
  refreshLenses();
}

function updateChrome() {
  for (const b of document.querySelectorAll('.tabs .btn')) b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
  placeSegThumb();
  // 矢印だけのボタンなので、何日（何か月）動くかは説明と読み上げで伝える
  const [prev, next] = state.view === 'day' ? ['前日', '翌日'] : ['前月', '翌月'];
  $('prevBtn').title = prev; $('prevBtn').setAttribute('aria-label', prev);
  $('nextBtn').title = next; $('nextBtn').setAttribute('aria-label', next);
  $('datePicker').value = state.date;
  $('dateDisplay').innerHTML = dateDisplayHtml(state.date);
  // 「今日」は、今日（カレンダーでは今月）を表示しているときだけ青、それ以外は黒
  const t = todayStr();
  $('todayBtn').classList.toggle('on-today', state.view === 'month' ? monthStart(state.date) === monthStart(t) : state.date === t);
  $('equipFilter').hidden = state.view !== 'day';
  $('freeBtn').hidden = state.view !== 'day';
  if (state.freeNow && (state.view !== 'day' || state.date !== todayStr())) state.freeNow = false;
  $('freeBtn').setAttribute('aria-pressed', String(!!state.freeNow));
  $('roomSelect').hidden = state.view === 'day';
  const label = $('rangeLabel');
  const d = parseDate(state.date);
  if (state.view === 'day') {
    label.textContent = `${d.getMonth() + 1}月${d.getDate()}日(${WEEKDAY_NAMES[d.getDay()]})`;
    label.className = 'range-label redundant';
  } else if (state.view === 'room') {
    const { from, to } = currentRange();
    label.textContent = `${mdLabel(from)}〜${mdLabel(to)}`;
    label.className = 'range-label redundant';
  } else {
    label.textContent = `${d.getFullYear()}年${d.getMonth() + 1}月`;
    label.className = 'range-label';
  }
}

function setDate(s) {
  if (!s) return;
  state.date = s;
  updateChrome();
  load();
}

function setView(view) {
  state.view = view;
  save_(LS.view, view);
  if (view === 'room' && !state.roomId && state.rooms[0]) state.roomId = state.rooms[0].id;
  if (state.data) applySettings();
  updateChrome();
  load();
}

function shift(dir) {
  state.slide = dir; // 次の描画で、表を進む向きからすべり込ませる
  if (state.view === 'day') setDate(addDays(state.date, dir));
  else if (state.view === 'room') setDate(addMonths(state.date, dir));
  else setDate(addMonths(state.date, dir));
}
