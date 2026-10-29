import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';

const dir = process.argv[2];
process.on("unhandledRejection", e => { console.log("UNCAUGHT:", e.message); process.exit(1); });
const db = new PGlite();
let pass = 0, fail = 0;
const ok = (name, cond, extra='') => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra); } };

// --- Supabase stubs ---
await db.exec(`
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; create schema storage;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;
create schema vault; create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text, description text);
create function vault.create_secret(s text, n text, d text) returns uuid language sql as $$ insert into vault.secrets(name, secret, description) values (n, s, d) returning id $$;
create view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets;
create schema cron; create function cron.schedule(a text, b text, c text) returns bigint language sql as $$ select 1::bigint $$;

grant usage on schema public, auth, storage to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
`);

for (const f of fs.readdirSync(dir).sort()) {
  const sql = fs.readFileSync(path.join(dir, f), 'utf8');
  try { await db.exec(sql); console.log('applied', f); }
  catch (e) { console.log('MIGRATION ERROR in', f, e.message); process.exit(1); }
}
await db.exec(`grant select, insert, update, delete on all tables in schema public to authenticated;
  grant usage, select on all sequences in schema public to authenticated;
  grant select on public.subscription_plans to anon;
  grant select, insert, delete on storage.objects to authenticated;`);

const A='00000000-0000-0000-0000-00000000000a', B='00000000-0000-0000-0000-00000000000b', C='00000000-0000-0000-0000-00000000000c', D='00000000-0000-0000-0000-00000000000d';
await db.exec(`insert into auth.users(id,email,raw_user_meta_data) values
 ('${A}','a@a.co.za','{"full_name":"Alice"}'),('${B}','b@b.co.za','{}'),('${C}','c@a.co.za','{}'),('${D}','d@a.co.za','{}')`);

async function as(uid, sql, params=[]) {
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${uid||''}', false);`);
  try { const r = await db.query(sql, params); return r.rows; }
  finally { await db.exec('reset role;'); }
}
async function asErr(uid, sql, params=[]) { try { await as(uid, sql, params); return null; } catch (e) { return e.message; } }

ok('profile auto-created', (await db.query(`select full_name from user_profiles where id='${A}'`)).rows[0]?.full_name === 'Alice');

const orgA = (await as(A, `select public.create_organisation('Alpha Construction','construction') id`))[0].id;
const orgB = (await as(B, `select public.create_organisation('Beta Mining','mining') id`))[0].id;
ok('orgs created', orgA && orgB);
ok('trial subscription on professional', (await as(A, `select p.code from organisation_subscriptions s join subscription_plans p on p.id=s.plan_id where s.org_id='${orgA}'`))[0]?.code === 'professional');
ok('default methodology', (await as(A, `select count(*)::int n from risk_methodologies where org_id='${orgA}'`))[0].n === 1);
ok('notification rules seeded', (await as(A, `select count(*)::int n from notification_rules where org_id='${orgA}'`))[0].n === 12);

// add C as employee, D as safety officer in org A (as admin A)
await as(A, `insert into organisation_memberships(org_id,user_id,role) values ('${orgA}','${C}','employee'),('${orgA}','${D}','safety_officer')`);

// Sites
const siteA = (await as(A, `insert into sites(org_id,name) values ('${orgA}','Head Office') returning id`))[0].id;
ok('B cannot see A sites', (await as(B, `select * from sites where org_id='${orgA}'`)).length === 0);
ok('B cannot insert into A', (await asErr(B, `insert into sites(org_id,name) values ('${orgA}','Hack')`)) !== null);
ok('B cannot see org A', (await as(B, `select * from organisations`)).length === 1);
ok('anon cannot read organisations', (await asErr(null, `select * from organisations`)) !== null);
ok('anon reads plans', (await as(null, `select code from subscription_plans`)).length === 4);
ok('anon cannot call create_organisation', (await asErr(null, `select public.create_organisation('Hack')`)) !== null);
ok('anon cannot call helper functions', (await asErr(null, `select public.is_member('${orgA}')`)) !== null);
ok('anon cannot read contact enquiries', (await asErr(null, `select * from contact_enquiries`)) !== null);

// Site limit: professional max 3 sites
await as(A, `insert into sites(org_id,name) values ('${orgA}','Site 2'),('${orgA}','Site 3')`);
ok('site limit enforced', (await asErr(A, `insert into sites(org_id,name) values ('${orgA}','Site 4')`))?.includes('plan allows'));

// Risk assessment scoring
const meth = (await as(A, `select id from risk_methodologies where org_id='${orgA}'`))[0].id;
const ref = (await as(D, `select public.next_reference('${orgA}','RA') r`))[0].r;
ok('reference format', /^RA-\d{4}-0001$/.test(ref), ref);
const ra = (await as(D, `insert into risk_assessments(org_id,reference,title,assessment_type,methodology_id,site_id) values ('${orgA}','${ref}','Working at height','task_specific','${meth}','${siteA}') returning id`))[0].id;
const item = (await as(D, `insert into risk_assessment_items(assessment_id,org_id,hazard,initial_likelihood,initial_severity,residual_likelihood,residual_severity) values ('${ra}','${orgA}','Fall from ladder',4,5,2,3) returning initial_score, initial_rating, residual_score, residual_rating`))[0];
ok('deterministic scoring', item.initial_score === 20 && item.initial_rating === 'Extreme' && item.residual_score === 6 && item.residual_rating === 'Medium', JSON.stringify(item));
ok('employee cannot see risk assessments', (await as(C, `select * from risk_assessments`)).length === 0);
ok('employee cannot create risk assessment', (await asErr(C, `insert into risk_assessments(org_id,reference,title,assessment_type,methodology_id) values ('${orgA}','X','Xxx','baseline','${meth}')`)) !== null);
// B tries to attach item to A's assessment under B's org
ok('cross-org child blocked', (await asErr(B, `insert into risk_assessment_items(assessment_id,org_id,hazard,initial_likelihood,initial_severity) values ('${ra}','${orgB}','x',1,1)`)) !== null);

// Incidents: employee reports, confidential
const inc = (await as(C, `insert into incidents(org_id,reference,category,occurred_at,title,description,site_id,reported_by) values ('${orgA}',public.next_reference('${orgA}','INC'),'near_miss',now(),'Slipped on wet floor','Wet floor near canteen','${siteA}','${C}') returning id`))[0].id;
ok('employee sees own incident', (await as(C, `select * from incidents`)).length === 1);
ok('manager notified of incident', (await db.query(`select count(*)::int n from notifications where user_id='${A}' and event_type='incident.reported'`)).rows[0].n === 1);
const conf = (await as(C, `insert into incidents(org_id,reference,category,occurred_at,title,description,is_confidential,reported_by) values ('${orgA}','INC-C','other',now(),'Confidential matter','details',true,'${C}') returning id`))[0].id;
ok('safety officer cannot see confidential', (await as(D, `select id from incidents where id='${conf}'`)).length === 0);
ok('admin sees confidential', (await as(A, `select id from incidents where id='${conf}'`)).length === 1);
ok('B cannot see A incidents', (await as(B, `select * from incidents`)).length === 0);
ok('employee cannot spoof reporter', (await asErr(C, `insert into incidents(org_id,reference,category,occurred_at,title,description,reported_by) values ('${orgA}','INC-X','other',now(),'Spoofed','x','${A}')`)) !== null);

// Documents: self approval blocked, approval flow
const doc = (await as(D, `insert into documents(org_id,reference,title,doc_type) values ('${orgA}','SOP-001','Ladder safety SOP','sop') returning id`))[0].id;
const ver = (await as(D, `insert into document_versions(document_id,org_id,version_number,content,status) values ('${doc}','${orgA}',1,'{"purpose":"x"}','in_review') returning id`))[0].id;
ok('self-approval blocked', (await asErr(D, `insert into document_approvals(version_id,org_id,reviewer_id) values ('${ver}','${orgA}','${D}')`)) !== null);
const appr = (await as(D, `insert into document_approvals(version_id,org_id,reviewer_id) values ('${ver}','${orgA}','${A}') returning id`))[0].id;
ok('employee cannot see draft doc', (await as(C, `select * from documents`)).length === 0);
ok('only reviewer decides', (await asErr(D, `select public.decide_document_version('${appr}','approved',null)`)) !== null);
await as(A, `select public.decide_document_version('${appr}','approved','Looks good')`);
ok('doc approved & current', (await as(A, `select status, current_version_id from documents where id='${doc}'`))[0].current_version_id === ver);
ok('employee sees approved doc', (await as(C, `select * from documents`)).length === 1);
ok('approved version locked', (await asErr(A, `update document_versions set content='{"x":1}' where id='${ver}'`)) !== null || (await as(A, `select content->>'purpose' p from document_versions where id='${ver}'`))[0].p === 'x');
ok('author notified of approval', (await db.query(`select count(*)::int n from notifications where user_id='${D}' and event_type='document.approved'`)).rows[0].n === 1);

// Corrective actions
const act = (await as(D, `insert into corrective_actions(org_id,reference,source_type,source_id,title,responsible_id,due_date) values ('${orgA}','CA-1','incident','${inc}','Install anti-slip mats','${C}',current_date+7) returning id`))[0].id;
ok('responsible notified', (await db.query(`select count(*)::int n from notifications where user_id='${C}' and event_type='action.assigned'`)).rows[0].n === 1);
ok('employee sees assigned action', (await as(C, `select id from corrective_actions`)).length === 1);
ok('cannot close without verification', (await asErr(C, `update corrective_actions set status='closed' where id='${act}'`))?.includes('verification'));
ok('responsible cannot self-verify', (await asErr(C, `update corrective_actions set verification_outcome='effective', verified_at=now() where id='${act}'`)) !== null);
ok('responsible cannot reassign', (await asErr(C, `update corrective_actions set due_date=current_date+90 where id='${act}'`)) !== null);
await as(C, `update corrective_actions set status='awaiting_verification' where id='${act}'`);
await as(D, `update corrective_actions set verification_outcome='effective', verified_at=now() where id='${act}'`);
await as(D, `update corrective_actions set status='closed' where id='${act}'`);
ok('action closed after verification', (await as(D, `select status, verified_by from corrective_actions where id='${act}'`))[0].verified_by === D);

// Membership safety
ok('cannot remove last admin', (await asErr(A, `update organisation_memberships set role='ohs_manager' where org_id='${orgA}' and user_id='${A}'`)) !== null);
ok('non-admin cannot add members', (await asErr(D, `insert into organisation_memberships(org_id,user_id,role) values ('${orgA}','${B}','org_admin')`)) !== null);
ok('cannot move record to other org', (await asErr(A, `update sites set org_id='${orgB}' where id='${siteA}'`)) !== null);

// Profile email cannot be changed by the user
await as(C, `update user_profiles set email='hijack@evil.example', full_name='Cee' where id='${C}'`);
const pc = (await db.query(`select email, full_name from user_profiles where id='${C}'`)).rows[0];
ok('profile email locked, name editable', pc.email === 'c@a.co.za' && pc.full_name === 'Cee', JSON.stringify(pc));
ok('cannot set default org to foreign org', (await asErr(C, `update user_profiles set default_org_id='${orgB}' where id='${C}'`)) !== null);
// Notifications: own only; can mark read only
ok('B sees no A notifications', (await as(B, `select * from notifications`)).length === 0);
await as(A, `update notifications set read_at=now() where user_id='${A}'`);
ok('cannot alter notification text', (await asErr(A, `update notifications set title='x' where user_id='${A}'`)) !== null);

// Reminders
await db.exec(`update corrective_actions set status='open', due_date=current_date-1, requires_verification=false where id='${act}'`).catch(e=>console.log(e.message));
const n = (await db.query(`select public.run_daily_reminders() n`)).rows[0].n;
ok('reminder sweep runs', n >= 1, n);
ok('client cannot run reminder sweep', (await asErr(A, `select public.run_daily_reminders()`)) !== null);

// Storage
ok('member can upload to own org path', (await asErr(C, `insert into storage.objects(bucket_id,name,owner) values ('org-files','${orgA}/incidents/x.jpg','${C}')`)) === null);
ok('cannot upload to other org path', (await asErr(B, `insert into storage.objects(bucket_id,name,owner) values ('org-files','${orgA}/incidents/y.jpg','${B}')`)) !== null);
ok('B cannot read A files', (await as(B, `select * from storage.objects`)).length === 0);

// Audit
ok('audit log written', (await db.query(`select count(*)::int n from audit_logs where org_id='${orgA}'`)).rows[0].n > 5);
ok('employee cannot read audit', (await as(C, `select * from audit_logs`)).length === 0);

// Organisation deletion (e.g. POPIA erasure) must cascade cleanly
ok('organisation can be deleted', (await db.query(`delete from organisations where id='${orgA}'`).then(()=>null).catch(e=>e.message)) === null);
ok('org records removed', (await db.query(`select count(*)::int n from incidents where org_id='${orgA}'`)).rows[0].n === 0);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
