// TTS provider registry and ElevenLabs web-session voice helpers.

export const PROVIDERS = {
  fish: {
    id: 'fish',
    name: 'fish.audio',
    type: 'webSession',
    msg: 'fish', // content-script message namespace
    origin: 'https://fish.audio/*',
    appUrl: 'https://fish.audio/text-to-speech/',
    autoTag: true, // has the /enhance/text emotion-tagging endpoint
    maxChars: 15000,
  },
  elevenlabs_web: {
    id: 'elevenlabs_web',
    name: 'ElevenLabs (web)',
    type: 'webSession',
    msg: 'eleven',
    origin: 'https://elevenlabs.io/*',
    appUrl: 'https://elevenlabs.io/app/speech-synthesis/text-to-speech',
    // Drives the logged-in elevenlabs.io session (Firebase Bearer token) — no
    // API key. ElevenLabs web per-generation cap is 5000 chars.
    maxChars: 5000,
  },
};

// ── ElevenLabs models ───────────────────────────────────────────────────────
// The three TTS models, each with its own control set (verified against the
// ElevenLabs docs). All three are capped at 5000 characters per request, so
// `maxChars` stays safely under that; longer text is chunked. v3 tunes
// expression with audio tags rather than the style/speed sliders, and its
// stability is a discrete Creative/Natural/Robust choice.
const EL_MAX_CHARS = 4500; // safely under the 5000-char per-request cap
export const ELEVEN_MODELS = [
  { id: 'eleven_multilingual_v2', label: 'Multilingual v2 — lifelike quality', maxChars: EL_MAX_CHARS, style: true, speed: true, stability: 'slider' },
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5 — fast & affordable', maxChars: EL_MAX_CHARS, style: true, speed: true, stability: 'slider' },
  { id: 'eleven_v3', label: 'v3 — most expressive (alpha)', maxChars: EL_MAX_CHARS, style: false, speed: false, stability: 'discrete' },
];
// v3's discrete stability presets → the numeric value the API expects.
export const ELEVEN_STABILITY_MODES = [
  { value: 0, label: 'Creative' },
  { value: 0.5, label: 'Natural' },
  { value: 1, label: 'Robust' },
];
export const elevenModel = (id) => ELEVEN_MODELS.find((m) => m.id === id) || ELEVEN_MODELS[0];

const clamp = (n, lo, hi, dflt) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
};

// Build the ElevenLabs `voice_settings` object for a model, including only the
// controls that model supports. Exported so the worker can build it for the
// web-session provider (the content script stays logic-free).
export function buildElevenVoiceSettings(s = {}, model) {
  const meta = elevenModel(model);
  let stability = clamp(s.stability, 0, 1, 0.5);
  // v3 only accepts the discrete Creative/Natural/Robust values — snap to the
  // nearest so what's generated matches the panel's choice.
  if (meta.stability === 'discrete') {
    stability = ELEVEN_STABILITY_MODES.map((m) => m.value).reduce(
      (a, b) => (Math.abs(b - stability) < Math.abs(a - stability) ? b : a),
      0.5
    );
  }
  const vs = {
    stability,
    similarity_boost: clamp(s.similarity, 0, 1, 0.75),
    use_speaker_boost: s.speakerBoost !== false,
  };
  if (meta.style) vs.style = clamp(s.style, 0, 1, 0);
  if (meta.speed) vs.speed = clamp(s.speed, 0.7, 1.2, 1);
  return vs;
}
