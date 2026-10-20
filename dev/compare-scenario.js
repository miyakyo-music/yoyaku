/**
 * テスト環境だけで使う: 同じ操作の台本を流し、結果を window.__scenario に残す（GAS と Cloudflare の結果を比べるため）。
 * 使い方は保守マニュアル 03 の「正本の移し替えを試す」。時刻は ?now=2026-10-10T09:00:00%2B09:00 で固定して流す。
 */
(async () => {
  const out = [];
  const A = 'admin123';
  const D = '2026-10-12', D7 = '2026-10-19', T = '2026-10-10';
  const ids = {};
  const rec = (name, r, extra) => { out.push([name, r.ok, r.code || '', (r.message || '').replace(/res_\w+/g, 'ID'), extra === undefined ? '' : extra]); return r; };
  const c = (fn, p) => callApi(fn, p);
  const base = { roomId: 'room_07', date: D, affiliation: 'G1', name: '甲', memo: '', pin: '1111' };
  // 終わった予約は API では作れないので、両方の保存先（シートと Cloudflare）へ直接入れる（流していない方の分は使われない）
  const put = (x) => {
    const row = toRow_(Object.assign({ affiliation: '', pin: '', createdAt: T + ' 06:00:00', groupId: '', memo: '', updatedAt: '', color: '' }, x));
    appendRows_(getSpreadsheet_().getSheetByName('予約台帳'), [row]);
    devCf.core.db.exec('INSERT INTO reservations (id, date, room_id, st, en, affiliation, name, pin, created_at, group_id, memo, updated_at, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ...row);
  };

  let r = rec('sched', await c('getSchedule', { from: T, to: D }), null);
  out[out.length - 1][4] = [r.reservations.length, r.rooms.length, r.closures.length, r.settings.unitMinutes, r.settings.viewPasswordRequired];
  r = rec('create', await c('createReservation', Object.assign({}, base, { start: '13:00', end: '14:00' })));
  ids.a = r.reservation && r.reservation.id;
  out[out.length - 1][4] = r.reservation && [r.reservation.start, r.reservation.end, r.reservation.hasPin, r.reservation.color];
  rec('overlap', await c('createReservation', Object.assign({}, base, { start: '13:30', end: '14:30' })));
  rec('unit', await c('createReservation', Object.assign({}, base, { start: '13:03', end: '14:30' })));
  rec('formula', await c('createReservation', Object.assign({}, base, { start: '15:00', end: '16:00', name: '=x' })));
  rec('closure', await c('createReservation', Object.assign({}, base, { date: T, roomId: 'room_10', start: '15:00', end: '16:00' })));
  rec('closureAll', await c('createReservation', Object.assign({}, base, { date: T, roomId: 'room_05', start: '21:00', end: '21:30' })));
  rec('past', await c('createReservation', Object.assign({}, base, { date: T, start: '07:00', end: '08:00' })));
  rec('pinBad', await c('createReservation', Object.assign({}, base, { start: '16:00', end: '17:00', pin: '12a' })));
  rec('noRoom', await c('createReservation', Object.assign({}, base, { roomId: 'room_99', start: '16:00', end: '17:00' })));
  rec('colorNonAdmin', await c('createReservation', Object.assign({}, base, { start: '18:00', end: '19:00', color: 'red' })), null);
  rec('bulkNoAdmin', await c('createBulkReservations', Object.assign({}, base, { dates: [D, D7], roomIds: ['room_08', 'room_09'], start: '15:00', end: '16:00' })));
  r = rec('bulk', await c('createBulkReservations', Object.assign({}, base, { adminPassword: A, dates: [D, D7], roomIds: ['room_08', 'room_09'], start: '15:00', end: '16:00', color: 'purple' })));
  ids.g = r.groupId; ids.g1 = r.reservations && r.reservations[0].id;
  out[out.length - 1][4] = r.reservations && r.reservations.map((x) => x.date + x.roomId + x.color).join(',');
  r = rec('bulkConflict', await c('createBulkReservations', Object.assign({}, base, { adminPassword: A, dates: [D, D7], roomIds: ['room_08'], start: '15:30', end: '16:30' })));
  out[out.length - 1][4] = [r.availableCount, (r.conflicts || []).length];
  r = rec('pairs', await c('createBulkReservations', Object.assign({}, base, { adminPassword: A, pairs: [{ date: D, roomId: 'room_11' }, { date: D7, roomId: 'room_12' }, { date: D, roomId: 'room_11' }], start: '09:00', end: '10:00' })));
  out[out.length - 1][4] = r.reservations && r.reservations.length;
  rec('updWrongPin', await c('updateReservation', Object.assign({}, base, { id: ids.a, pin: '2222', start: '14:00', end: '15:00' })));
  r = rec('upd', await c('updateReservation', Object.assign({}, base, { id: ids.a, pin: '1111', start: '14:00', end: '15:00', memo: 'メモ  あり' })));
  out[out.length - 1][4] = r.reservation && [r.reservation.start, r.reservation.end, r.reservation.memo];
  rec('updConflict', await c('updateReservation', Object.assign({}, base, { id: ids.a, pin: '1111', roomId: 'room_08', start: '15:00', end: '16:00' })));
  r = rec('updSeries', await c('updateReservation', Object.assign({}, base, { id: ids.g1, adminPassword: A, scope: 'following', start: '16:00', end: '17:00', name: '乙' })));
  out[out.length - 1][4] = r.reservations && r.reservations.map((x) => x.start + x.name).join(',');
  r = rec('byIds', await c('getReservationsByIds', { ids: [ids.a, ids.g1, 'nope'] }));
  out[out.length - 1][4] = r.reservations && r.reservations.map((x) => x.start + x.name + x.hasPin).join(',');
  for (let i = 0; i < 6; i++) rec('cancelBad' + i, await c('cancelReservation', { id: ids.a, pin: '9999' }));
  r = rec('cancelSeries', await c('cancelReservation', { id: ids.g1, adminPassword: A, scope: 'following' }));
  out[out.length - 1][4] = r.cancelledIds && r.cancelledIds.length;
  r = rec('cancelAdminPinField', await c('cancelReservation', { id: ids.a, pin: A }));
  rec('cancelAgain', await c('cancelReservation', { id: ids.a, pin: '1111' }));
  // 管理画面の予約履歴からまとめて削除
  r = await c('createBulkReservations', Object.assign({}, base, { adminPassword: A, dates: [D, D7], roomIds: ['room_13'], start: '11:00', end: '12:00' }));
  const delIds = (r.reservations || []).map((x) => x.id);
  rec('delNoAdmin', await c('adminDeleteReservations', { ids: delIds }));
  rec('delEmpty', await c('adminDeleteReservations', { adminPassword: A, ids: [] }));
  r = rec('del', await c('adminDeleteReservations', { adminPassword: A, ids: delIds.concat(['nope', delIds[0]]) }));
  out[out.length - 1][4] = r.deletedIds && r.deletedIds.length;
  r = rec('delAgain', await c('adminDeleteReservations', { adminPassword: A, ids: delIds }));
  out[out.length - 1][4] = r.deletedIds && r.deletedIds.length;
  CacheService.getScriptCache().remove('writes_' + Math.floor(Date.now() / 60000)); // 削除の分で、書き込みの上限に当たらないよう数え直す
  devCf.core.kdel('writes_' + Math.floor(Date.now() / 60000));
  // 終了した予約の取消（管理者だけができる）
  put({ id: 'res_dev_past', date: T, roomId: 'room_13', start: '07:00', end: '08:00', name: '過去' });
  rec('cancelPast', await c('cancelReservation', { id: 'res_dev_past' }));
  rec('cancelPastAdmin', await c('cancelReservation', { id: 'res_dev_past', adminPassword: A }));
  rec('bug', await c('submitBugReport', { message: '=テスト', contact: 'x', env: { userAgent: 'UA', screen: '1x1', page: 'p' } }), null);
  r = rec('bugs', await c('adminGetBugReports', { adminPassword: A }));
  ids.bug = r.reports && r.reports[0] && r.reports[0].id;
  out[out.length - 1][4] = r.reports && r.reports.map((x) => x.status + x.message + x.contact + x.userAgent).join(',');
  rec('bugStatus', await c('adminSetBugStatus', { adminPassword: A, id: ids.bug, status: '対応済み' }));
  rec('bugStatusBad', await c('adminSetBugStatus', { adminPassword: A, id: ids.bug, status: 'x' }));
  r = rec('adminData', await c('adminGetData', { adminPassword: A }));
  out[out.length - 1][4] = r.ok && [Object.keys(r).sort().join(','), r.rooms.length, r.closures.length, r.openBugs, JSON.stringify(r.settings)];
  const s = Object.assign({}, r.settings, { maxDurationMinutes: 120 });
  r = rec('saveSettings', await c('adminSaveSettings', { adminPassword: A, settings: s }));
  out[out.length - 1][4] = r.ok && [JSON.stringify(r.settings), r.warnings.join('|')];
  rec('tooLong', await c('createReservation', Object.assign({}, base, { start: '07:00', end: '10:00' })));
  rec('tooLongAdmin', await c('createReservation', Object.assign({}, base, { adminPassword: A, start: '07:00', end: '10:00' })));
  rec('badSettings', await c('adminSaveSettings', { adminPassword: A, settings: Object.assign({}, s, { unitMinutes: 7 }) }));
  r = rec('notice', await c('adminSetNotice', { adminPassword: A, notice: 'お知らせ  です', noticeLevel: '重要' }));
  out[out.length - 1][4] = r.ok && JSON.stringify(r.settings);
  r = await c('adminGetData', { adminPassword: A });
  const rooms = r.rooms.map((x) => ({ id: x.id, name: x.name, equipment: x.equipment, restriction: x.restriction, note: x.note, tags: x.tags }));
  rec('roomInUse', await c('adminSaveRooms', { adminPassword: A, rooms: rooms.filter((x) => x.id !== 'room_07') }));
  const rooms2 = rooms.filter((x) => x.id !== 'room_25').concat([{ name: '新しい部屋', equipment: 'GP', restriction: '限定公開', note: '', tags: 'GP' }]);
  r = rec('saveRooms', await c('adminSaveRooms', { adminPassword: A, rooms: rooms2 }));
  out[out.length - 1][4] = r.rooms && r.rooms.slice(-2).map((x) => x.id + x.name + x.restriction + x.order).join(',');
  const newRoom = r.rooms && r.rooms[r.rooms.length - 1].id;
  r = rec('saveClosures', await c('adminSaveClosures', { adminPassword: A, closures: [{ date: D, roomId: 'room_07', allDay: false, start: '07:00', end: '08:00', reason: '点検' }, { date: D, roomId: '', allDay: true, reason: '休館' }] }));
  out[out.length - 1][4] = r.ok && [JSON.stringify(r.closures), r.warnings.join('|')];
  rec('afterClosure', await c('createReservation', Object.assign({}, base, { roomId: 'room_01', start: '10:00', end: '11:00' })));
  await c('adminSaveClosures', { adminPassword: A, closures: [] });
  // 1分あたりの書き込みの上限（GAS は30件、Cloudflare は60件）に台本が当たらないよう、ここで数え直す
  const minuteKey = 'writes_' + Math.floor(Date.now() / 60000);
  CacheService.getScriptCache().remove(minuteKey);
  devCf.core.kdel(minuteKey);
  // まとめ予約の「この日以降を取り消す」: 管理者以外は、終わった分・見えない部屋（限定公開）・管理者のみの部屋の分を残す
  r = await c('adminGetData', { adminPassword: A });
  await c('adminSaveRooms', { adminPassword: A, rooms: r.rooms.map((x) => Object.assign({}, x, x.id === 'room_15' ? { restriction: '管理者のみ' } : {})) });
  const series = [['s1', 'room_14', T, '10:00', '11:00'], ['s0', 'room_12', T, '07:00', '08:00'], ['s2', 'room_14', D7, '10:00', '11:00'],
    ['s3', 'room_15', D7, '10:00', '11:00'], ['s4', newRoom, D7, '10:00', '11:00']];
  series.forEach(([n, roomId, date, start, end]) => put({ id: 'res_dev_' + n, date, roomId, start, end, name: n, groupId: 'grp_dev_series' }));
  // 時刻が読めない行（シートを手で書き換えた空欄など）は、同じ部屋・同じ日の全時間帯と重なるとみなす
  put({ id: 'res_dev_broken', date: D7, roomId: 'room_03', start: '', end: '', name: '壊' });
  rec('brokenTime', await c('createReservation', Object.assign({}, base, { date: D7, roomId: 'room_03', start: '18:00', end: '19:00' })));
  // 「この日以降をまとめて変更」も、管理者以外は同じ分を変えずに残す（全体を失敗にしない）
  r = rec('updateFollowing', await c('updateReservation', { id: 'res_dev_s1', scope: 'following', date: T, roomId: 'room_14', start: '10:00', end: '11:00', affiliation: '', name: '丙', memo: '' }));
  out[out.length - 1][4] = r.reservations && r.reservations.map((x) => x.id.replace('res_dev_', '') + x.name).sort().join(',');
  r = rec('cancelFollowing', await c('cancelReservation', { id: 'res_dev_s1', scope: 'following' }));
  out[out.length - 1][4] = r.cancelledIds && r.cancelledIds.slice().sort().join(',');
  r = rec('cancelFollowingLeft', await c('getReservationsByIds', { adminPassword: A, ids: series.map((x) => 'res_dev_' + x[0]) }));
  out[out.length - 1][4] = r.reservations && r.reservations.map((x) => x.name).sort().join(',');
  r = rec('cancelFollowingAdmin', await c('cancelReservation', { id: 'res_dev_s0', adminPassword: A, scope: 'following' }));
  out[out.length - 1][4] = r.cancelledIds && r.cancelledIds.slice().sort().join(',');
  // 限定公開
  r = await c('adminGetData', { adminPassword: A });
  await c('adminSaveSettings', { adminPassword: A, settings: Object.assign({}, r.settings, { limitedPassword: 'secret1' }) });
  r = rec('limitedNo', await c('getSchedule', { from: D, to: D }));
  out[out.length - 1][4] = [r.rooms.some((x) => x.id === newRoom), r.limitedAccess || false, r.limitedDenied || false];
  r = rec('limitedBad', await c('getSchedule', { from: D, to: D, limitedKey: 'nope' }));
  out[out.length - 1][4] = [r.rooms.some((x) => x.id === newRoom), r.limitedAccess || false, r.limitedDenied || false];
  r = rec('limitedOk', await c('getSchedule', { from: D, to: D, limitedKey: 'secret1' }));
  out[out.length - 1][4] = [r.rooms.some((x) => x.id === newRoom), r.limitedAccess || false];
  r = rec('limitedBook', await c('createReservation', Object.assign({}, base, { roomId: newRoom, start: '10:00', end: '11:00', limitedKey: 'secret1', color: 'green' })));
  out[out.length - 1][4] = r.reservation && r.reservation.color;
  rec('limitedBookNo', await c('createReservation', Object.assign({}, base, { roomId: newRoom, start: '12:00', end: '13:00' })));
  // 誤入力が続いて止めている間は、正しいパスワードでも通さず（端末の覚えは消させない）、回数も増やさない
  for (let i = 0; i < 30; i++) await c('getSchedule', { from: D, to: D, limitedKey: 'bad' + i });
  r = rec('limitedLocked', await c('getSchedule', { from: D, to: D, limitedKey: 'secret1' }));
  out[out.length - 1][4] = [r.rooms.some((x) => x.id === newRoom), r.limitedAccess || false, r.limitedLocked || false, r.limitedDenied || false];
  r = rec('limitedLockedAdmin', await c('getSchedule', { from: D, to: D, limitedKey: 'secret1', adminPassword: A }));
  out[out.length - 1][4] = [r.rooms.some((x) => x.id === newRoom), r.limitedAccess || false, r.limitedLocked || false];
  CacheService.getScriptCache().remove('limitedFailures');
  devCf.core.kdel('limitedFailures');
  // 管理者の端末に残った古いパスワードは数えない（29回の誤入力のあとでも、正しいパスワードの人は止まらない）
  for (let i = 0; i < 29; i++) await c('getSchedule', { from: D, to: D, limitedKey: 'old', adminPassword: A });
  for (let i = 0; i < 29; i++) await c('getSchedule', { from: D, to: D, limitedKey: 'bad' + i });
  r = rec('limitedAdminStale', await c('getSchedule', { from: D, to: D, limitedKey: 'secret1' }));
  out[out.length - 1][4] = [r.rooms.some((x) => x.id === newRoom), r.limitedAccess || false, r.limitedLocked || false];
  CacheService.getScriptCache().remove('limitedFailures');
  devCf.core.kdel('limitedFailures');
  r = rec('limitedAfterLock', await c('getSchedule', { from: D, to: D, limitedKey: 'secret1' }));
  out[out.length - 1][4] = [r.rooms.some((x) => x.id === newRoom), r.limitedAccess || false];
  // 閲覧パスワード
  r = await c('adminGetData', { adminPassword: A });
  await c('adminSaveSettings', { adminPassword: A, settings: Object.assign({}, r.settings, { viewPassword: 'view' }) });
  rec('viewNo', await c('getSchedule', { from: D, to: D }));
  rec('viewBad', await c('getSchedule', { from: D, to: D, viewKey: 'x' }));
  r = rec('viewOk', await c('getSchedule', { from: D, to: D, viewKey: 'view' }));
  out[out.length - 1][4] = r.settings && r.settings.viewPasswordRequired;
  // 管理者は閲覧パスワードを求められない（端末に残った古い値も数えない）
  r = rec('viewAdmin', await c('getSchedule', { from: D, to: D, adminPassword: A }));
  out[out.length - 1][4] = r.reservations && r.reservations.length;
  rec('viewAdminStale', await c('getSchedule', { from: D, to: D, adminPassword: A, viewKey: 'old' }), null);
  for (let i = 0; i < 28; i++) await c('getSchedule', { from: D, to: D, viewKey: 'x' + i }); // viewBad と合わせて29回
  rec('viewBeforeLock', await c('getSchedule', { from: D, to: D, viewKey: 'view' }), null); // 管理者の古い値を数えていれば、ここで止まる
  await c('getSchedule', { from: D, to: D, viewKey: 'x28' }); // 30回目
  rec('viewLocked', await c('getSchedule', { from: D, to: D, viewKey: 'view' }));
  rec('viewLockedEmpty', await c('getSchedule', { from: D, to: D }));
  CacheService.getScriptCache().remove('viewFailures');
  devCf.core.kdel('viewFailures');
  rec('viewAfterLock', await c('getSchedule', { from: D, to: D, viewKey: 'view' }), null);
  await c('adminSaveSettings', { adminPassword: A, settings: Object.assign({}, r.settings, { viewPassword: '', limitedPassword: 'secret1', closedWeekdays: [] }) });
  // 変更履歴（予約 ID は両方で違うので比べない）
  const logLine = (e) => [e.action, e.date, e.roomId, e.time, e.who].join(' ');
  r = rec('log', await c('adminGetLog', { adminPassword: A }));
  out[out.length - 1][4] = r.entries && [r.entries.map(logLine).join(';'), r.more];
  r = rec('logCancel', await c('adminGetLog', { adminPassword: A, kind: 'cancel' }));
  out[out.length - 1][4] = r.entries && r.entries.map(logLine).join(';');
  r = rec('logAdmin', await c('adminGetLog', { adminPassword: A, kind: 'admin' }));
  out[out.length - 1][4] = r.entries && r.entries.map((e) => e.action + ' ' + e.detail).join(';');
  r = rec('logQuery', await c('adminGetLog', { adminPassword: A, q: base.name + ' 変更' }));
  out[out.length - 1][4] = r.entries && r.entries.map(logLine).join(';');
  rec('logNoAdmin', await c('adminGetLog', {}));
  // パスワード変更・パスキー（パスワードを変えると、それより前に出たパスキーでのログインの印は使えない）
  const pkToken = (exp) => 'pk1.' + exp + '.devtag.' + hmac_('devtoken', 'pk1.' + exp + '.devtag');
  const nowSec = Math.floor(Date.now() / 1000);
  const pkOld = pkToken(nowSec + 12 * 3600 - 60);
  rec('pkBefore', await c('adminGetData', { adminPassword: pkOld }), null);
  rec('pwShort', await c('adminChangePassword', { adminPassword: A, newPassword: '123' }));
  rec('pwChange', await c('adminChangePassword', { adminPassword: A, newPassword: 'newpass1' }));
  rec('pkAfter', await c('adminGetData', { adminPassword: pkOld }));
  rec('pkNew', await c('adminGetData', { adminPassword: pkToken(nowSec + 12 * 3600 + 60) }), null);
  rec('pwOld', await c('adminGetData', { adminPassword: A }));
  rec('pwNew', await c('adminGetData', { adminPassword: 'newpass1' }), null);
  rec('pwBack', await c('adminChangePassword', { adminPassword: 'newpass1', newPassword: A }));
  r = rec('ticket', await c('adminPasskeyTicket', { adminPassword: A }));
  out[out.length - 1][4] = /^pkt\.\d+\.[\w-]+$/.test(r.ticket || '');
  for (let i = 0; i < 10; i++) rec('adminBad' + i, await c('adminGetData', { adminPassword: 'wrong' + i }));
  rec('range', await c('getSchedule', { from: '2026-10-01', to: '2026-12-01' }));
  rec('unknown', await c('nope', {}));
  r = await c('getSchedule', { from: T, to: D7 });
  out.push(['final', r.ok, '', '', r.reservations.map((x) => x.date + x.roomId + x.start + x.end + x.name + x.hasPin + x.color + x.memo).sort().join(';')]);
  window.__scenario = out;
  return out.length;
})();
