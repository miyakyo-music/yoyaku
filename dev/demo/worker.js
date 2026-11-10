/**
 * デモサーバー: dev/demo/build.py が埋め込んだ画面（files.js）を配り、POST /dev-sql（dev/serve.py と同じ約束）を Durable Object の SQLite で受ける。
 * 開いた端末ごとに Cookie（demo_c）で別のデータベースを使う（テスト環境の localStorage と同じく、端末ごとに独立）。
 */
import { DurableObject } from 'cloudflare:workers';
import { handlePasskey } from '../../cache/worker.js';
import FILES from './files.js'; // dev/demo/build.py が作る { パス: [種類, base64] }

const COOKIE = 'demo_c';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cookie = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + COOKIE + '=([\\w-]+)'));
    if (url.pathname === '/dev-sql' && request.method === 'POST') {
      const id = env.SQL.idFromName(cookie ? cookie[1] : 'shared');
      return env.SQL.get(id).fetch(request);
    }
    // パスキー（管理者・利用者）は本物の高速キャッシュと同じ処理で確かめる（rpId はこのデモのドメイン、合言葉は dev の devtoken）
    if (url.pathname.startsWith('/passkey/')) return handlePasskey(url.pathname.slice(9), request, env, {});
    let path = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!FILES[path] && FILES[path + '.html']) path += '.html';
    const file = FILES[path];
    if (!file) return new Response('Not Found', { status: 404 });
    const out = new Response(Uint8Array.from(atob(file[1]), (c) => c.charCodeAt(0)), { headers: { 'Content-Type': file[0] } });
    out.headers.set('Cache-Control', 'no-store');
    out.headers.set('X-Robots-Tag', 'noindex');
    if (!cookie && (out.headers.get('Content-Type') || '').includes('text/html')) {
      out.headers.append('Set-Cookie', `${COOKIE}=${crypto.randomUUID()}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
    }
    return out;
  },
};

export class DemoSql extends DurableObject {
  async fetch(request) {
    const req = await request.json().catch(() => ({}));
    const sql = this.ctx.storage.sql;
    let out;
    try {
      if (req.q === '__RESET__') {
        const tables = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray();
        for (const t of tables) sql.exec(`DROP TABLE IF EXISTS "${t.name}"`);
        out = { rows: [] };
      } else if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(req.q || '')) {
        // Durable Object の SQLite は BEGIN などを受け付けない。1つずつ書き込む（デモなので取り消しはしない）
        out = { rows: [] };
      } else {
        out = { rows: sql.exec(req.q, ...(req.b || [])).toArray() };
      }
    } catch (e) {
      out = { error: String(e && e.message || e) };
    }
    return Response.json(out);
  }
}
