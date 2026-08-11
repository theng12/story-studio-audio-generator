const reasonFor = (slug) =>
  'Unsupported Story Studio section "' + slug + '". Choose the whole script, Introduction, or a numbered chapter.';

export function storyStudioSection(sectionSlug) {
  const slug = String(sectionSlug || '').trim();
  if (slug === 'Script') return { kind: 'script', sectionSlug: slug, chapterNumber: null };
  if (slug === 'Introduction') return { kind: 'intro', sectionSlug: slug, chapterNumber: null };
  const match = slug.match(/^Chapter_(\d+)$/);
  if (!match) return null;
  const chapterNumber = Number(match[1]);
  if (!Number.isInteger(chapterNumber) || chapterNumber < 1) return null;
  return { kind: 'chapter', sectionSlug: 'Chapter_' + String(chapterNumber).padStart(2, '0'), chapterNumber };
}

export function sectionEligibility(sectionSlug) {
  const slug = String(sectionSlug || '').trim();
  const contract = storyStudioSection(slug);
  return contract
    ? { supported: true, ...contract, reason: '' }
    : { supported: false, sectionSlug: slug, kind: 'unsupported', chapterNumber: null, reason: reasonFor(slug || 'unknown') };
}
