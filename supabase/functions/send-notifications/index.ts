// send-notifications — flushes pending in-app notifications to email via Resend.
//
// Notifications are created inside the database (event triggers and the daily
// run_daily_reminders() sweep), deduplicated by (user_id, dedupe_key). This
// function picks up rows with email_status = 'pending', sends them, and
// records the Resend message id or the error, so delivery is trackable.
//
// Scheduled every 10 minutes by pg_cron (migration 7). Callers must send the
// x-cron-secret header; the value lives in Supabase Vault and is checked via
// check_cron_secret(), which only the service role may call.
// Deploy with --no-verify-jwt. Secrets: RESEND_API_KEY (+ automatic SUPABASE_*).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { esc, layout, sendEmail, SITE_URL } from '../_shared/email.ts';

const BATCH = 50;

Deno.serve(async (req) => {
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const secret = req.headers.get('x-cron-secret') ?? '';
  const { data: allowed } = secret ? await sb.rpc('check_cron_secret', { p_secret: secret }) : { data: false };
  if (allowed !== true) {
    return new Response(JSON.stringify({ error: 'Unauthorised' }), { status: 401 });
  }

  const { data: rows, error } = await sb.from('notifications')
    .select('id, org_id, user_id, event_type, title, body, link, dedupe_key, organisations(name)')
    .eq('email_status', 'pending').order('created_at').limit(BATCH);
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  // Resolve recipient emails in one query.
  const ids = [...new Set((rows ?? []).map((r) => r.user_id))];
  const { data: profiles } = ids.length
    ? await sb.from('user_profiles').select('id, email, full_name').in('id', ids)
    : { data: [] as { id: string; email: string; full_name: string }[] };
  const byId = new Map((profiles ?? []).map((p) => [p.id, p]));

  let sent = 0, failed = 0;
  for (const n of rows ?? []) {
    const p = byId.get(n.user_id);
    if (!p?.email) {
      await sb.from('notifications').update({ email_status: 'skipped', email_error: 'No email address' }).eq('id', n.id);
      continue;
    }
    const org = (n as unknown as { organisations?: { name?: string } }).organisations?.name ?? 'your organisation';
    const url = n.link ? SITE_URL + n.link.replace(/^\//, '') : SITE_URL + 'app/';
    const res = await sendEmail({
      to: p.email,
      subject: n.title,
      idempotencyKey: `notif-${n.id}`,
      html: layout({
        heading: n.title,
        bodyHtml: `${n.body ? `<p>${esc(n.body)}</p>` : ''}<p style="color:#587480;font-size:13px">${esc(org)}</p>`,
        ctaLabel: 'Open in OHS Hub', ctaUrl: url,
        footnote: 'You can change which emails you receive in your OHS Hub profile.',
      }),
      text: `${n.title}\n\n${n.body ?? ''}\n\n${org}\nOpen: ${url}`,
    });
    if (res.ok) {
      sent++;
      await sb.from('notifications').update({ email_status: 'sent', email_provider_id: res.id, emailed_at: new Date().toISOString(), email_error: null }).eq('id', n.id);
    } else {
      failed++;
      await sb.from('notifications').update({ email_status: 'failed', email_error: res.error.slice(0, 500) }).eq('id', n.id);
    }
  }
  return new Response(JSON.stringify({ processed: rows?.length ?? 0, sent, failed }), { headers: { 'Content-Type': 'application/json' } });
});
