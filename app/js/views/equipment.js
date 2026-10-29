// Equipment and PPE: an equipment register with inspection, maintenance and
// defect logs, and a register of PPE issued to employees. A passed
// inspection rolls the next due date forward; a failed inspection or a
// reported defect takes the item out of service (done by the database).
import { sb, q } from '../sb.js';
import { h, modalForm, confirmAction, toast, errMsg, emptyState, fmtDate, opt } from '../ui.js';
import {
  loadSites, nameMap, today, addDays, statusBadge, kv, setQuery, downloadCsv, siteOptions,
  EQUIPMENT_STATUS, EQUIPMENT_CATEGORY, LOG_KIND, expiryState, expiryBadge, planAllows, planNotice,
} from '../data.js';
import { actionsPanel } from './actions.js';

export async function render(view, ctx) {
  if (!planAllows(ctx.state, 'equipment')) return planNotice(view, 'Equipment & PPE', 'The equipment register and PPE issue records');
  if (ctx.params[0]) return renderDetail(view, ctx, ctx.params[0]);
  const tab = ctx.query.get('t') === 'ppe' ? 'ppe' : 'equipment';
  view.append(h('div', { class: 'page-title' },
    h('div', {}, h('h1', {}, 'Equipment & PPE'), h('p', {}, ctx.can.staff ? 'Equipment that needs inspecting or certifying, and the PPE issued to your people.' : 'Equipment on your sites and the PPE issued to you.')),
    tab === 'equipment' && ctx.can.field ? h('button', { class: 'btn btn-primary', onclick: async () => { const r = await equipmentForm(ctx.state.org.id); if (r) location.hash = `#/equipment/${r.id}`; } }, 'Add equipment')
      : tab === 'ppe' && ctx.can.edit ? h('button', { class: 'btn btn-primary', onclick: async () => { if (await ppeForm(ctx.state.org.id)) { toast('PPE issue recorded.'); ctx.reload(); } } }, 'Issue PPE') : null));
  view.append(h('div', { class: 'tabs', role: 'tablist' }, [['equipment', 'Equipment'], ['ppe', ctx.can.staff ? 'PPE issued' : 'My PPE']].map(([k, l]) =>
    h('button', { role: 'tab', 'aria-selected': String(k === tab), onclick: () => setQuery('equipment', { t: k === 'ppe' ? 'ppe' : '' }) }, l))));
  const panel = h('div'); view.append(panel);
  return tab === 'ppe' ? ppe(panel, ctx) : list(panel, ctx);
}

const dueState = (e) => (e.status === 'retired' || !e.next_inspection_due ? null : expiryState(e.next_inspection_due, 14));

async function list(panel, { state, query }) {
  const org = state.org.id;
  const cat = query.get('cat') || ''; const f = query.get('f') || ''; const site = query.get('site') || '';
  const [rows, sites] = await Promise.all([q(sb.from('equipment').select('*').eq('org_id', org).order('name')), loadSites(org)]);
  const sName = new Map(sites.map((s) => [s.id, s.name]));
  const set = (p) => setQuery('equipment', { cat, f, site, ...p });
  panel.append(h('div', { class: 'chips' }, [['', 'All'], ['due', 'Inspection due or overdue'], ['out', 'Out of service'], ['cert', 'Certificates expiring']].map(([k, l]) =>
    h('button', { class: 'chip', 'aria-pressed': String(f === k), onclick: () => set({ f: k }) }, l))));
  panel.append(h('div', { class: 'filters' },
    h('label', {}, 'Category', h('select', { onchange: (e) => set({ cat: e.target.value }) }, [['', 'All categories'], ...opt(EQUIPMENT_CATEGORY)].map(([v, l]) => h('option', { value: v, selected: v === cat }, l)))),
    sites.length > 1 ? h('label', {}, 'Site', h('select', { onchange: (e) => set({ site: e.target.value }) }, siteOptions(sites, 'All sites').map(([v, l]) => h('option', { value: v, selected: v === site }, l)))) : null));
  const shown = rows.filter((e) => (!cat || e.category === cat) && (!site || e.site_id === site)
    && (f !== 'due' || ['expiring', 'expired'].includes(dueState(e))) && (f !== 'out' || e.status === 'out_of_service')
    && (f !== 'cert' || (e.certificate_expires_on && e.status !== 'retired' && expiryState(e.certificate_expires_on) !== 'valid'))
    && (f || e.status !== 'retired'));
  const card = h('div', { class: 'card' }); panel.append(card);
  if (!rows.length) { card.append(emptyState('No equipment yet', 'Add fire extinguishers, first aid kits, ladders, lifting equipment and anything else that needs regular inspection or certification.')); return; }
  if (!shown.length) { card.append(emptyState('Nothing here', 'No equipment matches these filters.')); return; }
  card.append(h('div', { class: 'card-head' }, h('span', { class: 'muted' }, `${shown.length} item${shown.length === 1 ? '' : 's'}`),
    h('button', { class: 'btn btn-secondary btn-sm', onclick: () => downloadCsv('equipment-register.csv', [
      ['Name', 'Asset number', 'Category', 'Site', 'Location', 'Status', 'Next inspection', 'Certificate expires'],
      ...shown.map((e) => [e.name, e.asset_number || '', EQUIPMENT_CATEGORY[e.category], sName.get(e.site_id) || '', e.location || '', EQUIPMENT_STATUS[e.status], e.next_inspection_due || '', e.certificate_expires_on || ''])]) }, 'Export CSV')));
  card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, ['Equipment', 'Category', 'Site', 'Status', 'Next inspection', 'Certificate'].map((t) => h('th', {}, t)))),
    h('tbody', {}, shown.map((e) => h('tr', {},
      h('td', { 'data-label': 'Equipment' }, h('a', { class: 'row-link', href: `#/equipment/${e.id}` }, e.name), h('div', { class: 'muted small' }, [e.asset_number, e.location].filter(Boolean).join(' · '))),
      h('td', { 'data-label': 'Category' }, EQUIPMENT_CATEGORY[e.category]),
      h('td', { 'data-label': 'Site' }, sName.get(e.site_id) || '—'),
      h('td', { 'data-label': 'Status' }, statusBadge(e.status, EQUIPMENT_STATUS)),
      h('td', { 'data-label': 'Next inspection' }, e.next_inspection_due && e.status !== 'retired' ? expiryBadge(e.next_inspection_due, 14) : '—'),
      h('td', { 'data-label': 'Certificate' }, e.certificate_expires_on ? expiryBadge(e.certificate_expires_on) : '—')))))));
}

function equipmentForm(org, e = {}) {
  return loadSites(org).then((sites) => modalForm({
    title: e.id ? 'Edit equipment' : 'Add equipment',
    submitLabel: e.id ? 'Save changes' : 'Add equipment',
    fields: [
      { name: 'name', label: 'Name', required: true, value: e.name, maxlength: 160, placeholder: 'e.g. 9 kg DCP fire extinguisher' },
      { name: 'category', label: 'Category', type: 'select', value: e.category || 'other', options: opt(EQUIPMENT_CATEGORY) },
      { name: 'equipment_type', label: 'Type or model', value: e.equipment_type, maxlength: 120 },
      { name: 'asset_number', label: 'Asset number', value: e.asset_number, maxlength: 60, placeholder: 'e.g. FE-012' },
      { name: 'serial_number', label: 'Serial number', value: e.serial_number, maxlength: 60 },
      { name: 'site_id', label: 'Site', type: 'select', value: e.site_id || '', options: siteOptions(sites) },
      { name: 'location', label: 'Location on site', value: e.location, maxlength: 160, placeholder: 'e.g. Workshop, next to the main door' },
      { name: 'inspection_interval_months', label: 'Inspect every (months)', type: 'number', value: e.inspection_interval_months ?? '',
        validate: (v) => (v && !(Number(v) >= 1 && Number(v) <= 120) ? 'Enter 1 to 120 months.' : '') },
      { name: 'next_inspection_due', label: 'Next inspection due', type: 'date', value: e.next_inspection_due || '' },
      { name: 'certificate_expires_on', label: 'Certificate expires on', type: 'date', value: e.certificate_expires_on || '', hint: 'For items that need a certificate, such as lifting equipment or pressure vessels.' },
      { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, value: e.notes, maxlength: 1000 },
    ],
    onSubmit: (v) => {
      const row = { name: v.name, category: v.category, equipment_type: v.equipment_type || null, asset_number: v.asset_number || null,
        serial_number: v.serial_number || null, site_id: v.site_id || null, location: v.location || null,
        inspection_interval_months: v.inspection_interval_months ? Number(v.inspection_interval_months) : null,
        next_inspection_due: v.next_inspection_due || null, certificate_expires_on: v.certificate_expires_on || null, notes: v.notes || null };
      return e.id ? q(sb.from('equipment').update(row).eq('id', e.id).select('id').single()) : q(sb.from('equipment').insert({ ...row, org_id: org }).select('id').single());
    },
  }));
}

async function renderDetail(view, { state, can, reload }, id) {
  const org = state.org.id;
  const e = await q(sb.from('equipment').select('*').eq('id', id).maybeSingle());
  if (!e) { view.append(h('div', { class: 'card' }, emptyState('Equipment not found', 'It may have been removed, or you may not have access to it.'))); return; }
  const [log, sites, names] = await Promise.all([
    can.staff ? q(sb.from('equipment_maintenance').select('*').eq('equipment_id', id).order('performed_on', { ascending: false }).order('created_at', { ascending: false })) : [],
    loadSites(org), nameMap(org),
  ]);
  view.append(h('a', { class: 'back', href: '#/equipment' }, 'Back to equipment'),
    h('div', { class: 'page-title' }, h('div', {}, h('h1', {}, e.name), h('p', {}, EQUIPMENT_CATEGORY[e.category], e.asset_number ? ` · ${e.asset_number}` : '', ' ', statusBadge(e.status, EQUIPMENT_STATUS)))));
  if (e.status === 'out_of_service') view.append(h('div', { class: 'alert alert--err', style: 'margin-bottom:16px' }, 'Out of service. Don\'t use this item until it has been repaired and passes an inspection.'));

  const bar = h('div', { class: 'btn-row', style: 'margin-bottom:18px' });
  if (can.field && e.status !== 'retired') {
    bar.append(h('button', { class: 'btn btn-primary', onclick: () => logForm(org, e, 'inspection', reload) }, 'Record inspection'),
      h('button', { class: 'btn btn-secondary', onclick: () => logForm(org, e, 'defect', reload) }, 'Report a defect'),
      h('button', { class: 'btn btn-secondary', onclick: () => logForm(org, e, 'maintenance', reload) }, 'Log maintenance or repair'),
      h('button', { class: 'btn-link', onclick: async () => { if (await equipmentForm(org, e)) { toast('Equipment saved.'); reload(); } } }, 'Edit'));
  }
  if (can.manage) bar.append(h('button', { class: 'btn-link', onclick: async () => {
    const next = e.status === 'retired' ? 'in_service' : 'retired';
    if (await confirmAction(next === 'retired' ? 'Retire this item?' : 'Bring back into service?', next === 'retired' ? 'Retired items stay on record but no longer get reminders.' : 'Record an inspection before it is used.', next === 'retired' ? 'Retire' : 'Bring back', false)) {
      try { await q(sb.from('equipment').update({ status: next }).eq('id', e.id)); reload(); } catch (err) { toast(errMsg(err), 'err'); }
    } } }, e.status === 'retired' ? 'Bring back into service' : 'Retire'));
  if (bar.children.length) view.append(bar);

  const main = h('div', {}); const side = h('div', {});
  view.append(h('div', { class: 'detail-grid' }, main, side));
  if (can.staff) {
    const lc = h('div', { class: 'card' }, h('h2', {}, 'Inspection and maintenance history'));
    lc.append(log.length ? h('ul', { class: 'timeline' }, log.map((l) => h('li', {},
      h('div', { class: 'tl-head' }, h('strong', {}, LOG_KIND[l.kind]), l.outcome ? statusBadge(l.outcome === 'pass' ? 'completed' : 'returned', { completed: 'Passed', returned: 'Failed' }) : null,
        h('span', { class: 'muted small' }, fmtDate(l.performed_on))),
      h('div', {}, l.description),
      h('div', { class: 'muted small' }, [l.performed_by ? `By ${l.performed_by}` : null, names.get(l.created_by) ? `Recorded by ${names.get(l.created_by)}` : null, l.next_due ? `Next due ${fmtDate(l.next_due)}` : null].filter(Boolean).join(' · ')))))
      : h('p', { class: 'muted' }, 'Nothing recorded yet.'));
    main.append(lc);
    main.append(await actionsPanel({ org, source_type: 'equipment', source_id: e.id, site_id: e.site_id, canRaise: can.field, defaultTitle: `${e.name}: `, onChange: reload }));
  }
  side.append(h('div', { class: 'card' }, h('h2', {}, 'Details'), kv([
    ['Status', statusBadge(e.status, EQUIPMENT_STATUS)],
    ['Next inspection', e.next_inspection_due ? expiryBadge(e.next_inspection_due, 14) : 'Not set'],
    ['Inspect every', e.inspection_interval_months ? `${e.inspection_interval_months} months` : null],
    ['Certificate', e.certificate_expires_on ? expiryBadge(e.certificate_expires_on) : null],
    ['Site', sites.find((s) => s.id === e.site_id)?.name], ['Location', e.location],
    ['Type or model', e.equipment_type], ['Serial number', e.serial_number], ['Notes', e.notes]])));
}

async function logForm(org, e, kind, reload) {
  const isInsp = kind === 'inspection';
  const titles = { inspection: 'Record an inspection', defect: 'Report a defect', maintenance: 'Log maintenance or repair' };
  const r = await modalForm({
    title: titles[kind],
    intro: kind === 'defect' ? 'Reporting a defect takes the item out of service until it is repaired and passes an inspection.'
      : isInsp ? 'A failed inspection takes the item out of service.' : null,
    submitLabel: 'Save',
    fields: [
      ...(kind === 'maintenance' ? [{ name: 'kind', label: 'Type', type: 'select', value: 'maintenance', options: [['maintenance', 'Maintenance or service'], ['repair', 'Repair']] }] : []),
      ...(isInsp ? [{ name: 'outcome', label: 'Result', type: 'select', required: true, options: [['', 'Choose'], ['pass', 'Passed, safe to use'], ['fail', 'Failed, not safe to use']] }] : []),
      { name: 'performed_on', label: 'Date', type: 'date', required: true, value: today(), validate: (v) => (v > today() ? 'Can\'t be in the future.' : '') },
      { name: 'description', label: kind === 'defect' ? 'What is wrong?' : 'What was done or found?', type: 'textarea', required: true, rows: 3, maxlength: 2000 },
      { name: 'performed_by', label: kind === 'defect' ? 'Reported by' : 'Done by (person or company)', maxlength: 160 },
      ...(isInsp ? [{ name: 'next_due', label: 'Next inspection due', type: 'date',
        value: e.inspection_interval_months ? '' : addDays(today(), 365), hint: e.inspection_interval_months ? `Leave blank to use the ${e.inspection_interval_months}-month interval.` : null }] : []),
    ],
    onSubmit: (v) => q(sb.from('equipment_maintenance').insert({ org_id: org, equipment_id: e.id, kind: v.kind || kind, outcome: v.outcome || null,
      performed_on: v.performed_on, description: v.description, performed_by: v.performed_by || null, next_due: v.next_due || null })),
  });
  if (r) { toast(kind === 'defect' || r.outcome === 'fail' ? 'Saved. The item is now out of service.' : 'Saved.'); reload(); }
}

// ---- PPE ----
async function ppe(panel, { state, can, query, reload }) {
  const org = state.org.id;
  const f = query.get('f') || '';
  let emps = [];
  if (can.staff) emps = await q(sb.from('employees').select('id, first_name, last_name').eq('org_id', org));
  const rows = await q(sb.from('ppe_issues').select('*').eq('org_id', org).order('issued_on', { ascending: false }).limit(1000));
  const eName = new Map(emps.map((e) => [e.id, `${e.first_name} ${e.last_name}`]));
  if (can.staff) panel.append(h('div', { class: 'chips' }, [['', 'Currently issued'], ['due', 'Due for replacement'], ['returned', 'Returned'], ['all', 'All']].map(([k, l]) =>
    h('button', { class: 'chip', 'aria-pressed': String(f === k), onclick: () => setQuery('equipment', { t: 'ppe', f: k }) }, l))));
  const shown = rows.filter((r) => (f === 'all') || (f === 'returned' ? !!r.returned_on : !r.returned_on && (f !== 'due' || (r.replace_by && r.replace_by <= addDays(today(), 14)))));
  const card = h('div', { class: 'card' }); panel.append(card);
  if (!shown.length) { card.append(emptyState(rows.length ? 'Nothing here' : 'No PPE issued yet', can.staff ? 'Record the PPE you hand out, with sizes and when it needs replacing.' : 'PPE issued to you will appear here.')); return; }
  card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, [can.staff ? 'Employee' : null, 'Item', 'Size', 'Qty', 'Issued', 'Replace by', ''].filter(Boolean).map((t) => h('th', {}, t)))),
    h('tbody', {}, shown.map((r) => h('tr', {},
      can.staff ? h('td', { 'data-label': 'Employee' }, eName.get(r.employee_id) || '—') : null,
      h('td', { 'data-label': 'Item' }, r.item, r.notes ? h('div', { class: 'muted small' }, r.notes) : null),
      h('td', { 'data-label': 'Size' }, r.size || '—'),
      h('td', { 'data-label': 'Qty' }, String(r.quantity)),
      h('td', { 'data-label': 'Issued' }, fmtDate(r.issued_on)),
      h('td', { 'data-label': 'Replace by' }, r.returned_on ? h('span', { class: 'muted' }, `Returned ${fmtDate(r.returned_on)}`) : r.replace_by ? expiryBadge(r.replace_by, 14) : '—'),
      h('td', { class: 'actions' }, can.edit && !r.returned_on ? h('button', { class: 'btn-link', onclick: async () => {
        if (await modalForm({ title: 'Mark as returned', submitLabel: 'Save', fields: [{ name: 'd', label: 'Returned on', type: 'date', required: true, value: today() }],
          onSubmit: (v) => q(sb.from('ppe_issues').update({ returned_on: v.d }).eq('id', r.id)) })) reload();
      } }, 'Returned') : null)))))));
}

async function ppeForm(org) {
  const emps = await q(sb.from('employees').select('id, first_name, last_name').eq('org_id', org).eq('status', 'active').order('last_name'));
  if (!emps.length) { toast('Add employees under People first.', 'err'); return null; }
  return modalForm({
    title: 'Issue PPE',
    submitLabel: 'Record issue',
    fields: [
      { name: 'employee_id', label: 'Employee', type: 'select', required: true, options: [['', 'Choose an employee'], ...emps.map((e) => [e.id, `${e.first_name} ${e.last_name}`])] },
      { name: 'item', label: 'Item', required: true, maxlength: 120, placeholder: 'e.g. Safety boots' },
      { name: 'size', label: 'Size', maxlength: 20 },
      { name: 'quantity', label: 'Quantity', type: 'number', value: '1', validate: (v) => (!(Number(v) >= 1) ? 'Enter at least 1.' : '') },
      { name: 'issued_on', label: 'Issued on', type: 'date', required: true, value: today() },
      { name: 'replace_by', label: 'Replace by', type: 'date', value: addDays(today(), 365) },
      { name: 'notes', label: 'Notes', maxlength: 500 },
    ],
    onSubmit: (v) => q(sb.from('ppe_issues').insert({ org_id: org, employee_id: v.employee_id, item: v.item, size: v.size || null, quantity: Number(v.quantity) || 1,
      issued_on: v.issued_on, replace_by: v.replace_by || null, notes: v.notes || null })),
  });
}
