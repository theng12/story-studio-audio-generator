// Actual service-worker integration. Only browser/provider/HTTP boundaries are
// mocked; the imported background owns claims, locks, pacing and recovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
const AUDIO = Buffer.from('RIFF exact fixture audio bytes');
const JOB = { jobId: 'audio/a', kind: 'audio', provider: 'fish', voice: 'v1', text: 'Hello.', model: 's2.1-pro', speed: 1.2 };
const clone = (value) => value === undefined ? value : structuredClone(value);
function area(state) {
  return {
    async get(keys) { return keys == null ? clone(state) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in state).map((key) => [key, clone(state[key])])); },
    async set(values) { Object.assign(state, clone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key]; },
  };
}
function cacheStorage() {
  const rows = new Map();
  return { rows, async open() { return {
    async put(key, response) { rows.set(key, response.clone()); },
    async match(key) { return rows.get(key)?.clone(); },
    async delete(key) { return rows.delete(typeof key === 'string' ? key : key.url); },
    async keys() { return [...rows.keys()].map((url) => ({ url })); },
  }; } };
}
async function waitFor(predicate) { for (let n = 0; n < 400; n++) { if (predicate()) return; await pause(5); } throw new Error('Actual audio background fixture timed out.'); }
async function boot({ local, cache = cacheStorage(), mode = 'gateway', enabled = true, autoStart = false, job = JOB, answers = [{ ok: true }], onGenerate, providerFailure, lostClaim = false, uploadLimit = 1024, voices = [{ id: 'v1', name: 'Fixture voice' }] } = {}) {
  local ||= { gatewaySettings: { gatewayModeEnabled: enabled, gatewayBaseUrl: 'http://gateway.invalid' }, gatewayWorkerToken: 'fixture-only', gatewayWorkerId: 'fixture-audio' };
  const sync = { settings: { mode, humanDelayMinSec: 0, humanDelayMaxSec: 0, providerSettings: { fish: { model: 'wrong-local-model', speed: 1.9 } } } };
  const savedEnabled = local.gatewaySettings.gatewayModeEnabled;
  if (!autoStart) local.gatewaySettings.gatewayModeEnabled = false;
  const previous = Object.fromEntries(['chrome', 'fetch', 'caches'].map((key) => [key, globalThis[key]]));
  const calls = [], provider = [], alarms = [];
  let listener;
  globalThis.chrome = {
    storage: { local: area(local), sync: area(sync), session: area({}) },
    alarms: { create() {}, clear() {}, onAlarm: { addListener(fn) { alarms.push(fn); } } },
    runtime: { onInstalled: { addListener() {} }, onMessage: { addListener(fn) { listener = fn; } } },
    sidePanel: { setPanelBehavior: async () => {} },
    tabs: {
      query: async () => [{ id: 7, status: 'complete' }],
      async sendMessage(id, message) {
        provider.push(clone(message));
        if (message.type === 'fish:inventory') return { ok: true, raw: { fishModelOptions: { labels: ['Fish Audio S2.1 Pro'], complete: true }, voices } };
        if (message.type === 'fish:generate') {
          await onGenerate?.(local);
          if (providerFailure) throw new Error('Fixture provider outcome unknown.');
          return { ok: true, base64: AUDIO.toString('base64'), mime: 'audio/wav' };
        }
        throw new Error(`Unexpected provider operation ${message.type}`);
      },
    },
  };
  globalThis.caches = cache;
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(new URL(url).origin, 'http://gateway.invalid', 'No network or Story endpoint allowed.');
    const call = { url, init }; calls.push(call);
    if (url.endsWith('/health')) return Response.json({ ok: true, workerId: 'fixture-audio', kind: 'audio', maxResultBytes: uploadLimit });
    if (url.endsWith('/claim')) { if (lostClaim) throw new Error('Fixture claim outcome unknown.'); return job ? Response.json({ job }) : new Response(null, { status: 204 }); }
    if (url.endsWith('/result')) { call.bytes = Buffer.from(await init.body.get('file').arrayBuffer()); call.mime = init.body.get('mediaType'); return Response.json(answers.length > 1 ? answers.shift() : answers[0]); }
    if (/\/(progress|fail)$/.test(url)) return Response.json({ ok: true });
    throw new Error(`Unexpected HTTP ${url}`);
  };
  await import(`../src/background.js?gateway-runtime=${Date.now()}-${Math.random()}`);
  await pause(25);
  local.gatewaySettings.gatewayModeEnabled = savedEnabled;
  return {
    local, sync, cache, calls, provider,
    tick() { for (const alarm of alarms) alarm({ name: 'gatewayPoll' }); },
    async send(message) { return new Promise((resolve) => listener(message, {}, resolve)); },
    async settled() { await pause(25); },
    restore() { for (const [key, value] of Object.entries(previous)) globalThis[key] = value; },
  };
}

test('real claim/inventory/generation/upload returns exact bytes with authoritative model and voice', async () => {
  const worker = await boot();
  try {
    worker.tick(); worker.tick();
    await waitFor(() => worker.local.gatewayStatus?.lastJob === JOB.jobId);
    await worker.settled();
    const generation = worker.provider.filter((entry) => entry.type === 'fish:generate');
    assert.equal(generation.length, 1);
    assert.equal(generation[0].backend, JOB.model);
    assert.equal(generation[0].voice, JOB.voice);
    assert.equal(generation[0].speed, JOB.speed);
    assert.deepEqual(worker.calls.find((entry) => entry.url.endsWith('/result')).bytes, AUDIO);
    assert.equal(worker.calls.filter((entry) => entry.url.endsWith('/claim')).length, 1);
    assert.equal(worker.cache.rows.size, 0);
    assert.equal(worker.local.gatewayInFlightJobId, undefined);
    assert.equal(worker.sync.settings.gatewayBaseUrl, undefined);
  } finally { worker.restore(); }
});

test('malformed/ignored response holds bytes across actual restart/sweep; explicit delivery does not generate', async () => {
  const first = await boot({ answers: [{ ok: true, ignored: true }] });
  let local, cache;
  try {
    first.tick();
    await waitFor(() => first.local.gatewayStatus?.held);
    await first.settled();
    assert.equal(first.cache.rows.size, 1);
    first.tick(); await first.settled();
    assert.equal(first.calls.filter((entry) => entry.url.endsWith('/result')).length, 1, 'Alarm must not retry upload.');
    assert.equal(first.calls.filter((entry) => entry.url.endsWith('/fail')).length, 0);
    local = first.local; cache = first.cache;
  } finally { first.restore(); }
  const second = await boot({ local, cache, autoStart: true, answers: [{}, { ok: true }] });
  try {
    assert.equal(cache.rows.size, 1, 'Startup sweep must preserve the Gateway artifact.');
    assert.equal(second.calls.length, 0);
    assert.equal((await second.send({ type: 'retryGatewayDelivery' })).ok, false);
    assert.equal(cache.rows.size, 1);
    assert.equal((await second.send({ type: 'retryGatewayDelivery' })).ok, true);
    assert.equal(second.provider.length, 0);
    assert.deepEqual(second.calls.find((entry) => entry.url.endsWith('/result')).bytes, AUDIO);
    assert.equal(cache.rows.size, 0);
  } finally { second.restore(); }
});

test('changed token during provider call retains bytes and refuses redirect', async () => {
  const worker = await boot({ onGenerate: (local) => { local.gatewayWorkerToken = 'rotated'; } });
  try {
    worker.tick(); await waitFor(() => worker.local.gatewayStatus?.held); await worker.settled();
    assert.equal(worker.cache.rows.size, 1);
    assert.equal(worker.calls.filter((entry) => /\/(fail|result)$/.test(entry.url)).length, 0);
    assert.equal((await worker.send({ type: 'retryGatewayDelivery' })).ok, false);
  } finally { worker.restore(); }
});

test('unknown generation and lost claim remain held without replay after restart/alarm', async () => {
  const failed = await boot({ providerFailure: true });
  let local, cache;
  try {
    failed.tick(); await waitFor(() => failed.local.gatewayStatus?.held); await failed.settled();
    assert.equal(JSON.parse(failed.calls.find((entry) => entry.url.endsWith('/fail')).init.body).ambiguous, true);
    await failed.send({ type: 'resumeQueue' }); failed.tick(); await failed.settled();
    assert.equal(failed.provider.filter((entry) => entry.type === 'fish:generate').length, 1);
    local = failed.local; cache = failed.cache;
  } finally { failed.restore(); }
  const restarted = await boot({ local, cache, autoStart: true });
  try { assert.equal(restarted.provider.length, 0); assert.equal(restarted.calls.length, 0); }
  finally { restarted.restore(); }
  const lost = await boot({ lostClaim: true });
  try {
    lost.tick(); await waitFor(() => lost.local.gatewayStatus?.held); lost.tick(); await lost.settled();
    assert.equal(lost.calls.filter((entry) => entry.url.endsWith('/claim')).length, 1);
    assert.equal(lost.provider.length, 0);
  } finally { lost.restore(); }
});

test('wrong mode/disabled never claims; missing model/voice and unknown live voice refuse Generate', async () => {
  for (const mode of ['studio', 'standalone']) {
    const worker = await boot({ mode, autoStart: true });
    try { worker.tick(); await worker.settled(); assert.equal(worker.calls.length, 0); }
    finally { worker.restore(); }
  }
  const disabled = await boot({ enabled: false, autoStart: true });
  try { disabled.tick(); await disabled.settled(); assert.equal(disabled.calls.length, 0); }
  finally { disabled.restore(); }
  for (const job of [{ ...JOB, model: undefined }, { ...JOB, voice: 'not-discovered' }]) {
    const worker = await boot({ job });
    try {
      worker.tick(); await waitFor(() => worker.local.gatewayStatus?.error); await worker.settled();
      assert.equal(worker.provider.filter((entry) => entry.type === 'fish:generate').length, 0);
      assert.equal(JSON.parse(worker.calls.find((entry) => entry.url.endsWith('/fail')).init.body).ambiguous, false);
    } finally { worker.restore(); }
  }
});

test('upload limit retains output; lock prevents local enqueue from generating concurrently', async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const worker = await boot({ uploadLimit: 1, onGenerate: () => barrier });
  try {
    worker.tick(); await waitFor(() => worker.provider.some((entry) => entry.type === 'fish:generate'));
    const enqueued = await worker.send({ type: 'enqueue', items: [{ id: 'local', kind: 'paste', target: 'download', text: 'local', label: 'local' }] });
    assert.equal(enqueued.added, 1);
    worker.tick(); await worker.settled();
    assert.equal(worker.provider.filter((entry) => entry.type === 'fish:generate').length, 1);
    release();
    await waitFor(() => worker.local.gatewayStatus?.held); await worker.settled();
    assert.equal(worker.cache.rows.size, 1);
    assert.equal(worker.calls.filter((entry) => entry.url.endsWith('/result')).length, 0);
    assert.equal(worker.local.queue[0].status, 'pending');
  } finally { release(); worker.restore(); }
});
