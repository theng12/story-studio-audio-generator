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
  const MAX_CHARS = 5000; // ElevenLabs web per-generation cap; longer text is chunked
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
    const call = async (t) => {
      try {
        return await fetch(`${API}${path}`, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${t}` } });
      } catch (error) {
        throw Object.assign(error, { submitted: true });
      }
    };
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

  async function inventory() {
    const [voicesResponse, modelsPayload] = await Promise.all([
      authedFetch('/voices'),
      authedFetch('/models').then(async (r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (!voicesResponse.ok) throw new Error(`ElevenLabs voices ${voicesResponse.status}`);
    const voices = ((await voicesResponse.json()).voices || []).map((v) => ({ id: v.voice_id, title: v.name }));
    return { voices, modelsPayload };
  }

  async function generate({ text, voice, model, maxChars, voiceSettings }) {
    if (!text || !text.trim()) throw new Error('No text to speak.');
    if (!voice) throw new Error('Pick an ElevenLabs voice.');
    if (!model) throw new Error('Pick an ElevenLabs model.');
    const buffers = [];
    const limit = Math.max(1, Number(maxChars) || MAX_CHARS);
    try {
      for (const chunk of splitText(text, limit)) {
        const body = { text: chunk, model_id: model };
        if (voiceSettings) body.voice_settings = voiceSettings;
        const r = await authedFetch(`/text-to-speech/${encodeURIComponent(voice)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const bodyText = await r.text().catch(() => '');
          // ElevenLabs returns quota_exceeded as HTTP 401 (same code as a bad key),
          // so distinguish it by body text rather than status alone.
          const limit =
            r.status === 429 || /quota_exceeded|insufficient|out of credits|too many requests|rate.?limit/i.test(bodyText);
          throw Object.assign(new Error(`ElevenLabs ${r.status}: ${bodyText.slice(0, 160)}`), { limit, ambiguous: r.status === 408 || r.status >= 500 });
        }
        try {
          buffers.push(await r.arrayBuffer());
        } catch (error) {
          throw Object.assign(error, { responseBody: true });
        }
      }
      const total = buffers.reduce((n, b) => n + b.byteLength, 0);
      const merged = new Uint8Array(total);
      let off = 0;
      for (const b of buffers) { merged.set(new Uint8Array(b), off); off += b.byteLength; }
      return { base64: bufToBase64(merged.buffer), mime: 'audio/mpeg' };
    } catch (error) {
      if (buffers.length > 0 || error?.submitted || error?.responseBody || error?.ambiguous) throw Object.assign(error, { ambiguous: true });
      throw error;
    }
  }

  window.__STORY_STUDIO_BRIDGE__.createMainBridge({
    requestKind: REQ,
    responseKind: RES,
    handlers: { inventory, generate },
  });
})();
