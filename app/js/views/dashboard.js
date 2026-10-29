// Dashboard: every figure comes from the organisation's own records.
// Cards open the matching filtered list. Empty data shows guidance,
// never sample numbers.
import { sb, q } from '../sb.js';
import { h, fmtDate } from '../ui.js';
import { loadSites, loadMethodology, today, addDays, INCIDENT_CATEGORIES, bandFor } from '../data.js';
import { reportIncident } from './incidents.js';

const MONTHS = { 3: 'Last 3 months', 6: 'Last 6 months', 12: 'Last 12 months' };

export async function render(view, ctx) {
  const { state, can, query } = ctx;
  const org = state.org.id;
  const first = (state.profile?.full_name || '').split(' ')[0];
  view.append(h('div', { class: 'page-title' },
    h('div', {}, h('h1', {}, first ? `Welcome, ${first}` : 'Dashboard'), h('p', {}, state.org.name)),
    h('button', { class: 'btn btn-primary', onclick: async () => { const r = await reportIncident(state); if (r) location.hash = `#/incidents/${r.id}`; } }, 'Report an incident')));

  if (state.sub?.status === 'trialing') {
    view.append(h('div', { class: 'alert alert--info', style: 'margin-bottom:18px' },
      `You're on a free trial of ${state.sub.subscription_plans?.name ?? 'OHS Hub'} until ${fmtDate(state.sub.trial_ends_at)}. `,
      'Online payment is not switched on yet, so we will contact you about billing before your trial ends.'));
  }

  await myWork(view, ctx);
  if (!can.staff) return;

  // Filters
  const months = +(query.get('m') || 6);
  const site = query.get('site') || '';
  const sites = await loadSites(org);
  const go = (m, s) => { const qs = new URLSearchParams(Object.entries({ m, site: s }).filter(([, v]) => v)).toString(); location.hash = `#/dashboard${qs ? '?' + qs : ''}`; };
  view.append(h('div', { class: 'filters' },
    h('label', {}, 'Period', h('select', { onchange: (e) => go(e.target.value, site) }, Object.entries(MONTHS).map(([v, l]) => h('option', { value: v, selected: +v === months }, l)))),
    sites.length > 1 ? h('label', {}, 'Site', h('select', { onchange: (e) => go(months, e.target.value) },
      [['', 'All sites'], ...sites.map((s) => [s.id, s.name])].map(([v, l]) => h('option', { value: v, selected: v === site }, l)))) : null));

  const since = new Date(); since.setMonth(since.getMonth() - months + 1); since.setDate(1);
  const sinceIso = since.toISOString().slice(0, 10);
  const bySite = (x) => (site ? x.eq('site_id', site) : x);
  const cnt = async (table, f) => { const { count, error } = await f(sb.from(table).select('id', { count: 'exact', head: true }).eq('org_id', org)); return error ? null : count ?? 0; };
  const t = today();

  const [raApproved, openInc, awaitingInv, openActions, overdueActions, verifyActions, overdueIns, overdueSched, docReviews, docPending,
    incidents, inspections, register, actionsAll, meth] = await Promise.all([
    cnt('risk_assessments', (x) => bySite(x.eq('status', 'approved'))),
    cnt('incidents', (x) => bySite(x.neq('status', 'closed'))),
    cnt('incidents', (x) => bySite(x.eq('status', 'reported'))),
    cnt('corrective_actions', (x) => bySite(x.in('status', ['open', 'in_progress', 'awaiting_verification']))),
    cnt('corrective_actions', (x) => bySite(x.in('status', ['open', 'in_progress']).lt('due_date', t))),
    cnt('corrective_actions', (x) => bySite(x.eq('status', 'awaiting_verification'))),
    cnt('inspections', (x) => bySite(x.in('status', ['scheduled', 'in_progress']).lt('due_on', t))),
    cnt('inspection_schedules', (x) => bySite(x.eq('is_active', true).lt('next_due_on', t))),
    cnt('documents', (x) => x.eq('status', 'approved').lte('review_date', addDays(t, 30))),
    cnt('documents', (x) => x.eq('status', 'in_review')),
    q(bySite(sb.from('incidents').select('occurred_at, category').eq('org_id', org).gte('occurred_at', sinceIso))),
    q(bySite(sb.from('inspections').select('completed_at, compliant_count, non_compliant_count').eq('org_id', org).in('status', ['completed', 'closed']).gte('completed_at', sinceIso))),
    q(bySite(sb.from('risk_register_entries').select('initial_score, residual_score').eq('org_id', org).in('status', ['open', 'controlled']))),
    q(bySite(sb.from('corrective_actions').select('status, due_date, closed_at').eq('org_id', org).gte('created_at', sinceIso))),
    loadMethodology(org),
  ]);
  const highRisks = register.filter((r) => { const b = bandFor(meth, r.residual_score ?? r.initial_score); return b && meth.bands.indexOf(b) >= meth.bands.length - 2; }).length;

  const qs = site ? `&site=${site}` : '';
  const stat = (n, label, href, alert = false) => h('a', { class: `stat ${alert && n ? 'alert-stat' : ''}`, href },
    h('div', { class: 'n' }, n == null ? '—' : n), h('div', { class: 'l' }, label));
  view.append(h('div', { class: 'stats' },
    stat(openInc, 'Open incidents', '#/incidents?f=open'),
    stat(awaitingInv, 'Awaiting investigation', '#/incidents?f=awaiting', true),
    stat(openActions, 'Outstanding actions', `#/actions?f=open${qs}`),
    stat(overdueActions, 'Overdue actions', `#/actions?f=overdue${qs}`, true),
    stat(verifyActions, 'Actions to verify', `#/actions?f=verify${qs}`),
    stat((overdueIns ?? 0) + (overdueSched ?? 0), 'Overdue inspections', '#/inspections?t=schedules', true),
    stat(highRisks, 'High and extreme risks', '#/register', true),
    stat(raApproved, 'Approved risk assessments', '#/risk?status=approved'),
    stat(docReviews, 'Document reviews due in 30 days', '#/documents', true),
    stat(docPending, 'Documents in review', '#/documents?f=drafts')));

  // Charts
  const monthsList = [...Array(months)].map((_, i) => { const d = new Date(since); d.setMonth(d.getMonth() + i); return d.toISOString().slice(0, 7); });
  const label = (ym) => new Date(ym + '-15').toLocaleDateString('en-ZA', { month: 'short' });
  const incByMonth = monthsList.map((m) => incidents.filter((i) => i.occurred_at.slice(0, 7) === m).length);
  const insByMonth = monthsList.map((m) => {
    const rows = inspections.filter((i) => i.completed_at?.slice(0, 7) === m);
    const c = rows.reduce((a, r) => a + r.compliant_count, 0), n = rows.reduce((a, r) => a + r.compliant_count + r.non_compliant_count, 0);
    return n ? Math.round((c / n) * 100) : null;
  });
  const catCounts = Object.entries(INCIDENT_CATEGORIES).map(([k, l]) => [l, incidents.filter((i) => i.category === k).length]).filter(([, n]) => n);
  const bandCounts = (meth?.bands || []).map((b) => [b.label, register.filter((r) => { const s = r.residual_score ?? r.initial_score; return s >= b.min && s <= b.max; }).length, b.colour]);
  const closedOnTime = actionsAll.filter((a) => a.status === 'closed' && a.closed_at && a.closed_at.slice(0, 10) <= a.due_date).length;
  const closedLate = actionsAll.filter((a) => a.status === 'closed' && a.closed_at && a.closed_at.slice(0, 10) > a.due_date).length;
  const stillOpen = actionsAll.filter((a) => ['open', 'in_progress', 'awaiting_verification'].includes(a.status)).length;

  view.append(h('div', { class: 'grid-2' },
    chartCard('Incidents per month', `${incidents.length} in the ${MONTHS[months].toLowerCase()}`, incidents.length
      ? columns(incByMonth, monthsList.map(label)) : null, 'No incidents recorded in this period.'),
    chartCard('Inspection compliance', 'Share of checked items found compliant, by month', insByMonth.some((x) => x != null)
      ? columns(insByMonth, monthsList.map(label), '%') : null, 'No completed inspections in this period.')));
  view.append(h('div', { class: 'grid-2' },
    chartCard('Risk register by rating', 'Open and controlled risks, using residual rating where set', register.length
      ? bars(bandCounts) : null, 'The risk register is empty.'),
    chartCard('Corrective action completion', `Actions raised in the ${MONTHS[months].toLowerCase()}`, actionsAll.length
      ? bars([['Closed on time', closedOnTime, '#2E7D32'], ['Closed late', closedLate, '#E8710A'], ['Still open', stillOpen, '#005C72']]) : null,
      'No actions raised in this period.')));
  if (catCounts.length) view.append(chartCard('Incidents by category', MONTHS[months], bars(catCounts)));

  if (can.admin) await setupChecklist(view, org);
}

function chartCard(title, sub, body, empty) {
  return h('div', { class: 'card' }, h('h2', {}, title), h('p', { class: 'sub' }, sub), body || h('p', { class: 'muted' }, empty));
}
function columns(values, labels, suffix = '') {
  const max = Math.max(1, ...values.map((v) => v ?? 0));
  return h('div', { role: 'img', 'aria-label': labels.map((l, i) => `${l}: ${values[i] ?? 'no data'}${values[i] != null ? suffix : ''}`).join(', ') },
    h('div', { class: 'cols' }, values.map((v) => h('div', { class: 'col' }, h('span', { class: 'v' }, v == null ? '' : `${v}${suffix}`),
      h('span', { class: 'b', style: `height:${v == null ? 0 : Math.max(2, (v / max) * 100)}%` })))),
    h('div', { class: 'col-labels' }, labels.map((l) => h('span', {}, l))));
}
function bars(rows) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return h('div', { class: 'bars' }, rows.map(([l, n, colour]) => h('div', { class: 'bar-row' }, h('span', {}, l),
    h('span', { class: 'bar-track' }, h('span', { class: 'bar-fill', style: `width:${(n / max) * 100}%;${colour ? `background:${colour}` : ''}` })),
    h('strong', {}, String(n)))));
}

async function myWork(view, { state, can }) {
  const org = state.org.id, me = state.user.id;
  const [actions, reviews, investigations, toRead] = await Promise.all([
    q(sb.from('corrective_actions').select('id, reference, title, due_date, status').eq('org_id', org).eq('responsible_id', me)
      .in('status', ['open', 'in_progress']).order('due_date').limit(8)),
    can.staff ? q(sb.from('document_approvals').select('id, document_versions(document_id, version_number, documents!document_versions_document_id_fkey(title))').eq('org_id', org).eq('reviewer_id', me).eq('decision', 'pending')) : [],
    q(sb.from('incident_investigations').select('incident_id, status, target_date, incidents(reference, title)').eq('org_id', org).eq('investigator_id', me).in('status', ['assigned', 'in_progress', 'returned'])),
    q(sb.from('documents').select('id, title, current_version_id').eq('org_id', org).eq('status', 'approved').eq('requires_acknowledgement', true)),
  ]);
  const acks = toRead.length ? await q(sb.from('document_acknowledgements').select('version_id').eq('user_id', me)) : [];
  const ackd = new Set(acks.map((a) => a.version_id));
  const unread = toRead.filter((d) => !ackd.has(d.current_version_id));
  const items = [
    ...investigations.map((i) => [`#/incidents/${i.incident_id}`, `Investigate ${i.incidents?.reference}: ${i.incidents?.title}`, i.target_date ? `Target ${fmtDate(i.target_date)}` : '', i.target_date && i.target_date < today()]),
    ...reviews.map((r) => [`#/documents/${r.document_versions?.document_id}`, `Review: ${r.document_versions?.documents?.title} (v${r.document_versions?.version_number})`, 'Awaiting your approval', false]),
    ...actions.map((a) => [`#/actions/${a.id}`, `${a.reference}: ${a.title}`, `Due ${fmtDate(a.due_date)}`, a.due_date < today()]),
    ...unread.map((d) => [`#/documents/${d.id}`, `Read and acknowledge: ${d.title}`, '', false]),
  ];
  const card = h('div', { class: 'card' }, h('h2', {}, 'Your tasks'));
  if (!items.length) card.append(h('p', { class: 'muted' }, 'Nothing needs your attention right now.'));
  else card.append(h('ul', { class: 'file-list' }, items.map(([href, text, meta, late]) => h('li', {},
    h('a', { class: 'row-link', href }, text), h('span', { class: late ? 'overdue small' : 'muted small' }, late ? `${meta} (overdue)` : meta)))));
  view.append(card);
}

async function setupChecklist(view, org) {
  const c = async (table, f = (x) => x) => { const { count } = await f(sb.from(table).select('id', { count: 'exact', head: true }).eq('org_id', org)); return count ?? 0; };
  const [orgRow, sites, depts, employees, members, invites, tpls, ras] = await Promise.all([
    sb.from('organisations').select('registration_number, physical_address').eq('id', org).single().then((r) => r.data),
    c('sites', (x) => x.eq('is_active', true)), c('departments'), c('employees', (x) => x.eq('status', 'active')),
    c('organisation_memberships', (x) => x.eq('status', 'active')),
    c('organisation_invitations', (x) => x.is('accepted_at', null).is('revoked_at', null)),
    c('inspection_templates', (x) => x.eq('status', 'approved')), c('risk_assessments')]);
  const list = [
    [!!(orgRow?.registration_number && orgRow?.physical_address), 'Complete your company details', 'Registration number and physical address appear on reports.', '#/company'],
    [sites > 0, 'Add your sites', 'Every inspection and incident is linked to a site.', '#/sites'],
    [depts > 0, 'Add departments', 'Lets you filter records by department.', '#/sites'],
    [employees > 0, 'Add your employees', 'Needed for incident reports and training records.', '#/people'],
    [members > 1 || invites > 0, 'Invite your team', 'Give your OHS manager, safety officers and supervisors their own login.', '#/team'],
    [ras > 0, 'Start a baseline risk assessment', 'Identify the main hazards at each site.', '#/risk'],
    [tpls > 0, 'Approve your first inspection checklist', 'Start from a starter checklist and adapt it.', '#/inspections?t=checklists'],
  ];
  const done = list.filter((i) => i[0]).length;
  if (done === list.length) return;
  view.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Getting started'), h('span', { class: 'muted' }, `${done} of ${list.length} done`)),
    h('ul', { class: 'checklist' }, list.map(([ok, title, text, href]) => h('li', {},
      h('span', { class: `tick ${ok ? 'done' : ''}`, 'aria-label': ok ? 'Done' : 'Not done yet' }),
      h('div', {}, h('div', { class: ok ? 'done-text' : '' }, title), h('div', { class: 'muted small' }, text)),
      ok ? null : h('a', { class: 'btn btn-secondary btn-sm', href }, 'Open'))))));
}
