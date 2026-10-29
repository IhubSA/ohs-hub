// AI drafting helpers. All AI calls go through the ai-generate Edge
// Function; this module never sees the provider key. Every AI result is
// shown with a review panel and must be checked by a competent person.
import { sb, q } from './sb.js';
import { h, toast } from './ui.js';

export async function aiQuota(org) {
  try { return await q(sb.rpc('ai_quota', { p_org: org })); } catch { return { enabled: false, can_generate: false }; }
}

// Returns null when AI cannot be used, with the reason as text, so screens
// show an explanation instead of a button that does nothing.
export function aiAvailability(quota) {
  if (!quota?.can_generate) return { ok: false, reason: null };
  if (!quota.platform_enabled) return { ok: false, reason: 'AI drafting is not switched on yet.' };
  if (!quota.plan_includes_ai) return { ok: false, reason: 'Your plan does not include AI drafting.' };
  if (quota.remaining === 0) return { ok: false, reason: `All ${quota.limit} AI drafts for this month have been used.` };
  return { ok: true, reason: quota.limit ? `${quota.used} of ${quota.limit} AI drafts used this month.` : null };
}

export async function callAI(payload) {
  const { data, error } = await sb.functions.invoke('ai-generate', { body: payload });
  if (error) {
    let msg = 'The AI request failed. Try again.';
    try { const body = await error.context?.json?.(); if (body?.error) msg = body.error; } catch { /* keep default */ }
    throw new Error(msg);
  }
  return data;
}

// Busy overlay while the model works (drafts can take 20 to 60 seconds).
export async function withBusy(label, fn) {
  const dlg = h('dialog', { class: 'modal', 'aria-live': 'polite' },
    h('div', { class: 'modal-body', style: 'padding:28px' }, h('p', { class: 'ai-busy' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), label),
      h('p', { class: 'muted small' }, 'This usually takes 20 to 60 seconds.')));
  document.body.append(dlg); dlg.showModal();
  dlg.addEventListener('cancel', (e) => e.preventDefault());
  try { return await fn(); } finally { dlg.close(); dlg.remove(); }
}

export const aiLabel = (text = 'AI-generated draft. A competent person must check and approve it before use.') =>
  h('p', { class: 'ai-label' }, h('strong', {}, 'AI '), text);

// Review panel: missing information, uncertainties, legal references.
export function reviewPanel(validation = {}, refs = []) {
  const v = validation || {};
  const lists = [
    ['Sections the AI did not complete', v.missing_sections],
    ['Information you still need to add', v.missing_information],
    ['Points the AI was unsure about', v.uncertainties],
    ['Sections that mention legislation in the text (check these carefully)', v.legal_mentions_in_text],
    ['Evidence to collect', v.evidence_to_collect],
  ].filter(([, items]) => items?.length);
  const box = h('div', { class: 'ai-review' }, aiLabel());
  for (const [title, items] of lists) box.append(h('h3', { class: 'section-label' }, title), h('ul', {}, items.map((i) => h('li', {}, i))));
  if (refs?.length) {
    box.append(h('h3', { class: 'section-label' }, 'Legal references suggested'),
      h('ul', {}, refs.map((r) => h('li', {}, r.verified ? h('span', { class: 'badge ok' }, 'Verified') : h('span', { class: 'badge bad' }, 'Needs verification'),
        ' ', h('strong', {}, r.reference), r.reason ? ` (${r.reason})` : ''))));
    if (refs.some((r) => !r.verified)) box.append(h('p', { class: 'small' }, 'References marked "Needs verification" were not found in your verified legal register. Check them against the official text before relying on them.'));
  }
  if (v.note) box.append(h('p', { class: 'small' }, v.note));
  return box;
}

// Generic list dialog for picking AI suggestions.
export function suggestionDialog({ title, intro, body, footer }) {
  const dlg = h('dialog', { class: 'modal modal-wide', 'aria-label': title });
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.append(
    h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'modal-close', type: 'button', 'aria-label': 'Close', onclick: close }, '×')),
    h('div', { class: 'modal-body' }, intro ? h('p', { class: 'muted' }, intro) : null, body),
    h('div', { class: 'modal-foot' }, footer ? footer(close) : null, h('button', { class: 'btn btn-secondary', type: 'button', onclick: close }, 'Done')));
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.body.append(dlg); dlg.showModal();
  return { dlg, close };
}

export function aiError(e) { toast(e.message || 'The AI request failed.', 'err'); }
