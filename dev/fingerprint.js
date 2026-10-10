/**
 * 見た目の「指紋」をとって比べる道具（リファクタリングなど、見た目を変えないはずの作業の確かめに使う）。
 *
 * 使い方（テスト環境 http://127.0.0.1:8765/ で、ブラウザの開発者ツールのコンソールに、このファイルの中身を貼り付けてから）:
 *   1. 作業の前: 画面を開き直して await __capture('L1280', ['day'])   … 「L1280」は幅や色の組み合わせに付ける名前
 *   2. 作業の後: 同じ幅・同じ色で画面を開き直して await __compare('L1280', ['day'])
 *      → 'same' なら見た目は同じ。違えば、違った要素の名前を出す。
 *   状態の名前: day / book / detail / room / month / my / bug（予約表）、admin:rooms など（管理画面）
 *   - 1つの状態ごとにページを開き直してから測ると、結果が安定する（ダイアログを開いた履歴などが残らないように）。
 *   - 時刻で変わるもの（現在時刻の線、空室ランプ、「〇:〇〇 更新」の文字）は比べない。
 *   - URL に &now=2026-10-10T12:00:00 のように時刻を付けて開くと、画面の「今」が止まり（dev/fixed-time.js）、
 *     「終了した予約」の見え方なども前後で同じになる。作業の前後で同じ時刻を付けること。
 */
// 画面の「指紋」: すべての要素（と ::before / ::after）の計算後のスタイルと位置をまとめて1つの数にする。
// リファクタリングの前後で同じ数になれば、見た目は変わっていない。時刻で変わるもの（現在時刻の線など）は除く。
window.__fp = function () {
  const SKIP = '.now-line, .past, .lamp, #statusText, .toast, .tl-scale span.now, .hovercard';
  let h = 5381, n = 0;
  const parts = {};
  const hash = (s) => { let x = 5381; for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0; return x; };
  const styleStr = (cs) => { let s = ''; for (let i = 0; i < cs.length; i++) { const p = cs[i]; if (p.startsWith('--')) continue; s += p + ':' + cs.getPropertyValue(p) + ';'; } return s; };
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest(SKIP)) continue;
    const r = el.getBoundingClientRect();
    let s = el.tagName + '.' + (el.getAttribute('class') || '') + '#' + el.id + '|' + styleStr(getComputedStyle(el));
    s += '|B' + styleStr(getComputedStyle(el, '::before')) + '|A' + styleStr(getComputedStyle(el, '::after'));
    s += `|${r.x.toFixed(1)},${r.y.toFixed(1)},${r.width.toFixed(1)},${r.height.toFixed(1)}`;
    const eh = hash(s); h = (Math.imul(h, 31) + eh) | 0; n++;
    parts[n] = el.tagName + '.' + (el.getAttribute('class') || '') + '#' + el.id + ':' + eh;
  }
  window.__fpParts = parts;
  return { n, h };
};

// 予約表・管理画面の決まった状態を作ってから指紋をとる
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
window.__runState = async function (name) {
  for (let i = 0; i < 40 && document.body.classList.contains('loading'); i++) await wait(100); // 読み込み中が終わるまで待つ
  await wait(400);
  document.activeElement && document.activeElement.blur && document.activeElement.blur();
  const segs = document.querySelectorAll('.seg .btn');
  if (segs.length && !name.startsWith('admin') && name !== 'room' && name !== 'month') { segs[0].click(); await wait(700); }
  if (name === 'book') { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); (document.querySelector('.fab:not([hidden])') || document.getElementById('newBtn')).click(); await wait(900); }
  if (name === 'detail') { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); document.querySelectorAll('.blk.res')[1].click(); await wait(900); }
  if (name === 'room') { document.querySelectorAll('.seg .btn')[1].click(); await wait(900); }
  if (name === 'month') { document.querySelectorAll('.seg .btn')[2].click(); await wait(900); }
  if (name === 'my') { document.getElementById('myBtn').click(); await wait(900); }
  if (name === 'bug') { document.querySelector('[data-bug]').click(); await wait(900); }
  if (name.startsWith('admin:')) { document.querySelector(`[data-tab="${name.slice(6)}"]`).click(); await wait(900); }
  const m = document.getElementById('main'); if (m) { m.scrollLeft = 0; m.scrollTop = 0; }
  window.scrollTo(0, 0);
  const st = document.getElementById('statusText'); if (st) st.textContent = '0:00 更新'; // 時刻で幅が変わるので固定
  await wait(300);
  return window.__fp();
};

// 基準を保存する / 基準と比べる（localStorage に「fp:ラベル:状態名」で保存）
window.__capture = async function (label, names) {
  const out = {};
  for (const n of names) { out[n] = (await window.__runState(n)).h; localStorage.setItem(`fp:${label}:${n}`, JSON.stringify(window.__fpParts)); }
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  return out;
};
window.__compare = async function (label, names) {
  const out = {};
  for (const n of names) {
    await window.__runState(n);
    const A = JSON.parse(localStorage.getItem(`fp:${label}:${n}`) || '{}');
    const B = window.__fpParts;
    const diff = [];
    const ka = Object.keys(A).length, kb = Object.keys(B).length;
    for (const k of Object.keys(B)) if (A[k] !== B[k]) diff.push(B[k].split(':')[0]);
    out[n] = ka === kb && !diff.length ? 'same' : { countA: ka, countB: kb, diff: diff.length, first: diff.slice(0, 6) };
  }
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  return out;
};
