// Headless click-through of the OHS Hub app against an in-memory mock of the
// Supabase REST API (the sandbox cannot reach supabase.co).
const { chromium } = require('playwright');
const fs = require('fs');
// Setup: put fonts.css (optional) and a bundled supabase-js ESM file at
// sbbundle/supabase.esm.js next to this script, serve the repo root on :8767,
// then run: node app.e2e.cjs
const S = __dirname;
const BASE = 'http://localhost:8767/';
const SB = 'https://paunnbnjxmkxgexihgnf.supabase.co';
const USER = { id: 'u-admin-0000-0000-0000-000000000001', email: 'brent@example.co.za', user_metadata: { full_name: 'Brent Proctor', company_name: 'Fish Hoek Builders', industry: 'construction' } };
let n = 0; const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

const db = { user_profiles: [{ id: USER.id, email: USER.email, full_name: 'Brent Proctor', job_title: null, default_org_id: null, notification_email: true }],
  organisations: [], organisation_memberships: [], organisation_subscriptions: [], subscription_plans: [{ id: 'p1', name: 'Professional', max_users: 15, max_sites: 3 }],
  sites: [], departments: [], employees: [], contractors: [], organisation_invitations: [], notifications: [] };
const calls = [];

function applyFilters(rows, params) {
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'columns', 'on_conflict'].includes(k)) continue;
    const [op, ...rest] = v.split('.'); const val = rest.join('.');
    rows = rows.filter((r) => {
      const x = r[k];
      if (op === 'eq') return String(x) === val;
      if (op === 'is') return val === 'null' ? x == null : String(x) === val;
      if (op === 'gt') return x > val;
      if (op === 'in') return val.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/"/g, '')).includes(String(x));
      return true;
    });
  }
  return rows;
}
function embed(table, rows, select) {
  return rows.map((r) => {
    const o = { ...r };
    if (/organisations\(/.test(select || '') && r.org_id) o.organisations = db.organisations.find((x) => x.id === r.org_id) || null;
    if (/subscription_plans\(/.test(select || '')) o.subscription_plans = db.subscription_plans[0];
    return o;
  });
}

async function handle(route) {
  const req = route.request(); const url = new URL(req.url()); const method = req.method();
  const json = (body, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'content-range', ...headers }, body: JSON.stringify(body) });
  if (method === 'OPTIONS') return json({});
  if (url.pathname.startsWith('/auth/v1/user')) return json(USER);
  if (url.pathname.startsWith('/functions/v1/')) { calls.push({ fn: url.pathname, body: JSON.parse(req.postData() || '{}') }); return json({ ok: true, invitation_id: uid() }); }
  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    const fn = url.pathname.split('/').pop(); const body = JSON.parse(req.postData() || '{}'); calls.push({ rpc: fn, body });
    if (fn === 'create_organisation') {
      const id = uid(); db.organisations.push({ id, name: body.p_name, industry: body.p_industry, registration_number: body.p_registration_number, province: body.p_province, settings: { require_independent_approval: true, confidential_incidents_enabled: true } });
      db.organisation_memberships.push({ id: uid(), org_id: id, user_id: USER.id, role: 'org_admin', status: 'active', site_ids: null, can_view_confidential: true, can_approve_documents: true, created_at: new Date().toISOString() });
      db.organisation_subscriptions.push({ org_id: id, status: 'trialing', trial_ends_at: new Date(Date.now() + 14 * 864e5).toISOString(), billing_status: 'not_configured' });
      return json(id);
    }
    return json(null);
  }
  const table = url.pathname.replace('/rest/v1/', ''); db[table] ??= [];
  const params = [...url.searchParams.entries()];
  const single = (req.headers()['accept'] || '').includes('vnd.pgrst.object');
  if (method === 'GET' || method === 'HEAD') {
    let rows = embed(table, applyFilters(db[table], params), url.searchParams.get('select'));
    const headers = { 'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` };
    if (method === 'HEAD') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range', ...headers }, body: '' });
    if (single) return rows.length ? json(rows[0], 200, headers) : json({ code: 'PGRST116', message: 'no rows' }, 406);
    return json(rows, 200, headers);
  }
  if (method === 'POST') {
    let body = JSON.parse(req.postData()); body = Array.isArray(body) ? body : [body];
    const rows = body.map((r) => ({ id: uid(), is_active: true, status: r.status ?? (table === 'employees' ? 'active' : undefined), created_at: new Date().toISOString(), ...r }));
    db[table].push(...rows); calls.push({ insert: table, rows });
    return single ? json(rows[0], 201) : json(rows, 201);
  }
  if (method === 'PATCH') {
    const patch = JSON.parse(req.postData()); const rows = applyFilters(db[table], params); rows.forEach((r) => Object.assign(r, patch));
    calls.push({ update: table, patch }); return json(rows);
  }
  if (method === 'DELETE') { const rows = applyFilters(db[table], params); db[table] = db[table].filter((r) => !rows.includes(r)); return json(rows); }
  return json({}, 404);
}

(async () => {
  const b = await chromium.launch();
  const out = []; const ok = (name, c, extra = '') => out.push(`${c ? 'PASS' : 'FAIL'} ${name}${c ? '' : ' ' + extra}`);
  const errors = [];
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
  const fcss = fs.readFileSync(S + '/fonts.css', 'utf8');
  await ctx.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm', (r) => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(S + '/sbbundle/supabase.esm.js', 'utf8') }));
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: fcss }));
  await ctx.route(SB + '/**', handle);
  const exp = Math.floor(Date.now() / 1000) + 3600 * 24;
  const payload = Buffer.from(JSON.stringify({ sub: USER.id, exp, role: 'authenticated' })).toString('base64url');
  const session = { access_token: `x.${payload}.y`, refresh_token: 'r', token_type: 'bearer', expires_in: 86400, expires_at: exp, user: USER };
  await ctx.addInitScript((s) => localStorage.setItem('sb-paunnbnjxmkxgexihgnf-auth-token', JSON.stringify(s)), session);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const shot = (name) => p.screenshot({ path: `${S}/shots/app-${name}.png`, fullPage: true });

  // 1. Setup wizard
  await p.goto(BASE + 'app/');
  await p.waitForSelector('#org-name');
  ok('setup wizard shown for new user', await p.isVisible('text=Set up your company'));
  ok('company name prefilled from registration', (await p.inputValue('#org-name')) === 'Fish Hoek Builders');
  await shot('setup1');
  await p.fill('#org-name', ''); await p.click('button:has-text("Create company")');
  ok('setup validates company name', await p.isVisible('text=Enter your company name.'));
  await p.fill('#org-name', 'Fish Hoek Builders'); await p.selectOption('#org-province', 'Western Cape');
  await p.click('button:has-text("Create company")');
  await p.waitForSelector('#site-name');
  ok('create_organisation RPC called', calls.some((c) => c.rpc === 'create_organisation' && c.body.p_province === 'Western Cape' && c.body.p_industry === 'construction'));
  await p.fill('#site-name', 'Main Road Project'); await p.fill('#site-depts', 'Workshop\nSite office\nWorkshop');
  await p.click('button:has-text("Finish setup")');
  await p.waitForSelector('.app-shell');
  ok('site created', db.sites.length === 1 && db.sites[0].name === 'Main Road Project');
  ok('departments created, duplicates removed', db.departments.length === 2, JSON.stringify(db.departments.map((d) => d.name)));
  await p.waitForSelector('.stats');
  ok('dashboard shows real safety counts', (await p.textContent('.stats')).includes('0Open incidents') && (await p.textContent('.stats')).includes('0Outstanding actions'), await p.textContent('.stats'));
  ok('trial banner shown', await p.isVisible('text=free trial of Professional'));
  ok('getting started checklist 2 of 7', (await p.textContent('.content')).includes('2 of 7 done'), await p.textContent('.content'));
  await shot('dashboard');

  // 2. Company
  await p.click('.side-nav a[data-route="company"]'); await p.waitForSelector('#c-registration_number');
  await p.fill('#c-registration_number', '2019/123456/07'); await p.fill('#c-physical_address', '1 Main Road, Fish Hoek');
  await p.click('button:has-text("Save changes")'); await p.waitForSelector('.toast');
  ok('company details saved', db.organisations[0].registration_number === '2019/123456/07' && db.organisations[0].physical_address === '1 Main Road, Fish Hoek');
  ok('usage meter shows sites 1 of 3', (await p.textContent('.kv')).includes('1 of 3'));
  await shot('company');

  // 3. Sites
  await p.click('.side-nav a[data-route="sites"]'); await p.waitForSelector('.site-block');
  await p.click('button:has-text("Add a site")'); await p.fill('#f-name', 'Kommetjie Depot'); await p.click('dialog button[type=submit]');
  await p.waitForFunction(() => document.querySelectorAll('.site-block').length >= 3);
  ok('second site added', db.sites.length === 2);
  await shot('sites');

  // 4. People
  await p.click('.side-nav a[data-route="people"]'); await p.waitForSelector('text=No employees yet');
  await p.click('.card-head button:has-text("Add an employee")');
  await p.click('dialog button[type=submit]');
  ok('employee form validates', await p.isVisible('dialog >> text=First name is required.'));
  await p.fill('#f-first_name', 'Thandi'); await p.fill('#f-last_name', 'Mokoena'); await p.fill('#f-job_title', 'Site supervisor');
  await p.selectOption('#f-site_id', { label: 'Main Road Project' });
  await p.click('dialog button[type=submit]'); await p.waitForSelector('table.data');
  ok('employee added and listed', db.employees.length === 1 && (await p.textContent('table.data')).includes('Thandi Mokoena'));
  await p.fill('input[type=search]', 'zzz'); ok('employee search filters', (await p.textContent('table.data')).includes('No employees match'));
  await p.click('button[role=tab]:has-text("Contractors")'); await p.waitForSelector('text=No contractors yet');
  ok('contractors tab', true);
  await shot('people');

  // 5. Team & invitations
  await p.click('.side-nav a[data-route="team"]'); await p.waitForSelector('text=Members');
  ok('admin listed as member', (await p.textContent('table.data')).includes('Brent Proctor'));
  await p.click('button:has-text("Invite someone")');
  await p.fill('#f-email', 'not-an-email'); await p.click('dialog button[type=submit]');
  ok('invite validates email', await p.isVisible('dialog >> text=Enter a valid email address.'));
  await p.fill('#f-email', 'safety@fhb.co.za'); await p.selectOption('#f-role', 'supervisor');
  await p.check('dialog .checks label:has-text("Kommetjie Depot") input');
  await p.click('dialog button[type=submit]'); await p.waitForSelector('.toast:has-text("Invitation sent")');
  const inv = calls.find((c) => c.fn === '/functions/v1/invite-user');
  ok('invite-user called with role and site scope', inv && inv.body.role === 'supervisor' && inv.body.email === 'safety@fhb.co.za' && inv.body.site_ids.length === 1, JSON.stringify(inv));
  await shot('team');

  // 6. Profile and notifications
  await p.click('.side-nav a[data-route="profile"]'); await p.waitForSelector('#p-name');
  await p.fill('#p-title', 'Director'); await p.uncheck('#p-email'); await p.click('button:has-text("Save profile")');
  await p.waitForSelector('.toast:has-text("Profile saved")');
  ok('profile saved incl. email preference', db.user_profiles[0].job_title === 'Director' && db.user_profiles[0].notification_email === false);
  await p.click('.side-nav a[data-route="notifications"]'); await p.waitForSelector('text=Nothing here yet');
  ok('notifications empty state', true);

  // 7. Mobile
  await p.setViewportSize({ width: 390, height: 844 });
  await p.goto(BASE + 'app/#/dashboard'); await p.waitForSelector('.stats');
  const rect = await p.evaluate(() => { const r = document.getElementById('sidebar').getBoundingClientRect(); return {l: r.left, r: r.right, w: innerWidth}; }); ok('sidebar hidden on mobile', rect.r <= 0, JSON.stringify(rect));
  await p.click('.menu-btn'); await p.waitForTimeout(300);
  ok('mobile menu opens', await p.evaluate(() => document.getElementById('sidebar').getBoundingClientRect().left >= 0));
  await p.mouse.click(370, 600); await p.waitForTimeout(300);
  ok('tap outside closes menu', await p.evaluate(() => !document.getElementById('sidebar').classList.contains('is-open')));
  await p.click('.menu-btn'); await p.waitForTimeout(300);
  await p.click('.side-nav a[data-route="team"]'); await p.waitForSelector('text=Members');
  const sw = await p.evaluate(() => document.documentElement.scrollWidth);
  ok('no horizontal scroll on mobile', sw <= 390, sw);
  await shot('team-mobile');

  ok('no console errors', errors.length === 0, errors.join(' | '));
  console.log(out.join('\n'));
  console.log(`\n${out.filter((x) => x.startsWith('PASS')).length} passed, ${out.filter((x) => x.startsWith('FAIL')).length} failed`);
  await b.close();
})();
