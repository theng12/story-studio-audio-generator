// Actual service-worker integration. Only browser/provider/HTTP boundaries are
// mocked; the imported background owns claims, locks, pacing and recovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { artifactDescriptor, putAudioArtifact } from '../src/lib/audio-artifacts.js';
const AUDIO = Buffer.from('RIFF exact fixture audio bytes');
const MODEL = ['eleven', 'multilingual', 'v2'].join('_');
const JOB = { jobId: 'audio/a', kind: 'audio', provider: 'elevenlabs_web', voice: 'v1', text: 'Hello.', model: MODEL, speed: 1.2 };
const clone = (value) => value === undefined ? value : structuredClone(value);
const claimsFor = (worker, provider) => worker.calls.filter((entry) => entry.url.endsWith('/claim') && JSON.parse(entry.init.body).account?.provider === provider);
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
async function boot({ local, cache = cacheStorage(), mode = 'gateway', enabled = true, autoStart = false, job = JOB, answers = [{ ok: true }], onGenerate, onSave, onInventory, inventoryReply, inventoryMaxAgeSeconds = 90, inventoryMaxBytes = 1048576, claimStatus, quoteRequired = false, accounts = true, providerFailure, providerReply, tabs = [{ id: 7, status: 'complete' }], failAnswer = { ok: true }, lostClaim = false, uploadLimit = 1024, voices = [{ id: 'v1', name: 'Fixture voice' }] } = {}) {
  local ||= { gatewaySettings: { gatewayModeEnabled: enabled, gatewayBaseUrl: 'http://gateway.invalid' }, gatewayWorkerToken: 'fixture-only', gatewayWorkerId: 'fixture-audio' };
  const sync = { settings: { mode, maxRetries: 0, humanDelayMinSec: 0, humanDelayMaxSec: 0, providerSettings: { elevenlabs_web: { model: 'wrong-local-model', speed: 1.1 } } } };
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
    downloads: {
      async download(options) { await onSave?.(options); return 17; },
      async search() { return [{ id: 17, state: 'complete', filename: 'fixture.wav' }]; },
    },
    tabs: {
      query: async () => tabs,
      async sendMessage(id, message) {
        provider.push(clone(message));
        if (message.type === 'fish:account') return accounts ? { ok: true, raw: { accountId: 'fish.fixture-account', signedIn: true } } : { ok: false, error: 'No signed-in fish account.' };
        if (message.type === 'eleven:account') return accounts ? { ok: true, raw: { accountId: 'elevenlabs_web.fixture-account', signedIn: true } } : { ok: false, error: 'No signed-in ElevenLabs account.' };
        if (message.type === 'fish:inventory') return { ok: true, raw: { fishModelOptions: { models: [{ id: 'drama-3', label: 'Drama3' }], complete: true }, voices } };
        if (message.type === 'eleven:inventory') {
          await onInventory?.(local);
          return inventoryReply || { ok: true, raw: { modelsPayload: { models: [{ model_id: MODEL, name: 'Multilingual v2', can_do_text_to_speech: true, maximum_text_length_per_request: 15000 }] }, voices } };
        }
        if (message.type === 'eleven:generate') {
          await onGenerate?.(local);
          if (providerFailure) throw new Error('Fixture provider outcome unknown.');
          return providerReply || { ok: true, base64: AUDIO.toString('base64'), mime: 'audio/wav' };
        }
        throw new Error(`Unexpected provider operation ${message.type}`);
      },
    },
  };
  globalThis.caches = cache;
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(new URL(url).origin, 'http://gateway.invalid', 'No network or unmocked endpoint allowed.');
    const call = { url, init }; calls.push(call);
    if (url.endsWith('/health')) return Response.json({ ok: true, workerId: 'fixture-audio', kind: 'audio', maxResultBytes: uploadLimit, audioInventoryMaxAgeSeconds: inventoryMaxAgeSeconds, audioInventoryMaxBytes: inventoryMaxBytes });
    if (url.endsWith('/claim')) {
      if (lostClaim) throw new Error('Fixture claim outcome unknown.');
      if (claimStatus) return new Response(null, { status: claimStatus });
      const body = JSON.parse(init.body);
      const eligible = Object.keys(body.audioInventory.providers).length > 0;
      // The Gateway binds an account to the job's provider; the fixture does too.
      const sameProvider = !body.account || !job || body.account.provider === job.provider;
      if (quoteRequired) return Response.json({ job: null, quoteRequired: { job, payloadSha256: 'a'.repeat(64), executionAuthorized: false } });
      return job && eligible && sameProvider ? Response.json({ job }) : new Response(null, { status: 204 });
    }
    if (url.endsWith('/telemetry')) return Response.json({ ok: true });
    if (url.endsWith('/result')) { call.bytes = Buffer.from(await init.body.get('file').arrayBuffer()); call.mime = init.body.get('mediaType'); return Response.json(answers.length > 1 ? answers.shift() : answers[0]); }
    if (url.endsWith('/fail')) return Response.json(failAnswer);
    if (url.endsWith('/progress')) return Response.json({ ok: true });
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
    const generation = worker.provider.filter((entry) => entry.type === 'eleven:generate');
    assert.equal(generation.length, 1);
    assert.equal(generation[0].model, JOB.model);
    assert.equal(generation[0].voice, JOB.voice);
    assert.equal(generation[0].speed, JOB.speed);
    assert.deepEqual(worker.calls.find((entry) => entry.url.endsWith('/result')).bytes, AUDIO);
    assert.equal(claimsFor(worker, JOB.provider).length, 1);
    assert.equal(worker.cache.rows.size, 0);
    assert.equal(worker.local.gatewayInFlightJobId, undefined);
    assert.equal(worker.sync.settings.gatewayBaseUrl, undefined);
  } finally { worker.restore(); }
});

test('no open workspace observes no account and attempts no claim, repeatedly', async () => {
  const worker = await boot({ tabs: [] });
  try {
    for (let n = 0; n < 2; n++) {
      worker.tick();
      await waitFor(() => worker.local.gatewayStatus?.accountUnavailable);
      await worker.settled();
    }
    assert.equal(worker.calls.filter((entry) => entry.url.endsWith('/claim')).length, 0);
    assert.equal(worker.calls.filter((entry) => entry.url.endsWith('/telemetry')).length, 0);
    assert.equal(worker.local.gatewayStatus.balance, 'Unknown');
    assert.match(worker.local.gatewayStatus.error, /no claim was attempted/i);
    assert.equal(worker.calls.filter((entry) => entry.url.endsWith('/fail')).length, 0);
    assert.equal(worker.local.gatewayInFlightPhase, undefined);
    assert.equal(worker.provider.length, 0);
  } finally { worker.restore(); }
});

test('workspace loss stops the claim and reports no observed account on the next poll', async () => {
  const tabs = [{ id: 7, status: 'complete' }];
  const worker = await boot({ tabs, job: null });
  try {
    worker.tick(); await waitFor(() => worker.local.gatewayStatus?.idle); await worker.settled();
    const first = claimsFor(worker, 'elevenlabs_web');
    assert.equal(first.length, 1);
    assert.ok(JSON.parse(first[0].init.body).audioInventory.providers.elevenlabs_web);
    const claimed = worker.calls.filter((entry) => entry.url.endsWith('/claim')).length;
    tabs.length = 0;
    worker.tick(); await waitFor(() => worker.local.gatewayStatus?.accountUnavailable); await worker.settled();
    assert.equal(worker.calls.filter((entry) => entry.url.endsWith('/claim')).length, claimed);
    assert.equal(worker.provider.filter((entry) => entry.type === 'eleven:generate').length, 0);
  } finally { worker.restore(); }
});

test('claim carries fresh IDs only, then rechecks provider inventory before submit', async () => {
  const voices = [{ id: 'v1', title: 'Private account voice' }];
  let refreshes = 0;
  const worker = await boot({ voices, onInventory() { if (++refreshes === 2) voices.length = 0; } });
  try {
    const before = Date.now();
    worker.tick(); await waitFor(() => worker.local.gatewayStatus?.error); await worker.settled();
    const claim = worker.calls.find((entry) => entry.url.endsWith('/claim'));
    const snapshot = JSON.parse(claim.init.body).audioInventory.providers.elevenlabs_web;
    assert.deepEqual(snapshot.models, [{ id: JOB.model }]);
    assert.deepEqual(snapshot.voices, [{ id: JOB.voice }]);
    assert.equal(snapshot.source, 'live');
    assert.equal(snapshot.complete, true);
    assert(snapshot.fetchedAt >= before && snapshot.fetchedAt <= Date.now());
    assert.equal(claim.init.body.includes('Private account voice'), false);
    assert.equal(claim.init.body.includes('maxChars'), false);
    assert.equal(worker.provider.filter((entry) => entry.type === 'eleven:generate').length, 0);
    assert.equal(JSON.parse(worker.calls.find((entry) => entry.url.endsWith('/fail')).init.body).ambiguous, false);
    assert.equal(worker.local.gatewayStatus.held, false);
  } finally { worker.restore(); }
});

test('worker character limit is enforced before submit without calling registry defaults observed', async () => {
  const worker = await boot({ job: { ...JOB, text: 'x'.repeat(15001) } });
  try {
    worker.tick(); await waitFor(() => worker.local.gatewayStatus?.error); await worker.settled();
    assert.match(worker.local.gatewayStatus.error, /this worker's 15000 character limit/);
    assert.equal(worker.local.gatewayStatus.error.includes('observed'), false);
    assert.equal(worker.provider.filter((entry) => entry.type === 'eleven:generate').length, 0);
    assert.equal(JSON.parse(worker.calls.find((entry) => entry.url.endsWith('/fail')).init.body).ambiguous, false);
  } finally { worker.restore(); }
});

for (const options of [
  { inventoryReply: { ok: true, raw: { modelsPayload: { models: [] }, voices: [{ id: 'v1' }] } } },
  { voices: [] },
  { inventoryReply: { ok: false, error: 'Fixture inventory unavailable.' } },
]) {
  test('fallback, empty voices or failed discovery publishes no eligible provider', async () => {
    const worker = await boot(options);
    try {
      worker.tick(); await waitFor(() => worker.local.gatewayStatus?.idle); await worker.settled();
      const claim = worker.calls.find((entry) => entry.url.endsWith('/claim'));
      assert.deepEqual(JSON.parse(claim.init.body).audioInventory.providers, {});
      assert.equal(worker.provider.filter((entry) => entry.type === 'eleven:generate').length, 0);
    } finally { worker.restore(); }
  });
}

test('mode/token change during discovery refuses claim with no retained claim marker', async () => {
  const worker = await boot({ onInventory(local) { local.gatewayWorkerToken = 'rotated'; } });
  try {
    worker.tick(); await waitFor(() => worker.local.gatewayStatus?.error); await worker.settled();
    assert.equal(worker.calls.filter((entry) => entry.url.endsWith('/claim')).length, 0);
    assert.equal(worker.local.gatewayStatus.held, false);
  } finally { worker.restore(); }
});

for (const options of [{ inventoryMaxAgeSeconds: null }, { inventoryMaxBytes: 1 }]) {
  test('missing or exceeded advertised limits fail before persisting a claim', async () => {
    const worker = await boot(options);
    try {
      worker.tick(); await waitFor(() => worker.local.gatewayStatus?.error); await worker.settled();
      assert.equal(worker.calls.filter((entry) => entry.url.endsWith('/claim')).length, 0);
      assert.equal(worker.local.gatewayStatus.held, false);
      assert.equal(worker.local.gatewayInFlightPhase, undefined);
    } finally { worker.restore(); }
  });
}

for (const status of [413, 422, 500]) {
  test(`claim HTTP ${status} ${status === 500 ? 'preserves uncertainty' : 'clears a definite pre-claim rejection'}`, async () => {
    const worker = await boot({ claimStatus: status });
    try {
      worker.tick(); await waitFor(() => worker.local.gatewayStatus?.error); await worker.settled();
      assert.equal(worker.local.gatewayStatus.held, status === 500);
      assert.equal(worker.provider.filter((entry) => entry.type === 'eleven:generate').length, 0);
    } finally { worker.restore(); }
  });
}

for (const code of [402, 429]) {
  test(`explicit provider ${code} is acknowledged as non-ambiguous and pauses before another claim`, async () => {
    const worker = await boot({ providerReply: { ok: false, error: `Provider ${code}: limit reached`, limit: true, ambiguous: false } });
    try {
      worker.tick();
      await waitFor(() => worker.local.gatewayStatus?.error);
      await worker.settled();
      assert.equal(JSON.parse(worker.calls.find((entry) => entry.url.endsWith('/fail')).init.body).ambiguous, false);
      assert.equal(worker.local.gatewayStatus.ambiguous, false);
      assert.equal(worker.local.gatewayStatus.held, false);
      assert.equal(worker.local.gatewayInFlightPhase, undefined);
      assert.equal(worker.local.queuePaused, true);
      worker.tick(); await worker.settled();
      assert.equal(claimsFor(worker, JOB.provider).length, 1);
      assert.equal(worker.provider.filter((entry) => entry.type === 'eleven:generate').length, 1);
    } finally { worker.restore(); }
  });
}

test('unacknowledged explicit provider rejection remains held without another claim', async () => {
  const worker = await boot({ providerReply: { ok: false, error: 'Provider rejected request', ambiguous: false }, failAnswer: { ok: true, ignored: true } });
  try {
    worker.tick(); await waitFor(() => worker.local.gatewayStatus?.held); await worker.settled();
    assert.equal(worker.local.gatewayInFlightPhase, 'generating');
    worker.tick(); await worker.settled();
    assert.equal(claimsFor(worker, JOB.provider).length, 1);
    assert.equal(worker.provider.filter((entry) => entry.type === 'eleven:generate').length, 1);
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
  const second = await boot({ local, cache, autoStart: true, answers: [{}, { ok: true }], inventoryMaxAgeSeconds: null, inventoryMaxBytes: null });
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
    assert.equal(failed.provider.filter((entry) => entry.type === 'eleven:generate').length, 1);
    local = failed.local; cache = failed.cache;
  } finally { failed.restore(); }
  const restarted = await boot({ local, cache, autoStart: true });
  try { assert.equal(restarted.provider.length, 0); assert.equal(restarted.calls.length, 0); }
  finally { restarted.restore(); }
  const lost = await boot({ lostClaim: true });
  try {
    lost.tick(); await waitFor(() => lost.local.gatewayStatus?.held); lost.tick(); await lost.settled();
    assert.equal(lost.calls.filter((entry) => entry.url.endsWith('/claim')).length, 1);
    assert.equal(lost.provider.filter((entry) => entry.type === 'eleven:generate').length, 0);
  } finally { lost.restore(); }
});

test('wrong mode/disabled never claims; missing model/voice and unknown live voice refuse Generate', async () => {
  for (const mode of ['standalone']) {
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
      assert.equal(worker.provider.filter((entry) => entry.type === 'eleven:generate').length, 0);
      assert.equal(JSON.parse(worker.calls.find((entry) => entry.url.endsWith('/fail')).init.body).ambiguous, false);
    } finally { worker.restore(); }
  }
});

test('standalone saves retained audio after a failed save without generating twice or claiming Gateway work', async () => {
  const saves = [];
  const worker = await boot({ mode: 'standalone', onSave(payload) { saves.push(payload); if (saves.length === 1) throw new Error('Fixture save unavailable.'); } });
  try {
    const item = {
      id: 'local-save', kind: 'paste', target: 'download', downloadPath: 'StoryStudioAudio/Standalone/fixture.mp3',
      text: 'Local fixture narration.', label: 'Fixture', provider: 'elevenlabs_web', voice: 'v1',
      providerSettings: { model: MODEL, speed: 1, modelMeta: { id: MODEL, label: 'Multilingual v2' } },
    };
    assert.equal((await worker.send({ type: 'enqueue', items: [item] })).added, 1);
    await waitFor(() => worker.local.queue?.[0]?.status === 'failed');
    await worker.settled();
    assert.equal(worker.cache.rows.size, 1);
    assert.equal(worker.local.queue[0].phase, 'saving');
    assert.equal((await worker.send({ type: 'retryFailed', id: item.id })).retried, 1);
    await waitFor(() => worker.local.queue?.[0]?.status === 'done');
    await worker.settled();
    assert.equal(worker.provider.filter((entry) => entry.type === 'eleven:generate').length, 1);
    assert.equal(saves.length, 2);
    assert.equal(saves[1].filename, 'StoryStudioAudio/Standalone/fixture.wav');
    assert.deepEqual(Buffer.from(saves[1].url.split(',')[1], 'base64'), AUDIO);
    worker.tick(); await worker.settled();
    assert.equal(worker.calls.length, 0);
    assert.equal(worker.cache.rows.size, 0);
  } finally { worker.restore(); }
});

test('Fish verification pauses fresh work without submission, automatic retry or retryFailed replay', async () => {
  const worker = await boot({ mode: 'standalone' });
  try {
    worker.sync.settings.maxRetries = 4;
    const item = {
      id: 'fish-verification', kind: 'paste', target: 'download', text: 'Do not submit.', label: 'Verification fixture',
      provider: 'fish', voice: 'v1', sceneDuration: 8,
      providerSettings: { model: 'drama-3', modelMeta: { id: 'drama-3', label: 'Drama3' }, speed: 1.1, sceneDuration: 8 },
    };
    assert.equal((await worker.send({ type: 'enqueue', items: [item, { ...item, id: 'later', text: 'Later narration.' }] })).added, 2);
    await waitFor(() => worker.local.queuePaused === true);
    await worker.settled();
    const failed = worker.local.queue[0];
    assert.equal(failed.status, 'failed');
    assert.equal(failed.verificationRequired, true);
    assert.equal(!!failed.ambiguous, false);
    assert.equal(failed.phase, undefined);
    assert.equal(failed.attempts, undefined);
    assert.equal(worker.local.queue[1].status, 'pending');
    assert.deepEqual(failed.providerSettings, item.providerSettings);
    assert.equal(failed.sceneDuration, 8);
    assert.equal((await worker.send({ type: 'retryFailed', id: item.id })).retried, 0);
    assert.equal((await worker.send({ type: 'retryFailed' })).retried, 0);
    worker.tick(); await worker.settled();
    assert.equal(worker.provider.length, 0);
    assert.equal(worker.calls.length, 0);
    assert.equal(worker.cache.rows.size, 0);
  } finally { worker.restore(); }
});

test('standalone saves retained Fish bytes while new Fish generation is unavailable', async () => {
  const cache = cacheStorage();
  const artifact = await putAudioArtifact(cache, artifactDescriptor('fish-retained', 'audio/wav'), { base64: AUDIO.toString('base64'), mime: 'audio/wav' });
  const item = {
    id: 'fish-retained', status: 'failed', phase: 'saving', artifact,
    kind: 'paste', target: 'download', downloadPath: 'StoryStudioAudio/Standalone/retained.wav',
    text: 'Do not regenerate.', label: 'Retained Fish', provider: 'fish', voice: 'v1',
    providerSettings: { model: 'saved-model', modelMeta: { id: 'saved-model', label: 'Saved model' }, sceneDuration: 8 },
  };
  const saves = [];
  const local = { gatewaySettings: { gatewayModeEnabled: false }, queue: [item] };
  const worker = await boot({ mode: 'standalone', local, cache, onSave: (payload) => saves.push(payload) });
  try {
    assert.equal((await worker.send({ type: 'retryFailed', id: item.id })).retried, 1);
    await waitFor(() => worker.local.queue[0].status === 'done');
    await worker.settled();
    assert.equal(saves.length, 1);
    assert.deepEqual(Buffer.from(saves[0].url.split(',')[1], 'base64'), AUDIO);
    assert.deepEqual(worker.local.queue[0].providerSettings, item.providerSettings);
    assert.equal(worker.provider.length, 0);
    assert.equal(worker.calls.length, 0);
    assert.equal(worker.cache.rows.size, 0);
  } finally { worker.restore(); }
});

test('listed Fish models cannot authorize a Gateway claim while verification is unavailable', async () => {
  const worker = await boot({ inventoryReply: { ok: false, error: 'Other provider unavailable.' } });
  try {
    worker.tick(); await waitFor(() => worker.local.gatewayStatus?.idle); await worker.settled();
    assert(worker.provider.some((message) => message.type === 'fish:inventory'));
    const claim = worker.calls.find((entry) => entry.url.endsWith('/claim'));
    assert.deepEqual(JSON.parse(claim.init.body).audioInventory.providers, {});
    assert.equal(worker.provider.some((message) => message.type.endsWith(':generate')), false);
    assert.equal(worker.local.gatewayInFlightPhase, undefined);
  } finally { worker.restore(); }
});

test('upload limit retains output; lock prevents local enqueue from generating concurrently', async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const worker = await boot({ uploadLimit: 1, onGenerate: () => barrier });
  try {
    worker.tick(); await waitFor(() => worker.provider.some((entry) => entry.type === 'eleven:generate'));
    const enqueued = await worker.send({ type: 'enqueue', items: [{ id: 'local', kind: 'paste', target: 'download', text: 'local', label: 'local' }] });
    assert.equal(enqueued.added, 1);
    worker.tick(); await worker.settled();
    assert.equal(worker.provider.filter((entry) => entry.type === 'eleven:generate').length, 1);
    release();
    await waitFor(() => worker.local.gatewayStatus?.held); await worker.settled();
    assert.equal(worker.cache.rows.size, 1);
    assert.equal(worker.calls.filter((entry) => entry.url.endsWith('/result')).length, 0);
    assert.equal(worker.local.queue[0].status, 'pending');
  } finally { release(); worker.restore(); }
});

test('an unreadable provider account attempts no claim and shows unknown balance', async () => {
  const worker = await boot({ accounts: false });
  try {
    worker.tick(); await waitFor(() => worker.local.gatewayStatus?.accountUnavailable); await worker.settled();
    assert.equal(worker.calls.filter((entry) => entry.url.endsWith('/claim')).length, 0);
    assert.equal(worker.calls.filter((entry) => entry.url.endsWith('/telemetry')).length, 0);
    assert.equal(worker.provider.filter((entry) => entry.type === 'eleven:generate').length, 0);
    assert.equal(worker.local.gatewayStatus.balance, 'Unknown');
    assert.match(worker.local.gatewayStatus.error, /no claim was attempted/i);
  } finally { worker.restore(); }
});

test('claim carries a schema 1 account for the job provider and never a numeric balance', async () => {
  const worker = await boot();
  try {
    worker.tick(); await waitFor(() => worker.local.gatewayStatus?.lastJob === JOB.jobId); await worker.settled();
    const claim = claimsFor(worker, JOB.provider)[0];
    const account = JSON.parse(claim.init.body).account;
    assert.equal(account.schema, 1);
    assert.equal(account.provider, JOB.provider);
    assert.equal(account.accountId, 'elevenlabs_web.fixture-account');
    assert.equal(account.signIn, 'signed_in');
    assert.equal(account.readiness, 'ready');
    assert.equal(account.balance, null);
    assert.equal(JSON.stringify(claim.init.body).includes('"balance":{"value"'), false);
  } finally { worker.restore(); }
});

test('a quote preview is reported without a second claim, generation or invented price', async () => {
  const worker = await boot({ quoteRequired: true });
  try {
    worker.tick(); await waitFor(() => worker.local.gatewayStatus?.quoteRequired); await worker.settled();
    assert.equal(worker.calls.filter((entry) => entry.url.endsWith('/claim')).length, 1);
    assert.equal(JSON.parse(worker.calls.find((entry) => entry.url.endsWith('/claim')).init.body).quote, undefined);
    assert.equal(worker.calls.filter((entry) => entry.url.endsWith('/result')).length, 0);
    assert.equal(worker.provider.filter((entry) => entry.type === 'eleven:generate').length, 0);
    assert.equal(worker.local.gatewayStatus.balance, 'Unknown');
    assert.match(worker.local.gatewayStatus.error, /credit quote/i);
  } finally { worker.restore(); }
});
