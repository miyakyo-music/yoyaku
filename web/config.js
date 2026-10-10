/**
 * 接続先の設定（このファイルだけを書き換えれば、別の GAS デプロイにつなぎ替えられる）
 *
 * GAS_API_URL   … Apps Script の「デプロイを管理」に表示されるウェブアプリの URL（末尾が /exec）
 * CACHE_API_URL … 高速キャッシュ（Cloudflare Workers）の URL（例: https://yoyaku-cache.〇〇.workers.dev）。
 *                 空欄にすると高速キャッシュを使わず、予約表は GAS から直接読む（今まで通りの動き）。
 */
window.GAS_API_URL = 'https://script.google.com/macros/s/AKfycbwq8wtllGrITwNSLkfmBKNYXLwnh-LbF58fUbW1fYr_SLi4tArg2Irlp__zbOtUgQ/exec';
window.CACHE_API_URL = 'https://yoyaku-cache.kuridanho.workers.dev';
