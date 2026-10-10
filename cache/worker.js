/**
 * 練習室予約の「高速キャッシュ」（Cloudflare Workers ＋ D1）
 *
 * 予約の正本はスプレッドシート（GAS）。ここは、予約表に出す分の写しを置いて速く返すだけ。
 * - GAS が予約・設定の変更のたびに、写しをまとめて POST /push で送ってくる（合言葉つき）。
 * - 予約表は GET /schedule?from=YYYY-MM-DD&to=YYYY-MM-DD で読む。返す形は GAS の getSchedule と同じ。
 * - 写しの範囲外・写しがない・閲覧パスワード使用中などは { ok:false, code:'MISS' } を返し、予約表は GAS から読み直す。
 *
 * 置くのは、予約表を開けば誰でも見られる内容だけ（編集用パスワード・限定公開の部屋は GAS 側で除いてから送る）。
 * 外部の部品（ライブラリ）は使わない。
 *
 * 設定（wrangler.toml とリポジトリの Secrets）:
 *   DB          … D1 データベースのつなぎ（wrangler.toml）
 *   PUSH_TOKEN  … GAS と共有する合言葉（Cloudflare の秘密の設定。GitHub Actions が Secrets から登録する）
 */

let tableReady = false;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    try {
      await ensureTable(env);
      if (url.pathname === '/schedule' && request.method === 'GET') return cors(await schedule(url, env));
      if (url.pathname === '/push' && request.method === 'POST') return await push(request, env);
      if (url.pathname === '/') return cors(json(await status(env)));
      return cors(json({ ok: false, code: 'NOT_FOUND' }, 404));
    } catch (e) {
      return cors(json({ ok: false, code: 'ERROR', message: String(e && e.message || e) }, 500));
    }
  },
};

/** 写しを入れる表（k = 'meta' または 'm:YYYY-MM'、v = JSON）。初回だけ作る */
async function ensureTable(env) {
  if (tableReady) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT NOT NULL)').run();
  tableReady = true;
}

async function readMeta(env) {
  const row = await env.DB.prepare("SELECT v FROM cache WHERE k = 'meta'").first();
  return row ? JSON.parse(row.v) : null;
}

/** 動作確認用（ブラウザで開くと、写しの版と送られた時刻がわかる） */
async function status(env) {
  const meta = await readMeta(env);
  return {
    ok: true, service: '練習室予約キャッシュ',
    version: meta ? meta.version : null, pushedAt: meta ? meta.pushedAt : null,
    disabled: meta ? !!meta.disabled : null, windowFrom: meta ? meta.windowFrom : null, windowTo: meta ? meta.windowTo : null,
  };
}

/** 予約表の読み込み（GAS の getSchedule と同じ形で返す） */
async function schedule(url, env) {
  const from = url.searchParams.get('from') || '';
  const to = url.searchParams.get('to') || from;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (!DATE.test(from) || !DATE.test(to) || from > to) return json({ ok: false, code: 'BAD_REQUEST' }, 400);

  const meta = await readMeta(env);
  if (!meta || meta.disabled || from < meta.windowFrom || to > meta.windowTo) return json({ ok: false, code: 'MISS' });

  const months = monthsBetween(from, to);
  const placeholders = months.map(() => '?').join(',');
  const rows = await env.DB.prepare(`SELECT v FROM cache WHERE k IN (${placeholders})`)
    .bind(...months.map((m) => 'm:' + m)).all();
  const reservations = [];
  for (const row of rows.results || []) {
    for (const r of JSON.parse(row.v)) if (r.date >= from && r.date <= to) reservations.push(r);
  }
  return json({
    ok: true, from, to,
    rooms: meta.rooms,
    reservations,
    closures: (meta.closures || []).filter((c) => c.date >= from && c.date <= to),
    settings: meta.settings,
    serverNow: nowJst(),
    apiVersion: meta.apiVersion,
    cache: { version: meta.version, pushedAt: meta.pushedAt },
  }, 200, { 'Cache-Control': 'no-store' });
}

/** GAS からの写しの受け取り。版が今より古いもの（順番が入れ替わって届いたもの）は捨てる */
async function push(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!env.PUSH_TOKEN || !safeEqual(auth, 'Bearer ' + env.PUSH_TOKEN)) return json({ ok: false, code: 'UNAUTHORIZED' }, 401);
  const body = await request.json();
  const version = Number(body && body.version);
  if (!Number.isFinite(version)) return json({ ok: false, code: 'BAD_REQUEST' }, 400);

  const current = await readMeta(env);
  if (current && Number(current.version) > version) return json({ ok: true, skipped: true, version: current.version });

  const meta = {
    version, pushedAt: nowJst(), apiVersion: body.apiVersion,
    disabled: !!body.disabled,
    windowFrom: body.windowFrom || '', windowTo: body.windowTo || '',
    rooms: body.rooms || [], settings: body.settings || {}, closures: body.closures || [],
  };
  const stmts = [env.DB.prepare("INSERT OR REPLACE INTO cache (k, v) VALUES ('meta', ?)").bind(JSON.stringify(meta))];
  // 範囲から外れた古い月の写しは消す
  stmts.push(env.DB.prepare("DELETE FROM cache WHERE k LIKE 'm:%'"));
  for (const [month, list] of Object.entries(body.months || {})) {
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    stmts.push(env.DB.prepare('INSERT OR REPLACE INTO cache (k, v) VALUES (?, ?)').bind('m:' + month, JSON.stringify(list || [])));
  }
  await env.DB.batch(stmts); // まとめて1回で書き換える（途中で失敗したら全部取り消される）
  return json({ ok: true, version });
}

// ---------------- 小物 ----------------

function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** 日本時間の「YYYY-MM-DD HH:mm」（GAS の serverNow と同じ形） */
function nowJst() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

/** 合言葉の照合（文字列の長さ・中身で時間差が出ないように比べる） */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

/** 予約表（GitHub Pages）から読めるようにする。読み込み（GET）だけを許す */
function cors(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  h.set('Access-Control-Max-Age', '86400');
  return new Response(res.body, { status: res.status, headers: h });
}
