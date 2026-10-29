// Platform administration (iHubSA only): customer organisations and their
// plans, plan prices, limits and features, the shared legal library, and
// platform settings. Platform administrators see organisation metadata
// only; the database gives them no access to customers' safety records.
import { sb, q } from '../sb.js';
import { h, modalForm, toast, errMsg, emptyState, fmtDate, fmtDateTime, opt, INDUSTRIES } from '../ui.js';
import { statusBadge, kv, setQuery, VERIFICATION, REQ_KIND } from '../data.js';

const FEATURES = {
  ai: 'AI drafting', documents: 'Documents', incidents: 'Incidents', inspections: 'Inspections', risk_assessments: 'Risk assessments',
  risk_register: 'Risk register', actions: 'Corrective actions', investigations: 'Investigations', approvals: 'Approvals', reports: 'Reports',
  legal: 'Legal register', training: 'Training', contractors: 'Contractor documents', equipment: 'Equipment & PPE',
  multi_site: 'Multiple sites', enterprise_admin: 'Enterprise administration',
};
const SUB_STATUS = { trialing: 'Free trial', active: 'Active', past_due: 'Payment overdue', cancelled: 'Cancelled', expired: 'Expired' };
const BILLING = { not_configured: 'Not set up', pending: 'Pending', paid: 'Paid', overdue: 'Overdue', waived: 'Waived' };

export async function render(view, ctx) {
  if (!ctx.state.isPlatformAdmin) { view.append(h('div', { class: 'card' }, emptyState('Not available', 'This page is for iHubSA platform administrators.'))); return; }
  const tab = ctx.query.get('t') || 'orgs';
  view.append(h('div', { class: 'page-title' }, h('div', {}, h('h1', {}, 'Platform admin'), h('p', {}, 'iHubSA only. Customer organisations, plans, the shared legal library and platform settings.'))));
  view.append(h('div', { class: 'tabs', role: 'tablist' }, [['orgs', 'Organisations'], ['plans', 'Plans'], ['legal', 'Legal library'], ['settings', 'Settings']].map(([k, l]) =>
    h('button', { role: 'tab', 'aria-selected': String(k === tab), onclick: () => setQuery('admin', { t: k === 'orgs' ? '' : k }) }, l))));
  const panel = h('div'); view.append(panel);
  if (tab === 'plans') return plans(panel, ctx);
  if (tab === 'legal') return library(panel, ctx);
  if (tab === 'settings') return settings(panel, ctx);
  return orgs(panel, ctx);
}

async function orgs(panel, { reload }) {
  const [rows, planList] = await Promise.all([q(sb.rpc('platform_organisations')), q(sb.from('subscription_plans').select('id, code, name').order('sort_order'))]);
  const count = (s) => rows.filter((r) => r.status === s).length;
  panel.append(h('div', { class: 'stats' },
    [['Organisations', rows.length], ['On free trial', count('trialing')], ['Active', count('active')], ['Users', rows.reduce((n, r) => n + Number(r.members), 0)]].map(([l, n]) =>
      h('div', { class: 'stat' }, h('div', { class: 'n' }, String(n)), h('div', { class: 'l' }, l)))));
  const card = h('div', { class: 'card' }); panel.append(card);
  if (!rows.length) { card.append(emptyState('No organisations yet', 'Customers appear here when they register.')); return; }
  card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, ['Organisation', 'Plan', 'Status', 'Users', 'Sites', 'AI this month', 'Joined', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((r) => h('tr', {},
      h('td', { 'data-label': 'Organisation' }, h('strong', {}, r.name), h('div', { class: 'muted small' }, [INDUSTRIES[r.industry] || r.industry, r.province].filter(Boolean).join(', '))),
      h('td', { 'data-label': 'Plan' }, r.plan_name || '—'),
      h('td', { 'data-label': 'Status' }, statusBadge(r.status === 'active' ? 'approved' : r.status === 'trialing' ? 'in_review' : 'returned', { approved: SUB_STATUS[r.status], in_review: SUB_STATUS[r.status], returned: SUB_STATUS[r.status] }),
        r.status === 'trialing' && r.trial_ends_at ? h('div', { class: 'muted small' }, `until ${fmtDate(r.trial_ends_at)}`) : null,
        h('div', { class: 'muted small' }, `Billing: ${BILLING[r.billing_status] || '—'}`)),
      h('td', { 'data-label': 'Users' }, String(r.members)),
      h('td', { 'data-label': 'Sites' }, String(r.sites)),
      h('td', { 'data-label': 'AI this month' }, String(r.ai_used)),
      h('td', { 'data-label': 'Joined' }, fmtDate(r.created_at)),
      h('td', { class: 'actions' }, h('button', { class: 'btn btn-secondary btn-sm', onclick: async () => { if (await subForm(r, planList)) { toast('Subscription updated.'); reload(); } } }, 'Change plan'))))))));
  card.append(h('p', { class: 'muted small', style: 'margin:12px 0 0' }, 'Only organisation details and usage are shown here. Customers\' safety records are not visible to platform administrators.'));
}

function subForm(r, planList) {
  return modalForm({
    title: `Plan for ${r.name}`,
    submitLabel: 'Save',
    fields: [
      { name: 'plan_id', label: 'Plan', type: 'select', value: planList.find((p) => p.code === r.plan_code)?.id || '', options: planList.map((p) => [p.id, p.name]) },
      { name: 'status', label: 'Status', type: 'select', value: r.status || 'trialing', options: opt(SUB_STATUS) },
      { name: 'billing_status', label: 'Billing', type: 'select', value: r.billing_status || 'not_configured', options: opt(BILLING) },
      { name: 'trial_ends_at', label: 'Trial ends', type: 'date', value: r.trial_ends_at ? r.trial_ends_at.slice(0, 10) : '' },
      { name: 'override_max_users', label: 'Custom user limit', type: 'number', value: r.override_max_users ?? '', hint: 'Leave blank to use the plan limit.' },
      { name: 'override_max_sites', label: 'Custom site limit', type: 'number', value: r.override_max_sites ?? '' },
      { name: 'override_ai_generations', label: 'Custom AI drafts per month', type: 'number', value: r.override_ai_generations ?? '' },
    ],
    onSubmit: (v) => {
      const n = (x) => (x === '' ? null : Number(x));
      return q(sb.from('organisation_subscriptions').update({ plan_id: v.plan_id, status: v.status, billing_status: v.billing_status,
        trial_ends_at: v.status === 'trialing' && v.trial_ends_at ? `${v.trial_ends_at}T23:59:59+02:00` : null,
        override_max_users: n(v.override_max_users), override_max_sites: n(v.override_max_sites), override_ai_generations: n(v.override_ai_generations) }).eq('org_id', r.org_id).select('id').single());
    },
  });
}

async function plans(panel, { reload }) {
  const rows = await q(sb.from('subscription_plans').select('*').order('sort_order'));
  panel.append(h('p', { class: 'muted' }, 'Prices left blank show as "Contact us for pricing" on the website. Changes apply immediately.'));
  for (const p of rows) {
    const feats = Object.entries(p.features || {}).filter(([, on]) => on).map(([k]) => FEATURES[k] || k);
    panel.append(h('div', { class: 'site-block' },
      h('header', {}, h('div', {}, h('h3', {}, p.name, !p.is_active ? ' (inactive)' : !p.is_public ? ' (hidden)' : '', p.is_default_trial ? ' · trial plan' : ''),
        h('div', { class: 'meta' }, p.price_monthly_zar != null ? `R${Number(p.price_monthly_zar).toLocaleString('en-ZA')} a month` : 'Contact us for pricing',
          ` · ${p.max_users ?? 'Unlimited'} users · ${p.max_sites ?? 'Unlimited'} sites · ${p.ai_generations_per_month ?? 'Unlimited'} AI drafts a month`)),
        h('button', { class: 'btn btn-secondary btn-sm', onclick: async () => { if (await planForm(p)) { toast('Plan saved.'); reload(); } } }, 'Edit')),
      h('div', { style: 'padding:10px 16px' }, h('p', { class: 'small', style: 'margin:0' }, feats.join(', ') || 'No features'))));
  }
}

function planForm(p) {
  const n = (x) => (x === '' ? null : Number(x));
  return modalForm({
    title: `Edit ${p.name}`,
    submitLabel: 'Save plan',
    fields: [
      { name: 'name', label: 'Name', required: true, value: p.name, maxlength: 60 },
      { name: 'tagline', label: 'Tagline', value: p.tagline, maxlength: 160 },
      { name: 'price_monthly_zar', label: 'Price per month (R, excl. VAT)', type: 'number', value: p.price_monthly_zar ?? '', hint: 'Blank shows "Contact us for pricing".' },
      { name: 'price_annual_zar', label: 'Price per year (R, excl. VAT)', type: 'number', value: p.price_annual_zar ?? '' },
      { name: 'max_users', label: 'User limit', type: 'number', value: p.max_users ?? '', hint: 'Blank = unlimited.' },
      { name: 'max_sites', label: 'Site limit', type: 'number', value: p.max_sites ?? '' },
      { name: 'ai_generations_per_month', label: 'AI drafts per month', type: 'number', value: p.ai_generations_per_month ?? '' },
      { name: 'trial_days', label: 'Trial length (days)', type: 'number', value: p.trial_days },
      { name: 'features', label: 'Included modules', type: 'checks', value: Object.entries(p.features || {}).filter(([, v]) => v).map(([k]) => k), options: opt(FEATURES) },
      { name: 'feature_list', label: 'Bullet points for the pricing page (one per line)', type: 'textarea', rows: 5, value: (p.feature_list || []).join('\n') },
      { name: 'is_public', label: 'Show on the pricing page', type: 'checkbox', value: p.is_public },
      { name: 'is_active', label: 'Available to new customers', type: 'checkbox', value: p.is_active },
    ],
    onSubmit: (v) => {
      for (const k of ['price_monthly_zar', 'price_annual_zar', 'max_users', 'max_sites', 'ai_generations_per_month', 'trial_days']) {
        if (v[k] !== '' && !(Number(v[k]) >= 0)) throw new Error('Numbers must be zero or more.');
      }
      return q(sb.from('subscription_plans').update({ name: v.name, tagline: v.tagline || null, price_monthly_zar: n(v.price_monthly_zar), price_annual_zar: n(v.price_annual_zar),
        max_users: n(v.max_users), max_sites: n(v.max_sites), ai_generations_per_month: n(v.ai_generations_per_month), trial_days: n(v.trial_days) ?? 14,
        features: Object.fromEntries(v.features.map((k) => [k, true])), feature_list: v.feature_list.split('\n').map((s) => s.trim()).filter(Boolean),
        is_public: v.is_public, is_active: v.is_active, updated_at: new Date().toISOString() }).eq('id', p.id));
    },
  });
}

async function library(panel, { state, reload }) {
  const [fws, reqs] = await Promise.all([
    q(sb.from('legal_frameworks').select('*').order('title')),
    q(sb.from('legal_requirements').select('*').is('org_id', null).order('reference')),
  ]);
  const fwMap = new Map(fws.map((f) => [f.id, f]));
  panel.append(h('div', { class: 'alert alert--info', style: 'margin-bottom:16px' },
    'Entries here are shared with every customer. Each must be verified against the official text by a second platform administrator before it shows as "Verified". You can\'t verify an entry you captured yourself.'));
  panel.append(h('div', { class: 'btn-row', style: 'margin-bottom:14px' },
    h('button', { class: 'btn btn-primary', onclick: async () => { if (await reqForm(fws)) { toast('Requirement added.'); reload(); } } }, 'Add requirement'),
    h('button', { class: 'btn btn-secondary', onclick: async () => { if (await fwForm()) { toast('Source added.'); reload(); } } }, 'Add Act, regulation or standard')));
  panel.append(h('div', { class: 'card' }, h('h2', {}, 'Acts, regulations and standards'), h('ul', { class: 'file-list' }, fws.map((f) => h('li', {},
    h('span', {}, h('strong', {}, f.title), h('br'), h('span', { class: 'muted small' }, `${f.code} · ${f.kind.replace('_', ' ')}${f.source_url ? '' : ''}`)),
    h('span', {}, f.source_url ? h('a', { href: f.source_url, target: '_blank', rel: 'noopener' }, 'Official source') : null, ' ',
      h('button', { class: 'btn-link', onclick: async () => { if (await fwForm(f)) { toast('Saved.'); reload(); } } }, 'Edit')))))));
  const rc = h('div', { class: 'card' }, h('h2', {}, 'Shared requirements'));
  if (!reqs.length) rc.append(h('p', { class: 'muted' }, 'No shared requirements yet.'));
  else rc.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, ['Requirement', 'Source', 'Status', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, reqs.map((r) => h('tr', {},
      h('td', { 'data-label': 'Requirement', class: 'wide-col' }, h('strong', {}, r.title ? `${r.reference}: ${r.title}` : r.reference), h('div', { class: 'small' }, r.requirement.slice(0, 180) + (r.requirement.length > 180 ? '…' : ''))),
      h('td', { 'data-label': 'Source' }, fwMap.get(r.framework_id)?.title || REQ_KIND[r.requirement_kind]),
      h('td', { 'data-label': 'Status' }, statusBadge(r.verification_status, VERIFICATION), r.verified_at ? h('div', { class: 'muted small' }, fmtDateTime(r.verified_at)) : null),
      h('td', { class: 'actions' },
        h('button', { class: 'btn-link', onclick: async () => { if (await reqForm(fws, r)) { toast('Saved.'); reload(); } } }, 'Edit'),
        r.verification_status !== 'verified' && r.created_by !== state.user.id ? h('button', { class: 'btn-link', onclick: async () => {
          if (await modalForm({ title: 'Verify requirement', submitLabel: 'Mark as verified',
            fields: [{ name: 'notes', label: 'How did you verify it?', type: 'textarea', required: true, rows: 3, maxlength: 2000 }],
            onSubmit: (v) => q(sb.rpc('verify_legal_requirement', { p_id: r.id, p_notes: v.notes })) })) { toast('Verified.'); reload(); }
        } }, 'Verify') : null)))))));
  panel.append(rc);
}

function fwForm(f = {}) {
  return modalForm({
    title: f.id ? 'Edit source' : 'Add an Act, regulation or standard',
    submitLabel: 'Save',
    fields: [
      { name: 'title', label: 'Title', required: true, value: f.title, maxlength: 200, placeholder: 'e.g. Construction Regulations, 2014' },
      { name: 'code', label: 'Short code', required: true, value: f.code, maxlength: 40, placeholder: 'e.g. CR-2014', validate: (v) => (!/^[A-Za-z0-9-]+$/.test(v) ? 'Letters, numbers and dashes only.' : '') },
      { name: 'kind', label: 'Type', type: 'select', value: f.kind || 'regulation', options: [['act', 'Act'], ['regulation', 'Regulation'], ['standard', 'Standard'], ['recommended_practice', 'Recommended practice']] },
      { name: 'sector', label: 'Sector', value: f.sector || 'general', maxlength: 60 },
      { name: 'source_url', label: 'Link to the official text', type: 'url', value: f.source_url, maxlength: 500 },
      { name: 'is_active', label: 'In use', type: 'checkbox', value: f.is_active ?? true },
    ],
    onSubmit: (v) => {
      const row = { title: v.title, code: v.code.toUpperCase(), kind: v.kind, sector: v.sector || 'general', source_url: v.source_url || null, is_active: v.is_active };
      return f.id ? q(sb.from('legal_frameworks').update(row).eq('id', f.id)) : q(sb.from('legal_frameworks').insert(row));
    },
  });
}

function reqForm(fws, r = {}) {
  return modalForm({
    title: r.id ? 'Edit shared requirement' : 'Add a shared requirement',
    intro: r.verification_status === 'verified' ? 'Changing the wording sends it back to "Needs verification" for every customer.' : null,
    submitLabel: 'Save',
    fields: [
      { name: 'framework_id', label: 'Act, regulation or standard', type: 'select', required: true, value: r.framework_id || '', options: [['', 'Choose'], ...fws.map((f) => [f.id, f.title])] },
      { name: 'requirement_kind', label: 'Type', type: 'select', value: r.requirement_kind || 'legislation', options: [['legislation', 'Legislation'], ['recommended_practice', 'Recommended practice']] },
      { name: 'reference', label: 'Section or clause', required: true, value: r.reference, maxlength: 120 },
      { name: 'title', label: 'Short title', value: r.title, maxlength: 200 },
      { name: 'requirement', label: 'Wording from the official text', type: 'textarea', required: true, rows: 5, value: r.requirement, maxlength: 5000 },
      { name: 'applicability', label: 'Applies to', value: r.applicability, maxlength: 500 },
      { name: 'source_reference', label: 'Source (gazette or link)', value: r.source_reference, maxlength: 500 },
      { name: 'effective_date', label: 'In force from', type: 'date', value: r.effective_date || '' },
    ],
    onSubmit: (v) => {
      const row = { framework_id: v.framework_id, requirement_kind: v.requirement_kind, reference: v.reference, title: v.title || null, requirement: v.requirement,
        applicability: v.applicability || null, source_reference: v.source_reference || null, effective_date: v.effective_date || null };
      return r.id ? q(sb.from('legal_requirements').update(row).eq('id', r.id)) : q(sb.from('legal_requirements').insert({ ...row, org_id: null }));
    },
  });
}

async function settings(panel, { reload }) {
  const ai = await q(sb.from('platform_settings').select('value, updated_at').eq('key', 'ai').maybeSingle());
  const v = ai?.value || {};
  panel.append(h('div', { class: 'card' }, h('h2', {}, 'AI drafting'),
    kv([['Status', v.enabled ? statusBadge('approved', { approved: 'Switched on' }) : statusBadge('returned', { returned: 'Switched off' })],
      ['Provider', v.provider || 'anthropic'], ['Model', v.model || '—'], ['Last changed', ai?.updated_at ? fmtDateTime(ai.updated_at) : null]]),
    h('p', { class: 'muted small' }, 'Switching AI off hides the AI buttons for every customer straight away. The provider key itself is kept as a Supabase secret and is never shown here.'),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-secondary', onclick: async () => {
      const r = await modalForm({ title: 'AI settings', submitLabel: 'Save',
        fields: [{ name: 'enabled', label: 'AI drafting switched on', type: 'checkbox', value: !!v.enabled },
          { name: 'model', label: 'Model', required: true, value: v.model || 'claude-sonnet-5-5', maxlength: 80, hint: 'The Anthropic model name, for example claude-sonnet-5-5.' }],
        onSubmit: (x) => q(sb.from('platform_settings').update({ value: { ...v, enabled: x.enabled, model: x.model }, updated_at: new Date().toISOString() }).eq('key', 'ai')) });
      if (r) { toast('AI settings saved.'); reload(); }
    } }, 'Change'))));
}
