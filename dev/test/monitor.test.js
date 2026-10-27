/**
 * 見張り（dev/monitor.js）の判定を、作った応答で確かめる（ネットにはつながない）。
 * あわせて、GAS（gas/Code.gs）が /mirror/changes に付けて送る版を、Store（cache/store.js）が覚えて出すことを、
 * テスト環境と同じ組み立て（world.js）で確かめる。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { judge, readCacheUrl, readGasBuild } = require('../monitor.js');
const { createWorld } = require('./world.js');

const NOW = Date.parse('2026-10-27T12:00:00+09:00');
const BUILD = '2026-10-27.1';
const ago = (min) => new Date(NOW - min * 60000 + 9 * 3600000).toISOString().slice(0, 19) + '+09:00';

/** 良好な応答（正本が Cloudflare）。over で一部を変える */
function cf(over) {
  return Object.assign({
    ok: true, primary: 'cloudflare',
    gas: { build: BUILD, at: ago(3), via: 'mirror' },
    mirror: { unmirrored: 0, oldestUnmirroredAt: null },
    pushedAt: '2026-09-01 10:00', disabled: true, // 正本が Cloudflare の間は古いままで正しい
  }, over);
}
/** 良好な応答（正本が GAS） */
function gas(over) {
  return Object.assign({
    ok: true, primary: 'gas', mirror: null,
    gas: { build: BUILD, at: ago(8 * 60), via: 'push' }, pushedAt: '2026-10-27 04:00', disabled: false,
  }, over);
}
const run = (status) => judge(status, { now: NOW, build: BUILD });
const has = (list, word) => list.some((s) => s.includes(word));

test('良好なら何も出さない（正本が Cloudflare でも GAS でも）', () => {
  assert.deepStrictEqual(run(cf()), []);
  assert.deepStrictEqual(run(gas()), []);
  // 写し待ちが少しあっても、新しければ良い
  assert.deepStrictEqual(run(cf({ mirror: { unmirrored: 4, oldestUnmirroredAt: ago(9) } })), []);
});

test('応答が読めない・ok でない', () => {
  assert.ok(has(run(null), 'JSON'));
  assert.ok(has(run(cf({ ok: false, message: '正本（Store）の様子を読めません。' })), 'ok でない'));
});

test('正本がどちらか分からない（古い Worker・Store を読めない）', () => {
  assert.ok(has(run({ ok: true, version: 1, pushedAt: '2026-10-27 10:00' }), '正本がどちらか'));
  assert.ok(has(run(cf({ primary: null })), '正本がどちらか'));
});

test('写されていない変更が30分以上残っている', () => {
  const bad = run(cf({ mirror: { unmirrored: 12, oldestUnmirroredAt: ago(31) } }));
  assert.strictEqual(bad.length, 1);
  assert.ok(has(bad, '12 件'));
  assert.deepStrictEqual(run(cf({ mirror: { unmirrored: 12, oldestUnmirroredAt: ago(29) } })), []);
  // 時刻の列ができる前の行だけ（時刻がわからない）なら、件数だけでは知らせない（GAS が来ているかで見る）
  assert.deepStrictEqual(run(cf({ mirror: { unmirrored: 2, oldestUnmirroredAt: null } })), []);
});

test('GAS が長く写しに来ていない（正本が Cloudflare）', () => {
  assert.ok(has(run(cf({ gas: { build: BUILD, at: ago(61), via: 'mirror' } })), '61 分前'));
  assert.deepStrictEqual(run(cf({ gas: { build: BUILD, at: ago(59), via: 'mirror' } })), []);
  const never = run(cf({ gas: { build: null, at: null, via: 'mirror' } }));
  assert.strictEqual(never.length, 1, '来たことがなければ、版の違いは重ねて出さない');
  assert.ok(has(never, '一度も'));
});

test('GAS が長く写しを送ってきていない（正本が GAS）', () => {
  assert.ok(has(run(gas({ gas: { build: BUILD, at: ago(27 * 60), via: 'push' } })), '27 時間前'));
  assert.deepStrictEqual(run(gas({ gas: { build: BUILD, at: ago(25 * 60), via: 'push' } })), []);
  assert.ok(has(run(gas({ gas: null })), '一度も'));
});

test('GAS の版がリポジトリと違う・名乗っていない', () => {
  assert.ok(has(run(cf({ gas: { build: '2026-10-20.1', at: ago(3), via: 'mirror' } })), '2026-10-20.1'));
  assert.ok(has(run(gas({ gas: { build: '', at: ago(60), via: 'push' } })), '名乗っていません'));
});

test('悪いところが重なれば、全部出す', () => {
  const bad = run(cf({ ok: false, gas: { build: 'old', at: ago(200), via: 'mirror' }, mirror: { unmirrored: 3, oldestUnmirroredAt: ago(180) } }));
  assert.strictEqual(bad.length, 4);
});

test('リポジトリから URL と GAS の版を読める', () => {
  assert.match(readCacheUrl(), /^(https:\/\/\S+|)$/);
  assert.match(readGasBuild(), /^\d{4}-\d{2}-\d{2}\.\d+$/, 'gas/Code.gs の GAS_BUILD は「日付.何回目」の形');
});

test('GAS が写しに来ると、Store が時刻と版を覚え、写し終えた変更は数えない', async () => {
  const w = createWorld({ now: '2026-10-27T09:00:00+09:00' });
  w.run('migrateToCloudflare()');
  const core = w.ctx.devCf.core;
  let st = core.sync('status');
  assert.strictEqual(st.mirrorAt, null, 'まだ来ていない');
  const r = await core.api({ action: 'createReservation', params: { roomId: 'room_01', date: '2026-10-30', start: '10:00', end: '10:30', affiliation: 'a', name: 'b', pin: '1111' } });
  assert.ok(r.ok, JSON.stringify(r));
  st = core.sync('status');
  assert.ok(st.unmirrored > 0 && st.oldestUnmirroredAt > 0, '写し待ちの件数と時刻が出る');
  // GAS の5分ごとの見回りを2回（1回目で写し、2回目の after で「写し終えた」が伝わる）
  w.run('cacheRetry({ triggerUid: 1 }); cacheRetry({ triggerUid: 1 })');
  st = core.sync('status');
  assert.strictEqual(st.gasBuild, readGasBuild(), 'GAS の版を覚えている');
  assert.ok(st.mirrorAt > 0, '来た時刻を覚えている');
  assert.strictEqual(st.unmirrored, 0, JSON.stringify(st));
  assert.strictEqual(st.oldestUnmirroredAt, null);
  await w.settle();
  assert.deepStrictEqual(w.errors, []);
});
