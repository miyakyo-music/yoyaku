// 管理画面: りざぶ郎の画面から手で書き出した CSV を読み、予約として取り込む（「設定」タブ。仕様書 4.7）。
// りざぶ郎へは一切つながない。ファイルはこの画面で読み、部屋を当ててからサーバーの adminImportReservations に送る
'use strict';

let importItems = [];

/** CSV の文字コードは UTF-8 か Shift_JIS のどちらか（先に UTF-8 として読み、読めなければ Shift_JIS） */
async function readCsvText(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { return new TextDecoder('shift_jis').decode(buf); }
}
/** CSV の1行を欄に分ける（"" で囲んだ欄の中の , と "" を扱う） */
function csvCells(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch !== '"') cur += ch;
      else if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}
/**
 * りざぶ郎の CSV の1行（部屋,テキスト,開始,終了,予約者,…。日時は 202610281305 の形）を、取り込む予約の形にする。
 * 部屋は名前がそのまま同じ部屋か、名前の「練習室n」と「P.n」（電子ピアノの番号）で当てる。
 * 予約者は先頭の英数字を学籍番号/所属、残りを氏名にする（英数字だけなら、それを氏名に。英数字がなければ全体を氏名に）
 */
function rizaburoItem(f, rooms) {
  const s = String(f[2] || '').replace(/\D/g, '').slice(0, 12);
  const e = String(f[3] || '').replace(/\D/g, '').slice(0, 12);
  if (s.length !== 12 || e.length !== 12) return { error: '日時が読めない行' };
  // りざぶ郎は 24:00 を翌日の 0:00 と書くので、24:00 に戻す
  let end = e.slice(8, 10) + ':' + e.slice(10, 12);
  if (e.slice(8) === '0000' && e.slice(0, 8) === nextDay8(s.slice(0, 8))) end = '24:00';
  else if (s.slice(0, 8) !== e.slice(0, 8)) return { error: '日をまたぐ予約' };
  const roomName = String(f[0] || '').normalize('NFKC').trim();
  let hit = rooms.filter((r) => r.name.normalize('NFKC') === roomName);
  if (hit.length !== 1) {
    const num = (roomName.match(/練習室\s*(\d+)/) || [])[1];
    const p = (roomName.match(/P\.\s*(\d+)/) || [])[1];
    hit = num ? rooms.filter((r) => r.name === '練習室' + Number(num) && (!p || String(r.tags || '').split('・').includes('電子P.' + p))) : [];
  }
  if (hit.length !== 1) return { error: '部屋が決まらない: ' + (roomName || '（空欄）') };
  const who = String(f[4] || '').normalize('NFKC').trim();
  const w = who.match(/^([A-Za-z0-9]*\d[A-Za-z0-9]*)\s*・?\s*(.*)$/);
  const affiliation = w && w[2].trim() ? w[1].toUpperCase() : '';
  const name = w ? (w[2].trim() || w[1].toUpperCase()) : who;
  if (!name) return { error: '予約者が空欄' };
  return {
    value: {
      date: s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8), roomId: hit[0].id,
      start: s.slice(8, 10) + ':' + s.slice(10, 12), end, affiliation, name,
    },
  };
}

/** 20261028 の翌日（20261029） */
function nextDay8(d) {
  const t = new Date(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)) + 1);
  return t.getFullYear() + pad(t.getMonth() + 1) + pad(t.getDate());
}

$('importFile').addEventListener('change', async (ev) => {
  const files = [...ev.target.files];
  ev.target.value = ''; // 同じファイルを選び直しても読み直す
  if (!files.length) return;
  $('importError').textContent = '';
  $('importResult').textContent = '';
  importItems = [];
  const rooms = (state.data && state.data.rooms) || [];
  const bad = {};
  const seen = new Set();
  try {
    for (const file of files) {
      const lines = (await readCsvText(file)).replace(/^﻿/, '').split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim() || line[0] === '#') continue;
        const f = csvCells(line);
        if (!/\d/.test(f[2] || '')) continue; // 見出しの行
        const x = rizaburoItem(f, rooms);
        if (x.error) { bad[x.error] = (bad[x.error] || 0) + 1; continue; }
        const key = JSON.stringify(x.value);
        if (seen.has(key)) continue; // 同じ日の CSV を2回選んだときなど
        seen.add(key);
        importItems.push(x.value);
      }
    }
  } catch (e) {
    $('importError').textContent = 'ファイルを読めませんでした。' + errMessage(e);
    importItems = [];
  }
  const dates = importItems.map((x) => x.date).sort();
  const span = dates.length ? '（' + dateLabel(dates[0]).text + (dates[0] === dates[dates.length - 1] ? '' : ' 〜 ' + dateLabel(dates[dates.length - 1]).text) + '）' : '';
  $('importSummary').textContent = importItems.length + '件' + span;
  $('importBtn').disabled = !importItems.length;
  const problems = Object.keys(bad).map((k) => k + '（' + bad[k] + '行）');
  if (problems.length) $('importResult').textContent = '読み飛ばした行\n' + problems.join('\n');
});

$('importBtn').addEventListener('click', async () => {
  if (!importItems.length) return;
  const btn = $('importBtn');
  btn.disabled = true;
  btn.textContent = '取り込み中…';
  $('importError').textContent = '';
  try {
    const res = await api('adminImportReservations', { items: importItems });
    if (!res.ok) throw new Error(res.message);
    exportCache = null; // 予約履歴と統計は、次に開いたときに読み直す
    for (const k of Object.keys(statsCache)) delete statsCache[k];
    importItems = [];
    $('importSummary').textContent = '';
    const lines = [res.added + '件を取り込みました。'];
    if (res.same) lines.push('取り込み済み: ' + res.same + '件');
    if (res.skipped.length) lines.push('取り込めなかった予約: ' + res.skipped.length + '件', ...res.skipped);
    $('importResult').textContent = lines.join('\n');
    toast(res.added + '件を取り込みました');
  } catch (e) {
    $('importError').textContent = errMessage(e);
  } finally {
    btn.textContent = '取り込む';
    btn.disabled = !importItems.length;
  }
});
