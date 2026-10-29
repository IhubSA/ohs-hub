-- =====================================================================
-- OHS Hub — Migration 11: Stage 4 workflow guards
-- Approval steps are enforced in the database so no screen (or a direct
-- API call) can skip them:
--   * documents only become approved through decide_document_version()
--   * risk assessments, inspection templates and investigations need an
--     OHS manager / administrator to approve, and not their own author
--     when the organisation requires independent approval
--   * inspection compliance counts are calculated by the database
-- =====================================================================

-- Organisation setting helper
create or replace function public.org_requires_independent(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((settings->>'require_independent_approval')::boolean, true)
  from public.organisations where id = p_org;
$$;
grant execute on function public.org_requires_independent(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Controlled documents
-- ---------------------------------------------------------------------
create or replace function public.decide_document_version(p_approval uuid, p_decision text, p_comments text)
returns void language plpgsql security definer set search_path = public as $$
declare a public.document_approvals; v public.document_versions; v_pending int;
begin
  perform set_config('ohs.approving', 'on', true);
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
    -- Other reviewers on this round no longer need to act.
    update public.document_approvals set decision = 'rejected', comments = coalesce(comments, 'Closed: another reviewer rejected this version'), decided_at = now()
     where version_id = v.id and decision = 'pending';
    update public.document_versions set status = 'draft', submitted_at = null where id = v.id;
    update public.documents set status = case when current_version_id is null then 'draft'::public.document_status else 'approved'::public.document_status end
     where id = v.document_id;
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

create or replace function public.tg_doc_version_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is null or current_setting('ohs.approving', true) = 'on' then return new; end if;
  if tg_op = 'INSERT' then
    if new.status not in ('draft','in_review') then
      raise exception 'New versions start as drafts' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.status is distinct from old.status and new.status in ('approved','obsolete') then
    raise exception 'A version only becomes approved through the review process' using errcode = '42501';
  end if;
  if new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at then
    raise exception 'Approval details are recorded by the review process' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger document_versions_guard before insert or update on public.document_versions
  for each row execute function public.tg_doc_version_guard();

create or replace function public.tg_document_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is null or current_setting('ohs.approving', true) = 'on' then return new; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.current_version_id is not null then
      raise exception 'New documents start as drafts' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.current_version_id is distinct from old.current_version_id
     or (new.status = 'approved' and old.status <> 'approved' and old.current_version_id is null) then
    raise exception 'A document only becomes approved through the review process' using errcode = '42501';
  end if;
  if new.status in ('obsolete','archived') and new.status is distinct from old.status
     and not public.is_manager(new.org_id) then
    raise exception 'Only an OHS manager or administrator can retire a document' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger documents_guard before insert or update on public.documents
  for each row execute function public.tg_document_guard();

-- Submit a draft version for review in one step (sets statuses and
-- creates the approval requests). Reviewers must be eligible members.
create or replace function public.submit_document_version(p_version uuid, p_reviewers uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare v public.document_versions; r uuid;
begin
  select * into v from public.document_versions where id = p_version;
  if v.id is null or not public.is_editor(v.org_id) then
    raise exception 'Your role cannot submit documents for review' using errcode = '42501';
  end if;
  if v.status <> 'draft' then raise exception 'Only a draft can be submitted for review'; end if;
  if coalesce(array_length(p_reviewers, 1), 0) = 0 then raise exception 'Choose at least one reviewer'; end if;
  foreach r in array p_reviewers loop
    if not exists (select 1 from public.organisation_memberships m
                   where m.org_id = v.org_id and m.user_id = r and m.status = 'active'
                     and (m.role in ('org_admin','ohs_manager') or m.can_approve_documents)) then
      raise exception 'One of the chosen reviewers is not allowed to approve documents';
    end if;
    if r = v.created_by and public.org_requires_independent(v.org_id) then
      raise exception 'Your organisation requires an independent approver. The author cannot review their own document.';
    end if;
  end loop;
  -- A resubmission starts a fresh review round.
  delete from public.document_approvals where version_id = v.id;
  foreach r in array p_reviewers loop
    insert into public.document_approvals (version_id, org_id, reviewer_id, requested_by)
    values (v.id, v.org_id, r, auth.uid()) on conflict (version_id, reviewer_id) do nothing;
  end loop;
  update public.document_versions set status = 'in_review', submitted_at = now() where id = v.id;
  update public.documents set status = 'in_review' where id = v.document_id and current_version_id is null;
end $$;
grant execute on function public.submit_document_version(uuid, uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- Risk assessments: approval by a manager, independent of the assessor
-- ---------------------------------------------------------------------
create or replace function public.tg_ra_approval_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    if not public.is_manager(new.org_id) then
      raise exception 'Only an OHS manager or administrator can approve a risk assessment' using errcode = '42501';
    end if;
    if public.org_requires_independent(new.org_id) and new.assessor_id = auth.uid() then
      raise exception 'Your organisation requires an independent approver. You cannot approve your own assessment.' using errcode = '42501';
    end if;
    new.approver_id := auth.uid();
    new.approved_at := now();
  elsif tg_op = 'UPDATE' and old.status = 'approved' and new.status = 'approved'
        and (new.approver_id is distinct from old.approver_id or new.approved_at is distinct from old.approved_at) then
    raise exception 'Approval details cannot be edited' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.status = 'approved' and new.status = 'draft' then
    new.approver_id := null; new.approved_at := null;   -- reopened for revision
  end if;
  return new;
end $$;
create trigger risk_assessments_approval before insert or update on public.risk_assessments
  for each row execute function public.tg_ra_approval_guard();

-- Items of an approved assessment are locked; reopen it to change them.
create or replace function public.tg_ra_item_lock()
returns trigger language plpgsql set search_path = public as $$
declare v_status public.record_status;
begin
  select status into v_status from public.risk_assessments where id = coalesce(new.assessment_id, old.assessment_id);
  if v_status = 'approved' and auth.uid() is not null then
    raise exception 'This assessment is approved. Reopen it for revision to change its hazards.';
  end if;
  return coalesce(new, old);
end $$;
create trigger risk_items_lock before insert or update or delete on public.risk_assessment_items
  for each row execute function public.tg_ra_item_lock();

-- ---------------------------------------------------------------------
-- Inspection templates: approval by a manager; approved items locked
-- ---------------------------------------------------------------------
create or replace function public.tg_template_approval_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    if not public.is_manager(new.org_id) then
      raise exception 'Only an OHS manager or administrator can approve a checklist' using errcode = '42501';
    end if;
    new.approved_by := auth.uid();
    new.approved_at := now();
  end if;
  if tg_op = 'UPDATE' and old.status = 'approved' and new.status = 'draft' then
    new.version := old.version + 1; new.approved_by := null; new.approved_at := null;
  end if;
  return new;
end $$;
create trigger inspection_templates_approval before insert or update on public.inspection_templates
  for each row execute function public.tg_template_approval_guard();

create or replace function public.tg_template_item_lock()
returns trigger language plpgsql set search_path = public as $$
declare v_status public.record_status;
begin
  select status into v_status from public.inspection_templates where id = coalesce(new.template_id, old.template_id);
  if v_status = 'approved' and auth.uid() is not null then
    raise exception 'This checklist is approved. Start a revision to change its questions.';
  end if;
  return coalesce(new, old);
end $$;
create trigger inspection_template_items_lock before insert or update or delete on public.inspection_template_items
  for each row execute function public.tg_template_item_lock();

-- Inspections can only be started from an approved checklist.
create or replace function public.tg_inspection_template_check()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.inspection_templates where id = new.template_id and status = 'approved') then
    raise exception 'Inspections can only use an approved checklist';
  end if;
  return new;
end $$;
create trigger inspections_template_check before insert on public.inspections
  for each row execute function public.tg_inspection_template_check();

-- Compliance counts maintained by the database.
create or replace function public.tg_inspection_counts()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_id uuid := coalesce(new.inspection_id, old.inspection_id);
begin
  update public.inspections i set
    compliant_count = (select count(*) from public.inspection_responses r where r.inspection_id = v_id and r.response = 'compliant'),
    non_compliant_count = (select count(*) from public.inspection_responses r where r.inspection_id = v_id and r.response = 'non_compliant')
  where i.id = v_id;
  return null;
end $$;
create trigger inspection_responses_counts after insert or update or delete on public.inspection_responses
  for each row execute function public.tg_inspection_counts();

-- Completed inspections are read-only (responses cannot change after).
create or replace function public.tg_inspection_response_lock()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  select status into v_status from public.inspections where id = coalesce(new.inspection_id, old.inspection_id);
  if v_status in ('completed','closed','cancelled') and auth.uid() is not null then
    raise exception 'This inspection is completed and can no longer be changed';
  end if;
  return coalesce(new, old);
end $$;
create trigger inspection_responses_lock before insert or update or delete on public.inspection_responses
  for each row execute function public.tg_inspection_response_lock();

-- ---------------------------------------------------------------------
-- Investigations: approval by a manager who is not the investigator
-- ---------------------------------------------------------------------
create or replace function public.tg_investigation_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if new.status = 'approved' and old.status is distinct from 'approved' then
    if not public.is_manager(new.org_id) then
      raise exception 'Only an OHS manager or administrator can approve an investigation' using errcode = '42501';
    end if;
    if new.investigator_id = auth.uid() then
      raise exception 'An investigation must be approved by someone other than the investigator' using errcode = '42501';
    end if;
    new.reviewer_id := auth.uid();
    new.approved_at := now();
  end if;
  if new.status = 'submitted' and old.status is distinct from 'submitted' then
    new.submitted_at := now();
  end if;
  if new.status = 'returned' and old.status is distinct from 'returned' and not public.is_manager(new.org_id) then
    raise exception 'Only an OHS manager or administrator can return an investigation' using errcode = '42501';
  end if;
  -- Non-editor investigators cannot reassign the investigation
  if new.investigator_id is distinct from old.investigator_id and not public.is_editor(new.org_id) then
    raise exception 'Only an editor can reassign the investigator' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger investigations_guard before update on public.incident_investigations
  for each row execute function public.tg_investigation_guard();

-- Closing an incident with an investigation requires it to be approved.
create or replace function public.tg_incident_close_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'closed' and old.status is distinct from 'closed' then
    if exists (select 1 from public.incident_investigations where incident_id = new.id and status <> 'approved') then
      raise exception 'Approve the investigation before closing this incident';
    end if;
    if not public.is_manager(new.org_id) and auth.uid() is not null then
      raise exception 'Only an OHS manager or administrator can close an incident' using errcode = '42501';
    end if;
    new.closed_at := now();
  end if;
  return new;
end $$;
create trigger incidents_close_guard before update on public.incidents
  for each row execute function public.tg_incident_close_guard();

-- Investigation milestones move the incident status along.
create or replace function public.tg_investigation_incident_status()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.incidents set status = case
      when new.status in ('assigned','in_progress','returned') then 'under_investigation'
      when new.status = 'submitted' then 'awaiting_approval'
      else status end
  where id = new.incident_id and status <> 'closed';
  return new;
end $$;
create trigger investigations_incident_status after insert or update of status on public.incident_investigations
  for each row execute function public.tg_investigation_incident_status();

-- Notify managers when an investigation is submitted, and the
-- investigator when it is returned or approved.
create or replace function public.tg_notify_investigation_status()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_ref text;
begin
  if new.status is distinct from old.status then
    select reference into v_ref from public.incidents where id = new.incident_id;
    if new.status = 'submitted' then
      perform public.notify_roles(new.org_id, array['org_admin','ohs_manager']::public.org_role[], 'investigation.submitted',
        'Investigation ready for review: ' || v_ref, null, 'app/#/incidents/' || new.incident_id, 'incident', new.incident_id,
        'investigation.submitted:' || new.id || ':' || coalesce(new.submitted_at::text, now()::text));
    elsif new.status in ('returned','approved') then
      perform public.notify_user(new.org_id, new.investigator_id, 'investigation.' || new.status,
        'Investigation ' || new.status || ': ' || v_ref, new.reviewer_comments, 'app/#/incidents/' || new.incident_id,
        'incident', new.incident_id, 'investigation.' || new.status || ':' || new.id || ':' || now()::text);
    end if;
  end if;
  return new;
end $$;
create trigger investigations_notify_status after update of status on public.incident_investigations
  for each row execute function public.tg_notify_investigation_status();

-- Notify the verifying roles when an action is waiting for verification.
create or replace function public.tg_notify_action_verification()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'awaiting_verification' and old.status is distinct from 'awaiting_verification' then
    perform public.notify_roles(new.org_id, array['ohs_manager','safety_officer']::public.org_role[], 'action.awaiting_verification',
      'Action ready for verification: ' || new.reference, new.title, 'app/#/actions/' || new.id, 'corrective_action', new.id,
      'action.verify:' || new.id || ':' || now()::text);
  end if;
  return new;
end $$;
create trigger corrective_actions_notify_verify after update of status on public.corrective_actions
  for each row execute function public.tg_notify_action_verification();

revoke execute on function public.tg_doc_version_guard() from public, anon, authenticated;

-- Security advisor: trigger-only function must not be callable through the API.
revoke execute on function public.handle_user_email_change() from public, anon, authenticated;
