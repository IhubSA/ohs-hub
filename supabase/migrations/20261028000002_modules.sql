-- =====================================================================
-- OHS Hub — Migration 2: OHS modules
-- Risk, documents, inspections, incidents, actions, legal, training,
-- equipment, contractors, notifications, AI jobs, contact enquiries.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Risk methodology: configurable 3x3 / 5x5 matrices. Scores are
-- calculated by the database (likelihood x severity) — never by AI.
-- bands: [{"min":1,"max":4,"label":"Low","colour":"#2E7D32"}, ...]
-- ---------------------------------------------------------------------
create table public.risk_methodologies (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organisations(id) on delete cascade,
  name              text not null,
  matrix_size       smallint not null check (matrix_size in (3, 5)),
  likelihood_labels text[] not null,
  severity_labels   text[] not null,
  bands             jsonb not null,
  is_default        boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (array_length(likelihood_labels, 1) = matrix_size),
  check (array_length(severity_labels, 1) = matrix_size),
  check (jsonb_typeof(bands) = 'array' and jsonb_array_length(bands) between 2 and 6)
);
create unique index risk_methodologies_one_default on public.risk_methodologies(org_id) where is_default;
create trigger risk_methodologies_updated before update on public.risk_methodologies
  for each row execute function public.tg_set_updated_at();

-- Deterministic rating lookup.
create or replace function public.risk_band(p_methodology uuid, p_score integer)
returns text language sql stable set search_path = public as $$
  select b->>'label'
  from public.risk_methodologies m, jsonb_array_elements(m.bands) b
  where m.id = p_methodology
    and p_score between (b->>'min')::int and (b->>'max')::int
  limit 1;
$$;

-- Default methodology is created with every new organisation.
create or replace function public.tg_org_defaults()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.risk_methodologies (org_id, name, matrix_size, likelihood_labels, severity_labels, bands, is_default)
  values (new.id, 'Standard 5×5 matrix', 5,
    array['Rare','Unlikely','Possible','Likely','Almost certain'],
    array['Insignificant','Minor','Moderate','Major','Catastrophic'],
    '[{"min":1,"max":4,"label":"Low","colour":"#2E7D32"},
      {"min":5,"max":9,"label":"Medium","colour":"#F2B705"},
      {"min":10,"max":16,"label":"High","colour":"#E8710A"},
      {"min":17,"max":25,"label":"Extreme","colour":"#C8102E"}]'::jsonb,
    true);
  insert into public.notification_rules (org_id, event_type, enabled, email_enabled, days_before)
  select new.id, e, true, true, d from (values
    ('incident.reported', null), ('investigation.assigned', null),
    ('action.assigned', null), ('action.due_soon', 3), ('action.overdue', null),
    ('inspection.upcoming', 2), ('inspection.overdue', null),
    ('training.expiring', 30), ('document.review_due', 14),
    ('document.approval_requested', null), ('document.approved', null), ('document.rejected', null)
  ) as t(e, d);
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Controlled documents
-- ---------------------------------------------------------------------
create type public.document_type as enum (
  'sop','safe_work_procedure','risk_assessment','jsa','inspection_checklist','toolbox_talk',
  'safety_alert','emergency_plan','method_statement','audit_checklist','incident_report',
  'corrective_action_plan','ohs_report','policy','other');
create type public.document_status as enum ('draft','in_review','approved','obsolete','archived');

create table public.document_categories (
  id     uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organisations(id) on delete cascade,
  name   text not null,
  unique (org_id, name)
);

create table public.documents (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organisations(id) on delete cascade,
  reference          text not null,
  title              text not null check (char_length(title) between 3 and 200),
  doc_type           public.document_type not null,
  category_id        uuid references public.document_categories(id) on delete set null,
  site_id            uuid references public.sites(id) on delete set null,
  department_id      uuid references public.departments(id) on delete set null,
  status             public.document_status not null default 'draft',
  current_version_id uuid,                     -- latest approved (effective) version
  owner_id           uuid references auth.users(id),
  review_date        date,
  requires_acknowledgement boolean not null default false,
  visible_to_employees boolean not null default true,
  created_by         uuid references auth.users(id) default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, reference)
);
create index documents_org_status_idx on public.documents(org_id, status);
create index documents_review_idx on public.documents(org_id, review_date);
create trigger documents_updated before update on public.documents
  for each row execute function public.tg_set_updated_at();

create table public.document_versions (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references public.documents(id) on delete cascade,
  org_id          uuid not null references public.organisations(id) on delete cascade,
  version_number  integer not null,
  status          public.document_status not null default 'draft',
  content         jsonb not null default '{}'::jsonb,   -- structured sections
  change_summary  text,
  source_refs     jsonb not null default '[]'::jsonb,   -- references used (verified/unverified flags)
  ai_job_id       uuid,
  effective_date  date,
  review_date     date,
  created_by      uuid references auth.users(id) default auth.uid(),
  submitted_at    timestamptz,
  approved_by     uuid references auth.users(id),
  approved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (document_id, version_number)
);
create index document_versions_doc_idx on public.document_versions(document_id);
create trigger document_versions_updated before update on public.document_versions
  for each row execute function public.tg_set_updated_at();

alter table public.documents add constraint documents_current_version_fk
  foreign key (current_version_id) references public.document_versions(id) on delete set null;

-- Approved versions are immutable (content cannot change once approved).
create or replace function public.tg_lock_approved_version()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.status in ('approved','obsolete','archived')
     and (new.content is distinct from old.content or new.version_number <> old.version_number) then
    raise exception 'Approved versions cannot be edited. Create a new revision instead.';
  end if;
  return new;
end $$;
create trigger document_versions_lock before update on public.document_versions
  for each row execute function public.tg_lock_approved_version();

create table public.document_approvals (
  id          uuid primary key default gen_random_uuid(),
  version_id  uuid not null references public.document_versions(id) on delete cascade,
  org_id      uuid not null references public.organisations(id) on delete cascade,
  reviewer_id uuid not null references auth.users(id),
  decision    text not null default 'pending' check (decision in ('pending','approved','rejected')),
  comments    text,
  requested_by uuid references auth.users(id) default auth.uid(),
  requested_at timestamptz not null default now(),
  decided_at  timestamptz,
  unique (version_id, reviewer_id)
);
create index document_approvals_reviewer_idx on public.document_approvals(reviewer_id, decision);

-- Independent approval: an author cannot approve their own version when
-- the organisation requires independent approval.
create or replace function public.tg_check_independent_approval()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_author uuid; v_required boolean;
begin
  select v.created_by, coalesce((o.settings->>'require_independent_approval')::boolean, true)
    into v_author, v_required
  from public.document_versions v join public.organisations o on o.id = v.org_id
  where v.id = new.version_id;
  if v_required and new.reviewer_id = v_author then
    raise exception 'Your organisation requires an independent approver. You cannot approve your own document.';
  end if;
  return new;
end $$;
create trigger document_approvals_independent before insert or update on public.document_approvals
  for each row execute function public.tg_check_independent_approval();

-- RPC: record a decision. Approving makes the version effective,
-- supersedes the previous one (kept as obsolete) and audits it.
create or replace function public.decide_document_version(p_approval uuid, p_decision text, p_comments text)
returns void language plpgsql security definer set search_path = public as $$
declare a public.document_approvals; v public.document_versions; v_pending int;
begin
  select * into a from public.document_approvals where id = p_approval;
  if a.id is null or a.reviewer_id <> auth.uid() then
    raise exception 'You are not the assigned reviewer for this document' using errcode = '42501';
  end if;
  if not public.has_role(a.org_id, array['org_admin','ohs_manager','safety_officer','supervisor']::public.org_role[]) then
    raise exception 'Your role cannot approve documents' using errcode = '42501';
  end if;
  if a.decision <> 'pending' then raise exception 'This decision has already been recorded'; end if;
  if p_decision not in ('approved','rejected') then raise exception 'Decision must be approved or rejected'; end if;
  if p_decision = 'rejected' and coalesce(trim(p_comments), '') = '' then
    raise exception 'Add a comment explaining why the document was rejected';
  end if;

  update public.document_approvals set decision = p_decision, comments = p_comments, decided_at = now()
   where id = p_approval;
  select * into v from public.document_versions where id = a.version_id;

  if p_decision = 'rejected' then
    update public.document_versions set status = 'draft' where id = v.id;
    update public.documents set status = 'draft' where id = v.document_id and current_version_id is null;
  else
    select count(*) into v_pending from public.document_approvals
     where version_id = v.id and decision <> 'approved';
    if v_pending = 0 then
      update public.document_versions set status = 'obsolete'
       where document_id = v.document_id and status = 'approved' and id <> v.id;
      update public.document_versions
         set status = 'approved', approved_by = auth.uid(), approved_at = now(),
             effective_date = coalesce(effective_date, (now() at time zone 'Africa/Johannesburg')::date)
       where id = v.id;
      update public.documents set status = 'approved', current_version_id = v.id,
             review_date = coalesce(v.review_date, review_date)
       where id = v.document_id;
    end if;
  end if;
  perform public.log_event(a.org_id, 'document.' || p_decision, 'document_versions', v.id,
                           jsonb_build_object('approval_id', p_approval));
end $$;

create table public.document_acknowledgements (
  id              uuid primary key default gen_random_uuid(),
  version_id      uuid not null references public.document_versions(id) on delete cascade,
  org_id          uuid not null references public.organisations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) default auth.uid(),
  acknowledged_at timestamptz not null default now(),
  unique (version_id, user_id)
);

-- ---------------------------------------------------------------------
-- Risk assessments and register
-- ---------------------------------------------------------------------
create type public.risk_assessment_type as enum ('baseline','issue_based','task_specific','jsa','jha');
create type public.record_status as enum ('draft','in_review','approved','archived');

create table public.risk_assessments (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organisations(id) on delete cascade,
  reference       text not null,
  title           text not null check (char_length(title) between 3 and 200),
  assessment_type public.risk_assessment_type not null,
  methodology_id  uuid not null references public.risk_methodologies(id),
  site_id         uuid references public.sites(id) on delete set null,
  department_id   uuid references public.departments(id) on delete set null,
  activity        text,
  scope           text,
  status          public.record_status not null default 'draft',
  assessor_id     uuid references auth.users(id) default auth.uid(),
  approver_id     uuid references auth.users(id),
  approved_at     timestamptz,
  review_date     date,
  document_id     uuid references public.documents(id) on delete set null,
  ai_job_id       uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, reference)
);
create index risk_assessments_org_idx on public.risk_assessments(org_id, status);
create trigger risk_assessments_updated before update on public.risk_assessments
  for each row execute function public.tg_set_updated_at();

create type public.control_level as enum ('elimination','substitution','engineering','administrative','ppe');

create table public.risk_assessment_items (
  id                  uuid primary key default gen_random_uuid(),
  assessment_id       uuid not null references public.risk_assessments(id) on delete cascade,
  org_id              uuid not null references public.organisations(id) on delete cascade,
  sort_order          integer not null default 0,
  activity            text,
  task                text,
  hazard_category     text,
  hazard              text not null,
  persons_exposed     text,
  consequences        text,
  existing_controls   text,
  initial_likelihood  smallint not null check (initial_likelihood between 1 and 5),
  initial_severity    smallint not null check (initial_severity between 1 and 5),
  initial_score       smallint,       -- set by trigger
  initial_rating      text,           -- set by trigger
  additional_controls text,
  control_levels      public.control_level[] not null default '{}',
  residual_likelihood smallint check (residual_likelihood between 1 and 5),
  residual_severity   smallint check (residual_severity between 1 and 5),
  residual_score      smallint,
  residual_rating     text,
  responsible_id      uuid references auth.users(id),
  due_date            date,
  ai_suggested        boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index risk_items_assessment_idx on public.risk_assessment_items(assessment_id);
create trigger risk_items_updated before update on public.risk_assessment_items
  for each row execute function public.tg_set_updated_at();

create or replace function public.tg_score_risk_item()
returns trigger language plpgsql set search_path = public as $$
declare v_m uuid; v_size int;
begin
  select ra.methodology_id, m.matrix_size into v_m, v_size
  from public.risk_assessments ra join public.risk_methodologies m on m.id = ra.methodology_id
  where ra.id = new.assessment_id;
  if new.initial_likelihood > v_size or new.initial_severity > v_size
     or coalesce(new.residual_likelihood,1) > v_size or coalesce(new.residual_severity,1) > v_size then
    raise exception 'Ratings must be between 1 and % for this matrix', v_size;
  end if;
  new.initial_score  := new.initial_likelihood * new.initial_severity;
  new.initial_rating := public.risk_band(v_m, new.initial_score);
  if new.residual_likelihood is not null and new.residual_severity is not null then
    new.residual_score  := new.residual_likelihood * new.residual_severity;
    new.residual_rating := public.risk_band(v_m, new.residual_score);
  else
    new.residual_score := null; new.residual_rating := null;
  end if;
  return new;
end $$;
create trigger risk_items_score before insert or update on public.risk_assessment_items
  for each row execute function public.tg_score_risk_item();

create table public.risk_register_entries (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organisations(id) on delete cascade,
  reference           text not null,
  site_id             uuid references public.sites(id) on delete set null,
  department_id       uuid references public.departments(id) on delete set null,
  methodology_id      uuid not null references public.risk_methodologies(id),
  activity            text,
  task                text,
  hazard_category     text,
  hazard_description  text not null,
  persons_exposed     text,
  existing_controls   text,
  additional_controls text,
  initial_likelihood  smallint not null check (initial_likelihood between 1 and 5),
  initial_severity    smallint not null check (initial_severity between 1 and 5),
  initial_score       smallint,
  initial_rating      text,
  residual_likelihood smallint check (residual_likelihood between 1 and 5),
  residual_severity   smallint check (residual_severity between 1 and 5),
  residual_score      smallint,
  residual_rating     text,
  owner_id            uuid references auth.users(id),
  status              text not null default 'open' check (status in ('open','controlled','closed')),
  review_date         date,
  source_item_id      uuid references public.risk_assessment_items(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, reference)
);
create index risk_register_org_idx on public.risk_register_entries(org_id, status);
create trigger risk_register_updated before update on public.risk_register_entries
  for each row execute function public.tg_set_updated_at();

create or replace function public.tg_score_register_entry()
returns trigger language plpgsql set search_path = public as $$
begin
  new.initial_score  := new.initial_likelihood * new.initial_severity;
  new.initial_rating := public.risk_band(new.methodology_id, new.initial_score);
  if new.residual_likelihood is not null and new.residual_severity is not null then
    new.residual_score  := new.residual_likelihood * new.residual_severity;
    new.residual_rating := public.risk_band(new.methodology_id, new.residual_score);
  else
    new.residual_score := null; new.residual_rating := null;
  end if;
  return new;
end $$;
create trigger risk_register_score before insert or update on public.risk_register_entries
  for each row execute function public.tg_score_register_entry();

-- Links from a register entry to SOPs, inspection templates, incidents, etc.
create table public.record_links (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  from_type   text not null,
  from_id     uuid not null,
  to_type     text not null,
  to_id       uuid not null,
  created_by  uuid references auth.users(id) default auth.uid(),
  created_at  timestamptz not null default now(),
  unique (from_type, from_id, to_type, to_id)
);
create index record_links_from_idx on public.record_links(from_type, from_id);
create index record_links_to_idx on public.record_links(to_type, to_id);

-- ---------------------------------------------------------------------
-- Equipment & PPE (declared before inspections, which reference it)
-- ---------------------------------------------------------------------
create table public.equipment (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organisations(id) on delete cascade,
  site_id            uuid references public.sites(id) on delete set null,
  name               text not null,
  equipment_type     text,
  asset_number       text,
  serial_number      text,
  status             text not null default 'in_service' check (status in ('in_service','out_of_service','retired')),
  next_inspection_due date,
  certificate_expires_on date,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index equipment_org_idx on public.equipment(org_id);
create trigger equipment_updated before update on public.equipment
  for each row execute function public.tg_set_updated_at();

create table public.equipment_maintenance (
  id           uuid primary key default gen_random_uuid(),
  equipment_id uuid not null references public.equipment(id) on delete cascade,
  org_id       uuid not null references public.organisations(id) on delete cascade,
  kind         text not null check (kind in ('maintenance','inspection','defect','repair')),
  performed_on date not null,
  description  text not null,
  performed_by text,
  created_by   uuid references auth.users(id) default auth.uid(),
  created_at   timestamptz not null default now()
);

create table public.ppe_issues (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  item        text not null,
  size        text,
  quantity    integer not null default 1 check (quantity > 0),
  issued_on   date not null default current_date,
  replace_by  date,
  issued_by   uuid references auth.users(id) default auth.uid(),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Inspections
-- ---------------------------------------------------------------------
create table public.inspection_templates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  title       text not null,
  category    text not null default 'general',
  description text,
  status      public.record_status not null default 'draft',
  version     integer not null default 1,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  ai_job_id   uuid,
  created_by  uuid references auth.users(id) default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index inspection_templates_org_idx on public.inspection_templates(org_id);
create trigger inspection_templates_updated before update on public.inspection_templates
  for each row execute function public.tg_set_updated_at();

create table public.inspection_template_items (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.inspection_templates(id) on delete cascade,
  org_id      uuid not null references public.organisations(id) on delete cascade,
  section     text not null default 'General',
  question    text not null,
  guidance    text,
  sort_order  integer not null default 0,
  photo_required_on_fail boolean not null default false
);
create index inspection_template_items_tpl_idx on public.inspection_template_items(template_id, sort_order);

create table public.inspection_schedules (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organisations(id) on delete cascade,
  template_id   uuid not null references public.inspection_templates(id) on delete cascade,
  site_id       uuid references public.sites(id) on delete set null,
  equipment_id  uuid references public.equipment(id) on delete set null,
  inspector_id  uuid references auth.users(id),
  frequency     text not null check (frequency in ('once','daily','weekly','monthly','quarterly','annually')),
  interval_count integer not null default 1 check (interval_count between 1 and 52),
  next_due_on   date not null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index inspection_schedules_due_idx on public.inspection_schedules(org_id, next_due_on) where is_active;
create trigger inspection_schedules_updated before update on public.inspection_schedules
  for each row execute function public.tg_set_updated_at();

create table public.inspections (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organisations(id) on delete cascade,
  reference      text not null,
  template_id    uuid not null references public.inspection_templates(id),
  schedule_id    uuid references public.inspection_schedules(id) on delete set null,
  site_id        uuid references public.sites(id) on delete set null,
  equipment_id   uuid references public.equipment(id) on delete set null,
  inspector_id   uuid references auth.users(id) default auth.uid(),
  due_on         date,
  started_at     timestamptz,
  completed_at   timestamptz,
  status         text not null default 'scheduled'
                 check (status in ('scheduled','in_progress','completed','closed','cancelled')),
  follow_up_of   uuid references public.inspections(id) on delete set null,
  compliant_count     integer not null default 0,
  non_compliant_count integer not null default 0,
  summary        text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, reference)
);
create index inspections_org_status_idx on public.inspections(org_id, status, due_on);
create trigger inspections_updated before update on public.inspections
  for each row execute function public.tg_set_updated_at();

create type public.inspection_response as enum ('compliant','non_compliant','not_applicable','not_inspected');

create table public.inspection_responses (
  id               uuid primary key default gen_random_uuid(),
  inspection_id    uuid not null references public.inspections(id) on delete cascade,
  org_id           uuid not null references public.organisations(id) on delete cascade,
  template_item_id uuid references public.inspection_template_items(id) on delete set null,
  section          text,
  question         text not null,           -- snapshot, so template edits don't rewrite history
  response         public.inspection_response not null default 'not_inspected',
  comment          text,
  risk_level       text check (risk_level in ('low','medium','high','extreme')),
  photo_paths      text[] not null default '{}',
  client_updated_at timestamptz,            -- offline capture: last-write-wins with conflict check
  updated_by       uuid references auth.users(id) default auth.uid(),
  updated_at       timestamptz not null default now(),
  unique (inspection_id, template_item_id)
);
create index inspection_responses_insp_idx on public.inspection_responses(inspection_id);

-- Offline sync conflict guard: reject a stale client write.
create or replace function public.tg_inspection_response_conflict()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.client_updated_at is not null and old.client_updated_at is not null
     and new.client_updated_at < old.client_updated_at then
    raise exception 'CONFLICT: this response was changed on another device after your copy was taken'
      using errcode = '40001';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger inspection_responses_conflict before update on public.inspection_responses
  for each row execute function public.tg_inspection_response_conflict();

-- ---------------------------------------------------------------------
-- Incidents and investigations
-- ---------------------------------------------------------------------
create type public.incident_category as enum (
  'injury','near_miss','dangerous_occurrence','property_damage','occupational_illness',
  'environmental','unsafe_condition','unsafe_act','other');

create table public.incidents (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references public.organisations(id) on delete cascade,
  reference              text not null,
  category               public.incident_category not null,
  sub_category           text,
  occurred_at            timestamptz not null,
  reported_at            timestamptz not null default now(),
  site_id                uuid references public.sites(id) on delete set null,
  department_id          uuid references public.departments(id) on delete set null,
  location_detail        text,
  reported_by            uuid references auth.users(id) default auth.uid(),
  title                  text not null check (char_length(title) between 3 and 200),
  description            text not null,
  actual_consequences    text,
  potential_consequences text,
  potential_severity     smallint check (potential_severity between 1 and 5),
  immediate_controls     text,
  is_confidential        boolean not null default false,
  status                 text not null default 'reported'
                         check (status in ('reported','under_investigation','awaiting_approval','closed')),
  escalation_status      text not null default 'not_required'
                         check (escalation_status in ('not_required','pending','notified')),
  closed_at              timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (org_id, reference)
);
create index incidents_org_idx on public.incidents(org_id, status, occurred_at desc);
create trigger incidents_updated before update on public.incidents
  for each row execute function public.tg_set_updated_at();

-- Persons involved. Injury details are sensitive personal information.
create table public.incident_persons (
  id             uuid primary key default gen_random_uuid(),
  incident_id    uuid not null references public.incidents(id) on delete cascade,
  org_id         uuid not null references public.organisations(id) on delete cascade,
  employee_id    uuid references public.employees(id) on delete set null,
  contractor_id  uuid references public.contractors(id) on delete set null,
  person_name    text,
  involvement    text not null check (involvement in ('injured','involved','first_aider','supervisor_on_duty','other')),
  injury_details text,
  created_at     timestamptz not null default now()
);

create table public.incident_witnesses (
  id           uuid primary key default gen_random_uuid(),
  incident_id  uuid not null references public.incidents(id) on delete cascade,
  org_id       uuid not null references public.organisations(id) on delete cascade,
  witness_name text not null,
  contact      text,
  statement    text,
  statement_taken_on date,
  created_at   timestamptz not null default now()
);

create table public.incident_evidence (
  id           uuid primary key default gen_random_uuid(),
  incident_id  uuid not null references public.incidents(id) on delete cascade,
  org_id       uuid not null references public.organisations(id) on delete cascade,
  storage_path text not null,               -- org-files/{org_id}/incidents/{incident_id}/...
  file_name    text not null,
  mime_type    text,
  description  text,
  collected_by uuid references auth.users(id) default auth.uid(),
  created_at   timestamptz not null default now()
);

create table public.incident_investigations (
  id                   uuid primary key default gen_random_uuid(),
  incident_id          uuid not null unique references public.incidents(id) on delete cascade,
  org_id               uuid not null references public.organisations(id) on delete cascade,
  investigator_id      uuid references auth.users(id),
  status               text not null default 'assigned'
                       check (status in ('assigned','in_progress','submitted','approved','returned')),
  target_date          date,
  milestones           jsonb not null default '[]'::jsonb,
  timeline             jsonb not null default '[]'::jsonb,   -- [{at, event}]
  five_whys            jsonb not null default '[]'::jsonb,
  cause_effect         jsonb not null default '{}'::jsonb,   -- fishbone categories
  summary              text,
  recommendations      text,
  reviewer_id          uuid references auth.users(id),
  reviewer_comments    text,
  submitted_at         timestamptz,
  approved_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create trigger investigations_updated before update on public.incident_investigations
  for each row execute function public.tg_set_updated_at();

create table public.investigation_findings (
  id               uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references public.incident_investigations(id) on delete cascade,
  org_id           uuid not null references public.organisations(id) on delete cascade,
  finding_type     text not null check (finding_type in ('immediate_cause','underlying_cause','contributing_factor','finding')),
  description      text not null,
  is_verified      boolean not null default false,   -- AI suggestions start unverified
  source           text not null default 'investigator' check (source in ('investigator','ai_suggestion')),
  created_by       uuid references auth.users(id) default auth.uid(),
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Legal compliance (platform library + company-specific)
-- ---------------------------------------------------------------------
create table public.legal_frameworks (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  title       text not null,
  kind        text not null check (kind in ('act','regulation','standard','recommended_practice')),
  sector      text not null default 'general',
  source_url  text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table public.legal_requirements (
  id                  uuid primary key default gen_random_uuid(),
  framework_id        uuid references public.legal_frameworks(id) on delete cascade,
  org_id              uuid references public.organisations(id) on delete cascade, -- NULL = platform library
  reference           text not null,          -- e.g. "Section 8(1)"
  requirement         text not null,
  requirement_kind    text not null check (requirement_kind in ('legislation','recommended_practice','company')),
  applicability       text,
  source_reference    text,
  effective_date      date,
  version             integer not null default 1,
  verification_status text not null default 'unverified' check (verification_status in ('unverified','verified','superseded')),
  verified_by         uuid references auth.users(id),
  verified_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index legal_requirements_org_idx on public.legal_requirements(org_id);
create trigger legal_requirements_updated before update on public.legal_requirements
  for each row execute function public.tg_set_updated_at();

create table public.compliance_assessments (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organisations(id) on delete cascade,
  requirement_id uuid not null references public.legal_requirements(id) on delete cascade,
  site_id        uuid references public.sites(id) on delete set null,
  is_applicable  boolean not null default true,
  responsible_id uuid references auth.users(id),
  evaluation     text not null default 'not_assessed'
                 check (evaluation in ('compliant','partially_compliant','non_compliant','not_assessed')),
  evidence       text,
  findings       text,
  assessed_on    date,
  review_date    date,
  assessed_by    uuid references auth.users(id) default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index compliance_assessments_org_idx on public.compliance_assessments(org_id);
create trigger compliance_assessments_updated before update on public.compliance_assessments
  for each row execute function public.tg_set_updated_at();

-- Statutory reporting rules: versioned and verification-gated.
create table public.statutory_report_rules (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid references public.organisations(id) on delete cascade, -- NULL = platform
  name               text not null,
  description        text,
  applies_to         public.incident_category[] not null default '{}',
  conditions         jsonb not null default '{}'::jsonb,
  legal_requirement_id uuid references public.legal_requirements(id) on delete set null,
  due_within_hours   integer check (due_within_hours > 0),
  version            integer not null default 1,
  is_verified        boolean not null default false,
  verified_by        uuid references auth.users(id),
  verified_at        timestamptz,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now()
);

create table public.statutory_reports (
  id               uuid primary key default gen_random_uuid(),
  incident_id      uuid not null references public.incidents(id) on delete cascade,
  org_id           uuid not null references public.organisations(id) on delete cascade,
  rule_id          uuid references public.statutory_report_rules(id) on delete set null,
  legal_reference  text,
  responsible_id   uuid references auth.users(id),
  due_at           timestamptz,
  status           text not null default 'assessing'
                   check (status in ('assessing','not_required','required','submitted','confirmed')),
  submitted_at     timestamptz,
  evidence_path    text,
  confirmed_by     uuid references auth.users(id),
  confirmed_at     timestamptz,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger statutory_reports_updated before update on public.statutory_reports
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------
-- Corrective actions (central register)
-- ---------------------------------------------------------------------
create table public.corrective_actions (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references public.organisations(id) on delete cascade,
  reference             text not null,
  source_type           text not null check (source_type in
                         ('risk_assessment','risk_register','inspection','audit','incident',
                          'legal_compliance','management_review','other')),
  source_id             uuid,
  site_id               uuid references public.sites(id) on delete set null,
  title                 text not null check (char_length(title) between 3 and 200),
  description           text,
  priority              text not null default 'medium' check (priority in ('low','medium','high','critical')),
  responsible_id        uuid references auth.users(id),
  due_date              date not null,
  status                text not null default 'open'
                        check (status in ('open','in_progress','awaiting_verification','closed','cancelled')),
  requires_verification boolean not null default true,
  verification_method   text,
  verified_by           uuid references auth.users(id),
  verified_at           timestamptz,
  verification_outcome  text check (verification_outcome in ('effective','not_effective')),
  closed_at             timestamptz,
  created_by            uuid references auth.users(id) default auth.uid(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, reference)
);
create index corrective_actions_org_idx on public.corrective_actions(org_id, status, due_date);
create index corrective_actions_resp_idx on public.corrective_actions(responsible_id, status);
create index corrective_actions_source_idx on public.corrective_actions(source_type, source_id);
create trigger corrective_actions_updated before update on public.corrective_actions
  for each row execute function public.tg_set_updated_at();

-- An action needing verification cannot close without an effective
-- verification by someone other than the responsible person.
create or replace function public.tg_action_close_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status = 'closed' and (old.status is distinct from 'closed') then
    if new.requires_verification and (new.verified_at is null or new.verification_outcome is distinct from 'effective') then
      raise exception 'This action needs verification before it can be closed';
    end if;
    if new.requires_verification and new.verified_by = new.responsible_id then
      raise exception 'The person responsible for an action cannot verify it';
    end if;
    new.closed_at := now();
  end if;
  return new;
end $$;
create trigger corrective_actions_close_guard before update on public.corrective_actions
  for each row execute function public.tg_action_close_guard();

create table public.action_evidence (
  id           uuid primary key default gen_random_uuid(),
  action_id    uuid not null references public.corrective_actions(id) on delete cascade,
  org_id       uuid not null references public.organisations(id) on delete cascade,
  storage_path text not null,
  file_name    text not null,
  note         text,
  uploaded_by  uuid references auth.users(id) default auth.uid(),
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Training & competency, contractor documents
-- ---------------------------------------------------------------------
create table public.training_courses (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organisations(id) on delete cascade,
  name           text not null,
  kind           text not null default 'course' check (kind in ('induction','course','certificate','licence','refresher')),
  validity_months integer check (validity_months > 0),
  created_at     timestamptz not null default now(),
  unique (org_id, name)
);

create table public.competency_requirements (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organisations(id) on delete cascade,
  course_id  uuid not null references public.training_courses(id) on delete cascade,
  job_title  text,
  department_id uuid references public.departments(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.training_records (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organisations(id) on delete cascade,
  course_id      uuid not null references public.training_courses(id) on delete cascade,
  employee_id    uuid references public.employees(id) on delete cascade,
  contractor_id  uuid references public.contractors(id) on delete cascade,
  completed_on   date not null,
  expires_on     date,
  provider       text,
  certificate_path text,
  created_by     uuid references auth.users(id) default auth.uid(),
  created_at     timestamptz not null default now(),
  check (employee_id is not null or contractor_id is not null)
);
create index training_records_expiry_idx on public.training_records(org_id, expires_on);

create table public.contractor_documents (
  id            uuid primary key default gen_random_uuid(),
  contractor_id uuid not null references public.contractors(id) on delete cascade,
  org_id        uuid not null references public.organisations(id) on delete cascade,
  doc_kind      text not null,     -- e.g. 'safety_file', 'letter_of_good_standing'
  storage_path  text not null,
  file_name     text not null,
  expires_on    date,
  review_status text not null default 'pending' check (review_status in ('pending','accepted','rejected')),
  reviewed_by   uuid references auth.users(id),
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Notifications (in-app + email via Resend)
-- ---------------------------------------------------------------------
create table public.notification_rules (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organisations(id) on delete cascade,
  event_type    text not null,
  enabled       boolean not null default true,
  email_enabled boolean not null default true,
  days_before   integer check (days_before between 0 and 120),
  extra_roles   public.org_role[] not null default '{}',  -- also notify these roles
  unique (org_id, event_type)
);

create table public.notifications (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organisations(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  event_type   text not null,
  title        text not null,
  body         text,
  link         text,                    -- relative app route, e.g. 'app/#/actions/<id>'
  record_type  text,
  record_id    uuid,
  dedupe_key   text not null,           -- prevents duplicates, e.g. 'action.overdue:<id>:2026-10-28'
  read_at      timestamptz,
  email_status text not null default 'pending'
               check (email_status in ('pending','sent','failed','skipped','disabled')),
  email_provider_id text,
  email_error  text,
  emailed_at   timestamptz,
  created_at   timestamptz not null default now(),
  unique (user_id, dedupe_key)
);
create index notifications_user_idx on public.notifications(user_id, read_at, created_at desc);
create index notifications_email_queue_idx on public.notifications(email_status, created_at) where email_status = 'pending';

-- Notify helper used by triggers and scheduled jobs.
create or replace function public.notify_user(
  p_org uuid, p_user uuid, p_event text, p_title text, p_body text,
  p_link text, p_record_type text, p_record_id uuid, p_dedupe text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.notification_rules; v_email boolean;
begin
  if p_user is null then return; end if;
  select * into r from public.notification_rules where org_id = p_org and event_type = p_event;
  if r.id is not null and not r.enabled then return; end if;
  select coalesce(notification_email, true) into v_email from public.user_profiles where id = p_user;
  insert into public.notifications (org_id, user_id, event_type, title, body, link, record_type, record_id,
                                    dedupe_key, email_status)
  values (p_org, p_user, p_event, p_title, p_body, p_link, p_record_type, p_record_id, p_dedupe,
          case when coalesce(r.email_enabled, true) and coalesce(v_email, true) then 'pending' else 'disabled' end)
  on conflict (user_id, dedupe_key) do nothing;
end $$;

-- Notify all members with given roles.
create or replace function public.notify_roles(
  p_org uuid, p_roles public.org_role[], p_event text, p_title text, p_body text,
  p_link text, p_record_type text, p_record_id uuid, p_dedupe text)
returns void language plpgsql security definer set search_path = public as $$
declare m record;
begin
  for m in select user_id from public.organisation_memberships
           where org_id = p_org and status = 'active' and role = any(p_roles) loop
    perform public.notify_user(p_org, m.user_id, p_event, p_title, p_body, p_link, p_record_type, p_record_id, p_dedupe);
  end loop;
end $$;

-- Event triggers -------------------------------------------------------
create or replace function public.tg_notify_incident()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.notify_roles(new.org_id, array['org_admin','ohs_manager']::public.org_role[],
    'incident.reported', 'New incident reported: ' || new.reference,
    new.title, 'app/#/incidents/' || new.id, 'incident', new.id, 'incident.reported:' || new.id);
  return new;
end $$;
create trigger incidents_notify after insert on public.incidents
  for each row execute function public.tg_notify_incident();

create or replace function public.tg_notify_investigation()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_ref text;
begin
  if new.investigator_id is not null and (tg_op = 'INSERT' or new.investigator_id is distinct from old.investigator_id) then
    select reference into v_ref from public.incidents where id = new.incident_id;
    perform public.notify_user(new.org_id, new.investigator_id, 'investigation.assigned',
      'You have been assigned to investigate ' || v_ref, null,
      'app/#/incidents/' || new.incident_id, 'incident', new.incident_id,
      'investigation.assigned:' || new.id || ':' || new.investigator_id);
  end if;
  return new;
end $$;
create trigger investigations_notify after insert or update on public.incident_investigations
  for each row execute function public.tg_notify_investigation();

create or replace function public.tg_notify_action()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.responsible_id is not null and (tg_op = 'INSERT' or new.responsible_id is distinct from old.responsible_id) then
    perform public.notify_user(new.org_id, new.responsible_id, 'action.assigned',
      'Corrective action assigned: ' || new.reference,
      new.title || ' — due ' || to_char(new.due_date, 'DD Mon YYYY'),
      'app/#/actions/' || new.id, 'corrective_action', new.id,
      'action.assigned:' || new.id || ':' || new.responsible_id);
  end if;
  return new;
end $$;
create trigger corrective_actions_notify after insert or update on public.corrective_actions
  for each row execute function public.tg_notify_action();

create or replace function public.tg_notify_approval()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_title text; v_doc uuid; v_author uuid;
begin
  select d.title, d.id, v.created_by into v_title, v_doc, v_author
  from public.document_versions v join public.documents d on d.id = v.document_id where v.id = new.version_id;
  if tg_op = 'INSERT' then
    perform public.notify_user(new.org_id, new.reviewer_id, 'document.approval_requested',
      'Document awaiting your approval', v_title, 'app/#/documents/' || v_doc, 'document', v_doc,
      'document.approval_requested:' || new.id);
  elsif new.decision <> old.decision and new.decision in ('approved','rejected') then
    perform public.notify_user(new.org_id, v_author, 'document.' || new.decision,
      'Document ' || new.decision || ': ' || v_title, new.comments, 'app/#/documents/' || v_doc,
      'document', v_doc, 'document.' || new.decision || ':' || new.id);
  end if;
  return new;
end $$;
create trigger document_approvals_notify after insert or update on public.document_approvals
  for each row execute function public.tg_notify_approval();

-- Daily reminder sweep (called by the scheduled Edge Function / pg_cron).
create or replace function public.run_daily_reminders()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Africa/Johannesburg')::date;
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
      'action.overdue:' || r.id || ':' || to_char(v_today, 'IYYY-IW'));
    perform public.notify_roles(r.org_id, array['ohs_manager']::public.org_role[], 'action.overdue',
      'Overdue action: ' || r.reference, r.title, 'app/#/actions/' || r.id, 'corrective_action', r.id,
      'action.overdue:' || r.id || ':' || to_char(v_today, 'IYYY-IW'));
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
  -- Expiring training (notify managers)
  for r in select tr.*, c.name course, e.first_name || ' ' || e.last_name person, coalesce(nr.days_before, 30) d
           from public.training_records tr
           join public.training_courses c on c.id = tr.course_id
           left join public.employees e on e.id = tr.employee_id
           left join public.notification_rules nr on nr.org_id = tr.org_id and nr.event_type = 'training.expiring'
           where tr.expires_on between v_today and v_today + coalesce(nr.days_before, 30) loop
    perform public.notify_roles(r.org_id, array['org_admin','ohs_manager']::public.org_role[], 'training.expiring',
      'Training expires ' || to_char(r.expires_on, 'DD Mon YYYY'), coalesce(r.person, 'Contractor') || ': ' || r.course,
      'app/#/training', 'training_record', r.id, 'training.expiring:' || r.id || ':' || r.expires_on);
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- ---------------------------------------------------------------------
-- AI generation jobs (server-side only; written by Edge Functions)
-- ---------------------------------------------------------------------
create table public.ai_generation_jobs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organisations(id) on delete cascade,
  user_id       uuid not null references auth.users(id),
  doc_type      public.document_type not null,
  section_key   text,                    -- set when regenerating a single section
  inputs        jsonb not null,
  status        text not null default 'queued' check (status in ('queued','running','succeeded','failed','rejected')),
  output        jsonb,
  validation    jsonb,                   -- missing sections, flagged uncertainties
  source_refs   jsonb not null default '[]'::jsonb,
  provider      text,
  model         text,
  input_tokens  integer,
  output_tokens integer,
  error         text,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);
create index ai_jobs_org_idx on public.ai_generation_jobs(org_id, created_at desc);

-- ---------------------------------------------------------------------
-- Public contact enquiries (marketing site). Inserted only by the
-- contact-submit Edge Function using the service role.
-- ---------------------------------------------------------------------
create table public.contact_enquiries (
  id             uuid primary key default gen_random_uuid(),
  full_name      text not null check (char_length(full_name) between 2 and 120),
  email          text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  company        text check (char_length(company) <= 160),
  company_size   text,
  industry       text,
  topic          text not null default 'general' check (topic in ('general','demo','pricing','partnership','support')),
  message        text not null check (char_length(message) between 10 and 4000),
  consent        boolean not null check (consent),
  ip_hash        text,
  email_status   text not null default 'pending' check (email_status in ('pending','sent','failed')),
  email_error    text,
  status         text not null default 'new' check (status in ('new','contacted','closed','spam')),
  created_at     timestamptz not null default now()
);
create index contact_enquiries_ip_idx on public.contact_enquiries(ip_hash, created_at desc);

-- New organisation defaults (methodology + notification rules).
create trigger organisations_defaults after insert on public.organisations
  for each row execute function public.tg_org_defaults();

-- ---------------------------------------------------------------------
-- Audit triggers on key OHS records
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'documents','document_versions','risk_assessments','risk_assessment_items','risk_register_entries',
    'inspection_templates','inspections','incidents','incident_investigations','investigation_findings',
    'statutory_reports','corrective_actions','legal_requirements','compliance_assessments',
    'training_records','equipment','contractors','employees','risk_methodologies','notification_rules']
  loop
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$I
                    for each row execute function public.tg_audit_row()', t);
  end loop;
end $$;
