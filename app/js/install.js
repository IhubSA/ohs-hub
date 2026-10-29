// Install OHS Hub as an app (phone home screen, desktop, Start menu), and
// tell open copies when a newer version has been uploaded.
import { h, toast } from './ui.js';
import { APP_VERSION } from './version.js';

let deferred = null;              // Chrome/Edge/Samsung "install" prompt, saved for our button
const listeners = new Set();
const notify = () => listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });

export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const ua = navigator.userAgent;
export const isIOS = () => /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isSafariMac = () => /Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|Edg|Firefox/.test(ua);
const isFirefoxDesktop = () => /Firefox/.test(ua) && !/Android/.test(ua);

// The install button is offered unless the app is already running installed.
export const canOfferInstall = () => !isStandalone();
export const onInstallChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export function initInstall() {
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; notify(); });
  addEventListener('appinstalled', () => { deferred = null; toast('OHS Hub is installed. You can open it from your home screen or apps list.'); notify(); });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register(`sw.js?v=${APP_VERSION}`).catch(() => { /* app still works without it */ });
  }
  // Check for a newer upload when the app opens and every 30 minutes.
  setTimeout(checkForUpdate, 8000);
  setInterval(checkForUpdate, 30 * 60 * 1000);
}

export async function installApp() {
  if (deferred) {
    deferred.prompt();
    await deferred.userChoice.catch(() => null);
    deferred = null; notify();
    return;
  }
  showInstructions();
}

function showInstructions() {
  let steps;
  if (isIOS()) {
    steps = [
      'Open OHS Hub in Safari (other browsers on iPhone and iPad can\'t install apps).',
      'Tap the Share button (the square with an arrow pointing up) at the bottom or top of the screen.',
      'Scroll down and tap "Add to Home Screen".',
      'Tap "Add". OHS Hub now opens from its own icon, full screen.',
    ];
  } else if (isSafariMac()) {
    steps = ['In Safari, open the File menu (or the Share button).', 'Choose "Add to Dock".', 'Click "Add". OHS Hub opens from the Dock like any other app.'];
  } else if (isFirefoxDesktop()) {
    steps = ['Firefox on computers can\'t install web apps.', 'Open OHS Hub in Chrome or Microsoft Edge and click "Install app" again.', 'Or bookmark this page in Firefox.'];
  } else {
    steps = [
      'Open your browser\'s menu (⋮ or … at the top right).',
      'Choose "Install OHS Hub", "Install app" or "Add to Home screen".',
      'Confirm. OHS Hub then opens from its own icon.',
      'If you don\'t see the option, reload the page and wait a few seconds, then try again.',
    ];
  }
  const dlg = h('dialog', { class: 'modal', 'aria-label': 'Install OHS Hub' });
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.append(
    h('div', { class: 'modal-head' }, h('h2', {}, 'Install OHS Hub'), h('button', { class: 'modal-close', type: 'button', 'aria-label': 'Close', onclick: close }, '×')),
    h('div', { class: 'modal-body' },
      h('div', { class: 'install-intro' }, h('img', { src: 'icons/icon-192.png', alt: '', width: 56, height: 56 }),
        h('p', {}, 'Install OHS Hub on this device to open it from its own icon, full screen, like any other app. Your records stay safely online; nothing extra is stored on the device.')),
      h('ol', { class: 'install-steps' }, steps.map((s) => h('li', {}, s)))),
    h('div', { class: 'modal-foot' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: close }, 'Got it')));
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.body.append(dlg); dlg.showModal();
}

// ---- Updates ----
let shownFor = null;
export async function checkForUpdate({ manual = false } = {}) {
  try {
    const res = await fetch(`js/version.js?check=${Date.now()}`, { cache: 'no-store' });
    const latest = (await res.text()).match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1];
    if (latest && latest !== APP_VERSION) {
      if (shownFor === latest && !manual) return latest;
      shownFor = latest;
      const t = h('div', { class: 'toast update-toast', role: 'status' },
        h('span', {}, `A new version of OHS Hub (v${latest}) is available.`),
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => reloadForUpdate() }, 'Update now'));
      document.getElementById('toasts').append(t);
      return latest;
    }
    if (manual) toast(`You have the latest version (v${APP_VERSION}).`);
    return APP_VERSION;
  } catch {
    if (manual) toast('Could not check for updates. Check your connection.', 'err');
    return null;
  }
}

async function reloadForUpdate() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
    if (reg?.waiting) reg.waiting.postMessage('skip-waiting');
  } catch { /* reload anyway */ }
  location.reload();
}
