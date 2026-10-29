-- =====================================================================
-- OHS Hub — Migration 1: Foundation
-- Tenancy, profiles, roles, subscriptions, helper functions, audit log.
-- Target: a dedicated Supabase project (Postgres 15+).
-- =====================================================================

-- gen_random_uuid() and sha256() are built into Postgres 13+; no extension needed.

-- ---------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------
create type public.org_role as enum (
  'org_admin',       -- Organisation Administrator
  'ohs_manager',     -- OHS Manager
  'safety_officer',  -- Safety Officer
  'supervisor',      -- Supervisor
  'employee',        -- Employee
  'auditor'          -- Auditor / read-only
);

create type public.membership_status as enum ('active', 'suspended');
create type public.subscription_status as enum ('trialing', 'active', 'past_due', 'cancelled', 'expired');
create type public.billing_status as enum ('not_configured', 'pending', 'paid', 'overdue', 'waived');

-- ---------------------------------------------------------------------
-- Shared trigger: updated_at
-- ---------------------------------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Platform administrators (iHubSA staff). Deliberately NOT granted
-- blanket access to tenant data — see RLS migration.
-- ---------------------------------------------------------------------
create table public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.platform_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

-- ---------------------------------------------------------------------
-- User profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------
create table public.user_profiles (
  id                 uuid primary key references auth.users(id) on delete cascade,
  full_name          text not null default '' check (char_length(full_name) <= 120),
  email              text not null,
  job_title          text check (char_length(job_title) <= 120),
  default_org_id     uuid,
  notification_email boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger user_profiles_updated before update on public.user_profiles
  for each row execute function public.tg_set_updated_at();

-- Auto-create a profile when someone signs up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- Organisations (tenants)
-- ---------------------------------------------------------------------
create table public.organisations (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null check (char_length(name) between 2 and 160),
  trading_name        text check (char_length(trading_name) <= 160),
  registration_number text check (char_length(registration_number) <= 40),
  vat_number          text check (char_length(vat_number) <= 20),
  industry            text not null default 'general'
                      check (industry in ('construction','mining','manufacturing','engineering_maintenance',
                                          'logistics_warehousing','transport','facilities_management',
                                          'general','ohs_consultancy')),
  physical_address    text check (char_length(physical_address) <= 400),
  province            text check (province in ('Eastern Cape','Free State','Gauteng','KwaZulu-Natal','Limpopo',
                                               'Mpumalanga','Northern Cape','North West','Western Cape')),
  -- Org-level configuration: independent approval, confidentiality, etc.
  settings            jsonb not null default jsonb_build_object(
                         'require_independent_approval', true,
                         'confidential_incidents_enabled', true,
                         'timezone', 'Africa/Johannesburg'),
  status              text not null default 'active' check (status in ('active','suspended','closed')),
  created_by          uuid references auth.users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger organisations_updated before update on public.organisations
  for each row execute function public.tg_set_updated_at();

alter table public.user_profiles
  add constraint user_profiles_default_org_fk foreign key (default_org_id)
  references public.organisations(id) on delete set null;

-- ---------------------------------------------------------------------
-- Sites and departments
-- ---------------------------------------------------------------------
create table public.sites (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organisations(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 160),
  code       text check (char_length(code) <= 20),
  address    text check (char_length(address) <= 400),
  province   text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);
create index sites_org_idx on public.sites(org_id);
create trigger sites_updated before update on public.sites
  for each row execute function public.tg_set_updated_at();

create table public.departments (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organisations(id) on delete cascade,
  site_id    uuid references public.sites(id) on delete set null,
  name       text not null check (char_length(name) between 1 and 160),
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, site_id, name)
);
create index departments_org_idx on public.departments(org_id);
create trigger departments_updated before update on public.departments
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------
-- Memberships: a user can belong to several organisations.
-- site_ids NULL = all sites; otherwise the user's scope is limited
-- (used for supervisors and employees).
-- ---------------------------------------------------------------------
create table public.organisation_memberships (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organisations(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  role              public.org_role not null,
  status            public.membership_status not null default 'active',
  site_ids          uuid[],
  can_view_confidential boolean not null default false,
  can_approve_documents boolean not null default false,
  invited_by        uuid references auth.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, user_id)
);
create index memberships_user_idx on public.organisation_memberships(user_id);
create trigger memberships_updated before update on public.organisation_memberships
  for each row execute function public.tg_set_updated_at();

create table public.organisation_invitations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organisations(id) on delete cascade,
  email        text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role         public.org_role not null,
  site_ids     uuid[],
  token_hash   text not null unique,         -- sha256 of the emailed token; raw token never stored
  invited_by   uuid not null references auth.users(id),
  expires_at   timestamptz not null default now() + interval '7 days',
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users(id),
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index invitations_org_idx on public.organisation_invitations(org_id);

-- ---------------------------------------------------------------------
-- Workforce: employees and contractors
-- Data minimisation: no ID numbers or medical fields here.
-- ---------------------------------------------------------------------
create table public.employees (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organisations(id) on delete cascade,
  site_id         uuid references public.sites(id) on delete set null,
  department_id   uuid references public.departments(id) on delete set null,
  user_id         uuid references auth.users(id) on delete set null,
  employee_number text check (char_length(employee_number) <= 40),
  first_name      text not null check (char_length(first_name) between 1 and 80),
  last_name       text not null check (char_length(last_name) between 1 and 80),
  job_title       text check (char_length(job_title) <= 120),
  email           text,
  start_date      date,
  status          text not null default 'active' check (status in ('active','inactive','terminated')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, employee_number)
);
create index employees_org_idx on public.employees(org_id);
create index employees_site_idx on public.employees(site_id);
create trigger employees_updated before update on public.employees
  for each row execute function public.tg_set_updated_at();

create table public.contractors (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organisations(id) on delete cascade,
  company_name        text not null check (char_length(company_name) between 1 and 160),
  registration_number text,
  contact_name        text,
  contact_email       text,
  services            text,
  access_status       text not null default 'pending'
                      check (access_status in ('pending','approved','suspended','expired')),
  induction_completed_on date,
  access_expires_on   date,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index contractors_org_idx on public.contractors(org_id);
create trigger contractors_updated before update on public.contractors
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------
-- Subscription plans (configurable by platform admins) and tenant
-- subscriptions. No payment provider wired yet — billing_status stays
-- 'not_configured' until one is chosen.
-- ---------------------------------------------------------------------
create table public.subscription_plans (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique check (code ~ '^[a-z0-9_]+$'),
  name                text not null,
  tagline             text,
  price_monthly_zar   numeric(10,2) check (price_monthly_zar >= 0),  -- NULL = "contact us"
  price_annual_zar    numeric(10,2) check (price_annual_zar >= 0),
  max_users           integer check (max_users > 0),                 -- NULL = unlimited / custom
  max_sites           integer check (max_sites > 0),
  ai_generations_per_month integer check (ai_generations_per_month >= 0),
  storage_mb          integer check (storage_mb > 0),
  trial_days          integer not null default 14 check (trial_days between 0 and 90),
  features            jsonb not null default '{}'::jsonb,   -- entitlement flags, e.g. {"contractors":true}
  feature_list        text[] not null default '{}',          -- marketing bullet points
  is_public           boolean not null default true,
  is_default_trial    boolean not null default false,
  is_active           boolean not null default true,
  sort_order          integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index subscription_plans_one_default on public.subscription_plans(is_default_trial) where is_default_trial;
create trigger subscription_plans_updated before update on public.subscription_plans
  for each row execute function public.tg_set_updated_at();

create table public.organisation_subscriptions (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null unique references public.organisations(id) on delete cascade,
  plan_id            uuid not null references public.subscription_plans(id),
  status             public.subscription_status not null default 'trialing',
  billing_status     public.billing_status not null default 'not_configured',
  trial_ends_at      timestamptz,
  current_period_end timestamptz,
  payment_provider   text,          -- set once a provider is confirmed
  provider_reference text,
  -- Per-tenant overrides for Enterprise (NULL = use plan value)
  override_max_users integer,
  override_max_sites integer,
  override_ai_generations integer,
  override_storage_mb integer,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger org_subscriptions_updated before update on public.organisation_subscriptions
  for each row execute function public.tg_set_updated_at();

create table public.usage_counters (
  org_id         uuid not null references public.organisations(id) on delete cascade,
  period_start   date not null,             -- first day of month (Africa/Johannesburg)
  ai_generations integer not null default 0,
  storage_bytes  bigint not null default 0,
  primary key (org_id, period_start)
);

-- ---------------------------------------------------------------------
-- Reference number counters (e.g. INC-2026-0001)
-- ---------------------------------------------------------------------
create table public.reference_counters (
  org_id  uuid not null references public.organisations(id) on delete cascade,
  prefix  text not null,
  year    integer not null,
  last_no integer not null default 0,
  primary key (org_id, prefix, year)
);

-- =====================================================================
-- Helper functions used by RLS. SECURITY DEFINER so they can read
-- memberships without recursive policy evaluation.
-- =====================================================================
create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

create or replace function public.my_role(p_org uuid)
returns public.org_role language sql stable security definer set search_path = public as $$
  select role from public.organisation_memberships
  where org_id = p_org and user_id = auth.uid() and status = 'active';
$$;

create or replace function public.is_member(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.organisation_memberships
                 where org_id = p_org and user_id = auth.uid() and status = 'active');
$$;

create or replace function public.has_role(p_org uuid, p_roles public.org_role[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.organisation_memberships
                 where org_id = p_org and user_id = auth.uid() and status = 'active'
                   and role = any(p_roles));
$$;

-- Managers: full control of OHS records.
create or replace function public.is_manager(p_org uuid)
returns boolean language sql stable set search_path = public as $$
  select public.has_role(p_org, array['org_admin','ohs_manager']::public.org_role[]);
$$;

-- Editors: may create/update operational OHS records.
create or replace function public.is_editor(p_org uuid)
returns boolean language sql stable set search_path = public as $$
  select public.has_role(p_org, array['org_admin','ohs_manager','safety_officer']::public.org_role[]);
$$;

-- Field roles: may capture inspections/incidents/hazards.
create or replace function public.is_field(p_org uuid)
returns boolean language sql stable set search_path = public as $$
  select public.has_role(p_org, array['org_admin','ohs_manager','safety_officer','supervisor']::public.org_role[]);
$$;

-- Site scope check: NULL site_ids on the membership means "all sites".
create or replace function public.in_site_scope(p_org uuid, p_site uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.organisation_memberships m
    where m.org_id = p_org and m.user_id = auth.uid() and m.status = 'active'
      and (m.site_ids is null or p_site is null or p_site = any(m.site_ids)
           or m.role in ('org_admin','ohs_manager','auditor'))
  );
$$;

create or replace function public.can_view_confidential(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.organisation_memberships
                 where org_id = p_org and user_id = auth.uid() and status = 'active'
                   and (role in ('org_admin','ohs_manager') or can_view_confidential));
$$;

-- Next reference number: e.g. next_reference(org, 'INC') -> 'INC-2026-0007'
create or replace function public.next_reference(p_org uuid, p_prefix text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_year integer := extract(year from (now() at time zone 'Africa/Johannesburg'))::int;
  v_no   integer;
begin
  if not public.is_member(p_org) and auth.uid() is not null then
    raise exception 'Not a member of this organisation' using errcode = '42501';
  end if;
  insert into public.reference_counters (org_id, prefix, year, last_no)
  values (p_org, p_prefix, v_year, 1)
  on conflict (org_id, prefix, year) do update set last_no = reference_counters.last_no + 1
  returning last_no into v_no;
  return p_prefix || '-' || v_year || '-' || lpad(v_no::text, 4, '0');
end $$;

-- Effective entitlement for an org (plan value with overrides).
create or replace function public.org_limit(p_org uuid, p_key text)
returns integer language sql stable security definer set search_path = public as $$
  select case p_key
    when 'users' then coalesce(s.override_max_users, p.max_users)
    when 'sites' then coalesce(s.override_max_sites, p.max_sites)
    when 'ai_generations' then coalesce(s.override_ai_generations, p.ai_generations_per_month)
    when 'storage_mb' then coalesce(s.override_storage_mb, p.storage_mb)
  end
  from public.organisation_subscriptions s
  join public.subscription_plans p on p.id = s.plan_id
  where s.org_id = p_org;
$$;

create or replace function public.org_has_feature(p_org uuid, p_feature text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((p.features ->> p_feature)::boolean, false)
  from public.organisation_subscriptions s
  join public.subscription_plans p on p.id = s.plan_id
  where s.org_id = p_org and s.status in ('trialing','active');
$$;

-- Server-side entitlement enforcement for sites and users.
create or replace function public.tg_enforce_site_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_limit integer; v_count integer;
begin
  v_limit := public.org_limit(new.org_id, 'sites');
  if v_limit is not null then
    select count(*) into v_count from public.sites where org_id = new.org_id and is_active;
    if v_count >= v_limit then
      raise exception 'Your plan allows % site(s). Upgrade your plan to add more.', v_limit
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
create trigger sites_enforce_limit before insert on public.sites
  for each row execute function public.tg_enforce_site_limit();

create or replace function public.tg_enforce_user_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_limit integer; v_count integer;
begin
  v_limit := public.org_limit(new.org_id, 'users');
  if v_limit is not null then
    select count(*) into v_count from public.organisation_memberships
     where org_id = new.org_id and status = 'active';
    if v_count >= v_limit then
      raise exception 'Your plan allows % user(s). Upgrade your plan to add more.', v_limit
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
create trigger memberships_enforce_limit before insert on public.organisation_memberships
  for each row execute function public.tg_enforce_user_limit();

-- ---------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------
create table public.audit_logs (
  id          bigint generated always as identity primary key,
  org_id      uuid references public.organisations(id) on delete cascade,
  actor_id    uuid,
  action      text not null,            -- INSERT / UPDATE / DELETE / custom e.g. 'document.approved'
  table_name  text,
  record_id   uuid,
  changes     jsonb,
  created_at  timestamptz not null default now()
);
create index audit_logs_org_idx on public.audit_logs(org_id, created_at desc);
create index audit_logs_record_idx on public.audit_logs(record_id);

-- Generic row audit. Stores only changed column names + new values for
-- updates, to keep sensitive text out of logs where possible.
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
  insert into public.audit_logs (org_id, actor_id, action, table_name, record_id, changes)
  values (v_org, auth.uid(), tg_op, tg_table_name, v_id, v_changes);
  return coalesce(new, old);
end $$;

create or replace function public.log_event(p_org uuid, p_action text, p_table text, p_record uuid, p_detail jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.audit_logs (org_id, actor_id, action, table_name, record_id, changes)
  values (p_org, auth.uid(), p_action, p_table, p_record, p_detail);
$$;

create trigger audit_organisations after update or delete on public.organisations
  for each row execute function public.tg_audit_row();
create trigger audit_memberships after insert or update or delete on public.organisation_memberships
  for each row execute function public.tg_audit_row();
create trigger audit_sites after insert or update or delete on public.sites
  for each row execute function public.tg_audit_row();
create trigger audit_subscriptions after insert or update on public.organisation_subscriptions
  for each row execute function public.tg_audit_row();

-- ---------------------------------------------------------------------
-- RPC: create an organisation. Caller becomes org_admin, gets a trial
-- on the default trial plan and a default 5x5 risk methodology
-- (methodology inserted in migration 2's function override).
-- ---------------------------------------------------------------------
create or replace function public.create_organisation(
  p_name text, p_industry text default 'general', p_registration_number text default null,
  p_province text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org  uuid;
  v_plan record;
begin
  if auth.uid() is null then
    raise exception 'Sign in to create an organisation' using errcode = '42501';
  end if;
  insert into public.organisations (name, industry, registration_number, province, created_by)
  values (trim(p_name), p_industry, nullif(trim(p_registration_number), ''), p_province, auth.uid())
  returning id into v_org;

  select * into v_plan from public.subscription_plans where is_default_trial and is_active limit 1;
  if v_plan.id is null then
    raise exception 'No trial plan is configured. Contact support.';
  end if;
  insert into public.organisation_subscriptions (org_id, plan_id, status, trial_ends_at)
  values (v_org, v_plan.id, 'trialing', now() + make_interval(days => v_plan.trial_days));

  insert into public.organisation_memberships (org_id, user_id, role, can_approve_documents, can_view_confidential)
  values (v_org, auth.uid(), 'org_admin', true, true);

  update public.user_profiles set default_org_id = coalesce(default_org_id, v_org) where id = auth.uid();
  return v_org;
end $$;

-- RPC: accept an invitation using the raw token from the email link.
create or replace function public.accept_invitation(p_token text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_inv public.organisation_invitations;
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'Sign in to accept this invitation' using errcode = '42501';
  end if;
  select email into v_email from auth.users where id = auth.uid();
  select * into v_inv from public.organisation_invitations
   where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
     and accepted_at is null and revoked_at is null and expires_at > now();
  if v_inv.id is null then
    raise exception 'This invitation is invalid or has expired';
  end if;
  if lower(v_inv.email) <> lower(v_email) then
    raise exception 'This invitation was sent to a different email address';
  end if;
  insert into public.organisation_memberships (org_id, user_id, role, site_ids, invited_by)
  values (v_inv.org_id, auth.uid(), v_inv.role, v_inv.site_ids, v_inv.invited_by)
  on conflict (org_id, user_id) do update set role = excluded.role, status = 'active';
  update public.organisation_invitations set accepted_at = now(), accepted_by = auth.uid() where id = v_inv.id;
  update public.user_profiles set default_org_id = coalesce(default_org_id, v_inv.org_id) where id = auth.uid();
  return v_inv.org_id;
end $$;
