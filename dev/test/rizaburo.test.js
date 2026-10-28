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

test('今日は20分ごと、翌日は毎時30分', () => {
  assert.deepStrictEqual(P.datesFor(at('2026-10-28T09:00:00+09:00')), ['2026-10-28']);
  assert.deepStrictEqual(P.datesFor(at('2026-10-28T09:20:00+09:00')), ['2026-10-28']);
  assert.deepStrictEqual(P.datesFor(at('2026-10-28T09:40:00+09:00')), ['2026-10-28']);
  assert.deepStrictEqual(P.datesFor(at('2026-10-28T09:10:00+09:00')), []);
  assert.deepStrictEqual(P.datesFor(at('2026-10-28T09:30:00+09:00')), ['2026-10-29']);
});

test('2日後以降は朝夕に5分間隔で1日ずつ', () => {
  assert.deepStrictEqual(P.datesFor(at('2026-10-28T04:05:00+09:00')), ['2026-10-30']);
  assert.deepStrictEqual(P.datesFor(at('2026-10-28T04:15:00+09:00')), ['2026-10-31']);
  assert.deepStrictEqual(P.datesFor(at('2026-10-28T16:05:00+09:00')), ['2026-10-30']);
  assert.deepStrictEqual(P.datesFor(at('2026-10-28T16:25:00+09:00')), ['2026-11-01']);
  assert.deepStrictEqual(P.datesFor(at('2026-10-28T09:15:00+09:00')), ['2026-11-30']);
  assert.deepStrictEqual(P.datesFor(at('2026-10-28T09:25:00+09:00')), []);
});

test('夜間は今日と翌日だけ', () => {
  assert.deepStrictEqual(P.datesFor(at('2026-10-28T23:10:00+09:00')), []);
  assert.deepStrictEqual(P.datesFor(at('2026-10-28T23:00:00+09:00')), ['2026-10-28']);
  assert.deepStrictEqual(P.datesFor(at('2026-10-28T23:30:00+09:00')), ['2026-10-29']);
  assert.deepStrictEqual(P.datesFor(at('2026-10-28T00:00:00+09:00')), ['2026-10-28']);
});

test('1日を通して、どの回も1日分だけ', () => {
  const count = {};
  let max = 0;
  let total = 0;
  for (let ms = at('2026-10-28T00:00:00+09:00'); ms < at('2026-10-29T00:00:00+09:00'); ms += 5 * 60000) {
    const ds = P.datesFor(ms);
    max = Math.max(max, ds.length);
    total += ds.length;
    for (const d of ds) count[d] = (count[d] || 0) + 1;
  }
  assert.strictEqual(max, 1);
  assert.strictEqual(total, 146);
  assert.strictEqual(count['2026-10-28'], 58);
  assert.strictEqual(count['2026-10-29'], 24);
  for (let d = '2026-10-30'; d <= '2026-11-30'; d = P.addDays(d, 1)) assert.strictEqual(count[d], 2, d);
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
