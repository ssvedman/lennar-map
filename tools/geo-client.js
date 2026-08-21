/* ============================================================================
   geo-client.js — the only thing in this project that talks to a geocoder.

   map-core.js decides what a geocoder's answer MEANS and is deliberately
   network-free. This file does the asking, and nothing else: it returns a hit in
   the shape resolveLocation() expects and leaves every judgement to it.

   Loaded in the browser as window.GEOCLIENT; required in node as module.exports.

   ── WHICH PROVIDER, AND WHY ──────────────────────────────────────────────────
   Two different questions need two different services.

   A STREET — "where is Sunfish Drive" — is what a new community gives us,
   because its lots have no house numbers yet. Census cannot answer that: its
   onelineaddress endpoint geocodes addresses and wants a number. Nominatim has
   road geometry and answers it directly.

   An ADDRESS — "where is 1660 Rider Rain Ln" — is what someone types by hand.
   Census is authoritative for US addresses, needs no key, and reports whether it
   interpolated to a real address range or fell back to the street.

   ── WHY STREET LOOKUPS DO NOT RUN IN A BROWSER ───────────────────────────────
   Nominatim's usage policy requires an identifying User-Agent and no more than
   one request per second. A browser cannot set User-Agent — it is a forbidden
   header — so a browser cannot use Nominatim politely, whatever CORS allows.
   Street resolution therefore runs from node, where both obligations can be met.

   Address lookups DO work from a browser, because Census asks for neither. That
   is the manual-assist path: you type an address, it offers a coordinate.
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.GEOCLIENT = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const IN_BROWSER = typeof window !== "undefined" && typeof window.document !== "undefined";

  const UA = "community-map-locator/1.0 (+lennar-map tools/geo-client.js)";
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* Nominatim asks for 1 req/s. Honoured with a shared gate rather than a sleep
     per call site, so concurrent callers cannot collectively exceed it. */
  let nominatimNext = 0;
  async function nominatimGate(rateMs) {
    const now = Date.now();
    const wait = Math.max(0, nominatimNext - now);
    nominatimNext = Math.max(now, nominatimNext) + rateMs;
    if (wait) await sleep(wait);
  }

  const RATE = { nominatim: 1100, census: 200 };

  /* The street name out of a provider's answer, so map-core's sameStreet() can
     check it against what was asked. Getting this wrong in the permissive
     direction defeats the entire safety mechanism, so each provider's extraction
     is explicit rather than a shared guess. */
  function streetFromNominatim(m) {
    // addressdetails=1 gives a structured road, which is what we want. Falling
    // back to the first segment of display_name is a last resort — for a road
    // result that segment IS the road name.
    const a = m.address || {};
    return a.road || a.pedestrian || a.residential || a.footway
        || String(m.display_name || "").split(",")[0].trim() || null;
  }

  /* WHICH TOWN the provider thinks it is in. Reported alongside the coordinate
     so map-core can check it against what Community-DB's Community Information
     Sheet says — the one check able to catch a correctly-named street in the
     wrong town directly, rather than by inference from a radius.

     Every one of these can legitimately be absent, and absent must stay absent:
     map-core reads a missing field as "no evidence", and inventing a value here
     would turn that into false agreement. */
  function placeFromNominatim(m) {
    const a = m.address || {};
    /* WHICH field the town name came from, reported alongside it.

       These are not equally authoritative. `city` and `town` are
       municipalities. `village`, `hamlet` and `suburb` are often a
       neighbourhood or a census-designated place that no postal address ever
       uses — OSM calls the area "Lake Nona" where every letter sent there says
       "Orlando". Treating that as the community being in the wrong town would
       refuse a perfectly correct street, so map-core lets a weak kind AGREE but
       not REFUSE. */
    const strong = [["city", a.city], ["town", a.town], ["municipality", a.municipality]];
    const weak = [["village", a.village], ["hamlet", a.hamlet],
                  ["suburb", a.suburb], ["neighbourhood", a.neighbourhood]];
    const picked = strong.filter(x => x[1])[0] || weak.filter(x => x[1])[0] || null;
    return {
      city: picked ? picked[1] : null,
      cityKind: picked ? picked[0] : null,
      cityAuthoritative: !!picked && strong.some(x => x[0] === picked[0]),
      zip: a.postcode ? String(a.postcode).slice(0, 5) : null,
      // Nominatim writes "Volusia County"; map-core's placeKey strips the word.
      county: a.county || null
    };
  }

  function placeFromCensus(m) {
    const a = m.addressComponents || {};
    return { city: a.city || null,
             zip: a.zip ? String(a.zip).slice(0, 5) : null,
             county: null };            // Census does not return one here
  }

  function streetFromCensus(m) {
    /* matchedAddress looks like "1660 RIDER RAIN LN, APOPKA, FL, 32703". Take the
       first comma segment and drop the leading house number — the same shape
       map-core's streetOf() handles, so the two agree about what a street is. */
    const first = String(m.matchedAddress || "").split(",")[0].trim();
    return first.replace(/^\d+[a-z]?\s+/i, "").trim() || null;
  }

  /* ------------------------------------------------------------- providers */

  async function lookupStreetNominatim(street, opts) {
    const o = opts || {};
    /* County rather than city. A new subdivision's city is often unknown, and
       guessing one wrongly turns a findable road into "no result". The county
       narrows the search enough to be useful while staying true; the bounding box
       and the strict name check in map-core do the rest of the filtering.

       viewbox + bounded confines the search to the division outright, which is
       the cheapest possible defence against a same-named road in another state. */
    /* Two shapes of question, and which one gets asked depends entirely on
       whether Community-DB knows where this community is.

       WITHOUT a locality: a free-form question narrowed only by county, if a
       county was supplied. County rather than city, because a new subdivision's
       city is often unknown and guessing one wrongly turns a findable road into
       "no result".

       WITH one: Nominatim's structured form, which is materially better than
       putting the same words in `q`. The free-form parser has to guess which
       token is a city and which is a street, and it guesses wrong on exactly the
       inputs here — invented-sounding subdivision names. Given the fields
       separately it does not have to guess, and a postcode narrows the search to
       a few square miles rather than a state.

       The two are mutually exclusive in Nominatim's API: `q` cannot be combined
       with the structured parameters, and sending both is an error. */
    const loc = o.locality || null;
    const box = o.bbox;
    const base = "https://nominatim.openstreetmap.org/search";
    const common = "&format=json&limit=5&countrycodes=us&addressdetails=1"
      + (box ? "&bounded=1&viewbox="
          + [box.minLon, box.maxLat, box.maxLon, box.minLat].join(",") : "");

    const structuredUrl = (loc && (loc.city || loc.zip))
      ? base + "?" + [["street", street],
                      ["city", loc.city],
                      ["county", loc.county],
                      ["state", loc.state || o.state || "FL"],
                      ["postalcode", loc.zip],
                      ["country", "USA"]]
          .filter(x => x[1]).map(x => x[0] + "=" + encodeURIComponent(x[1])).join("&") + common
      : null;

    const freeUrl = base + "?q=" + encodeURIComponent(
      [street, (loc && loc.county) || o.county, o.state || "FL", "USA"]
        .filter(Boolean).join(", ")) + common;

    async function ask(url) {
      await nominatimGate(o.rateMs || RATE.nominatim);
      const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en" } });
      if (!r.ok) throw new Error("nominatim HTTP " + r.status);
      const j = await r.json();
      return Array.isArray(j) && j.length ? j : null;
    }

    /* Structured first, free-form as the fallback — and the fallback is not
       optional politeness, it is load-bearing.

       Structured search matches on the fields given, which means it silently
       EXCLUDES any road whose OSM record carries no city or postcode. That is
       not a rare gap: it is the normal state of a road in a subdivision built
       last year, which is precisely the population this tool exists for. Asked
       for Plank Place in Davenport 33837 the structured form returns nothing,
       while the free-form form finds it immediately — the road is in OSM, it
       just has no address tags.

       So: ask the precise question first, because when it answers, the answer
       comes with the city and postcode that let map-core corroborate it. If it
       does not, ask the loose question and let the gates do their usual work. A
       result with no locality attached simply carries no locality evidence,
       which is different from carrying bad evidence — and a wrong-town match
       that DOES report its town is still caught, which is the case that matters. */
    /* WHAT WAS SENT, field by field. One flag for the whole request was too
       coarse in both directions.

       The free-form query still embeds the county, so a county "agreement" on
       that path is just as circular as a postcode one on the structured path —
       yet a per-request flag called it volunteered. And a structured query that
       had only a city to send marked a genuinely volunteered POSTCODE as not
       worth trusting, refusing to place things it should have placed.

       So each field says for itself whether it was a constraint or an answer. */
    let j = structuredUrl ? await ask(structuredUrl) : null;
    let via = "structured";
    let asked = { city: !!(loc && loc.city), county: !!(loc && loc.county),
                  zip: !!(loc && loc.zip) };
    if (!j) {
      j = await ask(freeUrl);
      via = "free";
      // The free-form query names the county in its text, and nothing else.
      asked = { city: false, county: !!((loc && loc.county) || o.county), zip: false };
    }
    if (!j) return null;

    /* Prefer a road. Nominatim will happily return a suburb or a hamlet that
       shares the name, and a suburb centroid is not a street. */
    const road = j.find(m => m.class === "highway")
              || j.find(m => ["road", "residential", "pedestrian"].includes(m.type));
    const m = road || j[0];

    /* The runners-up, not thrown away. limit=5 was being asked for and then all
       but one answer discarded, so a street name that matches several different
       roads looked exactly like one that matches exactly one — and the
       single-street placement path would take the first on a coin flip. Handing
       the alternatives back lets map-core refuse to place on an ambiguous
       answer, which is a decision it should be making rather than this file. */
    const others = j.filter(x => x !== m && x.class === "highway")
                    .map(x => ({ lat: +x.lat, lon: +x.lon,
                                 matchedStreet: streetFromNominatim(x) }));

    const place = placeFromNominatim(m);
    return {
      lat: +m.lat, lon: +m.lon,
      precision: (m.class === "highway") ? "street" : "area",
      source: "nominatim",
      /* HOW the answer was obtained, which decides how much its locality is
         worth. A structured query filters by city and postcode, so anything it
         returns necessarily carries the postcode that was asked for — checking
         that against the sheet it came from proves nothing, because the sheet
         supplied it. A free-form query constrains none of that, so a locality it
         reports back is volunteered, and agreeing with the sheet is real
         evidence. map-core will only place a lone street on the second kind. */
      via: via,
      matchedStreet: streetFromNominatim(m),
      matchedCity: place.city, matchedZip: place.zip, matchedCounty: place.county,
      matchedCityKind: place.cityKind,
      cityAuthoritative: place.cityAuthoritative,
      asked: asked,
      others: others,
      raw: { display_name: m.display_name, class: m.class, type: m.type }
    };
  }

  async function lookupAddressCensus(addr, opts) {
    const o = opts || {};
    const url = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
      + "?address=" + encodeURIComponent(addr)
      + "&benchmark=Public_AR_Current&format=json";

    await sleep(o.rateMs || RATE.census);
    const r = await fetch(url, IN_BROWSER ? {} : { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error("census HTTP " + r.status);
    const j = await r.json();
    const m = j.result && j.result.addressMatches && j.result.addressMatches[0];
    if (!m) return null;
    const place = placeFromCensus(m);
    return {
      lat: m.coordinates.y, lon: m.coordinates.x,
      // A tigerLine side means it interpolated to a real address range.
      precision: (m.tigerLine && m.tigerLine.side) ? "address" : "street",
      source: "census",
      matchedStreet: streetFromCensus(m),
      matchedCity: place.city, matchedZip: place.zip, matchedCounty: place.county,
      // Census is never handed a locality to filter on, so whatever it reports
      // back it worked out for itself, in every field.
      via: "free",
      asked: { city: false, county: false, zip: false },
      cityAuthoritative: true,
      others: [],
      raw: { matchedAddress: m.matchedAddress }
    };
  }

  /* ------------------------------------------------------------------- api */

  /* Where is this street? Returns a hit, null for "no such street", or
     { error } — and the three are kept distinct because they mean different
     things to the operator. "No result" for a brand-new road is expected and
     will probably resolve on a later import; an error means the lookup never
     happened and nothing has been learned.

     Refuses outright in a browser. Failing loudly beats sending a request that
     violates someone's usage policy, and the caller has a manual path. */
  async function street(name, opts) {
    if (IN_BROWSER) {
      return { error: "street lookups run from node, not the browser — Nominatim "
                    + "requires a User-Agent, which a browser cannot set" };
    }
    if (typeof fetch !== "function") {
      return { error: "this node build has no global fetch (needs node 18+)" };
    }
    if (!name) return null;
    try {
      return await lookupStreetNominatim(name, opts);
    } catch (e) {
      return { error: (e && e.message) || String(e) };
    }
  }

  /* Where is this full address? Works in both node and a browser.

     The browser case is the one unknown in this whole design: whether Census
     sends CORS headers has not been verified. It either works or it returns a
     network error, and the caller treats the error as "type the coordinate in
     yourself" — so an unfriendly answer costs a click, not a feature. The error
     distinguishes a blocked request from a genuine miss so the cause is legible
     the first time somebody hits it. */
  async function address(addr, opts) {
    if (typeof fetch !== "function") {
      return { error: "no fetch available in this environment" };
    }
    if (!String(addr || "").trim()) return null;
    try {
      return await lookupAddressCensus(addr, opts);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      /* A browser reports a CORS refusal as an opaque "Failed to fetch", with no
         detail, because exposing the reason would itself leak information. Name
         the likely cause rather than passing that on. */
      if (IN_BROWSER && /failed to fetch|networkerror|load failed/i.test(msg)) {
        return { error: "could not reach the geocoder from the browser — it may not "
                      + "allow cross-origin requests. Enter the coordinate by hand, "
                      + "or run tools/locate-communities.js.", blocked: true };
      }
      return { error: msg };
    }
  }

  /* Every street of one community, in order, stopping early once there is enough
     to decide. Two agreeing streets is all resolveLocation needs, so a community
     with 42 streets does not cost 42 requests at one per second.

     `onProgress` exists because at 1.1 s per lookup a batch is slow enough that
     silence looks like a hang. */
  async function streetsFor(streets, opts) {
    const o = opts || {};
    const out = [];
    const cap = o.maxLookups || 6;
    for (const s of (streets || []).slice(0, cap)) {
      const name = typeof s === "string" ? s : s.street;
      if (o.onProgress) o.onProgress(name);
      out.push({ street: name, hit: await street(name, o) });

      /* Enough already? Two distinct streets that both resolved is the bar for
         agreement, and stopping there is the difference between a batch that
         takes a minute and one that takes ten.

         "Resolved" has to mean "would actually count", not "came back with a
         coordinate". Counting bare returns let two useless answers — a road of
         the wrong name, or one in a town the sheet says this is not — end the
         search before the third street was ever tried, manufacturing the
         single-street case out of a community that had four streets to offer.

         The test for what counts lives in map-core and is not importable here
         without dragging this file into the decision business it is deliberately
         kept out of, so the caller passes it in. With no predicate the old
         behaviour stands, which is what a caller that does not care wants. */
      const accept = o.accept || (h => h && !h.error && Number.isFinite(h.lat));
      const good = out.filter(c => accept(c.hit, c.street));
      if (good.length >= (o.enoughHits || 2)) break;
    }
    return out;
  }

  return {
    IN_BROWSER, RATE, UA,
    street, address, streetsFor,
    streetFromNominatim, streetFromCensus,
    placeFromNominatim, placeFromCensus
  };
});
