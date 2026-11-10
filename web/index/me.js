// 予約表: マイページ（ログイン中の人の登録内容、パスキーの一覧・追加・削除、ログアウト。仕様書 2.12）
// 「自分の予約」の氏名の行から開く。パスキーは高速キャッシュが動いているときだけ（index/user.js の userPkSupported）。
// 一覧・追加・削除には、正本が出す許可証（userPasskeyTicket）を Worker（/passkey/userList・userRegister・userDelete）に添える
'use strict';

/** 正本から、パスキーの操作に使う許可証をもらう（有効5分） */
async function meTicket() {
  const t = await api('userPasskeyTicket', {});
  if (!t || !t.ok) throw new Error((t && t.message) || 'パスキーを扱えませんでした。');
  return t.ticket;
}

/** 登録したパスキーの一覧を読み直して出す */
async function meLoadPasskeys() {
  const ul = $('mePkList');
  ul.innerHTML = '<li class="me-note">読み込み中…</li>';
  try {
    const res = await upkCall('userList', { ticket: await meTicket() });
    const mine = load_(LS.userPk, '');
    const day = (t) => esc(String(t || '').slice(0, 10).replace(/-/g, '/'));
    // 名前は「iPhone（2026/11/10 登録）」の形で保存しているので、端末の種類だけを大きく出し、日付と「この端末」は下の行に
    ul.innerHTML = res.passkeys.map((p) =>
      `<li><div><b>${esc(String(p.name).replace(/（[^（]*登録）$/, '') || p.name)}</b>` +
      `<small>${[p.id === mine ? 'この端末' : '', p.created ? day(p.created) + ' 登録' : '', p.lastUsed ? '最後の使用 ' + day(p.lastUsed) : ''].filter(Boolean).join(' · ')}</small></div>` +
      `<button type="button" data-id="${esc(p.id)}" data-name="${esc(p.name)}">削除</button></li>`).join('');
  } catch (ex) {
    if (ex instanceof AuthError) { ul.innerHTML = ''; return; }
    ul.innerHTML = `<li class="me-note">${esc(errMessage(ex))}</li>`;
  }
}

function openMePage() {
  const u = state.user;
  if (!u) return;
  $('meName').textContent = u.name;
  $('meSid').textContent = u.studentId;
  $('mePkSec').hidden = !userPkSupported;
  $('meDialog').showModal();
  if (userPkSupported) meLoadPasskeys();
}
$('myUser').addEventListener('click', openMePage);

$('mePkList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-id]');
  if (!btn || !state.user) return;
  if (!confirm(`パスキー「${btn.dataset.name}」を削除しますか？\nこのパスキーではログインできなくなります。端末に残ったパスキーは、端末の設定から削除してください。`)) return;
  if (isOffline()) { toast(OFFLINE_MSG, 'error'); return; }
  btn.disabled = true;
  try {
    await upkCall('userDelete', { ticket: await meTicket(), id: btn.dataset.id });
    if (btn.dataset.id === load_(LS.userPk, '')) { try { localStorage.removeItem(LS.userPk); } catch (ex) { /* 保存できない環境では何もしない */ } }
    toast('パスキーを削除しました');
    await meLoadPasskeys();
  } catch (ex) {
    btn.disabled = false;
    if (!(ex instanceof AuthError)) toast(errMessage(ex), 'error');
  }
});

$('mePkAdd').addEventListener('click', async () => {
  if (!state.user) return;
  const btn = $('mePkAdd');
  if (isOffline()) { toast(OFFLINE_MSG, 'error'); return; }
  btn.disabled = true;
  try {
    const ticket = await meTicket();
    const c = await upkCall('challenge');
    const label = `${state.user.name}（${state.user.studentId}）`; // パスキーの一覧に出る名前（ID は学籍番号と氏名）
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: new TextEncoder().encode(c.challenge),
      rp: { id: c.rpId, name: '練習室予約' },
      // 同じ人が同じ端末で登録し直したときは置き換わるよう、学籍番号から作る
      user: { id: new TextEncoder().encode('user:' + state.user.studentId), name: label, displayName: label },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none', timeout: 60000,
    } });
    const r = cred.response;
    if (typeof r.getPublicKey !== 'function') throw new Error('このブラウザではパスキーを登録できません。Safari・Chrome を新しくしてからお試しください。');
    await upkCall('userRegister', {
      ticket, name: upkDeviceName(), id: cred.id, publicKey: upkB64(r.getPublicKey()), alg: r.getPublicKeyAlgorithm(),
      clientDataJSON: upkB64(r.clientDataJSON), authenticatorData: upkB64(r.getAuthenticatorData()),
    });
    save_(LS.userPk, cred.id);
    toast('パスキーを登録しました');
    await meLoadPasskeys();
  } catch (ex) {
    if (!upkCancelled(ex) && !(ex instanceof AuthError)) toast(errMessage(ex), 'error');
  } finally {
    btn.disabled = false;
  }
});

$('meLogout').addEventListener('click', () => {
  if (!confirm('ログアウトしますか？')) return;
  logoutUser();
  toast('ログアウトしました');
});
