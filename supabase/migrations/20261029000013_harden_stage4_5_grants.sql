-- =====================================================================
-- OHS Hub — Migration 13: tighten function permissions added in Stages 4–5
--   * trigger functions can't be called through the API by anyone
--   * app RPCs can't be called by signed-out visitors
--   * future functions are not executable by PUBLIC/anon by default
--   * month_start gets a fixed search_path
-- =====================================================================

alter function public.month_start(timestamptz) set search_path = public;

do $$
declare f record;
begin
  -- Trigger functions: only the database calls these.
  for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prorettype = 'trigger'::regtype loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
  -- Everything else: never callable while signed out. Functions that were
  -- open to PUBLIC keep exactly the same access for signed-in users.
  for f in select p.oid::regprocedure sig,
                  (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')) open_to_public
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prorettype <> 'trigger'::regtype and p.prokind = 'f' loop
    if f.open_to_public then execute format('grant execute on function %s to authenticated', f.sig); end if;
    execute format('revoke execute on function %s from public, anon', f.sig);
  end loop;
end $$;

alter default privileges in schema public revoke execute on functions from public, anon;
