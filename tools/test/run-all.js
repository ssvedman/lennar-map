#!/usr/bin/env node
/**
 * run-all.js — every suite.
 *
 *   npm install --no-save jsdom xlsx     # two suites skip cleanly without these
 *   node tools/test/run-all.js
 */

'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const suites = ['run-tests.js', 'import-tests.js', 'app-tests.js'];
let failed = 0;

for (const s of suites) {
  const r = spawnSync(process.execPath, [path.join(__dirname, s)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

process.exit(failed ? 1 : 0);
