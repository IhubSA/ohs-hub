// Document control: library, structured editor (SOP fields per the
// product spec), versions, review and approval, acknowledgements, print.
// Approval only happens through the database review process.
import { sb, q } from '../sb.js';
import { h, modalForm, confirmAction, toast, errMsg, emptyState, fmtDate, fmtDateTime } from '../ui.js';
import {
  loadMembers, loadSites, loadDepts, nameMap, nextRef, memberOptions, siteOptions, today, addDays,
  DOC_TYPES, DOC_PREFIX, DOC_STATUS, statusBadge, kv, setQuery,
} from '../data.js';

const SOP = [
  ['purpose', 'Purpose'], ['scope', 'Scope'], ['responsibilities', 'Responsible persons'],
  ['competencies', 'Required competencies and authorisations'], ['ppe', 'Required PPE'], ['equipment', 'Equipment and materials'],
  ['prerequisites', 'Prerequisites'], ['hazards', 'Identified hazards'], ['precautions', 'Safety precautions'],
  ['steps', 'Step-by-step work instructions'], ['critical_controls', 'Critical control measures'],
  ['emergency', 'Emergency response procedures'], ['records', 'Required records'],
];
export const SCHEMAS = {
  sop: SOP, safe_work_procedure: SOP,
  method_statement: [['scope', 'Scope of work'], ['sequence', 'Sequence of work'], ['resources', 'Resources, plant and equipment'],
    ['hazards', 'Hazards and controls'], ['responsibilities', 'Responsibilities'], ['competencies', 'Competencies required'], ['emergency', 'Emergency arrangements']],
  toolbox_talk: [['topic', 'Topic and purpose'], ['key_points', 'Key points'], ['discussion', 'Discussion questions'], ['actions', 'Actions agreed']],
  safety_alert: [['what_happened', 'What happened'], ['why_it_matters', 'Why it matters'], ['actions_required', 'Actions required'], ['contact', 'Who to contact']],
  emergency_plan: [['purpose', 'Purpose'], ['scope', 'Scope'], ['contacts', 'Emergency contacts'], ['roles', 'Roles and responsibilities'],
    ['alarm', 'Raising the alarm'], ['evacuation', 'Evacuation procedure'], ['assembly', 'Assembly points'], ['scenarios', 'Specific emergency scenarios'], ['drills', 'Drills and testing']],
  policy: [['purpose', 'Purpose'], ['scope', 'Scope'], ['statement', 'Policy statement'], ['responsibilities', 'Responsibilities'], ['review', 'Monitoring and review']],
};
const GENERIC = [['purpose', 'Purpose'], ['scope', 'Scope'], ['content', 'Content']];
export const schemaFor = (type) => SCHEMAS[type] || GENERIC;

export async function render(view, ctx) {
  if (ctx.params[0]) return renderDetail(view, ctx, ctx.params[0], ctx.params[1]);
  return renderList(view, ctx);
}

async function newDocument(state, preset = {}) {
  const org = state.org.id;
  const [sites, depts, members] = await Promise.all([loadSites(org), loadDepts(org), loadMembers(org)]);
  return modalForm({
    title: 'New controlled document', submitLabel: 'Create draft',
    fields: [
      { name: 'doc_type', label: 'Document type', type: 'select', value: preset.doc_type || 'sop', options: Object.entries(DOC_TYPES) },
      { name: 'title', label: 'Title', required: true, maxlength: 200, value: preset.title, placeholder: 'e.g. Working from portable ladders' },
      { name: 'reference', label: 'Reference number', maxlength: 40, hint: 'Leave blank to number it automatically, e.g. SOP-2026-0001.' },
      { name: 'site_id', label: 'Site', type: 'select', options: siteOptions(sites, 'All sites') },
      { name: 'department_id', label: 'Department', type: 'select', options: [['', 'All departments'], ...depts.map((d) => [d.id, d.name])] },
      { name: 'owner_id', label: 'Document owner', type: 'select', value: state.user.id, options: memberOptions(members, 'Choose an owner') },
      { name: 'review_date', label: 'Review date', type: 'date', value: addDays(today(), 365) },
      { name: 'requires_acknowledgement', label: 'Staff must acknowledge they have read it', type: 'checkbox', value: false },
      { name: 'visible_to_employees', label: 'Employees can read the approved version', type: 'checkbox', value: true },
    ],
    onSubmit: async (v) => {
      const reference = v.reference || await nextRef(org, DOC_PREFIX[v.doc_type] || 'DOC');
      const doc = await q(sb.from('documents').insert({
        org_id: org, reference, title: v.title, doc_type: v.doc_type, site_id: v.site_id || null, department_id: v.department_id || null,
        owner_id: v.owner_id || state.user.id, review_date: v.review_date || null,
        requires_acknowledgement: v.requires_acknowledgement, visible_to_employees: v.visible_to_employees,
      }).select('id').single());
      await q(sb.from('document_versions').insert({ document_id: doc.id, org_id: org, version_number: 1, content: {}, change_summary: 'First issue', review_date: v.review_date || null }));
      return doc;
    },
  });
}

async function renderList(view, { state, can, query }) {
  const org = state.org.id;
  const f = query.get('f') || 'effective';
  const type = query.get('type') || '';
  const search = (query.get('q') || '').trim();
  let qy = sb.from('documents').select('id, reference, title, doc_type, status, review_date, requires_acknowledgement, current_version_id, owner_id, document_versions!document_versions_document_id_fkey(id, version_number, status)')
    .eq('org_id', org).order('title').limit(500);
  if (f === 'effective') qy = qy.eq('status', 'approved');
  if (f === 'drafts') qy = qy.in('status', ['draft', 'in_review']);
  if (f === 'retired') qy = qy.in('status', ['obsolete', 'archived']);
  if (type) qy = qy.eq('doc_type', type);
  if (search) qy = qy.or(`title.ilike.%${search.replace(/[%,()]/g, ' ')}%,reference.ilike.%${search.replace(/[%,()]/g, ' ')}%`);
  let [rows, names, pending, acks] = await Promise.all([q(qy), nameMap(org),
    can.staff ? q(sb.from('document_approvals').select('version_id, document_versions(document_id)').eq('reviewer_id', state.user.id).eq('decision', 'pending')) : [],
    q(sb.from('document_acknowledgements').select('version_id').eq('user_id', state.user.id))]);
  const awaitingMe = new Set(pending.map((p) => p.document_versions?.document_id));
  const ackd = new Set(acks.map((a) => a.version_id));
  if (f === 'review') rows = rows.filter((r) => awaitingMe.has(r.id));
  if (f === 'toread') rows = rows.filter((r) => r.status === 'approved' && r.requires_acknowledgement && !ackd.has(r.current_version_id));

  view.append(h('div', { class: 'page-title' },
    h('div', {}, h('h1', {}, 'Documents'), h('p', {}, 'Controlled safety documents: procedures, plans, policies and toolbox talks.')),
    can.edit ? h('button', { class: 'btn btn-primary', onclick: async () => { const r = await newDocument(state); if (r) location.hash = `#/documents/${r.id}`; } }, 'New document') : null));

  const chips = [['effective', 'Effective'], ['toread', 'To acknowledge'], ...(can.staff ? [['drafts', 'Drafts and in review'], ['review', `Awaiting my review${awaitingMe.size ? ` (${awaitingMe.size})` : ''}`], ['retired', 'Obsolete and archived'], ['all', 'All']] : [])];
  const searchBox = h('input', { type: 'search', placeholder: 'Search titles or references', value: search, 'aria-label': 'Search documents' });
  view.append(h('div', { class: 'chips', role: 'group' }, chips.map(([k, l]) => h('button', { class: 'chip', 'aria-pressed': String(f === k), onclick: () => setQuery('documents', { f: k, type, q: search }) }, l))));
  view.append(h('form', { class: 'filters', onsubmit: (e) => { e.preventDefault(); setQuery('documents', { f, type, q: searchBox.value }); } },
    h('label', {}, 'Type', h('select', { onchange: (e) => setQuery('documents', { f, type: e.target.value, q: search }) },
      [['', 'All types'], ...Object.entries(DOC_TYPES)].map(([v, l]) => h('option', { value: v, selected: v === type }, l)))),
    h('label', { style: 'flex:1;min-width:200px' }, 'Search', searchBox)));

  const card = h('div', { class: 'card' });
  view.append(card);
  if (!rows.length) {
    card.append(emptyState(f === 'effective' ? 'No approved documents yet' : 'Nothing here',
      can.edit ? 'Create a document, write or paste its content, then submit it for review.' : 'Approved documents your organisation publishes will appear here.'));
    return;
  }
  card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, ['Reference', 'Title', 'Type', 'Version', 'Status', 'Review', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((d) => {
      const cur = d.document_versions?.find((v) => v.id === d.current_version_id);
      const revising = d.document_versions?.some((v) => ['draft', 'in_review'].includes(v.status) && d.current_version_id);
      const due = d.status === 'approved' && d.review_date && d.review_date < today();
      return h('tr', {},
        h('td', { 'data-label': 'Reference' }, h('span', { class: 'ref' }, d.reference)),
        h('td', { 'data-label': 'Title' }, h('a', { class: 'row-link', href: `#/documents/${d.id}` }, d.title), h('div', { class: 'muted small' }, names.get(d.owner_id) || '')),
        h('td', { 'data-label': 'Type' }, DOC_TYPES[d.doc_type]),
        h('td', { 'data-label': 'Version' }, cur ? `v${cur.version_number}` : '—', revising && can.staff ? h('div', { class: 'muted small' }, 'Revision in progress') : null),
        h('td', { 'data-label': 'Status' }, statusBadge(d.status, DOC_STATUS)),
        h('td', { 'data-label': 'Review' }, h('span', { class: due ? 'overdue' : '' }, fmtDate(d.review_date))),
        h('td', { 'data-label': '' }, awaitingMe.has(d.id) ? h('span', { class: 'badge warn' }, 'Your review') : null,
          d.requires_acknowledgement && d.status === 'approved' ? (ackd.has(d.current_version_id) ? h('span', { class: 'badge ok' }, 'Read') : h('span', { class: 'badge' }, 'Please acknowledge')) : null));
    })))));
}

async function renderDetail(view, { state, can, reload }, id, versionId) {
  const org = state.org.id;
  const doc = await q(sb.from('documents').select('*').eq('id', id).maybeSingle());
  if (!doc) { view.append(h('div', { class: 'card' }, emptyState('Document not found', 'It may have been deleted, or you may not have access to it.'))); return; }
  const versions = await q(sb.from('document_versions').select('*').eq('document_id', id).order('version_number', { ascending: false }));
  const [names, members, sites, depts] = await Promise.all([nameMap(org), loadMembers(org), loadSites(org), loadDepts(org)]);
  const working = versions.find((v) => ['draft', 'in_review'].includes(v.status));
  const current = versions.find((v) => v.id === doc.current_version_id);
  const shown = versions.find((v) => v.id === versionId) || (can.staff ? (working || current) : current) || versions[0];
  if (!shown) { view.append(h('div', { class: 'card' }, emptyState('No readable version', 'This document has no approved version yet.'))); return; }
  const approvals = can.staff ? await q(sb.from('document_approvals').select('*').eq('version_id', shown.id).order('requested_at')) : [];
  const myApproval = approvals.find((a) => a.reviewer_id === state.user.id && a.decision === 'pending');
  const [myAck, ackCount] = await Promise.all([
    q(sb.from('document_acknowledgements').select('id, acknowledged_at').eq('version_id', shown.id).eq('user_id', state.user.id).maybeSingle()),
    can.staff ? sb.from('document_acknowledgements').select('id', { count: 'exact', head: true }).eq('version_id', shown.id).then((r) => r.count ?? 0) : null]);
  const schema = schemaFor(doc.doc_type);
  const content = shown.content || {};
  const editing = can.edit && shown.status === 'draft';

  view.append(h('a', { class: 'back no-print', href: '#/documents' }, 'Back to documents'));
  view.append(h('div', { class: 'page-title' }, h('div', {}, h('h1', {}, doc.title),
    h('p', {}, h('span', { class: 'ref' }, doc.reference), ` ${DOC_TYPES[doc.doc_type]}, version ${shown.version_number} `, statusBadge(shown.status, DOC_STATUS)))));

  // Status banner: never let a draft be mistaken for the effective version
  if (shown.status === 'approved') view.append(h('div', { class: 'doc-banner effective' }, `Effective version ${shown.version_number}, in force from ${fmtDate(shown.effective_date)}.`));
  else if (shown.status === 'obsolete') view.append(h('div', { class: 'doc-banner draft' }, `Superseded version ${shown.version_number}. Do not use.`, current ? [' ', h('a', { href: `#/documents/${id}/${current.id}` }, `View effective version ${current.version_number}`)] : null));
  else view.append(h('div', { class: 'doc-banner draft' }, `${shown.status === 'in_review' ? 'In review' : 'Draft'}: version ${shown.version_number} is not approved and must not be used.`,
    current ? [' ', h('a', { href: `#/documents/${id}/${current.id}` }, `View effective version ${current.version_number}`)] : null));

  // Buttons
  const btns = [];
  const act = async (fn, msg) => { try { await fn(); toast(msg); reload(); } catch (e) { toast(errMsg(e), 'err'); } };
  if (editing) {
    btns.push(h('button', { class: 'btn btn-primary', onclick: () => submitForReview(org, doc, shown, members, state.user.id).then((r) => r && reload()) }, 'Submit for review'));
    btns.push(h('button', { class: 'btn btn-secondary', onclick: () => editProperties(doc, sites, depts, members).then((r) => r && reload()) }, 'Document settings'));
  }
  if (myApproval) {
    btns.push(h('button', { class: 'btn btn-primary', onclick: () => modalForm({ title: 'Approve this version?', submitLabel: 'Approve',
      intro: 'Approving confirms this version is accurate and suitable for use. It becomes effective once every reviewer has approved it.',
      fields: [{ name: 'c', label: 'Comments', type: 'textarea', rows: 2, maxlength: 2000 }],
      onSubmit: (v) => q(sb.rpc('decide_document_version', { p_approval: myApproval.id, p_decision: 'approved', p_comments: v.c || null })) })
      .then((r) => { if (r) { toast('Approval recorded.'); reload(); } }) }, 'Approve'));
    btns.push(h('button', { class: 'btn btn-secondary', onclick: () => modalForm({ title: 'Reject this version', submitLabel: 'Reject',
      fields: [{ name: 'c', label: 'What needs to change?', type: 'textarea', required: true, rows: 3, maxlength: 2000 }],
      onSubmit: (v) => q(sb.rpc('decide_document_version', { p_approval: myApproval.id, p_decision: 'rejected', p_comments: v.c })) })
      .then((r) => { if (r) { toast('Returned to the author.'); reload(); } }) }, 'Reject'));
  }
  if (can.edit && doc.status === 'approved' && !working) btns.push(h('button', { class: 'btn btn-secondary', onclick: () => modalForm({
    title: 'Start a revision', submitLabel: 'Start revision',
    intro: `Version ${current?.version_number} stays effective until the revision is approved.`,
    fields: [{ name: 'summary', label: 'What is changing?', required: true, maxlength: 500 }],
    onSubmit: async (v) => q(sb.from('document_versions').insert({ document_id: id, org_id: org, version_number: (versions[0]?.version_number || 0) + 1,
      content: current?.content || {}, change_summary: v.summary, review_date: addDays(today(), 365) }).select('id').single()),
  }).then((r) => { if (r) { toast('Revision started.'); location.hash = `#/documents/${id}/${r.id}`; } }) }, 'Start revision'));
  if (shown.status === 'approved' && shown.id === doc.current_version_id && doc.requires_acknowledgement && !myAck) {
    btns.push(h('button', { class: 'btn btn-primary', onclick: async () => {
      if (await confirmAction('Acknowledge this document?', 'You confirm you have read and understood this version.', 'I have read it', false))
        act(() => q(sb.from('document_acknowledgements').insert({ version_id: shown.id, org_id: org, user_id: state.user.id })), 'Thank you. Your acknowledgement is recorded.');
    } }, 'Acknowledge'));
  }
  if (can.manage && ['approved'].includes(doc.status)) btns.push(h('button', { class: 'btn-link danger', onclick: async () => {
    if (await confirmAction('Make this document obsolete?', 'It is withdrawn from use. All versions and their history are kept.', 'Make obsolete'))
      act(() => q(sb.from('documents').update({ status: 'obsolete' }).eq('id', id)), 'Document withdrawn.');
  } }, 'Withdraw'));
  if (can.manage && doc.status === 'draft' && !doc.current_version_id) btns.push(h('button', { class: 'btn-link danger', onclick: async () => {
    if (await confirmAction('Delete this draft document?', 'It has never been approved, so it can be deleted.', 'Delete draft'))
      act(async () => { await q(sb.from('document_versions').delete().eq('document_id', id)); await q(sb.from('documents').delete().eq('id', id)); location.hash = '#/documents'; }, 'Draft deleted.');
  } }, 'Delete draft'));
  btns.push(h('button', { class: 'btn btn-secondary', onclick: () => window.print() }, 'Print'));
  view.append(h('div', { class: 'btn-row no-print', style: 'margin-bottom:16px' }, btns));
  if (myAck) view.append(h('p', { class: 'muted small' }, `You acknowledged this version on ${fmtDate(myAck.acknowledged_at)}.`));
  if (shown.status === 'draft' && can.staff && approvals.some((a) => a.decision === 'rejected')) {
    view.append(h('p', { class: 'notice' }, 'Returned by reviewer: ', approvals.filter((a) => a.decision === 'rejected').map((a) => `${names.get(a.reviewer_id)}: ${a.comments}`).join(' ')));
  }

  view.append(h('div', { class: 'detail-grid' },
    editing ? editorCard(doc, shown, schema, reload) : contentCard(doc, shown, schema, sites, depts, names),
    h('div', {},
      h('div', { class: 'card' }, h('h2', {}, 'Control information'), kv([
        ['Owner', names.get(doc.owner_id) || '—'],
        ['Author', names.get(shown.created_by) || '—'],
        ['Site', sites.find((s) => s.id === doc.site_id)?.name || 'All sites'],
        ['Department', depts.find((d) => d.id === doc.department_id)?.name || 'All departments'],
        ['Change summary', shown.change_summary || '—'],
        ['Approved by', shown.approved_by ? `${names.get(shown.approved_by) || '—'}, ${fmtDate(shown.approved_at)}` : '—'],
        ['Effective date', fmtDate(shown.effective_date)],
        ['Review date', fmtDate(doc.review_date)],
        doc.requires_acknowledgement && can.staff ? ['Acknowledged by', `${ackCount ?? 0} ${ackCount === 1 ? 'person' : 'people'}`] : null,
      ])),
      can.staff && approvals.length ? h('div', { class: 'card' }, h('h2', {}, 'Review'), h('ul', { class: 'file-list' }, approvals.map((a) => h('li', {},
        h('span', {}, names.get(a.reviewer_id) || '—', a.comments ? h('div', { class: 'muted small' }, a.comments) : null),
        statusBadge(a.decision === 'pending' ? 'in_review' : a.decision, { in_review: 'Pending', approved: 'Approved', rejected: 'Rejected' }))))) : null,
      can.staff ? h('div', { class: 'card no-print' }, h('h2', {}, 'Version history'), h('ul', { class: 'file-list' }, versions.map((v) => h('li', {},
        h('a', { href: `#/documents/${id}/${v.id}`, 'aria-current': v.id === shown.id ? 'page' : null }, `Version ${v.version_number}`, v.change_summary ? h('div', { class: 'muted small' }, v.change_summary) : null),
        statusBadge(v.status, DOC_STATUS))))) : null)));
}

function contentCard(doc, v, schema, sites, depts, names) {
  const c = v.content || {};
  const card = h('article', { class: 'card doc-view' },
    h('p', { class: 'muted small' }, `${doc.reference}, version ${v.version_number}`));
  const filled = schema.filter(([k]) => (c[k] || '').trim());
  if (!filled.length) card.append(h('p', { class: 'muted' }, 'This version has no content yet.'));
  for (const [k, label] of filled) card.append(h('h2', {}, label), h('p', {}, c[k]));
  return card;
}

function editorCard(doc, v, schema, reload) {
  const c = v.content || {};
  const inputs = {};
  const status = h('span', { class: 'sync', role: 'status' }, 'Draft');
  const form = h('form', { class: 'form doc-sections', onsubmit: async (e) => {
    e.preventDefault();
    const content = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()]));
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Saving…';
    try { await q(sb.from('document_versions').update({ content }).eq('id', v.id)); toast('Draft saved.'); status.textContent = `Saved ${fmtDateTime(new Date().toISOString())}`; }
    catch (err) { toast(errMsg(err), 'err'); }
    btn.disabled = false; btn.textContent = 'Save draft';
  } });
  for (const [k, label] of schema) {
    const ta = h('textarea', { id: `sec-${k}`, rows: k === 'steps' ? 10 : 4, maxlength: 20000 }, c[k] || '');
    inputs[k] = ta;
    form.append(h('div', { class: 'field' }, h('label', { for: `sec-${k}` }, label), ta));
  }
  form.append(h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save draft'), status));
  return h('div', { class: 'card' }, h('h2', {}, 'Content'),
    h('p', { class: 'sub' }, doc.doc_type === 'sop' || doc.doc_type === 'safe_work_procedure' ? 'Number each work step on its own line. Leave out sections that do not apply.' : 'Leave out sections that do not apply.'),
    form);
}

async function submitForReview(org, doc, v, members, me) {
  const fresh = await q(sb.from('document_versions').select('content').eq('id', v.id).single());
  const filled = Object.values(fresh?.content || {}).some((x) => (x || '').trim());
  if (!filled) { toast('Add and save the document content before submitting it for review.', 'err'); return null; }
  const eligible = members.filter((m) => (['org_admin', 'ohs_manager'].includes(m.role) || m.can_approve_documents) && m.user_id !== v.created_by);
  if (!eligible.length) { toast('No one else can approve documents yet. An administrator can give a team member approval rights under Team & roles.', 'err'); return null; }
  return modalForm({
    title: 'Submit for review', submitLabel: 'Submit for review',
    intro: 'Each reviewer must approve before the version becomes effective. The author cannot review their own document.',
    fields: [{ name: 'reviewers', label: 'Reviewers', type: 'checks', required: true, options: eligible.map((m) => [m.user_id, m.name]) }],
    onSubmit: (vals) => q(sb.rpc('submit_document_version', { p_version: v.id, p_reviewers: vals.reviewers })),
  }).then((r) => { if (r) toast('Submitted. The reviewers have been notified.'); return r; });
}

function editProperties(doc, sites, depts, members) {
  return modalForm({
    title: 'Document settings', submitLabel: 'Save',
    fields: [
      { name: 'title', label: 'Title', required: true, value: doc.title, maxlength: 200 },
      { name: 'site_id', label: 'Site', type: 'select', value: doc.site_id ?? '', options: siteOptions(sites, 'All sites') },
      { name: 'department_id', label: 'Department', type: 'select', value: doc.department_id ?? '', options: [['', 'All departments'], ...depts.map((d) => [d.id, d.name])] },
      { name: 'owner_id', label: 'Document owner', type: 'select', value: doc.owner_id ?? '', options: memberOptions(members, 'Choose an owner') },
      { name: 'review_date', label: 'Review date', type: 'date', value: doc.review_date },
      { name: 'requires_acknowledgement', label: 'Staff must acknowledge they have read it', type: 'checkbox', value: doc.requires_acknowledgement },
      { name: 'visible_to_employees', label: 'Employees can read the approved version', type: 'checkbox', value: doc.visible_to_employees },
    ],
    onSubmit: (v) => q(sb.from('documents').update({ title: v.title, site_id: v.site_id || null, department_id: v.department_id || null,
      owner_id: v.owner_id || null, review_date: v.review_date || null, requires_acknowledgement: v.requires_acknowledgement,
      visible_to_employees: v.visible_to_employees }).eq('id', doc.id)),
  }).then((r) => { if (r) toast('Settings saved.'); return r; });
}
