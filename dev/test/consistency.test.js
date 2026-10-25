/**
 * 壊れても画面を開くまで気づきにくい「約束」を確かめる（どれも速い）。
 *   - 画面と GAS の約束の版 API_VERSION が同じ
 *   - JS がすべて文法として読める
 *   - 部品のファイル（web/index・web/admin・web/shared）がすべて HTML から読み込まれ、boot.js が最後
 *   - 更新情報（RELEASES）の形がそろっている
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { ROOT } = require('./world.js');

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const list = (dir, ext) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(ext)).map((f) => dir + '/' + f);

test('API_VERSION が web/api.js と gas/Code.gs で同じ', () => {
  const ver = (f) => Number((/const API_VERSION = (\d+);/.exec(read(f)) || [])[1]);
  assert.ok(ver('web/api.js') > 0, 'web/api.js に API_VERSION が見つからない');
  assert.strictEqual(ver('gas/Code.gs'), ver('web/api.js'));
});

test('JS がすべて文法として読める', () => {
  const files = ['web', 'web/index', 'web/admin', 'cache', 'dev', 'dev/test'].flatMap((d) => list(d, '.js'));
  for (const f of files) {
    // cache/worker.js は import / export を使うので、モジュールとして確かめる
    const args = f === 'cache/worker.js' ? ['--input-type=module', '--check'] : ['--check', path.join(ROOT, f)];
    execFileSync(process.execPath, args, { input: f === 'cache/worker.js' ? read(f) : undefined, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  // Code.gs は拡張子が .gs なので、中身を読んで確かめる
  assert.doesNotThrow(() => new vm.Script(read('gas/Code.gs'), { filename: 'gas/Code.gs' }));
});

for (const [page, dir] of [['web/index.html', 'index'], ['web/admin.html', 'admin']]) {
  test(`${page} が ${dir}/ の部品をすべて読み込み、boot.js が最後`, () => {
    const html = read(page);
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    const styles = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
    for (const f of list('web/' + dir, '.js')) assert.ok(scripts.includes(f.slice(4)), `${f} が読み込まれていない`);
    for (const f of list('web/' + dir, '.css')) assert.ok(styles.includes(f.slice(4)), `${f} が読み込まれていない`);
    for (const f of [...scripts, ...styles]) assert.ok(fs.existsSync(path.join(ROOT, 'web', f)), `${f} というファイルがない`);
    assert.strictEqual(scripts[scripts.length - 1], dir + '/boot.js', 'boot.js が最後に読み込まれていない');
    assert.strictEqual(styles[styles.length - 1], dir + '/fallback.css', 'fallback.css が最後に読み込まれていない');
  });
}

test('web/shared/ の CSS がどちらかの画面から読み込まれている', () => {
  const html = read('web/index.html') + read('web/admin.html');
  for (const f of list('web/shared', '.css')) assert.ok(html.includes(`href="${f.slice(4)}"`), `${f} が読み込まれていない`);
});

test('更新情報（RELEASES）の形がそろっている', () => {
  // ファイルの残りは画面の部品を使うので、一覧の部分（const RELEASES = [ から ]; まで）だけを読む
  const m = /const RELEASES = (\[[\s\S]*?\n\]);/.exec(read('web/index/releases.js'));
  assert.ok(m, 'web/index/releases.js に const RELEASES = [ … ]; が見つからない');
  const RELEASES = vm.runInNewContext(m[1]);
  assert.ok(Array.isArray(RELEASES) && RELEASES.length > 0);
  RELEASES.forEach((r, i) => {
    const where = `${i + 1}番目（${r.ver || '版なし'} ${r.date}）`;
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, where + ' の date');
    assert.ok(r.ver === '' ? i === 0 : /^v\d+\.\d+\.\d+/.test(r.ver), where + ' の ver（版なしは先頭だけ）');
    assert.ok(Array.isArray(r.items) && r.items.length > 0, where + ' の items');
    for (const it of r.items) assert.ok(typeof it === 'string' || (it && typeof it.text === 'string'), where + ' の項目の形');
    if (i > 0) assert.ok(r.date <= RELEASES[i - 1].date, where + ' が新しい順に並んでいない');
  });
  const appVersion = (/APP_VERSION = '([^']+)'/.exec(read('web/api.js')) || [])[1];
  assert.ok(RELEASES.some((r) => r.ver === appVersion), `今の版 ${appVersion} が更新情報にない`);
});
