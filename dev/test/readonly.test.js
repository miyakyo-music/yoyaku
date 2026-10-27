/**
 * Cloudflare が正本なのに届かないとき（仕様書 2.7.6）: 予約表の読み取りだけ GAS の写しから返り（readOnly）、
 * 書き込みは写しに回らず、Cloudflare が戻れば元どおり Cloudflare から読むことを、ブラウザなしで確かめる。
 * 画面の web/api.js（callApi）と本物の gas/Code.gs・cache/store.js を、テスト環境と同じ組み立て（world.js）で動かす。
 * Cloudflare を止めるのは dev/cf-stub.js の devCf.down（'network' = 通信の失敗、'500' = 503 を返す）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createWorld } = require('./world.js');

const NOW = '2026-10-10T09:00:00+09:00';
const A = 'admin123';
const range = { from: '2026-10-12', to: '2026-10-12' };
const book = { roomId: 'room_01', date: '2026-10-12', start: '10:00', end: '11:00', affiliation: 'G1', name: '写しの試験', memo: '', pin: '1234' };
const call = (w, action, params, opts) => w.run(`callApi(${JSON.stringify(action)}, ${JSON.stringify(params)}, ${JSON.stringify(opts || {})})`);
/** GAS の doPost を直接呼ぶ（画面を通さない） */
const gas = (w, action, params) => JSON.parse(w.run(`doPost({ postData: { contents: ${JSON.stringify(JSON.stringify({ action, params }))} } }).getContent()`));

function cfWorld() {
  const w = createWorld({ now: NOW });
  w.run('migrateToCloudflare()');
  assert.strictEqual(w.run("PropertiesService.getScriptProperties().getProperty('PRIMARY')"), 'cloudflare', 'Cloudflare に移せなかった');
  return w;
}
// GAS に写させる（合図の mirrorNow は8秒に1回までに間引かれ、移した直後の合図で使い切っているので、見回りと同じく直接呼ぶ）
const mirrored = async (w) => { await w.settle(); assert.ok(w.run('mirrorPull_()').ok, '写せなかった'); };

for (const mode of ['network', '500']) {
  test(`Cloudflare に届かない（${mode === 'network' ? '通信の失敗' : '503'}）間は、写しから見るだけ`, async () => {
    const w = cfWorld();
    const made = await call(w, 'createReservation', book);
    assert.ok(made.ok, JSON.stringify(made));
    await mirrored(w);
    const normal = await call(w, 'getSchedule', range, { readFallback: true });
    assert.ok(normal.ok && !normal.readOnly, '止める前は Cloudflare から読む');

    w.run(`devCf.down = '${mode}'`);
    const ro = await call(w, 'getSchedule', range, { readFallback: true });
    assert.ok(ro.ok, JSON.stringify(ro));
    assert.strictEqual(ro.readOnly, true, '写しから返ったら readOnly が付く');
    assert.match(ro.mirrorAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, '写しの時刻が付く');
    assert.ok(ro.reservations.some((r) => r.id === made.reservation.id), 'Cloudflare で入れた予約が写しにある');
    assert.ok(ro.reservations.every((r) => !('pin' in r)), '編集用パスワードは返さない');
    assert.deepStrictEqual(ro.reservations, normal.reservations, '写しと正本の予約が同じ');
    const mine = await call(w, 'getReservationsByIds', { ids: [made.reservation.id] }, { readFallback: true });
    assert.ok(mine.ok && mine.readOnly && mine.reservations.length === 1, '自分の予約も写しから読める');

    // readFallback を付けない読み取り（管理画面）と書き込みは、写しに回らない
    await assert.rejects(call(w, 'getSchedule', range), '管理画面の読み取りは写しに回らない');
    await assert.rejects(call(w, 'createReservation', Object.assign({}, book, { start: '12:00', end: '13:00' })), '書き込みは送れない');
    // GAS に readOnly 付きの書き込みを送っても MOVED。readOnly のない getSchedule も MOVED（古い画面が写しを正本と思わないように）
    assert.strictEqual(gas(w, 'createReservation', Object.assign({ readOnly: true }, book)).code, 'MOVED');
    assert.strictEqual(gas(w, 'getSchedule', range).code, 'MOVED');

    w.run('devCf.down = false');
    const back = await call(w, 'getSchedule', range, { readFallback: true });
    assert.ok(back.ok && !back.readOnly, '戻ったら Cloudflare から読む');
    assert.deepStrictEqual(w.errors, [], 'コンソールに赤いエラーが出た');
  });
}

test('写しから読むときも、閲覧パスワード・限定公開の扱いは今の getSchedule と同じ', async () => {
  const w = cfWorld();
  const data = await call(w, 'adminGetData', { adminPassword: A });
  const saved = await call(w, 'adminSaveSettings', { adminPassword: A, settings: Object.assign({}, data.settings, { viewPassword: 'yomu', limitedPassword: 'gentei' }) });
  assert.ok(saved.ok, JSON.stringify(saved));
  await mirrored(w);
  w.run("devCf.down = 'network'");
  const fb = { readFallback: true };
  assert.strictEqual((await call(w, 'getSchedule', range, fb)).code, 'AUTH_REQUIRED', '閲覧パスワードがないと断る');
  assert.strictEqual((await call(w, 'getSchedule', Object.assign({ viewKey: 'chigau' }, range), fb)).code, 'AUTH_REQUIRED', '違う閲覧パスワードも断る');
  const pub = await call(w, 'getSchedule', Object.assign({ viewKey: 'yomu' }, range), fb);
  assert.ok(pub.ok && pub.readOnly, JSON.stringify(pub));
  assert.ok(pub.rooms.every((r) => r.restriction !== '限定公開'), '限定公開のパスワードがなければ限定公開の部屋を出さない');
  const lim = await call(w, 'getSchedule', Object.assign({ viewKey: 'yomu', limitedKey: 'gentei' }, range), fb);
  assert.ok(lim.ok && lim.limitedAccess, '限定公開のパスワードが合えば見られる');
  const bad = await call(w, 'getSchedule', Object.assign({ viewKey: 'yomu', limitedKey: 'x' }, range), fb);
  assert.ok(bad.ok && bad.limitedDenied, '違えば limitedDenied');
  // 管理用パスワード（Cloudflare で変えられているかもしれない）はここでは使わない: 断らず（ADMIN_AUTH にせず）一般の見え方で返す
  const admin = await call(w, 'getSchedule', Object.assign({ viewKey: 'yomu', adminPassword: 'wrong' }, range), fb);
  assert.ok(admin.ok && admin.readOnly && admin.openBugs === undefined, JSON.stringify(admin));
  assert.deepStrictEqual(w.errors, [], 'コンソールに赤いエラーが出た');
});
