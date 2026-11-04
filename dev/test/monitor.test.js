/**
 * 見張り（monitor/judge.js・monitor/worker.js・dev/monitor.js）の判定と、知らせを送るかの決め方を、作った応答で確かめる（ネットにはつながない）。
 * GAS（gas/Code.gs）の monitorAlert が、署名を確かめてからメールを送ることも確かめる。
 * あわせて、GAS（gas/Code.gs）が /mirror/changes に付けて送る版を、Store（cache/store.js）が覚えて出すことを、
 * テスト環境と同じ組み立て（world.js）で確かめる。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { judge, judgeMonitor, readCacheUrl, readGasBuild, readMonitorUrl } = require('../monitor.js');
const { step, judgeItems } = globalThis.MonitorJudge;
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

// ---------------- 監視用の Worker（monitor/） ----------------

const MIN = 60000;
const item = (kind) => ({ kind, text: kind + ' が悪い' });

test('知らせは「2回続けて悪い」「増えた」「すべて直った」「24時間続く」のときだけ', () => {
  let t = NOW;
  let r = step(null, [], t);
  assert.strictEqual(r.mail, null, '良好なら送らない');
  r = step(r.state, [item('gas')], t += 5 * MIN);
  assert.strictEqual(r.mail, null, '1回だけ悪いのは、一時的かもしれないので送らない');
  r = step(r.state, [item('gas')], t += 5 * MIN);
  assert.match(r.mail.subject, /止まっている恐れ/);
  assert.match(r.mail.body, /gas が悪い/);
  r = step(r.state, [item('gas')], t += 5 * MIN);
  assert.strictEqual(r.mail, null, '同じものが続いている間は、もう送らない');
  r = step(r.state, [item('gas'), item('slow')], t += 5 * MIN);
  assert.strictEqual(r.mail, null, '増えたものも、1回目は待つ');
  r = step(r.state, [item('gas'), item('slow')], t += 5 * MIN);
  assert.match(r.mail.subject, /増えました/);
  assert.match(r.mail.body, /slow が悪い/);
  r = step(r.state, [item('gas')], t += 5 * MIN);
  assert.strictEqual(r.mail, null, '一部だけ直ったときは送らない');
  r = step(r.state, [item('gas')], t += 24 * 60 * MIN);
  assert.match(r.mail.subject, /まだ直っていません/);
  r = step(r.state, [], t += 5 * MIN);
  assert.match(r.mail.subject, /直りました/);
  assert.strictEqual(r.state.alerting, false);
  assert.strictEqual(r.state.lastOkAt, t);
  r = step(r.state, [], t += 5 * MIN);
  assert.strictEqual(r.mail, null);
});

test('一度だけ悪かったものが直っても、知らせていなければ「直った」は送らない', () => {
  let r = step(null, [item('pages')], NOW);
  r = step(r.state, [], NOW + 5 * MIN);
  assert.strictEqual(r.mail, null);
});

test('GAS の版の違いは、反映が追いつくまでの30分は知らせない', () => {
  const st = cf({ gas: { build: 'old', at: ago(3), via: 'mirror' } });
  const items = judgeItems(st, { now: NOW, build: BUILD });
  assert.deepStrictEqual(items.map((i) => i.kind), ['build']);
  let r = step(null, items, NOW);
  r = step(r.state, items, NOW + 25 * MIN);
  assert.strictEqual(r.mail, null);
  r = step(r.state, items, NOW + 30 * MIN);
  assert.match(r.mail.body, /old/);
});

test('控えの見張りが、監視用の Worker の止まり・メールの失敗を見つける', () => {
  assert.deepStrictEqual(judgeMonitor({ ok: true, lastRunAt: ago(6) }, NOW), []);
  assert.ok(has(judgeMonitor({ ok: true, lastRunAt: ago(31) }, NOW), '31 分前'));
  assert.ok(has(judgeMonitor({ ok: true, lastRunAt: null }, NOW), '一度も'));
  assert.ok(has(judgeMonitor({ ok: true, lastRunAt: ago(1), mailError: 'x' }, NOW), 'メールを送れて'));
  assert.ok(has(judgeMonitor(null, NOW), '読めません'));
  assert.match(readMonitorUrl(), /^https:\/\/yoyaku-monitor\.[^/]+\.workers\.dev$/);
});

test('監視用の Worker の設定の URL が、web/config.js・cache/wrangler.toml と同じ', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');
  const toml = read('monitor/wrangler.toml');
  const v = (name, text = toml) => (new RegExp('^' + name + ' = "([^"]*)"', 'm').exec(text) || [])[1];
  assert.strictEqual(v('CACHE_URL'), readCacheUrl());
  assert.strictEqual(v('GAS_URL'), /window\.GAS_API_URL = '([^']*)'/.exec(read('web/config.js'))[1]);
  assert.strictEqual(v('GAS_URL'), v('GAS_URL', read('cache/wrangler.toml')));
  assert.match(v('CODE_URL'), /\/main\/gas\/Code\.gs$/);
});

/** 監視用の Worker の State を、作った通信で1回動かす。routes は URL の先頭 → 返す {status, body, ms?} */
async function runMonitor(routes, prev, env) {
  const { State } = await import('../../monitor/worker.js');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const key = Object.keys(routes).find((k) => String(url).startsWith(k));
    const r = key ? routes[key] : { status: 404, body: '{}' };
    if (r.error) throw new Error(r.error);
    if (r.ms) await new Promise((ok) => setTimeout(ok, r.ms));
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status || 200 });
  };
  try {
    const saved = new Map(prev ? [['state', prev]] : []);
    const ctx = { storage: { get: async (k) => saved.get(k), put: async (k, v) => saved.set(k, v) } };
    const s = new State(ctx, Object.assign({
      CACHE_URL: 'https://c.test', PAGES_URL: 'https://p.test/', CODE_URL: 'https://code.test/Code.gs',
      GAS_URL: 'https://gas.test/exec', PUSH_TOKEN: 'tok',
    }, env || {}));
    await s.fetch(new Request('https://state/run', { method: 'POST' }));
    const status = await (await s.fetch(new Request('https://state/status'))).json();
    return { calls, state: saved.get('state'), status };
  } finally {
    globalThis.fetch = realFetch;
  }
}

function goodRoutes(over) {
  const now = Date.now();
  const t = (min) => new Date(now - min * MIN + 9 * 3600000).toISOString().slice(0, 19) + '+09:00';
  return Object.assign({
    'https://c.test/schedule': { body: { ok: true, reservations: [] } },
    'https://c.test/': { body: { ok: true, primary: 'cloudflare', gas: { build: 'B1', at: t(2) }, mirror: { unmirrored: 0 } } },
    'https://p.test/': { body: '<!doctype html>' },
    'https://code.test/': { body: "const X = 1;\nconst GAS_BUILD = 'B1';\n" },
    'https://gas.test/': { body: { ok: true } },
  }, over);
}

test('監視用の Worker: 良好なら何も送らず、最後に動いた時刻とリポジトリの版を覚える', async () => {
  const { calls, state, status } = await runMonitor(goodRoutes());
  assert.deepStrictEqual(status.problems, []);
  assert.ok(status.lastRunAt && status.lastOkAt);
  assert.strictEqual(state.repoBuild, 'B1');
  assert.ok(!calls.some((c) => c.url.startsWith('https://gas.test')), 'メールは頼まない');
  assert.ok(calls.some((c) => /\/schedule\?from=\d{4}-\d{2}-\d{2}&to=/.test(c.url)));
});

test('監視用の Worker: 2回続けて悪ければ、合言葉で署名して GAS にメールを頼む。送れなければ次の回にもう一度', async () => {
  const routes = goodRoutes({ 'https://p.test/': { status: 503, body: 'down' }, 'https://c.test/schedule': { error: 'timeout' } });
  const first = await runMonitor(routes);
  assert.deepStrictEqual(first.status.problems.map((p) => p.kind).sort(), ['pages', 'schedule']);
  // 5分たったことにする
  const prev = JSON.parse(JSON.stringify(first.state));
  for (const k of Object.keys(prev.problems)) prev.problems[k].since -= 5 * MIN;
  const second = await runMonitor(routes, prev);
  const sent = second.calls.find((c) => c.url.startsWith('https://gas.test'));
  assert.ok(sent, 'メールを頼んだ');
  const req = JSON.parse(sent.init.body);
  assert.strictEqual(req.action, 'monitorAlert');
  const p = req.params;
  const sig = nodeCrypto.createHmac('sha256', 'tok').update('mon1.' + p.at + '.' + p.subject + '\n' + p.body).digest('base64url');
  assert.strictEqual(p.sig, sig, 'gas/Code.gs の hmac_ と同じ作り方の署名');
  assert.match(p.body, /GitHub Pages/);
  assert.strictEqual(second.state.alerting, true);
  // GAS が断ったら、知らせる前の状態に戻し、理由を出す
  const failed = await runMonitor(Object.assign({}, routes, { 'https://gas.test/': { body: { ok: false, message: 'だめ' } } }), prev);
  assert.strictEqual(failed.state.alerting, false);
  assert.match(failed.status.mailError, /だめ/);
});

test('監視用の Worker: 返事が遅ければ「遅い」', async () => {
  const lim = globalThis.MonitorJudge.LIMITS;
  const keep = lim.slowMs;
  lim.slowMs = 40; // 試験では 40ms を「遅い」の境目にする
  try {
    const fast = await runMonitor(goodRoutes());
    assert.deepStrictEqual(fast.status.problems, []);
    const slow = await runMonitor(goodRoutes({ 'https://c.test/schedule': { body: { ok: true }, ms: 80 } }));
    assert.deepStrictEqual(slow.status.problems.map((p) => p.kind), ['slow']);
  } finally {
    lim.slowMs = keep;
  }
});

test('GAS の monitorAlert: 署名が合えばオーナーにメールを送り、合わなければ送らない。1日の上限がある', () => {
  const w = createWorld({ now: '2026-10-27T09:00:00+09:00' });
  const at = Math.floor(w.run('Date.now()') / 1000);
  const sign = (subject, body) => nodeCrypto.createHmac('sha256', 'devtoken').update('mon1.' + at + '.' + subject + '\n' + body).digest('base64url');
  const call = (params) => JSON.parse(w.run('JSON.stringify(monitorAlert(' + JSON.stringify(params) + '))'));
  assert.strictEqual(call({ at, subject: '件名', body: '本文', sig: 'x' }).code, 'UNAUTHORIZED');
  assert.strictEqual(call({ at: at - 3600, subject: '件名', body: '本文', sig: sign('件名', '本文') }).code, 'UNAUTHORIZED', '古い頼みは受けない');
  assert.strictEqual(w.run('MailApp.sent.length'), 0);
  assert.ok(call({ at, subject: '件名', body: '本文', sig: sign('件名', '本文') }).ok);
  assert.deepStrictEqual(JSON.parse(w.run('JSON.stringify(MailApp.sent[0])')).to, 'owner@example.test');
  for (let i = 1; i < 20; i++) assert.ok(call({ at, subject: '件名', body: '本文', sig: sign('件名', '本文') }).ok);
  assert.strictEqual(call({ at, subject: '件名', body: '本文', sig: sign('件名', '本文') }).code, 'LIMIT');
  // 正本が Cloudflare でも受ける（MOVED を返さない）
  w.run('migrateToCloudflare()');
  const res = JSON.parse(w.run('doPost({ postData: { contents: ' + JSON.stringify(JSON.stringify({ action: 'monitorAlert', params: { at, subject: 's', body: 'b', sig: 'x' } })) + ' } }).getContent()'));
  assert.strictEqual(res.code, 'UNAUTHORIZED');
});
