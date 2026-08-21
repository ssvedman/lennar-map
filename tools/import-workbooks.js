#!/usr/bin/env node
/**
 * import-workbooks.js — rebuild data.json from the weekly spreadsheets.
 *
 *   node tools/import-workbooks.js --re2 RE2.xlsx --starts StartSchedule.xlsx \
 *                                  --contacts "Construction Community Contact.xlsx"
 *
 *   --re2        "Vendor Assignments" export from E1
 *   --starts     division start log/schedule, from permitting
 *   --contacts   Construction Community Contact export
 *   --dry-run    report only, write nothing
 *   --division   division code, default OLH
 *   --contacts-strict   clear contacts for communities the sheet omits
 *   --allow-growth      permit a run that more than doubles the community count
 *
 * Any source can be passed alone; the others are left untouched.
 * Follow with: node tools/validate.js --fix
 * Then:        SUPABASE_KEY=<SERVICE_ROLE_KEY> node tools/seed-supabase.js
 *
 * MERGE, NOT REBUILD. The workbooks carry starts, trade assignments and
 * contacts. Coordinates, municipality, utilities and plans exist only in
 * data.json and are preserved. New communities get a null coordinate and are
 * reported; validate.js --fix geocodes them.
 *
 * ── THIS FILE IS NOW A WRAPPER ───────────────────────────────────────────────
 * The parsing and the merge live in tools/map-core.js, which has no filesystem
 * or process dependencies and is loaded unchanged by Blueprint's Data Intake.
 * That is the point: the map is built from the same two workbooks as Vendor
 * Assignments, and three tools reading one spreadsheet three different ways is
 * how they end up disagreeing about which communities exist.
 *
 * What stays here is everything that is genuinely a command line: reading files,
 * choosing sheets, printing the report, and writing the result.
 */

'use strict';
const fs = require('fs');
const path = require('path');
const CORE = require('./map-core.js');

/* ── SheetJS ──────────────────────────────────────────────────────────────── */
let XLSX;
for (const p of ['xlsx', path.join(process.env.XLSX_PATH || '/tmp/node_modules', 'xlsx')]) {
  try { XLSX = require(p); break; } catch { /* keep looking */ }
}
if (!XLSX) {
  console.error('needs SheetJS:  npm install --no-save xlsx');
  process.exit(2);
}

/* ── args ─────────────────────────────────────────────────────────────────── */
const args = process.argv.slice(2);
const has = f => args.includes(f);
const argOf = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const RE2_FILE      = argOf('--re2', null);
const STARTS_FILE   = argOf('--starts', null);
const CONTACTS_FILE = argOf('--contacts', null);
// By default a community the contact sheet does not mention keeps whatever
// contacts it already has. The sheet is filtered at source (it excludes several
// job titles) and does not cover every community, so treating absence as
// "remove the contacts" would silently strip managers off the map.
const CONTACTS_STRICT = has('--contacts-strict');
// Overrides the refusal when a run would more than double the community count.
const ALLOW_GROWTH = has('--allow-growth');
const DATA     = argOf('--data', path.join(__dirname, '..', 'data.json'));
const PEOPLE   = argOf('--people', path.join(__dirname, '..', 'people.json'));
const DIV_CODE = argOf('--division', 'OLH');   // Orlando, per the sibling apps' config
const DRY      = has('--dry-run');

if (!RE2_FILE && !STARTS_FILE && !CONTACTS_FILE) {
  console.error('nothing to do — pass --starts, --re2 and/or --contacts');
  process.exit(2);
}

/* ── sheet access ─────────────────────────────────────────────────────────── */

const read = f => XLSX.read(fs.readFileSync(f), { type: 'buffer' });

// Some exports carry a header block above the table, which leaves the declared
// range starting at A1 and yields a sheet of empty columns.
function fixRange(ws) {
  if (!ws) return ws;
  let minR = Infinity, minC = Infinity, maxR = 0, maxC = 0, any = false;
  for (const k in ws) {
    if (k[0] === '!') continue;
    const c = XLSX.utils.decode_cell(k);
    any = true;
    if (c.r < minR) minR = c.r; if (c.c < minC) minC = c.c;
    if (c.r > maxR) maxR = c.r; if (c.c > maxC) maxC = c.c;
  }
  if (any) ws['!ref'] = XLSX.utils.encode_range({ s: { r: minR, c: minC }, e: { r: maxR, c: maxC } });
  return ws;
}

// "Permit Log" is named explicitly, last. The Orlando workbook has neither of
// the other two tabs and used to be found only by falling through to the first
// sheet — which worked solely because Permit Log happens to be first in the file.
function startsSheet(wb) {
  return wb.SheetNames.includes('Start Log') ? 'Start Log'
       : wb.SheetNames.includes('START SCHEDULE') ? 'START SCHEDULE'
       : wb.SheetNames.includes('Permit Log') ? 'Permit Log'
       : wb.SheetNames[0];
}

/* ── run ──────────────────────────────────────────────────────────────────── */
function main() {
  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const people = JSON.parse(fs.readFileSync(PEOPLE, 'utf8'));
  const find = { notes: [], problems: [] };

  // The rolling window starts at the current calendar month. Derived rather than
  // hand-edited: this value drives every next-3 figure and marker size on the
  // map, and hand-editing is exactly how it drifted before.
  const dataStart = CORE.currentDataStart();

  let startsAgg = null, idName = {}, re2 = null, contacts = null;

  if (STARTS_FILE) {
    const wb = read(STARTS_FILE);
    const sheet = startsSheet(wb);
    const rows = XLSX.utils.sheet_to_json(fixRange(wb.Sheets[sheet]), { defval: null });
    const parsed = CORE.parseStarts(rows, sheet, find);
    idName = parsed.idName;
    startsAgg = CORE.aggregateStarts(parsed.records, dataStart, find);
  }

  if (RE2_FILE) {
    const wb = read(RE2_FILE);
    const rows = XLSX.utils.sheet_to_json(fixRange(wb.Sheets[wb.SheetNames[0]]), { defval: null });
    re2 = CORE.parseRE2(rows, DIV_CODE, find);
  }

  if (CONTACTS_FILE) {
    // Matching is by name, so it needs the community list — which means this has
    // to run after the workbooks have had their say about which exist.
    const namesForMatch = new Set(data.communities.map(c => c.name));
    if (startsAgg) for (const id of startsAgg.keys()) namesForMatch.add(idName[id] || id);
    const wb = read(CONTACTS_FILE);
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null });
    try {
      contacts = CORE.parseContacts(grid, [...namesForMatch], find);
    } catch (e) {
      // A malformed sheet is an expected failure, not a crash.
      console.error('\n  errors\n    ✗ ' + e.message + '\n\n  nothing written.\n');
      process.exit(1);
    }
  }

  const result = CORE.buildDocument({
    data, people, startsAgg, idName, re2, contacts, dataStart,
    contactsStrict: CONTACTS_STRICT, allowGrowth: ALLOW_GROWTH,
    notes: find.notes, problems: find.problems
  });

  report(result);

  if (result.problems.length) {
    console.log('\n  errors');
    for (const p of result.problems) console.log('    ✗ ' + p);
    console.log('\n  nothing written.\n');
    process.exit(1);
  }

  if (DRY) {
    console.log('\n  --dry-run: nothing written.\n');
    return;
  }

  fs.writeFileSync(DATA, JSON.stringify(result.next));
  fs.writeFileSync(PEOPLE, JSON.stringify(result.people));
  console.log(`\n  wrote ${path.relative(process.cwd(), DATA)}`);
  console.log('  next:  node tools/validate.js --fix');
  console.log('  then:  SUPABASE_KEY=<SERVICE_ROLE_KEY> node tools/seed-supabase.js\n');
}

/* ── report ───────────────────────────────────────────────────────────────── */
function report(r) {
  console.log('');
  for (const n of r.notes) console.log('  · ' + n);

  console.log(`\n  ${r.totals.communities} communities · ${r.totals.starts} starts in the 12 months `
    + `from ${r.next.dataStart}`
    + `\n  ${r.totals.tradeCats} trade categories · ${r.totals.vendors} vendors`);

  const list = (label, arr) => {
    if (!arr.length) return;
    console.log(`\n  ${label} (${arr.length}):`);
    for (const n of arr.slice(0, 25)) console.log(`    ${n}`);
    if (arr.length > 25) console.log(`    …and ${arr.length - 25} more`);
  };
  list('new communities', r.added);
  list('no starts in this window (kept, not removed)', r.dormant);

  if (r.needGeo.length) {
    console.log(`\n  ⚠ ${r.needGeo.length} new communit${r.needGeo.length === 1 ? 'y has' : 'ies have'} no coordinates yet.`);
    console.log('    They are held off the map until located.');
    console.log('    Run:  node tools/validate.js --fix');
  }

  if (!r.coverage) {
    console.log('\n  ⚠ construction-manager assignments were NOT refreshed — no contact sheet.');
    console.log('    Existing contacts in people.json were preserved. Pass --contacts to refresh them.');
    return;
  }

  const c = r.coverage;

  // A development in the sheet that matches nothing on the map is either a new
  // one or a naming difference needing an alias. Either way a human has to look.
  if (c.unmatched.length) {
    console.log(`\n  ⚠ ${c.unmatched.length} entr${c.unmatched.length === 1 ? 'y' : 'ies'} `
      + 'in the contact sheet matched no community:');
    for (const u of c.unmatched) console.log(`      ${u}`);
    console.log('    Add an alias to COMMUNITY_ALIASES in tools/map-core.js, or ignore if not yet on the map.');
  }

  if (c.awaiting.length) {
    console.log(`\n  · ${c.awaiting.length} communit${c.awaiting.length === 1 ? 'y' : 'ies'} awaiting `
      + `contact assignment: ${c.awaiting.join(', ')}`);
  }

  if (c.nowStaffed.length) {
    console.log(`\n  ✓ ${c.nowStaffed.length} communit${c.nowStaffed.length === 1 ? 'y has' : 'ies have'} `
      + `gained contacts: ${c.nowStaffed.join(', ')}`);
    console.log('    Remove them from AWAITING_CONTACTS in tools/map-core.js.');
  }

  if (c.unexpected.length) {
    const kept = c.unexpected.filter(x => x.kept);
    console.log(`\n  ⚠ ${c.unexpected.length} communit${c.unexpected.length === 1 ? 'y is' : 'ies are'} `
      + 'not named in the contact sheet:');
    for (const x of c.unexpected.slice(0, 20)) {
      console.log(`      ${x.name}${x.kept ? '  (kept ' + x.kept + ' existing)' : '  (no contacts)'}`);
    }
    if (c.unexpected.length > 20) console.log(`      …and ${c.unexpected.length - 20} more`);
    if (kept.length && !CONTACTS_STRICT) {
      console.log(`    ${kept.length} kept the contacts already on file — now stale carry-over.`);
      console.log('    --contacts-strict would clear them instead.');
    }
  }
}

main();
