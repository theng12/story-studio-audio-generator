import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  assert.deepEqual(manifest.host_permissions.sort(), ['http://127.0.0.1/*', 'http://[::1]/*', 'http://localhost/*', 'https://elevenlabs.io/*', 'https://fish.audio/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.doesNotMatch(JSON.stringify(manifest), /api\.fish\.audio|api\.us\.elevenlabs|securetoken\.googleapis/);
});

test('Gateway mode is unusable without the loopback host permissions', () => {
  // Gateway mode fetches http://127.0.0.1:8787; a host without a port matches every port.
  // Without these three, every connect fails with "Failed to fetch".
  const modeSource = readFileSync(new URL('../src/lib/config.js', import.meta.url), 'utf8');
  if (!modeSource.includes("'gateway'")) return;
  for (const host of ['http://127.0.0.1/*', 'http://localhost/*', 'http://[::1]/*']) {
    assert.ok(manifest.host_permissions.includes(host), `${host} is declared`);
  }
});

test('a fixed key keeps the extension id stable across versioned folders', () => {
  // Without a key Chrome derives a new id from the folder path every release, so a seeded
  // extension id and its storage are orphaned. This pins the id.
  assert.ok(manifest.key, 'the manifest carries a fixed key');
  const der = Buffer.from(manifest.key, 'base64');
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  const id = [...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join('');
  assert.equal(id, 'nokgedfmpknhbdenojdfkdfiagocclci');
});

test('the Gateway pane shows the Relay-owned connection honestly', () => {
  const popup = readFileSync(new URL('../src/popup/popup.js', import.meta.url), 'utf8');
  assert.match(popup, /Connected through Relay/, 'the seeded state is named');
  assert.match(popup, /gatewayRelayMachineId/, 'the Relay marker is read');
  assert.match(popup, /gatewayReadiness/, 'the shared readiness object is read');
  assert.match(popup, /readiness\.reason/, 'a blocked readiness shows its reason');
});
