// 管理画面: 設定の「一般」（利用時間・予約の制限・お知らせ）
'use strict';

// ---------------- 利用時間・制限 ----------------
function fillSettings(s) {
  state.settingsBase = s;
  $('sTitle').value = s.title;
  $('sNotice').value = s.notice || '';
  $('sNoticeLevel').value = s.noticeLevel === '重要' ? '重要' : '通常';
  timeSelects($('sOpenH'), $('sOpenM'), 23);
  timeSelects($('sCloseH'), $('sCloseM'), 24);
  setTime($('sOpenH'), $('sOpenM'), s.openTime);
  setTime($('sCloseH'), $('sCloseM'), s.closeTime);
  $('sUnit').innerHTML = state.data.unitOptions.map((u) => `<option value="${u}">${u}</option>`).join('');
  $('sUnit').value = String(s.unitMinutes);
  $('sMaxDur').value = s.maxDurationMinutes;
  $('sMaxDays').value = s.maxDaysAhead;
  $('sMaxBulk').value = s.maxBulkCount;
  $('sWeekdays').innerHTML = [...WEEKDAY_NAMES].map((w, i) =>
    `<label class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}"><input type="checkbox" value="${i}"${s.closedWeekdays.includes(i) ? ' checked' : ''}>${w}</label>`).join('');
  $('sBulkAdmin').checked = !!s.bulkRequiresAdmin;
  fillPasswords(s);
  $('settingsError').textContent = '';
  $('settingsWarn').textContent = '';
}
$('settingsForm').addEventListener('input', () => checkDirty('settings'));
$('settingsForm').addEventListener('change', () => checkDirty('settings'));
$('settingsForm').addEventListener('submit', (e) => e.preventDefault());
$('saveSettingsBtn').addEventListener('click', async () => {
  const err = $('settingsError');
  err.textContent = '';
  $('settingsWarn').textContent = '';
  const mine = {
    title: $('sTitle').value,
    notice: $('sNotice').value,
    noticeLevel: $('sNoticeLevel').value,
    openTime: getTime($('sOpenH'), $('sOpenM')),
    closeTime: getTime($('sCloseH'), $('sCloseM')),
    unitMinutes: Number($('sUnit').value),
    maxDurationMinutes: Number($('sMaxDur').value || 0),
    maxDaysAhead: Number($('sMaxDays').value || 0),
    maxBulkCount: Number($('sMaxBulk').value || 0),
    closedWeekdays: [...$('sWeekdays').querySelectorAll('input:checked')].map((c) => Number(c.value)),
    bulkRequiresAdmin: $('sBulkAdmin').checked,
  };
  if (toMin(mine.closeTime) <= toMin(mine.openTime)) { err.textContent = '利用終了時刻は利用開始時刻より後にしてください。'; return; }
  const btn = $('saveSettingsBtn');
  btn.disabled = true;
  try {
    // 保存の直前に最新の設定を読み直し、この画面で変えた項目だけを重ねる
    // （開いたあとに予約表でお知らせを変えた、ほかの画面でパスワードを変えた、などを戻さないため）
    const latest = (await fetchLatest()).settings;
    const base = state.settingsBase || {};
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const settings = Object.assign({}, latest);
    for (const k of Object.keys(mine)) if (!same(mine[k], base[k])) settings[k] = mine[k];
    const res = await api('adminSaveSettings', { settings });
    if (!res.ok) throw new Error(res.message);
    state.data.settings = res.settings;
    $('appName').textContent = res.settings.title;
    fillSettings(res.settings);
    renderClosureForm();
    renderExportForm();
    setDirty('settings', false);
    $('settingsWarn').textContent = (res.warnings || []).join('\n');
    toast('設定を保存しました');
  } catch (ex) {
    err.textContent = errMessage(ex);
  } finally {
    btn.disabled = false;
  }
});
