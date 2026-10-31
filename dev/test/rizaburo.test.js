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

test('普通の予約を、取り込みの直しで書き換えない', async () => {
  const w = createWorld({ now: '2026-10-28T09:00:00+09:00' });
  await w.run('migrateToCloudflare()');
  await w.settle();
  const made = await w.run(`devCf.core.api({ action: 'createReservation', params: { roomId: 'room_01', date: '2026-10-31', start: '10:05', end: '11:00', name: '自分', affiliation: 'G1' } })`);
  assert.strictEqual(made.ok, true, JSON.stringify(made));
  const res = await w.run(`devCf.core.importRizaburo({ from: '2026-10-31', to: '2026-10-31', dates: ['2026-10-31'], lines: ['練習室1,"",202610311002,202610311100,G1 自分'] })`);
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(res.fixed, 0);
  assert.strictEqual(res.overlap, 1);
  const list = await w.run(`devCf.core.api({ action: 'getSchedule', params: { from: '2026-10-31', to: '2026-10-31' } })`);
  const hit = list.reservations.filter((r) => r.roomId === 'room_01' && r.date === '2026-10-31');
  assert.strictEqual(hit.length, 1);
  assert.strictEqual(hit[0].start, '10:05');
});

test('取り込み済みの予約を削除しても、りざぶ郎が同じなら戻らない', async () => {
  const w = createWorld({ now: '2026-10-28T09:00:00+09:00' });
  await w.run('migrateToCloudflare()');
  await w.settle();
  const line = '練習室1,"",202611011000,202611011100,G1 自分';
  const first = await w.run(`devCf.core.importRizaburo({ from: '2026-11-01', to: '2026-11-01', dates: ['2026-11-01'], lines: ['${line}'] })`);
  assert.strictEqual(first.added, 1, JSON.stringify(first));
  const before = await w.run(`devCf.core.api({ action: 'getSchedule', params: { from: '2026-11-01', to: '2026-11-01' } })`);
  const id = before.reservations.find((r) => r.roomId === 'room_01' && r.date === '2026-11-01').id;
  const del = await w.run(`devCf.core.api({ action: 'adminDeleteReservations', params: { adminPassword: 'admin123', ids: ['${id}'] } })`);
  assert.strictEqual(del.ok, true, JSON.stringify(del));
  const again = await w.run(`devCf.core.importRizaburo({ from: '2026-11-01', to: '2026-11-01', dates: ['2026-11-01'], lines: ['${line}'] })`);
  assert.strictEqual(again.added, 0, JSON.stringify(again));
  assert.ok(again.ignored >= 1);
  const after = await w.run(`devCf.core.api({ action: 'getSchedule', params: { from: '2026-11-01', to: '2026-11-01' } })`);
  assert.strictEqual(after.reservations.filter((r) => r.roomId === 'room_01' && r.date === '2026-11-01').length, 0);
});

test('取り込み済みの予約を変更しても、りざぶ郎が同じなら上書きしない', async () => {
  const w = createWorld({ now: '2026-10-28T09:00:00+09:00' });
  await w.run('migrateToCloudflare()');
  await w.settle();
  const line = '練習室1,"",202611021000,202611021100,G1 自分';
  const first = await w.run(`devCf.core.importRizaburo({ from: '2026-11-02', to: '2026-11-02', dates: ['2026-11-02'], lines: ['${line}'] })`);
  assert.strictEqual(first.added, 1, JSON.stringify(first));
  const before = await w.run(`devCf.core.api({ action: 'getSchedule', params: { from: '2026-11-02', to: '2026-11-02' } })`);
  const id = before.reservations.find((r) => r.roomId === 'room_01' && r.date === '2026-11-02').id;
  const upd = await w.run(`devCf.core.api({ action: 'updateReservation', params: { id: '${id}', roomId: 'room_01', date: '2026-11-02', start: '10:30', end: '11:30', name: '自分', affiliation: 'G1', adminPassword: 'admin123' } })`);
  assert.strictEqual(upd.ok, true, JSON.stringify(upd));
  const again = await w.run(`devCf.core.importRizaburo({ from: '2026-11-02', to: '2026-11-02', dates: ['2026-11-02'], lines: ['${line}'] })`);
  assert.strictEqual(again.added, 0, JSON.stringify(again));
  assert.ok(again.ignored >= 1);
  const after = await w.run(`devCf.core.api({ action: 'getSchedule', params: { from: '2026-11-02', to: '2026-11-02' } })`);
  assert.strictEqual(after.reservations.find((r) => r.roomId === 'room_01' && r.date === '2026-11-02').start, '10:30');
});

test('この仕組みを入れる前の取り込みも、操作ログから引き継ぐ', async () => {
  const w = createWorld({ now: '2026-10-28T09:00:00+09:00' });
  await w.run('migrateToCloudflare()');
  await w.settle();
  const line = '練習室1,"",202611031000,202611031100,G1 自分';
  const first = await w.run(`devCf.core.importRizaburo({ from: '2026-11-03', to: '2026-11-03', dates: ['2026-11-03'], lines: ['${line}'] })`);
  assert.strictEqual(first.added, 1, JSON.stringify(first));
  const before = await w.run(`devCf.core.api({ action: 'getSchedule', params: { from: '2026-11-03', to: '2026-11-03' } })`);
  const id = before.reservations.find((r) => r.roomId === 'room_01' && r.date === '2026-11-03').id;
  const del = await w.run(`devCf.core.api({ action: 'adminDeleteReservations', params: { adminPassword: 'admin123', ids: ['${id}'] } })`);
  assert.strictEqual(del.ok, true, JSON.stringify(del));
  // 仕組みを入れる前の状態にする（指紋の記録を消す）。操作ログの「取り込み」から作り直せるはず
  await w.run(`devCf.core.db.exec("DELETE FROM kv WHERE k = 'rizaburoSeen:2026-11-03'")`);
  const again = await w.run(`devCf.core.importRizaburo({ from: '2026-11-03', to: '2026-11-03', dates: ['2026-11-03'], lines: ['${line}'] })`);
  assert.strictEqual(again.added, 0, JSON.stringify(again));
  assert.ok(again.ignored >= 1);
});

test('取り込みの履歴と日別の件数を残す', async () => {
  const w = createWorld({ now: '2026-10-28T09:00:00+09:00' });
  await w.run('migrateToCloudflare()');
  await w.settle();
  const line1 = '練習室1,"",202611011000,202611011100,G1 自分';
  const line2 = '練習室2,"",202611021000,202611021100,G2 自分';
  assert.strictEqual((await w.run(`devCf.core.importRizaburo({ from: '2026-11-01', to: '2026-11-01', dates: ['2026-11-01'], lines: ['${line1}'] })`)).added, 1);
  assert.strictEqual((await w.run(`devCf.core.importRizaburo({ from: '2026-11-01', to: '2026-11-01', dates: ['2026-11-01'], lines: ['${line1}'] })`)).ignored, 1);
  assert.strictEqual((await w.run(`devCf.core.importRizaburo({ from: '2026-11-02', to: '2026-11-02', dates: ['2026-11-02'], lines: ['${line2}'] })`)).added, 1);
  const p = await w.run(`devCf.core.rizaburoProgress(10)`);
  assert.strictEqual(p.ok, true, JSON.stringify(p));
  const d1 = p.dates.find((d) => d.date === '2026-11-01');
  assert.strictEqual(d1.seen, 1);
  assert.strictEqual(d1.current, 1);
  const d2 = p.dates.find((d) => d.date === '2026-11-02');
  assert.strictEqual(d2.seen, 1);
  assert.strictEqual(d2.current, 1);
  assert.strictEqual(p.totals.seen, 2);
  assert.strictEqual(p.totals.current, 2);
  assert.strictEqual(p.range.to, '2026-11-30');
  assert.strictEqual(p.runs.length, 3, JSON.stringify(p.runs));
  assert.strictEqual(p.runs[0].added, 1);
  assert.ok(p.runs.some((r) => r.ignored === 1), JSON.stringify(p.runs));
});

test('取り込みの履歴は直近500回まで', async () => {
  const w = createWorld({ now: '2026-10-28T09:00:00+09:00' });
  await w.run(`for (let i = 0; i < 505; i++) devCf.core.saveRizaburoRun({ at: '2026-10-28 09:00:00', ok: true, rows: i });`);
  const p = await w.run(`devCf.core.rizaburoProgress(500)`);
  assert.strictEqual(p.runs.length, 500);
  assert.strictEqual(p.runs[0].rows, 504);
  assert.strictEqual(p.runs[499].rows, 5);
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
