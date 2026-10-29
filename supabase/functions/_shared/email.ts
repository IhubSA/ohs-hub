// Shared Resend helper and branded email layout for OHS Hub Edge Functions.
// Secrets come from Edge Function environment variables — never the browser.

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
export const EMAIL_FROM = Deno.env.get('EMAIL_FROM') ?? 'OHS Hub <notifications@ihub-sa.co.za>';
export const EMAIL_REPLY_TO = Deno.env.get('EMAIL_REPLY_TO') ?? 'enquiries@ihub-sa.co.za';
export const SITE_URL = (Deno.env.get('SITE_URL') ?? 'https://ihubsa.github.io/ohs-hub/').replace(/\/?$/, '/');

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function layout(opts: { heading: string; bodyHtml: string; ctaLabel?: string; ctaUrl?: string; footnote?: string }) {
  const cta = opts.ctaUrl
    ? `<p style="margin:24px 0"><a href="${esc(opts.ctaUrl)}" style="background:#FC7312;color:#052E3A;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:4px;display:inline-block">${esc(opts.ctaLabel ?? 'Open OHS Hub')}</a></p>`
    : '';
  return `<!doctype html><html lang="en-ZA"><body style="margin:0;background:#F3F8F9;font-family:Arial,Helvetica,sans-serif;color:#052E3A">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F8F9;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #D2E0E4;border-radius:8px">
<tr><td style="background:#052E3A;padding:14px 24px;border-radius:8px 8px 0 0;color:#ffffff;font-weight:700;font-size:18px">
<img src="${SITE_URL}assets/img/logo-light.png" alt="OHS Hub" height="40" style="display:block;height:40px;width:auto;border:0"></td></tr>
<tr><td style="padding:28px 24px 8px;font-size:15px;line-height:1.6">
<h1 style="font-size:20px;margin:0 0 12px">${esc(opts.heading)}</h1>${opts.bodyHtml}${cta}</td></tr>
<tr><td style="padding:16px 24px 24px;border-top:1px solid #EAF2F4;font-size:12px;color:#587480">
${opts.footnote ? esc(opts.footnote) + '<br>' : ''}OHS Hub by iHubSA, Fish Hoek, Western Cape.</td></tr>
</table></td></tr></table></body></html>`;
}

export type SendResult = { ok: true; id: string } | { ok: false; error: string };

export async function sendEmail(msg: {
  to: string | string[]; subject: string; html: string; text: string; replyTo?: string; idempotencyKey?: string;
}): Promise<SendResult> {
  if (!RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY is not configured' };
  const headers: Record<string, string> = { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' };
  if (msg.idempotencyKey) headers['Idempotency-Key'] = msg.idempotencyKey.slice(0, 256);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      from: EMAIL_FROM, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text,
      reply_to: msg.replyTo ?? EMAIL_REPLY_TO,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${body?.message ?? 'unknown error'}` };
  return { ok: true, id: body.id };
}
