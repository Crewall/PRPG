// The version check (docs/10 §11.2). After an update, an open tab keeps running the scripts it loaded, and the
// server keeps running the code it started with. This notices either and says what to do: reload the page, or
// restart the server.

import { h, api } from './ui.js';
import { helpLink } from './help.js';

let first = null; // what the server reported when this page loaded
let latest = null;
let dismissed = '';
let banner = null;

/** The last version report (for the connection details), or null before the first check. */
export const versionInfo = () => latest;

function show(kind, text, action) {
  const key = `${kind}:${latest?.client}:${latest?.commitOnDisk}`;
  if (dismissed === key) return;
  banner?.remove();
  banner = h('div', { class: 'update-banner', role: 'status' },
    h('span', {}, text, ' ', helpLink('updates')),
    action,
    h('button', { class: 'ghost small', title: 'Hide until the next update', onclick: () => { dismissed = key; banner.remove(); banner = null; } }, '×'));
  document.body.append(banner);
}

export async function checkVersion() {
  let v;
  try { v = await api.get('/api/system/version'); } catch { return; } // an older server has no check: nothing to say
  latest = v;
  if (!first) first = v;
  if (v.restartNeeded) {
    show('restart', `PRPG was updated${v.commitOnDisk && v.commitOnDisk !== v.commit ? ` (to ${v.commitOnDisk})` : ''}, but the server is still running the old code. Restart it (in Termux: Ctrl+C, then npm start), then reload this page.`,
      h('button', { class: 'small', onclick: () => location.reload() }, 'Reload'));
  } else if (v.client !== first.client || v.commit !== first.commit) { // new page files, or a server restarted on a new commit
    show('reload', 'PRPG was updated. Reload the page to use the new version.', h('button', { class: 'small primary', onclick: () => location.reload() }, 'Reload'));
  } else if (banner) {
    banner.remove();
    banner = null;
  }
}

checkVersion();
setInterval(checkVersion, 3 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkVersion(); });
window.addEventListener('online', checkVersion);
