// Corrective actions — central register fed by risk assessments,
// inspections, incidents and audits. Verification is enforced by the
// database: an action needing verification cannot close until someone
// other than the responsible person confirms it was effective.
import { sb, q } from '../sb.js';
import { h, modalForm, confirmAction, toast, errMsg, emptyState, fmtDate, opt } from '../ui.js';
import {
  loadMembers, loadSites, nameMap, nextRef, memberOptions, siteOptions, today, addDays, isOverdue,
  PRIORITY, ACTION_STATUS, ACTION_SOURCE, statusBadge, kv, uploadFile, openFile, fileButton, setQuery,
} from '../data.js';

const SOURCE_LINK = {
  incident: (id) => `#/incidents/${id}`, inspection: (id) => `#/inspections/${id}`,
  risk_assessment: (id) => `#/risk/${id}`, risk_register: () => '#/register',
  legal_compliance: (id) => `#/legal/${id}`, emergency_drill: (id) => `#/emergency/${id}`,
  equipment: (id) => `#/equipment/${id}`, contractor: (id) => `#/contractors/${id}`,
};

// Reusable: open the "new action" form from any module.
export async function createAction({ org, source_type = 'other', source_id = null, site_id = null, title = '', description = '' }) {
  const [members, sites] = await Promise.all([loadMembers(org), loadSites(org)]);
  return modalForm({
    title: 'Raise a corrective action',
    submitLabel: 'Raise action',
    fields: [
      { name: 'title', label: 'Action', required: true, value: title, maxlength: 200, placeholder: 'e.g. Replace damaged ladder in workshop' },
      { name: 'description', label: 'Details', type: 'textarea', value: description, maxlength: 2000, rows: 3 },
      { name: 'responsible_id', label: 'Responsible person', type: 'select', required: true, options: memberOptions(members, 'Choose a person') },
      { name: 'due_date', label: 'Due date', type: 'date', required: true, value: addDays(today(), 14),
        validate: (v) => (v < today() ? 'The due date cannot be in the past.' : '') },
      { name: 'priority', label: 'Priority', type: 'select', value: 'medium', options: opt(PRIORITY) },
      { name: 'site_id', label: 'Site', type: 'select', value: site_id ?? '', options: siteOptions(sites) },
      ...(source_id ? [] : [{ name: 'source_type', label: 'Source', type: 'select', value: source_type, options: opt(ACTION_SOURCE) }]),
      { name: 'requires_verification', label: 'Needs verification before closing', type: 'checkbox', value: true,
        hint: 'Someone other than the responsible person must confirm the action worked.' },
      { name: 'verification_method', label: 'How will it be verified?', maxlength: 300, placeholder: 'e.g. Follow-up inspection of the workshop' },
    ],
    onSubmit: async (v) => {
      const reference = await nextRef(org, 'CA');
      return q(sb.from('corrective_actions').insert({
        org_id: org, reference, title: v.title, description: v.description || null,
        source_type: source_id ? source_type : v.source_type, source_id,
        responsible_id: v.responsible_id, due_date: v.due_date, priority: v.priority, site_id: v.site_id || null,
        requires_verification: v.requires_verification, verification_method: v.verification_method || null,
      }).select('id, reference').single());
    },
  }).then((r) => { if (r) toast(`Action ${r.reference} raised. The responsible person has been notified.`); return r; });
}

// Compact list of actions for a source record, used on detail pages.
export async function actionsPanel({ org, source_type, source_id, site_id, canRaise, defaultTitle = '', onChange }) {
  const [rows, names] = await Promise.all([
    q(sb.from('corrective_actions').select('id, reference, title, status, due_date, responsible_id, priority')
      .eq('org_id', org).eq('source_type', source_type).eq('source_id', source_id).order('created_at')),
    nameMap(org),
  ]);
  const card = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Corrective actions'),
      canRaise ? h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: async () => {
        const r = await createAction({ org, source_type, source_id, site_id, title: defaultTitle });
        if (r) onChange?.();
      } }, 'Raise action') : null));
  if (!rows.length) card.append(h('p', { class: 'muted' }, 'No actions raised yet.'));
  else card.append(h('ul', { class: 'file-list' }, rows.map((a) => h('li', {},
    h('span', {}, h('a', { class: 'row-link', href: `#/actions/${a.id}` }, `${a.reference} ${a.title}`),
      h('br'), h('span', { class: 'muted small' }, `${names.get(a.responsible_id) || '—'}, due ${fmtDate(a.due_date)}`)),
    statusBadge(a.status, ACTION_STATUS)))));
  return card;
}

export async function render(view, ctx) {
  if (ctx.params[0]) return renderDetail(view, ctx, ctx.params[0]);
  return renderList(view, ctx);
}

const FILTERS = [
  ['open', 'All open'], ['mine', 'Assigned to me'], ['overdue', 'Overdue'],
  ['verify', 'Awaiting verification'], ['closed', 'Closed'], ['all', 'All'],
];

async function renderList(view, { state, can, query, reload }) {
  const org = state.org.id;
  const f = query.get('f') || (can.staff ? 'open' : 'mine');
  const site = query.get('site') || '';
  let qy = sb.from('corrective_actions')
    .select('id, reference, title, source_type, responsible_id, due_date, priority, status, site_id')
    .eq('org_id', org).order('due_date', { ascending: true }).limit(500);
  if (f === 'open' || f === 'mine' || f === 'overdue') qy = qy.in('status', ['open', 'in_progress', 'awaiting_verification']);
  if (f === 'mine') qy = qy.eq('responsible_id', state.user.id);
  if (f === 'overdue') qy = qy.lt('due_date', today()).in('status', ['open', 'in_progress']);
  if (f === 'verify') qy = qy.eq('status', 'awaiting_verification');
  if (f === 'closed') qy = qy.in('status', ['closed', 'cancelled']);
  if (site) qy = qy.eq('site_id', site);
  const [rows, names, sites] = await Promise.all([q(qy), nameMap(org), loadSites(org)]);

  view.append(h('div', { class: 'page-title' },
    h('div', {}, h('h1', {}, 'Corrective actions'), h('p', {}, 'Every action from risk assessments, inspections, incidents and audits, in one register.')),
    can.field ? h('button', { class: 'btn btn-primary', onclick: async () => { if (await createAction({ org })) reload(); } }, 'Raise action') : null));

  view.append(h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter actions' },
    FILTERS.filter(([k]) => can.staff || ['mine', 'closed'].includes(k)).map(([k, l]) =>
      h('button', { class: 'chip', type: 'button', 'aria-pressed': String(f === k), onclick: () => setQuery('actions', { f: k, site }) }, l))));
  if (can.staff && sites.length > 1) {
    view.append(h('div', { class: 'filters' }, h('label', {}, 'Site',
      h('select', { onchange: (e) => setQuery('actions', { f, site: e.target.value }) },
        siteOptions(sites, 'All sites').map(([v, l]) => h('option', { value: v, selected: v === site }, l))))));
  }

  const card = h('div', { class: 'card' });
  view.append(card);
  if (!rows.length) {
    card.append(emptyState(f === 'overdue' ? 'Nothing overdue' : 'No actions here',
      f === 'mine' ? 'Actions assigned to you will appear here.' : 'Actions raised from inspections, incidents and risk assessments will appear here.'));
    return;
  }
  card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, ['Reference', 'Action', 'Source', 'Responsible', 'Due', 'Priority', 'Status'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((a) => {
      const late = isOverdue(a.due_date, a.status);
      return h('tr', {},
        h('td', { 'data-label': 'Reference' }, h('span', { class: 'ref' }, a.reference)),
        h('td', { 'data-label': 'Action' }, h('a', { class: 'row-link', href: `#/actions/${a.id}` }, a.title)),
        h('td', { 'data-label': 'Source' }, ACTION_SOURCE[a.source_type]),
        h('td', { 'data-label': 'Responsible' }, names.get(a.responsible_id) || '—'),
        h('td', { 'data-label': 'Due' }, h('span', { class: late ? 'overdue' : '' }, fmtDate(a.due_date), late ? ' (overdue)' : '')),
        h('td', { 'data-label': 'Priority' }, statusBadge(a.priority, PRIORITY)),
        h('td', { 'data-label': 'Status' }, statusBadge(a.status, ACTION_STATUS)));
    })))));
  card.append(h('p', { class: 'muted small', style: 'margin:10px 0 0' }, `${rows.length} action${rows.length === 1 ? '' : 's'}`));
}

async function renderDetail(view, { state, can, reload }, id) {
  const org = state.org.id;
  const a = await q(sb.from('corrective_actions').select('*').eq('id', id).maybeSingle());
  if (!a) { view.append(h('div', { class: 'card' }, emptyState('Action not found', 'It may have been deleted, or you may not have access to it.'))); return; }
  const [names, members, sites, evidence] = await Promise.all([
    nameMap(org), loadMembers(org), loadSites(org),
    q(sb.from('action_evidence').select('*').eq('action_id', id).order('created_at')),
  ]);
  const me = state.user.id;
  const isResp = a.responsible_id === me;
  const active = ['open', 'in_progress'].includes(a.status);
  const late = isOverdue(a.due_date, a.status);
  const update = async (patch, msg) => {
    try { await q(sb.from('corrective_actions').update(patch).eq('id', id)); toast(msg); reload(); }
    catch (e) { toast(errMsg(e), 'err'); }
  };

  view.append(h('a', { class: 'back', href: '#/actions' }, 'Back to corrective actions'));
  view.append(h('div', { class: 'page-title' },
    h('div', {}, h('h1', {}, a.title), h('p', {}, h('span', { class: 'ref' }, a.reference), ' ', statusBadge(a.status, ACTION_STATUS), ' ', statusBadge(a.priority, PRIORITY)))));

  // Workflow buttons
  const buttons = [];
  if ((isResp || can.edit) && a.status === 'open') buttons.push(h('button', { class: 'btn btn-secondary', onclick: () => update({ status: 'in_progress' }, 'Marked as in progress.') }, 'Start work'));
  if ((isResp || can.edit) && active) {
    buttons.push(h('button', { class: 'btn btn-primary', onclick: async () => {
      const ok = await confirmAction(a.requires_verification ? 'Submit for verification?' : 'Close this action?',
        a.requires_verification ? 'A safety officer or OHS manager will check that the action worked before it is closed. Attach evidence first if you have it.'
          : 'This action does not need verification, so it will be closed now.',
        a.requires_verification ? 'Submit for verification' : 'Close action', false);
      if (ok) update({ status: a.requires_verification ? 'awaiting_verification' : 'closed' }, a.requires_verification ? 'Submitted for verification.' : 'Action closed.');
    } }, a.requires_verification ? 'Mark as done' : 'Close action'));
  }
  if (can.edit && a.status === 'awaiting_verification' && !isResp) {
    buttons.push(h('button', { class: 'btn btn-primary', onclick: async () => {
      const r = await modalForm({ title: 'Verify this action', intro: a.verification_method ? `Verification method: ${a.verification_method}` : 'Confirm whether the action has effectively controlled the risk.',
        submitLabel: 'Record verification',
        fields: [{ name: 'outcome', label: 'Outcome', type: 'select', required: true, value: '',
          options: [['', 'Choose an outcome'], ['effective', 'Effective: close the action'], ['not_effective', 'Not effective: send back to the responsible person']] }],
        onSubmit: async (v) => {
          await q(sb.from('corrective_actions').update({ verification_outcome: v.outcome, verified_at: new Date().toISOString() }).eq('id', id));
          await q(sb.from('corrective_actions').update({ status: v.outcome === 'effective' ? 'closed' : 'in_progress' }).eq('id', id));
        } });
      if (r) { toast(r.outcome === 'effective' ? 'Verified and closed.' : 'Sent back for further work.'); reload(); }
    } }, 'Verify'));
  }
  if (can.edit && a.status === 'awaiting_verification' && isResp) {
    buttons.push(h('span', { class: 'muted small' }, 'Another safety officer or manager must verify this action, because you are responsible for it.'));
  }
  if (can.edit && a.status !== 'closed' && a.status !== 'cancelled') {
    buttons.push(h('button', { class: 'btn btn-secondary', onclick: () => editAction(a, members, sites).then((r) => r && reload()) }, 'Edit'));
    buttons.push(h('button', { class: 'btn-link danger', onclick: async () => {
      if (await confirmAction('Cancel this action?', 'The action stays in the register as cancelled.', 'Cancel action')) update({ status: 'cancelled' }, 'Action cancelled.');
    } }, 'Cancel action'));
  }
  if (buttons.length) view.append(h('div', { class: 'btn-row no-print', style: 'margin-bottom:18px' }, buttons));

  const src = SOURCE_LINK[a.source_type] && a.source_id ? h('a', { href: SOURCE_LINK[a.source_type](a.source_id) }, ACTION_SOURCE[a.source_type]) : ACTION_SOURCE[a.source_type];
  view.append(h('div', { class: 'detail-grid' },
    h('div', { class: 'card' },
      h('h2', {}, 'Details'),
      a.description ? h('p', { class: 'prose-block' }, a.description) : h('p', { class: 'muted' }, 'No further details.'),
      kv([
        ['Source', src],
        ['Responsible', names.get(a.responsible_id) || '—'],
        ['Due date', h('span', { class: late ? 'overdue' : '' }, fmtDate(a.due_date), late ? ' (overdue)' : '')],
        ['Site', sites.find((s) => s.id === a.site_id)?.name || '—'],
        ['Raised by', names.get(a.created_by) || '—'],
        ['Raised on', fmtDate(a.created_at)],
        ['Verification', a.requires_verification ? (a.verification_method || 'Required') : 'Not required'],
        a.verified_at ? ['Verified', `${a.verification_outcome === 'effective' ? 'Effective' : 'Not effective'}, by ${names.get(a.verified_by) || '—'} on ${fmtDate(a.verified_at)}`] : null,
        a.closed_at ? ['Closed on', fmtDate(a.closed_at)] : null,
      ])),
    evidenceCard(org, a, evidence, isResp || can.field, reload)));
}

function evidenceCard(org, a, evidence, canAdd, reload) {
  const card = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Evidence'),
    canAdd && a.status !== 'closed' && a.status !== 'cancelled' ? fileButton('Add files', async (files) => {
      for (const file of files) {
        try {
          const up = await uploadFile(org, 'actions', a.id, file);
          await q(sb.from('action_evidence').insert({ action_id: a.id, org_id: org, storage_path: up.path, file_name: up.name }));
        } catch (e) { toast(errMsg(e), 'err'); return; }
      }
      toast('Evidence added.'); reload();
    }, { capture: false }) : null));
  if (!evidence.length) card.append(h('p', { class: 'muted' }, 'Photos or documents showing the action was completed.'));
  else card.append(h('ul', { class: 'file-list' }, evidence.map((e) => h('li', {}, h('span', {}, e.file_name),
    h('button', { class: 'btn-link', onclick: () => openFile(e.storage_path).catch((x) => toast(errMsg(x), 'err')) }, 'Open')))));
  return card;
}

function editAction(a, members, sites) {
  return modalForm({
    title: `Edit ${a.reference}`, submitLabel: 'Save action',
    fields: [
      { name: 'title', label: 'Action', required: true, value: a.title, maxlength: 200 },
      { name: 'description', label: 'Details', type: 'textarea', value: a.description, maxlength: 2000, rows: 3 },
      { name: 'responsible_id', label: 'Responsible person', type: 'select', required: true, value: a.responsible_id, options: memberOptions(members, 'Choose a person') },
      { name: 'due_date', label: 'Due date', type: 'date', required: true, value: a.due_date },
      { name: 'priority', label: 'Priority', type: 'select', value: a.priority, options: opt(PRIORITY) },
      { name: 'site_id', label: 'Site', type: 'select', value: a.site_id ?? '', options: siteOptions(sites) },
      { name: 'requires_verification', label: 'Needs verification before closing', type: 'checkbox', value: a.requires_verification },
      { name: 'verification_method', label: 'How will it be verified?', value: a.verification_method, maxlength: 300 },
    ],
    onSubmit: async (v) => q(sb.from('corrective_actions').update({
      title: v.title, description: v.description || null, responsible_id: v.responsible_id, due_date: v.due_date,
      priority: v.priority, site_id: v.site_id || null, requires_verification: v.requires_verification,
      verification_method: v.verification_method || null,
    }).eq('id', a.id)),
  }).then((r) => { if (r) toast('Action saved.'); return r; });
}
