// Stage 6 end-to-end: legal register, training, contractors, equipment & PPE, emergency, platform admin.
// Real Postgres + RLS + triggers, real app in Chromium. Run like stage4.e2e.cjs.
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
  const emp = (await db(`insert into employees(org_id,first_name,last_name,site_id,job_title,user_id) values ($1,'Craig','Adams',$2,'Rigger',$3) returning id`, [org, site, U.C[0]]))[0].id;
  await db(`insert into employees(org_id,first_name,last_name,site_id,job_title) values ($1,'Lerato','Dlamini',$2,'Clerk')`, [org, site]);
  await db(`update organisation_subscriptions set plan_id = (select id from subscription_plans where code='business') where org_id=$1`, [org]);
  await db(`insert into platform_admins(user_id) values ($1),($2)`, [U.A[0], U.M[0]]);
  const fs3 = require('fs'); const pdf = '/tmp/ohs-test-cert.pdf'; fs3.writeFileSync(pdf, '%PDF-1.4\n%test certificate\n');

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
  const shot = (n) => p.screenshot({ path: `${S}/shots/s6-${n}.png`, fullPage: true });

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
      else if (tag === 'INPUTfile') await p.setInputFiles(sel, v);
      else if (tag.startsWith('DIV')) { for (const lbl of [].concat(v)) await p.click(`${sel} label:has-text("${lbl}")`); }
      else await p.fill(sel, v);
    }
    if (submit) { await p.click('dialog.modal .modal-foot button[type=submit]'); await p.waitForSelector('dialog.modal[open]', { state: 'detached', timeout: 10000 }).catch(async () => { const err = await p.textContent('dialog.modal .alert').catch(() => ''); console.log('   MODAL STILL OPEN:', err, await p.$$eval('dialog.modal .error', (es) => es.map((e) => e.textContent).filter(Boolean))); }); await p.waitForTimeout(500); }
  };
  const click = async (sel) => { await p.click(sel); await p.waitForTimeout(300); };
  const text = () => p.textContent('.content');

  try {
    // ===== Menu =====
    await as('A', '#/dashboard');
    const nav = await p.textContent('.side-nav');
    ok('menu shows Compliance modules and Platform admin', ['Legal register', 'Training', 'Contractors', 'Equipment & PPE', 'Emergency', 'Platform admin'].every((x) => nav.includes(x)), nav);

    // ===== Legal register =====
    await as('M', '#/legal');
    ok('legal register empty state', (await text()).includes('Your legal register is empty'));
    await click('.page-title button:has-text("Add requirement")');
    const fw = (await db(`select id from legal_frameworks where code='OHSA-85-1993'`))[0].id;
    await modal({ framework_id: fw, reference: 'Section 8(2)(a)', title: 'Safe systems of work', requirement: 'Provide and maintain systems of work, plant and machinery that, as far as is reasonably practicable, are safe and without risks to health.', source_reference: 'Act 85 of 1993' });
    await p.waitForSelector('text=Compliance');
    ok('new requirement shows Needs verification', (await text()).includes('Needs verification') && (await text()).includes('has not been verified'));
    await click('.content button:has-text("Verify")');
    await modal({ notes: 'Checked gazette' });
    ok('author cannot verify own requirement', (await p.textContent('dialog.modal .alert')).includes('other than'));
    await p.click('dialog.modal .modal-close');
    const req = (await db(`select id from legal_requirements where org_id=$1`, [org]))[0].id;
    await as('A', `#/legal/${req}`);
    await click('.content button:has-text("Verify")');
    await modal({ notes: 'Checked against the official Act text, 29 Oct 2026' });
    ok('independent manager verifies', (await db(`select verification_status s from legal_requirements where id=$1`, [req]))[0].s === 'verified' && (await text()).includes('Verified'));
    await as('D', `#/legal/${req}`);
    await click('button:has-text("Assess a site")');
    await modal({ site_id: site, evaluation: 'non_compliant', evidence: 'No safe work procedures for the workshop lathe', findings: 'Procedures missing' });
    ok('site assessment shown', (await text()).includes('Not compliant') && (await text()).includes('Main Road Project'));
    await click('.content button:has-text("Raise action")');
    await modal({ title: 'Write a safe work procedure for the lathe', responsible_id: U.D[0] });
    ok('action raised from legal register', (await db(`select count(*)::int n from corrective_actions where source_type='legal_compliance' and source_id=$1`, [req]))[0].n === 1);
    await go('#/legal');
    ok('register summary counts', (await p.textContent('.stats')).includes('1Not compliant'), await p.textContent('.stats'));
    await as('M', `#/legal/${req}`);
    await click('.content button:has-text("Edit")');
    await modal({ requirement: 'Provide and maintain, as far as reasonably practicable, safe systems of work.' });
    ok('editing wording resets verification', (await db(`select verification_status s, version v from legal_requirements where id=$1`, [req]))[0].s === 'unverified' && (await text()).includes('Needs verification'));
    await as('C', '#/dashboard');
    ok('employee has no legal register', !(await p.isVisible('.side-nav a[data-route="legal"]')));

    // ===== Training =====
    await as('A', '#/training?t=courses');
    await click('button:has-text("Add a course")');
    await modal({ name: 'Rigging certificate', kind: 'certificate', validity_months: '24' });
    await click('.site-block button:has-text("Who needs it")');
    await modal({ job_title: 'Rigger' });
    await go('#/training');
    ok('matrix shows missing training', (await p.textContent('table.tmatrix')).includes('Missing') && (await p.textContent('.stats.compact')).includes('1Missing'));
    await click('table.tmatrix .cell-btn >> nth=0');
    await modal({ completed_on: '2026-03-01', provider: 'Cape Lifting Academy', file: pdf });
    const rec = (await db(`select expires_on::text e, certificate_path from training_records where org_id=$1`, [org]))[0];
    ok('training recorded with expiry and certificate', rec?.e === '2028-03-01' && !!rec.certificate_path, JSON.stringify(rec));
    ok('matrix updates to valid', (await p.textContent('table.tmatrix')).includes('Valid'));
    await go('#/training?t=records');
    ok('records list shows expiry', /Valid to 0?1 Mar 2028/.test(await text()) && await p.isVisible('button:has-text("Certificate")'));
    await as('C', '#/training');
    ok('employee sees own training', (await text()).includes('My training') && (await text()).includes('Rigging certificate'));

    // ===== Contractors =====
    await as('D', '#/people/contractors');
    ok('old People > Contractors link redirects', (await p.evaluate(() => location.hash)) === '#/contractors');
    await click('.page-title button:has-text("Add a contractor")');
    await modal({ company_name: 'Cape Scaffolding (Pty) Ltd', services: 'Scaffolding', contact_email: 'safety@capescaff.example' });
    await p.waitForSelector('text=Safety file and documents');
    await click('button:has-text("Upload document")');
    await modal({ doc_kind: 'safety_file', file: pdf, expires_on: '2027-06-30' });
    ok('document uploaded as awaiting review', (await text()).includes('Awaiting review'));
    ok('safety officer cannot review or approve', !(await p.isVisible('.content button:has-text("Review")')) && !(await p.isVisible('.content button:has-text("Approve access")')));
    const kid = (await db(`select id from contractors where org_id=$1`, [org]))[0].id;
    await as('M', `#/contractors/${kid}`);
    await click('.content button:has-text("Approve access")');
    await modal({});
    ok('access needs induction first', (await p.textContent('dialog.modal .alert')).includes('induction'));
    await p.click('dialog.modal .modal-close');
    await click('.content button:has-text("Review")');
    await modal({ decision: 'accepted', notes: 'Complete and current' });
    await click('.content button:has-text("Record induction")'); await modal({});
    await click('.content button:has-text("Approve access")'); await modal({});
    const k = (await db(`select access_status, access_approved_by from contractors where id=$1`, [kid]))[0];
    ok('manager approves access after induction', k.access_status === 'approved' && k.access_approved_by === U.M[0]);
    ok('contractor page shows accepted and approved', (await text()).includes('Accepted') && (await text()).includes('Up to date'));

    // ===== Equipment & PPE =====
    await as('D', '#/equipment');
    await click('.page-title button:has-text("Add equipment")');
    await modal({ name: '9 kg DCP fire extinguisher', category: 'fire_equipment', asset_number: 'FE-01', site_id: site, location: 'Workshop door', inspection_interval_months: '12' });
    await p.waitForSelector('text=Inspection and maintenance history');
    await click('.content button:has-text("Record inspection")');
    await modal({ outcome: 'pass', description: 'Annual service by SAQCC-registered company', performed_by: 'Fire Safe Services' });
    const eq = (await db(`select id, next_inspection_due::text d, status from equipment where org_id=$1`, [org]))[0];
    ok('passed inspection rolls next due forward 12 months', eq.d && eq.d > '2027-01-01' && eq.status === 'in_service', JSON.stringify(eq));
    await click('.content button:has-text("Report a defect")');
    await modal({ description: 'Safety pin missing' });
    ok('defect takes item out of service', (await db(`select status from equipment where id=$1`, [eq.id]))[0].status === 'out_of_service' && (await text()).includes('Out of service'));
    await go('#/equipment?t=ppe');
    await click('.page-title button:has-text("Issue PPE")');
    await modal({ employee_id: emp, item: 'Safety boots', size: '9' });
    ok('PPE issue recorded', (await text()).includes('Safety boots') && (await text()).includes('Craig Adams'));
    await as('C', '#/equipment?t=ppe');
    ok('employee sees own PPE only', (await text()).includes('My PPE') && (await text()).includes('Safety boots') && !(await p.isVisible('.page-title button:has-text("Issue PPE")')));

    // ===== Emergency =====
    await as('D', '#/emergency');
    await click('button:has-text("Add national numbers")'); await modal({});
    await click('.content button:has-text("Add a number")');
    await modal({ role: 'Fire warden', name: 'Sipho M.', phone: '021 555 0100', site_id: site });
    await as('C', '#/emergency');
    ok('employee sees emergency numbers as tap-to-call links', await p.isVisible('a[href="tel:10111"]') && await p.isVisible('a[href="tel:0215550100"]') && !(await p.isVisible('button:has-text("Add a number")')));
    await as('D', '#/emergency?t=drills');
    await click('.content button:has-text("Plan a drill")');
    await modal({ drill_type: 'evacuation', site_id: site, scheduled_for: new Date().toISOString().slice(0, 10), coordinator_id: U.D[0], target_minutes: '3' });
    await p.waitForSelector('text=Record the results');
    await click('.content button:has-text("Record results")');
    await modal({ participants: '24', evacuation_minutes: '4.5', outcome: 'needs_improvement', observations: 'Back exit was blocked by pallets.' });
    const dr = (await db(`select status, outcome, reference from emergency_drills where org_id=$1`, [org]))[0];
    ok('drill completed with results', dr.status === 'completed' && dr.outcome === 'needs_improvement' && /^DRL-\d{4}-0001$/.test(dr.reference), JSON.stringify(dr));
    ok('drill shows results', (await text()).includes('4.5 minutes') && (await text()).includes('Needs improvement'));
    await go('#/emergency?t=plans');
    ok('emergency equipment listed', (await text()).includes('9 kg DCP fire extinguisher'));

    // ===== Platform admin =====
    await as('A', '#/admin');
    ok('platform admin sees organisations', (await text()).includes('Fish Hoek Builders') && (await text()).includes('Business'));
    await click('.content button:has-text("Change plan")');
    const prof = (await db(`select id from subscription_plans where code='professional'`))[0].id;
    await modal({ plan_id: prof });
    await as('A', '#/training');
    ok('plan change hides training (not in Professional)', (await text()).includes("Training isn't in your plan"));
    const cl = await pool.connect();
    let blocked = false;
    try { await cl.query('begin'); await cl.query('set local role authenticated'); await cl.query(`select set_config('request.jwt.claim.sub',$1,true)`, [U.A[0]]);
      await cl.query(`insert into training_courses(org_id,name) values ($1,'Blocked')`, [org]); } catch { blocked = true; } finally { await cl.query('rollback'); cl.release(); }
    ok('database also blocks it', blocked);
    await go('#/admin');
    await click('.content button:has-text("Change plan")');
    await modal({ plan_id: (await db(`select id from subscription_plans where code='business'`))[0].id });
    await go('#/admin?t=plans');
    await click('.site-block:has-text("Starter") button:has-text("Edit")');
    await modal({ price_monthly_zar: '950' });
    ok('plan price saved', Number((await db(`select price_monthly_zar p from subscription_plans where code='starter'`))[0].p) === 950 && (await text()).includes('R950 a month'));
    await go('#/admin?t=legal');
    await click('.content button:has-text("Add requirement")');
    await modal({ framework_id: fw, reference: 'Section 13', title: 'Duty to inform', requirement: 'Every employer shall make employees aware of the hazards to their health and safety.' });
    ok('shared library entry added unverified', (await text()).includes('Duty to inform') && (await db(`select verification_status s from legal_requirements where org_id is null and reference='Section 13'`))[0].s === 'unverified');
    ok('author has no verify button on own entry', !(await p.isVisible('.content tr:has-text("Duty to inform") button:has-text("Verify")')));
    await as('M', '#/admin?t=legal');
    await click('.content tr:has-text("Duty to inform") button:has-text("Verify")');
    await modal({ notes: 'Checked against Act 85 of 1993 text' });
    ok('second platform admin verifies shared entry', (await db(`select verification_status s from legal_requirements where org_id is null and reference='Section 13'`))[0].s === 'verified');
    await go('#/admin?t=settings');
    ok('settings show AI switch', (await text()).includes('AI drafting') && (await text()).includes('claude-sonnet-5-5'));
    await as('D', '#/dashboard');
    ok('non-admins have no Platform admin menu', !(await p.isVisible('.side-nav a[data-route="admin"]')));

    // ===== Phone =====
    await p.setViewportSize({ width: 390, height: 844 });
    await as('A', '#/dashboard');
    for (const r of ['#/legal', `#/legal/${req}`, '#/training', '#/training?t=records', '#/training?t=courses', '#/contractors', `#/contractors/${kid}`, '#/equipment', `#/equipment/${eq.id}`, '#/equipment?t=ppe', '#/emergency', '#/emergency?t=drills', '#/emergency?t=plans', '#/admin', '#/admin?t=plans', '#/admin?t=legal']) {
      await go(r); await p.waitForTimeout(300);
      const ov = await p.evaluate(() => { const w = innerWidth; const bad = [...document.querySelectorAll('.content *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > w + 1 && !e.closest('.table-wrap,.tabs,.tmatrix-wrap'); }).slice(0, 3).map((e) => e.tagName + '.' + [...e.classList].join('.') + ' r=' + Math.round(e.getBoundingClientRect().right)); return { sw: document.documentElement.scrollWidth, w, bad }; });
      ok('phone fits ' + r, ov.sw <= ov.w + 1 && !ov.bad.length, JSON.stringify(ov));
      await p.screenshot({ path: `${S}/shots/s6-${r.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}.png` });
    }
    await p.setViewportSize({ width: 1360, height: 900 });
    await go('#/training'); await shot('matrix');
  } catch (e) { ok('flow completed without exception', false, e.message); await shot('failure6'); }

  ok('no browser errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  console.log(`\n${out.filter((x) => x.startsWith('PASS')).length} passed, ${out.filter((x) => x.startsWith('FAIL')).length} failed`);
  await b.close(); await pool.end();
})();
