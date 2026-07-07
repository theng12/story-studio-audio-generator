// Central defaults + settings access for the extension.
//
// Two run modes, chosen on the Options page at install time:
//   - "companion": read scripts straight from a running Story Studio KH
//                  server (desktop API on :8000, or server-mode on :8766).
//   - "paste":     the user pastes/【selects】 the script text manually; no
//                  dependency on Story Studio running.
//
// Everything here is just defaults — the live values come from
// chrome.storage.sync and are edited on the Options page.

export const DEFAULTS = {
  mode: 'paste', // "companion" | "paste" — user picks on first run
  // UI color theme: 'light' | 'dark' | 'system' (follow the OS setting).
  theme: 'system',
  // Story Studio server. Default port 8766, but fully editable — set this to a
  // localhost URL (any port; loopback bypasses auth) or a remote/Tailscale URL
  // like http://mac-mini.tailXXXX.ts.net:8766 (needs Grant access + login).
  studioBaseUrl: 'http://localhost:8766',
  // Server mode requires a login -> session cookie. Desktop mode does not.
  studioUsername: '',
  // NOTE: we never store the password; the user logs in through the popup
  // and the session cookie is held by the browser for studioBaseUrl.
  // Where downloaded audio lands, relative to the browser's Downloads dir.
  // Tokens: {project} {episodeCode} {episodeTitle} are filled per job.
  downloadSubdir: 'StoryStudioAudio/{project}/{episodeCode}',
  // Filename template (extension appended automatically).
  // Tokens: {episodeCode} {chapterNum} {chapterLabel} {project}
  filenameTemplate: '{episodeCode} - {chapterNum} {chapterLabel}',
  // Active TTS provider: 'fish' | 'elevenlabs' | 'openai'.
  provider: 'fish',
  // Remembered voice per provider (so switching providers keeps each choice).
  voiceByProvider: {}, // { fish: '<id>', elevenlabs: '<id>', openai: 'alloy' }
  // Default fish.audio voice id/name (legacy; mirrored into voiceByProvider).
  fishVoice: '',
  // Where generated audio goes:
  //   "project"  — POST back to Story Studio so it lands in the episode's
  //                real audio folder ({CODE}_Chapter_NN.mp3) and rebuilds
  //                audio_chapters.json. Companion mode only.
  //   "download" — save into the browser Downloads folder (works always).
  saveTarget: 'project',
  // Auto-tag the script with Fish's emotion/pause tags before generating
  // (POST /enhance/text). Off by default.
  autoTag: false,
  // Regeneration toggles (companion mode), borrowed from the sibling Flow ext:
  //   showDoneEpisodes — also list episodes whose audio is already complete.
  //   includeExisting  — also list chapters/intro that already have audio,
  //                      so you can re-voice them (edited script, new voice…).
  showDoneEpisodes: false,
  includeExisting: false,
  // Last-used selections, restored when the popup reopens.
  lastProject: '',
  lastEpisode: '',
  // Human pacing — a randomised gap between generations so a web session
  // (fish.audio / ElevenLabs) is never flooded. Seconds; the panel's "Human
  // pace" presets set these two. Default ≈ the old fixed 5–12s gap.
  humanDelayMinSec: 5,
  humanDelayMaxSec: 12,
  // Auto-retry a failed generation/download this many times before giving up
  // and marking it failed (0 = off). The manual "Retry failed" button always
  // works regardless of this.
  maxRetries: 1,
};

const STORAGE_KEY = 'settings';

export async function getSettings() {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  return { ...DEFAULTS, ...(stored[STORAGE_KEY] || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  return next;
}

// Story Studio login, stored in LOCAL storage (not synced across machines).
// Only needed for a remote/tailnet server — localhost bypasses auth entirely.
const CRED_KEY = 'studioCredentials';

export async function getCredentials() {
  const stored = await chrome.storage.local.get(CRED_KEY);
  return stored[CRED_KEY] || { username: '', password: '' };
}

export async function saveCredentials({ username, password }) {
  await chrome.storage.local.set({ [CRED_KEY]: { username, password } });
}

// Provider API keys (ElevenLabs, OpenAI). LOCAL storage only — these are
// secrets and must never sync to the Google account.
const KEYS_KEY = 'providerKeys';

export async function getApiKeys() {
  const stored = await chrome.storage.local.get(KEYS_KEY);
  return stored[KEYS_KEY] || { elevenLabsKey: '', openaiKey: '' };
}

export async function saveApiKeys(patch) {
  const current = await getApiKeys();
  await chrome.storage.local.set({ [KEYS_KEY]: { ...current, ...patch } });
}
