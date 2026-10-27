/**
 * 公開のときに CSS・JS をまとめる処理（dev/bundle.js）を確かめる。web のコピーに流して、
 *   - まとめたファイルが、HTML の並び順どおりの中身になっている
 *   - HTML の参照がすべて差し替わり、ほかの部分（<head> の中に書いた <script> など）は変わらない
 *   - まとめた JS が、別々の <script> のときと同じ動きになる（1つが例外を出しても次が動く・'use strict' はファイルごと・外側の名前を共有）
 *   - privacy.html と手元の web/ は変わらない
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { ROOT } = require('./world.js');
const { bundle, findGroups, rebaseUrls } = require('../bundle.js');

const WEB = path.join(ROOT, 'web');
const read = (f) => fs.readFileSync(f, 'utf8');
const refs = (html, re) => [...html.matchAll(re)].map((m) => m[1]);
const CSS_RE = /<link rel="stylesheet" href="([^"]+)">/g;
const JS_RE = /<script src="([^"]+)"><\/script>/g;
const INLINE_RE = /<script>[\s\S]*?<\/script>/g;

function copyWeb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-test-'));
  fs.cpSync(WEB, dir, { recursive: true });
  return dir;
}

/** まとめた JS を、<script> を入れるとその場で別の台本として動かす作りの、小さな画面の代わりで動かす */
function runBundle(code) {
  const errors = [];
  const ctx = vm.createContext({});
  const parent = {
    insertBefore(s) { try { new vm.Script(s.text, { filename: 'inline' }).runInContext(ctx); } catch (e) { errors.push(e); } },
    removeChild() {},
  };
  ctx.window = ctx;
  ctx.document = { currentScript: { parentNode: parent }, createElement: () => ({ text: '' }) };
  new vm.Script(code).runInContext(ctx);
  return { ctx, errors };
}

test('予約表と管理画面: 並び順どおりにまとまり、参照がすべて差し替わる', () => {
  const dir = copyWeb();
  try {
    const before = {};
    for (const p of ['index.html', 'admin.html', 'privacy.html']) before[p] = read(path.join(WEB, p));
    const made = bundle(dir);
    for (const page of ['index.html', 'admin.html']) {
      const base = page.replace('.html', '');
      const html = read(path.join(dir, page));
      const css = refs(before[page], CSS_RE);
      const js = refs(before[page], JS_RE);
      // 参照は、まとめたファイルの1つずつだけ
      assert.deepStrictEqual(refs(html, CSS_RE), [`bundle/${base}.css`], page + ' の CSS');
      assert.deepStrictEqual(refs(html, JS_RE), [`bundle/${base}.js`], page + ' の JS');
      assert.deepStrictEqual(made.filter((m) => m.page === page).map((m) => m.files), [css, js], page + ' のまとめた中身の並び');
      assert.ok(js.includes('config.js') && js.includes('api.js') && js[js.length - 1] === base + '/boot.js');
      // まとめた CSS は、元のファイルを並び順どおりにつないだもの（url() の直しが要るものは今はない）
      const bundled = read(path.join(dir, `bundle/${base}.css`));
      assert.strictEqual(bundled, css.map((f) => `/* ===== ${f} ===== */\n${read(path.join(WEB, f))}\n`).join(''));
      // まとめた JS の中の並びと中身
      const parts = [];
      const ctx = vm.createContext({ document: { currentScript: { parentNode: { insertBefore: (s) => parts.push(s.text), removeChild() {} } }, createElement: () => ({}) } });
      new vm.Script(read(path.join(dir, `bundle/${base}.js`))).runInContext(ctx);
      assert.deepStrictEqual(parts,js.map((f) => read(path.join(WEB, f)) + '\n//# sourceURL=' + f));
      // タグを抜いたほかの部分（<head> の中のダークモード判定など）は同じ
      const strip = (h) => h.replace(CSS_RE, '').replace(JS_RE, '').replace(/\n+/g, '\n');
      assert.strictEqual(strip(html), strip(before[page]), page + ' のほかの部分');
      assert.deepStrictEqual(html.match(INLINE_RE), before[page].match(INLINE_RE));
      // まとめたタグは、元の最初のタグの位置にある
      assert.ok(html.indexOf(`bundle/${base}.css`) < html.indexOf('</head>'));
      assert.ok(html.indexOf(`bundle/${base}.js`) > html.indexOf('id="toast"'));
    }
    assert.strictEqual(read(path.join(dir, 'privacy.html')), before['privacy.html'], 'privacy.html は変えない');
    for (const p of ['index.html', 'admin.html', 'privacy.html']) assert.strictEqual(read(path.join(WEB, p)), before[p], '手元の web/' + p + ' は変えない');
    assert.ok(!fs.existsSync(path.join(WEB, 'bundle')), '手元の web/ に bundle/ を作らない');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('まとめた JS: 別々の <script> と同じ動き（例外・文法の誤り・use strict・外側の名前）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'index'));
    const files = {
      'a.js': 'loose = 1;\nwindow.order = ["a"];', // 'use strict' なし: 宣言なしの代入が通る
      'index/b.js': "'use strict';\nconst shared = 2;\nfunction hello() { return shared; }\nwindow.order.push('b');",
      'index/c.js': "'use strict';\nwindow.order.push('c');\nnotDeclared = 3;", // 'use strict' あり: ここで例外
      'index/d.js': "'use strict';\nwindow.order.push('d'; // 文法の誤り",
      'index/e.js': "'use strict';\nwindow.order.push('e:' + hello() + ':' + loose);",
    };
    for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), t);
    fs.writeFileSync(path.join(dir, 'index.html'), '<head>\n<script>var dark = 1;</script>\n</head><body>\n' +
      Object.keys(files).map((f) => `<script src="${f}"></script>`).join('\n') + '\n</body>');
    bundle(dir);
    const { ctx, errors } = runBundle(read(path.join(dir, 'bundle/index.js')));
    assert.deepStrictEqual([...ctx.order], ['a', 'b', 'c', 'e:2:1'], '例外・文法の誤りのファイルのあとも動く');
    assert.deepStrictEqual(errors.map((e) => e.name), ['ReferenceError', 'SyntaxError']);
    assert.strictEqual(ctx.loose, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('まとめる範囲: 属性の付いたもの・外のもの・間にほかのものがあるところで切れる', () => {
  const html = [
    '<link rel="stylesheet" href="a.css">', '<!-- 説明 -->', '<link rel="stylesheet" href="b.css">',
    '<link rel="stylesheet" href="c.css" media="print">', '<link rel="stylesheet" href="d.css">', '<link rel="stylesheet" href="e.css">',
    '<script src="x.js"></script>', '<script src="y.js" defer></script>', '<script src="z.js"></script>',
    '<script>inline()</script>', '<script src="p.js"></script>', '<script src="https://example.com/q.js"></script>', '<script src="r.js"></script>',
    '<script src="s.js?v=1"></script>', '<script src="t.js"></script>', '<script type="module" src="m.js"></script>', '<script src="u.js"></script>', '<script src="w.js"></script>',
  ].join('\n');
  assert.deepStrictEqual(findGroups(html).map((g) => g.files), [['a.css', 'b.css'], ['d.css', 'e.css'], ['u.js', 'w.js']]);
});

test('CSS の url() は、まとめたファイルの場所から同じものを指す', () => {
  const css = 'a{background:url(img/x.png)} b{background:url("../favicon.svg")} c{background:url(\'data:image/svg+xml,%3Csvg%3E\')} d{background:url(https://e.com/y.png)}';
  assert.strictEqual(rebaseUrls(css, 'index', 'bundle'),
    'a{background:url(../index/img/x.png)} b{background:url("../favicon.svg")} c{background:url(\'data:image/svg+xml,%3Csvg%3E\')} d{background:url(https://e.com/y.png)}');
});
