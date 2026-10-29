// Team & roles: members, role assignment, site scope and invitations.
import { sb, q } from '../sb.js';
import { h, modalForm, confirmAction, toast, errMsg, badge, fmtDate, relTime, ROLE_LABELS, ROLE_HELP } from '../ui.js';

async function invokeInvite(body) {
  const { data, error } = await sb.functions.invoke('invite-user', { body });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch { /* keep default */ }
    throw new Error(msg);
  }
  return data;
}

export async function render(view, { state, can, reload }) {
  const org = state.org.id;
  const admin = can.admin;
  const [members, sites, invites] = await Promise.all([
    q(sb.from('organisation_memberships').select('id, user_id, role, status, site_ids, can_view_confidential, can_approve_documents, created_at').eq('org_id', org)),
    q(sb.from('sites').select('id, name').eq('org_id', org).eq('is_active', true).order('name')),
    admin ? q(sb.from('organisation_invitations').select('id, email, role, site_ids, expires_at, created_at')
      .eq('org_id', org).is('accepted_at', null).is('revoked_at', null).order('created_at', { ascending: false })) : [],
  ]);
  const profiles = members.length ? await q(sb.from('user_profiles').select('id, full_name, email, job_title').in('id', members.map((m) => m.user_id))) : [];
  const prof = Object.fromEntries(profiles.map((p) => [p.id, p]));
  const siteName = Object.fromEntries(sites.map((s) => [s.id, s.name]));
  const roleOptions = Object.entries(ROLE_LABELS);
  const scopeText = (ids) => !ids || !ids.length ? 'All sites' : ids.map((i) => siteName[i] || 'Inactive site').join(', ');

  view.append(h('div', { class: 'page-title' },
    h('div', {}, h('h1', {}, 'Team & roles'), h('p', {}, admin ? 'Invite people and control what each person can see and do.' : 'People who have access to this organisation.')),
    admin ? h('button', { class: 'btn btn-primary', onclick: () => inviteForm() }, 'Invite someone') : null));

  // ---------------- Invite ----------------
  function inviteForm() {
    modalForm({
      title: 'Invite someone',
      intro: 'They will receive an email with a link that is valid for 7 days. They sign in, or create an account, with the same email address.',
      submitLabel: 'Send invitation',
      fields: [
        { name: 'email', label: 'Email address', type: 'email', required: true, maxlength: 200 },
        { name: 'role', label: 'Role', type: 'select', value: 'safety_officer', options: roleOptions,
          hint: Object.entries(ROLE_HELP).map(([k, t]) => `${ROLE_LABELS[k]}: ${t}`).join(' ') },
        sites.length ? { name: 'site_ids', label: 'Limit to these sites', type: 'checks', options: sites.map((s) => [s.id, s.name]),
          hint: 'Leave all unticked for access to every site. Site limits apply to supervisors and employees.' } : null,
      ].filter(Boolean),
      onSubmit: (v) => invokeInvite({ action: 'invite', org_id: org, email: v.email, role: v.role, site_ids: v.site_ids || [] }),
    }).then((r) => { if (r) { toast('Invitation sent.'); reload(); } });
  }

  // ---------------- Members ----------------
  const editMember = (m) => modalForm({
    title: `Edit access: ${prof[m.user_id]?.full_name || prof[m.user_id]?.email || 'member'}`,
    submitLabel: 'Save access',
    fields: [
      { name: 'role', label: 'Role', type: 'select', value: m.role, options: roleOptions, hint: ROLE_HELP[m.role] },
      sites.length ? { name: 'site_ids', label: 'Limit to these sites', type: 'checks', value: m.site_ids || [], options: sites.map((s) => [s.id, s.name]),
        hint: 'Leave all unticked for access to every site.' } : null,
      { name: 'can_view_confidential', label: 'Can see confidential incident reports', type: 'checkbox', value: m.can_view_confidential,
        hint: 'Administrators and OHS managers always can.' },
      { name: 'can_approve_documents', label: 'Can approve controlled documents', type: 'checkbox', value: m.can_approve_documents,
        hint: 'Administrators and OHS managers always can.' },
    ].filter(Boolean),
    onSubmit: async (v) => {
      await q(sb.from('organisation_memberships').update({
        role: v.role, site_ids: v.site_ids && v.site_ids.length ? v.site_ids : null,
        can_view_confidential: v.can_view_confidential, can_approve_documents: v.can_approve_documents,
      }).eq('id', m.id));
    },
  }).then((r) => { if (r) { toast('Access updated.'); reload(); } });

  const setStatus = async (m, status) => {
    const name = prof[m.user_id]?.full_name || prof[m.user_id]?.email;
    const ok = await confirmAction(status === 'suspended' ? `Suspend ${name}?` : `Reactivate ${name}?`,
      status === 'suspended' ? 'They will immediately lose access to this organisation. Their records and history are kept.' : 'They will regain access with their current role.',
      status === 'suspended' ? 'Suspend access' : 'Reactivate', status === 'suspended');
    if (!ok) return;
    try { await q(sb.from('organisation_memberships').update({ status }).eq('id', m.id)); toast('Access updated.'); reload(); }
    catch (e) { toast(errMsg(e), 'err'); }
  };
  const removeMember = async (m) => {
    const name = prof[m.user_id]?.full_name || prof[m.user_id]?.email;
    if (!await confirmAction(`Remove ${name}?`, 'They will lose access to this organisation. Records they created stay in place.', 'Remove from organisation')) return;
    try { await q(sb.from('organisation_memberships').delete().eq('id', m.id)); toast('Member removed.'); reload(); }
    catch (e) { toast(errMsg(e), 'err'); }
  };

  members.sort((a, b) => (prof[a.user_id]?.full_name || '').localeCompare(prof[b.user_id]?.full_name || ''));
  view.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, `Members (${members.filter((m) => m.status === 'active').length} active)`)),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ['Name', 'Role', 'Sites', 'Status', ''].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, members.map((m) => {
        const p = prof[m.user_id] || {};
        const me = m.user_id === state.user.id;
        return h('tr', {},
          h('td', { 'data-label': 'Name' }, h('strong', {}, p.full_name || '(name not set)'), me ? ' (you)' : '', h('div', { class: 'muted small' }, p.email || '')),
          h('td', { 'data-label': 'Role' }, ROLE_LABELS[m.role],
            m.can_view_confidential && !['org_admin', 'ohs_manager'].includes(m.role) ? h('div', { class: 'muted small' }, 'Sees confidential reports') : null,
            m.can_approve_documents && !['org_admin', 'ohs_manager'].includes(m.role) ? h('div', { class: 'muted small' }, 'Approves documents') : null),
          h('td', { 'data-label': 'Sites' }, scopeText(m.site_ids)),
          h('td', { 'data-label': 'Status' }, m.status === 'active' ? badge('Active', 'ok') : badge('Suspended', 'bad')),
          h('td', { class: 'actions' }, admin ? [
            h('button', { class: 'btn-link', onclick: () => editMember(m) }, 'Edit access'),
            me ? null : h('button', { class: 'btn-link', onclick: () => setStatus(m, m.status === 'active' ? 'suspended' : 'active') }, m.status === 'active' ? 'Suspend' : 'Reactivate'),
            me ? null : h('button', { class: 'btn-link danger', onclick: () => removeMember(m) }, 'Remove'),
          ] : null));
      }))))));

  // ---------------- Invitations ----------------
  if (admin) {
    const now = new Date().toISOString();
    const resend = async (i) => {
      try { await invokeInvite({ action: 'resend', invitation_id: i.id }); toast(`Invitation re-sent to ${i.email}.`); reload(); }
      catch (e) { toast(errMsg(e), 'err'); }
    };
    const revoke = async (i) => {
      if (!await confirmAction(`Revoke the invitation to ${i.email}?`, 'The link in their email will stop working.', 'Revoke invitation')) return;
      try { await q(sb.from('organisation_invitations').update({ revoked_at: new Date().toISOString() }).eq('id', i.id)); toast('Invitation revoked.'); reload(); }
      catch (e) { toast(errMsg(e), 'err'); }
    };
    view.append(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, `Open invitations (${invites.length})`)),
      invites.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, ['Email', 'Role', 'Sent', 'Expires', ''].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', {}, invites.map((i) => h('tr', {},
          h('td', { 'data-label': 'Email' }, i.email),
          h('td', { 'data-label': 'Role' }, ROLE_LABELS[i.role], h('div', { class: 'muted small' }, scopeText(i.site_ids))),
          h('td', { 'data-label': 'Sent' }, relTime(i.created_at)),
          h('td', { 'data-label': 'Expires' }, i.expires_at < now ? badge('Expired', 'bad') : fmtDate(i.expires_at)),
          h('td', { class: 'actions' }, h('button', { class: 'btn-link', onclick: () => resend(i) }, i.expires_at < now ? 'Send a new link' : 'Resend'),
            h('button', { class: 'btn-link danger', onclick: () => revoke(i) }, 'Revoke')))))))
        : h('p', { class: 'muted', style: 'margin:0' }, 'No open invitations.')));
  }

  view.append(h('div', { class: 'card' }, h('h2', {}, 'What each role can do'),
    h('dl', { class: 'kv', style: 'margin-top:12px' }, Object.entries(ROLE_HELP).map(([k, t]) => [h('dt', {}, ROLE_LABELS[k]), h('dd', { style: 'font-weight:400' }, t)]))));
}
