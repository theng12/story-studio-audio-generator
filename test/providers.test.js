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
  normalizeFishTtsModels,
  normalizeElevenTtsModels,
  resolveElevenModel,
} from '../src/lib/providers.js';

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

test('normalizes only recognized visible Story Studio Audio Generator model labels into backend ids', () => {
  const models = normalizeFishTtsModels([
    'Fish Audio S2.1 Pro Free Newest',
    'Fish Audio S2 Pro Legacy',
    'Fish Audio S1 Legacy',
    'Fish Audio S3',
    'Fish Audio S3 Pro',
    'Unrelated page control',
  ]);

  assert.deepEqual(models, [
    { id: 's2.1-pro', label: 'Fish Audio S2.1 Pro Free Newest' },
    { id: 's2-pro', label: 'Fish Audio S2 Pro Legacy' },
    { id: 's1', label: 'Fish Audio S1 Legacy' },
    { id: 's3', label: 'Fish Audio S3' },
    { id: 's3-pro', label: 'Fish Audio S3 Pro' },
  ]);
});

test('does not treat a partial Fish model collection as live inventory', () => {
  const inventory = createFishInventory({ complete: false, labels: ['Fish Audio S3 Pro'] });

  assert.equal(inventory.source, 'fallback');
  assert.deepEqual(inventory.models, FISH_FALLBACK_MODELS);
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

test('Fish inventory source opens and restores the visible model combobox', () => {
  const source = readFileSync(new URL('../src/content/fish-main.js', import.meta.url), 'utf8');

  assert.match(source, /openFishModelCombobox/);
  assert.match(source, /closeFishModelCombobox/);
  assert.match(source, /stableRounds/);
  assert.match(source, /complete: true/);
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
    { id: 's2.1-pro', label: 'Fish Audio S2.1 Pro - Free, newest' },
    { id: 's2-pro', label: 'Fish Audio S2 Pro - Legacy' },
    { id: 's1', label: 'Fish Audio S1 - Legacy' },
  ]);
  assert.deepEqual(fallback.models, FISH_FALLBACK_MODELS);
  assert.deepEqual(fallback.voices, [{ id: 'voice-1', title: 'Narrator' }]);
});
