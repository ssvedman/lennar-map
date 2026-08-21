#!/usr/bin/env node
/* ============================================================================
   seed-supabase.js — load the committed data.json / people.json into map_data.

   Run once, after map_supabase_setup.sql, before pointing the site at the
   database. Until this runs, map_data has no row and index.html falls back to
   the files — which is harmless, but it also means you would not notice that the
   database side was never populated.

     SUPABASE_KEY=<SERVICE_ROLE_KEY> node tools/seed-supabase.js
     SUPABASE_KEY=<KEY> node tools/seed-supabase.js --dry-run
     SUPABASE_KEY=<KEY> node tools/seed-supabase.js --url https://xxxx.supabase.co --row orlando

   In PowerShell, set it first: $env:SUPABASE_KEY = '<KEY>'

   The anon key cannot write (RLS restricts insert/update to admin/editor in
   app_roles, and anon has no JWT), so use the service role key from
   Supabase Studio > Settings > API. Do not commit it, and prefer SUPABASE_KEY
   in the environment: --key still works, but a key spelled out on the command
   line is kept in your shell history and is visible in the process list to
   anyone else on the machine.

   Deliberately dependency-free: global fetch (Node 18+) and fs, matching the
   other tools in this directory.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const DATA_FILE   = path.join(REPO, 'data.json');
const PEOPLE_FILE = path.join(REPO, 'people.json');

const DEFAULT_URL = 'https://memhzqphludiruovuzwt.supabase.co';

/* ------------------------------------------------------------------ args */

/* A flag's value must not itself be a flag. `--row --dry-run` reads as a row
   named "--dry-run", so the run both seeds the wrong key and does the write it
   was being asked not to do — the one mistake here that is awkward to undo.
   Treating a --something as a missing value falls back to the default, which is
   what the caller who forgot the argument was going to get anyway. */
function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  const v = i !== -1 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : fallback;
}
const has = name => process.argv.indexOf('--' + name) !== -1;

const URL_BASE = (arg('url', process.env.SUPABASE_URL || DEFAULT_URL) || '').replace(/\/+$/, '');
const KEY      = arg('key', process.env.SUPABASE_KEY || '');
const ROW      = arg('row', 'orlando');
const LABEL    = arg('label', 'Orlando Division');
const DRY      = has('dry-run');
const ACTOR    = arg('by', 'seed-supabase.js');

/* The key is a credential and --url decides where it is sent, so the two cannot
   be trusted independently. An unvalidated host means a mistyped — or pasted —
   URL forwards a service-role key to somebody else's server, and the request
   looks completely ordinary while it happens. Only the project's own host, or
   one explicitly allowed through the environment, gets to see it.

   Deliberately the same function, the same override and the same wording as
   locate-communities.js. Two tools that send the same key to the same project
   but disagree about which hosts are acceptable are two separate things to
   check, and the one nobody checks is the one that leaks. */
function hostAllowed(u) {
  let h;
  try { h = new URL(u).host; } catch { return false; }
  const ok = [new URL(DEFAULT_URL).host]
    .concat((process.env.SUPABASE_ALLOWED_HOSTS || '').split(',').map(x => x.trim()).filter(Boolean));
  return ok.indexOf(h) !== -1;
}

if (typeof fetch !== 'function') {
  console.error('This script needs Node 18 or newer (global fetch).');
  process.exit(2);
}
/* Checked before anything is read, let alone sent. --dry-run is exempt because
   it makes no request at all — it only prints the target it would have used. */
if (!DRY && !hostAllowed(URL_BASE)) {
  console.error(`Refusing to send the key to ${URL_BASE} — that is not the project host.`);
  console.error('Set SUPABASE_ALLOWED_HOSTS to that host if it is deliberate, or --dry-run to');
  console.error('check the payload without a key going anywhere.');
  process.exit(2);
}
if (!DRY && !KEY) {
  console.error('Missing key. Set SUPABASE_KEY in the environment to the service role key (--key\n'
    + 'also works, but leaves the key in your shell history), or --dry-run to check the payload only.');
  process.exit(2);
}

/* ------------------------------------------------------------------ read */

function readJson(file, label) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`Could not read ${label} at ${file}: ${err.message}`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`${label} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
}

const data   = readJson(DATA_FILE, 'data.json');
const people = readJson(PEOPLE_FILE, 'people.json');

/* -------------------------------------------------------------- validate

   Refuse to seed something the map cannot render. Pushing a malformed document
   would leave the site fetching a row it then fails on, which is worse than the
   file fallback it replaces — the fallback only fires when the *fetch* fails.  */

const problems = [];
const comms = Array.isArray(data.communities) ? data.communities : null;

if (!comms)                     problems.push('data.json has no communities array');
if (comms && !comms.length)     problems.push('data.json has zero communities');
if (!data.dataStart)            problems.push('data.json is missing dataStart — the month window depends on it');
if (!/^\d{4}-\d{2}$/.test(data.dataStart || '')) problems.push(`dataStart "${data.dataStart}" is not YYYY-MM`);
if (!Array.isArray(data.tradeCats)) problems.push('data.json is missing the tradeCats lookup');
if (!Array.isArray(data.vendors))   problems.push('data.json is missing the vendors lookup');
if (!people || typeof people.people !== 'object') problems.push('people.json has no people object');

// Not fatal, but worth printing: these are the records the map will now hold back
// rather than plot at 0,0.
const unplaceable = (comms || []).filter(
  c => !Number.isFinite(c.lat) || !Number.isFinite(c.lon) || (c.lat === 0 && c.lon === 0)
);

// A starts array of the wrong length silently shifts every month in the heatmap,
// so check it here rather than discovering it as a visual bug.
const badStarts = (comms || []).filter(c => !Array.isArray(c.starts) || c.starts.length !== 12);
if (badStarts.length) {
  problems.push(`${badStarts.length} communities have a starts array that is not 12 long `
              + `(first: ${badStarts[0].name})`);
}

if (problems.length) {
  console.error('Refusing to seed:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

/* ------------------------------------------------------------------ report */

console.log(`source      : ${path.relative(process.cwd(), DATA_FILE)} + ${path.basename(PEOPLE_FILE)}`);
console.log(`generatedAt : ${data.generatedAt || '(none)'}`);
console.log(`dataStart   : ${data.dataStart}`);
console.log(`communities : ${comms.length}`);
console.log(`people      : ${Object.keys(people.people).length}`);
console.log(`tradeCats   : ${data.tradeCats.length}   vendors: ${data.vendors.length}`);
console.log(`target      : ${URL_BASE}/rest/v1/map_data  key='${ROW}'`);
if (unplaceable.length) {
  console.log(`\nnote        : ${unplaceable.length} community(ies) have no usable coordinates and will`);
  console.log(`              be held off the map until located:`);
  for (const c of unplaceable.slice(0, 10)) console.log(`                - ${c.name} (${c.num})`);
  if (unplaceable.length > 10) console.log(`                …and ${unplaceable.length - 10} more`);
}

if (DRY) {
  console.log('\n--dry-run: nothing was written.');
  process.exit(0);
}

/* ------------------------------------------------------------------ write */

// Upsert rather than insert so re-running is safe. prev_* are deliberately left
// alone: this is a seed, not a publish, and overwriting the rollback slot with
// the file contents would destroy whatever real previous version was there.
const row = {
  key: ROW,
  label: LABEL,
  payload: data,
  people: people,
  updated_at: new Date().toISOString(),
  updated_by: ACTOR
};

(async () => {
  const res = await fetch(`${URL_BASE}/rest/v1/map_data?on_conflict=key`, {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      // merge-duplicates makes this an upsert; return=representation so a
      // silently-filtered write (RLS) shows up as an empty array rather than 201.
      Prefer: 'resolution=merge-duplicates,return=representation'
    },
    body: JSON.stringify([row])
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`\nWrite failed: HTTP ${res.status}`);
    console.error(text.slice(0, 500));
    if (res.status === 401 || res.status === 403) {
      console.error('\nThat key is not allowed to write map_data. The anon key never is —');
      console.error('use the service role key, or sign in as an app_roles admin/editor.');
    }
    process.exit(1);
  }

  let returned;
  try { returned = JSON.parse(text); } catch (_) { returned = null; }
  if (Array.isArray(returned) && returned.length === 0) {
    console.error('\nThe request succeeded but wrote nothing — RLS filtered it out.');
    console.error('Check map_can_write() against the identity behind this key.');
    process.exit(1);
  }

  console.log(`\nSeeded map_data key='${ROW}'.`);
  console.log('The site will now read from the database; data.json stays as the offline fallback.');
})().catch(err => {
  console.error(`\nWrite failed: ${err && err.message || err}`);
  process.exit(1);
});
