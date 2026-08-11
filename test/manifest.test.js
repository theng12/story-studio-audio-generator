import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const declared = [manifest.background.service_worker, manifest.side_panel.default_path, manifest.options_page, ...Object.values(manifest.action.default_icon), ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap((entry) => entry.js)];

test('manifest declares only existing package files', () => {
  for (const file of declared) assert.equal(existsSync(new URL(file, root)), true, file);
});

test('manifest keeps only extension and provider-page permissions', () => {
  assert.deepEqual(manifest.permissions.sort(), ['alarms', 'downloads', 'sidePanel', 'storage', 'tabs']);
  assert.deepEqual(manifest.host_permissions.sort(), ['http://127.0.0.1/*', 'http://localhost/*', 'https://elevenlabs.io/*', 'https://fish.audio/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.doesNotMatch(JSON.stringify(manifest), /api\.fish\.audio|api\.us\.elevenlabs|securetoken\.googleapis/);
});
