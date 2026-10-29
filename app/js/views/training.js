// Training and competence: courses with validity periods, who needs which
// course (by job title or department), training records with certificates,
// and a matrix showing valid, expiring, expired or missing for each person.
// Expiry dates are worked out by the database from the course validity.
import { sb, q } from '../sb.js';
import { h, modalForm, confirmAction, toast, errMsg, emptyState, fmtDate, opt } from '../ui.js';
import {
  loadSites, loadDepts, today, statusBadge, setQuery, downloadCsv, uploadFile, openFile, checkFile, ACCEPT,
  COURSE_KIND, EXPIRY, expiryState, expiryBadge, planAllows, planNotice,
} from '../data.js';

export async function render(view, ctx) {
  if (!planAllows(ctx.state, 'training')) return planNotice(view, 'Training', 'Training records and the training matrix');
  if (!ctx.can.staff) return myTraining(view, ctx);
  const tab = ctx.query.get('t') || 'matrix';
  view.append(h('div', { class: 'page-title' },
    h('div', {}, h('h1', {}, 'Training'), h('p', {}, 'Who needs which training, who has it, and what is about to expire.')),
    ctx.can.edit ? h('button', { class: 'btn btn-primary', onclick: async () => { if (await recordForm(ctx.state.org.id)) { toast('Training recorded.'); ctx.reload(); } } }, 'Record training') : null));
  view.append(h('div', { class: 'tabs', role: 'tablist' },
    [['matrix', 'Training matrix'], ['records', 'Records'], ['courses', 'Courses and requirements']].map(([k, l]) =>
      h('button', { role: 'tab', 'aria-selected': String(k === tab), onclick: () => setQuery('training', { t: k }) }, l))));
  const panel = h('div');
  view.append(panel);
  if (tab === 'records') return records(panel, ctx);
  if (tab === 'courses') return courses(panel, ctx);
  return matrix(panel, ctx);
}

const person = (e) => `${e.first_name} ${e.last_name}`;

async function loadAll(org) {
  const [courses, reqs, emps, contractors, recs] = await Promise.all([
    q(sb.from('training_courses').select('*').eq('org_id', org).order('name')),
    q(sb.from('competency_requirements').select('*').eq('org_id', org)),
    q(sb.from('employees').select('id, first_name, last_name, job_title, department_id, site_id, status, user_id').eq('org_id', org).order('last_name')),
    q(sb.from('contractors').select('id, company_name').eq('org_id', org).order('company_name')),
    q(sb.from('training_records').select('*').eq('org_id', org).order('completed_on', { ascending: false })),
  ]);
  return { courses, reqs, emps, contractors, recs };
}

// Latest record per person and course
function latestMap(recs) {
  const m = new Map();
  for (const r of recs) {
    const key = `${r.employee_id || 'c:' + r.contractor_id}|${r.course_id}`;
    if (!m.has(key)) m.set(key, r);
  }
  return m;
}
const norm = (s) => String(s || '').trim().toLowerCase();
function required(reqs, e, courseId) {
  return reqs.some((r) => r.course_id === courseId && (
    (!r.job_title && !r.department_id) || (r.job_title && norm(r.job_title) === norm(e.job_title)) || (r.department_id && r.department_id === e.department_id)));
}

async function matrix(panel, { state, can, query, reload }) {
  const org = state.org.id;
  const site = query.get('site') || '';
  const showAll = query.get('all') === '1';
  const [{ courses, reqs, emps, recs }, sites, depts] = await Promise.all([loadAll(org), loadSites(org), loadDepts(org)]);
  const latest = latestMap(recs);
  const people = emps.filter((e) => e.status === 'active' && (!site || e.site_id === site));
  const cols = showAll ? courses : courses.filter((c) => reqs.some((r) => r.course_id === c.id));

  panel.append(h('div', { class: 'filters' },
    sites.length > 1 ? h('label', {}, 'Site', h('select', { onchange: (e) => setQuery('training', { t: 'matrix', site: e.target.value, all: showAll ? '1' : '' }) },
      [['', 'All sites'], ...sites.map((s) => [s.id, s.name])].map(([v, l]) => h('option', { value: v, selected: v === site }, l)))) : null,
    h('label', { class: 'inline-check' }, h('input', { type: 'checkbox', checked: showAll, onchange: (e) => setQuery('training', { t: 'matrix', site, all: e.target.checked ? '1' : '' }) }),
      'Show courses nobody is required to do')));

  const card = h('div', { class: 'card' });
  panel.append(card);
  if (!courses.length) {
    card.append(emptyState('No courses yet', 'Start by adding the courses, certificates and licences your people need, and how long each one stays valid.',
      can.manage ? h('a', { class: 'btn btn-primary', href: '#/training?t=courses' }, 'Add courses') : null));
    return;
  }
  if (!cols.length) { card.append(emptyState('No requirements set', 'Say which job titles or departments need each course under "Courses and requirements". The matrix then shows who is missing what.')); return; }
  if (!people.length) { card.append(emptyState('No employees', 'Add your employees under People to build the matrix.')); return; }

  const tally = { valid: 0, expiring: 0, expired: 0, missing: 0 };
  const cellState = (e, c) => {
    const r = latest.get(`${e.id}|${c.id}`);
    const need = required(reqs, e, c.id);
    if (!r) return need ? 'missing' : null;
    return expiryState(r.expires_on);
  };
  const csv = [['Employee', 'Job title', ...cols.map((c) => c.name)]];
  const body = people.map((e) => {
    const row = [person(e), e.job_title || ''];
    const tr = h('tr', {}, h('th', { scope: 'row' }, person(e), h('div', { class: 'muted small' }, e.job_title || '')),
      cols.map((c) => {
        const st = cellState(e, c);
        const need = required(reqs, e, c.id);
        const r = latest.get(`${e.id}|${c.id}`);
        if (st && need) tally[st]++;
        row.push(st ? `${EXPIRY[st]}${r?.expires_on ? ' ' + r.expires_on : ''}` : '');
        const content = st ? h('span', { class: `cell cell-${st}`, title: `${c.name}: ${EXPIRY[st]}${r?.expires_on ? ' (' + fmtDate(r.expires_on) + ')' : ''}` }, EXPIRY[st].split(' ')[0]) : h('span', { class: 'muted' }, '·');
        return h('td', { 'data-label': c.name },
          can.edit ? h('button', { class: 'cell-btn', type: 'button', 'aria-label': `${person(e)}, ${c.name}: ${st ? EXPIRY[st] : 'not required'}. Record training`,
            onclick: async () => { if (await recordForm(org, { employee_id: e.id, course_id: c.id })) { toast('Training recorded.'); reload(); } } }, content) : content);
      }));
    csv.push(row);
    return tr;
  });
  card.append(h('div', { class: 'stats compact' }, Object.entries(tally).map(([k, n]) =>
    h('div', { class: 'stat' }, h('div', { class: 'n' }, String(n)), h('div', { class: 'l' }, EXPIRY[k])))));
  card.append(h('div', { class: 'card-head' }, h('span', { class: 'muted small' }, 'Counts include required training only. Click a cell to record training.'),
    h('button', { class: 'btn btn-secondary btn-sm', onclick: () => downloadCsv('training-matrix.csv', csv) }, 'Export CSV')));
  card.append(h('div', { class: 'tmatrix-wrap' }, h('table', { class: 'tmatrix' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Person'), cols.map((c) => h('th', { scope: 'col' }, h('span', {}, c.name))))),
    h('tbody', {}, body))));
}

async function records(panel, { state, can, query, reload }) {
  const org = state.org.id;
  const f = query.get('f') || '';
  const { courses, emps, contractors, recs } = await loadAll(org);
  const cMap = new Map(courses.map((c) => [c.id, c]));
  const eMap = new Map(emps.map((e) => [e.id, person(e)]));
  const kMap = new Map(contractors.map((k) => [k.id, k.company_name]));
  const latest = new Set([...latestMap(recs).values()].map((r) => r.id));
  const rows = recs.filter((r) => !f || (latest.has(r.id) && expiryState(r.expires_on) === f));
  panel.append(h('div', { class: 'chips' }, [['', 'All records'], ['expiring', 'Expiring in 30 days'], ['expired', 'Expired']].map(([k, l]) =>
    h('button', { class: 'chip', 'aria-pressed': String(f === k), onclick: () => setQuery('training', { t: 'records', f: k }) }, l))));
  const card = h('div', { class: 'card' });
  panel.append(card);
  if (!rows.length) { card.append(emptyState(f ? 'Nothing here' : 'No training recorded yet', 'Use "Record training" to add completed courses and certificates.')); return; }
  card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, ['Person', 'Course', 'Completed', 'Expiry', 'Provider', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((r) => h('tr', {},
      h('td', { 'data-label': 'Person' }, r.employee_id ? eMap.get(r.employee_id) || '—' : `${kMap.get(r.contractor_id) || 'Contractor'} (contractor)`),
      h('td', { 'data-label': 'Course' }, cMap.get(r.course_id)?.name || '—'),
      h('td', { 'data-label': 'Completed' }, fmtDate(r.completed_on)),
      h('td', { 'data-label': 'Expiry' }, latest.has(r.id) ? expiryBadge(r.expires_on) : h('span', { class: 'muted' }, r.expires_on ? `Replaced (${fmtDate(r.expires_on)})` : 'Replaced')),
      h('td', { 'data-label': 'Provider' }, r.provider || '—'),
      h('td', { class: 'actions' },
        r.certificate_path ? h('button', { class: 'btn-link', onclick: () => openFile(r.certificate_path).catch((e) => toast(errMsg(e), 'err')) }, 'Certificate') : null,
        can.manage ? h('button', { class: 'btn-link danger', onclick: async () => {
          if (await confirmAction('Delete this record?', 'Use this only for records captured in error.', 'Delete')) {
            try { await q(sb.from('training_records').delete().eq('id', r.id)); toast('Record deleted.'); reload(); } catch (e) { toast(errMsg(e), 'err'); }
          } } }, 'Delete') : null)))))));
}

export async function recordForm(org, preset = {}) {
  const { courses, emps, contractors } = await loadAll(org);
  if (!courses.length) { toast('Add a course first, under "Courses and requirements".', 'err'); return null; }
  const people = [['', 'Choose a person'], ...emps.filter((e) => e.status === 'active').map((e) => [`e:${e.id}`, person(e)]),
    ...contractors.map((k) => [`c:${k.id}`, `${k.company_name} (contractor)`])];
  const res = await modalForm({
    title: 'Record training',
    submitLabel: 'Save record',
    fields: [
      { name: 'who', label: 'Person', type: 'select', required: true, value: preset.employee_id ? `e:${preset.employee_id}` : preset.contractor_id ? `c:${preset.contractor_id}` : '', options: people },
      { name: 'course_id', label: 'Course', type: 'select', required: true, value: preset.course_id || '', options: [['', 'Choose a course'], ...courses.map((c) => [c.id, c.name])] },
      { name: 'completed_on', label: 'Completed on', type: 'date', required: true, value: today(), validate: (v) => (v > today() ? 'Can\'t be in the future.' : '') },
      { name: 'expires_on', label: 'Expires on', type: 'date', hint: 'Leave blank to work it out from the course validity.' },
      { name: 'provider', label: 'Training provider', maxlength: 160 },
      { name: 'notes', label: 'Notes', maxlength: 1000 },
      { name: 'file', label: 'Certificate', type: 'file', accept: ACCEPT, hint: 'Photo or PDF, up to 10 MB.' },
    ],
    onSubmit: async (v) => {
      const file = v.file;
      if (file) { const bad = checkFile(file); if (bad) throw new Error(bad); }
      const [kind, id] = v.who.split(':');
      const row = await q(sb.from('training_records').insert({ org_id: org, course_id: v.course_id, completed_on: v.completed_on,
        expires_on: v.expires_on || null, provider: v.provider || null, notes: v.notes || null,
        employee_id: kind === 'e' ? id : null, contractor_id: kind === 'c' ? id : null }).select('id').single());
      if (file) {
        const up = await uploadFile(org, 'training', row.id, file);
        await q(sb.from('training_records').update({ certificate_path: up.path }).eq('id', row.id));
      }
      return row;
    },
  });
  return res;
}

async function courses(panel, { state, can, reload }) {
  const org = state.org.id;
  const [{ courses, reqs }, depts] = await Promise.all([loadAll(org), loadDepts(org)]);
  const dName = new Map(depts.map((d) => [d.id, d.name]));
  if (can.manage) panel.append(h('div', { class: 'btn-row', style: 'margin-bottom:14px' },
    h('button', { class: 'btn btn-secondary', onclick: async () => { if (await courseForm(org)) { toast('Course added.'); reload(); } } }, 'Add a course')));
  if (!courses.length) { panel.append(h('div', { class: 'card' }, emptyState('No courses yet', 'Add inductions, courses, certificates and licences, with how long each stays valid.'))); return; }
  for (const c of courses) {
    const mine = reqs.filter((r) => r.course_id === c.id);
    panel.append(h('div', { class: 'site-block' },
      h('header', {}, h('div', {}, h('h3', {}, c.name), h('div', { class: 'meta' }, `${COURSE_KIND[c.kind]} · ${c.validity_months ? `valid for ${c.validity_months} months` : 'does not expire'}`)),
        can.manage ? h('div', { class: 'btn-row' },
          h('button', { class: 'btn btn-secondary btn-sm', onclick: async () => { if (await requirementForm(org, c, depts)) { toast('Requirement added.'); reload(); } } }, 'Who needs it'),
          h('button', { class: 'btn-link', onclick: async () => { if (await courseForm(org, c)) { toast('Course saved.'); reload(); } } }, 'Edit')) : null),
      h('div', { style: 'padding:10px 16px' }, mine.length
        ? h('ul', { class: 'dept-list' }, mine.map((r) => h('li', {},
          h('span', {}, !r.job_title && !r.department_id ? 'Everyone' : [r.job_title ? `Job title: ${r.job_title}` : null, r.department_id ? `Department: ${dName.get(r.department_id) || '—'}` : null].filter(Boolean).join(', ')),
          can.manage ? h('button', { class: 'btn-link danger', onclick: async () => { await q(sb.from('competency_requirements').delete().eq('id', r.id)); reload(); } }, 'Remove') : null)))
        : h('p', { class: 'muted', style: 'margin:0' }, 'Not required for anyone yet.'))));
  }
}

function courseForm(org, c = {}) {
  return modalForm({
    title: c.id ? 'Edit course' : 'Add a course',
    submitLabel: 'Save course',
    fields: [
      { name: 'name', label: 'Name', required: true, value: c.name, maxlength: 160, placeholder: 'e.g. First aid level 1' },
      { name: 'kind', label: 'Type', type: 'select', value: c.kind || 'course', options: opt(COURSE_KIND) },
      { name: 'validity_months', label: 'Valid for (months)', type: 'number', value: c.validity_months ?? '', hint: 'Leave blank if it does not expire.',
        validate: (v) => (v && !(Number(v) >= 1 && Number(v) <= 240) ? 'Enter a number of months between 1 and 240.' : '') },
      { name: 'description', label: 'Description', type: 'textarea', rows: 2, maxlength: 1000, value: c.description },
    ],
    onSubmit: (v) => {
      const row = { name: v.name, kind: v.kind, validity_months: v.validity_months ? Number(v.validity_months) : null, description: v.description || null };
      return c.id ? q(sb.from('training_courses').update(row).eq('id', c.id)) : q(sb.from('training_courses').insert({ ...row, org_id: org }));
    },
  });
}

function requirementForm(org, c, depts) {
  return modalForm({
    title: `Who needs ${c.name}?`,
    intro: 'Choose a job title, a department, or leave both blank if everyone needs it. Job titles must match the ones on employee records.',
    submitLabel: 'Add requirement',
    fields: [
      { name: 'job_title', label: 'Job title', maxlength: 120, placeholder: 'e.g. Rigger' },
      { name: 'department_id', label: 'Department', type: 'select', options: [['', 'Any department'], ...depts.map((d) => [d.id, d.name])] },
    ],
    onSubmit: (v) => q(sb.from('competency_requirements').insert({ org_id: org, course_id: c.id, job_title: v.job_title || null, department_id: v.department_id || null })),
  });
}

// Employees see their own training
async function myTraining(view, { state }) {
  const org = state.org.id;
  view.append(h('div', { class: 'page-title' }, h('div', {}, h('h1', {}, 'My training'), h('p', {}, 'Your courses, certificates and when they expire.'))));
  const me = await q(sb.from('employees').select('id').eq('org_id', org).eq('user_id', state.user.id).maybeSingle());
  const card = h('div', { class: 'card' });
  view.append(card);
  if (!me) { card.append(emptyState('No employee record linked', 'Ask your OHS manager to link your login to your employee record.')); return; }
  const [recs, courses] = await Promise.all([
    q(sb.from('training_records').select('*').eq('employee_id', me.id).order('completed_on', { ascending: false })),
    q(sb.from('training_courses').select('id, name').eq('org_id', org)),
  ]);
  const cMap = new Map(courses.map((c) => [c.id, c.name]));
  const latest = [...latestMap(recs).values()];
  if (!latest.length) { card.append(emptyState('Nothing recorded yet', 'Training you complete will appear here.')); return; }
  card.append(h('ul', { class: 'file-list' }, latest.map((r) => h('li', {}, h('span', {}, h('strong', {}, cMap.get(r.course_id) || 'Course'),
    h('br'), h('span', { class: 'muted small' }, `Completed ${fmtDate(r.completed_on)}`)), expiryBadge(r.expires_on)))));
}
