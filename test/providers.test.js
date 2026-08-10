import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS,
  ELEVEN_FALLBACK_MODELS,
  FISH_FALLBACK_MODELS,
  createFishInventory,
  createElevenInventory,
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
      { model_id: 'eleven_v3', name: 'Eleven v3', can_do_text_to_speech: true, maximum_text_length_per_request: 10000 },
      { model_id: 'speech-to-speech', name: 'Voice changer', can_do_text_to_speech: false },
      { model_id: 'new_tts', name: 'New TTS', capabilities: { text_to_speech: true }, maximum_text_length_per_request: 2200 },
    ],
  });

  assert.deepEqual(models, [
    { id: 'eleven_v3', label: 'Eleven v3', maxChars: 10000, style: false, speed: false, stability: 'discrete' },
    { id: 'new_tts', label: 'New TTS', maxChars: 2200, style: true, speed: true, stability: 'slider' },
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
    model: { id: 'account_model', label: 'Account Model', maxChars: 4500, style: true, speed: true, stability: 'slider' },
    repaired: true,
  });
});

test('normalizes only recognized visible Story Studio Audio Generator model labels into backend ids', () => {
  const models = normalizeFishTtsModels([
    'Fish Audio S2.1 Pro Free Newest',
    'Fish Audio S2 Pro Legacy',
    'Fish Audio S1 Legacy',
    'Unrelated page control',
  ]);

  assert.deepEqual(models, [
    { id: 's2.1-pro', label: 'Fish Audio S2.1 Pro Free Newest' },
    { id: 's2-pro', label: 'Fish Audio S2 Pro Legacy' },
    { id: 's1', label: 'Fish Audio S1 Legacy' },
  ]);
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
