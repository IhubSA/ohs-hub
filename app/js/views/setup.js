// First-run company setup: creates the organisation (caller becomes
// administrator on a free trial), then the first site and departments.
import { sb, q } from '../sb.js';
import { h, INDUSTRIES, PROVINCES, errMsg } from '../ui.js';

const LOGO = '<img src="../assets/img/logo.png" alt="OHS Hub" width="110" height="44">';

function field(id, label, input, { optional = false, hint } = {}) {
  input.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label, optional ? h('span', { class: 'muted' }, ' (optional)') : null),
    input, hint ? h('p', { class: 'hint' }, hint) : null, h('p', { class: 'error' }));
}
const setErr = (input, msg) => {
  const f = input.closest('.field');
  f.classList.toggle('has-error', !!msg);
  f.querySelector('.error').textContent = msg || '';
  return !msg;
};

export function renderSetup(root, { state, onDone }) {
  const meta = state.user.user_metadata || {};
  let orgId = null;
  const status = h('div', { class: 'alert alert--err', role: 'alert', hidden: true });
  const stepsNav = (n) => h('ol', { class: 'steps-mini', 'aria-label': 'Setup steps' },
    ['Company details', 'First site'].map((s, i) => h('li', { 'aria-current': i + 1 === n ? 'step' : null }, h('b', {}, i + 1), s)));
  const card = h('div', { class: 'card' });
  root.replaceChildren(h('div', { class: 'center-page' }, h('div', { class: 'setup' },
    h('a', { class: 'brand', href: '../index.html', html: LOGO }), card)));

  // ---- Step 1: company ----
  function step1() {
    const name = h('input', { value: meta.company_name || '', maxlength: 160, autocomplete: 'organization', required: true });
    const industry = h('select', {}, Object.entries(INDUSTRIES).map(([v, l]) => h('option', { value: v, selected: v === (meta.industry || 'general') }, l)));
    const reg = h('input', { maxlength: 40, placeholder: 'e.g. 2019/123456/07' });
    const province = h('select', {}, h('option', { value: '' }, 'Select'), PROVINCES.map((p) => h('option', { value: p }, p)));
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create company');
    const form = h('form', { class: 'form', novalidate: true },
      field('org-name', 'Company name', name),
      h('div', { class: 'form-row' }, field('org-industry', 'Industry', industry), field('org-province', 'Province', province, { optional: true })),
      field('org-reg', 'CIPC registration number', reg, { optional: true }),
      status, h('div', {}, submit));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!setErr(name, name.value.trim().length >= 2 ? '' : 'Enter your company name.')) { name.focus(); return; }
      submit.disabled = true; submit.textContent = 'Creating…'; status.hidden = true;
      try {
        orgId = await q(sb.rpc('create_organisation', {
          p_name: name.value.trim(), p_industry: industry.value,
          p_registration_number: reg.value.trim() || null, p_province: province.value || null,
        }));
        step2();
      } catch (err) {
        status.hidden = false; status.textContent = errMsg(err);
        submit.disabled = false; submit.textContent = 'Create company';
      }
    });
    card.replaceChildren(stepsNav(1), h('h1', { style: 'font-size:2rem' }, 'Set up your company'),
      h('p', { class: 'muted' }, 'You will be the administrator. Your 14-day free trial of the Professional plan starts now. No card details are needed.'),
      form);
    name.focus();
  }

  // ---- Step 2: first site and departments ----
  function step2() {
    const site = h('input', { maxlength: 160, placeholder: 'e.g. Head office, Plant 1, Durban depot' });
    const depts = h('textarea', { rows: 4, placeholder: 'One per line, e.g.\nWorkshop\nWarehouse\nAdministration' });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Finish setup');
    const skip = h('button', { class: 'btn-link', type: 'button', onclick: () => onDone(orgId) }, 'Skip for now');
    const form = h('form', { class: 'form', novalidate: true },
      field('site-name', 'Site name', site),
      field('site-depts', 'Departments at this site', depts, { optional: true, hint: 'You can add or change these later under Sites & departments.' }),
      status, h('div', { class: 'btn-row' }, submit, skip));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!setErr(site, site.value.trim() ? '' : 'Enter a site name, or choose "Skip for now".')) { site.focus(); return; }
      submit.disabled = true; submit.textContent = 'Saving…'; status.hidden = true;
      try {
        const s = await q(sb.from('sites').insert({ org_id: orgId, name: site.value.trim() }).select('id').single());
        const names = [...new Set(depts.value.split('\n').map((x) => x.trim()).filter(Boolean))].slice(0, 30);
        if (names.length) await q(sb.from('departments').insert(names.map((n) => ({ org_id: orgId, site_id: s.id, name: n.slice(0, 160) }))));
        onDone(orgId);
      } catch (err) {
        status.hidden = false; status.textContent = errMsg(err);
        submit.disabled = false; submit.textContent = 'Finish setup';
      }
    });
    card.replaceChildren(stepsNav(2), h('h1', { style: 'font-size:2rem' }, 'Add your first site'),
      h('p', { class: 'muted' }, 'A site is a physical workplace: an office, plant, depot or project site. Records such as inspections and incidents are linked to sites.'),
      form);
    site.focus();
  }

  step1();
}
