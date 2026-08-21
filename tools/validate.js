#!/usr/bin/env node
/**
 * validate.js — schema and location checks for data.json.
 *
 *   node tools/validate.js              check only
 *   node tools/validate.js --geocode    re-geocode addresses, report drift
 *   node tools/validate.js --fix        ...and correct the unambiguous ones
 *
 * Replaces a human: the previous weekly job asked the owner where each new
 * community was and waited for a reply, which stops working the moment nobody
 * answers. Here the geocoder proposes, the thresholds decide, and a person is
 * asked only about genuinely ambiguous cases.
 *
 * Exit codes:  0 clean (warnings allowed) · 1 errors found · 2 could not run
 */

'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const has = f => args.includes(f);
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag);
  // A following flag is not a value: `--data --fix` means --data was given
  // no path, not that the path is "--fix".
  const v = i >= 0 ? args[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : dflt;
};

const DATA = argOf('--data', path.join(__dirname, '..', 'data.json'));
const PEOPLE = argOf('--people', path.join(__dirname, '..', 'people.json'));
const FIX = has('--fix');
const GEOCODE = has('--geocode') || FIX;

/* ── thresholds ───────────────────────────────────────────────────────────────
   Tuned for new construction. A brand-new subdivision address often does not
   exist in any geocoder yet, so the geocoder falls back to the street, the
   ZIP centroid, or the town. Those fallbacks are useless as corrections and
   must never overwrite a coordinate someone placed by hand.                   */
const DRIFT_OK_M      = 250;    // under this, stored and geocoded agree
const DRIFT_FIX_MAX_M = 2000;   // beyond this, too far to be a silent fix
const NEAR_DUP_M      = 25;     // closer than this, effectively the same point

// Orlando division bounding box. A geocode outside it is wrong, full stop.
const BBOX = { minLat: 26.5, maxLat: 30.5, minLon: -83.0, maxLon: -80.0 };

/* Every `geoSource` this tooling knows how to read: the values map-core's
   applyLocation() and acceptProposal() write, plus the `single` that
   locate-communities --accept-single records, plus `manual`. See the WRITING A
   LOCATION ONTO A COMMUNITY comment in map-core.js — that is the list this one
   has to stay in step with. What matters below is not which of these a pin
   carries so much as whether it carries one of them AT ALL: a geoSource this
   file has never heard of came from something we cannot reason about, and the
   safe reading of an unreadable provenance is "leave it alone".               */
const AUTO_GEO_SOURCES = new Set(['agreement', 'sibling', 'locality', 'single', 'confirmed']);
const KNOWN_GEO_SOURCES = new Set([...AUTO_GEO_SOURCES, 'manual']);

/* ── geocoding providers ─────────────────────────────────────────────────────
   Behind one interface so the chain can be reordered, and so the checks can be
   tested with a stub. Census first: it is free, has no API key, is authoritative
   for US addresses, and returns a match type we can act on. Nominatim second,
   with its 1 req/s policy respected.                                           */

const providers = {
  census: {
    name: 'census',
    rateMs: 200,
    async lookup(addr) {
      const url = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress'
        + `?address=${encodeURIComponent(addr)}&benchmark=Public_AR_Current&format=json`;
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error(`census HTTP ${r.status}`);
      const j = await r.json();
      const m = j.result && j.result.addressMatches && j.result.addressMatches[0];
      if (!m) return null;
      return {
        lat: m.coordinates.y,
        lon: m.coordinates.x,
        // "Exact" and "Non_Exact" are both interpolated to a real address range.
        precision: m.tigerLine && m.tigerLine.side ? 'address' : 'street',
        source: 'census'
      };
    }
  },

  nominatim: {
    name: 'nominatim',
    rateMs: 1100, // usage policy: max 1 request per second
    async lookup(addr) {
      const url = 'https://nominatim.openstreetmap.org/search'
        + `?q=${encodeURIComponent(addr)}&format=json&limit=1&countrycodes=us&addressdetails=1`;
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error(`nominatim HTTP ${r.status}`);
      const j = await r.json();
      if (!j.length) return null;
      const m = j[0];
      // Anything coarser than a building or road is a town/ZIP centroid and is
      // not a usable correction for a specific homesite.
      const precision =
        ['building', 'house', 'residential'].includes(m.type) ? 'address'
        : m.class === 'highway' ? 'street'
        : 'area';
      return { lat: +m.lat, lon: +m.lon, precision, source: 'nominatim' };
    }
  }
};

const UA = 'community-map-validator/1.0 (+repo tools/validate.js)';
const CHAIN = argOf('--provider', 'census,nominatim').split(',').map(s => s.trim());

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function geocode(addr) {
  const errors = [];
  for (const key of CHAIN) {
    const p = providers[key];
    if (!p) { errors.push(`unknown provider "${key}"`); continue; }
    try {
      const hit = await p.lookup(addr);
      await sleep(p.rateMs);
      if (hit) return hit;
    } catch (e) {
      errors.push(`${key}: ${e.message}`);
      await sleep(p.rateMs);
    }
  }
  return errors.length ? { error: errors.join('; ') } : null;
}

/* ── geometry ─────────────────────────────────────────────────────────────── */

function metres(a, b) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const p1 = rad(a.lat), p2 = rad(b.lat);
  const dp = rad(b.lat - a.lat), dl = rad(b.lon - a.lon);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ── reporting ────────────────────────────────────────────────────────────── */

const errors = [], warnings = [], fixes = [], placements = [];
const err = (who, msg) => errors.push({ who, msg });
const warn = (who, msg) => warnings.push({ who, msg });

/* ── checks ───────────────────────────────────────────────────────────────── */

function checkSchema(data, people) {
  const REQUIRED = ['name', 'num', 'addr', 'lat', 'lon', 'starts'];
  const seenNum = new Map();

  if (!data.generatedAt || isNaN(Date.parse(data.generatedAt))) {
    err('data.json', 'generatedAt missing or unparseable — the header cannot report freshness');
  } else {
    const ageDays = (Date.now() - Date.parse(data.generatedAt)) / 864e5;
    const cadence = data.updateCadenceDays || 7;
    if (ageDays > cadence + 1) {
      warn('data.json', `data is ${Math.floor(ageDays)} days old (cadence is ${cadence})`);
    }
  }

  // dataStart drives every next-3-month figure and marker size on the map. A
  // wrong value shifts the whole page without anything looking broken, which is
  // exactly how it drifted out of step with its own comments before.
  if (!/^\d{4}-\d{2}$/.test(data.dataStart || '')) {
    err('data.json', `dataStart "${data.dataStart}" is not YYYY-MM`);
  } else {
    /* UTC on both sides. map-core's currentDataStart() stamps the month from
       getUTCMonth(), so on an evening east of UTC — or any evening at all, from
       here — local time is still in the previous month while the file correctly
       says the next one. Comparing the two calendars made this reject a file it
       had just watched import-workbooks write, for a few hours a month. */
    const [y, m] = data.dataStart.split('-').map(Number);
    const now = new Date();
    const offset = (now.getUTCFullYear() * 12 + now.getUTCMonth() + 1) - (y * 12 + m);
    if (offset < 0 || offset > 1) {
      err('data.json',
        `dataStart ${data.dataStart} puts the current month at index ${offset} of starts[] — expected 0 or 1`);
    }
  }

  const cats = data.tradeCats || [], vendors = data.vendors || [];

  for (const c of data.communities || []) {
    const who = c.name || c.num || '(unnamed)';

    for (const k of REQUIRED) {
      // lat/lon are handled below: absent is expected, wrong is not.
      if (k === 'lat' || k === 'lon') continue;
      if (c[k] == null) err(who, `missing required field "${k}"`);
    }
    if (!Array.isArray(c.starts) || c.starts.length !== 12) {
      err(who, `starts[] has ${c.starts ? c.starts.length : 0} entries, expected 12`);
    } else if (c.starts.some(v => !Number.isInteger(v) || v < 0)) {
      err(who, 'starts[] contains a non-integer or negative value');
    }

    if (seenNum.has(c.num)) err(who, `duplicate community number ${c.num} (also ${seenNum.get(c.num)})`);
    else seenNum.set(c.num, who);

    /* An ABSENT coordinate is not an error. It is the state every new community
       arrives in, and the map now holds such communities off the map and reports
       the count rather than plotting them at 0,0. Treating it as an error meant
       this script exited 1 on every run that followed an import, which is how a
       report stops being read.

       A PRESENT but nonsensical coordinate is still an error: 0,0 is what a null
       becomes after arithmetic, and outside the division means something wrote a
       wrong value. Those are bugs; a new community is not. */
    const absent = c.lat == null && c.lon == null;
    if (absent) {
      // Counted at report time, not here: --fix may place some of these a few
      // lines further down, and a note written before that runs is already wrong.
    } else if (typeof c.lat !== 'number' || typeof c.lon !== 'number') {
      err(who, `lat/lon is present but not numeric (${JSON.stringify(c.lat)},${JSON.stringify(c.lon)})`);
    } else if (c.lat === 0 && c.lon === 0) {
      err(who, 'coordinates are 0,0 — null island, which is what a null becomes after arithmetic');
    } else if (c.lat < BBOX.minLat || c.lat > BBOX.maxLat || c.lon < BBOX.minLon || c.lon > BBOX.maxLon) {
      err(who, `coordinates ${c.lat},${c.lon} fall outside the division bounding box`);
    }

    // Fields that render as an em-dash when absent, which looks identical to a
    // field that is genuinely empty. Warn so they get filled rather than
    // quietly showing nothing.
    for (const k of ['municipality', 'electric', 'water']) {
      if (!c[k]) warn(who, `no ${k}`);
    }
    if (!c.plans || !c.plans.length) warn(who, 'no plans listed');
    if (c.approxGeo) warn(who, 'location is approximate');

    if (c.trades) {
      for (const [ci, vi] of Object.entries(c.trades)) {
        if (cats[ci] == null) err(who, `trade category index ${ci} out of range`);
        if (vendors[vi] == null) err(who, `vendor index ${vi} out of range`);
      }
    }

    for (const id of [].concat(c.cms || [], c.acm ? [c.acm] : [])) {
      if (!people[id]) err(who, `references unknown person "${id}"`);
    }
  }

  // Unreferenced people are a privacy issue as much as a tidiness one: a contact
  // nobody links to is still published.
  const referenced = new Set(
    (data.communities || []).flatMap(c => [].concat(c.cms || [], c.acm ? [c.acm] : []))
  );
  for (const id of Object.keys(people)) {
    if (!referenced.has(id)) warn('people.json', `"${id}" is published but not referenced by any community`);
  }
}

function checkColocation(data) {
  /* Only communities that are actually on the map can share a pin.

     Without the guard this compared null to null, found them 0 m apart, and
     reported that two communities with no coordinates "share one map pin" —
     neither is on the map, so they share nothing. Three new communities produced
     three such warnings, crying wolf in the one report that is supposed to be
     worth reading. */
  const cs = (data.communities || []).filter(c =>
    Number.isFinite(c.lat) && Number.isFinite(c.lon));

  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      const d = metres(cs[i], cs[j]);
      if (d < 0.5) {
        warn(cs[i].name, `identical coordinates to ${cs[j].name} — they share one map pin`);
      } else if (d < NEAR_DUP_M) {
        warn(cs[i].name, `${d.toFixed(0)} m from ${cs[j].name} — effectively the same point`);
      }
    }
  }
}

async function checkGeocode(data) {
  const cs = data.communities || [];
  process.stderr.write(`geocoding ${cs.length} addresses via ${CHAIN.join(' → ')}\n`);

  for (const c of cs) {
    /* No address, nothing to ask. Census answers a blank query with HTTP 400,
       which produced one "geocoder unavailable" warning per new community —
       noise that hid the real message, which is simply that the address is not
       known yet. Say that instead, once. */
    if (!String(c.addr || '').trim()) {
      warn(c.name, c.lat == null
        ? 'no address yet, so there is nothing to geocode — set one, or let '
          + 'Blueprint locate it from the permit log streets'
        : 'no address recorded (the coordinate is set, so this is cosmetic)');
      continue;
    }
    const query = `${c.addr}`;
    const hit = await geocode(query);

    if (!hit) { warn(c.name, 'no geocoder returned a result'); continue; }
    if (hit.error) { warn(c.name, `geocoder unavailable (${hit.error})`); continue; }

    const inBox = hit.lat >= BBOX.minLat && hit.lat <= BBOX.maxLat
               && hit.lon >= BBOX.minLon && hit.lon <= BBOX.maxLon;
    if (!inBox) { warn(c.name, `geocode landed outside the division — ignored`); continue; }

    /* PLACING a community is a different operation from CORRECTING one, and
       conflating them meant --fix could never place anything.

       metres() reads an absent latitude as 0, so the distance from a null
       coordinate to a perfectly correct geocode is about 9,162 km — four
       thousand times the 2 km ceiling that exists to stop a bad geocode moving a
       good pin. The guard was doing its job; it was just being asked the wrong
       question. There is no drift to measure when there is no prior position.

       So: no coordinate, plus an address-precision result inside the division,
       is a placement. It is flagged approxGeo, because a single geocode of a
       hand-typed address is weaker evidence than the corroborated agreement
       map-core requires, and approxGeo means no later run will silently move it. */
    if (c.lat == null && c.lon == null) {
      if (hit.precision !== 'address') {
        warn(c.name, `has no coordinate, and the geocoder only managed `
          + `${hit.precision} precision (${hit.source}) — too coarse to place a pin`);
        continue;
      }
      if (FIX) {
        c.lat = +hit.lat.toFixed(7);
        c.lon = +hit.lon.toFixed(7);
        c.approxGeo = true;
        placements.push({ who: c.name, to: [c.lat, c.lon], source: hit.source, addr: c.addr });
      } else {
        warn(c.name, `has no coordinate; "${c.addr}" resolves to `
          + `${hit.lat.toFixed(5)},${hit.lon.toFixed(5)} (${hit.source}) — re-run with --fix to place it`);
      }
      continue;
    }

    const d = metres(c, hit);
    if (d <= DRIFT_OK_M) continue; // agrees, nothing to say

    const detail = `stored point is ${(d / 1000).toFixed(2)} km from the geocoded address `
                 + `(${hit.source}, ${hit.precision})`;

    /* Only an address-precision result inside the sane-drift band is allowed to
       rewrite a coordinate. A street or area match at 5 km is the geocoder
       failing to find a new subdivision, not evidence the pin is wrong.

       And nothing rewrites a HAND-PLACED one. `approxGeo` marks a coordinate
       this tooling produced and may therefore revise; a coordinate somebody
       typed carries geoSource "manual" and no approxGeo flag, and treating the
       absent flag as permission to move it would have this tool quietly undoing
       the one correction a person went to the trouble of making. It is still
       reported, because a manual pin 8 km from its own address is worth
       knowing about — it is just not overwritten.

       ── AND NOTHING REWRITES A PROVENANCE WE CANNOT READ ──────────────────
       `manual` is not the only string that means "not yours to move"; it is
       just the only one that exists today. A geoSource this file does not
       recognise came from a tool written after it — a future confidence level,
       an import from another division, a hand edit somebody labelled — and the
       one thing we can say about it is that we do not know what it means. A
       guard that only asks "is this the literal string manual?" reads every
       such value as permission. So the check is: known value, or no value.

       AN ABSENT geoSource IS NOT SUSPICIOUS, and it deliberately does not
       trigger the above. Every one of the 71 pins on the map today is missing
       the field, because the field postdates all of them — and so does the
       manual-placement tooling that would have written "manual", which means
       an absent geoSource cannot be concealing a hand placement. There were no
       hand placements to conceal. Treating absent as protected would not close
       a gap, it would switch --fix off for the entire division while this same
       function went on printing "re-run with --fix to correct" at an operator
       for whom that had silently become a no-op. Absent falls through to the
       approxGeo rule, exactly as it always has.                              */
    const byHand = c.geoSource === 'manual';
    // A non-empty value we have never heard of. Absent is not this.
    const unreadable = !!c.geoSource && !KNOWN_GEO_SOURCES.has(c.geoSource);
    const confident = hit.precision === 'address' && d <= DRIFT_FIX_MAX_M
                   && !c.approxGeo && !byHand && !unreadable;

    if (FIX && confident) {
      fixes.push({ who: c.name, from: [c.lat, c.lon], to: [hit.lat, hit.lon], d });
      c.lat = +hit.lat.toFixed(7);
      c.lon = +hit.lon.toFixed(7);
      delete c.approxGeo;
    } else if (confident) {
      warn(c.name, `${detail} — re-run with --fix to correct`);
    } else if (byHand) {
      warn(c.name, `${detail} — placed by hand, so it is reported but never moved`);
    } else if (unreadable) {
      /* Named in full, because the value IS the finding: whoever reads this
         knows what wrote it and this file does not. There is no --force flag to
         offer — forcing one pin would be another way to move a coordinate with
         no record of who decided to. Either teach this file the value, or clear
         the pin and let --fix place it afresh. */
      warn(c.name, `${detail} — geoSource "${c.geoSource}" is not a provenance this `
        + `tool recognises, so it is reported but never moved. Add it to `
        + `AUTO_GEO_SOURCES in tools/validate.js if it is one of ours, or clear this `
        + `community's lat/lon to let --fix place it again`);
    } else {
      warn(c.name, `${detail} — needs a human`);
    }
  }
}

/* ── writing ──────────────────────────────────────────────────────────────────
   Write beside the target, then rename over it. writeFileSync truncates the
   file and then fills it, so an interruption in between — a full disk, a
   Ctrl-C, a geocoder call that took long enough for somebody to give up — does
   not leave a bad coordinate in data.json, it leaves no data.json worth
   parsing. The map falls back to the database and the next run cannot read what
   it is meant to be checking.

   A rename within one directory is atomic on every filesystem this runs on:
   every reader sees either the whole old document or the whole new one. Same
   directory is not incidental — a rename across devices is a copy, which is
   exactly the operation being avoided.                                        */
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

/* ── run ──────────────────────────────────────────────────────────────────── */

(async function main() {
  let data, people;
  try {
    data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    people = JSON.parse(fs.readFileSync(PEOPLE, 'utf8')).people || {};
  } catch (e) {
    console.error(`could not read data: ${e.message}`);
    process.exit(2);
  }

  checkSchema(data, people);
  checkColocation(data);

  if (GEOCODE) {
    if (typeof fetch !== 'function') {
      console.error('this Node build has no global fetch — needs Node 18+');
      process.exit(2);
    }
    await checkGeocode(data);
  }

  if (placements.length || fixes.length) {
    writeJsonAtomic(DATA, data);
  }

  if (placements.length) {
    // Placing a pin that did not exist is a bigger event than nudging one, so it
    // is reported first and separately.
    console.log(`\n  placed ${placements.length} communit${placements.length === 1 ? 'y' : 'ies'} `
      + `that had no coordinate:`);
    for (const p of placements) {
      console.log(`    + ${p.who.padEnd(22)} ${p.to[0]},${p.to[1]}  (${p.source})`);
      console.log(`      from "${p.addr}"`);
    }
    console.log('      Flagged approximate, so no later run will move them silently.');
  }

  if (fixes.length) {
    // Corrections are written but still printed. A coordinate moving is
    // something a reviewer should see in the run output, not only in the diff.
    console.log(`\n  corrected ${fixes.length} coordinate${fixes.length === 1 ? '' : 's'}:`);
    for (const f of fixes) {
      console.log(`    ✓ ${f.who.padEnd(22)} moved ${(f.d / 1000).toFixed(2)} km  `
        + `${f.from[0]},${f.from[1]} → ${f.to[0]},${f.to[1]}`);
    }
  }

  /* Communities still without a coordinate. Reported as a note rather than an
     error: this is the expected state of a new community, and the starts figure
     is what says whether it matters. Three communities is housekeeping; a
     hundred hidden starts is not. */
  /* Derived from the document as it now stands, AFTER any placements above. An
     earlier version collected this during the schema check and then reported
     three communities awaiting a location on a run that had just placed one of
     them. */
  const unlocated = (data.communities || [])
    .filter(c => c.lat == null && c.lon == null)
    .map(c => ({ who: c.name || c.num, starts: (c.starts || []).reduce((a, b) => a + b, 0) }));

  if (unlocated.length) {
    const hidden = unlocated.reduce((a, u) => a + u.starts, 0);
    console.log(`\n  ${unlocated.length} communit${unlocated.length === 1 ? 'y' : 'ies'} `
      + `still awaiting a location`
      + (hidden ? `, hiding ${hidden} start${hidden === 1 ? '' : 's'} from the map:` : ':'));
    for (const u of unlocated.sort((a, b) => b.starts - a.starts)) {
      console.log(`    · ${u.who.padEnd(22)}${u.starts} start${u.starts === 1 ? '' : 's'} hidden`);
    }
  }

  const group = list => {
    const by = new Map();
    for (const { who, msg } of list) {
      if (!by.has(who)) by.set(who, []);
      by.get(who).push(msg);
    }
    return by;
  };

  if (errors.length) {
    console.log('\n  errors');
    for (const [who, msgs] of group(errors)) {
      for (const m of msgs) console.log(`    ✗ ${who.padEnd(22)} ${m}`);
    }
  }
  if (warnings.length && !has('--quiet')) {
    console.log('\n  warnings');
    for (const [who, msgs] of group(warnings)) {
      for (const m of msgs) console.log(`    ⚠ ${who.padEnd(22)} ${m}`);
    }
  }

  const n = (data.communities || []).length;
  console.log(`\n  ${n} records · ${errors.length} error${errors.length === 1 ? '' : 's'} · `
    + `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`
    + (fixes.length ? ` · ${fixes.length} corrected` : '') + '\n');

  process.exit(errors.length ? 1 : 0);
})();
