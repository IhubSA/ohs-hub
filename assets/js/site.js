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
  { code: 'free', name: 'Free', tagline: 'For one person getting the safety basics in place.', price_monthly_zar: 0, price_annual_zar: 0, max_users: 1, max_sites: 1, max_contractors: 0, ai_generations_per_month: 2, storage_mb: 100, trial_days: 0,
    feature_list: ['Incident reporting and investigation', 'Corrective actions', 'Checklists and inspections', 'Risk assessments', 'SOPs and safety documents', 'AI drafting', 'Emergency numbers and drills', 'Dashboard'] },
  { code: 'smme', name: 'SMME', tagline: 'For small teams running their safety system together.', price_monthly_zar: 299, price_annual_zar: 2990, price_extra_user_zar: 79, max_users: 4, max_sites: 1, max_contractors: 0, ai_generations_per_month: 5, storage_mb: 1024, trial_days: 14,
    feature_list: ['Incident reporting and investigation', 'Corrective actions', 'Checklists and inspections', 'Risk assessments', 'SOPs and safety documents', 'AI drafting', 'Emergency numbers and drills', 'Dashboard', 'Independent document approval', 'Risk register', 'Monthly and quarterly reports'] },
  { code: 'business', name: 'Business', tagline: 'For growing businesses with training and equipment to manage.', price_monthly_zar: 899, price_annual_zar: 8990, price_extra_user_zar: 79, max_users: 10, max_sites: 3, max_contractors: 0, ai_generations_per_month: 20, storage_mb: 5120, trial_days: 14, is_default_trial: true,
    feature_list: ['Incident reporting and investigation', 'Corrective actions', 'Checklists and inspections', 'Risk assessments', 'SOPs and safety documents', 'AI drafting', 'Emergency numbers and drills', 'Dashboard', 'Independent document approval', 'Risk register', 'Monthly and quarterly reports', 'Training matrix and competency', 'Equipment and PPE registers', 'Multiple sites'] },
  { code: 'enterprise', name: 'Enterprise', tagline: 'For multi-site organisations with legal and contractor obligations.', price_monthly_zar: 1999, price_annual_zar: 19990, price_extra_user_zar: 79, max_users: 25, max_sites: 10, max_contractors: 10, ai_generations_per_month: 50, storage_mb: 20480, trial_days: 14,
    feature_list: ['Incident reporting and investigation', 'Corrective actions', 'Checklists and inspections', 'Risk assessments', 'SOPs and safety documents', 'AI drafting', 'Emergency numbers and drills', 'Dashboard', 'Independent document approval', 'Risk register', 'Monthly and quarterly reports', 'Training matrix and competency', 'Equipment and PPE registers', 'Multiple sites', 'Legal register with verification', 'Contractor management'] },
  { code: 'principal_contractor', name: 'Principal Contractor', tagline: 'For principal contractors managing many subcontractors across sites.', price_monthly_zar: 3999, price_annual_zar: 39990, price_extra_user_zar: 79, max_users: 50, max_sites: null, max_contractors: null, ai_generations_per_month: 150, storage_mb: 51200, trial_days: 14,
    feature_list: ['Incident reporting and investigation', 'Corrective actions', 'Checklists and inspections', 'Risk assessments', 'SOPs and safety documents', 'AI drafting', 'Emergency numbers and drills', 'Dashboard', 'Independent document approval', 'Risk register', 'Monthly and quarterly reports', 'Training matrix and competency', 'Equipment and PPE registers', 'Multiple sites', 'Legal register with verification', 'Contractor management', 'Unlimited contractors and sites', 'Priority support'] },
];
let PRICING = { vat: 'none', annual_note: '2 months free' };
const VAT_TEXT = { excl: 'excl. VAT', incl: 'incl. VAT', none: '' };

const zar = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 });
const storageText = (mb) => (mb == null ? 'Unlimited storage' : mb >= 1024 ? `${Math.round(mb / 1024)} GB storage` : `${mb} MB storage`);
let billing = 'monthly';

function renderPlans(el, plans) {
  el.innerHTML = '';
  el.classList.toggle('plans--5', plans.length >= 5);
  const vat = VAT_TEXT[PRICING.vat] ?? '';
  for (const p of plans) {
    const card = document.createElement('article');
    card.className = 'plan' + (p.is_default_trial ? ' is-featured' : '');
    if (p.is_default_trial) {
      const f = document.createElement('span');
      f.className = 'plan-flag';
      f.textContent = 'Most popular';
      card.appendChild(f);
    }
    const h = document.createElement('h3'); h.textContent = p.name; card.appendChild(h);
    const t = document.createElement('p'); t.className = 'tagline'; t.textContent = p.tagline || ''; card.appendChild(t);
    const price = document.createElement('p'); price.className = 'price';
    const free = Number(p.price_monthly_zar) === 0;
    const annual = billing === 'annual' && p.price_annual_zar != null;
    if (free) {
      price.textContent = 'Free';
    } else if (p.price_monthly_zar != null) {
      price.textContent = zar.format(annual ? p.price_annual_zar : p.price_monthly_zar) + ' ';
      const sm = document.createElement('small'); sm.textContent = `${annual ? 'per year' : 'per month'}${vat ? ', ' + vat : ''}`; price.appendChild(sm);
    } else {
      price.textContent = 'Contact us for pricing';
      price.classList.add('is-quote');
    }
    card.appendChild(price);
    if (!free && annual && p.price_monthly_zar) {
      const save = document.createElement('p'); save.className = 'saving';
      save.textContent = `Works out at ${zar.format(p.price_annual_zar / 12)} a month${PRICING.annual_note ? ' · ' + PRICING.annual_note : ''}`;
      card.appendChild(save);
    }
    const lim = document.createElement('ul'); lim.className = 'limits';
    const items = [
      p.max_users ? `${p.max_users} user${p.max_users === 1 ? '' : 's'}` : 'Users to suit you',
      p.max_sites == null ? 'Unlimited sites' : `${p.max_sites} site${p.max_sites === 1 ? '' : 's'}`,
      p.ai_generations_per_month == null ? 'Unlimited AI drafts' : `${p.ai_generations_per_month} AI drafts a month`,
      p.max_contractors === 0 ? null : p.max_contractors == null ? 'Unlimited contractors' : `Up to ${p.max_contractors} contractors`,
      storageText(p.storage_mb),
      p.price_extra_user_zar != null && !free ? `Extra users ${zar.format(p.price_extra_user_zar)} each a month` : null,
    ].filter(Boolean);
    for (const x of items) { const li = document.createElement('li'); li.textContent = x; lim.appendChild(li); }
    card.appendChild(lim);
    const ul = document.createElement('ul'); ul.className = 'features';
    for (const f of p.feature_list || []) { const li = document.createElement('li'); li.textContent = f; ul.appendChild(li); }
    card.appendChild(ul);
    const a = document.createElement('a');
    a.className = p.is_default_trial ? 'btn btn-primary btn-block' : 'btn btn-secondary btn-block';
    a.href = `register.html?plan=${encodeURIComponent(p.code)}`;
    a.textContent = free ? 'Start free' : p.trial_days ? `Try free for ${p.trial_days} days` : 'Get started';
    card.appendChild(a);
    el.appendChild(card);
  }
  const badge = document.getElementById('annual-badge');
  if (badge) {
    badge.hidden = !PRICING.annual_note;
    badge.replaceChildren('Pay yearly, get ', Object.assign(document.createElement('strong'), { textContent: PRICING.annual_note || '' }));
  }
  const note = document.getElementById('pricing-note');
  if (note) note.textContent = [vat ? (PRICING.vat === 'incl' ? 'Prices include VAT.' : 'Prices exclude VAT.') : '', 'All prices are in South African rand.'].filter(Boolean).join(' ');
}

const plansEl = document.getElementById('plans');
if (plansEl) {
  let current = FALLBACK_PLANS;
  const toggle = document.getElementById('billing-toggle');
  toggle?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-billing]'); if (!b) return;
    billing = b.dataset.billing;
    toggle.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderPlans(plansEl, current);
  });
  renderPlans(plansEl, current);
  if (isConfigured()) {
    const hdr = { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } };
    Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/subscription_plans?select=code,name,tagline,price_monthly_zar,price_annual_zar,price_extra_user_zar,max_users,max_sites,max_contractors,ai_generations_per_month,storage_mb,trial_days,is_default_trial,feature_list&is_active=eq.true&is_public=eq.true&order=sort_order`, hdr)
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
      fetch(`${SUPABASE_URL}/rest/v1/platform_settings?select=value&key=eq.pricing`, hdr).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    ]).then(([rows, settings]) => {
      if (settings?.[0]?.value) PRICING = { ...PRICING, ...settings[0].value };
      if (Array.isArray(rows) && rows.length) current = rows;
      renderPlans(plansEl, current);
    }).catch(() => { /* keep fallback */ });
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
