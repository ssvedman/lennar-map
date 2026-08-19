#!/usr/bin/env node
/**
 * run-tests.js — exercises validate.js with a stubbed network.
 *
 * Mostly: which geocode results are allowed to overwrite a coordinate. Getting
 * that wrong moves a pin to the wrong subdivision and nobody notices.
 */

'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const VALIDATE = path.join(ROOT, 'tools', 'validate.js');
const STUB = path.join(__dirname, 'stub-fetch.js');

let pass = 0, fail = 0;

function tmpFixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmap-'));
  const now = new Date();
  const dataStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const data = Object.assign({
    generatedAt: new Date().toISOString(),
    updateCadenceDays: 7,
    dataStart,
    tradeCats: ['Roofing Turnkey'],
    vendors: ['Proformance Roofing'],
    communities: [{
      name: 'Test Community', num: '99999999999',
      addr: '1573 Plank Pl, Davenport, FL 33837',
      lat: 28.2048225, lon: -81.6470894,
      starts: [1,0,0,0,0,0,0,0,0,0,0,0],
      acm: 'a.person', cms: ['a.person'],
      trades: { 0: 0 },
      municipality: 'Davenport', electric: 'Duke', water: 'Polk',
      plans: ['H006 (B)']
    }]
  }, overrides);

  const dp = path.join(dir, 'data.json');
  const pp = path.join(dir, 'people.json');
  fs.writeFileSync(dp, JSON.stringify(data));
  fs.writeFileSync(pp, JSON.stringify({
    people: { 'a.person': { name: 'A Person', phone: '000', email: 'a@b.com', roles: ['acm','cm'] } }
  }));
  return { dir, dp, pp };
}

function run(fx, extra = [], env = {}) {
  const args = ['-r', STUB, VALIDATE, '--data', fx.dp, '--people', fx.pp, ...extra];
  try {
    const out = execFileSync(process.execPath, args, {
      env: Object.assign({}, process.env, env), encoding: 'utf8'
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

console.log('\nvalidate.js\n');

/* ── schema ─────────────────────────────────────────────────────────────── */

test('clean fixture passes', () => {
  const fx = tmpFixture();
  const r = run(fx);
  assert(r.code === 0, `expected exit 0, got ${r.code}\n${r.out}`);
  assert(/0 errors/.test(r.out), `expected 0 errors:\n${r.out}`);
});

test('starts[] of the wrong length is an error', () => {
  const fx = tmpFixture();
  const d = JSON.parse(fs.readFileSync(fx.dp)); d.communities[0].starts = [1,2,3];
  fs.writeFileSync(fx.dp, JSON.stringify(d));
  const r = run(fx);
  assert(r.code === 1, 'expected exit 1');
  assert(/expected 12/.test(r.out), r.out);
});

test('coordinates outside the division are an error', () => {
  const fx = tmpFixture();
  const d = JSON.parse(fs.readFileSync(fx.dp));
  d.communities[0].lat = 41.8781; d.communities[0].lon = -87.6298;
  fs.writeFileSync(fx.dp, JSON.stringify(d));
  const r = run(fx);
  assert(r.code === 1, 'expected exit 1');
  assert(/bounding box/.test(r.out), r.out);
});

test('null island is an error', () => {
  const fx = tmpFixture();
  const d = JSON.parse(fs.readFileSync(fx.dp));
  d.communities[0].lat = 0; d.communities[0].lon = 0;
  fs.writeFileSync(fx.dp, JSON.stringify(d));
  const r = run(fx);
  assert(/null island/.test(r.out), r.out);
});

test('a dataStart that misplaces the current month is an error', () => {
  const fx = tmpFixture({ dataStart: '2019-01' });
  const r = run(fx);
  assert(r.code === 1, 'expected exit 1');
  assert(/expected 0 or 1/.test(r.out), r.out);
});

test('an unknown person reference is an error', () => {
  const fx = tmpFixture();
  const d = JSON.parse(fs.readFileSync(fx.dp)); d.communities[0].cms = ['nobody'];
  fs.writeFileSync(fx.dp, JSON.stringify(d));
  const r = run(fx);
  assert(r.code === 1, 'expected exit 1');
  assert(/unknown person/.test(r.out), r.out);
});

test('a trade index out of range is an error', () => {
  const fx = tmpFixture();
  const d = JSON.parse(fs.readFileSync(fx.dp)); d.communities[0].trades = { 99: 0 };
  fs.writeFileSync(fx.dp, JSON.stringify(d));
  const r = run(fx);
  assert(r.code === 1, 'expected exit 1');
  assert(/out of range/.test(r.out), r.out);
});

test('a duplicate community number is an error', () => {
  const fx = tmpFixture();
  const d = JSON.parse(fs.readFileSync(fx.dp));
  d.communities.push(Object.assign({}, d.communities[0], { name: 'Twin' }));
  fs.writeFileSync(fx.dp, JSON.stringify(d));
  const r = run(fx);
  assert(r.code === 1, 'expected exit 1');
  assert(/duplicate community number/.test(r.out), r.out);
});

test('identical coordinates warn but do not fail', () => {
  const fx = tmpFixture();
  const d = JSON.parse(fs.readFileSync(fx.dp));
  d.communities.push(Object.assign({}, d.communities[0], { name: 'Twin', num: '88888888888' }));
  fs.writeFileSync(fx.dp, JSON.stringify(d));
  const r = run(fx);
  assert(r.code === 0, `expected exit 0, got ${r.code}`);
  assert(/identical coordinates/.test(r.out), r.out);
});

test('stale data warns but does not fail', () => {
  const fx = tmpFixture({ generatedAt: new Date(Date.now() - 30 * 864e5).toISOString() });
  const r = run(fx);
  assert(r.code === 0, 'expected exit 0');
  assert(/days old/.test(r.out), r.out);
});

test('a published but unreferenced person is flagged', () => {
  const fx = tmpFixture();
  fs.writeFileSync(fx.pp, JSON.stringify({ people: {
    'a.person': { name: 'A Person', phone: '000', email: 'a@b.com', roles: ['acm','cm'] },
    'ghost':    { name: 'Ghost', phone: '111', email: 'g@b.com', roles: ['cm'] }
  }}));
  const r = run(fx);
  assert(/"ghost" is published but not referenced/.test(r.out), r.out);
});

/* ── geocoding decisions ────────────────────────────────────────────────── */

const coordsOf = fx => {
  const c = JSON.parse(fs.readFileSync(fx.dp)).communities[0];
  return [c.lat, c.lon];
};

test('a geocode that agrees produces no geocoding output', () => {
  const fx = tmpFixture();
  const r = run(fx, ['--geocode'], { GEOCODE_CASE: 'agrees' });
  assert(r.code === 0, 'expected exit 0');
  assert(!/km from the geocoded/.test(r.out), `should be silent:\n${r.out}`);
});

test('--fix corrects a confident address-precision drift', () => {
  const fx = tmpFixture();
  const before = coordsOf(fx);
  const r = run(fx, ['--fix'], { GEOCODE_CASE: 'confident-drift' });
  const after = coordsOf(fx);
  assert(/corrected 1 coordinate/.test(r.out), r.out);
  assert(after[0] !== before[0], 'latitude should have moved');
  assert(Math.abs(after[0] - 28.2085) < 1e-6, `unexpected corrected lat ${after[0]}`);
});

test('--geocode without --fix reports the same drift but does not write', () => {
  const fx = tmpFixture();
  const before = coordsOf(fx);
  const r = run(fx, ['--geocode'], { GEOCODE_CASE: 'confident-drift' });
  const after = coordsOf(fx);
  assert(/re-run with --fix/.test(r.out), r.out);
  assert(after[0] === before[0] && after[1] === before[1], 'coordinates must not change without --fix');
});

test('drift beyond the fix ceiling is never auto-applied', () => {
  const fx = tmpFixture();
  const before = coordsOf(fx);
  const r = run(fx, ['--fix'], { GEOCODE_CASE: 'far-drift' });
  const after = coordsOf(fx);
  assert(/needs a human/.test(r.out), r.out);
  assert(after[0] === before[0], 'a 40 km jump must not be applied automatically');
});

test('a coarse (town-centroid) match never overwrites a pin', () => {
  const fx = tmpFixture();
  const before = coordsOf(fx);
  const r = run(fx, ['--fix'], { GEOCODE_CASE: 'coarse-only' });
  const after = coordsOf(fx);
  assert(after[0] === before[0], 'an area-precision match must not be applied');
  assert(!/corrected/.test(r.out), r.out);
});

test('a geocode outside the bounding box is ignored', () => {
  const fx = tmpFixture();
  const before = coordsOf(fx);
  const r = run(fx, ['--fix'], { GEOCODE_CASE: 'out-of-box' });
  assert(coordsOf(fx)[0] === before[0], 'out-of-box result must not be applied');
  assert(/outside the division/.test(r.out), r.out);
});

test('the chain falls through to Nominatim when Census is down', () => {
  const fx = tmpFixture();
  const r = run(fx, ['--fix'], { GEOCODE_CASE: 'census-down' });
  assert(/corrected 1 coordinate/.test(r.out), `expected fallback to succeed:\n${r.out}`);
});

test('an approximate location is never auto-corrected', () => {
  const fx = tmpFixture();
  const d = JSON.parse(fs.readFileSync(fx.dp)); d.communities[0].approxGeo = true;
  fs.writeFileSync(fx.dp, JSON.stringify(d));
  const before = coordsOf(fx);
  const r = run(fx, ['--fix'], { GEOCODE_CASE: 'confident-drift' });
  assert(coordsOf(fx)[0] === before[0], 'approxGeo records must be left for a human');
  assert(/needs a human/.test(r.out), r.out);
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
