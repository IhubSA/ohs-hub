// Stage 4 end-to-end: real Postgres + RLS + triggers, real app in Chromium.
const { chromium } = require('playwright');
const fs = require('fs');
const { handle, storage, pool } = require('./test-api-shim.cjs');
const S = process.env.OHS_TEST_ASSETS || __dirname; // needs fonts.css, sbbundle/supabase.esm.js and a shots/ folder
const BASE = 'http://localhost:8768/';
const SB = 'https://paunnbnjxmkxgexihgnf.supabase.co';
const U = {
  A: ['10000000-0000-4000-8000-00000000000a', 'brent@example.co.za', 'Brent Proctor', 'org_admin'],
  M: ['10000000-0000-4000-8000-00000000000b', 'mandla@example.co.za', 'Mandla Nkosi', 'ohs_manager'],
  D: ['10000000-0000-4000-8000-00000000000d', 'dineo@example.co.za', 'Dineo Mokoena', 'safety_officer'],
  C: ['10000000-0000-4000-8000-00000000000c', 'craig@example.co.za', 'Craig Adams', 'employee'],
};
const out = []; const ok = (n, c, x = '') => { out.push(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ' :: ' + x}`); console.log(out[out.length - 1]); };
const db = (sql, p = []) => pool.query(sql, p).then((r) => r.rows);

(async () => {
  // ---- seed users and organisation ----
  for (const [id, email, name] of Object.values(U)) await db(`insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,$3)`, [id, email, { full_name: name }]);
  const c = await pool.connect();
  await c.query('begin'); await c.query('set local role authenticated'); await c.query(`select set_config('request.jwt.claim.sub',$1,true)`, [U.A[0]]);
  const org = (await c.query(`select public.create_organisation('Fish Hoek Builders','construction') id`)).rows[0].id;
  await c.query('commit'); c.release();
  for (const k of ['M', 'D', 'C']) await db(`insert into organisation_memberships(org_id,user_id,role) values ($1,$2,$3)`, [org, U[k][0], U[k][3]]);
  const site = (await db(`insert into sites(org_id,name) values ($1,'Main Road Project') returning id`, [org]))[0].id;
  await db(`insert into employees(org_id,first_name,last_name,site_id) values ($1,'Craig','Adams',$2)`, [org, site]);

  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 }, serviceWorkers: 'block' });
  const fcss = fs.readFileSync(S + '/fonts.css', 'utf8');
  await ctx.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm', (r) => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(S + '/sbbundle/supabase.esm.js', 'utf8') }));
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: fcss }));
  await ctx.route(SB + '/**', async (route) => {
    const req = route.request(); const url = new URL(req.url()); const h = req.headers();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'content-range' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: cors, body: '' });
    const tok = (h.authorization || '').replace(/^Bearer\s+/i, '');
    let sub = null; try { sub = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).sub || null; } catch { /* anon */ }
    if (url.pathname.startsWith('/auth/v1/')) { const u = Object.values(U).find((x) => x[0] === sub); return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ id: sub, email: u?.[1] }) }); }
    if (url.pathname.startsWith('/functions/v1/')) return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: '{"ok":true}' });
    if (url.pathname.startsWith('/storage/v1/')) {
      const r = await storage({ method: req.method(), path: url.pathname.replace('/storage/v1/', ''), body: req.postDataBuffer(), sub, contentType: h['content-type'] });
      return route.fulfill({ status: r.status, headers: cors, contentType: 'application/json', body: JSON.stringify(r.body) });
    }
    const raw = req.postData();
    const r = await handle({ method: req.method(), path: url.pathname.replace('/rest/v1/', ''), search: url.search, headers: h, body: raw ? JSON.parse(raw) : null, sub });
    if (r.status >= 400) console.log('   API', req.method(), url.pathname, r.status, r.body.message);
    return route.fulfill({ status: r.status, headers: { ...cors, ...(r.headers || {}) }, contentType: 'application/json', body: r.body == null ? '' : JSON.stringify(r.body) });
  });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  p.on('dialog', (d) => d.dismiss());
  const shot = (n) => p.screenshot({ path: `${S}/shots/s4-${n}.png`, fullPage: true });

  const as = async (k, hash = '') => {
    const exp = Math.floor(Date.now() / 1000) + 86400;
    const payload = Buffer.from(JSON.stringify({ sub: U[k][0], exp, role: 'authenticated' })).toString('base64url');
    const session = { access_token: `x.${payload}.y`, refresh_token: 'r', token_type: 'bearer', expires_in: 86400, expires_at: exp, user: { id: U[k][0], email: U[k][1] } };
    await p.goto(BASE + '404.html'); await p.waitForLoadState('load');
    await p.evaluate((s) => { localStorage.clear(); localStorage.setItem('sb-paunnbnjxmkxgexihgnf-auth-token', JSON.stringify(s)); }, session);
    await p.goto(BASE + 'app/index.html' + (hash || '#/dashboard')); await p.reload();
    await p.waitForSelector('.app-shell'); await p.waitForSelector('.content .page-title, .content .card', { timeout: 15000 });
  };
  const go = async (hash) => { await p.evaluate((x) => { location.hash = x; }, hash); await p.waitForTimeout(150); await p.waitForSelector('.content > div > *', { timeout: 15000 }); await p.waitForTimeout(400); };
  const modal = async (fields, submit = true) => {
    await p.waitForSelector('dialog.modal[open]');
    for (const [k, v] of Object.entries(fields)) {
      const sel = `dialog.modal #f-${k}`;
      const tag = await p.$eval(sel, (e) => e.tagName + (e.type || ''));
      if (tag.startsWith('SELECT')) await p.selectOption(sel, v);
      else if (tag.includes('checkbox')) { if (v) await p.check(sel); else await p.uncheck(sel); }
      else if (tag.startsWith('DIV')) { for (const lbl of [].concat(v)) await p.click(`${sel} label:has-text("${lbl}")`); }
      else await p.fill(sel, v);
    }
    if (submit) { await p.click('dialog.modal .modal-foot button[type=submit]'); await p.waitForSelector('dialog.modal[open]', { state: 'detached', timeout: 10000 }).catch(async () => { const err = await p.textContent('dialog.modal .alert').catch(() => ''); console.log('   MODAL STILL OPEN:', err, await p.$$eval('dialog.modal .error', (es) => es.map((e) => e.textContent).filter(Boolean))); }); await p.waitForTimeout(500); }
  };
  const click = async (sel) => { await p.click(sel); await p.waitForTimeout(300); };
  const text = () => p.textContent('.content');

  try {
    // ===== Risk assessment (safety officer) =====
    await as('D', '#/risk');
    ok('risk empty state', (await text()).includes('No risk assessments yet'));
    await click('button:has-text("New assessment")');
    await modal({ title: 'Workshop baseline', assessment_type: 'baseline', site_id: site });
    await p.waitForSelector('text=Hazards and controls');
    await click('button:has-text("Add hazard")');
    await modal({ hazard_category: 'Working at height', hazard: 'Fall from portable ladder', persons_exposed: 'Maintenance staff', existing_controls: 'Ladder inspected monthly',
      initial_likelihood: '4', initial_severity: '4', additional_controls: 'Use mobile scaffold for work above 2 m', control_levels: ['Engineering controls'], residual_likelihood: '2', residual_severity: '3', responsible_id: U.D[0] });
    await p.waitForSelector('text=Fall from portable ladder');
    const t1 = await text();
    ok('hazard scored by database: 16 High / 6 Medium', t1.includes('16 High') && t1.includes('6 Medium'), t1.slice(0, 400));
    const ra = (await db(`select id, status from risk_assessments where org_id=$1`, [org]))[0];
    await click('button:has-text("Add to register")');
    ok('added to risk register', (await db(`select count(*)::int n from risk_register_entries where org_id=$1`, [org]))[0].n === 1);
    await click('button:has-text("Submit for approval")');
    ok('submitted for approval', (await db(`select status from risk_assessments where id=$1`, [ra.id]))[0].status === 'in_review');
    ok('safety officer has no approve button', !(await p.isVisible('.content button:has-text("Approve")')));
    await shot('risk-detail');

    await as('A', `#/risk/${ra.id}`);
    await p.waitForSelector('button:has-text("Approve")');
    await click('.content button:has-text("Approve")'); await modal({});
    ok('admin approved RA independently', (await db(`select status, approver_id from risk_assessments where id=$1`, [ra.id]))[0].approver_id === U.A[0]);
    ok('approved RA hides Add hazard', !(await p.isVisible('button:has-text("Add hazard")')));

    await go('#/register');
    ok('register shows entry with ratings', (await text()).includes('Fall from portable ladder') && (await text()).includes('16 High'));
    await shot('register');

    // ===== Inspections =====
    await as('D', '#/inspections?t=checklists');
    await click('button:has-text("New checklist")');
    await modal({ starter: 'fire' });
    await p.waitForSelector('text=Firefighting equipment');
    const tpl = (await db(`select id from inspection_templates where org_id=$1`, [org]))[0].id;
    ok('starter checklist copied (10 questions)', (await db(`select count(*)::int n from inspection_template_items where template_id=$1`, [tpl]))[0].n === 10);
    ok('safety officer cannot approve checklist', !(await p.isVisible('.content button:has-text("Approve")')) && (await text()).includes('must approve this checklist'));
    await shot('checklist');
    await as('M', `#/inspections/checklist/${tpl}`);
    await click('.content button:has-text("Approve")'); await modal({});
    ok('manager approved checklist', (await db(`select status from inspection_templates where id=$1`, [tpl]))[0].status === 'approved');

    await as('D', '#/inspections');
    await click('button:has-text("Start inspection")');
    await modal({ template_id: tpl, site_id: site });
    await p.waitForSelector('.q');
    const qs = await p.$$('.q');
    for (let i = 0; i < qs.length; i++) {
      await qs[i].$eval(i === 0 ? 'button[data-v="non_compliant"]' : 'button[data-v="compliant"]', (b) => b.click());
      await p.waitForTimeout(120);
    }
    await qs[0].$eval('textarea', (t) => { t.value = 'Extinguisher in workshop missing'; t.dispatchEvent(new Event('change')); });
    await p.waitForTimeout(500);
    ok('progress shows all answered', (await p.textContent('.progress-line')).includes(`${qs.length} of ${qs.length} answered`), await p.textContent('.progress-line'));
    const ins = (await db(`select id, compliant_count, non_compliant_count from inspections where org_id=$1`, [org]))[0];
    ok('database counted responses', ins.compliant_count === qs.length - 1 && ins.non_compliant_count === 1, JSON.stringify(ins));
    ok('comment saved', (await db(`select comment from inspection_responses where inspection_id=$1 and response='non_compliant'`, [ins.id]))[0]?.comment === 'Extinguisher in workshop missing');
    ok('no stray null text in capture view', !(await p.$$eval('.q', (qs) => qs.some((q) => /\bnull\b/.test(q.textContent)))));
    await p.setViewportSize({ width: 390, height: 844 }); ok('no horizontal scroll on phone', await p.evaluate(() => document.documentElement.scrollWidth <= 390)); await shot('inspection-mobile'); await p.setViewportSize({ width: 1360, height: 900 });
    await click('button:has-text("Complete inspection")'); await modal({ summary: 'Generally good, one extinguisher missing.' });
    await p.waitForSelector('text=Findings (1)');
    ok('inspection completed', (await db(`select status from inspections where id=$1`, [ins.id]))[0].status === 'completed');
    await click('.q.is-nc button:has-text("Raise action")');
    await modal({ responsible_id: U.C[0], priority: 'high' });
    const act = (await db(`select id, reference, status from corrective_actions where source_id=$1`, [ins.id]))[0];
    ok('action raised from finding', !!act && act.status === 'open');
    await shot('inspection-report');

    // ===== Employee works the action =====
    await as('C');
    ok('employee task list shows action', (await text()).includes(act.reference));
    ok('employee nav hides risk and inspections', !(await p.isVisible('.side-nav a[data-route="risk"]')) && !(await p.isVisible('.side-nav a[data-route="inspections"]')));
    await shot('employee-dashboard');
    await go(`#/actions/${act.id}`);
    await click('button:has-text("Start work")');
    await click('button:has-text("Mark as done")'); await modal({});
    ok('employee submitted for verification', (await db(`select status from corrective_actions where id=$1`, [act.id]))[0].status === 'awaiting_verification');
    ok('employee cannot verify', !(await p.isVisible('button:has-text("Verify")')));

    await as('D', `#/actions/${act.id}`);
    await click('.content button:has-text("Verify")'); await modal({ outcome: 'effective' });
    const a2 = (await db(`select status, verified_by from corrective_actions where id=$1`, [act.id]))[0];
    ok('verified by safety officer and closed', a2.status === 'closed' && a2.verified_by === U.D[0], JSON.stringify(a2));

    // ===== Incident =====
    await as('C', '#/incidents');
    await click('.content button:has-text("Report an incident")');
    await modal({ category: 'near_miss', title: 'Pallet fell from racking', site_id: site, description: 'A pallet slipped off the second shelf and landed in the aisle. Nobody was hurt.' });
    await p.waitForSelector('text=What happened');
    const inc = (await db(`select id, reference, reported_by from incidents where org_id=$1`, [org]))[0];
    ok('employee reported incident', inc.reported_by === U.C[0]);
    ok('managers notified', (await db(`select count(*)::int n from notifications where record_id=$1 and event_type='incident.reported'`, [inc.id]))[0].n === 2);
    await click('.card-head:has-text("Witnesses") button'); await modal({ witness_name: 'Sipho Dlamini', statement: 'I saw the pallet tip.' });
    ok('witness added by reporter', (await text()).includes('Sipho Dlamini'));
    ok('employee sees no investigation section', !(await text()).includes('Start investigation'));

    await as('D', `#/incidents/${inc.id}`);
    await click('button:has-text("Start investigation")'); await modal({ investigator_id: U.D[0] });
    await click('button:has-text("Add a why")'); await modal({ why: 'The pallet was overhanging the beam' });
    await click('.card-head:has-text("Causes and findings") button'); await modal({ finding_type: 'immediate_cause', description: 'Pallet overhang', is_verified: true });
    await click('button:has-text("Write summary")'); await modal({ summary: 'Pallet stacked with overhang due to no loading guidance.', recommendations: 'Mark beam load limits; train forklift drivers.' });
    await click('button:has-text("Submit for review")'); await modal({});
    ok('investigation submitted', (await db(`select status from incident_investigations where incident_id=$1`, [inc.id]))[0].status === 'submitted');
    ok('incident awaiting approval', (await db(`select status from incidents where id=$1`, [inc.id]))[0].status === 'awaiting_approval');
    await shot('incident-investigation');

    await as('M', `#/incidents/${inc.id}`);
    await click('.content button:has-text("Approve")'); await modal({ c: 'Good investigation.' });
    await click('button:has-text("Close incident")'); await modal({});
    ok('manager approved and closed incident', (await db(`select status from incidents where id=$1`, [inc.id]))[0].status === 'closed');

    // ===== Documents =====
    await as('D', '#/documents');
    await click('.page-title button:has-text("New document")');
    await modal({ doc_type: 'sop', title: 'Working from portable ladders', requires_acknowledgement: true });
    await p.waitForSelector('#sec-purpose');
    await p.fill('#sec-purpose', 'To make sure portable ladders are used safely.');
    await p.fill('#sec-steps', '1. Inspect the ladder.\n2. Set it up on firm ground.\n3. Keep three points of contact.');
    await click('button:has-text("Save draft")');
    const doc = (await db(`select id, reference from documents where org_id=$1`, [org]))[0];
    ok('SOP draft saved with auto reference', /^SOP-\d{4}-0001$/.test(doc.reference) && (await db(`select content->>'purpose' p from document_versions where document_id=$1`, [doc.id]))[0].p.startsWith('To make'));
    ok('draft banner shown', (await text()).includes('is not approved and must not be used'));
    await click('.content button:has-text("Submit for review")');
    await modal({ reviewers: ['Mandla Nkosi'] });
    ok('submitted for review', (await db(`select status from document_versions where document_id=$1`, [doc.id]))[0].status === 'in_review');
    await shot('document-draft');

    await as('C', '#/documents');
    ok('employee cannot see unapproved document', !(await text()).includes('Working from portable ladders'));
    await as('M', `#/documents/${doc.id}`);
    await click('.content button:has-text("Approve")');
    await modal({});

    ok('document approved and effective', (await db(`select status, current_version_id is not null c from documents where id=$1`, [doc.id]))[0].status === 'approved');
    ok('effective banner', await p.waitForSelector('.doc-banner.effective', { timeout: 8000 }).then(async (e) => (await e.textContent()).includes('Effective version 1')).catch(() => false));

    await as('C', '#/documents');
    ok('employee sees approved document', (await text()).includes('Working from portable ladders') && (await text()).includes('Please acknowledge'));
    await go(`#/documents/${doc.id}`);
    await click('.content button:has-text("Acknowledge")'); await modal({});
    ok('employee acknowledged', (await db(`select count(*)::int n from document_acknowledgements`))[0].n === 1);
    await shot('document-employee');

    await as('D', `#/documents/${doc.id}`);
    await click('button:has-text("Start revision")'); await modal({ summary: 'Add ladder angle guidance' });
    ok('revision draft created, v1 still effective', (await db(`select count(*)::int n from document_versions where document_id=$1 and status='draft'`, [doc.id]))[0].n === 1
      && (await db(`select status from documents where id=$1`, [doc.id]))[0].status === 'approved');

    // ===== Dashboard =====
    await as('A');
    await p.waitForSelector('.stats');
    const st = await p.textContent('.stats');
    ok('dashboard: approved RA 1', st.includes('1Approved risk assessments'), st);
    ok('dashboard: high risks 0 (residual Medium)', st.includes('0High and extreme risks'), st);
    ok('dashboard: no open incidents', st.includes('0Open incidents'), st);
    ok('charts render from data', (await text()).includes('Incidents per month') && (await p.$$('.col .b')).length > 0);
    await shot('dashboard');
  } catch (e) { ok('flow completed without exception', false, e.message); await shot('failure'); }

  ok('no browser errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  console.log(`\n${out.filter((x) => x.startsWith('PASS')).length} passed, ${out.filter((x) => x.startsWith('FAIL')).length} failed`);
  await b.close(); await pool.end();
})();
