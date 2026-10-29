-- =====================================================================
-- OHS Hub — Migration 14: Stage 6 modules
--   * plan entitlements enforced in the database for legal, training,
--     contractor documents and equipment/PPE
--   * legal register: verification workflow (independent verifier, edits
--     reset verification, versioning), compliance register per site
--   * training: expiry worked out from the course validity
--   * contractors: document review and access approval by managers
--   * equipment: inspection results roll forward the next due date
--   * emergency preparedness: emergency contacts and drills
--   * platform administration: organisation overview and plan changes
--   * daily reminders for all of the above
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Plan entitlements (RESTRICTIVE: they narrow the existing policies)
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select * from (values
    ('training_courses','training'), ('competency_requirements','training'), ('training_records','training'),
    ('equipment','equipment'), ('equipment_maintenance','equipment'), ('ppe_issues','equipment'),
    ('contractor_documents','contractors'), ('compliance_assessments','legal')) v(t, f) loop
    execute format('create policy %1$s_plan_ins on public.%1$I as restrictive for insert to authenticated with check (public.org_has_feature(org_id, %2$L))', r.t, r.f);
    execute format('create policy %1$s_plan_upd on public.%1$I as restrictive for update to authenticated using (public.org_has_feature(org_id, %2$L))', r.t, r.f);
  end loop;
end $$;
create policy legal_req_plan_ins on public.legal_requirements as restrictive for insert to authenticated
  with check (org_id is null or public.org_has_feature(org_id, 'legal'));
create policy legal_req_plan_upd on public.legal_requirements as restrictive for update to authenticated
  using (org_id is null or public.org_has_feature(org_id, 'legal'));

-- ---------------------------------------------------------------------
-- 2. Legal register
-- ---------------------------------------------------------------------
alter table public.legal_requirements
  add column if not exists title text check (char_length(title) <= 200),
  add column if not exists verification_notes text,
  add column if not exists created_by uuid references auth.users(id) default auth.uid();

-- Verification can only be granted through verify_legal_requirement().
-- Any change to the wording of a verified requirement sends it back to
-- "unverified" and raises its version, so nobody relies on an unchecked edit.
create or replace function public.tg_legal_requirement_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.verification_status = 'verified' and coalesce(current_setting('ohs.verifying', true), '') <> 'on' then
      new.verification_status := 'unverified'; new.verified_by := null; new.verified_at := null;
    end if;
    new.version := 1;
    return new;
  end if;
  if coalesce(current_setting('ohs.verifying', true), '') = 'on' then return new; end if;
  if (new.reference, new.requirement, coalesce(new.title, ''), coalesce(new.applicability, ''), coalesce(new.source_reference, ''),
      new.framework_id, new.effective_date, new.requirement_kind)
     is distinct from
     (old.reference, old.requirement, coalesce(old.title, ''), coalesce(old.applicability, ''), coalesce(old.source_reference, ''),
      old.framework_id, old.effective_date, old.requirement_kind) then
    new.version := old.version + 1;
    if old.verification_status = 'verified' or new.verification_status = 'verified' then
      new.verification_status := 'unverified';
    end if;
    new.verified_by := null; new.verified_at := null;
  elsif new.verification_status = 'verified' and old.verification_status <> 'verified' then
    raise exception 'Use "Verify" to verify a requirement' using errcode = '42501';
  elsif new.verification_status = old.verification_status then
    new.verified_by := old.verified_by; new.verified_at := old.verified_at;
  end if;
  if new.verification_status <> 'verified' then new.verified_by := null; new.verified_at := null; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists legal_requirement_guard on public.legal_requirements;
create trigger legal_requirement_guard before insert or update on public.legal_requirements
  for each row execute function public.tg_legal_requirement_guard();

create or replace function public.verify_legal_requirement(p_id uuid, p_notes text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.legal_requirements;
begin
  select * into r from public.legal_requirements where id = p_id;
  if r.id is null then raise exception 'Requirement not found'; end if;
  if r.org_id is null then
    if not public.is_platform_admin() then raise exception 'Only platform administrators can verify the shared legal library' using errcode = '42501'; end if;
  else
    if not public.is_manager(r.org_id) then raise exception 'Only administrators and OHS managers can verify requirements' using errcode = '42501'; end if;
    if not public.org_has_feature(r.org_id, 'legal') then raise exception 'Your plan does not include the legal register' using errcode = '42501'; end if;
  end if;
  if r.created_by = auth.uid() and (r.org_id is null or public.org_requires_independent(r.org_id)) then
    raise exception 'Someone other than the person who captured this requirement must verify it' using errcode = '42501';
  end if;
  if coalesce(trim(p_notes), '') = '' then raise exception 'Record how you verified it (for example the official source you checked)'; end if;
  perform set_config('ohs.verifying', 'on', true);
  update public.legal_requirements set verification_status = 'verified', verified_by = auth.uid(), verified_at = now(),
    verification_notes = left(p_notes, 2000), updated_at = now() where id = p_id;
  perform set_config('ohs.verifying', 'off', true);
end $$;
revoke execute on function public.verify_legal_requirement(uuid, text) from public, anon;
grant execute on function public.verify_legal_requirement(uuid, text) to authenticated;

-- Compliance register: one assessment per requirement per site (or organisation-wide)
create unique index if not exists compliance_assessments_unique
  on public.compliance_assessments (org_id, requirement_id, coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---------------------------------------------------------------------
-- 3. Training
-- ---------------------------------------------------------------------
alter table public.training_records add column if not exists notes text;
alter table public.training_courses add column if not exists description text;
create or replace function public.tg_training_expiry()
returns trigger language plpgsql set search_path = public as $$
declare v_months int;
begin
  if new.expires_on is null then
    select validity_months into v_months from public.training_courses where id = new.course_id;
    if v_months is not null then new.expires_on := (new.completed_on + make_interval(months => v_months))::date; end if;
  end if;
  if new.expires_on is not null and new.expires_on < new.completed_on then
    raise exception 'The expiry date must be after the completion date';
  end if;
  if new.contractor_id is not null then
    perform 1 from public.contractors where id = new.contractor_id and org_id = new.org_id;
    if not found then raise exception 'Linked record belongs to a different organisation' using errcode = '42501'; end if;
  end if;
  if new.employee_id is not null then
    perform 1 from public.employees where id = new.employee_id and org_id = new.org_id;
    if not found then raise exception 'Linked record belongs to a different organisation' using errcode = '42501'; end if;
  end if;
  return new;
end $$;
create trigger training_expiry before insert or update on public.training_records
  for each row execute function public.tg_training_expiry();
create index if not exists training_records_person_idx on public.training_records (org_id, employee_id, course_id, completed_on desc);

-- ---------------------------------------------------------------------
-- 4. Contractors
-- ---------------------------------------------------------------------
alter table public.contractor_documents
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_notes text,
  add column if not exists uploaded_by uuid references auth.users(id) default auth.uid();
alter table public.contractors
  add column if not exists access_approved_by uuid references auth.users(id),
  add column if not exists access_approved_at timestamptz;

-- Only administrators and OHS managers may accept or reject documents,
-- and not documents they uploaded themselves.
create or replace function public.tg_contractor_doc_review()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.review_status := 'pending'; new.reviewed_by := null; new.reviewed_at := null;
    return new;
  end if;
  if new.review_status is distinct from old.review_status then
    if not public.is_manager(new.org_id) then
      raise exception 'Only administrators and OHS managers can review contractor documents' using errcode = '42501';
    end if;
    if new.review_status <> 'pending' and old.uploaded_by = auth.uid() and public.org_requires_independent(new.org_id) then
      raise exception 'Someone other than the uploader must review this document' using errcode = '42501';
    end if;
    new.reviewed_by := case when new.review_status = 'pending' then null else auth.uid() end;
    new.reviewed_at := case when new.review_status = 'pending' then null else now() end;
  else
    new.reviewed_by := old.reviewed_by; new.reviewed_at := old.reviewed_at;
  end if;
  if new.storage_path is distinct from old.storage_path then
    raise exception 'Upload a new document instead of replacing the file';
  end if;
  return new;
end $$;
create trigger contractor_doc_review before insert or update on public.contractor_documents
  for each row execute function public.tg_contractor_doc_review();

-- Approving site access is a manager decision and needs a completed induction.
create or replace function public.tg_contractor_access()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.access_status = 'approved' and (tg_op = 'INSERT' or old.access_status is distinct from 'approved') then
    if not public.is_manager(new.org_id) then
      raise exception 'Only administrators and OHS managers can approve contractor access' using errcode = '42501';
    end if;
    if new.induction_completed_on is null then
      raise exception 'Record the site induction before approving access';
    end if;
    new.access_approved_by := auth.uid(); new.access_approved_at := now();
  elsif tg_op = 'UPDATE' and new.access_status = old.access_status then
    new.access_approved_by := old.access_approved_by; new.access_approved_at := old.access_approved_at;
  elsif new.access_status <> 'approved' then
    new.access_approved_by := null; new.access_approved_at := null;
  end if;
  return new;
end $$;
create trigger contractor_access before insert or update on public.contractors
  for each row execute function public.tg_contractor_access();

-- ---------------------------------------------------------------------
-- 5. Equipment and PPE
-- ---------------------------------------------------------------------
alter table public.equipment
  add column if not exists category text not null default 'other'
    check (category in ('fire_equipment','first_aid','emergency','lifting','ladders_access','electrical','pressure','vehicles_mobile','machinery','hand_tools','other')),
  add column if not exists inspection_interval_months integer check (inspection_interval_months between 1 and 120),
  add column if not exists location text,
  add column if not exists notes text;
alter table public.equipment_maintenance
  add column if not exists outcome text check (outcome in ('pass','fail')),
  add column if not exists next_due date;
alter table public.ppe_issues
  add column if not exists returned_on date,
  add column if not exists notes text;

-- A passed inspection sets the next due date; a failed inspection or a
-- reported defect takes the item out of service until it is repaired.
create or replace function public.tg_equipment_log()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_int int;
begin
  if new.kind = 'inspection' then
    if new.outcome is null then raise exception 'Record whether the inspection passed or failed'; end if;
    select inspection_interval_months into v_int from public.equipment where id = new.equipment_id;
    if new.next_due is null and v_int is not null then new.next_due := (new.performed_on + make_interval(months => v_int))::date; end if;
  end if;
  return new;
end $$;
create trigger equipment_log_before before insert on public.equipment_maintenance
  for each row execute function public.tg_equipment_log();

create or replace function public.tg_equipment_log_after()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'inspection' and new.outcome = 'pass' then
    update public.equipment set next_inspection_due = coalesce(new.next_due, next_inspection_due),
      status = case when status = 'out_of_service' then 'in_service' else status end, updated_at = now()
    where id = new.equipment_id;
  elsif (new.kind = 'inspection' and new.outcome = 'fail') or new.kind = 'defect' then
    update public.equipment set status = 'out_of_service', updated_at = now() where id = new.equipment_id and status <> 'retired';
  end if;
  return null;
end $$;
create trigger equipment_log_after after insert on public.equipment_maintenance
  for each row execute function public.tg_equipment_log_after();
revoke execute on function public.tg_equipment_log() from public, anon, authenticated;
revoke execute on function public.tg_equipment_log_after() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. Emergency preparedness (all plans)
-- ---------------------------------------------------------------------
create table public.emergency_contacts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  site_id     uuid references public.sites(id) on delete cascade,     -- NULL = all sites
  role        text not null check (char_length(role) between 2 and 120),
  name        text check (char_length(name) <= 120),
  phone       text not null check (char_length(phone) between 3 and 40),
  alt_phone   text check (char_length(alt_phone) <= 40),
  notes       text check (char_length(notes) <= 500),
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index emergency_contacts_org_idx on public.emergency_contacts(org_id, site_id, sort_order);

create table public.emergency_drills (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organisations(id) on delete cascade,
  reference          text not null,
  site_id            uuid references public.sites(id) on delete set null,
  drill_type         text not null default 'evacuation'
                     check (drill_type in ('evacuation','fire','medical','chemical_spill','bomb_threat','shelter_in_place','other')),
  scenario           text check (char_length(scenario) <= 2000),
  scheduled_for      date not null,
  status             text not null default 'planned' check (status in ('planned','completed','cancelled')),
  held_on            date,
  coordinator_id     uuid references auth.users(id),
  announced          boolean not null default true,
  participants       integer check (participants >= 0),
  evacuation_minutes numeric(6,1) check (evacuation_minutes >= 0),
  target_minutes     numeric(6,1) check (target_minutes > 0),
  everyone_accounted boolean,
  outcome            text check (outcome in ('satisfactory','needs_improvement','unsatisfactory')),
  observations       text check (char_length(observations) <= 5000),
  created_by         uuid references auth.users(id) default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, reference)
);
create index emergency_drills_org_idx on public.emergency_drills(org_id, status, scheduled_for);

alter table public.emergency_contacts enable row level security;
alter table public.emergency_drills enable row level security;
-- Everyone in the organisation can see emergency numbers and drills
create policy emergency_contacts_read on public.emergency_contacts for select to authenticated using (public.is_member(org_id));
create policy emergency_contacts_write on public.emergency_contacts for all to authenticated
  using (public.is_editor(org_id)) with check (public.is_editor(org_id));
create policy emergency_drills_read on public.emergency_drills for select to authenticated using (public.is_member(org_id));
create policy emergency_drills_insert on public.emergency_drills for insert to authenticated with check (public.is_field(org_id));
create policy emergency_drills_update on public.emergency_drills for update to authenticated
  using (public.is_field(org_id)) with check (public.is_field(org_id));
create policy emergency_drills_delete on public.emergency_drills for delete to authenticated using (public.is_manager(org_id));
grant select, insert, update, delete on public.emergency_contacts, public.emergency_drills to authenticated;
grant all on public.emergency_contacts, public.emergency_drills to service_role;

create trigger freeze_org_emergency_contacts before update on public.emergency_contacts for each row execute function public.tg_freeze_org_id();
create trigger freeze_org_emergency_drills before update on public.emergency_drills for each row execute function public.tg_freeze_org_id();
create trigger parent_org_contacts_site before insert or update on public.emergency_contacts
  for each row execute function public.tg_check_parent_org('sites', 'site_id');
create trigger parent_org_drills_site before insert or update on public.emergency_drills
  for each row execute function public.tg_check_parent_org('sites', 'site_id');
create trigger emergency_contacts_updated before update on public.emergency_contacts for each row execute function public.tg_set_updated_at();
create trigger emergency_drills_updated before update on public.emergency_drills for each row execute function public.tg_set_updated_at();
create trigger audit_emergency_drills after insert or update or delete on public.emergency_drills for each row execute function public.tg_audit_row();
create trigger audit_emergency_contacts after insert or update or delete on public.emergency_contacts for each row execute function public.tg_audit_row();

-- A completed drill must record what happened.
create or replace function public.tg_drill_complete()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status = 'completed' then
    if new.held_on is null or new.outcome is null then
      raise exception 'Record the date held and the outcome to complete the drill';
    end if;
    if new.held_on > (now() at time zone 'Africa/Johannesburg')::date then
      raise exception 'A drill can''t be completed with a future date';
    end if;
  end if;
  return new;
end $$;
create trigger drill_complete before insert or update on public.emergency_drills
  for each row execute function public.tg_drill_complete();

-- Corrective actions can now come from drills and contractor or equipment findings
alter table public.corrective_actions drop constraint if exists corrective_actions_source_type_check;
alter table public.corrective_actions add constraint corrective_actions_source_type_check check (source_type in
  ('risk_assessment','risk_register','inspection','audit','incident','legal_compliance','management_review',
   'emergency_drill','equipment','contractor','other'));

-- ---------------------------------------------------------------------
-- 7. Platform administration (iHubSA). Metadata only: no customer records.
-- ---------------------------------------------------------------------
create or replace function public.platform_organisations()
returns table (org_id uuid, name text, industry text, province text, created_at timestamptz, plan_code text, plan_name text,
               status public.subscription_status, billing_status public.billing_status, trial_ends_at timestamptz,
               members bigint, sites bigint, ai_used integer,
               override_max_users integer, override_max_sites integer, override_ai_generations integer)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform administrators only' using errcode = '42501'; end if;
  return query
    select o.id, o.name, o.industry, o.province, o.created_at, p.code, p.name, s.status, s.billing_status, s.trial_ends_at,
      (select count(*) from public.organisation_memberships m where m.org_id = o.id and m.status = 'active'),
      (select count(*) from public.sites x where x.org_id = o.id and x.is_active),
      coalesce((select u.ai_generations from public.usage_counters u where u.org_id = o.id and u.period_start = public.month_start()), 0),
      s.override_max_users, s.override_max_sites, s.override_ai_generations
    from public.organisations o
    left join public.organisation_subscriptions s on s.org_id = o.id
    left join public.subscription_plans p on p.id = s.plan_id
    order by o.created_at desc;
end $$;
revoke execute on function public.platform_organisations() from public, anon;
grant execute on function public.platform_organisations() to authenticated;

-- ---------------------------------------------------------------------
-- 8. Daily reminders (adds Stage 6 items to the existing sweep)
-- ---------------------------------------------------------------------
create or replace function public.run_daily_reminders()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Africa/Johannesburg')::date;
  v_week text := to_char(v_today, 'IYYY-IW');
  v_count integer := 0;
  r record;
begin
  -- Actions due soon
  for r in select a.*, coalesce(nr.days_before, 3) d
           from public.corrective_actions a
           left join public.notification_rules nr on nr.org_id = a.org_id and nr.event_type = 'action.due_soon'
           where a.status in ('open','in_progress') and a.due_date between v_today and v_today + coalesce(nr.days_before, 3) loop
    perform public.notify_user(r.org_id, r.responsible_id, 'action.due_soon',
      'Action due ' || to_char(r.due_date, 'DD Mon YYYY') || ': ' || r.reference, r.title,
      'app/#/actions/' || r.id, 'corrective_action', r.id, 'action.due_soon:' || r.id || ':' || r.due_date);
    v_count := v_count + 1;
  end loop;
  -- Overdue actions (once per week per action)
  for r in select * from public.corrective_actions
           where status in ('open','in_progress') and due_date < v_today loop
    perform public.notify_user(r.org_id, r.responsible_id, 'action.overdue',
      'Overdue action: ' || r.reference, r.title, 'app/#/actions/' || r.id, 'corrective_action', r.id,
      'action.overdue:' || r.id || ':' || v_week);
    perform public.notify_roles(r.org_id, array['ohs_manager']::public.org_role[], 'action.overdue',
      'Overdue action: ' || r.reference, r.title, 'app/#/actions/' || r.id, 'corrective_action', r.id,
      'action.overdue:' || r.id || ':' || v_week);
    v_count := v_count + 1;
  end loop;
  -- Upcoming inspections
  for r in select s.*, t.title, coalesce(nr.days_before, 2) d
           from public.inspection_schedules s join public.inspection_templates t on t.id = s.template_id
           left join public.notification_rules nr on nr.org_id = s.org_id and nr.event_type = 'inspection.upcoming'
           where s.is_active and s.next_due_on between v_today and v_today + coalesce(nr.days_before, 2) loop
    perform public.notify_user(r.org_id, r.inspector_id, 'inspection.upcoming',
      'Inspection due ' || to_char(r.next_due_on, 'DD Mon YYYY'), r.title, 'app/#/inspections',
      'inspection_schedule', r.id, 'inspection.upcoming:' || r.id || ':' || r.next_due_on);
    v_count := v_count + 1;
  end loop;
  -- Documents due for review
  for r in select d.*, coalesce(nr.days_before, 14) dd
           from public.documents d
           left join public.notification_rules nr on nr.org_id = d.org_id and nr.event_type = 'document.review_due'
           where d.status = 'approved' and d.review_date is not null
             and d.review_date <= v_today + coalesce(nr.days_before, 14) loop
    perform public.notify_user(r.org_id, r.owner_id, 'document.review_due',
      'Document review due ' || to_char(r.review_date, 'DD Mon YYYY'), r.title,
      'app/#/documents/' || r.id, 'document', r.id, 'document.review_due:' || r.id || ':' || r.review_date);
    v_count := v_count + 1;
  end loop;
  -- Expiring training (managers)
  for r in select tr.*, c.name course, coalesce(e.first_name || ' ' || e.last_name, k.company_name) person, coalesce(nr.days_before, 30) d
           from public.training_records tr
           join public.training_courses c on c.id = tr.course_id
           left join public.employees e on e.id = tr.employee_id
           left join public.contractors k on k.id = tr.contractor_id
           left join public.notification_rules nr on nr.org_id = tr.org_id and nr.event_type = 'training.expiring'
           where tr.expires_on between v_today and v_today + coalesce(nr.days_before, 30)
             and not exists (select 1 from public.training_records n where n.course_id = tr.course_id
                             and n.employee_id is not distinct from tr.employee_id and n.contractor_id is not distinct from tr.contractor_id
                             and n.completed_on > tr.completed_on) loop
    perform public.notify_roles(r.org_id, array['org_admin','ohs_manager']::public.org_role[], 'training.expiring',
      'Training expires ' || to_char(r.expires_on, 'DD Mon YYYY'), coalesce(r.person, 'Someone') || ': ' || r.course,
      'app/#/training', 'training_record', r.id, 'training.expiring:' || r.id || ':' || r.expires_on);
    v_count := v_count + 1;
  end loop;
  -- Contractor documents expiring (30 days) and contractor access expiring (14 days)
  for r in select cd.*, k.company_name from public.contractor_documents cd join public.contractors k on k.id = cd.contractor_id
           where cd.review_status <> 'rejected' and cd.expires_on between v_today and v_today + 30 loop
    perform public.notify_roles(r.org_id, array['org_admin','ohs_manager']::public.org_role[], 'contractor.document_expiring',
      'Contractor document expires ' || to_char(r.expires_on, 'DD Mon YYYY'), r.company_name || ': ' || r.file_name,
      'app/#/contractors/' || r.contractor_id, 'contractor', r.contractor_id, 'contractor.doc:' || r.id || ':' || r.expires_on);
    v_count := v_count + 1;
  end loop;
  for r in select * from public.contractors where access_status = 'approved' and access_expires_on between v_today and v_today + 14 loop
    perform public.notify_roles(r.org_id, array['org_admin','ohs_manager']::public.org_role[], 'contractor.access_expiring',
      'Contractor access expires ' || to_char(r.access_expires_on, 'DD Mon YYYY'), r.company_name,
      'app/#/contractors/' || r.id, 'contractor', r.id, 'contractor.access:' || r.id || ':' || r.access_expires_on);
    v_count := v_count + 1;
  end loop;
  -- Equipment inspections due (14 days) or overdue (weekly), and certificates expiring (30 days)
  for r in select * from public.equipment where status <> 'retired' and next_inspection_due is not null
             and next_inspection_due <= v_today + 14 loop
    perform public.notify_roles(r.org_id, array['org_admin','ohs_manager','safety_officer']::public.org_role[], 'equipment.inspection_due',
      case when r.next_inspection_due < v_today then 'Equipment inspection overdue: ' else 'Equipment inspection due ' || to_char(r.next_inspection_due, 'DD Mon YYYY') || ': ' end || r.name,
      coalesce(r.asset_number, ''), 'app/#/equipment/' || r.id, 'equipment', r.id,
      'equipment.due:' || r.id || ':' || case when r.next_inspection_due < v_today then v_week else r.next_inspection_due::text end);
    v_count := v_count + 1;
  end loop;
  for r in select * from public.equipment where status <> 'retired' and certificate_expires_on between v_today and v_today + 30 loop
    perform public.notify_roles(r.org_id, array['org_admin','ohs_manager']::public.org_role[], 'equipment.certificate_expiring',
      'Equipment certificate expires ' || to_char(r.certificate_expires_on, 'DD Mon YYYY'), r.name,
      'app/#/equipment/' || r.id, 'equipment', r.id, 'equipment.cert:' || r.id || ':' || r.certificate_expires_on);
    v_count := v_count + 1;
  end loop;
  -- PPE due for replacement (14 days)
  for r in select p.*, e.first_name || ' ' || e.last_name person from public.ppe_issues p join public.employees e on e.id = p.employee_id
           where p.returned_on is null and p.replace_by between v_today and v_today + 14 loop
    perform public.notify_roles(r.org_id, array['org_admin','ohs_manager','safety_officer']::public.org_role[], 'ppe.replacement_due',
      'PPE due for replacement ' || to_char(r.replace_by, 'DD Mon YYYY'), r.person || ': ' || r.item,
      'app/#/equipment?t=ppe', 'ppe_issue', r.id, 'ppe.replace:' || r.id || ':' || r.replace_by);
    v_count := v_count + 1;
  end loop;
  -- Legal compliance reviews due (14 days)
  for r in select ca.*, coalesce(lr.title, lr.reference) req from public.compliance_assessments ca
           join public.legal_requirements lr on lr.id = ca.requirement_id
           where ca.is_applicable and ca.review_date between v_today and v_today + 14 loop
    if r.responsible_id is not null then
      perform public.notify_user(r.org_id, r.responsible_id, 'legal.review_due',
        'Compliance review due ' || to_char(r.review_date, 'DD Mon YYYY'), r.req, 'app/#/legal', 'compliance_assessment', r.id,
        'legal.review:' || r.id || ':' || r.review_date);
    else
      perform public.notify_roles(r.org_id, array['org_admin','ohs_manager']::public.org_role[], 'legal.review_due',
        'Compliance review due ' || to_char(r.review_date, 'DD Mon YYYY'), r.req, 'app/#/legal', 'compliance_assessment', r.id,
        'legal.review:' || r.id || ':' || r.review_date);
    end if;
    v_count := v_count + 1;
  end loop;
  -- Emergency drills coming up (7 days)
  for r in select * from public.emergency_drills where status = 'planned' and scheduled_for between v_today and v_today + 7 loop
    if r.coordinator_id is not null then
      perform public.notify_user(r.org_id, r.coordinator_id, 'drill.upcoming', 'Emergency drill on ' || to_char(r.scheduled_for, 'DD Mon YYYY'),
        r.reference, 'app/#/emergency/' || r.id, 'emergency_drill', r.id, 'drill.upcoming:' || r.id || ':' || r.scheduled_for);
    else
      perform public.notify_roles(r.org_id, array['org_admin','ohs_manager']::public.org_role[], 'drill.upcoming',
        'Emergency drill on ' || to_char(r.scheduled_for, 'DD Mon YYYY'), r.reference, 'app/#/emergency/' || r.id,
        'emergency_drill', r.id, 'drill.upcoming:' || r.id || ':' || r.scheduled_for);
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
revoke execute on function public.run_daily_reminders() from public, anon, authenticated;

-- Trigger functions added here are never callable through the API
revoke execute on function public.tg_legal_requirement_guard() from public, anon, authenticated;
revoke execute on function public.tg_training_expiry() from public, anon, authenticated;
revoke execute on function public.tg_contractor_doc_review() from public, anon, authenticated;
revoke execute on function public.tg_contractor_access() from public, anon, authenticated;
revoke execute on function public.tg_drill_complete() from public, anon, authenticated;
