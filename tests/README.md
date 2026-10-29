# OHS Hub tests

| Test | What it checks | How to run |
|---|---|---|
| `../supabase/tests/rls.test.mjs` | 84 database security and workflow rules (tenant isolation, approvals, verification, locks) on an in-memory Postgres | `npm i @electric-sql/pglite@0.2.17 && node rls.test.mjs ../migrations` |
| `stage4.e2e.cjs` | 44 end-to-end checks: four users (admin, OHS manager, safety officer, employee) click through risk assessments, the register, checklists, inspections, actions, incidents, investigations and documents in a real browser against a **real Postgres** with all migrations and RLS | Start Postgres on port 54329 (user `postgres`, password `pw`), run `node setup-test-db.mjs ../supabase/migrations`, serve the repo root on port 8768, then `node stage4.e2e.cjs` |
| `app.e2e.cjs` | 26 click-through checks of setup, company, sites, people and team against an in-memory API stand-in | Serve the repo root on port 8767, then `node app.e2e.cjs` |

`test-api-shim.cjs` is a small stand-in for Supabase's REST API used only by the end-to-end test. Every request runs as the signed-in user under the `authenticated` role, so row-level security, triggers and database functions behave as they do on Supabase.
