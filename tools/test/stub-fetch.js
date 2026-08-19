/**
 * stub-fetch.js — preload module replacing global fetch with canned geocoder
 * responses, so validate.js can be exercised offline.
 *
 *   node -r ./tools/test/stub-fetch.js tools/validate.js --fix --data <fixture>
 *
 * GEOCODE_CASE selects the scenario. Stubs the network only — every line that
 * decides what to do with a result is the real one.
 */

'use strict';

const CASES = {
  // Address-precision match, 400 m from the stored point: inside the sane-drift
  // band, so --fix should silently correct it.
  'confident-drift': {
    census: { lat: 28.2085, lon: -81.6471, side: 'L' }
  },
  // Address-precision match but 40 km away: beyond DRIFT_FIX_MAX_M, so it must
  // be reported for a human rather than applied.
  'far-drift': {
    census: { lat: 28.5648, lon: -81.6471, side: 'L' }
  },
  // Census misses entirely; Nominatim returns only a town centroid. Coarse
  // precision must never overwrite a hand-placed pin.
  'coarse-only': {
    census: null,
    nominatim: { lat: 28.2100, lon: -81.6500, type: 'administrative', class: 'boundary' }
  },
  // Geocode lands in another state. Outside the bounding box, must be ignored.
  'out-of-box': {
    census: { lat: 41.8781, lon: -87.6298, side: 'L' }
  },
  // Census 500s, Nominatim returns a building-precision match at 300 m.
  'census-down': {
    census: 'error',
    nominatim: { lat: 28.2075, lon: -81.6471, type: 'building', class: 'place' }
  },
  // Everything agrees with the stored point: no output at all.
  'agrees': {
    census: { lat: 28.2048225, lon: -81.6470894, side: 'L' }
  }
};

const scenario = CASES[process.env.GEOCODE_CASE || 'agrees'] || CASES.agrees;

const json = body => Promise.resolve({
  ok: true, status: 200, json: () => Promise.resolve(body)
});

globalThis.fetch = function (url) {
  const u = String(url);

  if (u.includes('geocoding.geo.census.gov')) {
    const c = scenario.census;
    if (c === 'error') return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
    if (!c) return json({ result: { addressMatches: [] } });
    return json({
      result: {
        addressMatches: [{
          coordinates: { x: c.lon, y: c.lat },
          tigerLine: c.side ? { side: c.side } : {}
        }]
      }
    });
  }

  if (u.includes('nominatim.openstreetmap.org')) {
    const n = scenario.nominatim;
    if (n === 'error') return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve([]) });
    if (!n) return json([]);
    return json([{ lat: String(n.lat), lon: String(n.lon), type: n.type, class: n.class }]);
  }

  return Promise.reject(new Error(`stub-fetch: unexpected URL ${u}`));
};
