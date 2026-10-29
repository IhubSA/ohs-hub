// People: employee records and contractor companies.
// Data minimisation: no ID numbers or medical details are captured here.
import { sb, q } from '../sb.js';
import { h, modalForm, confirmAction, toast, errMsg, emptyState, badge, fmtDate } from '../ui.js';

const EMP_STATUS = { active: ['Active', 'ok'], inactive: ['Inactive', 'warn'], terminated: ['Left the company', ''] };
const ACCESS = { pending: ['Pending', 'warn'], approved: ['Approved', 'ok'], suspended: ['Suspended', 'bad'], expired: ['Expired', 'bad'] };

export async function render(view, ctx) {
  const tab = ctx.params[0] === 'contractors' ? 'contractors' : 'employees';
  view.append(h('div', { class: 'page-title' }, h('div', {}, h('h1', {}, 'People'),
    h('p', {}, 'Your workforce and the contractors who work on your sites.'))));
  const tabs = h('div', { class: 'tabs', role: 'tablist' },
    [['employees', 'Employees'], ['contractors', 'Contractors']].map(([k, l]) =>
      h('button', { role: 'tab', 'aria-selected': String(k === tab), onclick: () => ctx.navigate(k === 'employees' ? 'people' : 'people/contractors') }, l)));
  const panel = h('div', { role: 'tabpanel' });
  view.append(tabs, panel);
  if (tab === 'employees') await employees(panel, ctx); else await contractors(panel, ctx);
}

async function employees(panel, { state, can, reload }) {
  const org = state.org.id;
  const [rows, sites, depts] = await Promise.all([
    q(sb.from('employees').select('*').eq('org_id', org).order('last_name').order('first_name')),
    q(sb.from('sites').select('id, name').eq('org_id', org).eq('is_active', true).order('name')),
    q(sb.from('departments').select('id, name, site_id').eq('org_id', org).order('name')),
  ]);
  const siteName = Object.fromEntries(sites.map((s) => [s.id, s.name]));
  const deptName = Object.fromEntries(depts.map((d) => [d.id, d.name]));

  const form = (e = {}) => modalForm({
    title: e.id ? 'Edit employee' : 'Add an employee',
    intro: 'Record only what your OHS processes need. Do not capture ID numbers or medical information here.',
    submitLabel: e.id ? 'Save employee' : 'Add employee',
    fields: [
      { name: 'first_name', label: 'First name', required: true, value: e.first_name, maxlength: 80 },
      { name: 'last_name', label: 'Surname', required: true, value: e.last_name, maxlength: 80 },
      { name: 'employee_number', label: 'Employee number', value: e.employee_number, maxlength: 40 },
      { name: 'job_title', label: 'Job title', value: e.job_title, maxlength: 120 },
      { name: 'site_id', label: 'Site', type: 'select', value: e.site_id ?? '', options: [['', 'Not assigned'], ...sites.map((s) => [s.id, s.name])] },
      { name: 'department_id', label: 'Department', type: 'select', value: e.department_id ?? '',
        options: [['', 'Not assigned'], ...depts.map((d) => [d.id, d.site_id && siteName[d.site_id] ? `${d.name} (${siteName[d.site_id]})` : d.name])] },
      { name: 'email', label: 'Work email', type: 'email', value: e.email, maxlength: 200 },
      { name: 'start_date', label: 'Start date', type: 'date', value: e.start_date },
      { name: 'status', label: 'Status', type: 'select', value: e.status ?? 'active', options: Object.entries(EMP_STATUS).map(([k, [l]]) => [k, l]) },
    ],
    onSubmit: async (v) => {
      const row = { ...v };
      for (const k of ['employee_number', 'job_title', 'site_id', 'department_id', 'email', 'start_date']) row[k] = row[k] || null;
      if (e.id) await q(sb.from('employees').update(row).eq('id', e.id));
      else await q(sb.from('employees').insert({ ...row, org_id: org }));
    },
  }).then((r) => { if (r) { toast(e.id ? 'Employee saved.' : 'Employee added.'); reload(); } });

  const remove = async (e) => {
    if (!await confirmAction(`Delete ${e.first_name} ${e.last_name}?`,
      'This permanently removes the record. To keep their history, set their status to "Left the company" instead.', 'Delete employee')) return;
    try { await q(sb.from('employees').delete().eq('id', e.id)); toast('Employee deleted.'); reload(); }
    catch (err) { toast(errMsg(err), 'err'); }
  };

  const head = h('div', { class: 'card-head' }, h('h2', {}, `Employees (${rows.length})`),
    can.manage ? h('button', { class: 'btn btn-primary', onclick: () => form() }, 'Add an employee') : null);
  const card = h('div', { class: 'card' }, head);
  panel.append(card);
  if (!rows.length) {
    card.append(emptyState('No employees yet', 'Add the people who work for you so you can link them to training, PPE and incidents.',
      can.manage ? h('button', { class: 'btn btn-primary', onclick: () => form() }, 'Add your first employee') : null));
    return;
  }
  const search = h('input', { type: 'search', placeholder: 'Search by name, number or job title', 'aria-label': 'Search employees' });
  const siteFilter = h('select', { 'aria-label': 'Filter by site' }, h('option', { value: '' }, 'All sites'), sites.map((s) => h('option', { value: s.id }, s.name)));
  const statusFilter = h('select', { 'aria-label': 'Filter by status' }, h('option', { value: 'active' }, 'Active only'), h('option', { value: '' }, 'All statuses'));
  const tbody = h('tbody');
  const draw = () => {
    const term = search.value.trim().toLowerCase();
    const list = rows.filter((e) => (!siteFilter.value || e.site_id === siteFilter.value)
      && (!statusFilter.value || e.status === statusFilter.value)
      && (!term || `${e.first_name} ${e.last_name} ${e.employee_number ?? ''} ${e.job_title ?? ''}`.toLowerCase().includes(term)));
    tbody.replaceChildren(...(list.length ? list.map((e) => h('tr', {},
      h('td', { 'data-label': 'Name' }, h('strong', {}, `${e.first_name} ${e.last_name}`), e.employee_number ? h('div', { class: 'muted small' }, e.employee_number) : null),
      h('td', { 'data-label': 'Job title' }, e.job_title || '—'),
      h('td', { 'data-label': 'Site' }, siteName[e.site_id] || '—', e.department_id ? h('div', { class: 'muted small' }, deptName[e.department_id]) : null),
      h('td', { 'data-label': 'Started' }, fmtDate(e.start_date)),
      h('td', { 'data-label': 'Status' }, badge(...(EMP_STATUS[e.status] || [e.status]))),
      h('td', { class: 'actions' }, can.manage ? [h('button', { class: 'btn-link', onclick: () => form(e) }, 'Edit'),
        h('button', { class: 'btn-link danger', onclick: () => remove(e) }, 'Delete')] : null)))
      : [h('tr', {}, h('td', { colspan: 6, class: 'muted' }, 'No employees match these filters.'))]));
  };
  [search, siteFilter, statusFilter].forEach((el) => el.addEventListener('input', draw));
  card.append(h('div', { class: 'toolbar' }, search, siteFilter, statusFilter),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ['Name', 'Job title', 'Site', 'Started', 'Status', ''].map((t) => h('th', { scope: 'col' }, t)))), tbody)));
  draw();
}

async function contractors(panel, { state, can, reload }) {
  const org = state.org.id;
  const rows = await q(sb.from('contractors').select('*').eq('org_id', org).order('company_name'));
  const form = (c = {}) => modalForm({
    title: c.id ? 'Edit contractor' : 'Add a contractor',
    submitLabel: c.id ? 'Save contractor' : 'Add contractor',
    fields: [
      { name: 'company_name', label: 'Company name', required: true, value: c.company_name, maxlength: 160 },
      { name: 'registration_number', label: 'Registration number', value: c.registration_number, maxlength: 40 },
      { name: 'services', label: 'Services provided', value: c.services, maxlength: 200, placeholder: 'e.g. Electrical maintenance' },
      { name: 'contact_name', label: 'Contact person', value: c.contact_name, maxlength: 120 },
      { name: 'contact_email', label: 'Contact email', type: 'email', value: c.contact_email, maxlength: 200 },
      { name: 'access_status', label: 'Site access', type: 'select', value: c.access_status ?? 'pending', options: Object.entries(ACCESS).map(([k, [l]]) => [k, l]) },
      { name: 'induction_completed_on', label: 'Induction completed on', type: 'date', value: c.induction_completed_on },
      { name: 'access_expires_on', label: 'Access expires on', type: 'date', value: c.access_expires_on },
      { name: 'notes', label: 'Notes', type: 'textarea', value: c.notes, maxlength: 2000, rows: 3 },
    ],
    onSubmit: async (v) => {
      const row = { ...v };
      for (const k of Object.keys(row)) if (row[k] === '') row[k] = null;
      if (c.id) await q(sb.from('contractors').update(row).eq('id', c.id));
      else await q(sb.from('contractors').insert({ ...row, org_id: org }));
    },
  }).then((r) => { if (r) { toast(c.id ? 'Contractor saved.' : 'Contractor added.'); reload(); } });

  const card = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, `Contractors (${rows.length})`),
    can.edit ? h('button', { class: 'btn btn-primary', onclick: () => form() }, 'Add a contractor') : null),
    h('p', { class: 'sub' }, 'Basic contractor register. Safety-file submissions, inductions and contractor inspections arrive with the contractor management module.'));
  panel.append(card);
  if (!rows.length) {
    card.append(emptyState('No contractors yet', 'Record the companies that do work on your sites.',
      can.edit ? h('button', { class: 'btn btn-primary', onclick: () => form() }, 'Add your first contractor') : null));
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, ['Company', 'Services', 'Contact', 'Access', 'Expires', ''].map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', {}, rows.map((c) => {
      const expired = c.access_expires_on && c.access_expires_on < today;
      const st = expired ? ACCESS.expired : (ACCESS[c.access_status] || [c.access_status]);
      return h('tr', {},
        h('td', { 'data-label': 'Company' }, h('strong', {}, c.company_name), c.registration_number ? h('div', { class: 'muted small' }, c.registration_number) : null),
        h('td', { 'data-label': 'Services' }, c.services || '—'),
        h('td', { 'data-label': 'Contact' }, c.contact_name || '—', c.contact_email ? h('div', { class: 'muted small' }, c.contact_email) : null),
        h('td', { 'data-label': 'Access' }, badge(...st)),
        h('td', { 'data-label': 'Expires' }, fmtDate(c.access_expires_on)),
        h('td', { class: 'actions' }, can.edit ? h('button', { class: 'btn-link', onclick: () => form(c) }, 'Edit') : null));
    })))));
}
