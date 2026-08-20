#!/usr/bin/env node
/**
 * import-tests.js — exercises import-workbooks.js against synthetic workbooks.
 * Needs xlsx; skips cleanly without it.
 *
 * The cases that matter are destructive ones: the placeholder filter, and the
 * fact that a merge must preserve coordinates rather than blanking every pin.
 */

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let XLSX;
for (const p of ['xlsx', path.join(process.env.XLSX_PATH || '/tmp/node_modules', 'xlsx')]) {
  try { XLSX = require(p); break; } catch { /* keep looking */ }
}
if (!XLSX) {
  console.log('\n  xlsx not installed — skipping import tests');
  console.log('  npm install --no-save xlsx\n');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..', '..');
const IMPORT = path.join(ROOT, 'tools', 'import-workbooks.js');

let pass = 0, fail = 0;
const test = (n, fn) => {
  try { fn(); console.log(`  ✓ ${n}`); pass++; }
  catch (e) { console.log(`  ✗ ${n}\n      ${e.message}`); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`); };

/* ── fixtures ─────────────────────────────────────────────────────────────── */
const thisMonth = () => {
  const d = new Date();
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
};
const dayIn = (offsetMonths, day) => {
  const { y, m } = thisMonth();
  const d = new Date(Date.UTC(y, m - 1 + offsetMonths, day));
  return d.toISOString().slice(0, 10);
};

function sheet(rows) { return XLSX.utils.json_to_sheet(rows); }
function book(name, rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet(rows), name);
  return wb;
}

function env() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-'));
  const dp = path.join(dir, 'data.json');
  const pp = path.join(dir, 'people.json');

  // Two existing communities carrying the fields only data.json holds.
  fs.writeFileSync(dp, JSON.stringify({
    generatedAt: '2020-01-01T00:00:00.000Z',
    updateCadenceDays: 7,
    dataStart: '2020-01',
    tradeCats: ['Roofing Turnkey', 'Obsolete Trade'],
    vendors: ['Proformance Roofing', 'Gone Vendor'],
    communities: [
      { name: 'Alpha Ridge', num: '11110000000', addr: '1 A St, Orlando, FL',
        lat: 28.5, lon: -81.4, starts: new Array(12).fill(1),
        acm: 'a.person', cms: ['a.person'], trades: { 0: 0 },
        municipality: 'Orlando', electric: 'Duke', water: 'OUC',
        plans: ['H001 (A)'] },
      { name: 'Beta Field', num: '22220000000', addr: '2 B St, Orlando, FL',
        lat: 28.6, lon: -81.5, starts: new Array(12).fill(2),
        acm: 'a.person', cms: ['a.person'], trades: { 1: 1 },
        municipality: 'Apopka', electric: 'Duke', water: 'Apopka' }
    ]
  }));
  fs.writeFileSync(pp, JSON.stringify({
    people: { 'a.person': { name: 'A Person', phone: '000', email: 'a@b.com', roles: ['acm', 'cm'] } }
  }));
  return { dir, dp, pp };
}

function run(e, files = {}, extra = []) {
  const a = ['--data', e.dp, '--people', e.pp, ...extra];
  for (const [flag, wb] of Object.entries(files)) {
    const f = path.join(e.dir, flag + '.xlsx');
    XLSX.writeFile(wb, f);
    a.push('--' + flag, f);
  }
  try {
    return { code: 0, out: execFileSync(process.execPath, [IMPORT, ...a], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status, out: (err.stdout || '') + (err.stderr || '') };
  }
}
const load = e => JSON.parse(fs.readFileSync(e.dp, 'utf8'));
const byName = (d, n) => d.communities.find(c => c.name === n);

/* ── tests ────────────────────────────────────────────────────────────────── */
console.log('\nimport-workbooks.js\n');

test('the "Comm / Start (Prj)" layout parses', () => {
  const e = env();
  const rows = [
    { Comm: 'Alpha Ridge', Job: '11110000123', 'Start (Prj)': dayIn(0, 5), 'Start (Act)': null },
    { Comm: 'Alpha Ridge', Job: '11110000124', 'Start (Prj)': dayIn(0, 6), 'Start (Act)': null },
    { Comm: 'Alpha Ridge', Job: '11110000125', 'Start (Prj)': null, 'Start (Act)': dayIn(1, 7) }
  ];
  const r = run(e, { starts: book('Start Log', rows) });
  eq(r.code, 0, `exit\n${r.out}`);
  const a = byName(load(e), 'Alpha Ridge');
  eq(a.starts[0], 2, 'month 0');
  eq(a.starts[1], 1, 'month 1');
});

test('the "Project / PrjStart" layout parses', () => {
  const e = env();
  const rows = [
    { Project: '1111000 - Alpha Ridge', Job: '11110000123', PrjStart: dayIn(0, 5), ActStart: null },
    { Project: '1111000 - Alpha Ridge', Job: '11110000124', PrjStart: null, ActStart: dayIn(0, 9) }
  ];
  const r = run(e, { starts: book('START SCHEDULE', rows) });
  eq(r.code, 0, `exit\n${r.out}`);
  eq(byName(load(e), 'Alpha Ridge').starts[0], 2, 'month 0');
});

test('Excel serial dates are handled', () => {
  const e = env();
  // 45000 = 2023-03-15; outside the window, so it should land nowhere but not crash.
  const rows = [
    { Comm: 'Alpha Ridge', Job: '11110000123', 'Start (Prj)': 45000, 'Start (Act)': null },
    { Comm: 'Alpha Ridge', Job: '11110000124', 'Start (Prj)': dayIn(2, 1), 'Start (Act)': null }
  ];
  const r = run(e, { starts: book('Start Log', rows) });
  eq(r.code, 0, `exit\n${r.out}`);
  const a = byName(load(e), 'Alpha Ridge');
  eq(a.starts[2], 1, 'the in-window start should land in month 2');
  eq(a.starts.reduce((x, y) => x + y, 0), 1, 'the 2023 date must not be counted');
});

test('the placeholder filter drops >10 starts on one community-day', () => {
  const e = env();
  const rows = [];
  // 11 homes parked on one nominal date — a scheduling placeholder.
  for (let i = 0; i < 11; i++) {
    rows.push({ Comm: 'Alpha Ridge', Job: '1111000' + String(1000 + i), 'Start (Prj)': dayIn(0, 15), 'Start (Act)': null });
  }
  // 10 on another day is legitimate and must survive.
  for (let i = 0; i < 10; i++) {
    rows.push({ Comm: 'Alpha Ridge', Job: '1111000' + String(2000 + i), 'Start (Prj)': dayIn(1, 20), 'Start (Act)': null });
  }
  const r = run(e, { starts: book('Start Log', rows) });
  eq(r.code, 0, `exit\n${r.out}`);
  const a = byName(load(e), 'Alpha Ridge');
  eq(a.starts[0], 0, 'the 11-on-one-day block should be dropped');
  eq(a.starts[1], 10, 'exactly 10 on one day is not a placeholder');
  assert(/placeholder filter: dropped 11/.test(r.out), `should report the drop:\n${r.out}`);
});

test('exactly 10 on one day is kept, 11 is dropped', () => {
  // The threshold is confirmed, not inherited guesswork, so pin both sides of it.
  for (const [n, expected] of [[10, 10], [11, 0]]) {
    const e = env();
    const rows = [];
    for (let i = 0; i < n; i++) {
      rows.push({ Comm: 'Alpha Ridge', Job: '1111000' + String(1000 + i),
                  'Start (Prj)': dayIn(0, 15), 'Start (Act)': null });
    }
    const r = run(e, { starts: book('Start Log', rows) });
    eq(r.code, 0, `exit\n${r.out}`);
    eq(byName(load(e), 'Alpha Ridge').starts[0], expected,
       `${n} starts on one day should aggregate to ${expected}`);
  }
});

test('coordinates, utilities and plans survive a starts-only import', () => {
  const e = env();
  const before = byName(load(e), 'Alpha Ridge');
  const rows = [{ Comm: 'Alpha Ridge', Job: '11110000123', 'Start (Prj)': dayIn(0, 5), 'Start (Act)': null }];
  const r = run(e, { starts: book('Start Log', rows) });
  eq(r.code, 0, `exit\n${r.out}`);
  const after = byName(load(e), 'Alpha Ridge');
  eq(after.lat, before.lat, 'latitude must be preserved');
  eq(after.lon, before.lon, 'longitude must be preserved');
  eq(after.municipality, 'Orlando', 'municipality must be preserved');
  eq(after.electric, 'Duke', 'electric must be preserved');
  eq(JSON.stringify(after.plans), JSON.stringify(before.plans), 'plans must be preserved');
  eq(JSON.stringify(after.cms), JSON.stringify(before.cms), 'contacts must be preserved');
});

test('a starts-only import leaves communities absent from it alone', () => {
  const e = env();
  const rows = [{ Comm: 'Alpha Ridge', Job: '11110000123', 'Start (Prj)': dayIn(0, 5), 'Start (Act)': null }];
  run(e, { starts: book('Start Log', rows) });
  assert(byName(load(e), 'Beta Field'), 'Beta Field should not be deleted by a starts-only run');
  eq(byName(load(e), 'Beta Field').starts[0], 0, 'but it should show no starts');
});

test('RE2 assignments are imported and keyed by community number', () => {
  const e = env();
  const re2 = [
    { Division: 'OLH', Community: '11110000000', Description: 'Alpha Ridge',
      'Supplier Desc': 'New Roofer LLC', 'Trade Desc.': 'Roofing Turnkey', 'Expired Date': null },
    { Division: 'OLH', Community: '11110000000', Description: 'Alpha Ridge',
      'Supplier Desc': 'Some Plumber', 'Trade Desc.': 'Plumbing Turnkey', 'Expired Date': null }
  ];
  const r = run(e, { re2: book('Sheet1', re2) });
  eq(r.code, 0, `exit\n${r.out}`);
  const d = load(e), a = byName(d, 'Alpha Ridge');
  const t = {};
  for (const [c, v] of Object.entries(a.trades)) t[d.tradeCats[c]] = d.vendors[v];
  eq(t['Roofing Turnkey'], 'New Roofer LLC', 'roofing vendor');
  eq(t['Plumbing Turnkey'], 'Some Plumber', 'plumbing vendor');
});

test('expired RE2 assignments are skipped', () => {
  const e = env();
  const re2 = [
    { Division: 'OLH', Community: '11110000000', Description: 'Alpha Ridge',
      'Supplier Desc': 'Old Roofer', 'Trade Desc.': 'Roofing Turnkey', 'Expired Date': '2001-01-01' },
    { Division: 'OLH', Community: '11110000000', Description: 'Alpha Ridge',
      'Supplier Desc': 'Current Plumber', 'Trade Desc.': 'Plumbing Turnkey', 'Expired Date': '2099-01-01' }
  ];
  const r = run(e, { re2: book('Sheet1', re2) });
  const d = load(e), a = byName(d, 'Alpha Ridge');
  const names = Object.entries(a.trades).map(([, v]) => d.vendors[v]);
  assert(!names.includes('Old Roofer'), 'expired assignment should be dropped');
  assert(names.includes('Current Plumber'), 'unexpired assignment should survive');
  assert(/1 expired/.test(r.out), `should report it:\n${r.out}`);
});

test('rows for another division are ignored', () => {
  const e = env();
  const re2 = [
    { Division: 'TPU', Community: '11110000000', Description: 'Alpha Ridge',
      'Supplier Desc': 'Tampa Roofer', 'Trade Desc.': 'Roofing Turnkey', 'Expired Date': null },
    { Division: 'OLH', Community: '11110000000', Description: 'Alpha Ridge',
      'Supplier Desc': 'Orlando Roofer', 'Trade Desc.': 'Roofing Turnkey', 'Expired Date': null }
  ];
  const r = run(e, { re2: book('Sheet1', re2) });
  const d = load(e), a = byName(d, 'Alpha Ridge');
  eq(d.vendors[Object.values(a.trades)[0]], 'Orlando Roofer', 'should take the OLH row');
});

test('an RE2 file for the wrong division is refused, not silently applied', () => {
  const e = env();
  const re2 = [
    { Division: 'TPU', Community: '99990000000', Description: 'Tampa Place',
      'Supplier Desc': 'Tampa Roofer', 'Trade Desc.': 'Roofing Turnkey', 'Expired Date': null }
  ];
  const r = run(e, { re2: book('Sheet1', re2) });
  eq(r.code, 1, 'should exit non-zero');
  assert(/wrong file/.test(r.out), `should say so:\n${r.out}`);
  assert(/nothing written/.test(r.out), 'must not write');
});

test('a job number normalizes to the 11-digit community number', () => {
  const e = env();
  // 11110000123 → first 7 digits + "0000" → 11110000000
  const rows = [{ Comm: 'Alpha Ridge', Job: '11110000123', 'Start (Prj)': dayIn(0, 5), 'Start (Act)': null }];
  run(e, { starts: book('Start Log', rows) });
  const a = byName(load(e), 'Alpha Ridge');
  eq(a.num, '11110000000', 'should match the existing record, not create a new one');
  eq(load(e).communities.length, 2, 'no duplicate community should be created');
});

test('a new community is added with no coordinates and reported', () => {
  const e = env();
  const rows = [{ Comm: 'Gamma Park', Job: '33330000001', 'Start (Prj)': dayIn(0, 5), 'Start (Act)': null }];
  const r = run(e, { starts: book('Start Log', rows) });
  eq(r.code, 0, `exit\n${r.out}`);
  const g = byName(load(e), 'Gamma Park');
  assert(g, 'new community should be added');
  eq(g.lat, null, 'a new community must not be given an invented coordinate');
  assert(/new communities \(1\)/.test(r.out), `should be listed:\n${r.out}`);
  assert(/validate\.js --fix/.test(r.out), 'should point at the geocoder');
});

test('validate.js reports the un-geocoded newcomer instead of failing the run', () => {
  /* This used to assert that validate.js EXITS 1 on a community with no
     coordinate. The intent was right — do not silently ship a community that
     cannot be placed — but the mechanism was wrong, and it had two costs.

     It made validate.js exit 1 after every single import, because an import's
     whole job is to introduce communities that have no coordinate yet. A report
     that always fails is a report nobody reads, and this one carries the
     geocoding drift warnings that genuinely matter.

     And it was solving a problem that had already moved: the map now holds an
     unplaceable community off the map and says how many are waiting, so nothing
     is silently shipped whether or not this script exits non-zero.

     So the assertion is now the intent rather than the old mechanism: the
     community is reported, the starts it hides are counted, and the run succeeds
     so that the rest of the output gets read. */
  const e = env();
  run(e, { starts: book('Start Log', [
    { Comm: 'Gamma Park', Job: '33330000001', 'Start (Prj)': dayIn(0, 5), 'Start (Act)': null }
  ]) });
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath,
      [path.join(ROOT, 'tools', 'validate.js'), '--data', e.dp, '--people', e.pp], { encoding: 'utf8' });
  } catch (err) { code = err.status; out = (err.stdout || '') + (err.stderr || ''); }

  eq(code, 0, `an expected state must not fail the run:\n${out}`);
  assert(/awaiting a location/.test(out), `the newcomer should be reported:\n${out}`);
  assert(/Gamma Park/.test(out), 'by name');
  assert(!/lat\/lon is present but not numeric/.test(out),
    'and not mislabelled as a type error');

  // The community must still be in the document — reported, not dropped.
  const d = load(e);
  assert(d.communities.some(c => c.name === 'Gamma Park'), 'and kept in the document');
});

test('dataStart is emitted as the current month', () => {
  const e = env();
  run(e, { starts: book('Start Log', [
    { Comm: 'Alpha Ridge', Job: '11110000123', 'Start (Prj)': dayIn(0, 5), 'Start (Act)': null }
  ]) });
  const { y, m } = thisMonth();
  eq(load(e).dataStart, `${y}-${String(m).padStart(2, '0')}`, 'dataStart');
});

test('unused trade categories and vendors are pruned', () => {
  const e = env();
  const re2 = [
    { Division: 'OLH', Community: '11110000000', Description: 'Alpha Ridge',
      'Supplier Desc': 'Proformance Roofing', 'Trade Desc.': 'Roofing Turnkey', 'Expired Date': null },
    { Division: 'OLH', Community: '22220000000', Description: 'Beta Field',
      'Supplier Desc': 'Proformance Roofing', 'Trade Desc.': 'Roofing Turnkey', 'Expired Date': null }
  ];
  run(e, { re2: book('Sheet1', re2) });
  const d = load(e);
  assert(!d.tradeCats.includes('Obsolete Trade'), 'unused category should be pruned');
  assert(!d.vendors.includes('Gone Vendor'), 'unused vendor should be pruned');
  assert(d.tradeCats.includes('Roofing Turnkey'), 'used category should remain');
});

test('a stale workbook cannot delete the communities it omits', () => {
  const e = env();
  // Pad the existing data out so this is a real test rather than 2 → 1.
  const d = JSON.parse(fs.readFileSync(e.dp, 'utf8'));
  for (let i = 0; i < 6; i++) {
    d.communities.push({
      name: 'Filler ' + i, num: '9' + String(i) + '990000000',
      addr: 'x', lat: 28.5, lon: -81.4, starts: new Array(12).fill(1)
    });
  }
  fs.writeFileSync(e.dp, JSON.stringify(d));
  const before = d.communities.length; // 8

  /* Both workbooks supplied, but between them they mention only one community —
     the signature of someone picking last quarter's file.

     This used to be refused by a shrink guard, because the union of the two
     workbooks was authoritative and everything else was deleted. It is not
     refused now, because nothing is deleted: an import adds and decorates, and a
     community with no start in the window is dormant rather than gone. Its
     coordinates, utilities and contacts exist nowhere else, so losing them to a
     quiet quarter was the more expensive failure. */
  const starts = book('Start Log', [
    { Comm: 'Alpha Ridge', Job: '11110000123', 'Start (Prj)': dayIn(0, 5), 'Start (Act)': null }
  ]);
  const re2 = book('Sheet1', [
    { Division: 'OLH', Community: '11110000000', Description: 'Alpha Ridge',
      'Supplier Desc': 'Proformance Roofing', 'Trade Desc.': 'Roofing Turnkey', 'Expired Date': null }
  ]);
  const r = run(e, { starts, re2 });
  eq(r.code, 0, 'should succeed rather than refuse');
  eq(load(e).communities.length, before, 'every community must survive');
  assert(/no starts in this window/.test(r.out),
         `the omitted ones should be reported as dormant:\n${r.out}`);

  // Their coordinates — which exist in no workbook — must be intact.
  const filler = load(e).communities.find(c => c.name === 'Filler 0');
  eq(filler.lat, 28.5, 'a dormant community keeps its coordinates');
});

test('the RE2 export cannot introduce a community the map does not have', () => {
  const e = env();
  const before = load(e).communities.length;
  // The real export lists every community the division has ever had — 576 for
  // Orlando against the 71 on the map — so letting it define existence pulled in
  // five hundred closed-out communities with no coordinates.
  const re2 = book('Sheet1', [
    { Division: 'OLH', Community: '11110000000', Description: 'Alpha Ridge',
      'Supplier Desc': 'Proformance Roofing', 'Trade Desc.': 'Roofing Turnkey', 'Expired Date': null },
    { Division: 'OLH', Community: '77770000000', Description: 'Closed Out Estates',
      'Supplier Desc': 'Proformance Roofing', 'Trade Desc.': 'Roofing Turnkey', 'Expired Date': null }
  ]);
  const r = run(e, { re2 });
  eq(r.code, 0, 'should succeed');
  const d = load(e);
  eq(d.communities.length, before, 'no community was added');
  assert(!d.communities.some(c => c.name === 'Closed Out Estates'),
         'the unknown community must not appear');
  assert(/1 communities in the export are not on the map/.test(r.out),
         `and the count should be reported:\n${r.out}`);
});

test('a 10-digit job number resolves to the same community as an 11-digit one', () => {
  const e = env();
  /* 485 of the 6,674 jobs in the real Orlando permit log carry a 3-digit lot
     rather than a 4-digit one. Under the old >=11 rule every one of them fell
     through unnormalised and became its own community — Hunt Club 40GC alone
     split into 208 — taking the division from 94 communities to 575. */
  const starts = book('Start Log', [
    { Comm: 'Alpha Ridge', Job: '11110000123', 'Start (Prj)': dayIn(0, 5), 'Start (Act)': null },
    { Comm: 'Alpha Ridge', Job: '1111000456',  'Start (Prj)': dayIn(0, 6), 'Start (Act)': null },
    { Comm: 'Alpha Ridge', Job: '1111000789',  'Start (Prj)': dayIn(0, 7), 'Start (Act)': null }
  ]);
  const r = run(e, { starts });
  eq(r.code, 0, 'should succeed');
  const d = load(e);
  const alphas = d.communities.filter(c => c.name === 'Alpha Ridge');
  eq(alphas.length, 1, 'all three lots belong to one community, not three');
  eq(alphas[0].starts.reduce((a, b) => a + b, 0), 3, 'and all three starts land on it');
});

test('--dry-run writes nothing', () => {
  const e = env();
  const before = fs.readFileSync(e.dp, 'utf8');
  const r = run(e, { starts: book('Start Log', [
    { Comm: 'Alpha Ridge', Job: '11110000123', 'Start (Prj)': dayIn(0, 5), 'Start (Act)': null }
  ]) }, ['--dry-run']);
  eq(r.code, 0, 'should succeed');
  eq(fs.readFileSync(e.dp, 'utf8'), before, 'data.json must be unchanged');
  assert(/nothing written/.test(r.out), 'should say so');
});

/* ── contacts ───────────────────────────────────────────────────────────── */

// The real export carries a block of applied-filter text above the header, and
// the headers have trailing spaces. Reproduce both.
function contactBook(rows) {
  const aoa = [
    ['Applied filters:\nPosition is not VPC, ACM, or LOA', null, null, null, null],
    [null, null, null, null, null],
    ['Communities ', 'Construction ', 'Phone ', 'Email ', "ACM's"],
    ...rows.map(r => [r.communities, r.name, r.phone, r.email, r.acm])
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
  return wb;
}

test('the header row is found beneath the applied-filters block', () => {
  const e = env();
  const r = run(e, { contacts: contactBook([
    { communities: 'Alpha', name: 'Cody Mason', phone: '111', email: 'Cody.Mason@lennar.com', acm: 'A Person' }
  ]) });
  eq(r.code, 0, `exit\n${r.out}`);
  assert(/contacts: 1 rows/.test(r.out), `should parse one row:\n${r.out}`);
});

test('a development name fans out to every community under it', () => {
  const e = env();
  // "Alpha" should reach Alpha Ridge; it must not reach Beta Field.
  const r = run(e, { contacts: contactBook([
    { communities: 'Alpha', name: 'Cody Mason', phone: '111', email: 'cody.mason@lennar.com', acm: 'A Person' }
  ]) });
  eq(r.code, 0, `exit\n${r.out}`);
  const d = load(e);
  eq(JSON.stringify(byName(d, 'Alpha Ridge').cms), JSON.stringify(['cody.mason']), 'Alpha Ridge');
  eq(JSON.stringify(byName(d, 'Beta Field').cms), JSON.stringify(['a.person']), 'Beta Field should be untouched');
});

test('a cell naming two developments assigns to both', () => {
  const e = env();
  const r = run(e, { contacts: contactBook([
    { communities: 'Alpha and Beta', name: 'Cody Mason', phone: '111', email: 'cody.mason@lennar.com', acm: 'A Person' }
  ]) });
  eq(r.code, 0, `exit\n${r.out}`);
  const d = load(e);
  assert(byName(d, 'Alpha Ridge').cms.includes('cody.mason'), 'Alpha Ridge');
  assert(byName(d, 'Beta Field').cms.includes('cody.mason'), 'Beta Field');
});

test('&, / and "and" all separate developments', () => {
  for (const sep of [' and ', ' & ', '/', ' / ']) {
    const e = env();
    const r = run(e, { contacts: contactBook([
      { communities: 'Alpha' + sep + 'Beta', name: 'Cody Mason', phone: '111', email: 'cody.mason@lennar.com', acm: 'A Person' }
    ]) });
    eq(r.code, 0, `separator "${sep}" exit\n${r.out}`);
    const d = load(e);
    assert(byName(d, 'Beta Field').cms.includes('cody.mason'), `separator "${sep}" should reach Beta Field`);
  }
});

test('several managers on one development are all kept, in sheet order', () => {
  const e = env();
  const r = run(e, { contacts: contactBook([
    { communities: 'Alpha', name: 'First Person', phone: '1', email: 'first.person@lennar.com', acm: 'A Person' },
    { communities: 'Alpha', name: 'Second Person', phone: '2', email: 'second.person@lennar.com', acm: 'A Person' }
  ]) });
  eq(r.code, 0, `exit\n${r.out}`);
  eq(JSON.stringify(byName(load(e), 'Alpha Ridge').cms),
     JSON.stringify(['first.person', 'second.person']), 'both, in order');
});

test('contact emails are lowercased', () => {
  const e = env();
  run(e, { contacts: contactBook([
    { communities: 'Alpha', name: 'Cody Mason', phone: '111', email: 'Cody.Mason@Lennar.com', acm: 'A Person' }
  ]) });
  const p = JSON.parse(fs.readFileSync(e.pp, 'utf8')).people;
  eq(p['cody.mason'].email, 'cody.mason@lennar.com', 'email should be normalized');
});

test('a community the sheet does not mention keeps its existing contacts', () => {
  const e = env();
  const r = run(e, { contacts: contactBook([
    { communities: 'Alpha', name: 'Cody Mason', phone: '111', email: 'cody.mason@lennar.com', acm: 'A Person' }
  ]) });
  eq(JSON.stringify(byName(load(e), 'Beta Field').cms), JSON.stringify(['a.person']),
     'Beta Field must not be stripped just because the sheet omits it');
  assert(/not named in the contact sheet/.test(r.out), `should report it:\n${r.out}`);
  assert(/kept 1 existing/.test(r.out), `should say they were kept:\n${r.out}`);
});

test('--contacts-strict clears contacts for communities the sheet omits', () => {
  const e = env();
  const r = run(e, { contacts: contactBook([
    { communities: 'Alpha', name: 'Cody Mason', phone: '111', email: 'cody.mason@lennar.com', acm: 'A Person' }
  ]) }, ['--contacts-strict']);
  eq(r.code, 0, `exit\n${r.out}`);
  eq(byName(load(e), 'Beta Field').cms, undefined, 'Beta Field contacts should be cleared');
});

test('an unmatched development is reported, not silently dropped', () => {
  const e = env();
  const r = run(e, { contacts: contactBook([
    { communities: 'Nowhere Landing', name: 'Cody Mason', phone: '111', email: 'cody.mason@lennar.com', acm: 'A Person' }
  ]) });
  assert(/matched no community/.test(r.out), `should report:\n${r.out}`);
  assert(/Nowhere Landing/.test(r.out), 'should name it');
});

test('a manager matching nothing is not published', () => {
  const e = env();
  run(e, { contacts: contactBook([
    { communities: 'Nowhere Landing', name: 'Ghost Person', phone: '111', email: 'ghost.person@lennar.com', acm: 'A Person' }
  ]) });
  const p = JSON.parse(fs.readFileSync(e.pp, 'utf8')).people;
  assert(!p['ghost.person'], 'a manager assigned to nothing must not be published');
});

test('a manager no longer assigned anywhere is removed', () => {
  const e = env();
  // Give the two communities a distinct ACM, so the outgoing manager really is
  // referenced by nothing once the sheet replaces them. (a.person doubles as the
  // ACM in the default fixture, which is why they would otherwise be kept.)
  const d = JSON.parse(fs.readFileSync(e.dp, 'utf8'));
  d.communities.forEach(c => { c.acm = 'b.person'; });
  fs.writeFileSync(e.dp, JSON.stringify(d));
  fs.writeFileSync(e.pp, JSON.stringify({ people: {
    'a.person': { name: 'A Person', phone: '000', email: 'a@b.com', roles: ['cm'] },
    'b.person': { name: 'B Person', phone: '001', email: 'b@b.com', roles: ['acm'] }
  }}));

  const r = run(e, { contacts: contactBook([
    { communities: 'Alpha', name: 'Cody Mason', phone: '111', email: 'cody.mason@lennar.com', acm: 'B Person' },
    { communities: 'Beta', name: 'Cody Mason', phone: '111', email: 'cody.mason@lennar.com', acm: 'B Person' }
  ]) }, ['--contacts-strict']);
  eq(r.code, 0, `exit\n${r.out}`);
  const p = JSON.parse(fs.readFileSync(e.pp, 'utf8')).people;
  assert(!p['a.person'], 'the replaced manager should be dropped from people.json');
  assert(p['b.person'], 'the ACM must be kept — still referenced');
  assert(/removed 1 no longer assigned/.test(r.out), `should report:\n${r.out}`);
});

test('a manager the sheet drops but who is still an ACM is kept', () => {
  const e = env();
  // a.person is both the CM and the ACM in the fixture. Replacing them as CM
  // must not delete them, because communities still reference them as ACM.
  const r = run(e, { contacts: contactBook([
    { communities: 'Alpha', name: 'Cody Mason', phone: '111', email: 'cody.mason@lennar.com', acm: 'A Person' },
    { communities: 'Beta', name: 'Cody Mason', phone: '111', email: 'cody.mason@lennar.com', acm: 'A Person' }
  ]) }, ['--contacts-strict']);
  eq(r.code, 0, `exit\n${r.out}`);
  const p = JSON.parse(fs.readFileSync(e.pp, 'utf8')).people;
  assert(p['a.person'], 'still referenced as ACM, so must be kept');
});

test('the ACM column is applied, using details already on file', () => {
  const e = env();
  const r = run(e, { contacts: contactBook([
    { communities: 'Alpha', name: 'Cody Mason', phone: '111', email: 'cody.mason@lennar.com', acm: 'A Person' }
  ]) });
  eq(r.code, 0, `exit\n${r.out}`);
  eq(byName(load(e), 'Alpha Ridge').acm, 'a.person', 'ACM should resolve to the existing person id');
});

test('an ACM we have no details for is an error, not a silent gap', () => {
  const e = env();
  const r = run(e, { contacts: contactBook([
    { communities: 'Alpha', name: 'Cody Mason', phone: '111', email: 'cody.mason@lennar.com', acm: 'Nobody Known' }
  ]) });
  eq(r.code, 1, 'should refuse');
  assert(/no details for: "Nobody Known"/.test(r.out), `should name them:\n${r.out}`);
  assert(/nothing written/.test(r.out), 'must not write');
});

test('conflicting ACMs on one community leave it unchanged', () => {
  const e = env();
  const d = JSON.parse(fs.readFileSync(e.dp, 'utf8'));
  fs.writeFileSync(e.pp, JSON.stringify({ people: {
    'a.person': { name: 'A Person', phone: '000', email: 'a@b.com', roles: ['acm', 'cm'] },
    'b.person': { name: 'B Person', phone: '001', email: 'b@b.com', roles: ['acm'] }
  }}));
  fs.writeFileSync(e.dp, JSON.stringify(d));
  const r = run(e, { contacts: contactBook([
    { communities: 'Alpha', name: 'One', phone: '1', email: 'one@lennar.com', acm: 'A Person' },
    { communities: 'Alpha', name: 'Two', phone: '2', email: 'two@lennar.com', acm: 'B Person' }
  ]) });
  eq(r.code, 0, `exit\n${r.out}`);
  assert(/more than one area manager/.test(r.out), `should report the conflict:\n${r.out}`);
  eq(byName(load(e), 'Alpha Ridge').acm, 'a.person', 'should keep what was on file');
});

test('the alias table maps a development name onto a different map prefix', () => {
  const e = env();
  // Rename the fixture so it exercises the real Bridgewalk → Springhead alias.
  const d = JSON.parse(fs.readFileSync(e.dp, 'utf8'));
  d.communities[0].name = 'Springhead 25';
  d.communities[1].name = 'Springhead 40';
  fs.writeFileSync(e.dp, JSON.stringify(d));

  const r = run(e, { contacts: contactBook([
    { communities: 'Bridgewalk', name: 'Caleb Wayt', phone: '1', email: 'caleb.wayt@lennar.com', acm: 'A Person' }
  ]) });
  eq(r.code, 0, `exit\n${r.out}`);
  const out = load(e);
  assert(byName(out, 'Springhead 25').cms.includes('caleb.wayt'), 'Springhead 25 should be covered');
  assert(byName(out, 'Springhead 40').cms.includes('caleb.wayt'), 'Springhead 40 should be covered');
  assert(!/matched no community/.test(r.out), `Bridgewalk should not be reported unmatched:\n${r.out}`);
});

test('an alias with two targets matches either naming convention', () => {
  const e = env();
  // sanctuary → ['wellness', 'sanctuary']: covers the Wellness phases today and
  // a Sanctuary-named record if one ever appears.
  const d = JSON.parse(fs.readFileSync(e.dp, 'utf8'));
  d.communities[0].name = 'Wellness 22TH';
  d.communities[1].name = 'Sanctuary at Wellness';
  fs.writeFileSync(e.dp, JSON.stringify(d));

  const r = run(e, { contacts: contactBook([
    { communities: 'Sanctuary', name: 'Andrew Caruso', phone: '1', email: 'andrew.caruso@lennar.com', acm: 'A Person' }
  ]) });
  eq(r.code, 0, `exit\n${r.out}`);
  const out = load(e);
  assert(byName(out, 'Wellness 22TH').cms.includes('andrew.caruso'), 'Wellness phase should be covered');
  assert(byName(out, 'Sanctuary at Wellness').cms.includes('andrew.caruso'), 'a Sanctuary-named record should be covered');
});

test('a known non-map development is skipped, not reported as unmatched', () => {
  const e = env();
  const r = run(e, { contacts: contactBook([
    { communities: 'The Cove', name: 'Rhett Pendleton', phone: '1', email: 'rhett.pendleton@lennar.com', acm: 'A Person' }
  ]) });
  eq(r.code, 0, `exit\n${r.out}`);
  assert(!/matched no community/.test(r.out), `should not warn:\n${r.out}`);
  assert(/skipped 1 known non-map development/.test(r.out), `should note it:\n${r.out}`);
  assert(/The Cove/.test(r.out), 'should name it');
});

test('a manager whose only development is ignored is not published', () => {
  const e = env();
  run(e, { contacts: contactBook([
    { communities: 'The Cove', name: 'Rhett Pendleton', phone: '1', email: 'rhett.pendleton@lennar.com', acm: 'A Person' }
  ]) });
  const p = JSON.parse(fs.readFileSync(e.pp, 'utf8')).people;
  assert(!p['rhett.pendleton'], 'a manager covering only an ignored development must not be published');
});

test('a manager who also covers a real community is still published', () => {
  const e = env();
  // "Alpha and Lake Hamilton" — one half ignored, the other real.
  const r = run(e, { contacts: contactBook([
    { communities: 'Alpha and Lake Hamilton', name: 'Michael Doughty', phone: '1', email: 'michael.doughty@lennar.com', acm: 'A Person' }
  ]) });
  eq(r.code, 0, `exit\n${r.out}`);
  const p = JSON.parse(fs.readFileSync(e.pp, 'utf8')).people;
  assert(p['michael.doughty'], 'should still be published via the real community');
  assert(byName(load(e), 'Alpha Ridge').cms.includes('michael.doughty'), 'and assigned to it');
  assert(!/matched no community/.test(r.out), `the ignored half should not warn:\n${r.out}`);
});

test('an unknown development is still reported', () => {
  const e = env();
  const r = run(e, { contacts: contactBook([
    { communities: 'Somewhere New', name: 'Cody Mason', phone: '1', email: 'cody.mason@lennar.com', acm: 'A Person' }
  ]) });
  assert(/matched no community/.test(r.out), `the ignore list must not silence genuinely new names:\n${r.out}`);
  assert(/Somewhere New/.test(r.out), 'should name it');
});

test('a community awaiting contacts is a note, not a warning', () => {
  const e = env();
  const d = JSON.parse(fs.readFileSync(e.dp, 'utf8'));
  d.communities[1].name = 'Cloverleaf';       // on AWAITING_CONTACTS
  delete d.communities[1].cms;
  fs.writeFileSync(e.dp, JSON.stringify(d));

  const r = run(e, { contacts: contactBook([
    { communities: 'Alpha', name: 'Cody Mason', phone: '1', email: 'cody.mason@lennar.com', acm: 'A Person' }
  ]) });
  eq(r.code, 0, `exit\n${r.out}`);
  assert(/awaiting contact assignment: Cloverleaf/.test(r.out), `should note it:\n${r.out}`);
  assert(!/not named in the contact sheet/.test(r.out),
         `a known-expected gap must not raise the warning:\n${r.out}`);
});

test('a community that gains contacts is flagged for removal from the list', () => {
  const e = env();
  const d = JSON.parse(fs.readFileSync(e.dp, 'utf8'));
  d.communities[1].name = 'Cloverleaf';
  fs.writeFileSync(e.dp, JSON.stringify(d));

  // The sheet now covers it — the acknowledgement has served its purpose.
  const r = run(e, { contacts: contactBook([
    { communities: 'Cloverleaf', name: 'Cody Mason', phone: '1', email: 'cody.mason@lennar.com', acm: 'A Person' }
  ]) });
  eq(r.code, 0, `exit\n${r.out}`);
  assert(/gained contacts: Cloverleaf/.test(r.out), `should report it:\n${r.out}`);
  assert(/Remove them from AWAITING_CONTACTS/.test(r.out), 'should say what to do');
  assert(byName(load(e), 'Cloverleaf').cms.includes('cody.mason'), 'and still assign them');
});

test('a community not on either list still warns', () => {
  const e = env();
  const r = run(e, { contacts: contactBook([
    { communities: 'Alpha', name: 'Cody Mason', phone: '1', email: 'cody.mason@lennar.com', acm: 'A Person' }
  ]) });
  // Beta Field is on neither list and has contacts the sheet no longer covers.
  assert(/not named in the contact sheet/.test(r.out), `should warn:\n${r.out}`);
  assert(/Beta Field/.test(r.out), 'should name it');
  assert(/stale carry-over/.test(r.out), 'should explain why it matters');
});

test('a contact sheet with no Email column is refused', () => {
  const e = env();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Communities', 'Construction', 'Phone'], ['Alpha', 'Cody Mason', '111']
  ]), 'Sheet1');
  const r = run(e, { contacts: wb });
  eq(r.code, 1, 'should refuse');
  assert(/header row containing "Email"/.test(r.out), `should explain:\n${r.out}`);
});

test('without a contact sheet, contacts are preserved and the gap reported', () => {
  const e = env();
  const r = run(e, { starts: book('Start Log', [
    { Comm: 'Alpha Ridge', Job: '11110000123', 'Start (Prj)': dayIn(0, 5), 'Start (Act)': null }
  ]) });
  eq(JSON.stringify(byName(load(e), 'Alpha Ridge').cms), JSON.stringify(['a.person']), 'contacts preserved');
  assert(/NOT refreshed/.test(r.out), `should warn:\n${r.out}`);
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
