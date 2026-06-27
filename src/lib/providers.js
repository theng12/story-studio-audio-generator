// TTS provider registry + API-key provider calls.
//
// Two kinds of provider:
//   - webSession (fish.audio): driven via a content script on its own page
//     (handled in background.js, not here).
//   - apiKey   (ElevenLabs, OpenAI): the service worker calls the official API
//     directly with a stored key — no browser tab, no captcha. Implemented here.
//
// Each provider's subscription/usage is the user's own. Keys live in LOCAL
// storage (see config.js getApiKeys).

export const PROVIDERS = {
  fish: {
    id: 'fish',
    name: 'fish.audio',
    type: 'webSession',
    origin: 'https://fish.audio/*',
    appUrl: 'https://fish.audio/text-to-speech/',
    autoTag: true, // has the /enhance/text emotion-tagging endpoint
    maxChars: 15000,
  },
  elevenlabs: {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    type: 'apiKey',
    keyField: 'elevenLabsKey',
    model: 'eleven_multilingual_v2',
    maxChars: 9000, // multilingual_v2 caps around 10k; stay safely under
  },
  openai: {
    id: 'openai',
    name: 'OpenAI TTS',
    type: 'apiKey',
    keyField: 'openaiKey',
    model: 'gpt-4o-mini-tts',
    maxChars: 4000, // OpenAI hard limit is 4096 chars/request
    fixedVoices: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'],
  },
};

// ── helpers ─────────────────────────────────────────────────────────────────
function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function concatBuffers(buffers) {
  const total = buffers.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of buffers) {
    out.set(new Uint8Array(b), off);
    off += b.byteLength;
  }
  return out.buffer;
}

// Split text into <= maxChars pieces, preferring sentence then word boundaries.
// (MP3 chunks are byte-concatenated afterward — fine for same-format playback.)
export function splitText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const out = [];
  const sentences = text.match(/[^.!?]+[.!?]+[\s]*|[^.!?]+$/g) || [text];
  let cur = '';
  for (const s of sentences) {
    if (s.length > maxChars) {
      // A single huge sentence — hard-split on words.
      if (cur) {
        out.push(cur);
        cur = '';
      }
      let rest = s;
      while (rest.length > maxChars) {
        let cut = rest.lastIndexOf(' ', maxChars);
        if (cut <= 0) cut = maxChars;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      cur = rest;
    } else if ((cur + s).length > maxChars) {
      out.push(cur);
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// ── per-provider API calls (apiKey providers only) ──────────────────────────
async function elevenGenerateChunk(text, voice, key, model) {
  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: model }),
    }
  );
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.arrayBuffer();
}

async function openaiGenerateChunk(text, voice, key, model) {
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, voice, input: text, response_format: 'mp3' }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.arrayBuffer();
}

// List the user's voices for an apiKey provider → [{ id, title }].
export async function listVoices(providerId, keys) {
  const p = PROVIDERS[providerId];
  if (p.fixedVoices) return p.fixedVoices.map((v) => ({ id: v, title: v }));
  if (p.id === 'elevenlabs') {
    const key = keys[p.keyField];
    if (!key) throw new Error('Set your ElevenLabs API key in Settings.');
    const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key } });
    if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 120)}`);
    const j = await r.json();
    return (j.voices || []).map((v) => ({ id: v.voice_id, title: v.name }));
  }
  return [];
}

// Generate audio for an apiKey provider → { base64, mime }. Chunks long text.
export async function generate(providerId, { text, voice, keys, model }) {
  const p = PROVIDERS[providerId];
  const key = keys[p.keyField];
  if (!key) throw new Error(`Set your ${p.name} API key in Settings.`);
  if (!voice) throw new Error(`Pick a ${p.name} voice.`);
  const useModel = model || p.model;
  const chunks = splitText(text, p.maxChars);
  const buffers = [];
  for (const chunk of chunks) {
    if (p.id === 'elevenlabs') buffers.push(await elevenGenerateChunk(chunk, voice, key, useModel));
    else if (p.id === 'openai') buffers.push(await openaiGenerateChunk(chunk, voice, key, useModel));
    else throw new Error(`Provider ${providerId} has no apiKey generator.`);
  }
  return { base64: bufToBase64(concatBuffers(buffers)), mime: 'audio/mpeg' };
}
