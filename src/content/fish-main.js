// MAIN-world script injected into fish.audio.
//
// Why MAIN world: the only protected step is the per-request reCAPTCHA token,
// which is minted by the page's own `grecaptcha.enterprise` — a main-world
// object an isolated content script cannot reach. So this script owns the
// Fish API calls; the isolated `fish.js` bridges it to the extension via
// window.postMessage (this world has no chrome.* APIs).
//
// Everything here was verified live against the logged-in studio:
//   - Auth:   Authorization: Bearer <localStorage.token>
//   - Voices: GET  https://api.fish.audio/model?self=true
//   - TTS:    POST https://api.fish.audio/task  (stream:true)
//             → returns the MP3 bytes directly (application/octet-stream).
//
// The studio also passes a fresh reCAPTCHA token on every generate; we mint
// our own with the page's site key + action "tts".

(() => {
  const API = 'https://api.fish.audio';
  const REQ = 'FISHEXT_REQ';
  const RES = 'FISHEXT_RES';

  const token = () => localStorage.getItem('token') || '';

  function siteKey() {
    for (const s of document.querySelectorAll('script[src]')) {
      const m = s.src.match(/[?&]render=([\w-]+)/);
      if (m) return m[1];
    }
    return null;
  }

  function recaptcha(action) {
    const key = siteKey();
    if (!key) throw new Error('reCAPTCHA site key not found on page.');
    const g = (window.grecaptcha && window.grecaptcha.enterprise) || window.grecaptcha;
    if (!g) throw new Error('grecaptcha not loaded.');
    return new Promise((resolve, reject) => {
      g.ready(() => g.execute(key, { action }).then(resolve).catch(reject));
    });
  }

  async function listVoices() {
    const r = await fetch(`${API}/model?self=true&page_size=50`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    if (!r.ok) throw new Error(`Voice list failed (${r.status}).`);
    const j = await r.json();
    const arr = Array.isArray(j) ? j : j.items || [];
    return arr.map((v) => ({ id: v._id, title: v.title }));
  }

  // Returns { base64, mime } for the generated audio.
  async function generate({ text, model, speed = 1, volume = 0, format = 'mp3' }) {
    if (!text || !text.trim()) throw new Error('No text to speak.');
    if (!model) throw new Error('No voice (model_id) selected.');
    // The studio caps a single generation at 15k characters. Chunking +
    // stitching multiple chapters is a follow-up; for now fail loudly.
    if (text.length > 15000) {
      throw new Error(`Text is ${text.length} chars; fish.audio caps one generation at 15000. Split this chapter.`);
    }
    const rc = await recaptcha('tts');
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
        backend: 's2-pro',
        sampler: { temperature: 1, top_p: 0.9 },
        normalize: false,
      },
      recaptcha: rc,
    };
    const r = await fetch(`${API}/task`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let msg = `Generation failed (${r.status}).`;
      try {
        const j = await r.json();
        if (j?.message) msg = j.message;
      } catch {
        /* binary/empty body */
      }
      throw new Error(msg);
    }
    const buf = await r.arrayBuffer();
    if (!buf.byteLength) throw new Error('Empty audio returned.');
    return { base64: bufToBase64(buf), mime: format === 'wav' ? 'audio/wav' : 'audio/mpeg' };
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

  const handlers = { listVoices, generate };

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
      window.postMessage({ kind: RES, id, ok: false, error: String(e.message || e) }, '*');
    }
  });
})();
