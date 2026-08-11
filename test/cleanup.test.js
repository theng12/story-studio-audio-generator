import test from 'node:test';
import assert from 'node:assert/strict';

import { sectionEligibility, storyStudioSection } from '../src/lib/section-contracts.js';
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

test('startup migrates legacy local credentials without invoking login or getCredentials', async () => {
  const sync = storageArea({ settings: { studioBaseUrl: 'https://studio.example.test', theme: 'dark' } });
  const local = storageArea({ studioCredentials: { username: 'alice', password: 'legacy-secret' } });
  const session = storageArea();
  globalThis.chrome = { storage: { sync, local, session } };
  const { getSettings } = await import('../src/lib/config.js');

  const settings = await getSettings();

  assert.equal(settings.studioBaseUrl, 'https://studio.example.test');
  assert.equal(settings.studioUsername, 'alice');
  assert.deepEqual(local.values, { studioBaseUrl: 'https://studio.example.test', studioUsername: 'alice' });
  assert.deepEqual(session.values, { studioPassword: 'legacy-secret' });
  assert.deepEqual(sync.values.settings, { theme: 'dark', mode: 'studio' });
});

test('repeated startup migration leaves no legacy credential or new writes', async () => {
  const sync = storageArea({ settings: { theme: 'dark' } });
  const local = storageArea({ studioBaseUrl: 'https://studio.example.test', studioCredentials: { username: 'alice', password: 'legacy-secret' } });
  const session = storageArea();
  globalThis.chrome = { storage: { sync, local, session } };
  const { getSettings } = await import('../src/lib/config.js');

  await getSettings();
  const before = { local: { ...local.calls }, session: { ...session.calls }, sync: { ...sync.calls } };
  await getSettings();

  assert.deepEqual(local.values, { studioBaseUrl: 'https://studio.example.test', studioUsername: 'alice' });
  assert.deepEqual(session.values, { studioPassword: 'legacy-secret' });
  assert.deepEqual(local.calls, { get: before.local.get + 1, set: before.local.set, remove: before.local.remove });
  assert.deepEqual(session.calls, { get: before.session.get + 1, set: before.session.set, remove: before.session.remove });
  assert.deepEqual(sync.calls, { get: before.sync.get + 1, set: before.sync.set, remove: before.sync.remove });
});

test('startup returns a username migrated from legacy sync settings', async () => {
  const sync = storageArea({ settings: { studioBaseUrl: 'https://studio.example.test', studioUsername: 'alice' } });
  const local = storageArea();
  const session = storageArea();
  globalThis.chrome = { storage: { sync, local, session } };
  const { getSettings } = await import('../src/lib/config.js');

  const settings = await getSettings();

  assert.equal(settings.studioUsername, 'alice');
  assert.equal(local.values.studioUsername, 'alice');
});

test('accepts whole script, introduction, and numbered chapter contracts', () => {
  assert.deepEqual(storyStudioSection('Script'), { kind: 'script', sectionSlug: 'Script', chapterNumber: null });
  assert.deepEqual(storyStudioSection('Introduction'), { kind: 'intro', sectionSlug: 'Introduction', chapterNumber: null });
  assert.deepEqual(storyStudioSection('Chapter_03'), { kind: 'chapter', sectionSlug: 'Chapter_03', chapterNumber: 3 });
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

test('Story Studio and Fleet boundaries are enforced', async () => {
  const background = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
  const popup = readFileSync(new URL('../src/popup/popup.js', import.meta.url), 'utf8');
  const options = readFileSync(new URL('../src/options/options.html', import.meta.url), 'utf8');
  assert.match(popup, /sectionEligibility\(s\)/);
  assert.match(background, /storyStudioSection\(item\.sectionSlug\)/);
  assert.match(background, /Unsupported Story Studio section/);
  assert.match(background, /if \(await preflightStudioPassword\(q\[currentIdx\], settings\)\) return;/);
  assert.match(background, /actions: \['pause_after_current', 'resume_hub_pause', 'clear_pending'\]/);
  assert.doesNotMatch(background, /case 'retry_failed'/);
  assert.match(options, /browser session only/);
  const { StudioClient } = await import('../src/lib/story-studio.js');
  assert.equal(typeof StudioClient.prototype.whoami, 'undefined');
});

test('release metadata documents cleanup without stale claims', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.equal(manifest.version, '0.7.26');
  assert.match(changelog, /^## 0\.7\.26 - Audio Generator cleanup/m);
  assert.match(readme, /signed-in provider web sessions/i);
  assert.doesNotMatch(readme, /api\.fish\.audio|api\.us\.elevenlabs|securetoken\.googleapis|Coming soon/i);
});

test('keeps an unknown missing section visible but unsupported', () => {
  assert.deepEqual(sectionEligibility('Appendix_A'), {
    supported: false,
    sectionSlug: 'Appendix_A',
    kind: 'unsupported',
    chapterNumber: null,
    reason: 'Unsupported Story Studio section "Appendix_A". Choose the whole script, Introduction, or a numbered chapter.',
  });
  assert.equal(storyStudioSection('Chapter_0'), null);
  assert.equal(storyStudioSection('Chapter_abc'), null);
});
