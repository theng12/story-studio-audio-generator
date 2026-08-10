// MAIN-world script injected into fish.audio.
//
// Why MAIN world: `api.fish.audio` only accepts the generate/voices calls from
// the fish.audio page origin. Running here makes our fetches indistinguishable
// from Fish's own app code (same origin, same `localStorage.token`), so they're
// accepted. This script owns the Fish API calls; the isolated `fish.js` bridges
// it to the extension via window.postMessage (this world has no chrome.* APIs).
//
// Everything here was verified live against the logged-in studio:
//   - Auth:   Authorization: Bearer <localStorage.token>
//   - Voices: GET  https://api.fish.audio/model?self=true
//   - TTS:    POST https://api.fish.audio/task  (stream:true)
//             → returns the MP3 bytes directly (application/octet-stream).

(() => {
  const API = 'https://api.fish.audio';
  const REQ = 'FISHEXT_REQ';
  const RES = 'FISHEXT_RES';

  const token = () => localStorage.getItem('token') || '';

  // NOTE: Fish's web app sends a reCAPTCHA token on every generate, but the
  // /task API does NOT enforce it for an authenticated (Bearer-token) request
  // — verified live: a correct body with no recaptcha field returns the MP3
  // with status 200. So we don't mint one; the localStorage token is enough.

  // Auto-tag: Fish's "Auto Tag All" — inserts [emphasis]/[soft]/[pause]/…
  // tags so the S2 model reads more expressively. Verified live:
  //   POST /enhance/text { payload: { text } } -> { enhanced_script }
  async function enhance(text) {
    const r = await fetch(`${API}/enhance/text`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { text } }),
    });
    if (!r.ok) throw new Error(`Auto-tag failed (${r.status}).`);
    const j = await r.json();
    return j.enhanced_script || text;
  }

  async function inventory() {
    const r = await fetch(`${API}/model?self=true&page_size=50`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    if (!r.ok) throw new Error(`Voice list failed (${r.status}).`);
    const j = await r.json();
    const arr = Array.isArray(j) ? j : j.items || [];
    const voices = arr.map((v) => ({ id: v._id, title: v.title }));
    return { voices, fishModelOptions: await collectFishModelOptions() };
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function fishModelControl() {
    const visible = (element) => !!element?.getClientRects?.().length;
    for (const control of document.querySelectorAll('select, [role="combobox"]')) {
      if (!visible(control)) continue;
      const context = `${control.getAttribute('aria-label') || ''} ${control.labels?.[0]?.textContent || ''} ${control.parentElement?.textContent || ''}`;
      if (/model/i.test(context)) return control;
    }
    return null;
  }

  function renderedFishModelLabels(control) {
    if (control.tagName === 'SELECT') return [...control.options].map((option) => option.textContent || '');
    const visible = (element) => !!element?.getClientRects?.().length;
    return [...document.querySelectorAll('[role="option"]')]
      .filter(visible)
      .map((option) => option.textContent || '');
  }

  function fishModelOptionsVisible(control) {
    return renderedFishModelLabels(control).length > 0;
  }

  function fishModelComboboxOpen(control) {
    return control.getAttribute('aria-expanded') === 'true';
  }

  function dispatchFishModelPointerDown(control) {
    const PointerDown = window.PointerEvent || MouseEvent;
    control.dispatchEvent(new PointerDown('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      pointerType: 'mouse',
    }));
  }

  function dispatchFishModelKey(control, key) {
    control.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  }

  async function openFishModelCombobox(control) {
    const wasExpanded = fishModelComboboxOpen(control);
    if (!wasExpanded && control.tagName !== 'SELECT') {
      control.focus();
      control.click();
      await sleep(50);
      if (!fishModelComboboxOpen(control) || !fishModelOptionsVisible(control)) {
        dispatchFishModelPointerDown(control);
        await sleep(50);
      }
      if (!fishModelComboboxOpen(control) || !fishModelOptionsVisible(control)) {
        dispatchFishModelKey(control, 'Enter');
        await sleep(50);
      }
      if (!fishModelComboboxOpen(control) || !fishModelOptionsVisible(control)) {
        dispatchFishModelKey(control, 'ArrowDown');
      }
    }
    let previous = '';
    let stableRounds = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const labels = renderedFishModelLabels(control).filter((label) => /Fish Audio S\d/i.test(label));
      const signature = labels.join('\n');
      stableRounds = labels.length && signature === previous ? stableRounds + 1 : 0;
      if (stableRounds >= 2) return { labels, opened: !wasExpanded };
      previous = signature;
      await sleep(50);
    }
    return { labels: [], opened: !wasExpanded };
  }

  async function closeFishModelCombobox(control, opened) {
    if (!opened) return;
    if (control.tagName === 'SELECT') control.blur();
    else if (fishModelComboboxOpen(control)) {
      control.focus();
      dispatchFishModelKey(control, 'Escape');
    }
    await sleep(50);
  }

  // Opening only exposes options; it never selects one. A current combobox
  // label alone is intentionally not accepted as a complete model inventory.
  async function collectFishModelOptions() {
    const control = fishModelControl();
    if (!control) return { labels: [], complete: false };
    const { labels, opened } = await openFishModelCombobox(control);
    await closeFishModelCombobox(control, opened);
    const complete = control.tagName === 'SELECT' && labels.length > 0;
    return { labels, complete };
  }

  // Returns { base64, mime } for the generated audio.
  async function generate({ text, model, backend, speed = 1, volume = 0, format = 'mp3', autoTag = false }) {
    if (!text || !text.trim()) throw new Error('No text to speak.');
    if (!model) throw new Error('No voice (model_id) selected.');
    if (autoTag) text = await enhance(text);
    // The studio caps a single generation at 15k characters. Chunking +
    // stitching multiple chapters is a follow-up; for now fail loudly.
    if (text.length > 15000) {
      throw new Error(`Text is ${text.length} chars; fish.audio caps one generation at 15000. Split this chapter.`);
    }
    const prosody = { speed, volume, normalize_loudness: true };
    const body = {
      type: 'tts',
      stream: true,
      model,
      prosody,
      latency: 'balanced',
      parameters: {
        text,
        model_id: model,
        format,
        prosody,
        latency: 'balanced',
        backend: backend || 's2.1-pro',
        sampler: { temperature: 1, top_p: 0.9 },
        normalize: false,
      },
    };
    let r;
    try {
      r = await fetch(`${API}/task`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw Object.assign(error, { ambiguous: true });
    }
    if (!r.ok) {
      const bodyText = await r.text().catch(() => '');
      let msg = `Generation failed (${r.status}).`;
      try {
        const j = JSON.parse(bodyText);
        if (j?.message) msg = j.message;
      } catch {
        /* binary/empty/non-JSON body */
      }
      // A credit/balance/rate-limit failure — surfaced as .limit so the queue
      // can pause or auto-resume instead of burning through every remaining item.
      const limit =
        r.status === 402 ||
        r.status === 429 ||
        /insufficient|balance|credit|quota|too many requests|rate.?limit/i.test(`${msg} ${bodyText}`);
      throw Object.assign(new Error(msg), { limit, ambiguous: r.status === 408 || r.status >= 500 });
    }
    let buf;
    try {
      buf = await r.arrayBuffer();
    } catch (error) {
      throw Object.assign(error, { ambiguous: true });
    }
    if (!buf.byteLength) throw Object.assign(new Error('Empty audio returned.'), { ambiguous: true });
    try {
      return { base64: bufToBase64(buf), mime: format === 'wav' ? 'audio/wav' : 'audio/mpeg' };
    } catch (error) {
      throw Object.assign(error, { ambiguous: true });
    }
  }

  function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  const handlers = { inventory, generate };

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.kind !== REQ) return;
    const { id, op, payload } = d;
    try {
      const fn = handlers[op];
      if (!fn) throw new Error(`Unknown op: ${op}`);
      const result = await fn(payload || {});
      window.postMessage({ kind: RES, id, ok: true, result }, '*');
    } catch (e) {
      window.postMessage({ kind: RES, id, ok: false, error: String(e.message || e), limit: !!e.limit, ambiguous: !!e.ambiguous }, '*');
    }
  });
})();
