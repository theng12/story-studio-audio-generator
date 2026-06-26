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
  async function generate({ text, model, speed = 1, volume = 0, format = 'mp3', autoTag = false }) {
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
        backend: 's2-pro',
        sampler: { temperature: 1, top_p: 0.9 },
        normalize: false,
      },
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
