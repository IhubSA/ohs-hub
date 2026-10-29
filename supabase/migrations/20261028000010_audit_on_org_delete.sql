-- =====================================================================
-- OHS Hub — Migration 10: allow organisations to be deleted
-- When an organisation is deleted its records cascade; the audit trigger
-- must not try to log those deletions against an organisation that no
-- longer exists (its audit log is removed with it).
-- =====================================================================
create or replace function public.tg_audit_row()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_id uuid;
  v_changes jsonb;
begin
  if tg_op = 'DELETE' then
    v_org := (to_jsonb(old)->>'org_id')::uuid;
    v_id  := (to_jsonb(old)->>'id')::uuid;
    v_changes := null;
  else
    v_org := (to_jsonb(new)->>'org_id')::uuid;
    v_id  := (to_jsonb(new)->>'id')::uuid;
    if tg_op = 'UPDATE' then
      select jsonb_object_agg(n.key, n.value) into v_changes
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o using (key)
      where n.value is distinct from o.value and n.key not in ('updated_at');
      if v_changes is null then return new; end if;
    end if;
  end if;
  if tg_table_name = 'organisations' then v_org := v_id; end if;
  -- Organisation is being deleted: nothing to attach the entry to.
  if tg_op = 'DELETE' and v_org is not null
     and not exists (select 1 from public.organisations where id = v_org) then
    return old;
  end if;
  if tg_table_name = 'organisations' and tg_op = 'DELETE' then
    return old;
  end if;
  insert into public.audit_logs (org_id, actor_id, action, table_name, record_id, changes)
  values (v_org, auth.uid(), tg_op, tg_table_name, v_id, v_changes);
  return coalesce(new, old);
end $$;
