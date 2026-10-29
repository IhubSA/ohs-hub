// Company details, organisation settings and subscription status.
import { sb, q } from '../sb.js';
import { h, INDUSTRIES, PROVINCES, fmtDate, toast, errMsg, badge } from '../ui.js';

export async function render(view, { state, can, reload }) {
  const org = await q(sb.from('organisations').select('*').eq('id', state.org.id).single());
  const [members, sites] = await Promise.all([
    sb.from('organisation_memberships').select('id', { count: 'exact', head: true }).eq('org_id', org.id).eq('status', 'active'),
    sb.from('sites').select('id', { count: 'exact', head: true }).eq('org_id', org.id).eq('is_active', true),
  ]);
  const plan = state.sub?.subscription_plans;

  view.append(h('div', { class: 'page-title' }, h('div', {}, h('h1', {}, 'Company'),
    h('p', {}, can.admin ? 'Details that identify your organisation on reports and documents.' : 'Only an organisation administrator can change these details.'))));

  // ---- Details form ----
  const ro = !can.admin;
  const inp = (name, attrs = {}) => h('input', { id: `c-${name}`, name, value: org[name] ?? '', disabled: ro, ...attrs });
  const fld = (name, label, input, optional = true) => h('div', { class: 'field' },
    h('label', { for: `c-${name}` }, label, optional ? h('span', { class: 'muted' }, ' (optional)') : null), input, h('p', { class: 'error' }));
  const settings = org.settings || {};
  const indep = h('input', { type: 'checkbox', id: 'c-indep', checked: settings.require_independent_approval !== false, disabled: ro });
  const conf = h('input', { type: 'checkbox', id: 'c-conf', checked: settings.confidential_incidents_enabled !== false, disabled: ro });
  const save = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save changes');

  const form = h('form', { class: 'form', novalidate: true },
    fld('name', 'Registered company name', inp('name', { maxlength: 160, required: true }), false),
    h('div', { class: 'form-row' },
      fld('trading_name', 'Trading name', inp('trading_name', { maxlength: 160 })),
      fld('industry', 'Industry', h('select', { id: 'c-industry', name: 'industry', disabled: ro },
        Object.entries(INDUSTRIES).map(([v, l]) => h('option', { value: v, selected: v === org.industry }, l))), false)),
    h('div', { class: 'form-row' },
      fld('registration_number', 'CIPC registration number', inp('registration_number', { maxlength: 40 })),
      fld('vat_number', 'VAT number', inp('vat_number', { maxlength: 20 }))),
    h('div', { class: 'form-row' },
      fld('province', 'Province', h('select', { id: 'c-province', name: 'province', disabled: ro },
        h('option', { value: '' }, 'Select'), PROVINCES.map((p) => h('option', { value: p, selected: p === org.province }, p)))),
      h('div')),
    fld('physical_address', 'Physical address', h('textarea', { id: 'c-physical_address', name: 'physical_address', rows: 3, maxlength: 400, disabled: ro }, org.physical_address ?? '')),
    h('h3', { style: 'margin-top:8px' }, 'Policies'),
    h('label', { class: 'switch-row', for: 'c-indep' }, indep, h('span', {}, 'Require independent approval',
      h('small', {}, 'Nobody can approve a document they wrote themselves.'))),
    h('label', { class: 'switch-row', for: 'c-conf' }, conf, h('span', {}, 'Allow confidential incident reports',
      h('small', {}, 'Confidential reports are visible only to administrators, OHS managers and people you authorise.'))),
    can.admin ? h('div', {}, save) : null);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = form.elements.name.value.trim();
    const nameField = form.elements.name.closest('.field');
    nameField.classList.toggle('has-error', name.length < 2);
    nameField.querySelector('.error').textContent = name.length < 2 ? 'Enter the company name.' : '';
    if (name.length < 2) return;
    save.disabled = true;
    try {
      const v = (n) => form.elements[n].value.trim() || null;
      await q(sb.from('organisations').update({
        name, trading_name: v('trading_name'), industry: form.elements.industry.value,
        registration_number: v('registration_number'), vat_number: v('vat_number'), province: v('province'),
        physical_address: v('physical_address'),
        settings: { ...settings, require_independent_approval: indep.checked, confidential_incidents_enabled: conf.checked },
      }).eq('id', org.id));
      state.org.name = name;
      toast('Company details saved.');
      const sel = document.querySelector('#org-select option:checked') || document.querySelector('.org-name');
      if (sel) sel.textContent = name;
    } catch (err) { toast(errMsg(err), 'err'); }
    save.disabled = false;
  });

  // ---- Subscription ----
  const meter = (used, max) => max ? h('div', { class: 'meter', role: 'img', 'aria-label': `${used} of ${max}` },
    h('span', { style: `width:${Math.min(100, Math.round((used / max) * 100))}%` })) : null;
  const statusBadge = { trialing: ['Free trial', 'warn'], active: ['Active', 'ok'], past_due: ['Payment overdue', 'bad'],
    cancelled: ['Cancelled', 'bad'], expired: ['Expired', 'bad'] }[state.sub?.status] || ['Unknown', ''];
  const subCard = h('div', { class: 'card' }, h('h2', {}, 'Plan and usage'),
    h('dl', { class: 'kv', style: 'margin-top:12px' },
      h('dt', {}, 'Plan'), h('dd', {}, plan?.name ?? '—'),
      h('dt', {}, 'Status'), h('dd', {}, badge(statusBadge[0], statusBadge[1])),
      state.sub?.trial_ends_at ? [h('dt', {}, 'Trial ends'), h('dd', {}, fmtDate(state.sub.trial_ends_at))] : null,
      h('dt', {}, 'Users'), h('dd', {}, `${members.count ?? 0}${plan?.max_users ? ` of ${plan.max_users}` : ''}`, meter(members.count ?? 0, plan?.max_users)),
      h('dt', {}, 'Sites'), h('dd', {}, `${sites.count ?? 0}${plan?.max_sites ? ` of ${plan.max_sites}` : ''}`, meter(sites.count ?? 0, plan?.max_sites)),
      h('dt', {}, 'Billing'), h('dd', {}, 'Online payment is not available yet. We will contact you before your trial ends.')),
    h('p', { class: 'small muted', style: 'margin-top:14px' }, 'Need more users or sites? ',
      h('a', { href: '../contact.html?topic=pricing', target: '_blank', rel: 'noopener' }, 'Contact us about upgrading'), '.'));

  view.append(h('div', { class: 'grid-2' }, h('div', { class: 'card' }, h('h2', {}, 'Company details'), form), subCard));
}
