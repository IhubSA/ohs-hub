// The signed-in person's own profile, email preferences and password.
import { sb, q } from '../sb.js';
import { h, toast, errMsg, ROLE_LABELS, fmtDate } from '../ui.js';
import { APP_VERSION, APP_RELEASED } from '../version.js';
import { installApp, canOfferInstall, isStandalone, checkForUpdate } from '../install.js';

export async function render(view, { state }) {
  const p = state.profile || {};
  view.append(h('div', { class: 'page-title' }, h('div', {}, h('h1', {}, 'My profile'), h('p', {}, state.user.email))));

  // ---- Details ----
  const name = h('input', { id: 'p-name', value: p.full_name || '', maxlength: 120, autocomplete: 'name' });
  const title = h('input', { id: 'p-title', value: p.job_title || '', maxlength: 120, autocomplete: 'organization-title' });
  const emails = h('input', { type: 'checkbox', id: 'p-email', checked: p.notification_email !== false });
  const save = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save profile');
  const details = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'field' }, h('label', { for: 'p-name' }, 'Full name'), name, h('p', { class: 'error' })),
    h('div', { class: 'field' }, h('label', { for: 'p-title' }, 'Job title', h('span', { class: 'muted' }, ' (optional)')), title),
    h('label', { class: 'switch-row', for: 'p-email' }, emails, h('span', {}, 'Email me my notifications',
      h('small', {}, 'You will always see notifications in OHS Hub. Untick to stop the email copies.'))),
    h('div', {}, save));
  details.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = name.closest('.field');
    const bad = name.value.trim().length < 2;
    f.classList.toggle('has-error', bad); f.querySelector('.error').textContent = bad ? 'Enter your full name.' : '';
    if (bad) return;
    save.disabled = true;
    try {
      const row = { full_name: name.value.trim(), job_title: title.value.trim() || null, notification_email: emails.checked };
      await q(sb.from('user_profiles').update(row).eq('id', state.user.id));
      Object.assign(state.profile, row);
      document.querySelector('.side-foot .who').textContent = row.full_name;
      toast('Profile saved.');
    } catch (err) { toast(errMsg(err), 'err'); }
    save.disabled = false;
  });

  // ---- Password ----
  const pw = h('input', { id: 'p-pw', type: 'password', autocomplete: 'new-password' });
  const pw2 = h('input', { id: 'p-pw2', type: 'password', autocomplete: 'new-password' });
  const pwBtn = h('button', { class: 'btn btn-secondary', type: 'submit' }, 'Change password');
  const pwForm = h('form', { class: 'form', novalidate: true },
    h('div', { class: 'field' }, h('label', { for: 'p-pw' }, 'New password'), pw, h('p', { class: 'hint' }, 'At least 10 characters, including a letter and a number.'), h('p', { class: 'error' })),
    h('div', { class: 'field' }, h('label', { for: 'p-pw2' }, 'Confirm new password'), pw2, h('p', { class: 'error' })),
    h('div', {}, pwBtn));
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const strong = pw.value.length >= 10 && /[A-Za-z]/.test(pw.value) && /\d/.test(pw.value);
    const set = (el, msg) => { const f = el.closest('.field'); f.classList.toggle('has-error', !!msg); f.querySelector('.error').textContent = msg; };
    set(pw, strong ? '' : 'Use at least 10 characters, including a letter and a number.');
    set(pw2, pw.value === pw2.value ? '' : 'The passwords do not match.');
    if (!strong || pw.value !== pw2.value) return;
    pwBtn.disabled = true;
    const { error } = await sb.auth.updateUser({ password: pw.value });
    pwBtn.disabled = false;
    if (error) { toast(errMsg(error), 'err'); return; }
    pwForm.reset(); toast('Password changed.');
  });

  view.append(h('div', { class: 'grid-2' },
    h('div', { class: 'card' }, h('h2', {}, 'Your details'), details),
    h('div', {},
      h('div', { class: 'card' }, h('h2', {}, 'Password'), pwForm),
      h('div', { class: 'card' }, h('h2', {}, 'Your organisations'),
        h('ul', { style: 'padding-left:18px;margin:8px 0 0' }, state.memberships.map((m) =>
          h('li', {}, m.organisations.name, h('span', { class: 'muted' }, ` (${ROLE_LABELS[m.role]})`))))),
      aboutCard())));
}

function aboutCard() {
  const installed = isStandalone();
  return h('div', { class: 'card about-app' },
    h('div', { class: 'about-head' }, h('img', { src: 'icons/icon-192.png', alt: '', width: 56, height: 56 }),
      h('div', {}, h('h2', {}, 'OHS Hub on this device'),
        h('p', { class: 'muted', style: 'margin:2px 0 0' }, `Version ${APP_VERSION}, released ${fmtDate(APP_RELEASED)}`))),
    h('p', {}, installed
      ? 'You are using the installed app. It opens from its own icon and updates itself when a new version is released.'
      : 'Install OHS Hub on your phone, tablet or computer to open it from its own icon, full screen, like any other app.'),
    h('div', { class: 'btn-row' },
      canOfferInstall() ? h('button', { class: 'btn btn-primary', type: 'button', onclick: installApp }, 'Install app') : null,
      h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => checkForUpdate({ manual: true }) }, 'Check for updates')),
    h('p', { class: 'small muted', style: 'margin:12px 0 0' }, 'Your records are kept online, not on the device, so signing in anywhere shows the same information.'));
}
