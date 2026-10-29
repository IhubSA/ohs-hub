-- =====================================================================
-- OHS Hub — Migration 3: Row Level Security and integrity guards
-- Tenant isolation is enforced HERE, not in the browser.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Extra helpers
-- ---------------------------------------------------------------------
-- Any role except plain 'employee'.
create or replace function public.is_staff(p_org uuid)
returns boolean language sql stable set search_path = public as $$
  select public.has_role(p_org, array['org_admin','ohs_manager','safety_officer','supervisor','auditor']::public.org_role[]);
$$;

create or replace function public.can_see_incident(p_incident uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.incidents i
    left join public.incident_investigations inv on inv.incident_id = i.id
    where i.id = p_incident and public.is_member(i.org_id)
      and (
        i.reported_by = auth.uid()
        or inv.investigator_id = auth.uid()
        or (i.is_confidential and public.can_view_confidential(i.org_id))
        or (not i.is_confidential and public.is_staff(i.org_id) and public.in_site_scope(i.org_id, i.site_id))
      )
  );
$$;

create or replace function public.can_see_document(p_document uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.documents d
    where d.id = p_document and public.is_member(d.org_id)
      and (public.is_staff(d.org_id) or (d.status = 'approved' and d.visible_to_employees))
  );
$$;

-- ---------------------------------------------------------------------
-- Integrity guards
-- ---------------------------------------------------------------------
-- org_id may never change after insert.
create or replace function public.tg_freeze_org_id()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.org_id is distinct from old.org_id then
    raise exception 'Records cannot be moved between organisations';
  end if;
  return new;
end $$;

-- A child row must belong to the same organisation as its parent.
-- Usage: tg_check_parent_org('<parent_table>', '<fk_column>')
create or replace function public.tg_check_parent_org()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_parent_org uuid; v_fk uuid;
begin
  v_fk := (to_jsonb(new) ->> tg_argv[1])::uuid;
  if v_fk is null then return new; end if;
  execute format('select org_id from public.%I where id = $1', tg_argv[0]) into v_parent_org using v_fk;
  if v_parent_org is distinct from new.org_id then
    raise exception 'Linked record belongs to a different organisation' using errcode = '42501';
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'sites','departments','organisation_memberships','organisation_invitations','employees','contractors',
    'risk_methodologies','document_categories','documents','document_versions','document_approvals',
    'document_acknowledgements','risk_assessments','risk_assessment_items','risk_register_entries',
    'record_links','equipment','equipment_maintenance','ppe_issues','inspection_templates',
    'inspection_template_items','inspection_schedules','inspections','inspection_responses','incidents',
    'incident_persons','incident_witnesses','incident_evidence','incident_investigations',
    'investigation_findings','compliance_assessments','statutory_reports','corrective_actions',
    'action_evidence','training_courses','competency_requirements','training_records',
    'contractor_documents','notification_rules','notifications','ai_generation_jobs']
  loop
    execute format('create trigger freeze_org_%1$s before update on public.%1$I
                    for each row execute function public.tg_freeze_org_id()', t);
  end loop;
end $$;

create trigger parent_org_dept_site before insert or update on public.departments
  for each row execute function public.tg_check_parent_org('sites', 'site_id');
create trigger parent_org_doc_versions before insert or update on public.document_versions
  for each row execute function public.tg_check_parent_org('documents', 'document_id');
create trigger parent_org_doc_approvals before insert or update on public.document_approvals
  for each row execute function public.tg_check_parent_org('document_versions', 'version_id');
create trigger parent_org_doc_acks before insert on public.document_acknowledgements
  for each row execute function public.tg_check_parent_org('document_versions', 'version_id');
create trigger parent_org_ra_items before insert or update on public.risk_assessment_items
  for each row execute function public.tg_check_parent_org('risk_assessments', 'assessment_id');
create trigger parent_org_ra_methodology before insert or update on public.risk_assessments
  for each row execute function public.tg_check_parent_org('risk_methodologies', 'methodology_id');
create trigger parent_org_register_methodology before insert or update on public.risk_register_entries
  for each row execute function public.tg_check_parent_org('risk_methodologies', 'methodology_id');
create trigger parent_org_tpl_items before insert or update on public.inspection_template_items
  for each row execute function public.tg_check_parent_org('inspection_templates', 'template_id');
create trigger parent_org_schedules before insert or update on public.inspection_schedules
  for each row execute function public.tg_check_parent_org('inspection_templates', 'template_id');
create trigger parent_org_inspections before insert or update on public.inspections
  for each row execute function public.tg_check_parent_org('inspection_templates', 'template_id');
create trigger parent_org_responses before insert or update on public.inspection_responses
  for each row execute function public.tg_check_parent_org('inspections', 'inspection_id');
create trigger parent_org_inc_persons before insert or update on public.incident_persons
  for each row execute function public.tg_check_parent_org('incidents', 'incident_id');
create trigger parent_org_inc_witnesses before insert or update on public.incident_witnesses
  for each row execute function public.tg_check_parent_org('incidents', 'incident_id');
create trigger parent_org_inc_evidence before insert or update on public.incident_evidence
  for each row execute function public.tg_check_parent_org('incidents', 'incident_id');
create trigger parent_org_investigations before insert or update on public.incident_investigations
  for each row execute function public.tg_check_parent_org('incidents', 'incident_id');
create trigger parent_org_findings before insert or update on public.investigation_findings
  for each row execute function public.tg_check_parent_org('incident_investigations', 'investigation_id');
create trigger parent_org_stat_reports before insert or update on public.statutory_reports
  for each row execute function public.tg_check_parent_org('incidents', 'incident_id');
create trigger parent_org_action_evidence before insert or update on public.action_evidence
  for each row execute function public.tg_check_parent_org('corrective_actions', 'action_id');
create trigger parent_org_maintenance before insert or update on public.equipment_maintenance
  for each row execute function public.tg_check_parent_org('equipment', 'equipment_id');
create trigger parent_org_ppe before insert or update on public.ppe_issues
  for each row execute function public.tg_check_parent_org('employees', 'employee_id');
create trigger parent_org_training before insert or update on public.training_records
  for each row execute function public.tg_check_parent_org('training_courses', 'course_id');
create trigger parent_org_contractor_docs before insert or update on public.contractor_documents
  for each row execute function public.tg_check_parent_org('contractors', 'contractor_id');
create trigger parent_org_compliance before insert or update on public.compliance_assessments
  for each row execute function public.tg_check_parent_org('legal_requirements', 'requirement_id');

-- legal_requirements with org_id NULL are platform rows; parent check
-- above would reject company assessments of platform requirements, so
-- override for that table:
drop trigger parent_org_compliance on public.compliance_assessments;
create or replace function public.tg_check_requirement_org()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_exists boolean;
begin
  select org_id, true into v_org, v_exists from public.legal_requirements where id = new.requirement_id;
  if v_exists and v_org is not null and v_org <> new.org_id then
    raise exception 'Linked record belongs to a different organisation' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger requirement_org_compliance before insert or update on public.compliance_assessments
  for each row execute function public.tg_check_requirement_org();

-- Verification of corrective actions: only editors may verify, and the
-- verifier is always the signed-in user (cannot be spoofed).
create or replace function public.tg_action_verify_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.verified_at is distinct from old.verified_at) or (new.verification_outcome is distinct from old.verification_outcome) then
    if auth.uid() is not null and not public.is_editor(new.org_id) then
      raise exception 'Only an OHS manager, safety officer or administrator can verify actions' using errcode = '42501';
    end if;
    new.verified_by := auth.uid();
    new.verified_at := coalesce(new.verified_at, now());
  end if;
  -- Responsible people (non-editors) may only progress their own action, not reassign it.
  if auth.uid() is not null and not public.is_editor(new.org_id) then
    if new.responsible_id is distinct from old.responsible_id or new.due_date is distinct from old.due_date
       or new.requires_verification is distinct from old.requires_verification then
      raise exception 'Only an editor can reassign, reschedule or change verification on an action' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger corrective_actions_verify_guard before update on public.corrective_actions
  for each row execute function public.tg_action_verify_guard();

-- Never leave an organisation without an active admin.
create or replace function public.tg_keep_one_admin()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_org uuid := coalesce(old.org_id, new.org_id); v_count int;
begin
  if tg_op = 'DELETE' and exists (select 1 from public.organisations where id = old.org_id) is false then
    return old;  -- organisation itself is being deleted
  end if;
  select count(*) into v_count from public.organisation_memberships
   where org_id = v_org and role = 'org_admin' and status = 'active';
  if v_count = 0 then
    raise exception 'An organisation must keep at least one active administrator';
  end if;
  return coalesce(new, old);
end $$;
create constraint trigger memberships_keep_admin after update or delete on public.organisation_memberships
  deferrable initially deferred for each row execute function public.tg_keep_one_admin();

-- Users may mark notifications read but change nothing else.
create or replace function public.tg_notification_user_update()
returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null and (new.title, new.body, new.user_id, new.dedupe_key, new.email_status)
     is distinct from (old.title, old.body, old.user_id, old.dedupe_key, old.email_status) then
    raise exception 'Only the read status of a notification can be changed';
  end if;
  return new;
end $$;
create trigger notifications_user_update before update on public.notifications
  for each row execute function public.tg_notification_user_update();

-- =====================================================================
-- Enable RLS on every table
-- =====================================================================
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

-- =====================================================================
-- Policies
-- =====================================================================

-- Platform -------------------------------------------------------------
create policy platform_admins_self on public.platform_admins for select to authenticated
  using (user_id = auth.uid());
create policy platform_settings_admin on public.platform_settings for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

create policy plans_public_read on public.subscription_plans for select to anon, authenticated
  using ((is_active and is_public) or public.is_platform_admin());
create policy plans_admin_write on public.subscription_plans for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

create policy contact_admin on public.contact_enquiries for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

create policy legal_frameworks_read on public.legal_frameworks for select to authenticated using (true);
create policy legal_frameworks_admin on public.legal_frameworks for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- Profiles -------------------------------------------------------------
create policy profiles_read on public.user_profiles for select to authenticated
  using (id = auth.uid() or exists (
    select 1 from public.organisation_memberships a
    join public.organisation_memberships b on a.org_id = b.org_id
    where a.user_id = auth.uid() and a.status = 'active' and b.user_id = user_profiles.id));
create policy profiles_update_own on public.user_profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Organisations --------------------------------------------------------
create policy orgs_read on public.organisations for select to authenticated using (public.is_member(id));
create policy orgs_update on public.organisations for update to authenticated
  using (public.has_role(id, array['org_admin']::public.org_role[]))
  with check (public.has_role(id, array['org_admin']::public.org_role[]));

create policy memberships_read on public.organisation_memberships for select to authenticated
  using (user_id = auth.uid() or public.is_member(org_id));
create policy memberships_admin on public.organisation_memberships for all to authenticated
  using (public.has_role(org_id, array['org_admin']::public.org_role[]))
  with check (public.has_role(org_id, array['org_admin']::public.org_role[]));

create policy invitations_admin on public.organisation_invitations for all to authenticated
  using (public.has_role(org_id, array['org_admin']::public.org_role[]))
  with check (public.has_role(org_id, array['org_admin']::public.org_role[]));

create policy subscriptions_read on public.organisation_subscriptions for select to authenticated
  using (public.is_member(org_id) or public.is_platform_admin());
create policy subscriptions_platform on public.organisation_subscriptions for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());

create policy usage_read on public.usage_counters for select to authenticated
  using (public.has_role(org_id, array['org_admin','ohs_manager']::public.org_role[]) or public.is_platform_admin());

create policy audit_read on public.audit_logs for select to authenticated
  using (public.has_role(org_id, array['org_admin','ohs_manager','auditor']::public.org_role[]));

-- reference_counters: no policies -> only SECURITY DEFINER functions.

-- Generic helper to create the common policy set ------------------------
-- read_fn / write_fn / delete_fn are SQL boolean expressions on org_id.
create or replace function public._make_policies(p_table text, p_read text, p_write text, p_delete text)
returns void language plpgsql set search_path = public as $$
begin
  execute format('create policy %1$s_read on public.%1$I for select to authenticated using (%2$s)', p_table, p_read);
  execute format('create policy %1$s_insert on public.%1$I for insert to authenticated with check (%2$s)', p_table, p_write);
  execute format('create policy %1$s_update on public.%1$I for update to authenticated using (%2$s) with check (%2$s)', p_table, p_write);
  execute format('create policy %1$s_delete on public.%1$I for delete to authenticated using (%2$s)', p_table, p_delete);
end $$;

-- Configuration owned by admins
select public._make_policies('sites',       'public.is_member(org_id)', 'public.has_role(org_id, array[''org_admin'']::public.org_role[])', 'public.has_role(org_id, array[''org_admin'']::public.org_role[])');
select public._make_policies('departments', 'public.is_member(org_id)', 'public.has_role(org_id, array[''org_admin'']::public.org_role[])', 'public.has_role(org_id, array[''org_admin'']::public.org_role[])');
select public._make_policies('risk_methodologies',  'public.is_member(org_id)', 'public.is_manager(org_id)', 'public.is_manager(org_id)');
select public._make_policies('document_categories', 'public.is_member(org_id)', 'public.is_manager(org_id)', 'public.is_manager(org_id)');
select public._make_policies('notification_rules',  'public.is_member(org_id)', 'public.is_manager(org_id)', 'public.is_manager(org_id)');
select public._make_policies('training_courses',    'public.is_member(org_id)', 'public.is_manager(org_id)', 'public.is_manager(org_id)');
select public._make_policies('competency_requirements', 'public.is_member(org_id)', 'public.is_manager(org_id)', 'public.is_manager(org_id)');

-- Workforce
select public._make_policies('employees',
  'public.is_staff(org_id) or user_id = auth.uid()', 'public.is_manager(org_id)', 'public.is_manager(org_id)');
select public._make_policies('contractors',        'public.is_staff(org_id)', 'public.is_editor(org_id)', 'public.is_manager(org_id)');
select public._make_policies('contractor_documents','public.is_staff(org_id)', 'public.is_editor(org_id)', 'public.is_manager(org_id)');
select public._make_policies('ppe_issues',
  'public.is_staff(org_id) or exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())',
  'public.is_editor(org_id)', 'public.is_manager(org_id)');
select public._make_policies('training_records',
  'public.is_staff(org_id) or exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())',
  'public.is_editor(org_id)', 'public.is_manager(org_id)');

-- Equipment
select public._make_policies('equipment',             'public.is_member(org_id)', 'public.is_field(org_id)', 'public.is_manager(org_id)');
select public._make_policies('equipment_maintenance', 'public.is_staff(org_id)',  'public.is_field(org_id)', 'public.is_manager(org_id)');

-- Documents
create policy documents_read on public.documents for select to authenticated
  using (public.is_member(org_id) and (
    (public.is_staff(org_id) and public.in_site_scope(org_id, site_id))
    or (status = 'approved' and visible_to_employees)));
create policy documents_insert on public.documents for insert to authenticated with check (public.is_editor(org_id));
create policy documents_update on public.documents for update to authenticated
  using (public.is_editor(org_id)) with check (public.is_editor(org_id));
create policy documents_delete on public.documents for delete to authenticated
  using (public.is_manager(org_id) and status = 'draft');

create policy doc_versions_read on public.document_versions for select to authenticated
  using (public.can_see_document(document_id) and (public.is_staff(org_id) or status = 'approved'));
create policy doc_versions_insert on public.document_versions for insert to authenticated with check (public.is_editor(org_id));
create policy doc_versions_update on public.document_versions for update to authenticated
  using (public.is_editor(org_id) and status in ('draft','in_review'))
  with check (public.is_editor(org_id));
create policy doc_versions_delete on public.document_versions for delete to authenticated
  using (public.is_manager(org_id) and status = 'draft');

create policy doc_approvals_read on public.document_approvals for select to authenticated
  using (public.is_staff(org_id));
create policy doc_approvals_insert on public.document_approvals for insert to authenticated
  with check (public.is_editor(org_id) and decision = 'pending'
              and public.has_role(org_id, array['org_admin','ohs_manager','safety_officer','supervisor']::public.org_role[])
              and exists (select 1 from public.organisation_memberships m
                          where m.org_id = document_approvals.org_id and m.user_id = reviewer_id and m.status = 'active'
                            and (m.can_approve_documents or m.role in ('org_admin','ohs_manager'))));
-- Decisions go through decide_document_version(); no direct update.
create policy doc_approvals_delete on public.document_approvals for delete to authenticated
  using (public.is_manager(org_id) and decision = 'pending');

create policy doc_acks_read on public.document_acknowledgements for select to authenticated
  using (user_id = auth.uid() or public.is_staff(org_id));
create policy doc_acks_insert on public.document_acknowledgements for insert to authenticated
  with check (user_id = auth.uid() and public.is_member(org_id));

-- Risk
select public._make_policies('risk_assessments',
  'public.is_staff(org_id) and public.in_site_scope(org_id, site_id)', 'public.is_editor(org_id)', 'public.is_manager(org_id)');
select public._make_policies('risk_assessment_items', 'public.is_staff(org_id)', 'public.is_editor(org_id)', 'public.is_editor(org_id)');
select public._make_policies('risk_register_entries',
  'public.is_staff(org_id) and public.in_site_scope(org_id, site_id)', 'public.is_editor(org_id)', 'public.is_manager(org_id)');
select public._make_policies('record_links', 'public.is_staff(org_id)', 'public.is_field(org_id)', 'public.is_editor(org_id)');

-- Inspections
select public._make_policies('inspection_templates',      'public.is_staff(org_id)', 'public.is_editor(org_id)', 'public.is_manager(org_id)');
select public._make_policies('inspection_template_items', 'public.is_staff(org_id)', 'public.is_editor(org_id)', 'public.is_editor(org_id)');
select public._make_policies('inspection_schedules',      'public.is_staff(org_id)', 'public.is_editor(org_id)', 'public.is_editor(org_id)');
select public._make_policies('inspections',
  'public.is_staff(org_id) and public.in_site_scope(org_id, site_id)',
  'public.is_editor(org_id) or (public.is_field(org_id) and inspector_id = auth.uid())',
  'public.is_manager(org_id)');
create policy inspection_responses_read on public.inspection_responses for select to authenticated
  using (public.is_staff(org_id));
create policy inspection_responses_write on public.inspection_responses for all to authenticated
  using (public.is_editor(org_id) or exists (select 1 from public.inspections i
         where i.id = inspection_id and i.inspector_id = auth.uid() and i.status in ('scheduled','in_progress')))
  with check (public.is_editor(org_id) or exists (select 1 from public.inspections i
         where i.id = inspection_id and i.inspector_id = auth.uid() and i.status in ('scheduled','in_progress')));

-- Incidents (anyone in the org can report; visibility is restricted)
create or replace function public.is_investigator(p_incident uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.incident_investigations
                 where incident_id = p_incident and investigator_id = auth.uid());
$$;

-- Evaluated on the row itself (not via can_see_incident) so a reporter can
-- read back the row they have just inserted.
create policy incidents_read on public.incidents for select to authenticated
  using (public.is_member(org_id) and (
    reported_by = auth.uid()
    or public.is_investigator(id)
    or (is_confidential and public.can_view_confidential(org_id))
    or (not is_confidential and public.is_staff(org_id) and public.in_site_scope(org_id, site_id))));
create policy incidents_insert on public.incidents for insert to authenticated
  with check (public.is_member(org_id) and reported_by = auth.uid()
              and (not is_confidential or coalesce((select (settings->>'confidential_incidents_enabled')::boolean
                                                    from public.organisations o where o.id = org_id), false)));
create policy incidents_update on public.incidents for update to authenticated
  using (public.is_editor(org_id) and public.can_see_incident(id))
  with check (public.is_editor(org_id));
create policy incidents_delete on public.incidents for delete to authenticated
  using (public.is_manager(org_id));

do $$
declare t text;
begin
  foreach t in array array['incident_persons','incident_witnesses','incident_evidence','statutory_reports'] loop
    execute format($f$
      create policy %1$s_read on public.%1$I for select to authenticated
        using (public.can_see_incident(incident_id) and (public.is_staff(org_id)
               or exists (select 1 from public.incidents i where i.id = incident_id and i.reported_by = auth.uid())));
      create policy %1$s_insert on public.%1$I for insert to authenticated
        with check (public.can_see_incident(incident_id) and (public.is_editor(org_id)
               or exists (select 1 from public.incidents i where i.id = incident_id and i.reported_by = auth.uid()
                          and i.status = 'reported')));
      create policy %1$s_update on public.%1$I for update to authenticated
        using (public.is_editor(org_id) and public.can_see_incident(incident_id))
        with check (public.is_editor(org_id));
      create policy %1$s_delete on public.%1$I for delete to authenticated
        using (public.is_manager(org_id));
    $f$, t);
  end loop;
end $$;

create policy investigations_read on public.incident_investigations for select to authenticated
  using (public.can_see_incident(incident_id) and (public.is_staff(org_id) or investigator_id = auth.uid()));
create policy investigations_insert on public.incident_investigations for insert to authenticated
  with check (public.is_editor(org_id));
create policy investigations_update on public.incident_investigations for update to authenticated
  using (public.can_see_incident(incident_id) and (public.is_editor(org_id) or investigator_id = auth.uid()))
  with check (public.is_editor(org_id) or investigator_id = auth.uid());

create policy findings_read on public.investigation_findings for select to authenticated
  using (exists (select 1 from public.incident_investigations v
                 where v.id = investigation_id and public.can_see_incident(v.incident_id)));
create policy findings_write on public.investigation_findings for all to authenticated
  using (exists (select 1 from public.incident_investigations v where v.id = investigation_id
                 and (public.is_editor(v.org_id) or v.investigator_id = auth.uid())))
  with check (exists (select 1 from public.incident_investigations v where v.id = investigation_id
                 and (public.is_editor(v.org_id) or v.investigator_id = auth.uid())));

-- Legal compliance (platform library rows have org_id NULL)
create policy legal_req_read on public.legal_requirements for select to authenticated
  using (org_id is null or public.is_member(org_id));
create policy legal_req_platform on public.legal_requirements for all to authenticated
  using (org_id is null and public.is_platform_admin())
  with check (org_id is null and public.is_platform_admin());
create policy legal_req_org on public.legal_requirements for all to authenticated
  using (org_id is not null and public.is_manager(org_id))
  with check (org_id is not null and public.is_manager(org_id));

select public._make_policies('compliance_assessments', 'public.is_staff(org_id)', 'public.is_editor(org_id)', 'public.is_manager(org_id)');

create policy stat_rules_read on public.statutory_report_rules for select to authenticated
  using (org_id is null or public.is_member(org_id));
create policy stat_rules_platform on public.statutory_report_rules for all to authenticated
  using (org_id is null and public.is_platform_admin()) with check (org_id is null and public.is_platform_admin());
create policy stat_rules_org on public.statutory_report_rules for all to authenticated
  using (org_id is not null and public.is_manager(org_id)) with check (org_id is not null and public.is_manager(org_id));

-- Corrective actions
create policy actions_read on public.corrective_actions for select to authenticated
  using (public.is_member(org_id) and (responsible_id = auth.uid()
         or (public.is_staff(org_id) and public.in_site_scope(org_id, site_id))));
create policy actions_insert on public.corrective_actions for insert to authenticated
  with check (public.is_field(org_id));
create policy actions_update on public.corrective_actions for update to authenticated
  using (public.is_editor(org_id) or responsible_id = auth.uid())
  with check (public.is_member(org_id));
create policy actions_delete on public.corrective_actions for delete to authenticated
  using (public.is_manager(org_id) and status = 'open');

create policy action_evidence_read on public.action_evidence for select to authenticated
  using (exists (select 1 from public.corrective_actions a where a.id = action_id));  -- inherits actions_read
create policy action_evidence_insert on public.action_evidence for insert to authenticated
  with check (exists (select 1 from public.corrective_actions a where a.id = action_id
              and (public.is_field(a.org_id) or a.responsible_id = auth.uid())));
create policy action_evidence_delete on public.action_evidence for delete to authenticated
  using (uploaded_by = auth.uid() or public.is_manager(org_id));

-- Notifications: own only; users can mark read
create policy notifications_own_read on public.notifications for select to authenticated
  using (user_id = auth.uid());
create policy notifications_own_update on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- AI jobs: readable by requester or managers; written by Edge Functions only
create policy ai_jobs_read on public.ai_generation_jobs for select to authenticated
  using (user_id = auth.uid() or public.is_manager(org_id));

drop function public._make_policies(text, text, text, text);

-- ---------------------------------------------------------------------
-- Grants. RLS decides row access; these limit which operations exist.
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon;
grant select on public.subscription_plans to anon;
revoke execute on all functions in schema public from anon;
revoke execute on function public.run_daily_reminders() from public, authenticated;
revoke execute on function public.notify_user(uuid, uuid, text, text, text, text, text, uuid, text) from public, authenticated;
revoke execute on function public.notify_roles(uuid, public.org_role[], text, text, text, text, text, uuid, text) from public, authenticated;
revoke execute on function public.log_event(uuid, text, text, uuid, jsonb) from public, authenticated;
