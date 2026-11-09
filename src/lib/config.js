// Central defaults + settings access for the extension.
//
// Everything here is just defaults — the live values come from
// chrome.storage.sync and are edited on the Options page.

export const DEFAULTS = {
  mode: 'studio',
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
  // Fleet Hub is opt-in. The URL/name are syncable convenience settings, while
  // the pairing secret and generated identity deliberately stay in local
  // storage so another browser profile cannot silently become this agent.
  fleetAgentEnabled: false,
  fleetHubUrl: '',
  fleetAgentName: '',
  fleetTelemetryDetails: false,
  fleetQueueControlEnabled: false,
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
const STUDIO_URL_KEY = 'studioBaseUrl';
const STUDIO_USERNAME_KEY = 'studioUsername';
const STUDIO_PASSWORD_KEY = 'studioPassword';
const LEGACY_CRED_KEY = 'studioCredentials';

// Earlier releases offered direct API providers. Keep saved preferences usable
// without ever sending them through a different provider unexpectedly.
function migrateLegacySettings(settings) {
  if (!settings) return settings;
  const next = { ...settings };
  if (!['studio', 'standalone', 'gateway'].includes(next.mode)) next.mode = DEFAULTS.mode;
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
  const [stored, local, session] = await Promise.all([
    chrome.storage.sync.get(STORAGE_KEY),
    chrome.storage.local.get([STUDIO_URL_KEY, STUDIO_USERNAME_KEY, LEGACY_CRED_KEY, GATEWAY_SETTINGS_KEY]),
    chrome.storage.session.get(STUDIO_PASSWORD_KEY),
  ]);
  const saved = stored[STORAGE_KEY] || {};
  const migrated = migrateLegacySettings(saved);
  const localPatch = {};
  if (local[STUDIO_URL_KEY] == null && migrated.studioBaseUrl != null) localPatch[STUDIO_URL_KEY] = migrated.studioBaseUrl;
  if (local[STUDIO_USERNAME_KEY] == null && migrated.studioUsername != null) localPatch[STUDIO_USERNAME_KEY] = migrated.studioUsername;
  const credentials = await migrateLegacyCredentials(local, session);
  if (Object.keys(localPatch).length) await chrome.storage.local.set(localPatch);
  const next = { ...migrated };
  const gateway = { ...(local[GATEWAY_SETTINGS_KEY] || {}) };
  for (const key of GATEWAY_LOCAL_FIELDS) {
    if (!Object.hasOwn(gateway, key) && Object.hasOwn(next, key)) gateway[key] = next[key];
    delete next[key];
  }
  if (JSON.stringify(gateway) !== JSON.stringify(local[GATEWAY_SETTINGS_KEY] || {})) await chrome.storage.local.set({ [GATEWAY_SETTINGS_KEY]: gateway });
  delete next.studioBaseUrl;
  delete next.studioUsername;
  if (JSON.stringify(saved) !== JSON.stringify(next)) {
    await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  }
  return { ...DEFAULTS, ...next, ...gateway, studioBaseUrl: local[STUDIO_URL_KEY] ?? localPatch[STUDIO_URL_KEY] ?? DEFAULTS.studioBaseUrl, studioUsername: credentials.username || localPatch[STUDIO_USERNAME_KEY] || DEFAULTS.studioUsername };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const { studioBaseUrl, studioUsername, ...syncPatch } = patch;
  const next = { ...current, ...syncPatch, ...(studioBaseUrl === undefined ? {} : { studioBaseUrl }), ...(studioUsername === undefined ? {} : { studioUsername }) };
  const { studioBaseUrl: _url, studioUsername: _username, ...syncNext } = next;
  const gateway = {};
  for (const key of GATEWAY_LOCAL_FIELDS) { gateway[key] = next[key]; delete syncNext[key]; }
  await chrome.storage.local.set({ [GATEWAY_SETTINGS_KEY]: gateway });
  await chrome.storage.sync.set({ [STORAGE_KEY]: syncNext });
  const localPatch = {};
  if (studioBaseUrl !== undefined) localPatch[STUDIO_URL_KEY] = String(studioBaseUrl || '');
  if (studioUsername !== undefined) localPatch[STUDIO_USERNAME_KEY] = String(studioUsername || '');
  if (Object.keys(localPatch).length) await chrome.storage.local.set(localPatch);
  return next;
}

// Story Studio username stays local; its password stays session-only.
const FLEET_SECRET_KEY = 'fleetPairingSecret';

export async function getCredentials() {
  const [local, session] = await Promise.all([chrome.storage.local.get([STUDIO_USERNAME_KEY, LEGACY_CRED_KEY]), chrome.storage.session.get(STUDIO_PASSWORD_KEY)]);
  return migrateLegacyCredentials(local, session);
}

async function migrateLegacyCredentials(local, session) {
  const legacy = local[LEGACY_CRED_KEY] || {};
  const username = String(local[STUDIO_USERNAME_KEY] ?? legacy.username ?? '');
  const password = String(session[STUDIO_PASSWORD_KEY] ?? legacy.password ?? '');
  if (username && local[STUDIO_USERNAME_KEY] !== username) await chrome.storage.local.set({ [STUDIO_USERNAME_KEY]: username });
  if (password && session[STUDIO_PASSWORD_KEY] !== password) await chrome.storage.session.set({ [STUDIO_PASSWORD_KEY]: password });
  if (local[LEGACY_CRED_KEY]) await chrome.storage.local.remove(LEGACY_CRED_KEY);
  return { username, password };
}

export async function saveCredentials({ username, password }) {
  await chrome.storage.local.set({ [STUDIO_USERNAME_KEY]: String(username || '') });
  await chrome.storage.session.set({ [STUDIO_PASSWORD_KEY]: String(password || '') });
  await chrome.storage.local.remove(LEGACY_CRED_KEY);
}

export function isLocalStudioUrl(url) {
  try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(String(url || '')).hostname.replace(/^\[|\]$/g, '')); } catch { return false; }
}

export function requiresStudioPassword(item, settings, password) {
  return !!(item?.slug && item.target !== 'download' && !isLocalStudioUrl(settings?.studioBaseUrl) && !String(password || ''));
}

// Fleet pairing material is intentionally local-only. It is never included in
// sync settings, telemetry, or a command payload.
export async function getFleetPairingSecret() {
  const stored = await chrome.storage.local.get(FLEET_SECRET_KEY);
  return typeof stored[FLEET_SECRET_KEY] === 'string' ? stored[FLEET_SECRET_KEY] : '';
}

export async function saveFleetPairingSecret(secret) {
  await chrome.storage.local.set({ [FLEET_SECRET_KEY]: String(secret || '') });
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
