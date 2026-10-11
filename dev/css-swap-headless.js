#!/usr/bin/env node
/**
 * dev/css-swap.js の比べる処理を、画面に出さない Chrome でまとめて流す（見た目を変えない整理の確かめ）。
 * 組み込みブラウザで1つずつ待つより速く、途中で止まらない。結果だけを短く出す。
 *
 * 使い方（このリポジトリの一番上で）:
 *   node dev/css-swap-headless.js                 前の版 = HEAD（コミット前の変更を、最後のコミットと比べる）
 *   node dev/css-swap-headless.js --old v0.7.1-beta   前の版をタグやコミットで指定
 *   node dev/css-swap-headless.js --old keep      web/__old/ を今のまま使う
 *   node dev/css-swap-headless.js --only index-pc,admin-sp   一部の場面だけ
 *   node dev/css-swap-headless.js --list          場面の一覧
 * テスト環境（dev/serve.py）が動いていなければ、自分で起動して終わったら止める。
 * すべて同じなら「すべて同じ」と出して終了コード 0。違いやエラーがあれば中身を出して 1。
 * 必要なもの: Node 22 以上（WebSocket が標準）、/Applications/Google Chrome.app（CHROME で場所を変えられる）
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const NOW = 'now=2026-10-11T12:00:00';
const PC = { width: 1280, height: 860 };
const TABLET = { width: 820, height: 1180, mobile: true };
const PHONE = { width: 375, height: 812, mobile: true };
// 場面: どの画面を、どの幅で、どの状態（dev/css-swap.js の __st の手順）にしてから比べるか
const CASES = {
  'index-pc': { page: 'index', size: PC, steps: ['visitDialogs'] },
  'index-pc-book': { page: 'index', size: PC, steps: ['bookForm'] },
  'index-pc-month': { page: 'index', size: PC, steps: ['month'] },
  'index-tablet': { page: 'index', size: TABLET, steps: ['visitDialogs'] },
  'index-sp': { page: 'index', size: PHONE, steps: ['visitDialogs'] },
  'index-sp-book': { page: 'index', size: PHONE, steps: ['bookForm'] },
  'admin-pc': { page: 'admin', size: PC, steps: ['adminTabs'] },
  'admin-sp': { page: 'admin', size: PHONE, steps: ['adminTabs'] },
};
const PARALLEL = 4; // 同時に開く数（多すぎると計算が重なって遅くなる）
const CASE_TIMEOUT = 10 * 60 * 1000;
// テスト環境では接続先がないので、毎回出るエラー（作業と関係ない）
const IGNORE_ERR = [/dev-cf\.test\/live/];

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
if (args.includes('--list')) { for (const [k, c] of Object.entries(CASES)) console.log(k, c.size.width + 'px', c.steps.join('+')); process.exit(0); }
const only = opt('--only') ? opt('--only').split(',') : Object.keys(CASES);
for (const k of only) if (!CASES[k]) { console.error('知らない場面: ' + k); process.exit(2); }
const port = Number(opt('--port') || 8765);
const BASE = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 前の版を web/__old/ に置く ----------
function prepareOld() {
  const ref = opt('--old') || 'HEAD';
  const dir = path.join(ROOT, 'web/__old');
  if (ref === 'keep') { if (!fs.existsSync(dir)) throw new Error('web/__old/ がありません'); return 'web/__old/（そのまま）'; }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execSync(`git archive ${JSON.stringify(ref)} web | tar -x -C ${JSON.stringify(dir)} --strip-components=1`, { cwd: ROOT, stdio: 'inherit' });
  fs.writeFileSync(path.join(dir, 'config.js'), "window.GAS_API_URL = 'https://script.google.com/macros/s/dev-stub/exec';\nwindow.CACHE_API_URL = 'http://dev-cf.test';\n");
  return ref;
}

// ---------- テスト環境 ----------
async function up() { try { return (await fetch(BASE + '/')).ok; } catch { return false; } }
async function ensureServer() {
  if (await up()) return null;
  const p = spawn('python3', ['dev/serve.py', String(port)], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { if (await up()) return p; await sleep(100); }
  p.kill(); throw new Error('テスト環境が起動しません');
}

// ---------- Chrome（DevTools の通信） ----------
async function launchChrome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'css-swap-chrome-'));
  const p = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('Chrome が起動しません: ' + buf.slice(-300))), 20000);
    p.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
    p.on('exit', (c) => reject(new Error('Chrome が終了しました（' + c + '）')));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const waiting = new Map();
  const listeners = new Set();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result); }
    else for (const f of listeners) f(m);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const msg = { id: ++id, method, params }; if (sessionId) msg.sessionId = sessionId;
    waiting.set(msg.id, { resolve, reject }); ws.send(JSON.stringify(msg));
  });
  const close = () => { try { ws.close(); } catch { /* そのまま */ } p.kill(); setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 500); };
  return { send, listeners, close };
}

// ---------- 1つの場面 ----------
async function runCase(cdp, name) {
  const c = CASES[name];
  const errors = [];
  // 場面ごとに別の保存場所（localStorage など）を使い、互いに影響しないようにする
  const { browserContextId } = await cdp.send('Target.createBrowserContext');
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => cdp.send(m, p, sessionId);
  const onMsg = (m) => {
    if (m.sessionId !== sessionId) return;
    let text = null;
    if (m.method === 'Runtime.exceptionThrown') text = m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text;
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') text = m.params.entry.text + (m.params.entry.url ? ' ' + m.params.entry.url : '');
    if (text && !IGNORE_ERR.some((r) => r.test(text))) errors.push(text.split('\n')[0].slice(0, 200));
  };
  cdp.listeners.add(onMsg);
  try {
    await s('Page.enable'); await s('Runtime.enable'); await s('Log.enable');
    const { width, height, mobile } = c.size;
    await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile: !!mobile });
    if (mobile) {
      // 組み込みブラウザのスマホ表示と同じく、触って操作する端末として扱う（(hover: hover) が外れる）
      await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await s('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' });
    }
    const evaluate = async (expr) => {
      const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const go = async (url) => {
      await s('Page.navigate', { url });
      await evaluate(`new Promise((r) => { const t = Date.now(); (function f() { document.readyState === 'complete' && location.href === ${JSON.stringify(url)} ? r() : Date.now() - t > 20000 ? r() : setTimeout(f, 100); })(); })`);
    };
    const page = c.page === 'admin' ? '/admin.html' : '/';
    // 模擬データを初期化してから開く（?reset=1 は読み込み直しで消える）
    await s('Page.navigate', { url: BASE + page + '?reset=1' });
    await evaluate(`new Promise((r) => { const t = Date.now(); (function f() { !location.search && document.readyState === 'complete' ? r() : Date.now() - t > 20000 ? r() : setTimeout(f, 100); })(); })`).catch(() => {});
    await sleep(500);
    await go(BASE + page + (c.page === 'admin' ? '?light' : `?light&${NOW}`));
    if (c.page === 'admin') {
      const ok = await evaluate(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 100 && !document.querySelector('form input[type=password]')?.offsetParent; i++) await wait(100);
        const f = document.querySelector('form'); f.querySelector('input[type=password]').value = 'admin123'; f.requestSubmit();
        for (let i = 0; i < 150; i++) { if (document.querySelector('[data-tab]')?.offsetParent) return true; await wait(100); }
        return document.querySelector('.error, .msg.error')?.textContent || 'ログインできません';
      })()`);
      if (ok !== true) throw new Error('管理画面: ' + ok);
    }
    await evaluate(`new Promise((r, j) => { const x = document.createElement('script'); x.src = '/dev/css-swap.js'; x.onload = r; x.onerror = () => j(new Error('css-swap.js が読めません')); document.head.append(x); })`);
    const out = await Promise.race([
      evaluate(`window.__go(${JSON.stringify(c.steps)}).then(() => JSON.stringify({ err: window.__err, res: window.__res }))`),
      sleep(CASE_TIMEOUT).then(() => { throw new Error('時間切れ'); }),
    ]);
    const { err, res } = JSON.parse(out);
    if (err) throw new Error(err.split('\n')[0]);
    const entries = Object.entries(res || {});
    const diffs = entries.filter(([, v]) => v !== 'same');
    return { name, total: entries.length, diffs, errors };
  } catch (e) {
    return { name, fail: String(e.message || e), errors };
  } finally {
    cdp.listeners.delete(onMsg);
    await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}

(async () => {
  const t0 = Date.now();
  const oldRef = prepareOld();
  const server = await ensureServer();
  const cdp = await launchChrome();
  const results = [];
  try {
    const queue = [...only];
    await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      while (queue.length) { const n = queue.shift(); const r = await runCase(cdp, n); results.push(r); process.stdout.write('.'); }
    }));
  } finally {
    cdp.close();
    if (server) server.kill();
  }
  process.stdout.write('\n');
  let bad = 0;
  console.log(`前の版: ${oldRef}（${Math.round((Date.now() - t0) / 1000)}秒）`);
  for (const r of only.map((n) => results.find((x) => x.name === n))) {
    if (r.fail) { bad++; console.log(`✗ ${r.name}: 比べられませんでした — ${r.fail}`); }
    else if (r.diffs.length) {
      bad++;
      console.log(`✗ ${r.name}: ${r.total - r.diffs.length}/${r.total} 同じ。違う状態:`);
      for (const [pass, v] of r.diffs) {
        console.log(`   [${pass}] ${v.n} か所`);
        for (const d of v.first.slice(0, 4)) console.log(`     ${d.el}: ${d.props.slice(0, 3).join(' /').trim()}`);
      }
    } else console.log(`○ ${r.name}: ${r.total}/${r.total} 同じ`);
    if (r.errors.length) { bad++; console.log(`   コンソールのエラー: ${[...new Set(r.errors)].slice(0, 5).join(' | ')}`); }
  }
  console.log(bad ? '違いかエラーがあります' : 'すべて同じ');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
