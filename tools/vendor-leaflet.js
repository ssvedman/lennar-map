#!/usr/bin/env node
/**
 * vendor-leaflet.js — download Leaflet into vendor/ and print the <link> and
 * <script> tags with integrity hashes to paste into index.html.
 *
 *   node tools/vendor-leaflet.js [version]
 *
 * Only needed when changing version. Commit vendor/ afterwards.
 */

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = process.argv[2] || '1.9.4';

/* The version is a command-line string that becomes a directory name, so it can
   contain "..", and path.join would happily walk out of vendor/ and start
   writing files wherever it landed. Resolve, then confirm the result is still
   inside. A bare startsWith on the base is not that check — it compares
   characters, not directory boundaries, so a sibling whose name merely begins
   with "vendor" would satisfy it. Requiring either an exact match or a real
   separator after the base restores the boundary. Same idiom as blueprint-dev's
   serve.js, for the same reason. */
const VENDOR = path.resolve(__dirname, '..', 'vendor');
const OUT = path.resolve(VENDOR, `leaflet-${VERSION}`);
if (OUT !== VENDOR && !OUT.startsWith(VENDOR + path.sep)) {
  console.error(`version "${VERSION}" resolves to ${OUT}, which is outside vendor/`);
  process.exit(2);
}

const FILES = ['leaflet.css', 'leaflet.js'];

/* TWO INDEPENDENT CDNs, AND THEY HAVE TO AGREE ────────────────────────────────
   An SRI hash computed from a single download attests to nothing except that
   the bytes were transferred without corruption. It is a fingerprint of
   whatever arrived — if the one source served something tampered with, this
   tool faithfully hashes the tampered file, prints the hash with every
   appearance of diligence, and the page then enforces the compromise on every
   visitor forever.

   The hash only becomes evidence when something independent vouches for the
   bytes. unpkg and jsdelivr both serve npm, but from different infrastructure
   and different operators, so agreement between them means the artifact would
   have had to be replaced in the registry itself or in both CDNs at once.
   That is not proof; it is a very great deal more than one fetch.

   One source answering is therefore not a degraded success, it is a failure:
   a source cannot corroborate itself. Nothing is written in that case. */
const SOURCES = [
  { name: 'unpkg',    at: f => `https://unpkg.com/leaflet@${VERSION}/dist/${f}` },
  { name: 'jsdelivr', at: f => `https://cdn.jsdelivr.net/npm/leaflet@${VERSION}/dist/${f}` }
];

// Leaflet's CSS references these by relative path; without them the zoom
// controls and marker shadows silently disappear.
const ASSETS = [
  'images/layers.png', 'images/layers-2x.png',
  'images/marker-icon.png', 'images/marker-icon-2x.png', 'images/marker-shadow.png'
];

const sri = buf => 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Every source is asked, and every answer has to be the same bytes. Throws
// otherwise — including when a source is merely unreachable, since a file only
// one CDN would show us is a file nothing corroborates.
async function corroborated(file) {
  const got = [], missing = [];
  for (const s of SOURCES) {
    try { got.push({ from: s.name, buf: await get(s.at(file)) }); }
    catch (e) { missing.push(`${s.name} (${e.message})`); }
  }
  if (got.length !== SOURCES.length) {
    throw new Error(`${file}: only ${got.length} of ${SOURCES.length} sources answered — `
      + `could not reach ${missing.join(', ')}. A single source cannot corroborate itself.`);
  }
  for (const other of got.slice(1)) {
    if (!other.buf.equals(got[0].buf)) {
      throw new Error(`${file}: ${got[0].from} and ${other.from} served DIFFERENT bytes `
        + `(${got[0].buf.length} vs ${other.buf.length}). One of them is not serving `
        + `leaflet@${VERSION}. Do not hash either until you know which.`);
    }
  }
  return got[0].buf;
}

(async () => {
  if (typeof fetch !== 'function') {
    console.error('needs Node 18+ for global fetch');
    process.exit(2);
  }

  const agree = SOURCES.map(s => s.name).join(' + ');
  const hashes = {};

  /* Fetched and corroborated in full BEFORE anything touches the disk, so a
     disagreement or an unreachable CDN leaves the existing vendor/ directory
     exactly as it was rather than half-replaced with unverified files. */
  const bytes = {};
  for (const f of FILES) {
    bytes[f] = await corroborated(f);
    console.error(`  ${f.padEnd(12)} ${(bytes[f].length / 1024).toFixed(1)} KB  (${agree} agree)`);
  }

  fs.mkdirSync(path.join(OUT, 'images'), { recursive: true });

  for (const f of FILES) {
    fs.writeFileSync(path.join(OUT, f), bytes[f]);
    hashes[f] = sri(bytes[f]);
  }

  // The images carry no integrity attribute — the CSS references them by
  // relative path and the browser has nothing to check them against — but they
  // are held to the same two-source rule anyway, because "unverifiable" is a
  // reason to be more careful about the source, not less. A missing one costs
  // a control icon, so it warns rather than aborting.
  for (const a of ASSETS) {
    try {
      fs.writeFileSync(path.join(OUT, a), await corroborated(a));
    } catch (e) {
      console.error(`  ! ${a}: ${e.message}`);
    }
  }

  const base = `vendor/leaflet-${VERSION}`;
  // No crossorigin attribute: SRI only needs it for cross-origin resources, and
  // these are served from the same origin as the page.
  console.log(`
Downloaded to ${base}/, ${agree} agreeing byte for byte. Replace the Leaflet
block in index.html <head> with:

<link rel="stylesheet" href="${base}/leaflet.css"
      integrity="${hashes['leaflet.css']}"/>
<script src="${base}/leaflet.js"
        integrity="${hashes['leaflet.js']}"></script>

Then commit ${base}/ and drop any CDN fallback script.
`);
})().catch(e => {
  // Reached before any write in every case that matters, so saying so is not a
  // guess — and it is the thing the reader needs to know before deciding
  // whether to re-run or to go and look at what the two CDNs are serving.
  console.error(`  ${e.message}`);
  console.error('  Nothing was written; vendor/ is unchanged.');
  /* exitCode rather than exit(): a refusal here always has a fetch still
     unwound behind it, and tearing the process down on top of one aborts Node
     itself on Windows — an assertion failure and exit 127 printed underneath a
     message that had already said the right thing. Node leaves once the sockets
     have closed, with the code we asked for. */
  process.exitCode = 1;
});
