// Signed-in web-session TTS provider registry and ElevenLabs model helpers.

const ELEVEN_DEFAULT_MAX_CHARS = 4500;

export const FISH_FALLBACK_MODELS = [
  { id: 's2.1-pro', label: 'Fish Audio S2.1 Pro (saved default)' },
  { id: 's2-pro', label: 'Fish Audio S2 Pro - Legacy' },
  { id: 's1', label: 'Fish Audio S1 - Legacy' },
];

export const ELEVEN_FALLBACK_MODELS = [
  { id: 'eleven_multilingual_v2', label: 'Multilingual v2 - lifelike quality', maxChars: ELEVEN_DEFAULT_MAX_CHARS, style: true, speakerBoost: true, speed: true, stability: 'slider' },
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5 - fast and affordable', maxChars: ELEVEN_DEFAULT_MAX_CHARS, style: true, speakerBoost: true, speed: true, stability: 'slider' },
  { id: 'eleven_v3', label: 'v3 - expressive', maxChars: ELEVEN_DEFAULT_MAX_CHARS, style: false, speakerBoost: true, speed: false, stability: 'discrete' },
];

export const PROVIDERS = {
  fish: {
    displayName: 'fish.audio',
    origin: 'https://fish.audio/*',
    workspaceUrl: 'https://fish.audio/text-to-speech/',
    messageNamespace: 'fish',
    uiNote: 'Uses your fish.audio web plan. Keep a logged-in fish.audio tab open.',
    quotaCopy: 'uses your fish.audio web plan',
    maxChars: 15000,
    capabilities: { models: true, autoTag: true, speed: true, speedRange: { min: 0.5, max: 2 } },
    defaults: { model: 's2.1-pro', speed: 1 },
  },
  elevenlabs_web: {
    displayName: 'ElevenLabs',
    origin: 'https://elevenlabs.io/*',
    workspaceUrl: 'https://elevenlabs.io/app/speech-synthesis/text-to-speech',
    messageNamespace: 'eleven',
    uiNote: 'Uses your logged-in elevenlabs.io session. Keep an elevenlabs.io tab open.',
    quotaCopy: 'uses your ElevenLabs quota',
    maxChars: 5000,
    capabilities: { models: true, speed: true, speedRange: { min: 0.7, max: 1.2 }, stability: true, similarity: true, speakerBoost: true },
    defaults: { model: 'eleven_multilingual_v2', stability: 0.5, similarity: 0.75, style: 0, speed: 1, speakerBoost: true },
  },
};

export const PROVIDER_SETTING_DEFAULTS = Object.fromEntries(
  Object.entries(PROVIDERS).map(([id, provider]) => [id, provider.defaults])
);

const knownElevenControls = Object.fromEntries(ELEVEN_FALLBACK_MODELS.map((model) => [model.id, model]));

// Labels are useful for listing, but never manufacture request IDs or generation support.
export function normalizeFishTtsModels(rows) {
  const seen = new Set();
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: typeof row?.id === 'string' ? row.id : '',
    label: String(typeof row === 'string' ? row : row?.label || '').replace(/\s+/g, ' ').trim(),
    generationSupported: false,
  })).filter((model) => model.label && !seen.has(model.id || model.label) && seen.add(model.id || model.label));
}

export function createFishInventory(modelOptions, voices = [], discovery = {}) {
  const options = Array.isArray(modelOptions) ? { labels: modelOptions } : modelOptions || {};
  const models = normalizeFishTtsModels(options.models || options.labels);
  const source = !models.length ? 'fallback' : options.complete === true && models.every((model) => model.id) ? 'live' : 'discovered';
  const limitKnown = Number.isSafeInteger(options.maxChars) && options.maxChars > 0 && options.limitSource === 'workspace-textarea';
  return {
    voices: Array.isArray(voices) ? voices : [],
    voiceScope: discovery.voiceScope || 'unverified',
    voicesComplete: false,
    models: (models.length ? models : FISH_FALLBACK_MODELS.map((model) => ({ ...model, generationSupported: false })))
      .map((model) => limitKnown && model.id && model.id === options.selectedId ? { ...model, maxChars: options.maxChars, limitSource: options.limitSource } : model),
    capabilities: PROVIDERS.fish.capabilities,
    source,
    complete: source === 'live',
    generationAvailable: false,
    verificationRequired: true,
    limitation: 'Workspace verification is required; listing models and voices does not establish generation support.',
  };
}

const ttsCapable = (model) =>
  model?.can_do_text_to_speech === true ||
  model?.capabilities?.text_to_speech === true ||
  model?.supported_features?.includes?.('text_to_speech');

const advertisedMaxChars = (model) => {
  const value = Number(model?.maximum_text_length_per_request ?? model?.max_characters_per_request ?? model?.max_characters);
  return Number.isFinite(value) && value > 0 ? value : ELEVEN_DEFAULT_MAX_CHARS;
};

// The models endpoint is account-specific. Preserve known control differences,
// while new TTS models use the broadly supported web controls by default.
export function normalizeElevenTtsModels(payload) {
  const models = Array.isArray(payload) ? payload : payload?.models;
  if (!Array.isArray(models)) return [];
  return models
    .filter(ttsCapable)
    .map((model) => {
      const id = String(model.model_id || model.id || '');
      if (!id) return null;
      const known = knownElevenControls[id];
      return {
        id,
        label: String(model.name || model.display_name || id),
        maxChars: advertisedMaxChars(model),
        style: typeof model.can_use_style === 'boolean' ? model.can_use_style : known?.style || false,
        speakerBoost: typeof model.can_use_speaker_boost === 'boolean' ? model.can_use_speaker_boost : known?.speakerBoost || false,
        speed: known?.speed || false,
        stability: known?.stability || 'slider',
      };
    })
    .filter(Boolean);
}

export function createElevenInventory(payload, voices = []) {
  const models = normalizeElevenTtsModels(payload);
  return {
    voices: Array.isArray(voices) ? voices : [],
    models: models.length ? models : ELEVEN_FALLBACK_MODELS,
    capabilities: PROVIDERS.elevenlabs_web.capabilities,
    source: models.length ? 'live' : 'fallback',
    complete: models.length > 0,
  };
}

export function resolveElevenModel(id, models = ELEVEN_FALLBACK_MODELS) {
  const model = models.find((candidate) => candidate.id === id) || models[0] || ELEVEN_FALLBACK_MODELS[0];
  return { model, repaired: model.id !== id };
}

export function resolveFishModel(id, models = FISH_FALLBACK_MODELS) {
  const model = models.find((candidate) => candidate.id === id) || models[0] || FISH_FALLBACK_MODELS[0];
  return { model, repaired: model.id !== id };
}

const fallbackModelsFor = (providerId) =>
  providerId === 'elevenlabs_web' ? ELEVEN_FALLBACK_MODELS : FISH_FALLBACK_MODELS;

export function modelsForProviderSettings(providerId, settings = {}, inventory) {
  const models = inventory?.models?.length ? inventory.models : fallbackModelsFor(providerId);
  const savedId = settings.model;
  if (!savedId || models.some((model) => model.id === savedId) || inventory?.authoritative) return models;
  const saved = settings.modelMeta?.id === savedId
    ? settings.modelMeta
    : { id: savedId, label: `${savedId} (saved)` };
  return [...models, saved];
}

export function snapshotProviderSettings(providerId, settings = {}, inventory, displayedModelId) {
  const models = modelsForProviderSettings(providerId, settings, inventory);
  if (displayedModelId && !models.some((model) => model.id === displayedModelId)) {
    throw new Error((PROVIDERS[providerId]?.displayName || providerId) + ' model was not discovered; refresh inventory and queue again.');
  }
  const resolve = providerId === 'elevenlabs_web' ? resolveElevenModel : resolveFishModel;
  const model = resolve(displayedModelId || settings.model, models).model;
  return { ...settings, model: model.id, modelMeta: model };
}

export function assertProviderSettingsSnapshot(providerId, settings = {}) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new Error('This provider is no longer supported.');
  const modelId = String(settings.model || '');
  const modelMeta = settings.modelMeta;
  if (!modelId || !modelMeta || modelMeta.id !== modelId || !String(modelMeta.label || '')) {
    throw new Error(provider.displayName + ' model was not discovered; refresh inventory and queue again.');
  }
  return modelMeta;
}

export function snapshotProviderJob(providerId, settings = {}, inventory, voiceId, displayedModelId = '') {
  const providerSettings = snapshotProviderSettings(providerId, settings, inventory, displayedModelId);
  assertProviderSettingsSnapshot(providerId, providerSettings);
  const voice = String(voiceId || '');
  if (!voice) throw new Error((PROVIDERS[providerId]?.displayName || providerId) + ' voice was not discovered; refresh inventory and queue again.');
  if (inventory?.source === 'live' && inventory.complete === true && !inventory.voices.some((candidate) => candidate.id === voice)) {
    throw new Error((PROVIDERS[providerId]?.displayName || providerId) + ' voice was not discovered; refresh inventory and queue again.');
  }
  return { voice, providerSettings };
}

export function modelMetaNeedsSync(saved, live) {
  if (!live || saved?.id !== live.id) return true;
  return ['label', 'maxChars', 'style', 'speakerBoost', 'speed', 'stability'].some((key) => saved[key] !== live[key]);
}

export const ELEVEN_STABILITY_MODES = [
  { value: 0, label: 'Creative' },
  { value: 0.5, label: 'Natural' },
  { value: 1, label: 'Robust' },
];

export const elevenModel = (model) =>
  typeof model === 'object' && model?.id ? model : resolveElevenModel(model).model;

const clamp = (n, lo, hi, dflt) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
};

export function buildElevenVoiceSettings(settings = {}, model) {
  const meta = elevenModel(model);
  let stability = clamp(settings.stability, 0, 1, 0.5);
  if (meta.stability === 'discrete') {
    stability = ELEVEN_STABILITY_MODES.map((entry) => entry.value).reduce(
      (nearest, value) => (Math.abs(value - stability) < Math.abs(nearest - stability) ? value : nearest),
      0.5
    );
  }
  const voiceSettings = {
    stability,
    similarity_boost: clamp(settings.similarity, 0, 1, 0.75),
  };
  if (meta.style) voiceSettings.style = clamp(settings.style, 0, 1, 0);
  if (meta.speakerBoost) voiceSettings.use_speaker_boost = settings.speakerBoost !== false;
  if (meta.speed) voiceSettings.speed = clamp(settings.speed, 0.7, 1.2, 1);
  return voiceSettings;
}
