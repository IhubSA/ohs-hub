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


// ===== Stage 4 workflow guards (migration 11) =====
const doc2 = (await as(D, `insert into documents(org_id,reference,title,doc_type) values ('${orgA}','SOP-002','Forklift SOP','sop') returning id`))[0].id;
const ver2 = (await as(D, `insert into document_versions(document_id,org_id,version_number,content) values ('${doc2}','${orgA}',1,'{"purpose":"y"}') returning id`))[0].id;
ok('cannot self-approve version by status edit', (await asErr(D, `update document_versions set status='approved' where id='${ver2}'`)) !== null);
ok('cannot mark document approved directly', (await asErr(D, `update documents set status='approved' where id='${doc2}'`)) !== null);
ok('cannot insert pre-approved document', (await asErr(D, `insert into documents(org_id,reference,title,doc_type,status) values ('${orgA}','SOP-X','Sneaky','sop','approved')`)) !== null);
ok('author cannot be own reviewer', (await asErr(D, `select public.submit_document_version('${ver2}', array['${D}']::uuid[])`)) !== null);
ok('employee cannot be reviewer', (await asErr(D, `select public.submit_document_version('${ver2}', array['${C}']::uuid[])`)) !== null);
await as(D, `select public.submit_document_version('${ver2}', array['${A}']::uuid[])`);
ok('submitted for review', (await as(D, `select status from document_versions where id='${ver2}'`))[0].status === 'in_review');
const ap2 = (await as(A, `select id from document_approvals where version_id='${ver2}' and decision='pending'`))[0].id;
ok('reject needs comment', (await asErr(A, `select public.decide_document_version('${ap2}','rejected','')`)) !== null);
await as(A, `select public.decide_document_version('${ap2}','rejected','Add PPE section')`);
ok('rejected back to draft', (await as(D, `select status from document_versions where id='${ver2}'`))[0].status === 'draft');
await as(D, `update document_versions set content='{"purpose":"y","ppe":"boots"}' where id='${ver2}'`);
await as(D, `select public.submit_document_version('${ver2}', array['${A}']::uuid[])`);
const ap3 = (await as(A, `select id from document_approvals where version_id='${ver2}' and decision='pending'`))[0]?.id;
ok('resubmission opens new review', !!ap3);
await as(A, `select public.decide_document_version('${ap3}','approved','OK')`);
ok('document approved via review', (await as(D, `select status from documents where id='${doc2}'`))[0].status === 'approved');
const ver3 = (await as(D, `insert into document_versions(document_id,org_id,version_number,content) values ('${doc2}','${orgA}',2,'{"purpose":"y2"}') returning id`))[0].id;
ok('revision draft keeps effective version', (await as(C, `select current_version_id from documents where id='${doc2}'`))[0].current_version_id === ver2);
ok('employee cannot see revision draft', (await as(C, `select id from document_versions where id='${ver3}'`)).length === 0);

// Risk assessment approval
ok('safety officer cannot approve RA', (await asErr(D, `update risk_assessments set status='approved' where id='${ra}'`)) !== null);
await as(A, `update risk_assessments set status='approved' where id='${ra}'`);
ok('manager approves RA', (await as(A, `select approver_id from risk_assessments where id='${ra}'`))[0].approver_id === A);
ok('approved RA hazards locked', (await asErr(D, `insert into risk_assessment_items(assessment_id,org_id,hazard,initial_likelihood,initial_severity) values ('${ra}','${orgA}','Noise',2,2)`)) !== null);
await as(A, `update risk_assessments set status='draft' where id='${ra}'`);
ok('reopened RA clears approval', (await as(A, `select approver_id from risk_assessments where id='${ra}'`))[0].approver_id === null);
const ra2 = (await as(A, `insert into risk_assessments(org_id,reference,title,assessment_type,methodology_id) values ('${orgA}','RA-X','Office baseline','baseline','${meth}') returning id`))[0].id;
ok('assessor cannot approve own RA', (await asErr(A, `update risk_assessments set status='approved' where id='${ra2}'`)) !== null);

// Inspection templates and inspections
const tpl = (await as(D, `insert into inspection_templates(org_id,title,category) values ('${orgA}','Workshop checklist','workshops') returning id`))[0].id;
const ti1 = (await as(D, `insert into inspection_template_items(template_id,org_id,question,sort_order) values ('${tpl}','${orgA}','Guards fitted?',1) returning id`))[0].id;
const ti2 = (await as(D, `insert into inspection_template_items(template_id,org_id,question,sort_order) values ('${tpl}','${orgA}','Floors clear?',2) returning id`))[0].id;
ok('cannot inspect with draft checklist', (await asErr(D, `insert into inspections(org_id,reference,template_id,inspector_id) values ('${orgA}','INS-0','${tpl}','${D}')`)) !== null);
ok('safety officer cannot approve checklist', (await asErr(D, `update inspection_templates set status='approved' where id='${tpl}'`)) !== null);
await as(A, `update inspection_templates set status='approved' where id='${tpl}'`);
ok('approved checklist locked', (await asErr(D, `insert into inspection_template_items(template_id,org_id,question) values ('${tpl}','${orgA}','Extra?')`)) !== null);
const insp = (await as(D, `insert into inspections(org_id,reference,template_id,inspector_id,site_id,status) values ('${orgA}','INS-1','${tpl}','${D}','${siteA}','in_progress') returning id`))[0].id;
await as(D, `insert into inspection_responses(inspection_id,org_id,template_item_id,question,response) values ('${insp}','${orgA}','${ti1}','Guards fitted?','compliant'),('${insp}','${orgA}','${ti2}','Floors clear?','non_compliant')`);
const cnt = (await as(D, `select compliant_count, non_compliant_count from inspections where id='${insp}'`))[0];
ok('database counts responses', cnt.compliant_count === 1 && cnt.non_compliant_count === 1, JSON.stringify(cnt));
await as(D, `update inspections set status='completed', completed_at=now() where id='${insp}'`);
ok('completed inspection locked', (await asErr(D, `update inspection_responses set response='compliant' where inspection_id='${insp}'`)) !== null);

// Investigations
const inv = (await as(D, `insert into incident_investigations(incident_id,org_id,investigator_id,status) values ('${inc}','${orgA}','${D}','assigned') returning id`))[0].id;
ok('incident moves to under investigation', (await as(A, `select status from incidents where id='${inc}'`))[0].status === 'under_investigation');
ok('cannot close with open investigation', (await asErr(A, `update incidents set status='closed' where id='${inc}'`)) !== null);
await as(D, `update incident_investigations set status='submitted', summary='Wet floor from leaking urn' where id='${inv}'`);
ok('incident awaiting approval', (await as(A, `select status from incidents where id='${inc}'`))[0].status === 'awaiting_approval');
ok('manager told investigation submitted', (await db.query(`select count(*)::int n from notifications where user_id='${A}' and event_type='investigation.submitted'`)).rows[0].n === 1);
ok('investigator cannot approve own', (await asErr(D, `update incident_investigations set status='approved' where id='${inv}'`)) !== null);
await as(A, `update incident_investigations set status='approved' where id='${inv}'`);
ok('safety officer cannot close incident', (await asErr(D, `update incidents set status='closed' where id='${inc}'`)) !== null);
await as(A, `update incidents set status='closed' where id='${inc}'`);
ok('manager closes incident', (await as(A, `select status, closed_at from incidents where id='${inc}'`))[0].closed_at !== null);

// Action verification notification
const act2 = (await as(D, `insert into corrective_actions(org_id,reference,source_type,title,responsible_id,due_date) values ('${orgA}','CA-2','inspection','Fix floor drain','${C}',current_date+5) returning id`))[0].id;
await as(C, `update corrective_actions set status='awaiting_verification' where id='${act2}'`);
ok('verifiers notified', (await db.query(`select count(*)::int n from notifications where user_id='${D}' and event_type='action.awaiting_verification' and record_id='${act2}'`)).rows[0].n === 1);


// ===== Stage 5: AI controls and reports (migration 12) =====
const begin = (u, task='document') => db.query(`select public.ai_begin_job('${u}','${orgA}','${task}','sop',null,'{}') id`).then(r=>r.rows[0].id).catch(e=>'ERR:'+e.message);
ok('AI off until platform switch', String(await begin(A)).includes('not been switched on'));
await db.exec(`update platform_settings set value = jsonb_set(value,'{enabled}','true') where key='ai'`);
ok('employee cannot use AI', String(await begin(C)).includes('Only administrators'));
ok('outsider cannot use AI', String(await begin(B)).includes('not a member'));
const job = await begin(D);
ok('safety officer starts AI job', /^[0-9a-f-]{36}$/.test(job), job);
await db.query(`select public.ai_finish_job('${job}', true, '{"sections":{}}', '{}', '[]', 'anthropic', 'claude-sonnet-5-5', 100, 200, null)`);
const quota = (await as(C, `select public.ai_quota('${orgA}') q`))[0].q;
ok('quota counts successful draft', quota.used === 1 && quota.limit === 100 && quota.enabled === true && quota.can_generate === false, JSON.stringify(quota));
const job2 = await begin(D); await db.query(`select public.ai_finish_job('${job2}', false, null, null, null, 'anthropic', 'm', 0, 0, 'timeout')`);
ok('failed draft not counted', (await as(A, `select public.ai_quota('${orgA}') q`))[0].q.used === 1);
await db.exec(`update usage_counters set ai_generations = 100 where org_id='${orgA}'`);
ok('monthly limit enforced', String(await begin(D)).includes('used all its AI drafts'));
await db.exec(`update usage_counters set ai_generations = 1 where org_id='${orgA}'`);
for (let i = 0; i < 4; i++) await begin(D);
ok('per-user rate limit', String(await begin(D)).includes('Too many AI requests'));
ok('client cannot call ai_begin_job', (await asErr(D, `select public.ai_begin_job('${D}','${orgA}','x','sop',null,'{}')`)) !== null);
ok('client cannot call ai_finish_job', (await asErr(D, `select public.ai_finish_job('${job}', true, '{}', '{}', '[]', 'x', 'x', 1, 1, null)`)) !== null);
ok('B cannot read A quota', (await asErr(B, `select public.ai_quota('${orgA}')`)) !== null);
ok('AI job log readable by manager', (await as(A, `select count(*)::int n from ai_generation_jobs`))[0].n >= 2);
ok('AI job log hidden from employee', (await as(C, `select count(*)::int n from ai_generation_jobs`))[0].n === 0);

const rep = (await as(A, `select public.ohs_report('${orgA}', (current_date - 30), current_date) r`))[0].r;
ok('report counts incidents', rep.incidents.total === 2 && rep.incidents.near_misses === 1 && rep.incidents.closed === 1, JSON.stringify(rep.incidents));
ok('report counts inspections', rep.inspections.completed === 1 && rep.inspections.compliance_pct == 50, JSON.stringify(rep.inspections));
ok('report counts actions', rep.actions.raised === 2 && rep.actions.overdue_at_end === 1 && rep.actions.awaiting_verification === 1, JSON.stringify(rep.actions));
ok('report risk bands from methodology', Array.isArray(rep.risk.by_band) && rep.risk.by_band.length === 4);
const repD = (await as(D, `select public.ohs_report('${orgA}', (current_date - 30), current_date) r`))[0].r;
ok('report respects confidentiality', repD.incidents.total === 1, repD.incidents.total);
ok('employee cannot run report', (await asErr(C, `select public.ohs_report('${orgA}', current_date - 30, current_date)`)) !== null);
ok('other company cannot run report', (await asErr(B, `select public.ohs_report('${orgA}', current_date - 30, current_date)`)) !== null);

// Organisation deletion (e.g. POPIA erasure) must cascade cleanly
ok('organisation can be deleted', (await db.query(`delete from organisations where id='${orgA}'`).then(()=>null).catch(e=>e.message)) === null);
ok('org records removed', (await db.query(`select count(*)::int n from incidents where org_id='${orgA}'`)).rows[0].n === 0);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
