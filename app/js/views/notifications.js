// In-app notifications for the current organisation. Email copies are sent
// by the send-notifications Edge Function through Resend.
import { sb, q } from '../sb.js';
import { h, relTime, toast, errMsg, emptyState, fmtDateTime } from '../ui.js';

export async function render(view, { state, reload, refreshBell }) {
  const rows = await q(sb.from('notifications').select('id, title, body, link, read_at, created_at, email_status')
    .eq('user_id', state.user.id).eq('org_id', state.org.id).order('created_at', { ascending: false }).limit(100));
  const unread = rows.filter((n) => !n.read_at);

  const markAll = async () => {
    try {
      await q(sb.from('notifications').update({ read_at: new Date().toISOString() }).in('id', unread.map((n) => n.id)));
      toast('All notifications marked as read.'); refreshBell(); reload();
    } catch (e) { toast(errMsg(e), 'err'); }
  };
  view.append(h('div', { class: 'page-title' },
    h('div', {}, h('h1', {}, 'Notifications'), h('p', {}, 'Assignments, approvals, due dates and reminders for this organisation.')),
    unread.length ? h('button', { class: 'btn btn-secondary', onclick: markAll }, 'Mark all as read') : null));

  const card = h('div', { class: 'card' });
  view.append(card);
  if (!rows.length) {
    card.append(emptyState('Nothing here yet', 'You will be notified here, and by email, when something needs your attention.'));
    return;
  }
  for (const n of rows) {
    const markRead = async () => {
      if (n.read_at) return;
      await sb.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', n.id);
      refreshBell();
    };
    // Links point at app routes; only follow ones this release can open.
    const route = (n.link || '').replace(/^app\/#\//, '');
    const known = /^(dashboard|company|sites|people|team|profile)/.test(route);
    const title = known
      ? h('a', { href: `#/${route}`, onclick: markRead }, h('strong', {}, n.title))
      : h('strong', {}, n.title);
    const item = h('div', { class: `notif ${n.read_at ? '' : 'unread'}` },
      h('span', { class: 'dot', 'aria-label': n.read_at ? null : 'Unread' }),
      h('div', {}, title, n.body ? h('p', {}, n.body) : null,
        n.read_at ? null : h('button', { class: 'btn-link', style: 'padding-left:0', onclick: async (e) => {
          await markRead(); item.classList.remove('unread'); e.currentTarget.remove();
        } }, 'Mark as read')),
      h('time', { datetime: n.created_at, title: fmtDateTime(n.created_at) }, relTime(n.created_at)));
    card.append(item);
  }
}
