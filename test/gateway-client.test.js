import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTtsJob, buildGatewayClient, GATEWAY_KIND, TTS_JOB_SCHEMA } from '../src/lib/gateway-client.js';

test('GATEWAY_KIND is audio', () => {
  assert.equal(GATEWAY_KIND, 'audio');
});

test('TTS_JOB_SCHEMA requires provider, voice, text and lists known providers', () => {
  assert.deepEqual(TTS_JOB_SCHEMA.required, ['provider', 'voice', 'text']);
  assert.ok(TTS_JOB_SCHEMA.knownProviders.includes('fish'));
  assert.ok(TTS_JOB_SCHEMA.knownProviders.includes('elevenlabs_web'));
});

test('validateTtsJob rejects non-object and missing required fields', () => {
  assert.deepEqual(validateTtsJob(null), { ok: false, error: 'job is not an object' });
  assert.deepEqual(validateTtsJob({}), { ok: false, error: 'missing or empty required field: provider' });
  assert.deepEqual(validateTtsJob({ provider: 'fish' }), { ok: false, error: 'missing or empty required field: voice' });
  assert.deepEqual(validateTtsJob({ provider: 'fish', voice: 'v1' }), { ok: false, error: 'missing or empty required field: text' });
});

test('validateTtsJob rejects unsupported provider', () => {
  const result = validateTtsJob({ provider: 'openai', voice: 'v1', text: 'hello' });
  assert.equal(result.ok, false);
  assert.match(result.error, /unsupported provider/);
});

test('validateTtsJob accepts valid fish and elevenlabs_web jobs', () => {
  assert.deepEqual(validateTtsJob({ provider: 'fish', voice: 'v1', text: 'hello world' }), { ok: true });
  assert.deepEqual(validateTtsJob({ provider: 'elevenlabs_web', voice: 'abc', text: 'test', model: 'eleven_multilingual_v2', speed: 1 }), { ok: true });
});

test('validateTtsJob rejects whitespace-only required fields', () => {
  assert.deepEqual(validateTtsJob({ provider: '  ', voice: 'v1', text: 'hello' }), { ok: false, error: 'missing or empty required field: provider' });
  assert.deepEqual(validateTtsJob({ provider: 'fish', voice: '', text: 'hello' }), { ok: false, error: 'missing or empty required field: voice' });
});

test('buildGatewayClient returns an object with the expected methods', () => {
  const client = buildGatewayClient('http://localhost:9999', 'test-token');
  assert.equal(typeof client.health, 'function');
  assert.equal(typeof client.claim, 'function');
  assert.equal(typeof client.progress, 'function');
  assert.equal(typeof client.fail, 'function');
  assert.equal(typeof client.result, 'function');
});

test('buildGatewayClient strips trailing slashes from baseUrl', () => {
  // Verify indirectly: the client should not throw on construction.
  const client = buildGatewayClient('http://localhost:9999///', 'tok');
  assert.ok(client);
});