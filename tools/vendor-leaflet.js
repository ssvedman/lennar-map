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
const OUT = path.join(__dirname, '..', 'vendor', `leaflet-${VERSION}`);

const FILES = [
  { url: `https://unpkg.com/leaflet@${VERSION}/dist/leaflet.css`, name: 'leaflet.css' },
  { url: `https://unpkg.com/leaflet@${VERSION}/dist/leaflet.js`,  name: 'leaflet.js'  }
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

(async () => {
  if (typeof fetch !== 'function') {
    console.error('needs Node 18+ for global fetch');
    process.exit(2);
  }

  fs.mkdirSync(path.join(OUT, 'images'), { recursive: true });
  const hashes = {};

  for (const f of FILES) {
    const buf = await get(f.url);
    fs.writeFileSync(path.join(OUT, f.name), buf);
    hashes[f.name] = sri(buf);
    console.error(`  ${f.name.padEnd(12)} ${(buf.length / 1024).toFixed(1)} KB`);
  }

  for (const a of ASSETS) {
    try {
      const buf = await get(`https://unpkg.com/leaflet@${VERSION}/dist/${a}`);
      fs.writeFileSync(path.join(OUT, a), buf);
    } catch (e) {
      console.error(`  ! ${a}: ${e.message}`);
    }
  }

  const base = `vendor/leaflet-${VERSION}`;
  // No crossorigin attribute: SRI only needs it for cross-origin resources, and
  // these are served from the same origin as the page.
  console.log(`
Downloaded to ${base}/. Replace the Leaflet block in index.html <head> with:

<link rel="stylesheet" href="${base}/leaflet.css"
      integrity="${hashes['leaflet.css']}"/>
<script src="${base}/leaflet.js"
        integrity="${hashes['leaflet.js']}"></script>

Then commit ${base}/ and drop any CDN fallback script.
`);
})().catch(e => { console.error(e.message); process.exit(1); });
