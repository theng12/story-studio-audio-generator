// MAIN-world script injected into elevenlabs.io.
//
// Drives the user's logged-in ElevenLabs session — NO API key. Verified live:
//   - Auth: the web app authenticates to api.us.elevenlabs.io with a Firebase
//     ID token (Authorization: Bearer …). We read it from localStorage
//     (firebase:authUser:<apiKey>:[DEFAULT] → stsTokenManager.accessToken) and
//     refresh it ourselves via Firebase's securetoken endpoint when it's near
//     expiry, so it never goes stale.
//   - TTS:  POST /v1/text-to-speech/{voice_id}  { text, model_id } → MP3 bytes.
//   - Voices: GET /v1/voices → the account's voices.
//
// Why MAIN world: this runs in the elevenlabs.io origin with the user's session,
// so the same-origin token is reachable and the API accepts the request. The
// isolated `eleven.js` bridges it to the extension (no chrome.* here).

(() => {
  const API = 'https://api.us.elevenlabs.io/v1';
  const MODEL = 'eleven_multilingual_v2';
  const MAX_CHARS = 2400; // free-tier-safe per-generation cap; long text is chunked
  const REQ = 'ELEVENEXT_REQ';
  const RES = 'ELEVENEXT_RES';

  function authData() {
    const k = Object.keys(localStorage).find((x) => /^firebase:authUser:/.test(x));
    if (!k) throw new Error('Not signed into ElevenLabs — open elevenlabs.io and log in.');
    const apiKey = k.match(/^firebase:authUser:([^:]+):/)[1];
    const m = (JSON.parse(localStorage.getItem(k) || '{}').stsTokenManager) || {};
    return { apiKey, accessToken: m.accessToken, refreshToken: m.refreshToken, exp: m.expirationTime };
  }

  async function refreshToken(apiKey, refreshTok) {
    const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshTok)}`,
    });
    if (!r.ok) throw new Error('ElevenLabs session expired — reload elevenlabs.io.');
    return (await r.json()).id_token;
  }

  async function getToken() {
    const a = authData();
    if (!a.accessToken) throw new Error('No ElevenLabs session — reload elevenlabs.io.');
    // Refresh a minute before expiry to avoid mid-request expiry.
    if (a.exp && a.exp < Date.now() + 60000) return refreshToken(a.apiKey, a.refreshToken);
    return a.accessToken;
  }

  async function authedFetch(path, opts = {}) {
    let token = await getToken();
    const call = (t) => fetch(`${API}${path}`, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${t}` } });
    let r = await call(token);
    if (r.status === 401) {
      const a = authData();
      token = await refreshToken(a.apiKey, a.refreshToken);
      r = await call(token);
    }
    return r;
  }

  function bufToBase64(buf) {
    const b = new Uint8Array(buf);
    let s = '';
    const C = 0x8000;
    for (let i = 0; i < b.length; i += C) s += String.fromCharCode.apply(null, b.subarray(i, i + C));
    return btoa(s);
  }

  // Split into <= MAX_CHARS pieces at sentence then word boundaries.
  function splitText(text, max) {
    if (text.length <= max) return [text];
    const out = [];
    const sentences = text.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) || [text];
    let cur = '';
    for (const s of sentences) {
      if (s.length > max) {
        if (cur) { out.push(cur); cur = ''; }
        let rest = s;
        while (rest.length > max) {
          let cut = rest.lastIndexOf(' ', max);
          if (cut <= 0) cut = max;
          out.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        cur = rest;
      } else if ((cur + s).length > max) {
        out.push(cur);
        cur = s;
      } else cur += s;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }

  async function listVoices() {
    const r = await authedFetch('/voices');
    if (!r.ok) throw new Error(`ElevenLabs voices ${r.status}`);
    const j = await r.json();
    return (j.voices || []).map((v) => ({ id: v.voice_id, title: v.name }));
  }

  async function generate({ text, voice, model }) {
    if (!text || !text.trim()) throw new Error('No text to speak.');
    if (!voice) throw new Error('Pick an ElevenLabs voice.');
    const buffers = [];
    for (const chunk of splitText(text, MAX_CHARS)) {
      const r = await authedFetch(`/text-to-speech/${encodeURIComponent(voice)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text: chunk, model_id: model || MODEL }),
      });
      if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 160)}`);
      buffers.push(await r.arrayBuffer());
    }
    const total = buffers.reduce((n, b) => n + b.byteLength, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const b of buffers) { merged.set(new Uint8Array(b), off); off += b.byteLength; }
    return { base64: bufToBase64(merged.buffer), mime: 'audio/mpeg' };
  }

  const handlers = { generate, listVoices };
  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.kind !== REQ) return;
    try {
      const fn = handlers[d.op];
      if (!fn) throw new Error(`Unknown op: ${d.op}`);
      const result = await fn(d.payload || {});
      window.postMessage({ kind: RES, id: d.id, ok: true, result }, '*');
    } catch (e) {
      window.postMessage({ kind: RES, id: d.id, ok: false, error: String(e.message || e) }, '*');
    }
  });
})();
