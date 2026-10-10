/** ローカル動作確認用: 初回だけ setup() を実行し、サンプルの予約・休館データを入れる。 */
(function () {
  'use strict';
  // http://127.0.0.1:8765/?reset=1 で開くと、テストデータを初期状態に戻す
  if (/[?&]reset=1/.test(location.search)) {
    localStorage.clear();
    sessionStorage.clear();
    window.devCf.reset(); // ブラウザの中の Cloudflare（正本）のデータも消す
    location.replace(location.pathname);
    return;
  }
  if (!gasStub.isEmpty()) return;
  setup();

  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const tomorrow = addDays_(today, 1);
  const samples = [
    [today, 'room_01', '15:00', '17:10', 'G8032', '上野友希'],
    [today, 'room_02', '10:00', '11:40', 'G8012', '佐藤'],
    [today, 'room_07', '10:30', '11:30', 'G8501', '鈴木'],
    [today, 'room_07', '11:35', '12:20', 'G8501', '鈴木'],
    [today, 'room_09', '09:25', '10:20', 'G8193', '高橋'],
    [today, 'room_12', '10:30', '13:00', 'G8505', '菊地悠花'],
    [today, 'room_16', '10:00', '12:00', 'g6509', '持地'],
    [today, 'room_16', '12:45', '14:30', 'G4507', '横山'],
    [today, 'room_17', '12:20', '12:45', 'G5', '伊藤'],
    [today, 'room_18', '07:00', '10:10', 'g7410', '山本'],
    [today, 'room_21', '11:00', '13:30', '教員', '工藤心結'],
    [today, 'room_26', '14:00', '15:00', 'G8715', '佐々木'],
    [tomorrow, 'room_03', '09:00', '10:00', 'G8122', '塩見'],
  ].filter((s) => s[4]);
  const rows = samples.map((s, i) => toRow_({
    id: 'res_seed_' + i, date: s[0], roomId: s[1], start: s[2], end: s[3], affiliation: s[4], name: s[5],
    pin: '0000', createdAt: today + ' 08:00:00', groupId: '', memo: '', updatedAt: '',
  }));
  appendRows_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.reservations), rows);

  const closures = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.closures);
  closures.getRange(2, 1, 2, 5).setValues([
    [today, 'room_10', '', '', 'ピアノ調律'],
    [today, '', '21:00', '22:00', '全館清掃'],
  ]);
  gasStub.save();
})();
