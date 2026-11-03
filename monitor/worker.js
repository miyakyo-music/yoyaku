/**
 * 練習室予約の見張り（監視用の Worker。予約の Worker〈cache/worker.js〉とは別に動く）
 *
 * Cloudflare の定期実行（wrangler.toml の crons、5分ごと）で、外から見える次のものを確かめる。
 *   - 高速キャッシュの Worker の GET /（予約の正本・GAS の写しの遅れ・GAS の版。判定は judge.js、GitHub Actions の見張りと同じ）
 *   - 予約表の読み込み GET /schedule（今日から1週間。画面が実際に読むもの）が ok を返すか
 *   - 上の2つの返事にかかった時間（LIMITS.slowMs を超えたら「遅い」）
 *   - 予約表の画面（GitHub Pages）が開けるか
 * GAS の版は、公開されているリポジトリの gas/Code.gs を1時間に1回読んで比べる。
 *
 * 悪いところが続いたら（judge.js の step）、GAS に頼んでメールを送る（Code.gs の monitorAlert。宛先は GAS のオーナー）。
 * 頼むときは、GAS と共有する合言葉（PUSH_TOKEN。GAS の CACHE_PUSH_TOKEN と同じ）で署名する。
 * 送れなかったときは、次の回にもう一度送る。
 *
 * 前の回の様子は、下の Durable Object「State」（1つだけ）が覚える。GET / で、最後に動いた時刻と今の様子を返す
 * （誰でも見られる。中身は高速キャッシュの GET / で誰でも見られるものだけ）。GitHub Actions の控えの見張りが
 * 1日1回これを読み、この Worker が止まっていないかを確かめる（dev/monitor.js）。
 *
 * 設定（wrangler.toml とリポジトリの Secrets）:
 *   CACHE_URL  … 高速キャッシュの Worker（web/config.js の CACHE_API_URL と同じ）
 *   PAGES_URL  … 予約表の画面
 *   CODE_URL   … リポジトリの gas/Code.gs（公開されている生のファイル）
 *   GAS_URL    … GAS のウェブアプリの URL（web/config.js の GAS_API_URL と同じ）
 *   PUSH_TOKEN … GAS と共有する合言葉（Cloudflare の秘密の設定。GitHub Actions が Secrets の CACHE_PUSH_TOKEN から登録する）
 */

import './judge.js';

const J = globalThis.MonitorJudge;
const TIMEOUT_MS = 20000;
const CODE_EVERY_MS = 60 * 60 * 1000; // リポジトリの GAS_BUILD を読み直す間隔

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/' || request.method !== 'GET') return json({ ok: false, code: 'NOT_FOUND' }, 404);
    return state(env).fetch('https://state/status');
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(state(env).fetch('https://state/run', { method: 'POST' }).then((r) => r.text()));
  },
};

function state(env) { return env.STATE.get(env.STATE.idFromName('main')); }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
  });
}

/** 日本時間の「YYYY-MM-DD」（days 日後） */
function jstDate(now, days = 0) {
  return new Date(now + 9 * 3600000 + days * 86400000).toISOString().slice(0, 10);
}
function isoJst(ms) {
  return ms ? new Date(ms + 9 * 3600000).toISOString().slice(0, 19) + '+09:00' : null;
}

/** fetch して、かかった時間（ミリ秒）と一緒に返す。返事がなければ {error} */
async function timed(url, init) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, Object.assign({ signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'Cache-Control': 'no-cache' } }, init || {}));
    const text = await res.text();
    return { res, text, ms: Date.now() - t0 };
  } catch (e) {
    return { error: String(e && e.message || e), ms: Date.now() - t0 };
  }
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

/** 署名（URL に使える Base64、末尾の = なし）。gas/Code.gs の hmac_ と同じ作り方 */
async function hmac(key, message) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message)));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class State {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const st = (await this.ctx.storage.get('state')) || null;
    if (url.pathname === '/run') {
      const next = await this.run(st);
      await this.ctx.storage.put('state', next);
      return json({ ok: true });
    }
    // GET /: 最後に動いた時刻と今の様子
    const s = st || {};
    return json({
      ok: true, service: '練習室予約の見張り', serverNow: isoJst(Date.now()),
      lastRunAt: isoJst(s.lastRunAt), lastOkAt: isoJst(s.lastOkAt), alerting: !!s.alerting,
      problems: Object.keys(s.problems || {}).map((k) => ({ kind: k, since: isoJst(s.problems[k].since), texts: s.problems[k].texts })),
      lastAlertAt: isoJst(s.lastAlertAt), mailError: s.mailError || null, repoBuild: s.repoBuild || null,
    });
  }

  /** 1回分の見回り。次に覚える状態を返す */
  async run(prev) {
    const env = this.env;
    const now = Date.now();
    prev = prev || {};
    const items = [];
    const cacheUrl = String(env.CACHE_URL || '').replace(/\/+$/, '');

    // リポジトリの GAS_BUILD（1時間に1回だけ読む。読めなければ前の値を使い、なければ版は比べない）
    let repoBuild = prev.repoBuild || '';
    let codeAt = prev.codeAt || 0;
    if (env.CODE_URL && now - codeAt >= CODE_EVERY_MS) {
      const got = await timed(env.CODE_URL);
      const b = got.res && got.res.ok ? J.buildFromCode(got.text) : '';
      if (b) { repoBuild = b; codeAt = now; }
    }

    const [st, sc, pg] = await Promise.all([
      timed(cacheUrl + '/'),
      timed(cacheUrl + '/schedule?from=' + jstDate(now) + '&to=' + jstDate(now, 6)),
      env.PAGES_URL ? timed(env.PAGES_URL) : Promise.resolve(null),
    ]);

    // 高速キャッシュの GET /
    const data = st.res ? parseJson(st.text) : null;
    if (st.error) items.push({ kind: 'unreachable', text: '高速キャッシュの Worker から返事がありません（' + st.error + '）。' });
    else if (st.res.status !== 200) items.push({ kind: 'unreachable', text: '高速キャッシュの Worker が HTTP ' + st.res.status + ' を返しました' + (data && data.message ? '（' + data.message + '）' : '') + '。' });
    else items.push(...J.judgeItems(data, { now, build: repoBuild }));

    // 予約表の読み込み
    const sched = sc.res ? parseJson(sc.text) : null;
    if (sc.error || !sc.res.ok || !sched || (!sched.ok && !(sched.code === 'MISS' && sched.primary))) {
      // 正本が返せない設定（閲覧パスワードを使っている）のときの MISS は、画面が /api から読むので正しい
      items.push({ kind: 'schedule', text: '予約表の読み込み（/schedule）が失敗しました（' + (sc.error || 'HTTP ' + sc.res.status + (sched && sched.message ? '、' + sched.message : '')) + '）。' });
    }

    const slow = Math.max(st.ms, sc.ms);
    if (!st.error && !sc.error && slow > J.LIMITS.slowMs) {
      items.push({ kind: 'slow', text: '高速キャッシュの返事に ' + (slow / 1000).toFixed(1) + ' 秒かかりました（' + J.LIMITS.slowMs / 1000 + ' 秒を超えたら知らせる）。' });
    }

    if (pg && (pg.error || !pg.res.ok)) {
      items.push({ kind: 'pages', text: '予約表の画面（' + env.PAGES_URL + '）が開けません（' + (pg.error || 'HTTP ' + pg.res.status) + '）。GitHub Pages を確かめてください。' });
    }

    const { state: next, mail } = J.step(prev, items, now);
    next.repoBuild = repoBuild;
    next.codeAt = codeAt;
    next.mailError = null;
    if (mail) {
      const err = await this.send(mail);
      if (err) {
        // 送れなかったら、知らせる前の状態に戻し、次の回にもう一度送る
        Object.assign(next, { alerting: !!prev.alerting, alerted: prev.alerted || [], lastAlertAt: prev.lastAlertAt || 0, mailError: err });
      }
    }
    return next;
  }

  /** GAS にメールを頼む。うまくいけば null、だめなら理由 */
  async send(mail) {
    const gas = String(this.env.GAS_URL || '').trim();
    const key = String(this.env.PUSH_TOKEN || '').trim();
    if (!gas || !key) return 'GAS_URL か PUSH_TOKEN が設定されていません。';
    const at = Math.floor(Date.now() / 1000);
    const sig = await hmac(key, 'mon1.' + at + '.' + mail.subject + '\n' + mail.body);
    const got = await timed(gas, {
      method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'monitorAlert', params: { at, subject: mail.subject, body: mail.body, sig } }),
    });
    if (got.error) return 'GAS から返事がありません（' + got.error + '）。';
    const r = parseJson(got.text);
    if (!r || !r.ok) return 'GAS がメールを送れませんでした（' + (r && r.message || 'HTTP ' + got.res.status) + '）。';
    return null;
  }
}
