#!/usr/bin/env node
/**
 * 整理の前後を同じ物差しで比べるための一覧（レビュー 2026-10-20 の P3 を受けた整理用）。
 *
 * 使い方（このリポジトリの一番上で）:
 *   node dev/refactor-report.js            CSS・JS・GAS/Store の一覧を出す
 *   node dev/refactor-report.js --css      CSS だけ
 *   node dev/refactor-report.js --js       JS だけ
 *   node dev/refactor-report.js --server   GAS と Store の定数だけ
 *
 * 数え方は目安。CSS は「セレクタ { … }」を、@media の中も含めて数える。
 * 「使われていない疑い」は、HTML と JS の文字列を単純に検索した結果。動的に作る名前は
 * JS の中に出てくるので拾えるが、外部（GAS の応答など）から来る名前は拾えない。消す前に必ず目で確かめる。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const list = (dir, ext) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(ext)).map((f) => dir + '/' + f).sort();
const percent = (n, total) => (total ? Math.round((n / total) * 1000) / 10 : 0);

const cssFiles = [
  ...list('web/shared', '.css'),
  ...list('web/index', '.css'),
  ...list('web/admin', '.css'),
];
const jsFiles = [
  'web/api.js', 'web/config.js', 'web/sw.js',
  ...list('web/shared', '.js'),
  ...list('web/index', '.js'),
  ...list('web/admin', '.js'),
];

/** コメントを外す（文字列の中の // を壊さないよう、雑だが十分） */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** セレクタと宣言を取り出す。@media の中も平坦に扱う */
function cssBlocks(text) {
  const css = stripComments(text);
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (!sel || sel.startsWith('@') || sel.startsWith('from') || sel.startsWith('to') || /^\d+%$/.test(sel)) continue;
    const decls = m[2].split(';').map((d) => d.trim()).filter(Boolean);
    out.push({ sel, decls });
  }
  return out;
}

function cssReport() {
  console.log('\n== CSS ==');
  const perFile = [];
  const bySel = new Map();
  let total = 0;
  let important = 0;
  for (const f of cssFiles) {
    const blocks = cssBlocks(read(f));
    total += blocks.length;
    important += (read(f).match(/!important/g) || []).length;
    perFile.push({ f, n: blocks.length });
    for (const b of blocks) {
      if (!bySel.has(b.sel)) bySel.set(b.sel, []);
      bySel.get(b.sel).push(f);
    }
  }
  console.log(`ファイル ${cssFiles.length}・指定の塊 ${total}・!important ${important}`);
  console.log('多いファイル（上位10）:');
  for (const x of perFile.sort((a, b) => b.n - a.n).slice(0, 10)) console.log(`  ${String(x.n).padStart(3)}  ${x.f}`);

  const within = [...bySel].map(([sel, files]) => [sel, files.length]).filter(([, n]) => n > 1);
  console.log(`同じ選び方が2回以上出てくるもの: ${within.length}（ファイルをまたぐものを含む）`);
  for (const [sel, n] of within.sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(n).padStart(2)}回  ${sel.slice(0, 90)}`);

  const topbar = cssBlocks(read('web/index/topbar.css'));
  const topbarSel = new Map();
  for (const b of topbar) topbarSel.set(b.sel, (topbarSel.get(b.sel) || 0) + 1);
  const tbDup = [...topbarSel].filter(([, n]) => n > 1);
  console.log(`web/index/topbar.css: 指定の塊 ${topbar.length}・同じ選び方 ${tbDup.length}`);
  for (const [sel, n] of tbDup.sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(n).padStart(2)}回  ${sel}`);

  // 使われていない疑い: セレクタのクラス・id が HTML/JS のどこにも出てこない
  const code = [...list('web', '.html'), ...jsFiles].map(read).join('\n');
  const used = new Set();
  const suspects = [];
  for (const [sel] of bySel) {
    for (const name of sel.match(/\.[A-Za-z_][\w-]*/g) || []) {
      const c = name.slice(1);
      if (used.has(c)) continue;
      used.add(c);
      const re = new RegExp('(^|[^\\w-])' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^\\w-]|$)');
      if (!re.test(code)) suspects.push(c);
    }
  }
  console.log(`HTML・JS のどこにも出てこないクラス名の疑い: ${suspects.length}`);
  if (suspects.length) console.log('  ' + suspects.slice(0, 40).join(', ') + (suspects.length > 40 ? ' …' : ''));
}

/** ファイルの外側（行頭）にある宣言だけを取る。IIFE の中（字下げ）は含めない */
function topLevel(text) {
  const names = new Set();
  for (const m of text.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of text.matchAll(/^(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  return [...names];
}

function functionsWithBody(text) {
  const out = [];
  const re = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm;
  let m;
  while ((m = re.exec(text))) {
    let i = m.index + m[0].length;
    let depth = 1;
    for (; i < text.length && depth; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
    }
    const body = text.slice(m.index, i).replace(/\s+/g, ' ').replace(/\/\/[^\n]*/g, '').trim();
    out.push({ name: m[1], body });
  }
  return out;
}

function jsReport() {
  console.log('\n== JS（画面） ==');
  const all = jsFiles.map((f) => ({ f, text: read(f) }));
  const code = all.map((x) => x.text).join('\n') + '\n' + list('web', '.html').map(read).join('\n');
  const resolve = (page, src) => path.posix.normalize(path.posix.join(path.posix.dirname(page), src));
  for (const page of ['web/index.html', 'web/admin.html']) {
    const names = new Map();
    for (const src of [...read(page).matchAll(/<script src="([^"]+)"/g)].map((m) => resolve(page, m[1]))) {
      if (!fs.existsSync(path.join(ROOT, src))) { console.log(`  ! 実在しない: ${src}`); continue; }
      for (const n of topLevel(read(src))) {
        if (!names.has(n)) names.set(n, []);
        names.get(n).push(src);
      }
    }
    const dup = [...names].filter(([, fs]) => fs.length > 1);
    console.log(`${page}: 外側の名前 ${names.size}・重複 ${dup.length}`);
    for (const [n, fs] of dup.slice(0, 10)) console.log(`  重複 ${n}: ${fs.join(', ')}`);
  }
  // 同じ名前で中身が違う関数（予約表と管理画面）
  const indexFns = functionsWithBody(all.filter((x) => x.f.startsWith('web/index/')).map((x) => x.text).join('\n'));
  const adminFns = functionsWithBody(all.filter((x) => x.f.startsWith('web/admin/')).map((x) => x.text).join('\n'));
  const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
  const same = [];
  const diff = [];
  for (const a of indexFns) {
    const b = adminFns.find((x) => x.name === a.name);
    if (!b) continue;
    (hash(a.body) === hash(b.body) ? same : diff).push(a.name);
  }
  console.log(`予約表と管理画面で同じ名前の関数: ${same.length + diff.length}（中身も同じ ${same.length} / 違う ${diff.length}）`);
  if (same.length) console.log('  同じ: ' + same.join(', '));
  if (diff.length) console.log('  違う: ' + diff.join(', '));

  // 参照されていない疑い（定義の1回だけ）
  const funcs = [...new Set(all.flatMap((x) => functionsWithBody(x.text).map((y) => y.name)))];
  const unused = funcs.filter((n) => (code.match(new RegExp('\\b' + n + '\\b', 'g')) || []).length <= 1);
  console.log(`参照されていない疑いの関数: ${unused.length}`);
  if (unused.length) console.log('  ' + unused.join(', '));
}

function systemConstants(text) {
  const m = text.match(/const SYSTEM = \{([\s\S]*?)\n\s*\};/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const k = line.match(/^\s*([A-Z_]+):\s*([^,]+),/);
    if (k) out[k[1]] = k[2].replace(/\/\/.*/, '').trim();
  }
  return out;
}

function serverReport() {
  console.log('\n== GAS と Store ==');
  const gas = read('gas/Code.gs');
  const store = read('cache/store.js');
  const a = systemConstants(gas) || {};
  const b = systemConstants(store) || {};
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  console.log(`SYSTEM の定数: GAS ${Object.keys(a).length}・Store ${Object.keys(b).length}`);
  for (const k of keys) if (a[k] !== b[k]) console.log(`  違い ${k}: GAS=${a[k] || '(なし)'} / Store=${b[k] || '(なし)'}`);
  const gf = [...gas.matchAll(/^function ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  const sf = [...store.matchAll(/^\s{2}function ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  console.log(`関数: GAS ${gf.length}・Store ${sf.length}・同じ名前 ${gf.filter((n) => sf.includes(n)).length}`);
}

const args = process.argv.slice(2);
const only = (x) => !args.length || args.includes(x);
if (only('--css')) cssReport();
if (only('--js')) jsReport();
if (only('--server')) serverReport();
