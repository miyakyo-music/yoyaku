/**
 * 仕様書と実装の「ずれ」を、人の注意力に頼らず見つける。
 *   - 仕様書の「対象の版」が APP_VERSION と同じ
 *   - 仕様書が出している web/... のファイルが実在する（* の見本は除く）
 *   - 仕様書の「API_VERSION … 今は N」が実装と同じ
 * 文章の正しさそのものは見ない（それはレビューの仕事）。版・ファイル名のずれだけを見る。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./world.js');

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const spec = () => read('docs/仕様書.md');

test('仕様書の「対象の版」が、画面の APP_VERSION と同じ', () => {
  const app = (/APP_VERSION = '([^']+)'/.exec(read('web/api.js')) || [])[1];
  assert.ok(app, 'web/api.js に APP_VERSION が見つからない');
  const m = /対象の版: (v[0-9][^\s（(]*)/.exec(spec());
  assert.ok(m, '仕様書に「対象の版: v…」が見つからない');
  assert.strictEqual(m[1], app, '仕様書の対象の版と web/api.js の APP_VERSION が違う');
});

test('仕様書が出している web/ のファイルが実在する', () => {
  const paths = [...new Set([...spec().matchAll(/`(web\/[^`\s]+)`/g)].map((m) => m[1]))]
    .filter((p) => /\.(html|css|js|json|webmanifest|png|svg)$/.test(p))
    .filter((p) => !p.includes('*')); // `web/index/*.css` のような見本は、ファイル名ではない
  assert.ok(paths.length >= 10, '仕様書から web/ のファイル名が読み取れない');
  for (const p of paths) assert.ok(fs.existsSync(path.join(ROOT, p)), `仕様書が出している ${p} が無い`);
});

test('仕様書の API_VERSION が、実装と同じ', () => {
  const actual = Number((/const API_VERSION = (\d+);/.exec(read('gas/Code.gs')) || [])[1]);
  assert.ok(actual > 0, 'gas/Code.gs に API_VERSION が見つからない');
  const m = /API_VERSION[^\n]*今は (\d+)/.exec(spec());
  assert.ok(m, '仕様書に「API_VERSION … 今は N」が見つからない');
  assert.strictEqual(Number(m[1]), actual, '仕様書の API_VERSION と実装が違う');
});
