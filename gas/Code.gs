/**
 * 練習室予約システム — サーバー側（Google Apps Script）
 *
 * 画面（web/）は GitHub Pages から配信し、このスクリプトは JSON を返す API としてだけ動く。
 * ウェブアプリ（実行ユーザー: 自分 / アクセス: 全員）としてデプロイし、その URL を web/config.js に書く。
 *
 * スプレッドシートに紐づく（コンテナバインド）スクリプトとして配置する。
 * 別ファイルのスプレッドシートを使う場合は、スクリプトプロパティ SPREADSHEET_ID にIDを設定する。
 *
 * シート構成（メニュー「予約システム > 初期セットアップ」で自動作成）:
 *   予約台帳        … 予約1件 = 1行
 *   部屋マスタ      … 部屋の一覧・予約制限
 *   休館・利用停止  … 休館日・メンテナンスなど予約できない日時
 *   設定            … 利用時間・予約単位・各種制限（管理者がシート上で変更できる）
 *   操作ログ        … 予約・変更・取消の記録（取消で台帳から消えた予約も追跡できる）
 *
 * スクリプトプロパティ:
 *   ADMIN_PASSWORD  … 管理用パスワード（メニューから設定）。どの予約も変更・取消でき、各種制限を受けない。
 *   SPREADSHEET_ID  … （任意）データ保存先スプレッドシートのID
 */

const SHEETS = {
  reservations: '予約台帳',
  rooms: '部屋マスタ',
  closures: '休館・利用停止',
  settings: '設定',
  log: '操作ログ',
  bugs: '不具合報告',
};

const HEADERS = {
  // 列の順番は変えないこと（台帳は列の位置で読み書きしている）
  reservations: ['予約ID', '予約日', '部屋ID', '開始時刻', '終了時刻', '学籍番号/所属', '氏名・団体名', '編集用パスワード', '作成日時', 'まとめ予約ID', '備考', '更新日時'],
  rooms: ['表示順', '部屋ID', '部屋表示名', '設備区分', '予約制限', '備考', '特徴タグ'],
  closures: ['日付', '部屋ID（空欄=全室）', '開始時刻（空欄=終日）', '終了時刻', '理由'],
  settings: ['項目', '値', '説明'],
  log: ['日時', '操作', '予約ID', '予約日', '部屋ID', '時間', '予約者', '詳細'],
  bugs: ['報告ID', '受付日時', '状態', '内容', '連絡先', '端末・ブラウザ', '画面サイズ', '表示していた画面', '環境情報（詳細）'],
};

const BUG_STATUSES = ['未対応', '対応中', '対応済み', '対応しない'];

const SYSTEM = {
  TIMEZONE: 'Asia/Tokyo',
  LOCK_WAIT_MS: 10000,
  MAX_AFFILIATION_LENGTH: 30,
  MAX_NAME_LENGTH: 50, // 英字の氏名や団体名も入るように長めにとる
  MAX_MEMO_LENGTH: 100,
  MAX_RANGE_DAYS: 42,
  // 編集用パスワード・パスワードの総当たり対策
  MAX_PIN_FAILURES: 5,
  MAX_LIMITED_FAILURES: 30, // 限定公開のパスワードを、全体でこの回数間違えると一定時間受け付けない
  FAILURE_LOCK_SECONDS: 600,
};

/** 「設定」シートの項目。label がシート上の項目名、def が既定値。 */
const SETTINGS = [
  { key: 'title', label: '予約表のタイトル', def: '練習室予約', desc: '画面上部に表示される名前' },
  { key: 'notice', label: 'お知らせ', def: '', desc: '画面上部に表示するお知らせ（空欄なら表示しない）' },
  { key: 'noticeLevel', label: 'お知らせの種類', def: '通常', desc: '通常（青）／ 重要（赤。休館など予約に直結する連絡）' },
  { key: 'openTime', label: '利用開始時刻', def: '07:00', desc: '例：07:00' },
  { key: 'closeTime', label: '利用終了時刻', def: '22:00', desc: '例：22:00' },
  { key: 'unitMinutes', label: '予約単位（分）', def: '5', desc: '1, 5, 10, 15, 30 など60を割り切れる数' },
  { key: 'maxDurationMinutes', label: '1回の最大予約時間（分）', def: '0', desc: '0 = 制限なし（管理者は制限を受けない）' },
  { key: 'maxDaysAhead', label: '何日先まで予約できるか', def: '0', desc: '0 = 制限なし。例：14 なら今日から14日後まで（管理者は制限を受けない）' },
  { key: 'closedWeekdays', label: '定休日（曜日）', def: '', desc: '例：日 / 土,日（空欄なら定休日なし）' },
  { key: 'maxBulkCount', label: 'まとめて予約の最大件数', aliases: ['くり返し予約の最大回数'], def: '100', desc: 'くり返し・複数部屋の予約で1回に登録できる件数（部屋数×日数）' },
  { key: 'bulkRequiresAdmin', label: 'まとめて予約は管理者のみ', aliases: ['くり返し予約は管理者のみ'], def: 'はい', desc: 'くり返し予約・複数部屋の同時予約を管理者に限る（はい / いいえ）' },
  { key: 'viewPassword', label: '閲覧パスワード', def: '', desc: '設定すると予約表の閲覧・予約にこのパスワードが必要（空欄なら誰でも利用可）' },
  { key: 'limitedPassword', label: '限定公開の部屋のパスワード', def: '', desc: '予約制限が「限定公開」の部屋（演習室など）を表示・予約するためのパスワード（6文字以上。空欄なら管理者以外は使えない）' },
];
/** 画面へ返さない設定（パスワード類） */
const SECRET_SETTINGS = ['viewPassword', 'limitedPassword'];

// LIMITED（限定公開）… 演習室など。限定公開のパスワードを入れた人（と管理者）にだけ部屋も予約も見え、予約できる。
// 知らない人には部屋があることも分からないよう、サーバーから一切返さない。
const ROOM_RESTRICTIONS = { ADMIN_ONLY: '管理者のみ', STOPPED: '使用停止', LIMITED: '限定公開' };
const WEEKDAYS = '日月火水木金土';

// ---------------------------------------------------------------------------
// API の入口（ウェブアプリとしてデプロイする）
// ---------------------------------------------------------------------------

/** 画面とAPIの版。呼び出し方や応答の形を変えたら、web/api.js の API_VERSION と一緒に上げる */
const API_VERSION = 1;

/** 画面から呼び出せる処理。ここにない関数は外部から実行できない */
const API = {
  getSchedule: getSchedule,
  getReservationsByIds: getReservationsByIds,
  createReservation: createReservation,
  createBulkReservations: createBulkReservations,
  updateReservation: updateReservation,
  cancelReservation: cancelReservation,
  submitBugReport: submitBugReport,
  adminGetData: adminGetData,
  adminSaveSettings: adminSaveSettings,
  adminSaveRooms: adminSaveRooms,
  adminSaveClosures: adminSaveClosures,
  adminGetBugReports: adminGetBugReports,
  adminSetBugStatus: adminSetBugStatus,
  adminChangePassword: adminChangePassword,
};

/**
 * 画面からの呼び出し口。本文は {"action": 処理名, "params": {...}} の JSON。
 * CORS の事前確認を避けるため、画面側は Content-Type: text/plain で送ってくる。
 * パスワード類を含むので、URL のパラメータ（doGet）では受け付けない。
 */
function doPost(e) {
  let result;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const fn = Object.prototype.hasOwnProperty.call(API, req.action) ? API[req.action] : null;
    result = fn ? fn(req.params || {}) : fail_('不明な操作です。', 'BAD_REQUEST');
  } catch (err) {
    console.error(err);
    result = fail_('サーバーでエラーが発生しました。時間をおいて再度お試しください。', 'SERVER_ERROR');
  }
  result = result || { ok: true };
  result.apiVersion = API_VERSION;
  return json_(result);
}

/** 動作確認用（ブラウザで URL を開くと、API が動いているかがわかる） */
function doGet() {
  return json_({ ok: true, service: '練習室予約API', apiVersion: API_VERSION, serverNow: nowStr_('yyyy-MM-dd HH:mm') });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// 公開API（doPost から呼び出される。引数はすべて1つのオブジェクト）
// ---------------------------------------------------------------------------

/**
 * 期間内の予約・休館情報と部屋マスタ・設定を返す。編集用パスワードはクライアントへ返さない。
 * @param {{from:string, to?:string, viewKey?:string}} p 日付は YYYY-MM-DD
 */
function getSchedule(p) {
  p = p || {};
  const ctx = context_(p);
  const denied = checkView_(ctx, p.viewKey);
  if (denied) return denied;

  const from = normDate_(p.from);
  const to = normDate_(p.to || p.from);
  if (!isValidDate_(from) || !isValidDate_(to) || from > to) return fail_('日付の指定が正しくありません。');
  if (daysBetween_(from, to) >= SYSTEM.MAX_RANGE_DAYS) return fail_('一度に表示できる期間は' + SYSTEM.MAX_RANGE_DAYS + '日までです。');

  const visible = visibleIn_(ctx);
  return Object.assign({
    ok: true,
    from: from,
    to: to,
    rooms: ctx.rooms,
    reservations: readReservations_(ctx.resSheet).filter(r => r.date >= from && r.date <= to && visible(r)).map(toPublic_),
    closures: readClosures_(ctx.ss).filter(c => c.date >= from && c.date <= to && visible(c)),
    settings: publicSettings_(ctx.settings),
    serverNow: nowStr_('yyyy-MM-dd HH:mm'),
  }, limitedInfo_(ctx), ctx.isAdmin ? { openBugs: openBugCount_(ctx.ss) } : {});
}

/**
 * 予約IDを指定して取得する（「この端末の予約」一覧用）。
 * @param {{ids:string[], viewKey?:string}} p
 */
function getReservationsByIds(p) {
  p = p || {};
  const ctx = context_(p);
  const denied = checkView_(ctx, p.viewKey);
  if (denied) return denied;
  const ids = new Set((Array.isArray(p.ids) ? p.ids : []).slice(0, 300).map(String));
  const visible = visibleIn_(ctx);
  const list = readReservations_(ctx.resSheet)
    .filter(r => ids.has(r.id) && visible(r))
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
    .map(toPublic_);
  return { ok: true, reservations: list, rooms: ctx.rooms, serverNow: nowStr_('yyyy-MM-dd HH:mm') };
}

/**
 * 予約を1件登録する。ScriptLock で排他制御し、ロック取得後に重複を再照合する。
 * @param {{date, roomId, start, end, affiliation, name, memo, pin, adminPassword?, viewKey?}} p
 */
function createReservation(p) {
  p = p || {};
  const ctx = context_(p);
  const denied = checkView_(ctx, p.viewKey);
  if (denied) return denied;
  const admin = resolveAdmin_(p.adminPassword);
  if (admin.error) return fail_(admin.error);

  const v = validateBooking_(ctx, p, admin.ok);
  if (v.error) return fail_(v.error);
  const r = v.value;
  if (r.pin && !/^\d{4}$/.test(r.pin)) return fail_('編集用パスワードは4桁の数字で入力してください（設定しない場合は空欄）。');
  const ruleError = checkDateRules_(ctx, r, admin.ok) || closureError_(ctx, r);
  if (ruleError) return fail_(ruleError);

  return withLock_(() => {
    const conflict = findConflict_(readReservations_(ctx.resSheet), r, null);
    if (conflict) {
      return fail_('すでに存在する予約と時間が重複しています（' + describe_(conflict) + '）。', 'CONFLICT');
    }
    const now = nowStr_('yyyy-MM-dd HH:mm:ss');
    const created = Object.assign({}, r, { id: newId_('res'), groupId: '', createdAt: now, updatedAt: '' });
    appendRows_(ctx.resSheet, [toRow_(created)]);
    log_(ctx.ss, '予約', created, '');
    return { ok: true, reservation: toPublic_(created) };
  });
}

/**
 * 複数の日付・複数の部屋をまとめて予約する（授業の毎週予約、練習室6の全台を押さえる など）。
 * 「部屋 × 日付」のすべての組み合わせを、共通のグループIDで登録する。
 * 予約できない組み合わせがあり skipConflicts が false の場合は何も書き込まず、
 * code: 'PARTIAL_CONFLICT' と予約できない一覧を返す（画面側で「予約できる分だけ予約」を確認する）。
 * @param {{dates:string[], roomIds?:string[], roomId?:string, start, end, affiliation, name, memo, pin,
 *          adminPassword?, skipConflicts?, viewKey?}} p
 */
function createBulkReservations(p) {
  p = p || {};
  const ctx = context_(p);
  const denied = checkView_(ctx, p.viewKey);
  if (denied) return denied;
  if (!Array.isArray(p.dates) || !p.dates.length) return fail_('予約する日付が指定されていません。');
  const dates = Array.from(new Set(p.dates.map(normDate_))).sort();
  if (dates.some(d => !isValidDate_(d))) return fail_('日付の形式が正しくありません。');
  const roomIds = Array.from(new Set((Array.isArray(p.roomIds) && p.roomIds.length ? p.roomIds : [p.roomId]).map(id => String(id || '').trim())));
  const total = dates.length * roomIds.length;
  if (total > ctx.settings.maxBulkCount) {
    return fail_('まとめて予約できるのは最大' + ctx.settings.maxBulkCount + '件です（今回: ' + roomIds.length + '部屋 × ' + dates.length + '日 = ' + total + '件）。');
  }

  const admin = resolveAdmin_(p.adminPassword);
  if (admin.error) return fail_(admin.error);
  if (ctx.settings.bulkRequiresAdmin && total > 1 && !admin.ok) return fail_('くり返し予約・複数部屋の同時予約には管理用パスワードが必要です。');

  const bases = [];
  for (const roomId of roomIds) {
    const v = validateBooking_(ctx, Object.assign({}, p, { date: dates[0], roomId: roomId }), admin.ok);
    if (v.error) return fail_(v.error);
    bases.push(v.value);
  }
  if (bases[0].pin && !/^\d{4}$/.test(bases[0].pin)) return fail_('編集用パスワードは4桁の数字で入力してください（設定しない場合は空欄）。');

  return withLock_(() => {
    const rows = readReservations_(ctx.resSheet);
    const conflicts = [];
    const available = [];
    dates.forEach(date => {
      bases.forEach(base => {
        const r = Object.assign({}, base, { date: date });
        const reason = checkDateRules_(ctx, r, admin.ok) || closureError_(ctx, r);
        const conflict = reason ? null : findConflict_(rows, r, null);
        if (reason || conflict) conflicts.push({ date: date, roomId: r.roomId, reason: reason || '既存の予約と重複（' + describe_(conflict) + '）' });
        else available.push(r);
      });
    });

    if (conflicts.length && !p.skipConflicts) {
      return Object.assign(fail_('予約できない日・部屋が含まれています。', 'PARTIAL_CONFLICT'), {
        conflicts: conflicts,
        availableCount: available.length,
      });
    }
    if (!available.length) return fail_('指定したすべての日・部屋で予約できませんでした。', 'CONFLICT');

    const groupId = newId_('grp');
    const now = nowStr_('yyyy-MM-dd HH:mm:ss');
    const created = available.map(r => Object.assign({}, r, { id: newId_('res'), groupId: groupId, createdAt: now, updatedAt: '' }));
    appendRows_(ctx.resSheet, created.map(toRow_));
    log_(ctx.ss, 'まとめて予約', created[0], created.length + '件（' + roomIds.length + '部屋 × ' + dates.length + '日: ' + dates.join(', ') + '）');
    return { ok: true, groupId: groupId, reservations: created.map(toPublic_), skipped: conflicts };
  });
}

/**
 * 予約内容（日付・部屋・時間・予約者・備考）を変更する。編集用パスワードまたは管理用パスワードで認証する。
 * @param {{id, pin, date, roomId, start, end, affiliation, name, memo, viewKey?}} p
 */
function updateReservation(p) {
  p = p || {};
  const ctx = context_(p);
  const denied = checkView_(ctx, p.viewKey);
  if (denied) return denied;
  const id = String(p.id || '').trim();
  if (!id) return fail_('予約IDが指定されていません。');

  return withLock_(() => {
    const rows = readReservations_(ctx.resSheet);
    const target = rows.find(r => r.id === id);
    // 限定公開の部屋の予約は、見られない人には「存在しない」と返す
    if (!target || !visibleIn_(ctx)(target)) return fail_('この予約は既に取り消されているか、存在しません。', 'NOT_FOUND');
    const auth = checkPin_(target, p.pin, p.adminPassword);
    if (auth.error) return fail_(auth.error);
    if (!auth.admin && isPast_(target.date, target.end)) return fail_('終了した予約は変更できません。');
    if (!auth.admin && roomOf_(ctx, target.roomId).restriction === ROOM_RESTRICTIONS.ADMIN_ONLY) {
      return fail_('この部屋の予約は管理者のみ変更できます。');
    }

    const v = validateBooking_(ctx, Object.assign({}, p, { pin: target.pin }), auth.admin);
    if (v.error) return fail_(v.error);
    const r = v.value;
    const ruleError = checkDateRules_(ctx, r, auth.admin) || closureError_(ctx, r);
    if (ruleError) return fail_(ruleError);
    const conflict = findConflict_(rows, r, id);
    if (conflict) return fail_('変更後の時間帯が、すでに存在する予約と重複しています（' + describe_(conflict) + '）。', 'CONFLICT');

    const updated = Object.assign({}, target, r, {
      id: target.id, pin: target.pin, createdAt: target.createdAt, groupId: target.groupId,
      updatedAt: nowStr_('yyyy-MM-dd HH:mm:ss'),
    });
    ctx.resSheet.getRange(target.row, 1, 1, HEADERS.reservations.length).setNumberFormat('@').setValues([toRow_(updated)]);
    SpreadsheetApp.flush();
    log_(ctx.ss, auth.admin ? '変更（管理者）' : '変更', updated, '変更前: ' + target.date + ' ' + target.roomId + ' ' + describe_(target));
    return { ok: true, reservation: toPublic_(updated) };
  });
}

/**
 * 予約を取り消す（台帳から削除し、操作ログに記録する）。
 * @param {{id, pin, scope?:'single'|'following', viewKey?}} p
 *   scope 'following' … 同じくり返し予約のうち、この日以降をすべて取り消す
 */
function cancelReservation(p) {
  p = p || {};
  const ctx = context_(p);
  const denied = checkView_(ctx, p.viewKey);
  if (denied) return denied;
  const id = String(p.id || '').trim();
  if (!id) return fail_('予約IDが指定されていません。');

  return withLock_(() => {
    const rows = readReservations_(ctx.resSheet);
    const target = rows.find(r => r.id === id);
    // 限定公開の部屋の予約は、見られない人には「存在しない」と返す
    if (!target || !visibleIn_(ctx)(target)) return fail_('この予約は既に取り消されているか、存在しません。', 'NOT_FOUND');
    const auth = checkPin_(target, p.pin, p.adminPassword);
    if (auth.error) return fail_(auth.error);
    if (!auth.admin && roomOf_(ctx, target.roomId).restriction === ROOM_RESTRICTIONS.ADMIN_ONLY) {
      return fail_('この部屋の予約は管理者のみ取り消せます。');
    }

    const targets = p.scope === 'following' && target.groupId
      ? rows.filter(r => r.groupId === target.groupId && r.date >= target.date)
      : [target];
    // 下の行から削除して行番号のずれを防ぐ
    targets.map(r => r.row).sort((a, b) => b - a).forEach(row => ctx.resSheet.deleteRow(row));
    SpreadsheetApp.flush();
    log_(ctx.ss, auth.admin ? '取消（管理者）' : '取消', target,
      targets.length > 1 ? targets.length + '件（' + targets.map(t => t.date).join(', ') + '）' : '');
    return { ok: true, cancelledIds: targets.map(r => r.id) };
  });
}

/**
 * 不具合報告を受け付けて「不具合報告」シートに記録する。画像の添付は受け付けない。
 * 閲覧パスワードが設定されていても送れるようにし、代わりに全体の送信数を制限する。
 * @param {{message:string, contact?:string, env?:Object}} p
 */
function submitBugReport(p) {
  p = p || {};
  const message = String(p.message || '').trim();
  const contact = String(p.contact || '').trim();
  if (!message) return fail_('不具合の内容を入力してください。');
  if (message.length > 2000) return fail_('内容は2000文字以内で入力してください。');
  if (contact.length > 100) return fail_('連絡先は100文字以内で入力してください。');

  const cache = CacheService.getScriptCache();
  const count = Number(cache.get('bugreports') || 0);
  if (count >= 30) return fail_('現在、報告が集中しています。しばらくしてから再度お試しください。');
  cache.put('bugreports', String(count + 1), 600);

  const env = p.env && typeof p.env === 'object' ? p.env : {};
  const text = (v, max) => {
    const t = String(v == null ? '' : v).slice(0, max);
    return /^[=+\-@]/.test(t) ? ' ' + t : t; // 数式として解釈されないように
  };
  const id = newId_('bug');
  const row = [
    id,
    nowStr_('yyyy-MM-dd HH:mm:ss'),
    BUG_STATUSES[0],
    text(message, 2000),
    text(contact, 100),
    text(env.userAgent, 400),
    text(env.screen, 100),
    text(env.page, 200),
    text(JSON.stringify(env), 3000),
  ];
  return withLock_(() => {
    const ss = getSpreadsheet_();
    const sheet = ensureSheet_(ss, SHEETS.bugs, HEADERS.bugs);
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setNumberFormat('@').setValues([row]);
    SpreadsheetApp.flush();
    return { ok: true, id: id };
  });
}

// ---------------------------------------------------------------------------
// 管理画面API（すべて管理用パスワード adminPassword が必要）
// ---------------------------------------------------------------------------

const UNIT_OPTIONS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60];

/** 管理画面の初期表示用に、設定・部屋・休館情報をまとめて返す（ログイン確認を兼ねる）。 */
function adminGetData(p) {
  const denied = requireAdmin_(p);
  if (denied) return denied;
  const ss = getSpreadsheet_();
  return {
    ok: true,
    settings: loadSettings_(ss),
    rooms: readRooms_(ss),
    closures: readClosures_(ss),
    unitOptions: UNIT_OPTIONS,
    today: nowStr_('yyyy-MM-dd'),
    spreadsheetUrl: ss.getUrl(), // 管理画面の「スプレッドシートを開く」用（開けるのは共有されている人だけ）
    openBugs: openBugCount_(ss),
  };
}

/** まだ片付いていない不具合報告（未対応・対応中）の件数（管理画面・管理者モードのバッジ用） */
function openBugCount_(ss) {
  const sheet = ss.getSheetByName(SHEETS.bugs);
  if (!sheet) return 0;
  const closed = [BUG_STATUSES[2], BUG_STATUSES[3]]; // 対応済み・対応しない
  return readTable_(sheet, 3).filter(r => r[0].trim() && closed.indexOf(r[2] || BUG_STATUSES[0]) < 0).length;
}

/**
 * 「設定」シートを更新する。
 * @param {{adminPassword, settings:{title, notice, openTime, closeTime, unitMinutes, maxDurationMinutes,
 *          maxDaysAhead, closedWeekdays:number[], maxBulkCount, bulkRequiresAdmin:boolean, viewPassword}}} p
 */
function adminSaveSettings(p) {
  const denied = requireAdmin_(p);
  if (denied) return denied;
  const v = validateSettings_(p.settings || {});
  if (v.error) return fail_(v.error);

  return withLock_(() => {
    const ss = getSpreadsheet_();
    const sheet = ensureSheet_(ss, SHEETS.settings, HEADERS.settings);
    sheet.getRange('B:B').setNumberFormat('@');
    const labels = readTable_(sheet, 1).map(r => r[0].trim());
    SETTINGS.forEach(def => {
      const idx = [def.label].concat(def.aliases || []).map(l => labels.indexOf(l)).find(i => i >= 0);
      if (idx !== undefined) {
        // 旧い項目名の行は新しい項目名に書き換える
        sheet.getRange(idx + 2, 1, 1, 3).setValues([[def.label, v.value[def.key], def.desc]]);
      } else {
        sheet.getRange(sheet.getLastRow() + 1, 1, 1, 3).setValues([[def.label, v.value[def.key], def.desc]]);
        labels.push(def.label);
      }
    });
    SpreadsheetApp.flush();
    const settings = loadSettings_(ss);
    logAdmin_(ss, '設定変更', SETTINGS.filter(d => SECRET_SETTINGS.indexOf(d.key) < 0).map(d => d.label + '=' + v.value[d.key]).join(' / '));
    return { ok: true, settings: settings, warnings: settingsWarnings_(ss, settings) };
  });
}

/**
 * 部屋マスタを丸ごと置き換える（並び順 = 配列の順）。id が空の部屋は新規追加として部屋IDを自動で振る。
 * 今日以降の予約が残っている部屋は削除できない。
 * @param {{adminPassword, rooms:{id?, name, equipment, restriction, note}[]}} p
 */
function adminSaveRooms(p) {
  const denied = requireAdmin_(p);
  if (denied) return denied;
  const input = Array.isArray(p.rooms) ? p.rooms : [];
  if (!input.length) return fail_('部屋を1つ以上登録してください。');
  if (input.length > 200) return fail_('登録できる部屋は200室までです。');

  const rooms = [];
  for (let i = 0; i < input.length; i++) {
    const r = input[i] || {};
    const room = {
      id: String(r.id || '').trim(),
      name: String(r.name || '').trim(),
      equipment: String(r.equipment || '').trim(),
      restriction: String(r.restriction || '').trim(),
      note: String(r.note || '').trim(),
      tags: String(r.tags || '').trim(),
    };
    const label = (i + 1) + '行目';
    if (!room.name || room.name.length > 30) return fail_(label + ': 部屋名を30文字以内で入力してください。');
    if (room.equipment.length > 20) return fail_(label + ': 設備区分は20文字以内で入力してください。');
    if (room.note.length > 100) return fail_(label + ': 備考は100文字以内で入力してください。');
    if (room.tags.length > 30) return fail_(label + ': 特徴タグは30文字以内で入力してください。');
    if (['', ROOM_RESTRICTIONS.ADMIN_ONLY, ROOM_RESTRICTIONS.STOPPED, ROOM_RESTRICTIONS.LIMITED].indexOf(room.restriction) < 0) {
      return fail_(label + ': 予約制限の値が正しくありません。');
    }
    if ([room.name, room.equipment, room.note, room.tags].some(t => /^[=+\-@]/.test(t))) {
      return fail_(label + ': 先頭に「= + - @」は使用できません。');
    }
    rooms.push(room);
  }

  return withLock_(() => {
    const ss = getSpreadsheet_();
    const current = readRooms_(ss);
    const currentIds = new Set(current.map(r => r.id));
    const seen = new Set();
    for (const r of rooms) {
      if (!r.id) continue;
      if (!currentIds.has(r.id)) return fail_('部屋ID「' + r.id + '」が見つかりません。画面を再読み込みしてやり直してください。');
      if (seen.has(r.id)) return fail_('部屋ID「' + r.id + '」が重複しています。');
      seen.add(r.id);
    }

    const today = nowStr_('yyyy-MM-dd');
    const reservations = readReservations_(getSheet_(ss, SHEETS.reservations));
    const removed = current.filter(r => !seen.has(r.id));
    for (const r of removed) {
      const n = reservations.filter(x => x.roomId === r.id && x.date >= today).length;
      if (n) {
        return fail_('「' + r.name + '」には今日以降の予約が' + n + '件あるため削除できません。' +
          '先に予約を取り消すか、予約制限を「使用停止」にしてください。', 'ROOM_IN_USE');
      }
    }

    // 新しい部屋ID: 過去の予約・休館データで使われたことのない番号を振る（古い予約が新しい部屋に紐づかないように）
    const used = new Set(current.map(r => r.id).concat(reservations.map(r => r.roomId), readClosures_(ss).map(c => c.roomId)));
    let n = 1;
    rooms.forEach(r => {
      if (r.id) return;
      while (used.has('room_' + pad2_(n))) n++;
      r.id = 'room_' + pad2_(n);
      used.add(r.id);
    });

    const sheet = getSheet_(ss, SHEETS.rooms);
    const last = sheet.getLastRow();
    if (last >= 2) sheet.getRange(2, 1, last - 1, HEADERS.rooms.length).clearContent();
    sheet.getRange(2, 1, rooms.length, HEADERS.rooms.length).setNumberFormat('@')
      .setValues(rooms.map((r, i) => [String(i + 1), r.id, r.name, r.equipment, r.restriction, r.note, r.tags]));
    SpreadsheetApp.flush();

    const added = rooms.filter(r => !currentIds.has(r.id)).map(r => r.name);
    logAdmin_(ss, '部屋変更', '全' + rooms.length + '室' +
      (added.length ? ' / 追加: ' + added.join('、') : '') +
      (removed.length ? ' / 削除: ' + removed.map(r => r.name).join('、') : ''));
    return { ok: true, rooms: readRooms_(ss) };
  });
}

/**
 * 「休館・利用停止」シートを丸ごと置き換える。重なる予約は自動では取り消さず、件数を warnings で返す。
 * @param {{adminPassword, closures:{date, roomId, allDay, start, end, reason}[]}} p
 */
function adminSaveClosures(p) {
  const denied = requireAdmin_(p);
  if (denied) return denied;
  const input = Array.isArray(p.closures) ? p.closures : [];
  const ss = getSpreadsheet_();
  const roomIds = new Set(readRooms_(ss).map(r => r.id));

  const closures = [];
  for (let i = 0; i < input.length; i++) {
    const c = input[i] || {};
    const item = {
      date: normDate_(c.date),
      roomId: String(c.roomId || '').trim(),
      allDay: !!c.allDay,
      start: c.allDay ? '' : normTime_(c.start),
      end: c.allDay ? '' : normTime_(c.end),
      reason: String(c.reason || '').trim(),
    };
    const label = (item.date || (i + 1) + '件目') + ': ';
    if (!isValidDate_(item.date)) return fail_(label + '日付が正しくありません。');
    if (item.roomId && !roomIds.has(item.roomId)) return fail_(label + '部屋が見つかりません。');
    if (!item.allDay && (!isTime_(item.start) || !isTime_(item.end) || toMin_(item.start) >= toMin_(item.end))) {
      return fail_(label + '時間帯が正しくありません（終了は開始より後にしてください）。');
    }
    if (item.reason.length > 50) return fail_(label + '理由は50文字以内で入力してください。');
    if (/^[=+\-@]/.test(item.reason)) return fail_(label + '理由の先頭に「= + - @」は使用できません。');
    closures.push(item);
  }
  closures.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));

  return withLock_(() => {
    const sheet = ensureSheet_(ss, SHEETS.closures, HEADERS.closures);
    const last = sheet.getLastRow();
    if (last >= 2) sheet.getRange(2, 1, last - 1, HEADERS.closures.length).clearContent();
    if (closures.length) {
      sheet.getRange(2, 1, closures.length, HEADERS.closures.length).setNumberFormat('@')
        .setValues(closures.map(c => [c.date, c.roomId, c.start, c.end, c.reason]));
    }
    SpreadsheetApp.flush();
    logAdmin_(ss, '休館・利用停止の変更', closures.length + '件');

    // 今日以降の休館と重なっている予約を知らせる
    const today = nowStr_('yyyy-MM-dd');
    const rooms = readRooms_(ss);
    const settings = loadSettings_(ss);
    const ctx = { ss: ss, closures: readClosures_(ss), settings: settings };
    const overlaps = readReservations_(getSheet_(ss, SHEETS.reservations))
      .filter(r => r.date >= today && closureError_(ctx, r))
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    const warnings = overlaps.length ? ['休館・利用停止と重なる予約が' + overlaps.length + '件あります（自動では取り消されません）:'].concat(
      overlaps.slice(0, 20).map(r => r.date + ' ' + ((rooms.find(x => x.id === r.roomId) || {}).name || r.roomId) + ' ' + describe_(r))) : [];
    return { ok: true, closures: ctx.closures, warnings: warnings };
  });
}

/** 不具合報告の一覧（新しい順、最大200件）。 */
function adminGetBugReports(p) {
  const denied = requireAdmin_(p);
  if (denied) return denied;
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.bugs);
  const rows = sheet ? readTable_(sheet, HEADERS.bugs.length) : [];
  const reports = rows.filter(r => r[0].trim()).map(r => ({
    id: r[0].trim(), receivedAt: r[1], status: r[2] || BUG_STATUSES[0], message: r[3], contact: r[4],
    userAgent: r[5], screen: r[6], page: r[7], env: r[8],
  })).reverse().slice(0, 200);
  return { ok: true, reports: reports, statuses: BUG_STATUSES };
}

/** 不具合報告の状態（未対応・対応中・対応済み など）を変更する。 */
function adminSetBugStatus(p) {
  const denied = requireAdmin_(p);
  if (denied) return denied;
  const id = String(p.id || '');
  const status = String(p.status || '');
  if (BUG_STATUSES.indexOf(status) < 0) return fail_('状態の値が正しくありません。');
  return withLock_(() => {
    const sheet = getSpreadsheet_().getSheetByName(SHEETS.bugs);
    const rows = sheet ? readTable_(sheet, 1) : [];
    const idx = rows.findIndex(r => r[0].trim() === id);
    if (idx < 0) return fail_('報告が見つかりません。');
    sheet.getRange(idx + 2, 3, 1, 1).setValues([[status]]);
    SpreadsheetApp.flush();
    return { ok: true };
  });
}

/** 管理用パスワードを変更する（引き継ぎ時など）。 */
function adminChangePassword(p) {
  const denied = requireAdmin_(p);
  if (denied) return denied;
  const next = String(p.newPassword || '');
  if (next.length < 6) return fail_('新しいパスワードは6文字以上にしてください。');
  PropertiesService.getScriptProperties().setProperty('ADMIN_PASSWORD', next);
  logAdmin_(getSpreadsheet_(), '管理用パスワード変更', '');
  return { ok: true };
}

function requireAdmin_(p) {
  const error = verifyAdmin_(p && p.adminPassword);
  return error ? fail_(error, 'ADMIN_AUTH') : null;
}

function validateSettings_(s) {
  const title = String(s.title || '').trim();
  const notice = String(s.notice || '').trim().replace(/\s+/g, ' ');
  const noticeLevel = s.noticeLevel === '重要' ? '重要' : '通常';
  const open = normTime_(s.openTime);
  const close = normTime_(s.closeTime);
  const unit = Number(s.unitMinutes);
  const int = (v, min, max) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  const maxDuration = int(s.maxDurationMinutes, 0, 24 * 60);
  const maxDays = int(s.maxDaysAhead, 0, 730);
  const maxBulk = int(s.maxBulkCount, 1, 300);
  const weekdays = (Array.isArray(s.closedWeekdays) ? s.closedWeekdays : []).map(Number).filter(n => n >= 0 && n <= 6);
  const viewPassword = String(s.viewPassword || '').trim();
  const limitedPassword = String(s.limitedPassword || '').trim();

  if (!title || title.length > 40) return { error: 'タイトルを40文字以内で入力してください。' };
  if (notice.length > 200) return { error: 'お知らせは200文字以内で入力してください。' };
  if ([title, notice, viewPassword, limitedPassword].some(t => /^[=+\-@]/.test(t))) return { error: '先頭に「= + - @」は使用できません。' };
  if (UNIT_OPTIONS.indexOf(unit) < 0) return { error: '予約単位は ' + UNIT_OPTIONS.join(', ') + ' 分のいずれかにしてください。' };
  if (!isTime_(open) || !isTime_(close) || toMin_(open) >= toMin_(close)) return { error: '利用終了時刻は利用開始時刻より後にしてください。' };
  if (toMin_(open) % unit || toMin_(close) % unit) return { error: '利用開始・終了時刻は予約単位（' + unit + '分）の区切りにしてください。' };
  if (maxDuration === null) return { error: '最大予約時間は0〜1440分の整数で入力してください。' };
  if (maxDuration && maxDuration % unit) return { error: '最大予約時間は予約単位（' + unit + '分）の倍数にしてください。' };
  if (maxDays === null) return { error: '予約受付期間は0〜730日の整数で入力してください。' };
  if (maxBulk === null) return { error: 'まとめて予約の最大件数は1〜300の整数で入力してください。' };
  if (viewPassword.length > 50) return { error: '閲覧パスワードは50文字以内で入力してください。' };
  if (limitedPassword && (limitedPassword.length < 6 || limitedPassword.length > 50)) return { error: '限定公開の部屋のパスワードは6〜50文字で入力してください。' };

  return {
    value: {
      title: title,
      notice: notice,
      noticeLevel: noticeLevel,
      openTime: open,
      closeTime: close,
      unitMinutes: String(unit),
      maxDurationMinutes: String(maxDuration),
      maxDaysAhead: String(maxDays),
      closedWeekdays: Array.from(new Set(weekdays)).sort().map(i => WEEKDAYS[i]).join(','),
      maxBulkCount: String(maxBulk),
      bulkRequiresAdmin: s.bulkRequiresAdmin ? 'はい' : 'いいえ',
      viewPassword: viewPassword,
      limitedPassword: limitedPassword,
    },
  };
}

/** 新しい設定に合わなくなった「今日以降の予約」を知らせる（予約は自動では消さない）。 */
function settingsWarnings_(ss, settings) {
  const today = nowStr_('yyyy-MM-dd');
  const open = toMin_(settings.openTime);
  const close = toMin_(settings.closeTime);
  const future = readReservations_(getSheet_(ss, SHEETS.reservations)).filter(r => r.date >= today);
  const outside = future.filter(r => toMin_(r.start) < open || toMin_(r.end) > close).length;
  const holiday = future.filter(r => settings.closedWeekdays.indexOf(weekday_(r.date)) >= 0).length;
  const warnings = [];
  if (outside) warnings.push('新しい利用時間の外にかかる予約が' + outside + '件あります（自動では取り消されません）。');
  if (holiday) warnings.push('定休日に入っている予約が' + holiday + '件あります（自動では取り消されません）。');
  return warnings;
}

function logAdmin_(ss, action, detail) {
  try {
    const sheet = ss.getSheetByName(SHEETS.log) || ensureSheet_(ss, SHEETS.log, HEADERS.log);
    const row = [nowStr_('yyyy-MM-dd HH:mm:ss'), action, '', '', '', '', '管理者', detail];
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setNumberFormat('@').setValues([row]);
  } catch (e) {
    console.error(e);
  }
}

// ---------------------------------------------------------------------------
// 管理者用メニュー（スプレッドシート上で使用）
// ---------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('予約システム')
    .addItem('初期セットアップ', 'setup')
    .addItem('前年度の予約をアーカイブ', 'archivePreviousFiscalYear')
    .addSeparator()
    .addItem('管理用パスワードを設定', 'setAdminPassword')
    .addToUi();
}

/** シートの作成・見出し・書式設定を行う。既存データは消さない（何度実行しても安全）。 */
function setup() {
  const ss = getSpreadsheet_();
  ss.setSpreadsheetTimeZone(SYSTEM.TIMEZONE);

  const resSheet = ensureSheet_(ss, SHEETS.reservations, HEADERS.reservations);
  resSheet.getRange('A:L').setNumberFormat('@');
  // 列名を整理した版に合わせて、台帳とアーカイブの見出しを書き換える（列の位置は同じなのでデータはそのまま）
  ss.getSheets()
    .filter(sh => sh.getName() === SHEETS.reservations || sh.getName().indexOf(SHEETS.reservations + '_') === 0)
    .forEach(sh => sh.getRange(1, 1, 1, HEADERS.reservations.length).setValues([HEADERS.reservations]).setFontWeight('bold'));

  const rooms = ensureSheet_(ss, SHEETS.rooms, HEADERS.rooms);
  rooms.getRange('B:G').setNumberFormat('@');
  if (rooms.getLastRow() < 2) {
    const data = defaultRooms_();
    rooms.getRange(2, 1, data.length, HEADERS.rooms.length).setValues(data);
  }
  setValidation_(rooms.getRange('E2:E500'), ['', ROOM_RESTRICTIONS.ADMIN_ONLY, ROOM_RESTRICTIONS.STOPPED, ROOM_RESTRICTIONS.LIMITED]);

  ensureSheet_(ss, SHEETS.closures, HEADERS.closures).getRange('A:E').setNumberFormat('@');

  const settings = ensureSheet_(ss, SHEETS.settings, HEADERS.settings);
  settings.getRange('B:B').setNumberFormat('@');
  const existing = settings.getLastRow() >= 2
    ? settings.getRange(2, 1, settings.getLastRow() - 1, 1).getDisplayValues().map(r => r[0].trim())
    : [];
  const missing = SETTINGS.filter(s => [s.label].concat(s.aliases || []).every(l => existing.indexOf(l) < 0))
    .map(s => [s.label, s.def, s.desc]);
  if (missing.length) settings.getRange(settings.getLastRow() + 1, 1, missing.length, 3).setValues(missing);
  settings.setColumnWidth(1, 220).setColumnWidth(2, 160).setColumnWidth(3, 480);

  ensureSheet_(ss, SHEETS.log, HEADERS.log);
  ensureSheet_(ss, SHEETS.bugs, HEADERS.bugs).getRange('A:I').setNumberFormat('@');

  const blank = ss.getSheetByName('シート1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);

  alert_('セットアップが完了しました。\n「部屋マスタ」「設定」シートの内容を確認・編集してください。');
}

/**
 * 今年度（4月始まり）より前の予約を「予約台帳_YYYY年度」シートへ移動する。
 * 今年度以降の予約（年度をまたいで先に入っている予約）は台帳に残る。
 */
function archivePreviousFiscalYear() {
  const ss = getSpreadsheet_();
  const sheet = getSheet_(ss, SHEETS.reservations);
  const now = new Date();
  const year = Number(Utilities.formatDate(now, SYSTEM.TIMEZONE, 'yyyy'));
  const month = Number(Utilities.formatDate(now, SYSTEM.TIMEZONE, 'M'));
  const fiscalYear = month >= 4 ? year : year - 1;
  const cutoff = fiscalYear + '-04-01';
  const archiveName = '予約台帳_' + (fiscalYear - 1) + '年度';
  const width = HEADERS.reservations.length;

  if (!confirm_(cutoff + ' より前の予約を「' + archiveName + '」シートへ移動します。よろしいですか？')) return;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    alert_('他の処理が実行中です。少し待ってから再度実行してください。');
    return;
  }
  try {
    const last = sheet.getLastRow();
    const values = last >= 2 ? sheet.getRange(2, 1, last - 1, width).getDisplayValues() : [];
    const rows = values.filter(r => String(r[0]).trim());
    const old = rows.filter(r => normDate_(r[1]) < cutoff);
    const keep = rows.filter(r => !(normDate_(r[1]) < cutoff));
    if (!old.length) {
      alert_('アーカイブ対象（' + cutoff + ' より前）の予約はありません。');
      return;
    }
    const archive = ensureSheet_(ss, archiveName, HEADERS.reservations);
    archive.getRange(archive.getLastRow() + 1, 1, old.length, width).setNumberFormat('@').setValues(old);
    sheet.getRange(2, 1, values.length, width).clearContent();
    if (keep.length) sheet.getRange(2, 1, keep.length, width).setNumberFormat('@').setValues(keep);
    SpreadsheetApp.flush();
    alert_(old.length + ' 件を「' + archiveName + '」へ移動しました（台帳に残った予約: ' + keep.length + ' 件）。');
  } finally {
    lock.releaseLock();
  }
}

function setAdminPassword() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('管理用パスワードの設定',
    'どの予約でも変更・取消できるパスワードを入力してください（6文字以上）。\n空欄でOKを押すと無効化します。',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const value = res.getResponseText().trim();
  const props = PropertiesService.getScriptProperties();
  if (!value) {
    props.deleteProperty('ADMIN_PASSWORD');
    ui.alert('管理用パスワードを無効化しました。');
    return;
  }
  if (value.length < 6) {
    ui.alert('6文字以上で設定してください。');
    return;
  }
  props.setProperty('ADMIN_PASSWORD', value);
  ui.alert('管理用パスワードを設定しました。');
}

// ---------------------------------------------------------------------------
// 検証・照合
// ---------------------------------------------------------------------------

/**
 * 処理に必要なデータをまとめて読む。p を渡すと、限定公開の部屋を見られるかを判定し、
 * 見られない場合は rooms から除く（以降の処理では「存在しない部屋」として扱われる）。
 */
function context_(p) {
  const ss = getSpreadsheet_();
  const settings = loadSettings_(ss);
  const allRooms = readRooms_(ss);
  const isAdmin = !!(p && p.adminPassword) && !verifyAdmin_(p.adminPassword);
  const limited = limitedAccess_(settings, p || {}, isAdmin);
  const rooms = limited.ok ? allRooms : allRooms.filter(r => r.restriction !== ROOM_RESTRICTIONS.LIMITED);
  return {
    ss: ss,
    settings: settings,
    rooms: rooms,
    limited: limited,
    isAdmin: isAdmin,
    resSheet: getSheet_(ss, SHEETS.reservations),
  };
}

/** 限定公開の部屋を見られるか。{ok} / {ok:false, denied:true}（パスワードが違う） */
function limitedAccess_(settings, p, isAdmin) {
  const pw = settings.limitedPassword;
  const key = String(p.limitedKey || '');
  if (key) {
    const cache = CacheService.getScriptCache();
    const failures = Number(cache.get('limitedFailures') || 0);
    if (pw && failures < SYSTEM.MAX_LIMITED_FAILURES && key === pw) return { ok: true };
    cache.put('limitedFailures', String(failures + 1), SYSTEM.FAILURE_LOCK_SECONDS); // 総当たり対策
  }
  if (isAdmin) return { ok: true };
  return key ? { ok: false, denied: true } : { ok: false };
}

/** 見えている部屋の予約・休館だけに絞る */
function visibleIn_(ctx) {
  const ids = new Set(ctx.rooms.map(r => r.id));
  return x => !x.roomId || ids.has(x.roomId);
}

/** 画面に返す、限定公開の状態（パスワードを入れていない人には何も返さない） */
function limitedInfo_(ctx) {
  if (ctx.limited.ok) return { limitedAccess: true };
  if (ctx.limited.denied) return { limitedDenied: true };
  return {};
}

function checkView_(ctx, viewKey) {
  const pw = ctx.settings.viewPassword;
  if (!pw || String(viewKey || '') === pw) return null;
  return fail_(viewKey ? '閲覧パスワードが違います。' : '閲覧パスワードを入力してください。', 'AUTH_REQUIRED');
}

/** 管理用パスワードが指定されていれば照合する。{ok:true} / {ok:false} / {error} */
function resolveAdmin_(password) {
  if (!password) return { ok: false };
  const error = verifyAdmin_(password);
  return error ? { error: error } : { ok: true };
}

/** 管理用パスワードを照合する。一致すれば null、不一致ならエラーメッセージ。総当たり対策付き。 */
function verifyAdmin_(password) {
  const adminPassword = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  if (!adminPassword) return '管理用パスワードが設定されていません。管理者に連絡してください。';
  const cache = CacheService.getScriptCache();
  const failures = Number(cache.get('adminfail') || 0);
  if (failures >= SYSTEM.MAX_PIN_FAILURES * 2) {
    return '管理用パスワードの誤入力が続いたため、一時的に利用できません。10分ほど待ってから再度お試しください。';
  }
  if (String(password) !== adminPassword) {
    cache.put('adminfail', String(failures + 1), SYSTEM.FAILURE_LOCK_SECONDS);
    return '管理用パスワードが一致しません。';
  }
  return null;
}

/**
 * 予約を変更・取消してよいか確認する。{admin:boolean} / {error}
 * - adminPassword（管理者モード）または編集用パスワード欄の管理用パスワード → 管理者として常に許可
 * - 編集用パスワードが設定されていない予約 → 誰でも許可
 * - 編集用パスワードが設定されている予約 → 一致すれば許可（連続誤入力で一時ロック）
 */
function checkPin_(target, pin, adminPassword) {
  if (adminPassword) {
    const error = verifyAdmin_(adminPassword);
    return error ? { error: error } : { admin: true };
  }
  const code = String(pin || '').trim();
  const stored = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  if (code && stored && code === stored) return { admin: true };
  if (!target.pin) return { admin: false };
  if (!code) return { error: 'この予約には編集用パスワードが設定されています。編集用パスワードを入力してください。' };

  const cache = CacheService.getScriptCache();
  const failKey = 'pinfail_' + target.id;
  const failures = Number(cache.get(failKey) || 0);
  if (failures >= SYSTEM.MAX_PIN_FAILURES) {
    return { error: '編集用パスワードの誤入力が続いたため、この予約は一時的に操作できません。10分ほど待ってから再度お試しください。' };
  }
  if (code === target.pin) {
    cache.remove(failKey);
    return { admin: false };
  }
  cache.put(failKey, String(failures + 1), SYSTEM.FAILURE_LOCK_SECONDS);
  return { error: '編集用パスワードが一致しません。' };
}

/** 予約内容の形式チェックと部屋の予約制限。{value} / {error} */
function validateBooking_(ctx, input, isAdmin) {
  const s = ctx.settings;
  const value = {
    date: normDate_(input.date),
    roomId: String(input.roomId || '').trim(),
    start: normTime_(input.start),
    end: normTime_(input.end),
    affiliation: String(input.affiliation || '').trim(),
    name: String(input.name || '').trim(),
    memo: String(input.memo || '').trim().replace(/\s+/g, ' '),
    pin: String(input.pin || '').trim(),
  };
  if (!isValidDate_(value.date)) return { error: '日付の形式が正しくありません。' };

  const room = roomOf_(ctx, value.roomId);
  if (!room.id) return { error: '指定された部屋が存在しません。' };
  if (room.restriction === ROOM_RESTRICTIONS.STOPPED) return { error: room.name + ' は現在使用停止中です。' };
  if (room.restriction === ROOM_RESTRICTIONS.ADMIN_ONLY && !isAdmin) {
    return { error: room.name + ' は管理者のみ予約できます（管理用パスワードが必要です）。' };
  }

  const st = toMin_(value.start);
  const en = toMin_(value.end);
  if (!isTime_(value.start) || !isTime_(value.end)) return { error: '時刻の指定が正しくありません。' };
  if (st % s.unitMinutes || en % s.unitMinutes) return { error: '時刻は' + s.unitMinutes + '分単位で指定してください。' };
  if (st < toMin_(s.openTime) || en > toMin_(s.closeTime) || st >= en) {
    return { error: '利用可能時間（' + s.openTime + '〜' + s.closeTime + '）の範囲で、終了を開始より後にしてください。' };
  }
  if (!isAdmin && s.maxDurationMinutes && en - st > s.maxDurationMinutes) {
    return { error: '1回に予約できるのは' + durationText_(s.maxDurationMinutes) + 'までです。' };
  }
  // 学籍番号/所属は任意（団体名・授業名だけでの予約を認める）
  if (value.affiliation.length > SYSTEM.MAX_AFFILIATION_LENGTH) {
    return { error: '学籍番号/所属は' + SYSTEM.MAX_AFFILIATION_LENGTH + '文字以内で入力してください。' };
  }
  if (!value.name || value.name.length > SYSTEM.MAX_NAME_LENGTH) {
    return { error: '氏名／団体名を' + SYSTEM.MAX_NAME_LENGTH + '文字以内で入力してください。' };
  }
  if (value.memo.length > SYSTEM.MAX_MEMO_LENGTH) return { error: '備考は' + SYSTEM.MAX_MEMO_LENGTH + '文字以内で入力してください。' };
  // スプレッドシートで数式として解釈される先頭文字を拒否（数式インジェクション対策）
  if ([value.affiliation, value.name, value.memo].some(t => /^[=+\-@]/.test(t))) {
    return { error: '学籍番号/所属・氏名・備考の先頭に「= + - @」は使用できません。' };
  }
  return { value: value };
}

/** 過去・受付期間・定休日のチェック。問題があればメッセージを返す。 */
function checkDateRules_(ctx, r, isAdmin) {
  const s = ctx.settings;
  if (isPast_(r.date, r.end)) return '過去の時間帯は予約できません。';
  if (s.closedWeekdays.indexOf(weekday_(r.date)) >= 0) return '定休日（' + WEEKDAYS[weekday_(r.date)] + '曜日）のため予約できません。';
  if (!isAdmin && s.maxDaysAhead && r.date > addDays_(nowStr_('yyyy-MM-dd'), s.maxDaysAhead)) {
    return '予約できるのは' + s.maxDaysAhead + '日先までです。';
  }
  return null;
}

function closureError_(ctx, r) {
  const s = toMin_(r.start);
  const e = toMin_(r.end);
  if (!ctx.closures) ctx.closures = readClosures_(ctx.ss); // くり返し予約で何度も読まないようにキャッシュ
  const hit = ctx.closures.find(c =>
    c.date === r.date && (!c.roomId || c.roomId === r.roomId) &&
    (c.allDay || (toMin_(c.start) < e && s < toMin_(c.end))));
  if (!hit) return null;
  return (hit.allDay ? '終日' : hm_(hit.start) + '〜' + hm_(hit.end) + ' は') + '利用できません' + (hit.reason ? '（' + hit.reason + '）' : '') + '。';
}

function findConflict_(rows, r, excludeId) {
  const s = toMin_(r.start);
  const e = toMin_(r.end);
  return rows.find(x => x.id !== excludeId && x.date === r.date && x.roomId === r.roomId &&
    toMin_(x.start) < e && s < toMin_(x.end)) || null;
}

function describe_(r) {
  return hm_(r.start) + '〜' + hm_(r.end) + ' ' + (r.affiliation ? r.affiliation + ' ' : '') + r.name;
}

// ---------------------------------------------------------------------------
// シート読み書き
// ---------------------------------------------------------------------------

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet_(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('シート「' + name + '」が見つかりません。管理者はメニュー「予約システム > 初期セットアップ」を実行してください。');
  return sheet;
}

/** シートが無ければ作成し、見出しが空の列だけ補う（旧バージョンの台帳への列追加にも対応）。 */
function ensureSheet_(ss, name, headers) {
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  const current = sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
  if (current.some((v, i) => !String(v).trim())) {
    const merged = current.map((v, i) => String(v).trim() || headers[i]);
    sheet.getRange(1, 1, 1, headers.length).setValues([merged]).setFontWeight('bold').setBackground('#eef2f7');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function setValidation_(range, values) {
  try {
    range.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(true).build());
  } catch (e) {
    // 入力規則は補助機能なので、設定できなくても続行する
  }
}

function readTable_(sheet, width) {
  const last = sheet.getLastRow();
  return last < 2 ? [] : sheet.getRange(2, 1, last - 1, width).getDisplayValues();
}

function readRooms_(ss) {
  return readTable_(getSheet_(ss, SHEETS.rooms), HEADERS.rooms.length)
    .map(r => ({
      order: Number(r[0]) || 9999,
      id: r[1].trim(),
      name: r[2].trim() || r[1].trim(),
      equipment: r[3].trim(),
      restriction: r[4].trim(),
      note: r[5].trim(),
      tags: r[6].trim(),
    }))
    .filter(r => r.id)
    .sort((a, b) => a.order - b.order);
}

function roomOf_(ctx, roomId) {
  return ctx.rooms.find(r => r.id === roomId) || {};
}

/** 台帳を読み込む。手入力でセルが日付・時刻・数値に変換されていても正規化して扱う。 */
function readReservations_(sheet) {
  return readTable_(sheet, HEADERS.reservations.length)
    .map((r, i) => ({
      row: i + 2,
      id: r[0].trim(),
      date: normDate_(r[1]),
      roomId: r[2].trim(),
      start: normTime_(r[3]),
      end: normTime_(r[4]),
      affiliation: r[5].trim(),
      name: r[6].trim(),
      pin: normPin_(r[7]),
      createdAt: r[8].trim(),
      groupId: r[9].trim(),
      memo: r[10].trim(),
      updatedAt: r[11].trim(),
    }))
    .filter(r => r.id);
}

function readClosures_(ss) {
  const sheet = ss.getSheetByName(SHEETS.closures);
  if (!sheet) return [];
  return readTable_(sheet, HEADERS.closures.length)
    .map(r => {
      const start = normTime_(r[2]);
      const end = normTime_(r[3]);
      const allDay = !isTime_(start) || !isTime_(end) || toMin_(start) >= toMin_(end);
      return { date: normDate_(r[0]), roomId: r[1].trim(), allDay: allDay, start: allDay ? '' : start, end: allDay ? '' : end, reason: r[4].trim() };
    })
    .filter(c => isValidDate_(c.date));
}

function loadSettings_(ss) {
  const raw = {};
  const sheet = ss.getSheetByName(SHEETS.settings);
  if (sheet) readTable_(sheet, 2).forEach(r => { raw[r[0].trim()] = r[1].trim(); });
  const v = {};
  SETTINGS.forEach(s => {
    const label = [s.label].concat(s.aliases || []).find(l => Object.prototype.hasOwnProperty.call(raw, l));
    v[s.key] = label ? raw[label] : s.def;
  });

  const unit = Number(v.unitMinutes);
  let open = normTime_(v.openTime);
  let close = normTime_(v.closeTime);
  if (!isTime_(open) || !isTime_(close) || toMin_(open) >= toMin_(close)) {
    open = '07:00';
    close = '22:00';
  }
  return {
    title: v.title || '練習室予約',
    notice: v.notice,
    noticeLevel: v.noticeLevel === '重要' ? '重要' : '通常',
    openTime: open,
    closeTime: close,
    unitMinutes: unit > 0 && 60 % unit === 0 ? unit : 5,
    maxDurationMinutes: Math.max(0, Number(v.maxDurationMinutes) || 0),
    maxDaysAhead: Math.max(0, Number(v.maxDaysAhead) || 0),
    closedWeekdays: String(v.closedWeekdays).split('').map(ch => WEEKDAYS.indexOf(ch)).filter(i => i >= 0),
    maxBulkCount: Math.max(1, Number(v.maxBulkCount) || 100),
    bulkRequiresAdmin: !/^(いいえ|no|false|0|off)$/i.test(String(v.bulkRequiresAdmin).trim()),
    viewPassword: v.viewPassword,
    limitedPassword: v.limitedPassword,
  };
}

function publicSettings_(s) {
  const copy = Object.assign({}, s);
  copy.viewPasswordRequired = !!s.viewPassword;
  SECRET_SETTINGS.forEach(k => delete copy[k]);
  return copy;
}

function toRow_(r) {
  return [r.id, r.date, r.roomId, r.start, r.end, r.affiliation, r.name, r.pin, r.createdAt || '', r.groupId || '', r.memo || '', r.updatedAt || ''];
}

function toPublic_(r) {
  return {
    id: r.id, date: r.date, roomId: r.roomId, start: r.start, end: r.end,
    affiliation: r.affiliation, name: r.name, memo: r.memo || '', groupId: r.groupId || '',
    hasPin: !!r.pin, // 編集用パスワードそのものは返さない
  };
}

/** 書式を「書式なしテキスト」にしてから追記し、日付・時刻・先頭ゼロの自動変換を防ぐ */
function appendRows_(sheet, rows) {
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows);
  SpreadsheetApp.flush();
}

function log_(ss, action, r, detail) {
  try {
    const sheet = ss.getSheetByName(SHEETS.log) || ensureSheet_(ss, SHEETS.log, HEADERS.log);
    const row = [nowStr_('yyyy-MM-dd HH:mm:ss'), action, r.id, r.date, r.roomId, r.start + '〜' + r.end, (r.affiliation ? r.affiliation + ' ' : '') + r.name, detail || r.memo || ''];
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setNumberFormat('@').setValues([row]);
  } catch (e) {
    console.error(e); // ログの失敗で予約処理自体は失敗させない
  }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(SYSTEM.LOCK_WAIT_MS)) {
    return fail_('アクセスが集中しています。少し待ってから再度お試しください。', 'BUSY');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** 現在使われている「りざぶ郎」の部屋構成に合わせた初期データ。実際の設備に合わせて部屋マスタを編集すること。 */
function defaultRooms_() {
  const rooms = [];
  const add = (id, name, equipment, tags) => rooms.push([rooms.length + 1, id, name, equipment || '', '', '', tags || '']);
  // 特徴の記載がない部屋はアップライトピアノ1台の部屋
  for (let i = 1; i <= 4; i++) add('room_' + pad2_(i), '練習室' + i, 'アップライトピアノ', 'UP');
  for (let i = 1; i <= 5; i++) add('room_06_p' + i, '練習室6', '電子ピアノ', '電子P.' + i);
  for (let i = 7; i <= 15; i++) add('room_' + pad2_(i), '練習室' + i, 'アップライトピアノ', 'UP');
  add('room_16', '練習室16', 'グランドピアノ', '大・GP');
  add('room_17', '練習室17', 'グランドピアノ', 'GP');
  add('room_18', '練習室18', 'アップライトピアノ', 'UP2台');
  add('room_19_p6', '練習室19', '電子ピアノ', '電子P.6');
  add('room_19_p7', '練習室19', '電子ピアノ', '電子P.7');
  add('room_20', '練習室20', 'アップライトピアノ', 'UP2台');
  add('room_21', '練習室21', 'グランドピアノ', '大・GP');
  for (let i = 22; i <= 26; i++) add('room_' + pad2_(i), '練習室' + i, 'アップライトピアノ', 'UP');
  return rooms;
}

// ---------------------------------------------------------------------------
// 日付・時刻ユーティリティ
// ---------------------------------------------------------------------------

function normDate_(v) {
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  return m ? m[1] + '-' + pad2_(m[2]) + '-' + pad2_(m[3]) : s;
}

function normTime_(v) {
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  return m ? pad2_(m[1]) + ':' + m[2] : s;
}

function normPin_(v) {
  const s = String(v == null ? '' : v).trim();
  return /^\d{1,4}$/.test(s) ? ('0000' + s).slice(-4) : s;
}

function isValidDate_(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const p = s.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2]);
  return d.getFullYear() === p[0] && d.getMonth() === p[1] - 1 && d.getDate() === p[2];
}

function isTime_(t) {
  return /^\d{2}:\d{2}$/.test(t) && toMin_(t) <= 24 * 60 && Number(t.slice(3)) < 60;
}

function toMin_(t) {
  const m = String(t).match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

function hm_(t) {
  return String(t).replace(/^0(\d)/, '$1');
}

function pad2_(n) {
  return ('0' + n).slice(-2);
}

function weekday_(dateStr) {
  const p = dateStr.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]).getDay();
}

function addDays_(dateStr, n) {
  const p = dateStr.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2] + n);
  return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate());
}

function daysBetween_(a, b) {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

function durationText_(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return (h ? h + '時間' : '') + (m ? m + '分' : '');
}

function isPast_(date, endTime) {
  return (date + ' ' + endTime) <= nowStr_('yyyy-MM-dd HH:mm');
}

function nowStr_(pattern) {
  return Utilities.formatDate(new Date(), SYSTEM.TIMEZONE, pattern);
}

function newId_(prefix) {
  return prefix + '_' + Date.now() + '_' + Utilities.getUuid().slice(0, 8);
}

function fail_(message, code) {
  return { ok: false, code: code || 'ERROR', message: message };
}

function alert_(message) {
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (e) {
    Logger.log(message); // スクリプトエディタから実行した場合
  }
}

function confirm_(message) {
  try {
    const ui = SpreadsheetApp.getUi();
    return ui.alert(message, ui.ButtonSet.OK_CANCEL) === ui.Button.OK;
  } catch (e) {
    return true; // スクリプトエディタから実行した場合は確認なしで実行
  }
}
