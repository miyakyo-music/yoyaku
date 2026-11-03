/**
 * 見張りの判定と、知らせを送るかどうかの決め方。ネットにつながない計算だけを置く。
 * 監視用の Worker（monitor/worker.js、5分ごと）と、GitHub Actions の控えの見張り（dev/monitor.js、1日1回）の両方が使う。
 * 試験は dev/test/monitor.test.js。
 */
'use strict';

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
  // 返事にこれ以上かかったら「遅い」（ミリ秒）。ふだんは1秒もかからない
  slowMs: 5000,
};

// 悪い状態がこの分だけ続いたら知らせる（監視用 Worker は5分ごとなので、4分なら「2回続けて悪い」）。
// GAS の版の違いは、main に push してから GAS に反映され、GAS が次に名乗りに来るまで（10分ほど）は正しい状態なので長めにとる
const GRACE_MINUTES = { default: 4, build: 30 };
// 直らないまま続いているとき、同じ知らせをもう一度送るまでの間（時間）
const REMIND_HOURS = 24;

/** 「YYYY-MM-DDTHH:mm:ss+09:00」などの時刻をミリ秒に。読めなければ NaN */
function parseTime(text) {
  return text ? Date.parse(String(text)) : NaN;
}

/** 何分前か（小数は切り捨て。時計のずれで先の時刻になっていたら 0） */
function minutesAgo(text, now) {
  const t = parseTime(text);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60000)) : NaN;
}

/** gas/Code.gs の中身から GAS_BUILD を読む（見つからなければ ''） */
function buildFromCode(text) {
  const m = /^const GAS_BUILD = '([^']*)';/m.exec(String(text || ''));
  return m ? m[1] : '';
}

/**
 * 高速キャッシュの Worker の GET / の応答を判定する。悪いところの一覧 [{kind, text}] を返す。空なら良い。
 * kind は知らせの間引きに使う名前（同じ kind が続いている間は、知らせを1回にする）。
 * @param status GET / の応答の JSON（読めなかったら null）
 * @param opts {now: ミリ秒, build: リポジトリの GAS_BUILD（空なら版は比べない）, limits?: LIMITS を上書き}
 */
function judgeItems(status, opts) {
  const now = opts.now;
  const lim = Object.assign({}, LIMITS, opts.limits || {});
  const bad = [];
  const push = (kind, text) => bad.push({ kind, text });
  if (!status || typeof status !== 'object') return [{ kind: 'status', text: 'Worker の応答が JSON として読めません。' }];
  if (status.ok !== true) {
    push('not-ok', 'Worker が ok でないと返しました' + (status.message ? '（' + status.message + '）' : '') + '。');
  }
  const primary = status.primary;
  if (primary !== 'cloudflare' && primary !== 'gas') {
    push('primary', '予約の正本がどちらか分かりません（primary: ' + JSON.stringify(primary) + '）。Worker が古いか、正本（Store）を読めていません。');
    return bad;
  }
  const gas = status.gas || {};
  if (primary === 'cloudflare') {
    const m = status.mirror || {};
    const n = Number(m.unmirrored) || 0;
    const age = minutesAgo(m.oldestUnmirroredAt, now);
    if (n > 0 && age >= lim.unmirroredMinutes) {
      push('unmirrored', 'スプレッドシートに写されていない変更が ' + n + ' 件あり、一番古いものは ' + age + ' 分前のものです（' + lim.unmirroredMinutes + ' 分を超えたら知らせる）。GAS の写しが止まっているか、写すときに失敗しています。');
    }
    const ago = minutesAgo(gas.at, now);
    if (!Number.isFinite(ago)) {
      push('gas', 'GAS が一度も写しに来ていません（/mirror/changes が呼ばれた記録がない）。GAS の5分ごとのトリガー cacheRetry を確かめてください。');
    } else if (ago >= lim.gasMirrorMinutes) {
      push('gas', 'GAS が最後に写しに来たのは ' + ago + ' 分前です（5分ごとに来るはず。' + lim.gasMirrorMinutes + ' 分を超えたら知らせる）。GAS のトリガー cacheRetry が止まっていないか確かめてください。');
    }
  } else {
    const ago = minutesAgo(gas.at, now);
    if (!Number.isFinite(ago)) {
      push('gas', 'GAS から高速キャッシュの写しが一度も届いていません（/push の記録がない）。');
    } else if (ago >= lim.gasPushMinutes) {
      push('gas', 'GAS が最後に写しを送ってきたのは ' + Math.floor(ago / 60) + ' 時間前です（毎日1回は送るはず。' + Math.floor(lim.gasPushMinutes / 60) + ' 時間を超えたら知らせる）。GAS のトリガー cacheRetry と、メニュー「高速キャッシュに今すぐ送る」を確かめてください。');
    }
  }
  if (gas.at) { // 来た記録があるときだけ、版を比べる
    if (!gas.build) {
      push('build', 'GAS が版（GAS_BUILD）を名乗っていません。GAS_BUILD を入れる前の Code.gs が動いています。gas/Code.gs を GAS に反映し直してください（GitHub Actions「GAS に反映」）。');
    } else if (opts.build && gas.build !== opts.build) {
      push('build', 'GAS で動いている版は ' + gas.build + '、リポジトリの gas/Code.gs は ' + opts.build + ' です。gas/Code.gs を GAS に反映し直してください（GitHub Actions「GAS に反映」）。');
    }
  }
  return bad;
}

/** judgeItems の文だけを並べたもの（悪いところの一覧。空なら良い） */
function judge(status, opts) {
  return judgeItems(status, opts).map((b) => b.text);
}

/**
 * 監視用 Worker の1回分: 前の状態と今回の悪いところから、次の状態と、送る知らせ（なければ null）を決める。
 * 知らせは「悪くなった（GRACE_MINUTES 続いた）」「悪いところが増えた」「すべて直った」「24時間直らない」のときだけ。
 * @param prev 前の状態（初めてなら null）
 * @param items 今回の悪いところ [{kind, text}]
 * @param now ミリ秒
 * @returns {state, mail: null | {subject, body}}
 */
function step(prev, items, now) {
  prev = prev || {};
  const before = prev.problems || {};
  const problems = {};
  for (const it of items) {
    const old = before[it.kind];
    const p = problems[it.kind] || { since: old ? old.since : now, texts: [] };
    p.texts.push(it.text);
    problems[it.kind] = p;
  }
  const due = Object.keys(problems).filter((k) => now - problems[k].since >= (GRACE_MINUTES[k] || GRACE_MINUTES.default) * 60000);
  const alerted = (prev.alerted || []).filter((k) => problems[k]); // 直ったものは、また悪くなったら知らせる
  const state = {
    problems, alerting: !!prev.alerting, alerted, lastAlertAt: prev.lastAlertAt || 0,
    lastRunAt: now, lastOkAt: items.length ? (prev.lastOkAt || 0) : now,
  };
  const list = (kinds) => kinds.map((k) => problems[k].texts.map((t) => '・' + t).join('\n')).join('\n');
  let mail = null;
  if (state.alerting && !items.length) {
    mail = { subject: '【練習室予約】直りました', body: '見張りで見つかっていた悪いところは、すべて直りました。\n' };
    state.alerting = false;
  } else if (due.some((k) => !alerted.includes(k))) {
    mail = {
      subject: state.alerting ? '【練習室予約】悪いところが増えました' : '【練習室予約】止まっている恐れがあります',
      body: '見張りで次のことが見つかりました。\n\n' + list(due) + '\n',
    };
    state.alerting = true;
    state.alerted = Array.from(new Set(alerted.concat(due)));
  } else if (state.alerting && now - state.lastAlertAt >= REMIND_HOURS * 3600000) {
    mail = { subject: '【練習室予約】まだ直っていません', body: '次のことが続いています。\n\n' + list(Object.keys(problems)) + '\n' };
  }
  if (mail) {
    state.lastAlertAt = now;
    mail.body += '\n調べる順番は docs/保守マニュアル/06_トラブルシューティング.md の「見張りが失敗したとき」にあります。\n';
  }
  return { state, mail };
}

const MonitorJudge = { LIMITS, GRACE_MINUTES, REMIND_HOURS, judge, judgeItems, step, buildFromCode, minutesAgo, parseTime };
// 読み込んだ側は globalThis.MonitorJudge で使う（Worker は import './judge.js'、Node は require のあとに読む。cache/store.js と同じ形）
globalThis.MonitorJudge = MonitorJudge;
