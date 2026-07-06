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
  async del(p) { const r = await fetch(p, { method: 'DELETE' }); if (!r.ok) throw new Error(r.statusText); return r.json(); },
};

function route() {
  const hash = location.hash.slice(1) || '/';
  if (hash.startsWith('/play/')) return renderPlay(hash.slice('/play/'.length));
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
    topbar(h('span', { class: 'badge' }, 'Layers 0–3')),
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
  const drawer = h('div', { class: 'drawer' });

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
    topbar(sceneLabel, newSceneBtn, debugBtn, panelBtn, h('span', { class: 'row' }, wsDot)),
    h('div', { class: 'playwrap' }, h('div', { class: 'playmain' }, sceneHeader, scrollBox, h('div', { class: 'inputbar' }, input, h('div', { class: 'btns' }, sendBtn, cancelBtn))), drawer),
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
        ...(facts.length ? facts.map((f) => h('div', { class: 'fact' }, h('span', { class: `lvl ${f.detailLevel}` }, f.detailLevel), h('span', { class: 'fcat' }, f.category), h('span', {}, f.content))) : [h('div', { class: 'empty' }, 'Nothing known yet.')]),
        h('button', { class: 'ghost', onclick: () => modal.remove() }, 'Close')));
    document.body.append(modal);
  }

  const scrollDown = () => { scrollBox.scrollTop = scrollBox.scrollHeight; };
  const addBubble = (cls, text) => { const b = h('div', { class: `bubble ${cls}` }, text); transcript.append(b); scrollDown(); return b; };
  const addStatus = (t) => { transcript.append(h('div', { class: 'status-line' }, t)); scrollDown(); };

  // Load history.
  try {
    const turns = await api.get(`/api/stories/${storyId}/turns`);
    if (!turns.length) transcript.append(h('div', { class: 'empty' }, 'Press Send (even empty) to open the story.'));
    for (const t of turns) { if (t.playerInput) addBubble('player', t.playerInput); if (t.narration) addBubble('narration', t.narration); }
  } catch {}

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
    for (const f of facts) factList.append(h('div', { class: 'fact' },
      h('span', { class: `lvl ${f.detailLevel}` }, f.detailLevel),
      h('span', { class: 'fcat' }, f.category), h('span', {}, f.content)));
    factList.append(h('details', { class: 'quickadd' }, h('summary', {}, '+ fact'), quickAddFact(object.id, refresh)));
    return card;
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
    const btn = h('button', { class: 'small primary' }, 'Add');
    btn.addEventListener('click', async () => { if (!content.value) return; await api.post(`/api/memory/objects/${objectId}/facts`, { content: content.value, category: cat.value, detailLevel: lvl.value }); refresh(); });
    return h('div', { class: 'form' }, content, cat, lvl, btn);
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

  async function renderThreads(body) {
    body.replaceChildren();
    let logs = [];
    try { logs = await api.get(`/api/stories/${storyId}/threadlog?limit=60`); } catch {}
    if (!logs.length) { body.append(h('div', { class: 'empty' }, 'No agent activity yet.')); return; }
    for (const l of logs) {
      const pre = h('pre', { class: 'thread-payload hidden' }, JSON.stringify(l.payload, null, 2));
      body.append(h('div', { class: 'mem-card' },
        h('div', { class: 'mem-head', onclick: () => pre.classList.toggle('hidden') },
          h('span', { class: `role-badge ${l.agentRole}` }, l.agentRole),
          h('span', { class: 'sub' }, `${l.direction} · ${l.tokensOut ?? l.tokensIn ?? 0}tk · ${l.durationMs ?? 0}ms`)),
        pre));
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

route();
