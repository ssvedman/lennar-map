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

group('developmentOf is the SAME rule index.html groups pins by');
{
  const fs2 = require('fs');
  const path2 = require('path');
  const html = fs2.readFileSync(path2.join(__dirname, '..', '..', 'index.html'), 'utf8');

  /* Two copies of one naming rule that must not disagree. This one decides which
     communities may vouch for each other's LOCATION; index.html's decides which
     share a map PIN. They are compared by behaviour rather than by source,
     because the two files are written differently and only the answers matter.

     This started life as a note printed to the console — it observed that
     index.html stripped fewer designators and said "if pin grouping should
     follow, update index.html to match." It should have followed, and nobody
     read the note: "Cypress Rsrv TH" reduced to "cypress rsrv" while "Cypress
     Rsrv SF" stayed "cypress rsrv sf", so two phases of one development were
     different developments, fell through to the 400 m distance fallback, and
     drew two pins on top of each other on the live map.

     A divergence a test merely mentions is a divergence nobody fixes. It is an
     assertion now. */
  const fnM = html.match(/function developmentOf\(name\)\s*\{[\s\S]*?\n\}/);
  const reM = html.match(/const DESIGNATOR = (\/\^\([^\n]*?\)\$\/i);/);
  ok(!!fnM, 'found developmentOf() in index.html');
  ok(!!reM, 'found its DESIGNATOR in index.html');

  if (fnM && reM) {
    /* The regex is READ from index.html, not copied into this file. The previous
       version passed in a hardcoded literal, so it was comparing map-core
       against a transcription of index.html rather than against index.html —
       and would have gone on passing however either one changed. */
    const theirs = new Function('DESIGNATOR',
      'return ' + fnM[0].replace('function developmentOf', 'function'))(eval(reM[1]));

    // Every name that actually exists, plus the shapes worth pinning explicitly.
    const doc = JSON.parse(fs2.readFileSync(
      path2.join(__dirname, '..', '..', 'data.json'), 'utf8'));
    const names = doc.communities.map(c => c.name).concat([
      'Waterlin 40RL', 'Wellness2 40FL', 'Hunt Club 50GC', 'Reedy 50 Classic',
      'Westview Villa', 'Edgewater MJR', 'Crosswinds 2 50', 'Grenelefe 60M',
      'DeBary Village TH', 'DeBary Village SF', 'Cypress Rsrv SF', 'Cypress Rsrv TH',
      'Springhead 25GC', 'Something PAR', 'Something CLA', 'Something VIL', 'Something MAJ']);

    const diffs = names.filter(n => theirs(n) !== C.developmentOf(n))
                       .map(n => n + ': map="' + theirs(n) + '" core="' + C.developmentOf(n) + '"');
    eq(diffs, [], 'the two files agree on every community name, exactly');

    // And the specific pairing that was broken, stated so a regression names itself.
    eq(theirs('Cypress Rsrv SF'), theirs('Cypress Rsrv TH'),
       'Cypress Rsrv SF and TH are one development to the map');
    eq(theirs('DeBary Village SF'), theirs('DeBary Village TH'),
       'and so are DeBary Village SF and TH');

    /* A community known only by a number reduces to "" in BOTH files — that is
       intended, and it is why each has an explicit `dev &&` guard before
       comparing. Without those guards two unrelated numbered communities would
       compare equal and merge on the 25 km same-development radius. Asserted
       here so the emptiness stays a shared, deliberate property rather than
       something one file quietly stops producing. */
    eq(theirs('40521'), '', 'a community known only by a number reduces to nothing');
    eq(C.developmentOf('40521'), '', 'in both files');
    ok(/if \(dev && dev === developmentOf\(b\.name\)\)/.test(html),
       'and index.html refuses to match on an empty development name');

    /* TAMPA. Its product words are not Orlando's, and the day the division went
       on the map every one of them read as part of the development name. The
       live symptom, kept here as the example because it is what someone
       actually saw: NPC drew three pins a few hundred metres apart — the AA
       phases on one, "NPC 18TH SER" alone, "NPC 40 EVE" alone.

       The truncated pair matters as much and is easier to overlook: the source
       field is 15 characters, so CLA and PAR arrive as CL and PA on any name
       long enough to reach the cut. */
    const oneDev = (label, names) => {
      const devs = [...new Set(names.map(theirs))];
      eq(devs.length, 1, label + ' is one development, not ' + devs.length +
         ' (' + devs.join(', ') + ')');
    };
    oneDev('NPC', ['NPC 40', 'NPC AA 50', 'NPC 18TH SER', 'NPC 40 EVE', 'NPC AA 60 CLA']);
    oneDev('Acacia', ['Acacia 40', 'Acacia 18 SER', 'Acacia 40 COT', 'Acacia 50 CLA']);
    oneDev('Conner', ['Conner 50 CLA', 'Conner 50 PIN', 'Conner 60 PAR', 'Conner 60 PIN']);
    oneDev('Prosper', ['Prosper 60', 'Prosper AA60 CL', 'Prosper 40 COT', 'Prosper TH']);
    oneDev('Stonegate', ['Stonegate 65s', 'Stonegate 65 PA', 'Stonegate 55CLA']);
    oneDev('Seaire', ['Seaire 50', 'Seaire P3 40', 'Seaire 40 COT']);
    oneDev('West Lake', ['West Lake 40', 'West Lake RLTH']);
    oneDev('Epperson', ['Epperson 20 ASC', 'Epperson 20']);
    oneDev('Angeline', ['Angeline 50', 'Angeline 50 T2', 'Angeline AA 27V']);
    oneDev('Gulfshade', ['Gulfshade 50 MJ', 'Gulfshade 50']);

    /* And the other direction, which is the risk of a longer list: a real word
       that happens to sit at the end of a name must survive. "Hilltop Point" is
       a development, not a Hilltop of type Point. */
    eq(theirs('Hilltop Point'), 'hilltop point', 'a name ending in a real word is left alone');
    eq(theirs('Balm East 50'), 'balm east', 'and a two-word development keeps both words');
    ok(theirs('Conner 50 CLA') !== theirs('Connerton 40'),
       'Conner and Connerton stay different developments');
  }
}

/* The backtest needs the real workbook and SheetJS; both are optional, so it
   skips cleanly and says so rather than failing on a machine without them. */
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

/* ── the locality Community-DB supplies ─────────────────────────────────── */

group('reading a locality off a Community Information Sheet');
{
  eq(C.parseLocality('DeBary, FL 32713'),
     { city: 'DeBary', state: 'FL', zip: '32713', county: null, raw: 'DeBary, FL 32713' },
     'the ordinary form');
  eq(C.parseLocality('Saint Cloud, Florida 34771-1234').zip, '34771',
     'ZIP+4 is truncated — the map has no use for the +4');
  eq(C.parseLocality('City of Debary').city, 'Debary',
     '"City of" is boilerplate, not part of the name');

  /* A county is NOT a city, and handing one to a geocoder as a city is how a
     findable road becomes "no result". The permitting municipality column
     genuinely contains both — "Polk County" and "City of Eustis" both appear. */
  const polk = C.parseLocality('', 'Polk County');
  eq(polk.county, 'Polk', 'a county is kept as a county');
  eq(polk.city, null, 'and never used as a city');
  eq(C.parseLocality('Unincorporated Osceola County').county, 'Osceola',
     'however it is prefixed');

  // The municipality is a fallback for the address line, never an override.
  eq(C.parseLocality('Apopka, FL 32703', 'City of Ocoee').city, 'Apopka',
     'the address line wins when both are present');
  eq(C.parseLocality('', 'City of Ocoee').city, 'Ocoee', 'and fills in when it is not');

  eq(C.parseLocality(''), null, 'an empty sheet field is no locality');
  eq(C.parseLocality('n/a'), null, 'and neither is a filler word with no place in it');
}

group('matching a CIS locality to a geocoder answer');
{
  const loc = C.parseLocality('DeBary, FL 32713');

  const vol = C.localityAgrees(loc, { matchedZip: '32713', via: 'free' });
  eq([vol.agrees, vol.on, vol.strong, vol.asked],
     [true, 'postcode 32713', true, false],
     'a postcode the geocoder volunteered, agreeing, is the strong case');
  ok(!C.localityAgrees(loc, { matchedZip: '32080' }).agrees,
     'and postcodes disagreeing is a refusal');

  eq(C.localityAgrees(loc, { matchedCity: 'Debary' }).agrees, true,
     'a city name matches case-insensitively');
  eq(C.localityAgrees(loc, { matchedCity: 'Debary' }).strong, false,
     'but a town is not strong evidence — many roads share one');
  ok(!C.localityAgrees(loc, { matchedCity: 'Saint Augustine Beach' }).agrees,
     'a different town is a refusal');

  /* The distinction that keeps this honest. Nothing to compare must read as NO
     EVIDENCE, never as disagreement — most roads in a new subdivision carry no
     city or postcode in OSM at all, and treating that as a refusal would reject
     exactly the communities this is meant to help. */
  eq(C.localityAgrees(loc, { matchedStreet: 'Sunfish Dr' }), null,
     'a provider that reported no locality gives no evidence either way');
  eq(C.localityAgrees(null, { matchedZip: '32713' }), null,
     'and neither does a community with no sheet on file');
}

group('a disagreeing postcode inside an agreeing town is not a refusal');
{
  /* Straight from the live geocoder: it puts Rider Rain Lane in Apopka 32704,
     while the sheet and the map's own address for that community both say
     Apopka 32703. Neither is wrong exactly — postcode boundaries in
     OpenStreetMap are approximate and a subdivision can straddle two.

     Refusing on that made a CORRECT sheet worse than no sheet at all: the
     community dropped from "proposed" to "pending" for having accurate data on
     file. So the town decides refusals and the postcode decides placements. */
  const loc = C.parseLocality('Apopka, FL 32703');
  const hit = { lat: 28.6607, lon: -81.5458, precision: 'street', source: 'nominatim',
                matchedStreet: 'Rider Rain Lane', matchedCity: 'Apopka',
                matchedZip: '32704', via: 'free' };

  const a = C.localityAgrees(loc, hit);
  eq(a.agrees, true, 'the town agrees, so the answer is not refused');
  eq(a.strong, false, 'but the postcodes differ, so it cannot place on its own');
  eq(a.note, 'different postcode, same town', 'and the discrepancy is not hidden');

  const r = C.resolveLocation([{ street: 'RIDER RAIN LN', hit: hit }], [],
                              { name: 'Rider Rain', locality: loc });
  eq(r.status, 'proposed', 'the outcome is a proposal');

  // The floor this sets: having a sheet must never be worse than having none.
  const blind = C.resolveLocation([{ street: 'RIDER RAIN LN', hit: hit }], [],
                                  { name: 'Rider Rain' });
  eq(r.status, blind.status,
     'which is no worse than the same lookup with no sheet at all — accurate data '
     + 'must never cost a community its place in the queue');
}

group('a postcode that was ASKED for cannot corroborate itself');
{
  /* The lookup narrows its first attempt by the sheet's own city and postcode.
     Anything that attempt returns therefore carries that postcode by
     construction — so comparing it back to the sheet proves nothing. The
     agreement is guaranteed, not earned.

     Left unchecked this is a route to the exact failure the whole file exists to
     prevent: a transposed postcode on a hand-filled sheet, plus any same-named
     street inside the wrong one, places a pin in the wrong town with nobody
     asked. `via` is how the two are told apart. */
  const loc = C.parseLocality('DeBary, FL 32713');

  const asked = { lat: 28.88, lon: -81.31, precision: 'street', source: 'nominatim',
                  matchedStreet: 'Sunfish Dr', matchedCity: 'DeBary',
                  matchedZip: '32713', via: 'structured' };
  const volunteered = Object.assign({}, asked, { via: 'free' });

  eq(C.localityAgrees(loc, asked).strong, false,
     'a constrained answer agreeing with the constraint is not strong evidence');
  eq(C.localityAgrees(loc, asked).asked, true, 'and is marked as having been asked for');
  eq(C.localityAgrees(loc, volunteered).strong, true,
     'the same answer, volunteered, is');

  const one = [{ street: 'SUNFISH DRIVE', hit: asked }];
  const r = C.resolveLocation(one, [], { name: 'DeBary Village TH', locality: loc });
  eq(r.status, 'proposed', 'so a lone street found that way is proposed, not placed');
  ok(r.evidence.some(e => /not the same as the geocoder having agreed independently/.test(e)),
     'and the proposal says exactly why: ' + JSON.stringify(r.evidence));

  const r2 = C.resolveLocation([{ street: 'SUNFISH DRIVE', hit: volunteered }], [],
                               { name: 'DeBary Village TH', locality: loc });
  eq(r2.status, 'located', 'while the volunteered one places it');
  eq(r2.confidence, 'locality', 'on the locality');

  /* A DISAGREEMENT still counts either way. Refusing a wrong town never depended
     on independence — the sheet saying one place and the answer being in another
     is a conflict however the question was put. */
  const wrong = Object.assign({}, asked, { matchedZip: '32080', matchedCity: 'Saint Augustine Beach' });
  eq(C.localityAgrees(loc, wrong).agrees, false,
     'a constrained answer that somehow disagrees is still refused');
}

group('two spellings of one town are not two towns');
{
  /* Live in this division: the map's own data says "St Cloud" and the geocoder
     answers "Saint Cloud". Compared literally those are different towns — and a
     differing town is a REFUSAL, so this one gap silently rejected correct
     streets in every St, Ft and Mt community there is. It fails in the direction
     that costs coverage while looking like caution, which is the hardest kind to
     notice. */
  ok(C.placeKey('St. Cloud') === C.placeKey('Saint Cloud'), 'St. Cloud is Saint Cloud');
  ok(C.placeKey('St Cloud') === C.placeKey('Saint Cloud'), 'with or without the point');
  ok(C.placeKey('Ft. Myers') === C.placeKey('Fort Myers'), 'and Ft is Fort');
  ok(C.placeKey('Mt. Dora') === C.placeKey('Mount Dora'), 'and Mt is Mount');

  // Only as a whole word, so a town that merely begins with those letters is
  // left alone. There is no Saint Uart.
  ok(C.placeKey('Stuart') !== C.placeKey('Saint Uart'), 'Stuart is not Saint Uart');

  const loc = C.parseLocality('St Cloud, FL 34771');
  eq(C.localityAgrees(loc, { matchedCity: 'Saint Cloud', via: 'free' }).agrees, true,
     'so a correct street in St Cloud is no longer refused');
}

group('an agreeing postcode outranks a differing town name');
{
  /* Unincorporated Florida: every letter sent there says "Orlando" while OSM
     names the census-designated place "Lake Nona". The postcodes agree, the town
     names do not, and the street is perfectly correct.

     Checking the town first refused it. A genuine wrong-town match disagrees on
     the postcode as well, so it is still refused below — the ordering separates
     the two cases without weakening either. */
  const loc = C.parseLocality('Orlando, FL 32832');
  const a = C.localityAgrees(loc, { matchedCity: 'Lake Nona', matchedZip: '32832',
                                    via: 'free', cityAuthoritative: true });
  eq(a.agrees, true, 'the postcodes agree, so it is not refused over the town name');
  eq(a.strong, true, 'and it is still strong enough to place on');
  ok(/unincorporated/.test(a.note || ''), 'with the discrepancy stated, not hidden');

  // The case this all exists for is untouched: its postcode differs too.
  const d = C.parseLocality('DeBary, FL 32713');
  eq(C.localityAgrees(d, { matchedCity: 'Saint Augustine Beach', matchedZip: '32080',
                           via: 'free', cityAuthoritative: true }).agrees, false,
     'a genuine wrong-town match still disagrees on both and is refused');
}

group('a neighbourhood name may agree but never refuse');
{
  /* Nominatim answers with whatever it has: city, town, village, hamlet,
     suburb. Only the first few are municipalities — the rest are often a
     subdivision or a CDP that no postal address uses. Letting one of those
     refuse a street would reject correct answers on the strength of a name
     nobody outside OSM uses. */
  const loc = C.parseLocality('Orlando, FL');
  eq(C.localityAgrees(loc, { matchedCity: 'Meadow Woods', cityAuthoritative: false,
                             via: 'free' }), null,
     'a weak place type that disagrees is no evidence, not a refusal');
  eq(C.localityAgrees(loc, { matchedCity: 'Orlando', cityAuthoritative: true,
                             via: 'free' }).agrees, true,
     'while a real municipality that agrees still counts');
}

group('a name matching several roads cannot place on the postcode alone');
{
  /* The geocoder is asked for five results and only one was ever used, so a
     street name matching three different roads looked identical to one matching
     exactly one — and the postcode path would place the first of them. That is a
     coin flip wearing the clothes of corroboration. */
  const loc = C.parseLocality('Apopka, FL 32703');
  const hit = { lat: 28.6607, lon: -81.5458, precision: 'address', source: 'nominatim',
                matchedStreet: 'Rider Rain Lane', matchedCity: 'Apopka',
                matchedZip: '32703', via: 'free', cityAuthoritative: true,
                asked: { city: false, county: false, zip: false },
                others: [{ lat: 28.9, lon: -81.9, matchedStreet: 'Rider Rain Ln' }] };

  const r = C.resolveLocation([{ street: 'RIDER RAIN LN', hit: hit }], [],
                              { name: 'X', locality: loc });
  eq(r.status, 'proposed', 'an ambiguous name is proposed, not placed');
  ok(/more than one road/.test(r.why), 'and says so: ' + r.why);

  // The same answer with no rival roads places, as before.
  const solo = Object.assign({}, hit, { others: [] });
  eq(C.resolveLocation([{ street: 'RIDER RAIN LN', hit: solo }], [],
                       { name: 'X', locality: loc }).status, 'located',
     'one road of that name still places');
}

group('what was asked for is tracked field by field');
{
  /* One flag for the whole request was wrong in both directions. The free-form
     query still names the COUNTY, so a county agreement on that path is exactly
     as circular as a postcode one on the structured path — and a per-request
     flag called it volunteered. */
  const loc = C.parseLocality('', 'Volusia County');
  const a = C.localityAgrees(loc, { matchedCounty: 'Volusia', via: 'free',
                                    asked: { city: false, county: true, zip: false } });
  eq(a.agrees, true, 'the county agrees');
  eq(a.asked, true, 'but it was named in the query, so it is marked as asked for');
  eq(a.strong, false, 'and a county never places anything regardless');
}

group('a locality catches the wrong-town match nothing else can see');
{
  /* This is a real answer from the live geocoder, not an invented one. Asked for
     SUNFISH DRIVE it returns Sunfish Drive in Saint Augustine Beach — which
     passes the name gate exactly, and passes the bounding box, because St
     Augustine is inside the division's box. Only corroboration stands between
     that and a pin 180 km from the community. */
  const wrongTown = [{ street: 'SUNFISH DRIVE', hit: {
    lat: 29.8459, lon: -81.2764, precision: 'address', source: 'nominatim',
    matchedStreet: 'Sunfish Drive', matchedCity: 'Saint Augustine Beach', matchedZip: '32080' } }];

  const blind = C.resolveLocation(wrongTown, [], { name: 'DeBary Village TH' });
  eq(blind.status, 'proposed',
     'with nothing to check it against, the best that can be done is to ASK');

  const loc = C.parseLocality('DeBary, FL 32713');
  const seeing = C.resolveLocation(wrongTown, [], { name: 'DeBary Village TH', locality: loc });
  eq(seeing.status, 'pending', 'with the sheet on file it is refused outright');
  ok(/not where/.test(seeing.why) && /Saint Augustine Beach/.test(seeing.why),
     'and the reason names both places: ' + seeing.why);

  /* The refusal is allowed here and ONLY here — nothing corroborates this point
     but itself. Once anything else does, the sheet loses its veto; see below. */
  const sib = [{ name: 'DeBary Village SF', lat: 29.8470, lon: -81.2770 }];
  eq(C.resolveLocation(wrongTown, sib, { name: 'DeBary Village TH', locality: loc }).status,
     'proposed', 'with a sibling agreeing, the sheet can only question it');
}

group('the sheet cannot overrule two streets that agree');
{
  /* This was wrong when first written. The locality check ran per candidate and
     DROPPED anything that disagreed, which took it out of the agreement cluster
     too — so one hand-typed field on a sheet could override two independent
     streets landing on the same patch of ground. That inverts the evidence: two
     streets agreeing is the strongest signal this file has, and a town typed
     into a spreadsheet is among the weakest.

     Worse, the narrowed lookup SENDS the city, so a disagreement could only ever
     surface on the free-form fallback — the path that new-subdivision roads take.
     The veto was aimed squarely at the communities it exists to help. */
  const loc = C.parseLocality('DeBary, FL 32713');
  const two = [
    { street: 'SUNFISH DR', hit: { lat: 28.660, lon: -81.540, precision: 'address',
      source: 'nominatim', matchedStreet: 'Sunfish Dr', matchedCity: 'Sanford',
      matchedZip: '32771', via: 'free' } },
    { street: 'MAHI PL', hit: { lat: 28.662, lon: -81.542, precision: 'address',
      source: 'nominatim', matchedStreet: 'Mahi Pl', matchedCity: 'Sanford',
      matchedZip: '32771', via: 'free' } }
  ];

  const r = C.resolveLocation(two, [], { name: 'DeBary Village TH', locality: loc });
  eq(r.status, 'proposed', 'the streets are not thrown away for disagreeing with the sheet');
  eq(r.confidence, 'agreement', 'and it is still recorded as an agreement');
  ok(/one of the two is wrong/.test(r.why),
     'but it is not applied unwatched either: ' + r.why);
  ok(r.lat === 28.661, "the point is the streets' own, not the sheet's");

  // With no sheet at all, the identical evidence places it. The sheet's only
  // effect is to stop it happening without somebody looking.
  eq(C.resolveLocation(two, [], { name: 'DeBary Village TH' }).status, 'located',
     'the same two streets with no sheet on file are placed');
}

group('two spellings of one road are not two streets');
{
  /* The permit log writes "SUNFISH DR" on one lot and "SUNFISH DRIVE" on the
     next. Counted separately, a single road corroborated ITSELF into an
     automatic placement — which is the agreement rule's entire claim, undone.
     It is the likeliest route to a wrong pin that survived every other gate,
     because both halves are genuinely the right street name. */
  const one = (lat, lon, st) => ({ lat, lon, precision: 'address',
    source: 'nominatim', matchedStreet: st, via: 'free' });

  const r = C.resolveLocation([
    { street: 'SUNFISH DR', hit: one(28.660, -81.540, 'Sunfish Dr') },
    { street: 'SUNFISH DRIVE', hit: one(28.662, -81.542, 'Sunfish Drive') }
  ], [], { name: 'X' });
  eq(r.status, 'proposed', 'one road written twice does not agree with itself');
  ok(r.tried.some(t => /written differently/.test(t.result)),
     'and the audit trail says why it was not counted: ' + JSON.stringify(r.tried));

  // Two genuinely different streets are unaffected.
  eq(C.resolveLocation([
    { street: 'SUNFISH DR', hit: one(28.660, -81.540, 'Sunfish Dr') },
    { street: 'MAHI PL', hit: one(28.662, -81.542, 'Mahi Pl') }
  ], [], { name: 'X' }).status, 'located', 'two real streets still agree');

  // Direction and type synonyms are the same road too.
  eq(C.resolveLocation([
    { street: 'N MAIN ST', hit: one(28.660, -81.540, 'N Main St') },
    { street: 'NORTH MAIN STREET', hit: one(28.662, -81.542, 'North Main Street') }
  ], [], { name: 'X' }).status, 'proposed', 'and so are direction synonyms');
}

group('a proposal says how many streets actually resolved');
{
  /* "Only one street resolved" was printed even when four had and simply landed
     nowhere near each other. That is a different situation with a different fix,
     and reading it as "one" is what makes --accept-single look reasonable when
     it is not. */
  const at = (lat, lon, st) => ({ lat, lon, precision: 'address',
    source: 'nominatim', matchedStreet: st, via: 'free' });
  const r = C.resolveLocation([
    { street: 'ALPHA DR', hit: at(28.60, -81.50, 'Alpha Dr') },
    { street: 'BETA LN', hit: at(28.90, -81.90, 'Beta Ln') },
    { street: 'GAMMA CT', hit: at(29.20, -82.20, 'Gamma Ct') }
  ], [], { name: 'X' });
  eq(r.status, 'proposed', 'scattered streets are proposed, not placed');
  ok(/3 streets resolved/.test(r.why), 'and the count is honest: ' + r.why);
  ok(/km apart/.test(r.why), 'with how far apart they landed');
  ok(!/only one street resolved/.test(r.why), 'never "only one"');
}

group('a postcode both sources agree on is enough to place one street');
{
  const loc = C.parseLocality('Apopka, FL 32704');
  loc.source = 'Community-DB CIS';
  const one = [{ street: 'RIDER RAIN LN', hit: {
    lat: 28.6607, lon: -81.5458, precision: 'address', source: 'nominatim',
    matchedStreet: 'Rider Rain Lane', matchedCity: 'Apopka', matchedZip: '32704',
    via: 'free' } }];

  /* The claim being made: a human filling in a sheet months ago and a mapping
     service today cannot have copied each other, so their agreeing on the
     postcode is independent corroboration — the same KIND of evidence the
     two-streets rule looks for, arriving from a different direction. */
  const r = C.resolveLocation(one, [], { name: 'Rider Rain', locality: loc });
  eq(r.status, 'located', 'one street plus an agreeing postcode places it');
  eq(r.confidence, 'locality', 'recorded as having been placed on the locality');
  ok(/Community-DB/.test(r.evidence[0]), 'and says where the corroboration came from');

  // Without it, exactly the same street is only a proposal. Nothing else changed.
  eq(C.resolveLocation(one, [], { name: 'Rider Rain' }).status, 'proposed',
     'the same evidence minus the sheet is still only a proposal');
}

group('a town is not a location');
{
  /* The line this draws. A postcode is a few square miles; a municipality can be
     twenty across, and "roughly the right area" is not evidence of a location —
     that is the whole reason the agreement radius is 1.5 km and not 15. So a
     city-only agreement makes a better PROPOSAL, never a placement. */
  const loc = C.parseLocality('Apopka, FL');       // no ZIP on this sheet
  const one = [{ street: 'RIDER RAIN LN', hit: {
    lat: 28.6607, lon: -81.5458, precision: 'address', source: 'nominatim',
    matchedStreet: 'Rider Rain Lane', matchedCity: 'Apopka', matchedZip: null } }];

  const r = C.resolveLocation(one, [], { name: 'Rider Rain', locality: loc });
  eq(r.status, 'proposed', 'a matching town alone does not place it');
  ok(r.evidence.some(e => /a town is not a location/.test(e)),
     'and the proposal says why it is only a proposal: ' + JSON.stringify(r.evidence));
}

group('a road with no address tags is not punished for it');
{
  /* Most roads in a subdivision built last year carry no city or postcode in
     OSM. If a missing field read as a refusal, this whole feature would reject
     precisely the communities it exists to place. */
  const loc = C.parseLocality('Davenport, FL 33837');
  const bare = [
    { street: 'PLANK PL', hit: { lat: 28.2048, lon: -81.6471, precision: 'street',
      source: 'nominatim', matchedStreet: 'Plank Place', matchedCity: null, matchedZip: null } },
    { street: 'SECOND ST', hit: { lat: 28.2060, lon: -81.6480, precision: 'street',
      source: 'nominatim', matchedStreet: 'Second St', matchedCity: null, matchedZip: null } }
  ];
  const r = C.resolveLocation(bare, [], { name: 'Somewhere', locality: loc });
  eq(r.status, 'located', 'two agreeing streets still place it');
  eq(r.confidence, 'agreement', 'on agreement, exactly as before the sheet existed');
}

group('one road is looked up once, not once per spelling');
{
  const doc = { communities: [{ num: '1', name: 'X', lat: null, lon: null, starts: [] }] };
  const streets = { '1': { 'SUNFISH DR': 3, 'SUNFISH DRIVE': 14, 'MAHI PL': 6 } };
  const got = C.pendingLocations(doc, streets)[0].streets;

  /* Two spellings of one road cost two geocoder requests at a second apiece to
     learn the same fact twice — and resolveLocation has to discard the duplicate
     at the far end anyway. Merged here, before anything is asked. */
  eq(got.length, 2, 'the two spellings of Sunfish are one entry');
  eq(got[0], { street: 'SUNFISH DRIVE', lots: 17 },
     'keeping the spelling the log favours, and the combined lot count');
  eq(got[1].street, 'MAHI PL', 'and the genuinely different road survives');
}

group('the audit trail is not published to the world');
{
  /* Locating writes who did what onto the community: placedBy, confirmedBy and
     rejected[].by are staff email addresses, and rejection reasons are free text
     somebody typed. All of it lives INSIDE payload.

     map_public is the only object anon can read, and it already refuses to
     publish updated_by for being one staff email — so geo travelling through
     inside payload would have walked a whole audit trail through the door that
     column was kept out of. The view strips it. Asserted here because the SQL
     cannot be run from a test, and a security property nobody checks is a
     security property that regresses. */
  const sql = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'map_supabase_setup.sql'), 'utf8');

  const view = sql.slice(sql.indexOf('create view public.map_public'),
                         sql.indexOf('revoke all on public.map_public'));
  ok(/-\s*'geo'/.test(view), 'the view subtracts geo from each community');
  ok(/jsonb_set\(payload, '\{communities\}'/.test(view),
     'and rebuilds payload around it rather than dropping payload wholesale');
  ok(/SECURITY: % communities still expose a geo block/.test(sql),
     'and the script asserts afterwards that none is reachable');
}

group('joining Community-DB rows to map communities');
{
  /* The join is the JDE number through normCommunityId — the same function the
     permit log goes through — so it is exact rather than a name match, and both
     lot-number widths land on the same community. */
  const rows = [
    { jde: '2641672', status: 'published', data: { f: { city_state_zip: 'DeBary, FL 32713' } } },
    { jde: '1114972', status: 'published', data: { f: { city_state_zip: 'Apopka, FL 32703' } } },
    { jde: '9999999', status: 'published', data: { f: {} } },
    { jde: '', status: 'published', data: { f: { city_state_zip: 'Nowhere, FL' } } }
  ];
  const by = C.localitiesFrom(rows);
  eq(Object.keys(by).sort(), ['11149720000', '26416720000'],
     "keyed by the map's community number, and a sheet with no locality is skipped");
  eq(by['26416720000'].zip, '32713', 'with the locality attached');
  ok(/Community-DB/.test(by['26416720000'].source), 'and where it came from');

  /* Publish is the act that says a value is meant to be believed — the same rule
     the map follows everywhere else — so a draft never shadows a published row. */
  const both = C.localitiesFrom([
    { jde: '2641672', status: 'draft', data: { f: { city_state_zip: 'Sanford, FL 32771' } } },
    { jde: '2641672', status: 'published', data: { f: { city_state_zip: 'DeBary, FL 32713' } } }
  ]);
  eq(both['26416720000'].city, 'DeBary', 'the published row wins over a draft');

  // But a draft on its own is better than nothing, and says that it is a draft.
  const draftOnly = C.localitiesFrom([
    { jde: '2641672', status: 'draft', data: { f: { city_state_zip: 'Sanford, FL 32771' } } }
  ]);
  eq(draftOnly['26416720000'].city, 'Sanford', 'a draft is used when it is all there is');
  ok(/draft/.test(draftOnly['26416720000'].source), 'and is labelled as one');

  eq(C.localitiesFrom(null), {}, 'no rows at all is not an error');
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
