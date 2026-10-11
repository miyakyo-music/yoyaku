/**
 * CSS だけを整理したときの確かめ（見た目を変えないはずの並べ替え・まとめ・ファイル分け）。
 * 同じ画面に「前の CSS」と「新しい CSS」を順に当て、全要素（と ::before / ::after など）の計算後のスタイルを比べる。
 * :hover・:focus-visible・:active、ダーク、屈折あり／なし、小窓を開いた状態、「透明度を下げる」・ぼかし非対応・印刷なども、
 * 両方の CSS を同じように書き換えてから比べる（その状態を全要素に一度に作る）。dev/fingerprint.js と違い、ページを開き直さずに済む。
 *
 * 使い方（テスト環境）:
 *   1. 前の版を web/__old/ に置く（git に入らない）。例: タグの web をそのまま取り出して、config.js だけテスト用にする
 *        git archive <タグ> web | tar -x -C /tmp/old && cp -R /tmp/old/web/ web/__old/
 *        printf "window.GAS_API_URL = 'https://script.google.com/macros/s/dev-stub/exec';\nwindow.CACHE_API_URL = 'http://dev-cf.test';\n" > web/__old/config.js
 *   2. 新しい版の画面（http://127.0.0.1:8765/?light&now=2026-10-11T12:00:00 など）を開き、コンソールでこのファイルを読み込む
 *        await new Promise((r) => { const s = document.createElement('script'); s.src = '/dev/css-swap.js'; s.onload = r; document.head.append(s); });
 *   3. 小窓の中身などを作ってから比べる（時間がかかるので、結果は window.__res に入る。__show() で要約）
 *        __go(['visitDialogs'], null, await __linksOf('/__old/index.html'));   // 管理画面は ['adminTabs'] と '/__old/admin.html'
 *      すべて 'same' なら、その状態では見た目は変わっていない。幅（PC・iPad・スマホ）を変えて、何度か比べる。
 *   状態を作る手順: visitDialogs（各小窓の中身）・bookForm（部屋別＋予約画面）・month・adminExtras（管理者モードのとき）・adminTabs（管理画面）
 */
(() => {
  const PSEUDO = [[':focus-visible', '__fv'], [':focus-within', '__fw'], [':focus(?![-\\w])', '__f'], [':hover', '__h'], [':active', '__a']];
  function stripBlock(css, at) {
    // @starting-style { ... } のような塊を、かっこの対応を見て取り除く
    let out = '', i = 0;
    for (;;) {
      const k = css.indexOf(at, i);
      if (k < 0) { out += css.slice(i); return out; }
      out += css.slice(i, k);
      let j = css.indexOf('{', k), depth = 0;
      for (; j < css.length; j++) { if (css[j] === '{') depth++; else if (css[j] === '}') { depth--; if (!depth) break; } }
      i = j + 1;
    }
  }
  function transform(css, pass) {
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');
    css = stripBlock(css, '@starting-style');
    for (const [p, cls] of PSEUDO) {
      const on = pass.pseudo && cls === '__' + pass.pseudo;
      css = css.replace(new RegExp(p, 'g'), on ? '.' + cls : '.__never');
    }
    if (pass.reduced) css = css.replace(/\(prefers-reduced-motion:\s*reduce\)/g, 'all');
    if (pass.transp) css = css.replace(/\(prefers-reduced-transparency:\s*reduce\)/g, 'all');
    if (pass.noblur) css = css.replace(/@supports not \(\(-webkit-backdrop-filter: blur\(1px\)\) or \(backdrop-filter: blur\(1px\)\)\)/g, '@supports (display: block)');
    if (pass.print) css = css.replace(/@media print/g, '@media all');
    return css;
  }
  const PSEUDO_EL = ['', '::before', '::after', '::backdrop', '::placeholder', '::marker'];
  function snap() {
    const out = new Map();
    for (const el of document.querySelectorAll('html, html *')) {
      if (el.closest('script, style, head')) continue;
      const t = el.tagName;
      const pes = PSEUDO_EL.filter((pe) => pe === '' || pe === '::before' || pe === '::after' || (pe === '::backdrop' && t === 'DIALOG') ||
        (pe === '::placeholder' && (t === 'INPUT' || t === 'TEXTAREA')) || (pe === '::marker' && (t === 'LI' || t === 'SUMMARY')));
      for (const pe of pes) {
        const cs = getComputedStyle(el, pe || null);
        let s = '';
        for (let i = 0; i < cs.length; i++) { const p = cs[i]; if (!p.startsWith('--')) s += p + ':' + cs.getPropertyValue(p) + ';'; }
        out.set(el, (out.get(el) || '') + '|' + pe + '{' + s + '}');
      }
    }
    return out;
  }
  function finishAll() {
    for (const a of document.getAnimations()) {
      try { if (a.effect && a.effect.getComputedTiming().iterations !== Infinity) a.finish(); } catch (e) { /* そのまま */ }
    }
  }
  const desc = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.getAttribute('class') ? '.' + el.getAttribute('class').trim().split(/\s+/).join('.') : '');
  function diffProps(a, b) {
    const pa = {}, pb = {};
    for (const [store, str] of [[pa, a], [pb, b]]) {
      for (const block of str.split('|').filter(Boolean)) {
        const pe = block.slice(0, block.indexOf('{'));
        for (const kv of block.slice(block.indexOf('{') + 1, -1).split(';')) { if (!kv) continue; const c = kv.indexOf(':'); store[pe + ' ' + kv.slice(0, c)] = kv.slice(c + 1); }
      }
    }
    const d = [];
    for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) if (pa[k] !== pb[k]) d.push(`${k}: ${pa[k]} → ${pb[k]}`);
    return d;
  }
  window.__swap = async function ({ oldCss, passes }) {
    const links = [...document.querySelectorAll('link[rel=stylesheet]')];
    const newText = (await Promise.all(links.map((l) => fetch(l.href).then((r) => r.text())))).join('\n');
    const oldText = (await Promise.all(oldCss.map((u) => fetch(u).then((r) => r.text())))).join('\n');
    links.forEach((l) => { l.disabled = true; });
    const A = document.createElement('style'), B = document.createElement('style');
    document.head.append(A, B);
    const report = {};
    const root = document.documentElement, body = document.body;
    for (const pass of passes) {
      await new Promise((r) => setTimeout(r, 0)); // 測っている間も、ほかの操作を受け付ける
      const added = [];
      for (const c of pass.html || []) if (!root.classList.contains(c)) { root.classList.add(c); added.push([root, c]); }
      for (const c of pass.htmlOff || []) if (root.classList.contains(c)) { root.classList.remove(c); added.push([root, c, 'off']); }
      for (const c of pass.body || []) if (!body.classList.contains(c)) { body.classList.add(c); added.push([body, c]); }
      if (pass.pseudo) for (const el of document.querySelectorAll('html, html *')) el.classList.add('__' + pass.pseudo);
      const opened = [];
      if (pass.openAll) for (const d of document.querySelectorAll('dialog:not([open])')) { d.setAttribute('open', ''); opened.push(d); }
      A.textContent = transform(oldText, pass); B.textContent = '';
      finishAll(); const sa = snap();
      A.textContent = ''; B.textContent = transform(newText, pass);
      finishAll(); const sb = snap();
      const diffs = [];
      for (const [el, va] of sa) {
        const vb = sb.get(el);
        if (va !== vb) diffs.push({ el: desc(el), props: diffProps(va, vb || '').slice(0, 6) });
      }
      report[pass.name] = diffs.length ? { n: diffs.length, first: diffs.slice(0, 8) } : 'same';
      if (pass.pseudo) for (const el of document.querySelectorAll('html, html *')) el.classList.remove('__' + pass.pseudo);
      opened.forEach((d) => d.removeAttribute('open'));
      for (const [node, c, off] of added) node.classList.toggle(c, !!off);
    }
    A.remove(); B.remove();
    links.forEach((l) => { l.disabled = false; });
    return report;
  };
  // よく使う組み合わせ
  window.__passes = (extra = {}) => [
    { name: 'plain' }, { name: 'hover', pseudo: 'h' }, { name: 'focus', pseudo: 'f' }, { name: 'fv', pseudo: 'fv' }, { name: 'fw', pseudo: 'fw' }, { name: 'active', pseudo: 'a' },
    { name: 'dark', html: ['dark'] }, { name: 'dark-hover', html: ['dark'], pseudo: 'h' }, { name: 'dark-fv', html: ['dark'], pseudo: 'fv' }, { name: 'dark-active', html: ['dark'], pseudo: 'a' }, { name: 'dark-focus', html: ['dark'], pseudo: 'f' },
    { name: 'refract', html: ['refract'] }, { name: 'norefract', htmlOff: ['refract'] }, { name: 'dark-refract', html: ['dark', 'refract'] },
    { name: 'solid', html: ['hdr-solid'] }, { name: 'dark-solid', html: ['dark', 'hdr-solid'] },
    { name: 'dlgopen', html: ['dlg-open'] }, { name: 'dark-dlgopen', html: ['dark', 'dlg-open'] },
    { name: 'loading', body: ['loading'] }, { name: 'fallback', body: ['dialog-fallback', 'modal-open'], openAll: true },
    { name: 'openall', openAll: true }, { name: 'dark-openall', html: ['dark'], openAll: true },
    { name: 'vt', body: ['vt-morph'], html: ['vt-morph'] },
    { name: 'reduced', reduced: true }, { name: 'transp', transp: true }, { name: 'dark-transp', html: ['dark'], transp: true }, { name: 'noblur', noblur: true }, { name: 'dark-noblur', html: ['dark'], noblur: true },
    { name: 'print', print: true },
    ...(extra.more || []),
  ];
})();

// 前の版の HTML が読み込んでいる CSS の場所（並び順のまま）
window.__linksOf = async (htmlUrl) => {
  const html = await (await fetch(htmlUrl)).text();
  const base = new URL(htmlUrl, location.href);
  return [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => new URL(m[1], base).pathname);
};

// ---------------- 比べる前に、いろいろな画面の状態（小窓の中身など）を作る ----------------
(() => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const closeAll = async () => { document.querySelectorAll('dialog[open]').forEach((d) => d.close()); await wait(400); };
  const idle = async () => { for (let i = 0; i < 40 && document.body.classList.contains('loading'); i++) await wait(150); await wait(300); };
  async function visitDialogs() {
    await idle();
    ($('newBtn').offsetParent ? $('newBtn') : $('fabBtn')).click(); await wait(1200); await closeAll();
    const b = document.querySelector('.blk.res'); if (b) { b.click(); await wait(1200); await closeAll(); }
    $('myBtn').click(); await wait(1200);
    const st = document.querySelector('[data-my="stats"]'); if (st) { st.click(); await wait(1500); }
    await closeAll();
    $('searchBtn').click(); await wait(800);
    const si = $('searchInput'); si.value = '佐'; si.dispatchEvent(new Event('input', { bubbles: true })); await wait(3500); await closeAll();
    document.querySelector('[data-bug]').click(); await wait(1000); await closeAll();
    const ef = $('equipFilter'); ef.value = '★edit'; ef.dispatchEvent(new Event('change', { bubbles: true })); await wait(1200); await closeAll();
    // 練習時間・検索の結果（模擬データが少ないので、index.js が作るのと同じ形の中身を入れる）
    const sb = $('myStatsBody');
    if (sb) sb.innerHTML = '<div class="ms-total"><b>6時間</b><span>5回・このあと予定 1.5時間</span></div><p class="ms-h">部屋ごと</p><div class="ms-bars">' +
      '<div class="ms-bar"><span>練習室3（UP）</span><i style="width:100%"></i><em>3時間</em></div><div class="ms-bar"><span>練習室17（GP）</span><i style="width:50%"></i><em>1.5時間</em></div></div>' +
      '<p class="ms-h">曜日ごと</p><div class="ms-week">' + [1, 2, 3, 4, 5, 6, 0].map((w) => `<div class="${w === 0 ? 'sun' : w === 6 ? 'sat' : ''}"><i style="height:${w * 9}px"></i>${'日月火水木金土'[w]}</div>`).join('') + '</div>';
    const sl = $('searchList');
    if (sl) sl.innerHTML = '<li><button type="button" data-date="2026-10-12" data-id="x"><b>10/12(月) 9:00〜10:00　練習室3（UP）</b><span><mark>佐</mark>藤（G8012）　伴奏合わせ</span></button></li>' +
      '<li><button type="button" data-date="2026-10-13" data-id="y"><b>10/13(火) 13:00〜14:00　練習室17（GP）</b><span><mark>佐</mark>々木</span></button></li>';
    // PC でマウスを乗せたときの詳細カード（中身は index.js の showCard と同じ形）
    const card = $('hoverCard');
    if (card) {
      card.innerHTML = '<div class="hc-time">10/11(日) 15:00 〜 17:10（2時間10分）</div><div class="hc-name">上野友希</div><div class="hc-aff">G8032</div>' +
        '<dl class="summary"><dt>部屋</dt><dd><span class="hc-dot mine"></span>練習室1（UP）・この端末の予約</dd><dt>備考</dt><dd>伴奏合わせ</dd></dl>';
      card.hidden = false;
    }
  }
  async function bookForm() {
    await idle();
    document.querySelectorAll('.tabs .btn')[1].click(); await wait(1500);
    ($('newBtn').offsetParent ? $('newBtn') : $('fabBtn')).click(); await wait(1500);
    for (const id of ['bMulti', 'bRepeat']) { const c = $(id); if (c && !c.closest('[hidden]')) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); await wait(500); } }
    await wait(800);
  }
  async function month() { await idle(); document.querySelectorAll('.tabs .btn')[2].click(); await wait(2000); }
  async function adminExtras() {
    await idle();
    const n = $('notice'); if (n && !n.closest('[hidden]')) { n.click(); await wait(600); }
    const b = document.querySelector('.blk.res'); if (b) { b.click(); await wait(1200); const c = $('dCopy'); if (c && !c.hidden) { c.click(); await wait(1500); } }
  }
  // 管理画面: タブを順に開いて中身を作る
  async function adminTabs() {
    for (let i = 0; i < 40 && !document.querySelector('[data-tab]'); i++) await wait(200);
    for (const t of ['stats', 'closures', 'setup', 'bugs', 'history']) {
      const b = document.querySelector(`[data-tab="${t}"]`); if (b) { b.click(); await wait(2500); }
    }
    const hx = document.querySelector('#xResult tr[data-i]'); if (hx) { hx.click(); await wait(500); }
  }
  window.__st = { visitDialogs, bookForm, month, adminExtras, closeAll, idle, adminTabs };
  // よく使う流れ: 状態を作ってから比べる（結果は window.__res）
  window.__go = async (what, passes, oldCss) => {
    window.__res = null; window.__err = null;
    try {
      for (const w of what) await window.__st[w]();
      window.__res = await window.__swap({ oldCss: oldCss || await window.__linksOf(location.pathname.includes('admin') ? '/__old/admin.html' : '/__old/index.html'), passes: passes || window.__passes() });
    } catch (e) { window.__err = String(e.stack || e); }
  };
  window.__show = () => JSON.stringify({ err: window.__err, res: window.__res && Object.fromEntries(Object.entries(window.__res).filter(([, v]) => v !== 'same').map(([k, v]) => [k, { n: v.n, first: v.first.slice(0, 4) }])), same: window.__res && Object.values(window.__res).filter((v) => v === 'same').length });
})();
