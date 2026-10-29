// OHS Hub — application entry: authentication guard, organisation context,
// shell and hash router.
import { sb, q } from './sb.js';
import { h, icon, toast, errMsg, ROLE_LABELS, fmtDate } from './ui.js';
import { renderSetup } from './views/setup.js';

const root = document.getElementById('root');
const ORG_KEY = 'ohs_current_org';
const INVITE_KEY = 'ohs_pending_invite';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

export const state = { session: null, user: null, profile: null, memberships: [], org: null, role: null, sub: null };

// Permission helpers mirror the database rules (the database is the authority).
export const can = {
  get admin() { return state.role === 'org_admin'; },
  get manage() { return ['org_admin', 'ohs_manager'].includes(state.role); },
  get edit() { return ['org_admin', 'ohs_manager', 'safety_officer'].includes(state.role); },
  get field() { return ['org_admin', 'ohs_manager', 'safety_officer', 'supervisor'].includes(state.role); },
  get staff() { return !!state.role && state.role !== 'employee'; },
};

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  company: '<path d="M3 21h18M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6M9 10h.01M15 10h.01"/>',
  sites: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 20a6.5 6.5 0 0 0-3-5.5"/>',
  team: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
};

const ROUTES = {
  dashboard: { label: 'Dashboard', icon: 'dashboard', load: () => import('./views/dashboard.js') },
  company: { label: 'Company', icon: 'company', load: () => import('./views/company.js') },
  sites: { label: 'Sites & departments', icon: 'sites', load: () => import('./views/sites.js') },
  people: { label: 'People', icon: 'people', load: () => import('./views/people.js'), when: () => can.staff },
  team: { label: 'Team & roles', icon: 'team', load: () => import('./views/team.js') },
  notifications: { label: 'Notifications', icon: 'bell', load: () => import('./views/notifications.js') },
  profile: { label: 'My profile', icon: 'profile', load: () => import('./views/profile.js') },
};

export function navigate(route) { location.hash = `#/${route}`; }

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
async function boot() {
  // Invitation links arrive as app/?invite=TOKEN. Keep the token until the
  // person is signed in, then remove it from the address bar.
  const url = new URL(location.href);
  const invite = url.searchParams.get('invite');
  if (invite && /^[a-f0-9]{64}$/.test(invite)) {
    store.set(INVITE_KEY, invite);
    url.searchParams.delete('invite');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }

  const { data } = await sb.auth.getSession();
  if (!data.session) {
    const pending = store.get(INVITE_KEY) ? '?invite=1' : '';
    location.replace(`../signin.html${pending}`);
    return;
  }
  state.session = data.session;
  state.user = data.session.user;
  if (/access_token|type=/.test(location.hash)) history.replaceState(null, '', location.pathname + '#/dashboard');

  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') location.replace('../signin.html');
  });

  await loadMemberships();

  const pending = store.get(INVITE_KEY);
  if (pending) {
    store.del(INVITE_KEY);
    try {
      const orgId = await q(sb.rpc('accept_invitation', { p_token: pending }));
      store.set(ORG_KEY, orgId);
      await loadMemberships();
      toast('Invitation accepted. Welcome to the team.');
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  }

  if (!state.memberships.length) {
    renderSetup(root, { state, onDone: async (orgId) => { store.set(ORG_KEY, orgId); await loadMemberships(); start(); } });
    return;
  }
  start();
}

export async function loadMemberships() {
  const [profile, memberships] = await Promise.all([
    q(sb.from('user_profiles').select('*').eq('id', state.user.id).maybeSingle()),
    q(sb.from('organisation_memberships')
      .select('org_id, role, status, site_ids, organisations(id, name, industry)')
      .eq('user_id', state.user.id).eq('status', 'active')),
  ]);
  state.profile = profile;
  state.memberships = (memberships || []).filter((m) => m.organisations);
  state.memberships.sort((a, b) => a.organisations.name.localeCompare(b.organisations.name));
}

export async function selectOrg(orgId) {
  const m = state.memberships.find((x) => x.org_id === orgId) || state.memberships[0];
  state.org = m.organisations;
  state.role = m.role;
  store.set(ORG_KEY, m.org_id);
  state.sub = await q(sb.from('organisation_subscriptions')
    .select('status, trial_ends_at, billing_status, subscription_plans(name, max_users, max_sites)')
    .eq('org_id', m.org_id).maybeSingle()).catch(() => null);
}

async function start() {
  const preferred = store.get(ORG_KEY) || state.profile?.default_org_id;
  await selectOrg(preferred);
  renderShell();
  window.addEventListener('hashchange', route);
  route();
}

// ---------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------
let els = {};
function renderShell() {
  root.innerHTML = '';
  const nav = h('nav', { class: 'side-nav', 'aria-label': 'App' });
  for (const [key, r] of Object.entries(ROUTES)) {
    if (r.when && !r.when()) continue;
    nav.append(h('a', { href: `#/${key}`, dataset: { route: key } }, icon(ICONS[r.icon]), r.label));
  }
  const orgSwitch = state.memberships.length > 1
    ? h('select', { id: 'org-select', 'aria-label': 'Organisation', onchange: async (e) => {
        await selectOrg(e.target.value); renderShell(); route();
        toast(`Switched to ${state.org.name}`);
      } }, state.memberships.map((m) => h('option', { value: m.org_id, selected: m.org_id === state.org.id }, m.organisations.name)))
    : h('div', { class: 'org-name' }, state.org.name);

  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar' },
    h('a', { class: 'brand', href: '#/dashboard', 'aria-label': 'OHS Hub dashboard', html:
      '<img src="../assets/img/logo-light.png" alt="" width="110" height="44">' }),
    h('div', { class: 'org-switch' }, h('label', { for: 'org-select' }, 'Organisation'), orgSwitch),
    nav,
    h('div', { class: 'side-foot' },
      h('div', { class: 'who' }, state.profile?.full_name || state.user.email),
      h('div', { class: 'role' }, ROLE_LABELS[state.role]),
      h('button', { type: 'button', onclick: async () => { await sb.auth.signOut(); } }, 'Sign out')));

  els.bellCount = h('span', { class: 'count', hidden: true });
  const trial = state.sub?.status === 'trialing' && state.sub.trial_ends_at
    ? h('span', { class: 'trial-pill' }, `Free trial until ${fmtDate(state.sub.trial_ends_at)}`) : null;
  const topbar = h('header', { class: 'topbar' },
    h('button', { class: 'bell menu-btn', type: 'button', 'aria-controls': 'sidebar', 'aria-expanded': 'false',
      onclick: (e) => { sidebar.classList.add('can-animate'); const open = sidebar.classList.toggle('is-open'); e.currentTarget.setAttribute('aria-expanded', String(open)); } },
      icon(ICONS.menu), 'Menu'),
    h('span', { class: 'spacer' }), trial,
    h('a', { class: 'bell', href: '#/notifications', 'aria-label': 'Notifications' }, icon(ICONS.bell), els.bellCount));
  els.content = h('main', { class: 'content', id: 'main', tabindex: '-1' });
  els.sidebar = sidebar;
  // Tap outside the open mobile menu, or press Escape, to close it.
  const menuBtn = topbar.querySelector('.menu-btn');
  const closeMenu = () => { sidebar.classList.remove('is-open'); menuBtn.setAttribute('aria-expanded', 'false'); };
  document.addEventListener('click', (e) => {
    if (sidebar.classList.contains('is-open') && !sidebar.contains(e.target) && !menuBtn.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sidebar.classList.contains('is-open')) { closeMenu(); menuBtn.focus(); } });
  root.append(h('div', { class: 'app-shell' }, sidebar, h('div', { class: 'main' }, topbar, els.content)));
  refreshBell();
}

export async function refreshBell() {
  try {
    const { count } = await sb.from('notifications').select('id', { count: 'exact', head: true })
      .eq('user_id', state.user.id).eq('org_id', state.org.id).is('read_at', null);
    els.bellCount.hidden = !count;
    els.bellCount.textContent = count > 99 ? '99+' : String(count || '');
    els.bellCount.parentElement.setAttribute('aria-label', count ? `Notifications, ${count} unread` : 'Notifications');
  } catch { /* non-critical */ }
}

async function route() {
  const [key, ...params] = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/');
  const r = ROUTES[key] && (!ROUTES[key].when || ROUTES[key].when()) ? ROUTES[key] : null;
  if (!r) { navigate('dashboard'); return; }
  els.sidebar.classList.remove('is-open');
  els.sidebar.querySelectorAll('.side-nav a').forEach((a) => {
    if (a.dataset.route === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.title = `${r.label} | OHS Hub`;
  els.content.replaceChildren(h('p', { class: 'loading', role: 'status' }, 'Loading…'));
  try {
    const mod = await r.load();
    const view = h('div');
    await mod.render(view, { state, can, params, navigate, refreshBell, reload: route });
    els.content.replaceChildren(view);
    els.content.focus({ preventScroll: true });
  } catch (e) {
    console.error(e);
    els.content.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'This page could not load'),
      h('p', {}, errMsg(e)), h('button', { class: 'btn btn-secondary', onclick: route }, 'Try again')));
  }
  refreshBell();
}

boot().catch((e) => {
  console.error(e);
  root.replaceChildren(h('div', { class: 'center-page' }, h('div', { class: 'card setup' },
    h('h1', {}, 'OHS Hub could not start'), h('p', {}, errMsg(e)),
    h('button', { class: 'btn btn-primary', onclick: () => location.reload() }, 'Reload'))));
});
