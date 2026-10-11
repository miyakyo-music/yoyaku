// 管理画面: パスキー（Face ID / Touch ID）でのログインと登録
'use strict';

// ---------------- パスキー（Face ID / Touch ID でログイン） ----------------
// 署名の確認は高速キャッシュ（Cloudflare、cache/worker.js）が行い、確かめられたら「ログインの印」を返す。
// 画面はその印を管理用パスワードの代わりに使う（GAS が同じ合言葉で確かめる）。
const PK_URL = String(window.CACHE_API_URL || '').replace(/\/+$/, '');
const pkSupported = !!(PK_URL && window.PublicKeyCredential && navigator.credentials);
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function pkCall(op, body) {
  let res;
  try {
    const r = await fetch(`${PK_URL}/passkey/${op}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body || {}) });
    res = await r.json();
  } catch (e) { throw new Error('通信に失敗しました。'); }
  if (!res || !res.ok) throw new Error((res && res.message) || 'パスキーの処理に失敗しました。');
  return res;
}
/** 端末の操作（Face ID など）を取りやめたときは、何も知らせない */
const pkCancelled = (e) => e && (e.name === 'NotAllowedError' || e.name === 'AbortError');

async function pkLogin() {
  const btn = $('pkLoginBtn');
  btn.disabled = true;
  $('loginError').textContent = '';
  try {
    const c = await pkCall('challenge');
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: new TextEncoder().encode(c.challenge), rpId: c.rpId, userVerification: 'required', timeout: 60000,
    } });
    const r = cred.response;
    const res = await pkCall('login', {
      id: cred.id, clientDataJSON: b64url(r.clientDataJSON), authenticatorData: b64url(r.authenticatorData), signature: b64url(r.signature),
    });
    await login(res.token);
  } catch (e) {
    if (!pkCancelled(e)) $('loginError').textContent = errMessage(e);
  } finally {
    btn.disabled = false;
  }
}

/** 登録するパスキーの名前（一覧で見分けるため）: 端末の種類と登録日 */
function pkDeviceName() {
  const ua = navigator.userAgent;
  const kind = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
    : /Macintosh/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : 'この端末';
  const d = new Date();
  return `${kind}（${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} 登録）`;
}

async function pkTicket() {
  const t = await api('adminPasskeyTicket', {});
  if (!t.ok) throw new Error(t.message);
  return t.ticket;
}

async function pkRefresh() {
  if (!pkSupported) return;
  $('pkError').textContent = '';
  try {
    const res = await pkCall('list', { ticket: await pkTicket() });
    $('pkList').innerHTML = res.passkeys.map((k) => `<li><span class="pk-body"><span class="pk-name">${esc(k.name)}</span>` +
      `<span class="pk-meta">${k.lastUsed ? `最後に使った日時 ${esc(k.lastUsed)}` : '未使用'}</span></span>` +
      `<button type="button" class="btn small danger-text" data-pk="${esc(k.id)}" data-name="${esc(k.name)}">削除</button></li>`).join('') ||
      '<li class="empty">登録されていません</li>';
  } catch (e) {
    $('pkError').textContent = errMessage(e);
  }
}

async function pkRegister() {
  const btn = $('pkAddBtn');
  btn.disabled = true;
  $('pkError').textContent = '';
  try {
    const ticket = await pkTicket();
    const c = await pkCall('challenge');
    const name = pkDeviceName();
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: new TextEncoder().encode(c.challenge),
      rp: { id: c.rpId, name: '練習室予約 管理画面' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: `管理者（${name}）`, displayName: `管理者（${name}）` },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none', timeout: 60000,
    } });
    const r = cred.response;
    if (typeof r.getPublicKey !== 'function') throw new Error('このブラウザではパスキーを登録できません。Safari・Chrome を新しくしてからお試しください。');
    await pkCall('register', {
      ticket, name, id: cred.id, publicKey: b64url(r.getPublicKey()), alg: r.getPublicKeyAlgorithm(),
      clientDataJSON: b64url(r.clientDataJSON), authenticatorData: b64url(r.getAuthenticatorData()),
    });
    toast('この端末をパスキーに登録しました');
    pkRefresh();
  } catch (e) {
    if (!pkCancelled(e)) $('pkError').textContent = errMessage(e);
  } finally {
    btn.disabled = false;
  }
}

$('pkLoginBtn').hidden = !pkSupported;
$('pkCard').dataset.unsupported = pkSupported ? '' : '1';
$('pkLoginBtn').addEventListener('click', pkLogin);
$('pkAddBtn').addEventListener('click', pkRegister);
$('pkList').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-pk]');
  if (!b || !confirm(`パスキー「${b.dataset.name}」を削除します。この端末（アカウント）では、パスキーで入れなくなります。`)) return;
  b.disabled = true;
  try {
    await pkCall('delete', { ticket: await pkTicket(), id: b.dataset.pk });
    toast('パスキーを削除しました');
    pkRefresh();
  } catch (ex) {
    $('pkError').textContent = errMessage(ex);
    b.disabled = false;
  }
});
