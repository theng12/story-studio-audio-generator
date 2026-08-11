import { getSettings, saveSettings, getCredentials, getProviderSettings, PROVIDER_SETTING_DEFAULTS, providerCooldown } from '../lib/config.js';
import { initTheme } from '../lib/theme.js';
import { StudioClient } from '../lib/story-studio.js';
import { sectionSlugFromFile } from '../lib/naming.js';
import { sectionEligibility } from '../lib/section-contracts.js';
import { ELEVEN_FALLBACK_MODELS, ELEVEN_STABILITY_MODES, FISH_FALLBACK_MODELS, PROVIDERS, modelMetaNeedsSync, modelsForProviderSettings, resolveElevenModel, resolveFishModel, snapshotProviderSettings, snapshotProviderJob } from '../lib/providers.js';
import { retryQueueItem } from '../lib/queue-recovery.js';

const $ = (id) => document.getElementById(id);
const status = (msg) => ($('status').textContent = msg || '');
const pad = (n) => String(n).padStart(2, '0');
const currentProvider = () => $('provider')?.value || settings.provider || 'fish';

// Build a settings patch that remembers the chosen voice for the active provider.
function rememberVoice(voice) {
  const p = currentProvider();
  const patch = { voiceByProvider: { ...(settings.voiceByProvider || {}), [p]: voice } };
  if (p === 'fish') patch.fishVoice = voice; // keep legacy key in sync
  return patch;
}

let settings;
let client; // StudioClient for the connected Story Studio workspace
let queueState = { queue: [], paused: false };
let liveStatus = null; // last persisted status (may carry a live countdown)
let ctx = {}; // { project, projectSlug, episodeCode, episodeTitle }
let episodesByProject = {}; // slug -> [episode objects with .status]
let currentSections = []; // [{ slug, kind, num, label, present }] for the section list
let studioConnectionTest = null;
const STUDIO_CONNECTION_TEST_KEY = 'studioConnectionTest';
let standaloneScripts = [];
let providerInventories = {};
let syncingElevenModel = '';

// An episode is worth showing when its script is done and (audio is missing, or
// the user asked to also see already-done episodes for re-voicing).
const isEligible = (ep) =>
  !!(ep.status && ep.status.script && (settings?.showDoneEpisodes || !ep.status.audio));

document.addEventListener('DOMContentLoaded', init);

async function init() {
  await initTheme();
  const manifest = chrome.runtime.getManifest();
  $('extensionVersion').textContent = `v${manifest.version}`;
  $('extensionVersion').title = `${manifest.name} v${manifest.version}`;
  initWhatsNew(manifest.version);
  settings = await getSettings();
  renderProviderOptions();
  renderWorkingMode();
  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('workingMode').addEventListener('change', changeWorkingMode);
  $('openStudioSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('openProviderPage').addEventListener('click', onOpenProviderPage);
  $('loadVoices').addEventListener('click', () => refreshInventory(true));
  await initInventory();

  // Provider selector. Switching keeps each provider's cached inventory visible
  // while refreshing it from an already-open signed-in tab.
  applyProviderUI();
  wireVoiceSettings();
  renderVoiceSettings();
  renderCooldownCard();
  $('provider').addEventListener('change', async () => {
    await persist({ provider: currentProvider() });
    applyProviderUI();
    renderVoiceSettings();
    renderCooldownCard();
    await initInventory();
  });

  // Auto-tag toggle.
  $('autoTag').checked = !!settings.autoTag;
  $('autoTag').addEventListener('change', () => persist({ autoTag: $('autoTag').checked }));

  // Human pace card — the gap between generations that keeps a web session from
  // being flooded.
  renderHumanPace();
  $('humanPacePreset').addEventListener('change', onPacePreset);
  $('humanPaceMin').addEventListener('change', onPaceCustom);
  $('humanPaceMax').addEventListener('change', onPaceCustom);

  // Provider cooldown card — what happens when a limit is detected.
  $('cooldownAutoResume').addEventListener('change', onCooldownToggle);
  $('cooldownPreset').addEventListener('change', onCooldownPreset);
  $('cooldownMinutes').addEventListener('change', saveCooldownCustom);

  // Queue controls: pause/resume, retry failed, clear pending. Resume also
  // overrides an active cooldown (the background clears it on manual resume).
  $('pauseQueue').addEventListener('click', () =>
    chrome.runtime.sendMessage({ type: queueState.paused || isCoolingDown() ? 'resumeQueue' : 'pauseQueue' })
  );
  $('retryFailed').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'retryFailed' }));
  $('clearQueue').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'clearQueue' }));
  // Per-item remove (pending) / retry (failed) — event-delegated.
  $('queueList').addEventListener('click', (e) => {
    const rm = e.target.closest('.qremove');
    if (rm) return void chrome.runtime.sendMessage({ type: 'removeItem', id: rm.dataset.id });
    const rt = e.target.closest('.qretry');
    if (rt) return void chrome.runtime.sendMessage({ type: 'retryFailed', id: rt.dataset.id });
  });

  // Load the current queue + paused state, then keep it live via storage events.
  const qs = await chrome.runtime.sendMessage({ type: 'getQueue' });
  queueState = { queue: qs?.queue || [], paused: !!qs?.paused };
  renderQueueUI();
  const { lastStatus } = await chrome.storage.local.get('lastStatus');
  // A cooldown can run for hours — don't let the general 30-min staleness gate
  // hide it on a cold panel reopen as long as the cooldown itself hasn't elapsed.
  const stillCooling =
    lastStatus?.countdownReason === 'cooldown' && Number(lastStatus.countdownUntil) > Date.now();
  if (lastStatus && (Date.now() - lastStatus.ts < 30 * 60 * 1000 || stillCooling)) {
    liveStatus = lastStatus;
    applyLiveStatus();
    renderQueueUI();
    renderAppliedSettings();
  }
  setInterval(() => {
    tickCountdown();
    renderActivityElapsed();
    renderConnectionStatus();
  }, 1000);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.lastStatus) {
      liveStatus = changes.lastStatus.newValue || null;
      applyLiveStatus();
      renderQueueUI();
      renderAppliedSettings();
    }
    if (changes.queuePaused) {
      queueState.paused = !!changes.queuePaused.newValue;
      renderQueueUI();
    }
    if (changes.queue) {
      const oldQ = changes.queue.oldValue || [];
      queueState.queue = changes.queue.newValue || [];
      onQueueChanged(oldQ, queueState.queue);
    }
  });

  await restoreConnectionStatus();
  $('queueSelected').addEventListener('click', onQueueSelected);
  $('queueEpisode').addEventListener('click', onQueueEpisode);
  $('queueProject').addEventListener('click', onQueueProject);
  $('reloadSections').addEventListener('click', onReloadSections);
  $('reviewStandalone').addEventListener('click', reviewStandaloneScripts);
  $('editStandalone').addEventListener('click', showStandaloneEditor);
  $('queueStandalone').addEventListener('click', onQueueStandalone);
  $('standaloneText').addEventListener('input', () => {
    if (standaloneScripts.length) showStandaloneEditor();
  });
  $('testConn').addEventListener('click', testConnection);
  $('selectAll').addEventListener('change', (e) => {
    $('sectionList')
      .querySelectorAll('input[type=checkbox]')
      .forEach((c) => {
        if (!c.disabled) c.checked = e.target.checked;
      });
    updateSelectionSummary();
  });
  // Regeneration toggles.
  $('showDoneEpisodes').checked = !!settings.showDoneEpisodes;
  $('includeExisting').checked = !!settings.includeExisting;
  updateStudioHints();
  $('showDoneEpisodes').addEventListener('change', async () => {
    await persist({ showDoneEpisodes: $('showDoneEpisodes').checked });
    updateStudioHints();
    await loadEpisodes();
  });
  $('includeExisting').addEventListener('change', async () => {
    await persist({ includeExisting: $('includeExisting').checked });
    updateStudioHints();
    renderSections(); // re-render (enables/disables already-voiced rows) — no refetch
  });
  if (!isStandaloneMode()) await initStudio();
}

function renderProviderOptions() {
  const select = $('provider');
  select.replaceChildren(
    ...Object.entries(PROVIDERS).map(([id, provider]) => new Option(provider.displayName, id))
  );
  select.value = PROVIDERS[settings.provider] ? settings.provider : Object.keys(PROVIDERS)[0];
}

function isStandaloneMode() {
  return settings?.mode === 'standalone';
}

function renderWorkingMode() {
  const standalone = isStandaloneMode();
  $('workingMode').value = standalone ? 'standalone' : 'studio';
  $('studioPane').hidden = standalone;
  $('studioBatchActions').hidden = standalone;
  $('standalonePane').hidden = !standalone;
}

async function changeWorkingMode() {
  await persist({ mode: $('workingMode').value });
  renderWorkingMode();
  if (isStandaloneMode()) {
    status('Standalone mode uses a local script and Downloads.');
    return;
  }
  await initStudio();
}

// Persist a settings patch and keep our local copy in sync.
async function persist(patch) {
  settings = await saveSettings(patch);
}

function updateStudioHints() {
  const eh = $('episodeHint');
  if (eh) eh.textContent = settings.showDoneEpisodes ? '(all episodes with a script)' : '(script done, audio missing)';
}

// Show provider-specific UI bits (auto-tag is a fish.audio-only feature).
// ms -> "2h 15m" / "15m 32s" / "32s" — cooldowns run minutes-to-hours, unlike
// the seconds-scale human-pace gap, so this needs the larger units too.
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
function applyProviderUI() {
  const p = currentProvider();
  const provider = PROVIDERS[p];
  $('autoTagLabel').hidden = !provider?.capabilities?.autoTag;
  renderInventoryStatus();
  // Web-session providers need their page open; offer a manual "open" shortcut
  // rather than the extension popping the page open when you switch providers.
  const openBtn = $('openProviderPage');
  openBtn.hidden = !provider;
  if (provider) openBtn.textContent = '↗ Open workspace';
}

function renderInventoryStatus() {
  const provider = PROVIDERS[currentProvider()];
  const source = providerInventories[currentProvider()]?.source;
  const inventoryNote = source === 'live'
    ? 'Inventory: live.'
    : source === 'discovered'
      ? 'Inventory: discovered models; completeness is unverified.'
    : source === 'fallback'
      ? 'Inventory: fallback models; live discovery is unavailable.'
      : '';
  $('providerNote').textContent = [provider?.uiNote, inventoryNote].filter(Boolean).join(' ');
}

// Open (or focus) the current provider's page — the only place the extension
// opens a provider tab in response to the user, not as a side effect.
async function onOpenProviderPage() {
  const r = await chrome.runtime.sendMessage({ type: 'openProviderPage', provider: currentProvider() });
  if (!r?.ok) status(r?.error || NORESP);
}

// ── Voice settings (per provider, model-aware for ElevenLabs) ────────────────
const currentProviderSettings = () => getProviderSettings(settings, currentProvider());
const isElevenProvider = (p) => p === 'elevenlabs_web';
const supportsModels = (p) => !!PROVIDERS[p]?.capabilities?.models;
const fmt2 = (v) => Number(v).toFixed(2);
// Snap a continuous stability to v3's nearest discrete preset (0 / 0.5 / 1).
const nearestStabilityMode = (v) =>
  [0, 0.5, 1].reduce((a, b) => (Math.abs(b - Number(v)) < Math.abs(a - Number(v)) ? b : a), 0.5);
// Speed slider range differs between Fish and ElevenLabs.
const speedRange = (p) => PROVIDERS[p]?.capabilities?.speedRange || { min: 0.7, max: 1.2 };

// Persist a change to the current provider's settings.
async function saveProviderSetting(patch) {
  const p = currentProvider();
  const next = { ...getProviderSettings(settings, p), ...patch };
  await persist({ providerSettings: { ...(settings.providerSettings || {}), [p]: next } });
}

// Populate + show/hide the voice-setting controls for the current provider and
// (for ElevenLabs) the selected model.
function renderVoiceSettings() {
  const p = currentProvider();
  const ps = currentProviderSettings();
  const eleven = isElevenProvider(p);
  const hasModels = supportsModels(p);
  let meta = null;

  // Model (discovered from each signed-in provider page).
  $('vsModelRow').hidden = !hasModels;
  if (hasModels) {
    const sel = $('vsModel');
    const models = modelsForProviderSettings(p, ps, providerInventories[p]);
    sel.replaceChildren(...models.map((m) => new Option(m.label, m.id)));
    const resolved = eleven ? resolveElevenModel(ps.model, models) : resolveFishModel(ps.model, models);
    sel.value = resolved.model.id;
    meta = resolved.model;
    if (eleven && providerInventories[p]?.authoritative && (resolved.repaired || modelMetaNeedsSync(ps.modelMeta, resolved.model))) {
      syncLiveElevenModel(resolved.model);
    }
  }

  // Stability (ElevenLabs): slider for v2/flash, discrete Creative/Natural/Robust for v3.
  $('vsStabilityRow').hidden = !eleven;
  if (eleven) {
    const discrete = meta.stability === 'discrete';
    $('vsStability').hidden = discrete;
    $('vsStabilityMode').hidden = !discrete;
    if (discrete) {
      const sm = $('vsStabilityMode');
      if (!sm.options.length)
        for (const m of ELEVEN_STABILITY_MODES) {
          const o = document.createElement('option');
          o.value = String(m.value);
          o.textContent = m.label;
          sm.appendChild(o);
        }
      sm.value = String(nearestStabilityMode(ps.stability));
      $('vsStabilityVal').textContent = ELEVEN_STABILITY_MODES.find((m) => String(m.value) === sm.value)?.label || '';
    } else {
      $('vsStability').value = ps.stability;
      $('vsStabilityVal').textContent = fmt2(ps.stability);
    }
  }

  // Similarity (ElevenLabs).
  $('vsSimilarityRow').hidden = !eleven;
  if (eleven) {
    $('vsSimilarity').value = ps.similarity;
    $('vsSimilarityVal').textContent = fmt2(ps.similarity);
  }

  // Style exaggeration (ElevenLabs v2/flash only — v3 uses audio tags).
  const showStyle = eleven && meta.style;
  $('vsStyleRow').hidden = !showStyle;
  if (showStyle) {
    $('vsStyle').value = ps.style;
    $('vsStyleVal').textContent = fmt2(ps.style);
  }

  // Speed (ElevenLabs v2/flash and Fish — not ElevenLabs v3).
  const showSpeed = p === 'fish' || (eleven && meta.speed);
  $('vsSpeedRow').hidden = !showSpeed;
  if (showSpeed) {
    const el = $('vsSpeed');
    const { min, max } = speedRange(p);
    el.min = min;
    el.max = max;
    el.step = 0.05;
    el.value = ps.speed ?? 1;
    $('vsSpeedVal').textContent = `${Number(ps.speed ?? 1).toFixed(2)}×`;
  }

  // Speaker boost is only available on models that advertise it.
  const showSpeakerBoost = eleven && meta.speakerBoost;
  $('vsSpeakerBoostRow').hidden = !showSpeakerBoost;
  if (showSpeakerBoost) $('vsSpeakerBoost').checked = ps.speakerBoost !== false;

  // Hide the whole card when a provider exposes nothing (shouldn't happen — all
  // both expose at least one control — but keeps it robust).
  const anything = hasModels || showSpeed;
  $('voiceSettings').hidden = !anything;
}

function syncLiveElevenModel(model) {
  const key = `${currentProvider()}:${currentProviderSettings().model}:${model.id}`;
  if (syncingElevenModel === key) return;
  syncingElevenModel = key;
  void saveProviderSetting({ model: model.id, modelMeta: model }).then(() => {
    syncingElevenModel = '';
    renderVoiceSettings();
  });
}

// Wire the voice-setting controls (called once from init).
function wireVoiceSettings() {
  $('vsModel').addEventListener('change', async () => {
    const p = currentProvider();
    const models = providerInventories[p]?.models || (isElevenProvider(p) ? ELEVEN_FALLBACK_MODELS : FISH_FALLBACK_MODELS);
    const model = (isElevenProvider(p) ? resolveElevenModel : resolveFishModel)($('vsModel').value, models).model;
    await saveProviderSetting({ model: model.id, modelMeta: model });
    renderVoiceSettings();
  });
  $('vsStability').addEventListener('input', () => {
    $('vsStabilityVal').textContent = fmt2($('vsStability').value);
    saveProviderSetting({ stability: Number($('vsStability').value) });
  });
  $('vsStabilityMode').addEventListener('change', () => {
    $('vsStabilityVal').textContent =
      ELEVEN_STABILITY_MODES.find((m) => String(m.value) === $('vsStabilityMode').value)?.label || '';
    saveProviderSetting({ stability: Number($('vsStabilityMode').value) });
  });
  $('vsSimilarity').addEventListener('input', () => {
    $('vsSimilarityVal').textContent = fmt2($('vsSimilarity').value);
    saveProviderSetting({ similarity: Number($('vsSimilarity').value) });
  });
  $('vsStyle').addEventListener('input', () => {
    $('vsStyleVal').textContent = fmt2($('vsStyle').value);
    saveProviderSetting({ style: Number($('vsStyle').value) });
  });
  $('vsSpeed').addEventListener('input', () => {
    $('vsSpeedVal').textContent = `${Number($('vsSpeed').value).toFixed(2)}×`;
    saveProviderSetting({ speed: Number($('vsSpeed').value) });
  });
  $('vsSpeakerBoost').addEventListener('change', () => saveProviderSetting({ speakerBoost: $('vsSpeakerBoost').checked }));
  $('vsReset').addEventListener('click', async () => {
    const def = PROVIDER_SETTING_DEFAULTS[currentProvider()];
    const p = currentProvider();
    const models = providerInventories[p]?.models || (isElevenProvider(p) ? ELEVEN_FALLBACK_MODELS : FISH_FALLBACK_MODELS);
    const model = (isElevenProvider(p) ? resolveElevenModel : resolveFishModel)(def?.model, models).model;
    if (def) await saveProviderSetting({ ...def, modelMeta: model });
    renderVoiceSettings();
  });
}

// ── Provider cooldown (auto-resume on a detected limit) ─────────────────────
// Mirrors the Human pace card but scoped to the currently-selected provider:
// what happens when a generation comes back with a detected credit/quota/
// rate-limit error. Off (default) hard-pauses the whole queue; on, it waits
// the chosen minutes and retries that provider on its own.
const COOLDOWN_PRESETS = [15, 30, 60, 240, 1440];

function cooldownMinutesLabel(minutes) {
  if (minutes % 60 === 0) return `${minutes / 60} hr`;
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function renderCooldownCard() {
  const p = currentProvider();
  $('cooldownProviderName').textContent = `· ${PROVIDERS[p]?.displayName || p}`;
  const cd = providerCooldown(settings, p);
  $('cooldownAutoResume').checked = !!cd.autoResume;
  $('cooldownOpts').hidden = !cd.autoResume;
  const isPreset = COOLDOWN_PRESETS.includes(cd.minutes);
  $('cooldownPreset').value = isPreset ? String(cd.minutes) : 'custom';
  $('cooldownCustom').hidden = !cd.autoResume || isPreset;
  $('cooldownMinutes').value = String(cd.minutes);
  renderCooldownState();
}

// Just the state chip — split out so the 1s countdown tick can refresh it
// without re-rendering (and losing focus in) the whole card.
function renderCooldownState() {
  const p = currentProvider();
  const cd = providerCooldown(settings, p);
  const el = $('cooldownState');
  if (!cd.autoResume) {
    el.textContent = 'Manual';
    el.classList.add('off');
    renderAppliedSettings();
    return;
  }
  el.classList.remove('off');
  const cooling =
    liveStatus &&
    liveStatus.countdownReason === 'cooldown' &&
    liveStatus.countdownProvider === p &&
    Number.isFinite(liveStatus.countdownUntil) &&
    liveStatus.countdownUntil > Date.now();
  el.textContent = cooling
    ? `On cooldown · ${formatDuration(liveStatus.countdownUntil - Date.now())}`
    : `Auto-resume · ${cooldownMinutesLabel(cd.minutes)}`;
  renderAppliedSettings();
}

// Compact operational summary below the header, independent of the batch card.
function renderAppliedSettings() {
  const el = $('appliedSettings');
  if (!el || !settings) return;
  const { min, max } = paceValues();
  const provider = currentProvider();
  const cooldown = providerCooldown(settings, provider);
  const cooling =
    liveStatus &&
    liveStatus.countdownReason === 'cooldown' &&
    liveStatus.countdownProvider === provider &&
    Number.isFinite(liveStatus.countdownUntil) &&
    liveStatus.countdownUntil > Date.now();
  const cooldownText = cooling
    ? `on cooldown ${formatDuration(liveStatus.countdownUntil - Date.now())}`
    : cooldown.autoResume
      ? `auto-resume ${cooldownMinutesLabel(cooldown.minutes)}`
      : 'stops on limit';
  const pace = document.createElement('span');
  pace.textContent = `⚙ Pacing ${min}–${max}s`;
  const cooldownState = document.createElement('span');
  cooldownState.textContent = `${PROVIDERS[provider]?.displayName || provider || 'Provider'} cooldown: ${cooldownText}`;
  el.replaceChildren(pace, cooldownState);
}

async function saveProviderCooldown(patch) {
  const p = currentProvider();
  const next = { ...settings.providerCooldowns, [p]: { ...providerCooldown(settings, p), ...patch } };
  await persist({ providerCooldowns: next });
}

async function onCooldownToggle() {
  await saveProviderCooldown({ autoResume: $('cooldownAutoResume').checked });
  renderCooldownCard();
}
async function onCooldownPreset() {
  const val = $('cooldownPreset').value;
  if (val === 'custom') {
    $('cooldownCustom').hidden = false;
    $('cooldownMinutes').focus();
    return;
  }
  await saveProviderCooldown({ minutes: Number(val) });
  renderCooldownCard();
}
async function saveCooldownCustom() {
  const minutes = Math.max(1, Math.min(1440, Math.round(Number($('cooldownMinutes').value) || 15)));
  await saveProviderCooldown({ minutes });
  renderCooldownCard();
}

// ── What's new (changelog) ──────────────────────────────────────────────────
// Renders CHANGELOG.md (packaged with the extension) in the modal, and shows a
// red dot on the button until the current version's notes have been opened.
function renderChangelog(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
  return md
    .split('\n')
    .map((line) => {
      if (/^#\s/.test(line)) return ''; // top-level title — modal already titled
      if (/^##\s/.test(line)) return `<h3 class="cl-ver">${inline(line.replace(/^##\s+/, ''))}</h3>`;
      if (/^\s*-\s/.test(line)) return `<div class="cl-item">• ${inline(line.replace(/^\s*-\s+/, ''))}</div>`;
      if (/^\s*$/.test(line)) return '';
      return `<p>${inline(line)}</p>`;
    })
    .join('');
}

async function openWhatsNew(version) {
  const body = $('whatsNewBody');
  if (!body.dataset.loaded) {
    try {
      const md = await (await fetch(chrome.runtime.getURL('CHANGELOG.md'))).text();
      body.innerHTML = renderChangelog(md);
      body.dataset.loaded = '1';
    } catch {
      body.textContent = "Couldn't load the changelog.";
    }
  }
  $('whatsNewModal').hidden = false;
  $('whatsNewDot').hidden = true;
  chrome.storage.local.set({ whatsNewSeen: version });
}

async function initWhatsNew(version) {
  const { whatsNewSeen } = await chrome.storage.local.get('whatsNewSeen');
  $('whatsNewDot').hidden = whatsNewSeen === version;
  $('whatsNew').onclick = () => openWhatsNew(version);
  $('whatsNewClose').onclick = () => ($('whatsNewModal').hidden = true);
  $('whatsNewModal').onclick = (e) => {
    if (e.target === $('whatsNewModal')) $('whatsNewModal').hidden = true;
  };
}

// How this provider uses its web-session quota — shown before a batch starts.
function costPhrase() {
  return PROVIDERS[currentProvider()]?.quotaCopy || 'uses your provider quota';
}

// ── Story Studio workflow ──────────────────────────────────────────────────
//
// We do NOT pre-check /auth/me. On localhost the Story Studio server bypasses
// auth for loopback requests, so no login is needed at all — and /auth/me
// (a public endpoint that always checks the cookie) would wrongly 401 and
// force a needless login prompt. Instead we just load the data; only a real
// 401 from a data call (a remote/tailnet server) shows the login form.
async function initStudio() {
  client = new StudioClient(settings.studioBaseUrl);
  try {
    await loadStudioData();
  } catch (e) {
    if (e.status !== 401) {
      const url = settings.studioBaseUrl || '';
      const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
      const hint = local ? 'is it running?' : 'is it running, did you Grant access + log in (Settings)?';
      status(`Can't reach Story Studio at ${url} — ${hint} (${e.message})`);
      return;
    }
    // A real 401 means a remote server that needs a login. Use the credentials
    // saved in Settings (localhost never reaches here — it bypasses auth).
    const cred = await getCredentials();
    if (!cred.username || !cred.password) {
      status('This server needs a login — add it in Settings (⚙).');
      return;
    }
    try {
      status('Signing in…');
      await client.login(cred.username, cred.password);
      await loadStudioData();
      status('');
    } catch {
      status('Saved login was rejected — update it in Settings (⚙).');
    }
  }
}

// Per-project episode list cache (storage). Avoids re-scanning large projects
// on every popup open. Fresh for EP_TTL; invalidated after we generate audio.
const EP_TTL = 5 * 60 * 1000;

async function fetchEpisodes(slug, force = false) {
  if (!force) {
    const { epCache = {} } = await chrome.storage.local.get('epCache');
    const hit = epCache[slug];
    if (hit && Date.now() - hit.ts < EP_TTL) return hit.episodes;
  }
  const raw = await client.listEpisodes(slug);
  const episodes = Array.isArray(raw) ? raw : raw.episodes || [];
  const { epCache = {} } = await chrome.storage.local.get('epCache');
  epCache[slug] = { ts: Date.now(), episodes };
  await chrome.storage.local.set({ epCache });
  return episodes;
}

async function invalidateEpisodes(slug) {
  const { epCache = {} } = await chrome.storage.local.get('epCache');
  delete epCache[slug];
  await chrome.storage.local.set({ epCache });
}

// Populate the project dropdown (cheap — just a manifest read) and lazily load
// episodes for the selected project only. No more scanning every project.
async function loadStudioData() {
  const projects = await client.listProjects();
  const sel = $('project');
  sel.innerHTML = '';
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.slug;
    opt.textContent = p.name || p.slug;
    sel.appendChild(opt);
  }
  if (!projects.length) {
    status('No projects found.');
    return;
  }
  if (settings.lastProject && projects.some((p) => p.slug === settings.lastProject)) {
    sel.value = settings.lastProject;
  }
  sel.onchange = () => {
    persist({ lastProject: sel.value });
    loadEpisodes();
  };
  await loadEpisodes();
}

async function loadEpisodes() {
  const slug = $('project').value;
  ctx.projectSlug = slug;
  ctx.project = $('project').selectedOptions[0]?.textContent || slug;
  status('Loading episodes…');
  episodesByProject[slug] = await fetchEpisodes(slug);
  const eps = (episodesByProject[slug] || []).filter(isEligible);
  const sel = $('episode');
  sel.innerHTML = '';
  for (const ep of eps) {
    const code = ep.episode_code || ep.code || '';
    const opt = document.createElement('option');
    opt.value = code;
    opt.dataset.title = ep.title || '';
    opt.dataset.hasIntro = ep.status?.introduction ? '1' : '';
    opt.textContent = `${code} ${ep.title || ''}`.trim();
    sel.appendChild(opt);
  }
  if (settings.lastEpisode && [...sel.options].some((o) => o.value === settings.lastEpisode)) {
    sel.value = settings.lastEpisode;
  }
  sel.onchange = () => {
    persist({ lastEpisode: sel.value });
    loadSections();
  };
  if (eps.length) {
    status('');
    fetchEpisodeAudioCounts(slug, eps); // lazily annotate each option with done/total
    await loadSections();
  } else {
    currentSections = [];
    renderSections();
    status('No episodes in this project need audio. 🎉');
  }
}

// Lazily append each episode's audio progress (`· done/total ✓`) to its dropdown
// label, so you can see which episodes are fully voiced without opening each.
// Throttled + abortable — a new project/episode reload bumps the run token.
let epCountRun = 0;
async function fetchEpisodeAudioCounts(slug, eps) {
  const run = ++epCountRun;
  const sel = $('episode');
  for (const ep of eps) {
    if (run !== epCountRun) return;
    const code = ep.episode_code || ep.code || '';
    const opt = [...sel.options].find((o) => o.value === code);
    if (!opt) continue;
    try {
      const a = await client.audioStatus(slug, code);
      const total = a.total ?? (a.present ?? 0) + (a.missing ?? (a.missing_files || []).length);
      const done = a.present ?? Math.max(0, total - (a.missing ?? (a.missing_files || []).length));
      if (total) {
        const base = `${code} ${opt.dataset.title || ''}`.trim();
        opt.textContent = `${base} · ${done}/${total}${done >= total ? ' ✓' : ''}`;
      }
    } catch {
      /* episode without an audio manifest yet — leave the plain label */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
}

// Load the episode's sections into the multi-select list. Missing-audio
// sections come from audio-status (authoritative); chapter titles + the full
// list come from chapter-list. Already-voiced sections are shown with a badge
// (selectable only in "include existing / re-voice" mode).
async function loadSections() {
  const slug = ctx.projectSlug;
  const epOpt = $('episode').selectedOptions[0];
  ctx.episodeCode = epOpt?.value || '';
  ctx.episodeTitle = epOpt?.dataset.title || '';
  const hasIntro = epOpt?.dataset.hasIntro === '1';
  status('Loading chapters…');
  try {
    const [audio, chapterRows] = await Promise.all([
      client.audioStatus(slug, ctx.episodeCode),
      client.chapterList(slug, ctx.episodeCode, ctx.episodeTitle).catch(() => ({ chapters: [] })),
    ]);

    // audio-status.missing_files is authoritative. Map every missing file back
    // to its section (a chunked chapter shows up as several _partN files that
    // all belong to one section) and never drop an unrecognised name.
    const missing = new Set();
    for (const f of audio.missing_files || []) {
      const sec = sectionSlugFromFile(f, ctx.episodeCode);
      if (sec) missing.add(sec);
    }

    const titles = {};
    const chapNums = new Set();
    for (const c of chapterRows.chapters || chapterRows || []) {
      const n = c.number ?? c.chapterNumber;
      if (n == null || c.present === false) continue;
      titles[n] = c.title || c.label;
      chapNums.add(n);
    }
    for (const s of missing) {
      const m = s.match(/^Chapter_(\d+)$/);
      if (m) chapNums.add(parseInt(m[1], 10));
    }

    const cand = [];
    const seen = new Set();
    if (missing.has('Script')) {
      cand.push({ slug: 'Script', kind: 'script', num: null, label: 'Script', supported: true, reason: '' });
      seen.add('Script');
    }
    if (hasIntro || missing.has('Introduction')) {
      cand.push({ slug: 'Introduction', kind: 'intro', num: null, label: 'Introduction' });
      seen.add('Introduction');
    }
    for (const num of [...chapNums].sort((a, b) => a - b)) {
      const slug = `Chapter_${pad(num)}`;
      cand.push({ slug, kind: 'chapter', num, label: `${pad(num)} ${titles[num] || `Chapter ${num}`}`, supported: true, reason: '' });
      seen.add(slug);
    }
    // Any missing section that isn't the intro or a Chapter_NN still gets a row
    // — a generatable oddity beats a hidden, stuck "missing" count.
    for (const s of missing) {
      if (seen.has(s)) continue;
      seen.add(s);
      const eligibility = sectionEligibility(s);
      cand.push({ slug: s, kind: eligibility.kind, num: eligibility.chapterNumber, label: s.replace(/_/g, ' '), supported: eligibility.supported, reason: eligibility.reason });
    }
    for (const s of cand) s.present = !missing.has(s.slug);
    currentSections = cand;
    renderSections();
    status('');
  } catch (e) {
    currentSections = [];
    renderSections();
    status(`Could not load chapters: ${e.message || e}`);
  }
}

// Render the section checkboxes. Missing-audio rows are pre-checked; already
// voiced rows show a ✓ badge and are only selectable when re-voice is on.
function renderSections() {
  const wrap = $('sectionList');
  wrap.innerHTML = '';
  if (!currentSections.length) {
    wrap.innerHTML = '<div class="empty">No chapters with a script found.</div>';
    updateSelectionSummary();
    return;
  }
  const includeExisting = !!settings.includeExisting;
  for (const s of currentSections) {
    const row = document.createElement('div');
    row.className = 'sec' + (s.present ? ' done' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.slug = s.slug;
    cb.checked = !s.present && s.supported !== false;
    cb.disabled = s.supported === false || (s.present && !includeExisting);
    cb.onchange = updateSelectionSummary;
    const lab = document.createElement('span');
    lab.className = 'seclabel';
    lab.textContent = s.label;
    row.append(cb, lab);
    row.title = s.reason || '';
    if (s.supported === false) {
      const reason = document.createElement('span');
      reason.className = 'muted';
      reason.textContent = s.reason;
      row.appendChild(reason);
    }
    if (s.present) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = '✓ audio';
      row.appendChild(b);
    }
    wrap.appendChild(row);
  }
  updateSelectionSummary();
}

function selectedSections() {
  const slugs = new Set(
    [...$('sectionList').querySelectorAll('input[type=checkbox]')]
      .filter((c) => c.checked && !c.disabled)
      .map((c) => c.dataset.slug)
  );
  return currentSections.filter((s) => s.supported !== false && slugs.has(s.slug));
}

function updateSelectionSummary() {
  const done = currentSections.filter((s) => s.present).length;
  $('sectionsSummary').textContent = currentSections.length
    ? `Chapters / Intro — ${done}/${currentSections.length} have audio`
    : 'Chapters / Intro';
  const n = selectedSections().length;
  const btn = $('queueSelected');
  btn.disabled = n === 0;
  btn.textContent = n ? `Queue selected (${n})` : 'Queue selected';
}

// ── Queue ───────────────────────────────────────────────────────────────────
//
// All generation goes through the worker's persistent queue (one item at a
// time, human-paced, survives the panel closing). The panel just builds items
// — identifiers only; the worker fetches each section's text when it gets to it.
function itemFromSection(s) {
  if (s.supported === false) throw new Error(s.reason);
  const { voice, providerSettings } = queueProviderSnapshot();
  return {
    kind: s.kind,
    slug: ctx.projectSlug,
    episodeCode: ctx.episodeCode,
    episodeTitle: ctx.episodeTitle,
    sectionSlug: s.slug,
    chapterNumber: s.num ?? null,
    provider: currentProvider(),
    voice,
    autoTag: $('autoTag').checked,
    providerSettings,
    label: `${ctx.episodeCode} ${s.label}`,
  };
}

function queueProviderSnapshot() {
  const provider = currentProvider();
  return snapshotProviderJob(provider, currentProviderSettings(), providerInventories[provider], $('voice').value, supportsModels(provider) ? $('vsModel').value : '');
}

const NORESP = 'no response from the background — reload the extension at chrome://extensions';
const skipNote = (r) => (r.skipped ? ` (skipped ${r.skipped} already queued)` : '');

// Queue the ticked sections (confirmed first).
async function onQueueSelected() {
  const voice = $('voice').value;
  if (!voice) return status('Pick a voice first (↻ to load).');
  const sel = selectedSections();
  if (!sel.length) return status('Tick at least one chapter.');
  const ok = await confirmDialog(
    `Queue ${sel.length} chapter${sel.length > 1 ? 's' : ''} from ${ctx.episodeCode}?`,
    `Generates with ${currentProvider()} — ${costPhrase()}.`,
    'Queue'
  );
  if (!ok) return;
  persist(rememberVoice(voice));
  const items = sel.map(itemFromSection);
  const r = await chrome.runtime.sendMessage({ type: 'enqueue', items });
  status(r?.ok ? `Queued ${r.added} from ${ctx.episodeCode}${skipNote(r)}.` : `Queue failed: ${r?.error || NORESP}`);
}

function parseStandaloneScripts(value) {
  return String(value || '')
    .split(/\r?\n\s*---\s*(?:\r?\n|$)/)
    .map((script) => script.trim())
    .filter(Boolean)
    .slice(0, 100);
}

function showStandaloneEditor() {
  $('standaloneEditor').hidden = false;
  $('standaloneReview').hidden = true;
}

function reviewStandaloneScripts() {
  const scripts = parseStandaloneScripts($('standaloneText').value);
  if (!scripts.length) return status('Add at least one script first.');
  standaloneScripts = scripts;
  $('standaloneReviewCount').textContent = `${scripts.length} script${scripts.length === 1 ? '' : 's'}`;
  $('standaloneReviewList').replaceChildren(
    ...scripts.map((script, index) => {
      const item = document.createElement('li');
      const preview = script.split(/\r?\n/).find((line) => line.trim())?.trim() || `Script ${index + 1}`;
      item.textContent = `${index + 1}. ${preview}`;
      item.title = script;
      return item;
    })
  );
  $('standaloneEditor').hidden = true;
  $('standaloneReview').hidden = false;
  status(`Review ${scripts.length} script${scripts.length === 1 ? '' : 's'} before queueing.`);
}

async function onQueueStandalone() {
  const voice = $('voice').value;
  if (!voice) return status('Pick a voice first (↻ to load).');
  if (!standaloneScripts.length) return status('Review the scripts before queueing.');
  const rawLabel = $('standaloneLabel').value.trim() || 'audio';
  const safeLabel = rawLabel.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'audio';
  const stamp = Date.now();
  const { voice: snapshotVoice, providerSettings } = queueProviderSnapshot();
  const items = standaloneScripts.map((text, index) => ({
    kind: 'paste',
    text,
    target: 'download',
    downloadPath: `StoryStudioAudio/Standalone/${stamp}_${pad(index + 1)}_${safeLabel}.mp3`,
    provider: currentProvider(),
    voice: snapshotVoice,
    autoTag: $('autoTag').checked,
    providerSettings,
    label: standaloneScripts.length > 1 ? `${rawLabel} ${index + 1}` : rawLabel,
    episodeCode: 'Standalone',
  }));
  await persist(rememberVoice(voice));
  const response = await chrome.runtime.sendMessage({ type: 'enqueue', items });
  if (!response?.ok) return status(`Queue failed: ${response?.error || NORESP}`);
  $('standaloneText').value = '';
  standaloneScripts = [];
  showStandaloneEditor();
  status(response.added ? `Queued ${response.added} standalone audio file${response.added === 1 ? '' : 's'} for Downloads${skipNote(response)}.` : 'Matching audio is already queued.');
}

// Queue every missing section of EVERY eligible episode in the project. The
// worker expands the project (it'd be too many calls to do here).
async function onQueueProject() {
  const voice = $('voice').value;
  if (!voice) return status('Pick a voice first (↻ to load).');
  if (!ctx.projectSlug) return;
  const ok = await confirmDialog(
    `Queue ALL missing audio across "${ctx.project}"?`,
    `This can be a lot of chapters — generates with ${currentProvider()}, ${costPhrase()}.`,
    'Queue all'
  );
  if (!ok) return;
  persist(rememberVoice(voice));
  const snapshot = queueProviderSnapshot();
  status(`Building a queue for all of ${ctx.project}…`);
  const r = await chrome.runtime.sendMessage({
    type: 'enqueueProject',
    payload: {
      slug: ctx.projectSlug,
      provider: currentProvider(),
      voice: snapshot.voice,
      autoTag: $('autoTag').checked,
      providerSettings: snapshot.providerSettings,
    },
  });
  status(
    r?.ok
      ? `Queued ${r.added} section(s) across ${r.episodes} episode(s)${skipNote(r)}.`
      : `Queue failed: ${r?.error || NORESP}`
  );
}

// Queue every missing section (intro + chapters) of just the CURRENT episode.
async function onQueueEpisode() {
  const voice = $('voice').value;
  if (!voice) return status('Pick a voice first (↻ to load).');
  if (!ctx.projectSlug || !ctx.episodeCode) return status('Pick an episode first.');
  const missing = currentSections.filter((s) => !s.present && s.supported !== false);
  if (!missing.length) return status('This episode already has all its audio. 🎉');
  const ok = await confirmDialog(
    `Queue all ${missing.length} missing section${missing.length > 1 ? 's' : ''} of ${ctx.episodeCode}?`,
    `Generates with ${currentProvider()} — ${costPhrase()}.`,
    'Queue'
  );
  if (!ok) return;
  persist(rememberVoice(voice));
  const items = missing.map(itemFromSection);
  const r = await chrome.runtime.sendMessage({ type: 'enqueue', items });
  status(r?.ok ? `Queued ${r.added} from ${ctx.episodeCode}${skipNote(r)}.` : `Queue failed: ${r?.error || NORESP}`);
}

// Re-pull the current project's episodes + the open episode's chapters/audio
// status from Story Studio (drops the 5-min cache) — "load script/audio".
async function onReloadSections() {
  if (!ctx.projectSlug) return status('Pick a project first.');
  await invalidateEpisodes(ctx.projectSlug);
  await loadEpisodes();
}

// ── Human pace (gap between generations) ─────────────────────────────────────
const HUMAN_PACE_PRESETS = {
  off: { min: 0, max: 0 },
  quick: { min: 2, max: 5 },
  balanced: { min: 5, max: 12 },
  cautious: { min: 15, max: 40 },
};
function paceValues() {
  const a = Math.max(0, Number(settings?.humanDelayMinSec) || 0);
  const b = Math.max(0, Number(settings?.humanDelayMaxSec) || 0);
  return { min: Math.min(a, b), max: Math.max(a, b) };
}
function pacePresetKey(min, max) {
  return Object.entries(HUMAN_PACE_PRESETS).find(([, p]) => p.min === min && p.max === max)?.[0] || 'custom';
}
function renderHumanPace() {
  const { min, max } = paceValues();
  const key = pacePresetKey(min, max);
  $('humanPacePreset').value = key;
  $('humanPaceCustom').hidden = key !== 'custom';
  $('humanPaceMin').value = String(min);
  $('humanPaceMax').value = String(max);
  const off = min === 0 && max === 0;
  const st = $('humanPaceState');
  st.textContent = off ? 'No delay' : min === max ? `${min}s` : `${min}–${max}s`;
  st.classList.toggle('off', off);
}
async function onPacePreset() {
  const key = $('humanPacePreset').value;
  if (key === 'custom') {
    $('humanPaceCustom').hidden = false;
    $('humanPaceMin').focus();
    return;
  }
  const p = HUMAN_PACE_PRESETS[key];
  if (!p) return;
  await persist({ humanDelayMinSec: p.min, humanDelayMaxSec: p.max });
  renderHumanPace();
  renderAppliedSettings();
}
async function onPaceCustom() {
  const min = Math.max(0, Math.min(3600, Math.round(Number($('humanPaceMin').value) || 0)));
  const max = Math.max(min, Math.min(3600, Math.round(Number($('humanPaceMax').value) || 0)));
  await persist({ humanDelayMinSec: min, humanDelayMaxSec: max });
  renderHumanPace();
  renderAppliedSettings();
}

// ── Queue view (status bar + controls + list) ────────────────────────────────
const Q_STATUS = { pending: 'Pending', running: 'Running', done: 'Done', failed: 'Failed' };
const isReviewRequired = (item) => !!(item?.ambiguous || item?.requiresLocalReview);

// A cooldown is "active" when the live status is currently carrying one for
// the provider it named — derived from liveStatus (pushed live via storage),
// no extra polling needed.
function isCoolingDown() {
  return !!(
    liveStatus &&
    liveStatus.countdownReason === 'cooldown' &&
    Number.isFinite(liveStatus.countdownUntil) &&
    liveStatus.countdownUntil > Date.now()
  );
}

function renderQueueUI() {
  const { queue, paused } = queueState;
  const cooling = isCoolingDown();
  updateGenStatus(queue, paused, cooling);
  renderQueueControls(queue, paused, cooling);
  renderQueueList(queue);
}

// Prominent Idle / Queued / Generating / Paused / Cooldown / Finished bar with counts.
function updateGenStatus(queue, paused, coolingDown = false) {
  const done = queue.filter((i) => i.status === 'done').length;
  const failed = queue.filter((i) => i.status === 'failed').length;
  const left = queue.filter((i) => i.status === 'pending' || i.status === 'running').length;
  const running = queue.some((i) => i.status === 'running');
  let state = 'Idle';
  let cls = 'idle';
  if (coolingDown && left > 0) {
    const name = PROVIDERS[liveStatus?.countdownProvider]?.displayName || liveStatus?.countdownProvider || 'Provider';
    state = `Cooldown · ${name}`;
    cls = 'cooldown';
  } else if (left > 0 && Number(liveStatus?.countdownUntil) > Date.now()) {
    state = 'Waiting';
    cls = 'waiting';
  } else if (paused && left > 0) {
    state = 'Paused';
    cls = 'paused';
  } else if (left > 0) {
    state = running ? 'Generating narration' : 'Queued';
    cls = running ? 'running' : 'queued';
  } else if (queue.length) {
    state = 'Finished';
    cls = 'done';
  }
  $('genStatusBar').className = 'genstatus ' + cls;
  $('gsStateText').textContent = state;
  $('gsDone').textContent = `${done} done`;
  $('gsFailed').textContent = `${failed} failed`;
  $('gsLeft').textContent = `${left} left`;
  $('gsCounts').hidden = queue.length === 0;
  updateActivityPanel(queue, { done, failed, left, running, state, cls });
}

// The compact activity panel remains useful even when the queue list is long:
// it tells the user exactly what is happening and how far the batch has moved.
function updateActivityPanel(queue, { done, failed, left, running, state, cls }) {
  const active = queue.find((i) => i.status === 'running');
  const next = queue.find((i) => i.status === 'pending');
  const current = active || next;
  const panel = $('activityPanel');
  panel.classList.toggle('is-running', running);
  panel.classList.toggle('is-waiting', cls === 'waiting' || cls === 'cooldown');
  panel.classList.toggle('is-complete', cls === 'done' && failed === 0);
  panel.classList.toggle('has-failure', cls === 'done' && failed > 0);

  $('activeJob').textContent = current
    ? active ? `Generating ${current.label}` : `Up next: ${current.label}`
    : queue.length ? (failed ? 'Queue finished with issues' : 'All audio saved') : 'Ready to generate audio';
  const speed = Number(current?.providerSettings?.speed);
  const context = [
    PROVIDERS[current?.provider]?.displayName || current?.provider || 'TTS',
    current?.voice ? `Voice ${current.voice}` : '',
    Number.isFinite(speed) && speed !== 1 ? `${speed.toFixed(2)}x` : '',
  ].filter(Boolean);
  $('activeJobMeta').textContent = current
    ? `${context.join(' · ')}${active ? ' · saving when complete' : ''}`
    : queue.length ? `${done} saved${failed ? ` · ${failed} failed` : ''}` : 'Choose sections, then queue them.';

  const total = queue.length;
  const completed = done + failed + (running ? 0.45 : 0);
  const percent = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  $('activityProgressFill').style.width = `${percent}%`;
  $('activityProgressText').textContent = `${percent}%`;
  renderActivityElapsed();
}

function renderActivityElapsed() {
  const active = queueState.queue.find((i) => i.status === 'running' && Number(i.startedAt));
  const el = $('activityElapsed');
  el.hidden = !active;
  if (!active) return;
  const seconds = Math.max(0, Math.floor((Date.now() - Number(active.startedAt)) / 1000));
  const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  el.textContent = `Elapsed ${h}:${m}:${s}`;
}

function renderQueueControls(queue, paused, coolingDown = false) {
  const active = queue.filter((i) => i.status === 'pending' || i.status === 'running').length;
  const pending = queue.filter((i) => i.status === 'pending').length;
  const retryable = queue.some((i) => PROVIDERS[i.provider] && retryQueueItem(i));
  $('queueDetail').hidden = queue.length === 0;
  $('queueInfo').textContent = `Queue (${queue.length})`;
  const pause = $('pauseQueue');
  pause.hidden = active === 0; // pause/resume only matters while there's work
  pause.textContent = paused || coolingDown ? 'Resume' : 'Pause';
  $('retryFailed').disabled = !retryable;
  $('clearQueue').disabled = pending === 0;
}

function renderQueueList(queue) {
  const ul = $('queueList');
  ul.innerHTML = '';
  ul.hidden = queue.length === 0;
  for (const [index, it] of queue.entries()) {
    const li = document.createElement('li');
    li.className = `qrow q-${it.status}`;
    const number = document.createElement('span');
    number.className = 'qindex';
    number.textContent = String(index + 1);
    const label = document.createElement('span');
    label.className = 'qlabel';
    label.textContent = it.label;
    if (it.status === 'failed' && it.error) label.title = it.error;
    const state = document.createElement('span');
    state.className = `qstate ${isReviewRequired(it) ? 'review' : it.status}`;
    state.textContent = isReviewRequired(it) ? 'Review required' : (Q_STATUS[it.status] || 'Pending');
    li.append(number, label, state);
    const actions = document.createElement('div');
    actions.className = 'qactions';
    if (it.status === 'pending') {
      const x = document.createElement('button');
      x.className = 'qremove';
      x.textContent = '✕';
      x.title = 'Remove from queue';
      x.dataset.id = it.id;
      actions.appendChild(x);
    } else if (it.status === 'failed' && PROVIDERS[it.provider] && !isReviewRequired(it)) {
      const r = document.createElement('button');
      r.className = 'qretry';
      r.textContent = '↻';
      r.title = it.error ? `Retry — ${it.error}` : 'Retry this item';
      r.dataset.id = it.id;
      actions.appendChild(r);
    }
    li.appendChild(actions);
    ul.appendChild(li);
  }
}

// ── Live status + countdown ──────────────────────────────────────────────────
// Non-countdown status text is shown as-is; a countdown is ticked each second.
function applyLiveStatus() {
  if (!liveStatus) return status('');
  if (Number.isFinite(liveStatus.countdownUntil)) tickCountdown();
  else status(liveStatus.text || '');
}
function tickCountdown() {
  if (!liveStatus || !Number.isFinite(liveStatus.countdownUntil)) return;
  // Only tick while there's actually work in flight — otherwise a countdown left
  // over from a killed worker would stick on "Starting…".
  if (!queueState.queue.some((i) => i.status === 'pending' || i.status === 'running')) return;
  const remaining = liveStatus.countdownUntil - Date.now();
  if (liveStatus.countdownReason === 'cooldown') {
    const name = PROVIDERS[liveStatus.countdownProvider]?.displayName || liveStatus.countdownProvider || 'Provider';
    status(remaining > 0 ? `⏸ ${name} limit reached — resuming in ${formatDuration(remaining)}…` : 'Resuming…');
    // The cooldown badge + Pause/Resume label depend on wall-clock time, not a
    // storage write, so keep them live each tick too (until the background
    // writes a fresh non-countdown status once the item actually resumes).
    renderQueueUI();
    renderCooldownState();
    return;
  }
  const secs = Math.max(0, Math.ceil(remaining / 1000));
  status(secs > 0 ? `Waiting ${secs}s before the next generation…` : 'Starting…');
}

// When the whole queue finishes, refresh the current episode's section list so
// the ones we just made drop off; always keep the queue UI current.
async function onQueueChanged(oldQ, newQ) {
  renderQueueUI();
  const active = newQ.some((i) => i.status === 'pending' || i.status === 'running');
  const wasActive = oldQ.some((i) => i.status === 'pending' || i.status === 'running');
  if (wasActive && !active && ctx.episodeCode) {
    await invalidateEpisodes(ctx.projectSlug);
    await loadSections();
  }
}

// ── Provider inventory (per provider) ───────────────────────────────────────
function renderVoices(voices) {
  const sel = $('voice');
  sel.innerHTML = '';
  for (const v of voices) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.title || v.id;
    sel.appendChild(opt);
  }
  const remembered =
    settings.voiceByProvider?.[currentProvider()] || (currentProvider() === 'fish' ? settings.fishVoice : '');
  if (remembered) sel.value = remembered;
}

async function getInventoryCache() {
  return (await chrome.storage.local.get('providerInventoryCache')).providerInventoryCache || {};
}

function renderInventory(inventory, fresh = false) {
  if (!inventory) return;
  const authoritative = fresh && inventory.source === 'live' && inventory.complete === true;
  providerInventories[currentProvider()] = { ...inventory, authoritative };
  renderVoices(inventory.voices || []);
  renderInventoryStatus();
  renderVoiceSettings();
}

async function initInventory() {
  const p = currentProvider();
  const cached = (await getInventoryCache())[p];
  if (cached?.fetchedAt && cached.inventory) renderInventory(cached.inventory);
  else renderInventory({ voices: [], models: p === 'elevenlabs_web' ? ELEVEN_FALLBACK_MODELS : FISH_FALLBACK_MODELS, source: 'fallback' });
  void refreshInventory(false);
}

async function refreshInventory(manual) {
  const p = currentProvider();
  status(`Refreshing ${PROVIDERS[p]?.displayName || p} inventory…`);
  const res = await chrome.runtime.sendMessage({ type: 'providerInventory', provider: p });
  if (!res?.ok) {
    return status(`Couldn't refresh ${PROVIDERS[p]?.displayName || p} inventory: ${res?.error || NORESP}`);
  }
  const cache = await getInventoryCache();
  cache[p] = { fetchedAt: res.inventory.fetchedAt, inventory: res.inventory };
  await chrome.storage.local.set({ providerInventoryCache: cache });
  if (p === currentProvider()) renderInventory(res.inventory, true);
  status(`Inventory refreshed (${res.inventory.source}).`);
}

// Styled confirmation overlay → resolves true (OK) / false (Cancel).
function confirmDialog(title, body, okText = 'Queue') {
  return new Promise((resolve) => {
    $('confirmTitle').textContent = title;
    $('confirmBody').textContent = body;
    $('confirmOk').textContent = okText;
    const dlg = $('confirm');
    dlg.hidden = false;
    const close = (val) => {
      dlg.hidden = true;
      $('confirmOk').onclick = null;
      $('confirmCancel').onclick = null;
      resolve(val);
    };
    $('confirmOk').onclick = () => close(true);
    $('confirmCancel').onclick = () => close(false);
  });
}

function testedAtLabel(at) {
  if (Date.now() - at < 60 * 1000) return 'tested just now';
  return `tested ${new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(at)}`;
}

function renderConnectionStatus() {
  const out = $('connStatus');
  if (!out || !studioConnectionTest || studioConnectionTest.url !== settings?.studioBaseUrl) return;
  const connected = studioConnectionTest.state === 'connected';
  $('openStudioSettings').hidden = connected;
  const text = `${connected ? 'Connected' : 'Failed'} · ${testedAtLabel(studioConnectionTest.at)}`;
  out.textContent = text;
  out.title = studioConnectionTest.detail || '';
  out.setAttribute('aria-label', studioConnectionTest.detail ? `${text}. ${studioConnectionTest.detail}` : text);
  out.classList.toggle('connected', connected);
  out.classList.toggle('failed', !connected);
}

async function restoreConnectionStatus() {
  const stored = await chrome.storage.session.get(STUDIO_CONNECTION_TEST_KEY);
  studioConnectionTest = stored[STUDIO_CONNECTION_TEST_KEY] || null;
  renderConnectionStatus();
}

async function recordConnectionTest(state, detail) {
  studioConnectionTest = { state, detail, at: Date.now(), url: settings.studioBaseUrl };
  await chrome.storage.session.set({ [STUDIO_CONNECTION_TEST_KEY]: studioConnectionTest });
  renderConnectionStatus();
}

// Panel connection test — verifies the whole chain from where you work.
async function testConnection() {
  const out = $('connStatus');
  const button = $('testConn');
  button.disabled = true;
  $('openStudioSettings').hidden = true;
  out.textContent = 'Testing…';
  out.title = '';
  out.removeAttribute('aria-label');
  out.classList.remove('connected', 'failed');
  try {
    const url = settings.studioBaseUrl || '';
    const local = /localhost|127\.0\.0\.1/.test(url);
    if (!local) {
      let pat = null;
      try {
        const u = new URL(url);
        pat = `${u.protocol}//${u.hostname}/*`;
      } catch {
        /* invalid url */
      }
      const granted = pat ? await chrome.permissions.contains({ origins: [pat] }).catch(() => false) : false;
      if (!granted) {
        await recordConnectionTest('failed', 'No host access. Open Settings and grant access.');
        return;
      }
    }
    const projects = await client.listProjects();
    const n = Array.isArray(projects) ? projects.length : (projects.projects || []).length;
    await recordConnectionTest('connected', `${n} project${n !== 1 ? 's' : ''} available`);
    await loadStudioData(); // refresh dropdowns now that we're reachable
  } catch (e) {
    const local = /localhost|127\.0\.0\.1/.test(settings.studioBaseUrl || '');
    await recordConnectionTest('failed', `${e.message}. ${local ? 'Running?' : 'Running, granted, logged in?'}`);
  } finally {
    button.disabled = false;
  }
}
