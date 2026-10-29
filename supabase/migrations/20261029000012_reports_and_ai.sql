-- =====================================================================
-- OHS Hub — Migration 12: OHS reports and AI usage controls
--   * ohs_report(): period statistics calculated in the database from
--     the caller's own records (runs with the caller's permissions, so
--     confidential incidents etc. only count for people allowed to see them)
--   * ai_quota(): how many AI drafts the organisation has left this month
--   * ai_begin_job()/ai_finish_job(): server-side only; enforce role,
--     plan entitlement, monthly limit and a per-user rate limit, and keep
--     a log of every generation
-- =====================================================================

alter table public.ai_generation_jobs add column if not exists task text;
create index if not exists ai_jobs_user_recent_idx on public.ai_generation_jobs(user_id, created_at desc);

create or replace function public.month_start(p_ts timestamptz default now())
returns date language sql stable as $$
  select date_trunc('month', (p_ts at time zone 'Africa/Johannesburg'))::date;
$$;

-- ---------------------------------------------------------------------
-- AI quota (readable by any member of the organisation)
-- ---------------------------------------------------------------------
create or replace function public.ai_quota(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_limit int; v_used int; v_feature boolean; v_enabled boolean;
begin
  if not public.is_member(p_org) then raise exception 'Not a member of this organisation' using errcode = '42501'; end if;
  v_limit := public.org_limit(p_org, 'ai_generations');
  v_feature := coalesce(public.org_has_feature(p_org, 'ai'), false);
  select coalesce((value->>'enabled')::boolean, false) into v_enabled from public.platform_settings where key = 'ai';
  select coalesce(ai_generations, 0) into v_used from public.usage_counters where org_id = p_org and period_start = public.month_start();
  return jsonb_build_object('enabled', coalesce(v_enabled, false) and v_feature, 'platform_enabled', coalesce(v_enabled, false),
    'plan_includes_ai', v_feature, 'limit', v_limit, 'used', coalesce(v_used, 0),
    'remaining', case when v_limit is null then null else greatest(v_limit - coalesce(v_used, 0), 0) end,
    'can_generate', public.is_editor(p_org));
end $$;
grant execute on function public.ai_quota(uuid) to authenticated;

-- Called by the ai-generate Edge Function (service role) on behalf of a
-- signed-in user. Returns the new job id or raises a clear reason.
create or replace function public.ai_begin_job(p_user uuid, p_org uuid, p_task text, p_doc_type public.document_type,
                                                p_section text, p_inputs jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_role public.org_role; v_q jsonb; v_recent int; v_id uuid;
begin
  select role into v_role from public.organisation_memberships where org_id = p_org and user_id = p_user and status = 'active';
  if v_role is null then raise exception 'You are not a member of this organisation' using errcode = '42501'; end if;
  if v_role not in ('org_admin','ohs_manager','safety_officer') then
    raise exception 'Only administrators, OHS managers and safety officers can use AI drafting' using errcode = '42501';
  end if;
  if not coalesce((select (value->>'enabled')::boolean from public.platform_settings where key = 'ai'), false) then
    raise exception 'AI drafting has not been switched on yet' using errcode = 'P0001';
  end if;
  if not coalesce(public.org_has_feature(p_org, 'ai'), false) then
    raise exception 'Your plan does not include AI drafting' using errcode = 'P0001';
  end if;
  if public.org_limit(p_org, 'ai_generations') is not null and
     coalesce((select ai_generations from public.usage_counters where org_id = p_org and period_start = public.month_start()), 0)
       >= public.org_limit(p_org, 'ai_generations') then
    raise exception 'Your organisation has used all its AI drafts for this month' using errcode = 'P0001';
  end if;
  select count(*) into v_recent from public.ai_generation_jobs where user_id = p_user and created_at > now() - interval '1 minute';
  if v_recent >= 6 then raise exception 'Too many AI requests. Wait a minute and try again.' using errcode = 'P0001'; end if;
  insert into public.ai_generation_jobs (org_id, user_id, task, doc_type, section_key, inputs, status)
  values (p_org, p_user, p_task, p_doc_type, p_section, p_inputs, 'running') returning id into v_id;
  return v_id;
end $$;

create or replace function public.ai_finish_job(p_job uuid, p_ok boolean, p_output jsonb, p_validation jsonb, p_refs jsonb,
                                                 p_provider text, p_model text, p_in int, p_out int, p_error text)
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  update public.ai_generation_jobs set status = case when p_ok then 'succeeded' else 'failed' end,
    output = p_output, validation = p_validation, source_refs = coalesce(p_refs, '[]'::jsonb), provider = p_provider,
    model = p_model, input_tokens = p_in, output_tokens = p_out, error = left(p_error, 1000), completed_at = now()
  where id = p_job returning org_id into v_org;
  if p_ok then  -- only successful drafts count towards the monthly allowance
    insert into public.usage_counters (org_id, period_start, ai_generations) values (v_org, public.month_start(), 1)
    on conflict (org_id, period_start) do update set ai_generations = usage_counters.ai_generations + 1;
  end if;
end $$;
revoke execute on function public.ai_begin_job(uuid, uuid, text, public.document_type, text, jsonb) from public, anon, authenticated;
revoke execute on function public.ai_finish_job(uuid, boolean, jsonb, jsonb, jsonb, text, text, int, int, text) from public, anon, authenticated;
grant execute on function public.ai_begin_job(uuid, uuid, text, public.document_type, text, jsonb) to service_role;
grant execute on function public.ai_finish_job(uuid, boolean, jsonb, jsonb, jsonb, text, text, int, int, text) to service_role;

-- ---------------------------------------------------------------------
-- OHS report statistics for a period (SAST dates, inclusive)
-- ---------------------------------------------------------------------
create or replace function public.ohs_report(p_org uuid, p_from date, p_to date, p_site uuid default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare
  r jsonb;
  tz constant text := 'Africa/Johannesburg';
begin
  if not public.is_staff(p_org) then raise exception 'Your role cannot view reports' using errcode = '42501'; end if;
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
