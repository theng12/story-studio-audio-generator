// MAIN-world discovery uses the signed-in workspace. Listing is not generation authority.
(() => {
  const API = 'https://api.fish.audio';
  const REQ = 'FISHEXT_REQ';
  const RES = 'FISHEXT_RES';
  const token = () => localStorage.getItem('token') || '';
  const visible = (element) => !!element.getClientRects?.().length;

  async function inventory() {
    const headers = { Authorization: `Bearer ${token()}` };
    const r = await fetch(`${API}/model?self=true&page_size=50`, { headers });
    if (!r.ok) throw new Error(`Voice list failed (${r.status}).`);
    const j = await r.json();
    const owned = Array.isArray(j) ? j : j.items || [];
    const voices = new Map(owned.filter((v) => typeof v?._id === 'string' && v._id).map((v) => [v._id, { id: v._id, title: v.title, source: 'owned-list' }]));
    // Public voices visible in the workspace need not belong to the signed-in account.
    const visibleIds = new Set();
    for (const image of document.querySelectorAll('img[src]')) {
      if (!visible(image)) continue;
      try {
        const url = new URL(image.currentSrc || image.src);
        if (url.protocol !== 'https:' || url.hostname !== 'public-platform.r2.fish.audio') continue;
        const match = url.pathname.match(/\/coverimage\/([a-f0-9]{32})(?:\/|$)/i);
        if (match) visibleIds.add(match[1]);
      } catch { /* An image is not a voice record. */ }
    }
    for (const id of visibleIds) {
      if (voices.has(id)) continue;
      try {
        const response = await fetch(`${API}/model/${encodeURIComponent(id)}`, { headers });
        if (!response.ok) continue;
        const voice = await response.json();
        if (voice?._id === id && typeof voice.title === 'string') voices.set(id, { id, title: voice.title, source: 'visible-detail' });
      } catch { /* Preserve known voices if a public detail cannot be read. */ }
    }
    return {
      voices: [...voices.values()], voiceScope: 'owned-and-visible', voicesComplete: false,
      fishModelOptions: await collectFishModelOptions(),
      verificationRequired: true,
    };
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function fishModelControl() {
    for (const control of document.querySelectorAll('select, [role="combobox"]')) {
      if (!visible(control)) continue;
      const context = `${control.getAttribute('aria-label') || ''} ${control.labels?.[0]?.textContent || ''} ${control.parentElement?.textContent || ''}`;
      if (/model/i.test(context)) return control;
    }
    return null;
  }
  function renderedFishModels(control) {
    const options = control.tagName === 'SELECT'
      ? [...control.options]
      : [...document.querySelectorAll('[role="option"]')].filter(visible);
    return options.map((option) => ({
      id: (control.tagName === 'SELECT' ? option.value : option.getAttribute('data-model-id')) || '',
      label: (option.textContent || '').replace(/\s+/g, ' ').trim(),
      source: 'workspace-option',
    })).filter((row) => row.label);
  }
  const menuOpen = (control) => control.getAttribute('aria-expanded') === 'true' || (control.tagName !== 'SELECT' && renderedFishModels(control).length > 0);
  function key(control, value) {
    control.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
    control.dispatchEvent(new KeyboardEvent('keyup', { key: value, bubbles: true, cancelable: true }));
  }
  async function collectFishModelOptions() {
    const control = fishModelControl();
    if (!control) return { models: [], complete: false };
    const opened = control.tagName !== 'SELECT' && !menuOpen(control);
    try {
      if (opened) {
        control.focus(); control.click(); await sleep(50);
        if (!menuOpen(control)) {
          const PointerDown = window.PointerEvent || MouseEvent;
          control.dispatchEvent(new PointerDown('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerType: 'mouse' }));
          await sleep(50);
        }
        if (!menuOpen(control)) { key(control, 'Enter'); await sleep(50); }
      }
      let previous = '', stableRounds = 0;
      for (let attempt = 0; attempt < 20; attempt++) {
        const models = renderedFishModels(control);
        const signature = JSON.stringify(models);
        stableRounds = models.length && signature === previous ? stableRounds + 1 : 0;
        if (stableRounds >= 2) {
          const text = [...document.querySelectorAll('textarea[maxlength]')].find(visible);
          const maxChars = Number(text?.getAttribute('maxlength'));
          const selectedId = control.tagName === 'SELECT' ? control.value : control.getAttribute('data-model-id');
          return {
            models, complete: control.tagName === 'SELECT' && models.every((row) => row.id),
            selectedId: selectedId || '',
            ...(Number.isSafeInteger(maxChars) && maxChars > 0 ? { maxChars, limitSource: 'workspace-textarea' } : {}),
          };
        }
        previous = signature; await sleep(50);
      }
      return { models: [], complete: false };
    } finally {
      // Exposing options must not change the selected model or other workspace controls.
      if (opened && menuOpen(control)) { control.focus(); key(control, 'Escape'); await sleep(50); }
    }
  }

  async function generate() {
    // shortcut: normal verification inputs are not yet captured; restore submission only with that contract.
    throw Object.assign(new Error('Fish workspace verification is required. Generation is unavailable until its normal verification flow is supported. No request was submitted.'), { verificationRequired: true, ambiguous: false });
  }
  // Opaque identity only, never the bearer token itself.
  // Known-weak identity: no stable Fish account id is captured yet, so a non-JWT
  // token yields a digest that rotates with the token. Replace when a stable Fish
  // id is captured.
  const jwtSubject = (value) => {
    try {
      const part = String(value).split('.')[1];
      if (!part) return null;
      const claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')));
      const id = claims.user_id || claims.sub || claims.uid;
      return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,100}$/.test(id) ? id : null;
    } catch { return null; }
  };
  async function account() {
    const value = token();
    if (!value) throw new Error('Not signed into fish.audio — open fish.audio and log in.');
    const subject = jwtSubject(value);
    if (subject) return { accountId: `fish.${subject}`, signedIn: true };
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return { accountId: `fish.${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 40)}`, signedIn: true };
  }

  window.__STORY_STUDIO_BRIDGE__.createMainBridge({ requestKind: REQ, responseKind: RES, handlers: { inventory, generate, account } });
})();
