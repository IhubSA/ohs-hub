// Emergency preparedness: emergency numbers everyone can see (by site),
// planned and completed emergency drills with results and follow-up
// actions, and quick links to emergency plans and emergency equipment.
import { sb, q } from '../sb.js';
import { h, modalForm, confirmAction, toast, errMsg, emptyState, fmtDate, opt } from '../ui.js';
import {
  loadSites, loadMembers, nameMap, nextRef, memberOptions, siteOptions, today, addDays, statusBadge, kv, setQuery,
  DRILL_TYPE, DRILL_STATUS, DRILL_OUTCOME, EQUIPMENT_CATEGORY, EQUIPMENT_STATUS, expiryBadge, planAllows,
} from '../data.js';
import { actionsPanel } from './actions.js';

export async function render(view, ctx) {
  if (ctx.params[0]) return drillDetail(view, ctx, ctx.params[0]);
  const tab = ctx.query.get('t') || 'contacts';
  view.append(h('div', { class: 'page-title' },
    h('div', {}, h('h1', {}, 'Emergency preparedness'), h('p', {}, 'Who to call, how you practise, and where your emergency plans and equipment are.'))));
  view.append(h('div', { class: 'tabs', role: 'tablist' },
    [['contacts', 'Emergency numbers'], ['drills', 'Drills'], ['plans', 'Plans and equipment']].map(([k, l]) =>
      h('button', { role: 'tab', 'aria-selected': String(k === tab), onclick: () => setQuery('emergency', { t: k === 'contacts' ? '' : k }) }, l))));
  const panel = h('div'); view.append(panel);
  if (tab === 'drills') return drills(panel, ctx);
  if (tab === 'plans') return plans(panel, ctx);
  return contacts(panel, ctx);
}

// ---- Emergency numbers ----
const telHref = (n) => `tel:${String(n).replace(/[^\d+]/g, '')}`;
const NATIONAL = [
  ['Police (SAPS)', '10111'],
  ['Ambulance and fire (national number)', '10177'],
  ['Emergency from any mobile phone', '112'],
];

async function contacts(panel, { state, can, reload }) {
  const org = state.org.id;
  const [rows, sites] = await Promise.all([
    q(sb.from('emergency_contacts').select('*').eq('org_id', org).order('sort_order').order('role')), loadSites(org)]);
  if (can.edit) panel.append(h('div', { class: 'btn-row', style: 'margin-bottom:14px' },
    h('button', { class: 'btn btn-primary', onclick: async () => { if (await contactForm(org, sites)) { toast('Number added.'); reload(); } } }, 'Add a number'),
    !rows.some((r) => r.phone === '10111') ? h('button', { class: 'btn btn-secondary', onclick: async () => {
      if (await confirmAction('Add the national emergency numbers?', 'Adds 10111 (police), 10177 (ambulance and fire) and 112 (from any mobile phone) for all sites. Also add your local fire station, hospital and security company, which respond faster in many areas.', 'Add numbers', false)) {
        try { await q(sb.from('emergency_contacts').insert(NATIONAL.map(([role, phone], i) => ({ org_id: org, role, phone, sort_order: 100 + i })))); toast('National numbers added.'); reload(); }
        catch (e) { toast(errMsg(e), 'err'); }
      } } }, 'Add national numbers') : null));
  if (!rows.length) {
    panel.append(h('div', { class: 'card' }, emptyState('No emergency numbers yet', can.edit ? 'Add the numbers people need in an emergency: first aiders, the fire warden, your local fire station and hospital, and the national numbers.' : 'Your safety team hasn\'t added emergency numbers yet.')));
    return;
  }
  const groups = [[null, 'All sites'], ...sites.map((s) => [s.id, s.name])];
  for (const [sid, name] of groups) {
    const list = rows.filter((r) => (r.site_id || null) === sid);
    if (!list.length) continue;
    panel.append(h('div', { class: 'card' }, h('h2', {}, name), h('ul', { class: 'contact-list' }, list.map((r) => h('li', {},
      h('div', {}, h('strong', {}, r.role), r.name ? h('div', { class: 'muted small' }, r.name) : null, r.notes ? h('div', { class: 'small' }, r.notes) : null),
      h('div', { class: 'contact-actions' },
        h('a', { class: 'btn btn-primary btn-sm call', href: telHref(r.phone) }, r.phone),
        r.alt_phone ? h('a', { class: 'btn btn-secondary btn-sm', href: telHref(r.alt_phone) }, r.alt_phone) : null,
        can.edit ? h('button', { class: 'btn-link', onclick: async () => { if (await contactForm(org, sites, r)) { toast('Saved.'); reload(); } } }, 'Edit') : null,
        can.edit ? h('button', { class: 'btn-link danger', onclick: async () => {
          if (await confirmAction('Remove this number?', `${r.role}: ${r.phone}`, 'Remove')) { await q(sb.from('emergency_contacts').delete().eq('id', r.id)); reload(); }
        } }, 'Remove') : null))))));
  }
}

function contactForm(org, sites, c = {}) {
  return modalForm({
    title: c.id ? 'Edit emergency number' : 'Add an emergency number',
    submitLabel: 'Save',
    fields: [
      { name: 'role', label: 'Who or what', required: true, value: c.role, maxlength: 120, placeholder: 'e.g. Fire warden, Fish Hoek fire station, first aider' },
      { name: 'name', label: 'Name', value: c.name, maxlength: 120 },
      { name: 'phone', label: 'Phone number', type: 'tel', required: true, value: c.phone, maxlength: 40,
        validate: (v) => (!/^[+\d][\d\s()-]{2,}$/.test(v) ? 'Enter a phone number using digits.' : '') },
      { name: 'alt_phone', label: 'Other number', type: 'tel', value: c.alt_phone, maxlength: 40 },
      { name: 'site_id', label: 'Site', type: 'select', value: c.site_id || '', options: siteOptions(sites, 'All sites') },
      { name: 'notes', label: 'Notes', value: c.notes, maxlength: 500, placeholder: 'e.g. Available 24 hours' },
      { name: 'sort_order', label: 'Order', type: 'number', value: c.sort_order ?? 0, hint: 'Lower numbers show first.' },
    ],
    onSubmit: (v) => {
      const row = { role: v.role, name: v.name || null, phone: v.phone, alt_phone: v.alt_phone || null, site_id: v.site_id || null, notes: v.notes || null, sort_order: Number(v.sort_order) || 0 };
      return c.id ? q(sb.from('emergency_contacts').update(row).eq('id', c.id)) : q(sb.from('emergency_contacts').insert({ ...row, org_id: org }));
    },
  });
}

// ---- Drills ----
async function drills(panel, { state, can, query, reload }) {
  const org = state.org.id;
  const f = query.get('f') || 'planned';
  const [rows, sites] = await Promise.all([
    q(sb.from('emergency_drills').select('*').eq('org_id', org).order('scheduled_for', { ascending: f === 'planned' })), loadSites(org)]);
  const sName = new Map(sites.map((s) => [s.id, s.name]));
  panel.append(h('div', { class: 'card-head', style: 'margin-bottom:12px' },
    h('div', { class: 'chips', style: 'margin:0' }, [['planned', 'Planned'], ['completed', 'Completed'], ['all', 'All']].map(([k, l]) =>
      h('button', { class: 'chip', 'aria-pressed': String(f === k), onclick: () => setQuery('emergency', { t: 'drills', f: k }) }, l))),
    can.field ? h('button', { class: 'btn btn-primary', onclick: async () => { const r = await drillForm(org); if (r) location.hash = `#/emergency/${r.id}`; } }, 'Plan a drill') : null));
  // Last completed drill per site helps spot sites that haven't practised
  const last = new Map();
  for (const d of rows) if (d.status === 'completed' && (!last.has(d.site_id) || d.held_on > last.get(d.site_id))) last.set(d.site_id, d.held_on);
  if (sites.length) panel.append(h('div', { class: 'stats' }, sites.map((s) => {
    const when = last.get(s.id);
    const stale = !when || when < addDays(today(), -365);
    return h('div', { class: `stat${stale ? ' alert-stat' : ''}` }, h('div', { class: 'l' }, s.name),
      h('div', { class: 'small', style: 'margin-top:6px' }, when ? `Last drill ${fmtDate(when)}` : 'No drill recorded'), stale ? h('div', { class: 'small overdue' }, 'More than a year ago') : null);
  })));
  const shown = rows.filter((d) => f === 'all' || d.status === f);
  const card = h('div', { class: 'card' }); panel.append(card);
  if (!shown.length) { card.append(emptyState(f === 'planned' ? 'No drills planned' : 'No drills here', 'Plan regular evacuation and emergency drills for each site and record how they went.')); return; }
  card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, ['Reference', 'Drill', 'Site', 'Date', 'Status', 'Outcome'].map((t) => h('th', {}, t)))),
    h('tbody', {}, shown.map((d) => h('tr', {},
      h('td', { 'data-label': 'Reference' }, h('span', { class: 'ref' }, d.reference)),
      h('td', { 'data-label': 'Drill' }, h('a', { class: 'row-link', href: `#/emergency/${d.id}` }, DRILL_TYPE[d.drill_type])),
      h('td', { 'data-label': 'Site' }, sName.get(d.site_id) || 'All sites'),
      h('td', { 'data-label': 'Date' }, h('span', { class: d.status === 'planned' && d.scheduled_for < today() ? 'overdue' : '' }, fmtDate(d.held_on || d.scheduled_for))),
      h('td', { 'data-label': 'Status' }, statusBadge(d.status, DRILL_STATUS)),
      h('td', { 'data-label': 'Outcome' }, d.outcome ? statusBadge(d.outcome, DRILL_OUTCOME) : '—')))))));
}

async function drillForm(org, d = {}) {
  const [sites, members] = await Promise.all([loadSites(org), loadMembers(org)]);
  return modalForm({
    title: d.id ? 'Edit drill' : 'Plan a drill',
    submitLabel: d.id ? 'Save' : 'Plan drill',
    fields: [
      { name: 'drill_type', label: 'Type of drill', type: 'select', value: d.drill_type || 'evacuation', options: opt(DRILL_TYPE) },
      { name: 'site_id', label: 'Site', type: 'select', value: d.site_id || '', options: siteOptions(sites, 'All sites') },
      { name: 'scheduled_for', label: 'Date', type: 'date', required: true, value: d.scheduled_for || addDays(today(), 14) },
      { name: 'coordinator_id', label: 'Coordinator', type: 'select', value: d.coordinator_id || '', options: memberOptions(members, 'Not assigned') },
      { name: 'scenario', label: 'Scenario', type: 'textarea', rows: 3, maxlength: 2000, value: d.scenario, placeholder: 'e.g. Fire in the paint store during the morning shift. Main exit blocked.' },
      { name: 'target_minutes', label: 'Target evacuation time (minutes)', type: 'number', value: d.target_minutes ?? '' },
      { name: 'announced', label: 'Announced in advance', type: 'checkbox', value: d.announced ?? true },
    ],
    onSubmit: async (v) => {
      const row = { drill_type: v.drill_type, site_id: v.site_id || null, scheduled_for: v.scheduled_for, coordinator_id: v.coordinator_id || null,
        scenario: v.scenario || null, target_minutes: v.target_minutes ? Number(v.target_minutes) : null, announced: v.announced };
      if (d.id) return q(sb.from('emergency_drills').update(row).eq('id', d.id).select('id').single());
      return q(sb.from('emergency_drills').insert({ ...row, org_id: org, reference: await nextRef(org, 'DRL') }).select('id').single());
    },
  });
}

async function drillDetail(view, { state, can, reload }, id) {
  const org = state.org.id;
  const d = await q(sb.from('emergency_drills').select('*').eq('id', id).maybeSingle());
  if (!d) { view.append(h('div', { class: 'card' }, emptyState('Drill not found', 'It may have been removed, or you may not have access to it.'))); return; }
  const [sites, names] = await Promise.all([loadSites(org), nameMap(org)]);
  view.append(h('a', { class: 'back', href: '#/emergency?t=drills' }, 'Back to drills'),
    h('div', { class: 'page-title' }, h('div', {}, h('h1', {}, `${DRILL_TYPE[d.drill_type]} drill`),
      h('p', {}, d.reference, ' ', statusBadge(d.status, DRILL_STATUS), d.outcome ? [' ', statusBadge(d.outcome, DRILL_OUTCOME)] : null))));
  const bar = h('div', { class: 'btn-row', style: 'margin-bottom:18px' });
  if (can.field && d.status === 'planned') {
    bar.append(h('button', { class: 'btn btn-primary', onclick: () => results(d, reload) }, 'Record results'),
      h('button', { class: 'btn btn-secondary', onclick: async () => { if (await drillForm(org, d)) { toast('Drill saved.'); reload(); } } }, 'Edit'),
      h('button', { class: 'btn-link', onclick: async () => {
        if (await confirmAction('Cancel this drill?', 'It stays on record as cancelled.', 'Cancel drill')) { await q(sb.from('emergency_drills').update({ status: 'cancelled' }).eq('id', d.id)); reload(); }
      } }, 'Cancel drill'));
  }
  if (can.field && d.status === 'completed') bar.append(h('button', { class: 'btn btn-secondary', onclick: () => results(d, reload) }, 'Edit results'));
  if (bar.children.length) view.append(bar);
  const main = h('div', {}); const side = h('div', {});
  view.append(h('div', { class: 'detail-grid' }, main, side));
  main.append(h('div', { class: 'card' }, h('h2', {}, d.status === 'completed' ? 'Results' : 'Plan'),
    d.scenario ? h('p', { class: 'prose-block' }, d.scenario) : null,
    d.status === 'completed' ? kv([
      ['Held on', fmtDate(d.held_on)], ['People taking part', d.participants != null ? String(d.participants) : null],
      ['Evacuation time', d.evacuation_minutes != null ? `${d.evacuation_minutes} minutes` : null],
      ['Target time', d.target_minutes != null ? `${d.target_minutes} minutes` : null],
      ['Everyone accounted for', d.everyone_accounted == null ? null : d.everyone_accounted ? 'Yes' : h('span', { class: 'overdue' }, 'No')],
      ['Outcome', statusBadge(d.outcome, DRILL_OUTCOME)]]) : h('p', { class: 'muted' }, 'Record the results after the drill.'),
    d.observations ? [h('h3', { class: 'section-label' }, 'What went well and what to improve'), h('p', { class: 'prose-block' }, d.observations)] : null));
  if (d.status !== 'planned' || can.field) main.append(await actionsPanel({ org, source_type: 'emergency_drill', source_id: d.id, site_id: d.site_id, canRaise: can.field, defaultTitle: `Drill ${d.reference}: `, onChange: reload }));
  side.append(h('div', { class: 'card' }, h('h2', {}, 'Details'), kv([
    ['Site', sites.find((s) => s.id === d.site_id)?.name || 'All sites'], ['Planned for', fmtDate(d.scheduled_for)],
    ['Coordinator', names.get(d.coordinator_id)], ['Announced in advance', d.announced ? 'Yes' : 'No (unannounced)']])));
}

async function results(d, reload) {
  const r = await modalForm({
    title: 'Record drill results',
    submitLabel: 'Save results',
    fields: [
      { name: 'held_on', label: 'Held on', type: 'date', required: true, value: d.held_on || (d.scheduled_for <= today() ? d.scheduled_for : today()),
        validate: (v) => (v > today() ? 'Can\'t be in the future.' : '') },
      { name: 'participants', label: 'People taking part', type: 'number', value: d.participants ?? '' },
      { name: 'evacuation_minutes', label: 'Time to evacuate (minutes)', type: 'number', value: d.evacuation_minutes ?? '', hint: d.target_minutes ? `Target: ${d.target_minutes} minutes.` : null },
      { name: 'everyone_accounted', label: 'Everyone was accounted for at the assembly point', type: 'checkbox', value: d.everyone_accounted ?? true },
      { name: 'outcome', label: 'Overall outcome', type: 'select', required: true, value: d.outcome || '', options: [['', 'Choose'], ...opt(DRILL_OUTCOME)] },
      { name: 'observations', label: 'What went well and what to improve', type: 'textarea', rows: 5, maxlength: 5000, value: d.observations },
    ],
    onSubmit: (v) => q(sb.from('emergency_drills').update({ status: 'completed', held_on: v.held_on, participants: v.participants === '' ? null : Number(v.participants),
      evacuation_minutes: v.evacuation_minutes === '' ? null : Number(v.evacuation_minutes), everyone_accounted: v.everyone_accounted,
      outcome: v.outcome, observations: v.observations || null }).eq('id', d.id)),
  });
  if (r) { toast(r.outcome === 'satisfactory' ? 'Results saved.' : 'Results saved. Raise actions for the improvements needed.'); reload(); }
}

// ---- Plans and emergency equipment ----
async function plans(panel, { state }) {
  const org = state.org.id;
  const [docs, equip, sites] = await Promise.all([
    q(sb.from('documents').select('id, reference, title, status, site_id').eq('org_id', org).eq('doc_type', 'emergency_plan').neq('status', 'archived').order('title')),
    planAllows(state, 'equipment') ? q(sb.from('equipment').select('*').eq('org_id', org).in('category', ['fire_equipment', 'first_aid', 'emergency']).neq('status', 'retired').order('name')) : null,
    loadSites(org),
  ]);
  const sName = new Map(sites.map((s) => [s.id, s.name]));
  panel.append(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Emergency plans'),
    h('a', { class: 'btn btn-secondary btn-sm', href: '#/documents' }, 'Go to documents')),
    docs.length ? h('ul', { class: 'file-list' }, docs.map((x) => h('li', {}, h('a', { class: 'row-link', href: `#/documents/${x.id}` }, `${x.reference} ${x.title}`),
      h('span', { class: 'muted small' }, sName.get(x.site_id) || 'All sites'))))
      : h('p', { class: 'muted' }, 'No emergency plans yet. Create one under Documents with the type "Emergency plan". AI drafting can help with the first draft.')));
  const ec = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Emergency equipment'),
    equip ? h('a', { class: 'btn btn-secondary btn-sm', href: '#/equipment?cat=fire_equipment' }, 'Equipment register') : null));
  if (!equip) ec.append(h('p', { class: 'muted' }, 'The equipment register is included in the Business and Enterprise plans.'));
  else if (!equip.length) ec.append(h('p', { class: 'muted' }, 'Add fire extinguishers, hose reels, first aid kits and alarms to the equipment register with the category "Fire equipment", "First aid" or "Emergency equipment".'));
  else ec.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, ['Equipment', 'Where', 'Status', 'Next inspection'].map((t) => h('th', {}, t)))),
    h('tbody', {}, equip.map((e) => h('tr', {},
      h('td', { 'data-label': 'Equipment' }, h('a', { class: 'row-link', href: `#/equipment/${e.id}` }, e.name), h('div', { class: 'muted small' }, EQUIPMENT_CATEGORY[e.category])),
      h('td', { 'data-label': 'Where' }, [sName.get(e.site_id), e.location].filter(Boolean).join(', ') || '—'),
      h('td', { 'data-label': 'Status' }, statusBadge(e.status, EQUIPMENT_STATUS)),
      h('td', { 'data-label': 'Next inspection' }, e.next_inspection_due ? expiryBadge(e.next_inspection_due, 14) : '—')))))));
  panel.append(ec);
}
