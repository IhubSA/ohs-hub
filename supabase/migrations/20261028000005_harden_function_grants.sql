-- =====================================================================
-- OHS Hub — Migration 5: function privilege hardening
-- Postgres grants EXECUTE on new functions to PUBLIC by default. Remove
-- that, then grant back only what signed-in users genuinely need.
-- Trigger functions need no EXECUTE grant to fire.
-- =====================================================================

revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- RLS helper functions (evaluated with the caller's privileges inside
-- policies). They only answer questions about the caller's OWN access.
grant execute on function public.is_platform_admin() to authenticated;
grant execute on function public.my_role(uuid) to authenticated;
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.has_role(uuid, public.org_role[]) to authenticated;
grant execute on function public.is_manager(uuid) to authenticated;
grant execute on function public.is_editor(uuid) to authenticated;
grant execute on function public.is_field(uuid) to authenticated;
grant execute on function public.is_staff(uuid) to authenticated;
grant execute on function public.in_site_scope(uuid, uuid) to authenticated;
grant execute on function public.can_view_confidential(uuid) to authenticated;
grant execute on function public.can_see_incident(uuid) to authenticated;
grant execute on function public.can_see_document(uuid) to authenticated;
grant execute on function public.is_investigator(uuid) to authenticated;
grant execute on function public.storage_org(text) to authenticated;
grant execute on function public.risk_band(uuid, integer) to authenticated;
grant execute on function public.org_limit(uuid, text) to authenticated;
grant execute on function public.org_has_feature(uuid, text) to authenticated;

-- Application RPCs (each checks auth.uid() and membership itself)
grant execute on function public.create_organisation(text, text, text, text) to authenticated;
grant execute on function public.accept_invitation(text) to authenticated;
grant execute on function public.decide_document_version(uuid, text, text) to authenticated;
grant execute on function public.next_reference(uuid, text) to authenticated;

-- Public plans: anonymous visitors must not need any function to read them.
drop policy plans_public_read on public.subscription_plans;
create policy plans_public_read_anon on public.subscription_plans for select to anon
  using (is_active and is_public);
create policy plans_public_read_auth on public.subscription_plans for select to authenticated
  using ((is_active and is_public) or public.is_platform_admin());
