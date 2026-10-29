// invite-user — an organisation administrator invites someone by email.
// The raw token is emailed once and only its SHA-256 hash is stored.
// The invitee accepts in the app (accept_invitation RPC), which checks the
// token, expiry and that their signed-in email matches the invitation.
//
// Body: { action: 'invite', org_id, email, role, site_ids? }
//       { action: 'resend', invitation_id }
// Deploy WITH JWT verification (callers must be signed in).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { esc, layout, sendEmail, SITE_URL } from '../_shared/email.ts';

const ROLES: Record<string, string> = {
  org_admin: 'Organisation Administrator', ohs_manager: 'OHS Manager', safety_officer: 'Safety Officer',
  supervisor: 'Supervisor', employee: 'Employee', auditor: 'Auditor (read-only)',
};
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function newToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return json(401, { error: 'Sign in again to send invitations.' });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: 'The request could not be read.' }); }

  let inv: { id: string; org_id: string; email: string; role: string } | null = null;
  if (body.action === 'resend') {
    const { data } = await admin.from('organisation_invitations')
      .select('id, org_id, email, role, accepted_at, revoked_at').eq('id', String(body.invitation_id ?? '')).maybeSingle();
    if (!data || data.accepted_at || data.revoked_at) return json(404, { error: 'This invitation is no longer open.' });
    inv = data;
  }
  const orgId = inv?.org_id ?? String(body.org_id ?? '');

  // Caller must be an active administrator of this organisation.
  const { data: me } = await admin.from('organisation_memberships')
    .select('role').eq('org_id', orgId).eq('user_id', user.id).eq('status', 'active').maybeSingle();
  if (me?.role !== 'org_admin') return json(403, { error: 'Only organisation administrators can invite people.' });

  const token = newToken();
  const token_hash = await sha256(token);
  const expires_at = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

  if (!inv) {
    const email = String(body.email ?? '').trim().toLowerCase();
    const role = String(body.role ?? '');
    const site_ids = Array.isArray(body.site_ids) && body.site_ids.length ? body.site_ids.map(String) : null;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(422, { error: 'Enter a valid email address.' });
    if (!ROLES[role]) return json(422, { error: 'Choose a role for this person.' });

    // Already a member?
    const { data: existing } = await admin.from('user_profiles').select('id').eq('email', email).maybeSingle();
    if (existing) {
      const { data: m } = await admin.from('organisation_memberships').select('id').eq('org_id', orgId).eq('user_id', existing.id).maybeSingle();
      if (m) return json(409, { error: 'This person is already a member of your organisation.' });
    }
    // Plan user limit (members + open invitations).
    const { data: limit } = await admin.rpc('org_limit', { p_org: orgId, p_key: 'users' });
    if (limit) {
      const [{ count: members }, { count: pending }] = await Promise.all([
        admin.from('organisation_memberships').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('status', 'active'),
        admin.from('organisation_invitations').select('id', { count: 'exact', head: true }).eq('org_id', orgId)
          .is('accepted_at', null).is('revoked_at', null).gt('expires_at', new Date().toISOString()),
      ]);
      if ((members ?? 0) + (pending ?? 0) >= limit) {
        return json(422, { error: `Your plan allows ${limit} users, including open invitations. Revoke an invitation or upgrade your plan.` });
      }
    }
    // Replace any open invitation for the same address.
    await admin.from('organisation_invitations').update({ revoked_at: new Date().toISOString() })
      .eq('org_id', orgId).eq('email', email).is('accepted_at', null).is('revoked_at', null);
    const { data: created, error } = await admin.from('organisation_invitations')
      .insert({ org_id: orgId, email, role, site_ids, token_hash, invited_by: user.id, expires_at })
      .select('id, org_id, email, role').single();
    if (error) { console.error('invite insert', error.code); return json(500, { error: 'The invitation could not be created.' }); }
    inv = created;
  } else {
    await admin.from('organisation_invitations').update({ token_hash, expires_at }).eq('id', inv.id);
  }

  const [{ data: org }, { data: inviter }] = await Promise.all([
    admin.from('organisations').select('name').eq('id', orgId).single(),
    admin.from('user_profiles').select('full_name, email').eq('id', user.id).single(),
  ]);
  const who = inviter?.full_name || inviter?.email || 'A colleague';
  const link = `${SITE_URL}app/?invite=${token}`;
  const roleLabel = ROLES[inv!.role];
  const sent = await sendEmail({
    to: inv!.email,
    subject: `${who} invited you to ${org?.name ?? 'their organisation'} on OHS Hub`,
    idempotencyKey: `invite-${inv!.id}-${token_hash.slice(0, 16)}`,
    replyTo: inviter?.email,
    html: layout({
      heading: `Join ${org?.name ?? 'your team'} on OHS Hub`,
      bodyHtml: `<p>${esc(who)} has invited you to join <strong>${esc(org?.name)}</strong> as <strong>${esc(roleLabel)}</strong>.</p>
        <p>Open the link below, then sign in, or create an account using <strong>${esc(inv!.email)}</strong>. The invitation expires in 7 days.</p>`,
      ctaLabel: 'Accept invitation', ctaUrl: link,
      footnote: "If you weren't expecting this invitation, you can ignore this email.",
    }),
    text: `${who} has invited you to join ${org?.name} on OHS Hub as ${roleLabel}.\n\nAccept: ${link}\n\nSign in or create an account using ${inv!.email}. The invitation expires in 7 days.`,
  });
  if (!sent.ok) {
    console.error('invite email', sent.error);
    return json(502, { error: 'The invitation was saved but the email could not be sent. Try "Resend" in a few minutes.', invitation_id: inv!.id });
  }
  return json(200, { ok: true, invitation_id: inv!.id });
});
