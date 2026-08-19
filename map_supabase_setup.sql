-- ============================================================================
--  Community Map — Supabase schema + Row Level Security
--  Run this ONCE in Supabase Studio > SQL Editor. Safe to re-run: everything
--  uses IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY.
--
--  WHY THIS EXISTS
--  The map used to be two committed files, data.json and people.json, rebuilt by
--  tools/import-workbooks.js and pushed by hand. That worked, but it meant the
--  Starts Log and the RE2 export had to be imported here separately from the
--  Vendor Assignments app, which reads the same two workbooks. Moving the
--  document into Postgres lets one upload in Blueprint feed every app.
--
--  WHAT IS DELIBERATELY *NOT* CHANGED
--  The payload is the same document data.json always held — same keys, same
--  index-compressed `trades`, same everything — stored as one jsonb value. It is
--  not normalized into community/vendor/trade tables. Two reasons:
--    1. `tradeCats` and `vendors` are re-interned on every import, so their
--       indices are not stable between runs. Normalizing means rewriting the
--       compression on both sides; keeping the blob means the browser's existing
--       rehydration code (index.html loadData) keeps working untouched.
--    2. The map reads the whole document at once and never queries a subset, so
--       a relational schema would buy nothing at read time.
--  If a future feature needs to query across communities, add a generated view
--  over the jsonb rather than changing the write path.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Tables
-- ---------------------------------------------------------------------------

-- One row per division. The map is Orlando-only today, so there is exactly one
-- row (key='orlando'), but keying by division rather than using a singleton row
-- means adding Tampa later is an insert, not a migration.
--
-- The prev_* columns are the same one-deep rollback the Vendor Assignments app
-- uses on division_data, and they exist for the same reason: publishing replaces
-- the whole document, so there has to be a way back. This matters more here than
-- it did before, because the git history of data.json WAS the rollback mechanism
-- and moving into Postgres gives that up.
create table if not exists public.map_data (
  key               text primary key,          -- 'orlando'
  label             text,                      -- 'Orlando Division'
  payload           jsonb not null,            -- the data.json document
  people            jsonb not null default '{"people":{}}'::jsonb,  -- the people.json document
  updated_at        timestamptz default now(),
  updated_by        text,
  prev_payload      jsonb,
  prev_people       jsonb,
  prev_updated_at   timestamptz,
  prev_by           text
);

-- Publish/revert history. Mirrors the Vendor Assignments change_log so Blueprint
-- can report on both the same way.
create table if not exists public.map_change_log (
  id      uuid primary key default gen_random_uuid(),
  at      timestamptz default now(),
  key     text,
  actor   text,
  summary jsonb
);
create index if not exists map_change_log_at_idx on public.map_change_log(at desc);

-- ---------------------------------------------------------------------------
-- 1. Helper functions
--
--  These read public.app_roles — the Vendor Assignments role table — rather than
--  introducing a map_app_roles of their own. The map is built from the RE2 export
--  and the division Starts Logs, which is exactly the Vendor Assignments data
--  set, so the people allowed to publish one are the people allowed to publish
--  the other, and a second role table would be a second thing to keep in sync.
--
--  If the map ever needs its own editors, change map_can_write() only — nothing
--  else in this file references app_roles.
--
--  SECURITY DEFINER so they can read app_roles without tripping its own RLS.
-- ---------------------------------------------------------------------------

create or replace function public.map_domain() returns text
  language sql immutable as $$ select '@lennar.com'::text $$;

create or replace function public.map_email() returns text
  language sql stable as $$ select lower(auth.jwt() ->> 'email') $$;

create or replace function public.map_is_domain() returns boolean
  language sql stable as $$
    select coalesce(public.map_email() like ('%'||public.map_domain()), false)
$$;

create or replace function public.map_role() returns text
  language sql stable security definer set search_path = public as $$
    select coalesce(
      (select role from public.app_roles where lower(email)=public.map_email()),
      'viewer')
$$;

create or replace function public.map_can_write() returns boolean
  language sql stable as $$
    select public.map_is_domain()
       and public.map_role() in ('admin','editor')
$$;

-- ---------------------------------------------------------------------------
-- 2. Enable RLS, and take anon's table privileges away
--
--  This database is shared with Vendor Assignments, Takeoff Flow, Community-DB
--  and Blueprint, and they all publish the same anon key. The map is the only
--  one of the five with no sign-in, so it is the one that has to be most careful:
--  whatever `anon` can reach here, anyone on the internet can reach.
--
--  So `anon` gets no privileges on these tables at all — not "RLS will sort it
--  out", but refused before a policy is even evaluated. Public read is served
--  through a narrow view instead (section 3). This matches how Blueprint's
--  hub_apps is set up, deliberately.
-- ---------------------------------------------------------------------------
alter table public.map_data       enable row level security;
alter table public.map_change_log enable row level security;

revoke all on public.map_data       from anon;
revoke all on public.map_change_log from anon;
grant select, insert, update on public.map_data       to authenticated;
grant select, insert         on public.map_change_log to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The public view — the only thing anon can see anywhere in this database
--
--  The map has no sign-in and never has: it is a static page, and its data was
--  until now two world-readable files on GitHub Pages. Public read is therefore
--  the status quo, not a loosening. But "the same as before" should mean exactly
--  that, and the table holds three things the files never exposed:
--
--    prev_payload  — a second full copy of the document, doubling what is
--                    reachable for no benefit to a visitor
--    prev_people   — likewise
--    updated_by    — a staff email address. The site has no reason to publish
--                    who ran the last import, and anonymous visitors certainly
--                    have no reason to read it.
--
--  The view exposes the four columns the page actually renders, and nothing else.
--
--  security_invoker = false is what makes this work: the view runs as its owner,
--  so it can read map_data even though anon cannot. It is the security boundary,
--  which is why it is stated explicitly rather than left to the server default —
--  flipping it to true would make the view return zero rows and the map would
--  quietly fall back to its committed copy forever.
--
--  `people` is included because people.json is already served publicly today and
--  removing it would be a change in behaviour, not a fix. It is names, work
--  phone numbers and work email addresses of construction managers. If that
--  should stop being public, drop `people` from this view and gate contacts
--  behind a signed-in fetch — the site already degrades cleanly when contacts are
--  unavailable, which is why they were split into their own file to begin with.
-- ---------------------------------------------------------------------------

drop view if exists public.map_public;
create view public.map_public
  with (security_invoker = false) as
  select key, label, payload, people, updated_at
    from public.map_data;

revoke all on public.map_public from anon, authenticated;
grant select on public.map_public to anon, authenticated;

comment on view public.map_public is
  'Read-only public projection of map_data for the unauthenticated Community Map. '
  'Deliberately omits prev_payload, prev_people, prev_updated_at and updated_by. '
  'This view is the only object in this database readable by anon.';

-- ---------------------------------------------------------------------------
-- 4. Policies on the base table (signed-in staff only)
-- ---------------------------------------------------------------------------

drop policy if exists map_data_sel on public.map_data;
create policy map_data_sel on public.map_data
  for select to authenticated
  using (public.map_is_domain());

drop policy if exists map_data_ins on public.map_data;
create policy map_data_ins on public.map_data
  for insert to authenticated
  with check (public.map_can_write());

drop policy if exists map_data_upd on public.map_data;
create policy map_data_upd on public.map_data
  for update to authenticated
  using (public.map_can_write())
  with check (public.map_can_write());

-- No delete policy: publishing replaces a row, reverting swaps it back. There is
-- no workflow that removes a division, so the capability is simply absent.

-- The log is readable by signed-in staff only. The map itself never displays it,
-- and "who published what when" is internal.
drop policy if exists map_log_sel on public.map_change_log;
create policy map_log_sel on public.map_change_log
  for select to authenticated
  using (public.map_is_domain());

drop policy if exists map_log_ins on public.map_change_log;
create policy map_log_ins on public.map_change_log
  for insert to authenticated
  with check (public.map_can_write());

-- ---------------------------------------------------------------------------
-- 5. Verify — the map is closed, and nothing else in the database is open
--
--  Two separate questions, and the second is the one that matters most.
--
--  The map is the only app here without a sign-in, so adding it to this shared
--  database is the moment to check what an unauthenticated caller can actually
--  reach. Every app publishes the same anon key in a public repo, so "the key is
--  secret" was never the protection — RLS and table grants are.
--
--  Assert rather than trust. If a later edit drops a policy or hands anon a
--  privilege, the next run of this file fails here instead of leaving it to be
--  discovered by someone else.
-- ---------------------------------------------------------------------------
do $$
declare
  v_rls     boolean;
  v_anon    int;
  v_pol     int;
  r         record;
  v_leaks   text := '';
  v_norls   text := '';
  v_public  text := '';
begin
  -- ---- the map's own posture -------------------------------------------
  select relrowsecurity into v_rls from pg_class where oid = 'public.map_data'::regclass;
  if not coalesce(v_rls, false) then
    raise exception 'SECURITY: row level security is NOT enabled on public.map_data';
  end if;

  select count(*) into v_anon from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'map_data' and grantee = 'anon';
  if v_anon > 0 then
    raise exception 'SECURITY: anon holds % privileges on public.map_data — it must reach the data only through map_public', v_anon;
  end if;

  select count(*) into v_anon from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'map_change_log' and grantee = 'anon';
  if v_anon > 0 then
    raise exception 'SECURITY: anon holds % privileges on public.map_change_log', v_anon;
  end if;

  select count(*) into v_pol from pg_policies
   where schemaname = 'public' and tablename = 'map_data';
  if v_pol < 3 then
    raise exception 'SECURITY: map_data has only % policies; expected select/insert/update', v_pol;
  end if;

  -- The view must exist and must be the definer-rights kind, or the map reads
  -- nothing and silently serves its offline copy forever.
  if not exists (select 1 from pg_views where schemaname = 'public' and viewname = 'map_public') then
    raise exception 'SECURITY: public.map_public is missing — the map would have no readable source';
  end if;
  if exists (
    select 1 from pg_class c
     where c.oid = 'public.map_public'::regclass
       and coalesce(array_to_string(c.reloptions, ','), '') like '%security_invoker=true%'
  ) then
    raise exception 'map_public has security_invoker=true, so it cannot read map_data as anon — the map would always fall back';
  end if;

  -- ---- the rest of the shared database ---------------------------------
  -- Every table anon can reach, and every table with RLS switched off. Neither
  -- should have anything in it but the map's own view.
  for r in
    select t.tablename
      from pg_tables t
     where t.schemaname = 'public'
       and exists (
         select 1 from information_schema.role_table_grants g
          where g.table_schema = 'public' and g.table_name = t.tablename and g.grantee = 'anon')
     order by t.tablename
  loop
    v_leaks := v_leaks || '  · ' || r.tablename || E'\n';
  end loop;

  for r in
    select c.relname as tablename
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
     order by c.relname
  loop
    v_norls := v_norls || '  · ' || r.tablename || E'\n';
  end loop;

  -- A policy with no TO clause applies to PUBLIC, which includes anon. Several
  -- of these are safe in practice because their USING expression evaluates false
  -- without a JWT — but that is the expression saving them, not the role scoping,
  -- and it is worth knowing which ones are relying on it.
  for r in
    select tablename, policyname
      from pg_policies
     where schemaname = 'public'
       and (roles is null or roles = '{public}')
     order by tablename, policyname
  loop
    v_public := v_public || '  · ' || r.tablename || '.' || r.policyname || E'\n';
  end loop;

  if v_norls <> '' then
    raise warning E'TABLES WITH RLS DISABLED — anon can read these if it holds any grant:\n%', v_norls;
  end if;
  if v_leaks <> '' then
    raise warning E'TABLES anon HOLDS PRIVILEGES ON — check each one is intended:\n%', v_leaks;
  end if;
  if v_public <> '' then
    raise warning E'POLICIES SCOPED TO PUBLIC (includes anon) — safe only if their USING clause rejects a null JWT:\n%', v_public;
  end if;

  raise notice 'Community Map: RLS on, % policies, anon reaches map_public only.', v_pol;
  raise notice 'Review any warnings above before treating the shared database as closed.';
end $$;

-- ---------------------------------------------------------------------------
-- 6. Seeding
--
--  Load the current committed documents into the table before pointing the site
--  at it, so the first read returns real data:
--
--      node tools/seed-supabase.js --url <SUPABASE_URL> --key <SERVICE_OR_ANON>
--
--  That script reads data.json and people.json from the repo and upserts them as
--  key='orlando'. It leaves the files in place; index.html falls back to them if
--  the database is unreachable, so they stay useful as an offline copy.
-- ---------------------------------------------------------------------------
