#!/usr/bin/env node
/**
 * 見張り: 高速キャッシュの Worker の GET /（cache/worker.js の status）を読み、止まっていそうなところがあれば失敗する。
 * GitHub Actions の「見張り」（.github/workflows/monitor.yml）が1日に数回流す。手元でも流せる。
 *   使い方（このリポジトリの一番上で）: node dev/monitor.js
 *   Worker の URL は web/config.js の CACHE_API_URL、GAS の版は gas/Code.gs の GAS_BUILD から読む（秘密の値は使わない）。
 *   すべて良ければ終了コード 0、悪いところがあれば、何が悪いかを日本語で出して 1。
 * 判定（judge）はネットにつながずに試験できるよう分けてある（dev/test/monitor.test.js）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// どれだけ遅れたら「止まっている」とみなすか（分）。仕組みから決めた値（仕様書 4.5・4.6）
const LIMITS = {
  // 正本が Cloudflare のとき: 予約が変わると10秒後に GAS へ合図が行き、届かなくても GAS の cacheRetry が5分ごとに写す。
  // 「写し終えた」は次の呼び出しで伝わるので、ふだんは長くて10分ほどで消える
  unmirroredMinutes: 30,
  // 正本が Cloudflare のとき: GAS の cacheRetry は予約がなくても5分ごとに /mirror/changes を読みに来る。
  // GAS のトリガーはときどき遅れたり1回抜けたりするので、余裕を見て1時間
  gasMirrorMinutes: 60,
  // 正本が GAS のとき: GAS は予約が変わるたびと、日付が変わった最初の見回り（毎日0時すぎ）に /push で写しを送る。
  // 予約がない日でも1日1回は来るので、24時間に余裕を足して26時間
  gasPushMinutes: 26 * 60,
};

/** web/config.js の CACHE_API_URL（空なら ''） */
function readCacheUrl(root = ROOT) {
  const text = fs.readFileSync(path.join(root, 'web/config.js'), 'utf8');
  const m = /window\.CACHE_API_URL\s*=\s*'([^']*)'/.exec(text);
  return m ? m[1].trim().replace(/\/+$/, '') : '';
}

/** gas/Code.gs の GAS_BUILD（見つからなければ ''） */
function readGasBuild(root = ROOT) {
  const text = fs.readFileSync(path.join(root, 'gas/Code.gs'), 'utf8');
  const m = /^const GAS_BUILD = '([^']*)';/m.exec(text);
  return m ? m[1] : '';
}

/** 「YYYY-MM-DDTHH:mm:ss+09:00」などの時刻をミリ秒に。読めなければ NaN */
function parseTime(text) {
  return text ? Date.parse(String(text)) : NaN;
}

/** 何分前か（小数は切り捨て。時計のずれで先の時刻になっていたら 0） */
function minutesAgo(text, now) {
  const t = parseTime(text);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60000)) : NaN;
}

/**
 * 応答を判定する。悪いところの一覧（日本語の文の配列）を返す。空なら良い。
 * @param status GET / の応答の JSON（読めなかったら null）
 * @param opts {now: ミリ秒, build: リポジトリの GAS_BUILD, limits?: LIMITS を上書き}
 */
function judge(status, opts) {
  const now = opts.now;
  const lim = Object.assign({}, LIMITS, opts.limits || {});
  const bad = [];
  if (!status || typeof status !== 'object') return ['Worker の応答が JSON として読めません。'];
  if (status.ok !== true) {
    bad.push('Worker が ok でないと返しました' + (status.message ? '（' + status.message + '）' : '') + '。');
  }
  const primary = status.primary;
  if (primary !== 'cloudflare' && primary !== 'gas') {
    bad.push('予約の正本がどちらか分かりません（primary: ' + JSON.stringify(primary) + '）。Worker が古いか、正本（Store）を読めていません。');
    return bad;
  }
  const gas = status.gas || {};
  if (primary === 'cloudflare') {
    const m = status.mirror || {};
    const n = Number(m.unmirrored) || 0;
    const age = minutesAgo(m.oldestUnmirroredAt, now);
    if (n > 0 && age >= lim.unmirroredMinutes) {
      bad.push('スプレッドシートに写されていない変更が ' + n + ' 件あり、一番古いものは ' + age + ' 分前のものです（' + lim.unmirroredMinutes + ' 分を超えたら知らせる）。GAS の写しが止まっているか、写すときに失敗しています。');
    }
    const ago = minutesAgo(gas.at, now);
    if (!Number.isFinite(ago)) {
      bad.push('GAS が一度も写しに来ていません（/mirror/changes が呼ばれた記録がない）。GAS の5分ごとのトリガー cacheRetry を確かめてください。');
    } else if (ago >= lim.gasMirrorMinutes) {
      bad.push('GAS が最後に写しに来たのは ' + ago + ' 分前です（5分ごとに来るはず。' + lim.gasMirrorMinutes + ' 分を超えたら知らせる）。GAS のトリガー cacheRetry が止まっていないか確かめてください。');
    }
  } else {
    const ago = minutesAgo(gas.at, now);
    if (!Number.isFinite(ago)) {
      bad.push('GAS から高速キャッシュの写しが一度も届いていません（/push の記録がない）。');
    } else if (ago >= lim.gasPushMinutes) {
      bad.push('GAS が最後に写しを送ってきたのは ' + Math.floor(ago / 60) + ' 時間前です（毎日1回は送るはず。' + Math.floor(lim.gasPushMinutes / 60) + ' 時間を超えたら知らせる）。GAS のトリガー cacheRetry と、メニュー「高速キャッシュに今すぐ送る」を確かめてください。');
    }
  }
  if (gas.at) { // 来た記録があるときだけ、版を比べる
    if (!gas.build) {
      bad.push('GAS が版（GAS_BUILD）を名乗っていません。GAS_BUILD を入れる前の Code.gs が動いています。gas/Code.gs を GAS に貼り直して、デプロイし直してください。');
    } else if (opts.build && gas.build !== opts.build) {
      bad.push('GAS で動いている版は ' + gas.build + '、リポジトリの gas/Code.gs は ' + opts.build + ' です。gas/Code.gs を GAS に貼り直して、デプロイし直してください。');
    }
  }
  return bad;
}

/** GET / を読む。返事がない・200 でない・JSON でないときは {error} */
async function fetchStatus(url) {
  try {
    const res = await fetch(url + '/', { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* 下で扱う */ }
    if (!data) return { error: 'Worker の応答が JSON ではありません（HTTP ' + res.status + '）: ' + text.slice(0, 200) };
    if (res.status !== 200) return { error: 'Worker が HTTP ' + res.status + ' を返しました' + (data.message ? '（' + data.message + '）' : '') + '。', data };
    return { data };
  } catch (e) {
    return { error: 'Worker から返事がありません（' + String(e && e.message || e) + '）。' };
  }
}

async function main() {
  const url = readCacheUrl();
  if (!url) { console.log('web/config.js の CACHE_API_URL が空なので、高速キャッシュは使っていません。見張るものはありません。'); return 0; }
  const build = readGasBuild();
  if (!build) { console.log('gas/Code.gs に GAS_BUILD が見つかりません。'); return 1; }
  // 一時的なつながりの失敗で知らせないよう、返事がなければ間をあけて3回まで試す
  let got;
  for (let i = 0; i < 3; i++) {
    got = await fetchStatus(url);
    if (!got.error) break;
    if (i < 2) await new Promise((r) => setTimeout(r, 30000));
  }
  const bad = got.error ? [got.error] : judge(got.data, { now: Date.now(), build });
  console.log('見た先: ' + url + '/');
  if (got.data) console.log('応答: ' + JSON.stringify(got.data, null, 2));
  console.log('リポジトリの GAS_BUILD: ' + build);
  if (!bad.length) { console.log('良好です。'); return 0; }
  console.log('\n悪いところ:');
  for (const b of bad) {
    console.log('- ' + b);
    if (process.env.GITHUB_ACTIONS) console.log('::error::' + b); // Actions の画面の一番上に出す
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## 見張りで見つかったこと\n\n' + bad.map((b) => '- ' + b).join('\n') + '\n\n調べる順番は docs/保守マニュアル/06_トラブルシューティング.md の「見張りが失敗したとき」。\n');
  }
  return 1;
}

module.exports = { judge, readCacheUrl, readGasBuild, LIMITS };

if (require.main === module) main().then((code) => process.exit(code));
