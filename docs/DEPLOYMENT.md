# OHS Hub — Deployment guide

## Current live setup (28 October 2026)

| Item | Value |
|---|---|
| Supabase project | **OHS Hub**, ref `paunnbnjxmkxgexihgnf`, region eu-west-2 (London), Free plan |
| API URL | `https://paunnbnjxmkxgexihgnf.supabase.co` (already in `assets/js/config.js`) |
| Database | Migrations 1–10 applied, Supabase security scan clean apart from the intentional items listed below |
| Edge Functions | `contact-submit` (public), `send-notifications` (scheduled), `invite-user` (signed-in admins) |
| Scheduled jobs | `ohs-daily-reminders` at 06:00 SAST, `ohs-send-notifications` every 10 minutes |
| Email | Resend, from `OHS Hub <notifications@ihub-sa.co.za>` using the send-only key "OHS Hub (Supabase)" |
| AI | Anthropic Claude Sonnet 5.5 (Stage 5; key not yet added) |

## Steps that need you, in the Supabase dashboard

Only you can do these, because they need the dashboard or a secret value.

1. **Edge Function secret.** Project Settings → Edge Functions → Secrets → add `RESEND_API_KEY` = the Resend key named "OHS Hub (Supabase)" (it was shown to you once in the chat). Until this is set, enquiries and invitations are saved but no email goes out.
2. **Auth URLs.** Authentication → URL Configuration:
   - Site URL: `https://ihubsa.github.io/ohs-hub/`
   - Redirect URLs: add `https://ihubsa.github.io/ohs-hub/**`
3. **Auth emails through Resend.** Authentication → Emails → SMTP Settings → enable custom SMTP:
   host `smtp.resend.com`, port `465`, username `resend`, password = the same Resend key, sender email `notifications@ihub-sa.co.za`, sender name `OHS Hub`.
   Without this, Supabase's built-in mailer only sends sign-up emails to members of your Supabase organisation, with a very low hourly limit.

## Website on GitHub Pages

1. Create a GitHub repository named **`ohs-hub`** under `ihubsa`. The name matters: links in emails point to `https://ihubsa.github.io/ohs-hub/`.
2. Upload everything in this folder through the GitHub web interface (Add file → Upload files), keeping the folder structure.
3. Go to Settings → Pages → Deploy from a branch → `main` / root.
4. If you later use a custom domain, update `SITE_URL` in `tools/build_site.py` (then rebuild), add the `SITE_URL` and `ALLOWED_ORIGINS` Edge Function secrets, and update the Auth URLs above.

## Make yourself a platform admin (after you register)

```sql
insert into public.platform_admins (user_id)
select id from auth.users where email = 'ihubsa@gmail.com';
```

## Tests

- **Database security** (in-memory Postgres; no live project needed):
  `cd supabase/tests && npm i @electric-sql/pglite@0.2.17 && node rls.test.mjs ../migrations`, which should print `54 passed, 0 failed`.
- **Live isolation check:** 20 cross-company checks were run inside the live database on 28 Oct 2026 with throwaway users, and all passed. The test data was deleted afterwards.
- **App click-through:** `tests/app.e2e.cjs` drives the real app in headless Chromium against an in-memory API stand-in (26 checks).

## Intentional security-advisor items

- *Signed-in users can execute SECURITY DEFINER functions* (15). These are the row-level-security helpers (`is_member`, `has_role` and similar), which answer questions about the caller's own access only, and the app RPCs (`create_organisation`, `accept_invitation`, `decide_document_version`, `next_reference`), which each check permissions themselves.
- *RLS enabled, no policy* on `reference_counters`. This is deliberate: only the `next_reference` function may touch it.

## Pre-launch checklist

- [ ] The three dashboard steps above are done
- [ ] A test enquiry from the live site reaches both inboxes
- [ ] A test registration receives its verification email
- [ ] Legal adviser has reviewed `privacy.html`, `terms.html` and `popia.html`, and the [bracketed] items are filled in
- [ ] Plan prices are set (or left as "Contact us for pricing")
- [ ] Upgrade Supabase to Pro before the first paying customer (Free projects pause after a week of inactivity and have no backups)
