-- =====================================================================
-- OHS Hub — Migration 4: Private storage, scheduled jobs, reference data
-- =====================================================================

-- ---------------------------------------------------------------------
-- Private bucket. Paths: {org_id}/{module}/{record_id}/{filename}
-- 10 MB limit; images, PDF and Office documents only.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('org-files', 'org-files', false, 10485760, array[
  'image/jpeg','image/png','image/webp','image/heic','application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv'])
on conflict (id) do nothing;

create or replace function public.storage_org(p_name text)
returns uuid language plpgsql immutable set search_path = public as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when others then
  return null;
end $$;

create policy org_files_read on storage.objects for select to authenticated
  using (bucket_id = 'org-files' and public.is_staff(public.storage_org(name))
         or (bucket_id = 'org-files' and owner = auth.uid() and public.is_member(public.storage_org(name))));
create policy org_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'org-files' and public.is_member(public.storage_org(name)));
create policy org_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'org-files' and (owner = auth.uid() or public.is_manager(public.storage_org(name))));

-- ---------------------------------------------------------------------
-- Reference data
-- Plans: names and features from the product brief. Prices are NULL
-- ("Contact us") until commercial pricing is confirmed. Edit them in
-- the platform admin screen, not here.
-- ---------------------------------------------------------------------
insert into public.subscription_plans
  (code, name, tagline, price_monthly_zar, max_users, max_sites, ai_generations_per_month, storage_mb,
   trial_days, is_default_trial, sort_order, features, feature_list)
values
  ('starter', 'Starter', 'For a single business getting its safety records in order.', null, 5, 1, 20, 1024,
   14, false, 1,
   '{"risk_assessments":true,"inspections":true,"incidents":true,"documents":true,"ai":true}',
   array['One company','Basic OHS dashboard','Limited AI document generation','Basic risk assessments',
         'Digital inspections','Incident reporting']),
  ('professional', 'Professional', 'For teams running a full OHS management system.', null, 15, 3, 100, 5120,
   14, true, 2,
   '{"risk_assessments":true,"risk_register":true,"inspections":true,"incidents":true,"investigations":true,"actions":true,"documents":true,"approvals":true,"reports":true,"ai":true}',
   array['Everything in Starter','Expanded AI document generation','Advanced risk registers','Incident investigations',
         'Corrective action management','Document approval workflows','Reporting and analytics']),
  ('business', 'Business', 'For multi-site operations with contractors.', null, 50, 10, 300, 20480,
   14, false, 3,
   '{"risk_assessments":true,"risk_register":true,"inspections":true,"incidents":true,"investigations":true,"actions":true,"documents":true,"approvals":true,"reports":true,"ai":true,"multi_site":true,"contractors":true,"training":true,"legal":true,"equipment":true}',
   array['Everything in Professional','Multiple sites','Contractor management','Training and competency management',
         'Advanced compliance reporting','More users and configurable permissions']),
  ('enterprise', 'Enterprise', 'For large or specialised organisations.', null, null, null, null, null,
   0, false, 4,
   '{"risk_assessments":true,"risk_register":true,"inspections":true,"incidents":true,"investigations":true,"actions":true,"documents":true,"approvals":true,"reports":true,"ai":true,"multi_site":true,"contractors":true,"training":true,"legal":true,"equipment":true,"enterprise_admin":true}',
   array['Custom user and site limits','Advanced administration','Enhanced reporting',
         'Industry-specific configuration','Priority support options'])
on conflict (code) do nothing;

-- Legal frameworks: the Acts themselves. Individual requirements are
-- NOT pre-loaded — they are added and verified through the platform
-- admin legal library so that nothing unverified is presented as law.
insert into public.legal_frameworks (code, title, kind, sector, source_url) values
  ('OHSA-85-1993', 'Occupational Health and Safety Act 85 of 1993', 'act', 'general', 'https://www.gov.za/documents/occupational-health-and-safety-act'),
  ('MHSA-29-1996', 'Mine Health and Safety Act 29 of 1996', 'act', 'mining', null)
on conflict (code) do nothing;

insert into public.platform_settings (key, value) values
  ('ai', '{"enabled": false, "provider": "anthropic", "model": "claude-sonnet-5-5"}'),
  ('email', '{"from": "OHS Hub <notifications@ihub-sa.co.za>", "reply_to": "enquiries@ihub-sa.co.za"}')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- Scheduled reminders. Requires the pg_cron extension (enable it in
-- Supabase → Database → Extensions). The send-notifications Edge
-- Function is also scheduled to flush pending emails.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('ohs-daily-reminders', '0 4 * * *', 'select public.run_daily_reminders()');  -- 06:00 SAST
  end if;
end $$;
