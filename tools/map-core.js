/* ============================================================================
   map-core.js — how the Community Map document is built from the workbooks.

   Pure logic: no filesystem, no network, no process. Every input is passed in
   and every finding is returned, so the same code runs in node (via
   tools/import-workbooks.js) and in the browser (via Blueprint's Data Intake).

   Loaded in the browser as window.MAPCORE; required in node as module.exports.

   ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
   This was the body of import-workbooks.js. It moved here so Blueprint can
   publish the map from the same upload that feeds Vendor Assignments and Takeoff
   Flow, without a second implementation of the merge. The CLI is now a wrapper
   that reads files, calls buildDocument(), and prints the findings; the browser
   calls the same function and renders them.

   The header comment on the original still applies and is the thing to keep in
   mind when changing anything here:

     MERGE, NOT REBUILD. The workbooks carry starts, trade assignments and
     contacts. Coordinates, municipality, utilities and plans exist only in the
     published document and are preserved. New communities get a null coordinate
     and are reported.

   ── WHAT CALLERS MUST NOT DO ─────────────────────────────────────────────────
   `tradeCats` and `vendors` are index-compressed and re-interned on every run,
   so their indices are NOT stable between documents. Never diff two documents'
   `trades` maps by index, and never merge a `communities` array from one run into
   the lookups of another.
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MAPCORE = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ------------------------------------------------------------- primitives */

  const S = v => (v == null ? null : String(v).trim() || null);
  const digits = v => String(v == null ? "" : v).replace(/\D/g, "");

  /* A job number carries the community in its first 7 digits; the map keys
     communities by the 11-digit form. "26320724105" → 2632072 + 0000.

     The threshold is 7, not 11. It used to be 11, and that was a real bug with a
     large effect: 485 of the 6,674 jobs in the Orlando permit log carry a 3-digit
     lot rather than a 4-digit one, so they are 10 characters long, and every one
     of them fell through unnormalised. Each became its own "community" — Hunt
     Club 40GC alone split into 208 of them — taking the division from 94
     communities to 575, all but a handful with no coordinates.

     Eleven only ever looked right because the majority of jobs happen to be that
     long. Seven is the actual structure: seven digits of community, then a lot
     number of whatever width. This matches Takeoff Flow, which has always used 7
     and has always produced the correct count. */
  const normCommunityId = v => {
    const d = digits(v);
    if (!d) return null;
    return d.length >= 7 ? d.slice(0, 7) + "0000" : d;
  };

  function xlDate(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") {
      const d = new Date(Math.round((v - 25569) * 86400 * 1000));
      return isNaN(d) ? null : d.toISOString().slice(0, 10);
    }
    const d = new Date(v);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }

  const cleanCommName = desc =>
    !desc ? null : (desc.replace(/\(.*?\)/g, "").replace(/[-*].*$/, "").trim() || null);

  const normName = v => String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9]/g, "");

  // Person ids are the email local part, lowercased. Stable across runs, so a
  // community's cms[] does not churn when the sheet is re-imported.
  const personIdFor = email =>
    String(email).split("@")[0].toLowerCase().replace(/[^a-z0-9]+/g, ".");

  /* ------------------------------------------------------------- name tables

     These were hard-coded in the importer, which meant onboarding a development
     was a code edit in someone's repo. They are still constants here, but they
     are exported and every entry point accepts an override, so a future move into
     a table is a change of caller rather than a change of logic.               */

  // Sheet name (normalized) → the map's name prefix, for the cases where the two
  // naming conventions genuinely differ rather than just adding a suffix.
  const COMMUNITY_ALIASES = {
    scenicterrace:         "scenicterr",
    ranchesatmcleod:       "ranches",
    providencegardenhills: ["provgarden", "providence"],
    theparksofedgewater:   "edgewater",
    wellnessridge:         "wellness",

    // Bridgewalk is the development; the map lists its phases as Springhead 25,
    // 25GC, 40, 50 and 60. Confirmed independently: the five managers on the
    // Bridgewalk rows are exactly the five already assigned to Springhead.
    bridgewalk:            "springhead",

    // "Sanctuary at Wellness" — always written as "Wellness Ridge/Sanctuary" in
    // the sheet, so today it resolves to the same Wellness phases that row already
    // covers. The second key is there so that if a Sanctuary record ever appears
    // on the map under its own name it is picked up rather than silently missed.
    sanctuary:             ["wellness", "sanctuary"]
  };

  // "Westview and Waterlin" · "Meadow Pointe & Hidden Ridge" · "Peace Creek TH / Lake Hamilton"
  const COMMUNITY_SPLIT = /\s+and\s+|\s*&\s*|\s*\/\s*/i;

  // Developments named in the contact sheet that deliberately do not appear on
  // the map. Without this they would be reported as unmatched on every run, which
  // trains people to ignore the one warning that catches a genuinely new
  // development.
  const IGNORED_DEVELOPMENTS = {
    thecove:      "not a community on the map",
    lakehamilton: "not a community on the map"
  };

  // Communities on the map that legitimately have nobody assigned yet. Checked
  // both ways: an entry here that HAS gained contacts is reported so the list
  // cannot quietly rot into a permanent excuse.
  const AWAITING_CONTACTS = {
    cloverleaf:    "new project, no contacts assigned yet",
    cypressrsrvth: "new project, no contacts assigned yet",
    ridgebrooke:   "new project, no contacts assigned yet"
  };

  /* Schedulers park a block of homes on a single nominal date. Counting those as
     real starts spikes a month that has nothing actually happening in it. Ten on
     one community-day is real and is kept; eleven or more is a placeholder. */
  const PLACEHOLDER_PER_DAY = 10;

  /* There is deliberately no shrink guard any more. It existed because an import
     could delete communities, and it cannot: `ids` always contains every existing
     community, so the count can only hold steady or rise. A guard that can never
     fire is worse than no guard — it reads as protection that is not there. What
     replaced it is the rule itself, in buildDocument(): an import never removes. */

  /* A run that multiplies the community count is the failure worth guarding.
     Two separate causes were found doing exactly that, both now fixed at source:
     the RE2 export defining existence, and the ≥11 job-number threshold above.
     This is the backstop for the next one.

     Growth is normal — a division opens communities. Doubling in a single import
     is not. Expressed as a multiple of the existing count rather than a flat
     number so it stays meaningful as the map grows. */
  const GROWTH_REFUSE = 2.0;

  /* ========================= LOCATING A NEW COMMUNITY =======================

     A community arrives from the workbooks with no coordinate. Nothing in any
     workbook supplies one, and until it has one the community is held off the
     map along with its starts.

     The permit log does carry an Address per lot, so the streets are known even
     before the house numbers are. What follows turns those streets into a
     coordinate — and, much more importantly, refuses to when it cannot be sure.

     ── WHY THIS IS SO CONSERVATIVE ───────────────────────────────────────────
     A geocoder's job is to return its best guess. Ask it for a street that does
     not exist yet — which is the normal state of a new subdivision — and it will
     cheerfully return a similarly-spelled street somewhere else in the state. A
     pin in the wrong place is worse than no pin: no pin is visibly missing and
     someone fixes it, whereas a wrong pin is believed. Every rule below exists to
     make a confident wrong answer impossible rather than to maximise hit rate.

     Three independent gates, all of which must pass:

       1. STRICT NAME MATCH. The street the geocoder matched must be the street
          asked for. Street *types* are normalised (AVENUE ↔ AVE) because those
          are genuine synonyms; the distinctive words must be equal, token for
          token. "White Holly" never matches "White Hollow".

       2. INSIDE THE DIVISION. Outside the bounding box, discarded.

       3. CORROBORATION. A single street's coordinate is never trusted on its own,
          because a same-named street in another town passes gates 1 and 2. It
          needs either
            · a second distinct street of the same community landing nearby, or
            · an already-located sibling community — the other phase of the same
              development — landing nearby.
          With neither, the result is offered for confirmation but never applied.

     Of the 94 communities in the Orlando log, 24 have only one street, so gate 3
     is doing real work rather than covering a rare case. And one community's
     entire address column reads "TBD" with no street at all, which no amount of
     cleverness can resolve — it stays pending, and pending is a fine answer.
     ======================================================================== */

  /* Street types that are the same thing written differently. Normalised so a
     match on the type alone cannot fail, while leaving the distinctive part of
     the name to be compared exactly. */
  const STREET_TYPES = {
    AVENUE: "AVE", AV: "AVE", AVE: "AVE",
    BOULEVARD: "BLVD", BLVD: "BLVD",
    CIRCLE: "CIR", CIR: "CIR",
    COURT: "CT", CT: "CT",
    COVE: "CV", CV: "CV",
    CROSSING: "XING", XING: "XING",
    DRIVE: "DR", DR: "DR",
    HIGHWAY: "HWY", HWY: "HWY",
    LANE: "LN", LN: "LN",
    LOOP: "LOOP",
    PARKWAY: "PKWY", PKWY: "PKWY",
    PASS: "PASS",
    PATH: "PATH",
    PLACE: "PL", PL: "PL",
    POINT: "PT", PT: "PT",
    RIDGE: "RDG", RDG: "RDG",
    ROAD: "RD", RD: "RD",
    RUN: "RUN",
    SQUARE: "SQ", SQ: "SQ",
    STREET: "ST", ST: "ST",
    TERRACE: "TER", TER: "TER",
    TRAIL: "TRL", TRL: "TRL",
    WAY: "WAY"
  };

  // Directional prefixes/suffixes, normalised the same way.
  const DIRECTIONS = { NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W",
                       N: "N", S: "S", E: "E", W: "W",
                       NORTHEAST: "NE", NORTHWEST: "NW",
                       SOUTHEAST: "SE", SOUTHWEST: "SW",
                       NE: "NE", NW: "NW", SE: "SE", SW: "SW" };

  /* The street part of a permit-log address. Drops a leading house number, or the
     "TBD" that stands in for one before lots are numbered. Returns null when
     there is nothing left — Ridgebrooke's entire address column is the bare word
     "TBD", and inventing a street from that would be the exact failure this file
     is written to avoid. */
  function streetOf(addr) {
    let s = String(addr == null ? "" : addr).trim();
    if (!s) return null;
    s = s.replace(/^(?:tbd|t\.b\.d\.?)\s*/i, "")     // TBD Sunfish Drive
         /* A house number jammed against the street with no space. The real log
            has "1928PINE MEADOWS GOLFCOURSE RD", and leaving the number in makes
            every lot on that road its own street name — so nothing can ever
            corroborate anything.

            The negative lookahead protects genuinely numbered streets: "42ND ST"
            must survive intact, so digits followed by an ordinal suffix are left
            alone. No optional trailing letter here either — allowing one turned
            "1928PINE" into "INE" by eating the P. */
         .replace(/^\d+(?!(?:st|nd|rd|th)\b)(?=[a-z])/i, "")   // 1928PINE MEADOWS…
         .replace(/^\d+[a-z]?\s+/i, "")                        // 1660 Rider Rain Ln
         .replace(/\s*(?:lot|unit|apt|#)\s*\S+$/i, "")
         .replace(/\s+/g, " ")
         .trim();
    if (!s) return null;
    // A bare "TBD", or anything with no letters, is not a street.
    if (/^t\.?b\.?d\.?$/i.test(s)) return null;
    if (!/[a-z]/i.test(s)) return null;

    /* Nor is a building schedule. Tampa's log writes the common-area buildings
       into the same Address column as lot ranges — "COMM BLDG - 0085-0090",
       eighteen of them on SouthCreek 20TH alone. They are not addresses, no
       geocoder will ever find one, and they crowd the real streets: the lookup
       budget is six per community and every slot one of these takes is a road
       that never got asked about.

       Deliberately narrow: it names the labels the logs actually use, and wants
       a numeric RANGE before dropping anything on shape alone. The first draft
       matched "a word, a dash, some digits" and quietly ate CR-54 and US-301 —
       real Pasco County roads, and exactly the kind a new subdivision sits on.
       The asymmetry settles it: an unrecognised label costs one lookup and a
       "no result", while a discarded street can cost a community its pin. */
    if (/^(?:comm(?:on)?|cmn)\s*(?:bldg|building|area)\b/i.test(s)) return null;
    if (/\b(?:bldg|building|unit|lot|lots|phase|tract)\b/i.test(s)
        && /\d+\s*[-–—]\s*\d+\s*$/.test(s)) return null;
    return s.toUpperCase();
  }

  /* Comparable form of a street name: uppercase tokens, punctuation dropped,
     types and directions canonicalised. Deliberately NOT fuzzy — no stemming, no
     edit distance, no dropping of unrecognised words. */
  function streetKey(street) {
    const toks = String(street == null ? "" : street)
      .toUpperCase()
      .replace(/[^A-Z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map(t => STREET_TYPES[t] || DIRECTIONS[t] || t);
    return toks.join(" ");
  }

  /* Is the street a geocoder matched the street that was asked for?

     Equality on the normalised key, with one allowance: a geocoder often returns
     a street with no type where the source had one, or vice versa. Dropping a
     trailing type from both sides is safe because the distinctive words still
     have to match exactly. Nothing else is forgiven. */
  function sameStreet(asked, matched) {
    const a = streetKey(asked), b = streetKey(matched);
    if (!a || !b) return false;
    if (a === b) return true;
    const strip = k => {
      const t = k.split(" ");
      return (t.length > 1 && Object.values(STREET_TYPES).indexOf(t[t.length - 1]) !== -1)
        ? t.slice(0, -1).join(" ") : k;
    };
    const sa = strip(a), sb = strip(b);
    // Both must still have a distinctive part left, or "AVE" would match "AVE".
    return !!sa && !!sb && sa === sb;
  }

  /* ── A DIRECTION THE ANSWER LEFT OUT ──────────────────────────────────────
     sameStreet stays exactly as strict as it reads: it decides, on its own,
     whether a pin may be placed, and every relaxation of it is a chance to put
     one in the wrong town. This is a separate, weaker question asked only after
     it has said no.

     Manatee County numbers its grid and hangs a direction off it — 77th Avenue
     East and 77th Avenue West are different roads a few miles apart, and
     confusing them is precisely the failure being guarded against. But
     OpenStreetMap tags that suffix inconsistently: "71ST TER E" came back as
     "71st Terrace E" and matched, while "77TH AVE E" came back as plain "77th
     Avenue" and was refused. Same county, same grid, same run.

     So the distinction is between an answer that OMITS the direction and one
     that CONTRADICTS it. Omission is missing information — the road may well be
     the right one, tagged carelessly. Contradiction is a different road, and
     stays a hard no. Returns "exact", "weak" or "no"; what a caller may do with
     "weak" is decided in resolveLocation, and it is never enough on its own. */
  const DIR_SET = new Set(Object.values(DIRECTIONS));
  function directionsIn(key) {
    return String(key || "").split(" ").filter(t => DIR_SET.has(t));
  }
  function nameMatch(asked, matched) {
    if (sameStreet(asked, matched)) return "exact";
    const a = streetKey(asked), b = streetKey(matched);
    if (!a || !b) return "no";
    const da = directionsIn(a), db = directionsIn(b);
    // Only the case where one side names a direction and the other names none.
    if (!(da.length && !db.length) && !(db.length && !da.length)) return "no";
    const drop = k => k.split(" ").filter(t => !DIR_SET.has(t)).join(" ");
    return sameStreet(drop(a), drop(b)) ? "weak" : "no";
  }

  // Metres between two {lat,lon}. Null-safe: a missing coordinate is not a
  // position at 0,0, it is the absence of one, so the answer is null.
  function metresBetween(a, b) {
    if (!a || !b) return null;
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return null;
    if (!Number.isFinite(b.lat) || !Number.isFinite(b.lon)) return null;
    const R = 6371000, rad = x => x * Math.PI / 180;
    const dp = rad(b.lat - a.lat), dl = rad(b.lon - a.lon);
    const h = Math.sin(dp / 2) ** 2
            + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Orlando division. Same box validate.js uses, kept here so the resolver can
  // reject an out-of-area match without a second source of truth.
  const BBOX = { minLat: 26.5, maxLat: 30.5, minLon: -83.0, maxLon: -80.0 };
  const inBox = h => !!h && Number.isFinite(h.lat) && Number.isFinite(h.lon)
    && h.lat >= BBOX.minLat && h.lat <= BBOX.maxLat
    && h.lon >= BBOX.minLon && h.lon <= BBOX.maxLon;

  /* ── THE PHASE NEXT DOOR, WHEN NOTHING ELSE IS LEFT ───────────────────────
     Offered only after the geocoders have been asked and have nothing: the
     road is too new for OpenStreetMap and for the Census alike, and no amount
     of re-running changes that this month.

     What is still true is that a phase of the same development is already on
     the map, and phases are the same piece of land — the widest development in
     either division spans 1.4 km. So the development's own position is a real
     answer to "roughly where is this", which is the question the map is for:
     it exists to show where work is and how much of it, at a zoom where a
     kilometre is a pin's width.

     A PROPOSAL, never a placement, and that distinction is the whole safety of
     it. Nothing here was verified against this community's own streets, so a
     person confirms it — and confirming is something they can actually do,
     unlike a lone street in a town they have no way to check. It is the
     coordinate they would have looked up by hand anyway, filled in for them.

     Skipped when a geocoded proposal already exists: that one is about THIS
     community, and evidence about the thing itself outranks evidence about its
     neighbours. */
  function developmentFallback(name, located) {
    const dev = developmentOf(name || "");
    if (!dev) return null;
    const sibs = (located || []).filter(s =>
      s && s.name && Number.isFinite(s.lat) && Number.isFinite(s.lon) &&
      !(s.lat === 0 && s.lon === 0) && developmentOf(s.name) === dev &&
      s.name !== name);
    if (!sibs.length) return null;

    /* The centre of the development rather than whichever phase sorted first —
       with several placed, the middle of them is the better guess for one whose
       own position is unknown, and it does not depend on array order. */
    const lat = +(sibs.reduce((a, s) => a + s.lat, 0) / sibs.length).toFixed(7);
    const lon = +(sibs.reduce((a, s) => a + s.lon, 0) / sibs.length).toFixed(7);
    const names = sibs.map(s => s.name);
    return {
      lat, lon, from: names,
      why: "no geocoder has this community's streets yet, but "
         + (names.length === 1 ? names[0] + " is"
            : names.length + " phases of the same development are")
         + " already on the map at this point. Phases sit on one piece of land — "
         + "the widest development anywhere in the data spans 1.4 km — so this is "
         + "the right neighbourhood, not the exact street. Confirm to put it on "
         + "the map approximately, or place it precisely yourself"
    };
  }

  /* ── ASKING A NARROWER QUESTION WHEN A PHASE IS ALREADY PLACED ─────────────
     The refusal below tells a community it cannot be 143 km from its own phase.
     Useful, but it arrives too late to help: the geocoder was asked "where is
     ALLENDALE STREET in the whole division", answered with the one in Titusville,
     and the answer had to be thrown away. The road actually wanted may well have
     been the second or third result, or may simply not have been asked for.

     So when a development already has a phase on the map, ask the narrower
     question instead — the same trick the Community Information Sheet plays with
     a city and postcode, using evidence we already hold rather than evidence
     somebody has to type. Nominatim takes viewbox + bounded, which the division
     filter already uses; this only tightens the box.

     Sized to exactly the region where an answer would be ACCEPTED anyway: every
     located phase, expanded by the same radius beyond which a sibling refuses. A
     point outside this box could not have survived resolveLocation, so nothing
     findable is lost — the box cannot change which answers are legal, only which
     ones the geocoder bothers to return. Clipped to the division, because a
     development near the edge would otherwise widen the search past it. */
  function siblingBox(name, located, radiusM) {
    const dev = developmentOf(name || "");
    if (!dev) return null;
    const sibs = (located || []).filter(s =>
      s && s.name && Number.isFinite(s.lat) && Number.isFinite(s.lon) &&
      !(s.lat === 0 && s.lon === 0) && developmentOf(s.name) === dev);
    if (!sibs.length) return null;

    const r = radiusM || SIBLING_REFUSE_M;
    const lats = sibs.map(s => s.lat), lons = sibs.map(s => s.lon);
    const dLat = r / 111320;
    /* A degree of longitude shrinks towards the poles, so converting the radius
       at the wrong latitude makes the box too narrow east-west — which WOULD
       start excluding legal answers. Taken at the phases' own latitude. */
    const midLat = lats.reduce((a, v) => a + v, 0) / lats.length;
    const dLon = r / (111320 * Math.max(0.15, Math.cos(midLat * Math.PI / 180)));

    return {
      minLat: Math.max(Math.min.apply(null, lats) - dLat, BBOX.minLat),
      maxLat: Math.min(Math.max.apply(null, lats) + dLat, BBOX.maxLat),
      minLon: Math.max(Math.min.apply(null, lons) - dLon, BBOX.minLon),
      maxLon: Math.min(Math.max.apply(null, lons) + dLon, BBOX.maxLon)
    };
  }

  /* Both thresholds are set from the division's actual geometry, not guessed.
     Measured across the 71 located communities:

       widest span of any one development   1.4 km   (Wellness, 13 phases)
       typical span                         0.4–0.6 km

     The first guesses were 3 km and 8 km. Those are not "safe" for being
     generous — a loose radius is what lets an unrelated subdivision corroborate a
     wrong answer, which is the one failure this whole mechanism exists to
     prevent. Tightened to roughly double the widest real case, which leaves room
     for a geocoder returning a block centroid or the far end of a road while
     staying far too tight to span two different towns.

     If a genuinely wider development ever appears, this will refuse to locate it
     and say so, which is the right way round: a pending community is visible and
     fixable, a confidently wrong pin is not. */
  const AGREE_M = 1500;      // two streets of ONE community
  const SIBLING_M = 3000;    // another located phase of the same development

  /* And the distance at which a located phase stops being silent and starts
     REFUSING. Corroboration was the only thing a sibling could do — within 3 km
     it vouched, beyond that it said nothing — and "says nothing" is the wrong
     reading of a development whose other phases are ninety kilometres from the
     point on offer. Phases of one development are adjacent by construction: the
     same piece of land, bought once and built out in stages.

     Tampa's first run made the cost visible. Twelve proposals went to a person
     to confirm and eight were impossible on evidence already in the document —
     "Seaire 40" offered in Orlando with Seaire 50 sitting 136 km away in Manatee
     County, "Acacia 50" 88 km from three located Acacias, both Stonegates 20-odd
     km from the Stonegate already on the map. Every one was a correctly-spelled
     street of the same name in another town: the exact failure this file exists
     to prevent, arriving through the one gap where the strongest evidence
     available was never consulted.

     Deliberately five times the corroboration radius, leaving a wide band
     between 3 and 15 km where a sibling neither vouches nor refuses. The widest
     real development spans 1.4 km, so 15 km is an order of magnitude past
     anything genuine — the band is for a development that grows in a way nobody
     has seen yet, not for the cases above. */
  const SIBLING_REFUSE_M = 15000;

  /* Development name, for sibling matching: "Waterlin 40RL" and "Waterlin 50" are
     both Waterlin. The map's own index.html has the same rule for grouping pins;
     a test asserts the two agree, since they must.

     Tampa's series words (ASC, COT, SER, PIN, EVE, MJ) sit alongside Orlando's,
     and CL/PA/RLTH are what a 15-character source field leaves of CLA/PAR/RL TH.
     Both matter here as much as they do to pin grouping: this rule also decides
     which located phase may vouch for a sibling's coordinate, so a designator it
     does not know is a corroboration that never gets offered. */
  const DESIGNATOR = /^(\d+[a-z]*|[a-z]\d+|(?:th|gc|aa|rl|fl|mjr|m|villa|classic|majors|sf|par|cla|vil|maj|asc|cot|ser|pin|eve|mj|cl|pa|rlth)\d*)$/i;
  function developmentOf(name) {
    const t = String(name == null ? "" : name).split(/\s+/).filter(Boolean);
    while (t.length > 1 && DESIGNATOR.test(t[t.length - 1])) t.pop();
    return t.join(" ").replace(/\d+$/, "").trim().toLowerCase();
  }

  /* ── WHERE THE COMMUNITY IS SUPPOSED TO BE ────────────────────────────────
     The permit log gives street names and nothing else. Community-DB gives the
     other half: someone fills in a Community Information Sheet for a project
     long before its first permit, and that sheet carries "City, State, Zip" and
     the permitting municipality, against a JDE number that normalises to exactly
     the community number the map uses. It is an exact join, not a name match.

     This is worth having for two separate reasons, and they should not be
     confused with each other.

     1. IT NARROWS THE QUESTION. "SUNFISH DRIVE, FL, USA" is a question about a
        state; "SUNFISH DRIVE, DeBary, FL 32713" is a question about one postal
        area. Not a small one — an exurban Florida postcode can run to ninety
        square miles and hold a dozen subdivisions — but a state has sixty-five
        thousand. More streets resolve, and fewer resolve to the wrong one.

     2. IT CORROBORATES. This is the larger claim, so it is worth being explicit
        about why it is allowed. The failure this whole file exists to prevent is
        a correctly-named street in ANOTHER TOWN being accepted. A postcode that
        the CIS and the geocoder agree on excludes exactly that, from a source
        that knows nothing about the geocoder — a human filling in a sheet. It is
        not a weaker form of the agreement rule; it is the same kind of evidence,
        from a different direction.

     What it must never become is a bare "the CIS said DeBary, so put it in
     DeBary". The coordinate still comes from a street that passed the name gate.
     The locality only answers "is this the right town", which is the one question
     a single street cannot answer for itself.                                   */

  /* A CIS locality, however it was typed. The sheet is filled in by hand, so
     "DeBary, FL 32713", "Debary FL", "DeBary, Florida, 32713-1234" and a stray
     "City of DeBary" all occur. Everything that cannot be read confidently comes
     back null rather than as a guess — a wrong city is worse than no city, since
     it would narrow the search to the wrong place and then corroborate it. */
  /* What people write in a field they cannot yet fill in. Matched whole, so a
     genuine place is never caught by it — there is no Florida town called TBD,
     but there is one called Ona. */
  const FILLER = /^(?:n\s*a|na|n\/a|tbd|t\.?b\.?d\.?|tba|none|null|unknown|unk|pending|various|same|see above|x+|-+|\?+)$/i;

  function parseLocality(text, extra) {
    const raw = String(text == null ? "" : text).trim();
    const out = { city: null, state: null, zip: null, county: null, raw: raw || null };

    /* The LAST five-digit run, not the first. The column is headed "City, State,
       Zip" but people paste whole addresses into it, and a house number is
       frequently five digits too — "10500 Lake Nona Blvd, Orlando, FL 32827"
       read left to right yields a postcode of 10500. That would then be sent to
       the geocoder as a filter, and matched back against itself. ZIP+4 is
       truncated; the map has no use for the +4. */
    const zips = raw.match(/\b\d{5}(?:-\d{4})?\b/g);
    if (zips) out.zip = zips[zips.length - 1].slice(0, 5);

    let rest = out.zip ? raw.replace(new RegExp("\\b" + out.zip + "(?:-\\d{4})?\\b"), " ") : raw;

    const sm = rest.match(/\b(FL|FLA|FLORIDA)\b/i);
    if (sm) { out.state = "FL"; rest = rest.replace(sm[0], " "); }

    /* The LAST comma segment, for the same reason. In "City, State, Zip" the
       city is the only segment left once the state and postcode are gone; in a
       pasted address it is the segment after the street. Taking the first gave
       "10500 Lake Nona Blvd" as the town. */
    const segs = rest.split(",").map(x => x.replace(/[^A-Za-z .'-]/g, " ")
                                           .replace(/\s+/g, " ").trim())
                     .filter(Boolean);
    let city = segs.length ? segs[segs.length - 1] : "";

    const county = city.match(/^(?:unincorporated\s+)?(.+?)\s+(?:county|co\.?)$/i);
    if (county) {
      /* A county is NOT a city, and handing one to a geocoder as a city is how a
         findable road becomes "no result". */
      out.county = county[1].trim();
      city = "";
    } else {
      city = city.replace(/^(?:city|town|village)\s+of\s+/i, "").trim();
    }

    /* A hand-filled sheet is full of placeholders, and "n/a" read as a town
       called "n a" is worse than reading nothing: it would narrow the geocoder's
       search to a place that does not exist, and the failure would look like the
       street being too new. Anything shorter than three letters is not a Florida
       municipality either — and a segment that is plainly a street rather than a
       town is not one, which is what is left when somebody pastes an address
       with no city in it at all. */
    const toks = city.toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
    const looksLikeStreet = toks.length > 1
      && Object.prototype.hasOwnProperty.call(STREET_TYPES, toks[toks.length - 1]);
    if (city && /[a-z]/i.test(city) && city.replace(/[^A-Za-z]/g, "").length >= 3
        && !FILLER.test(city) && !looksLikeStreet) {
      out.city = city;
    }

    /* The permitting municipality is a second, weaker field on the same sheet.
       It fills a gap but never overrides — "City, State, Zip" is the address
       line and is what a geocoder is being asked about. */
    if (extra && !out.city && !out.county) {
      const second = parseLocality(extra);
      if (second) {
        out.city = second.city;
        out.county = out.county || second.county;
        out.state = out.state || second.state;
      }
    }
    return (out.city || out.zip || out.county) ? out : null;
  }

  /* Comparable form of a place name. Deliberately as strict as sameStreet(): no
     fuzzy matching, because the whole value of this field is that it can rule a
     wrong town OUT, and a comparison that forgives differences cannot do that. */
  function placeKey(name) {
    return String(name == null ? "" : name)
      .toUpperCase()
      .replace(/\b(?:CITY|TOWN|VILLAGE)\s+OF\s+/g, "")
      .replace(/\b(?:COUNTY|CO)\b\.?/g, "")
      /* Abbreviation families, expanded before the punctuation is stripped.
         Florida is full of these and the two sources do not agree: the map's own
         data says "St Cloud" while the geocoder answers "Saint Cloud". Compared
         literally those are different towns, and a difference in town is a
         REFUSAL — so this one gap silently rejected correct streets in every St,
         Ft and Mt community in the division. */
      .replace(/\bST\b\.?\s+/g, "SAINT ")
      .replace(/\bFT\b\.?\s+/g, "FORT ")
      .replace(/\bMT\b\.?\s+/g, "MOUNT ")
      .replace(/[^A-Z0-9]+/g, "")
      .trim();
  }

  /* Does a geocoder's answer agree with the CIS about which town this is?

     Returns null when there is nothing to compare — no locality on file, or the
     provider did not report one. Null means "no evidence", NOT "disagrees": an
     absent field must never be read as a refusal, or every community whose CIS
     nobody has filled in would look actively wrong.

     Returns { agrees:false, on:"…" } when they genuinely conflict, which is a
     stronger signal than agreement and is acted on separately below. */
  function localityAgrees(locality, hit) {
    if (!locality || !hit) return null;

    // A postcode is worth more than a city name: it cannot be spelled two ways,
    // and it pins a few square miles rather than a municipality.
    /* WHY `via` decides whether an agreement counts for anything.

       A geocoder can be ASKED for a postcode or it can VOLUNTEER one, and only
       the second is evidence. The lookup narrows its first attempt by the
       sheet's own city and postcode, so anything that attempt returns carries
       that postcode by construction — checking it against the sheet it came
       from is circular, and the agreement is guaranteed rather than earned.

       That is not a theoretical worry. A transposed postcode on a hand-filled
       sheet, plus any same-named street inside the wrong one, would otherwise
       produce a confidently wrong pin with nobody asked — which is the single
       failure this entire file is written to make impossible.

       So a constrained answer still counts as narrowing, and its DISAGREEMENTS
       still count (a free-form fallback answer that names another town is
       refused exactly as before), but it cannot corroborate itself. */
    /* Per FIELD, not per request — see geo-client. A value the geocoder was
       handed cannot corroborate the thing it was handed from. */
    const askedFor = hit.asked || { city: hit.via === "structured",
                                    county: hit.via === "structured",
                                    zip: hit.via === "structured" };

    const cmp = (a, b) => (a && b) ? (placeKey(a) === placeKey(b)) : null;
    const city = cmp(locality.city, hit.matchedCity);
    const county = cmp(locality.county, hit.matchedCounty);
    const zip = (locality.zip && hit.matchedZip)
      ? String(locality.zip) === String(hit.matchedZip) : null;

    /* Is the town name the geocoder gave even a municipality? `city` and
       `town` are. `hamlet`, `suburb` and friends are often a neighbourhood or
       a census-designated place no postal address uses — OSM says "Lake Nona"
       where every letter says "Orlando". Those may agree but must never refuse. */
    const cityCanRefuse = hit.cityAuthoritative !== false;

    /* ── ORDER MATTERS HERE ──────────────────────────────────────────────
       An agreeing POSTCODE is checked before a disagreeing town, because
       agreeing-ZIP-with-differing-town is the signature of unincorporated-area
       naming rather than of a wrong place. A genuine wrong-town match — the
       Saint Augustine case this all exists for — disagrees on the postcode too,
       so it still refuses below. */
    if (zip === true) {
      return { agrees: true, on: "postcode " + locality.zip,
               strong: !askedFor.zip, asked: !!askedFor.zip,
               note: city === false
                 ? 'the postcodes agree but the town names differ ("'
                   + hit.matchedCity + '") — usually an unincorporated address'
                 : null };
    }

    if (city === false && cityCanRefuse) {
      return { agrees: false, on: "town — the sheet says " + locality.city
                                + ', the geocoder says "' + hit.matchedCity + '"' };
    }
    if (city === null && county === false) {
      return { agrees: false, on: "county — the sheet says " + locality.county
                                + ' County, the geocoder says "' + hit.matchedCounty + '"' };
    }
    if (city === null && county === null && zip === false) {
      // Nothing softer to go on, so the postcodes are all there is.
      return { agrees: false, on: "postcode — the sheet says " + locality.zip
                                + ", the geocoder says " + hit.matchedZip };
    }

    if (city === true) {
      return { agrees: true, on: locality.city, strong: false,
               asked: !!askedFor.city,
               note: zip === false ? "different postcode, same town" : null };
    }
    if (county === true) {
      return { agrees: true, on: locality.county + " County", strong: false,
               asked: !!askedFor.county };
    }
    return null;
  }

  /* Localities for every community, keyed by community number, out of whatever
     Community-DB rows were handed in. Takes rows rather than fetching them: this
     file makes no network calls and is unit-tested without one, and the two
     callers reach the database completely differently — Blueprint through a
     signed-in session, the CLI through a service key.

     A draft row is ignored in favour of the published one for the same
     community, on the same principle the map follows everywhere else: publish is
     the act that says a value is meant to be believed. */
  function localitiesFrom(rows) {
    const out = {};
    const rank = { published: 2, draft: 1 };
    const seen = {};
    for (const r of rows || []) {
      const id = normCommunityId(r && r.jde);
      if (!id) continue;
      const score = rank[r.status] || 0;
      if (seen[id] != null && seen[id] >= score) continue;
      const f = (r.data && r.data.f) || {};
      const loc = parseLocality(f.city_state_zip, f.municipality);
      if (!loc) continue;
      loc.source = "Community-DB CIS" + (r.status === "draft" ? " (draft)" : "");
      out[id] = loc;
      seen[id] = score;
    }
    return out;
  }

  /* Decide where a community is, from geocoded candidates for its streets.

     candidates: [{ street, hit }] where hit is
                 { lat, lon, precision, source, matchedStreet } or null/{error}
     siblings:   already-located communities, for corroboration
     Returns:
       { status: "located",  lat, lon, confidence, evidence[] }
       { status: "proposed", lat, lon, confidence, evidence[], why }
       { status: "pending",  why, tried[] }                                     */
  function resolveLocation(candidates, siblings, opts) {
    const o = opts || {};
    const agreeM = o.agreeM || AGREE_M;
    const siblingM = o.siblingM || SIBLING_M;
    const refuseM = o.siblingRefuseM || SIBLING_REFUSE_M;
    const tried = [];
    const good = [];

    for (const c of candidates || []) {
      const h = c.hit;
      if (!h)             { tried.push({ street: c.street, result: "no result" }); continue; }
      if (h.error)        { tried.push({ street: c.street, result: "geocoder error: " + h.error }); continue; }
      if (!inBox(h))      { tried.push({ street: c.street, result: "outside the division" }); continue; }
      const nameKind = nameMatch(c.street, h.matchedStreet);
      if (nameKind === "no") {
        // The single most dangerous case, so it is named explicitly rather than
        // lumped in with "no result".
        tried.push({ street: c.street,
                     result: 'matched a different street ("' + (h.matchedStreet || "?") + '") — rejected' });
        continue;
      }
      /* "weak" means the answer left a direction off a name that had one. It
         is carried, not discarded, but it may never place a community by
         itself — see the gate on the single-street path. */
      if (nameKind === "weak") {
        tried.push({ street: c.street,
                     result: 'matched "' + (h.matchedStreet || "?") + '", which omits the '
                           + 'direction — kept, but it cannot place this on its own' });
      }
      /* What Community-DB says about the town is RECORDED here and weighed
         later — it is deliberately not a veto at this point.

         It was one, and that was wrong. Dropping a candidate here removed it
         from the agreement cluster too, so a single hand-typed city field could
         override two independent streets landing on the same patch of ground —
         inverting the evidence. Worse, the narrowed lookup SENDS the city, so
         the veto could only ever fire on the free-form fallback, which is the
         path new-subdivision roads take. It was aimed squarely at the
         communities this exists to help.

         The rule that replaced it is below: the locality's authority is
         proportional to what it argues against. It can refuse a lone
         uncorroborated street, which is the weakest evidence there is. It
         cannot refuse two agreeing streets — it can only question them. */
      const loc = localityAgrees(o.locality, h);

      /* Two spellings of one road are not two streets. The permit log writes
         "SUNFISH DR" on one lot and "SUNFISH DRIVE" on the next, and counting
         them separately let a single road corroborate ITSELF into an automatic
         placement — which is the agreement rule's whole claim, undone. */
      const key = streetKey(c.street);
      const already = good.filter(g => streetKey(g.street) === key)[0];
      if (already) {
        tried.push({ street: c.street,
                     result: 'the same street as "' + already.street
                           + '" written differently — not counted twice' });
        continue;
      }

      if (nameKind === "exact") {
        tried.push({ street: c.street, result: "matched", lat: h.lat, lon: h.lon,
                     precision: h.precision || null, source: h.source || null,
                     locality: loc ? loc.on : null,
                     localityAgrees: loc ? loc.agrees : null });
      }
      good.push({ street: c.street, lat: h.lat, lon: h.lon,
                  precision: h.precision || null, source: h.source || null,
                  locality: loc || null,
                  weakName: nameKind === "weak",
                  matchedStreet: h.matchedStreet || null,
                  // How many OTHER roads of this name the geocoder also found.
                  ambiguous: (h.others || []).filter(x =>
                    sameStreet(c.street, x.matchedStreet)).length });
    }

    if (!good.length) {
      if (!candidates || !candidates.length) {
        return { status: "pending", tried,
                 why: "no street names are available for this community yet" };
      }
      /* Say WHICH way it failed. "No result" means the street is too new to be in
         the geocoder and will probably resolve on a later import. "Matched a
         different street" means the geocoder offered a similar name somewhere
         else and it was refused — a materially different situation, and the one
         worth being loud about, because accepting it is how a pin ends up in the
         wrong town. */
      const rejected = tried.filter(t => /different street/.test(t.result));
      const outside  = tried.filter(t => /outside the division/.test(t.result));
      const dupes = tried.filter(t => /written differently/.test(t.result));
      const parts = [];
      if (rejected.length) {
        parts.push(rejected.length + " street" + (rejected.length === 1 ? "" : "s")
          + " matched a differently-named street and were refused rather than "
          + "risk placing the pin somewhere else");
      }
      if (outside.length) {
        parts.push(outside.length + " landed outside the division");
      }
      const rest = tried.length - rejected.length - outside.length - dupes.length;
      if (rest > 0) {
        parts.push(rest + " returned nothing — likely too new for the geocoder, "
          + "which usually resolves on a later import");
      }
      return { status: "pending", tried, why: parts.join("; ") };
    }

    /* Corroboration by agreement: find the largest cluster of streets that land
       within agreeM of each other. Two is enough — two independent street names
       both resolving to the same patch of ground is not a coincidence. */
    let best = null;
    for (const anchor of good) {
      const near = good.filter(g => {
        const d = metresBetween(anchor, g);
        return d != null && d <= agreeM;
      });
      if (!best || near.length > best.length) best = near;
    }

    const centre = ms => ({
      lat: +(ms.reduce((a, g) => a + g.lat, 0) / ms.length).toFixed(7),
      lon: +(ms.reduce((a, g) => a + g.lon, 0) / ms.length).toFixed(7)
    });

    /* Does anything supporting this point contradict the sheet? Computed once
       and applied according to how strong the support is. */
    const conflictIn = ms => ms.map(g => g.locality)
                               .filter(l => l && !l.agrees)[0] || null;
    const sheet = (o.locality && o.locality.source) || "the Community Information Sheet";

    /* The already-located phases of this same development, and how far the
       nearest one is from a given point. Hoisted above the two-street branch
       because both branches consult it now — one to question, one to refuse. */
    const devName = developmentOf(o.name || "");
    const sibs = (siblings || []).filter(s =>
      s && s.name && Number.isFinite(s.lat) && Number.isFinite(s.lon) &&
      developmentOf(s.name) === devName && devName);
    const nearestSib = pt => {
      let near = null;
      for (const s of sibs) {
        const d = metresBetween(pt, s);
        if (d != null && (!near || d < near.d)) near = { s, d };
      }
      return near;
    };
    const farFrom = pt => {
      const n = nearestSib(pt);
      return n && n.d > refuseM ? n : null;
    };
    const km = d => (d / 1000).toFixed(d < 10000 ? 1 : 0);

    if (best.length >= 2) {
      const c = centre(best);
      const streetsSaid = best.length + " streets agree within "
                        + (agreeM / 1000) + " km: " + best.map(g => g.street).join(", ");
      const bad = conflictIn(best);

      /* Two agreeing streets are the strongest evidence here, so a distant
         sibling QUESTIONS them rather than refusing — the same weighting the
         sheet gets a few lines down. One of the two is wrong and a person picks
         which; what must not happen is it going in unwatched. */
      const away = farFrom(c);
      if (away) {
        return { status: "proposed", lat: c.lat, lon: c.lon,
                 confidence: "agreement",
                 evidence: [streetsSaid,
                            "but " + away.s.name + ", a located phase of the same "
                            + "development, is " + km(away.d) + " km away"],
                 why: "the streets agree with each other but land " + km(away.d)
                    + " km from " + away.s.name + ", which is already on the map — "
                    + "phases of one development do not sit that far apart, so one "
                    + "of the two is wrong",
                 tried };
      }

      /* Two independent street names landing on the same patch of ground is the
         strongest evidence this file has. A single field on a hand-filled sheet
         does not get to overrule it — but it does get to stop the placement
         happening unwatched, because one of the two is wrong and a person should
         decide which. */
      if (bad) {
        return { status: "proposed", lat: c.lat, lon: c.lon,
                 confidence: "agreement",
                 evidence: [streetsSaid,
                            "but " + sheet + " disagrees about the " + bad.on],
                 why: "the streets agree with each other and disagree with " + sheet
                    + " (" + bad.on + ") — one of the two is wrong, so this is not "
                    + "being applied without somebody looking",
                 tried };
      }
      return { status: "located", lat: c.lat, lon: c.lon,
               confidence: "agreement", evidence: [streetsSaid], tried };
    }

    /* Only one street resolved to a point nothing else corroborates. Look for an
       already-located sibling phase of the same development. */
    const only = good[0];

    /* A name we are not certain of gets no independent authority. The sibling
       and agreement paths may still carry it — corroboration is what a weak
       match needs and exactly what those provide — but the lone-street paths
       below place a community on the strength of the name alone, and this name
       is missing the very token that distinguishes 77th Avenue East from 77th
       Avenue West. Handled before them so it cannot leak into one. */
    const weakAlone = () => ({
      status: "pending", tried,
      why: '"' + only.street + '" only matched "' + (only.matchedStreet || "?")
         + '", which leaves off the direction — and 77th Avenue East and 77th '
         + "Avenue West are different roads. Nothing else corroborates the point, "
         + "so it is not being offered. It will place itself once a phase of this "
         + "development is on the map, or a second street is mapped"
    });

    for (const s of sibs) {
      const d = metresBetween(only, s);
      if (d != null && d <= siblingM) {
        const said = 'one street ("' + only.street + '"), corroborated by '
                   + s.name + " " + (d / 1000).toFixed(1) + " km away";
        const bad = conflictIn([only]);
        if (bad) {
          return { status: "proposed", lat: only.lat, lon: only.lon,
                   confidence: "sibling",
                   evidence: [said, "but " + sheet + " disagrees about the " + bad.on],
                   why: "a located phase of the same development puts it here, and "
                      + sheet + " disagrees (" + bad.on + ") — confirm before applying",
                   tried };
        }
        return { status: "located", lat: only.lat, lon: only.lon,
                 confidence: "sibling", evidence: [said], tried };
      }
    }

    /* THE SIBLING MAY REFUSE. One street, nothing corroborating it, and this
       development's own located phases are a county away. That is not "no
       corroboration" — it is evidence against, and the best evidence available:
       a placed pin got there by two streets agreeing, by a person, or by another
       corroborated sibling, where the point on offer rests on one road name that
       Florida reuses freely.

       Symmetrical with the sheet's veto below and refused for the same reason:
       both may only overrule the weakest case, a lone uncorroborated street.
       Neither touches two agreeing streets, which are handled above.

       Offering these anyway is not harmless. Confirming a proposal is one click
       and the reasons are long; a list where two thirds cannot be right teaches
       people to click through it, which costs the four that deserved reading. */
    if (only.weakName) return weakAlone();

    const away = farFrom(only);
    if (away) {
      return { status: "pending", tried,
               why: '"' + only.street + '" was found, but ' + km(away.d)
                  + " km from " + away.s.name + " — a phase of the same development "
                  + "that is already on the map. Nothing else corroborates the point, "
                  + "and one development does not span that distance, so this is "
                  + "almost certainly a same-named street in another town. Place it "
                  + "by hand, or wait for a second street to be mapped" };
    }

    /* Has this exact proposal already been put to somebody and refused? Checked
       here and nowhere else: the corroborated paths above are different evidence
       and are not suppressed by an earlier "no". */
    const refused = wasRejected(o.rejected, only.street, only.lat, only.lon);
    if (refused) {
      return { status: "pending", tried,
               why: '"' + only.street + '" resolved to the same point that was '
                  + "rejected" + (refused.by ? " by " + refused.by : "")
                  + (refused.at ? " on " + String(refused.at).slice(0, 10) : "")
                  + ", so it is not being offered again — place it by hand, or "
                  + "wait for a second street to be mapped" };
    }

    /* THE ONE PLACE THE SHEET MAY REFUSE OUTRIGHT. Nothing corroborates this
       point but itself: one street, no second street, no sibling. That is the
       weakest evidence there is, and it is exactly the shape of the failure this
       file exists to prevent — ask the live geocoder for SUNFISH DRIVE and it
       returns one in Saint Augustine Beach, correctly spelled and inside the
       division's bounding box. With the sheet saying another town, there is
       nothing here worth offering. */
    if (only.locality && !only.locality.agrees) {
      return { status: "pending", tried,
               why: '"' + only.street + '" was found, but not where ' + sheet
                  + " says this community is: " + only.locality.on
                  + ". Nothing else corroborates the point, so it is not being "
                  + "offered. Correct the sheet, or place it by hand" };
    }

    /* One street, no sibling — but the sheet and the geocoder independently
       agree on the postcode. That is corroboration of the same kind the
       agreement rule looks for, arriving from a different direction.

       Only a postcode, and only one the geocoder VOLUNTEERED. A town is shared
       by many roads, and an answer that was filtered by the sheet's own postcode
       carries it by construction — see localityAgrees.

       What this does NOT establish is that the point is right to within a
       postcode's width; a postcode is an area, not a position. What it
       establishes is that the road of this name which the geocoder found is in
       the postal area the sheet independently names, which rules out the
       same-name-different-town case and nothing more. */
    /* One more thing has to be true before a lone street may be placed on the
       strength of its postcode: the geocoder must have found exactly ONE road of
       that name. It is asked for five results, and if several came back the one
       used is simply the first — which is a coin flip, not corroboration. */
    /* The reason has to say what was actually established. This branch read
       "the postcode agrees, but the name matches more than one road" whatever
       the sheet had said — including, as on Tampa's first run, when there was no
       sheet at all: Community-DB held nothing for the division, so every one of
       these claimed an agreement that never happened. A reason a reader can
       check is the only thing making a proposal reviewable rather than a button
       to press. */
    if (only.ambiguous) {
      const agreed = only.locality && only.locality.agrees;
      return {
        status: "proposed", lat: only.lat, lon: only.lon,
        confidence: "single", street: only.street,
        evidence: ['"' + only.street + '" matches ' + (only.ambiguous + 1)
                   + " different roads; this is the first of them"],
        why: (agreed
                ? "the postcode agrees, but the name matches more than one road"
                : "nothing corroborates this point, and the name matches more "
                  + "than one road")
           + " and nothing says which — confirm before applying",
        tried
      };
    }

    if (only.locality && only.locality.agrees && only.locality.strong) {
      return { status: "located", lat: only.lat, lon: only.lon,
               confidence: "locality",
               evidence: ['one street ("' + only.street + '"), corroborated by '
                          + sheet + " — both put it in " + only.locality.on],
               tried };
    }

    /* Say how many actually resolved. "Only one street resolved" was printed
       even when four had and simply landed nowhere near each other, which is a
       different situation with a different fix — and reading it as "one" is what
       makes --accept-single look reasonable when it is not. */
    const scattered = good.length > 1;
    const spread = scattered
      ? Math.round(Math.max.apply(null, good.map(g =>
          Math.max.apply(null, good.map(h2 => metresBetween(g, h2) || 0)))) / 100) / 10
      : 0;

    return {
      status: "proposed", lat: only.lat, lon: only.lon,
      confidence: "single",
      street: only.street,
      evidence: [scattered
        ? good.length + " streets resolved but landed up to " + spread
          + " km apart, so none corroborates another; showing "
          + '"' + only.street + '"'
        : 'only "' + only.street + '" resolved']
        .concat(!only.locality || !only.locality.agrees ? []
          : only.locality.asked
            ? ["it was looked up inside " + only.locality.on + " because " + sheet
               + " says so — which is not the same as the geocoder having agreed "
               + "independently"]
            : ["it is in " + only.locality.on + ", which matches " + sheet
               + " — but a town is not a location"]),
      why: scattered
        ? good.length + " streets resolved but they are up to " + spread
          + " km apart, so none of them corroborates another — confirm before applying"
        : sibs.length
          ? "the one street that resolved is more than " + (siblingM / 1000)
            + " km from every located phase of " + (o.name || "this development")
            + " — confirm before applying"
          : "only one street resolved and there is no located sibling to check it "
            + "against, so it could be a same-named street elsewhere — confirm before applying",
      tried
    };
  }

  /* Which communities still need locating, and what to try for each. Ordered by
     how much is hidden with them, because that is what makes one worth chasing
     before another. */
  function pendingLocations(doc, streetsById) {
    const out = [];
    for (const c of (doc && doc.communities) || []) {
      if (Number.isFinite(c.lat) && Number.isFinite(c.lon) && !(c.lat === 0 && c.lon === 0)) continue;
      /* Merged by comparable name before anything is looked up. The permit log
         writes "SUNFISH DR" on one lot and "SUNFISH DRIVE" on the next, and
         they are one road: leaving both in spends two geocoder requests at a
         second apiece to learn the same fact twice, and resolveLocation has to
         throw the duplicate away at the far end regardless. The spelling with
         the most lots behind it is the one kept, since it is the one the log
         actually favours. */
      const merged = {};
      for (const [street, lots] of Object.entries((streetsById || {})[c.num] || {})) {
        const k = streetKey(street);
        if (!k) continue;
        if (!merged[k] || lots > merged[k].lots) {
          merged[k] = { street: merged[k] && merged[k].lots > lots ? merged[k].street : street,
                        lots: (merged[k] ? merged[k].lots : 0) + lots };
        } else {
          merged[k].lots += lots;
        }
      }
      const streets = Object.values(merged)
        .sort((a, b) => b.lots - a.lots)       // most lots first — the main road
        .map(m => ({ street: m.street, lots: m.lots }));
      out.push({
        num: c.num, name: c.name,
        addr: c.addr || "",
        streets,
        startsHidden: (c.starts || []).reduce((a, b) => a + b, 0),
        lastTried: (c.geo && c.geo.lastTried) || null,
        previously: (c.geo && c.geo.tried) || null,
        // Everything a reviewer needs in order to act, so the UI renders this
        // list rather than re-reading the community records behind it.
        proposed: (c.geo && c.geo.proposed) || null,
        rejected: (c.geo && c.geo.rejected) || null,
        why: (c.geo && c.geo.why) || null
      });
    }
    return out.sort((a, b) => b.startsHidden - a.startsHidden);
  }

  /* Record an attempt on the community record so the next import knows what has
     already been tried and the UI can show why something is still pending.
     Deliberately stored on the document: it travels with the data, survives a
     publish from either Blueprint or the CLI, and needs no extra table. */
  function applyLocation(community, result, now) {
    const c = community;
    // Rejections outlive attempts. Rebuilding `geo` wholesale used to discard
    // them, which handed a refused proposal straight back on the next import.
    const kept = (c.geo && c.geo.rejected) || [];
    c.geo = {
      lastTried: new Date(now || Date.now()).toISOString(),
      status: result.status,
      tried: (result.tried || []).map(t => ({ street: t.street, result: t.result }))
    };
    if (kept.length) c.geo.rejected = kept;
    if (result.status === "located") {
      c.lat = result.lat;
      c.lon = result.lon;
      c.geoSource = result.confidence;      // "agreement" | "sibling" | "manual"
      if (result.confidence !== "manual") c.approxGeo = true;
      delete c.geo.status;                  // resolved; keep only the audit trail
    } else if (result.status === "proposed") {
      // The street travels with the proposal so that refusing it can record what
      // was refused, not merely where.
      c.geo.proposed = { lat: result.lat, lon: result.lon,
                         street: result.street || null, why: result.why };
    } else {
      c.geo.why = result.why;
    }
    return c;
  }

  /* ── A PROPOSAL THAT WAS LOOKED AT AND REFUSED ────────────────────────────
     A proposal is a question put to a person: "one street resolved, here is
     where it lands, is that right?" Answering "no" has to be worth something,
     or the next import asks again — and a question that is asked every week
     stops being read, which is how the one genuinely wrong pin eventually gets
     waved through.

     So a rejection is written onto the community and consulted on the next run.
     It is deliberately narrow: it suppresses THE SAME EVIDENCE, not the
     community. The same street landing in the same place again is a question
     already answered. A second street resolving, or a sibling phase appearing,
     is new evidence and goes through on its own merits — keeping those two
     paths separate is the whole point.

     250 m, because a geocoder asked for the same street twice does not return
     quite the same point — a block centroid one week, an interpolated address
     range the next. Wide enough to recognise the same answer, far too tight to
     swallow a different one. */
  const REJECT_M = 250;

  function wasRejected(rejections, street, lat, lon) {
    for (const r of rejections || []) {
      if (streetKey(r.street) !== streetKey(street)) continue;
      const d = metresBetween({ lat: r.lat, lon: r.lon }, { lat: lat, lon: lon });
      /* A rejection recorded without a coordinate suppresses that street
         outright. Erring towards not re-asking is the safe direction: the cost
         is one question not repeated, and the manual path is always open. */
      if (d == null || d <= REJECT_M) return r;
    }
    return null;
  }

  /* ── WRITING A LOCATION ONTO A COMMUNITY ──────────────────────────────────
     Four ways a coordinate can arrive, and they are not equally trustworthy:

       agreement  two of the community's own streets landed together
       sibling    one street, vouched for by a located phase of the same development
       confirmed  one street, and a person looked at it and said yes
       manual     a person typed the coordinate

     `geoSource` records which, so a year from now a pin can be read for how
     much it is worth. Everything except `manual` is flagged `approxGeo`, which
     is what stops validate.js quietly moving it later — a geocode is evidence,
     not a survey. A typed coordinate is left alone entirely, because a person
     with a map in front of them beats every heuristic in this file. */

  /* The audit trail has to survive all of these writes. An earlier version
     rebuilt `geo` from scratch on each attempt, which threw the rejections away
     — so a refused proposal came straight back on the next import, which is
     precisely what the rejection exists to prevent. */
  function geoOf(c) {
    const g = c.geo || {};
    return { tried: g.tried || [], rejected: g.rejected || [] };
  }

  function stamp(now) { return new Date(now || Date.now()).toISOString(); }

  /* Accept a proposal already recorded on the community. Returns { ok } or
     { ok:false, error } rather than throwing: every caller is a UI that has to
     say what went wrong, and none of them can do anything with an exception. */
  function acceptProposal(community, opts) {
    const o = opts || {};
    const c = community;
    const p = c.geo && c.geo.proposed;
    if (!p) return { ok: false, error: "there is no proposal on this community to accept" };
    if (!inBox(p)) return { ok: false, error: "the proposed point is outside the division" };

    const prev = geoOf(c);
    c.lat = p.lat; c.lon = p.lon;
    c.geoSource = "confirmed";
    c.approxGeo = true;
    c.geo = {
      lastTried: stamp(o.now),
      confirmedAt: stamp(o.now),
      confirmedBy: o.by || null,
      tried: prev.tried
    };
    if (prev.rejected.length) c.geo.rejected = prev.rejected;
    return { ok: true, lat: c.lat, lon: c.lon };
  }

  /* Refuse one. The coordinate is kept, because it is the evidence — without it
     the record cannot tell "this street, here" from "this street, anywhere". */
  function rejectProposal(community, opts) {
    const o = opts || {};
    const c = community;
    const p = c.geo && c.geo.proposed;
    if (!p) return { ok: false, error: "there is no proposal on this community to reject" };

    const prev = geoOf(c);
    const street = p.street
      || (prev.tried.filter(t => t.result === "matched")[0] || {}).street
      || null;

    prev.rejected.push({
      street: street, lat: p.lat, lon: p.lon,
      at: stamp(o.now), by: o.by || null,
      reason: o.reason || null
    });

    c.geo = {
      lastTried: stamp(o.now),
      tried: prev.tried,
      rejected: prev.rejected,
      why: "a proposal at this point was rejected" + (o.by ? " by " + o.by : "")
         + " — it will not be offered again on the same evidence"
    };
    return { ok: true, rejected: prev.rejected[prev.rejected.length - 1] };
  }

  /* A coordinate typed by a person. Validated the same way an automatic one is:
     the division bounding box catches a transposed pair, which is the mistake
     people actually make. "-81.5, 28.6" puts Orlando in the Indian Ocean and
     reads perfectly plausibly right up until the map draws. */
  function placeManually(community, lat, lon, opts) {
    const o = opts || {};
    const c = community;
    const la = Number(lat), lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) {
      return { ok: false, error: "that is not a pair of numbers" };
    }
    if (la === 0 && lo === 0) {
      return { ok: false, error: "0,0 is null island, not a location" };
    }
    if (!inBox({ lat: la, lon: lo })) {
      return { ok: false, error: la + "," + lo + " is outside the division — latitude "
        + "should be about " + BBOX.minLat + " to " + BBOX.maxLat + " and longitude about "
        + BBOX.minLon + " to " + BBOX.maxLon
        + (inBox({ lat: lo, lon: la }) ? ". Those two look swapped." : "") };
    }

    const prev = geoOf(c);
    c.lat = +la.toFixed(7);
    c.lon = +lo.toFixed(7);
    c.geoSource = "manual";
    // A typed coordinate is not approximate, and marking it so would invite a
    // later --fix run to move it.
    delete c.approxGeo;
    c.geo = {
      lastTried: stamp(o.now),
      placedAt: stamp(o.now),
      placedBy: o.by || null,
      tried: prev.tried
    };
    if (prev.rejected.length) c.geo.rejected = prev.rejected;
    if (o.note) c.geo.note = o.note;
    return { ok: true, lat: c.lat, lon: c.lon };
  }

  /* "28.6607, -81.5458" as a person pastes it — out of Google Maps, out of an
     email, off a phone. Accepts a comma or whitespace between the two, a degree
     sign, and a trailing hemisphere letter. W and S negate, which is the one
     transformation worth making: a coordinate copied from a site that writes
     "81.5458° W" is otherwise silently in China.

     Anything else returns null rather than a guess. */
  function parseLatLon(text) {
    const s = String(text == null ? "" : text).trim();
    if (!s) return null;
    const m = s.match(
      /^\s*(-?\d+(?:\.\d+)?)\s*°?\s*([NnSs])?\s*(?:,\s*|\s+)(-?\d+(?:\.\d+)?)\s*°?\s*([EeWw])?\s*$/);
    if (!m) return null;
    let lat = parseFloat(m[1]), lon = parseFloat(m[3]);
    if (m[2] && /[Ss]/.test(m[2])) lat = -Math.abs(lat);
    if (m[4] && /[Ww]/.test(m[4])) lon = -Math.abs(lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat: lat, lon: lon };
  }

  /* ============================== PARSERS ==================================
     Each takes rows already extracted from a workbook — never a workbook — so
     this file never touches SheetJS and the caller decides how sheets are read.
     `find` is the collector: { notes: [], problems: [] }.
     ======================================================================== */

  /* Starts. Two layouts are seen in the wild; both are handled, matching
     buildDivision() in the Vendor Assignments app.

     Also collects the street names, which is how a new community gets located.
     Every row of the permit log carries an Address; for an established community
     it is a real one ("1660 Rider Rain Ln"), and for a brand-new one the house
     number has not been assigned yet so it reads "TBD Sunfish Drive". Either way
     the STREET is there, and the streets of a subdivision are enough to place it
     — see resolveLocation(). */
  function parseStarts(rows, sheetName, find) {
    const records = [], idName = {};
    const streets = {};        // community id -> { STREET: lotCount }
    let skipped = 0;

    for (const r of rows) {
      let community = null, date = null, kind = "Projected", job = null;

      if (r["Comm"] != null) {
        community = S(r["Comm"]);
        const p = r["Start (Prj)"], a = r["Start (Act)"];
        date = xlDate(a || p); kind = a ? "Actual" : "Projected"; job = r["Job"];
      } else if (r["Project"] != null) {
        const proj = S(r["Project"]) || "";
        community = proj.includes(" - ") ? proj.split(" - ").slice(1).join(" - ").trim() : proj;
        const p = r["PrjStart"], a = r["ActStart"];
        date = xlDate(a || p); kind = a ? "Actual" : "Projected"; job = r["Job"];
      }

      /* Streets are gathered from every row, before the date filter below. A lot
         with no start date still tells you where the subdivision is, and the
         newest communities are exactly the ones most likely to lack dates. */
      const id0 = normCommunityId(job);
      if (id0) {
        const st = streetOf(r["Address"]);
        if (st) {
          streets[id0] = streets[id0] || {};
          streets[id0][st] = (streets[id0][st] || 0) + 1;
        }
      }

      if (!community || !date) { skipped++; continue; }
      if (id0) idName[id0] = community;
      records.push({ id: id0, community, date, kind });
    }

    find.notes.push(`starts: sheet "${sheetName}", ${rows.length} rows → ${records.length} start records`
      + (skipped ? `, ${skipped} skipped (no community or no date)` : ""));
    if (!records.length) {
      find.problems.push("the starts workbook produced no usable rows — wrong file, or the columns have been renamed");
    }
    return { records, idName, streets };
  }

  function aggregateStarts(records, dataStart, find) {
    const [y0, m0] = dataStart.split("-").map(Number);
    const base = y0 * 12 + (m0 - 1);

    const perDay = new Map();            // id|date -> count
    for (const r of records) {
      if (!r.id) continue;
      const k = r.id + "|" + r.date;
      perDay.set(k, (perDay.get(k) || 0) + 1);
    }

    let dropped = 0, droppedDays = 0;
    const byCommunity = new Map();       // id -> number[12]

    for (const [k, count] of perDay) {
      if (count > PLACEHOLDER_PER_DAY) { dropped += count; droppedDays++; continue; }
      const [id, date] = k.split("|");
      const d = new Date(date + "T00:00:00Z");
      const slot = (d.getUTCFullYear() * 12 + d.getUTCMonth()) - base;
      if (slot < 0 || slot > 11) continue;    // outside the rolling window
      if (!byCommunity.has(id)) byCommunity.set(id, new Array(12).fill(0));
      byCommunity.get(id)[slot] += count;
    }

    if (droppedDays) {
      find.notes.push(`placeholder filter: dropped ${dropped} starts across ${droppedDays} `
        + `community-days with more than ${PLACEHOLDER_PER_DAY} on one date`);
    }
    return byCommunity;
  }

  /* RE2 vendor assignments. `rows` may be every row in the file or only this
     division's — divCounts is passed separately so the wrong-file guard works
     either way. */
  function parseRE2(rows, code, find, divCounts) {
    const today = new Date().toISOString().slice(0, 10);
    const byCommunity = new Map();       // id -> {cat: vendor}
    const nameHint = new Map();
    const counts = divCounts || {};
    const countHere = !divCounts;
    let expired = 0, matched = 0;

    for (const r of rows) {
      const div = S(r["Division"]);
      if (countHere && div) counts[div.toUpperCase()] = (counts[div.toUpperCase()] || 0) + 1;
      if (div && code && div.toUpperCase() !== code.toUpperCase()) continue;

      const vendor = S(r["Supplier Desc"]);
      const cat = S(r["Trade Desc."]) || S(r["Trade Desc"]);
      if (!vendor || !cat || cat === ".") continue;

      const exp = xlDate(r["Expired Date"]);
      if (exp && exp < today) { expired++; continue; }

      const id = normCommunityId(r["Community"]);
      if (!id) continue;

      matched++;
      if (!byCommunity.has(id)) byCommunity.set(id, {});
      byCommunity.get(id)[cat] = vendor;
      const nm = cleanCommName(S(r["Description"]));
      if (nm && !nameHint.has(id)) nameHint.set(id, nm);
    }

    find.notes.push(`RE2: ${rows.length} rows, ${matched} for division ${code}`
      + (expired ? `, ${expired} expired assignments skipped` : ""));

    // A file for the wrong division parses cleanly and produces almost nothing,
    // which is easy to miss.
    const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    if (!matched && rows.length) {
      find.problems.push(`no RE2 rows match division ${code} — this looks like the wrong file`
        + (top ? ` (it is mostly ${top})` : ""));
    } else if (top && top !== code.toUpperCase()) {
      find.notes.push(`note: the RE2 file is mostly division ${top}; ${matched} rows are ${code}`);
    }
    return { byCommunity, nameHint };
  }

  /* Contacts.

     The awkward part is that the sheet names DEVELOPMENTS while the map names
     COMMUNITIES. The sheet says "Wellness Ridge"; the map has Wellness 22TH,
     Wellness 32, Wellness 40FLGC and six more. One row fans out to several
     communities, and a cell can name more than one development. There is no
     community number anywhere in the sheet, so matching is by name.

     `grid` is the sheet as an array of arrays, INCLUDING the applied-filter block
     the Power BI export writes above the table — the header row is located, not
     assumed. Throws on a sheet it cannot read; that is an expected failure and
     callers are expected to catch it.                                           */
  function parseContacts(grid, communityNames, find, opts) {
    const options = opts || {};
    const aliases = options.aliases || COMMUNITY_ALIASES;
    const ignoredDevs = options.ignoredDevelopments || IGNORED_DEVELOPMENTS;

    const headerRow = grid.findIndex(r =>
      Array.isArray(r) && r.some(c => /e-?mail/i.test(String(c || ""))));
    if (headerRow < 0) {
      throw new Error('could not find a header row containing "Email" in the contact sheet');
    }

    // Headers carry trailing spaces ("Communities ", "Construction ").
    const col = {};
    grid[headerRow].forEach((h, i) => {
      const k = String(h == null ? "" : h).trim().toLowerCase();
      if (/^communit/.test(k)) col.communities = i;
      else if (/^construction|^name/.test(k)) col.name = i;
      else if (/^phone/.test(k)) col.phone = i;
      else if (/^e-?mail/.test(k)) col.email = i;
      else if (/acm/.test(k)) col.acm = i;
    });
    for (const need of ["communities", "name", "email"]) {
      if (col[need] == null) throw new Error(`contact sheet is missing a "${need}" column`);
    }

    const targets = communityNames.map(n => ({ name: n, n: normName(n) }));
    const matchToken = tok => {
      const t = normName(tok);
      if (!t) return [];
      let keys = aliases[t] || t;
      if (!Array.isArray(keys)) keys = [keys];
      return targets.filter(c => keys.some(k => c.n.startsWith(k))).map(c => c.name);
    };

    const people = {};                   // id -> person
    const cmsFor = new Map();            // community -> [ids], in sheet order
    const acmFor = new Map();            // community -> Set(acm name)
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
          phone: col.phone != null ? S(r[col.phone]) : null,
          email: email.toLowerCase(),    // the source mixes casing
          roles: ["cm"]
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
          if (normName(t) in ignoredDevs) ignored.add(t);
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
      if (!hitAny) delete people[id];     // nobody references them; do not publish them
    }

    find.notes.push(`contacts: ${rowCount} rows → ${Object.keys(people).length} managers `
      + `across ${cmsFor.size} communities`);
    if (!rowCount) {
      find.problems.push("the contact sheet produced no usable rows — wrong file, or the columns have been renamed");
    }
    if (ignored.size) {
      find.notes.push(`contacts: skipped ${ignored.size} known non-map development`
        + `${ignored.size === 1 ? "" : "s"} (${[...ignored].join(", ")})`);
    }

    return { people, cmsFor, acmFor, unmatched: [...unmatched],
             ignored: [...ignored], acmNames: [...acmNames] };
  }

  /* =============================== THE MERGE ===============================

     input: {
       data, people            the currently published documents
       startsAgg, idName       from parseStarts + aggregateStarts, or null
       re2                     from parseRE2, or null
       contacts                from parseContacts, or null
       dataStart               "YYYY-MM"; defaults to the current month
       contactsStrict          clear contacts for communities the sheet omits
     }
     ======================================================================== */

  function currentDataStart(now) {
    const d = now ? new Date(now) : new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  function buildDocument(input) {
    /* warnings is an OPTIONAL third channel. A caller that supplies it (Blueprint)
       gets the advisory findings separated from the blocking ones; a caller that
       does not (the CLI, older harnesses) gets them on problems exactly as
       before, where they print but block nothing. */
    const find = { notes: input.notes || [], problems: input.problems || [],
                   warnings: input.warnings || null };
    const data = input.data;
    const people = JSON.parse(JSON.stringify(input.people || { people: {} }));
    const dataStart = input.dataStart || currentDataStart(input.now);
    const startsAgg = input.startsAgg || null;
    const idName = input.idName || {};
    const re2 = input.re2 || null;
    const contacts = input.contacts || null;
    const strict = !!input.contactsStrict;
    const awaiting = input.awaitingContacts || AWAITING_CONTACTS;
    const allowGrowth = !!input.allowGrowth;

    const existing = new Map(data.communities.map(c => [c.num, c]));

    // The area managers are named in the sheet but their phone and email are not,
    // so carry those across from the people already on file.
    if (contacts) {
      const acmByName = new Map();
      for (const [id, p] of Object.entries(people.people || {})) {
        if (p.name) acmByName.set(p.name, id);
      }
      /* An unknown manager is advisory, not blocking. It used to block, which
         deadlocked a first publish: the people directory is created BY the
         publish, so on a bootstrap every name is unknown and there is nowhere
         the details could have been added yet. And blocking never protected
         anything — dropping the contact sheet entirely was allowed with a mere
         warning, so the strict path only ever forced a worse workaround. What
         actually happens without the details: communities matched to that
         manager publish without a manager card, and a later import fills it in
         once the person is on file. */
      for (const n of contacts.acmNames) {
        if (!acmByName.has(n)) {
          (find.warnings || find.problems).push(
            `the contact sheet names an area manager we have no details for: "${n}"`
            + " — their communities publish without a manager card; add the person "
            + "(name, phone, email) to the people directory and re-import to fill it in");
        }
      }
      contacts.acmId = n => acmByName.get(n) || null;
    }

    /* Which communities exist after this run.

       Two rules, and both were changed after running the importer against real
       exports for the first time in a while:

       1. THE RE2 EXPORT DOES NOT CREATE COMMUNITIES. It lists every community the
          division has ever had — 576 for Orlando, against the 71 the map tracks —
          so treating it as a source of truth for existence pulled in five hundred
          closed-out communities, each with no coordinates. It now only decorates:
          a community it names that the map does not have is ignored, and the
          count of those is reported.

       2. AN IMPORT NEVER REMOVES A COMMUNITY. The union used to be authoritative,
          which meant a community with no start in the rolling twelve-month window
          would be deleted along with its coordinates, utilities and contacts —
          none of which exist anywhere else. Dormant is not the same as gone.
          Removal is now a deliberate act, not a side effect of a quiet quarter.

       So: everything already published, plus anything the starts log introduces. */
    const ids = new Set(existing.keys());
    if (startsAgg) for (const id of startsAgg.keys()) ids.add(id);

    const re2Unknown = re2
      ? [...re2.byCommunity.keys()].filter(id => !ids.has(id)).length
      : 0;
    if (re2Unknown) {
      find.notes.push(`RE2: ${re2Unknown} communities in the export are not on the map `
        + "and were ignored — the export covers the division's whole history");
    }

    const cats = data.tradeCats.slice();
    const vendors = data.vendors.slice();
    const catIdx = new Map(cats.map((c, i) => [c, i]));
    const venIdx = new Map(vendors.map((v, i) => [v, i]));
    const intern = (list, idx, v) => {
      if (!idx.has(v)) { idx.set(v, list.length); list.push(v); }
      return idx.get(v);
    };

    const out = [];
    const added = [], dormant = [], needGeo = [];

    for (const id of ids) {
      const prev = existing.get(id);
      const rec = prev
        ? Object.assign({}, prev)
        : {
            // A new community carries no coordinate. Rather than invent one it is
            // written null and reported. The map holds such records off the map
            // and says how many are waiting, rather than dropping a pin at 0,0.
            name: (idName[id] || (re2 && re2.nameHint.get(id)) || id),
            num: id, addr: "", lat: null, lon: null,
            starts: new Array(12).fill(0)
          };

      if (!prev) { added.push(rec.name); needGeo.push(rec.name); }
      if (idName[id]) rec.name = idName[id];

      if (startsAgg) {
        rec.starts = startsAgg.get(id) || new Array(12).fill(0);
        // "unforecasted" means no schedule exists yet, which is different from a
        // schedule of zero. Only the scheduling side can clear it.
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
            find.notes.push(`${rec.name}: contact sheet lists more than one area manager `
              + `(${[...acmSet].join(", ")}) — left unchanged`);
          }
        } else if (strict) {
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

    /* Nothing is removed, but a community the starts log no longer mentions is
       worth surfacing: it is either genuinely dormant or a sign the wrong file was
       used. Informational, never destructive. */
    if (startsAgg) {
      for (const [id, c] of existing) if (!startsAgg.has(id)) dormant.push(c.name);
    }

    out.sort((a, b) => a.name.localeCompare(b.name));

    // Drop trade categories and vendors nothing references any more, so the
    // lookups do not grow forever. This is the re-interning that makes the
    // indices unstable between runs.
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

    /* People. The sheet is the source for community managers. Anyone it no longer
       lists but who is still referenced by a community keeps their entry — that
       happens when the sheet does not cover a community and its existing contacts
       were preserved above. Anyone referenced by nobody is dropped, because a
       contact nobody links to is still published. */
    let droppedPeople = [];
    if (contacts) {
      const merged = Object.assign({}, people.people || {});
      for (const [id, p] of Object.entries(contacts.people)) {
        const prev = merged[id] || {};
        merged[id] = {
          name: p.name || prev.name || null,
          phone: p.phone || prev.phone || null,
          email: p.email || prev.email || null,
          roles: [...new Set([...(prev.roles || []), "cm"])]
        };
      }
      const referenced = new Set(out.flatMap(c => [].concat(c.cms || [], c.acm ? [c.acm] : [])));
      for (const id of Object.keys(merged)) {
        if (!referenced.has(id)) { droppedPeople.push(merged[id].name || id); delete merged[id]; }
      }
      people.people = merged;
      if (droppedPeople.length) {
        find.notes.push(`people: removed ${droppedPeople.length} no longer assigned anywhere `
          + `(${droppedPeople.slice(0, 6).join(", ")}${droppedPeople.length > 6 ? ", …" : ""})`);
      }
    }

    const next = {
      generatedAt: new Date(input.now || Date.now()).toISOString(),
      updateCadenceDays: data.updateCadenceDays || 7,
      dataStart,
      tradeCats: newCats,
      vendors: newVendors,
      communities: out
    };

    /* Contact coverage, split so the routine gaps do not drown the real ones. */
    let coverage = null;
    if (contacts) {
      const uncovered = out.filter(c => !contacts.cmsFor.has(c.name));
      coverage = {
        unmatched: contacts.unmatched,
        ignored: contacts.ignored,
        awaiting: uncovered.filter(c => normName(c.name) in awaiting).map(c => c.name),
        // The list has to prune itself, or it becomes a permanent excuse.
        nowStaffed: out.filter(c => normName(c.name) in awaiting && contacts.cmsFor.has(c.name))
                       .map(c => c.name),
        unexpected: uncovered.filter(c => !(normName(c.name) in awaiting))
                             .map(c => ({ name: c.name, kept: (c.cms || []).length }))
      };
    }

    // Growth is the only direction an import can move the count, so it is the
    // only one guarded.
    if (!allowGrowth && existing.size && out.length > existing.size * GROWTH_REFUSE) {
      find.problems.push(
        `this run would take communities from ${existing.size} to ${out.length}, adding ${added.length}`
        + (needGeo.length ? ` with ${needGeo.length} having no coordinates` : "")
        + ". The RE2 export lists every community the division has ever had, not the "
        + "ones the map tracks, so importing it whole pulls in the historical ones. "
        + "Check the files, or pass --allow-growth if this is deliberate.");
    }

    return {
      next,
      people,
      notes: find.notes,
      problems: find.problems,
      warnings: find.warnings || [],
      added, dormant, needGeo, droppedPeople,
      coverage,
      totals: {
        communities: out.length,
        starts: out.reduce((a, c) => a + c.starts.reduce((x, y) => x + y, 0), 0),
        tradeCats: newCats.length,
        vendors: newVendors.length,
        before: existing.size
      }
    };
  }

  /* A compact diff for the publish history, mirroring what Vendor Assignments
     stores in change_log so Blueprint can report on both the same way. */
  function diffDocument(prev, next) {
    const names = doc => new Set(((doc && doc.communities) || []).map(c => c.name));
    const pc = names(prev), nc = names(next);
    const added = [...nc].filter(n => !pc.has(n));
    const removed = [...pc].filter(n => !nc.has(n));
    const startsOf = doc => ((doc && doc.communities) || [])
      .reduce((a, c) => a + (c.starts || []).reduce((x, y) => x + y, 0), 0);
    return {
      communities: nc.size,
      commsAdded: added.length,
      commsRemoved: removed.length,
      commsAddedList: added,
      commsRemovedList: removed,
      startsBefore: startsOf(prev),
      startsAfter: startsOf(next),
      unlocated: ((next && next.communities) || [])
        .filter(c => !Number.isFinite(c.lat) || !Number.isFinite(c.lon)).length
    };
  }

  return {
    S, digits, normCommunityId, xlDate, cleanCommName, normName, personIdFor,
    COMMUNITY_ALIASES, COMMUNITY_SPLIT, IGNORED_DEVELOPMENTS, AWAITING_CONTACTS,
    PLACEHOLDER_PER_DAY, GROWTH_REFUSE,
    STREET_TYPES, DIRECTIONS, BBOX, AGREE_M, SIBLING_M, REJECT_M,
    streetOf, streetKey, sameStreet, nameMatch, metresBetween, inBox, developmentOf,
    siblingBox, developmentFallback, SIBLING_REFUSE_M,
    resolveLocation, pendingLocations, applyLocation,
    acceptProposal, rejectProposal, placeManually, parseLatLon, wasRejected,
    parseLocality, placeKey, localityAgrees, localitiesFrom,
    parseStarts, aggregateStarts, parseRE2, parseContacts,
    currentDataStart, buildDocument, diffDocument
  };
});
