import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../src/content/bridge.js', import.meta.url), 'utf8');

test('bridge transport has random channel, hello handshake, request IDs, and stale-response rejection', () => {
  assert.match(source, /crypto\.randomUUID/);
  assert.match(source, /helloId/);
  assert.match(source, /setInterval/);
  assert.match(source, /clearInterval/);
  assert.match(source, /clearTimeout/);
  assert.match(source, /pending\.set\(id/);
  assert.match(source, /pending\.get\(data\.id/);
  assert.match(source, /clearTimeout\(entry\.timeout\)/);
  assert.match(source, /data\.channel !== channel/);
  assert.match(source, /setTimeout/);
});

test('both providers use the shared helper', () => {
  for (const name of ['fish', 'eleven']) {
    assert.match(readFileSync(new URL('../src/content/' + name + '.js', import.meta.url), 'utf8'), /createIsolatedBridge/);
    assert.match(readFileSync(new URL('../src/content/' + name + '-main.js', import.meta.url), 'utf8'), /createMainBridge/);
  }
});

test('isolated-first startup retries hello until a later MAIN bridge can correlate a call', async () => {
  const listeners = [];
  const window = {
    addEventListener(type, listener) {
      if (type === 'message') listeners.push(listener);
    },
    postMessage(data) {
      queueMicrotask(() => listeners.forEach((listener) => listener({ source: window, data })));
    },
  };
  const context = vm.createContext({
    window,
    crypto: { randomUUID: (() => { let n = 0; return () => 'id-' + (++n); })() },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    Uint8Array,
    Map,
    Promise,
    Error,
    Object,
  });
  vm.runInContext(source, context);
  const isolated = context.__STORY_STUDIO_BRIDGE__.createIsolatedBridge({
    requestKind: 'TEST_REQ',
    responseKind: 'TEST_RES',
    label: 'Test',
  });
  await new Promise((resolve) => setTimeout(resolve, 35));
  context.__STORY_STUDIO_BRIDGE__.createMainBridge({
    requestKind: 'TEST_REQ',
    responseKind: 'TEST_RES',
    handlers: { echo: ({ value }) => value },
  });
  const result = isolated.callMain('echo', { value: 'correct' });
  window.postMessage({ kind: 'TEST_RES', channel: 'stale-channel', id: 'id-stale', ok: true, result: 'stale' });
  assert.equal(await result, 'correct');
});
