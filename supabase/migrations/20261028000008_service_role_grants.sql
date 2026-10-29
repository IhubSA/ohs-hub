-- =====================================================================
-- OHS Hub — Migration 8: server-side (service_role) function access
-- Edge Functions use the service role. After migration 5 removed the
-- PUBLIC default, grant it explicit EXECUTE on public functions.
-- =====================================================================
grant execute on all functions in schema public to service_role;
alter default privileges in schema public grant execute on functions to service_role;
