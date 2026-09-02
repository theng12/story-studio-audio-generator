import { existsSync, readFileSync } from 'node:fs';
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

test('isolated provider consumers resolve the bridge from their isolated global', () => {
  for (const name of ['fish', 'eleven']) {
    let messageListener;
    let runtimeListener;
    const window = {
      addEventListener(type, listener) {
        if (type === 'message') messageListener = listener;
      },
      postMessage() {},
    };
    const context = vm.createContext({
      window,
      chrome: { runtime: { onMessage: { addListener(listener) { runtimeListener = listener; } } } },
      crypto: { randomUUID: () => 'test-id' },
      setTimeout: () => 1,
      clearTimeout() {},
      setInterval: () => 1,
      clearInterval() {},
      Uint8Array,
      Map,
      Promise,
      Error,
      Object,
    });
    vm.runInContext(source, context);
    assert.ok(context.__STORY_STUDIO_BRIDGE__);
    assert.equal(window.__STORY_STUDIO_BRIDGE__, undefined);
    assert.doesNotThrow(() => vm.runInContext(readFileSync(new URL('../src/content/' + name + '.js', import.meta.url), 'utf8'), context));
    assert.equal(typeof messageListener, 'function');
    assert.equal(typeof runtimeListener, 'function');
  }
});

test('world-specific bridge entries initialize the real provider consumers', () => {
  const root = new URL('../', import.meta.url);
  const entries = [
    { world: 'main', bridge: 'src/content/bridge-main.js', consumer: 'src/content/fish-main.js' },
    { world: 'isolated', bridge: 'src/content/bridge-isolated.js', consumer: 'src/content/fish.js' },
    { world: 'main', bridge: 'src/content/bridge-main.js', consumer: 'src/content/eleven-main.js' },
    { world: 'isolated', bridge: 'src/content/bridge-isolated.js', consumer: 'src/content/eleven.js' },
  ];
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(
    manifest.content_scripts.map(({ world = 'isolated', js }) => ({ world: world.toLowerCase(), bridge: js[0], consumer: js[1] })),
    entries
  );

  for (const entry of entries) {
    assert.equal(existsSync(new URL(entry.bridge, root)), true, entry.bridge);
    let messageListener;
    let runtimeListener;
    const window = {
      addEventListener(type, listener) {
        if (type === 'message') messageListener = listener;
      },
      postMessage() {},
    };
    const context = vm.createContext({
      window,
      chrome: { runtime: { onMessage: { addListener(listener) { runtimeListener = listener; } } } },
      crypto: { randomUUID: () => 'test-id' },
      localStorage: { getItem: () => '' },
      document: { querySelectorAll: () => [] },
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      btoa: () => '',
      setTimeout: () => 1,
      clearTimeout() {},
      setInterval: () => 1,
      clearInterval() {},
      Uint8Array,
      Map,
      Promise,
      Error,
      Object,
    });
    if (entry.world === 'main') {
      context.window = context;
      context.addEventListener = window.addEventListener;
      context.postMessage = window.postMessage;
    }
    vm.runInContext(readFileSync(new URL(entry.bridge, root), 'utf8'), context);
    assert.doesNotThrow(() => vm.runInContext(readFileSync(new URL(entry.consumer, root), 'utf8'), context));
    assert.equal(typeof messageListener, 'function');
    if (entry.world === 'isolated') assert.equal(typeof runtimeListener, 'function');
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
