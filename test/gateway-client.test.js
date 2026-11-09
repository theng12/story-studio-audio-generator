import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGatewayClient, gatewayBindingFingerprint, validateHealthResponse, validateTtsJob } from '../src/lib/gateway-client.js';
const job = { jobId: 'audio/a', kind: 'audio', provider: 'fish', voice: 'v1', text: 'Hello.', model: 's2.1-pro' };

test('actual settings migration keeps the third mode and moves Gateway configuration out of sync', async () => {
  const { getSettings, saveSettings, getGatewayCredentials } = await import('../src/lib/config.js');
  const previous = globalThis.chrome;
  const synced = { settings: { mode: 'gateway', gatewayModeEnabled: true, gatewayBaseUrl: 'http://gateway.invalid' } };
  const local = { gatewayWorkerToken: 'fixture-only', gatewayWorkerId: 'worker' };
  const area = (state) => ({
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in state).map((key) => [key, structuredClone(state[key])])); },
    async set(values) { Object.assign(state, structuredClone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key]; },
  });
  globalThis.chrome = { storage: { sync: area(synced), local: area(local), session: area({}) } };
  try {
    const settings = await getSettings();
    assert.equal(settings.mode, 'gateway');
    assert.equal(settings.gatewayBaseUrl, 'http://gateway.invalid');
    assert.equal(synced.settings.gatewayBaseUrl, undefined);
    assert.equal(synced.settings.gatewayModeEnabled, undefined);
    await saveSettings({ mode: 'standalone', gatewayBaseUrl: 'http://other.invalid' });
    assert.equal(local.gatewaySettings.gatewayBaseUrl, 'http://other.invalid');
    assert.equal(synced.settings.mode, 'standalone');
    assert.equal(synced.settings.gatewayBaseUrl, undefined);
    assert.deepEqual(await getGatewayCredentials(), { token: 'fixture-only', workerId: 'worker' });
  } finally { globalThis.chrome = previous; }
});

test('strict audio schema rejects absent model/kind and invalid supplied choices', () => {
  assert.equal(validateTtsJob(job).ok, true);
  for (const patch of [{ kind: 'video' }, { model: undefined }, { voice: '' }, { text: 42 }, { speed: NaN }, { autoTag: 'yes' }, { provider: 'unknown' }]) assert.equal(validateTtsJob({ ...job, ...patch }).ok, false);
  assert.equal(validateTtsJob(job, { knownVoices: ['other'] }).ok, false);
  assert.equal(validateTtsJob(job, { knownModels: ['other'] }).ok, false);
});

test('health requires exact identity and a finite positive upload limit', () => {
  const health = { ok: true, workerId: 'worker', kind: 'audio', maxResultBytes: 100 };
  const expected = { workerId: 'worker', kind: 'audio' };
  assert.equal(validateHealthResponse(health, expected).ok, true);
  for (const patch of [{ ok: 1 }, { workerId: undefined }, { kind: 'video' }, { maxResultBytes: 0 }, { maxResultBytes: NaN }]) assert.equal(validateHealthResponse({ ...health, ...patch }, expected).ok, false);
});

test('binding normalizes address and changes on token/identity rotation', async () => {
  const first = await gatewayBindingFingerprint('http://gateway.invalid', 'worker', 'fixture');
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, await gatewayBindingFingerprint('http://gateway.invalid/', 'worker', 'fixture'));
  assert.notEqual(first, await gatewayBindingFingerprint('http://gateway.invalid', 'worker', 'rotated'));
  assert.notEqual(first, await gatewayBindingFingerprint('http://gateway.invalid', 'other', 'fixture'));
});

test('wire paths/envelope, explicit answers and no credential redirects', async () => {
  const original = globalThis.fetch;
  const calls = [];
  let answer = { job };
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json(answer); };
  const client = buildGatewayClient('http://gateway.invalid', 'fixture');
  try {
    assert.deepEqual(await client.claim('worker'), job);
    assert.deepEqual(JSON.parse(calls[0].init.body), { workerId: 'worker', kind: 'audio' });
    answer = { ok: true };
    await client.progress(job.jobId, 'generating', 'fixture');
    await client.fail(job.jobId, 'fixture');
    assert.ok(calls[1].url.endsWith('/api/workers/jobs/audio%2Fa/progress'));
    assert.deepEqual(JSON.parse(calls[1].init.body), { phase: 'generating', message: 'fixture' });
    assert.ok(calls[2].url.endsWith('/api/workers/jobs/audio%2Fa/fail'));
    assert.equal(JSON.parse(calls[2].init.body).ambiguous, true);
    const file = new Blob(['exact audio'], { type: 'audio/wav' });
    for (answer of [{}, { ok: true, ignored: true }, { ok: 'true' }]) assert.equal((await client.result(job.jobId, { mediaType: 'audio/wav', file })).acknowledged, false);
    answer = { ok: true };
    assert.equal((await client.result(job.jobId, { mediaType: 'audio/wav', file })).acknowledged, true);
    assert.ok(calls.at(-1).url.endsWith('/api/workers/jobs/audio%2Fa/result'));
    assert.equal(await calls.at(-1).init.body.get('file').text(), 'exact audio');
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal(calls[0].init.credentials, 'omit');
    answer = {};
    await assert.rejects(client.fail(job.jobId, 'fixture'), /did not accept/);
  } finally { globalThis.fetch = original; }
});

test('idle204 and error bodies do not leak echoed credentials', async () => {
  const original = globalThis.fetch;
  const client = buildGatewayClient('http://gateway.invalid', 'fixture');
  try {
    globalThis.fetch = async () => new Response(null, { status: 204 });
    assert.equal(await client.claim('worker'), null);
    globalThis.fetch = async () => new Response('reflected-private-secret', { status: 401 });
    await assert.rejects(client.claim('worker'), (error) => error.message.includes('401') && !error.message.includes('reflected'));
    assert.throws(() => buildGatewayClient('https://user:secret@gateway.invalid', 'fixture'));
    assert.throws(() => buildGatewayClient('https://gateway.invalid?token=secret', 'fixture'));
  } finally { globalThis.fetch = original; }
});
