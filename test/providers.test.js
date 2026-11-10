import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PROVIDERS,
  ELEVEN_FALLBACK_MODELS,
  FISH_FALLBACK_MODELS,
  createFishInventory,
  createElevenInventory,
  buildElevenVoiceSettings,
  modelMetaNeedsSync,
  modelsForProviderSettings,
  normalizeFishTtsModels,
  normalizeElevenTtsModels,
  resolveElevenModel,
  snapshotProviderSettings,
  snapshotProviderJob,
  assertProviderSettingsSnapshot,
} from '../src/lib/providers.js';

test('snapshots the selected discovered voice and exact model metadata', () => {
  const inventory = {
    source: 'live', complete: true,
    voices: [{ id: 'voice-live', title: 'Account Narrator' }],
    models: [{ id: 'account-model', label: 'Account model', maxChars: 7200, style: true, speakerBoost: false, speed: true, stability: 'slider' }],
  };
  assert.deepEqual(snapshotProviderJob('elevenlabs_web', { model: 'account-model', style: 0.3 }, inventory, 'voice-live', 'account-model'), {
    voice: 'voice-live',
    providerSettings: { model: 'account-model', modelMeta: inventory.models[0], style: 0.3 },
  });
});

test('rejects an incomplete queued model snapshot', () => {
  assert.throws(() => assertProviderSettingsSnapshot('fish', { model: 's3-pro' }), /model was not discovered/i);
});

test('the registry exposes only the signed-in web providers and their UI metadata', () => {
  assert.deepEqual(Object.keys(PROVIDERS).sort(), ['elevenlabs_web', 'fish']);
  assert.equal(PROVIDERS.fish.workspaceUrl, 'https://fish.audio/text-to-speech/');
  assert.equal(PROVIDERS.fish.messageNamespace, 'fish');
  assert.equal(PROVIDERS.elevenlabs_web.workspaceUrl, 'https://elevenlabs.io/app/speech-synthesis/text-to-speech');
  assert.equal(PROVIDERS.elevenlabs_web.messageNamespace, 'eleven');
  assert.equal(PROVIDERS.elevenlabs_web.defaults.model, 'eleven_multilingual_v2');
});

test('normalizes only TTS-capable ElevenLabs models with stable controls', () => {
  const models = normalizeElevenTtsModels({
    models: [
      { model_id: 'eleven_v3', name: 'Eleven v3', can_do_text_to_speech: true, can_use_style: false, can_use_speaker_boost: true, maximum_text_length_per_request: 10000 },
      { model_id: 'speech-to-speech', name: 'Voice changer', can_do_text_to_speech: false },
      { model_id: 'new_tts', name: 'New TTS', capabilities: { text_to_speech: true }, can_use_style: true, can_use_speaker_boost: false, maximum_text_length_per_request: 2200 },
    ],
  });

  assert.deepEqual(models, [
    { id: 'eleven_v3', label: 'Eleven v3', maxChars: 10000, style: false, speakerBoost: true, speed: false, stability: 'discrete' },
    { id: 'new_tts', label: 'New TTS', maxChars: 2200, style: true, speakerBoost: false, speed: false, stability: 'slider' },
  ]);
});

test('uses the tested fallback catalog only when discovery has no usable TTS models', () => {
  const fallback = createElevenInventory({ models: [{ model_id: 'voice_conversion', can_do_text_to_speech: false }] });

  assert.equal(fallback.source, 'fallback');
  assert.deepEqual(fallback.models, ELEVEN_FALLBACK_MODELS);
});

test('marks a discovered inventory as live and repairs a stale selected model', () => {
  const inventory = createElevenInventory({
    models: [{ model_id: 'account_model', name: 'Account Model', can_do_text_to_speech: true }],
  });

  assert.equal(inventory.source, 'live');
  assert.deepEqual(resolveElevenModel('removed_model', inventory.models), {
    model: { id: 'account_model', label: 'Account Model', maxChars: 4500, style: false, speakerBoost: false, speed: false, stability: 'slider' },
    repaired: true,
  });
});

test('Fish listing preserves exact metadata IDs and never derives an ID or support from a label', () => {
  assert.deepEqual(normalizeFishTtsModels([
    { id: 'drama-3', label: 'Drama3' }, { id: 'future-exact-id', label: 'Future model' }, 'S2.1Pro',
  ]), [
    { id: 'drama-3', label: 'Drama3', generationSupported: false },
    { id: 'future-exact-id', label: 'Future model', generationSupported: false },
    { id: '', label: 'S2.1Pro', generationSupported: false },
  ]);
});

test('marks a partial Fish model collection as non-authoritative discovery', () => {
  const inventory = createFishInventory({ complete: false, labels: ['Fish Audio S3 Pro'] });

  assert.equal(inventory.source, 'discovered');
  assert.equal(inventory.complete, false);
  assert.deepEqual(inventory.models, [{ id: '', label: 'Fish Audio S3 Pro', generationSupported: false }]);
  assert.equal(inventory.verificationRequired, true);
});

test('keeps a saved model visible for non-authoritative discovery and snapshots the displayed Fish model', () => {
  const saved = { model: 's2-pro', modelMeta: { id: 's2-pro', label: 'Saved S2 Pro' }, speed: 1.1 };
  const inventory = { source: 'discovered', complete: false, models: [{ id: 's3-pro', label: 'Fish Audio S3 Pro' }] };

  assert.deepEqual(modelsForProviderSettings('fish', saved, inventory), [
    { id: 's3-pro', label: 'Fish Audio S3 Pro' },
    { id: 's2-pro', label: 'Saved S2 Pro' },
  ]);
  assert.deepEqual(snapshotProviderSettings('fish', saved, inventory, 's2-pro'), saved);
  assert.deepEqual(snapshotProviderSettings('fish', saved, inventory, 's3-pro'), {
    model: 's3-pro',
    modelMeta: { id: 's3-pro', label: 'Fish Audio S3 Pro' },
    speed: 1.1,
  });
});

test('snapshots currently displayed live ElevenLabs metadata without waiting for settings persistence', () => {
  const saved = { model: 'account_tts', modelMeta: { id: 'account_tts', label: 'Account TTS', maxChars: 4500 }, style: 0.2 };
  const liveModel = { id: 'account_tts', label: 'Account TTS', maxChars: 12000, style: true, speakerBoost: false, speed: false, stability: 'slider' };
  const inventory = { source: 'live', complete: true, models: [liveModel] };

  assert.deepEqual(snapshotProviderSettings('elevenlabs_web', saved, inventory, 'account_tts'), {
    model: 'account_tts',
    modelMeta: liveModel,
    style: 0.2,
  });
});

test('omits unsupported ElevenLabs controls and syncs changed live metadata', () => {
  const model = { id: 'new_tts', label: 'New TTS', maxChars: 12000, style: false, speakerBoost: false, speed: false, stability: 'slider' };

  assert.deepEqual(buildElevenVoiceSettings({ style: 0.8, speakerBoost: true, speed: 1.1 }, model), {
    stability: 0.5,
    similarity_boost: 0.75,
  });
  assert.equal(modelMetaNeedsSync({ ...model, maxChars: 4500 }, model), true);
  assert.equal(modelMetaNeedsSync(model, model), false);
});

test('ElevenLabs generation does not cap discovered model limits at 5000 characters', () => {
  const source = readFileSync(new URL('../src/content/eleven-main.js', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /Math\.min\(MAX_CHARS/);
  assert.match(source, /Number\(maxChars\) \|\| MAX_CHARS/);
});

test('uses the Fish fallback only when its visible Model control cannot be read', () => {
  const fallback = createFishInventory([], [{ id: 'voice-1', title: 'Narrator' }]);

  assert.equal(fallback.source, 'fallback');
  assert.deepEqual(FISH_FALLBACK_MODELS, [
    { id: 's2.1-pro', label: 'Fish Audio S2.1 Pro (saved default)' },
    { id: 's2-pro', label: 'Fish Audio S2 Pro - Legacy' },
    { id: 's1', label: 'Fish Audio S1 - Legacy' },
  ]);
  assert.deepEqual(fallback.models, FISH_FALLBACK_MODELS.map((model) => ({ ...model, generationSupported: false })));
  assert.equal(fallback.generationAvailable, false);
  assert.deepEqual(fallback.voices, [{ id: 'voice-1', title: 'Narrator' }]);
});

test('provider bridges preserve ambiguous MAIN-world generation failures', () => {
  const bridge = readFileSync(new URL('../src/content/bridge.js', import.meta.url), 'utf8');
  for (const name of ['fish', 'eleven']) {
    const main = readFileSync(new URL(`../src/content/${name}-main.js`, import.meta.url), 'utf8');
    assert.match(bridge, /ambiguous: !!data\.ambiguous/);
    assert.match(main, /createMainBridge/);
    assert.match(main, name === 'fish' ? /verificationRequired: true, ambiguous: false/ : /ambiguous: true/);
  }
});

test('ElevenLabs makes partial multi-chunk generations ambiguous before quota handling', () => {
  const source = readFileSync(new URL('../src/content/eleven-main.js', import.meta.url), 'utf8');
  assert.match(source, /buffers\.length > 0 \|\| error\?\.submitted/);
  assert.match(source, /catch \(error\) \{[\s\S]{0,180}ambiguous: true/);
});

test('ElevenLabs 5xx and timeout responses are ambiguous while normal 4xx remain retryable', () => {
  for (const name of ['eleven']) {
    const source = readFileSync(new URL(`../src/content/${name}-main.js`, import.meta.url), 'utf8');
    assert.match(source, /r\.status === 408 \|\| r\.status >= 500/);
  }
});
