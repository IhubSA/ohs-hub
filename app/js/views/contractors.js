// Contractor management: the companies that work on your sites, their
// safety-file documents (reviewed by a manager, with expiry dates), site
// induction, and access approval. The database makes sure only managers
// accept documents or approve access, and that access needs an induction.
import { sb, q } from '../sb.js';
import { h, modalForm, confirmAction, toast, errMsg, emptyState, fmtDate, fmtDateTime, opt } from '../ui.js';
import {
  nameMap, today, addDays, statusBadge, kv, setQuery, uploadFile, openFile, checkFile, ACCEPT,
  ACCESS_STATUS, DOC_REVIEW, CONTRACTOR_DOCS, expiryState, expiryBadge, planAllows,
} from '../data.js';
import { actionsPanel } from './actions.js';
import { recordForm } from './training.js';

export async function render(view, ctx) {
  if (ctx.params[0]) return renderDetail(view, ctx, ctx.params[0]);
  return renderList(view, ctx);
}

// Overall document position for a contractor
function docState(docs) {
  const live = docs.filter((d) => d.review_status !== 'rejected');
  if (!live.length) return { key: 'none', label: 'No documents', kind: 'bad' };
  if (live.some((d) => d.expires_on && d.expires_on < today())) return { key: 'expired', label: 'Document expired', kind: 'bad' };
  if (live.some((d) => d.review_status === 'pending')) return { key: 'pending', label: 'Awaiting review', kind: 'warn' };
  if (live.some((d) => expiryState(d.expires_on) === 'expiring')) return { key: 'expiring', label: 'Expiring soon', kind: 'warn' };
  return { key: 'ok', label: 'Up to date', kind: 'ok' };
}

async function renderList(view, { state, can, query, reload }) {
  const org = state.org.id;
  const f = query.get('f') || '';
  const [rows, docs] = await Promise.all([
    q(sb.from('contractors').select('*').eq('org_id', org).order('company_name')),
    q(sb.from('contractor_documents').select('id, contractor_id, review_status, expires_on').eq('org_id', org)),
  ]);
  const byK = new Map(rows.map((r) => [r.id, []]));
  for (const d of docs) byK.get(d.contractor_id)?.push(d);

  view.append(h('div', { class: 'page-title' },
    h('div', {}, h('h1', {}, 'Contractors'), h('p', {}, 'Contractor companies, their safety files, inductions and site access.')),
    can.edit ? h('button', { class: 'btn btn-primary', onclick: async () => { const r = await contractorForm(org); if (r) location.hash = `#/contractors/${r.id}`; } }, 'Add a contractor') : null));
  view.append(h('div', { class: 'chips' }, [['', 'All'], ['approved', 'Access approved'], ['pending', 'Pending'], ['attention', 'Needs attention']].map(([k, l]) =>
    h('button', { class: 'chip', 'aria-pressed': String(f === k), onclick: () => setQuery('contractors', { f: k }) }, l))));

  const shown = rows.filter((r) => {
    const ds = docState(byK.get(r.id));
    if (f === 'approved') return r.access_status === 'approved';
    if (f === 'pending') return r.access_status === 'pending';
    if (f === 'attention') return ['none', 'expired', 'pending', 'expiring'].includes(ds.key) || (r.access_expires_on && r.access_expires_on < addDays(today(), 14));
    return true;
  });
  const card = h('div', { class: 'card' });
  view.append(card);
  if (!rows.length) {
    card.append(emptyState('No contractors yet', 'Add the companies that work on your sites, collect their safety files and approve their access.',
      can.edit ? h('button', { class: 'btn btn-primary', onclick: async () => { const r = await contractorForm(org); if (r) location.hash = `#/contractors/${r.id}`; } }, 'Add your first contractor') : null));
    return;
  }
  if (!shown.length) { card.append(emptyState('Nothing here', 'No contractors match this filter.')); return; }
  card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, ['Company', 'Services', 'Access', 'Induction', 'Documents'].map((t) => h('th', {}, t)))),
    h('tbody', {}, shown.map((r) => {
      const ds = docState(byK.get(r.id));
      return h('tr', {},
        h('td', { 'data-label': 'Company' }, h('a', { class: 'row-link', href: `#/contractors/${r.id}` }, r.company_name), h('div', { class: 'muted small' }, r.contact_name || '')),
        h('td', { 'data-label': 'Services' }, r.services || '—'),
        h('td', { 'data-label': 'Access' }, statusBadge(r.access_status, ACCESS_STATUS),
          r.access_status === 'approved' && r.access_expires_on ? h('div', { class: 'muted small' }, `until ${fmtDate(r.access_expires_on)}`) : null),
        h('td', { 'data-label': 'Induction' }, r.induction_completed_on ? fmtDate(r.induction_completed_on) : h('span', { class: 'muted' }, 'Not done')),
        h('td', { 'data-label': 'Documents' }, h('span', { class: `badge ${ds.kind}` }, ds.label)));
    })))));
}

function contractorForm(org, c = {}) {
  return modalForm({
    title: c.id ? 'Edit contractor' : 'Add a contractor',
    submitLabel: c.id ? 'Save contractor' : 'Add contractor',
    fields: [
      { name: 'company_name', label: 'Company name', required: true, value: c.company_name, maxlength: 160 },
      { name: 'registration_number', label: 'CIPC registration number', value: c.registration_number, maxlength: 40 },
      { name: 'services', label: 'Services provided', value: c.services, maxlength: 300, placeholder: 'e.g. Scaffolding, electrical installations' },
      { name: 'contact_name', label: 'Contact person', value: c.contact_name, maxlength: 120 },
      { name: 'contact_email', label: 'Contact email', type: 'email', value: c.contact_email, maxlength: 200 },
      { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, value: c.notes, maxlength: 1000 },
    ],
    onSubmit: (v) => {
      const row = { company_name: v.company_name, registration_number: v.registration_number || null, services: v.services || null,
        contact_name: v.contact_name || null, contact_email: v.contact_email || null, notes: v.notes || null };
      return c.id ? q(sb.from('contractors').update(row).eq('id', c.id).select('id').single())
        : q(sb.from('contractors').insert({ ...row, org_id: org }).select('id').single());
    },
  });
}

async function renderDetail(view, { state, can, reload }, id) {
  const org = state.org.id;
  const c = await q(sb.from('contractors').select('*').eq('id', id).maybeSingle());
  if (!c) { view.append(h('div', { class: 'card' }, emptyState('Contractor not found', 'It may have been removed, or you may not have access to it.'))); return; }
  const [docs, names, training, courses] = await Promise.all([
    q(sb.from('contractor_documents').select('*').eq('contractor_id', id).order('created_at', { ascending: false })),
    nameMap(org),
    q(sb.from('training_records').select('*').eq('contractor_id', id).order('completed_on', { ascending: false })),
    q(sb.from('training_courses').select('id, name').eq('org_id', org)),
  ]);
  const docsAllowed = planAllows(state, 'contractors');
  const ds = docState(docs);

  view.append(h('a', { class: 'back', href: '#/contractors' }, 'Back to contractors'),
    h('div', { class: 'page-title' }, h('div', {}, h('h1', {}, c.company_name), h('p', {}, c.services || 'Contractor', ' ', statusBadge(c.access_status, ACCESS_STATUS)))));

  const bar = h('div', { class: 'btn-row', style: 'margin-bottom:18px' });
  if (can.edit) {
    bar.append(h('button', { class: 'btn btn-secondary', onclick: async () => { if (await contractorForm(org, c)) { toast('Contractor saved.'); reload(); } } }, 'Edit details'));
    bar.append(h('button', { class: 'btn btn-secondary', onclick: async () => {
      if (await modalForm({ title: 'Record site induction', submitLabel: 'Save induction',
        fields: [{ name: 'd', label: 'Induction completed on', type: 'date', required: true, value: c.induction_completed_on || today(), validate: (v) => (v > today() ? 'Can\'t be in the future.' : '') }],
        onSubmit: (v) => q(sb.from('contractors').update({ induction_completed_on: v.d }).eq('id', c.id)) })) { toast('Induction recorded.'); reload(); }
    } }, c.induction_completed_on ? 'Update induction' : 'Record induction'));
  }
  if (can.manage) {
    if (c.access_status !== 'approved') {
      bar.append(h('button', { class: 'btn btn-primary', onclick: async () => {
        const warn = ds.key === 'ok' ? '' : ` Note: documents are "${ds.label.toLowerCase()}".`;
        if (await modalForm({ title: 'Approve site access', intro: `Approve ${c.company_name} to work on your sites.${warn}`, submitLabel: 'Approve access',
          fields: [{ name: 'until', label: 'Access valid until', type: 'date', required: true, value: addDays(today(), 365), validate: (v) => (v <= today() ? 'Choose a future date.' : '') }],
          onSubmit: (v) => q(sb.from('contractors').update({ access_status: 'approved', access_expires_on: v.until }).eq('id', c.id)) })) { toast('Access approved.'); reload(); }
      } }, 'Approve access'));
    } else {
      bar.append(h('button', { class: 'btn btn-secondary', onclick: async () => {
        if (await modalForm({ title: 'Suspend access?', intro: 'The contractor will show as suspended until access is approved again.', fields: [], submitLabel: 'Suspend', danger: true,
          onSubmit: () => q(sb.from('contractors').update({ access_status: 'suspended' }).eq('id', c.id)) })) { toast('Access suspended.'); reload(); }
      } }, 'Suspend access'));
    }
  }
  if (bar.children.length) view.append(bar);

  const main = h('div', {}); const side = h('div', {});
  view.append(h('div', { class: 'detail-grid' }, main, side));

  // Documents
  const dc = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Safety file and documents'),
    can.edit && docsAllowed ? h('button', { class: 'btn btn-secondary btn-sm', onclick: async () => { if (await docForm(org, c)) { toast('Document uploaded for review.'); reload(); } } }, 'Upload document') : null));
  if (!docsAllowed) dc.append(h('p', { class: 'muted' }, 'Contractor document management is included in the Business and Enterprise plans.'));
  else if (!docs.length) dc.append(h('p', { class: 'muted' }, 'No documents yet. Upload the safety file, letter of good standing, insurance and competency certificates.'));
  else dc.append(h('ul', { class: 'file-list' }, docs.map((d) => h('li', { class: 'doc-item' },
    h('div', {}, h('button', { class: 'btn-link', style: 'padding:0', onclick: () => openFile(d.storage_path).catch((e) => toast(errMsg(e), 'err')) }, CONTRACTOR_DOCS[d.doc_kind] || d.doc_kind),
      h('div', { class: 'muted small' }, d.file_name, d.expires_on ? '' : ', no expiry'),
      d.review_notes ? h('div', { class: 'small' }, d.review_notes) : null,
      d.reviewed_by ? h('div', { class: 'muted small' }, `${DOC_REVIEW[d.review_status]} by ${names.get(d.reviewed_by) || 'a manager'}, ${fmtDateTime(d.reviewed_at)}`) : null),
    h('div', { class: 'doc-side' }, statusBadge(d.review_status, DOC_REVIEW), d.expires_on ? expiryBadge(d.expires_on) : null,
      can.manage && d.review_status === 'pending' ? h('button', { class: 'btn btn-secondary btn-sm', onclick: () => review(d, reload) }, 'Review') : null)))));
  main.append(dc);

  // Training held by the contractor's people (company level)
  const tc = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Training and competence'),
    can.edit && planAllows(state, 'training') ? h('button', { class: 'btn btn-secondary btn-sm', onclick: async () => { if (await recordForm(org, { contractor_id: c.id })) { toast('Training recorded.'); reload(); } } }, 'Record training') : null));
  const cMap = new Map(courses.map((x) => [x.id, x.name]));
  tc.append(training.length ? h('ul', { class: 'file-list' }, training.map((t) => h('li', {}, h('span', {}, cMap.get(t.course_id) || 'Course', h('br'),
    h('span', { class: 'muted small' }, `Completed ${fmtDate(t.completed_on)}${t.notes ? ' · ' + t.notes : ''}`)), expiryBadge(t.expires_on))))
    : h('p', { class: 'muted' }, 'No training recorded for this contractor.'));
  main.append(tc);
  main.append(await actionsPanel({ org, source_type: 'contractor', source_id: c.id, site_id: null, canRaise: can.field, defaultTitle: `${c.company_name}: `, onChange: reload }));

  side.append(h('div', { class: 'card' }, h('h2', {}, 'Details'), kv([
    ['Access', statusBadge(c.access_status, ACCESS_STATUS)],
    ['Access until', c.access_expires_on ? fmtDate(c.access_expires_on) : null],
    ['Approved by', c.access_approved_by ? names.get(c.access_approved_by) : null],
    ['Induction', c.induction_completed_on ? fmtDate(c.induction_completed_on) : 'Not done'],
    ['Documents', h('span', { class: `badge ${ds.kind}` }, ds.label)],
    ['Registration', c.registration_number], ['Contact', c.contact_name],
    ['Email', c.contact_email ? h('a', { href: `mailto:${c.contact_email}` }, c.contact_email) : null], ['Notes', c.notes]])));
  if (can.manage) side.append(h('button', { class: 'btn-link danger', onclick: async () => {
    if (await confirmAction('Delete this contractor?', 'Their documents and training records are deleted too. Consider suspending access instead.', 'Delete contractor')) {
      try { await q(sb.from('contractors').delete().eq('id', c.id)); toast('Contractor deleted.'); location.hash = '#/contractors'; } catch (e) { toast(errMsg(e), 'err'); }
    } } }, 'Delete contractor'));
}

function docForm(org, c) {
  return modalForm({
    title: 'Upload a contractor document',
    intro: 'A manager reviews each document before it counts. Documents you upload yourself must be reviewed by someone else.',
    submitLabel: 'Upload',
    fields: [
      { name: 'doc_kind', label: 'Document', type: 'select', value: 'safety_file', options: opt(CONTRACTOR_DOCS) },
      { name: 'file', label: 'File', type: 'file', required: true, accept: ACCEPT, hint: 'PDF, Word or a photo, up to 10 MB.' },
      { name: 'expires_on', label: 'Expires on', type: 'date', hint: 'Leave blank if it does not expire.' },
    ],
    onSubmit: async (v) => {
      const bad = checkFile(v.file); if (bad) throw new Error(bad);
      const up = await uploadFile(org, 'contractors', c.id, v.file);
      return q(sb.from('contractor_documents').insert({ org_id: org, contractor_id: c.id, doc_kind: v.doc_kind, storage_path: up.path,
        file_name: v.file.name, expires_on: v.expires_on || null }));
    },
  });
}

async function review(d, reload) {
  const r = await modalForm({
    title: `Review: ${CONTRACTOR_DOCS[d.doc_kind] || d.doc_kind}`,
    intro: 'Open the document first and check it is complete, current and for this contractor.',
    submitLabel: 'Save review',
    fields: [
      { name: 'decision', label: 'Decision', type: 'select', required: true, options: [['', 'Choose'], ['accepted', 'Accept'], ['rejected', 'Reject']] },
      { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, maxlength: 1000, placeholder: 'Required when rejecting' },
    ],
    onSubmit: (v) => {
      if (v.decision === 'rejected' && !v.notes) throw new Error('Say why the document was rejected.');
      return q(sb.from('contractor_documents').update({ review_status: v.decision, review_notes: v.notes || null }).eq('id', d.id));
    },
  });
  if (r) { toast('Review saved.'); reload(); }
}
