// Risk register — the organisation's live list of significant risks,
// fed from assessments or added directly (e.g. from an inspection or
// incident finding). Ratings are calculated by the database.
import { sb, q } from '../sb.js';
import { h, modalForm, toast, emptyState, fmtDate } from '../ui.js';
import { loadMembers, loadSites, loadMethodology, nameMap, nextRef, memberOptions, siteOptions, today, addDays, ratingChip, setQuery } from '../data.js';
import { HAZARD_CATEGORIES, lsFields } from './risk.js';
import { createAction } from './actions.js';

const STATUS = { open: 'Open', controlled: 'Controlled', closed: 'Closed' };

export async function render(view, { state, can, query, reload }) {
  const org = state.org.id;
  const status = query.get('status') || 'active';
  const site = query.get('site') || '';
  const search = (query.get('q') || '').trim();
  let qy = sb.from('risk_register_entries').select('*, risk_assessment_items(assessment_id)').eq('org_id', org)
    .order('residual_score', { ascending: false, nullsFirst: false }).order('initial_score', { ascending: false }).limit(500);
  if (status === 'active') qy = qy.in('status', ['open', 'controlled']);
  else if (status !== 'all') qy = qy.eq('status', status);
  if (site) qy = qy.eq('site_id', site);
  if (search) qy = qy.or(`hazard_description.ilike.%${search.replace(/[%,()]/g, ' ')}%,reference.ilike.%${search.replace(/[%,()]/g, ' ')}%`);
  const [rows, meth, sites, members, names] = await Promise.all([q(qy), loadMethodology(org), loadSites(org), loadMembers(org), nameMap(org)]);

  view.append(h('div', { class: 'page-title' },
    h('div', {}, h('h1', {}, 'Risk register'), h('p', {}, 'Your significant risks, highest residual risk first.')),
    can.edit ? h('div', { class: 'btn-row' },
      h('button', { class: 'btn btn-secondary', onclick: () => exportCsv(rows, sites, names) }, 'Export CSV'),
      h('button', { class: 'btn btn-primary', onclick: () => entryForm(org, meth, sites, members).then((r) => r && reload()) }, 'Add risk')) : null));

  const searchBox = h('input', { type: 'search', placeholder: 'Search hazards or references', value: search, 'aria-label': 'Search the register' });
  view.append(h('form', { class: 'filters', onsubmit: (e) => { e.preventDefault(); setQuery('register', { status, site, q: searchBox.value }); } },
    h('label', {}, 'Status', h('select', { onchange: (e) => setQuery('register', { status: e.target.value, site, q: search }) },
      [['active', 'Open and controlled'], ['open', 'Open'], ['controlled', 'Controlled'], ['closed', 'Closed'], ['all', 'All']]
        .map(([v, l]) => h('option', { value: v, selected: v === status }, l)))),
    h('label', {}, 'Site', h('select', { onchange: (e) => setQuery('register', { status, site: e.target.value, q: search }) },
      siteOptions(sites, 'All sites').map(([v, l]) => h('option', { value: v, selected: v === site }, l)))),
    h('label', { style: 'flex:1;min-width:200px' }, 'Search', searchBox)));

  const card = h('div', { class: 'card' });
  view.append(card);
  if (!rows.length) {
    card.append(emptyState('The register is empty', 'Add risks from an approved risk assessment, or record a risk found during an inspection or incident.'));
    return;
  }
  card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, ['Reference', 'Hazard', 'Site', 'Initial', 'Controls', 'Residual', 'Owner', 'Status', 'Review', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((r) => {
      const due = r.review_date && r.review_date < today();
      const raId = r.risk_assessment_items?.assessment_id;
      return h('tr', {},
        h('td', { 'data-label': 'Reference' }, h('span', { class: 'ref' }, r.reference)),
        h('td', { 'data-label': 'Hazard', class: 'wide-col' }, h('strong', {}, r.hazard_description), h('div', { class: 'muted small' }, [r.hazard_category, r.activity, r.task].filter(Boolean).join(', ')),
          raId ? h('a', { class: 'small', href: `#/risk/${raId}` }, 'Source assessment') : null),
        h('td', { 'data-label': 'Site' }, sites.find((s) => s.id === r.site_id)?.name || '—'),
        h('td', { 'data-label': 'Initial' }, ratingChip(meth, r.initial_score, r.initial_rating)),
        h('td', { 'data-label': 'Controls' }, h('div', { class: 'small' }, r.existing_controls || '—'), r.additional_controls ? h('div', { class: 'small muted' }, 'Planned: ', r.additional_controls) : null),
        h('td', { 'data-label': 'Residual' }, ratingChip(meth, r.residual_score, r.residual_rating)),
        h('td', { 'data-label': 'Owner' }, names.get(r.owner_id) || '—'),
        h('td', { 'data-label': 'Status' }, STATUS[r.status]),
        h('td', { 'data-label': 'Review' }, h('span', { class: due ? 'overdue' : '' }, fmtDate(r.review_date))),
        h('td', { class: 'actions' },
          can.edit ? h('button', { class: 'btn-link', onclick: () => entryForm(org, meth, sites, members, r).then((x) => x && reload()) }, 'Edit') : null,
          can.field ? h('button', { class: 'btn-link', onclick: () => createAction({ org, source_type: 'risk_register', source_id: r.id, site_id: r.site_id, title: `Control: ${r.hazard_description}`.slice(0, 200) }).then((x) => x && reload()) }, 'Raise action') : null));
    })))));
}

export function entryForm(org, meth, sites, members, r = {}, prefill = {}) {
  const v0 = { ...prefill, ...r };
  return modalForm({
    title: r.id ? `Edit ${r.reference}` : 'Add a risk to the register', submitLabel: r.id ? 'Save risk' : 'Add risk',
    intro: 'Ratings are calculated from your organisation\'s risk matrix when you save.',
    fields: [
      { name: 'hazard_description', label: 'Hazard', required: true, value: v0.hazard_description, maxlength: 500 },
      { name: 'hazard_category', label: 'Hazard category', type: 'select', value: v0.hazard_category ?? '', options: [['', 'Choose a category'], ...HAZARD_CATEGORIES.map((c) => [c, c])] },
      { name: 'site_id', label: 'Site', type: 'select', value: v0.site_id ?? '', options: siteOptions(sites) },
      { name: 'activity', label: 'Activity', value: v0.activity, maxlength: 200 },
      { name: 'persons_exposed', label: 'Persons exposed', value: v0.persons_exposed, maxlength: 300 },
      { name: 'existing_controls', label: 'Existing controls', type: 'textarea', rows: 2, value: v0.existing_controls, maxlength: 1500 },
      ...lsFields(meth, 'initial', v0),
      { name: 'additional_controls', label: 'Additional controls', type: 'textarea', rows: 2, value: v0.additional_controls, maxlength: 1500 },
      ...lsFields(meth, 'residual', v0, false),
      { name: 'owner_id', label: 'Risk owner', type: 'select', value: v0.owner_id ?? '', options: memberOptions(members) },
      { name: 'status', label: 'Status', type: 'select', value: v0.status || 'open', options: Object.entries(STATUS) },
      { name: 'review_date', label: 'Review date', type: 'date', value: v0.review_date || addDays(today(), 365) },
    ],
    onSubmit: async (v) => {
      if (!!v.residual_likelihood !== !!v.residual_severity) throw new Error('Give both residual likelihood and severity, or neither.');
      const row = {
        hazard_description: v.hazard_description, hazard_category: v.hazard_category || null, site_id: v.site_id || null,
        activity: v.activity || null, persons_exposed: v.persons_exposed || null, existing_controls: v.existing_controls || null,
        initial_likelihood: +v.initial_likelihood, initial_severity: +v.initial_severity, additional_controls: v.additional_controls || null,
        residual_likelihood: v.residual_likelihood ? +v.residual_likelihood : null, residual_severity: v.residual_severity ? +v.residual_severity : null,
        owner_id: v.owner_id || null, status: v.status, review_date: v.review_date || null,
      };
      if (r.id) return q(sb.from('risk_register_entries').update(row).eq('id', r.id));
      const reference = await nextRef(org, 'RR');
      return q(sb.from('risk_register_entries').insert({ ...row, org_id: org, reference, methodology_id: meth.id }).select('id, reference').single());
    },
  }).then((x) => { if (x) toast(r.id ? 'Risk saved.' : 'Risk added to the register.'); return x; });
}

function exportCsv(rows, sites, names) {
  const cols = ['Reference', 'Hazard', 'Category', 'Site', 'Activity', 'Persons exposed', 'Existing controls', 'Initial score', 'Initial rating',
    'Additional controls', 'Residual score', 'Residual rating', 'Owner', 'Status', 'Review date'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.map(cell).join(',')].concat(rows.map((r) => [r.reference, r.hazard_description, r.hazard_category,
    sites.find((s) => s.id === r.site_id)?.name, r.activity, r.persons_exposed, r.existing_controls, r.initial_score, r.initial_rating,
    r.additional_controls, r.residual_score, r.residual_rating, names.get(r.owner_id), STATUS[r.status], r.review_date].map(cell).join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `risk-register-${today()}.csv` });
  document.body.append(a); a.click(); a.remove();
}
