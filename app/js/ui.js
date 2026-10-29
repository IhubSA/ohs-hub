// OHS Hub — small UI toolkit. All DOM is built with h() so record data is
// always inserted as text, never as HTML.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v; // only ever used with static, trusted markup (icons)
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const ROLE_LABELS = {
  org_admin: 'Organisation Administrator', ohs_manager: 'OHS Manager', safety_officer: 'Safety Officer',
  supervisor: 'Supervisor', employee: 'Employee', auditor: 'Auditor (read-only)',
};
export const ROLE_HELP = {
  org_admin: 'Manages the organisation, users, roles, sites and departments.',
  ohs_manager: 'Oversees the OHS system and reviews controlled documents.',
  safety_officer: 'Conducts inspections, maintains risk assessments, reports and investigates incidents.',
  supervisor: 'Works on records for their sites: inspections, hazards, incidents and assigned actions.',
  employee: 'Reads approved safety documents, reports hazards and incidents, completes acknowledgements.',
  auditor: 'Read-only access to permitted records and reports.',
};
export const INDUSTRIES = {
  general: 'General commercial', construction: 'Construction', mining: 'Mining', manufacturing: 'Manufacturing',
  engineering_maintenance: 'Engineering and maintenance', logistics_warehousing: 'Logistics and warehousing',
  transport: 'Transport', facilities_management: 'Facilities management', ohs_consultancy: 'OHS consultancy',
};
export const PROVINCES = ['Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo', 'Mpumalanga',
  'Northern Cape', 'North West', 'Western Cape'];

const TZ = 'Africa/Johannesburg';
export const fmtDate = (d) => d ? new Date(d.length === 10 ? d + 'T12:00:00' : d)
  .toLocaleDateString('en-ZA', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' }) : '—';
export const fmtDateTime = (d) => d ? new Date(d)
  .toLocaleString('en-ZA', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
export function relTime(d) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return fmtDate(d);
}

// Turn database / API errors into plain guidance.
export function errMsg(e) {
  const m = (e && (e.message || e.error_description || e.error)) || String(e || '');
  if (/row-level security|permission denied|42501/i.test(m)) return 'Your role does not allow this change.';
  if (/duplicate key|already exists|23505/i.test(m)) return 'A record with these details already exists.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'You appear to be offline. Check your connection and try again.';
  if (/JWT|session/i.test(m)) return 'Your session has expired. Sign in again.';
  return m.replace(/^.*?ERROR:\s*/, '');
}

export function toast(msg, kind = 'ok') {
  const t = h('div', { class: `toast ${kind === 'err' ? 'err' : ''}` }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 7000 : 4000);
}

export const icon = (paths) => h('span', { 'aria-hidden': 'true', html:
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="18" height="18">${paths}</svg>` });

export function emptyState(title, text, action) {
  return h('div', { class: 'empty' }, h('h3', {}, title), h('p', {}, text), action || null);
}

export function badge(text, kind = '') { return h('span', { class: `badge ${kind}` }, text); }

// ---------------------------------------------------------------------
// Modal form. fields: [{ name, label, type, required, options, value,
// hint, maxlength, placeholder, rows }]. onSubmit(values) may throw.
// ---------------------------------------------------------------------
export function modalForm({ title, intro, fields, submitLabel = 'Save', danger = false, onSubmit }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: 'modal', 'aria-labelledby': 'mdl-title' });
    const status = h('div', { class: 'alert alert--err', role: 'alert', hidden: true });
    const form = h('form', { class: 'form', novalidate: true });
    const inputs = {};
    for (const f of fields) {
      const id = `f-${f.name}`;
      let input;
      if (f.type === 'select') {
        input = h('select', { id, name: f.name },
          (f.options || []).map(([v, l]) => h('option', { value: v, selected: String(f.value ?? '') === String(v) }, l)));
      } else if (f.type === 'textarea') {
        input = h('textarea', { id, name: f.name, maxlength: f.maxlength, rows: f.rows || 4, placeholder: f.placeholder }, f.value ?? '');
      } else if (f.type === 'checkbox') {
        input = h('input', { id, name: f.name, type: 'checkbox', checked: !!f.value });
        form.append(h('label', { class: 'switch-row', for: id }, input, h('span', {}, f.label, f.hint ? h('small', {}, f.hint) : null)));
        inputs[f.name] = { f, input };
        continue;
      } else if (f.type === 'checks') {
        const box = h('div', { class: 'checks', id, role: 'group', 'aria-label': f.label });
        const sel = new Set(f.value || []);
        for (const [v, l] of f.options || []) box.append(h('label', {}, h('input', { type: 'checkbox', value: v, checked: sel.has(v) }), l));
        input = box;
      } else {
        input = h('input', { id, name: f.name, type: f.type || 'text', value: f.value ?? '', maxlength: f.maxlength,
          placeholder: f.placeholder, autocomplete: f.autocomplete || 'off' });
      }
      inputs[f.name] = { f, input };
      form.append(h('div', { class: 'field' },
        h('label', { for: id }, f.label, f.required ? null : h('span', { class: 'muted' }, ' (optional)')),
        input, f.hint ? h('p', { class: 'hint' }, f.hint) : null, h('p', { class: 'error' })));
    }
    const submit = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'submit' }, submitLabel);
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.append(
      h('div', { class: 'modal-head' }, h('h2', { id: 'mdl-title' }, title),
        h('button', { class: 'modal-close', type: 'button', 'aria-label': 'Close', onclick: () => close(null) }, '×')),
      h('div', { class: 'modal-body' }, intro ? h('p', { class: 'muted' }, intro) : null, status, form),
      h('div', { class: 'modal-foot' },
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => close(null) }, 'Cancel'), submit));
    submit.setAttribute('form', 'mdl-form');
    form.id = 'mdl-form';
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = {};
      let firstBad = null;
      for (const [name, { f, input }] of Object.entries(inputs)) {
        let v;
        if (f.type === 'checkbox') v = input.checked;
        else if (f.type === 'checks') v = [...input.querySelectorAll('input:checked')].map((i) => i.value);
        else v = input.value.trim();
        values[name] = v;
        const field = input.closest('.field');
        let msg = '';
        if (f.required && (v === '' || (Array.isArray(v) && !v.length))) msg = `${f.label} is required.`;
        else if (f.type === 'email' && v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) msg = 'Enter a valid email address.';
        else if (f.validate) msg = f.validate(v, values) || '';
        if (field) { field.classList.toggle('has-error', !!msg); field.querySelector('.error').textContent = msg; }
        if (msg && !firstBad) firstBad = input;
      }
      if (firstBad) { firstBad.focus(); return; }
      submit.disabled = true;
      const label = submit.textContent;
      submit.textContent = 'Saving…';
      try {
        const result = await onSubmit(values);
        // Functions that return nothing come back as null or an empty body: treat as success.
        close(result === undefined || result === null || result === '' ? values : result);
      } catch (err) {
        status.hidden = false;
        status.textContent = errMsg(err);
        submit.disabled = false;
        submit.textContent = label;
      }
    });
    document.body.append(dlg);
    dlg.showModal();
    form.querySelector('input:not([type=checkbox]), select, textarea')?.focus();
  });
}

export function confirmAction(title, text, label = 'Confirm', danger = true) {
  return modalForm({ title, intro: text, fields: [], submitLabel: label, danger, onSubmit: async () => true });
}

export function opt(map) { return Object.entries(map); }
