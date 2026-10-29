// Sites and departments.
import { sb, q } from '../sb.js';
import { h, modalForm, confirmAction, toast, errMsg, emptyState, badge, PROVINCES } from '../ui.js';

export async function render(view, { state, can, reload }) {
  const org = state.org.id;
  const [sites, depts] = await Promise.all([
    q(sb.from('sites').select('*').eq('org_id', org).order('is_active', { ascending: false }).order('name')),
    q(sb.from('departments').select('*').eq('org_id', org).order('name')),
  ]);
  const admin = can.admin;

  const siteForm = (s = {}) => modalForm({
    title: s.id ? 'Edit site' : 'Add a site',
    submitLabel: s.id ? 'Save site' : 'Add site',
    fields: [
      { name: 'name', label: 'Site name', required: true, value: s.name, maxlength: 160 },
      { name: 'code', label: 'Site code', value: s.code, maxlength: 20, hint: 'A short code used in reference numbers, e.g. JHB01.' },
      { name: 'province', label: 'Province', type: 'select', value: s.province ?? '', options: [['', 'Select'], ...PROVINCES.map((p) => [p, p])] },
      { name: 'address', label: 'Address', type: 'textarea', value: s.address, maxlength: 400, rows: 2 },
    ],
    onSubmit: async (v) => {
      const row = { name: v.name, code: v.code || null, province: v.province || null, address: v.address || null };
      if (s.id) await q(sb.from('sites').update(row).eq('id', s.id));
      else await q(sb.from('sites').insert({ ...row, org_id: org }));
    },
  }).then((r) => { if (r) { toast(s.id ? 'Site saved.' : 'Site added.'); reload(); } });

  const deptForm = (site, d = {}) => modalForm({
    title: d.id ? 'Rename department' : `Add a department to ${site ? site.name : 'the organisation'}`,
    submitLabel: d.id ? 'Save' : 'Add department',
    fields: [{ name: 'name', label: 'Department name', required: true, value: d.name, maxlength: 160 }],
    onSubmit: async (v) => {
      if (d.id) await q(sb.from('departments').update({ name: v.name }).eq('id', d.id));
      else await q(sb.from('departments').insert({ org_id: org, site_id: site?.id ?? null, name: v.name }));
    },
  }).then((r) => { if (r) { toast('Department saved.'); reload(); } });

  const toggleSite = async (s) => {
    const ok = await confirmAction(s.is_active ? `Deactivate ${s.name}?` : `Reactivate ${s.name}?`,
      s.is_active ? 'The site and its records are kept, but it will no longer be offered for new records.' : 'The site will be available for new records again.',
      s.is_active ? 'Deactivate site' : 'Reactivate site', s.is_active);
    if (!ok) return;
    try { await q(sb.from('sites').update({ is_active: !s.is_active }).eq('id', s.id)); toast('Site updated.'); reload(); }
    catch (e) { toast(errMsg(e), 'err'); }
  };

  const deleteDept = async (d) => {
    if (!await confirmAction(`Delete ${d.name}?`, 'Records linked to this department keep their history but lose the department link.', 'Delete department')) return;
    try { await q(sb.from('departments').delete().eq('id', d.id)); toast('Department deleted.'); reload(); }
    catch (e) { toast(errMsg(e), 'err'); }
  };

  view.append(h('div', { class: 'page-title' },
    h('div', {}, h('h1', {}, 'Sites & departments'), h('p', {}, admin ? 'The workplaces and departments your records are organised by.' : 'Only an organisation administrator can change sites and departments.')),
    admin ? h('button', { class: 'btn btn-primary', onclick: () => siteForm() }, 'Add a site') : null));

  if (!sites.length) {
    view.append(h('div', { class: 'card' }, emptyState('No sites yet',
      'Add the offices, plants, depots or project sites where your people work.',
      admin ? h('button', { class: 'btn btn-primary', onclick: () => siteForm() }, 'Add your first site') : null)));
  }

  const deptItems = (list, site) => h('ul', { class: 'dept-list' },
    list.length ? list.map((d) => h('li', {}, h('span', {}, d.name),
      admin ? h('span', {}, h('button', { class: 'btn-link', onclick: () => deptForm(site, d) }, 'Rename'),
        h('button', { class: 'btn-link danger', onclick: () => deleteDept(d) }, 'Delete')) : null))
      : h('li', { class: 'muted' }, 'No departments yet.'));

  for (const s of sites) {
    const own = depts.filter((d) => d.site_id === s.id);
    view.append(h('section', { class: 'site-block', 'aria-label': s.name },
      h('header', {},
        h('div', {}, h('h3', {}, s.name, ' ', s.is_active ? null : badge('Inactive', 'warn')),
          h('div', { class: 'meta' }, [s.code, s.province, s.address].filter(Boolean).join(', ') || 'No address recorded')),
        admin ? h('div', {},
          h('button', { class: 'btn btn-secondary btn-sm', onclick: () => deptForm(s) }, 'Add department'), ' ',
          h('button', { class: 'btn-link', onclick: () => siteForm(s) }, 'Edit'),
          h('button', { class: 'btn-link', onclick: () => toggleSite(s) }, s.is_active ? 'Deactivate' : 'Reactivate')) : null),
      deptItems(own, s)));
  }

  const orgWide = depts.filter((d) => !d.site_id);
  if (orgWide.length || (admin && sites.length)) {
    view.append(h('section', { class: 'site-block', 'aria-label': 'Organisation-wide departments' },
      h('header', {}, h('div', {}, h('h3', {}, 'Organisation-wide departments'),
        h('div', { class: 'meta' }, 'Departments that are not tied to one site, such as Finance or HR.')),
        admin ? h('button', { class: 'btn btn-secondary btn-sm', onclick: () => deptForm(null) }, 'Add department') : null),
      deptItems(orgWide, null)));
  }
}
