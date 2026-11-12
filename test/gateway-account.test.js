import test from 'node:test';
import assert from 'node:assert/strict';
import { audioAccount, audioObservation, balanceLabel } from '../src/lib/gateway-account.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const OBSERVED = '2026-11-12T08:00:00.000Z';
const providers = ['fish', 'elevenlabs_web'];

test('unknown balance renders as unknown and never as zero', () => {
  for (const account of [null, undefined, {}, { balance: null }, { balance: '0' }, { balance: { value: null, unit: 'credits' } }, { balance: { value: Number.NaN, unit: 'credits' } }]) {
    assert.equal(balanceLabel(account), 'Unknown');
    assert.notEqual(balanceLabel(account), '0');
  }
  assert.equal(balanceLabel({ balance: { value: 12, unit: 'credits' } }), '12 credits');
});

test('audio account is schema 1 for its own provider with a null balance in every state', () => {
  for (const provider of providers) {
    for (const [signedIn, inventoryLive, readiness] of [[true, true, 'ready'], [true, false, 'unknown'], [false, true, 'unknown']]) {
      const account = audioAccount({ provider, accountId: `${provider}.fixture`, source: `extension.audio.${provider}`, observedAt: OBSERVED, signedIn, inventoryLive });
      assert.equal(account.schema, 1);
      assert.equal(account.provider, provider);
      assert.ok(SLUG.test(account.provider));
      assert.ok(ID.test(account.accountId));
      assert.ok(SLUG.test(account.source));
      assert.equal(account.observedAt, OBSERVED);
      assert.equal(account.balance, null);
      assert.equal(account.resetAt, null);
      assert.equal(account.creditBuckets, null);
      assert.equal(account.readiness, readiness);
      assert.equal(account.signIn, signedIn ? 'signed_in' : 'signed_out');
    }
  }
});

test('an absent or unreadable identity yields no account and therefore no claim', () => {
  const base = { provider: 'fish', source: 'extension.audio.fish', observedAt: OBSERVED, signedIn: true, inventoryLive: true };
  for (const accountId of [undefined, null, '', ' bad id', 'x'.repeat(121)]) {
    assert.equal(audioAccount({ ...base, accountId }), null);
    assert.equal(audioObservation({ ...base, accountId }), null);
  }
  assert.equal(audioAccount({ ...base, accountId: 'fish.a', provider: 'Flow' }), null);
  assert.equal(audioAccount({ ...base, accountId: 'fish.a', source: 'Extension Audio' }), null);
});

test('an observation carries the worker state the Gateway validates alongside the account', () => {
  const observation = audioObservation({
    provider: 'elevenlabs_web', accountId: 'elevenlabs_web.fixture', signedIn: true, inventoryLive: true,
    source: 'extension.audio.elevenlabs_web', observedAt: OBSERVED, paused: false, controlRevision: 'rev-1',
  });
  assert.equal(observation.account.provider, 'elevenlabs_web');
  assert.equal(observation.account.balance, null);
  assert.equal(observation.account.controlRevision, 'rev-1');
  assert.equal(observation.account.nextEligibleAt, OBSERVED);
  assert.equal(observation.account.enabled, true);
  assert.equal(observation.account.paused, false);
  assert.equal(observation.account.attention, false);
  assert.equal(observation.account.activity, 'idle');
  assert.deepEqual(observation.telemetry.state.source, 'extension.audio.elevenlabs_web');
  assert.deepEqual(observation.telemetry.state.observedAt, OBSERVED);
  const paused = audioObservation({ provider: 'fish', accountId: 'fish.a', signedIn: true, inventoryLive: true, source: 'extension.audio.fish', observedAt: OBSERVED, paused: true });
  assert.equal(paused.account.paused, true);
  assert.equal(paused.account.activity, 'waiting');
});
