// Legal register: requirements that apply to the organisation, whether each
// has been verified against the official source, and how compliant each
// site is. Verification is enforced by the database: a requirement only
// shows as "Verified" after a second competent person confirms it, and any
// edit to its wording sends it back to "Needs verification".
import { sb, q } from '../sb.js';
import { h, modalForm, toast, errMsg, emptyState, fmtDate, fmtDateTime, opt } from '../ui.js';
import {
  loadMembers, loadSites, nameMap, memberOptions, siteOptions, today, addDays, statusBadge, kv, setQuery, downloadCsv,
  VERIFICATION, EVALUATION, REQ_KIND, planAllows, planNotice,
} from '../data.js';
import { actionsPanel } from './actions.js';

export async function render(view, ctx) {
  if (!planAllows(ctx.state, 'legal')) return planNotice(view, 'Legal register', 'The legal register and compliance tracking');
  if (ctx.params[0]) return renderDetail(view, ctx, ctx.params[0]);
  return renderList(view, ctx);
}

const label = (r) => r.title ? `${r.reference}: ${r.title}` : r.reference;

async function loadRequirements(org) {
  const [reqs, fws] = await Promise.all([
    q(sb.from('legal_requirements').select('*').or(`org_id.is.null,org_id.eq.${org}`).neq('verification_status', 'superseded').order('reference')),
    q(sb.from('legal_frameworks').select('id, code, title, kind').eq('is_active', true).order('title')),
  ]);
  return { reqs, fws, fwMap: new Map(fws.map((f) => [f.id, f])) };
}

// Worst evaluation across sites decides the headline status
const RANK = { non_compliant: 3, partially_compliant: 2, not_assessed: 1, compliant: 0 };
function summarise(assessments) {
  const live = assessments.filter((a) => a.is_applicable);
  if (!assessments.length) return 'not_assessed';
  if (!live.length) return 'not_applicable';
  return live.reduce((w, a) => (RANK[a.evaluation] > RANK[w] ? a.evaluation : w), 'compliant');
}

async function renderList(view, { state, can, query, reload }) {
  const org = state.org.id;
  const fEval = query.get('e') || '';
  const fVer = query.get('v') || '';
  const search = (query.get('q') || '').toLowerCase();
  const [{ reqs, fws, fwMap }, assess, sites] = await Promise.all([
    loadRequirements(org),
    q(sb.from('compliance_assessments').select('id, requirement_id, site_id, is_applicable, evaluation, review_date').eq('org_id', org)),
    loadSites(org),
  ]);
  const byReq = new Map();
  for (const a of assess) (byReq.get(a.requirement_id) || byReq.set(a.requirement_id, []).get(a.requirement_id)).push(a);
  const rows = reqs.map((r) => {
    const list = byReq.get(r.id) || [];
    const review = list.filter((a) => a.is_applicable && a.review_date).map((a) => a.review_date).sort()[0] || null;
    return { ...r, status: summarise(list), review, fw: fwMap.get(r.framework_id) };
  });

  view.append(h('div', { class: 'page-title' },
    h('div', {}, h('h1', {}, 'Legal register'), h('p', {}, 'The legal and other requirements that apply to you, and how compliant each site is.')),
    can.manage ? h('button', { class: 'btn btn-primary', onclick: async () => { const r = await requirementForm(org, fws); if (r) location.hash = `#/legal/${r.id}`; } }, 'Add requirement') : null));

  const counts = (k) => rows.filter((r) => r.status === k).length;
  const overdue = rows.filter((r) => r.review && r.review < today()).length;
  view.append(h('div', { class: 'stats' },
    [['compliant', 'Compliant'], ['partially_compliant', 'Partly compliant'], ['non_compliant', 'Not compliant'], ['not_assessed', 'Not assessed']].map(([k, l]) =>
      h('a', { class: 'stat', href: `#/legal?e=${k}` }, h('div', { class: 'n' }, String(counts(k))), h('div', { class: 'l' }, l))),
    h('div', { class: 'stat' }, h('div', { class: 'n' }, String(overdue)), h('div', { class: 'l' }, 'Reviews overdue'))));

  const searchBox = h('input', { type: 'search', placeholder: 'Search references or wording', value: query.get('q') || '',
    onchange: (e) => setQuery('legal', { e: fEval, v: fVer, q: e.target.value.trim() }) });
  view.append(h('div', { class: 'filters' },
    h('label', {}, 'Compliance', h('select', { onchange: (e) => setQuery('legal', { e: e.target.value, v: fVer, q: search }) },
      [['', 'All'], ...opt(EVALUATION), ['not_applicable', 'Not applicable']].map(([v, l]) => h('option', { value: v, selected: v === fEval }, l)))),
    h('label', {}, 'Verification', h('select', { onchange: (e) => setQuery('legal', { e: fEval, v: e.target.value, q: search }) },
      [['', 'All'], ['verified', 'Verified'], ['unverified', 'Needs verification']].map(([v, l]) => h('option', { value: v, selected: v === fVer }, l)))),
    h('label', { style: 'flex:1;min-width:200px' }, 'Search', searchBox)));

  const shown = rows.filter((r) => (!fEval || r.status === fEval) && (!fVer || r.verification_status === fVer)
    && (!search || `${r.reference} ${r.title || ''} ${r.requirement} ${r.fw?.title || ''}`.toLowerCase().includes(search)));

  const card = h('div', { class: 'card' });
  view.append(card);
  if (!rows.length) {
    card.append(emptyState('Your legal register is empty',
      'Add the legal and company requirements that apply to your work. Each one is checked against the official source by a second competent person before it counts as verified.',
      can.manage ? h('button', { class: 'btn btn-primary', onclick: async () => { const r = await requirementForm(org, fws); if (r) location.hash = `#/legal/${r.id}`; } }, 'Add your first requirement') : null));
    return;
  }
  if (!shown.length) { card.append(emptyState('Nothing matches', 'Change the filters to see more requirements.')); return; }
  card.append(h('div', { class: 'card-head' }, h('span', { class: 'muted' }, `${shown.length} requirement${shown.length === 1 ? '' : 's'}`),
    h('button', { class: 'btn btn-secondary btn-sm', onclick: () => downloadCsv('legal-register.csv', [
      ['Reference', 'Title', 'Source', 'Type', 'Verification', 'Compliance', 'Next review'],
      ...shown.map((r) => [r.reference, r.title || '', r.fw?.title || 'Company', REQ_KIND[r.requirement_kind], VERIFICATION[r.verification_status],
        r.status === 'not_applicable' ? 'Not applicable' : EVALUATION[r.status], r.review || '']),
    ]) }, 'Export CSV')));
  card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, ['Requirement', 'Source', 'Verification', 'Compliance', 'Next review'].map((t) => h('th', {}, t)))),
    h('tbody', {}, shown.map((r) => h('tr', {},
      h('td', { 'data-label': 'Requirement', class: 'wide-col' }, h('a', { class: 'row-link', href: `#/legal/${r.id}` }, label(r)),
        h('div', { class: 'muted small' }, r.org_id ? 'Your requirement' : 'Shared library')),
      h('td', { 'data-label': 'Source' }, r.fw?.title || REQ_KIND[r.requirement_kind]),
      h('td', { 'data-label': 'Verification' }, statusBadge(r.verification_status, VERIFICATION)),
      h('td', { 'data-label': 'Compliance' }, r.status === 'not_applicable' ? h('span', { class: 'muted' }, 'Not applicable') : statusBadge(r.status, EVALUATION)),
      h('td', { 'data-label': 'Next review' }, r.review ? h('span', { class: r.review < today() ? 'overdue' : '' }, fmtDate(r.review)) : '—')))))));
  card.append(h('p', { class: 'muted small', style: 'margin:12px 0 0' },
    '"Needs verification" means nobody has yet confirmed the wording against the official source. Don\'t rely on it until it is verified.'));
}

function requirementForm(org, fws, r = {}) {
  return modalForm({
    title: r.id ? 'Edit requirement' : 'Add a requirement',
    intro: r.id && r.verification_status === 'verified' ? 'Changing the wording sends this requirement back to "Needs verification" until someone checks it again.' : 'Copy the wording from the official source. A second competent person verifies it before it counts as verified.',
    submitLabel: r.id ? 'Save changes' : 'Add requirement',
    fields: [
      { name: 'requirement_kind', label: 'Type', type: 'select', value: r.requirement_kind || 'legislation', options: opt(REQ_KIND) },
      { name: 'framework_id', label: 'Act, regulation or standard', type: 'select', value: r.framework_id || '',
        options: [['', 'None (company requirement)'], ...fws.map((f) => [f.id, f.title])] },
      { name: 'reference', label: 'Section or clause', required: true, value: r.reference, maxlength: 120, placeholder: 'e.g. Section 8(2)(a)' },
      { name: 'title', label: 'Short title', value: r.title, maxlength: 200, placeholder: 'e.g. Safe systems of work' },
      { name: 'requirement', label: 'Requirement (wording from the source)', type: 'textarea', required: true, value: r.requirement, maxlength: 5000, rows: 5 },
      { name: 'applicability', label: 'Who or what it applies to', value: r.applicability, maxlength: 500 },
      { name: 'source_reference', label: 'Where the wording comes from', value: r.source_reference, maxlength: 500,
        placeholder: 'e.g. Government Gazette No. 14918, or a link to the official text' },
      { name: 'effective_date', label: 'In force from', type: 'date', value: r.effective_date || '' },
    ],
    onSubmit: async (v) => {
      const row = { requirement_kind: v.requirement_kind, framework_id: v.framework_id || null, reference: v.reference, title: v.title || null,
        requirement: v.requirement, applicability: v.applicability || null, source_reference: v.source_reference || null, effective_date: v.effective_date || null };
      if (r.id) return q(sb.from('legal_requirements').update(row).eq('id', r.id).select('id').single());
      return q(sb.from('legal_requirements').insert({ ...row, org_id: org }).select('id').single());
    },
  });
}

async function renderDetail(view, { state, can, reload }, id) {
  const org = state.org.id;
  const r = await q(sb.from('legal_requirements').select('*').eq('id', id).maybeSingle());
  if (!r) { view.append(h('div', { class: 'card' }, emptyState('Requirement not found', 'It may have been removed, or you may not have access to it.'))); return; }
  const [fw, assess, sites, names, members, fws] = await Promise.all([
    r.framework_id ? q(sb.from('legal_frameworks').select('*').eq('id', r.framework_id).maybeSingle()) : null,
    q(sb.from('compliance_assessments').select('*').eq('org_id', org).eq('requirement_id', id).order('created_at')),
    loadSites(org), nameMap(org), loadMembers(org),
    q(sb.from('legal_frameworks').select('id, code, title, kind').eq('is_active', true).order('title')),
  ]);
  const siteName = (sid) => (sid ? sites.find((s) => s.id === sid)?.name || 'Site' : 'Whole organisation');
  const own = !!r.org_id;

  view.append(h('a', { class: 'back', href: '#/legal' }, 'Back to legal register'),
    h('div', { class: 'page-title' }, h('div', {}, h('h1', {}, label(r)),
      h('p', {}, fw ? fw.title : REQ_KIND[r.requirement_kind], ' ', statusBadge(r.verification_status, VERIFICATION)))));
  if (r.verification_status !== 'verified') {
    view.append(h('div', { class: 'alert alert--info', style: 'margin-bottom:16px' }, 'This requirement has not been verified against the official source yet. Don\'t rely on the wording until a competent person has checked it.'));
  }

  const bar = h('div', { class: 'btn-row', style: 'margin-bottom:18px' });
  if (own && can.manage) {
    bar.append(h('button', { class: 'btn btn-secondary', onclick: async () => { if (await requirementForm(org, fws, r)) { toast('Requirement saved.'); reload(); } } }, 'Edit'));
    if (r.verification_status !== 'verified') bar.append(h('button', { class: 'btn btn-primary', onclick: () => verify(r, state, reload) }, 'Verify'));
    bar.append(h('button', { class: 'btn-link', onclick: async () => {
      if (await modalForm({ title: 'Mark as superseded?', intro: 'Use this when the requirement has been replaced or repealed. It leaves the register but its history is kept.', fields: [], submitLabel: 'Mark superseded',
        onSubmit: () => q(sb.from('legal_requirements').update({ verification_status: 'superseded' }).eq('id', r.id)) })) { toast('Marked as superseded.'); location.hash = '#/legal'; }
    } }, 'Superseded'));
  }
  if (bar.children.length) view.append(bar);

  const main = h('div', {});
  const side = h('div', {});
  view.append(h('div', { class: 'detail-grid' }, main, side));
  main.append(h('div', { class: 'card' }, h('h2', {}, 'Requirement'),
    h('p', { class: 'prose-block' }, r.requirement),
    kv([['Applies to', r.applicability], ['Source of the wording', r.source_reference], ['In force from', r.effective_date ? fmtDate(r.effective_date) : null]])));

  // Compliance per site
  const ac = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Compliance'),
    can.edit ? h('button', { class: 'btn btn-secondary btn-sm', onclick: async () => { if (await assessmentForm(org, r, sites, members, assess)) { toast('Assessment saved.'); reload(); } } }, 'Assess a site') : null));
  if (!assess.length) ac.append(h('p', { class: 'muted' }, 'Not assessed yet. Record whether each site complies, with the evidence you checked.'));
  for (const a of assess) {
    ac.append(h('div', { class: 'assess-row' },
      h('div', { class: 'assess-head' }, h('strong', {}, siteName(a.site_id)),
        a.is_applicable ? statusBadge(a.evaluation, EVALUATION) : h('span', { class: 'muted' }, 'Not applicable')),
      kv([['Evidence', a.evidence], ['Findings', a.findings], ['Responsible', names.get(a.responsible_id)],
        ['Assessed', a.assessed_on ? fmtDate(a.assessed_on) : null], ['Next review', a.review_date ? h('span', { class: a.review_date < today() ? 'overdue' : '' }, fmtDate(a.review_date)) : null]]),
      can.edit ? h('button', { class: 'btn-link', onclick: async () => { if (await assessmentForm(org, r, sites, members, assess, a)) { toast('Assessment saved.'); reload(); } } }, 'Update') : null));
  }
  main.append(ac);
  main.append(await actionsPanel({ org, source_type: 'legal_compliance', source_id: r.id, site_id: null, canRaise: can.field,
    defaultTitle: `Close compliance gap: ${r.reference}`, onChange: reload }));

  side.append(h('div', { class: 'card' }, h('h2', {}, 'Verification'),
    kv([['Status', statusBadge(r.verification_status, VERIFICATION)], ['Version', String(r.version)],
      ['Verified by', r.verified_by ? (names.get(r.verified_by) || (own ? 'A team member' : 'iHubSA')) : null],
      ['Verified on', r.verified_at ? fmtDateTime(r.verified_at) : null], ['How it was checked', r.verification_notes],
      ['Held in', own ? 'Your organisation' : 'Shared iHubSA library']]),
    !own ? h('p', { class: 'muted small' }, 'Shared library entries are maintained and verified by iHubSA. You record your own compliance against them.') : null));
}

async function verify(r, state, reload) {
  const ok = await modalForm({
    title: 'Verify this requirement',
    intro: 'Confirm that the wording, section number and in-force date match the official source. You can\'t verify a requirement you captured yourself.',
    submitLabel: 'Mark as verified',
    fields: [{ name: 'notes', label: 'How did you verify it?', type: 'textarea', required: true, rows: 3, maxlength: 2000,
      placeholder: 'e.g. Checked against the Government Gazette text on the Department of Employment and Labour website, 29 Oct 2026' }],
    onSubmit: (v) => q(sb.rpc('verify_legal_requirement', { p_id: r.id, p_notes: v.notes })),
  });
  if (ok) { toast('Requirement verified.'); reload(); }
}

function assessmentForm(org, r, sites, members, existing, a = {}) {
  const used = new Set(existing.filter((x) => x.id !== a.id).map((x) => x.site_id || ''));
  const siteChoices = [['', 'Whole organisation'], ...sites.map((s) => [s.id, s.name])].filter(([v]) => !used.has(v));
  if (!a.id && !siteChoices.length) { toast('Every site already has an assessment. Update the existing ones.', 'err'); return null; }
  return modalForm({
    title: a.id ? 'Update compliance' : 'Assess compliance',
    submitLabel: 'Save assessment',
    fields: [
      ...(a.id ? [] : [{ name: 'site_id', label: 'Site', type: 'select', options: siteChoices }]),
      { name: 'is_applicable', label: 'This requirement applies here', type: 'checkbox', value: a.is_applicable ?? true },
      { name: 'evaluation', label: 'Compliance', type: 'select', value: a.evaluation || 'not_assessed', options: opt(EVALUATION) },
      { name: 'evidence', label: 'Evidence checked', type: 'textarea', rows: 3, maxlength: 3000, value: a.evidence,
        placeholder: 'e.g. Appointment letters on file, inspection records for September' },
      { name: 'findings', label: 'Findings or gaps', type: 'textarea', rows: 3, maxlength: 3000, value: a.findings },
      { name: 'responsible_id', label: 'Responsible person', type: 'select', value: a.responsible_id || '', options: memberOptions(members, 'Not assigned') },
      { name: 'assessed_on', label: 'Assessed on', type: 'date', value: a.assessed_on || today(), validate: (v) => (v && v > today() ? 'Can\'t be in the future.' : '') },
      { name: 'review_date', label: 'Next review', type: 'date', value: a.review_date || addDays(today(), 365) },
    ],
    onSubmit: (v) => {
      const row = { is_applicable: v.is_applicable, evaluation: v.is_applicable ? v.evaluation : 'not_assessed', evidence: v.evidence || null,
        findings: v.findings || null, responsible_id: v.responsible_id || null, assessed_on: v.assessed_on || null, review_date: v.review_date || null };
      if (a.id) return q(sb.from('compliance_assessments').update(row).eq('id', a.id));
      return q(sb.from('compliance_assessments').insert({ ...row, org_id: org, requirement_id: r.id, site_id: v.site_id || null }));
    },
  });
}
