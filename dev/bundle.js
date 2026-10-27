#!/usr/bin/env node
/**
 * 公開のときに、予約表と管理画面が読む CSS と JS を、それぞれ1つのファイルにまとめる（読み込みの回数を減らして起動を速くする）。
 * GitHub Actions の「GitHub Pages に公開」（.github/workflows/pages.yml）が、公開用の作業コピーの web/ に対して流す。
 * 手元の web/ は変えない（手元では web のコピーに流す）。外部のライブラリは使わない。
 *
 *   node dev/bundle.js <web のコピーのフォルダ>
 *
 * できるもの（HTML の名前ごと）: bundle/index.css・bundle/index.js、bundle/admin.css・bundle/admin.js。
 * HTML の中の <link rel="stylesheet" href="…"> と <script src="…"></script> のうち、続けて並んでいるもの
 * （間は空白と <!-- --> だけ）を1つのまとまりとし、最初の位置に、まとめたファイルを読む1つのタグを置く。
 * 属性がほかにあるもの（async・defer・type=module・media など）、外のサイトのもの、?… の付いたものは、まとめずにそのまま残す。
 * <head> のダークモード判定などの、中に書いた <script> にも触らない。版（?v=）は、このあと pages.yml が付ける。
 *
 * CSS: 並び順どおりにつなぐだけ（あとが前を上書きする順は変わらない）。url(…) の相対の場所は、まとめたファイルの場所
 *      から同じものを指すように直す。@import・@charset があったら止める（つなぐと効かなくなるため。今は使っていない）。
 *      1つのファイルの { } やコメントが閉じていないと、つないだ次のファイルまで巻き込むので、そのときも止める。
 * JS:  ただつなぐと、別々の <script> のときと動きが変わる（1つが例外を出すと残りが動かない、1つに古いブラウザが読めない
 *      書き方があると全部が動かない、先頭の 'use strict' が全体にかかる／途中の 'use strict' が効かなくなる）。
 *      そこで、まとめたファイルには「各ファイルの中身を文字として持ち、並び順どおりに1つずつ <script> にして動かす」
 *      小さな処理を書く。中に書いた <script> は入れたその場で動くので、別々のファイルのときと同じく、
 *      1つずつ別の台本として順に動き（一番外側の名前も共有）、例外や文法の誤りはそのファイルだけで止まる。
 *      動かした <script> はすぐ取り除く（画面の要素は増えない）。開発者ツールでは元のファイルの名前で出る（sourceURL）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PAGES = ['index.html', 'admin.html']; // まとめるのはこの2つだけ（privacy.html などは今のまま）
const OUT_DIR = 'bundle';
// 文字の名前（ファイルの先頭の印 BOM と、JS の古い版では文字列の中に書けない行の区切りの2文字）
const BOM = new RegExp('^' + String.fromCharCode(0xfeff));
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

// ---------- HTML の中のまとまりを探す ----------
const CSS_TAG = /^<link rel="stylesheet" href="([^"]+)">/;
const JS_TAG = /^<script src="([^"]+)"><\/script>/;
const GAP = /^(?:\s+|<!--[\s\S]*?-->)/; // まとまりの間に入ってよいもの（空白とコメント）
const local = (src) => !/^([a-z]+:|\/|#)/i.test(src) && !/[?#]/.test(src) && !src.split('/').includes('..');

/** html の中から、続けて並んだ同じ種類のタグのまとまりを探す。[{kind, files, tags:[{start,end}]}] */
function findGroups(html) {
  const groups = [];
  let cur = null;
  let i = 0;
  while (i < html.length) {
    const rest = html.slice(i);
    const m = rest.startsWith('<') && (rest.match(CSS_TAG) || rest.match(JS_TAG));
    if (m && local(m[1])) {
      const kind = m[0].startsWith('<link') ? 'css' : 'js';
      if (!cur || cur.kind !== kind) { cur = { kind, files: [], tags: [] }; groups.push(cur); }
      cur.files.push(m[1]);
      cur.tags.push({ start: i, end: i + m[0].length });
      i += m[0].length;
      continue;
    }
    const g = cur && rest.match(GAP);
    if (g) { i += g[0].length; continue; }
    cur = null; // ほかのものがはさまったら、まとまりはそこで切れる
    const next = html.indexOf('<', i + 1);
    i = next < 0 ? html.length : next;
  }
  return groups.filter((g) => g.files.length > 1);
}

// ---------- CSS ----------
/** コメントと文字列を飛ばしながら { } の数を数え、閉じていないものがないかを見る */
function checkCss(text, name) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); if (e < 0) throw new Error(`${name}: コメントが閉じていません`); i = e + 1; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      for (; j < text.length && text[j] !== c; j++) { if (text[j] === '\\') j++; else if (text[j] === '\n') throw new Error(`${name}: 文字列が閉じていません`); }
      if (j >= text.length) throw new Error(`${name}: 文字列が閉じていません`);
      i = j; continue;
    }
    if (c === '{') depth++;
    if (c === '}' && --depth < 0) throw new Error(`${name}: } が多すぎます`);
  }
  if (depth !== 0) throw new Error(`${name}: { が閉じていません`);
  if (/@import\b/i.test(stripComments(text))) throw new Error(`${name}: @import は、まとめると効かなくなるので使えません`);
  if (/@charset\b/i.test(stripComments(text))) throw new Error(`${name}: @charset は、まとめると効かなくなるので使えません`);
}
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');

/** url(…) の相対の場所を、まとめたファイルの場所（outDir）から同じものを指すように直す */
function rebaseUrls(text, fromDir, outDir) {
  return text.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/g, (all, dq, sq, bare) => {
    const u = dq ?? sq ?? bare;
    const q = dq != null ? '"' : sq != null ? "'" : '';
    if (!u || /^([a-z]+:|\/|#)/i.test(u)) return all; // data:・https:・/… ・#… はそのまま
    const target = path.posix.normalize(path.posix.join(fromDir, u));
    return `url(${q}${path.posix.relative(outDir, target)}${q})`;
  });
}

function bundleCss(root, files) {
  return files.map((f) => {
    const text = fs.readFileSync(path.join(root, f), 'utf8').replace(BOM, '');
    checkCss(text, f);
    return `/* ===== ${f} ===== */\n${rebaseUrls(text, path.posix.dirname(f), OUT_DIR)}\n`;
  }).join('');
}

// ---------- JS ----------
function bundleJs(root, files) {
  const parts = files.map((f) => {
    const text = fs.readFileSync(path.join(root, f), 'utf8').replace(BOM, '');
    // 古いブラウザでも文字列として読めるよう、行の区切りの特別な文字は \u の形にする
    const str = JSON.stringify(text + '\n//# sourceURL=' + f).split(LS).join('\\u2028').split(PS).join('\\u2029');
    return `[${JSON.stringify(f)}, ${str}]`;
  });
  return `// 公開のときに dev/bundle.js が作ったファイル（元は ${files.join('・')}）。手で直さない。
// 各ファイルを並び順どおりに1つずつ <script> にして動かす（別々に読み込んだときと同じ動きになるように）。
(function () {
  var parts = [
${parts.join(',\n')}
  ];
  var me = document.currentScript;
  var at = (me && me.parentNode) || document.body || document.documentElement;
  for (var i = 0; i < parts.length; i++) {
    var s = document.createElement('script');
    s.text = parts[i][1];
    at.insertBefore(s, me && me.parentNode === at ? me : null); // 入れたその場で動く
    at.removeChild(s);
  }
})();
`;
}

// ---------- 本体 ----------
/** root（web のコピー）の index.html・admin.html の CSS・JS をまとめ、HTML を書き換える。作ったファイルの一覧を返す */
function bundle(root) {
  const made = [];
  for (const page of PAGES) {
    const file = path.join(root, page);
    if (!fs.existsSync(file)) continue;
    let html = fs.readFileSync(file, 'utf8');
    const base = page.replace(/\.html$/, '');
    const groups = findGroups(html);
    const count = { css: 0, js: 0 };
    const edits = [];
    for (const g of groups) {
      const n = ++count[g.kind];
      const out = `${OUT_DIR}/${base}${n > 1 ? '-' + n : ''}.${g.kind}`;
      const body = g.kind === 'css' ? bundleCss(root, g.files) : bundleJs(root, g.files);
      fs.mkdirSync(path.join(root, OUT_DIR), { recursive: true });
      fs.writeFileSync(path.join(root, out), body);
      made.push({ page, out, files: g.files });
      const tag = g.kind === 'css' ? `<link rel="stylesheet" href="${out}">` : `<script src="${out}"></script>`;
      g.tags.forEach((t, k) => edits.push({ ...t, text: k === 0 ? tag : '' }));
    }
    // 後ろから書き換える（前の位置がずれないように）。消すタグは、続く改行も消す
    edits.sort((a, b) => b.start - a.start);
    for (const e of edits) {
      let end = e.end;
      if (!e.text && html[end] === '\n') end++;
      html = html.slice(0, e.start) + e.text + html.slice(end);
    }
    fs.writeFileSync(file, html);
  }
  return made;
}

module.exports = { bundle, findGroups, rebaseUrls };

if (require.main === module) {
  const target = process.argv[2];
  if (!target) { console.error('使い方: node dev/bundle.js <web のコピーのフォルダ>'); process.exit(2); }
  const root = path.resolve(target);
  // 手元の web/ を書き換えてしまわないように（公開の作業コピーで流すときだけ許す）
  if (root === path.resolve(__dirname, '..', 'web') && process.env.GITHUB_ACTIONS !== 'true') {
    console.error('手元の web/ は書き換えません。web のコピーを作ってそちらに流してください。');
    process.exit(2);
  }
  try {
    for (const m of bundle(root)) console.log(`${m.page}: ${m.out} ← ${m.files.length} 個（${m.files.join(' ')}）`);
  } catch (e) {
    console.error('まとめられませんでした: ' + e.message);
    process.exit(1);
  }
}
