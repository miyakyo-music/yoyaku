#!/usr/bin/env node
/**
 * Cloudflare の正本（cache/store.js）を昔の時点に戻した（復元した）ときに、写しの続きが reset を返すかを確かめる。
 * Durable Object の復元の代わりに、手元の SQLite で「変更の番号」と kv を昔の値へ戻して試す。
 * 使い方（このリポジトリの一番上で）: node dev/mirror-reset-test.js
 * 必要なもの: Node 22 以上（node:sqlite。古い 22 では node --experimental-sqlite dev/mirror-reset-test.js）
 * すべて通れば「すべて通りました」と出して終了コード 0、どこかで違えば 1。
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
require(path.resolve(__dirname, '../cache/store.js'));

const raw = new DatabaseSync(':memory:');
const db = {
  exec(q, ...b) { const st = raw.prepare(q); return /^\s*(SELECT|WITH|PRAGMA)/i.test(q) ? st.all(...b) : (st.run(...b), []); },
  txn(fn) { raw.exec('BEGIN'); try { const v = fn(); raw.exec('COMMIT'); return v; } catch (e) { raw.exec('ROLLBACK'); throw e; } },
};
const core = new StoreCore(db, { PUSH_TOKEN: 'x'.repeat(40) }, {});
let failed = 0;
const check = (name, ok, got) => { console.log((ok ? '通過 ' : '失敗 ') + name + (ok ? '' : '（' + JSON.stringify(got) + '）')); if (!ok) failed++; };
const book = (start) => core.api({ action: 'createReservation', params: { roomId: 'room_01', date: '2030-01-07', start, end: start.replace(':00', ':30'), affiliation: 'a', name: 'b', pin: '1111' } });

(async () => {
  core.sync('begin', {});
  core.sync('master', { rooms: [[1, 'room_01', '練習室1', '', '', '', '']], closures: [], settings: {}, adminPassword: 'admin123' });
  core.sync('finish', {});
  for (const s of ['10:00', '11:00']) await book(s);
  // 復元する時点: GAS がここまで写し終えた
  let r = core.sync('changes', { after: 0 });
  const restorePoint = { seq: r.seq, ack: core.kget('mirrorAck') || '' };
  r = core.sync('changes', { after: r.seq });
  check('ふだんの続きは reset にならない', !r.reset && r.changes.length === 0, r);
  for (const s of ['12:00', '13:00', '14:00']) await book(s);
  r = core.sync('changes', { after: restorePoint.seq });
  const gasSeq = r.seq; // GAS は復元の前に、ここまで写した
  check('復元の前に、新しい変更を写せる', r.changes.length === 6, r); // 予約1件で、予約と操作ログの2件
  core.sync('changes', { after: gasSeq });

  // 復元の代わり: 変更の番号と kv を、restorePoint の時点へ戻す（Durable Object の復元では、表も番号も一緒に戻る）
  raw.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'changes'").run(restorePoint.seq);
  raw.prepare('DELETE FROM changes WHERE seq > ?').run(restorePoint.seq);
  core.kput('mirrorAck', restorePoint.ack);

  await book('15:00'); // 復元のあとの予約。番号は restorePoint の次になり、GAS が写した番号より小さい
  r = core.sync('changes', { after: gasSeq });
  check('復元のあと、写した番号より昔に戻っていれば reset を返す', r.reset === true, r);
  check('reset のときは、まだ写していない変更を消さない', Number(core.sync('status').pendingChanges) > 0, core.sync('status'));
  const full = core.sync('full');
  check('丸ごと写し直すと、復元のあとの予約も入っている', full.reservations.some((x) => x[3] === '15:00'), full.reservations);
  r = core.sync('changes', { after: full.seq });
  check('丸ごと写し直したあとは、続きから写せる', !r.reset, r);

  console.log(failed ? `${failed}件が失敗しました` : 'すべて通りました');
  process.exit(failed ? 1 : 0);
})();
