#!/usr/bin/env node
/**
 * geo-tests.js — locating a new community from the permit log's street names.
 *
 * The property under test is not "how many communities can we place". It is
 * "can this ever place one in the wrong place". A missing pin is visible and
 * gets fixed; a wrong pin is believed. Most of what follows asserts a refusal.
 *
 * No network: geocoder responses are supplied directly, because what needs
 * testing is the decision made about a response, not the fetching of one.
 */

'use strict';
const C = require('../map-core.js');

let pass = 0, fail = 0;
const fails = [];
const ok = (c, l) => { c ? pass++ : (fail++, fails.push(l)); };
const eq = (a, e, l) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  ok(A === E, l + '\n      expected: ' + E + '\n      actual:   ' + A);
};
const group = n => console.log('\n  ' + n);

// An address-precision hit for `street` at a point.
const hit = (lat, lon, street) =>
  ({ lat, lon, precision: 'address', source: 'census', matchedStreet: street });

/* ── the street out of a permit-log address ──────────────────────────────── */

group('reading a street out of a permit-log address');
{
  eq(C.streetOf('1660 Rider Rain Ln'), 'RIDER RAIN LN', 'a numbered address');
  eq(C.streetOf('TBD Sunfish Drive'), 'SUNFISH DRIVE',
     'and one whose lot has no number yet — the normal state of a new community');
  eq(C.streetOf('  TBD WHITE HOLLY AVENUE  '), 'WHITE HOLLY AVENUE', 'whitespace is irrelevant');
  eq(C.streetOf('1573 Plank Pl Lot 14'), 'PLANK PL', 'a lot suffix is dropped');

  // Ridgebrooke's entire address column is the bare word TBD. Inventing a street
  // from that is exactly the failure this file exists to prevent.
  eq(C.streetOf('TBD'), null, 'a bare TBD is not a street');
  eq(C.streetOf('T.B.D.'), null, 'however it is punctuated');
  eq(C.streetOf('12345'), null, 'and neither is a bare number');
  eq(C.streetOf(''), null, 'nor an empty cell');
  eq(C.streetOf(null), null, 'nor a missing one');
}

/* ── strict street comparison ────────────────────────────────────────────── */

group('a matched street must be THE street, not a similar one');
{
  // Genuine synonyms. A geocoder abbreviating the type is not a different street.
  ok(C.sameStreet('WHITE HOLLY AVENUE', 'White Holly Ave'), 'AVENUE and AVE are the same');
  ok(C.sameStreet('SUNFISH DRIVE', 'Sunfish Dr'), 'DRIVE and DR are the same');
  ok(C.sameStreet('N MAIN ST', 'North Main Street'), 'directions normalise too');
  ok(C.sameStreet('SEA BASS PLACE', 'SEA BASS PL'), 'case is irrelevant');
  ok(C.sameStreet('MAHI PLACE', 'Mahi Ct'),
     'a differing type alone is tolerated — the distinctive words still match');

  /* The refusals. Every one of these is a plausible geocoder response to a street
     that does not exist yet, and accepting any of them puts the pin in the wrong
     place. */
  ok(!C.sameStreet('WHITE HOLLY AVENUE', 'White Hollow Ave'),
     'Holly is not Hollow — one letter is a different street');
  ok(!C.sameStreet('GOLDFINCH LOOP', 'Gold Finch Loop'),
     'and a word split in two is a different street');
  ok(!C.sameStreet('SUNFISH DRIVE', 'Sunfish Bay Dr'), 'an extra word is a different street');
  ok(!C.sameStreet('ELM FLOWER DRIVE', 'Elm Dr'), 'a missing word is a different street');
  ok(!C.sameStreet('BEECH LEAF AVENUE', 'Beech Leaf Ave S'),
     'and so is an added direction');
  ok(!C.sameStreet('SUNFISH DRIVE', ''), 'nothing matches nothing');
  ok(!C.sameStreet('SUNFISH DRIVE', null), 'nor a missing match');
  ok(!C.sameStreet('AVENUE', 'DRIVE'),
     'two bare types do not match — stripping them must not leave nothing');
}

/* ── the corroboration gate ──────────────────────────────────────────────── */

group('two streets agreeing is enough to place a community');
{
  // DeBary Village TH, as it actually appears: five streets, two of which the
  // geocoder knows.
  const r = C.resolveLocation([
    { street: 'SUNFISH DRIVE',  hit: hit(28.8836, -81.3087, 'Sunfish Dr') },
    { street: 'SEA BASS PLACE', hit: hit(28.8841, -81.3079, 'Sea Bass Pl') },
    { street: 'MAHI PLACE',     hit: null },
    { street: 'JEWELFISH WAY',  hit: null }
  ], [], { name: 'DeBary Village TH' });

  eq(r.status, 'located', 'two independent streets landing together is not a coincidence');
  eq(r.confidence, 'agreement', 'and it is recorded as such');
  ok(r.lat > 28.88 && r.lat < 28.89, 'the point is the centre of the agreeing streets');
  ok(/2 streets agree/.test(r.evidence[0]), 'the evidence names how it was decided');
  eq(r.tried.length, 4, 'every street attempted is recorded, including the failures');
}

group('one street alone is never trusted');
{
  const r = C.resolveLocation(
    [{ street: 'SWEET CHERRY LOOP', hit: hit(28.0, -81.9, 'Sweet Cherry Loop') }],
    [], { name: 'Cypress Rsrv TH' });

  eq(r.status, 'proposed', 'a lone street is proposed, never applied');
  ok(r.lat, 'the candidate point is carried so it can be confirmed');
  ok(/same-named street elsewhere/.test(r.why),
     'and the reason says what the risk is: ' + r.why);

  // 24 of the division's 94 communities have exactly one street, so this is the
  // common case rather than an edge one.
  const sib = C.resolveLocation(
    [{ street: 'SWEET CHERRY LOOP', hit: hit(28.0, -81.9, 'Sweet Cherry Loop') }],
    [{ name: 'Cypress Rsrv SF', lat: 28.006, lon: -81.905 }], { name: 'Cypress Rsrv TH' });
  eq(sib.status, 'located', 'a located sibling phase corroborates it');
  eq(sib.confidence, 'sibling', 'recorded as sibling evidence, not agreement');
  ok(/Cypress Rsrv SF/.test(sib.evidence[0]), 'naming which sibling vouched for it');

  // A sibling on the other side of the division vouches for nothing.
  const far = C.resolveLocation(
    [{ street: 'SWEET CHERRY LOOP', hit: hit(28.0, -81.9, 'Sweet Cherry Loop') }],
    [{ name: 'Cypress Rsrv SF', lat: 29.4, lon: -81.1 }], { name: 'Cypress Rsrv TH' });
  eq(far.status, 'proposed', 'a distant sibling does not corroborate');
  ok(/km from every located phase/.test(far.why), 'and the reason says so');

  // A sibling is a phase of the same development, not just any community.
  const unrelated = C.resolveLocation(
    [{ street: 'SWEET CHERRY LOOP', hit: hit(28.0, -81.9, 'Sweet Cherry Loop') }],
    [{ name: 'Wellness 40RL', lat: 28.001, lon: -81.901 }], { name: 'Cypress Rsrv TH' });
  eq(unrelated.status, 'proposed',
     'an unrelated community next door is not evidence about this one');
}

group('two streets that disagree do not average into a wrong answer');
{
  /* The trap an averaging implementation falls into: two streets resolve, but to
     different towns, and the midpoint is a field between them. Neither cluster
     reaches two members, so neither is trusted. */
  const r = C.resolveLocation([
    { street: 'SUNFISH DRIVE',  hit: hit(28.88, -81.30, 'Sunfish Dr') },
    { street: 'GOLDFINCH LOOP', hit: hit(27.90, -82.40, 'Goldfinch Loop') }
  ], [], { name: 'DeBary Village SF' });

  eq(r.status, 'proposed', 'two streets 120 km apart corroborate nothing');
  ok(r.lat === 28.88 || r.lat === 27.9, 'and the point offered is one of them, not their midpoint');
}

group('everything that must be refused outright');
{
  const wrongStreet = C.resolveLocation(
    [{ street: 'WHITE HOLLY AVENUE', hit: hit(28.5, -81.5, 'White Hollow Ave') }],
    [], { name: 'Cypress Rsrv SF' });
  eq(wrongStreet.status, 'pending', 'a differently-named match is refused, not proposed');
  ok(/differently-named/.test(wrongStreet.why),
     'and the reason distinguishes it from "not found": ' + wrongStreet.why);
  ok(/rejected/.test(wrongStreet.tried[0].result), 'the attempt log records the rejection');

  const outside = C.resolveLocation(
    [{ street: 'SUNFISH DRIVE', hit: hit(41.8781, -87.6298, 'Sunfish Dr') }],
    [], { name: 'X' });
  eq(outside.status, 'pending', 'a correctly-named street in Chicago is still refused');
  ok(/outside the division/.test(outside.why), 'for the right reason');

  const errored = C.resolveLocation(
    [{ street: 'SUNFISH DRIVE', hit: { error: 'census HTTP 400' } }], [], { name: 'X' });
  eq(errored.status, 'pending', 'a geocoder error is not a location');

  const nothing = C.resolveLocation([], [], { name: 'Ridgebrooke' });
  eq(nothing.status, 'pending', 'a community with no street at all stays pending');
  ok(/no street names are available/.test(nothing.why),
     'and says that, rather than implying the geocoder failed');

  // Too new to be mapped is the expected case, and should read as temporary.
  const tooNew = C.resolveLocation([
    { street: 'ELM FLOWER DRIVE', hit: null },
    { street: 'BEECH LEAF AVENUE', hit: null }
  ], [], { name: 'Cypress Rsrv SF' });
  eq(tooNew.status, 'pending', 'streets the geocoder has never heard of stay pending');
  ok(/later import/.test(tooNew.why), 'and the message says it will be retried: ' + tooNew.why);
}

/* ── distance, null-safely ───────────────────────────────────────────────── */

group('a missing coordinate is not a position at 0,0');
{
  /* validate.js measured drift from a null coordinate and got 9,162 km, which
     exceeded its own 2 km sanity ceiling — so --fix refused to place any new
     community, including ones with a perfect address. The null case has to be
     absent, not zero. */
  eq(C.metresBetween({ lat: null, lon: null }, { lat: 28.88, lon: -81.3 }), null,
     'distance from an absent point is unknown, not enormous');
  eq(C.metresBetween({ lat: 0, lon: 0 }, null), null, 'and to a missing point');
  const d = C.metresBetween({ lat: 28.88, lon: -81.30 }, { lat: 28.8841, lon: -81.3079 });
  ok(d > 300 && d < 1200, 'two real points measure sensibly (' + Math.round(d) + ' m)');
}

/* ── the pending queue ───────────────────────────────────────────────────── */

group('what still needs locating, worst first');
{
  const doc = { communities: [
    { num: '1', name: 'Located', lat: 28.5, lon: -81.5, starts: new Array(12).fill(1) },
    { num: '2', name: 'Small Gap', lat: null, lon: null, starts: [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { num: '3', name: 'Big Gap', lat: null, lon: null, starts: [20, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { num: '4', name: 'Null Island', lat: 0, lon: 0, starts: new Array(12).fill(0) }
  ] };
  const streets = { '3': { 'ELM FLOWER DR': 91, 'BEECH LEAF AVE': 45 }, '2': {} };

  const q = C.pendingLocations(doc, streets);
  eq(q.map(x => x.name), ['Big Gap', 'Small Gap', 'Null Island'],
     'located communities are absent, and 0,0 counts as unlocated');
  eq(q[0].startsHidden, 28, 'the starts hidden with it are counted');
  eq(q[0].streets.map(s => s.street), ['ELM FLOWER DR', 'BEECH LEAF AVE'],
     'streets come back busiest first — the main road is likeliest to be mapped');
  eq(q[1].streets, [], 'a community with no streets still appears, with none to try');
}

group('an attempt is recorded on the community, so a retry is informed');
{
  const c = { num: '3', name: 'Big Gap', lat: null, lon: null, starts: [] };
  C.applyLocation(c, C.resolveLocation([
    { street: 'ELM FLOWER DR', hit: hit(28.5, -81.5, 'Elm Flower Dr') },
    { street: 'BEECH LEAF AVE', hit: hit(28.502, -81.498, 'Beech Leaf Ave') }
  ], [], { name: 'Big Gap' }), Date.UTC(2026, 7, 20));

  ok(Number.isFinite(c.lat) && Number.isFinite(c.lon), 'a located community gets its coordinate');
  eq(c.geoSource, 'agreement', 'and how it was decided is kept on the record');
  ok(c.approxGeo, 'flagged approximate, so validate.js will not silently move it later');
  eq(c.geo.lastTried, '2026-08-20T00:00:00.000Z', 'the attempt is timestamped');
  eq(c.geo.tried.length, 2, 'with what was tried');

  const p = { num: '4', name: 'Lone Street', lat: null, lon: null, starts: [] };
  C.applyLocation(p, C.resolveLocation(
    [{ street: 'SOLO WAY', hit: hit(28.5, -81.5, 'Solo Way') }], [], { name: 'Lone Street' }));
  eq(p.lat, null, 'a proposal does NOT set the coordinate');
  ok(p.geo.proposed && p.geo.proposed.lat === 28.5, 'it is held for confirmation instead');
  ok(/elsewhere/.test(p.geo.proposed.why), 'with the reason attached');

  const s = { num: '5', name: 'Ridgebrooke', lat: null, lon: null, starts: [] };
  C.applyLocation(s, C.resolveLocation([], [], { name: 'Ridgebrooke' }));
  eq(s.lat, null, 'a pending community is untouched');
  ok(/no street names/.test(s.geo.why), 'and carries why, so the next run need not rediscover it');
}

/* ── the development rule must agree with the map's own ──────────────────── */

group('developmentOf matches the rule index.html groups pins by');
{
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');

  /* Two copies of a naming rule that must not disagree: this one decides which
     communities can vouch for each other's location, and index.html's decides
     which share a map pin. Rather than compare source, compare behaviour on the
     names that actually exist. */
  const m = html.match(/function developmentOf\(name\)\s*\{[\s\S]*?\n\}/);
  ok(!!m, 'found developmentOf in index.html');
  if (m) {
    const theirs = new Function('DESIGNATOR', 'return ' + m[0].replace('function developmentOf', 'function'))(
      /^(\d+[a-z]*|th|gc|aa|rl|fl|mjr|m|villa|classic|majors)$/i);
    const names = ['Waterlin 40RL', 'Wellness2 40FL', 'Hunt Club 50GC', 'Reedy 50 Classic',
                   'Westview Villa', 'Edgewater MJR', 'Crosswinds 2 50', 'Grenelefe 60M',
                   'DeBary Village TH', 'Cypress Rsrv SF', 'Springhead 25GC'];
    const diffs = names.filter(n => theirs(n) !== C.developmentOf(n))
                       .map(n => n + ': map="' + theirs(n) + '" core="' + C.developmentOf(n) + '"');
    // map-core adds SF/PAR/CLA/VIL/MAJ, which index.html lacks; anything it
    // strips, index.html must strip too, or the two disagree about siblings.
    const worse = diffs.filter(d => {
      const n = d.split(':')[0];
      return theirs(n).length < C.developmentOf(n).length;
    });
    eq(worse, [], 'map-core never groups less aggressively than the map itself');
    if (diffs.length) {
      console.log('    note: map-core strips more designators than index.html does —');
      for (const d of diffs) console.log('      ' + d);
      console.log('    that is intentional (SF/VIL/MAJ were added for sibling matching),');
      console.log('    but if pin grouping should follow, update index.html to match.');
    }
  }
}

/* ── backtest against the real division ─────────────────────────────────────
   The decisive test, and the only one that can catch a threshold set wrongly.

   Replays every community whose true location is already known as if it had just
   arrived: takes its real street list from the permit log, places a synthetic
   geocoder hit for each one inside the real community, and injects an adversarial
   extra street that resolves to a same-named road 60 km away — the exact failure
   mode a geocoder produces for a street that does not exist yet.

   Then checks two things. The resolver should place most of them, and it must
   place NONE of them wrong.

   Needs data.json plus the Orlando permit log; skips loudly without them. */

const FIXTURES = process.env.GEO_FIXTURES || process.env.INTAKE_FIXTURES;
let XLSX = null;
try { XLSX = require('xlsx'); }
catch (_) {
  try { XLSX = require(require('path').join(process.env.XLSX_PATH || '/tmp/node_modules', 'xlsx')); }
  catch (_2) { /* reported below */ }
}

group('backtest: replay the real division as if every community were new');
if (!XLSX || !FIXTURES || !require('fs').existsSync(FIXTURES)) {
  console.log('    ⚠ SKIPPED — needs SheetJS and GEO_FIXTURES pointing at the workbook folder.');
  console.log('      This is the check that would catch a wrongly-set distance threshold.');
} else {
  const fs2 = require('fs'), path2 = require('path');
  const doc = JSON.parse(fs2.readFileSync(path2.join(__dirname, '..', '..', 'data.json'), 'utf8'));
  const startsFile = fs2.readdirSync(FIXTURES).find(f => /Start Schedule/i.test(f) && /\.xls[xm]$/i.test(f));
  ok(!!startsFile, 'found the Orlando starts workbook (' + startsFile + ')');

  if (startsFile) {
    const wb = XLSX.read(fs2.readFileSync(path2.join(FIXTURES, startsFile)), { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['Permit Log'], { defval: null });
    const { streets } = C.parseStarts(rows, 'Permit Log', { notes: [], problems: [] });
    const located = doc.communities.filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lon));

    ok(located.length > 50, located.length + ' communities have a known location to replay');

    /* Thresholds must cover the real geometry. Measured: the widest development
       in the division spans 1.4 km across 13 phases. If a change loosened these
       to "be safe", this fails — loose is not safe, it is what lets an unrelated
       subdivision corroborate a wrong answer. */
    const byDev = {};
    for (const c of located) { const d = C.developmentOf(c.name); (byDev[d] = byDev[d] || []).push(c); }
    let widest = 0, widestDev = null;
    for (const [dev, cs] of Object.entries(byDev)) {
      for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
        const d = C.metresBetween(cs[i], cs[j]);
        if (d > widest) { widest = d; widestDev = dev; }
      }
    }
    ok(widest < C.SIBLING_M,
       'every real development (widest: ' + widestDev + ' at ' + (widest / 1000).toFixed(1)
       + ' km) fits inside SIBLING_M of ' + (C.SIBLING_M / 1000) + ' km');
    ok(C.SIBLING_M < widest * 4,
       'and SIBLING_M is not so loose it could span unrelated sites '
       + '(' + (C.SIBLING_M / 1000) + ' km against a ' + (widest / 1000).toFixed(1) + ' km worst case)');

    let n = 0, auto = 0, confirm = 0, stuck = 0, wrong = 0, worst = 0;
    const JIT = 0.004;                       // ~450 m, a hit anywhere in the subdivision
    for (const c of located) {
      const mine = Object.keys(streets[c.num] || {});
      if (!mine.length) continue;
      n++;
      const cands = mine.map((st, i) => ({ street: st, hit: {
        lat: c.lat + (i % 3 - 1) * JIT, lon: c.lon + ((i + 1) % 3 - 1) * JIT,
        precision: 'address', source: 'census', matchedStreet: st } }));
      // The adversary: a correctly-named street 60 km away.
      cands.push({ street: 'DECOY WAY', hit: {
        lat: c.lat + 0.55, lon: c.lon + 0.15,
        precision: 'address', source: 'census', matchedStreet: 'Decoy Way' } });

      const r = C.resolveLocation(cands, located.filter(x => x.num !== c.num), { name: c.name });
      if (r.status === 'located') {
        auto++;
        const err = C.metresBetween({ lat: r.lat, lon: r.lon }, c);
        if (err > worst) worst = err;
        if (err > C.AGREE_M) { wrong++; fails.push('backtest placed ' + c.name + ' ' + (err / 1000).toFixed(1) + ' km from truth'); }
      } else if (r.status === 'proposed') confirm++;
      else stuck++;
    }

    console.log('    replayed ' + n + ': ' + auto + ' resolved, ' + confirm
      + ' offered for confirmation, ' + stuck + ' pending');
    console.log('    worst error among the resolved: ' + Math.round(worst) + ' m');

    eq(wrong, 0, 'NOT ONE community was placed further than AGREE_M from its true location');
    ok(worst < C.AGREE_M, 'the worst resolved error (' + Math.round(worst)
       + ' m) is inside the agreement radius');
    ok(auto / n > 0.7, Math.round(auto / n * 100) + '% resolved without a human, which is the point');
    ok(auto + confirm + stuck === n, 'every replayed community got exactly one verdict');
  }
}

/* ── a coordinate typed by a person ─────────────────────────────────────── */

group('reading a coordinate somebody pasted in');
{
  eq(C.parseLatLon('28.6607, -81.5458'), { lat: 28.6607, lon: -81.5458 }, 'the ordinary form');
  eq(C.parseLatLon('  28.6607,-81.5458 '), { lat: 28.6607, lon: -81.5458 }, 'spacing is irrelevant');
  eq(C.parseLatLon('28.6607 -81.5458'), { lat: 28.6607, lon: -81.5458 }, 'a space instead of a comma');

  // The one transformation worth making. A site that writes "81.5458° W" is
  // giving a positive number for a negative longitude, and taking it literally
  // puts an Orlando community in China.
  eq(C.parseLatLon('28.6607°N, 81.5458°W'), { lat: 28.6607, lon: -81.5458 },
     'hemisphere letters negate rather than being ignored');
  eq(C.parseLatLon('28.6607N 81.5458W'), { lat: 28.6607, lon: -81.5458 },
     'with or without the degree sign');

  eq(C.parseLatLon('28.6607'), null, 'one number is not a coordinate');
  eq(C.parseLatLon('somewhere near the Publix'), null, 'and neither is prose');
  eq(C.parseLatLon('200, -81.5'), null, 'nor an impossible latitude');
  eq(C.parseLatLon(''), null, 'nor an empty box');
}

group('placing one by hand');
{
  const fresh = () => ({ num: '1', name: 'Ridgebrooke', lat: null, lon: null, starts: [1, 2] });

  {
    const c = fresh();
    const r = C.placeManually(c, 28.6607, -81.5458, { by: 'you@example.com' });
    ok(r.ok, 'a coordinate inside the division is accepted');
    eq([c.lat, c.lon], [28.6607, -81.5458], 'and written onto the community');
    eq(c.geoSource, 'manual', 'recorded as manual');
    // The point of `manual`: validate.js --fix leaves it alone forever after.
    ok(!('approxGeo' in c), 'and NOT flagged approximate, so nothing moves it later');
    eq(c.geo.placedBy, 'you@example.com', 'who placed it is recorded');
  }

  {
    // The mistake people actually make. Latitude and longitude transposed reads
    // perfectly plausibly until the map draws it in the Indian Ocean.
    const c = fresh();
    const r = C.placeManually(c, -81.5458, 28.6607);
    ok(!r.ok, 'a transposed pair is refused');
    ok(/swapped/.test(r.error), 'and the message says so rather than "out of range": ' + r.error);
    eq(c.lat, null, 'nothing is written on a refusal');
  }

  {
    const c = fresh();
    ok(!C.placeManually(c, 0, 0).ok, '0,0 is refused');
    ok(!C.placeManually(c, 41.88, -87.63).ok, 'and so is a real place in another state');
    ok(!C.placeManually(c, 'over', 'there').ok, 'and so is anything that is not a number');
  }
}

/* ── a proposal a person has already refused ────────────────────────────── */

group('a rejected proposal is not offered again');
{
  // One street, no sibling — the shape that produces a proposal.
  const lone = [{ street: 'SUNFISH DRIVE', hit: hit(28.66, -81.54, 'Sunfish Dr') }];

  const first = C.resolveLocation(lone, [], { name: 'DeBary Village TH' });
  eq(first.status, 'proposed', 'one uncorroborated street is proposed, not applied');
  eq(first.street, 'SUNFISH DRIVE', 'and the proposal names the street it came from');

  const c = { num: '1', name: 'DeBary Village TH', lat: null, lon: null, starts: [] };
  C.applyLocation(c, first);
  ok(c.geo.proposed && c.geo.proposed.street === 'SUNFISH DRIVE',
     'which is what gets recorded, so refusing it can record WHAT was refused');

  const rej = C.rejectProposal(c, { by: 'you@example.com' });
  ok(rej.ok, 'the proposal can be rejected');
  eq(c.geo.rejected.length, 1, 'and the rejection is kept on the community');
  eq(c.geo.rejected[0].street, 'SUNFISH DRIVE', 'with the street');
  eq([c.geo.rejected[0].lat, c.geo.rejected[0].lon], [28.66, -81.54],
     'and the point — without it the record cannot tell "here" from "anywhere"');
  ok(!c.geo.proposed, 'the refused proposal is gone, not left to be re-accepted');
  eq(c.lat, null, 'and nothing was placed');

  // The whole point: the next import must not ask again.
  const again = C.resolveLocation(lone, [], {
    name: 'DeBary Village TH', rejected: c.geo.rejected });
  eq(again.status, 'pending', 'the same evidence a second time is not re-proposed');
  ok(/rejected/.test(again.why), 'and it says why: ' + again.why);

  // A geocoder does not return quite the same point twice. 120 m away is the
  // same answer, not a new one.
  const nudged = [{ street: 'SUNFISH DRIVE', hit: hit(28.661, -81.5405, 'Sunfish Dr') }];
  eq(C.resolveLocation(nudged, [], { name: 'DeBary Village TH', rejected: c.geo.rejected }).status,
     'pending', 'nor is the same street a hundred metres along');

  // But a genuinely different point IS a new question.
  const elsewhere = [{ street: 'SUNFISH DRIVE', hit: hit(29.2, -81.9, 'Sunfish Dr') }];
  eq(C.resolveLocation(elsewhere, [], { name: 'DeBary Village TH', rejected: c.geo.rejected }).status,
     'proposed', 'the same street somewhere else is different evidence and is asked about');
}

group('a rejection suppresses the evidence, not the community');
{
  const rejected = [{ street: 'SUNFISH DRIVE', lat: 28.66, lon: -81.54, at: '2026-08-20T00:00:00Z' }];

  /* This is the distinction that matters. Refusing "one street, uncorroborated"
     must not also refuse "two streets that agree" — the second is the standard
     that would have placed it automatically in the first place, and a person
     saying no to a weaker claim cannot be read as no to a stronger one. */
  const two = [
    { street: 'SUNFISH DRIVE', hit: hit(28.66, -81.54, 'Sunfish Dr') },
    { street: 'MAHI PLACE', hit: hit(28.663, -81.543, 'Mahi Pl') }
  ];
  const r = C.resolveLocation(two, [], { name: 'DeBary Village TH', rejected });
  eq(r.status, 'located', 'two agreeing streets still place it');
  eq(r.confidence, 'agreement', 'on agreement, not in spite of the rejection');

  // And so does a sibling turning up, for the same reason.
  const sib = [{ name: 'DeBary Village SF', lat: 28.664, lon: -81.541 }];
  const s = C.resolveLocation([two[0]], sib, { name: 'DeBary Village TH', rejected });
  eq(s.status, 'located', 'and so does a located sibling phase');
  eq(s.confidence, 'sibling', 'corroborated by the sibling');
}

group('rejections survive everything written after them');
{
  const c = { num: '1', name: 'DeBary Village TH', lat: null, lon: null, starts: [],
              geo: { rejected: [{ street: 'SUNFISH DRIVE', lat: 28.66, lon: -81.54 }] } };

  /* applyLocation rebuilds `geo` on every attempt. An earlier version rebuilt it
     wholesale, which discarded the rejections — and handed the refused proposal
     straight back on the next import, which is the exact failure the rejection
     exists to prevent. */
  C.applyLocation(c, { status: 'pending', tried: [], why: 'nothing resolved' });
  eq((c.geo.rejected || []).length, 1, 'a later failed attempt does not discard them');

  C.applyLocation(c, { status: 'located', lat: 28.7, lon: -81.5, confidence: 'agreement',
                       tried: [], evidence: [] });
  eq((c.geo.rejected || []).length, 1, 'and neither does a successful one');
  eq(c.geoSource, 'agreement', 'which still records how it was placed');
}

group('accepting a proposal');
{
  const c = { num: '1', name: 'Cypress Rsrv TH', lat: null, lon: null, starts: [],
              geo: { tried: [{ street: 'PLANK PL', result: 'matched' }],
                     proposed: { lat: 28.66, lon: -81.54, street: 'PLANK PL', why: 'only one street' },
                     rejected: [{ street: 'OLD RD', lat: 29.9, lon: -82.5 }] } };

  const r = C.acceptProposal(c, { by: 'you@example.com' });
  ok(r.ok, 'a proposal can be confirmed');
  eq([c.lat, c.lon], [28.66, -81.54], 'and the coordinate is applied');
  eq(c.geoSource, 'confirmed', 'recorded as confirmed — a person looked at it');
  /* Still approximate: a person confirming that a single geocode looks right is
     not the same as a person typing a coordinate off a plat. */
  ok(c.approxGeo === true, 'but still approximate, so validate.js will not move it silently');
  eq(c.geo.confirmedBy, 'you@example.com', 'who confirmed it is recorded');
  eq((c.geo.rejected || []).length, 1, 'and earlier rejections survive');
  eq((c.geo.tried || []).length, 1, 'as does the audit trail');

  const none = { num: '2', name: 'Nothing', lat: null, lon: null };
  ok(!C.acceptProposal(none).ok, 'accepting nothing is an error, not a silent no-op');
  ok(!C.rejectProposal(none).ok, 'and so is rejecting nothing');
}

console.log('\n' + '─'.repeat(64));
if (fail) {
  console.log('  FAILED\n');
  fails.forEach(f => console.log('   ✗ ' + f));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(1);
}
console.log('  ✓ all ' + pass + ' assertions passed');
process.exit(0);
