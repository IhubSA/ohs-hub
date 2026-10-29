// Dashboard (Stage 3): real counts from the database plus a setup
// checklist. OHS module cards are added as each module ships.
import { sb } from '../sb.js';
import { h, fmtDate } from '../ui.js';

const count = async (table, orgId, extra = (x) => x) => {
  const { count: c, error } = await extra(sb.from(table).select('id', { count: 'exact', head: true }).eq('org_id', orgId));
  return error ? null : c ?? 0;
};

export async function render(view, { state, can }) {
  const org = state.org.id;
  const [orgRow, sites, depts, employees, contractors, members, invites] = await Promise.all([
    sb.from('organisations').select('registration_number, physical_address, province').eq('id', org).single().then((r) => r.data),
    count('sites', org, (x) => x.eq('is_active', true)),
    count('departments', org),
    can.staff ? count('employees', org, (x) => x.eq('status', 'active')) : null,
    can.staff ? count('contractors', org) : null,
    count('organisation_memberships', org, (x) => x.eq('status', 'active')),
    can.admin ? count('organisation_invitations', org, (x) => x.is('accepted_at', null).is('revoked_at', null).gt('expires_at', new Date().toISOString())) : null,
  ]);

  const first = (state.profile?.full_name || '').split(' ')[0];
  view.append(h('div', { class: 'page-title' }, h('div', {},
    h('h1', {}, first ? `Welcome, ${first}` : 'Dashboard'), h('p', {}, state.org.name))));

  if (state.sub?.status === 'trialing') {
    view.append(h('div', { class: 'alert alert--info', style: 'margin-bottom:18px' },
      `You're on a free trial of ${state.sub.subscription_plans?.name ?? 'OHS Hub'} until ${fmtDate(state.sub.trial_ends_at)}. `,
      'Online payment is not switched on yet, so we will contact you about billing before your trial ends.'));
  }

  const stat = (n, label, href) => {
    const inner = [h('div', { class: 'n' }, n == null ? '—' : n), h('div', { class: 'l' }, label)];
    return href ? h('a', { class: 'stat', href }, inner) : h('div', { class: 'stat' }, inner);
  };
  view.append(h('div', { class: 'stats' },
    stat(sites, 'Active sites', '#/sites'),
    stat(depts, 'Departments', '#/sites'),
    can.staff ? stat(employees, 'Active employees', '#/people') : null,
    can.staff ? stat(contractors, 'Contractors', '#/people/contractors') : null,
    stat(members, 'Team members', '#/team')));

  if (can.admin) {
    const companyDone = !!(orgRow?.registration_number && orgRow?.physical_address);
    const items = [
      [companyDone, 'Complete your company details', 'Registration number and physical address appear on reports.', '#/company'],
      [sites > 0, 'Add your sites', 'Every inspection and incident is linked to a site.', '#/sites'],
      [depts > 0, 'Add departments', 'Lets you filter records and dashboards by department.', '#/sites'],
      [employees > 0, 'Add your employees', 'Needed for training records, PPE and incident reports.', '#/people'],
      [members > 1 || invites > 0, 'Invite your team', 'Give your OHS manager, safety officers and supervisors their own login.', '#/team'],
    ];
    const done = items.filter((i) => i[0]).length;
    view.append(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Getting started'), h('span', { class: 'muted' }, `${done} of ${items.length} done`)),
      h('ul', { class: 'checklist' }, items.map(([ok, title, text, href]) => h('li', {},
        h('span', { class: `tick ${ok ? 'done' : ''}`, 'aria-label': ok ? 'Done' : 'Not done yet' }),
        h('div', {}, h('div', { class: ok ? 'done-text' : '' }, title), h('div', { class: 'muted small' }, text)),
        ok ? null : h('a', { class: 'btn btn-secondary btn-sm', href }, 'Open'))))));
  }

  view.append(h('div', { class: 'card' },
    h('h2', {}, 'Safety modules'),
    h('p', { class: 'sub' }, 'Risk assessments, inspections, incident reporting, corrective actions and document control are being added in the next release. Your company structure and team set up here will carry straight into them.')));
}
