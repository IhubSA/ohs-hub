-- =====================================================================
-- OHS Hub — Migration 7: scheduled email flush, authenticated via Vault
-- A random secret is generated inside the database (never typed or
-- committed). pg_cron sends it to the send-notifications Edge Function,
-- which checks it through a function only the service role can call.
-- =====================================================================

select vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'ohs_cron_secret', 'Shared secret for scheduled Edge Function calls')
where not exists (select 1 from vault.secrets where name = 'ohs_cron_secret');

create or replace function public.check_cron_secret(p_secret text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from vault.decrypted_secrets
                 where name = 'ohs_cron_secret' and decrypted_secret = p_secret);
$$;
revoke execute on function public.check_cron_secret(text) from public, anon, authenticated;
grant execute on function public.check_cron_secret(text) to service_role;

-- Every 10 minutes: flush pending notification emails.
select cron.schedule('ohs-send-notifications', '*/10 * * * *', $cron$
  select net.http_post(
    url := 'https://paunnbnjxmkxgexihgnf.supabase.co/functions/v1/send-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'ohs_cron_secret')),
    body := '{}'::jsonb);
$cron$);
