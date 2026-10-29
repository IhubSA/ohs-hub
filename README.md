# OHS Hub

Occupational health and safety management for South African workplaces: risk assessments, inspections, incidents, corrective actions, document control, a legal register and AI-assisted safety documentation.

Built by iHubSA on GitHub Pages, Supabase (Postgres, Auth, Storage, Edge Functions) and Resend.

| Folder | Contents |
|---|---|
| `/` | Public marketing website (static HTML) |
| `assets/` | Shared CSS, JavaScript, logo and images |
| `supabase/migrations/` | Database schema, security rules and reference data (run in order) |
| `supabase/functions/` | Edge Functions: `contact-submit`, `send-notifications` |
| `supabase/tests/` | Automated tenant-isolation and workflow tests |
| `docs/` | `IMPLEMENTATION_PLAN.md` (architecture, schema, roles, stages) and `DEPLOYMENT.md` |
| `tools/build_site.py` | Regenerates the marketing pages from one shared header/footer |

## Status

- **Stage 1 (plan and schema):** complete, with 48 security tests passing.
- **Stage 2 (marketing website):** complete. The contact form, sign-in and registration activate once `assets/js/config.js` is filled in.
- **Stage 3 onwards:** the authenticated app at `/app/` hasn't been built yet. See `docs/IMPLEMENTATION_PLAN.md`.

No secrets are stored in this repository.
