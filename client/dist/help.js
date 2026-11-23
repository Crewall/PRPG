// The help panel (docs/10 §11.1): short entries from help.json, grouped, searchable,
// opened at an entry by the small "?" links next to features.

import { h } from './ui.js';

let entries = null;
async function load() {
  if (!entries) {
    try { entries = await (await fetch('/help.json')).json(); } catch { entries = []; }
  }
  return entries;
}

let panel = null;

/** Open the help panel, optionally scrolled to one entry. */
export async function openHelp(id) {
  const all = await load();
  panel?.remove();
  const list = h('div', { class: 'help-list' });
  const search = h('input', { type: 'search', placeholder: 'Search help…', class: 'help-search' });
  const render = (q) => {
    const needle = q.trim().toLowerCase();
    const shown = all.filter((e) => !needle || `${e.title} ${e.body} ${e.example ?? ''}`.toLowerCase().includes(needle));
    const groups = [...new Set(shown.map((e) => e.group))];
    list.replaceChildren(
      ...(shown.length ? [] : [h('div', { class: 'sub' }, 'Nothing matches.')]),
      ...groups.flatMap((g) => [
        h('h4', { class: 'help-group' }, g),
        ...shown.filter((e) => e.group === g).map((e) =>
          h('div', { class: 'help-entry', id: `help-${e.id}` },
            h('div', { class: 'help-title' }, e.title),
            h('div', { class: 'help-body' }, e.body),
            e.example ? h('code', { class: 'help-example' }, e.example) : null)),
      ]),
    );
  };
  search.addEventListener('input', () => render(search.value));
  const close = () => { panel?.remove(); panel = null; document.removeEventListener('keydown', onKey); };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  panel = h('div', { class: 'help-bg', onclick: (ev) => { if (ev.target === panel) close(); } },
    h('aside', { class: 'help-panel', role: 'dialog', 'aria-label': 'Help' },
      h('div', { class: 'help-head' }, h('b', {}, 'How it works'), h('button', { class: 'ghost small', onclick: close }, 'Close')),
      search,
      list));
  document.body.append(panel);
  render('');
  if (id) {
    const el = document.getElementById(`help-${id}`);
    if (el) { el.classList.add('focus'); el.scrollIntoView({ block: 'start' }); }
  }
}

/** A small "?" that opens the panel at one entry. */
export function helpLink(id, title = 'What is this?') {
  return h('button', { class: 'help-link', type: 'button', title, 'aria-label': title, onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); openHelp(id); } }, '?');
}

/** First run: a dismissible one-line hint, remembered in this browser. */
export function firstRunHint() {
  const KEY = 'prpg.helpHintSeen';
  try { if (localStorage.getItem(KEY)) return null; } catch { return null; }
  const hint = h('div', { class: 'first-run' },
    h('span', {}, 'New here? Tap ', h('b', {}, '?'), ' for how to play.'),
    h('button', { class: 'ghost small', onclick: () => { try { localStorage.setItem(KEY, '1'); } catch {} hint.remove(); } }, 'Got it'));
  return hint;
}
