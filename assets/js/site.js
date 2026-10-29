// OHS Hub — marketing site behaviour (no build step, ES module)
import { SUPABASE_URL, SUPABASE_ANON_KEY, SITE, isConfigured } from './config.js';

// ---------------------------------------------------------------------
// Mobile navigation
// ---------------------------------------------------------------------
const toggle = document.querySelector('.nav-toggle');
const nav = document.getElementById('site-nav');
if (toggle && nav) {
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Close' : 'Menu';
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.classList.contains('is-open')) { toggle.click(); toggle.focus(); }
  });
}

// ---------------------------------------------------------------------
// Risk matrix demo — same bands as the default 5×5 methodology seeded
// for every new organisation (see migration 2).
// ---------------------------------------------------------------------
const BANDS = [
  { min: 1, max: 4, label: 'Low', colour: '#7FBF83' },
  { min: 5, max: 9, label: 'Medium', colour: '#F6CF52' },
  { min: 10, max: 16, label: 'High', colour: '#F09A4E' },
  { min: 17, max: 25, label: 'Extreme', colour: '#E0596E' },
];
const LIKELIHOOD = ['Rare', 'Unlikely', 'Possible', 'Likely', 'Almost certain'];
const SEVERITY = ['Insignificant', 'Minor', 'Moderate', 'Major', 'Catastrophic'];
const bandFor = (score) => BANDS.find((b) => score >= b.min && score <= b.max);

const matrix = document.getElementById('risk-matrix');
if (matrix) {
  const out = {
    score: document.getElementById('rm-score'),
    band: document.getElementById('rm-band'),
    calc: document.getElementById('rm-calc'),
  };
  const frag = document.createDocumentFragment();
  for (let s = 5; s >= 1; s--) {
    const y = document.createElement('div');
    y.className = 'axis axis-y';
    y.textContent = `${s} ${SEVERITY[s - 1]}`;
    frag.appendChild(y);
    for (let l = 1; l <= 5; l++) {
      const score = l * s;
      const b = bandFor(score);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cell';
      btn.dataset.band = b.label;
      btn.dataset.l = l;
      btn.dataset.s = s;
      btn.textContent = score;
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-label', `Likelihood ${l} ${LIKELIHOOD[l - 1]}, severity ${s} ${SEVERITY[s - 1]}: score ${score}, ${b.label}`);
      frag.appendChild(btn);
    }
  }
  frag.appendChild(document.createElement('div'));
  for (let l = 1; l <= 5; l++) {
    const x = document.createElement('div');
    x.className = 'axis axis-x';
    x.textContent = `${l} ${LIKELIHOOD[l - 1]}`;
    frag.appendChild(x);
  }
  matrix.appendChild(frag);

  const select = (btn) => {
    matrix.querySelectorAll('.cell[aria-pressed="true"]').forEach((c) => c.setAttribute('aria-pressed', 'false'));
    btn.setAttribute('aria-pressed', 'true');
    const l = +btn.dataset.l, s = +btn.dataset.s, score = l * s, b = bandFor(score);
    out.score.textContent = score;
    out.band.innerHTML = '';
    out.band.append('Rated ');
    const tag = document.createElement('b');
    tag.textContent = b.label;
    tag.style.background = b.colour;
    if (b.label === 'Extreme') tag.style.color = '#fff';
    out.band.appendChild(tag);
    out.calc.textContent = `Likelihood ${l} (${LIKELIHOOD[l - 1]}) × severity ${s} (${SEVERITY[s - 1]})`;
  };
  matrix.addEventListener('click', (e) => {
    const btn = e.target.closest('.cell');
    if (btn) select(btn);
  });
  // Arrow-key navigation across the grid
  matrix.addEventListener('keydown', (e) => {
    const btn = e.target.closest('.cell');
    if (!btn) return;
    let l = +btn.dataset.l, s = +btn.dataset.s;
    if (e.key === 'ArrowRight') l = Math.min(5, l + 1);
    else if (e.key === 'ArrowLeft') l = Math.max(1, l - 1);
    else if (e.key === 'ArrowUp') s = Math.min(5, s + 1);
    else if (e.key === 'ArrowDown') s = Math.max(1, s - 1);
    else return;
    e.preventDefault();
    const next = matrix.querySelector(`.cell[data-l="${l}"][data-s="${s}"]`);
    next.focus();
    select(next);
  });
  select(matrix.querySelector('.cell[data-l="4"][data-s="4"]'));
}

// ---------------------------------------------------------------------
// Pricing — loaded from the subscription_plans table so prices, limits
// and features are managed in the admin screen. Falls back to the
// published plan structure (without prices) if the database is not
// connected yet.
// ---------------------------------------------------------------------
const FALLBACK_PLANS = [
  { code: 'starter', name: 'Starter', tagline: 'For a single business getting its safety records in order.', price_monthly_zar: null, max_users: 5, max_sites: 1, trial_days: 14,
    feature_list: ['One company', 'Basic OHS dashboard', 'Limited AI document generation', 'Basic risk assessments', 'Digital inspections', 'Incident reporting'] },
  { code: 'professional', name: 'Professional', tagline: 'For teams running a full OHS management system.', price_monthly_zar: null, max_users: 15, max_sites: 3, trial_days: 14, is_default_trial: true,
    feature_list: ['Everything in Starter', 'Expanded AI document generation', 'Advanced risk registers', 'Incident investigations', 'Corrective action management', 'Document approval workflows', 'Reporting and analytics'] },
  { code: 'business', name: 'Business', tagline: 'For multi-site operations with contractors.', price_monthly_zar: null, max_users: 50, max_sites: 10, trial_days: 14,
    feature_list: ['Everything in Professional', 'Multiple sites', 'Contractor management', 'Training and competency management', 'Advanced compliance reporting', 'More users and configurable permissions'] },
  { code: 'enterprise', name: 'Enterprise', tagline: 'For large or specialised organisations.', price_monthly_zar: null, max_users: null, max_sites: null, trial_days: 0,
    feature_list: ['Custom user and site limits', 'Advanced administration', 'Enhanced reporting', 'Industry-specific configuration', 'Priority support options'] },
];

const zar = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 });

function renderPlans(el, plans) {
  el.innerHTML = '';
  for (const p of plans) {
    const card = document.createElement('article');
    card.className = 'plan' + (p.is_default_trial ? ' is-featured' : '');
    if (p.is_default_trial) {
      const f = document.createElement('span');
      f.className = 'plan-flag';
      f.textContent = 'Free trial plan';
      card.appendChild(f);
    }
    const h = document.createElement('h3'); h.textContent = p.name; card.appendChild(h);
    const t = document.createElement('p'); t.className = 'tagline'; t.textContent = p.tagline || ''; card.appendChild(t);
    const price = document.createElement('p'); price.className = 'price';
    if (p.price_monthly_zar != null) {
      price.textContent = zar.format(p.price_monthly_zar) + ' ';
      const sm = document.createElement('small'); sm.textContent = 'per month, excl. VAT'; price.appendChild(sm);
    } else {
      price.textContent = 'Contact us for pricing';
      price.classList.add('is-quote');
    }
    card.appendChild(price);
    const lim = document.createElement('p'); lim.className = 'limits';
    lim.textContent = p.max_users ? `Up to ${p.max_users} users, ${p.max_sites} site${p.max_sites === 1 ? '' : 's'}` : 'Users and sites set to your needs';
    card.appendChild(lim);
    const ul = document.createElement('ul');
    for (const f of p.feature_list || []) { const li = document.createElement('li'); li.textContent = f; ul.appendChild(li); }
    card.appendChild(ul);
    const a = document.createElement('a');
    a.className = p.is_default_trial ? 'btn btn-primary btn-block' : 'btn btn-secondary btn-block';
    if (p.code === 'enterprise') { a.href = 'contact.html?topic=pricing'; a.textContent = 'Talk to us'; }
    else { a.href = `register.html?plan=${encodeURIComponent(p.code)}`; a.textContent = p.trial_days ? `Start ${p.trial_days}-day free trial` : 'Get started'; }
    card.appendChild(a);
    el.appendChild(card);
  }
}

const plansEl = document.getElementById('plans');
if (plansEl) {
  renderPlans(plansEl, FALLBACK_PLANS);
  if (isConfigured()) {
    fetch(`${SUPABASE_URL}/rest/v1/subscription_plans?select=code,name,tagline,price_monthly_zar,max_users,max_sites,trial_days,is_default_trial,feature_list&is_active=eq.true&is_public=eq.true&order=sort_order`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    }).then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((rows) => { if (Array.isArray(rows) && rows.length) renderPlans(plansEl, rows); })
      .catch(() => { /* keep fallback */ });
  }
}

// ---------------------------------------------------------------------
// Contact form → contact-submit Edge Function
// ---------------------------------------------------------------------
const form = document.getElementById('contact-form');
if (form) {
  const status = document.getElementById('contact-status');
  const submit = form.querySelector('button[type="submit"]');
  const topic = new URLSearchParams(location.search).get('topic');
  if (topic && form.topic.querySelector(`option[value="${CSS.escape(topic)}"]`)) form.topic.value = topic;

  const show = (kind, msg) => { status.className = `alert alert--${kind}`; status.textContent = msg; status.hidden = false; status.focus(); };

  if (!isConfigured()) {
    show('info', `The contact form is being connected. Until then, email us at ${SITE.enquiryEmail}.`);
    submit.disabled = true;
  }

  const rules = {
    full_name: (v) => v.trim().length >= 2 || 'Enter your full name.',
    email: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim()) || 'Enter a valid email address, for example name@company.co.za.',
    message: (v) => v.trim().length >= 10 || 'Tell us a little more (at least 10 characters).',
    consent: (_, el) => el.checked || 'Tick the box so we may use your details to reply.',
  };
  const validate = () => {
    let first = null;
    for (const [name, rule] of Object.entries(rules)) {
      const el = form.elements[name];
      const field = el.closest('.field, .check-field');
      const res = rule(el.value, el);
      const err = field.querySelector('.error');
      if (res !== true) { field.classList.add('has-error'); err.textContent = res; el.setAttribute('aria-invalid', 'true'); first ??= el; }
      else { field.classList.remove('has-error'); el.removeAttribute('aria-invalid'); }
    }
    if (first) first.focus();
    return !first;
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!isConfigured() || !validate()) return;
    submit.disabled = true;
    submit.textContent = 'Sending…';
    const data = Object.fromEntries(new FormData(form));
    data.consent = form.consent.checked;
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/contact-submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify(data),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'We could not send your message.');
      form.reset();
      show('ok', 'Message sent. We\'ll reply to the email address you gave.');
    } catch (err) {
      show('err', `${err.message} Try again, or email ${SITE.enquiryEmail}.`);
    } finally {
      submit.disabled = false;
      submit.textContent = 'Send message';
    }
  });
}

// Footer year
document.querySelectorAll('[data-year]').forEach((el) => { el.textContent = new Date().getFullYear(); });
