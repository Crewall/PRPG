// PRPG web client — dependency-free, zero build step.
// Home (stories) + Play (streamed transcript, scene control, memory browser,
// summaries & threads under a debug flag, /look perception command).
// Svelte is nominated for later polish (docs/07); this is the working baseline.

const app = document.getElementById('app');
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
};

const api = {
  async get(p) { const r = await fetch(p); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r.json(); },
  async post(p, b, opts = {}) { const r = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}), signal: opts.signal }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r.json(); },
  async patch(p, b) { const r = await fetch(p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); if (!r.ok) throw new Error(r.statusText); return r.json(); },
  async put(p, b) { const r = await fetch(p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r.json(); },
  async del(p) { const r = await fetch(p, { method: 'DELETE' }); if (!r.ok) throw new Error(r.statusText); return r.json(); },
};

function route() {
  const hash = location.hash.slice(1) || '/';
  if (hash.startsWith('/play/')) return renderPlay(hash.slice('/play/'.length));
  if (hash.startsWith('/settings/prompts/')) return renderPromptEditor(decodeURIComponent(hash.slice('/settings/prompts/'.length)));
  if (hash === '/settings/seeds') return renderSeedsEditor();
  if (hash === '/settings/style') return renderStyleEditor();
  if (hash === '/settings') return renderSettings();
  return renderHome();
}
window.addEventListener('hashchange', route);

function topbar(...right) {
  return h('div', { class: 'topbar' },
    h('h1', { onclick: () => (location.hash = '/'), style: 'cursor:pointer' }, 'PRPG'),
    h('span', { class: 'spacer' }),
    ...right,
  );
}

// ---------------- Home ----------------
async function renderHome() {
  app.replaceChildren(topbar(h('span', { class: 'badge' }, 'Layers 0–3')), h('div', { class: 'scroll' }, h('div', { class: 'container' }, h('div', { class: 'empty' }, 'Loading…'))));
  let stories = [];
  try { stories = await api.get('/api/stories'); } catch {}

  const list = stories.length
    ? stories.map((s) =>
        h('div', { class: 'card story-card', onclick: () => (location.hash = `/play/${s.id}`) },
          h('div', { class: 'meta' }, h('div', { class: 'title' }, s.title), h('div', { class: 'sub' }, `updated ${new Date(s.updatedAt).toLocaleString()}`)),
          h('button', { class: 'link', onclick: async (ev) => { ev.stopPropagation(); if (confirm('Delete this story?')) { await api.del(`/api/stories/${s.id}?hard=true`); route(); } } }, 'delete'),
        ),
      )
    : [h('div', { class: 'empty' }, 'No stories yet. Create one below to begin.')];

  const titleIn = h('input', { placeholder: 'Story title (optional)' });
  const seedIn = h('textarea', { rows: '4', placeholder: 'Premise / opening seed… (optional)' });
  const genreIn = h('input', { placeholder: 'Genre (optional)' });
  const createBtn = h('button', { class: 'primary' }, 'Create & play');

  // Premise randomizer: the engine rolls N (1–12) atomic seed elements and a
  // model weaves them into a premise + title + genre. A filled title and/or
  // genre is kept fixed and woven into the result; all fields stay editable.
  const seedCount = h('input', { type: 'number', min: '1', max: '12', step: '1', value: '5', style: 'width:60px' });
  const seedNote = h('div', { class: 'sub', style: 'margin-top:6px' });
  const randomBtn = h('button', { class: 'ghost' }, '🎲 Randomize');
  let rollTimer = null;
  randomBtn.addEventListener('click', async () => {
    let n = parseInt(seedCount.value, 10); if (!(n >= 1 && n <= 12)) n = 5; seedCount.value = String(n);
    randomBtn.disabled = true; seedNote.className = 'sub'; seedNote.textContent = '';
    const t0 = Date.now();
    const tick = () => { randomBtn.textContent = `🎲 rolling… ${Math.round((Date.now() - t0) / 1000)}s`; };
    tick(); rollTimer = setInterval(tick, 1000);
    // A filled title/genre is sent as a fixed constraint the premise weaves in.
    const body = { count: n };
    if (titleIn.value.trim()) body.title = titleIn.value.trim();
    if (genreIn.value.trim()) body.genre = genreIn.value.trim();
    try {
      const r = await api.post('/api/stories/randomize', body);
      titleIn.value = r.title || titleIn.value;
      genreIn.value = r.genre || genreIn.value;
      seedIn.value = r.premise || seedIn.value;
      seedNote.className = 'sub ok'; seedNote.textContent = `✓ rolled ${(r.seeds || []).length}: ${(r.seeds || []).join(' · ')}`;
    } catch (e) { seedNote.className = 'sub err'; seedNote.textContent = '✗ randomize failed: ' + e.message; }
    clearInterval(rollTimer); rollTimer = null;
    randomBtn.disabled = false; randomBtn.textContent = '🎲 Randomize';
  });
  createBtn.addEventListener('click', async () => {
    createBtn.disabled = true; createBtn.textContent = 'Creating…';
    try {
      const story = await api.post('/api/stories', { title: titleIn.value || 'Untitled Story', seed: seedIn.value, settings: { genre: genreIn.value || 'freeform' } });
      location.hash = `/play/${story.id}`;
    } catch (e) { alert('Create failed: ' + e.message); createBtn.disabled = false; createBtn.textContent = 'Create & play'; }
  });

  app.replaceChildren(
    topbar(h('button', { class: 'ghost small', onclick: () => (location.hash = '/settings') }, '⚙ Settings')),
    h('div', { class: 'scroll' }, h('div', { class: 'container' },
      h('h2', {}, 'Your stories'), ...list,
      h('div', { class: 'card' },
        h('h3', { style: 'margin-top:0' }, 'New story'),
        h('label', {}, 'Title'), titleIn, h('label', {}, 'Genre'), genreIn, h('label', {}, 'Premise seed'), seedIn,
        h('div', { class: 'row', style: 'margin-top:14px; gap:10px; flex-wrap:wrap' }, createBtn, randomBtn, h('span', { class: 'sub' }, 'seeds'), seedCount),
        seedNote,
      ),
    )),
  );
}

// ---------------- Play ----------------
async function renderPlay(storyId) {
  let story;
  try { story = await api.get(`/api/stories/${storyId}`); } catch { location.hash = '/'; return; }
  let debug = !!(story.settings?.debug?.showThreads);

  const transcript = h('div', { class: 'transcript' });
  const scrollBox = h('div', { class: 'scroll' }, h('div', { class: 'container' }, transcript));
  const wsDot = h('span', { class: 'wsdot' });
  const sceneLabel = h('span', { class: 'badge' }, story.scene?.title || 'Scene');
  const input = h('textarea', { rows: '1', placeholder: 'What do you do?  (Ctrl+Enter to send · /look <name>, /scene, /retry)' });
  const sendBtn = h('button', { class: 'primary' }, 'Send');
  const cancelBtn = h('button', { class: 'ghost', disabled: true }, 'Stop');
  const rewindBtn = h('button', { class: 'ghost', title: 'Delete the last response and edit your message (restores summaries & memory to before it)' }, '↶ Edit');
  const drawer = h('div', { class: 'drawer' });

  // Agent status bar (feature): a live view of what each AI agent is doing this
  // round, fed by thread.activity events. Hidden by default, toggled from the
  // topbar, closable. State resets whenever the player sends new input.
  const AGENT_BAR_ROLES = ['context_planner', 'storyteller', 'adjudicator', 'npc', 'scribe_story', 'scribe_memory'];
  const agentStatus = new Map(); // role -> { attempt, status: 'waiting' | 'ok' | 'error' }
  const agentChips = h('div', { class: 'agent-chips' });
  const agentBar = h('div', { class: 'agent-bar gone' },
    h('span', { class: 'sub' }, 'Agents'),
    agentChips,
    h('span', { class: 'spacer' }),
    h('button', { class: 'link', title: 'Hide the agent bar', onclick: () => toggleAgentBar(false) }, '✕'));
  const agentBarBtn = h('button', { class: 'ghost small' }, '📊 Agents');
  agentBarBtn.addEventListener('click', () => toggleAgentBar(agentBar.classList.contains('gone')));
  function toggleAgentBar(show) {
    agentBar.classList.toggle('gone', !show);
    agentBarBtn.classList.toggle('on', show);
  }
  let agentTimer = null;
  function renderAgentBar() {
    const extra = [...agentStatus.keys()].filter((r) => !AGENT_BAR_ROLES.includes(r));
    let anyWaiting = false;
    agentChips.replaceChildren(...[...AGENT_BAR_ROLES, ...extra].map((role) => {
      const s = agentStatus.get(role);
      const label = ROLE_LABELS[role] || role;
      let txt = 'none', cls = 'none';
      if (s) {
        cls = s.status;
        if (s.status === 'waiting') { anyWaiting = true; txt = `req ${s.attempt} · waiting ${Math.round((Date.now() - s.startedAt) / 1000)}s`; }
        else if (s.status === 'ok') txt = `req ${s.attempt} · OK ${s.ms != null ? '· ' + (s.ms / 1000).toFixed(1) + 's' : ''}`.trim();
        else txt = `req ${s.attempt} · error`;
      }
      return h('span', { class: `agent-chip ${cls}` }, `${label}: ${txt}`);
    }));
    // While anything is waiting, tick the elapsed counters once a second.
    if (anyWaiting && !agentTimer) agentTimer = setInterval(() => {
      if (!agentBar.isConnected) { clearInterval(agentTimer); agentTimer = null; return; }
      renderAgentBar();
    }, 1000);
    if (!anyWaiting && agentTimer) { clearInterval(agentTimer); agentTimer = null; }
  }
  function noteAgentActivity(entry) {
    if (!entry || !entry.agentRole) return;
    const role = entry.agentRole, cur = agentStatus.get(role);
    if (entry.direction === 'request') {
      // A fresh request while still 'waiting' means a retry (jobs re-run on failure).
      agentStatus.set(role, { attempt: cur && cur.status === 'waiting' ? cur.attempt + 1 : 1, status: 'waiting', startedAt: Date.now() });
    } else {
      const ms = cur && cur.startedAt ? Date.now() - cur.startedAt : null;
      agentStatus.set(role, { attempt: cur ? cur.attempt : 1, status: 'ok', ms });
    }
    renderAgentBar();
  }
  function markAgentError(role) {
    const cur = agentStatus.get(role);
    agentStatus.set(role, { attempt: cur ? cur.attempt : 1, status: 'error' });
    renderAgentBar();
  }
  function resetAgentStatus() { agentStatus.clear(); renderAgentBar(); }
  renderAgentBar();

  // Story options popover — the settings you touch during play: verbosity
  // slider, adjudicator on/off, context mode, salience.
  const patchSettings = async (patch) => {
    await api.patch(`/api/stories/${storyId}`, { settings: patch });
    story.settings = { ...(story.settings || {}), ...patch };
  };
  const VERBOSITY_LABELS = ['', 'terse', 'brief', 'balanced', 'rich', 'expansive'];
  function showStoryOptions() {
    const s = story.settings || {};
    // Verbosity slider (storyteller reply length, 1–5).
    const vLabel = h('span', { class: 'sub' }, `${s.verbosity || 3} — ${VERBOSITY_LABELS[s.verbosity || 3]}`);
    const vSlider = h('input', { type: 'range', min: '1', max: '5', step: '1', value: String(s.verbosity || 3) });
    vSlider.addEventListener('input', () => { vLabel.textContent = `${vSlider.value} — ${VERBOSITY_LABELS[Number(vSlider.value)]}`; });
    vSlider.addEventListener('change', () => patchSettings({ verbosity: Number(vSlider.value) }));

    // Tone: the narrator voice fed to the storyteller's {{tone}} — per story.
    const toneIn = h('input', { value: s.tone || '', placeholder: 'immersive, second-person present tense' });
    const toneStatus = h('span', { class: 'sub' });
    toneIn.addEventListener('change', async () => {
      toneStatus.textContent = 'saving…';
      try { await patchSettings({ tone: toneIn.value }); toneStatus.className = 'sub ok'; toneStatus.textContent = '✓'; }
      catch (e) { toneStatus.className = 'sub err'; toneStatus.textContent = '✗ ' + e.message; }
    });

    const toggle = (label, hint, checked, onChange) => {
      const cb = h('input', { type: 'checkbox', ...(checked ? { checked: true } : {}) });
      cb.addEventListener('change', () => onChange(cb.checked));
      return h('label', { class: 'opt-row', title: hint }, cb, h('span', {}, label));
    };

    // Context budgets: how much summary/memory the storyteller gets each turn.
    // Bigger = better long-story continuity, more tokens per request.
    const budgets = { recentTurns: 6, digestTokens: 1200, sceneSummaryTokens: 500, retrievedMemoryTokens: 1500, ...(s.budgets || {}) };
    const budgetIn = (key, label, hint, min, max) => {
      const inp = h('input', { type: 'number', min: String(min), max: String(max), value: String(budgets[key]), style: 'width:6em' });
      inp.addEventListener('change', async () => {
        const v = Math.max(min, Math.min(max, Number(inp.value) || budgets[key]));
        inp.value = String(v); budgets[key] = v;
        await patchSettings({ budgets: { ...budgets } });
      });
      return h('label', { class: 'opt-row', title: hint }, inp, h('span', {}, label));
    };
    const budgetBlock = h('details', {},
      h('summary', { class: 'sub' }, 'Context budgets (long-story continuity)'),
      budgetIn('digestTokens', 'story digest tokens', 'Size of the whole-story digest the storyteller always sees. Raise if long stories lose their beginning.', 200, 4000),
      budgetIn('sceneSummaryTokens', 'scene summary tokens', 'Size of the rolling current-scene summary.', 100, 2000),
      budgetIn('retrievedMemoryTokens', 'retrieved memory tokens', 'Budget for memory facts retrieved for the turn.', 200, 6000),
      budgetIn('recentTurns', 'recent raw turns', 'How many of the latest exchanges are passed verbatim (chat-history mode).', 1, 20));

    const modal = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target.classList.contains('modal-bg')) modal.remove(); } },
      h('div', { class: 'modal' },
        h('h3', {}, 'Story options'),
        h('div', { class: 'opt-block' }, h('div', { class: 'sub' }, 'Storyteller verbosity'), vSlider, vLabel),
        h('div', { class: 'opt-block' }, h('div', { class: 'sub' }, 'Narrator tone'), h('div', { class: 'row', style: 'gap:8px' }, toneIn, toneStatus)),
        toggle('Adjudicator (dice-decided outcomes)', 'Uncertain, consequential actions are judged by an impartial AI referee and decided by a hidden dice roll. Off = the storyteller decides everything itself.',
          s.adjudicator?.enabled !== false, (on) => patchSettings({ adjudicator: { enabled: on } })),
        toggle('Summary-driven context', 'What the storyteller reads: off = recent chat history; on = summaries + planner-picked memory.',
          !!s.context?.summaryDriven, (on) => patchSettings({ context: { summaryDriven: on } })),
        toggle('NPC story mode (narrative minds)', 'Replaces the structured memory system for NPCs: each present character acts every round from its own personality + private notes, and the storyteller weaves the replies. Memory extraction is paused while this is on.',
          !!s.npcStories?.enabled, async (on) => { await patchSettings({ npcStories: { enabled: on } }); renderDrawer(); }),
        toggle('Salience system', 'Importance weighting & decay of memory objects.',
          s.salience?.enabled !== false, (on) => patchSettings({ salience: { enabled: on } })),
        budgetBlock,
        h('button', { class: 'ghost', onclick: () => modal.remove() }, 'Close')));
    document.body.append(modal);
  }
  const optsBtn = h('button', { class: 'ghost small', onclick: showStoryOptions }, '⚙ Story');

  const debugBtn = h('button', { class: 'ghost small' }, debug ? 'Debug: on' : 'Debug: off');
  debugBtn.addEventListener('click', async () => {
    debug = !debug;
    await api.patch(`/api/stories/${storyId}`, { settings: { debug: { showThreads: debug } } });
    debugBtn.textContent = debug ? 'Debug: on' : 'Debug: off';
    renderDrawer();
  });
  const newSceneBtn = h('button', { class: 'ghost small' }, '+ Scene');
  newSceneBtn.addEventListener('click', async () => {
    const title = prompt('New scene title?', '');
    if (title === null) return;
    const r = await api.post(`/api/stories/${storyId}/scenes`, { title });
    sceneLabel.textContent = r.scene?.title || 'Scene';
    addStatus('— new scene —');
  });
  const panelBtn = h('button', { class: 'ghost small', onclick: () => drawer.classList.toggle('open') }, '☰');
  const npcChips = h('div', { class: 'npc-chips' });
  const sceneHeader = h('div', { class: 'scene-header' }, h('span', { class: 'sub' }, 'Present:'), npcChips);

  app.replaceChildren(
    topbar(sceneLabel, newSceneBtn, optsBtn, debugBtn, agentBarBtn, panelBtn, h('span', { class: 'row' }, wsDot)),
    agentBar,
    h('div', { class: 'playwrap' }, h('div', { class: 'playmain' }, sceneHeader, scrollBox, h('div', { class: 'inputbar' }, input, h('div', { class: 'btns' }, sendBtn, cancelBtn, rewindBtn))), drawer),
  );

  let activeNpcIds = new Set();
  async function refreshSceneHeader() {
    let agents = [];
    try { agents = await api.get(`/api/stories/${storyId}/agents`); } catch {}
    const active = agents.filter((a) => a.role === 'npc' && a.state === 'active' && a.npc);
    activeNpcIds = new Set(active.map((a) => a.npcObjectId));
    // The player's own character: a chip to its dossier, or the intake interview.
    const pcId = story.settings?.playerObjectId;
    let pcChip;
    if (pcId) {
      let name = 'You';
      try { name = (await api.get(`/api/memory/objects/${pcId}?scope=player`))?.name || 'You'; } catch {}
      pcChip = h('button', { class: 'chip pc', onclick: () => showDossier(pcId) }, `🎭 ${name}`);
    } else {
      pcChip = h('button', { class: 'chip pc', title: 'A short interview (max 3 questions) creates your character sheet' , onclick: openCharacterCreator }, '🎭 create your character');
    }
    // Manual "add major character": type a name, the engine finds-or-creates
    // the character and promotes it — no trip through the memory browser.
    const addChip = h('button', { class: 'chip', title: 'Make a character a major character (own mind & voice). New names are created on the spot; their description is filled from the story by an AI.', onclick: async () => {
      const name = prompt('Character name to make major?', '');
      if (!name || !name.trim()) return;
      try { await api.post(`/api/stories/${storyId}/npcs/enter`, { name: name.trim() }); addStatus(`— ${name.trim()} is now a major character —`); }
      catch (e) { alert('could not add: ' + e.message); }
      refreshSceneHeader(); renderDrawer();
    } }, '+');
    npcChips.replaceChildren(
      pcChip,
      ...(active.length ? active.map((a) => h('button', { class: 'chip', onclick: () => showDossier(a.npcObjectId) }, a.npc)) : [h('span', { class: 'sub' }, 'no major characters yet')]),
      addChip,
    );
  }

  // Player dossier interview: 1–3 rounds of Q&A on its own AI thread.
  function openCharacterCreator() {
    const exchanges = [];
    let currentQ = '';
    const qEl = h('div', { class: 'mem-summary', style: 'padding:0' }, 'The interviewer is thinking…');
    const aEl = h('textarea', { rows: '3', placeholder: 'Your answer…' });
    const status = h('span', { class: 'sub' });
    const nextBtn = h('button', { class: 'primary', disabled: true }, 'Answer');
    let pending = null; // AbortController for the in-flight interview request
    const cancel = () => { if (pending) pending.abort(new DOMException('cancelled', 'AbortError')); modal.remove(); };
    const modal = h('div', { class: 'modal-bg' },
      h('div', { class: 'modal' },
        h('h3', {}, 'Who are you?'),
        qEl, aEl,
        h('div', { class: 'row', style: 'gap:10px' }, nextBtn, h('button', { class: 'ghost', onclick: cancel }, 'Cancel'), status)));
    async function ask() {
      nextBtn.disabled = true; status.textContent = 'the interviewer is thinking…';
      // The dossier reply can be slow; abort rather than hang forever, and let
      // Cancel abort it immediately (the server stops generating when we do).
      pending = new AbortController();
      const timeout = setTimeout(() => pending.abort(new DOMException('timeout', 'AbortError')), 90_000);
      try {
        const r = await api.post(`/api/stories/${storyId}/player/interview`, { exchanges }, { signal: pending.signal });
        if (r.done) {
          modal.remove();
          story.settings = { ...(story.settings || {}), playerObjectId: r.objectId };
          addStatus(`(character created: ${r.name})`);
          refreshSceneHeader(); renderDrawer();
          showDossier(r.objectId);
          return;
        }
        currentQ = r.question;
        qEl.textContent = r.question;
        aEl.value = '';
        status.textContent = `question ${r.round} of ${r.maxRounds}`;
        nextBtn.disabled = false;
        aEl.focus();
      } catch (e) {
        status.textContent = e.name === 'AbortError' ? '✗ cancelled — press Answer to try again' : '✗ ' + e.message;
        nextBtn.disabled = false;
      } finally {
        clearTimeout(timeout); pending = null;
      }
    }
    nextBtn.addEventListener('click', () => {
      if (!aEl.value.trim()) return;
      exchanges.push({ question: currentQ, answer: aEl.value.trim() });
      ask();
    });
    document.body.append(modal);
    ask();
  }

  // Character/object dossier: the full fact sheet with sorting and filtering
  // by tier, visibility level and category — plus (debug) what this NPC KNOWS
  // about the world, straight from the recorded knowledge links.
  // The dossier modal currently on screen, if any — so a finished rebuild
  // (memory.updated / npc.profile.updated) can refresh it in place.
  let openDossier = null; // { oid, reopen }
  function refreshDossierIfOpen(objectIds) {
    if (openDossier && (!objectIds || objectIds.includes(openDossier.oid))) openDossier.reopen();
  }

  async function showDossier(oid) {
    const scope = debug ? 'storyteller' : 'player';
    let view;
    try { view = await api.get(`/api/memory/objects/${oid}?scope=${scope}&maxFacts=500`); } catch { return; }
    const facts = (view?.facts) || [];
    let profile = null;
    try { profile = (await api.get(`/api/stories/${storyId}/npc-profiles`)).find((p) => p.objectId === oid) || null; } catch {}
    let knowledge = null;
    try {
      const k = await api.get(`/api/stories/${storyId}/npcs/${oid}/knowledge`);
      if (k.available && k.world?.length) knowledge = k.world;
    } catch {}

    const TIER_ORD = { major: 0, mid: 1, minor: 2 };
    const LVL_ORD = { visible: 0, known: 1, secret: 2, hidden: 3 };
    const LEVELS = ['visible', 'known', 'secret', 'hidden'];
    const TIERS = ['major', 'mid', 'minor'];
    const cats = [...new Set(facts.map((f) => f.category))].sort();
    const active = { tier: new Set(), lvl: new Set(), cat: new Set() }; // empty set = no filter
    let sortBy = 'tier';
    const sel = (values, val) => h('select', {}, ...values.map((v) => h('option', { value: v, ...(v === val ? { selected: true } : {}) }, v)));

    // One fact row: display with ✎/× controls; ✎ swaps to an inline editor.
    function factRow(f) {
      const row = h('div', { class: 'fact' });
      function show() {
        row.replaceChildren(
          h('span', { class: `lvl ${f.detailLevel}` }, f.detailLevel),
          h('span', { class: `tier ${f.tier || 'mid'}` }, f.tier || 'mid'),
          h('span', { class: 'fcat' }, f.category + (f.subcategory ? '/' + f.subcategory : '')),
          h('span', {}, f.content),
          h('button', { class: 'link', title: 'edit this fact', onclick: edit }, '✎'),
          h('button', { class: 'link', title: 'delete this fact', onclick: del }, '×'));
      }
      function del() {
        if (!confirm('Delete this fact?')) return;
        api.del(`/api/memory/facts/${f.id}`)
          .then(() => { facts.splice(facts.indexOf(f), 1); renderList(); })
          .catch((e) => alert('delete failed: ' + e.message));
      }
      function edit() {
        const content = h('textarea', { rows: '2', style: 'flex:1 1 100%' }); content.value = f.content;
        const cat = h('input', { value: f.category, style: 'width:9em' });
        const lvl = sel(LEVELS, f.detailLevel);
        const tier = sel(TIERS, f.tier || 'mid');
        row.replaceChildren(content, h('div', { class: 'row', style: 'gap:6px' }, cat, lvl, tier,
          h('button', { class: 'link', onclick: async () => {
            try {
              const updated = await api.patch(`/api/memory/facts/${f.id}`, { content: content.value, category: cat.value.trim() || f.category, detailLevel: lvl.value, tier: tier.value });
              Object.assign(f, updated); renderList();
            } catch (e) { alert('save failed: ' + e.message); }
          } }, 'save'),
          h('button', { class: 'link', onclick: show }, 'cancel')));
      }
      show();
      return row;
    }

    const list = h('div', { class: 'dossier-list' });
    function renderList() {
      const kept = facts.filter((f) =>
        (!active.tier.size || active.tier.has(f.tier || 'mid')) &&
        (!active.lvl.size || active.lvl.has(f.detailLevel)) &&
        (!active.cat.size || active.cat.has(f.category)));
      const t = (f) => TIER_ORD[f.tier || 'mid'] ?? 1;
      const l = (f) => LVL_ORD[f.detailLevel] ?? 0;
      kept.sort((a, b) =>
        sortBy === 'category' ? a.category.localeCompare(b.category) || t(a) - t(b)
        : sortBy === 'level' ? l(a) - l(b) || t(a) - t(b)
        : t(a) - t(b) || a.category.localeCompare(b.category));
      list.replaceChildren(
        h('div', { class: 'sub' }, `${kept.length} of ${facts.length} fact${facts.length === 1 ? '' : 's'}`),
        ...(kept.length ? kept.map(factRow) : [h('div', { class: 'empty' }, facts.length ? 'Nothing matches the filters.' : 'Nothing known yet.')]));
    }
    function chipRow(values, key) {
      return h('div', { class: 'filter-row' }, ...values.map((v) => {
        const b = h('button', { class: 'chip filter-chip' }, v);
        b.addEventListener('click', () => { active[key].has(v) ? active[key].delete(v) : active[key].add(v); b.classList.toggle('sel'); renderList(); });
        return b;
      }));
    }
    const sortSel = h('select', { class: 'dossier-sort', onchange: (e) => { sortBy = e.target.value; renderList(); } },
      ...[['tier', 'sort: importance'], ['category', 'sort: category'], ['level', 'sort: visibility']].map(([v, lbl]) => h('option', { value: v }, lbl)));
    renderList();

    // Add a fact by hand.
    const addContent = h('textarea', { rows: '2', placeholder: 'New fact…' });
    const addCat = h('input', { value: 'personality', style: 'width:9em', title: 'category' });
    const addLvl = sel(LEVELS, 'known');
    const addTier = sel(TIERS, 'mid');
    const addForm = h('details', { class: 'quickadd' }, h('summary', {}, '+ Add fact'), addContent,
      h('div', { class: 'row', style: 'gap:6px' }, addCat, addLvl, addTier,
        h('button', { class: 'link', onclick: async () => {
          if (!addContent.value.trim()) return;
          try {
            const created = await api.post(`/api/memory/objects/${oid}/facts`, { content: addContent.value.trim(), category: addCat.value.trim() || 'notes', detailLevel: addLvl.value, tier: addTier.value });
            facts.push(created); addContent.value = ''; renderList();
          } catch (e) { alert('add failed: ' + e.message); }
        } }, 'add')));

    // Prose portrait: the storyteller's description preserved near-verbatim
    // (built by ⟳ rebuild), editable — this is where the richness lives that
    // atomic facts can't hold.
    const portraitTa = h('textarea', { rows: '5', placeholder: '(no portrait yet — press "⟳ rebuild from story" to write one from the story text)' });
    portraitTa.value = profile?.personality || '';
    const portraitStatus = h('span', { class: 'sub' });
    const portraitBlock = h('div', {},
      h('div', { class: 'mem-type' }, 'Portrait (prose — editable)'), portraitTa,
      h('div', { class: 'row', style: 'gap:8px' },
        h('button', { class: 'link', onclick: async () => {
          portraitStatus.textContent = 'saving…';
          try { await api.put(`/api/npc-profiles/${oid}`, { personality: portraitTa.value }); portraitStatus.className = 'sub ok'; portraitStatus.textContent = '✓'; }
          catch (e) { portraitStatus.className = 'sub err'; portraitStatus.textContent = '✗ ' + e.message; }
        } }, 'save portrait'), portraitStatus));

    // Rebuild: a focused AI pass re-reads the recent story text and rewrites
    // this character's portrait + fact sheet. The modal refreshes itself when
    // the background job finishes (memory.updated / npc.profile.updated).
    const rebuildBtn = h('button', { class: 'link', title: 'Re-read the recent story text and rebuild this character\'s portrait and fact sheet. Runs in the background; the dossier refreshes when done.' }, '⟳ rebuild from story');
    rebuildBtn.addEventListener('click', async () => {
      rebuildBtn.textContent = '⟳ rebuilding…'; rebuildBtn.disabled = true;
      try { await api.post(`/api/stories/${storyId}/npcs/${oid}/rebuild`); }
      catch (e) { alert('rebuild failed: ' + e.message); rebuildBtn.textContent = '⟳ rebuild from story'; rebuildBtn.disabled = false; }
    });

    // Summary: one-line description, edited via a simple prompt.
    const summaryEl = h('div', { class: 'mem-summary' }, view?.summary || '(no summary)');
    const summaryEdit = h('button', { class: 'link', title: 'edit the one-line summary', onclick: async () => {
      const next = prompt('Character summary:', view?.summary || '');
      if (next === null) return;
      try { await api.patch(`/api/memory/objects/${oid}`, { summary: next }); view.summary = next; summaryEl.textContent = next || '(no summary)'; }
      catch (e) { alert('save failed: ' + e.message); }
    } }, '✎');

    const close = () => { openDossier = null; modal.remove(); };
    const modal = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target.classList.contains('modal-bg')) close(); } },
      h('div', { class: 'modal dossier' },
        h('h3', {}, view?.name || 'Unknown', ' ', rebuildBtn),
        h('div', { class: 'row', style: 'gap:6px' }, summaryEl, summaryEdit),
        portraitBlock,
        facts.length ? h('div', { class: 'filter-bar' }, chipRow(['major', 'mid', 'minor'], 'tier'), chipRow(['visible', 'known', 'secret', 'hidden'], 'lvl'), cats.length > 1 ? chipRow(cats, 'cat') : null, sortSel) : null,
        list,
        addForm,
        knowledge ? h('div', { class: 'knows' },
          h('div', { class: 'mem-type' }, `What ${view?.name || 'they'} knows about the world`),
          ...knowledge.map((k) => h('div', { class: 'fact' },
            h('span', { class: `tier ${k.tier || 'mid'}` }, k.tier || 'mid'),
            h('span', { class: 'fcat' }, k.objectName),
            h('span', {}, k.content + (k.distorted ? '  ⚠ believes a distortion' : '')))) ) : null,
        h('button', { class: 'ghost', onclick: close }, 'Close')));
    openDossier = { oid, reopen: () => { modal.remove(); showDossier(oid); } };
    document.body.append(modal);
  }

  // Streaming scroll policy: never yank the view away while the player is
  // reading. We scroll programmatically only (a) once when a reply starts, so
  // its first line is on screen, and (b) while `follow` is on — i.e. the
  // reader put themselves at the bottom. Scrolling up during a stream turns
  // follow off; scrolling back to the bottom turns it on again.
  let follow = true;
  let progScrollAt = 0; // ignore the scroll events our own scrolls fire
  const nearBottom = () => scrollBox.scrollHeight - scrollBox.scrollTop - scrollBox.clientHeight < 48;
  const scrollDown = (force) => {
    if (!force && !follow) return;
    progScrollAt = Date.now();
    scrollBox.scrollTop = scrollBox.scrollHeight;
  };
  scrollBox.addEventListener('scroll', () => { if (Date.now() - progScrollAt < 250) return; follow = nearBottom(); });
  // Show the START of a new streamed reply once, then stop auto-following so
  // the player can read it from the top while tokens keep arriving below.
  const showReplyStart = (bubble) => {
    progScrollAt = Date.now();
    bubble.scrollIntoView({ block: 'start' });
    follow = false;
  };
  const addBubble = (cls, text) => { const b = h('div', { class: `bubble ${cls}` }, text); transcript.append(b); scrollDown(); return b; };
  const addStatus = (t) => { transcript.append(h('div', { class: 'status-line' }, t)); scrollDown(); };

  // Load (or reload, after a rewind) the transcript from the server.
  let turnCount = 0;
  async function redrawTranscript() {
    transcript.replaceChildren();
    try {
      const turns = await api.get(`/api/stories/${storyId}/turns`);
      turnCount = turns.length;
      for (const t of turns) { if (t.playerInput) addBubble('player', t.playerInput); if (t.narration) addBubble('narration', t.narration); }
      follow = true;
      scrollDown(true); // a (re)loaded transcript always opens at the latest exchange
    } catch {}
  }
  await redrawTranscript();

  // A brand-new story opens itself: the storyteller sets the scene unprompted.
  let autoOpened = false;
  function maybeAutoOpen() {
    if (autoOpened || turnCount > 0 || busy || !wsOpen()) return;
    autoOpened = true;
    addStatus('(the storyteller opens the story…)');
    submitText('', false);
  }

  // Feature 1: delete the latest exchange (halting any in-flight response) and
  // put the prompt back in the box for editing. State (summaries, memory, …)
  // is restored server-side to before the message was sent.
  let rewinding = false;
  rewindBtn.addEventListener('click', async () => {
    if (rewinding) return;
    if (!confirm('Delete the last story message? This removes the storyteller’s latest response and restores memory & summaries to before it.')) return;
    rewinding = true; rewindBtn.disabled = true;
    try {
      const r = await api.post(`/api/stories/${storyId}/rewind`);
      current = null; setBusy(false);
      await redrawTranscript();
      if (r.playerInput) { input.value = r.playerInput; input.dispatchEvent(new Event('input')); }
      addStatus('(rewound — edit your message and send again)');
      input.focus();
      renderDrawer(); refreshSceneHeader();
    } catch (e) { addStatus('rewind failed: ' + e.message); }
    rewinding = false; rewindBtn.disabled = false;
  });

  // ---- Drawer tabs (Memory always; Summaries/Threads under debug) ----
  let activeTab = 'memory';
  async function renderDrawer() {
    const tabs = [['memory', 'Memory']];
    // NPC Story Mode: each character's mind (personality + private notes) is a
    // first-class, player-editable panel — the mode's replacement for the
    // memory browser's NPC role.
    if (story.settings?.npcStories?.enabled) tabs.unshift(['minds', 'NPC minds']);
    if (debug) tabs.push(['summaries', 'Summaries'], ['threads', 'Threads']);
    if (!tabs.find((t) => t[0] === activeTab)) activeTab = tabs[0][0];
    const tabRow = h('div', { class: 'tabs' }, ...tabs.map(([k, label]) =>
      h('button', { class: 'tab' + (activeTab === k ? ' active' : ''), onclick: () => { activeTab = k; renderDrawer(); } }, label)));
    const body = h('div', { class: 'drawer-body' }, h('div', { class: 'empty' }, 'Loading…'));
    drawer.replaceChildren(tabRow, body);
    if (activeTab === 'minds') await renderMinds(body);
    else if (activeTab === 'memory') await renderMemory(body);
    else if (activeTab === 'summaries') await renderSummaries(body);
    else await renderThreads(body);
  }

  // ---- NPC minds (NPC Story Mode): view & repair each character's head. ----
  async function renderMinds(body) {
    body.replaceChildren();
    let profiles = [];
    try { profiles = await api.get(`/api/stories/${storyId}/npc-profiles`); } catch {}
    if (!profiles.length) {
      body.append(h('div', { class: 'empty' }, 'No character minds yet — they appear when a major character enters a scene.'));
      return;
    }
    for (const p of profiles) {
      const persona = h('textarea', { rows: '4', placeholder: '(personality is being seeded…)' }); persona.value = p.personality || '';
      const notes = h('textarea', { rows: '6', placeholder: '(no notes yet — they write these themselves as they play)' }); notes.value = p.notes || '';
      const status = h('span', { class: 'sub' });
      const save = h('button', { class: 'link' }, 'save');
      save.addEventListener('click', async () => {
        status.textContent = 'saving…';
        try { await api.put(`/api/npc-profiles/${p.objectId}`, { personality: persona.value, notes: notes.value }); status.className = 'sub ok'; status.textContent = '✓'; }
        catch (e) { status.className = 'sub err'; status.textContent = '✗ ' + e.message; }
      });
      const details = h('div', { class: 'facts hidden' },
        h('div', { class: 'sub' }, 'Personality (stable — who they are)'), persona,
        h('div', { class: 'sub' }, 'Private notes (their own memory — they rewrite these each round they act)'), notes,
        h('div', { class: 'row', style: 'gap:8px' }, save, status));
      body.append(h('div', { class: 'mem-obj' },
        h('div', { class: 'mem-head' },
          h('span', { class: 'mem-name', onclick: () => details.classList.toggle('hidden') }, p.name),
          h('span', { class: 'sub', onclick: () => details.classList.toggle('hidden') }, p.personality ? 'mind' : 'seeding…')),
        details));
    }
  }

  async function renderMemory(body) {
    body.replaceChildren();
    const scope = debug ? 'storyteller' : 'player';

    // Feature: the salience system is optional per story.
    let salienceOn = story.settings?.salience?.enabled !== false;
    const salBtn = h('button', { class: 'link' }, salienceOn ? 'on' : 'off');
    salBtn.addEventListener('click', async () => {
      salienceOn = !salienceOn;
      await api.patch(`/api/stories/${storyId}`, { settings: { salience: { enabled: salienceOn } } });
      story.settings = { ...(story.settings || {}), salience: { enabled: salienceOn } };
      salBtn.textContent = salienceOn ? 'on' : 'off';
    });
    // Manual cleanup: unify duplicate entities + consolidate facts, right now.
    const cleanBtn = h('button', { class: 'link', title: 'Run the memory cleanup now: unify entities recorded under different names, deduplicate & merge facts, refresh summaries. Runs automatically every 10 turns.' }, 'clean up');
    cleanBtn.addEventListener('click', async () => {
      cleanBtn.textContent = 'cleaning…'; cleanBtn.disabled = true;
      try { await api.post(`/api/stories/${storyId}/memory/maintenance`); } catch (e) { alert('cleanup failed: ' + e.message); }
      // The memory.updated WS event re-renders the tab when the job finishes.
    });
    // Manual re-scan: re-run the memory scribe over recent turns when a pass
    // missed something (duplicates are filtered automatically on apply).
    const rescanBtn = h('button', { class: 'link', title: 'Re-run the memory scribe over the last few exchanges — use when it missed something important. Already-recorded facts are not duplicated.' }, 're-scan turns');
    rescanBtn.addEventListener('click', async () => {
      rescanBtn.textContent = 're-scanning…'; rescanBtn.disabled = true;
      try { await api.post(`/api/stories/${storyId}/memory/rescan`, {}); } catch (e) { alert('re-scan failed: ' + e.message); }
      // The memory.updated WS event re-renders the tab when the jobs finish.
    });
    body.append(h('div', { class: 'row item-tools' },
      h('span', { class: 'sub', title: 'Importance weighting & decay of memory objects. Off = salience frozen and ignored in ranking.' }, 'Salience system:'), salBtn, cleanBtn, rescanBtn));

    // Suggestion inbox.
    let suggestions = [];
    try { suggestions = await api.get(`/api/stories/${storyId}/memory/suggestions`); } catch {}
    if (suggestions.length) {
      body.append(h('div', { class: 'inbox' }, h('div', { class: 'inbox-h' }, `Suggestions (${suggestions.length})`),
        ...suggestions.map((s) => h('div', { class: 'sug' }, h('span', {}, s.reason || `${s.type}`),
          h('span', { class: 'row' },
            h('button', { class: 'link', onclick: async () => { await api.post(`/api/memory/suggestions/${s.id}`, { action: 'accept' }); renderMemory(body); } }, 'merge'),
            h('button', { class: 'link', onclick: async () => { await api.post(`/api/memory/suggestions/${s.id}`, { action: 'reject' }); renderMemory(body); } }, 'dismiss'))))));
    }
    // Object list grouped by type.
    let objects = [];
    try { objects = await api.get(`/api/stories/${storyId}/memory/objects?scope=${scope}`); } catch {}
    if (!objects.length) { body.append(h('div', { class: 'empty' }, 'No memory yet — play a few turns and the scribe will populate this.')); }
    const byType = {};
    for (const row of objects) (byType[row.object.type] ||= []).push(row);
    for (const [type, rows] of Object.entries(byType)) {
      body.append(h('div', { class: 'mem-type' }, type));
      for (const row of rows) body.append(memObjectCard(row, scope, () => renderMemory(body), objects));
    }
    // Quick add.
    body.append(h('details', { class: 'quickadd' }, h('summary', {}, '+ Add object manually'), quickAddObject(() => renderMemory(body))));
  }

  function memObjectCard(row, scope, refresh, allObjects) {
    const { object, view } = row;
    const facts = (view?.facts) || [];
    const factList = h('div', { class: 'facts hidden' });
    const head = h('div', { class: 'mem-head' },
      h('span', { class: 'mem-name', onclick: () => factList.classList.toggle('hidden') }, object.name),
      h('span', { class: 'sub', onclick: () => factList.classList.toggle('hidden') }, `${facts.length} fact${facts.length === 1 ? '' : 's'}`));
    // Characters can be promoted to major NPCs (own agent) or demoted.
    if (object.type === 'character') {
      const isActive = activeNpcIds.has(object.id);
      const btn = h('button', { class: 'link', onclick: async (ev) => {
        ev.stopPropagation();
        const q = isActive
          ? `Demote ${object.name}? They stop acting with their own mind; the storyteller voices them again.`
          : `Promote ${object.name} to a major character? They get their own mind and a full dossier (persona, looks, belongings, skills, state, goals) written by the AI.`;
        if (!confirm(q)) return;
        await api.post(`/api/stories/${storyId}/npcs/${object.id}/${isActive ? 'demote' : 'promote'}`);
        await refreshSceneHeader(); refresh();
      } }, isActive ? 'demote' : 'promote');
      head.append(btn);
    }
    const card = h('div', { class: 'mem-card' }, head, factList);
    if (object.summary) factList.append(h('div', { class: 'mem-summary' }, object.summary));

    // Feature 5: edit / delete the object itself (+ full dossier view).
    const objTools = h('div', { class: 'row item-tools' },
      h('button', { class: 'link', onclick: () => showDossier(object.id) }, 'dossier'),
      h('button', { class: 'link', onclick: () => objForm.classList.toggle('gone') }, 'edit'),
      h('button', { class: 'link danger', onclick: async () => {
        if (!confirm(`Delete "${object.name}" and all its facts?`)) return;
        await api.del(`/api/memory/objects/${object.id}`); refresh(); refreshSceneHeader();
      } }, 'delete'));
    const nameIn = h('input', { value: object.name });
    const sumIn = h('input', { value: object.summary || '', placeholder: 'Summary' });
    const objForm = h('div', { class: 'form gone' }, nameIn, sumIn,
      h('button', { class: 'small primary', onclick: async () => {
        await api.patch(`/api/memory/objects/${object.id}`, { name: nameIn.value, summary: sumIn.value }); refresh();
      } }, 'Save'));
    factList.append(objTools, objForm);

    // Merge duplicate entities: fold another object (same character under a
    // different name) into this one — facts, knowledge and aliases follow.
    const others = (allObjects || []).map((r) => r.object).filter((o) => o.id !== object.id);
    if (others.length) {
      const mergeSel = h('select', {},
        h('option', { value: '' }, 'merge another object into this…'),
        ...others.map((o) => h('option', { value: o.id }, `${o.name} (${o.type})`)));
      mergeSel.addEventListener('change', async () => {
        const mergeId = mergeSel.value;
        if (!mergeId) return;
        const victim = others.find((o) => o.id === mergeId);
        if (!confirm(`Merge "${victim?.name}" into "${object.name}"? Its facts and aliases move here; the duplicate is deleted.`)) { mergeSel.value = ''; return; }
        try { await api.post(`/api/memory/objects/${object.id}/merge`, { mergeId }); } catch (e) { alert('merge failed: ' + e.message); }
        refresh(); refreshSceneHeader();
      });
      objForm.append(mergeSel);
    }

    for (const f of facts) factList.append(factRow(f, refresh));
    factList.append(h('details', { class: 'quickadd' }, h('summary', {}, '+ fact'), quickAddFact(object.id, refresh)));
    return card;
  }

  // In-game clock stamp on a fact ("d2 14:30"), when the engine recorded one.
  function gameTimeTag(min) {
    if (min == null) return null;
    const day = Math.floor(min / 1440) + 1, hh = Math.floor((min % 1440) / 60), mm = min % 60;
    return h('span', { class: 'sub', title: 'In-game time when this was recorded' }, `d${day} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
  }

  // Feature 5: a fact row with inline edit (content/category/level/tier) and delete.
  function factRow(f, refresh) {
    const row = h('div', { class: 'fact' },
      h('span', { class: `lvl ${f.detailLevel}` }, f.detailLevel),
      h('span', { class: `tier ${f.tier || 'mid'}` }, f.tier || 'mid'),
      h('span', { class: 'fcat' }, f.category),
      ...(gameTimeTag(f.gameTimeMin) ? [gameTimeTag(f.gameTimeMin)] : []),
      h('span', {}, f.content),
      h('button', { class: 'link', onclick: () => startEdit() }, '✎'),
      h('button', { class: 'link danger', onclick: async () => {
        if (!confirm('Delete this fact?')) return;
        await api.del(`/api/memory/facts/${f.id}?hard=true`); refresh();
      } }, '✕'));
    function startEdit() {
      const content = h('input', { value: f.content });
      const cat = h('input', { value: f.category });
      const lvl = h('select', {}, ...['visible', 'known', 'secret', 'hidden'].map((l) => h('option', { ...(l === f.detailLevel ? { selected: true } : {}) }, l)));
      const tier = h('select', {}, ...['major', 'mid', 'minor'].map((t) => h('option', { ...(t === (f.tier || 'mid') ? { selected: true } : {}) }, t)));
      const form = h('div', { class: 'form' }, content, cat, lvl, tier,
        h('button', { class: 'small primary', onclick: async () => {
          await api.patch(`/api/memory/facts/${f.id}`, { content: content.value, category: cat.value, detailLevel: lvl.value, tier: tier.value }); refresh();
        } }, 'Save'),
        h('button', { class: 'small', onclick: () => { form.replaceWith(row); } }, 'Cancel'));
      row.replaceWith(form);
    }
    return row;
  }

  function quickAddObject(refresh) {
    const name = h('input', { placeholder: 'Name' });
    const type = h('select', {}, ...['character', 'item', 'location', 'faction', 'event', 'lore'].map((t) => h('option', {}, t)));
    const summary = h('input', { placeholder: 'Summary (optional)' });
    const btn = h('button', { class: 'small primary' }, 'Create');
    btn.addEventListener('click', async () => { if (!name.value) return; await api.post(`/api/stories/${storyId}/memory/objects`, { name: name.value, type: type.value, summary: summary.value }); refresh(); });
    return h('div', { class: 'form' }, name, type, summary, btn);
  }

  function quickAddFact(objectId, refresh) {
    const content = h('input', { placeholder: 'Fact content' });
    const cat = h('input', { placeholder: 'category', value: 'state' });
    const lvl = h('select', {}, ...['visible', 'known', 'secret', 'hidden'].map((l) => h('option', {}, l)));
    const tier = h('select', {}, ...['major', 'mid', 'minor'].map((t) => h('option', { ...(t === 'mid' ? { selected: true } : {}) }, t)));
    const btn = h('button', { class: 'small primary' }, 'Add');
    btn.addEventListener('click', async () => { if (!content.value) return; await api.post(`/api/memory/objects/${objectId}/facts`, { content: content.value, category: cat.value, detailLevel: lvl.value, tier: tier.value }); refresh(); });
    return h('div', { class: 'form' }, content, cat, lvl, tier, btn);
  }

  async function renderSummaries(body) {
    body.replaceChildren();
    // The hidden in-game clock (debug view only — the story never states it).
    try {
      const s = await api.get(`/api/stories/${storyId}`);
      if (s && s.clockMin != null) {
        const day = Math.floor(s.clockMin / 1440) + 1, hh = Math.floor((s.clockMin % 1440) / 60), mm = s.clockMin % 60;
        body.append(h('div', { class: 'row item-tools' }, h('span', { class: 'sub' },
          `In-game clock: Day ${day}, ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`)));
      }
    } catch {}
    let sums = [];
    try { sums = await api.get(`/api/stories/${storyId}/summaries`); } catch {}
    if (!sums.length) { body.append(h('div', { class: 'empty' }, 'No summaries yet.')); return; }
    for (const s of sums) body.append(h('div', { class: 'mem-card' },
      h('div', { class: 'mem-head' }, h('span', { class: 'mem-name' }, s.scope === 'story' ? 'Story digest' : 'Scene summary'), h('span', { class: 'sub' }, `→ turn ${s.coversToTurnIndex}`)),
      h('div', { class: 'mem-summary' }, s.content || '(empty)')));
  }

  // Feature 7: parsed, human-readable view of agent threads (prompts &
  // replies), with the raw JSON tucked behind a toggle.
  function kvNode(val) {
    if (val === null || val === undefined) return h('span', { class: 'kv-val sub' }, '—');
    if (typeof val !== 'object') return h('span', { class: 'kv-val' }, String(val));
    if (Array.isArray(val)) {
      if (!val.length) return h('span', { class: 'kv-val sub' }, '(none)');
      return h('div', { class: 'kv-list' }, ...val.map((v) => h('div', { class: 'kv-item' }, kvNode(v))));
    }
    // Fact-like objects → one readable row: category 25% | subcategory 25% |
    // content 50%, with the remaining fields in a muted meta line below.
    if ('content' in val && 'category' in val) {
      const rest = Object.entries(val).filter(([k, v]) => !['category', 'subcategory', 'content'].includes(k) && v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length));
      return h('div', { class: 'kv-fact' },
        h('div', { class: 'fact-grid' },
          h('span', { class: 'fcat' }, String(val.category ?? '')),
          h('span', { class: 'fcat sub' }, String(val.subcategory ?? '')),
          h('span', { class: 'fg-content' }, String(val.content ?? ''))),
        rest.length ? h('div', { class: 'sub fg-meta' }, rest.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')) : null);
    }
    return h('div', { class: 'kv-obj' }, ...Object.entries(val).map(([k, v]) => h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, k), kvNode(v))));
  }

  function parsedPayload(l) {
    const p = l.payload || {};
    const box = h('div', { class: 'thread-parsed' });
    if (l.direction === 'request') {
      if (p.model) box.append(h('div', { class: 'sub' }, `model: ${p.model}`));
      if (p.system) box.append(h('details', {}, h('summary', { class: 'sub' }, 'system prompt'), h('div', { class: 'prose' }, p.system)));
      for (const m of p.messages || []) {
        box.append(h('div', { class: 'msg' }, h('span', { class: `role-chip ${m.role}` }, m.role), h('div', { class: 'prose' }, m.content)));
      }
    } else {
      // Response: prefer the structured result; otherwise readable text with
      // any code/JSON fences pulled out into their own blocks.
      if (p.parsed && typeof p.parsed === 'object') box.append(kvNode(p.parsed));
      else {
        const text = String(p.text ?? '');
        let plain = text;
        const fences = [];
        plain = plain.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => { fences.push({ lang, code }); return ''; });
        plain = plain.trim();
        if (!plain && !fences.length) {
          try { box.append(kvNode(JSON.parse(text))); } catch { box.append(h('div', { class: 'prose' }, text)); }
        } else {
          if (plain) {
            try { box.append(kvNode(JSON.parse(plain))); } catch { box.append(h('div', { class: 'prose' }, plain)); }
          }
          for (const f of fences) box.append(h('details', {}, h('summary', { class: 'sub' }, f.lang || 'code'), h('pre', { class: 'thread-payload' }, f.code.trim())));
        }
      }
      if (p.stopReason) box.append(h('div', { class: 'sub' }, `stop: ${p.stopReason}`));
    }
    box.append(h('details', {}, h('summary', { class: 'sub' }, 'raw JSON'), h('pre', { class: 'thread-payload' }, JSON.stringify(p, null, 2))));
    return box;
  }

  async function renderThreads(body) {
    body.replaceChildren();
    let logs = [];
    try { logs = await api.get(`/api/stories/${storyId}/threadlog?limit=60`); } catch {}
    if (!logs.length) { body.append(h('div', { class: 'empty' }, 'No agent activity yet.')); return; }
    for (const l of logs) {
      const detail = h('div', { class: 'gone' });
      let built = false;
      body.append(h('div', { class: 'mem-card' },
        h('div', { class: 'mem-head', onclick: () => { if (!built) { detail.append(parsedPayload(l)); built = true; } detail.classList.toggle('gone'); } },
          h('span', { class: `role-badge ${l.agentRole}` }, l.agentRole),
          // Requests carry no duration; show the input size and how long ago it
          // was sent instead of a misleading "0ms". Responses show real latency.
          h('span', { class: 'sub' }, l.direction === 'response'
            ? `response · ${l.tokensOut ?? 0}tk · ${((l.durationMs ?? 0) / 1000).toFixed(1)}s`
            : `request · ${l.tokensIn ?? 0}tk · sent ${Math.max(0, Math.round((Date.now() - l.createdAt) / 1000))}s ago`)),
        detail));
    }
  }

  // ---- WebSocket (with auto-reconnect and a tappable status dot) ----
  let ws = null, current = null, busy = false, lastInput = '';
  let disposed = false, reconnectTimer = null;
  const wsInfo = { attempts: 0, since: null, lastClose: null, nextRetryAt: null };
  const setBusy = (b) => { busy = b; sendBtn.disabled = b; cancelBtn.disabled = !b; };
  const wsOpen = () => ws && ws.readyState === WebSocket.OPEN;

  function connectWs() {
    if (disposed) return;
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => { wsDot.classList.add('on'); wsInfo.attempts = 0; wsInfo.since = Date.now(); wsInfo.lastClose = null; wsInfo.nextRetryAt = null; maybeAutoOpen(); };
    ws.onclose = (ev) => {
      wsDot.classList.remove('on');
      wsInfo.lastClose = { code: ev.code, reason: ev.reason || '', at: Date.now() };
      scheduleReconnect();
    };
    ws.onerror = () => wsDot.classList.remove('on');
    ws.onmessage = onWsMessage;
  }
  function scheduleReconnect() {
    if (disposed || reconnectTimer) return;
    wsInfo.attempts++;
    const delay = Math.min(15000, 1000 * 2 ** Math.min(4, wsInfo.attempts - 1));
    wsInfo.nextRetryAt = Date.now() + delay;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWs(); }, delay);
  }
  // Leaving the page stops the reconnect loop and closes the socket.
  const dispose = () => { disposed = true; clearTimeout(reconnectTimer); try { ws?.close(); } catch {} window.removeEventListener('hashchange', dispose); };
  window.addEventListener('hashchange', dispose);

  // Tapping the green/red dot explains the connection state.
  wsDot.style.cursor = 'pointer';
  wsDot.title = 'connection status — tap for details';
  wsDot.addEventListener('click', async () => {
    const rows = [];
    const row = (k, v) => h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, k), h('span', { class: 'kv-val' }, v));
    if (wsOpen()) rows.push(row('connection', `✓ connected${wsInfo.since ? ` (since ${new Date(wsInfo.since).toLocaleTimeString()})` : ''}`));
    else {
      rows.push(row('connection', '✗ disconnected'));
      if (wsInfo.lastClose) rows.push(row('closed', `code ${wsInfo.lastClose.code}${wsInfo.lastClose.reason ? ` — ${wsInfo.lastClose.reason}` : ''} at ${new Date(wsInfo.lastClose.at).toLocaleTimeString()}`));
      if (wsInfo.nextRetryAt) rows.push(row('retrying', `attempt ${wsInfo.attempts}, next in ~${Math.max(0, Math.round((wsInfo.nextRetryAt - Date.now()) / 1000))}s`));
    }
    const healthRow = row('server', 'checking…');
    rows.push(healthRow);
    const reconnectBtn = h('button', { class: 'small' }, 'Reconnect now');
    const modal = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target.classList.contains('modal-bg')) modal.remove(); } },
      h('div', { class: 'modal' },
        h('h3', {}, 'Connection'),
        h('div', { class: 'kv-obj' }, ...rows),
        h('div', { class: 'row', style: 'margin-top:8px; gap:10px' },
          reconnectBtn,
          h('button', { class: 'ghost', onclick: () => modal.remove() }, 'Close'))));
    reconnectBtn.addEventListener('click', () => { clearTimeout(reconnectTimer); reconnectTimer = null; try { ws?.close(); } catch {} connectWs(); modal.remove(); });
    document.body.append(modal);
    // Distinguish "server down" from "websocket blocked": probe the HTTP API.
    try {
      const r = await fetch('/api/system/health', { signal: AbortSignal.timeout(4000) });
      const j = r.ok ? await r.json() : null;
      healthRow.lastChild.textContent = r.ok ? `✓ reachable (providers: ${(j?.providers || []).join(', ') || 'none'})` : `✗ HTTP ${r.status}`;
    } catch (e) { healthRow.lastChild.textContent = '✗ unreachable — is the PRPG server running? (' + e.message + ')'; }
  });

  function onWsMessage(ev) {
    const m = JSON.parse(ev.data);
    switch (m.t) {
      case 'turn.accepted': current = addBubble('narration cursor', ''); showReplyStart(current); break;
      case 'turn.status': addStatus(m.text); break;
      case 'turn.delta': if (!current) { current = addBubble('narration cursor', ''); showReplyStart(current); } current.textContent += m.text; scrollDown(); break;
      case 'turn.final':
        if (current) { current.className = 'bubble narration'; current.textContent = m.narration; }
        // Dice stay hidden from play — shown only in debug mode (and always in turn meta/logs).
        if (debug && m.meta?.rolls?.length) for (const r of m.meta.rolls) transcript.append(h('div', { class: 'tokens' }, `🎲 ${r.actor} — ${r.action}: ${r.chance}% vs d100=${r.roll} → ${r.outcome}${r.assessment ? `  (${r.assessment})` : ''}`));
        if (m.meta && (m.meta.promptTokensEst || m.meta.outputTokensEst)) transcript.append(h('div', { class: 'tokens' }, `~${m.meta.promptTokensEst || 0} in / ${m.meta.outputTokensEst || 0} out · ${m.meta.durationMs || 0}ms`));
        current = null; setBusy(false); scrollDown(); break;
      case 'turn.rejected': if (current) current.remove(); addStatus('(cancelled)'); current = null; setBusy(false); break;
      case 'turn.error':
        if (current) current.remove();
        addBubble('error', `The turn failed — ${m.message}`);
        // Don't lose the message: put it back in the box for another try.
        if (!input.value.trim() && lastInput) { input.value = lastInput; input.dispatchEvent(new Event('input')); }
        current = null; setBusy(false); break;
      case 'summary.updated': if (activeTab === 'summaries') renderDrawer(); break;
      case 'memory.updated': if (activeTab === 'memory') renderDrawer(); refreshDossierIfOpen(m.objectIds); break;
      case 'npc.profile.updated': if (m.storyId === storyId) { if (activeTab === 'minds') renderDrawer(); refreshDossierIfOpen(m.objectIds); } break;
      case 'scene.changed': api.get(`/api/stories/${storyId}`).then((s) => { sceneLabel.textContent = s.scene?.title || 'Scene'; }).catch(() => {}); refreshSceneHeader(); break;
      case 'story.rewound': if (m.storyId === storyId && !rewinding) { current = null; setBusy(false); redrawTranscript(); renderDrawer(); refreshSceneHeader(); } break;
      case 'thread.activity': if (m.storyId === storyId) noteAgentActivity(m.entry); if (activeTab === 'threads') renderDrawer(); break;
      // A background agent (scribe, archiver, dossier…) gave up after retries —
      // surface the full error in the transcript instead of failing silently.
      case 'job.failed': if (m.storyId === storyId) { markAgentError(m.type); addBubble('error', `Background agent failed — ${m.type}: ${m.error || 'unknown error'} (retry from the failed-jobs list or ignore; play continues)`); } break;
    }
  }

  async function handleSlash(text) {
    if (text.startsWith('/look')) {
      const name = text.slice(5).trim();
      if (!name) { addStatus('usage: /look <name>'); return true; }
      try { const view = await api.get(`/api/stories/${storyId}/look?name=${encodeURIComponent(name)}`); showLook(view); }
      catch (e) { addStatus(e.message); }
      return true;
    }
    if (text === '/scene') { newSceneBtn.click(); return true; }
    if (text === '/retry') { if (lastInput !== undefined) submitText(lastInput, true); return true; }
    return false;
  }

  function showLook(view) {
    const facts = (view?.facts) || [];
    const modal = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target.classList.contains('modal-bg')) modal.remove(); } },
      h('div', { class: 'modal' },
        h('h3', {}, view?.name || 'You see nothing.'),
        view?.summary ? h('div', { class: 'mem-summary' }, view.summary) : null,
        ...(facts.length ? facts.map((f) => h('div', { class: 'fact' }, h('span', { class: 'fcat' }, f.category), h('span', {}, f.content))) : [h('div', { class: 'empty' }, 'Nothing more is apparent.')]),
        h('button', { class: 'ghost', onclick: () => modal.remove() }, 'Close')));
    document.body.append(modal);
  }

  /** Try to send; returns false (with a visible reason) instead of silently dropping. */
  function submitText(text, isRetry) {
    if (busy) { addStatus('(the storyteller is still working — wait or press Stop)'); return false; }
    if (!wsOpen()) { addStatus('(not connected — your message is kept; tap the status dot for details)'); return false; }
    if (!isRetry && text) { addBubble('player', text); scrollDown(true); }
    lastInput = text;
    setBusy(true);
    resetAgentStatus(); // fresh round — clear last turn's agent activity
    ws.send(JSON.stringify({ t: 'turn.submit', storyId, input: text }));
    return true;
  }

  const submit = async () => {
    const text = input.value.trim();
    if (text.startsWith('/')) {
      if (await handleSlash(text)) { input.value = ''; input.style.height = 'auto'; return; }
    }
    // Clear the box only once the message is actually on its way.
    if (submitText(text, false)) { input.value = ''; input.style.height = 'auto'; }
  };
  sendBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', () => { if (wsOpen()) ws.send(JSON.stringify({ t: 'turn.cancel', storyId })); });
  // Enter inserts a line break (multi-line prompts are the norm here — an
  // accidental Enter must never fire a half-written message). Sending is the
  // Send button or Ctrl/Cmd+Enter.
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; });

  connectWs();
  renderDrawer();
  refreshSceneHeader();
}

// ---------------- Settings ----------------
const ROLE_LABELS = { storyteller: 'Storyteller', npc: 'NPC', scribe_memory: 'Memory scribe', scribe_story: 'Story scribe', overseer: 'Rule overseer', context_planner: 'Context planner', adjudicator: 'Adjudicator', player_intake: 'Character interviewer' };
const PROVIDER_LABELS = { anthropic: 'Anthropic', openai_compat: 'OpenAI-compatible (OpenRouter, etc.)' };

async function renderSettings() {
  app.replaceChildren(topbar(h('button', { class: 'ghost small', onclick: () => (location.hash = '/') }, '← Home')), h('div', { class: 'scroll' }, h('div', { class: 'container' }, h('div', { class: 'empty' }, 'Loading…'))));
  let view, prompts, seedMeta;
  try { view = await api.get('/api/settings/config'); prompts = await api.get('/api/settings/prompts'); seedMeta = await api.get('/api/settings/seeds'); }
  catch (e) { app.replaceChildren(topbar(), h('div', { class: 'container' }, h('div', { class: 'empty' }, 'Failed to load settings: ' + e.message))); return; }
  const seedNote = `${seedMeta.count} phrases · ${seedMeta.overridden ? 'customised' : 'default'} ›`;

  const favs = view.favourites.map((f) => ({ ...f }));
  const roles = JSON.parse(JSON.stringify(view.roles));
  const perf = { jobConcurrency: 2, requestTimeoutMs: 180000, ...(view.performance || {}) };
  const provInputs = {};

  function providerCard(kind) {
    const p = view.providers[kind] || {};
    const baseUrl = h('input', { placeholder: kind === 'openai_compat' ? 'https://openrouter.ai/api/v1' : 'https://api.anthropic.com (optional)', value: p.baseUrl || '' });
    const apiKey = h('input', { type: 'password', placeholder: p.configured ? `saved (${p.hint}) — leave blank to keep` : 'paste your API key' });
    const result = h('span', { class: 'sub' });
    const testBtn = h('button', { class: 'small' }, 'Test key');
    testBtn.addEventListener('click', async () => {
      result.className = 'sub'; result.textContent = 'testing…';
      try {
        const r = await api.post('/api/settings/test', { provider: kind, apiKey: apiKey.value || undefined, baseUrl: baseUrl.value || undefined });
        result.className = r.ok ? 'sub ok' : 'sub err';
        result.textContent = r.ok ? `✓ OK (${r.latencyMs}ms · ${r.model})` : `✗ ${r.error}`;
      } catch (e) { result.className = 'sub err'; result.textContent = '✗ ' + e.message; }
    });
    provInputs[kind] = { baseUrl, apiKey };

    // Feature 7: rate-limit / credits check (OpenRouter `GET /key`), with the
    // result displayed inside the provider card.
    const extras = [];
    if (kind === 'openai_compat') {
      const limitsBox = h('div', { class: 'limits' });
      const limitsBtn = h('button', { class: 'small' }, 'Check limits');
      limitsBtn.addEventListener('click', async () => {
        limitsBox.replaceChildren(h('span', { class: 'sub' }, 'checking…'));
        try {
          const r = await api.get('/api/settings/limits/openai_compat');
          if (!r.ok) { limitsBox.replaceChildren(h('span', { class: 'sub err' }, '✗ ' + (r.error || 'failed'))); return; }
          const k = r.key || {};
          const fmt = (n) => (typeof n === 'number' ? '$' + n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : String(n));
          const rows = [
            ['key', k.label || '—'],
            ['credits', k.limit == null ? `${fmt(k.usage)} used · no limit` : `${fmt(k.limit_remaining)} remaining of ${fmt(k.limit)}${k.limit_reset ? ` (resets: ${k.limit_reset})` : ''}`],
            ['usage', `today ${fmt(k.usage_daily)} · week ${fmt(k.usage_weekly)} · month ${fmt(k.usage_monthly)}`],
            ['tier', k.is_free_tier ? 'free tier' : 'paid'],
          ];
          limitsBox.replaceChildren(...rows.map(([a, b]) => h('div', { class: 'kv-row' }, h('span', { class: 'kv-key' }, a), h('span', { class: 'kv-val' }, b))));
        } catch (e) { limitsBox.replaceChildren(h('span', { class: 'sub err' }, '✗ ' + e.message)); }
      });
      extras.push(limitsBtn, limitsBox);
    }

    return h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, PROVIDER_LABELS[kind]),
      h('label', {}, 'Base URL'), baseUrl, h('label', {}, 'API key'), apiKey,
      h('div', { class: 'row', style: 'margin-top:10px; gap:10px; flex-wrap:wrap' }, testBtn, result, ...extras.slice(0, 1)),
      ...extras.slice(1));
  }

  const dynHost = h('div');
  function paint() {
    const favRows = favs.map((f, i) => {
      const label = h('input', { value: f.label, placeholder: 'label', oninput: (e) => (f.label = e.target.value) });
      const prov = h('select', { onchange: (e) => (f.provider = e.target.value) }, ...Object.keys(PROVIDER_LABELS).map((k) => h('option', { value: k, ...(k === f.provider ? { selected: true } : {}) }, k)));
      const model = h('input', { value: f.model, placeholder: 'model id (e.g. anthropic/claude-sonnet-4.5)', oninput: (e) => (f.model = e.target.value) });
      // Feature 6: live-test this specific model with the saved provider key.
      const testRes = h('span', { class: 'sub' });
      const test = h('button', { class: 'link', onclick: async () => {
        testRes.className = 'sub'; testRes.textContent = '…';
        try {
          const r = await api.post('/api/settings/test', { provider: f.provider, model: f.model });
          testRes.className = r.ok ? 'sub ok' : 'sub err';
          testRes.textContent = r.ok ? `✓ ${r.latencyMs}ms` : `✗ ${r.error}`;
        } catch (e) { testRes.className = 'sub err'; testRes.textContent = '✗ ' + e.message; }
      } }, 'test');
      const rm = h('button', { class: 'link', onclick: () => { favs.splice(i, 1); paint(); } }, 'remove');
      return h('div', { class: 'fav-row' }, label, prov, model, test, testRes, rm);
    });
    const addFav = h('button', { class: 'small', onclick: () => { favs.push({ id: 'f' + Math.random().toString(36).slice(2, 8), label: 'New model', provider: 'openai_compat', model: '' }); paint(); } }, '+ Add model');
    const favCard = h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Model favourites'), h('div', { class: 'sub', style: 'margin-bottom:8px' }, 'Curate the models you use; pick from these per role below.'), ...favRows, addFav);

    const roleRows = Object.keys(ROLE_LABELS).map((role) => {
      const binding = roles[role] || (roles[role] = { favouriteId: favs[0]?.id || '', temperature: 0.8, maxTokens: 2048 });
      const sel = h('select', { onchange: (e) => (binding.favouriteId = e.target.value) }, ...favs.map((f) => h('option', { value: f.id, ...(f.id === binding.favouriteId ? { selected: true } : {}) }, `${f.label} (${f.model || '—'})`)));
      const temp = h('input', { type: 'number', step: '0.1', min: '0', max: '2', value: binding.temperature, oninput: (e) => (binding.temperature = parseFloat(e.target.value)) });
      const maxT = h('input', { type: 'number', step: '1', min: '1', value: binding.maxTokens, oninput: (e) => (binding.maxTokens = parseInt(e.target.value, 10)) });
      return h('div', { class: 'role-row' }, h('div', { class: 'role-name' }, ROLE_LABELS[role]), sel, h('div', { class: 'mini' }, h('span', { class: 'sub' }, 'temp'), temp), h('div', { class: 'mini' }, h('span', { class: 'sub' }, 'max tok'), maxT));
    });
    const roleCard = h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Model & parameters per role'), ...roleRows);
    dynHost.replaceChildren(favCard, roleCard);
  }
  paint();

  const promptCard = h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Prompts'),
    h('div', { class: 'sub', style: 'margin-bottom:8px' }, 'Edit the instructions for each AI role.'),
    ...prompts.map((p) => h('div', { class: 'prompt-row', onclick: () => (location.hash = '/settings/prompts/' + encodeURIComponent(p.name)) },
      h('span', {}, p.label), h('span', { class: 'sub' }, p.overridden ? 'customised ›' : 'default ›'))),
    h('div', { class: 'prompt-row', onclick: () => (location.hash = '/settings/seeds') },
      h('span', {}, 'Story-beginning randomizer — seed phrases'), h('span', { class: 'sub' }, seedNote)),
    h('div', { class: 'prompt-row', onclick: () => (location.hash = '/settings/style') },
      h('span', {}, 'Storyteller style — verbosity & tone'), h('span', { class: 'sub' }, '›')));

  // Throughput tuning — matters most on slow/free models (see agent bar).
  const concInput = h('input', { type: 'number', step: '1', min: '1', max: '16', value: perf.jobConcurrency, oninput: (e) => (perf.jobConcurrency = parseInt(e.target.value, 10)) });
  const toInput = h('input', { type: 'number', step: '5', min: '10', max: '600', value: Math.round(perf.requestTimeoutMs / 1000), oninput: (e) => (perf.requestTimeoutMs = Math.round(parseFloat(e.target.value) * 1000)) });
  const perfCard = h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Performance'),
    h('div', { class: 'sub', style: 'margin-bottom:8px' }, 'Background scribe jobs that run at once, and how long to wait for a model reply. Raise the timeout for slow/free models; lower concurrency if you hit rate limits.'),
    h('div', { class: 'role-row' }, h('div', { class: 'role-name' }, 'Concurrent background jobs'), concInput),
    h('div', { class: 'role-row' }, h('div', { class: 'role-name' }, 'Request timeout (seconds)'), toInput));

  const status = h('span', { class: 'sub' });
  const saveBtn = h('button', { class: 'primary' }, 'Save settings');
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true; status.className = 'sub'; status.textContent = 'saving…';
    const providers = {};
    for (const kind of Object.keys(provInputs)) {
      const { baseUrl, apiKey } = provInputs[kind];
      providers[kind] = { baseUrl: baseUrl.value, ...(apiKey.value ? { apiKey: apiKey.value } : {}) };
    }
    try { await api.put('/api/settings/config', { providers, favourites: favs, roles, performance: perf }); status.className = 'sub ok'; status.textContent = '✓ saved'; }
    catch (e) { status.className = 'sub err'; status.textContent = '✗ ' + e.message; }
    saveBtn.disabled = false;
  });

  app.replaceChildren(
    topbar(h('button', { class: 'ghost small', onclick: () => (location.hash = '/') }, '← Home')),
    h('div', { class: 'scroll' }, h('div', { class: 'container' },
      h('h2', {}, 'Settings'),
      providerCard('anthropic'), providerCard('openai_compat'),
      dynHost, perfCard, promptCard,
      h('div', { class: 'row', style: 'margin-top:16px; gap:12px' }, saveBtn, status),
    )),
  );
}

async function renderPromptEditor(name) {
  app.replaceChildren(topbar(), h('div', { class: 'scroll' }, h('div', { class: 'container' }, h('div', { class: 'empty' }, 'Loading…'))));
  let data;
  try { data = await api.get('/api/settings/prompts/' + encodeURIComponent(name)); }
  catch { location.hash = '/settings'; return; }
  const ta = h('textarea', { rows: '24', style: 'font-family:ui-monospace,monospace; font-size:13px' }, data.content);

  // Feature 7: a readable preview of the template (markdown-lite, placeholders
  // highlighted) so prompts can be reviewed without parsing the source.
  const preview = h('div', { class: 'prompt-preview prose gone' });
  function renderPreview() {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let html = esc(ta.value);
    html = html
      .replace(/^###\s+(.+)$/gm, '<h5>$1</h5>')
      .replace(/^##\s+(.+)$/gm, '<h4>$1</h4>')
      .replace(/^#\s+(.+)$/gm, '<h3>$1</h3>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/^-\s+/gm, '• ')
      .replace(/\{\{(\w+)\}\}/g, '<span class="var">$1</span>');
    preview.innerHTML = html;
  }
  const previewBtn = h('button', { class: 'ghost' }, 'Preview');
  previewBtn.addEventListener('click', () => {
    const showing = !preview.classList.contains('gone');
    if (showing) { preview.classList.add('gone'); ta.classList.remove('gone'); previewBtn.textContent = 'Preview'; }
    else { renderPreview(); preview.classList.remove('gone'); ta.classList.add('gone'); previewBtn.textContent = 'Edit'; }
  });

  const status = h('span', { class: 'sub' });
  const saveBtn = h('button', { class: 'primary' }, 'Save prompt');
  saveBtn.addEventListener('click', async () => {
    status.textContent = 'saving…';
    try { await api.put('/api/settings/prompts/' + encodeURIComponent(name), { content: ta.value }); status.className = 'sub ok'; status.textContent = '✓ saved'; }
    catch (e) { status.className = 'sub err'; status.textContent = '✗ ' + e.message; }
  });
  const resetBtn = h('button', { class: 'ghost' }, 'Reset to default');
  resetBtn.addEventListener('click', async () => {
    if (!confirm('Reset this prompt to the built-in default?')) return;
    await api.del('/api/settings/prompts/' + encodeURIComponent(name));
    ta.value = data.default; status.className = 'sub'; status.textContent = 'reset to default';
  });

  app.replaceChildren(
    topbar(h('button', { class: 'ghost small', onclick: () => (location.hash = '/settings') }, '← Settings')),
    h('div', { class: 'scroll' }, h('div', { class: 'container' },
      h('h2', {}, 'Prompt: ' + name),
      h('div', { class: 'sub', style: 'margin-bottom:8px' }, 'Placeholders like {{genre}} are filled by the engine — leave them intact.'),
      ta, preview,
      h('div', { class: 'row', style: 'margin-top:12px; gap:12px' }, saveBtn, resetBtn, previewBtn, status),
    )),
  );
}

// Story-beginning randomizer: edit the seed phrases the engine rolls from to
// build a random premise. One phrase per line. Lives in settings so it's
// editable in-app (the shipped file is awkward to reach on Termux).
async function renderSeedsEditor() {
  app.replaceChildren(topbar(), h('div', { class: 'scroll' }, h('div', { class: 'container' }, h('div', { class: 'empty' }, 'Loading…'))));
  let data;
  try { data = await api.get('/api/settings/seeds'); }
  catch { location.hash = '/settings'; return; }
  const ta = h('textarea', { rows: '24', style: 'font-family:ui-monospace,monospace; font-size:13px' }, data.content);

  const status = h('span', { class: 'sub' });
  const countOf = (v) => v.split('\n').map((l) => l.trim()).filter(Boolean).length;
  const setCount = () => { status.className = 'sub'; status.textContent = `${countOf(ta.value)} phrases`; };
  ta.addEventListener('input', setCount);

  const saveBtn = h('button', { class: 'primary' }, 'Save phrases');
  saveBtn.addEventListener('click', async () => {
    status.className = 'sub'; status.textContent = 'saving…';
    try { const r = await api.put('/api/settings/seeds', { content: ta.value }); status.className = 'sub ok'; status.textContent = `✓ saved (${r.count} phrases)`; }
    catch (e) { status.className = 'sub err'; status.textContent = '✗ ' + e.message; }
  });
  const resetBtn = h('button', { class: 'ghost' }, 'Reset to default');
  resetBtn.addEventListener('click', async () => {
    if (!confirm('Reset the seed phrases to the built-in default list?')) return;
    try { await api.put('/api/settings/seeds', { content: '' }); ta.value = data.default; setCount(); status.className = 'sub'; status.textContent = 'reset to default'; }
    catch (e) { status.className = 'sub err'; status.textContent = '✗ ' + e.message; }
  });

  app.replaceChildren(
    topbar(h('button', { class: 'ghost small', onclick: () => (location.hash = '/settings') }, '← Settings')),
    h('div', { class: 'scroll' }, h('div', { class: 'container' },
      h('h2', {}, 'Story-beginning randomizer'),
      h('div', { class: 'sub', style: 'margin-bottom:8px' }, 'One seed phrase per line. The engine rolls 5 at random and a model weaves them into a premise. Blank lines are ignored; leave empty and reset to use the built-in list.'),
      ta,
      h('div', { class: 'row', style: 'margin-top:12px; gap:12px' }, saveBtn, resetBtn, status),
    )),
  );
  setCount();
}

// Storyteller style: view/edit the burned-in prompt insertions behind the
// {{verbosity}} and {{tone}} variables. Verbosity has one instruction string
// per step (1–5); tone is the default narrator voice for new stories.
async function renderStyleEditor() {
  app.replaceChildren(topbar(), h('div', { class: 'scroll' }, h('div', { class: 'container' }, h('div', { class: 'empty' }, 'Loading…'))));
  let data;
  try { data = await api.get('/api/settings/style'); }
  catch { location.hash = '/settings'; return; }
  const STEPS = ['1', '2', '3', '4', '5'];
  const LABELS = { 1: 'terse', 2: 'brief', 3: 'balanced', 4: 'rich', 5: 'expansive' };

  const vInputs = {};
  const vRows = STEPS.map((s) => {
    const ta = h('textarea', { rows: '2', style: 'font-family:ui-monospace,monospace; font-size:13px' }, data.verbosity[s] || '');
    vInputs[s] = ta;
    return h('div', { class: 'opt-block' }, h('div', { class: 'sub' }, `Verbosity ${s} — ${LABELS[s]}`), ta);
  });
  const toneIn = h('input', { value: data.tone || '', placeholder: data.toneDefault });

  const status = h('span', { class: 'sub' });
  const saveBtn = h('button', { class: 'primary' }, 'Save style');
  saveBtn.addEventListener('click', async () => {
    status.className = 'sub'; status.textContent = 'saving…';
    const verbosity = Object.fromEntries(STEPS.map((s) => [s, vInputs[s].value]));
    try { await api.put('/api/settings/style', { verbosity, tone: toneIn.value }); status.className = 'sub ok'; status.textContent = '✓ saved'; }
    catch (e) { status.className = 'sub err'; status.textContent = '✗ ' + e.message; }
  });
  const resetBtn = h('button', { class: 'ghost' }, 'Reset to defaults');
  resetBtn.addEventListener('click', async () => {
    if (!confirm('Reset verbosity strings and default tone to the built-in defaults?')) return;
    try {
      await api.put('/api/settings/style', { verbosity: {}, tone: '' });
      for (const s of STEPS) vInputs[s].value = data.verbosityDefault[s];
      toneIn.value = data.toneDefault;
      status.className = 'sub'; status.textContent = 'reset to defaults';
    } catch (e) { status.className = 'sub err'; status.textContent = '✗ ' + e.message; }
  });

  app.replaceChildren(
    topbar(h('button', { class: 'ghost small', onclick: () => (location.hash = '/settings') }, '← Settings')),
    h('div', { class: 'scroll' }, h('div', { class: 'container' },
      h('h2', {}, 'Storyteller style'),
      h('div', { class: 'sub', style: 'margin-bottom:8px' }, 'Reply-length instruction per verbosity step (the slider in Story options picks which one). The storyteller prompt inserts the chosen string as {{verbosity}}.'),
      ...vRows,
      h('h3', {}, 'Default tone'),
      h('div', { class: 'sub', style: 'margin-bottom:6px' }, 'The narrator voice ({{tone}}) for new stories. Each story can override this in its Story options. Built-in default: ' + data.toneDefault),
      toneIn,
      h('div', { class: 'row', style: 'margin-top:14px; gap:12px' }, saveBtn, resetBtn, status),
    )),
  );
}

route();
