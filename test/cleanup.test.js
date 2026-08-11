import test from 'node:test';
import assert from 'node:assert/strict';

import { sectionEligibility, storyStudioSection } from '../src/lib/section-contracts.js';

test('accepts whole script, introduction, and numbered chapter contracts', () => {
  assert.deepEqual(storyStudioSection('Script'), { kind: 'script', sectionSlug: 'Script', chapterNumber: null });
  assert.deepEqual(storyStudioSection('Introduction'), { kind: 'intro', sectionSlug: 'Introduction', chapterNumber: null });
  assert.deepEqual(storyStudioSection('Chapter_03'), { kind: 'chapter', sectionSlug: 'Chapter_03', chapterNumber: 3 });
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
