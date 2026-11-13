import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

function storageArea(initial = {}) {
  const values = { ...initial };
  const calls = { get: 0, set: 0, remove: 0 };
  return {
    values,
    calls,
    async get(keys) {
      calls.get++;
      const names = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys || {});
      return Object.fromEntries(names.filter((name) => name in values).map((name) => [name, values[name]]));
    },
    async set(patch) { calls.set++; Object.assign(values, patch); },
    async remove(keys) {
      calls.remove++;
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
}

test('stored Studio and unknown modes migrate silently to Standalone', async () => {
  const sync = storageArea({ settings: { mode: 'studio', theme: 'dark' } });
  const local = storageArea();
  globalThis.chrome = { storage: { sync, local } };
  const { getSettings, DEFAULTS } = await import('../src/lib/config.js');

  assert.equal(DEFAULTS.mode, 'standalone');
  const settings = await getSettings();
  assert.equal(settings.mode, 'standalone');
  assert.deepEqual(sync.values.settings, { mode: 'standalone', theme: 'dark' });

  sync.values.settings = { mode: 'something-else' };
  const unknown = await getSettings();
  assert.equal(unknown.mode, 'standalone');
  assert.deepEqual(sync.values.settings, { mode: 'standalone' });
});

test('no shipped source accepts the removed Studio mode', () => {
  for (const file of [
    '../src/lib/config.js',
    '../src/background.js',
    '../src/popup/popup.js',
    '../src/popup/popup.html',
    '../src/options/options.js',
    '../src/options/options.html',
  ]) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /['"]studio['"]/, file);
  }
});

test('generation has no provider-default model or voice fallback', () => {
  const background = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
  const eleven = readFileSync(new URL('../src/content/eleven-main.js', import.meta.url), 'utf8');
  assert.match(background, /assertProviderSettingsSnapshot\(providerId, providerSettings\)/);
  assert.match(background, /const voice = job\.voice;/);
  assert.doesNotMatch(background, /settings\.voiceByProvider\?\./);
  assert.match(eleven, /if \(!model\) throw new Error/);
  assert.doesNotMatch(eleven, /model \|\| MODEL/);
});

test('release metadata documents cleanup without stale claims', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.equal(changelog.match(/^## (\d+\.\d+\.\d+)/m)?.[1], manifest.version);
  assert.match(changelog, /^## 0\.7\.31 — /m);
  assert.match(readme, /signed-in provider web sessions/i);
  assert.doesNotMatch(readme, /api\.fish\.audio|api\.us\.elevenlabs|securetoken\.googleapis|Coming soon/i);
});

test('Fleet Hub is fully removed', () => {
  for (const file of ['../src/options/options.html', '../src/lib/config.js', '../src/background.js']) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /fleet/i, file);
  }
});

test('options page keeps only appearance and Gateway; the panel offers two modes', () => {
  const html = readFileSync(new URL('../src/options/options.html', import.meta.url), 'utf8');
  const popup = readFileSync(new URL('../src/popup/popup.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /flowWorkspaceUrl|grantFlow|flowGrantStatus/);
  assert.doesNotMatch(html, /studioSection|studioBaseUrl|studioUsername|studioPassword|grantAccess|testConnection|loginStatus/);
  assert.match(html, /id="gatewayModeEnabled"/);
  assert.match(popup, /<option value="standalone">/);
  assert.match(popup, /<option value="gateway">/);
});
