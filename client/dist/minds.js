// Minds engine UI (docs/10 §11, docs/11): the input preview, character cards,
// the sheet editor (advanced mode), the scenario editor, and the Cast and POV
// drawer tabs. Everything goes through the Minds API (src/api/mindsRoutes.ts).
//
// `ctx` comes from the play view: { storyId, advanced(), busy(), forced (Set),
// talk(c), toggleForce(c), dialoguePartner(), refresh() }.

import { h, api } from './ui.js';
import { helpLink } from './help.js';

// ---- Input preview (docs/10 §6): how the message will be read ----

/** The same lanes as the server (src/minds/contracts.ts parsePlayerInput). */
export function parsePlayerInput(text) {
  const ooc = [];
  let rest = text.replace(/\(\(([\s\S]*?)\)\)/g, (_m, inner) => { ooc.push(inner.trim()); return ' '; });
  const say = [];
  rest = rest.replace(/["“]([^"”]*)["”]/g, (_m, inner) => { if (inner.trim()) say.push(inner.trim()); return ' … '; });
  const doText = rest.replace(/(\s*…\s*)+/g, ' … ').replace(/\s+/g, ' ').replace(/^[\s…,.;:]+|[\s…,;:]+$/g, '').trim();
  return { say: say.join(' '), do: doText, ooc: ooc.filter(Boolean).join(' ') };
}

/** A one-line reading of the input box: 🗣 said · 🤚 tried · 📝 note. Empty when the box is. */
export function renderInputPreview(el, text, { dialogue = false } = {}) {
  const p = parsePlayerInput(text);
  const parts = [];
  if (p.say) parts.push(h('span', { class: 'lane say' }, '🗣 ', p.say));
  if (p.do) parts.push(h('span', { class: 'lane do' }, dialogue ? '👋 ' : '🤚 ', p.do));
  if (p.ooc) parts.push(h('span', { class: 'lane ooc' }, '📝 ', p.ooc));
  el.replaceChildren(...parts);
  el.style.display = parts.length ? '' : 'none';
}

// ---- Small helpers ----

/** el.replaceChildren, minus null/false kids (the DOM would print them as text). */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));

function modal(title, ...body) {
  const bg = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); } });
  const box = h('div', { class: 'modal wide' }, h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'ghost small', onclick: () => bg.remove() }, 'Close')), ...body);
  bg.append(box);
  document.body.append(bg);
  return { bg, box, close: () => bg.remove() };
}
const row = (label, el, hint) => h('label', { class: 'form-row' }, h('span', { class: 'sub' }, label), el, hint ? h('span', { class: 'hint' }, hint) : null);
const input = (value, attrs = {}) => h('input', { type: 'text', value: value ?? '', ...attrs });
const textarea = (value, rows = 3, attrs = {}) => { const t = h('textarea', { rows: String(rows), ...attrs }); t.value = value ?? ''; return t; };
const select = (options, current) => h('select', {}, ...options.map(([v, l]) => h('option', { value: v, ...(v === current ? { selected: true } : {}) }, l)));
const errLine = () => h('div', { class: 'sub err' });
const fmtValue = (v) => (Array.isArray(v) ? (v.length ? v.join(', ') : '—') : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v ?? '—'));

async function mindsView(ctx) {
  return api.get(`/api/stories/${ctx.storyId}/minds${ctx.advanced() ? '?advanced=1' : ''}`);
}

// ---- Character card: what you can perceive of someone, and what you can do ----

export async function openCharacterCard(ctx, objectId, { present = true } = {}) {
  let view;
  try { view = await mindsView(ctx); } catch (e) { alert(e.message); return; }
  const c = view.characters.find((x) => x.objectId === objectId);
  if (!c) return;
  const adv = ctx.advanced();
  const vars = c.variables.filter((v) => adv || c.isPlayer || v.visibility === 'public');
  const forced = ctx.forced.has(c.objectId);
  const unknown = !c.isPlayer && (adv ? c.playerKnowsName === false : c.nameKnown === false);
  const m = modal(`${c.isPlayer ? '🎭 ' : ''}${c.name}${c.pronouns ? ` (${c.pronouns})` : ''}`,
    h('div', { class: 'card-sub' }, `#${c.handle}${c.isPlayer ? ' · your character' : present ? ' · here with you' : ' · not here'}${unknown ? (adv ? ` · you don't know this name (to you: ${c.knownAs || 'someone'})` : ' · name unknown to you') : ''}${adv && !c.isPlayer ? (c.seeded ? ' · seeded' : ' · not seeded yet') : ''}`),
    c.appearance ? h('p', {}, c.appearance) : h('p', { class: 'sub' }, '(no appearance yet)'),
    c.state ? h('p', {}, h('span', { class: 'sub' }, 'State: '), `"${c.state}"`) : null,
    c.description || c.concept ? h('details', { open: c.isPlayer ? null : true }, h('summary', { class: 'sub' }, c.isPlayer ? 'Who you are' : 'Who they are (private)'), h('p', { class: 'prose' }, c.description || c.concept)) : null,
    c.ties?.length ? h('p', {}, h('span', { class: 'sub' }, c.isPlayer ? 'Your people: ' : 'Their people: '), c.ties.map((t) => `${t.name} (${t.label})`).join(', '), ' ', helpLink('ties')) : null,
    c.relations?.length ? h('p', {}, h('span', { class: 'sub' }, 'Toward others: '),
      [...new Set(c.relations.flatMap((r) => r.values.map((v) => v.label)))].map((label) => `${label}: ${c.relations.flatMap((r) => r.values.filter((v) => v.label === label).map((v) => `${r.name} ${v.display}`)).join(', ')}`).join(' · '), ' ', helpLink('relations')) : null,
    vars.length
      ? h('table', { class: 'vars' }, ...vars.map((v) => h('tr', {}, h('td', { class: 'sub' }, v.label), h('td', {}, v.display), adv ? h('td', { class: `vis ${v.visibility}` }, v.visibility) : null)))
      : null,
    !adv && !c.isPlayer ? h('div', { class: 'sub' }, 'You see what anyone present could: appearance, pronouns and what is visibly true.') : null,
    h('div', { class: 'row card-actions' },
      !c.isPlayer && present ? h('button', { class: 'primary', disabled: ctx.busy() || ctx.dialoguePartner() === c.objectId ? true : null, onclick: () => { m.close(); ctx.talk(c); } }, ctx.dialoguePartner() === c.objectId ? '💬 Talking' : '💬 Talk') : null,
      !c.isPlayer && present ? h('button', { title: 'Make sure they are called next round', onclick: () => { ctx.toggleForce(c); m.close(); } }, forced ? '⚡ Will act — undo' : '⚡ Act next round') : null,
      c.isPlayer || adv ? h('button', { onclick: () => { m.close(); openSheetEditor(ctx, c.objectId); } }, adv && !c.isPlayer ? '📋 Sheet' : '✎ Edit') : null,
      helpLink(c.isPlayer ? 'player-character' : 'cast-bar')));
}

// ---- Sheet editor (advanced mode; the player's own sheet always) ----

export async function openSheetEditor(ctx, objectId) {
  let view, defs, tiers = [];
  try {
    [view, defs] = await Promise.all([api.get(`/api/stories/${ctx.storyId}/minds?advanced=1`), api.get(`/api/stories/${ctx.storyId}/variables/defs`)]);
    tiers = (await api.get('/api/system/settings')).runtimeConfig?.tiers ?? [];
  } catch (e) { if (!view) { alert(e.message); return; } }
  const c = view.characters.find((x) => x.objectId === objectId);
  if (!c) return;
  const adv = ctx.advanced();
  const nameIn = input(c.realName ?? c.name);
  const pronIn = input(c.pronouns, { list: 'pronoun-list', maxlength: '40' });
  const knownAsIn = input(c.knownAs, { maxlength: '60', placeholder: 'e.g. the elf girl in green' });
  const knowsBox = h('input', { type: 'checkbox' });
  knowsBox.checked = c.playerKnowsName !== false;
  const lookIn = textarea(c.appearance, 2);
  const whoIn = textarea(c.description, 5);
  const conceptIn = textarea(c.concept, 2, { placeholder: 'e.g. a smuggler\'s daughter who wants out of the trade' });
  const stateIn = input(c.state);
  // Ties: what each other person is to this one. People are listed as the player knows them, unless advanced.
  let people = view.characters;
  if (!adv) { try { people = (await mindsView(ctx)).characters; } catch { /* keep the advanced list */ } }
  const others = people.filter((x) => x.objectId !== c.objectId);
  const tieRows = [];
  const tiesBox = h('div', { class: 'ties-edit' });
  const addTieRow = (other = '', label = '') => {
    const sel = select([['', '(someone)'], ...others.map((x) => [x.objectId, `${x.isPlayer ? '🎭 ' : ''}${x.name} · #${x.handle}`])], other);
    const lab = input(label, { maxlength: '120', placeholder: 'what they are to them: older brother, employer…' });
    const line = h('div', { class: 'row tie-row' }, sel, lab);
    const entry = { sel, lab, line };
    line.append(h('button', { class: 'ghost small', title: 'Remove this tie', onclick: () => { tieRows.splice(tieRows.indexOf(entry), 1); line.remove(); } }, '×'));
    tieRows.push(entry);
    tiesBox.append(line);
  };
  for (const t of c.ties ?? []) addTieRow(t.other, t.label);
  const readTies = () => {
    const out = Object.fromEntries((c.ties ?? []).map((t) => [t.other, '']));
    for (const { sel, lab } of tieRows) if (sel.value && lab.value.trim()) out[sel.value] = lab.value.trim();
    return out;
  };
  const tierSel = select([['', '(the role\'s tier)'], ...tiers.map((t) => [t.id, t.label])], c.tierId ?? '');
  const err = errLine();
  const saved = h('span', { class: 'sub' });
  const save = h('button', { class: 'primary', onclick: async () => {
    err.textContent = ''; saved.textContent = '';
    const body = { name: nameIn.value.trim(), pronouns: pronIn.value.trim(), knownAs: knownAsIn.value.trim(), appearance: lookIn.value.trim(), description: whoIn.value.trim(), concept: conceptIn.value.trim(), ties: readTies() };
    if (adv && !c.isPlayer) body.playerKnowsName = knowsBox.checked;
    if (adv || c.isPlayer) body.state = stateIn.value.trim();
    if (adv && !c.isPlayer) body.tierId = tierSel.value || null;
    try { await api.patch(`/api/stories/${ctx.storyId}/minds/${c.objectId}`, body); saved.textContent = 'Saved.'; ctx.refresh(); } catch (e) { err.textContent = e.message; }
  } }, 'Save sheet');

  const sections = [
    row('Name', nameIn),
    row('Pronouns', pronIn, 'Public: others see these with the name.'),
    row('Known to strangers as', knownAsIn, 'What someone who doesn\'t know the name calls them.'),
    adv && !c.isPlayer ? h('label', { class: 'sub' }, knowsBox, ' You (the player) know this name') : null,
    h('datalist', { id: 'pronoun-list' }, ...['she/her', 'he/him', 'they/them'].map((v) => h('option', { value: v }))),
    row('Appearance', lookIn, 'Public: what anyone sees at a glance.'),
    !c.isPlayer || c.concept ? row('In short', conceptIn, 'Who they are in a sentence or two (the narrator\'s hand-over). Their mind uses it until the description is written.') : null,
    row(c.isPlayer ? 'Who you are' : 'Description', whoIn, c.isPlayer ? 'Only the narrator reads this.' : 'Private: only this character\'s mind and the narrator read it.'),
    h('div', { class: 'form-row ties-field' }, h('span', { class: 'field-label' }, c.isPlayer ? 'Your people ' : 'Their people ', helpLink('ties')), tiesBox,
      h('div', { class: 'row' }, h('button', { class: 'small', onclick: () => addTieRow() }, '+ Add tie')),
      h('span', { class: 'hint' }, 'From this character\'s side. A tie also means both know each other\'s name.')),
    row('State', stateIn, 'One sentence: how they feel or are right now.'),
    adv && !c.isPlayer ? row('Model tier', tierSel, 'Override the tier this character\'s mind runs on.') : null,
    h('div', { class: 'row' }, save, saved), err,
  ];

  // Values: one editor per variable this holder has.
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const valueRows = c.variables.map((v) => {
    const d = byKey.get(v.key);
    let el;
    if (v.type === 'number') el = h('input', { type: 'number', value: String(v.value ?? ''), step: String(d?.step ?? 1), ...(d?.min != null ? { min: String(d.min) } : {}), ...(d?.max != null ? { max: String(d.max) } : {}) });
    else if (v.type === 'flag') { el = h('input', { type: 'checkbox' }); el.checked = !!v.value; }
    else if (v.type === 'choice') el = select((d?.options ?? []).map((o) => [o, o]), v.value);
    else if (v.type === 'list') el = input(Array.isArray(v.value) ? v.value.join(', ') : '', { placeholder: 'comma, separated, items' });
    else el = input(v.value);
    const read = () => (v.type === 'number' ? Number(el.value) : v.type === 'flag' ? el.checked : v.type === 'list' ? el.value.split(',').map((x) => x.trim()).filter(Boolean) : el.value);
    return { v, el, read };
  });
  const valuesErr = errLine();
  const valuesBox = adv && valueRows.length
    ? h('details', { open: true }, h('summary', {}, 'Variables ', helpLink('variables')),
        h('table', { class: 'vars edit' }, ...valueRows.map(({ v, el }) => h('tr', {}, h('td', { class: 'sub' }, v.label), h('td', {}, el), h('td', { class: `vis ${v.visibility}` }, v.visibility)))),
        h('div', { class: 'row' }, h('button', { onclick: async () => {
          valuesErr.textContent = '';
          const changes = valueRows.filter(({ v, read }) => JSON.stringify(read()) !== JSON.stringify(v.value)).map(({ v, read }) => ({ holder: c.objectId, key: v.key, op: 'set', value: read() }));
          if (!changes.length) { valuesErr.textContent = 'Nothing changed.'; return; }
          try {
            const out = await api.patch(`/api/stories/${ctx.storyId}/variables/values`, { changes });
            const bad = out.filter((o) => o.result !== 'applied');
            valuesErr.textContent = bad.length ? bad.map((o) => `${o.key}: ${o.result}${o.reason ? ` (${o.reason})` : ''}`).join(' · ') : 'Saved.';
            ctx.refresh();
          } catch (e) { valuesErr.textContent = e.message; }
        } }, 'Save values')), valuesErr)
    : null;

  // Toward others: relation variables, one row per person met (docs/11 §4.9).
  const rels = (c.relations ?? []).filter((r) => r.values.length);
  let relationsBox = null;
  if (adv && rels.length) {
    const cols = [...new Map(rels.flatMap((r) => r.values.map((v) => [v.key, v.label]))).entries()];
    const cells = [];
    const editor = (v) => {
      const d = byKey.get(v.key);
      let el;
      if (v.type === 'number') el = h('input', { type: 'number', value: String(v.value ?? ''), step: String(d?.step ?? 1), style: 'width:5em', ...(d?.min != null ? { min: String(d.min) } : {}), ...(d?.max != null ? { max: String(d.max) } : {}) });
      else if (v.type === 'flag') { el = h('input', { type: 'checkbox' }); el.checked = !!v.value; }
      else if (v.type === 'choice') el = select((d?.options ?? []).map((o) => [o, o]), v.value);
      else if (v.type === 'list') el = input(Array.isArray(v.value) ? v.value.join(', ') : '', { placeholder: 'a, b' });
      else el = input(v.value, { style: 'width:8em' });
      const read = () => (v.type === 'number' ? Number(el.value) : v.type === 'flag' ? el.checked : v.type === 'list' ? el.value.split(',').map((x) => x.trim()).filter(Boolean) : el.value);
      cells.push({ v, read });
      return el;
    };
    const relErr = errLine();
    relationsBox = h('details', { open: true, class: 'sheet-section' }, h('summary', {}, 'Toward others ', helpLink('relations')),
      h('div', { class: 'table-scroll' }, h('table', { class: 'vars edit rel' },
        h('tr', {}, h('th', {}, ''), ...cols.map(([, label]) => h('th', { class: 'sub' }, label))),
        ...rels.map((r) => h('tr', {}, h('td', {}, h('b', {}, r.name), h('span', { class: 'sub' }, ` #${r.handle}`)),
          ...cols.map(([key]) => { const v = r.values.find((x) => x.key === key); return h('td', {}, v ? editor(v) : h('span', { class: 'sub' }, '—')); }))))),
      h('div', { class: 'row' }, h('button', { onclick: async () => {
        relErr.textContent = '';
        const changes = cells.filter(({ v, read }) => JSON.stringify(read()) !== JSON.stringify(v.value)).map(({ v, read }) => ({ holder: v.holder, key: v.key, op: 'set', value: read() }));
        if (!changes.length) { relErr.textContent = 'Nothing changed.'; return; }
        try {
          const out = await api.patch(`/api/stories/${ctx.storyId}/variables/values`, { changes });
          const bad = out.filter((o) => o.result !== 'applied');
          relErr.textContent = bad.length ? bad.map((o) => `${o.key}: ${o.result}${o.reason ? ` (${o.reason})` : ''}`).join(' · ') : 'Saved.';
          ctx.refresh();
        } catch (e) { relErr.textContent = e.message; }
      } }, 'Save')), relErr);
  }

  // The mind: agenda, opinions and feelings by person, notes, faded (docs/11 §5.10). The player character has none.
  const mindBox = adv && !c.isPlayer ? h('details', { open: true, class: 'sheet-section' }, h('summary', {}, 'Mind: agenda, opinions, feelings, notes ', helpLink('thoughts')), mindSheet(ctx, c.objectId, view.characters)) : null;
  const profileBox = h('details', { open: !adv || c.isPlayer ? true : null, class: 'sheet-section' }, h('summary', {}, 'Profile'), ...sections);
  if (valuesBox) valuesBox.classList.add('sheet-section');

  modal(`${c.isPlayer ? 'Your character' : `${c.name}'s sheet`}`, profileBox, valuesBox, relationsBox, mindBox);
}

const KINDS = [['agenda', 'Agenda'], ['opinion', 'Opinion'], ['feeling', 'Feeling'], ['note', 'Note']];

/** An importance as a small 1–10 bar: written, and the current value when it has faded. */
function importanceBar(t) {
  const cur = t.status === 'active' ? t.current ?? t.importance : t.importance;
  const label = cur !== t.importance && t.status === 'active' ? `${t.importance}→${cur}` : String(t.importance);
  return h('span', { class: 'imp', title: `Importance ${t.importance}/10${cur !== t.importance ? `, now ${cur} (fading)` : ''}${t.fades === false ? ' · never fades' : ''}` },
    h('span', { class: 'imp-bar' }, h('span', { class: 'imp-fill', style: `width:${cur * 10}%` })), h('span', { class: 'imp-num' }, label));
}

/**
 * A character's mind on its sheet (advanced mode, docs/11 §5.10): every thought editable in place, grouped as the
 * character holds them. `people` is the advanced view's characters (for "about").
 */
export function mindSheet(ctx, owner, people) {
  const box = h('div', { class: 'mind-sheet' });
  const others = people.filter((p) => p.objectId !== owner);
  const nameOf = (p) => `${p.isPlayer ? '🎭 ' : ''}${p.realName ?? p.name}`;
  const aboutOptions = [['', '(no one)'], ...others.map((p) => [p.objectId, `${nameOf(p)} · #${p.handle}`])];

  const load = async () => {
    let data;
    try { data = await api.get(`/api/stories/${ctx.storyId}/thoughts?owner=${encodeURIComponent(owner)}&includeRevoked=1`); } catch (e) { fill(box, h('div', { class: 'sub err' }, e.message)); return; }
    const all = data.thoughts;
    const active = all.filter((t) => t.status === 'active');
    const byCur = (a, b) => (b.current ?? b.importance) - (a.current ?? a.importance) || b.seq - a.seq;
    const err = errLine();
    const save = async (t, body) => { err.textContent = ''; try { await api.patch(`/api/thoughts/${t.id}`, body); load(); } catch (e) { err.textContent = e.message; } };

    const row = (t) => {
      const line = h('div', { class: `thought v2 ${t.status}${t.pinned ? ' pinned' : ''}` });
      const view = () => fill(line,
        h('span', { class: `kind-chip ${t.kind}`, title: t.kind }, t.kind === 'agenda' ? 'agenda' : t.kind),
        importanceBar(t),
        h('span', { class: 'thought-text', title: 'Tap to edit', onclick: () => t.status === 'active' && edit() },
          t.text,
          t.tags.filter((g) => g !== `#${t.aboutHandle}`).length ? h('span', { class: 'sub' }, ` [${t.tags.filter((g) => g !== `#${t.aboutHandle}`).join(', ')}]`) : null,
          h('span', { class: 'sub' }, ` · t${t.seq} · ${t.source}${t.status === 'revised' ? ' · replaced' : t.status === 'faded' ? ' · faded' : t.status === 'revoked' ? ' · forgotten' : ''}${t.revisesSeq ? ` · revises t${t.revisesSeq}` : ''}`)),
        t.status === 'active'
          ? h('span', { class: 'thought-actions' },
              h('button', { class: 'ghost small', title: t.pinned ? 'Unpin' : 'Pin: always on their mind', onclick: () => save(t, { pinned: !t.pinned }) }, t.pinned ? '📌' : 'pin'),
              h('button', { class: 'ghost small', title: 'Edit', onclick: () => edit() }, '✎'),
              h('button', { class: 'ghost small', title: 'Forget', onclick: () => save(t, { revoked: true }) }, '×'))
          : h('button', { class: 'ghost small', title: 'Bring it back to mind', onclick: () => save(t, { restore: true }) }, 'restore'));
      const edit = () => {
        const kindSel = select(KINDS, t.kind);
        const aboutSel = select(aboutOptions, t.about ?? '');
        const impIn = h('input', { type: 'range', min: '1', max: '10', value: String(t.importance) });
        const impOut = h('b', {}, String(t.importance));
        impIn.addEventListener('input', () => { impOut.textContent = impIn.value; });
        const textIn = textarea(t.text, 2);
        const tagsIn = input(t.tags.filter((g) => g !== `#${t.aboutHandle}`).join(', '), { placeholder: 'tags, #handles' });
        fill(line, h('div', { class: 'thought-form' },
          h('div', { class: 'row', style: 'gap:6px; flex-wrap:wrap; align-items:center' }, kindSel, aboutSel, h('label', { class: 'sub imp-edit' }, 'importance ', impIn, ' ', impOut)),
          textIn, tagsIn,
          h('div', { class: 'row', style: 'gap:6px' },
            h('button', { class: 'small primary', onclick: () => save(t, { text: textIn.value.trim() || t.text, kind: kindSel.value, about: aboutSel.value || null, importance: Number(impIn.value), tags: tagsIn.value.split(',').map((x) => x.trim()).filter(Boolean) }) }, 'Save'),
            h('button', { class: 'small', onclick: () => view() }, 'Cancel'))));
      };
      view();
      return line;
    };

    // Grouping: agenda; per person (opinions, feelings, notes about them); feelings; notes.
    const agenda = active.filter((t) => t.kind === 'agenda').sort((a, b) => a.seq - b.seq);
    const aboutGroups = new Map();
    for (const t of active.filter((x) => x.kind !== 'agenda' && x.about)) {
      if (!aboutGroups.has(t.about)) aboutGroups.set(t.about, []);
      aboutGroups.get(t.about).push(t);
    }
    const feelings = active.filter((t) => t.kind === 'feeling' && !t.about).sort(byCur);
    const notes = active.filter((t) => (t.kind === 'note' || t.kind === 'opinion') && !t.about).sort(byCur);
    const past = all.filter((t) => t.status !== 'active').sort((a, b) => b.seq - a.seq);
    const personHead = (oid, list) => {
      const p = people.find((x) => x.objectId === oid);
      const opinions = list.filter((t) => t.kind === 'opinion').length;
      return h('div', { class: 'mind-person' }, h('b', {}, p ? nameOf(p) : list[0].aboutName ?? '?'), h('span', { class: 'sub' }, ` #${p?.handle ?? list[0].aboutHandle}${opinions > 1 ? ' · mixed opinions' : ''}`));
    };
    const group = (title, hint, items) => h('div', { class: 'mind-group' }, h('div', { class: 'mind-head' }, h('span', {}, title), hint ? h('span', { class: 'sub' }, ` ${hint}`) : null), ...(items.length ? items : [h('div', { class: 'sub' }, '—')]));

    // Add a thought.
    const kindSel = select(KINDS, 'opinion');
    const aboutSel = select(aboutOptions, '');
    const impIn = h('input', { type: 'range', min: '1', max: '10', value: '5' });
    const impOut = h('b', {}, '5');
    impIn.addEventListener('input', () => { impOut.textContent = impIn.value; });
    const textIn = input('', { placeholder: 'A new thought, first person: a few words to one sentence' });
    const tagsIn = input('', { placeholder: 'tags, #handles' });
    const add = h('div', { class: 'thought-add v2' },
      h('div', { class: 'row', style: 'gap:6px; flex-wrap:wrap; align-items:center' }, kindSel, aboutSel, h('label', { class: 'sub imp-edit' }, 'importance ', impIn, ' ', impOut)),
      h('div', { class: 'row', style: 'gap:6px; flex-wrap:wrap' }, textIn, tagsIn,
        h('button', { onclick: async () => {
          err.textContent = '';
          if (!textIn.value.trim()) return;
          try {
            const r = await api.post(`/api/stories/${ctx.storyId}/thoughts`, { owner, text: textIn.value.trim(), kind: kindSel.value, importance: Number(impIn.value), ...(aboutSel.value ? { about: aboutSel.value } : {}), tags: tagsIn.value.split(',').map((x) => x.trim()).filter(Boolean) });
            if (r.notes?.length) err.textContent = r.notes.join(' ');
            load();
          } catch (e) { err.textContent = e.message; }
        } }, 'Add')));

    fill(box,
      h('div', { class: 'sub' }, `Importance fades one point per ${data.fadeHours} in-story hours a thought doesn't come up; agenda, pinned and 8–10 never fade. Tap a thought to edit it.`),
      group('Agenda', `${agenda.length}/3 · always on their mind`, agenda.map(row)),
      group('People', 'opinions and feelings, by person', [...aboutGroups].sort((a, b) => Math.max(...b[1].map((t) => t.current ?? t.importance)) - Math.max(...a[1].map((t) => t.current ?? t.importance)))
        .flatMap(([oid, list]) => [personHead(oid, list), ...list.sort(byCur).map(row)])),
      group('Feelings', '', feelings.map(row)),
      group('Notes', 'facts, events, promises', notes.map(row)),
      past.length ? h('details', { class: 'mind-past' }, h('summary', { class: 'sub' }, `Faded, replaced and forgotten (${past.length})`), ...past.map(row)) : null,
      add, err);
  };
  load();
  return box;
}

/** A mind's thoughts (or the narrator's notes): pin, forget, add. */
export function thoughtsEditor(ctx, owner) {
  const box = h('div', { class: 'thoughts' });
  const load = async () => {
    let data;
    try { data = await api.get(`/api/stories/${ctx.storyId}/thoughts?owner=${encodeURIComponent(owner)}&includeRevoked=1`); } catch (e) { fill(box, h('div', { class: 'sub err' }, e.message)); return; }
    const textIn = input('', { placeholder: 'A new thought, first person' });
    const tagsIn = input('', { placeholder: 'tags, #handles' });
    const pinIn = h('input', { type: 'checkbox' });
    const err = errLine();
    fill(box, 
      ...(data.thoughts.length ? [] : [h('div', { class: 'sub' }, 'No thoughts yet.')]),
      ...data.thoughts.map((t) => h('div', { class: `thought ${t.status}` },
        h('span', { class: 'sub' }, `t${t.seq}`),
        h('span', { class: 'thought-text' }, t.text, t.tags.length ? h('span', { class: 'sub' }, ` [${t.tags.join(', ')}]`) : null, h('span', { class: 'sub' }, ` · ${t.source}`)),
        t.status === 'active'
          ? h('span', { class: 'thought-actions' },
              h('button', { class: 'ghost small', title: t.pinned ? 'Unpin' : 'Pin: always on their mind', onclick: async () => { await api.patch(`/api/thoughts/${t.id}`, { pinned: !t.pinned }); load(); } }, t.pinned ? '📌' : 'pin'),
              h('button', { class: 'ghost small', title: 'Forget (revoke)', onclick: async () => { await api.patch(`/api/thoughts/${t.id}`, { revoked: true }); load(); } }, '×'))
          : h('span', { class: 'sub' }, 'forgotten'))),
      data.vocabulary.length ? h('div', { class: 'sub' }, `Tags: ${data.vocabulary.map((v) => v.tag).join(', ')}`) : null,
      h('div', { class: 'thought-add' }, textIn, tagsIn, h('label', { class: 'sub' }, pinIn, ' pin'),
        h('button', { onclick: async () => {
          err.textContent = '';
          if (!textIn.value.trim()) return;
          try {
            const r = await api.post(`/api/stories/${ctx.storyId}/thoughts`, { owner, text: textIn.value.trim(), tags: tagsIn.value.split(',').map((x) => x.trim()).filter(Boolean), pin: pinIn.checked });
            if (r.notes?.length) err.textContent = r.notes.join(' ');
            load();
          } catch (e) { err.textContent = e.message; }
        } }, 'Add')),
      err,
    );
  };
  load();
  return box;
}

// ---- Scenario editor (docs/11 §4.8) ----

const TYPES = [['number', 'number'], ['text', 'short text'], ['choice', 'choice'], ['flag', 'yes / no'], ['list', 'list']];
const blankDef = () => ({ key: '', label: '', type: 'number', min: 0, max: 10, default: 10, scope: 'character', appliesTo: 'all', visibility: 'self', changedBy: ['narrator'], description: '', changeGuide: '' });

function defSummary(d) {
  const range = d.type === 'number' ? `${d.min ?? '−∞'}…${d.max ?? '∞'}${d.unit ? ` ${d.unit}` : ''}` : d.type === 'choice' ? (d.options ?? []).join(' / ') : d.type === 'list' ? `list ≤ ${d.maxItems ?? 10}` : d.type === 'flag' ? 'yes / no' : `text ≤ ${d.maxWords ?? 8} words`;
  const who = d.scope === 'world' ? 'world' : Array.isArray(d.appliesTo) ? d.appliesTo.map((x) => `#${x}`).join(', ') : { all: 'everyone', player: 'player', npcs: 'others' }[d.appliesTo] ?? 'everyone';
  return `${range} · ${who} · ${d.visibility} · changed by ${(d.changedBy ?? []).join(' + ') || 'nobody'}`;
}

/** The form for one definition; `onChange` fires with the edited definition. */
function defForm(d, onChange) {
  const box = h('div', { class: 'def-form' });
  const set = (patch) => { Object.assign(d, patch); onChange(); };
  const num = (v) => (v === '' || v == null ? undefined : Number(v));
  const field = (label, el, hint) => row(label, el, hint);
  const bind = (el, key, conv = (x) => x) => { el.addEventListener('change', () => set({ [key]: conv(el.type === 'checkbox' ? el.checked : el.value) })); return el; };
  const render = () => {
    const typeSel = select(TYPES, d.type);
    typeSel.addEventListener('change', () => {
      const t = typeSel.value;
      const keep = { key: d.key, label: d.label, scope: d.scope, appliesTo: d.appliesTo, visibility: d.visibility, changedBy: d.changedBy, description: d.description, changeGuide: d.changeGuide, type: t };
      for (const k of Object.keys(d)) delete d[k];
      Object.assign(d, keep, t === 'number' ? { min: 0, max: 10, default: 10 } : t === 'choice' ? { options: ['one', 'two'] } : {});
      onChange(); render();
    });
    const scopeSel = select([['character', 'each character'], ['world', 'the world (one value)']], d.scope);
    scopeSel.addEventListener('change', () => { set({ scope: scopeSel.value }); render(); });
    const appliesIn = input(Array.isArray(d.appliesTo) ? d.appliesTo.join(', ') : d.appliesTo, { placeholder: 'all, player, npcs, or #handles' });
    appliesIn.addEventListener('change', () => {
      const v = appliesIn.value.trim();
      set({ appliesTo: ['all', 'player', 'npcs'].includes(v) ? v : v.split(',').map((x) => x.trim().replace(/^#/, '')).filter(Boolean) });
    });
    const changers = h('span', { class: 'row' }, ...['narrator', 'self'].map((who) => {
      const cb = h('input', { type: 'checkbox' }); cb.checked = (d.changedBy ?? []).includes(who);
      cb.addEventListener('change', () => set({ changedBy: ['narrator', 'self'].filter((w) => (w === who ? cb.checked : (d.changedBy ?? []).includes(w))) }));
      return h('label', { class: 'sub' }, cb, who === 'self' ? ' the holder' : ' the narrator');
    }));
    const typeFields = [];
    if (d.type === 'number') {
      typeFields.push(h('div', { class: 'row form-grid' },
        field('Min', bind(input(d.min ?? '', { type: 'number' }), 'min', num)),
        field('Max', bind(input(d.max ?? '', { type: 'number' }), 'max', num)),
        field('Default', bind(input(d.default ?? '', { type: 'number' }), 'default', num)),
        field('Unit', bind(input(d.unit ?? ''), 'unit', (x) => x.trim() || undefined)),
        field('Max step', bind(input(d.maxStep ?? '', { type: 'number', min: '0' }), 'maxStep', num), 'Largest change per round.')));
      const bandsIn = input((d.bands ?? []).map((b) => `${b.upTo} ${b.label}`).join(', '), { placeholder: '2 critical, 5 hurt, 10 fine' });
      bandsIn.addEventListener('change', () => set({ bands: bandsIn.value.split(',').map((x) => x.trim().match(/^(-?\d+(?:\.\d+)?)\s+(.+)$/)).filter(Boolean).map((m) => ({ upTo: Number(m[1]), label: m[2].trim() })) }));
      typeFields.push(field('Bands', bandsIn, 'Labels shown next to the value: "up to 2 = critical", …'));
    } else if (d.type === 'text') {
      typeFields.push(h('div', { class: 'row form-grid' }, field('Default', bind(input(d.default ?? ''), 'default', (x) => x || undefined)), field('Max words', bind(input(d.maxWords ?? 8, { type: 'number', min: '1' }), 'maxWords', num))));
    } else if (d.type === 'choice') {
      typeFields.push(h('div', { class: 'row form-grid' },
        field('Options', bind(input((d.options ?? []).join(', ')), 'options', (x) => x.split(',').map((o) => o.trim()).filter(Boolean)), 'comma-separated'),
        field('Default', bind(input(d.default ?? ''), 'default', (x) => x.trim() || undefined))));
    } else if (d.type === 'flag') {
      const cb = h('input', { type: 'checkbox' }); cb.checked = !!d.default;
      typeFields.push(h('label', { class: 'sub' }, bind(cb, 'default'), ' starts as yes'));
    } else if (d.type === 'list') {
      typeFields.push(h('div', { class: 'row form-grid' },
        field('Starts with', bind(input((d.default ?? []).join(', ')), 'default', (x) => x.split(',').map((o) => o.trim()).filter(Boolean)), 'comma-separated'),
        field('Max items', bind(input(d.maxItems ?? 10, { type: 'number', min: '1' }), 'maxItems', num)),
        field('Words per item', bind(input(d.itemMaxWords ?? 6, { type: 'number', min: '1' }), 'itemMaxWords', num))));
    }
    fill(box, 
      h('div', { class: 'row form-grid' },
        field('Key', bind(input(d.key, { placeholder: 'health' }), 'key', (x) => x.trim()), 'lowercase, digits, _'),
        field('Label', bind(input(d.label, { placeholder: 'Health' }), 'label', (x) => x.trim())),
        field('Type', typeSel)),
      ...typeFields,
      h('div', { class: 'row form-grid' },
        field('Held by', scopeSel),
        d.scope === 'character' ? field('Which characters', appliesIn) : null,
        field('Visibility', bind(select([['public', 'public: everyone present sees it'], ['self', 'self: holder + narrator'], ['hidden', 'hidden: narrator only']], d.visibility), 'visibility'))),
      field('Who may change it', changers, 'You can always change values in advanced mode.'),
      field('What it means (for the AIs)', bind(textarea(d.description, 2), 'description')),
      field('When and how to change it (for the AIs)', bind(textarea(d.changeGuide, 2), 'changeGuide')),
    );
  };
  render();
  return box;
}

export async function openScenarioEditor(ctx) {
  let defs, templates;
  try { [defs, templates] = await Promise.all([api.get(`/api/stories/${ctx.storyId}/variables/defs`), api.get('/api/minds/templates')]); } catch (e) { alert(e.message); return; }
  defs = defs.map((d) => ({ ...d }));
  const list = h('div', { class: 'def-list' });
  const preview = h('div', { class: 'def-preview' });
  const err = errLine();
  let open = -1;
  let timer = null;
  const clean = () => defs.map(({ id: _id, storyId: _s, order: _o, ...d }) => d);
  const refreshPreview = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const p = await api.post(`/api/stories/${ctx.storyId}/variables/preview`, { defs: clean() });
        err.textContent = '';
        fill(preview, 
          h('div', { class: 'sub' }, 'A character reads (in its own prompt):'), h('pre', { class: 'thread-payload' }, p.character.join('\n')),
          h('div', { class: 'sub' }, 'The narrator reads:'), h('pre', { class: 'thread-payload' }, p.narrator.join('\n') || '(none)'));
      } catch (e) { err.textContent = e.message; }
    }, 300);
  };
  const renderList = () => {
    fill(list, ...defs.map((d, i) => h('div', { class: `def-card${open === i ? ' open' : ''}` },
      h('div', { class: 'def-head', onclick: () => { open = open === i ? -1 : i; renderList(); } },
        h('b', {}, d.label || d.key || '(new variable)'), h('span', { class: 'sub' }, ` ${d.key ? `${d.key} · ` : ''}${d.type} · ${defSummary(d)}`),
        h('span', { class: 'def-tools' },
          h('button', { class: 'ghost small', title: 'Move up', disabled: i === 0 ? true : null, onclick: (e) => { e.stopPropagation(); [defs[i - 1], defs[i]] = [defs[i], defs[i - 1]]; open = -1; renderList(); refreshPreview(); } }, '↑'),
          h('button', { class: 'ghost small', title: 'Move down', disabled: i === defs.length - 1 ? true : null, onclick: (e) => { e.stopPropagation(); [defs[i + 1], defs[i]] = [defs[i], defs[i + 1]]; open = -1; renderList(); refreshPreview(); } }, '↓'),
          h('button', { class: 'ghost small', title: 'Delete', onclick: (e) => {
            e.stopPropagation();
            if (!confirm(`Delete "${d.label || d.key}"? Values already stored for it are lost when you save.`)) return;
            defs.splice(i, 1); open = -1; renderList(); refreshPreview();
          } }, '×'))),
      open === i ? defForm(d, () => { refreshPreview(); const head = list.children[i]?.querySelector('.def-head .sub'); if (head) head.textContent = ` ${d.key ? `${d.key} · ` : ''}${d.type} · ${defSummary(d)}`; }) : null)));
    if (!defs.length) list.append(h('div', { class: 'sub' }, 'No variables yet: start from a template, or add one.'));
  };
  const tplSel = select([['', 'Start from a template…'], ...templates.map((t) => [t.id, `${t.label} — ${t.description}`])], '');
  tplSel.addEventListener('change', () => {
    const t = templates.find((x) => x.id === tplSel.value);
    tplSel.value = '';
    if (!t) return;
    if (defs.length && !confirm(`Replace the ${defs.length} variable(s) in the list with "${t.label}"?`)) return;
    defs = t.variables.map((d) => ({ ...d }));
    open = -1; renderList(); refreshPreview();
  });
  const saved = h('span', { class: 'sub' });
  const m = modal('Scenario variables',
    h('div', { class: 'row', style: 'gap:8px; flex-wrap:wrap; align-items:center' }, tplSel, h('button', { onclick: () => { defs.push(blankDef()); open = defs.length - 1; renderList(); } }, '+ Add variable'), helpLink('scenario')),
    list,
    h('details', { open: true }, h('summary', { class: 'sub' }, 'Preview: how the AIs will read it'), preview),
    err,
    h('div', { class: 'row', style: 'gap:8px; justify-content:flex-end' }, saved,
      h('button', { class: 'primary', onclick: async () => {
        err.textContent = ''; saved.textContent = '';
        try { await api.put(`/api/stories/${ctx.storyId}/variables/defs`, { defs: clean() }); saved.textContent = 'Saved.'; ctx.refresh(); setTimeout(() => m.close(), 400); } catch (e) { err.textContent = e.message; }
      } }, 'Save scenario')));
  renderList();
  refreshPreview();
}

// ---- Drawer: the cast (every sheet) ----

export async function renderCastTab(ctx, body) {
  fill(body, h('div', { class: 'sub' }, 'Loading…'));
  let view, st;
  try { [view, st] = await Promise.all([mindsView(ctx), api.get(`/api/stories/${ctx.storyId}`)]); } catch (e) { fill(body, h('div', { class: 'empty' }, e.message)); return; }
  const present = new Set(st?.scene?.activeNpcIds || []);
  const adv = ctx.advanced();
  const card = (c) => h('div', { class: 'mem-card' },
    h('div', { class: 'mem-head', onclick: () => openCharacterCard(ctx, c.objectId, { present: present.has(c.objectId) }) },
      h('div', {}, h('b', {}, `${c.isPlayer ? '🎭 ' : ''}${c.name}`), c.pronouns ? h('span', { class: 'sub' }, ` (${c.pronouns})`) : null, ctx.forced.has(c.objectId) ? ' ⚡' : null,
        h('div', { class: 'sub' }, [c.appearance, adv && c.state ? `State: "${c.state}"` : ''].filter(Boolean).join(' · ') || '—')),
      h('span', { class: 'sub' }, c.isPlayer ? 'you' : present.has(c.objectId) ? 'here' : 'away')));
  const chars = view.characters;
  const here = chars.filter((c) => c.isPlayer || present.has(c.objectId));
  const away = chars.filter((c) => !c.isPlayer && !present.has(c.objectId));
  fill(body, 
    h('div', { class: 'row', style: 'gap:8px; flex-wrap:wrap; margin-bottom:8px' },
      h('button', { class: 'small', onclick: () => openScenarioEditor(ctx) }, '⚙ Scenario variables'), helpLink(adv ? 'advanced' : 'cast-bar')),
    view.world.length ? h('div', { class: 'mem-card world' }, h('div', { class: 'mem-head' }, h('b', {}, 'The world'), h('span', { class: 'sub' }, view.world.map((v) => `${v.label}: ${v.display}`).join(' · ')))) : null,
    h('h4', { class: 'sub' }, 'Here'), ...here.map(card),
    away.length && adv ? h('h4', { class: 'sub' }, 'Elsewhere') : null, ...(adv ? away.map(card) : []),
    adv ? h('details', {}, h('summary', { class: 'sub' }, "The narrator's notes"), thoughtsEditor(ctx, 'narrator')) : null,
    adv ? changeLog(ctx) : null,
  );
}

// ---- Drawer: places and things (docs/10 §5.1d) ----

export async function renderPlacesTab(ctx, body) {
  fill(body, h('div', { class: 'sub' }, 'Loading…'));
  let places;
  try { places = await api.get(`/api/stories/${ctx.storyId}/minds/places${ctx.advanced() ? '?advanced=1' : ''}`); } catch (e) { fill(body, h('div', { class: 'empty' }, e.message)); return; }
  const adv = ctx.advanced();
  const reload = () => renderPlacesTab(ctx, body);
  const patch = async (p, body) => { try { await api.patch(`/api/memory/objects/${p.objectId}`, body); reload(); } catch (e) { alert(e.message); } };
  const card = (p) => {
    const edit = h('div', { class: 'place-edit gone' });
    const nameIn = input(p.name);
    const lineIn = input(p.line, { placeholder: 'One public line: what it is, whose it is' });
    const others = places.filter((x) => x.objectId !== p.objectId);
    const mergeSel = select([['', 'Merge a duplicate into this…'], ...others.map((x) => [x.objectId, `${x.name} · #${x.handle}${x.gone ? ' (gone)' : ''}`])], '');
    mergeSel.addEventListener('change', async () => {
      const victim = others.find((x) => x.objectId === mergeSel.value);
      if (!victim) return;
      if (!confirm(`Merge "${victim.name}" into "${p.name}"? Its aliases and the thoughts that mention it move here; the duplicate is deleted.`)) { mergeSel.value = ''; return; }
      try { await api.post(`/api/memory/objects/${p.objectId}/merge`, { mergeId: victim.objectId }); } catch (e) { alert(e.message); }
      reload();
    });
    fill(edit,
      row('Name', nameIn), row('Public line', lineIn, 'Everyone present reads it with the #handle.'),
      h('div', { class: 'row', style: 'gap:8px; flex-wrap:wrap' },
        h('button', { class: 'small primary', onclick: () => patch(p, { name: nameIn.value.trim() || p.name, summary: lineIn.value.trim() }) }, 'Save'),
        h('button', { class: 'small', onclick: () => patch(p, { status: p.gone ? 'active' : 'destroyed' }) }, p.gone ? 'Back in the story' : 'Mark gone'),
        h('button', { class: 'small danger', onclick: async () => {
          if (!confirm(`Delete "${p.name}"? Thoughts that mention #${p.handle} keep the tag.`)) return;
          try { await api.del(`/api/memory/objects/${p.objectId}`); } catch (e) { alert(e.message); }
          reload();
        } }, 'Delete')),
      others.length ? mergeSel : null);
    const where = p.here ? 'here' : p.inView ? 'in view' : p.gone ? 'gone' : '';
    return h('div', { class: `mem-card place${p.gone ? ' is-gone' : ''}` },
      h('div', { class: 'mem-head', onclick: () => edit.classList.toggle('gone') },
        h('div', {},
          h('b', {}, p.name), h('span', { class: 'sub' }, ` #${p.handle}${p.aliases?.length ? ` · also: ${p.aliases.join(', ')}` : ''}`),
          h('div', { class: 'sub' }, p.line || '(no public line yet)')),
        h('span', { class: 'sub place-meta' }, [where, adv && p.mentions ? `${p.mentions} thought${p.mentions === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '))),
      edit);
  };
  const groups = [['location', 'Places'], ['item', 'Things'], ['other', 'Other']];
  const groupOf = (p) => (p.type === 'location' ? 'location' : p.type === 'item' ? 'item' : 'other');
  fill(body,
    h('div', { class: 'sub', style: 'margin-bottom:8px' }, 'What the story keeps about places and things: a public line each, known by its #handle. Tap one to edit, merge a duplicate or mark it gone. ', helpLink('places')),
    ...(places.length ? [] : [h('div', { class: 'empty' }, 'No places or things yet: the narrator adds them as the story names them.')]),
    ...groups.flatMap(([g, label]) => {
      const items = places.filter((p) => groupOf(p) === g);
      return items.length ? [h('h4', { class: 'sub' }, label), ...items.map(card)] : [];
    }));
}

function changeLog(ctx) {
  const box = h('details', {}, h('summary', { class: 'sub' }, 'Change log (variables and states)'));
  box.addEventListener('toggle', async () => {
    if (!box.open || box.children.length > 1) return;
    let rows = [];
    try { rows = await api.get(`/api/stories/${ctx.storyId}/variables/changes?limit=60`); } catch {}
    box.append(rows.length
      ? h('table', { class: 'vars log' }, ...rows.map((r) => h('tr', { class: r.result },
          h('td', { class: 'sub' }, r.holderName || r.holder), h('td', {}, r.key === '$state' ? 'state' : r.key),
          h('td', {}, `${fmtValue(r.old)} → ${fmtValue(r.new ?? r.op?.value)}`), h('td', { class: 'sub' }, `${r.by} · ${r.result}${r.reason ? `: ${r.reason}` : ''}`))))
      : h('div', { class: 'sub' }, 'No changes yet.'));
  });
  return box;
}

// ---- Drawer: POV filter and prompt viewer (advanced mode, docs/10 §10) ----

let povChoice = 'narrator';

export async function renderPovTab(ctx, body) {
  let view;
  try { view = await api.get(`/api/stories/${ctx.storyId}/minds?advanced=1`); } catch (e) { fill(body, h('div', { class: 'empty' }, e.message)); return; }
  const minds = view.characters.filter((c) => !c.isPlayer);
  if (povChoice !== 'narrator' && !minds.some((c) => c.objectId === povChoice)) povChoice = 'narrator';
  const sel = select([['narrator', 'The narrator'], ...minds.map((c) => [c.objectId, c.name])], povChoice);
  const out = h('div', { class: 'pov-out' });
  const showThread = async () => {
    fill(out, h('div', { class: 'sub' }, 'Loading…'));
    let p;
    try { p = await api.get(`/api/stories/${ctx.storyId}/pov/${encodeURIComponent(povChoice)}`); } catch (e) { fill(out, h('div', { class: 'sub err' }, e.message)); return; }
    const msgs = p.log.map((m) => h('div', { class: `msg pov ${m.role}` }, h('span', { class: `role-chip ${m.role}` }, m.role === 'user' ? 'told' : 'answered'), h('div', { class: 'prose' }, m.content)));
    fill(out, 
      p.recap ? h('details', {}, h('summary', { class: 'sub' }, 'Recap (older rounds, compacted)'), h('div', { class: 'prose' }, p.recap)) : null,
      ...(msgs.length ? msgs : [h('div', { class: 'sub' }, 'Nothing in this thread yet.')]),
      p.pending.length ? h('div', { class: 'msg pov pending' }, h('span', { class: 'role-chip' }, 'waiting for its next round'), ...p.pending.map((x) => h('div', { class: 'prose' }, x.content))) : null,
    );
  };
  const showPrompt = async (which) => {
    fill(out, h('div', { class: 'sub' }, 'Loading…'));
    let p;
    try { p = await api.get(`/api/stories/${ctx.storyId}/pov/${encodeURIComponent(povChoice)}/prompt?which=${which}`); } catch (e) { fill(out, h('div', { class: 'sub err' }, e.message)); return; }
    if (p.none) { fill(out, h('div', { class: 'sub' }, 'Nothing sent yet.')); return; }
    fill(out, 
      h('div', { class: 'sub' }, which === 'next' ? 'Exactly what this mind would be sent now:' : `Sent ${new Date(p.sentAt).toLocaleString()}:`),
      h('details', {}, h('summary', { class: 'sub' }, 'System prompt'), h('div', { class: 'prose' }, p.system)),
      ...p.messages.map((m) => h('div', { class: `msg pov ${m.role}` }, h('span', { class: `role-chip ${m.role}` }, m.role), h('div', { class: 'prose' }, m.content))),
    );
  };
  sel.addEventListener('change', () => { povChoice = sel.value; showThread(); });
  fill(body, 
    h('div', { class: 'row', style: 'gap:6px; flex-wrap:wrap; margin-bottom:8px; align-items:center' },
      sel,
      h('button', { class: 'small', onclick: showThread }, 'Thread'),
      h('button', { class: 'small', onclick: () => showPrompt('next') }, 'Next prompt'),
      h('button', { class: 'small', onclick: () => showPrompt('last') }, 'Last prompt'),
      helpLink('pov')),
    out,
  );
  showThread();
}
