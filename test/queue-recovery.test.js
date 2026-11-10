import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  artifactDescriptor,
  artifactsForDiscardedItems,
  deleteAudioArtifact,
  deleteAudioArtifacts,
  getAudioArtifact,
  putAudioArtifact,
  sweepOrphanedAudioArtifacts,
} from '../src/lib/audio-artifacts.js';
import {
  RECOVERY_REVIEW_MESSAGE,
  canHandleInFlightFailure,
  isAmbiguousBridgeFailure,
  markGeneratedAudioPersistenceFailure,
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

test('restart observes an existing download and quarantines a download without an id', () => {
  const artifact = artifactDescriptor('download', 'audio/mpeg');
  const { queue } = recoverQueueAfterRestart([
    { id: 'download', status: 'running', phase: 'downloading', downloadId: 17, artifact },
    { id: 'lost-download', status: 'running', phase: 'downloading', artifact },
  ]);

  assert.equal(workKindForQueueItem(queue[0]), 'download');
  assert.equal(queue[0].status, 'pending');
  assert.equal(workKindForQueueItem(queue[1]), 'review');
  assert.equal(queue[1].requiresLocalReview, true);
});

test('retry keeps a saved artifact in the save-only path and refuses uncertain work', () => {
  const artifact = artifactDescriptor('save-failed', 'audio/mpeg');
  assert.deepEqual(retryQueueItem({ id: 'save-failed', status: 'failed', phase: 'saving', artifact, attempts: 2, error: 'Studio offline' }), {
    id: 'save-failed', status: 'pending', phase: 'saving', artifact, attempts: 0,
  });
  assert.equal(retryQueueItem({ id: 'unknown', status: 'failed', ambiguous: true, requiresLocalReview: true }), null);
  assert.equal(retryQueueItem({ id: 'verification', status: 'failed', verificationRequired: true, ambiguous: false }), null);
  assert.deepEqual(retryQueueItem({ id: 'interrupted', status: 'failed', phase: 'downloading', downloadId: 12, downloadInterrupted: true, artifact }), {
    id: 'interrupted', status: 'pending', phase: 'saving', artifact, attempts: 0,
  });
  assert.deepEqual(retryQueueItem({ id: 'completed', status: 'failed', phase: 'downloading', downloadId: 13, artifact }), {
    id: 'completed', status: 'pending', phase: 'downloading', downloadId: 13, artifact, attempts: 0,
  });
  assert.deepEqual(retryQueueItem({ id: 'download', status: 'failed', phase: 'saving', artifact }), {
    id: 'download', status: 'pending', phase: 'saving', artifact, attempts: 0,
  });
});

test('post-save failures never resurrect an already completed item', () => {
  assert.equal(canHandleInFlightFailure({ status: 'running' }), true);
  assert.equal(canHandleInFlightFailure({ status: 'done' }), false);
});

test('only post-submission bridge failures are treated as uncertain', () => {
  assert.equal(isAmbiguousBridgeFailure('Could not establish connection. Receiving end does not exist.'), false);
  assert.equal(isAmbiguousBridgeFailure('The message port closed before a response was received.'), true);
});

test('cache and queue persistence failures after a provider result are ambiguous', () => {
  for (const reason of ['Cache put failed', 'Queue write failed']) {
    const error = markGeneratedAudioPersistenceFailure(new Error(reason));
    assert.equal(error.ambiguous, true);
    assert.match(error.message, /Audio was generated/);
    assert.match(error.message, new RegExp(reason));
  }
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

test('orphan artifact sweeping keeps queued artifacts and ignores cleanup failures', async () => {
  const retained = artifactDescriptor('retained');
  const orphan = artifactDescriptor('orphan');
  const failed = artifactDescriptor('failed-delete');
  const deleted = [];
  const cache = {
    async keys() { return [{ url: retained.key }, { url: orphan.key }, { url: failed.key }, { url: 'https://example.test/not-audio' }]; },
    async delete(request) {
      const key = request.url || request;
      if (key === failed.key) throw new Error('storage unavailable');
      deleted.push(key);
      return true;
    },
  };
  await sweepOrphanedAudioArtifacts({ async open() { return cache; } }, [{ artifact: retained }]);
  assert.deepEqual(deleted, [orphan.key]);
});

test('artifact cleanup failures are best-effort', async () => {
  const descriptor = artifactDescriptor('cleanup-failure');
  await assert.doesNotReject(deleteAudioArtifacts({ async open() { throw new Error('cache unavailable'); } }, [descriptor]));
});

test('download launch checkpoints before Chrome accepts it and only interruptions reset it', () => {
  const source = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
  assert.match(source, /downloading\.phase = 'downloading';[\s\S]{0,180}await setQueue\(q\);[\s\S]{0,180}started = await startDownload/);
  assert.match(source, /throw markGeneratedAudioPersistenceFailure\(error\);[\s\S]{0,120}r = await observeDownload/);
  assert.match(source, /if \(e\?\.downloadInterrupted && it\.phase === 'downloading'\)/);
});
