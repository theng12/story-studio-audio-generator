// Central defaults + settings access for the extension.
//
// Everything here is just defaults — the live values come from
// chrome.storage.sync and are edited on the Options page.

export const DEFAULTS = {
  mode: 'standalone',
  // UI color theme: 'light' | 'dark' | 'system' (follow the OS setting).
  theme: 'system',
  // Active TTS provider: 'fish' | 'elevenlabs_web'.
  provider: 'fish',
  // Remembered voice per provider (so switching providers keeps each choice).
  voiceByProvider: {}, // { fish: '<id>', elevenlabs_web: '<id>' }
  // Default fish.audio voice id/name (legacy; mirrored into voiceByProvider).
  fishVoice: '',
  // Auto-tag the script with Fish's emotion/pause tags before generating
  // (POST /enhance/text). Off by default.
  autoTag: false,
  // Human pacing — a randomised gap between generations so a web session
  // (fish.audio / ElevenLabs) is never flooded. Seconds; the panel's "Human
  // pace" presets set these two. Default ≈ the old fixed 5–12s gap.
  humanDelayMinSec: 5,
  humanDelayMaxSec: 12,
  // Auto-retry a failed generation before giving up and marking it failed
  // (0 = off). The manual "Retry failed" button always works regardless.
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
  // Gateway third-mode (opt-in, off by default). Worker token and URL stay in
  // local storage — never synced, never logged. The worker ID is generated
  // once and persisted locally so re-installs keep the same identity.
  gatewayModeEnabled: false,
  gatewayBaseUrl: '',
};

export { PROVIDER_SETTING_DEFAULTS } from './providers.js';
import { PROVIDER_SETTING_DEFAULTS } from './providers.js';

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
const GATEWAY_SETTINGS_KEY = 'gatewaySettings';
const GATEWAY_LOCAL_FIELDS = ['gatewayModeEnabled', 'gatewayBaseUrl'];

// Earlier releases offered direct API providers and a removed Story Studio
// mode. Keep saved preferences usable without ever sending them through a
// different provider unexpectedly.
function migrateLegacySettings(settings) {
  if (!settings) return settings;
  const next = { ...settings };
  if (!['standalone', 'gateway'].includes(next.mode)) next.mode = DEFAULTS.mode;
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
  const [stored, local] = await Promise.all([
    chrome.storage.sync.get(STORAGE_KEY),
    chrome.storage.local.get(GATEWAY_SETTINGS_KEY),
  ]);
  const saved = stored[STORAGE_KEY] || {};
  const next = { ...migrateLegacySettings(saved) };
  const gateway = { ...(local[GATEWAY_SETTINGS_KEY] || {}) };
  for (const key of GATEWAY_LOCAL_FIELDS) {
    if (!Object.hasOwn(gateway, key) && Object.hasOwn(next, key)) gateway[key] = next[key];
    delete next[key];
  }
  if (JSON.stringify(gateway) !== JSON.stringify(local[GATEWAY_SETTINGS_KEY] || {})) await chrome.storage.local.set({ [GATEWAY_SETTINGS_KEY]: gateway });
  // Retire the removed Story Studio connection keys from synced settings.
  delete next.studioBaseUrl;
  delete next.studioUsername;
  if (JSON.stringify(saved) !== JSON.stringify(next)) {
    await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  }
  return { ...DEFAULTS, ...next, ...gateway };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  const syncNext = { ...next };
  const gateway = {};
  for (const key of GATEWAY_LOCAL_FIELDS) { gateway[key] = next[key]; delete syncNext[key]; }
  await chrome.storage.local.set({ [GATEWAY_SETTINGS_KEY]: gateway });
  await chrome.storage.sync.set({ [STORAGE_KEY]: syncNext });
  return next;
}

// Gateway worker token and ID are local-only (never synced, never logged).
const GATEWAY_TOKEN_KEY = 'gatewayWorkerToken';
const GATEWAY_WORKER_ID_KEY = 'gatewayWorkerId';

export async function getGatewayCredentials() {
  const stored = await chrome.storage.local.get([GATEWAY_TOKEN_KEY, GATEWAY_WORKER_ID_KEY]);
  return {
    token: typeof stored[GATEWAY_TOKEN_KEY] === 'string' ? stored[GATEWAY_TOKEN_KEY] : '',
    workerId: typeof stored[GATEWAY_WORKER_ID_KEY] === 'string' ? stored[GATEWAY_WORKER_ID_KEY] : '',
  };
}

export async function saveGatewayCredentials({ token, workerId }) {
  const patch = {};
  if (token !== undefined) patch[GATEWAY_TOKEN_KEY] = String(token || '');
  if (workerId !== undefined) patch[GATEWAY_WORKER_ID_KEY] = String(workerId || '');
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}
