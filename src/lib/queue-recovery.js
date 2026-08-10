export const RECOVERY_REVIEW_MESSAGE = 'Review required: generation may have reached the provider, so this item will not retry automatically. Check the provider tab, then re-queue only if no audio was created.';

export function isAmbiguousBridgeFailure(error) {
  return !/receiving end does not exist/i.test(String(error?.message || error));
}

export function markGeneratedAudioPersistenceFailure(error) {
  return Object.assign(
    new Error(`Audio was generated, but its recovery state could not be persisted: ${error?.message || error}`),
    { ambiguous: true },
  );
}

export function canHandleInFlightFailure(item) {
  return item?.status === 'running';
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
    if ((item.phase === 'saving' && item.artifact?.key) || (item.phase === 'downloading' && item.downloadId)) {
      return { ...item, status: 'pending' };
    }
    return reviewItem(item);
  });
  return { queue: recovered, changed };
}

export function workKindForQueueItem(item) {
  if (item?.ambiguous || item?.requiresLocalReview) return 'review';
  if (item?.phase === 'saving') return item.artifact?.key ? 'save' : 'review';
  if (item?.phase === 'downloading') return item.downloadId ? 'download' : 'review';
  return 'generate';
}

export function retryQueueItem(item) {
  if (!item || item.status !== 'failed' || item.ambiguous || item.requiresLocalReview) return null;
  const next = { ...item, status: 'pending', attempts: 0 };
  delete next.error;
  delete next.startedAt;
  delete next.finishedAt;
  delete next.durationMs;
  if (next.phase === 'downloading' && next.downloadInterrupted) {
    next.phase = 'saving';
    delete next.downloadId;
    delete next.downloadInterrupted;
  }
  return next;
}
