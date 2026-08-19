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

  /* ============================== PARSERS ==================================
     Each takes rows already extracted from a workbook — never a workbook — so
     this file never touches SheetJS and the caller decides how sheets are read.
     `find` is the collector: { notes: [], problems: [] }.
     ======================================================================== */

  /* Starts. Two layouts are seen in the wild; both are handled, matching
     buildDivision() in the Vendor Assignments app. */
  function parseStarts(rows, sheetName, find) {
    const records = [], idName = {};
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

      if (!community || !date) { skipped++; continue; }
      const id = normCommunityId(job);
      if (id) idName[id] = community;
      records.push({ id, community, date, kind });
    }

    find.notes.push(`starts: sheet "${sheetName}", ${rows.length} rows → ${records.length} start records`
      + (skipped ? `, ${skipped} skipped (no community or no date)` : ""));
    if (!records.length) {
      find.problems.push("the starts workbook produced no usable rows — wrong file, or the columns have been renamed");
    }
    return { records, idName };
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
    const find = { notes: input.notes || [], problems: input.problems || [] };
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
      for (const n of contacts.acmNames) {
        if (!acmByName.has(n)) {
          find.problems.push(`the contact sheet names an area manager we have no details for: "${n}"`
            + " — add them to people.json (name, phone, email) and re-run");
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
    parseStarts, aggregateStarts, parseRE2, parseContacts,
    currentDataStart, buildDocument, diffDocument
  };
});
