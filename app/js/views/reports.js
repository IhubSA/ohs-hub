// OHS reports: monthly, quarterly or custom periods. Every figure comes
// from ohs_report() in the database (respecting the viewer's access).
// The executive summary is written by a person, optionally starting
// from an AI draft that is clearly labelled.
import { sb, q } from '../sb.js';
import { h, toast, errMsg, fmtDate, fmtDateTime, modalForm } from '../ui.js';
import { loadSites, INCIDENT_CATEGORIES, ACTION_SOURCE, PRIORITY, nextRef, downloadWord, downloadCsv, setQuery, today } from '../data.js';
import { aiQuota, aiAvailability, callAI, withBusy, aiLabel, aiError } from '../ai.js';

const PERIODS = { this_month: 'This month', last_month: 'Last month', this_quarter: 'This quarter', last_quarter: 'Last quarter', ytd: 'Year to date', custom: 'Custom dates' };
const iso = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
function range(p, from, to) {
  const t = new Date(today() + 'T12:00:00'); const y = t.getFullYear(), m = t.getMonth(), qm = Math.floor(m / 3) * 3;
  const r = {
    this_month: [new Date(y, m, 1), t], last_month: [new Date(y, m - 1, 1), new Date(y, m, 0)],
    this_quarter: [new Date(y, qm, 1), t], last_quarter: [new Date(y, qm - 3, 1), new Date(y, qm, 0)], ytd: [new Date(y, 0, 1), t],
  }[p];
  if (p === 'custom') return [from || iso(new Date(y, m, 1)), to || today()];
  return [iso(r[0]), iso(r[1])];
}
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');

export async function render(view, { state, can, query }) {
  const org = state.org.id;
  const p = query.get('p') || 'last_month';
  const site = query.get('site') || '';
  const [from, to] = range(p, query.get('from'), query.get('to'));
  const sites = await loadSites(org);
  const periodLabel = p === 'custom' ? `${fmtDate(from)} to ${fmtDate(to)}` : `${PERIODS[p]} (${fmtDate(from)} to ${fmtDate(to)})`;

  view.append(h('div', { class: 'page-title no-print' }, h('div', {}, h('h1', {}, 'Reports'),
    h('p', {}, 'OHS performance reports built from your records. Choose a period, review the figures, add a summary and export.'))));
  const fromIn = h('input', { type: 'date', value: from, 'aria-label': 'From' });
  const toIn = h('input', { type: 'date', value: to, 'aria-label': 'To' });
  view.append(h('form', { class: 'filters no-print', onsubmit: (e) => { e.preventDefault(); setQuery('reports', { p: 'custom', from: fromIn.value, to: toIn.value, site }); } },
    h('label', {}, 'Period', h('select', { onchange: (e) => setQuery('reports', { p: e.target.value, site }) },
      Object.entries(PERIODS).map(([v, l]) => h('option', { value: v, selected: v === p }, l)))),
    p === 'custom' ? [h('label', {}, 'From', fromIn), h('label', {}, 'To', toIn), h('button', { class: 'btn btn-secondary btn-sm', type: 'submit' }, 'Update')] : null,
    sites.length > 1 ? h('label', {}, 'Site', h('select', { onchange: (e) => setQuery('reports', { p, site: e.target.value, from: query.get('from'), to: query.get('to') }) },
      [['', 'All sites'], ...sites.map((s) => [s.id, s.name])].map(([v, l]) => h('option', { value: v, selected: v === site }, l)))) : null));

  let r;
  try { r = await q(sb.rpc('ohs_report', { p_org: org, p_from: from, p_to: to, p_site: site || null })); }
  catch (e) { view.append(h('div', { class: 'card' }, h('p', {}, errMsg(e)))); return; }
  const scope = r.period.site_name ? `Site: ${r.period.site_name}` : 'All sites';

  // ---- summary box ----
  const summary = h('textarea', { 'aria-label': 'Executive summary', placeholder: 'Write the executive summary: overall performance, significant events, trends and priorities for next period.' });
  const summaryPrint = h('div', { class: 'summary-print' });
  const aiNote = h('div');
  summary.addEventListener('input', () => { summaryPrint.textContent = summary.value; });
  const avail = can.edit ? aiAvailability(await aiQuota(org)) : { ok: false };
  const writeAI = async () => {
    try {
      const res = await withBusy('Writing the executive summary…', () => callAI({ task: 'report_summary', org_id: org,
        inputs: { stats: { period: { from, to, scope }, incidents: r.incidents, inspections: r.inspections, actions: r.actions, risk: r.risk, documents: r.documents } } }));
      const o = res.output;
      summary.value = [o.summary, o.notable_points?.length ? `Notable points:\n${o.notable_points.map((x) => `- ${x}`).join('\n')}` : '',
        o.caveats?.length ? `Notes on the data:\n${o.caveats.map((x) => `- ${x}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
      summaryPrint.textContent = summary.value;
      aiNote.replaceChildren(aiLabel('This summary was drafted by AI from the figures below. Check it against the figures and edit it before sharing.'));
    } catch (e) { aiError(e); }
  };

  const metric = (n, l) => h('div', { class: 'metric' }, h('div', { class: 'n' }, n ?? '—'), h('div', { class: 'l' }, l));
  const table = (head, rows) => rows.length ? h('table', { class: 'data' }, h('thead', {}, h('tr', {}, head.map((x) => h('th', {}, x)))),
    h('tbody', {}, rows.map((row) => h('tr', {}, row.map((c, i) => h('td', { 'data-label': head[i] }, c ?? '—')))))) : h('p', { class: 'muted' }, 'None in this period.');
  const I = r.incidents, N = r.inspections, A = r.actions, R = r.risk, D = r.documents;

  const report = h('article', { class: 'card', id: 'report' },
    h('header', { class: 'report-head' }, h('h2', {}, `OHS report: ${state.org.name}`),
      h('p', { class: 'muted', style: 'margin:0' }, `${periodLabel}. ${scope}. Generated ${fmtDateTime(r.period.generated_at)}.`),
      h('p', { class: 'muted small', style: 'margin:4px 0 0' }, 'Figures are calculated from OHS Hub records you have access to. Confidential incidents are only included for people authorised to see them.')),
    h('section', { class: 'report-section summary-box' }, h('h3', {}, 'Executive summary'), aiNote, summary, summaryPrint,
      h('div', { class: 'btn-row no-print', style: 'margin-top:8px' },
        avail.ok ? h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: writeAI }, 'Draft summary with AI') : null,
        avail.reason ? h('span', { class: 'muted small' }, avail.reason) : null)),
    h('section', { class: 'report-section' }, h('h3', {}, 'Incidents'),
      h('div', { class: 'metric-grid' }, metric(I.total, 'Incidents reported'), metric(I.injuries, 'Injuries'), metric(I.near_misses, 'Near misses'),
        metric(I.dangerous_occurrences, 'Dangerous occurrences'), metric(I.open, 'Still open'), metric(I.investigations_approved, 'Investigations approved'),
        metric(I.avg_days_to_close != null ? `${I.avg_days_to_close} days` : '—', 'Average time to close')),
      table(['Category', 'Number'], Object.entries(I.by_category).map(([k, n]) => [INCIDENT_CATEGORIES[k] || k, n])),
      I.by_site.length > 1 ? table(['Site', 'Incidents'], I.by_site.map((s) => [s.site, s.count])) : null),
    h('section', { class: 'report-section' }, h('h3', {}, 'Inspections'),
      h('div', { class: 'metric-grid' }, metric(N.completed, 'Inspections completed'), metric(N.compliance_pct != null ? `${N.compliance_pct}%` : '—', 'Items compliant'),
        metric(N.items_non_compliant, 'Findings (non-compliant items)'), metric(N.overdue_at_end, 'Overdue at period end'))),
    h('section', { class: 'report-section' }, h('h3', {}, 'Corrective actions'),
      h('div', { class: 'metric-grid' }, metric(A.raised, 'Raised'), metric(A.closed, 'Closed'), metric(pct(A.closed_on_time, A.closed), 'Closed on time'),
        metric(A.open_at_end, 'Open now'), metric(A.overdue_at_end, 'Overdue'), metric(A.awaiting_verification, 'Awaiting verification')),
      table(['Source of actions raised', 'Number'], Object.entries(A.by_source).map(([k, n]) => [ACTION_SOURCE[k] || k, n])),
      Object.keys(A.open_by_priority).length ? table(['Open actions by priority', 'Number'], ['critical', 'high', 'medium', 'low'].filter((k) => A.open_by_priority[k]).map((k) => [PRIORITY[k], A.open_by_priority[k]])) : null),
    h('section', { class: 'report-section' }, h('h3', {}, 'Risk management'),
      h('div', { class: 'metric-grid' }, metric(R.register_active, 'Risks in the register'), metric(R.new_in_period, 'New risks added'),
        metric(R.assessments_approved, 'Assessments approved'), metric(R.assessments_review_overdue, 'Assessments past review date')),
      table(['Current rating', 'Risks'], R.by_band.map((b) => [b.band, b.count]))),
    h('section', { class: 'report-section' }, h('h3', {}, 'Document control'),
      h('div', { class: 'metric-grid' }, metric(D.effective, 'Effective documents'), metric(D.approved_in_period, 'Versions approved'),
        metric(D.review_overdue, 'Reviews overdue'), metric(D.acknowledgements, 'Acknowledgements recorded'))));

  const title = `OHS report ${state.org.name} ${from} to ${to}`;
  const exportsBar = h('div', { class: 'btn-row no-print', style: 'margin-bottom:14px' },
    h('button', { class: 'btn btn-secondary', onclick: () => window.print() }, 'Print or save as PDF'),
    h('button', { class: 'btn btn-secondary', onclick: () => { summaryPrint.textContent = summary.value; const clone = report.cloneNode(true); clone.querySelectorAll('.no-print, textarea').forEach((x) => x.remove()); clone.querySelector('.summary-print')?.removeAttribute('class'); downloadWord(title, title, clone); } }, 'Download Word'),
    h('button', { class: 'btn btn-secondary', onclick: () => downloadCsv(title, csvRows(r, scope)) }, 'Download CSV'),
    can.edit ? h('button', { class: 'btn btn-primary', onclick: () => saveAsDocument(state, r, summary.value, periodLabel, scope) }, 'Save to documents') : null);
  view.append(exportsBar, report);
}

function csvRows(r, scope) {
  const rows = [['Section', 'Measure', 'Value'], ['Period', 'From', r.period.from], ['Period', 'To', r.period.to], ['Period', 'Scope', scope]];
  const add = (sec, obj) => { for (const [k, v] of Object.entries(obj)) if (typeof v !== 'object' || v === null) rows.push([sec, k.replace(/_/g, ' '), v]); };
  add('Incidents', r.incidents); for (const [k, n] of Object.entries(r.incidents.by_category)) rows.push(['Incidents by category', INCIDENT_CATEGORIES[k] || k, n]);
  add('Inspections', r.inspections); add('Corrective actions', r.actions);
  for (const [k, n] of Object.entries(r.actions.by_source)) rows.push(['Actions by source', ACTION_SOURCE[k] || k, n]);
  add('Risk', r.risk); for (const b of r.risk.by_band) rows.push(['Risks by rating', b.band, b.count]);
  add('Documents', r.documents);
  return rows;
}

async function saveAsDocument(state, r, summary, periodLabel, scope) {
  const org = state.org.id;
  const ok = await modalForm({ title: 'Save report to documents', submitLabel: 'Save as draft',
    intro: 'The report is saved as a draft controlled document so it can be reviewed, approved and kept on record.',
    fields: [{ name: 'title', label: 'Document title', required: true, maxlength: 200, value: `OHS report: ${periodLabel}` }],
    onSubmit: async (v) => {
      const I = r.incidents, N = r.inspections, A = r.actions, R = r.risk, D = r.documents;
      const figures = [
        `Incidents: ${I.total} reported (${I.injuries} injuries, ${I.near_misses} near misses, ${I.dangerous_occurrences} dangerous occurrences); ${I.open} still open.`,
        `Inspections: ${N.completed} completed; ${N.compliance_pct ?? '—'}% of checked items compliant; ${N.items_non_compliant} findings; ${N.overdue_at_end} overdue at period end.`,
        `Corrective actions: ${A.raised} raised, ${A.closed} closed (${pct(A.closed_on_time, A.closed)} on time); ${A.open_at_end} open, ${A.overdue_at_end} overdue.`,
        `Risk: ${R.register_active} risks in the register (${R.by_band.map((b) => `${b.band} ${b.count}`).join(', ')}); ${R.assessments_approved} assessments approved; ${R.assessments_review_overdue} past review date.`,
        `Documents: ${D.effective} effective; ${D.approved_in_period} versions approved; ${D.review_overdue} reviews overdue.`,
      ].join('\n');
      const reference = await nextRef(org, 'RPT');
      const doc = await q(sb.from('documents').insert({ org_id: org, reference, title: v.title, doc_type: 'ohs_report', site_id: r.period.site_id || null,
        owner_id: state.user.id, visible_to_employees: false }).select('id').single());
      await q(sb.from('document_versions').insert({ document_id: doc.id, org_id: org, version_number: 1, change_summary: 'Report generated',
        content: { purpose: `OHS performance report for ${periodLabel}.`, scope: `${scope}. Generated ${fmtDateTime(r.period.generated_at)} from OHS Hub records.`,
          content: `${summary ? `Executive summary\n${summary}\n\n` : ''}Key figures\n${figures}` } }));
      return doc;
    } });
  if (ok) { toast('Report saved as a draft document.'); location.hash = `#/documents/${ok.id}`; }
}
