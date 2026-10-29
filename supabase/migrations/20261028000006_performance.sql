-- =====================================================================
-- OHS Hub — Migration 6: performance tuning (Supabase advisor fixes)
-- 1. Wrap auth.uid() in policies as (select auth.uid()) so Postgres
--    evaluates it once per query instead of once per row.
-- 2. Index foreign keys between OHS tables (excluding auth.users links).
-- =====================================================================

do $$
declare
  p record;
  v_using text;
  v_check text;
  v_sql text;
begin
  for p in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname in ('public', 'storage')
      and (qual ~ 'auth\.uid\(\)' or with_check ~ 'auth\.uid\(\)')
  loop
    v_using := regexp_replace(p.qual, '(\(\s*select\s+)?auth\.uid\(\)', '(select auth.uid())', 'g');
    v_check := regexp_replace(p.with_check, '(\(\s*select\s+)?auth\.uid\(\)', '(select auth.uid())', 'g');
    -- avoid double wrapping if a policy already used (select auth.uid())
    v_using := replace(v_using, '(select auth.uid()) AS uid)', '(select auth.uid())');
    v_check := replace(v_check, '(select auth.uid()) AS uid)', '(select auth.uid())');
    v_sql := format('alter policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
    if v_using is not null then v_sql := v_sql || format(' using (%s)', v_using); end if;
    if v_check is not null then v_sql := v_sql || format(' with check (%s)', v_check); end if;
    execute v_sql;
  end loop;
end $$;

do $$
declare
  fk record;
begin
  for fk in
    select c.conrelid::regclass as tbl, a.attname as col, c.conrelid, c.conkey
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where c.contype = 'f' and n.nspname = 'public' and array_length(c.conkey, 1) = 1
      and c.confrelid <> 'auth.users'::regclass
      and not exists (
        select 1 from pg_index i
        where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])
  loop
    execute format('create index if not exists %I on %s (%I)',
                   left(replace(fk.tbl::text, 'public.', '') || '_' || fk.col || '_fk_idx', 63), fk.tbl, fk.col);
  end loop;
end $$;
