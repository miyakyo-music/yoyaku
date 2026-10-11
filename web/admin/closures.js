// 管理画面: 休館・利用停止の登録と一覧
'use strict';

// ---------------- 休館・利用停止 ----------------

const showClosureDate = dateField('cDate');

// 休館の対象: 追加すると部屋ごとに1件ずつ登録する
const closurePick = roomPicker('cRoom');
function renderClosureForm() {
  const s = state.data.settings;
  closurePick.render();
  if (!$('cDate').value) $('cDate').value = state.data.today;
  showClosureDate();
  timeSelects($('cStartH'), $('cStartM'), 24);
  timeSelects($('cEndH'), $('cEndM'), 24);
  setTime($('cStartH'), $('cStartM'), s.openTime);
  setTime($('cEndH'), $('cEndM'), s.closeTime);
}

function renderClosures() {
  const today = state.data.today;
  const showPast = $('showPast').checked;
  const list = state.closures
    .map((c, i) => ({ ...c, i }))
    .filter((c) => showPast || c.date >= today)
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  $('closureList').innerHTML = list.length ? list.map((c) => {
    const d = dateLabel(c.date);
    return `<tr class="${c.date < today ? 'past' : ''}">
        <td class="${d.cls}">${esc(d.text)}</td>
        <td>${esc(roomName(c.roomId))}</td>
        <td>${c.allDay ? '終日' : esc(hm(c.start)) + '〜' + esc(hm(c.end))}</td>
        <td class="reason">${esc(c.reason)}</td>
        <td><button type="button" class="btn small danger-text" data-del="${c.i}">削除</button></td>
      </tr>`;
  }).join('') : `<tr><td colspan="5" class="empty">${showPast ? '登録はありません。' : '今日以降の登録はありません。'}</td></tr>`;
}

async function saveClosures(next, message) {
  $('closureError').textContent = '';
  $('closureWarn').textContent = '';
  const res = await api('adminSaveClosures', { closures: next });
  if (!res.ok) throw new Error(res.message);
  state.closures = res.closures;
  state.data.closures = res.closures;
  renderClosures();
  $('closureWarn').textContent = (res.warnings || []).join('\n');
  toast(message);
}

$('cAllDay').addEventListener('change', (e) => { $('cTimeField').hidden = e.target.checked; });
$('showPast').addEventListener('change', renderClosures);
$('closureForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const item = {
    date: $('cDate').value,
    allDay: $('cAllDay').checked,
    start: getTime($('cStartH'), $('cStartM')),
    end: getTime($('cEndH'), $('cEndM')),
    reason: $('cReason').value.trim(),
  };
  if (!item.date) { $('closureError').textContent = '日付を指定してください。'; return; }
  if (!item.allDay && toMin(item.end) <= toMin(item.start)) { $('closureError').textContent = '終了は開始より後にしてください。'; return; }
  const btn = $('addClosureBtn');
  btn.disabled = true;
  try {
    const picked = closurePick.ids();
    const ids = picked.length ? picked : [''];
    closurePick.close();
    await saveClosures(state.closures.concat(ids.map((roomId) => ({ ...item, roomId }))), ids.length > 1 ? `${ids.length}室に追加しました` : '追加しました');
    $('cReason').value = '';
  } catch (ex) {
    $('closureError').textContent = errMessage(ex);
  } finally {
    btn.disabled = false;
  }
});
$('closureList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del]');
  if (!b) return;
  const c = state.closures[Number(b.dataset.del)];
  if (!confirm(`${dateLabel(c.date).text} ${roomName(c.roomId)}「${c.reason || '利用停止'}」を削除しますか？`)) return;
  b.disabled = true;
  try {
    await saveClosures(state.closures.filter((_, i) => i !== Number(b.dataset.del)), '削除しました');
  } catch (ex) {
    $('closureError').textContent = errMessage(ex);
    b.disabled = false;
  }
});
