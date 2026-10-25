/**
 * 正本の台本（dev/compare-scenario.js）を、GAS が正本のときと Cloudflare が正本のときの両方で流し、
 *   1. 二つの結果が一つずつ同じであること（gas/Code.gs と cache/store.js が同じ動きをしているか）
 *   2. GAS の結果が、残してある期待値（scenario.expected.json）と同じであること（両方が同じように変わっていないか）
 * を確かめる。保守マニュアル 03 の 8章の手作業と同じことを、ブラウザなしで行う。
 * 動きを変えたつもりで期待値と違ったら、違いが意図どおりか確かめてから、UPDATE=1 node --test dev/test/ で書き直す。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createWorld } = require('./world.js');

const NOW = '2026-10-10T09:00:00+09:00'; // 台本の日付（compare-scenario.js の D・T）に合わせた「今」
const EXPECTED = path.join(__dirname, 'scenario.expected.json');

async function play(primary) {
  const w = createWorld({ now: NOW });
  if (primary === 'cloudflare') {
    w.run('migrateToCloudflare()');
    assert.strictEqual(w.run("PropertiesService.getScriptProperties().getProperty('PRIMARY')"), 'cloudflare', 'Cloudflare に移せなかった');
  }
  await w.load('dev/compare-scenario.js');
  await w.settle();
  assert.deepStrictEqual(w.errors, [], 'コンソールに赤いエラーが出た');
  return JSON.parse(JSON.stringify(w.ctx.__scenario));
}

// 1行に1つの手順を書く（違ったとき、どの手順が変わったかを git の差分で見やすくする）
const format = (steps) => '[\n' + steps.map((s) => '  ' + JSON.stringify(s)).join(',\n') + '\n]\n';

test('台本: GAS と Cloudflare で結果が同じ・期待値どおり', async (t) => {
  const gas = await play('gas');
  const cf = await play('cloudflare');

  await t.test('GAS と Cloudflare で、手順ごとの結果が同じ', () => {
    assert.strictEqual(cf.length, gas.length, '手順の数が違う');
    gas.forEach((g, i) => assert.deepStrictEqual(cf[i], g, `手順「${g[0]}」で違う（上が Cloudflare、下が GAS）`));
  });

  await t.test('GAS の結果が期待値どおり', () => {
    if (process.env.UPDATE === '1') { fs.writeFileSync(EXPECTED, format(gas)); return; }
    const expected = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));
    const names = (a) => a.map((s) => s[0]).join(',');
    assert.strictEqual(names(gas), names(expected), '手順の並びが期待値と違う（台本を変えたら UPDATE=1 で書き直す）');
    expected.forEach((e, i) => assert.deepStrictEqual(gas[i], e, `手順「${e[0]}」が期待値と違う（上が今、下が期待値）`));
  });
});
