// Risk assessments (baseline, issue-based, task-specific, JSA, JHA).
// Scores are calculated by the database from the organisation's approved
// matrix; this screen only collects likelihood and severity.
import { sb, q } from '../sb.js';
import { h, modalForm, confirmAction, toast, errMsg, emptyState, fmtDate, opt } from '../ui.js';
import {
  loadMembers, loadSites, loadDepts, loadMethodology, nameMap, nextRef, memberOptions, siteOptions, today, addDays,
  RA_TYPES, RECORD_STATUS, CONTROL_LEVELS, statusBadge, ratingChip, kv, setQuery,
} from '../data.js';
import { createAction, actionsPanel } from './actions.js';

export const HAZARD_CATEGORIES = ['Physical', 'Mechanical', 'Electrical', 'Chemical', 'Biological', 'Ergonomic', 'Psychosocial',
  'Fire and explosion', 'Working at height', 'Vehicles and mobile plant', 'Noise and vibration', 'Environmental', 'Other'];

export async function render(view, ctx) {
  if (ctx.params[0]) return renderDetail(view, ctx, ctx.params[0]);
  return renderList(view, ctx);
}

export function lsFields(meth, prefix, item = {}, required = true) {
  const n = meth.matrix_size;
  const lOpts = [['', 'Choose likelihood'], ...meth.likelihood_labels.map((l, i) => [String(i + 1), `${i + 1}: ${l}`])];
  const sOpts = [['', 'Choose severity'], ...meth.severity_labels.map((l, i) => [String(i + 1), `${i + 1}: ${l}`])];
  const label = prefix === 'initial' ? 'Initial' : 'Residual';
  return [
    { name: `${prefix}_likelihood`, label: `${label} likelihood`, type: 'select', required, value: item[`${prefix}_likelihood`] ?? '', options: lOpts },
    { name: `${prefix}_severity`, label: `${label} severity`, type: 'select', required, value: item[`${prefix}_severity`] ?? '', options: sOpts,
      hint: prefix === 'initial' ? `Scored on your ${n}×${n} matrix: likelihood × severity.` : null },
  ];
}

async function newAssessment(org, sites, depts) {
  return modalForm({
    title: 'New risk assessment', submitLabel: 'Create assessment',
    fields: [
      { name: 'title', label: 'Title', required: true, maxlength: 200, placeholder: 'e.g. Workshop baseline risk assessment' },
      { name: 'assessment_type', label: 'Type', type: 'select', value: 'baseline', options: opt(RA_TYPES) },
      { name: 'site_id', label: 'Site', type: 'select', options: siteOptions(sites) },
      { name: 'department_id', label: 'Department', type: 'select', options: [['', 'No specific department'], ...depts.map((d) => [d.id, d.name])] },
      { name: 'activity', label: 'Activity or task assessed', maxlength: 300 },
      { name: 'scope', label: 'Scope', type: 'textarea', rows: 2, maxlength: 1000 },
      { name: 'review_date', label: 'Review date', type: 'date', value: addDays(today(), 365) },
    ],
    onSubmit: async (v) => {
      const meth = await loadMethodology(org);
      if (!meth) throw new Error('Your organisation has no risk matrix set up. Contact your administrator.');
      const reference = await nextRef(org, 'RA');
      return q(sb.from('risk_assessments').insert({
        org_id: org, reference, title: v.title, assessment_type: v.assessment_type, methodology_id: meth.id,
        site_id: v.site_id || null, department_id: v.department_id || null, activity: v.activity || null,
        scope: v.scope || null, review_date: v.review_date || null,
      }).select('id').single());
    },
  });
}

async function renderList(view, { state, can, query }) {
  const org = state.org.id;
  const status = query.get('status') || '';
  let qy = sb.from('risk_assessments').select('id, reference, title, assessment_type, site_id, status, review_date, assessor_id, risk_assessment_items(residual_score, initial_score)')
    .eq('org_id', org).order('created_at', { ascending: false }).limit(300);
  if (status) qy = qy.eq('status', status);
  const [rows, sites, depts, names, meth] = await Promise.all([q(qy), loadSites(org), loadDepts(org), nameMap(org), loadMethodology(org)]);

  view.append(h('div', { class: 'page-title' },
    h('div', {}, h('h1', {}, 'Risk assessments'), h('p', {}, 'Identify hazards, score them on your approved matrix and plan controls using the hierarchy of controls.')),
    can.edit ? h('button', { class: 'btn btn-primary', onclick: async () => {
      const r = await newAssessment(org, sites, depts); if (r) location.hash = `#/risk/${r.id}`;
    } }, 'New assessment') : null));

  view.append(h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter by status' },
    [['', 'All'], ...Object.entries(RECORD_STATUS)].map(([k, l]) =>
      h('button', { class: 'chip', type: 'button', 'aria-pressed': String(status === k), onclick: () => setQuery('risk', { status: k }) }, l))));

  const card = h('div', { class: 'card' });
  view.append(card);
  if (!rows.length) {
    card.append(emptyState('No risk assessments yet', 'Start with a baseline assessment for each site, then add task-specific assessments for higher-risk work.',
      can.edit ? h('button', { class: 'btn btn-primary', onclick: async () => { const r = await newAssessment(org, sites, depts); if (r) location.hash = `#/risk/${r.id}`; } }, 'Create your first assessment') : null));
    return;
  }
  card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, ['Reference', 'Title', 'Type', 'Site', 'Hazards', 'Highest residual risk', 'Status', 'Review'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((r) => {
      const items = r.risk_assessment_items || [];
      const top = items.reduce((m, i) => Math.max(m, i.residual_score ?? i.initial_score ?? 0), 0);
      const due = r.review_date && r.review_date < today();
      return h('tr', {},
        h('td', { 'data-label': 'Reference' }, h('span', { class: 'ref' }, r.reference)),
        h('td', { 'data-label': 'Title' }, h('a', { class: 'row-link', href: `#/risk/${r.id}` }, r.title), h('div', { class: 'muted small' }, names.get(r.assessor_id) || '')),
        h('td', { 'data-label': 'Type' }, RA_TYPES[r.assessment_type]),
        h('td', { 'data-label': 'Site' }, sites.find((s) => s.id === r.site_id)?.name || '—'),
        h('td', { 'data-label': 'Hazards' }, String(items.length)),
        h('td', { 'data-label': 'Highest residual risk' }, top ? ratingChip(meth, top) : '—'),
        h('td', { 'data-label': 'Status' }, statusBadge(r.status, RECORD_STATUS)),
        h('td', { 'data-label': 'Review' }, h('span', { class: due ? 'overdue' : '' }, fmtDate(r.review_date))));
    })))));
}

async function renderDetail(view, { state, can, reload }, id) {
  const org = state.org.id;
  const ra = await q(sb.from('risk_assessments').select('*').eq('id', id).maybeSingle());
  if (!ra) { view.append(h('div', { class: 'card' }, emptyState('Assessment not found', 'It may have been deleted, or you may not have access to it.'))); return; }
  const [items, meth, members, names, sites, depts, regLinks] = await Promise.all([
    q(sb.from('risk_assessment_items').select('*').eq('assessment_id', id).order('sort_order').order('created_at')),
    q(sb.from('risk_methodologies').select('*').eq('id', ra.methodology_id).single()),
    loadMembers(org), nameMap(org), loadSites(org), loadDepts(org),
    q(sb.from('risk_register_entries').select('id, source_item_id').eq('org_id', org).not('source_item_id', 'is', null)),
  ]);
  const inRegister = new Set(regLinks.map((r) => r.source_item_id));
  const editable = can.edit && ra.status !== 'approved' && ra.status !== 'archived';
  const independent = ra.assessor_id !== state.user.id;
  const setStatus = async (status, msg) => {
    try { await q(sb.from('risk_assessments').update({ status }).eq('id', id)); toast(msg); reload(); }
    catch (e) { toast(errMsg(e), 'err'); }
  };

  view.append(h('a', { class: 'back no-print', href: '#/risk' }, 'Back to risk assessments'));
  view.append(h('div', { class: 'page-title' },
    h('div', {}, h('h1', {}, ra.title), h('p', {}, h('span', { class: 'ref' }, ra.reference), ' ', RA_TYPES[ra.assessment_type], ' ', statusBadge(ra.status, RECORD_STATUS)))));

  const buttons = [];
  if (editable) buttons.push(h('button', { class: 'btn btn-primary', onclick: () => itemForm(org, ra, meth, members).then((r) => r && reload()) }, 'Add hazard'));
  if (can.edit && ra.status === 'draft') buttons.push(h('button', { class: 'btn btn-secondary', disabled: !items.length, onclick: () => setStatus('in_review', 'Submitted for approval.') }, 'Submit for approval'));
  if (can.manage && ra.status === 'in_review') {
    buttons.push(h('button', { class: 'btn btn-primary', disabled: !independent, title: independent ? null : 'An independent person must approve this assessment',
      onclick: async () => { if (await confirmAction('Approve this risk assessment?', 'Approval confirms the hazards, ratings and controls are appropriate. The hazards are then locked until it is reopened.', 'Approve', false)) setStatus('approved', 'Risk assessment approved.'); } }, 'Approve'));
    buttons.push(h('button', { class: 'btn btn-secondary', onclick: () => setStatus('draft', 'Returned to draft.') }, 'Return to draft'));
  }
  if (can.edit && ra.status === 'approved') buttons.push(h('button', { class: 'btn btn-secondary', onclick: async () => {
    if (await confirmAction('Reopen for revision?', 'The assessment returns to draft and needs approval again.', 'Reopen', false)) setStatus('draft', 'Reopened for revision.');
  } }, 'Reopen for revision'));
  if (editable) buttons.push(h('button', { class: 'btn btn-secondary', onclick: () => editDetails(ra, sites, depts).then((r) => r && reload()) }, 'Edit details'));
  buttons.push(h('button', { class: 'btn btn-secondary', onclick: () => window.print() }, 'Print'));
  view.append(h('div', { class: 'btn-row no-print', style: 'margin-bottom:18px' }, buttons));
  if (can.manage && ra.status === 'in_review' && !independent) {
    view.append(h('p', { class: 'notice' }, 'You assessed this risk, so someone else with OHS manager or administrator rights must approve it.'));
  }

  view.append(h('div', { class: 'card' }, kv([
    ['Site', sites.find((s) => s.id === ra.site_id)?.name || '—'],
    ['Department', depts.find((d) => d.id === ra.department_id)?.name || '—'],
    ['Activity', ra.activity || '—'],
    ['Scope', ra.scope || '—'],
    ['Assessor', names.get(ra.assessor_id) || '—'],
    ['Approved', ra.approved_at ? `${names.get(ra.approver_id) || '—'}, ${fmtDate(ra.approved_at)}` : 'Not yet approved'],
    ['Review date', fmtDate(ra.review_date)],
    ['Risk matrix', `${meth.name} (${meth.bands.map((b) => `${b.label} ${b.min}–${b.max}`).join(', ')})`],
  ])));

  const card = h('div', { class: 'card' }, h('h2', {}, 'Hazards and controls'));
  view.append(card);
  if (!items.length) {
    card.append(emptyState('No hazards recorded', 'Add each hazard with its existing controls, initial rating, additional controls and residual rating.',
      editable ? h('button', { class: 'btn btn-primary', onclick: () => itemForm(org, ra, meth, members).then((r) => r && reload()) }, 'Add the first hazard') : null));
  } else {
    card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ['Hazard', 'Persons exposed', 'Existing controls', 'Initial', 'Additional controls', 'Residual', 'Owner', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, items.map((it) => h('tr', {},
        h('td', { 'data-label': 'Hazard', class: 'wide-col' }, h('strong', {}, it.hazard), it.hazard_category ? h('div', { class: 'muted small' }, it.hazard_category) : null,
          it.task || it.activity ? h('div', { class: 'muted small' }, [it.activity, it.task].filter(Boolean).join(': ')) : null,
          it.consequences ? h('div', { class: 'small' }, 'Consequences: ', it.consequences) : null),
        h('td', { 'data-label': 'Persons exposed' }, it.persons_exposed || '—'),
        h('td', { 'data-label': 'Existing controls' }, it.existing_controls || '—'),
        h('td', { 'data-label': 'Initial' }, ratingChip(meth, it.initial_score, it.initial_rating)),
        h('td', { 'data-label': 'Additional controls' }, it.additional_controls || '—',
          it.control_levels?.length ? h('div', { class: 'muted small' }, it.control_levels.map((c) => CONTROL_LEVELS[c]).join(', ')) : null),
        h('td', { 'data-label': 'Residual' }, ratingChip(meth, it.residual_score, it.residual_rating)),
        h('td', { 'data-label': 'Owner' }, names.get(it.responsible_id) || '—', it.due_date ? h('div', { class: 'muted small' }, `by ${fmtDate(it.due_date)}`) : null),
        h('td', { class: 'actions no-print' },
          editable ? h('button', { class: 'btn-link', onclick: () => itemForm(org, ra, meth, members, it).then((r) => r && reload()) }, 'Edit') : null,
          editable ? h('button', { class: 'btn-link danger', onclick: async () => {
            if (!await confirmAction('Delete this hazard?', it.hazard, 'Delete hazard')) return;
            try { await q(sb.from('risk_assessment_items').delete().eq('id', it.id)); toast('Hazard deleted.'); reload(); } catch (e) { toast(errMsg(e), 'err'); }
          } }, 'Delete') : null,
          can.edit && !inRegister.has(it.id) ? h('button', { class: 'btn-link', onclick: () => addToRegister(org, ra, it).then((r) => r && reload()) }, 'Add to register') : null,
          inRegister.has(it.id) ? h('span', { class: 'muted small' }, 'In register') : null,
          can.field ? h('button', { class: 'btn-link', onclick: () => createAction({ org, source_type: 'risk_assessment', source_id: ra.id, site_id: ra.site_id, title: it.additional_controls ? `Implement: ${it.additional_controls}`.slice(0, 200) : `Control: ${it.hazard}`.slice(0, 200) }).then((r) => r && reload()) }, 'Raise action') : null)))))));
  }
  view.append(await actionsPanel({ org, source_type: 'risk_assessment', source_id: ra.id, site_id: ra.site_id, canRaise: can.field, onChange: reload }));
}

function editDetails(ra, sites, depts) {
  return modalForm({
    title: 'Edit assessment details', submitLabel: 'Save',
    fields: [
      { name: 'title', label: 'Title', required: true, value: ra.title, maxlength: 200 },
      { name: 'assessment_type', label: 'Type', type: 'select', value: ra.assessment_type, options: opt(RA_TYPES) },
      { name: 'site_id', label: 'Site', type: 'select', value: ra.site_id ?? '', options: siteOptions(sites) },
      { name: 'department_id', label: 'Department', type: 'select', value: ra.department_id ?? '', options: [['', 'No specific department'], ...depts.map((d) => [d.id, d.name])] },
      { name: 'activity', label: 'Activity or task assessed', value: ra.activity, maxlength: 300 },
      { name: 'scope', label: 'Scope', type: 'textarea', rows: 2, value: ra.scope, maxlength: 1000 },
      { name: 'review_date', label: 'Review date', type: 'date', value: ra.review_date },
    ],
    onSubmit: async (v) => q(sb.from('risk_assessments').update({
      title: v.title, assessment_type: v.assessment_type, site_id: v.site_id || null, department_id: v.department_id || null,
      activity: v.activity || null, scope: v.scope || null, review_date: v.review_date || null,
    }).eq('id', ra.id)),
  }).then((r) => { if (r) toast('Assessment saved.'); return r; });
}

function itemForm(org, ra, meth, members, it = {}) {
  const pair = (v, label) => (v.residual_likelihood && !v.residual_severity) || (!v.residual_likelihood && v.residual_severity) ? `${label}` : '';
  return modalForm({
    title: it.id ? 'Edit hazard' : 'Add a hazard', submitLabel: it.id ? 'Save hazard' : 'Add hazard',
    intro: 'Ratings are calculated automatically from your organisation\'s risk matrix when you save.',
    fields: [
      { name: 'activity', label: 'Activity', value: it.activity, maxlength: 200 },
      { name: 'task', label: 'Task', value: it.task, maxlength: 200 },
      { name: 'hazard_category', label: 'Hazard category', type: 'select', value: it.hazard_category ?? '', options: [['', 'Choose a category'], ...HAZARD_CATEGORIES.map((c) => [c, c])] },
      { name: 'hazard', label: 'Hazard', required: true, value: it.hazard, maxlength: 500, placeholder: 'e.g. Fall from portable ladder' },
      { name: 'persons_exposed', label: 'Persons exposed', value: it.persons_exposed, maxlength: 300, placeholder: 'e.g. Maintenance staff, contractors' },
      { name: 'consequences', label: 'Potential consequences', type: 'textarea', rows: 2, value: it.consequences, maxlength: 1000 },
      { name: 'existing_controls', label: 'Existing controls', type: 'textarea', rows: 2, value: it.existing_controls, maxlength: 1500 },
      ...lsFields(meth, 'initial', it),
      { name: 'additional_controls', label: 'Additional controls', type: 'textarea', rows: 2, value: it.additional_controls, maxlength: 1500,
        hint: 'Work down the hierarchy: eliminate, substitute, engineer, then administrative controls and PPE.' },
      { name: 'control_levels', label: 'Control types used', type: 'checks', value: it.control_levels || [], options: opt(CONTROL_LEVELS) },
      ...lsFields(meth, 'residual', it, false).map((f, i) => (i === 1 ? { ...f, validate: (_, v) => pair(v, 'Give both residual likelihood and severity, or neither.') } : f)),
      { name: 'responsible_id', label: 'Control owner', type: 'select', value: it.responsible_id ?? '', options: memberOptions(members) },
      { name: 'due_date', label: 'Controls in place by', type: 'date', value: it.due_date },
    ],
    onSubmit: async (v) => {
      const row = {
        activity: v.activity || null, task: v.task || null, hazard_category: v.hazard_category || null, hazard: v.hazard,
        persons_exposed: v.persons_exposed || null, consequences: v.consequences || null, existing_controls: v.existing_controls || null,
        initial_likelihood: +v.initial_likelihood, initial_severity: +v.initial_severity,
        additional_controls: v.additional_controls || null, control_levels: v.control_levels,
        residual_likelihood: v.residual_likelihood ? +v.residual_likelihood : null, residual_severity: v.residual_severity ? +v.residual_severity : null,
        responsible_id: v.responsible_id || null, due_date: v.due_date || null,
      };
      if (it.id) return q(sb.from('risk_assessment_items').update(row).eq('id', it.id));
      return q(sb.from('risk_assessment_items').insert({ ...row, assessment_id: ra.id, org_id: org, sort_order: Date.now() % 1e9 }));
    },
  }).then((r) => { if (r) toast(it.id ? 'Hazard saved.' : 'Hazard added.'); return r; });
}

async function addToRegister(org, ra, it) {
  try {
    const reference = await nextRef(org, 'RR');
    await q(sb.from('risk_register_entries').insert({
      org_id: org, reference, site_id: ra.site_id, department_id: ra.department_id, methodology_id: ra.methodology_id,
      activity: it.activity || ra.activity, task: it.task, hazard_category: it.hazard_category, hazard_description: it.hazard,
      persons_exposed: it.persons_exposed, existing_controls: it.existing_controls, additional_controls: it.additional_controls,
      initial_likelihood: it.initial_likelihood, initial_severity: it.initial_severity,
      residual_likelihood: it.residual_likelihood, residual_severity: it.residual_severity,
      owner_id: it.responsible_id, review_date: ra.review_date, source_item_id: it.id,
      status: it.residual_score ? 'controlled' : 'open',
    }));
    toast(`Added to the risk register as ${reference}.`);
    return true;
  } catch (e) { toast(errMsg(e), 'err'); return false; }
}
