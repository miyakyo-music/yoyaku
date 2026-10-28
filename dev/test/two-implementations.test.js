/**
 * GAS（gas/Code.gs）と Cloudflare（cache/store.js・cache/worker.js）は、意図して同じ処理を2つ持っている。
 * 動く場所が違うので、片方だけ直すと静かにずれる。ここでは「同じであるべきもの」を確かめる。
 *   - 画面から呼ぶ操作の一覧が、両方にある（GAS だけの mirrorNow・passkeyRevoked を除く）
 *   - SYSTEM の定数が同じ値（意図して違うものは理由付きで除外）
 *   - パスキーのログインの印の有効時間が、Worker・Store・GAS で同じ
 *   - API_VERSION が3か所で同じ
 *
 * 動き（同じ入力で同じ結果）は dev/test/scenario.test.js の台本が見る。ここは、その手前の「形」を見る。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./world.js');

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** const SYSTEM = { … }; の、名前と値（コメントを除いた文字列）を取り出す */
function systemConstants(file) {
  const m = /const SYSTEM = \{([\s\S]*?)\n\s*\};/.exec(read(file));
  assert.ok(m, `${file} に const SYSTEM = { … }; が見つからない`);
  const out = new Map();
  for (const line of m[1].split('\n')) {
    const k = line.match(/^\s*([A-Z][A-Z0-9_]*):\s*([^,]+),/);
    if (!k) continue;
    out.set(k[1], k[2].replace(/\/\/.*/, '').trim());
  }
  return out;
}

/** const API = { … }; の、操作の名前を取り出す（GAS は `名前: 関数,`、Store は `名前,` の並び） */
function apiActions(file, style) {
  const m = /const API = \{([\s\S]*?)\n\s*\};/.exec(read(file));
  assert.ok(m, `${file} に const API = { … }; が見つからない`);
  if (style === 'gas') return [...m[1].matchAll(/^\s*([A-Za-z_$][\w$]*):/gm)].map((x) => x[1]).sort();
  return [...new Set(m[1].match(/[A-Za-z_$][\w$]*/g) || [])].sort();
}

// GAS だけにある操作（GAS から Cloudflare へ写すとき・パスキーを消したときの合図。画面からは呼ばない）
const GAS_ONLY_ACTIONS = ['mirrorNow', 'passkeyRevoked'];

// GAS だけにある定数（GAS の実行環境に合わせたもの）
const GAS_ONLY_CONSTANTS = {
  TIMEZONE: 'スプレッドシートの時間帯',
  LOCK_WAIT_MS: 'GAS のロックを待つ時間',
  CACHE_MONTHS_AHEAD: '高速キャッシュに置く範囲（GAS が写しを作る範囲）',
};

// Store だけにある定数（Cloudflare の実行環境に合わせたもの）
const STORE_ONLY_CONSTANTS = {
  PBKDF2_ROUNDS: '管理用パスワードを戻せない形にする計算の回数',
};

test('画面から呼ぶ操作の一覧が、GAS と Store で同じ（GAS だけの2つを除く）', () => {
  const gas = apiActions('gas/Code.gs', 'gas');
  const store = apiActions('cache/store.js', 'store');
  assert.deepStrictEqual(store, gas.filter((a) => !GAS_ONLY_ACTIONS.includes(a)), 'GAS と Store の操作の一覧が違う');

  const web = new Set();
  for (const dir of ['web/index', 'web/admin']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith('.js'))) {
      for (const m of read(dir + '/' + f).matchAll(/\bapi\('([A-Za-z]+)'/g)) web.add(m[1]);
    }
  }
  assert.deepStrictEqual([...web].sort(), store, '画面が呼ぶ操作と、Store の操作の一覧が違う');
});

test('SYSTEM の定数は、意図して違うものだけが違う', () => {
  const gas = systemConstants('gas/Code.gs');
  const store = systemConstants('cache/store.js');
  const onlyGas = [...gas.keys()].filter((k) => !store.has(k)).sort();
  const onlyStore = [...store.keys()].filter((k) => !gas.has(k)).sort();
  assert.deepStrictEqual(onlyGas, Object.keys(GAS_ONLY_CONSTANTS).sort(), 'GAS だけにある定数が増えた（理由を書いて除外表へ）');
  assert.deepStrictEqual(onlyStore, Object.keys(STORE_ONLY_CONSTANTS).sort(), 'Store だけにある定数が増えた（理由を書いて除外表へ）');

  // 意図して違う値（GAS は1分30件、Store はその倍）。ここも、どちらかだけ変えたら気づけるようにする
  assert.strictEqual(gas.get('MAX_WRITES_PER_MINUTE'), '30', 'GAS の書き込みの上限');
  assert.strictEqual(store.get('MAX_WRITES_PER_MINUTE'), '60', 'Store の書き込みの上限');

  for (const [k, v] of gas) {
    if (!store.has(k) || k === 'MAX_WRITES_PER_MINUTE') continue;
    assert.strictEqual(store.get(k), v, `SYSTEM.${k} が GAS と Store で違う`);
  }
});

test('パスキーのログインの印の有効時間が、Worker・Store・GAS で同じ', () => {
  const hours = Number((read('cache/worker.js').match(/const TOKEN_HOURS = (\d+)/) || [])[1]);
  assert.ok(hours > 0, 'cache/worker.js に TOKEN_HOURS が見つからない');
  assert.strictEqual(Number(systemConstants('gas/Code.gs').get('PASSKEY_TOKEN_HOURS')), hours);
  assert.strictEqual(Number(systemConstants('cache/store.js').get('PASSKEY_TOKEN_HOURS')), hours);
});

test('API_VERSION が web/api.js・gas/Code.gs・cache/store.js で同じ', () => {
  const ver = (file) => Number((read(file).match(/const API_VERSION = (\d+);/) || [])[1]);
  assert.ok(ver('web/api.js') > 0, 'web/api.js に API_VERSION が見つからない');
  assert.strictEqual(ver('gas/Code.gs'), ver('web/api.js'));
  assert.strictEqual(ver('cache/store.js'), ver('web/api.js'));
});
