import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGatewayClient, gatewayBindingFingerprint, prepareAudioInventory, validateHealthResponse, validateTtsJob } from '../src/lib/gateway-client.js';
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

const INVENTORY_HEALTH = { audioInventoryMaxAgeSeconds: 90, audioInventoryMaxBytes: 1048576 };
const observed = (patch = {}) => ({ ok: true, inventory: { source: 'live', complete: true, fetchedAt: 100000,
  models: [{ id: 'model', label: 'Private label', maxChars: 4500, speed: true }],
  voices: [{ id: 'voice', title: 'Private title' }], ...patch } });

test('inventory carries only observed IDs and original time, never labels or normalized capabilities', () => {
  const inventory = prepareAudioInventory({ fish: observed(), elevenlabs_web: observed({ source: 'fallback' }) }, 'worker', INVENTORY_HEALTH, 100100);
  assert.deepEqual(inventory, { schema: 1, providers: { fish: { source: 'live', complete: true, fetchedAt: 100000, models: [{ id: 'model' }], voices: [{ id: 'voice' }] } } });
  assert.equal(prepareAudioInventory({ fish: observed() }, 'worker', INVENTORY_HEALTH, 100200).providers.fish.fetchedAt, 100000);
  for (const patch of [{ source: 'fallback' }, { source: 'discovered' }, { complete: false }, { generationAvailable: false }, { verificationRequired: true }, { models: [] }, { voices: [] }, { voices: [{ id: '' }] }, { models: [{ id: 4 }] }]) {
    assert.deepEqual(prepareAudioInventory({ fish: observed(patch) }, 'worker', INVENTORY_HEALTH, 100100).providers, {});
  }
  assert.deepEqual(prepareAudioInventory({ fish: { ...observed(), ok: false } }, 'worker', INVENTORY_HEALTH, 100100).providers, {});
});

test('inventory rejects future/expired observations and uses server limits without timestamp repair or truncation', () => {
  for (const fetchedAt of [0, 100101, 10100, NaN, 1.5]) {
    assert.throws(() => prepareAudioInventory({ fish: observed({ fetchedAt }) }, 'worker', INVENTORY_HEALTH, 100100), /90 second age limit/);
  }
  assert.equal(prepareAudioInventory({ fish: observed({ fetchedAt: 10101 }) }, 'worker', INVENTORY_HEALTH, 100100).providers.fish.fetchedAt, 10101);
  for (const patch of [{ audioInventoryMaxAgeSeconds: undefined }, { audioInventoryMaxAgeSeconds: 0 }, { audioInventoryMaxBytes: undefined }, { audioInventoryMaxBytes: 1.5 }]) {
    assert.throws(() => prepareAudioInventory({}, 'worker', { ...INVENTORY_HEALTH, ...patch }, 100100), /limits are unavailable/);
  }
  const observations = { fish: observed({ voices: [{ id: 'អ' }] }) };
  const audioInventory = prepareAudioInventory(observations, 'worker', INVENTORY_HEALTH, 100100);
  const bytes = new TextEncoder().encode(JSON.stringify({ workerId: 'worker', kind: 'audio', audioInventory })).byteLength;
  assert.deepEqual(prepareAudioInventory(observations, 'worker', { ...INVENTORY_HEALTH, audioInventoryMaxBytes: bytes }, 100100), audioInventory);
  assert.throws(() => prepareAudioInventory(observations, 'worker', { ...INVENTORY_HEALTH, audioInventoryMaxBytes: bytes - 1 }, 100100), new RegExp(`Gateway allows ${bytes - 1} bytes`));
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
    assert.deepEqual(await client.claim('worker'), { job });
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

test('claim transports the inventory with existing bearer scope and distinguishes definite rejection from an unknown answer', async () => {
  const previous = globalThis.fetch;
  const client = buildGatewayClient('http://gateway.invalid', 'fixture');
  const audioInventory = prepareAudioInventory({ fish: observed() }, 'worker', INVENTORY_HEALTH, 100100);
  let sent;
  try {
    globalThis.fetch = async (_url, init) => { sent = init; return new Response(null, { status: 204 }); };
    assert.equal(await client.claim('worker', audioInventory), null);
    assert.deepEqual(JSON.parse(sent.body), { workerId: 'worker', kind: 'audio', audioInventory });
    assert.equal(sent.headers.Authorization, 'Bearer fixture');
    for (const status of [413, 422, 500]) {
      globalThis.fetch = async () => new Response('reflected-private-secret', { status });
      await assert.rejects(client.claim('worker', audioInventory), (error) =>
        !!error.claimRejected === (status !== 500) && !error.message.includes('reflected'));
    }
  } finally { globalThis.fetch = previous; }
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

test('a quote preview is returned as a preview and never as work', async () => {
  const original = globalThis.fetch;
  const client = buildGatewayClient('http://gateway.invalid', 'fixture');
  const preview = { job: { jobId: 'audio/a' }, payloadSha256: 'b'.repeat(64), executionAuthorized: false };
  try {
    globalThis.fetch = async () => Response.json({ job: null, quoteRequired: preview });
    assert.deepEqual(await client.claim('worker'), { quoteRequired: preview });
    globalThis.fetch = async () => Response.json({ job: null, quoteRequired: { ...preview, executionAuthorized: true } });
    await assert.rejects(client.claim('worker'), (error) => error.message.includes('preview'));
    globalThis.fetch = async () => Response.json({ job: null, quoteRequired: { ...preview, payloadSha256: 'not-a-digest' } });
    await assert.rejects(client.claim('worker'), (error) => error.message.includes('preview'));
    globalThis.fetch = async () => Response.json({ job: null });
    await assert.rejects(client.claim('worker'), (error) => error.message.includes('no job ID'));
  } finally { globalThis.fetch = original; }
});
