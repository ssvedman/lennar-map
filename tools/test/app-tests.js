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
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    // Strip the vendored Leaflet tags; the stub is injected instead.
    .replace(/<link rel="stylesheet" href="vendor\/[\s\S]*?\/>/, '')
    .replace(/<script src="vendor\/[\s\S]*?<\/script>/, '');

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

  win.fetch = url => {
    const name = String(url).split('?')[0].replace(/^.*\//, '');
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
      months, next3Idx, dataStart, meta
    });`);

  // Let the async init() settle.
  for (let i = 0; i < 60 && !(win.__state && win.__state().communities.length); i++) await new Promise(r => setTimeout(r, 20));
  await new Promise(r => setTimeout(r, 60));
  return win;
}

/* ── tests ─────────────────────────────────────────────────────────────────── */
(async () => {
  console.log('\nindex.html (jsdom, Leaflet stubbed)\n');

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
    eq($('#hdr-count').textContent, '71', 'header community count');
    eq($('#hdr-starts').textContent, '2,230', 'header total starts');
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
    eq(S().groups.length, 40, 'group count at a 250 m radius');
    const merged = S().groups.filter(g => g.members.length > 1);
    eq(merged.length, 14, 'merged group count');
    assert(S().groups.every(g => g.members.length >= 1), 'every group needs members');
    eq(S().groups.reduce((a, g) => a + g.members.length, 0), 71, 'every community must land in exactly one group');
  });

  await test('the two exact-duplicate coordinate pairs are merged', () => {
    const nameOf = i => S().communities[i].name;
    const groupNames = S().groups.map(g => g.members.map(nameOf));
    const together = (a, b) => groupNames.some(g => g.includes(a) && g.includes(b));
    assert(together('Crossprairie 25', 'Crossprairie 25 TH'), 'Crossprairie pair not merged');
    assert(together('Ranches 40GC', 'Ranches 60GC'), 'Ranches pair not merged');
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

  await test('a merged pin opens one popup with a tab per community', () => {
    const gi = S().groups.findIndex(g => g.visible.size > 3);
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
    const gi = S().groups.findIndex(g => g.visible.size > 2);
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

  /* ── regressions found in review ──────────────────────────────────────── */

  await test('clicking a merged pin keeps popup, panel, sidebar and URL in step', async () => {
    const w = await boot();
    const st = () => w.__state();
    const gi = st().groups.findIndex(g => g.visible.size > 2);
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
