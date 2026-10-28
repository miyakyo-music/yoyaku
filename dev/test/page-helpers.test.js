/**
 * 予約表と管理画面で、名前も中身も同じ6つの関数を固定する。
 * 判定（2026-10-28）のとおり、web/shared には移さず（読み込み順の危険を増やさない）、
 * 片方だけ変わったらここで止める。
 *   pad・toMin・toHHMM・hm・esc … index/core.js と admin/core.js
 *   errMessage … index/data.js と admin/core.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT } = require('./world.js');

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** 関数の定義（`function 名前(...) { … }`）を、かっこの対応をとって取り出す */
function functionSource(file, name) {
  const text = read(file);
  const start = new RegExp('^function ' + name + '\\(', 'm').exec(text);
  assert.ok(start, `${file} に function ${name}( が見つからない`);
  let i = text.indexOf('{', start.index);
  let depth = 0;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (!depth) { i++; break; } }
  }
  return text.slice(start.index, i);
}

const normalize = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();

test('予約表と管理画面で、同じ6つの関数は中身も同じ', () => {
  const pairs = [
    ['pad', 'web/index/core.js', 'web/admin/core.js'],
    ['toMin', 'web/index/core.js', 'web/admin/core.js'],
    ['toHHMM', 'web/index/core.js', 'web/admin/core.js'],
    ['hm', 'web/index/core.js', 'web/admin/core.js'],
    ['esc', 'web/index/core.js', 'web/admin/core.js'],
    ['errMessage', 'web/index/data.js', 'web/admin/core.js'],
  ];
  for (const [name, a, b] of pairs) {
    assert.strictEqual(normalize(functionSource(b, name)), normalize(functionSource(a, name)),
      `${name} が予約表（${a}）と管理画面（${b}）で違う。片方だけ直していないか確かめる`);
  }
});

test('同じ6つの関数の動き（あとから変えるときの目印）', () => {
  // toHHMM は pad を使うので、6つを同じ入れ物に読み込んでから呼ぶ
  const ctx = vm.createContext({});
  for (const name of ['pad', 'toMin', 'toHHMM', 'hm', 'esc']) vm.runInContext(functionSource('web/index/core.js', name), ctx);
  vm.runInContext(functionSource('web/index/data.js', 'errMessage'), ctx);
  const run = (call) => vm.runInContext(call, ctx);
  assert.strictEqual(run('esc(\'<a & "b">\')'), '&lt;a &amp; &quot;b&quot;&gt;');
  assert.strictEqual(run('pad(7)'), '07');
  assert.strictEqual(run('toMin("9:05")'), 545);
  assert.strictEqual(run('toHHMM(545)'), '09:05');
  assert.strictEqual(run('hm("09:05")'), '9:05');
  assert.strictEqual(run('errMessage(new Error("通信できません"))'), '通信できません');
});
