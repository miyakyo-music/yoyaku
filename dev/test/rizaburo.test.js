/**
 * りざぶ郎の取り込み（2026-11-04 まで）の試験。
 * - いつ・どの日を取るか（cache/rizaburo-plan.js）
 * - 予約者が違う重なりは、本システムの予約を優先すること（cache/store.js の importRizaburo）
 * ネットにはつながない（りざぶ郎の画面・CSV は使わない）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../../cache/rizaburo-plan.js');
const { createWorld } = require('./world.js');

const P = globalThis.RizaburoPlan;
const at = (s) => Date.parse(s);
const range = (from, to) => {
  const out = [];
  for (let d = from; d <= to; d = P.addDays(d, 1)) out.push(d);
  return out;
};

test('今日は10分ごと、明日〜7日後は1時間ごと（0分と30分に分ける）', () => {
  assert.deepStrictEqual(P.datesFor(at('2026-10-28T09:00:00+09:00')), ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']);
  assert.deepStrictEqual(P.datesFor(at('2026-10-28T09:30:00+09:00')), ['2026-10-28', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']);
  assert.deepStrictEqual(P.datesFor(at('2026-10-28T09:20:00+09:00')), ['2026-10-28']);
  assert.deepStrictEqual(P.datesFor(at('2026-10-28T10:10:00+09:00')), ['2026-10-28']);
});

test('8〜14日後は6時間ごと、15日後以降は4日に1回', () => {
  const early = P.datesFor(at('2026-10-28T06:10:00+09:00'));
  assert.deepStrictEqual(early, ['2026-10-28'].concat(range('2026-11-05', '2026-11-08')));
  const later = P.datesFor(at('2026-10-28T09:10:00+09:00'));
  assert.deepStrictEqual(later, ['2026-10-28'].concat(range('2026-11-09', '2026-11-11')));
  const far = P.datesFor(at('2026-10-28T04:20:00+09:00'));
  assert.strictEqual(far.length, 5);
  assert.ok(far.every((d) => d >= '2026-11-12' && d <= '2026-11-30'));
  // 1回の通信は 1日2回まで。10回の上限に収まる
  assert.ok(far.length * 2 <= 10);
});

test('夜間は回数を落とす', () => {
  assert.deepStrictEqual(P.datesFor(at('2026-10-28T23:10:00+09:00')), []);
  assert.deepStrictEqual(P.datesFor(at('2026-10-28T23:00:00+09:00')), ['2026-10-28']);
  assert.deepStrictEqual(P.datesFor(at('2026-10-28T00:00:00+09:00')), ['2026-10-28']);
  assert.deepStrictEqual(P.datesFor(at('2026-10-28T04:10:00+09:00')), []);
  const farNight = P.datesFor(at('2026-10-28T04:20:00+09:00'));
  assert.strictEqual(farNight.length, 5);
  assert.ok(!farNight.includes('2026-10-28'));
});

test('停止日と範囲の終わり', () => {
  assert.deepStrictEqual(P.datesFor(at('2026-11-04T00:00:00+09:00')), []);
  assert.deepStrictEqual(P.datesFor(at('2026-11-30T09:00:00+09:00')), []);
  assert.deepStrictEqual(P.datesFor(at('2026-12-01T09:00:00+09:00')), []);
});

test('手で指定する範囲は、今日〜11/30・23日以内に丸める', () => {
  assert.deepStrictEqual(P.manualRange('2026-10-01', '2026-11-10', at('2026-10-28T09:00:00+09:00')), { from: '2026-10-28', to: '2026-11-10' });
  assert.deepStrictEqual(P.manualRange('2026-11-20', '2026-12-10', at('2026-10-28T09:00:00+09:00')), { from: '2026-11-20', to: '2026-11-30' });
  assert.ok(P.manualRange('2026-10-01', '2026-11-30', at('2026-10-28T09:00:00+09:00')).error);
  assert.strictEqual(P.manualRange('2026-11-01', '2026-11-10', at('2026-11-04T00:00:00+09:00')).stopped, true);
});

test('予約者が違う重なりは、本システムの予約を優先する', async () => {
  const w = createWorld({ now: '2026-10-28T09:00:00+09:00' });
  await w.run('migrateToCloudflare()');
  await w.settle();
  const made = await w.run(`devCf.core.api({ action: 'createReservation', params: { roomId: 'room_01', date: '2026-10-29', start: '10:00', end: '11:00', name: '自分', affiliation: 'G1' } })`);
  assert.strictEqual(made.ok, true, JSON.stringify(made));
  const res = await w.run(`devCf.core.importRizaburo({ from: '2026-10-29', to: '2026-10-29', dates: ['2026-10-29'], lines: ['練習室1,"メモ, あり",202610291000,202610291100,G9999 他人'] })`);
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(res.added, 0);
  assert.strictEqual(res.overlap, 1);
  const list = await w.run(`devCf.core.api({ action: 'getSchedule', params: { from: '2026-10-29', to: '2026-10-29' } })`);
  const hit = list.reservations.filter((r) => r.roomId === 'room_01' && r.date === '2026-10-29');
  assert.strictEqual(hit.length, 1);
  assert.strictEqual(hit[0].name, '自分');
});

test('引用符つきカンマの行も読める', async () => {
  const w = createWorld({ now: '2026-10-28T09:00:00+09:00' });
  await w.run('migrateToCloudflare()');
  await w.settle();
  const res = await w.run(`devCf.core.importRizaburo({ from: '2026-10-30', to: '2026-10-30', dates: ['2026-10-30'], lines: ['練習室2,"メモ, あり",202610301000,202610301100,G1234 山田'] })`);
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(res.added, 1);
  const list = await w.run(`devCf.core.api({ action: 'getSchedule', params: { from: '2026-10-30', to: '2026-10-30' } })`);
  assert.ok(list.reservations.some((r) => r.roomId === 'room_02' && r.name === '山田' && r.affiliation === 'G1234'));
});
