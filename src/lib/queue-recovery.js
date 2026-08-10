export const RECOVERY_REVIEW_MESSAGE = 'Review required: generation may have reached the provider, so this item will not retry automatically. Check the provider tab, then re-queue only if no audio was created.';

export function isAmbiguousBridgeFailure(error) {
  return !/receiving end does not exist/i.test(String(error?.message || error));
}

function reviewItem(item) {
  return {
    ...item,
    status: 'failed',
    ambiguous: true,
    requiresLocalReview: true,
    error: RECOVERY_REVIEW_MESSAGE,
    finishedAt: Date.now(),
  };
}

export function recoverQueueAfterRestart(queue) {
  let changed = false;
  const recovered = (queue || []).map((item) => {
    if (item.status !== 'running') return item;
    changed = true;
    if (item.phase === 'saving' && item.artifact?.key) return { ...item, status: 'pending' };
    return reviewItem(item);
  });
  return { queue: recovered, changed };
}

export function workKindForQueueItem(item) {
  if (item?.ambiguous || item?.requiresLocalReview) return 'review';
  if (item?.phase === 'saving') return item.artifact?.key ? 'save' : 'review';
  return 'generate';
}

export function retryQueueItem(item) {
  if (!item || item.status !== 'failed' || item.ambiguous || item.requiresLocalReview) return null;
  const next = { ...item, status: 'pending', attempts: 0 };
  delete next.error;
  delete next.startedAt;
  delete next.finishedAt;
  delete next.durationMs;
  return next;
}
