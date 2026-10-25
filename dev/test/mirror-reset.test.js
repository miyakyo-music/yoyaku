/** 復元のあとの写し直しの試験（dev/mirror-reset-test.js。単独でも流せる）を、まとめて流す試験の一つとして流す */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

test('復元のあとの写し直し（dev/mirror-reset-test.js）', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '../mirror-reset-test.js')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});
