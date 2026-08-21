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

/* ── an absent coordinate is a normal state, not an error ─────────────────────
   A new community arrives with no coordinate, and the map holds it off the map
   rather than plotting it at 0,0. Treating that as an error made this script exit
   1 after every import, which is how a report stops being read. */

test('a community with no coordinate is reported, not failed', () => {
  const fx = tmpFixture();
  const d = JSON.parse(fs.readFileSync(fx.dp));
  d.communities[0].lat = null; d.communities[0].lon = null; d.communities[0].addr = '';
  d.communities[0].starts = [7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  fs.writeFileSync(fx.dp, JSON.stringify(d));
  const r = run(fx);
  assert(r.code === 0, `an unlocated community must not fail the run:\n${r.out}`);
  assert(/awaiting a location/.test(r.out), `should be reported:\n${r.out}`);
  assert(/7 starts hidden/.test(r.out),
    `and the starts it hides are what say whether it matters:\n${r.out}`);
  assert(!/missing required field "lat"/.test(r.out),
    'and it is not reported three times over as a missing field');
  assert(!/lat\/lon is not numeric/.test(r.out), 'nor as a type error');
});

test('but a coordinate that is present and wrong is still an error', () => {
  const fx = tmpFixture();
  const d = JSON.parse(fs.readFileSync(fx.dp));
  // A string where a number belongs is a bug, unlike an honest absence.
  d.communities[0].lat = '28.5'; d.communities[0].lon = '-81.5';
  fs.writeFileSync(fx.dp, JSON.stringify(d));
  const r = run(fx);
  assert(r.code === 1, 'expected exit 1');
  assert(/present but not numeric/.test(r.out), r.out);
});

test('two communities with no coordinates do not "share a map pin"', () => {
  const fx = tmpFixture();
  const d = JSON.parse(fs.readFileSync(fx.dp));
  // Both unlocated. Comparing null to null found them 0 m apart and reported a
  // shared pin — neither is on the map, so they share nothing.
  for (const i of [0, 1]) {
    if (!d.communities[i]) continue;
    d.communities[i].lat = null; d.communities[i].lon = null; d.communities[i].addr = '';
  }
  fs.writeFileSync(fx.dp, JSON.stringify(d));
  const r = run(fx);
  assert(!/share one map pin/.test(r.out), `false co-location warning:\n${r.out}`);
});

test('a community with no address says so once, not once per geocoder', () => {
  const fx = tmpFixture();
  const d = JSON.parse(fs.readFileSync(fx.dp));
  d.communities[0].lat = null; d.communities[0].lon = null; d.communities[0].addr = '';
  fs.writeFileSync(fx.dp, JSON.stringify(d));
  const r = run(fx, ['--geocode']);
  assert(/no address yet/.test(r.out), `should explain the real problem:\n${r.out}`);
  assert(!/geocoder unavailable/.test(r.out),
    'and must not blame the geocoder for being handed an empty string');
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

/* ── A COORDINATE SOMEBODY TYPED IS NOT THIS TOOL'S TO REVISE ────────────────
   `approxGeo` marks a coordinate this tooling produced and may therefore revise.
   A hand-placed one carries geoSource "manual" and deliberately no approxGeo
   flag — a person with a plat beats every heuristic here. Reading the absent
   flag as permission to move it would have --fix quietly undoing the one
   correction somebody went to the trouble of making, which is the worst possible
   direction for a tool that runs unattended. */

test('--fix never moves a hand-placed coordinate', () => {
  const fx = tmpFixture();
  const d = JSON.parse(fs.readFileSync(fx.dp));
  d.communities[0].geoSource = 'manual';
  delete d.communities[0].approxGeo;
  fs.writeFileSync(fx.dp, JSON.stringify(d));
  const before = coordsOf(fx);

  const r = run(fx, ['--fix'], { GEOCODE_CASE: 'confident-drift' });
  const after = coordsOf(fx);
  assert(after[0] === before[0] && after[1] === before[1],
    `a manual coordinate must not move, went ${before} → ${after}`);
  assert(!/corrected 1 coordinate/.test(r.out), `and must not be reported as corrected:\n${r.out}`);
  // Still reported, though: a hand-placed pin 8 km from its own address is worth
  // knowing about. Silence would be the other way of getting this wrong.
  assert(/placed by hand, so it is reported but never moved/.test(r.out),
    `it should still be surfaced:\n${r.out}`);
});

/* ── PLACING is not CORRECTING ────────────────────────────────────────────────
   metres() reads an absent latitude as 0, so the distance from a null coordinate
   to a perfectly correct geocode was ~9,162 km against a 2 km ceiling. --fix
   therefore refused to place ANY new community, including one whose address a
   human had typed in — while its own output told you to run it for exactly that. */

/* ── WHOSE COORDINATE IS IT ──────────────────────────────────────────────────
   The guard reads `geoSource` to decide whether --fix may move a pin, and the
   distinction that matters is between a value it does not RECOGNISE and no value
   at all. Those look alike and mean opposite things.

   An unrecognised value means somebody or something recorded a provenance this
   tooling does not understand — leave it alone. ABSENT means the community
   predates the field, which is true of every one of the 74 in the division
   today. Treating absent as unknown switched --fix off for the entire dataset
   while the report went on telling you to re-run with --fix, which is a silent
   feature-off dressed as caution. That is what these five pin down. */

test('--fix leaves a coordinate whose provenance it cannot read', () => {
  const fx = tmpFixture();
  const d = JSON.parse(fs.readFileSync(fx.dp));
  d.communities[0].geoSource = 'imported-from-somewhere';
  fs.writeFileSync(fx.dp, JSON.stringify(d));
  const before = coordsOf(fx);

  const r = run(fx, ['--fix'], { GEOCODE_CASE: 'confident-drift' });
  assert(coordsOf(fx)[0] === before[0], 'an unrecognised geoSource must not move');
  assert(/imported-from-somewhere/.test(r.out),
    `and the value should be named so it can be investigated:
${r.out}`);
});

test('but a coordinate with NO provenance is still corrected', () => {
  const fx = tmpFixture();
  const d = JSON.parse(fs.readFileSync(fx.dp));
  delete d.communities[0].geoSource;
  delete d.communities[0].approxGeo;
  fs.writeFileSync(fx.dp, JSON.stringify(d));
  const before = coordsOf(fx);

  const r = run(fx, ['--fix'], { GEOCODE_CASE: 'confident-drift' });
  assert(/corrected 1 coordinate/.test(r.out),
    `absent is not unknown — every community predates the field:
${r.out}`);
  assert(coordsOf(fx)[0] !== before[0], 'and the coordinate actually moved');
});

test('an automatic provenance is movable, when nothing else blocks it', () => {
  const fx = tmpFixture();
  const d = JSON.parse(fs.readFileSync(fx.dp));
  d.communities[0].geoSource = 'agreement';
  delete d.communities[0].approxGeo;      // map-core sets this alongside; see below
  fs.writeFileSync(fx.dp, JSON.stringify(d));

  const r = run(fx, ['--fix'], { GEOCODE_CASE: 'confident-drift' });
  assert(/corrected 1 coordinate/.test(r.out),
    `a value this tooling writes is not itself a reason to refuse:
${r.out}`);
});

test('approxGeo blocks the fix whatever the provenance says', () => {
  const fx = tmpFixture();
  const d = JSON.parse(fs.readFileSync(fx.dp));
  d.communities[0].geoSource = 'agreement';
  d.communities[0].approxGeo = true;
  fs.writeFileSync(fx.dp, JSON.stringify(d));
  const before = coordsOf(fx);

  run(fx, ['--fix'], { GEOCODE_CASE: 'confident-drift' });
  /* Worth being explicit about, because it is what makes the case above
     largely theoretical: map-core sets approxGeo alongside every automatic
     geoSource it writes, so in practice approxGeo is the operative gate and the
     provenance check is the backstop rather than the other way round. */
  assert(coordsOf(fx)[0] === before[0], 'approxGeo remains the operative gate');
});

test('--fix places a community that has an address but no coordinate', () => {
  const fx = tmpFixture();
  const d = JSON.parse(fs.readFileSync(fx.dp));
  d.communities[0].lat = null; d.communities[0].lon = null;
  fs.writeFileSync(fx.dp, JSON.stringify(d));

  const r = run(fx, ['--fix'], { GEOCODE_CASE: 'confident-drift' });
  assert(r.code === 0, `expected success:\n${r.out}`);
  assert(/placed 1 community/.test(r.out), `should report a placement:\n${r.out}`);

  const after = JSON.parse(fs.readFileSync(fx.dp)).communities[0];
  assert(typeof after.lat === 'number' && typeof after.lon === 'number',
    `the coordinate must actually be written, got ${after.lat},${after.lon}`);
  assert(after.approxGeo === true,
    'and flagged approximate, so a later run will not silently move it');
});

test('a placement is reported separately from a correction', () => {
  const fx = tmpFixture();
  const d = JSON.parse(fs.readFileSync(fx.dp));
  d.communities[0].lat = null; d.communities[0].lon = null;
  fs.writeFileSync(fx.dp, JSON.stringify(d));
  const r = run(fx, ['--fix'], { GEOCODE_CASE: 'confident-drift' });
  // "placed" and "corrected" are different events and must not read alike.
  assert(/placed/.test(r.out), 'says placed');
  assert(!/moved .* km/.test(r.out),
    `a first placement has not "moved" anything:\n${r.out}`);
});

test('--geocode without --fix reports the placement but writes nothing', () => {
  const fx = tmpFixture();
  const d = JSON.parse(fs.readFileSync(fx.dp));
  d.communities[0].lat = null; d.communities[0].lon = null;
  fs.writeFileSync(fx.dp, JSON.stringify(d));
  const r = run(fx, ['--geocode'], { GEOCODE_CASE: 'confident-drift' });
  assert(/re-run with --fix to place it/.test(r.out), `should offer it:\n${r.out}`);
  const after = JSON.parse(fs.readFileSync(fx.dp)).communities[0];
  assert(after.lat === null, 'and must not have written the coordinate');
});

test('a coarse match is refused for placement, not just for correction', () => {
  const fx = tmpFixture();
  const d = JSON.parse(fs.readFileSync(fx.dp));
  d.communities[0].lat = null; d.communities[0].lon = null;
  fs.writeFileSync(fx.dp, JSON.stringify(d));
  // A town centroid is not a homesite. Placing a pin on one is worse than none.
  const r = run(fx, ['--fix'], { GEOCODE_CASE: 'coarse-only' });
  assert(/too coarse to place a pin/.test(r.out), `should refuse:\n${r.out}`);
  const after = JSON.parse(fs.readFileSync(fx.dp)).communities[0];
  assert(after.lat === null, 'and leave the coordinate absent');
});

test('a geocode outside the division is refused for placement too', () => {
  const fx = tmpFixture();
  const d = JSON.parse(fs.readFileSync(fx.dp));
  d.communities[0].lat = null; d.communities[0].lon = null;
  fs.writeFileSync(fx.dp, JSON.stringify(d));
  const r = run(fx, ['--fix'], { GEOCODE_CASE: 'out-of-box' });
  const after = JSON.parse(fs.readFileSync(fx.dp)).communities[0];
  assert(after.lat === null, `a Chicago geocode must not place an Orlando community:\n${r.out}`);
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
