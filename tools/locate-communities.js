#!/usr/bin/env node
/**
 * locate-communities.js — place the communities that arrived without coordinates.
 *
 *   node tools/locate-communities.js --starts "August Start Schedule.xlsx"
 *   node tools/locate-communities.js --starts … --dry-run
 *   node tools/locate-communities.js --starts … --only "DeBary Village TH"
 *
 *   --starts      the division starts log — the source of the street names
 *   --dry-run     report what it would do, write nothing
 *   --only NAME   just this one community (repeatable)
 *   --max N       streets to try per community (default 6)
 *   --accept-single   apply a lone uncorroborated street. NOT the default; see below.
 *
 *   node tools/locate-communities.js --only "Ridgebrooke" --place "28.6607,-81.5458"
 *
 *   --place LAT,LON   set a coordinate by hand. Needs exactly one --only, reads
 *                     no workbook and makes no network call. Recorded as
 *                     `manual`, which means nothing ever moves it again.
 *
 *   --no-cis      skip the Community-DB lookup entirely
 *   --division    which division's sheets to read (default orlando)
 *
 * SUPABASE_KEY in the environment enables the Community-DB cross-reference,
 * which supplies each community's city and postcode. Optional: without it the
 * run works exactly as before, just with less to go on.
 *
 * Run after import-workbooks.js and before seed-supabase.js. Safe to re-run: a
 * community already located is skipped, and a community that cannot be resolved
 * is left exactly as it was with a note about what was tried.
 *
 * ── WHAT THIS DOES AND DOES NOT DECIDE ───────────────────────────────────────
 * It asks a geocoder where each of a community's streets is, and hands the
 * answers to map-core's resolveLocation(), which decides. Every rule about what
 * is trustworthy lives there and is unit-tested without a network; this file
 * only fetches, applies and reports.
 *
 * A community is placed only when two independent streets agree, or when one
 * street is corroborated by an already-located phase of the same development.
 * One street on its own is reported as a proposal and NOT applied, because a
 * same-named street in another town produces exactly that evidence. --accept-single
 * overrides that, and exists for the case where you have looked at the map
 * yourself and want to take the answer; it is not the default because the whole
 * point of this tool is that a wrong pin is worse than a missing one.
 */

'use strict';
const fs = require('fs');
const path = require('path');
const CORE = require('./map-core.js');
const GEO = require('./geo-client.js');

/* ── SheetJS ──────────────────────────────────────────────────────────────────
   Loaded here but not INSISTED on here: --place reads no workbook, and refusing
   to run it for want of a spreadsheet library would block the one path that is
   supposed to work when everything else does not.

   The ordinary resolution paths, plus XLSX_PATH when it is set. The
   unconditional /tmp/node_modules fallback that used to be here is gone: on a
   shared host that directory is writable by anyone, so an "xlsx" left there
   runs as this tool — which reads SUPABASE_KEY out of the environment a few
   lines below. XLSX_PATH serves the sandbox case it was there for, named by
   whoever runs the tool rather than by whoever wrote to /tmp first. */
let XLSX;
const XLSX_PATHS = ['xlsx'];
if (process.env.XLSX_PATH) XLSX_PATHS.push(path.join(process.env.XLSX_PATH, 'xlsx'));
for (const p of XLSX_PATHS) {
  try { XLSX = require(p); break; } catch { /* keep looking */ }
}

/* ── args ─────────────────────────────────────────────────────────────────── */
const args = process.argv.slice(2);
const has = f => args.includes(f);
/* A flag's value must not itself be a flag: `--starts --dry-run` is a forgotten
   filename, and reading "--dry-run" as the value went looking for a workbook by
   that name AND skipped the dry run that was asked for. Absent is the honest
   answer, and absent is a case every caller here already handles. */
const argOf = (f, d) => {
  const i = args.indexOf(f);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : d;
};
/* Same rule, and it matters more here than for argOf: --only collecting a flag
   as a community name matches nothing, so the run reports "0 communities
   awaiting a location" and reads as a clean success. */
const allOf = f => args.reduce(
  (a, v, i) => (args[i - 1] === f && !String(v).startsWith('--') ? a.concat(v) : a), []);

const STARTS = argOf('--starts', null);
const DATA   = argOf('--data', path.join(__dirname, '..', 'data.json'));
const DRY    = has('--dry-run');
const ONLY   = allOf('--only');
const MAX    = +argOf('--max', 6);
const ACCEPT_SINGLE = has('--accept-single');
const COUNTY = argOf('--county', null);   // optional hint, e.g. "Volusia County"
const PLACE  = argOf('--place', null);    // "28.6607,-81.5458", with --only

/* Community-DB, read for its city/postcode per community. Optional throughout —
   see fetchLocalities() below. The key comes from the environment by preference
   for the same reason seed-supabase.js prefers it: a key on the command line is
   written into shell history and is visible to anyone who can list processes. */
const DEFAULT_URL = 'https://memhzqphludiruovuzwt.supabase.co';
const URL_BASE = (argOf('--url', process.env.SUPABASE_URL || DEFAULT_URL) || '').replace(/\/+$/, '');

/* The key is a credential and --url decides where it is sent, so the two cannot
   be trusted independently. An unvalidated host means a mistyped — or pasted —
   URL forwards a service-role key to somebody else's server, and the request
   looks completely ordinary while it happens. Only the project's own host, or
   one explicitly allowed through the environment, gets to see it. */
function hostAllowed(u) {
  let h;
  try { h = new URL(u).host; } catch { return false; }
  const ok = [new URL(DEFAULT_URL).host]
    .concat((process.env.SUPABASE_ALLOWED_HOSTS || '').split(',').map(x => x.trim()).filter(Boolean));
  return ok.indexOf(h) !== -1;
}
const KEY      = argOf('--key', process.env.SUPABASE_KEY || '');
const DIVISION = argOf('--division', 'orlando');
const NO_CIS   = has('--no-cis');

/* Placing one by hand does not need the starts log, a geocoder or a network, so
   it is handled before any of that is required. Blueprint is the normal route;
   this exists because the README promises the Node path works when Blueprint
   does not, and without it the fallback cannot place anything at all —
   validate.js --fix needs an address, and these communities have none. */
if (PLACE) {
  if (ONLY.length !== 1) {
    console.error('--place needs exactly one --only "<community name>"');
    process.exit(2);
  }
  const pt = CORE.parseLatLon(PLACE);
  if (!pt) {
    console.error(`could not read "${PLACE}" as a coordinate — try "28.6607,-81.5458"`);
    process.exit(2);
  }
  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const rec = data.communities.find(c =>
    String(c.name).toLowerCase() === ONLY[0].toLowerCase());
  if (!rec) {
    console.error(`no community named "${ONLY[0]}" — check the spelling against data.json`);
    process.exit(2);
  }
  const r = CORE.placeManually(rec, pt.lat, pt.lon, { by: process.env.USERNAME || null });
  if (!r.ok) { console.error('  refused: ' + r.error); process.exit(1); }
  if (DRY) {
    console.log(`\n  --dry-run: would place ${rec.name} at ${r.lat},${r.lon}\n`);
  } else {
    writeJsonAtomic(DATA, data);
    console.log(`\n  placed ${rec.name} at ${r.lat},${r.lon} (manual — never auto-corrected)`);
    console.log('  next:  SUPABASE_KEY=<SERVICE_ROLE_KEY> node tools/seed-supabase.js\n');
  }
  process.exit(0);
}

if (!XLSX) {
  console.error('needs SheetJS:  npm install --no-save xlsx');
  process.exit(2);
}
if (!STARTS) {
  console.error('needs --starts <the division starts log .xlsx>');
  console.error('that is where the street names come from — every permit-log row');
  console.error('carries an Address, even before the lots are numbered.');
  process.exit(2);
}
if (typeof fetch !== 'function') {
  console.error('this node build has no global fetch — needs node 18+');
  process.exit(2);
}

/* ── writing ──────────────────────────────────────────────────────────────────
   Write beside the target, then rename over it — the same rule validate.js and
   import-workbooks.js follow, and for the same reason. writeFileSync truncates
   the file and then fills it, so an interruption in between leaves no data.json
   worth parsing rather than a stale one.

   This tool is the likeliest of the three to be interrupted: it makes one
   network call per street at roughly a second apiece, so a run over a handful of
   communities sits there for a minute or two looking idle, which is exactly when
   somebody reaches for Ctrl-C. A rename within one directory is atomic, so every
   reader sees either the whole old document or the whole new one — and the same
   directory is not incidental, since a rename across devices is a copy, which is
   the operation being avoided.                                                */
function writeJsonAtomic(file, value) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone, or never written */ }
    throw e;
  }
}

/* ── read the streets out of the starts log ───────────────────────────────── */

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
function startsSheet(wb) {
  return wb.SheetNames.includes('Start Log') ? 'Start Log'
       : wb.SheetNames.includes('START SCHEDULE') ? 'START SCHEDULE'
       : wb.SheetNames.includes('Permit Log') ? 'Permit Log'
       : wb.SheetNames[0];
}

/* ── where Community-DB thinks each community is ─────────────────────────────
   NOTE ON THE KEY. This reads a SIBLING APPLICATION's table, and the key it uses
   is the service role key, which bypasses row-level security everywhere. That is
   not a design choice so much as the only thing that works from a command line:
   cdb_cis is readable by a signed-in @lennar.com user and the anon key holds no
   privileges on any table, so there is no lesser credential a script can present.

   Two consequences worth being deliberate about. The host is validated before
   the key is sent anywhere, above. And Blueprint — which HAS a signed-in session
   — reads the same table through it instead, with RLS applying normally; that is
   the better route and the one to prefer when both are available.

   The permit log gives street names and nothing else. Community-DB's Community
   Information Sheets give the other half — "City, State, Zip" and the permitting
   municipality — against a JDE number that normalises to exactly the community
   number the map uses. It is an exact join, not a name match.

   Worth having for two reasons: it turns "SUNFISH DRIVE, FL, USA" into a
   question about a few square miles, and a postcode both the sheet and the
   geocoder agree on is independent corroboration that the street found is in the
   right town. See the long comment in map-core.js.

   ENTIRELY OPTIONAL. Without a key this returns nothing and the run proceeds
   exactly as it did before — fewer communities resolve, none resolve wrongly.
   The one thing it must not do is fail the run: a locator that stops working
   because an unrelated database is unreachable is worse than one that never
   read it. */
async function fetchLocalities() {
  if (NO_CIS) return { by: {}, note: '--no-cis: Community-DB was not consulted' };
  if (!KEY) {
    return { by: {}, note: 'no SUPABASE_KEY set, so Community-DB was not consulted — '
      + 'set it to narrow the search with each community\'s city and postcode' };
  }
  if (!hostAllowed(URL_BASE)) {
    return { by: {}, note: `refusing to send the key to ${URL_BASE} — not the project host. `
      + 'Set SUPABASE_ALLOWED_HOSTS if that is deliberate' };
  }
  const url = `${URL_BASE}/rest/v1/cdb_cis`
    + '?select=jde,status,data&jde=not.is.null'
    + `&division=eq.${encodeURIComponent(DIVISION)}`;
  try {
    const res = await fetch(url, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: 'application/json' }
    });
    if (!res.ok) {
      return { by: {}, note: `Community-DB returned HTTP ${res.status} — continuing without it` };
    }
    const rows = await res.json();
    const by = CORE.localitiesFrom(rows);
    const n = Object.keys(by).length;
    return { by, note: `Community-DB: ${rows.length} sheets read, ${n} with a usable locality` };
  } catch (e) {
    return { by: {}, note: `could not reach Community-DB (${(e && e.message) || e}) — continuing without it` };
  }
}

/* ── run ──────────────────────────────────────────────────────────────────── */

(async function main() {
  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));

  const wb = XLSX.read(fs.readFileSync(STARTS), { type: 'buffer' });
  const sheet = startsSheet(wb);
  const rows = XLSX.utils.sheet_to_json(fixRange(wb.Sheets[sheet]), { defval: null });
  const find = { notes: [], problems: [] };
  const { streets } = CORE.parseStarts(rows, sheet, find);

  const cis = await fetchLocalities();

  let queue = CORE.pendingLocations(data, streets);
  if (ONLY.length) {
    const want = new Set(ONLY.map(s => s.toLowerCase()));
    queue = queue.filter(q => want.has(q.name.toLowerCase()));
  }

  console.log('');
  console.log(`  sheet "${sheet}", ${rows.length} rows`);
  console.log(`  ${cis.note}`);
  console.log(`  ${queue.length} communit${queue.length === 1 ? 'y' : 'ies'} awaiting a location`);

  if (!queue.length) {
    console.log('\n  nothing to do — every community has a coordinate.\n');
    return;
  }

  // Everything already on the map, for sibling corroboration.
  const located = data.communities.filter(c =>
    Number.isFinite(c.lat) && Number.isFinite(c.lon) && !(c.lat === 0 && c.lon === 0));

  const applied = [], proposals = [], stuck = [];

  for (const q of queue) {
    const rec = data.communities.find(c => c.num === q.num);
    console.log('');
    console.log(`  ${q.name}  (${q.startsHidden} start${q.startsHidden === 1 ? '' : 's'} hidden)`);

    if (!q.streets.length) {
      const r = { status: 'pending', tried: [],
                  why: 'no street names are available for this community yet' };
      CORE.applyLocation(rec, r);
      stuck.push({ name: q.name, why: r.why });
      console.log('    · no streets in the log — nothing to look up');
      continue;
    }

    console.log(`    streets: ${q.streets.map(s => s.street).join(' | ')}`);

    /* The locality narrows the geocoder's question AND is checked against its
       answer. Both happen only when Community-DB has a sheet for this community;
       otherwise every gate behaves exactly as it did before. */
    const locality = cis.by[q.num] || null;
    if (locality) {
      console.log(`    ${locality.source} puts it in `
        + [locality.city, locality.county && locality.county + ' County', locality.zip]
            .filter(Boolean).join(', '));
    }

    const cands = await GEO.streetsFor(q.streets, {
      county: COUNTY, bbox: CORE.BBOX, maxLookups: MAX, locality,
      /* Which answers are worth stopping early for — the same gates
         resolveLocation applies, so the search does not give up after two
         answers that were never going to count. */
      accept: (h, street) => !!h && !h.error && CORE.inBox(h)
        && CORE.sameStreet(street, h.matchedStreet)
        && !((CORE.localityAgrees(locality, h) || {}).agrees === false),
      onProgress: name => process.stderr.write(`      looking up ${name}…\n`)
    });

    /* Anything already refused travels in with the request. A proposal a person
       has looked at and said no to must not come back every week — that is how
       a weekly report becomes something nobody reads. */
    const result = CORE.resolveLocation(cands, located,
      { name: q.name, locality, rejected: (rec.geo && rec.geo.rejected) || [] });

    // Report what each lookup actually did, because "pending" without the
    // reasons is not actionable.
    for (const t of result.tried) {
      console.log(`      ${t.street} → ${t.result}`);
    }

    if (result.status === 'located') {
      CORE.applyLocation(rec, result);
      located.push(rec);                 // can now corroborate a later sibling
      applied.push({ name: q.name, lat: rec.lat, lon: rec.lon,
                     confidence: result.confidence, evidence: result.evidence });
      console.log(`    ✓ placed at ${rec.lat},${rec.lon}  (${result.confidence})`);
      for (const e of result.evidence) console.log(`      ${e}`);

    } else if (result.status === 'proposed' && ACCEPT_SINGLE) {
      CORE.applyLocation(rec, Object.assign({}, result, { status: 'located', confidence: 'single' }));
      located.push(rec);
      applied.push({ name: q.name, lat: rec.lat, lon: rec.lon,
                     confidence: 'single (--accept-single)', evidence: result.evidence });
      console.log(`    ✓ placed at ${rec.lat},${rec.lon}  (single street, accepted by --accept-single)`);

    } else if (result.status === 'proposed') {
      CORE.applyLocation(rec, result);
      proposals.push({ name: q.name, lat: result.lat, lon: result.lon, why: result.why });
      console.log(`    ? ${result.lat},${result.lon} — NOT applied`);
      console.log(`      ${result.why}`);

    } else {
      CORE.applyLocation(rec, result);
      stuck.push({ name: q.name, why: result.why });
      console.log(`    · still pending — ${result.why}`);
    }
  }

  /* ── summary ─────────────────────────────────────────────────────────────
     Written last and read first. The counts are what tell you whether to do
     anything; the detail above is for when you do. */
  console.log('\n' + '─'.repeat(64));
  if (applied.length) {
    console.log(`  placed ${applied.length}:`);
    for (const a of applied) console.log(`    ✓ ${a.name.padEnd(22)}${a.lat},${a.lon}  (${a.confidence})`);
  }
  if (proposals.length) {
    console.log(`\n  ${proposals.length} awaiting your confirmation:`);
    for (const p of proposals) {
      console.log(`    ? ${p.name.padEnd(22)}${p.lat},${p.lon}`);
      console.log(`      ${p.why}`);
    }
    console.log('    Check these on a map. Confirm in Blueprint, or re-run with');
    console.log('    --accept-single --only "<name>" once you are satisfied.');
  }
  if (stuck.length) {
    console.log(`\n  ${stuck.length} still pending:`);
    for (const s of stuck) console.log(`    · ${s.name.padEnd(22)}${s.why}`);
  }

  const wrote = applied.length > 0;
  if (DRY) {
    console.log('\n  --dry-run: nothing written.\n');
    return;
  }

  /* Attempt records are written even when nothing was placed. That is the point
     of keeping them: the next run knows what has already been tried, and the UI
     can explain a pending community without re-deriving it. */
  writeJsonAtomic(DATA, data);
  console.log(`\n  wrote ${path.relative(process.cwd(), DATA)}`
    + (wrote ? '' : ' (attempt records only — no coordinates changed)'));
  if (wrote) {
    console.log('  next:  node tools/validate.js');
    console.log('  then:  SUPABASE_KEY=<SERVICE_ROLE_KEY> node tools/seed-supabase.js');
  }
  console.log('');
})().catch(e => {
  console.error('\n  failed: ' + ((e && e.stack) || e) + '\n');
  process.exit(1);
});
