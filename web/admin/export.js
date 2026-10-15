// 管理画面: 予約履歴の印刷とエクスポート（CSV・Excel・PDF）
'use strict';

/** 押している間は、印刷・エクスポートのボタンを止めて「読み込み中…」にする */
async function withExport(btn, fn) {
  const err = $('exportError');
  err.textContent = '';
  exportPick.close();
  toggleFmt(false);
  closeCols();
  toggleWd(false);
  const label = btn.textContent;
  $('xPrintBtn').disabled = $('xFmtBtn').disabled = true;
  btn.textContent = '読み込み中…';
  try {
    await fn(await exportRows());
  } catch (e) {
    err.textContent = errMessage(e);
  } finally {
    btn.textContent = label;
    $('xPrintBtn').disabled = $('xFmtBtn').disabled = false;
  }
}
function saveFile(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// エクスポートの形式の一覧（ボタンの下に開く）
function toggleFmt(open) {
  $('xFmtPop').hidden = !open;
  $('xFmtBtn').setAttribute('aria-expanded', String(open));
}
$('xFmtBtn').addEventListener('click', () => { closeCols(); toggleFmt($('xFmtPop').hidden); });

// 印刷・PDF に入れる項目（日付はいつも入れる）。選んだものは、この端末に覚えておく
const LIST_COLS = [
  { k: 'date', label: '日付', w: 60 },
  { k: 'time', label: '時間', w: 86 },
  { k: 'room', label: '部屋', w: 104, grow: true },
  { k: 'name', label: '氏名・団体名', w: 100, grow: true },
  { k: 'aff', label: '学籍番号/所属', w: 72, grow: true },
  { k: 'memo', label: '備考', w: 110, grow: true },
];
const COLS_KEY = 'prr.listCols';
function savedCols() {
  try { const v = JSON.parse(localStorage.getItem(COLS_KEY) || 'null'); if (Array.isArray(v)) return ['date', ...v.filter((k) => k !== 'date')]; } catch (e) { /* 覚えていなければ全部 */ }
  return LIST_COLS.map((c) => c.k);
}
let colsMode = '';
function openCols(mode) {
  colsMode = mode;
  const on = new Set(savedCols());
  $('xColsTitle').textContent = mode === 'pdf' ? 'PDF に入れる項目' : '印刷する項目';
  $('xColsGo').textContent = mode === 'pdf' ? 'PDF を保存' : '印刷';
  $('xColsList').innerHTML = LIST_COLS.filter((c) => c.k !== 'date').map((c) =>
    `<label class="check"><input type="checkbox" value="${c.k}"${on.has(c.k) ? ' checked' : ''}>${c.label}</label>`).join('');
  $('xColsPop').hidden = false;
  $(mode === 'pdf' ? 'xFmtBtn' : 'xPrintBtn').setAttribute('aria-expanded', 'true');
}
function closeCols() {
  $('xColsPop').hidden = true;
  $('xPrintBtn').setAttribute('aria-expanded', 'false');
  $('xFmtBtn').setAttribute('aria-expanded', 'false');
}
$('xPrintBtn').addEventListener('click', () => {
  toggleFmt(false);
  if (!$('xColsPop').hidden && colsMode === 'print') closeCols(); else openCols('print');
});
$('xColsGo').addEventListener('click', () => {
  const picked = [...$('xColsList').querySelectorAll('input:checked')].map((c) => c.value);
  try { localStorage.setItem(COLS_KEY, JSON.stringify(picked)); } catch (e) { /* 覚えられなくても続ける */ }
  const cols = ['date', ...picked];
  const mode = colsMode;
  closeCols();
  if (mode === 'pdf') {
    withExport($('xFmtBtn'), async (data) => {
      if (!data.list.length) throw new Error('条件に合う予約はありません。');
      await exportPdf(data, cols);
      toast(`${data.list.length}件を PDF に書き出しました`);
    });
  } else {
    printList(cols);
  }
});
document.addEventListener('pointerdown', (e) => {
  if ($('xFmtPick').contains(e.target)) return;
  if (!$('xFmtPop').hidden) toggleFmt(false);
  if (!$('xColsPop').hidden) closeCols();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('xFmtPop').hidden) { toggleFmt(false); $('xFmtBtn').focus(); }
  if (!$('xColsPop').hidden) { closeCols(); $(colsMode === 'pdf' ? 'xFmtBtn' : 'xPrintBtn').focus(); }
});
const EXPORTERS = { csv: exportCsv, xlsx: exportXlsx }; // PDF は項目を選んでから（xColsGo）
$('xFmtPop').addEventListener('click', (e) => {
  const b = e.target.closest('[data-fmt]');
  if (!b) return;
  if (b.dataset.fmt === 'pdf') { toggleFmt(false); openCols('pdf'); return; } // PDF は、入れる項目を選んでから
  withExport($('xFmtBtn'), async (data) => {
    if (!data.list.length) throw new Error('条件に合う予約はありません。');
    const name = await EXPORTERS[b.dataset.fmt](data);
    toast(`${data.list.length}件を ${name} に書き出しました`);
  });
});

// CSV: Excel で文字化けしないよう、先頭に BOM を付けた UTF-8。数式として読まれる先頭文字（= + - @）には ' を付ける
function csvCell(v) {
  let t = String(v == null ? '' : v);
  if (/^[=+\-@]/.test(t)) t = "'" + t;
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}
function exportCsv({ from, to, list }) {
  const text = '﻿' + [EXPORT_HEAD].concat(list.map(exportCells)).map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  saveFile(new Blob([text], { type: 'text/csv;charset=utf-8' }), `予約一覧_${from}_${to}.csv`);
  return 'CSV';
}

// Excel（.xlsx）: 中身は XML のファイルをまとめた ZIP。文字はすべて文字列のまま入れる（日付・時刻が勝手に変わらないように）
function exportXlsx({ from, to, list, rooms, stamp }) {
  const x = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''); // XML に入れられない文字は除く
  const col = (i) => String.fromCharCode(65 + i);
  const cell = (v, ref, s) => `<c r="${ref}" t="inlineStr"${s ? ` s="${s}"` : ''}><is><t xml:space="preserve">${x(v)}</t></is></c>`;
  const rows = [
    `<row r="1">${cell(`${state.data.settings.title} 予約一覧　${slash(from)}〜${slash(to)}　部屋: ${rooms}　${list.length}件　出力: ${stamp}`, 'A1', 1)}</row>`,
    `<row r="2">${EXPORT_HEAD.map((h, i) => cell(h, col(i) + 2, 1)).join('')}</row>`,
    ...list.map((r, n) => `<row r="${n + 3}">${exportCells(r).map((v, i) => cell(v, col(i) + (n + 3))).join('')}</row>`),
  ];
  const widths = [12, 5, 7, 7, 22, 14, 22, 30];
  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${rows.join('')}</sheetData>` +
    `<autoFilter ref="A2:H${list.length + 2}"/></worksheet>`;
  const files = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="予約一覧" sheetId="1" r:id="rId1"/></sheets>' +
      `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'予約一覧'!$A$2:$H$${list.length + 2}</definedName></definedNames></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2"><font><sz val="11"/><name val="Yu Gothic"/></font><font><b/><sz val="11"/><name val="Yu Gothic"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
      '</styleSheet>',
    'xl/worksheets/sheet1.xml': sheet,
  };
  saveFile(new Blob([zipStore(files)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `予約一覧_${from}_${to}.xlsx`);
  return 'Excel';
}

/** ZIP（圧縮なし）を作る。files は {名前: 文字列} */
function zipStore(files) {
  const enc = new TextEncoder();
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const parts = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameB = enc.encode(name), data = enc.encode(text), crc = crc32(data);
    const head = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, 0, 2], [12, 0x21, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, nameB.length, 2], [28, 0, 2]]
      .forEach(([o, v, n]) => (n === 4 ? head.setUint32(o, v, true) : head.setUint16(o, v, true)));
    const dir = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, 0, 2], [14, 0x21, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4],
      [28, nameB.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, offset, 4]]
      .forEach(([o, v, n]) => (n === 4 ? dir.setUint32(o, v, true) : dir.setUint16(o, v, true)));
    parts.push(new Uint8Array(head.buffer), nameB, data);
    central.push(new Uint8Array(dir.buffer), nameB);
    offset += 30 + nameB.length + data.length;
  }
  const size = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  const count = Object.keys(files).length;
  [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, count, 2], [10, count, 2], [12, size, 4], [16, offset, 4], [20, 0, 2]]
    .forEach(([o, v, n]) => (n === 4 ? end.setUint32(o, v, true) : end.setUint16(o, v, true)));
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)]);
}

// PDF: 印刷と同じ表を A4 縦で。文字は文字のまま入れ（小さく、検索・コピーもできる）、日本語の書体はファイルに入れず、
// 開く端末のゴシック体を使う（PDF の決まりにある日本語の標準書体 HeiseiKakuGo-W5 を指定。Mac・iPhone・Windows・Chrome で表示できる）
const PAGE = { w: 595.28, h: 841.89, m: 34 }; // A4（pt）と余白（12mm）
/** 文字の幅（pt）。半角は文字の大きさの半分、全角は同じ（PDF の中の決まり /W と合わせる） */
const halfWidth = (c) => c < 0x7f || (c >= 0xff61 && c <= 0xff9f);
const textWidth = (t, size) => [...String(t)].reduce((a, ch) => a + (halfWidth(ch.codePointAt(0)) ? 0.5 : 1), 0) * size;
/** 幅に収まらない文字は、末尾を「…」にして縮める */
function fit(text, width, size) {
  let t = String(text || '');
  if (textWidth(t, size) <= width) return t;
  while (t && textWidth(t + '…', size) > width) t = [...t].slice(0, -1).join('');
  return t + '…';
}
/** PDF の中の文字（UTF-16 の16進。BMP の外の文字は〓にする） */
const pdfHex = (t) => '<' + [...String(t)].map((ch) => { const c = ch.codePointAt(0); return (c > 0xffff ? 0x3013 : c).toString(16).padStart(4, '0'); }).join('') + '>';

/** 各ページの描画の命令（PDF の content stream）を作る */
function pdfPages({ from, to, list, rooms, stamp }, keys) {
  const usable = PAGE.w - PAGE.m * 2;
  // 選んだ項目だけを並べ、日付・時間以外の列で、余った幅を元の幅の割合で分け合う
  const PDF_COLS = LIST_COLS.filter((c) => keys.includes(c.k)).map((c) => ({ ...c }));
  const fixed = PDF_COLS.filter((c) => !c.grow).reduce((a, c) => a + c.w, 0);
  const growSum = PDF_COLS.filter((c) => c.grow).reduce((a, c) => a + c.w, 0);
  PDF_COLS.forEach((c) => { if (c.grow) c.w = c.w * (usable - fixed) / growSum; });
  const crossYear = from.slice(0, 4) !== to.slice(0, 4);
  const ROW = 16, HEAD_Y = PAGE.m + 44, FOOT = 20, FS = 9.5;
  const perPage = Math.floor((PAGE.h - HEAD_Y - ROW - PAGE.m - FOOT) / ROW);
  const pageCount = Math.max(1, Math.ceil(list.length / perPage));
  const Y = (y) => (PAGE.h - y).toFixed(2); // PDF は下が 0
  const pages = [];
  for (let p = 0; p < pageCount; p++) {
    const ops = [];
    // bold: 文字の縁もなぞって太く見せる（書体は1種類だけのため）
    const text = (t, x, y, size, opt) => {
      opt = opt || {};
      ops.push(`${opt.color || '0 0 0'} rg ${opt.color || '0 0 0'} RG ${opt.bold ? `2 Tr ${(size * 0.035).toFixed(3)} w` : '0 Tr'}`);
      ops.push(`BT /F1 ${size} Tf ${x.toFixed(2)} ${Y(y)} Td ${pdfHex(t)} Tj ET`);
    };
    const rule = (y, width, gray) => ops.push(`${gray} G ${width} w ${PAGE.m} ${Y(y)} m ${(PAGE.w - PAGE.m).toFixed(2)} ${Y(y)} l S`);
    text(`${state.data.settings.title} 予約一覧`, PAGE.m, PAGE.m + 14, 14, { bold: true });
    const stampText = `出力: ${stamp}`;
    text(`期間: ${slash(from)}(${wdOf(from)}) 〜 ${slash(to)}(${wdOf(to)})　部屋: ${fit(rooms, usable - 220, 9)}　${list.length}件`, PAGE.m, PAGE.m + 30, 9);
    text(stampText, PAGE.w - PAGE.m - textWidth(stampText, 9), PAGE.m + 30, 9, { color: '.33 .33 .33' });
    let y = HEAD_Y, x = PAGE.m;
    for (const c of PDF_COLS) { text(c.label, x + 4, y + 11, FS, { bold: true }); x += c.w; }
    rule(y + ROW, 1, 0);
    y += ROW;
    const rows = list.slice(p * perPage, (p + 1) * perPage);
    rows.forEach((r, i) => {
      const first = !i || rows[i - 1].date !== r.date; // ページの最初の行にも日付を出す
      if (first && i) rule(y, 1, .47);
      const w = wdOf(r.date);
      x = PAGE.m;
      PDF_COLS.forEach((c) => {
        if (c.k === 'date') {
          if (first) {
            const d = crossYear ? slash(r.date) : slash(r.date).slice(5);
            text(d, x + 4, y + 11, FS);
            text(`(${w})`, x + 4 + textWidth(d, FS), y + 11, FS, { color: w === '土' ? '.11 .31 .85' : w === '日' ? '.78 .16 .16' : '0 0 0' });
          }
        } else if (c.k === 'time') {
          // 開始を右揃えにして「〜」の位置をそろえる
          const s0 = hm(r.start), sw = textWidth('00:00', FS);
          text(s0, x + 4 + sw - textWidth(s0, FS), y + 11, FS);
          text(`〜${hm(r.end)}`, x + 4 + sw, y + 11, FS);
        } else {
          text(fit(cellOf(r, c.k), c.w - 8, FS), x + 4, y + 11, FS);
        }
        x += c.w;
      });
      y += ROW;
      rule(y, .5, .78);
    });
    if (!list.length) text('条件に合う予約はありません。', PAGE.m, y + 14, FS);
    const no = `${p + 1} / ${pageCount}`;
    text(no, (PAGE.w - textWidth(no, 8)) / 2, PAGE.h - PAGE.m + 6, 8, { color: '.33 .33 .33' });
    pages.push(ops.join('\n'));
  }
  return pages;
}

async function exportPdf(data, cols) {
  const pages = pdfPages(data, cols);
  const streams = [];
  for (const p of pages) streams.push(await deflate(new TextEncoder().encode(p)));
  saveFile(pdfFile(streams), `予約一覧_${data.from}_${data.to}.pdf`);
  return 'PDF';
}
/** 使える端末では縮める（使えない古い端末は、縮めずにそのまま入れる） */
async function deflate(bytes) {
  if (typeof CompressionStream !== 'function') return { data: bytes, filter: '' };
  const out = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer();
  return { data: new Uint8Array(out), filter: '/Filter /FlateDecode ' };
}
/** PDF（1.4）を作る。1〜4番は共通（目次・ページの束・書体）、そのあとにページと描画の命令が2つずつ並ぶ */
function pdfFile(streams) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let size = 0;
  const put = (b) => { const u = typeof b === 'string' ? enc.encode(b) : b; chunks.push(u); size += u.length; };
  const obj = (n, body, stream) => {
    offsets[n] = size;
    put(`${n} 0 obj\n${body}\n`);
    if (stream) { put('stream\n'); put(stream); put('\nendstream\n'); }
    put('endobj\n');
  };
  put('%PDF-1.4\n%âãÏÓ\n');
  const first = 6;
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${streams.map((_, i) => `${first + i * 2} 0 R`).join(' ')}] /Count ${streams.length} >>`);
  // 日本語の標準書体（ファイルには入れない）。半角の文字（CID 231〜389）は幅 500、それ以外は 1000
  obj(3, '<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiKakuGo-W5 /Encoding /UniJIS-UCS2-HW-H /DescendantFonts [4 0 R] >>');
  obj(4, '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiKakuGo-W5 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 4 >> ' +
    '/FontDescriptor 5 0 R /DW 1000 /W [231 389 500] >>');
  obj(5, '<< /Type /FontDescriptor /FontName /HeiseiKakuGo-W5 /Flags 4 /FontBBox [-92 -250 1010 922] /ItalicAngle 0 /Ascent 752 /Descent -221 /CapHeight 737 /StemV 114 >>');
  streams.forEach((s, i) => {
    const n = first + i * 2;
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${n + 1} 0 R >>`);
    obj(n + 1, `<< ${s.filter}/Length ${s.data.length} >>`, s.data);
  });
  const count = first + streams.length * 2;
  const xref = size;
  put(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) put(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  put(`trailer\n<< /Size ${count} /Root 1 0 R /Info << /Producer (practice-room-reservation) >> >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}

/**
 * 画面の一覧に出す短い部屋名（特徴タグの（）は詳細で見せる）。ただし、同じ名前の部屋が複数あるとき
 * （練習室6 の電子ピアノ5台など）は、見分けられるようにタグを残す
 */
function shortRoom(id) {
  const r = state.data.rooms.find((x) => x.id === id);
  if (!r) return id;
  return state.data.rooms.filter((x) => x.name === r.name).length > 1 ? roomName(id) : r.name;
}
/** 項目の中身（日付以外） */
function cellOf(r, k) {
  return k === 'time' ? `${hm(r.start)}〜${hm(r.end)}` : k === 'room' ? roomName(r.roomId) : k === 'name' ? r.name : k === 'aff' ? r.affiliation : k === 'memo' ? r.memo : '';
}

// 印刷: 選んだ項目で印刷用の表（#printArea）を作り、印刷のときはそれだけを出す（admin/history.css の @media print）
function printList(cols) {
  withExport($('xPrintBtn'), async (data) => {
    const { from, to, list, rooms, stamp } = data;
    let area = $('printArea');
    if (!area) { area = document.createElement('div'); area.id = 'printArea'; document.body.appendChild(area); }
    area.innerHTML = `<h1>${esc(state.data.settings.title)} 予約一覧</h1>` +
      `<p class="meta">期間: ${slash(from)}(${wdOf(from)}) 〜 ${slash(to)}(${wdOf(to)})　部屋: ${esc(rooms)}　${list.length}件<span>出力: ${stamp}</span></p>` +
      (list.length ? listTable(data, { cols }) : '<p>条件に合う予約はありません。</p>');
    window.print();
  });
}
