// Supabase client for the app. Only the public URL and anon key are used
// in the browser; every row is protected by Row Level Security.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../../assets/js/config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

// Throw on error so callers can use try/catch.
export async function q(promise) {
  const { data, error, count } = await promise;
  if (error) throw error;
  return count != null && data == null ? count : data;
}
