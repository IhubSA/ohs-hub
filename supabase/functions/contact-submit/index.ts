// contact-submit — public marketing-site contact form.
// Validates input, blocks bots (honeypot) and floods (5 per hour per IP),
// stores the enquiry, emails the team via Resend and acknowledges the sender.
//
// Secrets: RESEND_API_KEY (required). Optional overrides: ENQUIRY_TO,
//          ALLOWED_ORIGINS (default https://ihubsa.github.io), IP_HASH_SALT.
// Deploy with JWT verification OFF (public form): supabase functions deploy contact-submit --no-verify-jwt
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { esc, layout, sendEmail } from '../_shared/email.ts';

const ALLOWED = (Deno.env.get('ALLOWED_ORIGINS') ?? 'https://ihubsa.github.io').split(',').map((s) => s.trim()).filter(Boolean);
const ENQUIRY_TO = (Deno.env.get('ENQUIRY_TO') ?? 'enquiries@ihub-sa.co.za,ihubsa@gmail.com')
  .split(',').map((s) => s.trim()).filter(Boolean);
const SALT = Deno.env.get('IP_HASH_SALT') ?? (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').slice(-24);
const TOPICS = ['general', 'demo', 'pricing', 'partnership', 'support'] as const;
const TOPIC_LABEL: Record<string, string> = {
  general: 'General question', demo: 'Walkthrough request', pricing: 'Pricing and quotes', partnership: 'Partnerships', support: 'Support',
};

function cors(origin: string | null) {
  const allow = ALLOWED.length === 0 ? '*' : (origin && ALLOWED.includes(origin) ? origin : ALLOWED[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

const json = (status: number, body: unknown, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });

async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

Deno.serve(async (req) => {
  const h = cors(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: h });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' }, h);
  if (ALLOWED.length && !ALLOWED.includes(req.headers.get('origin') ?? '')) return json(403, { error: 'Requests from this site are not accepted.' }, h);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: 'The form data could not be read.' }, h); }

  // Honeypot: bots fill hidden fields. Pretend success, store nothing.
  if (str(body.website, 200)) return json(200, { ok: true }, h);

  const data = {
    full_name: str(body.full_name, 120),
    email: str(body.email, 200).toLowerCase(),
    company: str(body.company, 160) || null,
    company_size: str(body.company_size, 40) || null,
    industry: str(body.industry, 80) || null,
    topic: (TOPICS as readonly string[]).includes(str(body.topic, 20)) ? str(body.topic, 20) : 'general',
    message: str(body.message, 4000),
    consent: body.consent === true || body.consent === 'on',
  };
  if (data.full_name.length < 2) return json(422, { error: 'Enter your full name.' }, h);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email)) return json(422, { error: 'Enter a valid email address.' }, h);
  if (data.message.length < 10) return json(422, { error: 'Your message needs at least 10 characters.' }, h);
  if (!data.consent) return json(422, { error: 'Consent is required so we can reply.' }, h);

  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  const ip_hash = await sha256(`${SALT}:${ip}`);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await sb.from('contact_enquiries').select('id', { count: 'exact', head: true })
    .eq('ip_hash', ip_hash).gte('created_at', since);
  if ((count ?? 0) >= 5) return json(429, { error: 'Too many messages from your connection. Please wait an hour.' }, h);

  const { data: row, error } = await sb.from('contact_enquiries').insert({ ...data, ip_hash }).select('id, created_at').single();
  if (error) { console.error('insert failed', error.code); return json(500, { error: 'We could not save your message.' }, h); }

  const when = new Date(row.created_at).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' });
  const rows = [
    ['Name', data.full_name], ['Email', data.email], ['Company', data.company], ['Employees', data.company_size],
    ['Industry', data.industry], ['Topic', TOPIC_LABEL[data.topic]], ['Received', when],
  ].filter(([, v]) => v).map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#587480">${esc(k)}</td><td style="padding:4px 0"><strong>${esc(v)}</strong></td></tr>`).join('');

  const team = await sendEmail({
    to: ENQUIRY_TO,
    subject: `OHS Hub enquiry: ${TOPIC_LABEL[data.topic]} from ${data.full_name}`,
    replyTo: data.email,
    idempotencyKey: `enquiry-${row.id}`,
    html: layout({ heading: 'New website enquiry', bodyHtml: `<table role="presentation" style="font-size:14px">${rows}</table>
      <p style="margin-top:16px;white-space:pre-wrap;border-left:3px solid #FC7312;padding-left:12px">${esc(data.message)}</p>
      <p style="font-size:13px;color:#587480">Reply to this email to answer ${esc(data.full_name)} directly.</p>` }),
    text: `New OHS Hub enquiry\n\nName: ${data.full_name}\nEmail: ${data.email}\nCompany: ${data.company ?? '-'}\nTopic: ${TOPIC_LABEL[data.topic]}\nReceived: ${when}\n\n${data.message}`,
  });

  await sendEmail({
    to: data.email,
    subject: 'We received your message — OHS Hub',
    idempotencyKey: `enquiry-ack-${row.id}`,
    html: layout({ heading: `Thanks, ${data.full_name.split(' ')[0]}`, bodyHtml:
      `<p>We've received your message about <strong>${esc(TOPIC_LABEL[data.topic].toLowerCase())}</strong> and will reply to this address.</p>
       <p style="color:#587480;font-size:13px">You're receiving this because you used the contact form on the OHS Hub website. We use your details only to respond to your enquiry.</p>` }),
    text: `Thanks, ${data.full_name}. We've received your message and will reply to this address.`,
  });

  await sb.from('contact_enquiries').update(team.ok
    ? { email_status: 'sent' }
    : { email_status: 'failed', email_error: team.error.slice(0, 500) }).eq('id', row.id);

  // The enquiry is stored even if email fails, so the visitor still gets success.
  return json(200, { ok: true }, h);
});
