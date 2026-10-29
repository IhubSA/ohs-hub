// Inspections: checklist library and builder, schedules, and capturing
// inspections on a phone. Responses are saved as each answer is given;
// if the connection drops they are queued on the device and sent when it
// returns (the database rejects stale changes from another device).
import { sb, q } from '../sb.js';
import { h, modalForm, confirmAction, toast, errMsg, emptyState, fmtDate, fmtDateTime, opt } from '../ui.js';
import {
  loadMembers, loadSites, nameMap, nextRef, memberOptions, siteOptions, today, addDays,
  INSPECTION_STATUS, RECORD_STATUS, statusBadge, kv, uploadFile, openFile, fileButton, setQuery,
} from '../data.js';
import { STARTERS, CATEGORIES } from '../starters.js';
import { createAction, actionsPanel } from './actions.js';
import { aiQuota, aiAvailability, callAI, withBusy, reviewPanel, suggestionDialog, aiError } from '../ai.js';

const FREQ = { once: 'Once', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', annually: 'Annually' };
const RESP = { compliant: 'Compliant', non_compliant: 'Non-compliant', not_applicable: 'Not applicable', not_inspected: 'Not inspected' };
const RISK = { low: 'Low', medium: 'Medium', high: 'High', extreme: 'Extreme' };

export async function render(view, ctx) {
  const [a, b] = ctx.params;
  if (a === 'checklist' && b) return renderBuilder(view, ctx, b);
  if (a) return renderInspection(view, ctx, a);
  return renderHub(view, ctx);
}

// ---------------------------------------------------------------------
// Hub with tabs
// ---------------------------------------------------------------------
async function renderHub(view, ctx) {
  const tab = ctx.query.get('t') || 'inspections';
  view.append(h('div', { class: 'page-title' }, h('div', {}, h('h1', {}, 'Inspections'),
    h('p', {}, 'Plan, carry out and follow up workplace inspections.'))));
  const tabs = [['inspections', 'Inspections'], ['schedules', 'Schedules'], ['checklists', 'Checklists']];
  view.append(h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([k, l]) =>
    h('button', { role: 'tab', 'aria-selected': String(tab === k), onclick: () => setQuery('inspections', { t: k }) }, l))));
  if (tab === 'checklists') return renderChecklists(view, ctx);
  if (tab === 'schedules') return renderSchedules(view, ctx);
  return renderInspections(view, ctx);
}

async function startInspection(org, user, { template_id = '', site_id = '', schedule = null } = {}) {
  const [tpls, sites] = await Promise.all([
    q(sb.from('inspection_templates').select('id, title').eq('org_id', org).eq('status', 'approved').order('title')), loadSites(org)]);
  if (!tpls.length) { toast('Approve a checklist first. Open the Checklists tab to create one.', 'err'); return null; }
  return modalForm({
    title: 'Start an inspection', submitLabel: 'Start inspection',
    fields: [
      { name: 'template_id', label: 'Checklist', type: 'select', required: true, value: template_id, options: [['', 'Choose a checklist'], ...tpls.map((t) => [t.id, t.title])] },
      { name: 'site_id', label: 'Site', type: 'select', value: site_id, options: siteOptions(sites) },
    ],
    onSubmit: async (v) => {
      const reference = await nextRef(org, 'INS');
      const row = await q(sb.from('inspections').insert({
        org_id: org, reference, template_id: v.template_id, site_id: v.site_id || null, inspector_id: user,
        schedule_id: schedule?.id || null, due_on: schedule?.next_due_on || today(), status: 'in_progress', started_at: new Date().toISOString(),
      }).select('id').single());
      if (schedule) await advanceSchedule(schedule);
      return row;
    },
  });
}

function nextDue(s) {
  const d = new Date(s.next_due_on + 'T12:00:00'); const n = s.interval_count || 1;
  if (s.frequency === 'daily') d.setDate(d.getDate() + n);
  else if (s.frequency === 'weekly') d.setDate(d.getDate() + 7 * n);
  else if (s.frequency === 'monthly') d.setMonth(d.getMonth() + n);
  else if (s.frequency === 'quarterly') d.setMonth(d.getMonth() + 3 * n);
  else if (s.frequency === 'annually') d.setFullYear(d.getFullYear() + n);
  return d.toISOString().slice(0, 10);
}
async function advanceSchedule(s) {
  if (s.frequency === 'once') await q(sb.from('inspection_schedules').update({ is_active: false }).eq('id', s.id));
  else await q(sb.from('inspection_schedules').update({ next_due_on: nextDue(s) }).eq('id', s.id));
}

async function renderInspections(view, { state, can, query }) {
  const org = state.org.id;
  const f = query.get('f') || 'open';
  let qy = sb.from('inspections').select('id, reference, status, due_on, completed_at, site_id, inspector_id, compliant_count, non_compliant_count, inspection_templates(title)')
    .eq('org_id', org).order('created_at', { ascending: false }).limit(300);
  if (f === 'open') qy = qy.in('status', ['scheduled', 'in_progress']);
  if (f === 'completed') qy = qy.in('status', ['completed', 'closed']);
  if (f === 'mine') qy = qy.eq('inspector_id', state.user.id);
  const [rows, sites, names] = await Promise.all([q(qy), loadSites(org), nameMap(org)]);

  const bar = h('div', { class: 'card-head' },
    h('div', { class: 'chips', style: 'margin:0' }, [['open', 'Open'], ['mine', 'Mine'], ['completed', 'Completed'], ['all', 'All']].map(([k, l]) =>
      h('button', { class: 'chip', 'aria-pressed': String(f === k), onclick: () => setQuery('inspections', { t: 'inspections', f: k }) }, l))),
    can.field ? h('button', { class: 'btn btn-primary', onclick: async () => {
      const r = await startInspection(org, state.user.id); if (r) location.hash = `#/inspections/${r.id}`;
    } }, 'Start inspection') : null);
  const card = h('div', { class: 'card' }, bar);
  view.append(card);
  if (!rows.length) { card.append(emptyState('No inspections here', 'Start an inspection from an approved checklist, or set up a schedule.')); return; }
  card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, ['Reference', 'Checklist', 'Site', 'Inspector', 'Due', 'Result', 'Status'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((r) => {
      const late = ['scheduled', 'in_progress'].includes(r.status) && r.due_on && r.due_on < today();
      const answered = r.compliant_count + r.non_compliant_count;
      return h('tr', {},
        h('td', { 'data-label': 'Reference' }, h('span', { class: 'ref' }, r.reference)),
        h('td', { 'data-label': 'Checklist' }, h('a', { class: 'row-link', href: `#/inspections/${r.id}` }, r.inspection_templates?.title || 'Inspection')),
        h('td', { 'data-label': 'Site' }, sites.find((s) => s.id === r.site_id)?.name || '—'),
        h('td', { 'data-label': 'Inspector' }, names.get(r.inspector_id) || '—'),
        h('td', { 'data-label': 'Due' }, h('span', { class: late ? 'overdue' : '' }, fmtDate(r.due_on))),
        h('td', { 'data-label': 'Result' }, answered ? `${Math.round((r.compliant_count / answered) * 100)}% compliant, ${r.non_compliant_count} finding${r.non_compliant_count === 1 ? '' : 's'}` : '—'),
        h('td', { 'data-label': 'Status' }, statusBadge(r.status, INSPECTION_STATUS)));
    })))));
}

async function renderSchedules(view, { state, can, reload }) {
  const org = state.org.id;
  const [rows, tpls, sites, members, names] = await Promise.all([
    q(sb.from('inspection_schedules').select('*, inspection_templates(title)').eq('org_id', org).eq('is_active', true).order('next_due_on')),
    q(sb.from('inspection_templates').select('id, title').eq('org_id', org).eq('status', 'approved').order('title')),
    loadSites(org), loadMembers(org), nameMap(org)]);
  const form = (s = {}) => modalForm({
    title: s.id ? 'Edit schedule' : 'Schedule recurring inspections', submitLabel: 'Save schedule',
    fields: [
      { name: 'template_id', label: 'Checklist', type: 'select', required: true, value: s.template_id ?? '', options: [['', 'Choose an approved checklist'], ...tpls.map((t) => [t.id, t.title])] },
      { name: 'site_id', label: 'Site', type: 'select', value: s.site_id ?? '', options: siteOptions(sites) },
      { name: 'inspector_id', label: 'Inspector', type: 'select', required: true, value: s.inspector_id ?? '',
        options: memberOptions(members, 'Choose an inspector', (m) => ['org_admin', 'ohs_manager', 'safety_officer', 'supervisor'].includes(m.role)) },
      { name: 'frequency', label: 'Frequency', type: 'select', value: s.frequency || 'monthly', options: opt(FREQ) },
      { name: 'next_due_on', label: 'Next due', type: 'date', required: true, value: s.next_due_on || today() },
    ],
    onSubmit: async (v) => {
      const row = { template_id: v.template_id, site_id: v.site_id || null, inspector_id: v.inspector_id, frequency: v.frequency, next_due_on: v.next_due_on };
      if (s.id) return q(sb.from('inspection_schedules').update(row).eq('id', s.id));
      return q(sb.from('inspection_schedules').insert({ ...row, org_id: org }));
    },
  }).then((r) => { if (r) { toast('Schedule saved. The inspector is reminded before each due date.'); reload(); } });

  const card = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Active schedules'),
    can.edit ? h('button', { class: 'btn btn-primary', disabled: !tpls.length, onclick: () => form() }, 'New schedule') : null));
  view.append(card);
  if (!tpls.length) card.append(h('p', { class: 'notice' }, 'Approve a checklist before scheduling inspections.'));
  if (!rows.length) { card.append(emptyState('No schedules yet', 'Schedules remind the inspector before each inspection is due.')); return; }
  card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, ['Checklist', 'Site', 'Inspector', 'Frequency', 'Next due', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((s) => {
      const late = s.next_due_on < today();
      return h('tr', {},
        h('td', { 'data-label': 'Checklist' }, s.inspection_templates?.title),
        h('td', { 'data-label': 'Site' }, sites.find((x) => x.id === s.site_id)?.name || '—'),
        h('td', { 'data-label': 'Inspector' }, names.get(s.inspector_id) || '—'),
        h('td', { 'data-label': 'Frequency' }, FREQ[s.frequency]),
        h('td', { 'data-label': 'Next due' }, h('span', { class: late ? 'overdue' : '' }, fmtDate(s.next_due_on), late ? ' (overdue)' : '')),
        h('td', { class: 'actions' },
          (can.edit || s.inspector_id === state.user.id) ? h('button', { class: 'btn btn-secondary btn-sm', onclick: async () => {
            const r = await startInspection(org, state.user.id, { template_id: s.template_id, site_id: s.site_id ?? '', schedule: s });
            if (r) location.hash = `#/inspections/${r.id}`;
          } }, 'Start now') : null,
          can.edit ? h('button', { class: 'btn-link', onclick: () => form(s) }, 'Edit') : null,
          can.edit ? h('button', { class: 'btn-link danger', onclick: async () => {
            if (await confirmAction('Stop this schedule?', 'Past inspections are kept.', 'Stop schedule')) {
              try { await q(sb.from('inspection_schedules').update({ is_active: false }).eq('id', s.id)); toast('Schedule stopped.'); reload(); } catch (e) { toast(errMsg(e), 'err'); }
            } } }, 'Stop') : null));
    })))));
}

async function renderChecklists(view, { state, can }) {
  const org = state.org.id;
  const rows = await q(sb.from('inspection_templates').select('id, title, category, status, version, inspection_template_items(count)')
    .eq('org_id', org).order('title'));
  const create = async () => {
    const r = await modalForm({
      title: 'New checklist', submitLabel: 'Create checklist',
      intro: 'Start from a starter checklist and adapt it, or start blank. A competent person must review and approve every checklist before it is used.',
      fields: [
        { name: 'starter', label: 'Start from', type: 'select', value: '', options: [['', 'A blank checklist'], ...STARTERS.map((s) => [s.key, s.title])] },
        { name: 'title', label: 'Checklist title', maxlength: 200, hint: 'Leave blank to use the starter\'s title.',
          validate: (v, vals) => (!v && !vals.starter ? 'Give the checklist a title.' : '') },
        { name: 'category', label: 'Category', type: 'select', value: 'general', options: opt(CATEGORIES) },
      ],
      onSubmit: async (v) => {
        const st = STARTERS.find((s) => s.key === v.starter);
        const tpl = await q(sb.from('inspection_templates').insert({ org_id: org, title: v.title || st.title, category: st ? st.category : v.category }).select('id').single());
        if (st) {
          let n = 0;
          const items = Object.entries(st.sections).flatMap(([section, qs]) => qs.map((question) => ({ template_id: tpl.id, org_id: org, section, question, sort_order: ++n })));
          await q(sb.from('inspection_template_items').insert(items));
        }
        return tpl;
      },
    });
    if (r) location.hash = `#/inspections/checklist/${r.id}`;
  };
  const card = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Checklist library'),
    can.edit ? h('button', { class: 'btn btn-primary', onclick: create }, 'New checklist') : null));
  view.append(card);
  if (!rows.length) { card.append(emptyState('No checklists yet', 'Create one from a starter checklist and adapt it to your workplace.', can.edit ? h('button', { class: 'btn btn-primary', onclick: create }, 'Create a checklist') : null)); return; }
  card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, ['Checklist', 'Category', 'Questions', 'Version', 'Status'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((t) => h('tr', {},
      h('td', { 'data-label': 'Checklist' }, h('a', { class: 'row-link', href: `#/inspections/checklist/${t.id}` }, t.title)),
      h('td', { 'data-label': 'Category' }, CATEGORIES[t.category] || t.category),
      h('td', { 'data-label': 'Questions' }, String(t.inspection_template_items?.[0]?.count ?? 0)),
      h('td', { 'data-label': 'Version' }, String(t.version)),
      h('td', { 'data-label': 'Status' }, statusBadge(t.status, RECORD_STATUS))))))));
}

// ---------------------------------------------------------------------
// Checklist builder
// ---------------------------------------------------------------------
async function renderBuilder(view, { state, can, reload }, id) {
  const org = state.org.id;
  const t = await q(sb.from('inspection_templates').select('*').eq('id', id).maybeSingle());
  if (!t) { view.append(h('div', { class: 'card' }, emptyState('Checklist not found', 'It may have been deleted.'))); return; }
  const items = await q(sb.from('inspection_template_items').select('*').eq('template_id', id).order('sort_order'));
  const names = await nameMap(org);
  const editable = can.edit && t.status !== 'approved';
  const act = async (fn, msg) => { try { await fn(); toast(msg); reload(); } catch (e) { toast(errMsg(e), 'err'); } };

  const itemForm = (it = {}) => modalForm({
    title: it.id ? 'Edit question' : 'Add a question', submitLabel: 'Save question',
    fields: [
      { name: 'section', label: 'Section', value: it.section || items[items.length - 1]?.section || 'General', maxlength: 100 },
      { name: 'question', label: 'Question or check', required: true, value: it.question, maxlength: 400, hint: 'Phrase it so that "compliant" means safe, e.g. "Emergency exits are unobstructed".' },
      { name: 'guidance', label: 'Guidance for the inspector', type: 'textarea', rows: 2, value: it.guidance, maxlength: 800 },
      { name: 'photo_required_on_fail', label: 'Ask for a photo when non-compliant', type: 'checkbox', value: it.photo_required_on_fail },
    ],
    onSubmit: async (v) => {
      const row = { section: v.section || 'General', question: v.question, guidance: v.guidance || null, photo_required_on_fail: v.photo_required_on_fail };
      if (it.id) return q(sb.from('inspection_template_items').update(row).eq('id', it.id));
      return q(sb.from('inspection_template_items').insert({ ...row, template_id: id, org_id: org, sort_order: (items[items.length - 1]?.sort_order || 0) + 1 }));
    },
  }).then((r) => { if (r) { toast('Question saved.'); reload(); } });

  const move = (i, d) => act(async () => {
    const a = items[i], b = items[i + d];
    await q(sb.from('inspection_template_items').update({ sort_order: b.sort_order }).eq('id', a.id));
    await q(sb.from('inspection_template_items').update({ sort_order: a.sort_order }).eq('id', b.id));
  }, 'Order updated.');

  view.append(h('a', { class: 'back', href: '#/inspections?t=checklists' }, 'Back to checklists'));
  view.append(h('div', { class: 'page-title' }, h('div', {}, h('h1', {}, t.title),
    h('p', {}, `${CATEGORIES[t.category] || t.category}, version ${t.version} `, statusBadge(t.status, RECORD_STATUS)))));
  const buttons = [];
  if (editable) {
    buttons.push(h('button', { class: 'btn btn-primary', onclick: () => itemForm() }, 'Add question'));
    const avail = aiAvailability(await aiQuota(org));
    if (avail.ok) buttons.push(h('button', { class: 'btn btn-secondary', onclick: () => suggestQuestions(org, t, items, reload) }, 'Suggest questions with AI'));
    buttons.push(h('button', { class: 'btn btn-secondary', onclick: () => modalForm({ title: 'Checklist details', submitLabel: 'Save',
      fields: [{ name: 'title', label: 'Title', required: true, value: t.title, maxlength: 200 },
        { name: 'category', label: 'Category', type: 'select', value: t.category, options: opt(CATEGORIES) },
        { name: 'description', label: 'Description', type: 'textarea', rows: 2, value: t.description, maxlength: 1000 }],
      onSubmit: (v) => q(sb.from('inspection_templates').update({ title: v.title, category: v.category, description: v.description || null }).eq('id', id)) })
      .then((r) => r && reload()) }, 'Edit details'));
  }
  if (can.manage && t.status !== 'approved') buttons.push(h('button', { class: 'btn btn-secondary', disabled: !items.length, onclick: async () => {
    if (await confirmAction('Approve this checklist?', 'Approving confirms the questions are suitable for this workplace. It can then be used for inspections and its questions are locked.', 'Approve checklist', false))
      act(() => q(sb.from('inspection_templates').update({ status: 'approved' }).eq('id', id)), 'Checklist approved.');
  } }, 'Approve'));
  if (can.edit && t.status === 'approved') buttons.push(h('button', { class: 'btn btn-secondary', onclick: async () => {
    if (await confirmAction('Start a revision?', 'The checklist returns to draft as a new version and must be approved again before further use. Completed inspections keep the questions they used.', 'Start revision', false))
      act(() => q(sb.from('inspection_templates').update({ status: 'draft' }).eq('id', id)), 'Revision started.');
  } }, 'Start revision'));
  if (buttons.length) view.append(h('div', { class: 'btn-row', style: 'margin-bottom:16px' }, buttons));
  if (t.status !== 'approved' && can.edit && !can.manage) view.append(h('p', { class: 'notice' }, 'An OHS manager or administrator must approve this checklist before it can be used.'));
  if (t.approved_at) view.append(h('p', { class: 'muted small' }, `Approved by ${names.get(t.approved_by) || '—'} on ${fmtDate(t.approved_at)}.`));

  const card = h('div', { class: 'card' }, h('h2', {}, 'Questions'));
  view.append(card);
  if (!items.length) { card.append(emptyState('No questions yet', 'Add the checks the inspector should make.')); return; }
  let section = null;
  const list = h('ul', { class: 'tpl-items' });
  items.forEach((it, i) => {
    if (it.section !== section) { section = it.section; list.append(h('li', { style: 'border:0;padding-top:14px' }, h('strong', {}, section))); }
    list.append(h('li', {},
      h('div', {}, it.question, it.guidance ? h('div', { class: 'muted small' }, it.guidance) : null, it.photo_required_on_fail ? h('div', { class: 'sec' }, 'Photo required if non-compliant') : null),
      editable ? h('div', { class: 'actions' },
        h('button', { class: 'btn-link', disabled: i === 0, 'aria-label': 'Move up', onclick: () => move(i, -1) }, '↑'),
        h('button', { class: 'btn-link', disabled: i === items.length - 1, 'aria-label': 'Move down', onclick: () => move(i, 1) }, '↓'),
        h('button', { class: 'btn-link', onclick: () => itemForm(it) }, 'Edit'),
        h('button', { class: 'btn-link danger', onclick: () => act(() => q(sb.from('inspection_template_items').delete().eq('id', it.id)), 'Question removed.') }, 'Remove')) : null));
  });
  card.append(list);
}

// ---------------------------------------------------------------------
// Conducting an inspection (mobile-first) and the completed report
// ---------------------------------------------------------------------
const QKEY = 'ohs_inspection_queue';
const readQueue = () => { try { return JSON.parse(localStorage.getItem(QKEY) || '[]'); } catch { return []; } };
const writeQueue = (v) => { try { localStorage.setItem(QKEY, JSON.stringify(v)); } catch { /* storage unavailable */ } };

async function pushResponse(row) {
  const { error } = await sb.from('inspection_responses').upsert(row, { onConflict: 'inspection_id,template_item_id' });
  if (error) throw error;
}
async function flushQueue() {
  const queue = readQueue(); if (!queue.length) return { sent: 0, left: 0, conflicts: 0 };
  const left = []; let sent = 0, conflicts = 0;
  for (const row of queue) {
    try { await pushResponse(row); sent++; }
    catch (e) {
      if (/CONFLICT|40001/.test(e.message || e.code)) conflicts++;          // newer answer exists: discard ours
      else if (/fetch|network/i.test(e.message || '')) left.push(row);       // still offline
      else conflicts++;
    }
  }
  writeQueue(left);
  return { sent, left: left.length, conflicts };
}

async function renderInspection(view, { state, can, reload }, id) {
  const org = state.org.id;
  await flushQueue().catch(() => {});
  const ins = await q(sb.from('inspections').select('*, inspection_templates(title, category)').eq('id', id).maybeSingle());
  if (!ins) { view.append(h('div', { class: 'card' }, emptyState('Inspection not found', 'It may have been deleted, or you may not have access to it.'))); return; }
  const [items, responses, sites, names] = await Promise.all([
    q(sb.from('inspection_template_items').select('*').eq('template_id', ins.template_id).order('sort_order')),
    q(sb.from('inspection_responses').select('*').eq('inspection_id', id)),
    loadSites(org), nameMap(org)]);
  const byItem = new Map(responses.map((r) => [r.template_item_id, r]));
  const mine = ins.inspector_id === state.user.id;
  const capturing = ['scheduled', 'in_progress'].includes(ins.status) && (mine || can.edit);

  view.append(h('a', { class: 'back no-print', href: '#/inspections' }, 'Back to inspections'));
  view.append(h('div', { class: 'page-title' }, h('div', {}, h('h1', {}, ins.inspection_templates?.title || 'Inspection'),
    h('p', {}, h('span', { class: 'ref' }, ins.reference), ' ', statusBadge(ins.status, INSPECTION_STATUS)))));
  view.append(h('div', { class: 'card' }, kv([
    ['Site', sites.find((s) => s.id === ins.site_id)?.name || '—'],
    ['Inspector', names.get(ins.inspector_id) || '—'],
    ['Due', fmtDate(ins.due_on)],
    ['Started', fmtDateTime(ins.started_at)],
    ins.completed_at ? ['Completed', fmtDateTime(ins.completed_at)] : null,
    ins.completed_at ? ['Result', `${ins.compliant_count} compliant, ${ins.non_compliant_count} non-compliant`] : null,
    ins.summary ? ['Summary', ins.summary] : null,
  ])));

  if (!capturing) return renderReport(view, { org, ins, items, byItem, can, reload });

  // Live capture
  const sync = h('span', { class: 'sync', role: 'status' });
  const progress = h('strong');
  const updateProgress = () => {
    const n = items.filter((it) => byItem.has(it.id)).length;
    progress.textContent = `${n} of ${items.length} answered`;
    const q2 = readQueue().filter((r) => r.inspection_id === id).length;
    sync.textContent = q2 ? `Offline: ${q2} answer${q2 === 1 ? '' : 's'} saved on this device, will send when you reconnect` : 'All answers saved';
    sync.className = `sync ${q2 ? 'offline' : ''}`;
    return n;
  };
  view.append(h('div', { class: 'progress-line' }, progress, ' ', sync));

  const pending = new Map(); // comment/photo/risk given before an answer is chosen
  const save = async (it, patch) => {
    if (!byItem.has(it.id) && !patch.response) { pending.set(it.id, { ...(pending.get(it.id) || {}), ...patch }); return; }
    if (pending.has(it.id)) { patch = { ...pending.get(it.id), ...patch }; pending.delete(it.id); }
    const prev = byItem.get(it.id) || {};
    const row = { inspection_id: id, org_id: org, template_item_id: it.id, section: it.section, question: it.question,
      response: prev.response || 'not_inspected', comment: prev.comment ?? null, risk_level: prev.risk_level ?? null,
      photo_paths: prev.photo_paths || [], ...patch, client_updated_at: new Date().toISOString() };
    byItem.set(it.id, { ...prev, ...row });
    try { await pushResponse(row); }
    catch (e) {
      if (/fetch|network/i.test(e.message || '') || !navigator.onLine) { writeQueue([...readQueue().filter((r) => !(r.inspection_id === id && r.template_item_id === it.id)), row]); }
      else toast(errMsg(e), 'err');
    }
    updateProgress();
  };

  let section = null;
  for (const it of items) {
    if (it.section !== section) { section = it.section; view.append(h('h2', { class: 'q-section' }, section)); }
    const r = byItem.get(it.id) || {};
    const box = h('div', { class: `q ${r.response === 'non_compliant' ? 'is-nc' : ''}` });
    const comment = h('textarea', { placeholder: 'Comment (optional)', 'aria-label': `Comment: ${it.question}`, maxlength: 2000 }, r.comment || '');
    comment.addEventListener('change', () => save(it, { comment: comment.value.trim() || null }));
    const risk = h('select', { 'aria-label': 'Risk level of this finding', onchange: (e) => save(it, { risk_level: e.target.value || null }) },
      [['', 'Risk level'], ...Object.entries(RISK)].map(([v, l]) => h('option', { value: v, selected: r.risk_level === v }, l)));
    const photos = h('span', { class: 'muted small' }, (r.photo_paths || []).length ? `${r.photo_paths.length} photo${r.photo_paths.length === 1 ? '' : 's'}` : '');
    const foot = h('div', { class: 'q-foot' },
      fileButton('Add photo', async (files) => {
        const paths = [...(byItem.get(it.id)?.photo_paths || pending.get(it.id)?.photo_paths || [])];
        for (const file of files) { try { paths.push((await uploadFile(org, 'inspections', id, file)).path); } catch (e) { toast(errMsg(e), 'err'); } }
        await save(it, { photo_paths: paths });
        photos.textContent = `${paths.length} photo${paths.length === 1 ? '' : 's'}`;
      }, { capture: true }),
      photos, risk);
    const setNc = (nc) => { box.classList.toggle('is-nc', nc); risk.hidden = !nc; };
    const buttons = Object.entries(RESP).map(([v, l]) => h('button', { type: 'button', dataset: { v }, 'aria-pressed': String(r.response === v),
      onclick: async (e) => {
        buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
        setNc(v === 'non_compliant');
        await save(it, { response: v });
      } }, l));
    setNc(r.response === 'non_compliant');
    box.append(...[h('div', { class: 'qtext' }, it.question), it.guidance ? h('div', { class: 'guide' }, it.guidance) : null,
      h('div', { class: 'resp', role: 'group', 'aria-label': it.question }, buttons), comment, foot].filter(Boolean));
    view.append(box);
  }
  updateProgress();
  window.addEventListener('online', async () => { const r = await flushQueue(); if (r.sent) toast(`${r.sent} saved answer${r.sent === 1 ? '' : 's'} sent.`); updateProgress(); }, { once: true });

  view.append(h('div', { class: 'card', style: 'margin-top:18px' },
    h('h2', {}, 'Finish the inspection'),
    h('p', { class: 'sub' }, 'Every question needs an answer. Use "Not inspected" for anything you could not check.'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn btn-primary', onclick: async () => {
        await flushQueue();
        if (readQueue().some((r) => r.inspection_id === id)) { toast('You are offline. Reconnect to complete the inspection; your answers are saved on this device.', 'err'); return; }
        const fresh = await q(sb.from('inspection_responses').select('template_item_id, response, photo_paths').eq('inspection_id', id));
        const answered = new Set(fresh.map((x) => x.template_item_id));
        const missing = items.filter((it) => !answered.has(it.id));
        if (missing.length) { toast(`${missing.length} question${missing.length === 1 ? ' is' : 's are'} unanswered. First: "${missing[0].question}"`, 'err'); return; }
        const needPhoto = items.filter((it) => it.photo_required_on_fail && fresh.find((x) => x.template_item_id === it.id && x.response === 'non_compliant' && !(x.photo_paths || []).length));
        if (needPhoto.length) { toast(`Add a photo for: "${needPhoto[0].question}"`, 'err'); return; }
        const nc = fresh.filter((x) => x.response === 'non_compliant').length;
        const r = await modalForm({ title: 'Complete inspection', intro: `${fresh.length - nc} compliant or not applicable, ${nc} non-compliant. Completed inspections cannot be changed.`,
          submitLabel: 'Complete inspection',
          fields: [{ name: 'summary', label: 'Summary', type: 'textarea', rows: 3, maxlength: 2000, placeholder: 'Overall observations' }],
          onSubmit: (v) => q(sb.from('inspections').update({ status: 'completed', completed_at: new Date().toISOString(), summary: v.summary || null }).eq('id', id)) });
        if (r) { toast(nc ? 'Inspection completed. Raise actions for the findings below.' : 'Inspection completed.'); reload(); }
      } }, 'Complete inspection'),
      can.edit ? h('button', { class: 'btn-link danger', onclick: async () => {
        if (await confirmAction('Cancel this inspection?', 'It stays on record as cancelled.', 'Cancel inspection')) {
          try { await q(sb.from('inspections').update({ status: 'cancelled' }).eq('id', id)); toast('Inspection cancelled.'); reload(); } catch (e) { toast(errMsg(e), 'err'); }
        } } }, 'Cancel inspection') : null)));
}

async function renderReport(view, { org, ins, items, byItem, can, reload }) {
  view.append(h('div', { class: 'btn-row no-print', style: 'margin-bottom:16px' },
    h('button', { class: 'btn btn-secondary', onclick: () => window.print() }, 'Print report')));
  const findings = items.filter((it) => byItem.get(it.id)?.response === 'non_compliant');
  const fc = h('div', { class: 'card' }, h('h2', {}, `Findings (${findings.length})`));
  view.append(fc);
  if (!findings.length) fc.append(h('p', { class: 'muted' }, 'No non-compliant items.'));
  for (const it of findings) {
    const r = byItem.get(it.id);
    fc.append(h('div', { class: 'q is-nc' },
      h('div', { class: 'qtext' }, it.question), h('div', { class: 'guide' }, it.section, r.risk_level ? `, risk: ${RISK[r.risk_level]}` : ''),
      r.comment ? h('p', { class: 'prose-block' }, r.comment) : null,
      h('div', { class: 'q-foot' },
        (r.photo_paths || []).map((p, i) => h('button', { class: 'btn-link', onclick: () => openFile(p).catch((e) => toast(errMsg(e), 'err')) }, `Photo ${i + 1}`)),
        can.field && ins.status === 'completed' ? h('button', { class: 'btn btn-secondary btn-sm no-print', onclick: () => createAction({ org, source_type: 'inspection', source_id: ins.id, site_id: ins.site_id,
          title: `Rectify: ${it.question}`.slice(0, 200), description: r.comment || '' }).then((x) => x && reload()) }, 'Raise action') : null)));
  }
  view.append(await actionsPanel({ org, source_type: 'inspection', source_id: ins.id, site_id: ins.site_id, canRaise: can.field, onChange: reload }));
  const all = h('div', { class: 'card' }, h('h2', {}, 'All responses'));
  all.append(h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, ['Section', 'Question', 'Response', 'Comment'].map((t) => h('th', {}, t)))),
    h('tbody', {}, items.map((it) => { const r = byItem.get(it.id) || {}; return h('tr', {},
      h('td', { 'data-label': 'Section' }, it.section), h('td', { 'data-label': 'Question' }, it.question),
      h('td', { 'data-label': 'Response' }, RESP[r.response] || '—'), h('td', { 'data-label': 'Comment' }, r.comment || '')); })))));
  view.append(all);
  if (can.manage && ins.status === 'completed') {
    view.append(h('div', { class: 'no-print' }, h('button', { class: 'btn btn-secondary', onclick: async () => {
      const { count } = await sb.from('corrective_actions').select('id', { count: 'exact', head: true }).eq('source_type', 'inspection').eq('source_id', ins.id).in('status', ['open', 'in_progress', 'awaiting_verification']);
      if (count) { toast(`${count} action${count === 1 ? ' is' : 's are'} still open. Close-out is available once they are closed.`, 'err'); return; }
      if (await confirmAction('Close out this inspection?', 'Confirms all findings have been dealt with.', 'Close out', false)) {
        try { await q(sb.from('inspections').update({ status: 'closed' }).eq('id', ins.id)); toast('Inspection closed out.'); reload(); } catch (e) { toast(errMsg(e), 'err'); }
      } } }, 'Close out inspection')));
  }
}

async function suggestQuestions(org, t, items, reload) {
  const vals = await modalForm({ title: 'Suggest checklist questions with AI', submitLabel: 'Suggest questions',
    intro: 'Describe what this checklist covers. You choose which suggestions to add, and the checklist still needs approval before use.',
    fields: [
      { name: 'work_area', label: 'Work area or activity', required: true, maxlength: 500, value: t.title },
      { name: 'equipment', label: 'Equipment or specialised plant', type: 'textarea', rows: 2, maxlength: 1000 },
      { name: 'scope', label: 'Scope and focus', type: 'textarea', rows: 2, maxlength: 1000, placeholder: 'e.g. Weekly walk-through by the supervisor, about 20 questions' },
    ], onSubmit: async (x) => x });
  if (!vals) return;
  let r;
  try {
    r = await withBusy('Writing checklist questions…', () => callAI({ task: 'checklist_questions', org_id: org,
      inputs: { checklist_category: CATEGORIES[t.category] || t.category, work_area: vals.work_area, equipment: vals.equipment, scope: vals.scope } }));
  } catch (e) { aiError(e); return; }
  const existing = new Set(items.map((i) => i.question.trim().toLowerCase()));
  const boxes = [];
  const body = h('div', {}, reviewPanel(r.validation, r.output.legal_references), (r.output.sections || []).map((sec) => h('fieldset', { class: 'ai-group' },
    h('legend', {}, sec.section), (sec.questions || []).map((qq) => {
      const dup = existing.has(qq.question.trim().toLowerCase());
      const cb = h('input', { type: 'checkbox', checked: !dup });
      boxes.push({ cb, section: sec.section, question: qq.question, guidance: qq.guidance });
      return h('label', { class: 'ai-check' }, cb, h('span', {}, qq.question, dup ? h('span', { class: 'muted small' }, ' (already in checklist)') : null,
        qq.guidance ? h('span', { class: 'muted small', style: 'display:block' }, qq.guidance) : null));
    }))));
  suggestionDialog({ title: 'Suggested questions', intro: 'Untick anything you do not want. You can edit questions after adding them.', body,
    footer: (close) => h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
      const chosen = boxes.filter((b) => b.cb.checked);
      if (!chosen.length) { toast('Tick at least one question.', 'err'); return; }
      let n = (items[items.length - 1]?.sort_order || 0);
      try {
        await q(sb.from('inspection_template_items').insert(chosen.map((c) => ({ template_id: t.id, org_id: org, section: c.section.slice(0, 100),
          question: c.question.slice(0, 400), guidance: c.guidance ? c.guidance.slice(0, 800) : null, sort_order: ++n }))));
        toast(`${chosen.length} question${chosen.length === 1 ? '' : 's'} added.`); close(); reload();
      } catch (e) { toast(errMsg(e), 'err'); }
    } }, 'Add selected questions') });
}
