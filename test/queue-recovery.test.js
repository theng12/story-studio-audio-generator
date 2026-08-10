import test from 'node:test';
import assert from 'node:assert/strict';
import {
  artifactDescriptor,
  artifactsForDiscardedItems,
  deleteAudioArtifact,
  getAudioArtifact,
  putAudioArtifact,
} from '../src/lib/audio-artifacts.js';
import {
  RECOVERY_REVIEW_MESSAGE,
  isAmbiguousBridgeFailure,
  recoverQueueAfterRestart,
  retryQueueItem,
  workKindForQueueItem,
} from '../src/lib/queue-recovery.js';

test('restart resumes saved audio without calling a provider again', () => {
  const artifact = artifactDescriptor('saved-item', 'audio/mpeg');
  const { queue } = recoverQueueAfterRestart([{ id: 'saved-item', status: 'running', phase: 'saving', artifact }]);

  assert.deepEqual(queue, [{ id: 'saved-item', status: 'pending', phase: 'saving', artifact }]);
  assert.equal(workKindForQueueItem(queue[0]), 'save');
});

test('restart quarantines a generation whose provider outcome is unknown', () => {
  const { queue } = recoverQueueAfterRestart([
    { id: 'during-provider', status: 'running', phase: 'generating' },
    { id: 'legacy-running', status: 'running' },
    { id: 'lost-artifact', status: 'running', phase: 'saving' },
  ]);

  for (const item of queue) {
    assert.equal(item.status, 'failed');
    assert.equal(item.ambiguous, true);
    assert.equal(item.requiresLocalReview, true);
    assert.equal(item.error, RECOVERY_REVIEW_MESSAGE);
    assert.equal(workKindForQueueItem(item), 'review');
  }
});

test('a saving phase without its artifact can never fall through to generation', () => {
  assert.equal(workKindForQueueItem({ id: 'missing', status: 'pending', phase: 'saving' }), 'review');
});

test('retry keeps a saved artifact in the save-only path and refuses uncertain work', () => {
  const artifact = artifactDescriptor('save-failed', 'audio/mpeg');
  assert.deepEqual(retryQueueItem({ id: 'save-failed', status: 'failed', phase: 'saving', artifact, attempts: 2, error: 'Studio offline' }), {
    id: 'save-failed', status: 'pending', phase: 'saving', artifact, attempts: 0,
  });
  assert.equal(retryQueueItem({ id: 'unknown', status: 'failed', ambiguous: true, requiresLocalReview: true }), null);
});

test('only post-submission bridge failures are treated as uncertain', () => {
  assert.equal(isAmbiguousBridgeFailure('Could not establish connection. Receiving end does not exist.'), false);
  assert.equal(isAmbiguousBridgeFailure('The message port closed before a response was received.'), true);
});

test('discarded queue history identifies every cached artifact for cleanup', () => {
  const saved = artifactDescriptor('saved', 'audio/mpeg');
  const discarded = artifactDescriptor('discarded', 'audio/wav');
  assert.deepEqual(
    artifactsForDiscardedItems(
      [{ id: 'saved', artifact: saved }, { id: 'discarded', artifact: discarded }],
      [{ id: 'saved', artifact: saved }],
    ),
    [discarded],
  );
});

test('Cache Storage persists audio outside chrome.storage and returns it unchanged', async () => {
  const entries = new Map();
  const cache = {
    async put(key, response) { entries.set(key, response.clone()); },
    async match(key) { return entries.get(key)?.clone(); },
    async delete(key) { return entries.delete(key); },
  };
  const cacheStorage = { async open() { return cache; } };
  const descriptor = artifactDescriptor('stable item', 'audio/mpeg');

  await putAudioArtifact(cacheStorage, descriptor, { base64: 'AQID', mime: 'audio/mpeg' });
  assert.deepEqual(descriptor, { id: 'stable item', key: 'https://story-studio-audio.invalid/artifacts/stable%20item', mime: 'audio/mpeg' });
  assert.deepEqual(await getAudioArtifact(cacheStorage, descriptor), { base64: 'AQID', mime: 'audio/mpeg' });
  await deleteAudioArtifact(cacheStorage, descriptor);
  assert.equal(await getAudioArtifact(cacheStorage, descriptor), null);
});
