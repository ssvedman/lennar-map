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
 *
 * Any source can be passed alone; the others are left untouched.
 * Follow with: node tools/validate.js --fix
 *
 * MERGE, NOT REBUILD. The workbooks carry starts, trade assignments and
 * contacts. Coordinates, municipality, utilities and plans exist only in
 * data.json and are preserved. New communities get a null coordinate and are
 * reported; validate.js --fix geocodes them.
 *
 * Parsing mirrors `buildDivision()` in the Vendor Assignments app — same sheet
 * detection, column aliases and community-number normalization. Three tools
 * reading one spreadsheet three different ways is how they end up disagreeing
 * about which communities exist.
 */

'use strict';
const fs = require('fs');
const path = require('path');

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

const RE2_FILE     = argOf('--re2', null);
const STARTS_FILE  = argOf('--starts', null);
const CONTACTS_FILE = argOf('--contacts', null);
// By default a community the contact sheet does not mention keeps whatever
// contacts it already has. The sheet is filtered at source (it excludes several
// job titles) and does not cover every community, so treating absence as
// "remove the contacts" would silently strip managers off the map. --contacts-strict
// opts into treating the sheet as the whole truth.
const CONTACTS_STRICT = has('--contacts-strict');
const DATA         = argOf('--data', path.join(__dirname, '..', 'data.json'));
const PEOPLE       = argOf('--people', path.join(__dirname, '..', 'people.json'));
const DIV_CODE     = argOf('--division', 'OLH');   // Orlando, per the sibling apps' config
const DRY          = has('--dry-run');

if (!RE2_FILE && !STARTS_FILE && !CONTACTS_FILE) {
  console.error('nothing to do — pass --starts, --re2 and/or --contacts');
  process.exit(2);
}

/* ── helpers, lifted from the Vendor Assignments pipeline ─────────────────── */
const S = v => (v == null ? null : String(v).trim() || null);
const digits = v => String(v == null ? '' : v).replace(/\D/g, '');

// A job number carries the community in its first 7 digits; the map keys
// communities by the 11-digit form. "26382720000" → 2638272 + 0000.
const normCommunityId = v => {
  const d = digits(v);
  if (!d) return null;
  return d.length >= 11 ? d.slice(0, 7) + '0000' : d;
};

function xlDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// Some exports carry a header block above the table, which leaves the declared
// range starting at A1 and yields a sheet of empty columns. Same fix the sibling
// app applies.
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

const cleanCommName = desc =>
  !desc ? null : (desc.replace(/\(.*?\)/g, '').replace(/[-*].*$/, '').trim() || null);

const read = f => XLSX.read(fs.readFileSync(f), { type: 'buffer' });
const notes = [], problems = [];

/* ── starts ───────────────────────────────────────────────────────────────── */
/**
 * Returns { records: [{id, community, date, kind}], idName: {id: name} }
 * Two layouts are seen in the wild; both are handled, as in the sibling app.
 */
function parseStarts(wb) {
  const sheet = wb.SheetNames.includes('Start Log') ? 'Start Log'
              : wb.SheetNames.includes('START SCHEDULE') ? 'START SCHEDULE'
              : wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(fixRange(wb.Sheets[sheet]), { defval: null });
  const records = [], idName = {};
  let skipped = 0;

  for (const r of rows) {
    let community = null, date = null, kind = 'Projected', job = null;

    if (r['Comm'] != null) {
      community = S(r['Comm']);
      const p = r['Start (Prj)'], a = r['Start (Act)'];
      date = xlDate(a || p); kind = a ? 'Actual' : 'Projected'; job = r['Job'];
    } else if (r['Project'] != null) {
      const proj = S(r['Project']) || '';
      community = proj.includes(' - ') ? proj.split(' - ').slice(1).join(' - ').trim() : proj;
      const p = r['PrjStart'], a = r['ActStart'];
      date = xlDate(a || p); kind = a ? 'Actual' : 'Projected'; job = r['Job'];
    }

    if (!community || !date) { skipped++; continue; }
    const id = normCommunityId(job);
    if (id) idName[id] = community;
    records.push({ id, community, date, kind });
  }

  notes.push(`starts: sheet "${sheet}", ${rows.length} rows → ${records.length} start records`
    + (skipped ? `, ${skipped} skipped (no community or no date)` : ''));
  if (!records.length) problems.push('the starts workbook produced no usable rows — wrong file, or the columns have been renamed');
  return { records, idName };
}

/**
 * The placeholder filter. Inherited from a comment the previous tooling left in
 * the data it generated:
 *   "any day where a single community has >10 starts on the same date is
 *    excluded as a placeholder."
 * Schedulers park a block of homes on a single nominal date; counting those as
 * real starts would spike a month that has nothing actually happening in it.
 *
 * Confirmed as correct — 10 is the intended threshold, not just an inherited
 * guess. A community-day of exactly 10 is real and is kept; 11 or more is a
 * placeholder and is dropped.
 */
const PLACEHOLDER_PER_DAY = 10;

function aggregateStarts(records, dataStart) {
  const [y0, m0] = dataStart.split('-').map(Number);
  const base = y0 * 12 + (m0 - 1);

  const perDay = new Map(); // id|date -> count
  for (const r of records) {
    if (!r.id) continue;
    const k = r.id + '|' + r.date;
    perDay.set(k, (perDay.get(k) || 0) + 1);
  }

  let dropped = 0, droppedDays = 0;
  const byCommunity = new Map(); // id -> number[12]

  for (const [k, count] of perDay) {
    if (count > PLACEHOLDER_PER_DAY) { dropped += count; droppedDays++; continue; }
    const [id, date] = k.split('|');
    const d = new Date(date + 'T00:00:00Z');
    const slot = (d.getUTCFullYear() * 12 + d.getUTCMonth()) - base;
    if (slot < 0 || slot > 11) continue; // outside the rolling window
    if (!byCommunity.has(id)) byCommunity.set(id, new Array(12).fill(0));
    byCommunity.get(id)[slot] += count;
  }

  if (droppedDays) {
    notes.push(`placeholder filter: dropped ${dropped} starts across ${droppedDays} `
      + `community-days with more than ${PLACEHOLDER_PER_DAY} on one date`);
  }
  return byCommunity;
}

/* ── RE2 vendor assignments ───────────────────────────────────────────────── */
function parseRE2(wb, code) {
  const rows = XLSX.utils.sheet_to_json(fixRange(wb.Sheets[wb.SheetNames[0]]), { defval: null });
  const today = new Date().toISOString().slice(0, 10);
  const byCommunity = new Map(); // id -> {cat: vendor}
  const nameHint = new Map();
  const divCounts = {};
  let expired = 0, matched = 0;

  for (const r of rows) {
    const div = S(r['Division']);
    if (div) divCounts[div.toUpperCase()] = (divCounts[div.toUpperCase()] || 0) + 1;
    if (div && code && div.toUpperCase() !== code.toUpperCase()) continue;

    const vendor = S(r['Supplier Desc']);
    const cat = S(r['Trade Desc.']) || S(r['Trade Desc']);
    if (!vendor || !cat || cat === '.') continue;

    const exp = xlDate(r['Expired Date']);
    if (exp && exp < today) { expired++; continue; }

    const id = normCommunityId(r['Community']);
    if (!id) continue;

    matched++;
    if (!byCommunity.has(id)) byCommunity.set(id, {});
    byCommunity.get(id)[cat] = vendor;
    const nm = cleanCommName(S(r['Description']));
    if (nm && !nameHint.has(id)) nameHint.set(id, nm);
  }

  notes.push(`RE2: ${rows.length} rows, ${matched} for division ${code}`
    + (expired ? `, ${expired} expired assignments skipped` : ''));

  // The same guard the sibling app shows before publishing: a file for the wrong
  // division parses cleanly and produces almost nothing, which is easy to miss.
  const top = Object.keys(divCounts).sort((a, b) => divCounts[b] - divCounts[a])[0];
  if (!matched && rows.length) {
    problems.push(`no RE2 rows match division ${code} — this looks like the wrong file`
      + (top ? ` (it is mostly ${top})` : ''));
  } else if (top && top !== code.toUpperCase()) {
    notes.push(`note: the RE2 file is mostly division ${top}; ${matched} rows are ${code}`);
  }
  return { byCommunity, nameHint };
}

/* ── contacts ─────────────────────────────────────────────────────────────── *
 * The "Construction Community Contact" sheet: community managers, their phone
 * and email, and the area manager over them.
 *
 * The awkward part is that it names DEVELOPMENTS while the map names
 * COMMUNITIES. The sheet says "Wellness Ridge"; the map has Wellness 22TH,
 * Wellness 32, Wellness 40FLGC and six more. It says "Ranches at Mcleod"; the
 * map has Ranches 40GC, 50GC, 60 and 60GC. One row therefore fans out to
 * several communities, and a cell can name more than one development
 * ("Westview and Waterlin", "Meadow Pointe & Hidden Ridge").
 *
 * There is no community number anywhere in the sheet, so matching is by name.
 * Most of it falls out of comparing normalized prefixes; the rest needs the
 * alias table below. When a new development appears it will be reported as
 * unmatched rather than silently dropped — add an alias and re-run.
 */

// Sheet name (normalized) → the map's name prefix, for the cases where the two
// naming conventions genuinely differ rather than just adding a suffix.
const COMMUNITY_ALIASES = {
  scenicterrace:         'scenicterr',
  ranchesatmcleod:       'ranches',
  providencegardenhills: ['provgarden', 'providence'],
  theparksofedgewater:   'edgewater',
  wellnessridge:         'wellness',

  // Bridgewalk is the development; the map lists its phases as Springhead 25,
  // 25GC, 40, 50 and 60. Confirmed independently: the five managers on the
  // Bridgewalk rows are exactly the five already assigned to Springhead.
  bridgewalk:            'springhead',

  // "Sanctuary at Wellness" — always written as "Wellness Ridge/Sanctuary" in
  // the sheet, so today it resolves to the same Wellness phases that row already
  // covers. The second key is there so that if a Sanctuary record ever appears
  // on the map under its own name it is picked up rather than silently missed.
  sanctuary:             ['wellness', 'sanctuary']
};

// "Westview and Waterlin" · "Meadow Pointe & Hidden Ridge" · "Peace Creek TH / Lake Hamilton"
const COMMUNITY_SPLIT = /\s+and\s+|\s*&\s*|\s*\/\s*/i;

// Developments named in the contact sheet that deliberately do not appear on the
// map. Without this they would be reported as unmatched on every single run,
// which trains people to ignore that warning — the one warning that catches a
// genuinely new development. Listed explicitly so the decision is visible and
// reversible rather than the entry silently vanishing.
//
// Both still carry a manager and an area manager in the sheet. The consequence
// of ignoring them is that a manager whose ONLY development is on this list is
// not published anywhere — currently Rhett Pendleton, whose sole entry is The
// Cove. Michael Doughty is unaffected: he also covers Peace Creek TH.
const IGNORED_DEVELOPMENTS = {
  thecove:      'not a community on the map',
  lakehamilton: 'not a community on the map'
};

// Communities on the map that legitimately have nobody assigned yet — new
// projects that have not reached the contact sheet. Without this they are
// reported every week as though something were wrong, which is the same noise
// problem as IGNORED_DEVELOPMENTS above.
//
// Unlike that list, this one is temporary by nature: these will gain contacts.
// So the importer checks it both ways — a community here that HAS gained
// contacts is reported so the entry can be deleted, and the list cannot quietly
// rot into a permanent excuse.
const AWAITING_CONTACTS = {
  cloverleaf:    'new project, no contacts assigned yet',
  cypressrsrvth: 'new project, no contacts assigned yet',
  ridgebrooke:   'new project, no contacts assigned yet'
};

const normName = v => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');

// Person ids are the email local part, lowercased. Stable across runs, so a
// community's cms[] does not churn when the sheet is re-imported.
const personIdFor = email => String(email).split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '.');

function parseContacts(wb, communityNames) {
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null });

  // The export carries a block of applied-filter text above the table, so the
  // header is not row 0. Find it rather than hard-coding an offset that a
  // slightly different export would break.
  const headerRow = grid.findIndex(r =>
    Array.isArray(r) && r.some(c => /e-?mail/i.test(String(c || ''))));
  if (headerRow < 0) {
    throw new Error('could not find a header row containing "Email" in the contact sheet');
  }

  // Headers carry trailing spaces ("Communities ", "Construction ").
  const col = {};
  grid[headerRow].forEach((h, i) => {
    const k = String(h == null ? '' : h).trim().toLowerCase();
    if (/^communit/.test(k)) col.communities = i;
    else if (/^construction|^name/.test(k)) col.name = i;
    else if (/^phone/.test(k)) col.phone = i;
    else if (/^e-?mail/.test(k)) col.email = i;
    else if (/acm/.test(k)) col.acm = i;
  });
  for (const need of ['communities', 'name', 'email']) {
    if (col[need] == null) throw new Error(`contact sheet is missing a "${need}" column`);
  }

  const targets = communityNames.map(n => ({ name: n, n: normName(n) }));
  const matchToken = tok => {
    const t = normName(tok);
    if (!t) return [];
    let keys = COMMUNITY_ALIASES[t] || t;
    if (!Array.isArray(keys)) keys = [keys];
    return targets.filter(c => keys.some(k => c.n.startsWith(k))).map(c => c.name);
  };

  const people = {};           // id -> person
  const cmsFor = new Map();    // community -> [ids], in sheet order
  const acmFor = new Map();    // community -> Set(acm name)
  const unmatched = new Set();
  const ignored = new Set();
  const acmNames = new Set();
  let rowCount = 0;

  for (const r of grid.slice(headerRow + 1)) {
    if (!Array.isArray(r)) continue;
    const comms = S(r[col.communities]);
    const name  = S(r[col.name]);
    const email = S(r[col.email]);
    if (!comms || !name || !email) continue;
    rowCount++;

    const id = personIdFor(email);
    if (!people[id]) {
      people[id] = {
        name,
        phone: S(r[col.phone]),
        email: email.toLowerCase(),   // the source mixes casing
        roles: ['cm']
      };
    }

    const acm = col.acm != null ? S(r[col.acm]) : null;
    if (acm) acmNames.add(acm);

    let hitAny = false;
    for (const tok of String(comms).split(COMMUNITY_SPLIT)) {
      const t = tok.trim();
      if (!t) continue;
      const hits = matchToken(t);
      if (!hits.length) {
        if (normName(t) in IGNORED_DEVELOPMENTS) ignored.add(t);
        else unmatched.add(t);
        continue;
      }
      hitAny = true;
      for (const c of hits) {
        if (!cmsFor.has(c)) cmsFor.set(c, []);
        if (!cmsFor.get(c).includes(id)) cmsFor.get(c).push(id);
        if (acm) {
          if (!acmFor.has(c)) acmFor.set(c, new Set());
          acmFor.get(c).add(acm);
        }
      }
    }
    if (!hitAny) delete people[id];   // nobody references them; do not publish them
  }

  notes.push(`contacts: ${rowCount} rows → ${Object.keys(people).length} managers `
    + `across ${cmsFor.size} communities`);
  if (!rowCount) problems.push('the contact sheet produced no usable rows — wrong file, or the columns have been renamed');

  // Reported as a one-line note rather than a warning: visible, not alarming.
  if (ignored.size) {
    notes.push(`contacts: skipped ${ignored.size} known non-map development`
      + `${ignored.size === 1 ? '' : 's'} (${[...ignored].join(', ')})`);
  }

  return { people, cmsFor, acmFor, unmatched: [...unmatched],
           ignored: [...ignored], acmNames: [...acmNames] };
}

/* ── merge ────────────────────────────────────────────────────────────────── */
function main() {
  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const people = JSON.parse(fs.readFileSync(PEOPLE, 'utf8'));

  // The rolling window starts at the current calendar month. Emitted here rather
  // than hand-edited: this value drives every next-3 figure and marker size on
  // the map, and hand-editing is exactly how it drifted before.
  const now = new Date();
  const dataStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  let startsAgg = null, idName = {}, re2 = null;

  if (STARTS_FILE) {
    const { records, idName: n } = parseStarts(read(STARTS_FILE));
    idName = n;
    startsAgg = aggregateStarts(records, dataStart);
  }
  if (RE2_FILE) re2 = parseRE2(read(RE2_FILE), DIV_CODE);

  let contacts = null;

  // Existing records, keyed by community number.
  const existing = new Map(data.communities.map(c => [c.num, c]));

  if (CONTACTS_FILE) {
    // Matching is by name, so it needs the community list — which means this has
    // to run after the workbooks have had their say about which exist.
    const namesForMatch = new Set(data.communities.map(c => c.name));
    if (startsAgg) for (const id of startsAgg.keys()) namesForMatch.add(idName[id] || id);
    try {
      contacts = parseContacts(read(CONTACTS_FILE), [...namesForMatch]);
    } catch (e) {
      // A malformed sheet is an expected failure, not a crash.
      console.error('\n  errors\n    ✗ ' + e.message + '\n\n  nothing written.\n');
      process.exit(1);
    }

    // The area managers are named in the sheet but their phone and email are
    // not, so carry those across from the people already on file.
    const acmByName = new Map();
    for (const [id, p] of Object.entries(people.people || {})) {
      if (p.name) acmByName.set(p.name, id);
    }
    for (const n of contacts.acmNames) {
      if (!acmByName.has(n)) {
        problems.push(`the contact sheet names an area manager we have no details for: "${n}"`
          + ' — add them to people.json (name, phone, email) and re-run');
      }
    }
    contacts.acmId = n => acmByName.get(n) || null;
  }

  // Which communities should exist after this run. With only one workbook
  // supplied, the other's communities are left alone rather than deleted.
  const ids = new Set();
  if (startsAgg) for (const id of startsAgg.keys()) ids.add(id);
  if (re2) for (const id of re2.byCommunity.keys()) ids.add(id);
  if (!startsAgg || !re2) for (const id of existing.keys()) ids.add(id);

  const cats = data.tradeCats.slice();
  const vendors = data.vendors.slice();
  const catIdx = new Map(cats.map((c, i) => [c, i]));
  const venIdx = new Map(vendors.map((v, i) => [v, i]));
  const intern = (list, idx, v) => {
    if (!idx.has(v)) { idx.set(v, list.length); list.push(v); }
    return idx.get(v);
  };

  const out = [];
  const added = [], removed = [], needGeo = [];

  for (const id of ids) {
    const prev = existing.get(id);
    const rec = prev
      ? Object.assign({}, prev)
      : {
          // A new community carries no coordinate. Rather than invent one, it is
          // written null and reported; validate.js --fix will geocode it, and
          // until then the schema check fails loudly rather than dropping a pin
          // in the Gulf of Mexico.
          name: (idName[id] || (re2 && re2.nameHint.get(id)) || id),
          num: id, addr: '', lat: null, lon: null,
          starts: new Array(12).fill(0)
        };

    if (!prev) { added.push(rec.name); needGeo.push(rec.name); }
    if (idName[id]) rec.name = idName[id];

    if (startsAgg) {
      rec.starts = startsAgg.get(id) || new Array(12).fill(0);
      // "unforecasted" means no schedule exists yet, which is different from a
      // schedule of zero. Only the contact/scheduling side can clear it.
      if (rec.starts.some(v => v > 0)) delete rec.unforecasted;
    }

    if (contacts) {
      const cms = contacts.cmsFor.get(rec.name);
      if (cms && cms.length) {
        rec.cms = cms;
        const acmSet = contacts.acmFor.get(rec.name);
        if (acmSet && acmSet.size === 1) {
          const aid = contacts.acmId([...acmSet][0]);
          if (aid) rec.acm = aid;
        } else if (acmSet && acmSet.size > 1) {
          // Two rows disagree about who the area manager is. Leave whatever is
          // on file rather than picking one arbitrarily.
          notes.push(`${rec.name}: contact sheet lists more than one area manager `
            + `(${[...acmSet].join(', ')}) — left unchanged`);
        }
      } else if (CONTACTS_STRICT) {
        delete rec.cms;
      }
    }

    if (re2) {
      const t = re2.byCommunity.get(id);
      if (t) {
        const m = {};
        for (const [cat, ven] of Object.entries(t)) {
          m[intern(cats, catIdx, cat)] = intern(vendors, venIdx, ven);
        }
        rec.trades = m;
      } else {
        delete rec.trades;
      }
    }

    out.push(rec);
  }

  for (const [id, c] of existing) if (!ids.has(id)) removed.push(c.name);

  out.sort((a, b) => a.name.localeCompare(b.name));

  // Drop trade categories and vendors nothing references any more, so the
  // lookups do not grow forever.
  const usedCat = new Set(), usedVen = new Set();
  for (const c of out) for (const [ci, vi] of Object.entries(c.trades || {})) {
    usedCat.add(+ci); usedVen.add(vi);
  }
  const catRemap = new Map(), venRemap = new Map();
  const newCats = [], newVendors = [];
  cats.forEach((c, i) => { if (usedCat.has(i)) { catRemap.set(i, newCats.length); newCats.push(c); } });
  vendors.forEach((v, i) => { if (usedVen.has(i)) { venRemap.set(i, newVendors.length); newVendors.push(v); } });
  for (const c of out) {
    if (!c.trades) continue;
    const m = {};
    for (const [ci, vi] of Object.entries(c.trades)) m[catRemap.get(+ci)] = venRemap.get(vi);
    c.trades = m;
  }

  // ── people ──────────────────────────────────────────────────────────────
  // The sheet is the source for community managers. Anyone it no longer lists
  // but who is still referenced by a community keeps their entry — that happens
  // when the sheet does not cover a community and its existing contacts were
  // preserved above. Anyone referenced by nobody is dropped, because a contact
  // nobody links to is still published.
  if (contacts) {
    const merged = Object.assign({}, people.people || {});
    for (const [id, p] of Object.entries(contacts.people)) {
      const prev = merged[id] || {};
      merged[id] = {
        name: p.name || prev.name || null,
        phone: p.phone || prev.phone || null,
        email: p.email || prev.email || null,
        roles: [...new Set([...(prev.roles || []), 'cm'])]
      };
    }
    const referenced = new Set(out.flatMap(c => [].concat(c.cms || [], c.acm ? [c.acm] : [])));
    const dropped = [];
    for (const id of Object.keys(merged)) {
      if (!referenced.has(id)) { dropped.push(merged[id].name || id); delete merged[id]; }
    }
    people.people = merged;
    if (dropped.length) notes.push(`people: removed ${dropped.length} no longer assigned anywhere `
      + `(${dropped.slice(0, 6).join(', ')}${dropped.length > 6 ? ', …' : ''})`);
  }

  const next = {
    generatedAt: new Date().toISOString(),
    updateCadenceDays: data.updateCadenceDays || 7,
    dataStart,
    tradeCats: newCats,
    vendors: newVendors,
    communities: out
  };

  /* ── report ─────────────────────────────────────────────────────────────── */
  console.log('');
  for (const n of notes) console.log('  · ' + n);

  const totalStarts = out.reduce((a, c) => a + c.starts.reduce((x, y) => x + y, 0), 0);
  console.log(`\n  ${out.length} communities · ${totalStarts} starts in the 12 months from ${dataStart}`
    + `\n  ${newCats.length} trade categories · ${newVendors.length} vendors`);

  const list = (label, arr) => {
    if (!arr.length) return;
    console.log(`\n  ${label} (${arr.length}):`);
    for (const n of arr.slice(0, 25)) console.log(`    ${n}`);
    if (arr.length > 25) console.log(`    …and ${arr.length - 25} more`);
  };
  list('new communities', added);
  list('no longer present', removed);

  if (needGeo.length) {
    console.log(`\n  ⚠ ${needGeo.length} new communit${needGeo.length === 1 ? 'y has' : 'ies have'} no coordinates yet.`);
    console.log('    Run:  node tools/validate.js --fix');
  }
  if (!CONTACTS_FILE) {
    console.log('\n  ⚠ construction-manager assignments were NOT refreshed — no contact sheet.');
    console.log('    Existing contacts in people.json were preserved. Pass --contacts to refresh them.');
  } else {
    // A development in the sheet that matches nothing on the map is either a new
    // one or a naming difference needing an alias. Either way a human has to
    // look, so it is listed rather than counted.
    if (contacts.unmatched.length) {
      console.log(`\n  ⚠ ${contacts.unmatched.length} entr${contacts.unmatched.length === 1 ? 'y' : 'ies'} `
        + 'in the contact sheet matched no community:');
      for (const u of contacts.unmatched) console.log(`      ${u}`);
      console.log('    Add an alias to COMMUNITY_ALIASES in this file, or ignore if not yet on the map.');
    }
    const uncovered = out.filter(c => !contacts.cmsFor.has(c.name));

    // Known-and-expected gaps are a note; anything else is a warning. A
    // community that HAS contacts but is no longer in the sheet is the case
    // worth attention — those contacts are now stale carry-over.
    const awaiting = uncovered.filter(c => normName(c.name) in AWAITING_CONTACTS);
    const unexpected = uncovered.filter(c => !(normName(c.name) in AWAITING_CONTACTS));

    if (awaiting.length) {
      console.log(`\n  · ${awaiting.length} communit${awaiting.length === 1 ? 'y' : 'ies'} awaiting `
        + `contact assignment: ${awaiting.map(c => c.name).join(', ')}`);
    }

    // The list has to prune itself, or it becomes a permanent excuse.
    const nowStaffed = out.filter(c =>
      normName(c.name) in AWAITING_CONTACTS && contacts.cmsFor.has(c.name));
    if (nowStaffed.length) {
      console.log(`\n  ✓ ${nowStaffed.length} communit${nowStaffed.length === 1 ? 'y has' : 'ies have'} `
        + `gained contacts: ${nowStaffed.map(c => c.name).join(', ')}`);
      console.log('    Remove them from AWAITING_CONTACTS in tools/import-workbooks.js.');
    }

    if (unexpected.length) {
      const kept = unexpected.filter(c => c.cms && c.cms.length);
      console.log(`\n  ⚠ ${unexpected.length} communit${unexpected.length === 1 ? 'y is' : 'ies are'} `
        + 'not named in the contact sheet:');
      for (const c of unexpected.slice(0, 20)) {
        console.log(`      ${c.name}${c.cms && c.cms.length ? '  (kept ' + c.cms.length + ' existing)' : '  (no contacts)'}`);
      }
      if (unexpected.length > 20) console.log(`      …and ${unexpected.length - 20} more`);
      if (kept.length && !CONTACTS_STRICT) {
        console.log(`    ${kept.length} kept the contacts already on file — now stale carry-over.`);
        console.log('    --contacts-strict would clear them instead.');
      }
    }
  }

  // A run that halves the community count is almost always the wrong file. The
  // sibling app puts this in front of a human before publishing; here it just
  // refuses.
  if (existing.size && out.length < existing.size * 0.5) {
    problems.push(`this run would cut communities from ${existing.size} to ${out.length} (over half) — check the files`);
  }

  if (problems.length) {
    console.log('\n  errors');
    for (const p of problems) console.log('    ✗ ' + p);
    console.log('\n  nothing written.\n');
    process.exit(1);
  }

  if (DRY) {
    console.log('\n  --dry-run: nothing written.\n');
    return;
  }

  fs.writeFileSync(DATA, JSON.stringify(next));
  fs.writeFileSync(PEOPLE, JSON.stringify(people));
  console.log(`\n  wrote ${path.relative(process.cwd(), DATA)}`);
  console.log('  next:  node tools/validate.js --fix\n');
}

main();
