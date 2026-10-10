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
 * もう1つの役目: 管理画面のパスキー（Face ID / Touch ID）ログイン。GAS では署名の確認ができないので、ここで確かめる。
 * - 確かめられたら「ログインの印」（pk1.有効期限.番号.署名）を返す。画面はこれを管理用パスワードの代わりに GAS へ送り、
 *   GAS は同じ合言葉で署名を確かめる。
 * - パスキーの登録・一覧・削除には、GAS が管理者に出した「許可証」（pkt.…、5分間有効）が要る。
 * - 置くのはパスキーの公開鍵（合い鍵にならない方）だけ。指紋や顔の情報は端末から出ない。
 *
 * 3つ目の役目: リアルタイム同期。予約表を開いている画面と WebSocket（/live）でつながっておき、GAS から写しが
 * 届いたら「表が変わった」という合図（版の番号だけ。名前などの中身は送らない）を全員に送る。画面はそれを受けて読み直す。
 * つながりは Durable Objects（下の Hub。1つだけ）がまとめて持つ。待っている間は眠っていて、料金・回数を使わない。
 *
 * 4つ目の役目: 予約の正本（store.js の StoreCore を、下の Durable Object「Store」の中で動かす）。
 * - POST /api … 画面からの呼び出し（予約・変更・取消・管理画面の操作）。GAS の doPost と同じ形で受けて返す。
 * - GET /schedule … 正本になっていれば、正本から返す（なっていなければ、これまでどおり写しから）。
 * - /migrate・/mirror/* … GAS 専用（合言葉つき）。スプレッドシートからの移し替えと、スプレッドシートへの写し。
 * 正本になるのは、GAS のメニュー「Cloudflare に移す」を実行したときだけ。それまでは /api は「GAS を使って」と返す。
 *
 * 設定（wrangler.toml とリポジトリの Secrets）:
 *   DB             … D1 データベースのつなぎ（wrangler.toml）
 *   PUSH_TOKEN     … GAS と共有する合言葉（Cloudflare の秘密の設定。GitHub Actions が Secrets から登録する）。
 *                    パスキーの署名にも使う（変えると、パスキーでのログイン中の人はログインし直しになる）
 *   PASSKEY_RP_ID  … パスキーを使うサイトのドメイン（wrangler.toml。例: miyakyo-music.github.io）。空ならパスキーは使わない
 *   PASSKEY_ORIGIN … 管理画面のサイトの起点（例: https://miyakyo-music.github.io）。/api も、このサイトからだけ読める
 *   GAS_URL        … GAS のウェブアプリの URL（wrangler.toml）。予約が変わったら「写して」と合図を送る
 */

import './store.js';

const StoreCore = globalThis.StoreCore;
let tableReady = false;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    if (url.pathname === '/live') return live(request, env);
    try {
      if (url.pathname === '/api' && request.method === 'POST') return apiCors(await store(env).fetch(request), env);
      if (url.pathname === '/migrate' || url.pathname.startsWith('/mirror/') || url.pathname === '/store/status') return await store(env).fetch(request);
      if (url.pathname === '/schedule' && request.method === 'GET' && env.STORE) {
        // 正本になっていれば正本から（まだなら、これまでどおり写しから）
        const res = await store(env).fetch(request);
        const data = await res.clone().json().catch(() => null);
        if (data && data.ok) return cors(new Response(res.body, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }));
      }
      await ensureTable(env);
      if (url.pathname === '/schedule' && request.method === 'GET') return cors(await schedule(url, env));
      if (url.pathname === '/ics' && request.method === 'GET') return icsResponse(url);
      if (url.pathname === '/push' && request.method === 'POST') return await push(request, env, ctx);
      if (url.pathname.startsWith('/passkey/')) return passkeyCors(await passkey(url.pathname.slice(9), request, env), env);
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
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT NOT NULL)'),
    // パスキー（公開鍵だけ）と、使い終わった確認用の文字列（同じものを2度使わせないため）
    env.DB.prepare('CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, alg INTEGER NOT NULL, name TEXT NOT NULL, created TEXT NOT NULL, last_used TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS passkey_used (c TEXT PRIMARY KEY, exp INTEGER NOT NULL)'),
  ]);
  tableReady = true;
}

// ---------------- パスキー ----------------

const TOKEN_HOURS = 12;   // パスキーでのログインが続く時間
const CHALLENGE_SEC = 180; // 確認用の文字列の有効時間
const MAX_PASSKEYS = 30;

/** /passkey/〜 の処理。本文は JSON（CORS の事前確認を避けるため、画面は text/plain で送る） */
async function passkey(op, request, env) {
  const rpId = String(env.PASSKEY_RP_ID || '').trim();
  const key = String(env.PUSH_TOKEN || '').trim();
  if (!rpId || !key) return json({ ok: false, code: 'DISABLED', message: 'パスキーは使えない設定です。' });
  if (request.method !== 'POST') return json({ ok: false, code: 'BAD_REQUEST' }, 405);
  const body = await request.json().catch(() => ({}));
  const now = Math.floor(Date.now() / 1000);
  const ng = (message, status = 400) => json({ ok: false, code: 'PASSKEY', message }, status);

  // 確認用の文字列（challenge）: 「有効期限.乱数.署名」。ここでは覚えず、署名で本物か確かめる
  if (op === 'challenge') {
    const exp = now + CHALLENGE_SEC;
    const rand = b64url(crypto.getRandomValues(new Uint8Array(16)));
    return json({ ok: true, rpId, challenge: `${exp}.${rand}.${await hmac(key, `chal.${exp}.${rand}`)}` });
  }

  // 登録・一覧・削除は、GAS が出した許可証が要る
  if (op === 'register' || op === 'list' || op === 'delete') {
    const m = /^pkt\.(\d+)\.([\w-]+)$/.exec(String(body.ticket || ''));
    if (!m || Number(m[1]) < now || !safeEqual(m[2], await hmac(key, `pkt.${m[1]}`))) return ng('管理画面に入り直してから、もう一度お試しください。', 401);
  }
  if (op === 'list') {
    const rows = await env.DB.prepare('SELECT id, name, created, last_used FROM passkeys ORDER BY created').all();
    return json({ ok: true, passkeys: (rows.results || []).map((r) => ({ id: r.id, name: r.name, created: r.created, lastUsed: r.last_used || '' })) });
  }
  if (op === 'delete') {
    await env.DB.prepare('DELETE FROM passkeys WHERE id = ?').bind(String(body.id || '')).run();
    return json({ ok: true });
  }
  if (op !== 'register' && op !== 'login') return json({ ok: false, code: 'NOT_FOUND' }, 404);

  // ここから登録・ログインに共通の確認（端末が作った「どのサイトで・何に答えたか」の記録）
  const clientData = b64urlDecode(body.clientDataJSON);
  const authData = b64urlDecode(body.authenticatorData);
  let cd;
  try { cd = JSON.parse(new TextDecoder().decode(clientData)); } catch (e) { return ng('形式が正しくありません。'); }
  if (cd.type !== (op === 'register' ? 'webauthn.create' : 'webauthn.get')) return ng('形式が正しくありません。');
  if (cd.origin !== String(env.PASSKEY_ORIGIN || `https://${rpId}`)) return ng('このサイトからは使えません。', 403);
  const chal = new TextDecoder().decode(b64urlDecode(cd.challenge));
  const cm = /^(\d+)\.([\w-]+)\.([\w-]+)$/.exec(chal);
  if (!cm || Number(cm[1]) < now || !safeEqual(cm[3], await hmac(key, `chal.${cm[1]}.${cm[2]}`))) return ng('時間がたちすぎました。もう一度お試しください。');
  if (authData.length < 37 || !equalBytes(authData.slice(0, 32), await sha256(new TextEncoder().encode(rpId)))) return ng('このサイト用のパスキーではありません。', 403);
  const flags = authData[32];
  if (!(flags & 0x01) || !(flags & 0x04)) return ng('Face ID・Touch ID などでの本人確認が必要です。');
  // 同じ確認用の文字列は2度使わせない（古いものは消す）
  await env.DB.prepare('DELETE FROM passkey_used WHERE exp < ?').bind(now).run();
  const used = await env.DB.prepare('INSERT OR IGNORE INTO passkey_used (c, exp) VALUES (?, ?)').bind(cm[2], Number(cm[1])).run();
  if (used.meta && used.meta.changes === 0) return ng('この確認はすでに使われています。もう一度お試しください。');
  const stamp = nowJst();

  if (op === 'register') {
    const alg = Number(body.alg);
    if (alg !== -7 && alg !== -257) return ng('この端末のパスキーの方式には対応していません。');
    // 端末が作ったパスキーの番号が、本人確認の記録に含まれているものと同じか
    if (!(flags & 0x40) || authData.length < 55) return ng('形式が正しくありません。');
    const len = (authData[53] << 8) | authData[54];
    const credId = b64url(authData.slice(55, 55 + len));
    if (credId !== String(body.id || '')) return ng('形式が正しくありません。');
    await importKey(b64urlDecode(body.publicKey), alg); // 読める鍵か（読めなければここで失敗する）
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys').first();
    if (count && count.n >= MAX_PASSKEYS) return ng(`パスキーは${MAX_PASSKEYS}個までです。使っていないものを削除してください。`);
    const name = String(body.name || '').trim().slice(0, 40) || '名前なし';
    await env.DB.prepare('INSERT OR REPLACE INTO passkeys (id, pubkey, alg, name, created) VALUES (?, ?, ?, ?, ?)')
      .bind(credId, String(body.publicKey), alg, name, stamp).run();
    return json({ ok: true, id: credId, name });
  }

  // ログイン: 登録してある公開鍵で、端末の署名を確かめる
  const row = await env.DB.prepare('SELECT id, pubkey, alg, name FROM passkeys WHERE id = ?').bind(String(body.id || '')).first();
  if (!row) return ng('このパスキーは登録されていないか、削除されています。', 401);
  const signed = concat(authData, await sha256(clientData));
  let sig = b64urlDecode(body.signature);
  const pub = await importKey(b64urlDecode(row.pubkey), row.alg);
  const algo = row.alg === -7 ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
  if (row.alg === -7) sig = derToRaw(sig);
  if (!sig || !(await crypto.subtle.verify(algo, pub, sig, signed))) return ng('パスキーを確かめられませんでした。', 401);
  await env.DB.prepare('UPDATE passkeys SET last_used = ? WHERE id = ?').bind(stamp, row.id).run();
  const exp = now + TOKEN_HOURS * 3600;
  const tag = b64url(await sha256(new TextEncoder().encode(row.id))).slice(0, 12); // どのパスキーか（記録用の短い印）
  return json({ ok: true, name: row.name, token: `pk1.${exp}.${tag}.${await hmac(key, `pk1.${exp}.${tag}`)}` });
}

/** パスキーの応答は、管理画面のサイトからだけ読めるようにする */
function passkeyCors(res, env) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', String(env.PASSKEY_ORIGIN || `https://${env.PASSKEY_RP_ID}`));
  h.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  h.set('Vary', 'Origin');
  return new Response(res.body, { status: res.status, headers: h });
}

function importKey(spki, alg) {
  return alg === -7
    ? crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    : crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

/** ECDSA の署名を、端末の形（DER）から WebCrypto の形（r と s を32バイトずつ並べたもの）に直す */
function derToRaw(der) {
  if (der[0] !== 0x30) return null;
  let i = 2;
  const part = () => {
    if (der[i] !== 0x02) return null;
    const len = der[i + 1];
    let v = der.slice(i + 2, i + 2 + len);
    i += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) return null;
    const out = new Uint8Array(32); out.set(v, 32 - v.length);
    return out;
  };
  const r = part(), s = part();
  return r && s ? concat(r, s) : null;
}

async function hmac(key, message) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message))));
}
async function sha256(bytes) { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); }
function b64url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlDecode(text) {
  const t = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
  try { return Uint8Array.from(atob(t + '==='.slice((t.length + 3) % 4)), (c) => c.charCodeAt(0)); } catch (e) { return new Uint8Array(0); }
}
function concat(a, b) { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; }
function equalBytes(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }

async function readMeta(env) {
  const row = await env.DB.prepare("SELECT v FROM cache WHERE k = 'meta'").first();
  return row ? JSON.parse(row.v) : null;
}

/** 動作確認用（ブラウザで開くと、写しの版と送られた時刻がわかる） */
async function status(env) {
  const meta = await readMeta(env);
  return {
    ok: true, service: '練習室予約キャッシュ',
    tokenHint: await tokenHint(String(env.PUSH_TOKEN || '').trim()),
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
async function push(request, env, ctx) {
  const auth = (request.headers.get('Authorization') || '').trim();
  const token = String(env.PUSH_TOKEN || '').trim();
  if (!token || !safeEqual(auth, 'Bearer ' + token)) return json({ ok: false, code: 'UNAUTHORIZED', tokenHint: await tokenHint(token) }, 401);
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
  // 開いている画面に「表が変わった」と知らせる（失敗しても写しの更新には影響させない）
  if (env.HUB) {
    const notify = hub(env).fetch('https://hub/notify', { method: 'POST', body: JSON.stringify({ type: 'changed', version }) }).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(notify);
  }
  return json({ ok: true, version });
}

/**
 * カレンダーに追加するためのファイル（.ics）を返す。iPhone の Safari でこの URL を開くと、
 * ダウンロードを挟まずに「カレンダーに追加」の画面がそのまま出る（ファイルとして保存されるのは、画面側で作った場合だけ）。
 * 名前などの個人の情報は受け取らない: 部屋の名前・日付・開始・終了・予約のIDだけ。データベースも見ない。
 *   /ics?id=res_…&room=練習室7（UP）&date=2026-10-10&start=19:00&end=20:00&site=https://…/yoyaku/
 */
function icsResponse(url) {
  const q = (k) => (url.searchParams.get(k) || '').slice(0, 100);
  const date = q('date'), start = q('start'), end = q('end');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) {
    return new Response('bad request', { status: 400 });
  }
  const stamp = (d, t) => {
    const [y, mo, da] = d.split('-').map(Number);
    const [h, mi] = t.split(':').map(Number);
    return new Date(Date.UTC(y, mo - 1, da, h - 9, mi)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  };
  const text = (t) => String(t).replace(/[\r\n]+/g, ' ').replace(/[\\;,]/g, (c) => '\\' + c);
  const room = q('room') || '練習室';
  const site = /^https:\/\/[\w.-]+\.github\.io\//.test(q('site')) ? q('site') : '';
  const id = (q('id').replace(/[^\w-]/g, '') || stamp(date, start)) + '@miyakyo-music.github.io';
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//miyakyo-music//yoyaku//JA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${id}`, `DTSTAMP:${stamp(date, start)}`,
    `DTSTART:${stamp(date, start)}`, `DTEND:${stamp(date, end)}`,
    `SUMMARY:${text(room + 'の予約')}`, `LOCATION:${text('宮城教育大学 音楽棟')}`,
    ...(site ? [`URL:${site}`, `DESCRIPTION:${text(site)}`] : []),
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:練習室の予約', 'TRIGGER:-PT15M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
  return new Response(ics, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `inline; filename="yoyaku-${date}.ics"`,
      'Cache-Control': 'no-store',
    },
  });
}

// ---------------- 予約の正本 ----------------

function store(env) { return env.STORE.get(env.STORE.idFromName('main')); }

/** /api の応答は、予約表のサイトからだけ読めるようにする（本文は text/plain で届くので、事前確認は来ない） */
function apiCors(res, env) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', String(env.PASSKEY_ORIGIN || '*'));
  h.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  h.set('Vary', 'Origin');
  return new Response(res.body, { status: res.status, headers: h });
}

/**
 * 正本を持つ Durable Object。1つだけ（名前 'main'）。中身の処理は store.js。
 * データは この Durable Object の中の SQLite に置く（Cloudflare が自動で控えを取り、30日前までの状態に戻せる）
 */
export class Store {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    const sql = ctx.storage.sql;
    this.core = new StoreCore({
      exec: (q, ...b) => sql.exec(q, ...b).toArray(),
      txn: (fn) => ctx.storage.transactionSync(fn),
    }, env, { changed: () => this.changed() });
  }

  async fetch(request) {
    const url = new URL(request.url);
    let body = {};
    if (request.method === 'POST') {
      const text = await request.text();
      if (text.length > 2 * 1024 * 1024) return json({ ok: false, code: 'TOO_LARGE' }, 413);
      try { body = JSON.parse(text || '{}'); } catch (e) { return json({ ok: false, code: 'BAD_REQUEST', message: '形式が正しくありません。' }, 400); }
    }
    const res = await StoreCore.handleHttp(this.core, {
      method: request.method, path: url.pathname, query: url.searchParams,
      auth: (request.headers.get('Authorization') || '').trim(), body,
    });
    return json(res.body, res.status, { 'Cache-Control': 'no-store' });
  }

  /** 予約などが変わったとき: 開いている画面に知らせ、GAS に「スプレッドシートへ写して」と合図する（どちらも待たない） */
  changed() {
    const version = Date.now();
    const jobs = [];
    if (this.env.HUB) jobs.push(hub(this.env).fetch('https://hub/notify', { method: 'POST', body: JSON.stringify({ type: 'changed', version }) }).catch(() => {}));
    const gas = String(this.env.GAS_URL || '').trim();
    if (gas) {
      jobs.push(fetch(gas, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow',
        body: JSON.stringify({ action: 'mirrorNow', params: {} }),
      }).catch(() => {}));
    }
    this.ctx.waitUntil(Promise.all(jobs));
  }
}

// ---------------- リアルタイム同期 ----------------

function hub(env) { return env.HUB.get(env.HUB.idFromName('all')); }

/** 予約表からのつながり（WebSocket）。予約表のサイトからだけ受け付ける */
function live(request, env) {
  if (!env.HUB) return json({ ok: false, code: 'DISABLED' }, 404);
  if (request.headers.get('Upgrade') !== 'websocket') return json({ ok: false, code: 'BAD_REQUEST' }, 426);
  const allowed = String(env.PASSKEY_ORIGIN || '').trim();
  const origin = request.headers.get('Origin') || '';
  if (allowed && origin !== allowed) return json({ ok: false, code: 'FORBIDDEN' }, 403);
  return hub(env).fetch(request);
}

/**
 * つながりをまとめて持つ Durable Object。眠っている間もつながりは保たれる（Hibernation API）。
 * 画面からの「ping」には、起きずに「pong」と自動で返す（つながりが切れないように画面が45秒ごとに送る）
 */
export class Hub {
  constructor(state) {
    this.state = state;
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/notify') {
      const msg = await request.text();
      for (const ws of this.state.getWebSockets()) { try { ws.send(msg); } catch (e) { /* 切れたつながりは無視 */ } }
      return new Response('ok');
    }
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  webSocketMessage() { /* 画面からの中身は使わない */ }
  webSocketClose(ws, code) { try { ws.close(code, 'closed'); } catch (e) { /* すでに閉じている */ } }
  webSocketError() {}
}

// ---------------- 小物 ----------------

/**
 * 合言葉の「手がかり」: 長さと、ハッシュ（SHA-256）の先頭8文字。合言葉そのものは分からないが、
 * GAS 側の手がかりと比べれば、両方に同じ合言葉が入っているかを確かめられる
 */
async function tokenHint(token) {
  if (!token) return { length: 0 };
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { length: token.length, sha256: hex.slice(0, 8) };
}

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
