// Android back (and the browser's Back) closes the top overlay — a dialog, or the side panel on a narrow screen —
// instead of leaving the page behind it. Each overlay that opens adds a history entry; closing it by hand takes
// that entry back out, so Back always means "close what's on top, else go back a page".

const stack = []; // { node, close } — newest last
let skipPops = 0; // popstates caused by our own history.back()

const narrow = () => window.matchMedia('(max-width: 820px)').matches;

/** Close a dialog the way it closes itself: its own close hook, else its Close/Cancel button, else remove it. */
function closeDialog(node) {
  if (typeof node.backClose === 'function') return node.backClose();
  const btn = [...node.querySelectorAll('button')].find((b) => /^(close|cancel|✕|×)$/i.test(b.textContent.trim()));
  if (btn) return btn.click();
  node.remove();
}

function opened(node, close) {
  if (stack.some((o) => o.node === node)) return;
  history.pushState({ prpgOverlay: true }, '');
  stack.push({ node, close });
}

function closed(node) {
  const i = stack.findIndex((o) => o.node === node);
  if (i < 0) return; // closed by Back: its entry is already gone
  stack.splice(i, 1);
  if (history.state?.prpgOverlay) {
    skipPops++;
    history.back();
  }
}

window.addEventListener('popstate', () => {
  if (skipPops) {
    skipPops--;
    return;
  }
  let top = stack.pop();
  while (top && !top.node.isConnected) top = stack.pop();
  if (top) top.close();
});

// A different page: the overlays of the old one are gone.
window.addEventListener('hashchange', () => {
  stack.length = 0;
});

const observer = new MutationObserver((records) => {
  for (const r of records) {
    if (r.type === 'childList') {
      for (const n of r.addedNodes) if (n.nodeType === 1 && n.classList.contains('modal-bg')) opened(n, () => closeDialog(n));
      for (const n of r.removedNodes) if (n.nodeType === 1 && n.classList.contains('modal-bg')) closed(n);
    } else if (r.type === 'attributes' && r.target.classList?.contains('drawer')) {
      const d = r.target;
      const tracked = stack.some((o) => o.node === d);
      if (d.classList.contains('open') && !tracked && narrow()) opened(d, () => d.classList.remove('open'));
      else if (!d.classList.contains('open') && tracked) closed(d);
    }
  }
});
observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
