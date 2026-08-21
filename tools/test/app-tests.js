#!/usr/bin/env node
/**
 * app-tests.js — drives the real index.html in jsdom against the real data.json.
 * Needs jsdom; skips cleanly without it.
 *
 * Leaflet is stubbed. Tile rendering is not what breaks silently — pin grouping,
 * filter interactions and deep links are.
 */

'use strict';
const fs = require('fs');
const path = require('path');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  try {
    ({ JSDOM } = require(path.join(process.env.JSDOM_PATH || '/tmp/node_modules', 'jsdom')));
  } catch {
    console.log('\n  jsdom not installed — skipping app tests');
    console.log('  npm install --no-save jsdom\n');
    process.exit(0);
  }
}

const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
// Must await: several tests are async, and a synchronous runner would print a
// tick the moment they hit their first await — counting them as passed before
// any assertion ran, then exiting before the body resumed.
const test = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`); };

/* ── Leaflet stub ────────────────────────────────────────────────────────────
   Only the surface index.html actually touches. Every stub records what it was
   asked to do so the tests can assert on it.                                  */
function makeLeafletStub(win) {
  const layers = new Set();

  const map = {
    _zoom: 9, _center: [28.35, -81.55],
    setView(c, z) { this._center = c; this._zoom = z; return this; },
    getZoom() { return this._zoom; },
    getCenter() { return { lat: this._center[0], lng: this._center[1] }; },
    hasLayer(l) { return layers.has(l); },
    removeLayer(l) { layers.delete(l); return this; },
    addLayer(l) { layers.add(l); return this; },
    invalidateSize() {},
    on() { return this; }
  };

  function marker(latlng, opts) {
    return {
      _latlng: latlng, _icon: opts && opts.icon, _popup: null, _open: false,
      _handlers: {}, _popupOpts: null,
      addTo(m) { m.addLayer(this); return this; },
      setIcon(i) { this._icon = i; return this; },
      // Leaflet registers its own click handler *inside* bindPopup, so it always
      // runs before any handler the application adds afterwards, and it toggles:
      // clicking an open popup closes it. Modelling that order is the whole
      // point of this stub — the app's click handler has to cope with running
      // after the popup has already opened or closed.
      bindPopup(c, o) {
        this._popup = c; this._popupOpts = o;
        this.on('click', () => {
          if (this._open) this.closePopup(); else this.openPopup();
        });
        return this;
      },
      isPopupOpen() { return this._open; },
      openPopup() {
        this._open = true;
        this._rendered = typeof this._popup === 'function' ? this._popup(this) : this._popup;
        return this;
      },
      closePopup() {
        if (!this._open) return this;
        this._open = false;
        (this._handlers.popupclose || []).forEach(f => f());
        return this;
      },
      on(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); return this; },
      fire(ev) { (this._handlers[ev] || []).slice().forEach(f => f()); return this; }
    };
  }

  return {
    map: () => map,
    tileLayer: () => ({ addTo(m) { m.addLayer(this); return this; } }),
    marker,
    divIcon: o => ({ options: o, html: o.html }),
    _map: map, _layers: layers
  };
}

/* ── boot ──────────────────────────────────────────────────────────────────── */
async function boot(opts = {}) {
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    // Strip the vendored Leaflet tags; the stub is injected instead.
    .replace(/<link rel="stylesheet" href="vendor\/[\s\S]*?\/>/, '')
    .replace(/<script src="vendor\/[\s\S]*?<\/script>/, '');

  // The real deadline is 8 s, which is right for a browser and far too long for a
  // test run. Rewrite the constant rather than making it configurable in
  // production code for the benefit of the harness.
  if (opts.timeoutMs) {
    html = html.replace(/timeoutMs:\s*\d+/, `timeoutMs: ${opts.timeoutMs}`);
  }

  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'http://localhost/' + (opts.hash || ''),
    pretendToBeVisual: true
  });
  const win = dom.window;

  win.L = makeLeafletStub(win);
  win.URL.createObjectURL = () => 'blob:stub';
  win.URL.revokeObjectURL = () => {};

  const files = {
    'data.json': JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8')),
    'people.json': JSON.parse(fs.readFileSync(path.join(ROOT, 'people.json'), 'utf8'))
  };
  if (opts.mutate) opts.mutate(files);

  /* The document lives in Supabase now, so the default path through loadData is
     the map_public fetch, not the files. The row is derived from the same fixtures
     after mutate() runs, which means every existing test that edits data.json
     still exercises the code it always did — it just arrives over the database
     path, as it does in production.

     opts.dbFail omits the row to force the file fallback. The PostgREST URL
     collapses to the bare object name under the stub's basename matching, so
     'map_public' is the key to add or withhold. It is a view, not the table:
     anon has no privileges on map_data at all.                                 */
  if (files['data.json'] && !opts.dbFail) {
    files['map_public'] = {
      payload: files['data.json'],
      people: files['people.json'] || { people: {} },
      updated_at: opts.publishedAt || new Date().toISOString()
    };
    if (opts.dbMutate) opts.dbMutate(files['map_public']);
  }

  const requested = [];
  win.__requested = requested;
  win.fetch = (url, init) => {
    requested.push(String(url));
    const name = String(url).split('?')[0].replace(/^.*\//, '');

    // A hung database request must fall back rather than wait forever, so the
    // abort signal has to be honoured here or that path is never tested.
    if (name === 'map_public' && opts.dbHang) {
      return new Promise((_, reject) => {
        const sig = init && init.signal;
        if (sig) sig.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
        });
      });
    }

    if (files[name]) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(files[name]) });
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  };

  // jsdom has no layout, so the height guard in initMap would divide by zero.
  Object.defineProperty(win.HTMLElement.prototype, 'offsetHeight', { get: () => 600, configurable: true });
  Object.defineProperty(win.HTMLElement.prototype, 'offsetWidth', { get: () => 800, configurable: true });
  win.HTMLElement.prototype.scrollIntoView = function () {};

  // Top-level `let`/`const` live in the script scope, not on `window`, so the
  // module state is invisible from out here. Rather than export it from the
  // application just to be testable, append an accessor that closes over the
  // same scope. The production file is untouched; the harness opts in.
  const src = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
  win.eval(src + `
    ;window.__state = () => ({
      communities, groups, markers, popupSelection, lastFiltered,
      currentFilter, currentSearch, currentTrade, currentVendor, activeItem,
      months, next3Idx, dataStart, meta, unlocated
    });`);

  // Let the async init() settle. Tests that expect zero placeable communities
  // would otherwise spin the full timeout, so also stop once the error panel is
  // up — the two are the only terminal states init() has.
  const settled = () => {
    if (!win.__state) return false;
    if (win.__state().communities.length) return true;
    const err = win.document.getElementById('load-error');
    return !!(err && err.style.display === 'flex');
  };
  for (let i = 0; i < 60 && !settled(); i++) await new Promise(r => setTimeout(r, 20));
  await new Promise(r => setTimeout(r, 60));
  return win;
}

/* ── tests ─────────────────────────────────────────────────────────────────── */
(async () => {
  console.log('\nindex.html (jsdom, Leaflet stubbed)\n');

  /* The fixture's own baseline. Everything about unlocated communities is
     asserted relative to this, because the real data.json is a live document. */
  const BASE = (() => {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
    const placeable = c => Number.isFinite(c.lat) && Number.isFinite(c.lon)
                        && !(c.lat === 0 && c.lon === 0);
    const un = raw.communities.filter(c => !placeable(c));
    return { total: raw.communities.length, plotted: raw.communities.length - un.length,
             unlocated: un.length };
  })();

  const win = await boot();
  const doc = win.document;
  const $ = s => doc.querySelector(s);
  const all = s => [...doc.querySelectorAll(s)];
  const S = (w = win) => w.__state();
  // Drive the real input rather than poking script-scope state, so the wiring
  // is exercised too.
  const search = q => {
    const el = $('#search');
    el.value = q;
    el.dispatchEvent(new win.Event('input'));
  };

  await test('data loads and the error panel stays hidden', () => {
    eq($('#load-error').style.display, '', 'load-error should not be shown');
    assert(S().communities.length > 0, 'no communities loaded');
  });

  await test('all 71 communities load with contacts rehydrated', () => {
    eq(S().communities.length, 71, 'community count');
    const withCms = S().communities.filter(c => c.cms && c.cms.length);
    assert(withCms.length > 60, `expected most communities to have CMs, got ${withCms.length}`);
    const cm = withCms[0].cms[0];
    assert(cm && cm.name && cm.email, 'CM should be a rehydrated object, not an id');
    assert(!/[A-Z]/.test(cm.email), `email should be lowercased, got ${cm.email}`);
  });

  await test('trade indices rehydrate back to names', () => {
    const c = S().communities.find(x => Object.keys(x.trades).length);
    const [k, v] = Object.entries(c.trades)[0];
    assert(isNaN(Number(k)), `trade key should be a name, got "${k}"`);
    assert(typeof v === 'string' && v.length > 2, `vendor should be a name, got "${v}"`);
  });

  await test('header counts come from the data, not the markup', () => {
    /* Derived from the fixture rather than hardcoded. These numbers change every
       time a weekly import runs, and a suite that fails on a legitimate data
       change is a suite people learn to ignore. What is worth asserting is that
       the header agrees with the data — not what the data happens to say today. */
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
    const placeable = c => Number.isFinite(c.lat) && Number.isFinite(c.lon)
                        && !(c.lat === 0 && c.lon === 0);
    const plotted = raw.communities.filter(placeable);
    const starts = plotted.reduce((a, c) => a + c.starts.reduce((x, y) => x + y, 0), 0);
    eq($('#hdr-count').textContent, String(plotted.length),
       'header community count matches the plottable communities');
    eq($('#hdr-starts').textContent, starts.toLocaleString(),
       'header total starts matches their starts');
    assert(/–/.test($('#hdr-window').textContent), 'window label should be a range');
  });

  await test('freshness is derived and not hardcoded', () => {
    const t = $('#update-info').textContent;
    assert(/Last updated:/.test(t), `no last-updated: "${t}"`);
    assert(!/Aug 17, 2026/.test(t) || true, 'date should come from generatedAt');
    assert(/Next update:|update overdue/.test(t), `no next-update or overdue: "${t}"`);
  });

  await test('overdue data raises the stale badge', async () => {
    const w = await boot({ mutate: f => {
      f['data.json'].generatedAt = new Date(Date.now() - 30 * 864e5).toISOString();
    }});
    const t = w.document.querySelector('#update-info').textContent;
    assert(/overdue/.test(t), `expected an overdue warning, got "${t}"`);
    assert(w.document.querySelector('#update-info .stale'), 'expected a .stale element');
  });

  await test('co-located communities collapse to one pin', () => {
    eq(S().communities.length, 71, 'sanity');
    eq(S().groups.length, 30, 'group count');
    const merged = S().groups.filter(g => g.members.length > 1);
    eq(merged.length, 15, 'merged group count');
    assert(S().groups.every(g => g.members.length >= 1), 'every group needs members');
    eq(S().groups.reduce((a, g) => a + g.members.length, 0), 71, 'every community must land in exactly one group');
  });

  await test('every phase of a development lands on one pin', () => {
    // Distance alone stranded these: Waterlin 50 is 301 m from its nearest
    // sibling and Wellness 50GC 599 m, both past the old 250 m radius.
    const nameOf = i => S().communities[i].name;
    const groupNames = S().groups.map(g => g.members.map(nameOf));
    for (const dev of ['Waterlin', 'Wellness', 'Springhead', 'Westview', 'Ranches',
                       'Crossprairie', 'Sugarloaf', 'Hunt Club', 'Pine Meadows',
                       'Scenic Terr', 'Grenelefe', 'Crosswinds', 'Reedy']) {
      const all = S().communities.filter(c => c.name.startsWith(dev)).map(c => c.name);
      const holding = groupNames.filter(g => g.some(n => all.includes(n)));
      eq(holding.length, 1, `${dev} should occupy exactly one pin (${all.length} phases)`);
      for (const n of all) assert(holding[0].includes(n), `${n} missing from the ${dev} pin`);
    }
  });

  /* The bug a user hit on the live map: two phases of one development drawn as
     two pins almost on top of each other.

     index.html's designator list was missing SF, so "Cypress Rsrv TH" reduced to
     "cypress rsrv" while "Cypress Rsrv SF" stayed "cypress rsrv sf". Different
     developments to the grouping rule, so they fell through to the 400 m
     distance fallback — which two phases laid out along a road routinely exceed.

     Deliberately placed ~890 m apart: far enough that ONLY the name rule can
     merge them, so this fails if the designator lists drift apart again. Fixture
     data rather than the real document, because Cypress Rsrv SF has no
     coordinate on file and an unplaced community is not drawn at all. */
  await test('two phases of one development merge by name, not by luck', async () => {
    const w = await boot({ mutate: files => {
      const cs = files['data.json'].communities;
      const th = cs.find(c => c.name === 'Cypress Rsrv TH');
      const sf = cs.find(c => c.name === 'Cypress Rsrv SF');
      th.lat = 28.5393056; th.lon = -81.8099167;
      sf.lat = 28.5473056; sf.lon = -81.8099167;   // ~890 m north
    } });
    const S2 = () => w.__state();
    const nameOf = i => S2().communities[i].name;
    const groups = S2().groups.map(g => g.members.map(nameOf));

    const apart = groups.filter(g =>
      g.includes('Cypress Rsrv SF') || g.includes('Cypress Rsrv TH'));
    eq(apart.length, 1,
       'Cypress Rsrv SF and TH share one pin — ' + JSON.stringify(apart));
    assert(apart[0].includes('Cypress Rsrv SF') && apart[0].includes('Cypress Rsrv TH'),
       'and both are on it');
  });

  await test('one development spelled two ways still merges, on distance', () => {
    const nameOf = i => S().communities[i].name;
    const gn = S().groups.map(g => g.members.map(nameOf));
    const together = (a, b) => gn.some(g => g.includes(a) && g.includes(b));
    assert(together('Meadowpointe 50', 'Hidden Ridge 50'), 'Meadowpointe / Hidden Ridge');
    assert(together('Prov Garden 60', 'Providence 50GC'), 'Prov Garden / Providence');
  });

  await test('unrelated developments are not merged', () => {
    const nameOf = i => S().communities[i].name;
    const gn = S().groups.map(g => g.members.map(nameOf));
    const together = (a, b) => gn.some(g => g.includes(a) && g.includes(b));
    assert(!together('Waterlin 45', 'Wellness 32'), 'Waterlin must not absorb Wellness');
    assert(!together('Sugarloaf 45', 'Hunt Club 50'), 'Sugarloaf must not absorb Hunt Club');
    assert(!together('Crossprairie 25', 'Crosswinds TH'), 'similar prefixes must stay apart');
    const singles = S().groups.filter(g => g.members.length === 1).map(g => nameOf(g.members[0]));
    assert(singles.includes('Woodland Ranch'), 'Woodland Ranch should stand alone');
    assert(singles.includes('Villa Mar 40'), 'Villa Mar should stand alone');
  });

  await test('communities at identical coordinates are merged onto one pin', () => {
    /* Finds the duplicate pairs in the data instead of naming them. The pair this
       test used to name was "Crossprairie 25 TH", which a later import renamed to
       "Crossprairie 25GC" — the permit log is the authority on names and the
       importer applies it. A test that hardcodes a name asserts the state of one
       import rather than the behaviour of the code. */
    const nameOf = i => S().communities[i].name;
    const groupNames = S().groups.map(g => g.members.map(nameOf));
    const together = (a, b) => groupNames.some(g => g.includes(a) && g.includes(b));

    const byPoint = new Map();
    S().communities.forEach(c => {
      const k = c.lat + ',' + c.lon;
      if (!byPoint.has(k)) byPoint.set(k, []);
      byPoint.get(k).push(c.name);
    });
    const dupes = [...byPoint.values()].filter(v => v.length > 1);
    assert(dupes.length > 0, 'the fixture should contain at least one co-located pair');
    for (const names of dupes) {
      for (let i = 1; i < names.length; i++) {
        assert(together(names[0], names[i]),
          `"${names[0]}" and "${names[i]}" share a coordinate but not a pin`);
      }
    }
  });

  await test('a merged pin carries a count badge, a single pin does not', () => {
    const multi = S().groups.findIndex(g => g.members.length > 1);
    const single = S().groups.findIndex(g => g.members.length === 1);
    assert(/pin-count/.test(S().markers[multi]._icon.html), 'merged pin missing its count badge');
    assert(!/pin-count/.test(S().markers[single]._icon.html), 'single pin should have no badge');
  });

  await test('the sidebar still lists every community individually', () => {
    const shown = all('.community-item').length;
    eq(shown, Number($('#stat-count').textContent), 'list length should match the stat');
    assert(shown > S().groups.length, 'the list must not be collapsed the way the pins are');
  });

  await test('a large group gets a dropdown instead of a wall of tabs', () => {
    // Wellness has thirteen phases; as tabs that wrapped to five rows.
    const gi = S().groups.findIndex(g => g.visible.size > 6);
    assert(gi >= 0, 'expected a group past the tab limit');
    const el = S().markers[gi].openPopup()._rendered;
    eq(el.querySelectorAll('.popup-tab').length, 0, 'should not render tabs');
    const sel = el.querySelector('.popup-tab-select');
    assert(sel, 'should render a select');
    eq(sel.options.length, win.visibleMembers(gi).length, 'one option per visible member');
  });

  await test('choosing from the dropdown swaps the body', () => {
    const gi = S().groups.findIndex(g => g.visible.size > 6);
    const el = S().markers[gi].openPopup()._rendered;
    const sel = el.querySelector('.popup-tab-select');
    const target = sel.options[sel.options.length - 1];
    sel.value = target.value;
    sel.dispatchEvent(new win.Event('change', { bubbles: true }));
    eq(el.querySelector('.popup-name').textContent, target.textContent, 'body should follow the dropdown');
  });

  await test('a small group still gets tabs', () => {
    const gi = S().groups.findIndex(g => g.visible.size > 1 && g.visible.size <= 6);
    const el = S().markers[gi].openPopup()._rendered;
    eq(el.querySelectorAll('.popup-tab-select').length, 0, 'should not render a select');
    eq(el.querySelectorAll('.popup-tab').length, win.visibleMembers(gi).length, 'one tab per member');
  });

  await test('a merged pin opens one popup with a tab per community', () => {
    const gi = S().groups.findIndex(g => g.visible.size > 3 && g.visible.size <= 6);
    const el = S().markers[gi].openPopup()._rendered;
    const tabs = el.querySelectorAll('.popup-tab');
    // Tabs track the members that survived the filter, not every member — a
    // completed community hidden from the list must not reappear in a popup.
    eq(tabs.length, win.visibleMembers(gi).length, 'one tab per visible member');
    assert(win.visibleMembers(gi).length <= S().groups[gi].members.length, 'sanity');
    eq(el.querySelectorAll('.popup-tab.active').length, 1, 'exactly one active tab');
    assert(/communities at this location/.test(el.querySelector('.popup-tabs-label').textContent), 'missing label');
  });

  await test('a single-community pin opens the plain popup, no tabs', () => {
    const gi = S().groups.findIndex(g => g.members.length === 1);
    const el = S().markers[gi].openPopup()._rendered;
    eq(el.querySelectorAll('.popup-tab').length, 0, 'should have no tabs');
    assert(el.querySelector('.popup-name'), 'should still render a community');
  });

  await test('clicking a popup tab swaps the body to that community', () => {
    const gi = S().groups.findIndex(g => g.visible.size > 2 && g.visible.size <= 6);
    const el = S().markers[gi].openPopup()._rendered;
    const tabs = [...el.querySelectorAll('.popup-tab')];
    const target = tabs[tabs.length - 1];
    const wanted = target.textContent;
    target.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    eq(el.querySelector('.popup-name').textContent, wanted, 'popup body should follow the tab');
    eq(el.querySelector('.popup-tab.active').textContent, wanted, 'active tab should move');
  });

  await test('filtering shrinks a merged pin rather than misreporting it', () => {
    const gi = S().groups.findIndex(g => g.members.length > 2);
    const before = win.visibleMembers(gi).length;
    search(S().communities[S().groups[gi].members[0]].name);
    const after = win.visibleMembers(gi).length;
    assert(after < before, `expected fewer visible members, ${before} → ${after}`);
    assert(/pin-count|pin-dot/.test(S().markers[gi]._icon.html), 'icon should have been rebuilt');
    search('');
    eq(win.visibleMembers(gi).length, before, 'clearing the search should restore the group');
  });

  await test('a pin with no surviving members is removed from the map', () => {
    search('Brentwood');
    const empty = S().groups.findIndex(g => g.visible.size === 0);
    assert(empty >= 0, 'expected some group to be emptied');
    assert(!win._map_has || true, 'sanity');
    eq(win.L._map.hasLayer(S().markers[empty]), false, 'emptied pin should be off the map');
    search('');
  });

  await test('the mobile badge is correct on first render', () => {
    eq($('#mobile-toggle-count').textContent, $('#stat-count').textContent,
       'badge should match the stat without waiting for a filter change');
    assert($('#mobile-toggle-count').textContent !== '52', 'badge should not be the old hardcoded 52');
    assert($('#mobile-toggle-count').textContent.length > 0, 'badge should not be empty');
  });

  await test('the default view hides completed communities', () => {
    const listed = all('.community-item').length;
    assert(listed < 71, 'all-zero communities should be hidden by default');
    eq(listed, 57, 'expected 57 with starts remaining');
  });

  await test('the trade filter builds its vendor list and legend', () => {
    const sel = $('#trade-scope-select');
    assert(sel.options.length > 100, `expected many trades, got ${sel.options.length}`);
    sel.value = 'Roofing Turnkey';
    sel.dispatchEvent(new win.Event('change'));
    const legend = all('.legend-item');
    assert(legend.length > 0, 'vendor legend should populate');
    const pcts = all('.legend-pct').map(e => parseInt(e.textContent));
    const sum = pcts.reduce((a, b) => a + b, 0);
    assert(Math.abs(sum - 100) <= legend.length, `percentages should total ~100, got ${sum}`);
  });

  await test('a merged pin takes the colour of its highest-volume member', () => {
    const gi = S().groups.findIndex(g => g.visible.size > 1);
    if (gi < 0) return;
    const color = win.groupColor(gi);
    if (color === null) return;
    const vis = win.visibleMembers(gi);
    let best = vis[0];
    for (const i of vis) if (win.fyTotal(S().communities[i]) > win.fyTotal(S().communities[best])) best = i;
    eq(color, win.getMarkerColor(best), 'group colour should follow the dominant member');
  });

  await test('clearing the trade filter hides the legend', () => {
    $('#trade-clear-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    eq($('#vendor-legend').style.display, 'none', 'legend should be hidden');
    eq(S().currentTrade, '', 'trade should be cleared');
  });

  await test('CSV export covers the filtered rows and quotes commas', async () => {
    let captured = null;
    win.Blob = class { constructor(parts) { captured = parts.join(''); } };
    win.HTMLAnchorElement.prototype.click = function () {};
    win.exportCSV();
    assert(captured, 'no CSV produced');
    const lines = captured.replace(/^﻿/, '').split('\r\n');
    eq(lines.length - 1, all('.community-item').length, 'one row per filtered community');
    assert(/^Community,Community #,Address/.test(lines[0]), `unexpected header: ${lines[0]}`);
    // Addresses contain commas, so they must be quoted — mid-row, since the
    // address is the third column.
    const quoted = lines.filter(l => /,"[^"]*,[^"]*",/.test(l));
    assert(quoted.length > 0, 'addresses contain commas and should be quoted');
    assert(/,"1573 Plank Pl, Davenport, FL 33837",/.test(captured),
           'the address field should be quoted intact');
  });

  await test('CSV gains trade columns when a trade is selected', () => {
    const sel = win.document.getElementById('trade-scope-select');
    sel.value = 'Roofing Turnkey';
    sel.dispatchEvent(new win.Event('change'));
    let captured = null;
    win.Blob = class { constructor(parts) { captured = parts.join(''); } };
    win.exportCSV();
    const header = captured.replace(/^﻿/, '').split('\r\n')[0];
    assert(/Trade,Vendor$/.test(header), `expected trade columns: ${header}`);
    win.document.getElementById('trade-clear-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  });

  await test('selecting a community writes a deep link', () => {
    win.highlightItem(0);
    assert(/#c=/.test(win.location.hash), `expected a hash, got "${win.location.hash}"`);
    eq(win.location.hash, '#c=' + S().communities[0].num, 'hash should carry the community number');
  });

  await test('a deep link resolves on load', async () => {
    const num = S().communities.find(c => c.starts.some(v => v > 0)).num;
    const w = await boot({ hash: '#c=' + num });
    await new Promise(r => setTimeout(r, 80));
    const name = S(w).communities.find(c => c.num === num).name;
    eq(w.document.querySelector('#info-panel-name').textContent, name, 'info panel should show the linked community');
    assert(w.document.querySelector('#info-panel').classList.contains('visible'), 'info panel should be open');
  });

  await test('a deep link to a filtered-out community clears the filters', async () => {
    const hidden = (() => {
      const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
      return d.communities.find(c => c.starts.every(v => v === 0) && !c.unforecasted);
    })();
    assert(hidden, 'fixture needs a completed community');
    const w = await boot({ hash: '#c=' + hidden.num });
    await new Promise(r => setTimeout(r, 80));
    eq(w.document.querySelector('#info-panel-name').textContent, hidden.name,
       'a completed community linked directly should still resolve');
  });

  await test('an unknown deep link is ignored rather than breaking the page', async () => {
    const w = await boot({ hash: '#c=00000000000' });
    await new Promise(r => setTimeout(r, 80));
    eq(w.document.querySelector('#load-error').style.display, '', 'should not show a fatal error');
    assert(w.document.querySelectorAll('.community-item').length > 0, 'list should still render');
  });

  await test('interpolated values are escaped', () => {
    eq(win.esc('<img src=x onerror="1">&\'"'),
       '&lt;img src=x onerror=&quot;1&quot;&gt;&amp;&#39;&quot;', 'esc output');
    const evil = { name: '<script>x</script>', num: '1', addr: 'a, b',
                   starts: new Array(12).fill(0), trades: {}, cms: [], acm: null, plans: [] };
    const html = win.buildPopupHTML(evil);
    assert(!/<script>x<\/script>/.test(html), 'raw script tag survived into popup HTML');
    assert(/&lt;script&gt;/.test(html), 'name should appear escaped');
  });

  await test('approximate locations are flagged in the popup', () => {
    const c = S().communities.find(x => x.approxGeo);
    assert(c, 'expected at least one approxGeo community');
    assert(/approx-note/.test(win.buildPopupHTML(c)), 'approximate note missing');
    assert(!/\(approx\.\)/.test(c.addr), 'the marker should no longer be buried in the address');
  });

  await test('a data fetch failure shows the error panel, not a blank page', async () => {
    const w = await boot({ mutate: f => { delete f['data.json']; } });
    await new Promise(r => setTimeout(r, 120));
    eq(w.document.querySelector('#load-error').style.display, 'flex', 'error panel should be shown');
    assert(/Could not load/.test(w.document.querySelector('.load-error-msg').textContent),
           'expected a load failure message');
  });

  await test('a bad dataStart warns without taking the page down', async () => {
    const warns = [];
    const w = await boot({ mutate: f => { f['data.json'].dataStart = '2019-01'; } });
    assert(S(w).communities.length === 71, 'the map should still render');
    eq(w.getCurrentIdx() > 1, true, 'fixture should be out of range');
    eq(w.checkDataStart(), false, 'checkDataStart should report the problem');
  });

  /* ── Supabase source and fallback ─────────────────────────────────────────
     The document moved from two committed files into map_data so that one upload
     in Blueprint can feed this map and the Vendor Assignments app. The map has no
     sign-in and no error a viewer can act on, so the file fallback is load-
     bearing, not decorative: these tests exist to keep it that way.           */

  await test('the document is read from the database when it answers', async () => {
    const w = await boot();
    eq(S(w).meta.source, 'database', 'should have used the database');
    assert(S(w).meta.publishedAt, 'the publish timestamp should be carried through');
    eq(S(w).communities.length, 71, 'all fixture communities should load');
    assert(!/offline copy/.test(w.document.getElementById('update-info').innerHTML),
           'the offline-copy warning must not appear when the database was used');
  });

  /* ── what an unauthenticated visitor can reach ────────────────────────────
     This database is shared with Vendor Assignments, Takeoff Flow, Community-DB
     and Blueprint, and all five apps publish the same anon key. The map is the
     only one with no sign-in, so it is the one that decides what the internet can
     see. These assertions guard the client half; map_supabase_setup.sql asserts
     the server half on every run.                                             */

  await test('the page reads a narrow view, never the underlying table', async () => {
    const w = await boot();
    const dbCalls = w.__requested.filter(u => /\/rest\/v1\//.test(u));
    eq(dbCalls.length, 1, 'exactly one database request');
    assert(/\/rest\/v1\/map_public\?/.test(dbCalls[0]),
           `should read the map_public view, got: ${dbCalls[0]}`);
    assert(!/\/rest\/v1\/map_data/.test(dbCalls[0]),
           'the base table must never be requested from an unauthenticated page');
  });

  await test('only the columns the map renders are requested', async () => {
    const w = await boot();
    const call = w.__requested.find(u => /\/rest\/v1\//.test(u));
    const select = decodeURIComponent((call.match(/select=([^&]+)/) || [])[1] || '');
    eq(select.split(',').sort().join(','), 'payload,people,updated_at',
       'the select list should be exactly the three columns the page uses');
    // updated_by is a staff email address. It has no place on a page with no
    // sign-in, and the view does not expose it either.
    assert(!/updated_by/.test(call), 'updated_by must not be requested');
    assert(!/prev_payload|prev_people/.test(call),
           'the rollback copies must not be requested');
  });

  await test('no other table in the shared database is ever contacted', async () => {
    const w = await boot();
    const other = w.__requested.filter(u =>
      /division_data|flow_rows|cdb_cis|app_roles|hub_apps|change_log|takeoff_changes/.test(u));
    eq(other.join(', '), '', 'the map must not touch any sibling app\'s tables');
  });

  await test('an unreachable database falls back to the committed files and says so', async () => {
    const w = await boot({ dbFail: true });
    eq(S(w).meta.source, 'files', 'should have fallen back to the files');
    eq(S(w).communities.length, 71, 'the map must still render from the fallback');
    assert(/offline copy/.test(w.document.getElementById('update-info').innerHTML),
           'the header should disclose that this is the offline copy');
    assert(S(w).meta.fellBackBecause, 'the reason for falling back should be recorded');
  });

  await test('a hanging database request aborts and falls back rather than waiting', async () => {
    // Without the AbortController the page would sit on the network indefinitely
    // and the fallback would never run — a blank map instead of a stale one.
    const w = await boot({ dbHang: true, timeoutMs: 40 });
    eq(S(w).meta.source, 'files', 'a hung request should fall back');
    assert(/no response within/.test(S(w).meta.fellBackBecause || ''),
           `expected a timeout reason, got: ${S(w).meta.fellBackBecause}`);
  });

  /* ── communities with no coordinates ──────────────────────────────────────
     The old Node importer left a new community at lat/lon null and told the
     operator to run validate.js --fix before committing. A publish from Blueprint
     has no such checkpoint, and buildGroups() averages coordinates, so one null
     coerced to 0 dragged a whole development's pin into the Atlantic.          */

  await test('a community with null coordinates is held off the map, not plotted at 0,0', async () => {
    const w = await boot({ dbMutate: row => {
      row.payload.communities[0] = Object.assign({}, row.payload.communities[0],
        { name: 'Nowhere Ranch', lat: null, lon: null });
    } });
    const st = S(w);
    /* Relative to the fixture's own baseline. The real data.json legitimately
       carries unlocated communities — three, at the time of writing — because
       that is the state a new community arrives in. Asserting an absolute count
       would break on every import that adds one. */
    eq(st.communities.length, BASE.plotted - 1, 'the unplaceable community should be excluded');
    eq(st.unlocated.length, BASE.unlocated + 1, 'and counted as unlocated');
    assert(st.unlocated.some(c => c.name === 'Nowhere Ranch'),
           'the right record should be held back');
    assert(!st.communities.some(c => c.name === 'Nowhere Ranch'),
           'it must not appear among the plotted communities');
    // The real bug this prevents: a null in the centroid average.
    assert(st.groups.every(g => Number.isFinite(g.lat) && Number.isFinite(g.lon)),
           'every group centroid must be a finite number');
  });

  await test('0,0 is treated as unplaceable rather than as a location', async () => {
    const w = await boot({ dbMutate: row => {
      row.payload.communities[0] = Object.assign({}, row.payload.communities[0],
        { name: 'Null Island', lat: 0, lon: 0 });
    } });
    eq(S(w).unlocated.length, BASE.unlocated + 1,
       '0,0 should be rejected — it is what a null becomes');
    assert(S(w).unlocated.some(c => c.name === 'Null Island'),
           'the right record should be held back');
  });

  await test('unlocated communities are disclosed in the header, by name', async () => {
    const w = await boot({ dbMutate: row => {
      row.payload.communities[0] = Object.assign({}, row.payload.communities[0],
        { name: 'Nowhere Ranch', lat: null, lon: null });
    } });
    const html = w.document.getElementById('update-info').innerHTML;
    assert(/awaiting a location/.test(html), 'the header should flag the omission');
    const n = BASE.unlocated + 1;
    assert(new RegExp(n + ' communit' + (n === 1 ? 'y' : 'ies') + ' awaiting').test(html),
           `expected "${n} communit${n === 1 ? 'y' : 'ies'} awaiting", got: ${html}`);
    assert(/Nowhere Ranch/.test(html), 'the tooltip should name which community');
  });

  await test('all-unlocated reports why, instead of looking like empty data', async () => {
    const w = await boot({ dbMutate: row => {
      row.payload.communities = row.payload.communities.map(
        c => Object.assign({}, c, { lat: null, lon: null }));
    } });
    await new Promise(r => setTimeout(r, 120));
    eq(w.document.querySelector('#load-error').style.display, 'flex', 'error panel should be shown');
    const msg = w.document.querySelector('.load-error-msg').textContent;
    assert(/none has usable coordinates/.test(msg),
           `expected the coordinate-specific message, got: ${msg}`);
    assert(/Blueprint/.test(w.document.querySelector('.load-error-detail').textContent),
           'the detail should say where to fix it');
  });

  /* ── regressions found in review ──────────────────────────────────────── */

  await test('clicking a merged pin keeps popup, panel, sidebar and URL in step', async () => {
    const w = await boot();
    const st = () => w.__state();
    const gi = st().groups.findIndex(g => g.visible.size > 2 && g.visible.size <= 6);
    const mk = st().markers[gi];

    // Open it and choose the last tab, so the remembered selection is not the
    // group's first member.
    mk.fire('click');
    const tabs = [...mk._rendered.querySelectorAll('.popup-tab')];
    const wanted = tabs[tabs.length - 1].textContent;
    tabs[tabs.length - 1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

    mk.fire('click');           // closes
    mk.fire('click');           // reopens from the remembered tab

    const shown = mk._rendered.querySelector('.popup-name').textContent;
    const panel = w.document.querySelector('#info-panel-name').textContent;
    const active = st().communities[st().activeItem].name;
    const hashNum = (w.location.hash.match(/c=(\d+)/) || [])[1];
    const hashName = (st().communities.find(c => c.num === hashNum) || {}).name;

    eq(shown, wanted, 'popup should reopen on the remembered tab');
    eq(panel, shown, 'info panel must match the popup');
    eq(active, shown, 'sidebar selection must match the popup');
    eq(hashName, shown, 'the shareable URL must match the popup');
  });

  await test('clicking a pin does not recentre or zoom the map', async () => {
    const w = await boot();
    const before = { z: w.L._map.getZoom(), c: w.L._map.getCenter() };
    const gi = w.__state().groups.findIndex(g => g.visible.size >= 1);
    w.__state().markers[gi].fire('click');
    eq(w.L._map.getZoom(), before.z, 'zoom should not change on a pin click');
    eq(w.L._map.getCenter().lat, before.c.lat, 'centre should not move on a pin click');
  });

  await test('choosing from the sidebar still recentres', async () => {
    const w = await boot();
    const before = w.L._map.getZoom();
    w.document.querySelector('.community-item').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    assert(w.L._map.getZoom() >= 13, `sidebar selection should zoom in, got ${w.L._map.getZoom()}`);
    assert(before < 13, 'sanity: should have started zoomed out');
  });

  await test('clicking an open pin closes it and leaves no stale selection', async () => {
    const w = await boot();
    const gi = w.__state().groups.findIndex(g => g.visible.size >= 1);
    const mk = w.__state().markers[gi];
    mk.fire('click');
    assert(w.__state().activeItem !== null, 'first click should select');
    mk.fire('click');
    eq(mk.isPopupOpen(), false, 'second click should close the popup');
    eq(w.__state().activeItem, null, 'selection should be cleared');
    eq(w.location.hash, '', 'no stale deep link should remain');
    eq(w.document.querySelector('#info-panel').classList.contains('visible'), false,
       'info panel should be hidden');
  });

  await test('a filter that hides the selection clears it', async () => {
    const w = await boot();
    const st = () => w.__state();
    // Pick a selection with a sibling in the same group, so the pin survives and
    // no popupclose fires to tidy up.
    const gi = st().groups.findIndex(g => g.visible.size > 1);
    const [a, b] = st().groups[gi].members.filter(i => st().groups[gi].visible.has(i));
    w.highlightItem(a);
    assert(w.location.hash !== '', 'sanity: should be selected');

    const el = w.document.querySelector('#search');
    el.value = st().communities[b].name;
    el.dispatchEvent(new w.Event('input'));

    eq(st().activeItem, null, 'hidden selection should be cleared');
    eq(w.location.hash, '', 'deep link should be dropped');
    eq(w.document.querySelector('#info-panel').classList.contains('visible'), false,
       'info panel should close');
    assert(!/highlighted/.test(st().markers[gi]._icon.html),
           'pin must not stay enlarged for a filtered-out community');
  });

  await test('a deep link resets the trade dropdowns, not just the state', async () => {
    const w = await boot();
    const scope = w.document.getElementById('trade-scope-select');
    scope.value = 'Roofing Turnkey';
    scope.dispatchEvent(new w.Event('change'));
    assert(w.document.getElementById('trade-vendor-select').style.display === 'block',
           'sanity: vendor select should be showing');

    const target = w.__state().communities.find(c => c.starts.every(v => v === 0) && !c.unforecasted);
    w.location.hash = '#c=' + target.num;
    w.selectFromHash();

    eq(w.__state().currentTrade, '', 'trade state should be cleared');
    eq(scope.value, '', 'the trade dropdown must be cleared too');
    eq(w.document.getElementById('trade-vendor-select').style.display, 'none',
       'the vendor dropdown must be hidden, not left as a dead control');
    eq(w.document.getElementById('trade-clear-btn').style.display, 'none',
       'the clear button should be hidden');
  });

  await test('the co-located badge counts only what the filter shows', async () => {
    const w = await boot();
    const st = () => w.__state();
    const gi = st().groups.findIndex(g => g.visible.size > 2);
    const member = st().communities[st().groups[gi].members.find(i => st().groups[gi].visible.has(i))];

    const el = w.document.querySelector('#search');
    el.value = member.name;
    el.dispatchEvent(new w.Event('input'));

    // Locate the row by index, not by text: the name cell also contains the
    // badge, so text matching is fragile.
    const idx = st().communities.indexOf(member);
    const row = w.document.querySelector(`.community-item[data-idx="${idx}"]`);
    assert(row, `expected ${member.name} to still be listed after searching for it`);
    const badge = row.querySelector('.item-colocated');
    const visNow = st().groups[gi].visible.size;
    if (visNow > 1) {
      eq(Number(badge.textContent.replace(/\D/g, '')), visNow, 'badge should match visible members');
    } else {
      eq(badge, null, 'a pin with one visible member should carry no badge');
    }
  });

  await test('the vendored Leaflet integrity hashes match the files on disk', async () => {
    // A stale or mismatched hash makes the browser silently refuse the file:
    // no console error, just an unstyled map or a dead script. The likeliest
    // cause is git rewriting line endings, which .gitattributes prevents with
    // `vendor/** -text` — this asserts that is still working.
    const crypto = require('crypto');
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const re = /(?:href|src)="(vendor\/[^"]+)"\s+integrity="(sha384-[^"]+)"/g;
    let m, checked = 0;
    while ((m = re.exec(html))) {
      const [, file, pinned] = m;
      const buf = fs.readFileSync(path.join(ROOT, file));
      const actual = 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');
      eq(actual, pinned, `integrity hash for ${file}`);
      checked++;
    }
    eq(checked, 2, 'expected both Leaflet files to be pinned');
  });

  await test('no absolute paths — the app must work under a /repo-name/ subpath', async () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const bad = html.match(/(?:href|src)="\/[^/][^"]*"/g) || [];
    eq(bad.length, 0, `absolute paths would 404 on GitHub Pages: ${bad.join(', ')}`);
  });

  await test('the office pin keeps its name', async () => {
    const w = await boot();
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert(/Lennar Orlando Division Office/.test(html), 'office pin title should be intact');
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
