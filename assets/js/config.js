// OHS Hub — public configuration.
// ONLY the project URL and the publishable (anon) key belong here. Both are
// safe in the browser because Row Level Security protects the data.
// NEVER put the service_role key, Resend key or AI key in this file.
//
// OHS Hub Supabase project (ref paunnbnjxmkxgexihgnf, region eu-west-2).
export const SUPABASE_URL = 'https://paunnbnjxmkxgexihgnf.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBhdW5uYm5qeG1reGdleGloZ25mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMyMTQyOTgsImV4cCI6MjEwODc5MDI5OH0.9r2O2SAmduXdzAKfQe3iUyFldQswkg9bEhfhyo5Sn6U';

export const SITE = {
  name: 'OHS Hub',
  enquiryEmail: 'enquiries@ihub-sa.co.za',
  appPath: 'app/',
};

export const isConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
