# Community Map

Public map of new-home communities in a residential homebuilding division — location,
utilities, scheduled starts, construction managers, and the trade partner covering each
scope. Mainly so trade partners can look a community up themselves.

Static site on GitHub Pages. No build step.

```
index.html      the application
data.json       offline fallback copy of the community document
people.json     offline fallback copy of the contacts
vendor/         Leaflet
tools/          import, validation, seeding, tests
map_supabase_setup.sql   schema + row-level security for the map_data table
```

## Where the data comes from

The document lives in Supabase, in the `map_data` table, and the page reads it with a
plain PostgREST `GET` — no client library. It moved there so that one upload in Blueprint
can update this map and the Vendor Assignments app together: both are built from the same
RE2 export and the same division Starts Logs, and importing them twice was how the two
ended up disagreeing about which communities exist.

`data.json` and `people.json` are still in the repo, and are still read — as the fallback
when the database cannot be reached. That is deliberate. The map has no sign-in and no
error a viewer can do anything about, so a stale map beats a blank one. When the fallback
is in use the header says *showing the offline copy*.

## What an anonymous visitor can reach

This database is shared with Vendor Assignments, Takeoff Flow, Community-DB and Blueprint,
and all five apps publish the same Supabase anon key in public repos. The key is not a
secret and nothing is protected by hiding it. What protects the data is that `anon` holds
**no privileges on any table**.

This map is the only one of the five with no sign-in, so it is the only thing an
unauthenticated caller can read anything through — and it reads a view, not a table:

```
map_public   key, label, payload, people, updated_at      ← anon can select this
map_data     everything above plus prev_payload,          ← anon has no grant at all
             prev_people, prev_updated_at, updated_by
```

The view deliberately omits the rollback copies, which would double what is reachable for
no benefit, and `updated_by`, which is a staff email address. Writes require an `admin` or
`editor` row in `app_roles` — see `map_can_write()`.

Running `map_supabase_setup.sql` asserts all of this and additionally audits the whole
database, warning about any table with RLS disabled, any table `anon` holds a grant on, and
any policy scoped to `PUBLIC` rather than to `authenticated`. Re-run it after any schema
change; it is safe to run repeatedly.

Note that `people` — construction manager names, work phones and work emails — is public,
because `people.json` is already served publicly today. To stop that, drop `people` from
the view: the site already degrades cleanly when contacts are missing, which is why they
live in their own file.

## Publishing

Normally: Blueprint → Data Intake. Drop the workbooks, review the preview, publish.

The Node path still works and is the fallback if Blueprint is unavailable:

```
node tools/import-workbooks.js --re2 RE2.xlsx --starts StartSchedule.xlsx \
                               --contacts "Construction Community Contact.xlsx"
node tools/validate.js --fix          # geocode drift check
node tools/seed-supabase.js --key <SERVICE_ROLE_KEY>
```

The importer and validator write `data.json`/`people.json` exactly as they always have;
`seed-supabase.js` pushes those files into `map_data`. Commit the files too, so the
fallback copy does not drift from what is published.

## Communities with no coordinates

A newly imported community arrives with no address and no `lat`/`lon`. Those records are
held off the map rather than plotted, and the header reports how many are waiting — an
unplaceable record used to coerce to `0,0` and drag its whole development's pin into the
Atlantic. Set the coordinates in Blueprint, or fill in the address and run
`tools/validate.js --fix`.

## Tests

```
npm install --no-save jsdom xlsx    # two suites skip cleanly without these
node tools/test/run-all.js
```
