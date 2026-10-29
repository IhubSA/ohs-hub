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
  await db(`update platform_settings set value = jsonb_set(value, '{enabled}', 'true') where key = 'ai'`);
  await db(`insert into legal_requirements (framework_id, org_id, reference, requirement, requirement_kind, verification_status)
            select id, null, 'Section 8', 'General duties of employers to their employees', 'legislation', 'verified' from legal_frameworks where code = 'OHSA-85-1993'`);

  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
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
    if (url.pathname === '/functions/v1/ai-generate') {
      const fr = await fetch('http://127.0.0.1:8000/', { method: 'POST', headers: { authorization: h.authorization, 'content-type': 'application/json' }, body: req.postData() });
      return route.fulfill({ status: fr.status, headers: cors, contentType: 'application/json', body: await fr.text() });
    }
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
    const fs2 = require('fs');
    // ===== AI document drafting (safety officer) =====
    await as('D', '#/documents');
    await click('.page-title button:has-text("New document")');
    await modal({ doc_type: 'sop', title: 'Changing light fittings from a ladder' });
    await p.waitForSelector('#sec-purpose');
    ok('AI usage shown', (await text()).includes('0 of 100 AI drafts used this month'), (await text()).slice(0, 300));
    await click('button:has-text("Draft with AI")');
    await modal({ task_description: 'Replacing fluorescent light fittings in the workshop using a step ladder', site_id: site, equipment: 'Step ladder, screwdrivers' });
    await p.waitForSelector('.ai-review', { timeout: 20000 });
    ok('AI filled empty sections', (await p.inputValue('#sec-purpose')) === 'AI text for purpose.' && (await p.inputValue('#sec-steps')).includes('Inspect the ladder'));
    ok('missing section reported', (await p.textContent('.ai-review')).includes('Sections the AI did not complete') && (await p.textContent('.ai-review')).includes('Required records'));
    ok('verified legal reference marked Verified', await p.isVisible('.ai-review .badge.ok:has-text("Verified")'));
    ok('unknown reference flagged', (await p.textContent('.ai-review')).includes('Needs verification') && (await p.textContent('.ai-review')).includes('Imaginary Ladder Regulation 99'));
    ok('placeholder flagged as missing info', (await p.textContent('.ai-review')).includes('[Site emergency number]'));
    ok('AI label shown', (await p.textContent('.ai-review')).includes('competent person must check'));
    await click('button:has-text("Save draft")');
    const doc = (await db(`select d.id, v.content, v.ai_job_id, v.source_refs from documents d join document_versions v on v.document_id = d.id where d.org_id = $1`, [org]))[0];
    ok('draft saved with AI job and references', doc.ai_job_id && doc.content.steps.includes('Inspect') && doc.source_refs.some((r) => r.verified) && doc.source_refs.some((r) => !r.verified));
    await click('.label-row:has(label[for="sec-steps"]) button:has-text("Rewrite with AI")');
    await modal({ instruction: 'Add isolation steps' });
    await p.waitForFunction(() => document.querySelector('#sec-steps').value.includes('REWRITTEN'), null, { timeout: 20000 });
    ok('single section rewritten, others unchanged', (await p.inputValue('#sec-purpose')) === 'AI text for purpose.');
    const reqs = fs2.readFileSync(__dirname + '/anthropic-requests.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const last = reqs[reqs.length - 1];
    ok('model is Claude Sonnet 5.5 with forced tool', last.model === 'claude-sonnet-5-5' && last.tool_choice?.name === 'submit_draft');
    ok('system prompt forbids invented legislation and ratings', /Do not invent legislation/.test(last.system) && /Never assign risk ratings/.test(last.system));
    ok('rewrite asks for that section only', Object.keys(last.tools[0].input_schema.properties.sections.properties).join() === 'steps');
    ok('no reporter names sent', !reqs.some((r) => JSON.stringify(r).includes('Dineo') || JSON.stringify(r).includes('Mokoena')));
    ok('site name sent as context', reqs[0].messages[0].content.includes('Main Road Project'));

    // ===== AI hazard suggestions =====
    await go('#/risk');
    await click('.page-title button:has-text("New assessment")');
    await modal({ title: 'Lighting maintenance', assessment_type: 'task_specific', site_id: site, activity: 'Replacing light fittings' });
    await p.waitForSelector('text=Hazards and controls');
    await click('button:has-text("Suggest hazards with AI")');
    await modal({ equipment: 'Step ladder' });
    await p.waitForSelector('text=Suggested hazards', { timeout: 20000 });
    ok('hazards listed without ratings', (await p.textContent('dialog.modal-wide')).includes('Fall from ladder') && !/likelihood\s*5/i.test(await p.textContent('dialog.modal-wide')));
    await p.click('dialog.modal-wide .ai-item:has-text("Fall from ladder") button');
    await p.waitForSelector('dialog.modal:not(.modal-wide) #f-hazard');
    ok('hazard form prefilled from AI', (await p.inputValue('dialog.modal:not(.modal-wide) #f-hazard')) === 'Fall from ladder' && (await p.inputValue('dialog.modal:not(.modal-wide) #f-initial_likelihood')) === '');
    await p.selectOption('dialog.modal:not(.modal-wide) #f-initial_likelihood', '3'); await p.selectOption('dialog.modal:not(.modal-wide) #f-initial_severity', '4');
    await p.click('dialog.modal:not(.modal-wide) .modal-foot button[type=submit]'); await p.waitForTimeout(800);
    ok('add button shows Added', await p.isVisible('dialog.modal-wide button:has-text("Added")'));
    await p.click('dialog.modal-wide .modal-foot button:has-text("Done")'); await p.waitForTimeout(800);
    const item = (await db(`select ai_suggested, initial_score, initial_rating, control_levels from risk_assessment_items i join risk_assessments a on a.id = i.assessment_id where a.title = 'Lighting maintenance'`))[0];
    ok('AI hazard saved, scored by matrix, bogus control level dropped', item?.ai_suggested === true && item.initial_score === 12 && item.initial_rating === 'High' && String(item.control_levels) === '{engineering}', JSON.stringify(item));

    // ===== AI checklist questions =====
    await go('#/inspections?t=checklists');
    await click('button:has-text("New checklist")');
    await modal({ title: 'Workshop walk-through', category: 'workshops' });
    await p.waitForSelector('button:has-text("Suggest questions with AI")');
    await click('button:has-text("Suggest questions with AI")');
    await modal({});
    await p.waitForSelector('text=Suggested questions', { timeout: 20000 });
    await p.click('dialog.modal-wide .ai-check:has-text("Stairs have handrails") input');
    await p.click('dialog.modal-wide button:has-text("Add selected questions")'); await p.waitForTimeout(900);
    const qs = await db(`select section, question from inspection_template_items i join inspection_templates t on t.id = i.template_id where t.title = 'Workshop walk-through' order by sort_order`);
    ok('selected AI questions added (unticked one skipped)', qs.length === 2 && qs[0].question === 'Walkways are clear' && qs[1].section === 'Fire', JSON.stringify(qs));

    // ===== AI investigation support =====
    await go('#/incidents');
    await click('.content button:has-text("Report an incident")');
    await modal({ category: 'near_miss', title: 'Box fell from shelf', site_id: site, description: 'A box fell from the top shelf in the store.' });
    await p.waitForSelector('text=What happened');
    await click('button:has-text("Start investigation")'); await modal({ investigator_id: U.D[0] });
    await click('button:has-text("Suggest questions with AI")');
    await modal({});
    await p.waitForSelector('text=Investigation prompts', { timeout: 20000 });
    ok('questions and evidence shown', (await p.textContent('dialog.modal-wide')).includes('Were beam limits marked?') && (await p.textContent('dialog.modal-wide')).includes('Photos of racking'));
    await p.click('dialog.modal-wide .ai-item:has-text("Pallet overhang") button'); await p.waitForTimeout(600);
    await p.click('dialog.modal-wide .modal-foot button:has-text("Done")'); await p.waitForTimeout(900);
    const f = (await db(`select is_verified, source, finding_type from investigation_findings`))[0];
    ok('AI factor stored as unconfirmed suggestion', f && f.is_verified === false && f.source === 'ai_suggestion' && f.finding_type === 'immediate_cause');
    ok('shown as not yet confirmed', (await text()).includes('Not yet confirmed'));

    // ===== Roles without AI =====
    await as('C', '#/documents');
    ok('employee has no Reports menu', !(await p.isVisible('.side-nav a[data-route="reports"]')));

    // ===== Reports (admin) =====
    await as('A', '#/reports?p=this_month');
    await p.waitForSelector('#report');
    const rt = await p.textContent('#report');
    ok('report shows real incident count', rt.includes('1Incidents reported') && rt.includes('1Near misses'), rt.slice(0, 600));
    ok('report scope and access note', rt.includes('All sites') && rt.includes('records you have access to'));
    await click('button:has-text("Draft summary with AI")');
    await p.waitForFunction(() => document.querySelector('.summary-box textarea').value.includes('AI SUMMARY'), null, { timeout: 20000 });
    ok('AI summary labelled', (await p.textContent('.summary-box')).includes('drafted by AI from the figures'));
    const summaryReq = fs2.readFileSync(__dirname + '/anthropic-requests.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
    ok('summary request contains only figures', summaryReq.messages[0].content.includes('"total":1') && !summaryReq.messages[0].content.includes('Box fell'));
    const [csv] = await Promise.all([p.waitForEvent('download'), p.click('button:has-text("Download CSV")')]);
    const csvText = fs2.readFileSync(await csv.path(), 'utf8');
    ok('CSV export has figures', csvText.includes('"Incidents","total","1"') && csv.suggestedFilename().endsWith('.csv'), csvText.slice(0, 200));
    const [word] = await Promise.all([p.waitForEvent('download'), p.click('button:has-text("Download Word")')]);
    const wordText = fs2.readFileSync(await word.path(), 'utf8');
    ok('Word export includes summary and sections', word.suggestedFilename().endsWith('.doc') && wordText.includes('AI SUMMARY') && wordText.includes('Corrective actions') && !wordText.includes('<textarea'));
    await shot('report');
    await click('button:has-text("Save to documents")'); await modal({});
    await p.waitForSelector('#sec-content', { timeout: 10000 });
    const rep = (await db(`select d.doc_type, d.status, v.content->>'content' c from documents d join document_versions v on v.document_id = d.id where d.doc_type = 'ohs_report'`))[0];
    ok('report saved as draft document', rep && rep.status === 'draft' && rep.c.includes('Key figures') && rep.c.includes('AI SUMMARY'));

    // ===== Usage and switching AI off =====
    const used = (await db(`select ai_generations n from usage_counters where org_id = $1`, [org]))[0]?.n;
    ok('usage counted for each successful draft (6)', used === 6, used);
    ok('every job logged with model and tokens', (await db(`select count(*)::int n from ai_generation_jobs where status = 'succeeded' and model = 'claude-sonnet-5-5' and input_tokens = 500`))[0].n === 6);
    await db(`update platform_settings set value = jsonb_set(value, '{enabled}', 'false') where key = 'ai'`);
    await as('D', `#/documents/${doc.id}`);
    ok('AI off: explanation instead of button', (await text()).includes('AI drafting is not switched on yet') && !(await p.isVisible('button:has-text("Draft with AI")')));
    await shot('document-ai-off');
  } catch (e) { ok('flow completed without exception', false, e.message); await shot('failure5'); }

  ok('no browser errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  console.log(`\n${out.filter((x) => x.startsWith('PASS')).length} passed, ${out.filter((x) => x.startsWith('FAIL')).length} failed`);
  await b.close(); await pool.end();
})();
