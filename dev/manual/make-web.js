// docx と同じ本文（make.js の body）から、Web ページ版（web/manual.html）を作る
const fs = require('fs');
const path = require('path');
const [, , outHtml] = process.argv;

const src = fs.readFileSync(path.join(__dirname, 'make-docx.js'), 'utf8');
const bodySrc = src.slice(src.indexOf('const body = ['), src.indexOf('const doc = new Document'));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const runs = (x) => (Array.isArray(x) ? x : [x]).map((r) => (typeof r === 'string' ? esc(r) : r.bold ? `<b>${esc(r.text)}</b>` : esc(r.text))).join('');
const t = (text, o = {}) => ({ text, bold: !!o.bold, size: o.size });
const b = (text) => t(text, { bold: true });
const p = (x) => `<p>${runs(x)}</p>`;
const toc = [];
const h1 = (s) => { const id = 's' + (toc.length + 1); toc.push([id, s]); return `<h2 id="${id}">${esc(s)}</h2>`; };
const h2 = (s) => `<h3>${esc(s)}</h3>`;
const steps = (items) => [`<ol>${items.map((x) => `<li>${runs(x)}</li>`).join('')}</ol>`];
const bullets = (items) => [`<ul>${items.map((x) => `<li>${runs(x)}</li>`).join('')}</ul>`];
const table = (w, rows) => `<div class="tbl"><table><thead><tr>${rows[0].map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('')}</tbody></table></div>`;
const box = (children) => `<section class="key">${children.map((c) => (c && c.__title ? `<p class="key-title">${runs(c.runs)}</p>` : c)).join('')}</section>`;
const gap = () => '';
const img = (file, w, caption) => [`<figure><img src="manual/${file}" alt="${esc(caption.replace(/^図\d+　/, ''))}" style="max-width:${Math.round(w * 1.25)}px" loading="lazy"><figcaption>${esc(caption)}</figcaption></figure>`];
// 表題などの Paragraph（docx 用）は、色や大きさの指定から役目を見分けて置き換える
const AlignmentType = { CENTER: 'center' };
class Paragraph {
  constructor(o) {
    const r = o.children[0];
    if (r && r.size === 26) return { __title: true, runs: o.children };
    return { __head: true, runs: o.children };
  }
}
// eslint-disable-next-line no-eval
const body = eval(bodySrc.replace('const body = ', '(') .replace(/;\s*$/, ')'));

const heads = body.filter((x) => x && x.__head).map((x) => runs(x.runs));
const main = body.filter((x) => !(x && x.__head)).flat().join('\n');
const tocHtml = `<nav class="toc" aria-label="目次"><p class="toc-title">目次</p><ol>${toc.map(([id, s]) => `<li><a href="#${id}">${esc(s.replace(/^\d+\.\s*/, ''))}</a></li>`).join('')}</ol></nav>`;
// 「はじめの囲み」の直後に目次を置く
const parts = main.split('</section>');
const html = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8')
  .replace('{{SUB}}', heads[0]).replace('{{TITLE}}', heads[1]).replace('{{META}}', heads[2])
  .replace('{{BODY}}', parts[0] + '</section>\n' + tocHtml + parts.slice(1).join('</section>'));
fs.writeFileSync(outHtml, html);
console.log('ok', toc.length);
