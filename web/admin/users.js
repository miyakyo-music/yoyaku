// 管理画面: 予約表から登録した利用者（学生）の一覧と削除（仕様書 2.12・3.1）
'use strict';

async function loadUsers() {
  $('userError').textContent = '';
  try {
    const res = await api('adminGetUsers', {});
    if (!res.ok) throw new Error(res.message);
    $('userCount').textContent = res.users.length ? `${res.users.length}人` : '';
    $('userList').innerHTML = res.users.map((u) => `<li><span class="pk-body"><span class="pk-name">${esc(u.name)}</span>` +
      `<span class="pk-meta">${esc(u.studentId)}・${esc(String(u.createdAt).slice(0, 10).replace(/-/g, '/'))} 登録</span></span>` +
      `<button type="button" class="btn small danger-text" data-sid="${esc(u.studentId)}" data-name="${esc(u.name)}">削除</button></li>`).join('') ||
      '<li class="empty">登録されていません</li>';
  } catch (e) {
    $('userError').textContent = errMessage(e);
  }
}

$('userList').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-sid]');
  if (!b || !confirm(`${b.dataset.name}（${b.dataset.sid}）の登録を削除します。この人はログインできなくなります（予約は残ります）。`)) return;
  b.disabled = true;
  try {
    const res = await api('adminDeleteUser', { studentId: b.dataset.sid });
    if (!res.ok) throw new Error(res.message);
    toast('登録を削除しました');
    loadUsers();
  } catch (ex) {
    $('userError').textContent = errMessage(ex);
    b.disabled = false;
  }
});
