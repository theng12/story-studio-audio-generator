// Central defaults + settings access for the extension.
//
// Everything here is just defaults — the live values come from
// chrome.storage.sync and are edited on the Options page.

export const DEFAULTS = {
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
  // Active TTS provider: 'fish' | 'elevenlabs_web'.
  provider: 'fish',
  // Remembered voice per provider (so switching providers keeps each choice).
  voiceByProvider: {}, // { fish: '<id>', elevenlabs_web: '<id>' }
  // Default fish.audio voice id/name (legacy; mirrored into voiceByProvider).
  fishVoice: '',
  // Auto-tag the script with Fish's emotion/pause tags before generating
  // (POST /enhance/text). Off by default.
  autoTag: false,
  // Regeneration toggles for the Story Studio workflow:
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
  // Auto-retry a failed generation or Studio ingest before giving up
  // and marking it failed (0 = off). The manual "Retry failed" button always
  // works regardless of this.
  maxRetries: 1,
  // Per-provider generation settings (model + voice tuning). Filled in lazily
  // from PROVIDER_SETTING_DEFAULTS via getProviderSettings(); only the keys the
  // user changes are stored here. ElevenLabs is model-aware (see providers.js).
  providerSettings: {},
  // Per-provider auto-resume on a detected limit/quota error (a generation that
  // comes back with `.limit` — see providers.js / the content scripts). Default
  // OFF everywhere: a limit hit hard-pauses the queue (press Resume yourself),
  // same as today. Switch a provider on to instead wait `minutes` and resume
  // automatically — self-correcting: if it's still limited, the next attempt
  // re-arms the cooldown. This is separate from `maxRetries` (generic,
  // non-quota failures keep retrying exactly as before regardless of this).
  providerCooldowns: {
    fish: { autoResume: false, minutes: 15 },
    elevenlabs_web: { autoResume: false, minutes: 60 },
  },
};

// Defaults for the per-provider tuning controls. Both providers use logged-in
// web sessions; ElevenLabs is model-aware and Fish exposes speed.
export const PROVIDER_SETTING_DEFAULTS = {
  elevenlabs_web: { model: 'eleven_multilingual_v2', stability: 0.5, similarity: 0.75, style: 0, speed: 1, speakerBoost: true },
  fish: { speed: 1 },
};

// Merge a provider's saved settings over its defaults.
export function getProviderSettings(settings, providerId) {
  return {
    ...(PROVIDER_SETTING_DEFAULTS[providerId] || {}),
    ...((settings.providerSettings || {})[providerId] || {}),
  };
}

// A provider's cooldown/auto-resume config — { autoResume, minutes }.
export function providerCooldown(settings, providerId) {
  return (
    settings?.providerCooldowns?.[providerId] ||
    DEFAULTS.providerCooldowns[providerId] || { autoResume: false, minutes: 15 }
  );
}

const STORAGE_KEY = 'settings';

// Earlier releases offered direct API providers. Keep saved preferences usable
// without ever sending them through a different provider unexpectedly.
function migrateLegacySettings(settings) {
  if (!settings) return settings;
  const next = { ...settings };
  delete next.mode;
  delete next.saveTarget;
  delete next.downloadSubdir;
  delete next.filenameTemplate;
  if (next.provider === 'elevenlabs') next.provider = 'elevenlabs_web';
  if (next.provider === 'openai') next.provider = 'fish';
  if (next.voiceByProvider?.elevenlabs && !next.voiceByProvider.elevenlabs_web) {
    next.voiceByProvider = { ...next.voiceByProvider, elevenlabs_web: next.voiceByProvider.elevenlabs };
  }
  if (next.providerSettings?.elevenlabs && !next.providerSettings.elevenlabs_web) {
    next.providerSettings = { ...next.providerSettings, elevenlabs_web: next.providerSettings.elevenlabs };
  }
  if (next.providerCooldowns?.elevenlabs && !next.providerCooldowns.elevenlabs_web) {
    next.providerCooldowns = { ...next.providerCooldowns, elevenlabs_web: next.providerCooldowns.elevenlabs };
  }
  return next;
}

export async function getSettings() {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  const saved = stored[STORAGE_KEY] || {};
  const migrated = migrateLegacySettings(saved);
  if (JSON.stringify(saved) !== JSON.stringify(migrated)) {
    await chrome.storage.sync.set({ [STORAGE_KEY]: migrated });
  }
  return { ...DEFAULTS, ...migrated };
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
