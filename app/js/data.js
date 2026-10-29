// Shared data helpers for the OHS modules: people pickers, sites,
// reference numbers, private file storage and common labels.
import { sb, q } from './sb.js';
import { h, badge } from './ui.js';

const cache = new Map();
const cached = (key, fn) => {
  if (!cache.has(key)) cache.set(key, fn().catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
};
export const clearCache = () => cache.clear();

// Active members of the organisation with display names.
export function loadMembers(org) {
  return cached(`members:${org}`, async () => {
    const ms = await q(sb.from('organisation_memberships')
      .select('user_id, role, can_approve_documents, can_view_confidential, site_ids')
      .eq('org_id', org).eq('status', 'active'));
    const ids = ms.map((m) => m.user_id);
    const profiles = ids.length ? await q(sb.from('user_profiles').select('id, full_name, email').in('id', ids)) : [];
    const byId = new Map(profiles.map((p) => [p.id, p]));
    return ms.map((m) => ({ ...m, name: byId.get(m.user_id)?.full_name || byId.get(m.user_id)?.email || 'Team member',
      email: byId.get(m.user_id)?.email })).sort((a, b) => a.name.localeCompare(b.name));
  });
}
export async function memberName(org, id) {
  if (!id) return '—';
  const ms = await loadMembers(org);
  return ms.find((m) => m.user_id === id)?.name || 'Former member';
}
export const nameMap = async (org) => new Map((await loadMembers(org)).map((m) => [m.user_id, m.name]));

export function loadSites(org) {
  return cached(`sites:${org}`, () => q(sb.from('sites').select('id, name, code, is_active').eq('org_id', org).order('name')));
}
export function loadDepts(org) {
  return cached(`depts:${org}`, () => q(sb.from('departments').select('id, name, site_id').eq('org_id', org).order('name')));
}
export function loadMethodology(org) {
  return cached(`meth:${org}`, () => q(sb.from('risk_methodologies').select('*').eq('org_id', org).eq('is_default', true).maybeSingle()));
}

export const nextRef = (org, prefix) => q(sb.rpc('next_reference', { p_org: org, p_prefix: prefix }));

export const siteOptions = (sites, blank = 'No specific site') =>
  [['', blank], ...sites.filter((s) => s.is_active).map((s) => [s.id, s.name])];
export const memberOptions = (members, blank = 'Unassigned', filter = () => true) =>
  [['', blank], ...members.filter(filter).map((m) => [m.user_id, m.name])];

// Dates (Africa/Johannesburg)
export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
export const addDays = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
export const isOverdue = (date, status, open = ['open', 'in_progress']) => !!date && open.includes(status) && date < today();

// ---------------------------------------------------------------------
// Private file storage: org-files/{org}/{module}/{record}/{file}
// ---------------------------------------------------------------------
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv'];
export const MAX_FILE = 10 * 1024 * 1024;
export const ACCEPT = '.jpg,.jpeg,.png,.webp,.heic,.pdf,.docx,.xlsx,.csv';

export function checkFile(file) {
  if (file.size > MAX_FILE) return `${file.name} is larger than 10 MB.`;
  if (file.type && !ALLOWED.includes(file.type)) return `${file.name} is not an allowed file type. Use photos, PDF, Word, Excel or CSV.`;
  return '';
}
export async function uploadFile(org, module, recordId, file) {
  const problem = checkFile(file);
  if (problem) throw new Error(problem);
  const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80);
  const path = `${org}/${module}/${recordId}/${crypto.randomUUID().slice(0, 8)}-${safe}`;
  const { error } = await sb.storage.from('org-files').upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (error) throw error;
  return { path, name: file.name, type: file.type };
}
export async function openFile(path) {
  const { data, error } = await sb.storage.from('org-files').createSignedUrl(path, 120);
  if (error) throw error;
  window.open(data.signedUrl, '_blank', 'noopener');
}
// File picker button that calls onFiles(FileList)
export function fileButton(label, onFiles, { capture = false, multiple = true } = {}) {
  const input = h('input', { type: 'file', accept: ACCEPT, multiple, hidden: true, capture: capture ? 'environment' : null,
    onchange: (e) => { if (e.target.files.length) onFiles([...e.target.files]); e.target.value = ''; } });
  return h('span', {}, input, h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: () => input.click() }, label));
}

// ---------------------------------------------------------------------
// Labels and status badges
// ---------------------------------------------------------------------
export const PRIORITY = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
export const ACTION_STATUS = { open: 'Open', in_progress: 'In progress', awaiting_verification: 'Awaiting verification', closed: 'Closed', cancelled: 'Cancelled' };
export const ACTION_SOURCE = { risk_assessment: 'Risk assessment', risk_register: 'Risk register', inspection: 'Inspection', audit: 'Audit',
  incident: 'Incident', legal_compliance: 'Legal compliance', management_review: 'Management review', other: 'Other' };
export const RECORD_STATUS = { draft: 'Draft', in_review: 'In review', approved: 'Approved', archived: 'Archived' };
export const RA_TYPES = { baseline: 'Baseline', issue_based: 'Issue-based', task_specific: 'Task-specific', jsa: 'Job safety analysis', jha: 'Job hazard analysis' };
export const CONTROL_LEVELS = { elimination: 'Elimination', substitution: 'Substitution', engineering: 'Engineering controls', administrative: 'Administrative controls', ppe: 'PPE' };
export const INCIDENT_CATEGORIES = { injury: 'Injury', near_miss: 'Near miss', dangerous_occurrence: 'Dangerous occurrence', property_damage: 'Property damage',
  occupational_illness: 'Occupational illness', environmental: 'Environmental event', unsafe_condition: 'Unsafe condition', unsafe_act: 'Unsafe act', other: 'Other' };
export const INCIDENT_STATUS = { reported: 'Reported', under_investigation: 'Under investigation', awaiting_approval: 'Awaiting approval', closed: 'Closed' };
export const INVESTIGATION_STATUS = { assigned: 'Assigned', in_progress: 'In progress', submitted: 'Submitted for review', approved: 'Approved', returned: 'Returned for changes' };
export const INSPECTION_STATUS = { scheduled: 'Scheduled', in_progress: 'In progress', completed: 'Completed', closed: 'Closed', cancelled: 'Cancelled' };
export const DOC_TYPES = { sop: 'Standard operating procedure', safe_work_procedure: 'Safe work procedure', risk_assessment: 'Risk assessment', jsa: 'Job safety analysis',
  inspection_checklist: 'Inspection checklist', toolbox_talk: 'Toolbox talk', safety_alert: 'Safety alert', emergency_plan: 'Emergency plan',
  method_statement: 'Method statement', audit_checklist: 'Audit checklist', incident_report: 'Incident report', corrective_action_plan: 'Corrective action plan',
  ohs_report: 'OHS report', policy: 'Policy', other: 'Other' };
export const DOC_PREFIX = { sop: 'SOP', safe_work_procedure: 'SWP', risk_assessment: 'RAD', jsa: 'JSA', inspection_checklist: 'CHK', toolbox_talk: 'TBT',
  safety_alert: 'SAL', emergency_plan: 'ERP', method_statement: 'MS', audit_checklist: 'AUD', incident_report: 'IIR', corrective_action_plan: 'CAP',
  ohs_report: 'RPT', policy: 'POL', other: 'DOC' };
export const DOC_STATUS = { draft: 'Draft', in_review: 'In review', approved: 'Approved', obsolete: 'Obsolete', archived: 'Archived' };

const KIND = {
  open: '', in_progress: 'info', awaiting_verification: 'warn', closed: 'ok', cancelled: '',
  draft: '', in_review: 'warn', approved: 'ok', archived: '', obsolete: '',
  reported: 'warn', under_investigation: 'info', awaiting_approval: 'warn',
  scheduled: '', completed: 'ok', assigned: 'info', submitted: 'warn', returned: 'bad',
  low: '', medium: 'warn', high: 'bad', critical: 'bad',
};
export const statusBadge = (value, labels) => badge(labels[value] || value, KIND[value] ?? '');

// Risk rating chip coloured by the organisation's methodology bands.
export function ratingChip(meth, score, label) {
  if (score == null) return h('span', { class: 'muted' }, '—');
  const band = (meth?.bands || []).find((b) => score >= b.min && score <= b.max);
  const colour = band?.colour || '#999';
  const dark = ['#F2B705', '#F6CF52'].includes(colour.toUpperCase());
  return h('span', { class: 'rating', style: `background:${colour};color:${dark ? '#052E3A' : '#fff'}` }, `${score} ${label || band?.label || ''}`.trim());
}
export const bandFor = (meth, score) => (meth?.bands || []).find((b) => score >= b.min && score <= b.max);

// Simple key-value list
export const kv = (pairs) => h('dl', { class: 'kv' }, pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? '—')]));

// Query-string helpers for list filters kept in the URL hash
export function setQuery(route, params) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
  location.hash = `#/${route}${qs ? '?' + qs : ''}`;
}
