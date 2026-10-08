/**
 * GAS（Code.gs の doPost）を呼び出す共通処理。予約表・管理画面の両方で使う。
 *
 * - Content-Type を text/plain にして送る（application/json だと CORS の事前確認が発生し、GAS が応答できない）
 * - Cookie は送らない（Google の複数アカウントのログイン状態に左右されないようにする）
 */
(function () {
  'use strict';
  // gas/Code.gs の API_VERSION と一致させる
  const API_VERSION = 1;
  const TIMEOUT_MS = 60 * 1000;
  let warned = false;

  /** 画面とサーバーの版が違うとき、再読み込みを促す帯を出す */
  function warnVersion() {
    if (warned) return;
    warned = true;
    const bar = document.createElement('div');
    bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap;' +
      'padding:10px 16px calc(10px + env(safe-area-inset-bottom));background:#1f2933;color:#fff;font-size:14px;line-height:1.5';
    bar.innerHTML = '<span>システムが更新されました。ページを再読み込みしてください。</span>';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '再読み込み';
    btn.style.cssText = 'font:inherit;padding:4px 14px;border-radius:6px;border:0;background:#fff;color:#1f2933;cursor:pointer';
    btn.addEventListener('click', () => location.reload());
    bar.appendChild(btn);
    document.body.appendChild(bar);
  }

  /**
   * @param {string} action Code.gs の関数名（API に登録されたもの）
   * @param {object} params
   * @returns {Promise<object>} サーバーの応答（{ok, ...}）。通信できなかったときは reject
   */
  window.callApi = async function (action, params) {
    const url = window.GAS_API_URL;
    if (!url) throw new Error('接続先が設定されていません（web/config.js の GAS_API_URL）。');
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl && setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, params: params || {}, v: API_VERSION }),
        credentials: 'omit',
        redirect: 'follow',
        cache: 'no-store',
        signal: ctrl ? ctrl.signal : undefined,
      });
    } catch (e) {
      throw new Error(e && e.name === 'AbortError'
        ? 'サーバーの応答がありません。時間をおいて再度お試しください。'
        : '通信に失敗しました。インターネット接続を確認してください。');
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`サーバーに接続できませんでした（${res.status}）。時間をおいて再度お試しください。`);
    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw new Error('サーバーの応答を読み取れませんでした。時間をおいて再度お試しください。');
    }
    if (data && data.apiVersion !== API_VERSION) warnVersion();
    return data;
  };
})();
