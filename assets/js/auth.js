// OHS Hub — sign in, registration and password reset (Supabase Auth)
import { SUPABASE_URL, SUPABASE_ANON_KEY, SITE, isConfigured } from './config.js';

const status = document.getElementById('auth-status');
const show = (kind, msg) => { status.className = `alert alert--${kind}`; status.textContent = msg; status.hidden = false; };
const appUrl = new URL(SITE.appPath, location.href).href;
const page = document.body.dataset.page;

function fieldError(form, name, msg) {
  const el = form.elements[name];
  const field = el.closest('.field, .check-field');
  field.classList.toggle('has-error', Boolean(msg));
  field.querySelector('.error').textContent = msg || '';
  if (msg) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
  return !msg;
}
const emailOk = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim());
const pwOk = (v) => v.length >= 10 && /[A-Za-z]/.test(v) && /\d/.test(v);

const forms = document.querySelectorAll('form[data-auth]');
const invited = new URLSearchParams(location.search).has('invite');
if (invited) document.querySelectorAll('a[data-keep-invite]').forEach((a) => { a.href += '?invite=1'; });
if (!isConfigured()) {
  show('info', `Sign-in and registration open once the OHS Hub workspace goes live. To join the early access list, email ${SITE.enquiryEmail}.`);
  forms.forEach((f) => f.querySelectorAll('input, select, button').forEach((el) => { el.disabled = true; }));
} else {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, detectSessionInUrl: true } });
  const busy = (btn, on, label) => { btn.disabled = on; btn.textContent = on ? 'Please wait…' : label; };

  if (invited && (page === 'signin' || page === 'register')) {
    show('info', 'You have been invited to an organisation on OHS Hub. Sign in, or create an account, using the email address the invitation was sent to.');
  }

  // Already signed in → go straight to the app (except on reset page)
  if (page === 'signin' || page === 'register') {
    const { data } = await sb.auth.getSession();
    if (data.session) location.replace(appUrl);
  }

  // --- Sign in ---
  const signin = document.getElementById('signin-form');
  signin?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = [fieldError(signin, 'email', emailOk(signin.email.value) ? '' : 'Enter the email address you registered with.'),
                fieldError(signin, 'password', signin.password.value ? '' : 'Enter your password.')].every(Boolean);
    if (!ok) return;
    const btn = signin.querySelector('button[type="submit"]');
    busy(btn, true, 'Sign in');
    const { error } = await sb.auth.signInWithPassword({ email: signin.email.value.trim(), password: signin.password.value });
    if (error) {
      busy(btn, false, 'Sign in');
      show('err', error.message.includes('Email not confirmed')
        ? 'Confirm your email address first. Check your inbox for the verification link.'
        : 'That email and password combination is incorrect.');
      return;
    }
    location.replace(appUrl);
  });

  // --- Forgot password ---
  const forgot = document.getElementById('forgot-form');
  forgot?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!fieldError(forgot, 'email', emailOk(forgot.email.value) ? '' : 'Enter the email address you registered with.')) return;
    const btn = forgot.querySelector('button[type="submit"]');
    busy(btn, true, 'Send reset link');
    await sb.auth.resetPasswordForEmail(forgot.email.value.trim(), { redirectTo: new URL('reset-password.html', location.href).href });
    busy(btn, false, 'Send reset link');
    show('ok', 'If that address has an account, a reset link is on its way. The link expires in one hour.');
  });

  // --- Register ---
  const reg = document.getElementById('register-form');
  if (reg) {
    if (invited) {
      reg.company_name.closest('.field').hidden = true;
      reg.industry.closest('.field').hidden = true;
      document.querySelector('.auth-box h1').textContent = 'Create your account';
      document.querySelector('.auth-box h1 + .muted')?.remove();
    }
    const plan = new URLSearchParams(location.search).get('plan');
    if (plan) reg.plan.value = plan;
    reg.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ok = [
        fieldError(reg, 'full_name', reg.full_name.value.trim().length >= 2 ? '' : 'Enter your full name.'),
        invited ? true : fieldError(reg, 'company_name', reg.company_name.value.trim().length >= 2 ? '' : 'Enter your company name.'),
        fieldError(reg, 'email', emailOk(reg.email.value) ? '' : 'Enter a valid work email address.'),
        fieldError(reg, 'password', pwOk(reg.password.value) ? '' : 'Use at least 10 characters, including a letter and a number.'),
        fieldError(reg, 'terms', reg.terms.checked ? '' : 'Accept the terms and privacy policy to continue.'),
      ].every(Boolean);
      if (!ok) return;
      const btn = reg.querySelector('button[type="submit"]');
      busy(btn, true, 'Create account');
      const { data, error } = await sb.auth.signUp({
        email: reg.email.value.trim(),
        password: reg.password.value,
        options: {
          emailRedirectTo: appUrl,
          // Company is created in the setup wizard on first sign-in, after the email is verified.
          data: { full_name: reg.full_name.value.trim(), company_name: reg.company_name.value.trim(),
                  industry: reg.industry.value, requested_plan: reg.plan.value || 'professional' },
        },
      });
      busy(btn, false, 'Create account');
      if (error) { show('err', error.message); return; }
      if (data.session) { location.replace(appUrl); return; }
      reg.reset();
      show('ok', 'Account created. Check your inbox and click the verification link to finish setting up your company.');
    });
  }

  // --- Reset password (arrives from email link) ---
  const reset = document.getElementById('reset-form');
  if (reset) {
    let ready = false;
    sb.auth.onAuthStateChange((event) => { if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') ready = true; });
    const { data } = await sb.auth.getSession();
    if (data.session) ready = true;
    reset.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ok = [
        fieldError(reset, 'password', pwOk(reset.password.value) ? '' : 'Use at least 10 characters, including a letter and a number.'),
        fieldError(reset, 'confirm', reset.confirm.value === reset.password.value ? '' : 'The passwords do not match.'),
      ].every(Boolean);
      if (!ok) return;
      if (!ready) { show('err', 'This reset link is invalid or has expired. Request a new one from the sign-in page.'); return; }
      const btn = reset.querySelector('button[type="submit"]');
      busy(btn, true, 'Save new password');
      const { error } = await sb.auth.updateUser({ password: reset.password.value });
      busy(btn, false, 'Save new password');
      if (error) { show('err', error.message); return; }
      show('ok', 'Password saved. Taking you to your workspace…');
      setTimeout(() => location.replace(appUrl), 1500);
    });
  }
}
