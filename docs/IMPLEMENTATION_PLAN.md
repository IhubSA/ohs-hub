# OHS Hub — Implementation Plan (Stage 1)

_Prepared 28 October 2026 · iHubSA_

## 1. Repository assessment

The `OHS Hub` folder was empty, so there was no existing framework, code or deployment to keep. Everything here is new.

## 2. Technology stack

| Layer | Choice | Why |
|---|---|---|
| Hosting | **GitHub Pages** (static) | Matches the existing iHubSA deployment workflow: upload files through the GitHub web interface. |
| Front end | **Plain HTML, CSS and ES modules. No build step.** | GitHub Pages can't run Next.js server features. Without a build you can upload changed files directly. The code is split into modules so it stays maintainable. |
| Database | **Supabase Postgres** | Includes RLS on every table. |
| Auth | **Supabase Auth** | Email and password, email verification, password reset. |
| Files | **Supabase Storage**, private `org-files` bucket | Access through signed URLs, 10 MB limit and a MIME allow-list. |
| Server logic | **Supabase Edge Functions** (Deno/TypeScript) | Handles the contact form, AI generation, email sending and invitations. Secrets stay on the server. |
| Email | **Resend** (Pro), sending from `ihub-sa.co.za`, which is already verified | |
| AI | **Anthropic Claude Sonnet 5.5**, called **only** from an Edge Function | Decided 28 Oct 2026 |
| Scheduling | `pg_cron` runs `run_daily_reminders()` at 06:00 SAST and the email flush every 10 minutes | |

The spec suggested React/Next.js with Tailwind. That would need either a different host (such as Vercel) or a GitHub Actions build. If you later want a Vercel/Next.js version, the database, RLS and Edge Functions carry over unchanged.

## 3. Project structure

```
/                         Marketing site (public)
  index.html  features.html  industries.html  pricing.html  resources.html
  about.html  contact.html  faq.html  privacy.html  terms.html  popia.html
  signin.html  register.html  reset-password.html  404.html
  sitemap.xml  robots.txt
  assets/css/site.css     Design system (tokens, components)
  assets/js/config.js     Public Supabase URL + publishable (anon) key ONLY
  assets/js/site.js       Navigation, risk-matrix demo, contact form, pricing loader
  assets/js/auth.js       Sign in / register / reset
  assets/img/             Logo, favicon, social image
/app/                     Authenticated OHS application (Stage 3+)
/supabase/migrations/     Repeatable SQL migrations (run in order)
/supabase/functions/      Edge Functions (contact-submit, send-notifications, ai-generate, invite-user)
/supabase/tests/          Automated RLS / workflow tests (run with Node)
/docs/                    This plan, deployment guide
```

## 4. Architecture

```
Browser (GitHub Pages) ──supabase-js (anon key + user JWT)──► Postgres (RLS on every table)
        │                                                        ▲
        └──fetch──► Edge Functions (service role, secrets) ──────┘
                        ├─► Resend API (email)
                        └─► AI provider API (structured JSON output)
pg_cron ──► run_daily_reminders() ──► notifications table ──► send-notifications fn ──► Resend
```

- **Tenant isolation is enforced in Postgres.** Every tenant table has `org_id` and RLS policies that check membership through `SECURITY DEFINER` helper functions (`is_member`, `has_role`, `is_staff`, `is_editor`, `in_site_scope`). An `org_id` sent by the browser is never trusted on its own. Triggers also block moving a record to another organisation, and block a child row from pointing to another tenant's parent.
- **Risk scores are calculated deterministically** by a database trigger, using likelihood × severity and the organisation's configured bands. AI can suggest hazards and controls but never produces a score.
- **Controlled documents.** Approved versions are immutable, and a new revision creates a new version. The previous version becomes `obsolete` but is kept. Self-approval is blocked when independent approval is on (the default).
- **Corrective actions** can't close without effective verification by someone other than the responsible person. The database records who verified, and this can't be spoofed.
- **Notifications** are created in the database, either by event triggers or by the daily sweep. A `dedupe_key` (unique per user) stops duplicates, and `email_status` tracks Resend delivery.
- **AI generation** goes through `ai-generate`. The function checks membership and the monthly usage limit, builds a structured prompt from a template, and asks the model for JSON that matches a section schema. It validates required sections, flags missing information, marks legal references as `unverified` unless they match a verified row in `legal_requirements`, then stores the job and the draft. Drafts always start as `draft` and need human approval.

## 5. Database schema (applied by migrations 1–4)

**Foundation:** `organisations`, `user_profiles`, `organisation_memberships` (role, site scope, confidential/approval flags), `organisation_invitations` (stores the hashed token), `sites`, `departments`, `employees`, `contractors`, `subscription_plans`, `organisation_subscriptions`, `usage_counters`, `reference_counters`, `platform_admins`, `platform_settings`, `audit_logs`.

**Modules:** `risk_methodologies`, `risk_assessments`, `risk_assessment_items`, `risk_register_entries`, `record_links`, `document_categories`, `documents`, `document_versions`, `document_approvals`, `document_acknowledgements`, `inspection_templates`, `inspection_template_items`, `inspection_schedules`, `inspections`, `inspection_responses`, `incidents`, `incident_persons`, `incident_witnesses`, `incident_evidence`, `incident_investigations`, `investigation_findings`, `statutory_report_rules`, `statutory_reports`, `corrective_actions`, `action_evidence`, `legal_frameworks`, `legal_requirements`, `compliance_assessments`, `training_courses`, `competency_requirements`, `training_records`, `equipment`, `equipment_maintenance`, `ppe_issues`, `contractor_documents`, `notification_rules`, `notifications`, `ai_generation_jobs`, `contact_enquiries`.

**Key server-side functions:** `create_organisation`, `accept_invitation`, `next_reference` (for example `INC-2026-0001`), `decide_document_version`, `run_daily_reminders`, `org_limit` / `org_has_feature` (entitlements), and the site/user limit triggers.

The spec suggested `subscriptions`; the schema uses `organisation_subscriptions` with per-tenant overrides for Enterprise. Polymorphic links (risk ↔ SOP ↔ inspection template) use one `record_links` table instead of many join tables.

### Tested (`supabase/tests/rls.test.mjs`, 48 checks, all passing)

- Company B can't read, insert into, or move records into Company A. Cross-tenant child rows are rejected.
- Anonymous visitors can read public plans only, not organisations or enquiries.
- Site limits come from the plan, and the reference number format is correct.
- Deterministic risk scoring: 4×5 = 20 is "Extreme" and 2×3 = 6 is "Medium".
- Employees can't see or create risk assessments, but can report incidents and see their own.
- Confidential incidents are hidden from safety officers and visible to admins. A user can't report an incident as someone else.
- Self-approval is blocked, only the assigned reviewer can decide, the approved version becomes current, and employees see approved documents only.
- Actions: can't close without verification, the responsible person can't self-verify or reassign, and the verifier is recorded.
- An organisation can't lose its last admin, and non-admins can't add members.
- Notifications are private to each user and can only be marked as read. Users can't run the reminder sweep.
- Storage: uploads are allowed only under your own organisation's path, and other tenants' files are hidden.
- Audit rows are written, and employees can't read the audit log.

## 6. Roles and permissions

| Capability | Org Admin | OHS Manager | Safety Officer | Supervisor | Employee | Auditor |
|---|---|---|---|---|---|---|
| Manage users, sites, departments | ✔ | | | | | |
| Configure methodology, rules, courses | ✔ | ✔ | | | | |
| Create/edit risk, documents, templates | ✔ | ✔ | ✔ | | | |
| Conduct inspections | ✔ | ✔ | ✔ | assigned | | |
| Report incidents | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| View confidential incidents | ✔ | ✔ | if granted | if granted | own | if granted |
| Approve documents | ✔ | ✔ | if granted | if granted | | |
| Verify corrective actions | ✔ | ✔ | ✔ | | | |
| Work on own assigned actions | ✔ | ✔ | ✔ | ✔ | ✔ | |
| View records | all | all | all | own sites | approved docs, own items | all (read-only) |
| Audit log | ✔ | ✔ | | | | ✔ |

Platform administrators (iHubSA) manage plans, the legal library and platform settings. They deliberately have **no blanket RLS bypass** on customer data.

## 7. Stages

1. **Plan and schema:** done (this document and migrations 1–4).
2. **Marketing website:** done. All pages, SEO, sitemap, the contact form and its Edge Function are built.
3. **Auth and multi-tenancy:** done. The live Supabase project has migrations 1–10 applied (5–10 add hardening, performance, a scheduled email flush, a profile-email guard and a fix that lets organisations be deleted). The app includes a setup wizard, dashboard, company, sites and departments, people (employees and contractors), team and roles with email invitations, notifications and profile. Isolation was tested on the live project.
4. **Core modules:** dashboard (real counts only), document control, SOP builder, risk assessments and register, inspections (mobile capture with an offline queue), incidents and investigations, corrective actions.
5. **AI and reporting:** `ai-generate` Edge Function, section regeneration, validation, monthly and quarterly reports, PDF/CSV export, AI summaries clearly labelled as such.
6. **Additional modules:** legal register admin and verification workflow, training matrix, contractors, equipment and PPE, emergency preparedness, platform plan admin.
7. **Testing and deployment:** end-to-end workflow tests, mobile checks, secret scan, final deployment guide.

## 8. Decisions needed

| # | Decision | Proposed default |
|---|---|---|
| 1 | Database location | **Decided:** new dedicated Supabase project "OHS Hub" (Free plan while building). |
| 2 | AI provider | **Decided:** Anthropic Claude Sonnet 5.5. |
| 3 | Public domain | GitHub Pages URL `https://ihubsa.github.io/ohs-hub/` for now. Update `sitemap.xml`, `robots.txt` and canonical tags if a custom domain is chosen. |
| 4 | Pricing | Plans are stored with **no prices** and show "Contact us for pricing" until commercial prices are set in the admin screen. |
| 5 | Payment provider | None. `billing_status` stays `not_configured` (PayFast, Paystack and Stripe are all possible later). |
| 6 | Sender addresses | `OHS Hub <notifications@ihub-sa.co.za>`, with reply-to `enquiries@ihub-sa.co.za`. Contact-form leads go to `enquiries@ihub-sa.co.za` and `ihubsa@gmail.com`. |
| 7 | Legal pages | The Privacy, Terms and POPIA texts are drafts and need review by a legal adviser before launch. Items in [BRACKETS] must be filled in. |
| 8 | Legal requirements library | Empty by design. Only the two Acts are listed. Individual requirements need to be loaded and verified by a competent person through the admin process. |

## 9. Known limitations (honest status)

- The OHS modules (risk, inspections, incidents, actions, documents) aren't built yet. That's Stage 4.
- The app was click-tested against an API stand-in. A live end-to-end run needs the dashboard steps in DEPLOYMENT.md to be completed first.
- No real statutory reporting rules are seeded. They must be configured and verified before use.
- Offline inspection capture is designed into the schema (with a `client_updated_at` conflict guard), but the client-side queue is a Stage 4 task.
