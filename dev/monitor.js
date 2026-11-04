#!/usr/bin/env node
/**
 * 控えの見張り: 高速キャッシュの Worker の GET /（cache/worker.js の status）と、監視用の Worker（monitor/）の GET / を読み、
 * 止まっていそうなところがあれば失敗する。ふだんの見張りは監視用の Worker が5分ごとに行い、メールで知らせる。
 * こちらは、Cloudflare ごと止まったときや、監視用の Worker そのものが止まったときの控え。
 * GitHub Actions の「見張り」（.github/workflows/monitor.yml）が1日1回流す。手元でも流せる。
 *   使い方（このリポジトリの一番上で）: node dev/monitor.js
 *   Worker の URL は web/config.js の CACHE_API_URL、GAS の版は gas/Code.gs の GAS_BUILD から読む（秘密の値は使わない）。
 *   すべて良ければ終了コード 0、悪いところがあれば、何が悪いかを日本語で出して 1。
 * 判定（monitor/judge.js の judge と、下の judgeMonitor）はネットにつながずに試験できるよう分けてある（dev/test/monitor.test.js）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

require('../monitor/judge.js');
const { judge, LIMITS, buildFromCode, minutesAgo } = globalThis.MonitorJudge; // 判定は監視用の Worker と同じもの

// 監視用の Worker（monitor/）が、最後に動いてからこれ以上たっていたら「止まっている」とみなす（分）。5分ごとに動く
const MONITOR_STALE_MINUTES = 30;

/** web/config.js の CACHE_API_URL（空なら ''） */
function readCacheUrl(root = ROOT) {
  const text = fs.readFileSync(path.join(root, 'web/config.js'), 'utf8');
  const m = /window\.CACHE_API_URL\s*=\s*'([^']*)'/.exec(text);
  return m ? m[1].trim().replace(/\/+$/, '') : '';
}

/** gas/Code.gs の GAS_BUILD（見つからなければ ''） */
function readGasBuild(root = ROOT) {
  return buildFromCode(fs.readFileSync(path.join(root, 'gas/Code.gs'), 'utf8'));
}

/**
 * 監視用の Worker の URL。名前は monitor/wrangler.toml の name、あとは高速キャッシュの Worker と同じ
 * （どちらも同じ Cloudflare アカウントの workers.dev）。読めなければ ''
 */
function readMonitorUrl(root = ROOT, cacheUrl = readCacheUrl(root)) {
  let toml = '';
  try { toml = fs.readFileSync(path.join(root, 'monitor/wrangler.toml'), 'utf8'); } catch (e) { return ''; }
  const name = /^name\s*=\s*"([^"]+)"/m.exec(toml);
  const m = /^https:\/\/[^./]+(\.[^/]+\.workers\.dev)$/.exec(cacheUrl);
  return name && m ? 'https://' + name[1] + m[1] : '';
}

/**
 * 監視用の Worker の GET / を判定する。悪いところの一覧（日本語の文の配列）を返す。
 * @param status 応答の JSON（読めなかったら null）
 */
function judgeMonitor(status, now) {
  if (!status || typeof status !== 'object' || status.ok !== true) return ['監視用の Worker の応答が読めません。'];
  const bad = [];
  const ago = minutesAgo(status.lastRunAt, now);
  if (!Number.isFinite(ago)) bad.push('監視用の Worker が一度も見回っていません（定期実行が動いていない）。');
  else if (ago >= MONITOR_STALE_MINUTES) bad.push('監視用の Worker が最後に見回ったのは ' + ago + ' 分前です（5分ごとに動くはず）。Cloudflare の yoyaku-monitor の定期実行を確かめてください。');
  if (status.mailError) bad.push('監視用の Worker が知らせのメールを送れていません（' + status.mailError + '）。GAS のメニュー「見張りのメールを試す」を実行して、メールの許可を確かめてください。');
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
  // 監視用の Worker（5分ごとの見張り）が動いているか
  const murl = readMonitorUrl(ROOT, url);
  if (murl) {
    const mon = await fetchStatus(murl);
    console.log('見た先: ' + murl + '/');
    if (mon.data) console.log('応答: ' + JSON.stringify(mon.data, null, 2));
    bad.push(...(mon.error ? [mon.error.replace('Worker', '監視用の Worker')] : judgeMonitor(mon.data, Date.now())));
  }
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

module.exports = { judge, judgeMonitor, readCacheUrl, readGasBuild, readMonitorUrl, LIMITS };

if (require.main === module) main().then((code) => process.exit(code));
