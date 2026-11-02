-- =====================================================================
-- OHS Hub — Migration 15: new plan structure (Free, SMME, Business,
-- Enterprise, Principal Contractor) and the limits that go with it
--   * contractor and storage limits, enforced by the database
--   * extra-user price and public pricing settings (VAT display)
--   * Free (one user) never requires independent approval
--   * sign-ups can start on Free, or on a trial of the plan they chose
--   * trials that end drop to the Free plan instead of locking people out
--   * risk register, reports and contractors follow the plan's modules
-- Prices and limits stay editable in Platform admin > Plans.
-- =====================================================================

alter table public.subscription_plans
  add column if not exists max_contractors integer check (max_contractors >= 0),
  add column if not exists price_extra_user_zar numeric(10,2) check (price_extra_user_zar >= 0);
alter table public.organisation_subscriptions
  add column if not exists override_max_contractors integer;

create or replace function public.org_limit(p_org uuid, p_key text)
returns integer language sql stable security definer set search_path = public as $$
  select case p_key
    when 'users' then coalesce(s.override_max_users, p.max_users)
    when 'sites' then coalesce(s.override_max_sites, p.max_sites)
    when 'ai_generations' then coalesce(s.override_ai_generations, p.ai_generations_per_month)
    when 'storage_mb' then coalesce(s.override_storage_mb, p.storage_mb)
    when 'contractors' then coalesce(s.override_max_contractors, p.max_contractors)
  end
  from public.organisation_subscriptions s
  join public.subscription_plans p on p.id = s.plan_id
  where s.org_id = p_org;
$$;

-- ---------------------------------------------------------------------
-- The plans. Existing rows are renamed so current subscriptions keep a
-- valid plan; Ihub-SA moves to the top plan.
-- ---------------------------------------------------------------------
update public.subscription_plans set is_default_trial = false;
update public.subscription_plans set code = 'free', name = 'Free', tagline = 'For one person getting the safety basics in place.',
  price_monthly_zar = 0, price_annual_zar = 0, price_extra_user_zar = null, max_users = 1, max_sites = 1, max_contractors = 0,
  ai_generations_per_month = 2, storage_mb = 100, trial_days = 0, sort_order = 1, is_public = true, is_active = true,
  features = '{"ai":true,"incidents":true,"investigations":true,"actions":true,"inspections":true,"risk_assessments":true,"documents":true,"emergency":true}',
  feature_list = array['Incident reporting and investigation','Corrective actions','Checklists and inspections','Risk assessments','SOPs and documents','Emergency numbers and drills']
where code = 'starter';
update public.subscription_plans set code = 'smme', name = 'SMME', tagline = 'For small teams running their safety system together.',
  price_monthly_zar = 299, price_annual_zar = 2990, price_extra_user_zar = 79, max_users = 4, max_sites = 1, max_contractors = 0,
  ai_generations_per_month = 5, storage_mb = 1024, trial_days = 14, sort_order = 2, is_public = true, is_active = true,
  features = '{"ai":true,"incidents":true,"investigations":true,"actions":true,"inspections":true,"risk_assessments":true,"documents":true,"emergency":true,"approvals":true,"risk_register":true,"reports":true}',
  feature_list = array['Everything in Free','Up to 4 users','Independent document approval','Risk register','Monthly and quarterly reports','5 AI drafts a month']
where code = 'professional';
update public.subscription_plans set name = 'Business', tagline = 'For growing businesses with training and equipment to manage.',
  price_monthly_zar = 899, price_annual_zar = 8990, price_extra_user_zar = 79, max_users = 10, max_sites = 3, max_contractors = 0,
  ai_generations_per_month = 20, storage_mb = 5120, trial_days = 14, sort_order = 3, is_public = true, is_active = true,
  features = '{"ai":true,"incidents":true,"investigations":true,"actions":true,"inspections":true,"risk_assessments":true,"documents":true,"emergency":true,"approvals":true,"risk_register":true,"reports":true,"training":true,"equipment":true,"multi_site":true}',
  feature_list = array['Everything in SMME','Up to 10 users and 3 sites','Training matrix and competency','Equipment and PPE registers','20 AI drafts a month']
where code = 'business';
update public.subscription_plans set name = 'Enterprise', tagline = 'For multi-site organisations with legal and contractor obligations.',
  price_monthly_zar = 1999, price_annual_zar = 19990, price_extra_user_zar = 79, max_users = 25, max_sites = 10, max_contractors = 15,
  ai_generations_per_month = 50, storage_mb = 20480, trial_days = 14, sort_order = 4, is_public = true, is_active = true,
  features = '{"ai":true,"incidents":true,"investigations":true,"actions":true,"inspections":true,"risk_assessments":true,"documents":true,"emergency":true,"approvals":true,"risk_register":true,"reports":true,"training":true,"equipment":true,"multi_site":true,"legal":true,"contractors":true}',
  feature_list = array['Everything in Business','Up to 25 users and 10 sites','Legal register with verification','Contractor management (up to 15 contractors)','50 AI drafts a month']
where code = 'enterprise';
insert into public.subscription_plans (code, name, tagline, price_monthly_zar, price_annual_zar, price_extra_user_zar, max_users, max_sites, max_contractors,
  ai_generations_per_month, storage_mb, trial_days, sort_order, is_public, is_active, features, feature_list)
values ('principal_contractor', 'Principal Contractor', 'For principal contractors managing many subcontractors across sites.',
  3999, 39990, 79, 50, null, null, 150, 51200, 14, 5, true, true,
  '{"ai":true,"incidents":true,"investigations":true,"actions":true,"inspections":true,"risk_assessments":true,"documents":true,"emergency":true,"approvals":true,"risk_register":true,"reports":true,"training":true,"equipment":true,"multi_site":true,"legal":true,"contractors":true,"enterprise_admin":true,"priority_support":true}',
  array['Everything in Enterprise','Up to 50 users and unlimited sites','Unlimited contractors','150 AI drafts a month','Priority support'])
on conflict (code) do nothing;
update public.subscription_plans set is_default_trial = true where code = 'business';
-- Ihub-SA (iHubSA's own organisation) stays on the top plan
update public.organisation_subscriptions set plan_id = (select id from public.subscription_plans where code = 'principal_contractor')
where org_id in (select id from public.organisations where name = 'Ihub-SA');

-- Public pricing settings (read by the pricing page; changed in Platform admin)
insert into public.platform_settings (key, value) values ('pricing', '{"vat":"none","annual_note":"2 months free"}')
on conflict (key) do nothing;
create policy platform_settings_pricing_read on public.platform_settings for select to anon, authenticated using (key = 'pricing');
grant select on public.platform_settings to anon;

-- ---------------------------------------------------------------------
-- One-user plans can't have an independent approver
-- ---------------------------------------------------------------------
create or replace function public.org_requires_independent(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((o.settings->>'require_independent_approval')::boolean, true)
     and coalesce(public.org_limit(o.id, 'users'), 2) > 1
  from public.organisations o where o.id = p_org;
$$;

-- ---------------------------------------------------------------------
-- New organisations: Free if the person chose Free, otherwise a trial of
-- the plan they chose (or the default trial plan)
-- ---------------------------------------------------------------------
create or replace function public.create_organisation(
  p_name text, p_industry text default 'general', p_registration_number text default null,
  p_province text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org  uuid;
  v_plan record;
  v_req  text;
begin
  if auth.uid() is null then
    raise exception 'Sign in to create an organisation' using errcode = '42501';
  end if;
  insert into public.organisations (name, industry, registration_number, province, created_by)
  values (trim(p_name), p_industry, nullif(trim(p_registration_number), ''), p_province, auth.uid())
  returning id into v_org;

  select raw_user_meta_data->>'requested_plan' into v_req from auth.users where id = auth.uid();
  select * into v_plan from public.subscription_plans where code = v_req and is_active and is_public limit 1;
  if v_plan.id is null then
    select * into v_plan from public.subscription_plans where is_default_trial and is_active limit 1;
  end if;
  if v_plan.id is null then
    raise exception 'No trial plan is configured. Contact support.';
  end if;
  if coalesce(v_plan.price_monthly_zar, 1) = 0 or v_plan.trial_days = 0 then
    insert into public.organisation_subscriptions (org_id, plan_id, status, billing_status)
    values (v_org, v_plan.id, 'active', case when coalesce(v_plan.price_monthly_zar, 1) = 0 then 'waived'::public.billing_status else 'not_configured'::public.billing_status end);
  else
    insert into public.organisation_subscriptions (org_id, plan_id, status, trial_ends_at)
    values (v_org, v_plan.id, 'trialing', now() + make_interval(days => v_plan.trial_days));
  end if;

  insert into public.organisation_memberships (org_id, user_id, role, can_approve_documents, can_view_confidential)
  values (v_org, auth.uid(), 'org_admin', true, true);

  update public.user_profiles set default_org_id = coalesce(default_org_id, v_org) where id = auth.uid();
  return v_org;
end $$;
revoke execute on function public.create_organisation(text, text, text, text) from public, anon;
grant execute on function public.create_organisation(text, text, text, text) to authenticated;

-- Ended trials move to the Free plan (run by the daily job)
create or replace function public.end_expired_trials()
returns integer language plpgsql security definer set search_path = public as $$
declare v_free uuid; r record; n integer := 0;
begin
  select id into v_free from public.subscription_plans where code = 'free' and is_active;
  if v_free is null then return 0; end if;
  for r in select * from public.organisation_subscriptions where status = 'trialing' and trial_ends_at < now() loop
    update public.organisation_subscriptions set plan_id = v_free, status = 'active', billing_status = 'waived', trial_ends_at = null, updated_at = now()
    where id = r.id;
    perform public.notify_roles(r.org_id, array['org_admin']::public.org_role[], 'subscription.trial_ended',
      'Your free trial has ended', 'Your organisation is now on the Free plan. Your records are kept. Contact iHubSA to choose a paid plan.',
      'app/#/company', 'organisation', r.org_id, 'trial.ended:' || r.org_id);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.end_expired_trials() from public, anon, authenticated;
do $$ begin
  perform cron.schedule('ohs-end-trials', '15 4 * * *', 'select public.end_expired_trials()');
exception when others then null; end $$;

-- ---------------------------------------------------------------------
-- Modules that now follow the plan
-- ---------------------------------------------------------------------
create policy contractors_plan_ins on public.contractors as restrictive for insert to authenticated
  with check (public.org_has_feature(org_id, 'contractors'));
create policy risk_register_plan_ins on public.risk_register_entries as restrictive for insert to authenticated
  with check (public.org_has_feature(org_id, 'risk_register'));

create or replace function public.tg_enforce_contractor_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_limit integer; v_count integer;
begin
  v_limit := public.org_limit(new.org_id, 'contractors');
  if v_limit is not null then
    select count(*) into v_count from public.contractors where org_id = new.org_id;
    if v_count >= v_limit then
      raise exception 'Your plan allows % contractor(s). Upgrade your plan to add more.', v_limit using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
create trigger contractors_enforce_limit before insert on public.contractors
  for each row execute function public.tg_enforce_contractor_limit();
revoke execute on function public.tg_enforce_contractor_limit() from public, anon, authenticated;

-- Storage: bytes used by an organisation's files
create or replace function public.org_storage_used(p_org uuid)
returns bigint language sql stable security definer set search_path = public, storage as $$
  select coalesce(sum(coalesce((to_jsonb(o) -> 'metadata' ->> 'size')::bigint, 0)), 0)::bigint
  from storage.objects o where o.bucket_id = 'org-files' and o.name like p_org::text || '/%';
$$;
revoke execute on function public.org_storage_used(uuid) from public, anon, authenticated;

create or replace function public.org_storage_ok(p_name text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_org uuid; v_limit integer;
begin
  begin v_org := split_part(p_name, '/', 1)::uuid; exception when others then return true; end;
  v_limit := public.org_limit(v_org, 'storage_mb');
  return v_limit is null or public.org_storage_used(v_org) < v_limit::bigint * 1024 * 1024;
end $$;
revoke execute on function public.org_storage_ok(text) from public, anon;
grant execute on function public.org_storage_ok(text) to authenticated;
create policy org_files_storage_limit on storage.objects as restrictive for insert to authenticated
  with check (bucket_id <> 'org-files' or public.org_storage_ok(name));

-- Platform overview now includes the contractor and storage overrides
drop function if exists public.platform_organisations();
create function public.platform_organisations()
returns table (org_id uuid, name text, industry text, province text, created_at timestamptz, plan_code text, plan_name text,
               status public.subscription_status, billing_status public.billing_status, trial_ends_at timestamptz,
               members bigint, sites bigint, ai_used integer,
               override_max_users integer, override_max_sites integer, override_ai_generations integer,
               override_max_contractors integer, override_storage_mb integer)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform administrators only' using errcode = '42501'; end if;
  return query
    select o.id, o.name, o.industry, o.province, o.created_at, p.code, p.name, s.status, s.billing_status, s.trial_ends_at,
      (select count(*) from public.organisation_memberships m where m.org_id = o.id and m.status = 'active'),
      (select count(*) from public.sites x where x.org_id = o.id and x.is_active),
      coalesce((select u.ai_generations from public.usage_counters u where u.org_id = o.id and u.period_start = public.month_start()), 0),
      s.override_max_users, s.override_max_sites, s.override_ai_generations, s.override_max_contractors, s.override_storage_mb
    from public.organisations o
    left join public.organisation_subscriptions s on s.org_id = o.id
    left join public.subscription_plans p on p.id = s.plan_id
    order by o.created_at desc;
end $$;
revoke execute on function public.platform_organisations() from public, anon;
grant execute on function public.platform_organisations() to authenticated;

-- Plan usage for the Company page (members of the organisation only)
create or replace function public.org_usage(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(p_org) then raise exception 'Not a member of this organisation' using errcode = '42501'; end if;
  return jsonb_build_object(
    'users', jsonb_build_object('used', (select count(*) from public.organisation_memberships where org_id = p_org and status = 'active'), 'limit', public.org_limit(p_org, 'users')),
    'sites', jsonb_build_object('used', (select count(*) from public.sites where org_id = p_org and is_active), 'limit', public.org_limit(p_org, 'sites')),
    'contractors', jsonb_build_object('used', (select count(*) from public.contractors where org_id = p_org), 'limit', public.org_limit(p_org, 'contractors')),
    'storage_mb', jsonb_build_object('used', round(public.org_storage_used(p_org) / 1048576.0, 1), 'limit', public.org_limit(p_org, 'storage_mb')),
    'ai_generations', jsonb_build_object('used', coalesce((select ai_generations from public.usage_counters where org_id = p_org and period_start = public.month_start()), 0), 'limit', public.org_limit(p_org, 'ai_generations')));
end $$;
revoke execute on function public.org_usage(uuid) from public, anon;
grant execute on function public.org_usage(uuid) to authenticated;

-- Reports follow the plan
create or replace function public.ohs_report(p_org uuid, p_from date, p_to date, p_site uuid default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare
  r jsonb;
  tz constant text := 'Africa/Johannesburg';
begin
  if not public.is_staff(p_org) then raise exception 'Your role cannot view reports' using errcode = '42501'; end if;
  if not public.org_has_feature(p_org, 'reports') then raise exception 'Reports are not included in your plan' using errcode = '42501'; end if;
  if p_to < p_from then raise exception 'The end date must be after the start date'; end if;

  with inc as (
    select * from public.incidents
    where org_id = p_org and (p_site is null or site_id = p_site)
      and (occurred_at at time zone tz)::date between p_from and p_to
  ), ins as (
    select * from public.inspections
    where org_id = p_org and (p_site is null or site_id = p_site) and status in ('completed','closed')
      and (completed_at at time zone tz)::date between p_from and p_to
  ), act as (
    select * from public.corrective_actions where org_id = p_org and (p_site is null or site_id = p_site)
  ), reg as (
    select * from public.risk_register_entries where org_id = p_org and (p_site is null or site_id = p_site) and status in ('open','controlled')
  ), meth as (
    select * from public.risk_methodologies where org_id = p_org and is_default
  )
  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'site_id', p_site,
       'site_name', (select name from public.sites where id = p_site), 'generated_at', now()),
    'incidents', jsonb_build_object(
       'total', (select count(*) from inc),
       'injuries', (select count(*) from inc where category = 'injury'),
       'near_misses', (select count(*) from inc where category = 'near_miss'),
       'dangerous_occurrences', (select count(*) from inc where category = 'dangerous_occurrence'),
       'closed', (select count(*) from inc where status = 'closed'),
       'open', (select count(*) from inc where status <> 'closed'),
       'investigations_approved', (select count(*) from public.incident_investigations v join inc on inc.id = v.incident_id where v.status = 'approved'),
       'avg_days_to_close', (select round(avg(extract(epoch from closed_at - reported_at) / 86400)::numeric, 1) from inc where closed_at is not null),
       'by_category', coalesce((select jsonb_object_agg(category, n) from (select category::text, count(*) n from inc group by 1) x), '{}'::jsonb),
       'by_site', coalesce((select jsonb_agg(jsonb_build_object('site', coalesce(s.name, 'No site'), 'count', n) order by n desc)
                   from (select site_id, count(*) n from inc group by 1) x left join public.sites s on s.id = x.site_id), '[]'::jsonb),
       'by_month', coalesce((select jsonb_agg(jsonb_build_object('month', m, 'count', n) order by m)
                   from (select to_char(occurred_at at time zone tz, 'YYYY-MM') m, count(*) n from inc group by 1) x), '[]'::jsonb)),
    'inspections', jsonb_build_object(
       'completed', (select count(*) from ins),
       'items_compliant', (select coalesce(sum(compliant_count), 0) from ins),
       'items_non_compliant', (select coalesce(sum(non_compliant_count), 0) from ins),
       'compliance_pct', (select case when sum(compliant_count + non_compliant_count) > 0
                            then round(100.0 * sum(compliant_count) / sum(compliant_count + non_compliant_count), 1) end from ins),
       'overdue_at_end', (select count(*) from public.inspections where org_id = p_org and (p_site is null or site_id = p_site)
                            and status in ('scheduled','in_progress') and due_on < p_to)
                       + (select count(*) from public.inspection_schedules where org_id = p_org and (p_site is null or site_id = p_site)
                            and is_active and next_due_on < p_to)),
    'actions', jsonb_build_object(
       'raised', (select count(*) from act where (created_at at time zone tz)::date between p_from and p_to),
       'closed', (select count(*) from act where status = 'closed' and (closed_at at time zone tz)::date between p_from and p_to),
       'closed_on_time', (select count(*) from act where status = 'closed' and (closed_at at time zone tz)::date between p_from and p_to
                            and (closed_at at time zone tz)::date <= due_date),
       'open_at_end', (select count(*) from act where status in ('open','in_progress','awaiting_verification')),
       'overdue_at_end', (select count(*) from act where status in ('open','in_progress') and due_date < p_to),
       'awaiting_verification', (select count(*) from act where status = 'awaiting_verification'),
       'open_by_priority', coalesce((select jsonb_object_agg(priority, n) from (select priority, count(*) n from act
                            where status in ('open','in_progress','awaiting_verification') group by 1) x), '{}'::jsonb),
       'by_source', coalesce((select jsonb_object_agg(source_type, n) from (select source_type, count(*) n from act
                            where (created_at at time zone tz)::date between p_from and p_to group by 1) x), '{}'::jsonb)),
    'risk', jsonb_build_object(
       'register_active', (select count(*) from reg),
       'by_band', coalesce((select jsonb_agg(jsonb_build_object('band', b->>'label', 'colour', b->>'colour',
                     'count', (select count(*) from reg where coalesce(residual_score, initial_score) between (b->>'min')::int and (b->>'max')::int))
                     order by (b->>'min')::int) from meth, jsonb_array_elements(meth.bands) b), '[]'::jsonb),
       'new_in_period', (select count(*) from reg where (created_at at time zone tz)::date between p_from and p_to),
       'assessments_approved', (select count(*) from public.risk_assessments where org_id = p_org and (p_site is null or site_id = p_site)
                                  and status = 'approved' and (approved_at at time zone tz)::date between p_from and p_to),
       'assessments_review_overdue', (select count(*) from public.risk_assessments where org_id = p_org and (p_site is null or site_id = p_site)
                                  and status = 'approved' and review_date < p_to)),
    'documents', jsonb_build_object(
       'approved_in_period', (select count(*) from public.document_versions v join public.documents d on d.id = v.document_id
                                where d.org_id = p_org and v.status in ('approved','obsolete') and (v.approved_at at time zone tz)::date between p_from and p_to),
       'effective', (select count(*) from public.documents where org_id = p_org and status = 'approved'),
       'review_overdue', (select count(*) from public.documents where org_id = p_org and status = 'approved' and review_date < p_to),
       'acknowledgements', (select count(*) from public.document_acknowledgements where org_id = p_org
                                and (acknowledged_at at time zone tz)::date between p_from and p_to))
  ) into r;
  return r;
end $$;
grant execute on function public.ohs_report(uuid, date, date, uuid) to authenticated;
