# OHS Hub

Occupational health and safety management for South African workplaces: risk assessments, inspections, incidents, corrective actions, document control, a legal register and AI-assisted safety documentation.

Built by iHubSA on GitHub Pages, Supabase (Postgres, Auth, Storage, Edge Functions) and Resend.

| Folder | Contents |
|---|---|
| `/` | Public marketing website (static HTML) |
| `assets/` | Shared CSS, JavaScript, logo and images |
| `supabase/migrations/` | Database schema, security rules and reference data (run in order) |
| `app/` | The signed-in OHS Hub application |
| `supabase/functions/` | Edge Functions: `contact-submit`, `send-notifications`, `invite-user`, `ai-generate` |
| `tests/` | End-to-end and click-through tests (see `tests/README.md`) |
| `supabase/tests/` | Automated tenant-isolation and workflow tests |
| `docs/` | `IMPLEMENTATION_PLAN.md` (architecture, schema, roles, stages) and `DEPLOYMENT.md` |
| `tools/build_site.py` | Regenerates the marketing pages from one shared header/footer |

## Status

- **Stage 1 (plan and schema):** complete.
- **Stage 2 (marketing website):** complete.
- **Stage 3 (accounts, companies, sites, people, team and roles):** complete. The app is at `/app/` and connected to the live Supabase project.
- **Stage 4 (core OHS modules):** complete. Dashboard, incidents and investigations, corrective actions, inspections (checklists, schedules, mobile capture), risk assessments, risk register and document control.
- **Stage 5 (AI drafting and reports):** complete. AI drafting for documents, hazards, checklists and investigations, plus OHS reports with PDF, Word and CSV export. AI switches on once the Anthropic key is added (see `docs/DEPLOYMENT.md`).
- **Phone and install (v1.5.0):** the app works on phones with a bottom tab bar, and can be installed on phones, tablets and computers from the **Install app** button. The version number is in the menu and on My profile.
- **Stage 6 (v1.6.0, additional modules):** complete. Legal register with verification and per-site compliance, training matrix, contractor management, equipment and PPE, emergency preparedness, and the iHubSA platform admin screen.
- **Stage 7 (final testing and launch):** next.
- Tests: 150 database security and workflow checks, 44 Stage 4, 34 Stage 5, 55 Stage 6 and 63 phone end-to-end checks against a real Postgres, and 26 app click-through checks, all passing. See `tests/README.md`.

No secrets are stored in this repository.
