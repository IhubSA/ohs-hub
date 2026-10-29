// Incidents: reporting (open to everyone), persons involved, witnesses,
// evidence, investigation workflow and statutory reporting tracking.
// Closing and approval rules are enforced by the database.
import { sb, q } from '../sb.js';
import { h, modalForm, confirmAction, toast, errMsg, emptyState, fmtDate, fmtDateTime, opt } from '../ui.js';
import {
  loadMembers, loadSites, loadDepts, loadMethodology, nameMap, nextRef, memberOptions, siteOptions,
  INCIDENT_CATEGORIES, INCIDENT_STATUS, INVESTIGATION_STATUS, statusBadge, kv, uploadFile, openFile, fileButton, setQuery, today, addDays,
} from '../data.js';
import { actionsPanel } from './actions.js';
import { aiQuota, aiAvailability, callAI, withBusy, reviewPanel, suggestionDialog, aiError } from '../ai.js';

const INVOLVEMENT = { injured: 'Injured person', involved: 'Involved', first_aider: 'First aider', supervisor_on_duty: 'Supervisor on duty', other: 'Other' };
const FINDING = { immediate_cause: 'Immediate cause', underlying_cause: 'Underlying cause', contributing_factor: 'Contributing factor', finding: 'Other finding' };
const STAT_STATUS = { assessing: 'Assessing whether reportable', not_required: 'Not required', required: 'Required, not yet submitted', submitted: 'Submitted', confirmed: 'Submission confirmed' };
const nowLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

export async function render(view, ctx) {
  if (ctx.params[0]) return renderDetail(view, ctx, ctx.params[0]);
  return renderList(view, ctx);
}

export async function reportIncident(state) {
  const org = state.org.id;
  const [sites, depts, meth, orgRow] = await Promise.all([loadSites(org), loadDepts(org), loadMethodology(org),
    q(sb.from('organisations').select('settings').eq('id', org).single())]);
  const confidentialOn = orgRow?.settings?.confidential_incidents_enabled !== false;
  return modalForm({
    title: 'Report an incident', submitLabel: 'Submit report',
    intro: 'Report what happened as soon as it is safe to do so. You can add people, witnesses and photos after submitting.',
    fields: [
      { name: 'category', label: 'What kind of event?', type: 'select', required: true, value: '', options: [['', 'Choose a category'], ...Object.entries(INCIDENT_CATEGORIES)] },
      { name: 'title', label: 'Short title', required: true, maxlength: 200, placeholder: 'e.g. Worker slipped on wet floor in canteen' },
      { name: 'occurred_at', label: 'When did it happen?', type: 'datetime-local', required: true, value: nowLocal(),
        validate: (v) => (new Date(v) > new Date(Date.now() + 5 * 60000) ? 'The date cannot be in the future.' : '') },
      { name: 'site_id', label: 'Site', type: 'select', options: siteOptions(sites) },
      { name: 'department_id', label: 'Department', type: 'select', options: [['', 'Not sure / not applicable'], ...depts.map((d) => [d.id, d.name])] },
      { name: 'location_detail', label: 'Exact location', maxlength: 300, placeholder: 'e.g. Loading bay 2' },
      { name: 'description', label: 'What happened?', type: 'textarea', required: true, rows: 4, maxlength: 4000 },
      { name: 'actual_consequences', label: 'What were the consequences?', type: 'textarea', rows: 2, maxlength: 2000, placeholder: 'Injuries, damage, lost time' },
      { name: 'potential_consequences', label: 'What could have happened?', type: 'textarea', rows: 2, maxlength: 2000 },
      ...(meth ? [{ name: 'potential_severity', label: 'Worst credible outcome', type: 'select', value: '',
        options: [['', 'Not sure'], ...meth.severity_labels.map((l, i) => [String(i + 1), `${i + 1}: ${l}`])] }] : []),
      { name: 'immediate_controls', label: 'What was done immediately?', type: 'textarea', rows: 2, maxlength: 2000, placeholder: 'e.g. Area barricaded, first aid given' },
      ...(confidentialOn ? [{ name: 'is_confidential', label: 'Keep this report confidential', type: 'checkbox', value: false,
        hint: 'Only administrators, OHS managers and people they authorise will see it.' }] : []),
    ],
    onSubmit: async (v) => {
      const reference = await nextRef(org, 'INC');
      return q(sb.from('incidents').insert({
        org_id: org, reference, category: v.category, title: v.title, occurred_at: new Date(v.occurred_at).toISOString(),
        site_id: v.site_id || null, department_id: v.department_id || null, location_detail: v.location_detail || null,
        description: v.description, actual_consequences: v.actual_consequences || null, potential_consequences: v.potential_consequences || null,
        potential_severity: v.potential_severity ? +v.potential_severity : null, immediate_controls: v.immediate_controls || null,
        is_confidential: !!v.is_confidential, reported_by: state.user.id,
      }).select('id, reference').single());
    },
  }).then((r) => { if (r) toast(`Incident ${r.reference} reported. Your OHS manager has been notified.`); return r; });
}

async function renderList(view, { state, can, query }) {
  const org = state.org.id;
  const f = query.get('f') || (can.staff ? 'open' : 'mine');
  const cat = query.get('cat') || '';
  let qy = sb.from('incidents').select('id, reference, title, category, occurred_at, site_id, status, is_confidential, reported_by')
    .eq('org_id', org).order('occurred_at', { ascending: false }).limit(500);
  if (f === 'open') qy = qy.neq('status', 'closed');
  if (f === 'awaiting') qy = qy.in('status', ['reported']);
  if (f === 'mine') qy = qy.eq('reported_by', state.user.id);
  if (f === 'closed') qy = qy.eq('status', 'closed');
  if (cat) qy = qy.eq('category', cat);
  const [rows, sites] = await Promise.all([q(qy), loadSites(org)]);

  view.append(h('div', { class: 'page-title' },
    h('div', {}, h('h1', {}, 'Incidents'), h('p', {}, can.staff ? 'Injuries, near misses, dangerous occurrences and unsafe conditions.' : 'Report incidents and hazards, and follow the ones you reported.')),
    h('button', { class: 'btn btn-primary', onclick: async () => { const r = await reportIncident(state); if (r) location.hash = `#/incidents/${r.id}`; } }, 'Report an incident')));
  const filters = can.staff ? [['open', 'Open'], ['awaiting', 'Awaiting investigation'], ['mine', 'Reported by me'], ['closed', 'Closed'], ['all', 'All']] : [['mine', 'Reported by me']];
  view.append(h('div', { class: 'filters' },
    h('div', { class: 'chips', style: 'margin:0' }, filters.map(([k, l]) => h('button', { class: 'chip', 'aria-pressed': String(f === k), onclick: () => setQuery('incidents', { f: k, cat }) }, l))),
    can.staff ? h('label', {}, 'Category', h('select', { onchange: (e) => setQuery('incidents', { f, cat: e.target.value }) },
      [['', 'All categories'], ...Object.entries(INCIDENT_CATEGORIES)].map(([v, l]) => h('option', { value: v, selected: v === cat }, l)))) : null));
  const card = h('div', { class: 'card' });
  view.append(card);
  if (!rows.length) { card.append(emptyState('No incidents here', 'When something happens, use "Report an incident". Near misses matter too.')); return; }
  card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, ['Reference', 'What happened', 'Category', 'When', 'Site', 'Status'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((r) => h('tr', {},
      h('td', { 'data-label': 'Reference' }, h('span', { class: 'ref' }, r.reference)),
      h('td', { 'data-label': 'What happened' }, h('a', { class: 'row-link', href: `#/incidents/${r.id}` }, r.title), r.is_confidential ? h('div', { class: 'muted small' }, 'Confidential') : null),
      h('td', { 'data-label': 'Category' }, INCIDENT_CATEGORIES[r.category]),
      h('td', { 'data-label': 'When' }, fmtDateTime(r.occurred_at)),
      h('td', { 'data-label': 'Site' }, sites.find((s) => s.id === r.site_id)?.name || '—'),
      h('td', { 'data-label': 'Status' }, statusBadge(r.status, INCIDENT_STATUS))))))));
}

async function renderDetail(view, { state, can, reload }, id) {
  const org = state.org.id;
  const inc = await q(sb.from('incidents').select('*').eq('id', id).maybeSingle());
  if (!inc) { view.append(h('div', { class: 'card' }, emptyState('Incident not found', 'It may have been deleted, or you may not have access to it.'))); return; }
  const me = state.user.id;
  const isReporter = inc.reported_by === me;
  const [persons, witnesses, evidence, inv, sites, depts, names, members, meth, employees] = await Promise.all([
    q(sb.from('incident_persons').select('*').eq('incident_id', id).order('created_at')),
    q(sb.from('incident_witnesses').select('*').eq('incident_id', id).order('created_at')),
    q(sb.from('incident_evidence').select('*').eq('incident_id', id).order('created_at')),
    q(sb.from('incident_investigations').select('*').eq('incident_id', id).maybeSingle()),
    loadSites(org), loadDepts(org), nameMap(org), loadMembers(org), loadMethodology(org),
    can.staff ? q(sb.from('employees').select('id, first_name, last_name').eq('org_id', org).eq('status', 'active').order('last_name')) : [],
  ]);
  const isInvestigator = inv?.investigator_id === me;
  const canAddInfo = can.edit || (isReporter && inc.status === 'reported');
  const closed = inc.status === 'closed';

  view.append(h('a', { class: 'back no-print', href: '#/incidents' }, 'Back to incidents'));
  view.append(h('div', { class: 'page-title' }, h('div', {}, h('h1', {}, inc.title),
    h('p', {}, h('span', { class: 'ref' }, inc.reference), ' ', INCIDENT_CATEGORIES[inc.category], ' ', statusBadge(inc.status, INCIDENT_STATUS),
      inc.is_confidential ? [' ', statusBadge('Confidential', {})] : null))));

  const buttons = [];
  if (can.edit && !closed) buttons.push(h('button', { class: 'btn btn-secondary', onclick: () => editIncident(inc, sites, depts, meth).then((r) => r && reload()) }, 'Edit details'));
  if (can.manage && !closed && (!inv || inv.status === 'approved')) buttons.push(h('button', { class: 'btn btn-primary', onclick: async () => {
    const { count } = await sb.from('corrective_actions').select('id', { count: 'exact', head: true }).eq('source_type', 'incident').eq('source_id', id).in('status', ['open', 'in_progress', 'awaiting_verification']);
    const r = await confirmAction('Close this incident?', count ? `${count} corrective action${count === 1 ? ' is' : 's are'} still open and will continue to be tracked in the action register.` : 'The incident record becomes final.', 'Close incident', false);
    if (r) { try { await q(sb.from('incidents').update({ status: 'closed' }).eq('id', id)); toast('Incident closed.'); reload(); } catch (e) { toast(errMsg(e), 'err'); } }
  } }, 'Close incident'));
  buttons.push(h('button', { class: 'btn btn-secondary', onclick: () => window.print() }, 'Print'));
  view.append(h('div', { class: 'btn-row no-print', style: 'margin-bottom:18px' }, buttons));

  const sevLabel = inc.potential_severity && meth ? `${inc.potential_severity}: ${meth.severity_labels[inc.potential_severity - 1]}` : '—';
  view.append(h('div', { class: 'detail-grid' },
    h('div', { class: 'card' }, h('h2', {}, 'What happened'),
      h('p', { class: 'prose-block' }, inc.description),
      kv([
        ['When', fmtDateTime(inc.occurred_at)],
        ['Where', [sites.find((s) => s.id === inc.site_id)?.name, inc.location_detail].filter(Boolean).join(', ') || '—'],
        ['Department', depts.find((d) => d.id === inc.department_id)?.name || '—'],
        ['Consequences', inc.actual_consequences || '—'],
        ['Could have been', inc.potential_consequences || '—'],
        ['Worst credible outcome', sevLabel],
        ['Immediate controls', inc.immediate_controls || '—'],
        ['Reported by', names.get(inc.reported_by) || '—'],
        ['Reported on', fmtDateTime(inc.reported_at)],
        inc.closed_at ? ['Closed on', fmtDateTime(inc.closed_at)] : null,
      ])),
    h('div', {},
      peopleCard(org, inc, persons, employees, canAddInfo && !closed, can.staff || isReporter, reload),
      witnessCard(org, inc, witnesses, canAddInfo && !closed, reload),
      evidenceCard(org, inc, evidence, canAddInfo && !closed, reload))));

  const aiAvail = inv && (can.edit || isInvestigator) ? aiAvailability(await aiQuota(org)) : { ok: false };
  if (can.staff || isInvestigator) view.append(investigationCard({ org, inc, inv, members, names, can, me, reload, aiAvail }));
  if (inv) view.append(await findingsCard({ org, inv, can, me, reload }));
  if (can.staff) {
    view.append(await statutoryCard({ org, inc, members, names, can, reload }));
    view.append(await actionsPanel({ org, source_type: 'incident', source_id: id, site_id: inc.site_id, canRaise: can.field, onChange: reload }));
  }
}

function editIncident(inc, sites, depts, meth) {
  const local = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
  return modalForm({
    title: `Edit ${inc.reference}`, submitLabel: 'Save',
    fields: [
      { name: 'category', label: 'Category', type: 'select', value: inc.category, options: Object.entries(INCIDENT_CATEGORIES) },
      { name: 'title', label: 'Short title', required: true, value: inc.title, maxlength: 200 },
      { name: 'occurred_at', label: 'When', type: 'datetime-local', required: true, value: local(inc.occurred_at) },
      { name: 'site_id', label: 'Site', type: 'select', value: inc.site_id ?? '', options: siteOptions(sites) },
      { name: 'department_id', label: 'Department', type: 'select', value: inc.department_id ?? '', options: [['', 'None'], ...depts.map((d) => [d.id, d.name])] },
      { name: 'location_detail', label: 'Exact location', value: inc.location_detail, maxlength: 300 },
      { name: 'description', label: 'What happened', type: 'textarea', required: true, rows: 4, value: inc.description, maxlength: 4000 },
      { name: 'actual_consequences', label: 'Consequences', type: 'textarea', rows: 2, value: inc.actual_consequences, maxlength: 2000 },
      { name: 'potential_consequences', label: 'Could have been', type: 'textarea', rows: 2, value: inc.potential_consequences, maxlength: 2000 },
      ...(meth ? [{ name: 'potential_severity', label: 'Worst credible outcome', type: 'select', value: inc.potential_severity ? String(inc.potential_severity) : '',
        options: [['', 'Not sure'], ...meth.severity_labels.map((l, i) => [String(i + 1), `${i + 1}: ${l}`])] }] : []),
      { name: 'immediate_controls', label: 'Immediate controls', type: 'textarea', rows: 2, value: inc.immediate_controls, maxlength: 2000 },
    ],
    onSubmit: (v) => q(sb.from('incidents').update({
      category: v.category, title: v.title, occurred_at: new Date(v.occurred_at).toISOString(), site_id: v.site_id || null,
      department_id: v.department_id || null, location_detail: v.location_detail || null, description: v.description,
      actual_consequences: v.actual_consequences || null, potential_consequences: v.potential_consequences || null,
      potential_severity: v.potential_severity ? +v.potential_severity : null, immediate_controls: v.immediate_controls || null,
    }).eq('id', inc.id)),
  }).then((r) => { if (r) toast('Incident saved.'); return r; });
}

function peopleCard(org, inc, persons, employees, canAdd, canSee, reload) {
  const card = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'People involved'),
    canAdd ? h('button', { class: 'btn btn-secondary btn-sm', onclick: () => modalForm({
      title: 'Add a person', submitLabel: 'Add person',
      intro: 'Injury details are sensitive personal information. Record only what is needed for the investigation.',
      fields: [
        ...(employees.length ? [{ name: 'employee_id', label: 'Employee', type: 'select', options: [['', 'Not an employee / not listed'], ...employees.map((e) => [e.id, `${e.first_name} ${e.last_name}`])] }] : []),
        { name: 'person_name', label: 'Name (if not listed)', maxlength: 120 },
        { name: 'involvement', label: 'Involvement', type: 'select', value: 'involved', options: Object.entries(INVOLVEMENT) },
        { name: 'injury_details', label: 'Injury details', type: 'textarea', rows: 2, maxlength: 1000 },
      ],
      onSubmit: (v) => {
        if (!v.employee_id && !v.person_name) throw new Error('Choose an employee or enter a name.');
        return q(sb.from('incident_persons').insert({ incident_id: inc.id, org_id: org, employee_id: v.employee_id || null,
          person_name: v.person_name || null, involvement: v.involvement, injury_details: v.injury_details || null }));
      } }).then((r) => { if (r) { toast('Person added.'); reload(); } }) }, 'Add') : null));
  const empName = (pid) => { const e = employees.find((x) => x.id === pid); return e ? `${e.first_name} ${e.last_name}` : null; };
  if (!canSee) card.append(h('p', { class: 'muted' }, 'Visible to the OHS team.'));
  else if (!persons.length) card.append(h('p', { class: 'muted' }, 'No people recorded.'));
  else card.append(h('ul', { class: 'file-list' }, persons.map((p) => h('li', {},
    h('span', {}, h('strong', {}, empName(p.employee_id) || p.person_name || 'Unnamed'), ` (${INVOLVEMENT[p.involvement]})`,
      p.injury_details ? h('div', { class: 'small' }, p.injury_details) : null)))));
  return card;
}

function witnessCard(org, inc, witnesses, canAdd, reload) {
  const card = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Witnesses'),
    canAdd ? h('button', { class: 'btn btn-secondary btn-sm', onclick: () => modalForm({
      title: 'Add a witness', submitLabel: 'Add witness',
      fields: [
        { name: 'witness_name', label: 'Name', required: true, maxlength: 120 },
        { name: 'contact', label: 'Contact details', maxlength: 200 },
        { name: 'statement', label: 'Statement', type: 'textarea', rows: 4, maxlength: 4000 },
        { name: 'statement_taken_on', label: 'Statement taken on', type: 'date', value: today() },
      ],
      onSubmit: (v) => q(sb.from('incident_witnesses').insert({ incident_id: inc.id, org_id: org, witness_name: v.witness_name,
        contact: v.contact || null, statement: v.statement || null, statement_taken_on: v.statement ? v.statement_taken_on || null : null })),
    }).then((r) => { if (r) { toast('Witness added.'); reload(); } }) }, 'Add') : null));
  if (!witnesses.length) card.append(h('p', { class: 'muted' }, 'No witnesses recorded.'));
  else card.append(h('ul', { class: 'file-list' }, witnesses.map((w) => h('li', {}, h('span', {}, h('strong', {}, w.witness_name),
    w.contact ? ` (${w.contact})` : '', w.statement ? h('div', { class: 'small prose-block' }, w.statement) : null,
    w.statement_taken_on ? h('div', { class: 'muted small' }, `Statement taken ${fmtDate(w.statement_taken_on)}`) : null)))));
  return card;
}

function evidenceCard(org, inc, evidence, canAdd, reload) {
  const card = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Photos and evidence'),
    canAdd ? fileButton('Add files', async (files) => {
      for (const file of files) {
        try {
          const up = await uploadFile(org, 'incidents', inc.id, file);
          await q(sb.from('incident_evidence').insert({ incident_id: inc.id, org_id: org, storage_path: up.path, file_name: up.name, mime_type: up.type || null }));
        } catch (e) { toast(errMsg(e), 'err'); return; }
      }
      toast('Evidence added.'); reload();
    }, { capture: true }) : null));
  if (!evidence.length) card.append(h('p', { class: 'muted' }, 'No photos or files yet.'));
  else card.append(h('ul', { class: 'file-list' }, evidence.map((e) => h('li', {},
    h('span', {}, e.file_name, h('div', { class: 'muted small' }, fmtDateTime(e.created_at))),
    h('button', { class: 'btn-link', onclick: () => openFile(e.storage_path).catch((x) => toast(errMsg(x), 'err')) }, 'Open')))));
  return card;
}

function investigationCard({ org, inc, inv, members, names, can, me, reload, aiAvail }) {
  const card = h('div', { class: 'card' }, h('h2', {}, 'Investigation'));
  const investigators = members.filter((m) => ['org_admin', 'ohs_manager', 'safety_officer', 'supervisor'].includes(m.role));
  if (!inv) {
    card.append(h('p', { class: 'muted' }, 'No investigation has been started.'));
    if (can.edit && inc.status !== 'closed') card.append(h('button', { class: 'btn btn-primary', onclick: () => modalForm({
      title: 'Start an investigation', submitLabel: 'Assign investigator',
      fields: [
        { name: 'investigator_id', label: 'Investigator', type: 'select', required: true, options: memberOptions(investigators, 'Choose an investigator') },
        { name: 'target_date', label: 'Target completion date', type: 'date', value: addDays(today(), 14) },
      ],
      onSubmit: (v) => q(sb.from('incident_investigations').insert({ incident_id: inc.id, org_id: org, investigator_id: v.investigator_id, target_date: v.target_date || null })),
    }).then((r) => { if (r) { toast('Investigator assigned and notified.'); reload(); } }) }, 'Start investigation'));
    return card;
  }
  const isInv = inv.investigator_id === me;
  const working = ['assigned', 'in_progress', 'returned'].includes(inv.status);
  const canWork = working && (isInv || can.edit);
  const upd = async (patch, msg) => {
    if (inv.status === 'assigned' && !patch.status) patch.status = 'in_progress';
    try { await q(sb.from('incident_investigations').update(patch).eq('id', inv.id)); if (msg) toast(msg); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  };

  card.append(kv([
    ['Status', statusBadge(inv.status, INVESTIGATION_STATUS)],
    ['Investigator', names.get(inv.investigator_id) || '—'],
    ['Target date', fmtDate(inv.target_date)],
    inv.submitted_at ? ['Submitted', fmtDateTime(inv.submitted_at)] : null,
    inv.approved_at ? ['Approved', `${names.get(inv.reviewer_id) || '—'}, ${fmtDateTime(inv.approved_at)}`] : null,
    inv.reviewer_comments ? ['Reviewer comments', inv.reviewer_comments] : null,
  ]));

  // Timeline
  const timeline = inv.timeline || [];
  card.append(h('h3', { class: 'section-label' }, 'Event timeline'));
  card.append(timeline.length ? h('ol', { class: 'timeline' }, [...timeline].sort((a, b) => (a.at > b.at ? 1 : -1)).map((t, i) => h('li', {},
    h('time', {}, fmtDateTime(t.at)), t.event,
    canWork ? h('button', { class: 'btn-link danger', onclick: () => upd({ timeline: timeline.filter((x) => x !== t) }) }, 'Remove') : null))) : h('p', { class: 'muted' }, 'No events added.'));
  if (canWork) card.append(h('button', { class: 'btn btn-secondary btn-sm', onclick: () => modalForm({ title: 'Add a timeline event', submitLabel: 'Add event',
    fields: [{ name: 'at', label: 'When', type: 'datetime-local', required: true, value: nowLocal() }, { name: 'event', label: 'What happened', required: true, maxlength: 500 }],
    onSubmit: async (v) => upd({ timeline: [...timeline, { at: new Date(v.at).toISOString(), event: v.event }] }) }) }, 'Add event'));

  // 5 Whys
  const whys = inv.five_whys || [];
  card.append(h('h3', { class: 'section-label' }, '5 Whys analysis'));
  card.append(whys.length ? h('ol', { class: 'whys' }, whys.map((w, i) => h('li', {}, h('span', {}, w),
    canWork ? h('button', { class: 'btn-link danger', onclick: () => upd({ five_whys: whys.filter((_, j) => j !== i) }) }, 'Remove') : h('span')))) : h('p', { class: 'muted' }, 'Ask "why?" until you reach a root cause you can act on.'));
  if (canWork && whys.length < 7) card.append(h('button', { class: 'btn btn-secondary btn-sm', onclick: () => modalForm({ title: `Why ${whys.length + 1}?`, submitLabel: 'Add',
    intro: whys.length ? `Previous answer: ${whys[whys.length - 1]}` : `Start from the event: ${inc.title}`,
    fields: [{ name: 'why', label: 'Because…', required: true, maxlength: 500 }],
    onSubmit: async (v) => upd({ five_whys: [...whys, v.why] }) }) }, 'Add a why'));

  // Summary and recommendations
  card.append(h('h3', { class: 'section-label' }, 'Summary'), h('p', { class: inv.summary ? 'prose-block' : 'muted' }, inv.summary || 'Not written yet.'));
  card.append(h('h3', { class: 'section-label' }, 'Recommendations'), h('p', { class: inv.recommendations ? 'prose-block' : 'muted' }, inv.recommendations || 'Not written yet.'));

  const btns = [];
  if (canWork) {
    btns.push(h('button', { class: 'btn btn-secondary', onclick: () => modalForm({ title: 'Summary and recommendations', submitLabel: 'Save',
      fields: [{ name: 'summary', label: 'Summary of findings', type: 'textarea', rows: 5, value: inv.summary, maxlength: 6000 },
        { name: 'recommendations', label: 'Recommendations', type: 'textarea', rows: 4, value: inv.recommendations, maxlength: 4000 },
        { name: 'target_date', label: 'Target date', type: 'date', value: inv.target_date }],
      onSubmit: async (v) => upd({ summary: v.summary || null, recommendations: v.recommendations || null, target_date: v.target_date || null }, 'Investigation saved.') }) }, 'Write summary'));
    if (aiAvail?.ok) btns.push(h('button', { class: 'btn btn-secondary', onclick: () => investigationSupport(org, inc, inv, reload) }, 'Suggest questions with AI'));
    btns.push(h('button', { class: 'btn btn-primary', onclick: async () => {
      if (!inv.summary) { toast('Write a summary of findings before submitting.', 'err'); return; }
      if (await confirmAction('Submit for review?', 'An OHS manager or administrator (not the investigator) will review and approve the investigation.', 'Submit for review', false)) upd({ status: 'submitted' }, 'Submitted for review.');
    } }, 'Submit for review'));
    if (can.edit) btns.push(h('button', { class: 'btn-link', onclick: () => modalForm({ title: 'Reassign investigator', submitLabel: 'Reassign',
      fields: [{ name: 'investigator_id', label: 'Investigator', type: 'select', required: true, value: inv.investigator_id, options: memberOptions(members.filter((m) => ['org_admin', 'ohs_manager', 'safety_officer', 'supervisor'].includes(m.role)), 'Choose') }],
      onSubmit: async (v) => upd({ investigator_id: v.investigator_id }, 'Investigator reassigned.') }) }, 'Reassign'));
  }
  if (can.manage && inv.status === 'submitted') {
    if (isInv) card.append(h('p', { class: 'notice' }, 'You investigated this incident, so another manager or administrator must approve it.'));
    else {
      btns.push(h('button', { class: 'btn btn-primary', onclick: () => modalForm({ title: 'Approve investigation', submitLabel: 'Approve',
        fields: [{ name: 'c', label: 'Comments', type: 'textarea', rows: 3, maxlength: 2000 }],
        onSubmit: async (v) => q(sb.from('incident_investigations').update({ status: 'approved', reviewer_comments: v.c || null }).eq('id', inv.id)) })
        .then((r) => { if (r) { toast('Investigation approved. You can now close the incident.'); reload(); } }) }, 'Approve'));
      btns.push(h('button', { class: 'btn btn-secondary', onclick: () => modalForm({ title: 'Return for changes', submitLabel: 'Return',
        fields: [{ name: 'c', label: 'What needs to change?', type: 'textarea', required: true, rows: 3, maxlength: 2000 }],
        onSubmit: async (v) => q(sb.from('incident_investigations').update({ status: 'returned', reviewer_comments: v.c }).eq('id', inv.id)) })
        .then((r) => { if (r) { toast('Returned to the investigator.'); reload(); } }) }, 'Return for changes'));
    }
  }
  if (btns.length) card.append(h('div', { class: 'btn-row no-print', style: 'margin-top:14px' }, btns));
  return card;
}

async function findingsCard({ org, inv, can, me, reload }) {
  const rows = await q(sb.from('investigation_findings').select('*').eq('investigation_id', inv.id).order('created_at'));
  const canWork = ['assigned', 'in_progress', 'returned'].includes(inv.status) && (inv.investigator_id === me || can.edit);
  const card = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Causes and findings'),
    canWork ? h('button', { class: 'btn btn-secondary btn-sm', onclick: () => modalForm({ title: 'Add a cause or finding', submitLabel: 'Add',
      fields: [{ name: 'finding_type', label: 'Type', type: 'select', value: 'immediate_cause', options: Object.entries(FINDING) },
        { name: 'description', label: 'Description', type: 'textarea', required: true, rows: 3, maxlength: 2000 },
        { name: 'is_verified', label: 'Supported by evidence', type: 'checkbox', value: false, hint: 'Leave unticked if this is still a possibility to be confirmed.' }],
      onSubmit: (v) => q(sb.from('investigation_findings').insert({ investigation_id: inv.id, org_id: org, finding_type: v.finding_type, description: v.description, is_verified: v.is_verified })),
    }).then((r) => { if (r) { toast('Finding added.'); reload(); } }) }, 'Add') : null));
  if (!rows.length) { card.append(h('p', { class: 'muted' }, 'Record immediate causes, underlying causes and contributing factors.')); return card; }
  for (const [k, l] of Object.entries(FINDING)) {
    const list = rows.filter((r) => r.finding_type === k);
    if (!list.length) continue;
    card.append(h('h3', { class: 'section-label' }, l), h('ul', { class: 'file-list' }, list.map((f) => h('li', {},
      h('span', {}, f.description, ' ', f.is_verified ? statusBadge('Supported by evidence', {}) : h('span', { class: 'badge warn' }, 'Not yet confirmed')),
      canWork ? h('button', { class: 'btn-link danger', onclick: async () => { try { await q(sb.from('investigation_findings').delete().eq('id', f.id)); reload(); } catch (e) { toast(errMsg(e), 'err'); } } }, 'Remove') : null))));
  }
  return card;
}

async function statutoryCard({ org, inc, members, names, can, reload }) {
  const rows = await q(sb.from('statutory_reports').select('*').eq('incident_id', inc.id).order('created_at'));
  const form = (r = {}) => modalForm({
    title: r.id ? 'Update reporting record' : 'Track an external reporting obligation', submitLabel: 'Save',
    intro: 'OHS Hub does not decide whether an event is reportable. A competent person must confirm the obligation against the current regulations.',
    fields: [
      { name: 'legal_reference', label: 'Legal reference', value: r.legal_reference, maxlength: 300, hint: 'Record the exact regulation you verified.' },
      { name: 'status', label: 'Status', type: 'select', value: r.status || 'assessing', options: Object.entries(STAT_STATUS) },
      { name: 'responsible_id', label: 'Responsible person', type: 'select', value: r.responsible_id ?? '', options: memberOptions(members) },
      { name: 'due_at', label: 'Due by', type: 'datetime-local', value: r.due_at ? new Date(new Date(r.due_at).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '' },
      { name: 'submitted_at', label: 'Submitted on', type: 'date', value: r.submitted_at ? r.submitted_at.slice(0, 10) : '' },
      { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, value: r.notes, maxlength: 2000 },
    ],
    onSubmit: async (v) => {
      if (v.status === 'confirmed' && !can.manage) throw new Error('Only an OHS manager or administrator can confirm a submission.');
      const row = { legal_reference: v.legal_reference || null, status: v.status, responsible_id: v.responsible_id || null,
        due_at: v.due_at ? new Date(v.due_at).toISOString() : null, submitted_at: v.submitted_at ? new Date(v.submitted_at + 'T12:00:00').toISOString() : null,
        notes: v.notes || null, ...(v.status === 'confirmed' && r.status !== 'confirmed' ? { confirmed_at: new Date().toISOString() } : {}) };
      if (r.id) return q(sb.from('statutory_reports').update(row).eq('id', r.id));
      return q(sb.from('statutory_reports').insert({ ...row, incident_id: inc.id, org_id: org }));
    },
  }).then((x) => { if (x) { toast('Reporting record saved.'); reload(); } });
  const card = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'External reporting'),
    can.edit ? h('button', { class: 'btn btn-secondary btn-sm', onclick: () => form() }, 'Add record') : null));
  if (!rows.length) card.append(h('p', { class: 'muted' }, 'Track any obligation to notify an external authority. Reporting rules depend on the event and must be verified.'));
  else card.append(h('ul', { class: 'file-list' }, rows.map((r) => h('li', {},
    h('span', {}, h('strong', {}, STAT_STATUS[r.status]), r.legal_reference ? ` (${r.legal_reference})` : '',
      h('div', { class: 'muted small' }, [r.responsible_id ? `Responsible: ${names.get(r.responsible_id) || '—'}` : null, r.due_at ? `Due ${fmtDateTime(r.due_at)}` : null, r.submitted_at ? `Submitted ${fmtDate(r.submitted_at)}` : null].filter(Boolean).join('. '))),
    can.edit ? h('button', { class: 'btn-link', onclick: () => form(r) }, 'Update') : null))));
  return card;
}

async function investigationSupport(org, inc, inv, reload) {
  const vals = await modalForm({ title: 'Investigation support from AI', submitLabel: 'Get suggestions',
    intro: 'The AI suggests questions, evidence and possible factors to explore. They are prompts, not findings. Edit the description below to remove names and personal details before sending.',
    fields: [
      { name: 'description', label: 'What happened (as sent to the AI)', type: 'textarea', required: true, rows: 5, maxlength: 4000, value: inc.description },
      { name: 'immediate_controls', label: 'Immediate controls taken', type: 'textarea', rows: 2, maxlength: 1500, value: inc.immediate_controls || '' },
    ], onSubmit: async (x) => x });
  if (!vals) return;
  let r;
  try {
    r = await withBusy('Preparing investigation prompts…', () => callAI({ task: 'investigation_support', org_id: org,
      inputs: { category: INCIDENT_CATEGORIES[inc.category], description: vals.description, immediate_controls: vals.immediate_controls, site_id: inc.site_id } }));
  } catch (e) { aiError(e); return; }
  let added = 0;
  const factors = (r.output.possible_factors || []).map((f) => {
    const btn = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: async () => {
      try {
        await q(sb.from('investigation_findings').insert({ investigation_id: inv.id, org_id: org, finding_type: f.type, description: f.factor.slice(0, 2000), is_verified: false, source: 'ai_suggestion' }));
        btn.textContent = 'Added as unconfirmed'; btn.disabled = true; added++;
      } catch (e) { toast(errMsg(e), 'err'); }
    } }, 'Add to explore');
    return h('div', { class: 'ai-item' }, h('div', {}, h('strong', {}, f.factor), h('div', { class: 'muted small' }, FINDING[f.type] || f.type)), btn);
  });
  const body = h('div', {}, reviewPanel({ ...r.validation, evidence_to_collect: r.output.evidence_to_collect }, []),
    h('h3', { class: 'section-label' }, 'Questions to ask'), h('ol', {}, (r.output.questions || []).map((x) => h('li', {}, x))),
    h('h3', { class: 'section-label' }, 'Possible factors to explore'), factors.length ? h('div', { class: 'ai-list' }, factors) : h('p', { class: 'muted' }, 'None suggested.'));
  const { dlg } = suggestionDialog({ title: 'Investigation prompts', intro: 'Added factors are marked "Not yet confirmed" until evidence supports them.', body });
  dlg.addEventListener('close', () => { if (added) reload(); });
}
