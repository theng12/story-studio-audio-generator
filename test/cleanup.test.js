import test from 'node:test';
import assert from 'node:assert/strict';

import { sectionEligibility, storyStudioSection } from '../src/lib/section-contracts.js';
import { readFileSync } from 'node:fs';

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
