// PRPG Layer-1 web client — dependency-free, zero build step.
// Home (list/create stories) + Play (streamed transcript over WebSocket).
// The design nominates Svelte for later layers (see docs/07); this is the
// walking-skeleton client that runs as static files with no toolchain.

const app = document.getElementById('app');
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
};

const api = {
  async get(path) { const r = await fetch(path); if (!r.ok) throw new Error(await r.text()); return r.json(); },
  async post(path, body) { const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(await r.text()); return r.json(); },
  async del(path) { const r = await fetch(path, { method: 'DELETE' }); if (!r.ok) throw new Error(await r.text()); return r.json(); },
};

// ---- Router (hash-based, no framework) ----
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

// ---- Home ----
async function renderHome() {
  app.replaceChildren(topbar(), h('div', { class: 'scroll' }, h('div', { class: 'container' }, h('div', { class: 'empty' }, 'Loading…'))));
  let stories = [];
  try { stories = await api.get('/api/stories'); } catch (e) { /* ignore */ }

  const list = stories.length
    ? stories.map((s) =>
        h('div', { class: 'card story-card', onclick: () => (location.hash = `/play/${s.id}`) },
          h('div', { class: 'meta' },
            h('div', { class: 'title' }, s.title),
            h('div', { class: 'sub' }, `updated ${new Date(s.updatedAt).toLocaleString()}`),
          ),
          h('button', { class: 'link', onclick: async (ev) => { ev.stopPropagation(); if (confirm('Delete this story?')) { await api.del(`/api/stories/${s.id}?hard=true`); route(); } } }, 'delete'),
        ),
      )
    : [h('div', { class: 'empty' }, 'No stories yet. Create one below to begin.')];

  const titleIn = h('input', { placeholder: 'Story title', value: 'A Night at the Rusty Flagon' });
  const seedIn = h('textarea', { rows: '4', placeholder: 'Premise / opening seed the storyteller builds from…' },
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
    topbar(h('span', { class: 'badge' }, 'Layer 1')),
    h('div', { class: 'scroll' }, h('div', { class: 'container' },
      h('h2', {}, 'Your stories'),
      ...list,
      h('div', { class: 'card' },
        h('h3', { style: 'margin-top:0' }, 'New story'),
        h('label', {}, 'Title'), titleIn,
        h('label', {}, 'Genre'), genreIn,
        h('label', {}, 'Premise seed'), seedIn,
        h('div', { style: 'margin-top:14px' }, createBtn),
      ),
    )),
  );
}

// ---- Play ----
async function renderPlay(storyId) {
  let story;
  try { story = await api.get(`/api/stories/${storyId}`); }
  catch { location.hash = '/'; return; }

  const transcript = h('div', { class: 'transcript' });
  const scrollBox = h('div', { class: 'scroll' }, h('div', { class: 'container' }, transcript));
  const wsDot = h('span', { class: 'wsdot' });
  const input = h('textarea', { rows: '1', placeholder: 'What do you do?  (empty = let the story open)' });
  const sendBtn = h('button', { class: 'primary' }, 'Send');
  const cancelBtn = h('button', { class: 'ghost', disabled: 'true' }, 'Stop');

  app.replaceChildren(
    topbar(
      h('span', { class: 'badge' }, story.title),
      h('span', { class: 'row' }, wsDot),
    ),
    scrollBox,
    h('div', { class: 'inputbar' },
      input,
      h('div', { class: 'btns' }, sendBtn, cancelBtn),
    ),
  );

  const scrollDown = () => { scrollBox.scrollTop = scrollBox.scrollHeight; };
  const addBubble = (cls, text) => { const b = h('div', { class: `bubble ${cls}` }, text); transcript.append(b); scrollDown(); return b; };

  // Load history.
  try {
    const turns = await api.get(`/api/stories/${storyId}/turns`);
    if (!turns.length) transcript.append(h('div', { class: 'empty' }, 'Press Send (even empty) to open the story.'));
    for (const t of turns) {
      if (t.playerInput) addBubble('player', t.playerInput);
      if (t.narration) addBubble('narration', t.narration);
    }
  } catch { /* ignore */ }

  // WebSocket.
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${wsProto}://${location.host}/ws`);
  let current = null; // active narration bubble
  let busy = false;

  const setBusy = (b) => { busy = b; sendBtn.disabled = b; cancelBtn.disabled = !b; };

  ws.onopen = () => wsDot.classList.add('on');
  ws.onclose = () => wsDot.classList.remove('on');
  ws.onerror = () => wsDot.classList.remove('on');
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'turn.accepted') {
      current = addBubble('narration cursor', '');
    } else if (m.t === 'turn.status') {
      if (current && !current.textContent) current.textContent = '';
      // show a transient status line if nothing streamed yet
    } else if (m.t === 'turn.delta') {
      if (!current) current = addBubble('narration cursor', '');
      current.textContent += m.text; scrollDown();
    } else if (m.t === 'turn.final') {
      if (current) { current.className = 'bubble narration'; current.textContent = m.narration; }
      if (m.meta && (m.meta.promptTokensEst || m.meta.outputTokensEst)) {
        transcript.append(h('div', { class: 'tokens' }, `~${m.meta.promptTokensEst || 0} in / ${m.meta.outputTokensEst || 0} out tokens · ${m.meta.durationMs || 0}ms`));
      }
      current = null; setBusy(false); scrollDown();
    } else if (m.t === 'turn.rejected') {
      if (current) current.remove();
      addBubble('error', `(cancelled)`); current = null; setBusy(false);
    } else if (m.t === 'turn.error') {
      if (current) current.remove();
      addBubble('error', `Error: ${m.message}`); current = null; setBusy(false);
    }
  };

  const submit = () => {
    if (busy || ws.readyState !== WebSocket.OPEN) return;
    const text = input.value.trim();
    if (text) addBubble('player', text);
    input.value = ''; input.style.height = 'auto';
    setBusy(true);
    ws.send(JSON.stringify({ t: 'turn.submit', storyId, input: text }));
  };

  sendBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', () => ws.send(JSON.stringify({ t: 'turn.cancel', storyId })));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; });
}

route();
