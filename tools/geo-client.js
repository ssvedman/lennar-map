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
    const q = [street, o.county, o.state || "FL", "USA"].filter(Boolean).join(", ");
    const box = o.bbox;
    const url = "https://nominatim.openstreetmap.org/search"
      + "?q=" + encodeURIComponent(q)
      + "&format=json&limit=5&countrycodes=us&addressdetails=1"
      + (box ? "&bounded=1&viewbox="
          + [box.minLon, box.maxLat, box.maxLon, box.minLat].join(",") : "");

    await nominatimGate(o.rateMs || RATE.nominatim);
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en" } });
    if (!r.ok) throw new Error("nominatim HTTP " + r.status);
    const j = await r.json();
    if (!Array.isArray(j) || !j.length) return null;

    /* Prefer a road. Nominatim will happily return a suburb or a hamlet that
       shares the name, and a suburb centroid is not a street. */
    const road = j.find(m => m.class === "highway")
              || j.find(m => ["road", "residential", "pedestrian"].includes(m.type));
    const m = road || j[0];

    return {
      lat: +m.lat, lon: +m.lon,
      precision: (m.class === "highway") ? "street" : "area",
      source: "nominatim",
      matchedStreet: streetFromNominatim(m),
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
    return {
      lat: m.coordinates.y, lon: m.coordinates.x,
      // A tigerLine side means it interpolated to a real address range.
      precision: (m.tigerLine && m.tigerLine.side) ? "address" : "street",
      source: "census",
      matchedStreet: streetFromCensus(m),
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
         agreement; stopping there is the difference between a batch that takes a
         minute and one that takes ten. */
      const good = out.filter(c => c.hit && !c.hit.error && Number.isFinite(c.hit.lat));
      if (good.length >= (o.enoughHits || 2)) break;
    }
    return out;
  }

  return {
    IN_BROWSER, RATE, UA,
    street, address, streetsFor,
    streetFromNominatim, streetFromCensus
  };
});
