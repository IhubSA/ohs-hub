-- =====================================================================
-- OHS Hub — Migration 9: profile email integrity
-- user_profiles.email is used to address notification emails, so users
-- must not be able to change it directly. It always mirrors the verified
-- sign-in email in auth.users.
-- =====================================================================
create or replace function public.tg_profile_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null and new.email is distinct from old.email then
    new.email := old.email;
  end if;
  if auth.uid() is not null and new.default_org_id is not null
     and new.default_org_id is distinct from old.default_org_id
     and not public.is_member(new.default_org_id) then
    raise exception 'You are not a member of that organisation' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger user_profiles_guard before update on public.user_profiles
  for each row execute function public.tg_profile_guard();

create or replace function public.handle_user_email_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email is distinct from old.email then
    update public.user_profiles set email = new.email where id = new.id;
  end if;
  return new;
end $$;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.handle_user_email_change();
