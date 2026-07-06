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
  async post(p, b) { const r = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r.json(); },
  async patch(p, b) { const r = await fetch(p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); if (!r.ok) throw new Error(r.statusText); return r.json(); },
  async put(p, b) { const r = await fetch(p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r.json(); },
  async del(p) { const r = await fetch(p, { method: 'DELETE' }); if (!r.ok) throw new Error(r.statusText); return r.json(); },
};

function route() {
  const hash = location.hash.slice(1) || '/';
  if (hash.startsWith('/play/')) return renderPlay(hash.slice('/play/'.length));
  if (hash.startsWith('/settings/prompts/')) return renderPromptEditor(decodeURIComponent(hash.slice('/settings/prompts/'.length)));
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

  const titleIn = h('input', { placeholder: 'Story title', value: 'A Night at the Rusty Flagon' });
  const seedIn = h('textarea', { rows: '4', placeholder: 'Premise / opening seed…' },
    'You are a traveler arriving at the Rusty Flagon, a dimly lit tavern on the edge of a rain-soaked frontier town. Something is not right here.');
  const genreIn = h('input', { placeholder: 'Genre', value: 'dark fantasy' });
  const createBtn = h('button', { class: 'primary' }, 'Create & play');
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
        h('div', { style: 'margin-top:14px' }, createBtn),
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
  const input = h('textarea', { rows: '1', placeholder: 'What do you do?  (/look <name>, /scene, /retry)' });
  const sendBtn = h('button', { class: 'primary' }, 'Send');
  const cancelBtn = h('button', { class: 'ghost', disabled: true }, 'Stop');
  const rewindBtn = h('button', { class: 'ghost', title: 'Delete the last response and edit your message (restores summaries & memory to before it)' }, '↶ Edit');
  const drawer = h('div', { class: 'drawer' });

  // Feature 4: per-story context mode. 'summary' feeds the storyteller the
  // summaries + planner-picked memory instead of the raw chat history.
  let ctxSummary = !!(story.settings?.context?.summaryDriven);
  const ctxBtn = h('button', { class: 'ghost small', title: 'What the storyteller reads: recent chat history, or summary + memory' }, ctxSummary ? 'Ctx: summary' : 'Ctx: history');
  ctxBtn.addEventListener('click', async () => {
    ctxSummary = !ctxSummary;
    await api.patch(`/api/stories/${storyId}`, { settings: { context: { summaryDriven: ctxSummary } } });
    ctxBtn.textContent = ctxSummary ? 'Ctx: summary' : 'Ctx: history';
  });

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
    topbar(sceneLabel, newSceneBtn, ctxBtn, debugBtn, panelBtn, h('span', { class: 'row' }, wsDot)),
    h('div', { class: 'playwrap' }, h('div', { class: 'playmain' }, sceneHeader, scrollBox, h('div', { class: 'inputbar' }, input, h('div', { class: 'btns' }, sendBtn, cancelBtn, rewindBtn))), drawer),
  );

  let activeNpcIds = new Set();
  async function refreshSceneHeader() {
    let agents = [];
    try { agents = await api.get(`/api/stories/${storyId}/agents`); } catch {}
    const active = agents.filter((a) => a.role === 'npc' && a.state === 'active' && a.npc);
    activeNpcIds = new Set(active.map((a) => a.npcObjectId));
    npcChips.replaceChildren(
      ...(active.length ? active.map((a) => h('button', { class: 'chip', onclick: () => showObjectCard(a.npcObjectId, debug ? 'storyteller' : 'player') }, a.npc)) : [h('span', { class: 'sub' }, 'no major characters yet')]),
    );
  }

  async function showObjectCard(oid, scope) {
    let view;
    try { view = await api.get(`/api/memory/objects/${oid}?scope=${scope}`); } catch { return; }
    const facts = (view?.facts) || [];
    const modal = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target.classList.contains('modal-bg')) modal.remove(); } },
      h('div', { class: 'modal' },
        h('h3', {}, view?.name || 'Unknown'),
        view?.summary ? h('div', { class: 'mem-summary' }, view.summary) : null,
        ...(facts.length ? facts.map((f) => h('div', { class: 'fact' }, h('span', { class: `lvl ${f.detailLevel}` }, f.detailLevel), h('span', { class: `tier ${f.tier || 'mid'}` }, f.tier || 'mid'), h('span', { class: 'fcat' }, f.category), h('span', {}, f.content))) : [h('div', { class: 'empty' }, 'Nothing known yet.')]),
        h('button', { class: 'ghost', onclick: () => modal.remove() }, 'Close')));
    document.body.append(modal);
  }

  const scrollDown = () => { scrollBox.scrollTop = scrollBox.scrollHeight; };
  const addBubble = (cls, text) => { const b = h('div', { class: `bubble ${cls}` }, text); transcript.append(b); scrollDown(); return b; };
  const addStatus = (t) => { transcript.append(h('div', { class: 'status-line' }, t)); scrollDown(); };

  // Load (or reload, after a rewind) the transcript from the server.
  async function redrawTranscript() {
    transcript.replaceChildren();
    try {
      const turns = await api.get(`/api/stories/${storyId}/turns`);
      if (!turns.length) transcript.append(h('div', { class: 'empty' }, 'Press Send (even empty) to open the story.'));
      for (const t of turns) { if (t.playerInput) addBubble('player', t.playerInput); if (t.narration) addBubble('narration', t.narration); }
    } catch {}
  }
  await redrawTranscript();

  // Feature 1: delete the latest exchange (halting any in-flight response) and
  // put the prompt back in the box for editing. State (summaries, memory, …)
  // is restored server-side to before the message was sent.
  let rewinding = false;
  rewindBtn.addEventListener('click', async () => {
    if (rewinding) return;
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
    if (debug) tabs.push(['summaries', 'Summaries'], ['threads', 'Threads']);
    if (!tabs.find((t) => t[0] === activeTab)) activeTab = 'memory';
    const tabRow = h('div', { class: 'tabs' }, ...tabs.map(([k, label]) =>
      h('button', { class: 'tab' + (activeTab === k ? ' active' : ''), onclick: () => { activeTab = k; renderDrawer(); } }, label)));
    const body = h('div', { class: 'drawer-body' }, h('div', { class: 'empty' }, 'Loading…'));
    drawer.replaceChildren(tabRow, body);
    if (activeTab === 'memory') await renderMemory(body);
    else if (activeTab === 'summaries') await renderSummaries(body);
    else await renderThreads(body);
  }

  async function renderMemory(body) {
    body.replaceChildren();
    const scope = debug ? 'storyteller' : 'player';
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
      for (const row of rows) body.append(memObjectCard(row, scope, () => renderMemory(body)));
    }
    // Quick add.
    body.append(h('details', { class: 'quickadd' }, h('summary', {}, '+ Add object manually'), quickAddObject(() => renderMemory(body))));
  }

  function memObjectCard(row, scope, refresh) {
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
        await api.post(`/api/stories/${storyId}/npcs/${object.id}/${isActive ? 'demote' : 'promote'}`);
        await refreshSceneHeader(); refresh();
      } }, isActive ? 'demote' : 'promote');
      head.append(btn);
    }
    const card = h('div', { class: 'mem-card' }, head, factList);
    if (object.summary) factList.append(h('div', { class: 'mem-summary' }, object.summary));

    // Feature 5: edit / delete the object itself.
    const objTools = h('div', { class: 'row item-tools' },
      h('button', { class: 'link', onclick: () => objForm.classList.toggle('hidden') }, 'edit'),
      h('button', { class: 'link danger', onclick: async () => {
        if (!confirm(`Delete "${object.name}" and all its facts?`)) return;
        await api.del(`/api/memory/objects/${object.id}`); refresh(); refreshSceneHeader();
      } }, 'delete'));
    const nameIn = h('input', { value: object.name });
    const sumIn = h('input', { value: object.summary || '', placeholder: 'Summary' });
    const objForm = h('div', { class: 'form hidden' }, nameIn, sumIn,
      h('button', { class: 'small primary', onclick: async () => {
        await api.patch(`/api/memory/objects/${object.id}`, { name: nameIn.value, summary: sumIn.value }); refresh();
      } }, 'Save'));
    factList.append(objTools, objForm);

    for (const f of facts) factList.append(factRow(f, refresh));
    factList.append(h('details', { class: 'quickadd' }, h('summary', {}, '+ fact'), quickAddFact(object.id, refresh)));
    return card;
  }

  // Feature 5: a fact row with inline edit (content/category/level/tier) and delete.
  function factRow(f, refresh) {
    const row = h('div', { class: 'fact' },
      h('span', { class: `lvl ${f.detailLevel}` }, f.detailLevel),
      h('span', { class: `tier ${f.tier || 'mid'}` }, f.tier || 'mid'),
      h('span', { class: 'fcat' }, f.category), h('span', {}, f.content),
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
      const detail = h('div', { class: 'hidden' });
      let built = false;
      body.append(h('div', { class: 'mem-card' },
        h('div', { class: 'mem-head', onclick: () => { if (!built) { detail.append(parsedPayload(l)); built = true; } detail.classList.toggle('hidden'); } },
          h('span', { class: `role-badge ${l.agentRole}` }, l.agentRole),
          h('span', { class: 'sub' }, `${l.direction} · ${l.tokensOut ?? l.tokensIn ?? 0}tk · ${l.durationMs ?? 0}ms`)),
        detail));
    }
  }

  // ---- WebSocket ----
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  let current = null, busy = false, lastInput = '';
  const setBusy = (b) => { busy = b; sendBtn.disabled = b; cancelBtn.disabled = !b; };
  ws.onopen = () => wsDot.classList.add('on');
  ws.onclose = () => wsDot.classList.remove('on');
  ws.onerror = () => wsDot.classList.remove('on');
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    switch (m.t) {
      case 'turn.accepted': current = addBubble('narration cursor', ''); break;
      case 'turn.status': addStatus(m.text); break;
      case 'turn.delta': if (!current) current = addBubble('narration cursor', ''); current.textContent += m.text; scrollDown(); break;
      case 'turn.final':
        if (current) { current.className = 'bubble narration'; current.textContent = m.narration; }
        if (m.meta && (m.meta.promptTokensEst || m.meta.outputTokensEst)) transcript.append(h('div', { class: 'tokens' }, `~${m.meta.promptTokensEst || 0} in / ${m.meta.outputTokensEst || 0} out · ${m.meta.durationMs || 0}ms`));
        current = null; setBusy(false); scrollDown(); break;
      case 'turn.rejected': if (current) current.remove(); addStatus('(cancelled)'); current = null; setBusy(false); break;
      case 'turn.error': if (current) current.remove(); addBubble('error', `Error: ${m.message}`); current = null; setBusy(false); break;
      case 'summary.updated': if (activeTab === 'summaries') renderDrawer(); break;
      case 'memory.updated': if (activeTab === 'memory') renderDrawer(); break;
      case 'scene.changed': api.get(`/api/stories/${storyId}`).then((s) => { sceneLabel.textContent = s.scene?.title || 'Scene'; }).catch(() => {}); refreshSceneHeader(); break;
      case 'story.rewound': if (m.storyId === storyId && !rewinding) { current = null; setBusy(false); redrawTranscript(); renderDrawer(); refreshSceneHeader(); } break;
      case 'thread.activity': if (activeTab === 'threads') renderDrawer(); break;
    }
  };

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

  function submitText(text, isRetry) {
    if (busy || ws.readyState !== WebSocket.OPEN) return;
    if (!isRetry && text) addBubble('player', text);
    lastInput = text;
    setBusy(true);
    ws.send(JSON.stringify({ t: 'turn.submit', storyId, input: text }));
  }

  const submit = async () => {
    const text = input.value.trim();
    input.value = ''; input.style.height = 'auto';
    if (text.startsWith('/')) { if (await handleSlash(text)) return; }
    submitText(text, false);
  };
  sendBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', () => ws.send(JSON.stringify({ t: 'turn.cancel', storyId })));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; });

  renderDrawer();
  refreshSceneHeader();
}

// ---------------- Settings ----------------
const ROLE_LABELS = { storyteller: 'Storyteller', npc: 'NPC', scribe_memory: 'Memory scribe', scribe_story: 'Story scribe', overseer: 'Rule overseer', context_planner: 'Context planner' };
const PROVIDER_LABELS = { anthropic: 'Anthropic', openai_compat: 'OpenAI-compatible (OpenRouter, etc.)' };

async function renderSettings() {
  app.replaceChildren(topbar(h('button', { class: 'ghost small', onclick: () => (location.hash = '/') }, '← Home')), h('div', { class: 'scroll' }, h('div', { class: 'container' }, h('div', { class: 'empty' }, 'Loading…'))));
  let view, prompts;
  try { view = await api.get('/api/settings/config'); prompts = await api.get('/api/settings/prompts'); }
  catch (e) { app.replaceChildren(topbar(), h('div', { class: 'container' }, h('div', { class: 'empty' }, 'Failed to load settings: ' + e.message))); return; }

  const favs = view.favourites.map((f) => ({ ...f }));
  const roles = JSON.parse(JSON.stringify(view.roles));
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
    return h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, PROVIDER_LABELS[kind]),
      h('label', {}, 'Base URL'), baseUrl, h('label', {}, 'API key'), apiKey,
      h('div', { class: 'row', style: 'margin-top:10px; gap:10px' }, testBtn, result));
  }

  const dynHost = h('div');
  function paint() {
    const favRows = favs.map((f, i) => {
      const label = h('input', { value: f.label, placeholder: 'label', oninput: (e) => (f.label = e.target.value) });
      const prov = h('select', { onchange: (e) => (f.provider = e.target.value) }, ...Object.keys(PROVIDER_LABELS).map((k) => h('option', { value: k, ...(k === f.provider ? { selected: true } : {}) }, k)));
      const model = h('input', { value: f.model, placeholder: 'model id (e.g. anthropic/claude-sonnet-4.5)', oninput: (e) => (f.model = e.target.value) });
      const rm = h('button', { class: 'link', onclick: () => { favs.splice(i, 1); paint(); } }, 'remove');
      return h('div', { class: 'fav-row' }, label, prov, model, rm);
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
      h('span', {}, p.label), h('span', { class: 'sub' }, p.overridden ? 'customised ›' : 'default ›'))));

  const status = h('span', { class: 'sub' });
  const saveBtn = h('button', { class: 'primary' }, 'Save settings');
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true; status.className = 'sub'; status.textContent = 'saving…';
    const providers = {};
    for (const kind of Object.keys(provInputs)) {
      const { baseUrl, apiKey } = provInputs[kind];
      providers[kind] = { baseUrl: baseUrl.value, ...(apiKey.value ? { apiKey: apiKey.value } : {}) };
    }
    try { await api.put('/api/settings/config', { providers, favourites: favs, roles }); status.className = 'sub ok'; status.textContent = '✓ saved'; }
    catch (e) { status.className = 'sub err'; status.textContent = '✗ ' + e.message; }
    saveBtn.disabled = false;
  });

  app.replaceChildren(
    topbar(h('button', { class: 'ghost small', onclick: () => (location.hash = '/') }, '← Home')),
    h('div', { class: 'scroll' }, h('div', { class: 'container' },
      h('h2', {}, 'Settings'),
      providerCard('anthropic'), providerCard('openai_compat'),
      dynHost, promptCard,
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
  const preview = h('div', { class: 'prompt-preview prose hidden' });
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
    const showing = !preview.classList.contains('hidden');
    if (showing) { preview.classList.add('hidden'); ta.classList.remove('hidden'); previewBtn.textContent = 'Preview'; }
    else { renderPreview(); preview.classList.remove('hidden'); ta.classList.add('hidden'); previewBtn.textContent = 'Edit'; }
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

route();
