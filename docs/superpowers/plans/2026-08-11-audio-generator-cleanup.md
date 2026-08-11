# Audio Generator Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Audio Generator cleanup by enforcing signed web-session provider contracts, truthful Story Studio queue eligibility, session-only credentials, correlated provider bridges, shipped Fleet behavior, and release-aligned documentation without weakening paid-request recovery.

**Architecture:** Keep the existing MV3 service worker as the only generation entry point and keep Fish Audio plus ElevenLabs Web behind their existing MAIN-world/isolated-world bridges. Add one shared classic-script bridge helper for a random per-page channel and random request IDs, one pure Story Studio section-contract helper used by the popup and worker, and keep storage/Fleet behavior in the existing modules rather than adding a framework or dependency.

**Tech Stack:** Chrome Manifest V3, vanilla JavaScript, classic content scripts, Node.js built-in node:test, node:assert/strict, node:fs, node:vm, and browser-native chrome.storage, chrome.tabs, chrome.downloads, chrome.alarms, crypto.subtle, and window.postMessage.

## Global Constraints

- Keep only Fish Audio and ElevenLabs Web; both use the account already signed in on the provider website and consume that website account's quota or credits.
- The extension must not accept provider developer API keys or add separately billed developer API routes.
- Preserve Fish account-voice/model discovery and its conservative fallback when the signed-page model control is unreadable.
- Preserve ElevenLabs account-voice/TTS-model/limit/control discovery and its conservative fallback.
- Every queued item snapshots the exact discovered model metadata and voice ID; an unknown or incomplete model snapshot fails before generation rather than silently falling back.
- The background queue remains the only extension component authorized to start generation.
- Add an unpredictable per-session bridge channel and unpredictable per-request correlation; ignore unrelated page messages and stale responses.
- The bridge hello is retried at a bounded interval until the random channel is acknowledged or the bounded startup timeout expires; readiness clears both retry and timeout handles. This protects against unrelated or stale page messages, not a compromised provider page, which remains an explicit non-goal.
- Preserve ambiguous-outcome classification, cached-audio recovery, download checkpointing, sequential pacing, and the rule that no uncertain paid request is automatically replayed.
- Only valid Story Studio whole-script, introduction, and numbered-chapter contracts may be queued; unknown missing filenames stay visible with an actionable unsupported-section reason but cannot reach provider generation or audio ingest.
- Store the Story Studio URL and username in chrome.storage.local.
- Store the Story Studio password in chrome.storage.session, not persistent local storage.
- After a browser restart, remote Story Studio work pauses and asks for the password again; generated audio and queue evidence remain preserved.
- Remove any legacy persisted Story Studio password during settings migration.
- Remove the proven-dead StudioClient.whoami() path.
- Preserve Story Studio audio ingestion, standalone downloads, section filenames, and remote host-permission handling.
- Fleet is opt-in and may send sanitized telemetry plus signed, revision-checked pause_after_current, resume_hub_pause, and clear_pending commands only.
- Fleet must not alter provider, model, voice, pacing, credentials, or site-access settings.
- Keep the existing visual layout; change correctness and copy only, not the layout system.
- Add no runtime or development dependencies.
- Retain all existing 29 provider/recovery tests and make the full Node test suite pass.
- Target release version is 0.7.26, based on the current manifest.json version 0.7.25.
- This planning turn creates only this plan file; leave production files and the untracked graphify-out/ directory unchanged.

---

## File Map (Locked)

Create:

- src/lib/section-contracts.js: pure Story Studio section parsing, queue-contract validation, and unsupported-section copy.
- src/content/bridge.js: shared classic-script handshake, random session-channel, request-ID, timeout, and response-correlation helper loaded separately in MAIN and isolated worlds.
- test/cleanup.test.js: dependency-free tests for section eligibility, storage migration, provider snapshot/generation guards, Fleet contracts, and preserved queue boundaries.
- test/manifest.test.js: dependency-free manifest permission and declared-file validation.
- test/bridge.test.js: dependency-free provider bridge transport tests.

Modify:

- src/content/fish.js, src/content/fish-main.js, src/content/eleven.js, src/content/eleven-main.js: use the shared correlated bridge and preserve provider fetch/error behavior.
- src/lib/config.js: local URL/username, session password, and legacy migration.
- src/lib/providers.js: exact provider snapshots and no-silent-fallback validation.
- src/lib/story-studio.js: remove whoami and preserve status-bearing REST errors.
- src/background.js: queue-contract/provider-snapshot validation, remote-auth pause, artifact recovery, and approved Fleet commands.
- src/popup/popup.js and src/popup/popup.html: unsupported rows, exact queue snapshots, and actual Fleet copy.
- src/options/options.js and src/options/options.html: local/session credentials and actual Fleet copy.
- manifest.json: bridge declarations, provider-page-only host permissions, and version 0.7.26.
- README.md and CHANGELOG.md: product documentation and release entry.
- test/providers.test.js and test/queue-recovery.test.js: retain existing coverage and add focused assertions.

Do not modify graphify-out/, icons, CSS, or unrelated source files.

## Interfaces Locked Before Implementation

- storyStudioSection(sectionSlug) returns { kind: 'script' | 'intro' | 'chapter', sectionSlug: string, chapterNumber: number | null } or null.
- sectionEligibility(sectionSlug) returns { supported, kind, sectionSlug, chapterNumber, reason }.
- snapshotProviderJob(providerId, settings, inventory, voiceId, displayedModelId) returns { voice, providerSettings } and throws on an incomplete snapshot.
- assertProviderSettingsSnapshot(providerId, settings) returns modelMeta and throws before ensureProviderTab when modelMeta.id does not equal model or required metadata is absent.
- getSettings and saveSettings keep their current merged-settings shape while routing studioBaseUrl and studioUsername to local storage.
- getCredentials returns { username, password }; saveCredentials({ username, password }) writes username locally and password to session storage only.
- isLocalStudioUrl(url) returns true only for localhost, 127.0.0.1, or ::1 Story Studio URLs; requiresStudioPassword(item, settings, password) returns false for standalone/download jobs and localhost, and true only for project-target jobs with a non-local URL and an empty session password.
- createIsolatedBridge({ requestKind, responseKind, label }) returns { callMain(op, payload, timeoutMs) }.
- createMainBridge({ requestKind, responseKind, handlers }) owns one random session channel.
- Approved Fleet actions are exactly pause_after_current, resume_hub_pause, and clear_pending; all retain signed timestamp/nonce/HMAC and expected queue-revision checks.

## Task 1: Lock Story Studio Section Contracts

**Files:**
- Create: src/lib/section-contracts.js
- Create: test/cleanup.test.js

**Interfaces:**
- Consumes: raw section slugs returned by sectionSlugFromFile(name, code).
- Produces: storyStudioSection and sectionEligibility for popup rows, worker validation, and ingest guards.

- [ ] **Step 1: Write the failing tests**

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
~~~

- [ ] **Step 2: Verify the red test**

Run: node --test test/cleanup.test.js

Expected: FAIL because src/lib/section-contracts.js does not exist yet.

- [ ] **Step 3: Write the minimal implementation**

~~~js
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
~~~

- [ ] **Step 4: Verify green**

Run: node --test test/cleanup.test.js

Expected: PASS for both section-contract tests.

- [ ] **Step 5: Commit**

~~~bash
git add src/lib/section-contracts.js test/cleanup.test.js
git commit -m "test: define Story Studio section contracts"
~~~

## Task 2: Add Correlated Provider Bridge Transport

**Files:**
- Create: src/content/bridge.js
- Create: test/bridge.test.js
- Modify: manifest.json, src/content/fish.js, src/content/fish-main.js, src/content/eleven.js, src/content/eleven-main.js

**Interfaces:**
- Consumes: existing FISHEXT_REQ/FISHEXT_RES and ELEVENEXT_REQ/ELEVENEXT_RES messages plus inventory and generate handlers.
- Produces: createIsolatedBridge and createMainBridge; existing chrome.runtime message types and response fields remain unchanged.

- [ ] **Step 1: Write the failing bridge tests**

~~~js
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../src/content/bridge.js', import.meta.url), 'utf8');

test('bridge transport has random channel, hello handshake, request IDs, and stale-response rejection', () => {
  assert.match(source, /crypto\.randomUUID/);
  assert.match(source, /helloId/);
  assert.match(source, /setInterval/);
  assert.match(source, /clearInterval/);
  assert.match(source, /clearTimeout/);
  assert.match(source, /pending\.set\(id/);
  assert.match(source, /pending\.get\(data\.id/);
  assert.match(source, /data\.channel !== channel/);
  assert.match(source, /setTimeout/);
});

test('both providers use the shared helper', () => {
  for (const name of ['fish', 'eleven']) {
    assert.match(readFileSync(new URL('../src/content/' + name + '.js', import.meta.url), 'utf8'), /createIsolatedBridge/);
    assert.match(readFileSync(new URL('../src/content/' + name + '-main.js', import.meta.url), 'utf8'), /createMainBridge/);
  }
});

test('isolated-first startup retries hello until a later MAIN bridge can correlate a call', async () => {
  const listeners = [];
  const window = {
    addEventListener(type, listener) {
      if (type === 'message') listeners.push(listener);
    },
    postMessage(data) {
      queueMicrotask(() => listeners.forEach((listener) => listener({ source: window, data })));
    },
  };
  const context = vm.createContext({
    window,
    crypto: { randomUUID: (() => { let n = 0; return () => 'id-' + (++n); })() },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    Uint8Array,
    Map,
    Promise,
    Error,
    Object,
  });
  vm.runInContext(source, context);
  const isolated = context.__STORY_STUDIO_BRIDGE__.createIsolatedBridge({
    requestKind: 'TEST_REQ',
    responseKind: 'TEST_RES',
    label: 'Test',
  });
  await new Promise((resolve) => setTimeout(resolve, 35));
  context.__STORY_STUDIO_BRIDGE__.createMainBridge({
    requestKind: 'TEST_REQ',
    responseKind: 'TEST_RES',
    handlers: { echo: ({ value }) => value },
  });
  const result = isolated.callMain('echo', { value: 'correct' });
  window.postMessage({ kind: 'TEST_RES', channel: 'stale-channel', id: 'id-stale', ok: true, result: 'stale' });
  assert.equal(await result, 'correct');
});
~~~

- [ ] **Step 2: Verify red**

Run: node --test test/bridge.test.js

Expected: FAIL because src/content/bridge.js does not exist.

- [ ] **Step 3: Add the shared helper**

Implement src/content/bridge.js as a classic script with this exact behavior:

~~~js
(() => {
  const root = globalThis.__STORY_STUDIO_BRIDGE__ || (globalThis.__STORY_STUDIO_BRIDGE__ = {});
  const randomId = () => {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  };

  const HELLO_RETRY_MS = 25;
  const HELLO_TIMEOUT_MS = 5000;

  root.createIsolatedBridge = ({ requestKind, responseKind, label }) => {
    let channel = '';
    const pending = new Map();
    const helloId = randomId();
    let helloRetry;
    let helloTimeout;
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const sendHello = () => window.postMessage({ kind: requestKind + ':hello', helloId }, '*');
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data) return;
      if (data.kind === responseKind + ':ready' && data.helloId === helloId && typeof data.channel === 'string') {
        channel = data.channel;
        clearInterval(helloRetry);
        clearTimeout(helloTimeout);
        resolveReady(channel);
        return;
      }
      if (data.kind !== responseKind || data.channel !== channel || typeof data.id !== 'string') return;
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      data.ok
        ? entry.resolve(data.result)
        : entry.reject(Object.assign(new Error(data.error || 'main-world error'), { limit: !!data.limit, ambiguous: !!data.ambiguous }));
    });
    helloRetry = setInterval(sendHello, HELLO_RETRY_MS);
    helloTimeout = setTimeout(() => {
      clearInterval(helloRetry);
      if (!channel) rejectReady(new Error(label + ' bridge did not initialize.'));
    }, HELLO_TIMEOUT_MS);
    sendHello();
    async function callMain(op, payload, timeoutMs = 120000) {
      const sessionChannel = await ready;
      const id = randomId();
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        window.postMessage({ kind: requestKind, channel: sessionChannel, id, op, payload }, '*');
        setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(Object.assign(new Error(label + ' "' + op + '" timed out.'), { ambiguous: op === 'generate' }));
        }, timeoutMs);
      });
    }
    return { callMain };
  };

  root.createMainBridge = ({ requestKind, responseKind, handlers }) => {
    const channel = randomId();
    window.addEventListener('message', async (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data) return;
      if (data.kind === requestKind + ':hello' && typeof data.helloId === 'string') {
        window.postMessage({ kind: responseKind + ':ready', helloId: data.helloId, channel }, '*');
        return;
      }
      if (data.kind !== requestKind || data.channel !== channel || typeof data.id !== 'string') return;
      try {
        const handler = handlers[data.op];
        if (!handler) throw new Error('Unknown op: ' + data.op);
        const result = await handler(data.payload || {});
        window.postMessage({ kind: responseKind, channel, id: data.id, ok: true, result }, '*');
      } catch (error) {
        window.postMessage({ kind: responseKind, channel, id: data.id, ok: false, error: String(error.message || error), limit: !!error.limit, ambiguous: !!error.ambiguous }, '*');
      }
    });
  };
})();
~~~

- [ ] **Step 4: Wire both providers and the manifest**

Replace the local seq/pending/callMain/response-listener code in fish.js and eleven.js with these exact initializers:

~~~js
const bridge = window.__STORY_STUDIO_BRIDGE__.createIsolatedBridge({
  requestKind: 'FISHEXT_REQ',
  responseKind: 'FISHEXT_RES',
  label: 'Fish',
});
~~~

~~~js
const bridge = window.__STORY_STUDIO_BRIDGE__.createIsolatedBridge({
  requestKind: 'ELEVENEXT_REQ',
  responseKind: 'ELEVENEXT_RES',
  label: 'ElevenLabs',
});
~~~

Replace each MAIN-world final message listener with the corresponding exact registration:

~~~js
window.__STORY_STUDIO_BRIDGE__.createMainBridge({
  requestKind: 'FISHEXT_REQ',
  responseKind: 'FISHEXT_RES',
  handlers: { inventory, generate },
});
~~~

Use ELEVENEXT_REQ and ELEVENEXT_RES in eleven-main.js. Preserve each current generate payload and current limit/ambiguous response mapping. Add src/content/bridge.js before each provider file in all four manifest content-script js arrays. Keep matches, worlds, and run_at unchanged.

- [ ] **Step 5: Verify green and syntax**

Run: node --test test/bridge.test.js

Expected: PASS.

Run: for f in $(rg --files -g '*.js' -g '!graphify-out/**' | sort); do node --check "$f"; done

Expected: exit 0.

- [ ] **Step 6: Commit**

~~~bash
git add src/content/bridge.js src/content/fish.js src/content/fish-main.js src/content/eleven.js src/content/eleven-main.js manifest.json test/bridge.test.js
git commit -m "fix: correlate provider bridge requests"
~~~

## Task 3: Make Provider Queue Snapshots Exact

**Files:**
- Modify: src/lib/providers.js, src/background.js, src/popup/popup.js, src/content/fish-main.js, src/content/eleven-main.js
- Modify: test/providers.test.js, test/cleanup.test.js

**Interfaces:**
- Consumes: provider inventories, snapshotProviderSettings, providerInventories, and the selected voice control.
- Produces: snapshotProviderJob for popup queue construction and assertProviderSettingsSnapshot for the worker before ensureProviderTab.

- [ ] **Step 1: Write failing tests**

Add to test/providers.test.js:

~~~js
test('snapshots the selected discovered voice and exact model metadata', () => {
  const inventory = {
    source: 'live',
    complete: true,
    voices: [{ id: 'voice-live', title: 'Account Narrator' }],
    models: [{ id: 'account-model', label: 'Account model', maxChars: 7200, style: true, speakerBoost: false, speed: true, stability: 'slider' }],
  };
  assert.deepEqual(snapshotProviderJob('elevenlabs_web', { model: 'account-model', style: 0.3 }, inventory, 'voice-live', 'account-model'), {
    voice: 'voice-live',
    providerSettings: { model: 'account-model', modelMeta: inventory.models[0], style: 0.3 },
  });
});

test('rejects an incomplete queued model snapshot', () => {
  assert.throws(() => assertProviderSettingsSnapshot('fish', { model: 's3-pro' }), /model was not discovered/i);
});
~~~

Add to test/cleanup.test.js:

~~~js
test('generation has no provider-default model or voice fallback', () => {
  const background = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
  const eleven = readFileSync(new URL('../src/content/eleven-main.js', import.meta.url), 'utf8');
  assert.match(background, /assertProviderSettingsSnapshot\(providerId, providerSettings\)/);
  assert.match(background, /const voice = job\.voice;/);
  assert.doesNotMatch(background, /settings\.voiceByProvider\?\./);
  assert.match(eleven, /if \(!model\) throw new Error/);
  assert.doesNotMatch(eleven, /model \|\| MODEL/);
});
~~~

- [ ] **Step 2: Verify red**

Run: node --test test/providers.test.js test/cleanup.test.js

Expected: FAIL because the snapshot functions do not exist and fallback paths remain; the existing 17 provider tests must remain green.

- [ ] **Step 3: Implement the snapshot helpers**

~~~js
export function assertProviderSettingsSnapshot(providerId, settings = {}) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new Error('This provider is no longer supported.');
  const modelId = String(settings.model || '');
  const modelMeta = settings.modelMeta;
  if (!modelId || !modelMeta || modelMeta.id !== modelId || !String(modelMeta.label || '')) {
    throw new Error(provider.displayName + ' model was not discovered; refresh inventory and queue again.');
  }
  return modelMeta;
}

export function snapshotProviderJob(providerId, settings = {}, inventory, voiceId, displayedModelId = '') {
  const providerSettings = snapshotProviderSettings(providerId, settings, inventory, displayedModelId);
  assertProviderSettingsSnapshot(providerId, providerSettings);
  const voice = String(voiceId || '');
  if (!voice) throw new Error((PROVIDERS[providerId]?.displayName || providerId) + ' voice was not discovered; refresh inventory and queue again.');
  if (inventory?.source === 'live' && inventory.complete === true && !inventory.voices.some((candidate) => candidate.id === voice)) {
    throw new Error((PROVIDERS[providerId]?.displayName || providerId) + ' voice was not discovered; refresh inventory and queue again.');
  }
  return { voice, providerSettings };
}
~~~

Change snapshotProviderSettings so a non-empty displayedModelId not found in modelsForProviderSettings throws the same discovered-model error instead of resolving to the first model. Keep saved-model visibility for non-authoritative discovery. In popup.js, use this exact queue boundary for Story Studio items:

~~~js
function queueProviderSnapshot() {
  const provider = currentProvider();
  return snapshotProviderJob(
    provider,
    currentProviderSettings(),
    providerInventories[provider],
    $('voice').value,
    supportsModels(provider) ? $('vsModel').value : '',
  );
}

function itemFromSection(section) {
  const { voice, providerSettings } = queueProviderSnapshot();
  return {
    kind: section.kind,
    slug: ctx.projectSlug,
    episodeCode: ctx.episodeCode,
    episodeTitle: ctx.episodeTitle,
    sectionSlug: section.slug,
    chapterNumber: section.num ?? null,
    provider: currentProvider(),
    voice,
    autoTag: $('autoTag').checked,
    providerSettings,
    label: ctx.episodeCode + ' ' + section.label,
  };
}
~~~

In onQueueStandalone, call queueProviderSnapshot once and use its voice and providerSettings in every pasted item, preserving target download and the current downloadPath.

- [ ] **Step 4: Validate before provider tab/request**

In background.js, import assertProviderSettingsSnapshot, merge only queued providerSettings over defaults, call the assertion before ensureProviderTab, use const voice = job.voice, and pass providerSettings.model exactly. Remove the settings.voiceByProvider fallback and Fish/ElevenLabs missing-model defaults. In eleven-main.js, reject an empty model and set model_id directly to the queued model. Preserve the current Fish/ElevenLabs inventory fallback catalogs for UI discovery only.

- [ ] **Step 5: Verify green**

Run: node --test test/providers.test.js test/cleanup.test.js

Expected: PASS for all existing provider tests plus exact voice/model snapshot and no-silent-fallback tests.

- [ ] **Step 6: Commit**

~~~bash
git add src/lib/providers.js src/background.js src/popup/popup.js src/content/fish-main.js src/content/eleven-main.js test/providers.test.js test/cleanup.test.js
git commit -m "fix: snapshot provider models and voices per queue item"
~~~

## Task 4: Make Story Studio Eligibility Truthful

**Files:**
- Modify: src/lib/section-contracts.js, src/background.js, src/popup/popup.js
- Modify: test/cleanup.test.js, test/queue-recovery.test.js

**Interfaces:**
- Consumes: sectionEligibility(sectionSlug) and sectionSlugFromFile(name, code).
- Produces: supported script, intro, and chapter queue items only; unsupported rows have kind unsupported, supported false, and a user-visible reason.

- [ ] **Step 1: Write failing queue-boundary tests**

~~~js
test('unknown Story Studio filenames are visible but cannot enter generation or ingest', () => {
  const popup = readFileSync(new URL('../src/popup/popup.js', import.meta.url), 'utf8');
  const background = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
  assert.match(popup, /sectionEligibility\(s\)/);
  assert.match(popup, /s\.supported === false/);
  assert.match(popup, /Unsupported Story Studio section/);
  assert.match(background, /storyStudioSection\(item\.sectionSlug\)/);
  assert.match(background, /Unsupported Story Studio section/);
});

test('project and standalone paths retain their targets and recovery boundaries', () => {
  const background = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
  const popup = readFileSync(new URL('../src/popup/popup.js', import.meta.url), 'utf8');
  assert.match(background, /if \(job\.target === 'download'\)/);
  assert.match(background, /putAudioArtifact\(caches/);
  assert.match(background, /saveAudio\(job, audio, settings\)/);
  assert.match(background, /armHumanDelay\(settings\)/);
  assert.match(popup, /target: 'download'/);
  assert.match(popup, /type: 'enqueueProject'/);
});

test('remote Story Studio auth loss pauses without discarding generated audio evidence', () => {
  const source = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
  assert.match(source, /e\?\.status === 401/);
  assert.match(source, /it\.status = 'pending'/);
  assert.match(source, /setQueuePaused\(true\)/);
  assert.match(source, /password required — open Settings/);
  assert.match(source, /it\.phase === 'saving' && it\.artifact/);
});
~~~

- [ ] **Step 2: Verify red**

Run: node --test test/cleanup.test.js test/queue-recovery.test.js

Expected: FAIL because unknown rows still become chapter items and the worker has no dedicated 401 pause branch. Existing recovery tests must remain green.

- [ ] **Step 3: Mark unknown popup rows unsupported**

Import sectionEligibility into popup.js. Keep audio.missing_files authoritative and keep chunk deduplication. Build each unknown row with this exact shape:

~~~js
const eligibility = sectionEligibility(slug);
cand.push({
  slug,
  kind: eligibility.kind,
  num: eligibility.chapterNumber,
  label: slug.replace(/_/g, ' '),
  supported: eligibility.supported,
  reason: eligibility.reason,
});
~~~

Add the Script row when missing contains Script; preserve the current Introduction row and chapter titles. In renderSections, use cb.disabled = s.supported === false || (s.present && !includeExisting), set row.title = s.reason, append the reason for unsupported rows, and keep those rows unchecked. Make selectedSections and onQueueEpisode select supported rows only. Make itemFromSection throw the reason before constructing an item when section.supported is false.

- [ ] **Step 4: Enforce the same boundary in the worker**

Import sectionEligibility and storyStudioSection into background.js. Replace isStudioQueueItem with:

~~~js
function isStudioQueueItem(item) {
  if (item?.kind === 'paste') return typeof item.text === 'string' && item.target === 'download';
  const contract = item?.sectionSlug ? storyStudioSection(item.sectionSlug) : null;
  return !!(item?.slug && item?.episodeCode && contract && item.kind === contract.kind && item.chapterNumber === contract.chapterNumber);
}
~~~

Make missingSectionItems return { items, unsupported }. Canonicalize supported chunk names through the contract and add unknown filenames to unsupported with their reason, never to items. Make enqueueProject sum unsupported and return it alongside added, skipped, and episodes. Add the exact fetch branch for a whole script:

~~~js
if (item.kind === 'script') {
  const script = await client.scriptContent(item.slug, item.episodeCode, item.episodeTitle);
  return script?.content || '';
}
~~~

At the start of saveAudio, validate storyStudioSection(job.sectionSlug) and its chapter number before constructing the audio-ingest request. Throw 'Unsupported Story Studio section; audio was not sent to Story Studio.' for an invalid contract. This is the final guard against an invalid ingest even if a caller bypasses the popup.

- [ ] **Step 5: Pause safely on a remote 401**

Set res.status on the Error thrown by saveAudio. In processQueue catch, before ambiguous-provider handling, add:

~~~js
if (it && e?.status === 401) {
  const preserveArtifact = it.phase === 'saving' && it.artifact;
  it.status = 'pending';
  delete it.startedAt;
  delete it.finishedAt;
  delete it.durationMs;
  if (!preserveArtifact) delete it.phase;
  await setQueue(q);
  await setQueuePaused(true);
  alarmClear();
  await writeStatus('Story Studio password required — open Settings to sign in again.', 'info');
  return;
}
~~~

Keep phase saving and artifact for a generated item so resume performs only the save. Clear generating when no provider result exists. Preserve existing ambiguous, cache, download, pacing, and no-automatic-replay branches.

- [ ] **Step 6: Verify green and commit**

Run: node --test test/cleanup.test.js test/queue-recovery.test.js

Expected: PASS for supported/unsupported sections, standalone/download preservation, project queue preservation, ingest blocking, and auth-pause evidence preservation.

~~~bash
git add src/lib/section-contracts.js src/background.js src/popup/popup.js test/cleanup.test.js test/queue-recovery.test.js
git commit -m "fix: reject unsupported Story Studio sections"
~~~

## Task 5: Reconcile Story Studio Credential Storage

**Files:**
- Modify: src/lib/config.js, src/background.js, src/options/options.js, src/options/options.html
- Modify: test/cleanup.test.js

**Interfaces:**
- Consumes: legacy sync settings.studioBaseUrl/studioUsername and legacy local studioCredentials.
- Produces: local studioBaseUrl/studioUsername, session studioPassword, and an empty password after browser session storage is cleared.

- [ ] **Step 1: Write failing migration tests**

Add this storageArea mock to test/cleanup.test.js, then add:

~~~js
function storageArea(initial = {}) {
  const values = { ...initial };
  return {
    values,
    async get(keys) {
      if (keys == null) return { ...values };
      const names = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
      return Object.fromEntries(names.filter((name) => name in values).map((name) => [name, values[name]]));
    },
    async set(patch) {
      Object.assign(values, patch);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
}
~~~

Then add:

~~~js
test('migrates a legacy password to session storage and removes its persistent copy', async () => {
  const sync = storageArea({ settings: { studioBaseUrl: 'http://remote.test:8766', studioUsername: 'alice', theme: 'dark' } });
  const local = storageArea({ studioCredentials: { username: 'alice', password: 'legacy-secret' } });
  const session = storageArea();
  globalThis.chrome = { storage: { sync, local, session } };
  const { getCredentials, getSettings } = await import('../src/lib/config.js');
  const settings = await getSettings();
  const credentials = await getCredentials();
  assert.equal(settings.studioBaseUrl, 'http://remote.test:8766');
  assert.equal(settings.studioUsername, 'alice');
  assert.equal(credentials.password, 'legacy-secret');
  assert.equal(local.values.studioCredentials, undefined);
  assert.equal(local.values.studioPassword, undefined);
  assert.equal(session.values.studioPassword, 'legacy-secret');
  assert.equal(sync.values.settings.studioBaseUrl, undefined);
  assert.equal(sync.values.settings.studioUsername, undefined);
});

test('clearing session storage asks for password again but preserves local connection data', async () => {
  const sync = storageArea({ settings: { theme: 'dark' } });
  const local = storageArea({ studioBaseUrl: 'http://remote.test:8766', studioUsername: 'alice' });
  const session = storageArea();
  globalThis.chrome = { storage: { sync, local, session } };
  const { getCredentials, getSettings, saveCredentials, saveSettings } = await import('../src/lib/config.js');
  await saveSettings({ studioBaseUrl: 'http://remote.test:8766' });
  await saveCredentials({ username: 'alice', password: 'current-secret' });
  assert.deepEqual(await getCredentials(), { username: 'alice', password: 'current-secret' });
  await session.remove('studioPassword');
  assert.deepEqual(await getCredentials(), { username: 'alice', password: '' });
  assert.equal((await getSettings()).studioBaseUrl, 'http://remote.test:8766');
  assert.equal(local.values.studioPassword, undefined);
});
~~~

Add these executable pure-helper tests:

~~~js
test('only remote project jobs require a Story Studio session password', async () => {
  const { isLocalStudioUrl, requiresStudioPassword } = await import('../src/lib/config.js');
  assert.equal(isLocalStudioUrl('http://localhost:8766'), true);
  assert.equal(isLocalStudioUrl('http://127.0.0.1:8766'), true);
  assert.equal(isLocalStudioUrl('http://[::1]:8766'), true);
  assert.equal(isLocalStudioUrl('https://studio.example.test'), false);
  assert.equal(requiresStudioPassword({ slug: 'project', target: 'project' }, { studioBaseUrl: 'https://studio.example.test' }, ''), true);
  assert.equal(requiresStudioPassword({ slug: 'project', target: 'project' }, { studioBaseUrl: 'https://studio.example.test' }, 'session-secret'), false);
  assert.equal(requiresStudioPassword({ slug: 'project', target: 'download' }, { studioBaseUrl: 'https://studio.example.test' }, ''), false);
  assert.equal(requiresStudioPassword({ slug: 'project', target: 'project' }, { studioBaseUrl: 'http://localhost:8766' }, ''), false);
});

test('background preflight precedes provider generation and preserves queue evidence', () => {
  const source = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
  assert.match(source, /import \{[^}]*getCredentials[^}]*\} from ['"]\.\/lib\/config\.js['"]/s);
  assert.match(source, /isLocalStudioUrl\(settings\.studioBaseUrl\)/);
  assert.match(source, /item\.target === 'download'/);
  assert.match(source, /await getCredentials\(\)/);
  assert.match(source, /setQueuePaused\(true\)/);
  assert.match(source, /Story Studio password required — open Settings to sign in again\./);
  assert.match(source, /if \(await preflightStudioPassword\(item, settings\)\) return;/);
  assert.match(source, /preflightStudioPassword\(item, settings\)[\s\S]*?const audio = await produceAudio/);
  assert.match(source, /it\.phase === 'saving' && it\.artifact/);
});
~~~

- [ ] **Step 2: Verify red**

Run: node --test test/cleanup.test.js

Expected: FAIL because URL/username still come from sync settings and the password still uses persistent local studioCredentials.

- [ ] **Step 3: Implement storage keys and migration**

Use STUDIO_URL_KEY = studioBaseUrl, STUDIO_USERNAME_KEY = studioUsername, STUDIO_PASSWORD_KEY = studioPassword, and LEGACY_CRED_KEY = studioCredentials. Update getSettings to read local URL/username, migrate missing local values from legacy sync fields, delete those fields from the sync settings object, and return the local values merged over DEFAULTS. Keep provider, queue, theme, and Fleet settings in sync.

Replace credential access with:

~~~js
export async function getCredentials() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get([STUDIO_USERNAME_KEY, LEGACY_CRED_KEY]),
    chrome.storage.session.get(STUDIO_PASSWORD_KEY),
  ]);
  const legacy = local[LEGACY_CRED_KEY] || {};
  const username = String(local[STUDIO_USERNAME_KEY] ?? legacy.username ?? '');
  const password = String(session[STUDIO_PASSWORD_KEY] ?? legacy.password ?? '');
  if (username && local[STUDIO_USERNAME_KEY] !== username) await chrome.storage.local.set({ [STUDIO_USERNAME_KEY]: username });
  if (password && session[STUDIO_PASSWORD_KEY] !== password) await chrome.storage.session.set({ [STUDIO_PASSWORD_KEY]: password });
  if (local[LEGACY_CRED_KEY]) await chrome.storage.local.remove(LEGACY_CRED_KEY);
  return { username, password };
}

export async function saveCredentials({ username, password }) {
  await chrome.storage.local.set({ [STUDIO_USERNAME_KEY]: String(username || '') });
  await chrome.storage.session.set({ [STUDIO_PASSWORD_KEY]: String(password || '') });
  await chrome.storage.local.remove(LEGACY_CRED_KEY);
}
~~~

Make saveSettings split studioBaseUrl and studioUsername from the sync patch, write those fields locally, and return the existing merged shape. Never write a password from settings.

Add these pure helpers to config.js and export them for the executable tests:

~~~js
export function isLocalStudioUrl(url) {
  try {
    const hostname = new URL(String(url || '')).hostname.replace(/^\[|\]$/g, '');
    return ['localhost', '127.0.0.1', '::1'].includes(hostname);
  } catch {
    return false;
  }
}

export function requiresStudioPassword(item, settings, password) {
  if (!item?.slug || item.target === 'download' || isLocalStudioUrl(settings?.studioBaseUrl)) return false;
  return !String(password || '');
}
~~~

In background.js import getCredentials, isLocalStudioUrl, and requiresStudioPassword from config.js. Add this preflight before any provider generation and before changing the item to running:

~~~js
async function preflightStudioPassword(item, settings) {
  if (item.target === 'download' || !item.slug || isLocalStudioUrl(settings.studioBaseUrl)) return false;
  const { password } = await getCredentials();
  if (!requiresStudioPassword(item, settings, password)) return false;
  await setQueuePaused(true);
  alarmClear();
  await writeStatus('Story Studio password required — open Settings to sign in again.', 'info');
  return true;
}
~~~

In processQueue, after selecting the next item and before setting `status = 'running'`, call `if (await preflightStudioPassword(item, settings)) return;`. Leave the item pending, do not delete `phase` or `artifact`, and do not call `produceAudio`, `ensureProviderTab`, `saveAudio`, or mutate queue evidence in this branch. Standalone download items and localhost Story Studio items must proceed unchanged; the existing 401 recovery branch remains as defense in depth for an expired remote session after generation.

- [ ] **Step 4: Update options copy without changing host-permission behavior**

Change the password hint to Stored for this browser session only. Keep options.js calling saveCredentials from save and login, keep the current remote host-permission request/test flow, and change the Fleet queue hint to only pause-after-current, resume of a Hub pause, and clear pending.

- [ ] **Step 5: Verify and commit**

Run: node --test test/cleanup.test.js test/queue-recovery.test.js

Expected: PASS for legacy migration, local URL/username, session password, cleared-password restart behavior, local/remote/standalone preflight rules, and preserved queue evidence.

Run: for f in $(rg --files -g '*.js' -g '!graphify-out/**' | sort); do node --check "$f"; done

~~~bash
git add src/lib/config.js src/background.js src/options/options.js src/options/options.html test/cleanup.test.js
git commit -m "fix: keep Story Studio passwords session-only"
~~~

## Task 6: Align Fleet Contracts and Copy

**Files:**
- Modify: src/background.js, src/popup/popup.html, src/options/options.html
- Modify: test/cleanup.test.js

**Interfaces:**
- Consumes: existing Fleet v2 HMAC signing, signed response verification, durable queue revision, and opt-in settings.
- Produces: sanitized telemetry plus exactly pause_after_current, resume_hub_pause, and clear_pending; no Fleet path changes provider/model/voice/pacing/credentials/site access.

- [ ] **Step 1: Write failing Fleet tests**

~~~js
test('Fleet UI describes actual opt-in behavior', () => {
  const popup = readFileSync(new URL('../src/popup/popup.html', import.meta.url), 'utf8');
  const options = readFileSync(new URL('../src/options/options.html', import.meta.url), 'utf8');
  assert.doesNotMatch(popup, /Coming soon/);
  assert.match(popup, /optional|opt-in/i);
  assert.match(options, /pause-after-current/i);
  assert.match(options, /resume/i);
  assert.match(options, /clear pending/i);
  assert.doesNotMatch(options, /selected normal-failure retries/i);
});

test('Fleet exposes only signed revision-checked queue controls', () => {
  const source = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
  assert.match(source, /actions: \['pause_after_current', 'resume_hub_pause', 'clear_pending'\]/);
  assert.match(source, /expectedQueueRevision/);
  assert.match(source, /queue_revision_mismatch/);
  assert.match(source, /fleetHmacHex/);
  assert.doesNotMatch(source, /case 'retry_failed'/);
  assert.doesNotMatch(source, /retryableFailedIds/);
});
~~~

- [ ] **Step 2: Verify red**

Run: node --test test/cleanup.test.js

Expected: FAIL because Fleet still says Coming soon and currently advertises/executes retry_failed.

- [ ] **Step 3: Remove the unapproved remote retry command**

Delete retry_failed from Fleet capabilities, retryableFailedIds from detailed telemetry, and the retry_failed execute branch. Keep local side-panel retryFailed behavior. Preserve target-agent/session checks, command-window checks, terminal receipts, expectedQueueRevision, HMAC signing, and local queue-only mutations.

- [ ] **Step 4: Replace copy without changing layout**

Use this exact popup disclosure:

~~~html
<summary><span>Fleet Hub</span><span class="summary-state">Optional</span></summary>
<section class="context-card">
  <p class="muted">Optional Fleet telemetry reports sanitized queue health. If enabled in Settings, signed and revision-checked commands can pause after the current item, resume a Fleet pause, or clear pending work. Provider, voice, pacing, credentials, and site access stay local.</p>
</section>
~~~

Use this exact options hint:

~~~html
<p class="hint">Hub controls are limited to pause-after-current, resume of a Hub pause, and clear pending. Provider, model, voice, pacing, cooldown, credentials, and site permissions remain local.</p>
~~~

- [ ] **Step 5: Verify and commit**

Run: node --test test/cleanup.test.js

Expected: PASS for copy, exact action list, revision checks, HMAC signing, and local settings boundaries.

~~~bash
git add src/background.js src/popup/popup.html src/options/options.html test/cleanup.test.js
git commit -m "fix: document and constrain Fleet queue controls"
~~~

## Task 7: Remove Dead Auth/Permissions and Validate the Package

**Files:**
- Create: test/manifest.test.js
- Modify: src/lib/story-studio.js, manifest.json, test/cleanup.test.js

**Interfaces:**
- Consumes: current manifest file references, provider origins, and StudioClient methods used by popup/background.
- Produces: no whoami method, no unused provider API/refresh-token host permissions, and a manifest whose every declared file exists.

- [ ] **Step 1: Write failing dead-path and manifest tests**

Create test/manifest.test.js:

~~~js
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const declared = [
  manifest.background.service_worker,
  manifest.side_panel.default_path,
  manifest.options_page,
  ...Object.values(manifest.action.default_icon),
  ...Object.values(manifest.icons),
  ...manifest.content_scripts.flatMap((entry) => entry.js),
];

test('manifest declares only existing package files', () => {
  for (const file of declared) assert.equal(existsSync(new URL(file, root)), true, file);
});

test('manifest keeps only extension and provider-page permissions', () => {
  assert.deepEqual(manifest.permissions.sort(), ['alarms', 'downloads', 'sidePanel', 'storage', 'tabs']);
  assert.deepEqual(manifest.host_permissions.sort(), [
    'http://127.0.0.1/*',
    'http://localhost/*',
    'https://elevenlabs.io/*',
    'https://fish.audio/*',
  ]);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.doesNotMatch(JSON.stringify(manifest), /api\.fish\.audio|api\.us\.elevenlabs|securetoken\.googleapis/);
});
~~~

Add this test to test/cleanup.test.js:

~~~js
test('StudioClient has no dead whoami path', async () => {
  const { StudioClient } = await import('../src/lib/story-studio.js');
  assert.equal(typeof StudioClient.prototype.whoami, 'undefined');
});
~~~

- [ ] **Step 2: Verify red**

Run: node --test test/manifest.test.js test/cleanup.test.js

Expected: FAIL because the API/refresh-token hosts and whoami still exist.

- [ ] **Step 3: Remove the dead method and hosts**

Delete only StudioClient.whoami and obsolete auth/me comments. Keep login and all project/episode/chapter/audio/script methods. Set host_permissions exactly to http://localhost/*, http://127.0.0.1/*, https://fish.audio/*, and https://elevenlabs.io/*. Keep optional remote host permissions and existing provider-page content-script matches.

Verify: rg -n "whoami|auth/me" src test README.md CHANGELOG.md

Expected: no output.

- [ ] **Step 4: Verify and commit**

Run: node --test test/manifest.test.js test/cleanup.test.js

Expected: PASS.

~~~bash
git add manifest.json src/lib/story-studio.js test/manifest.test.js test/cleanup.test.js
git commit -m "chore: remove dead Story Studio auth path and permissions"
~~~

## Task 8: Release Documentation and Full Verification

**Files:**
- Modify: manifest.json, README.md, CHANGELOG.md, test/cleanup.test.js

**Interfaces:**
- Consumes: final provider/session behavior, Fleet contracts, queue/recovery guarantees, and current version 0.7.25.
- Produces: version 0.7.26, accurate product-level docs, full verification evidence, a release commit, and a remote-aligned main branch.

- [ ] **Step 1: Write failing release assertions**

~~~js
test('release metadata documents cleanup without stale claims', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.equal(manifest.version, '0.7.26');
  assert.match(changelog, /^## 0\.7\.26 - Audio Generator cleanup/m);
  assert.match(readme, /signed-in provider web sessions/i);
  assert.doesNotMatch(readme, /api\.fish\.audio|api\.us\.elevenlabs|securetoken\.googleapis|Coming soon/i);
  assert.doesNotMatch(changelog, /Coming soon/i);
});
~~~

- [ ] **Step 2: Verify red against 0.7.25**

Run: node --test test/cleanup.test.js

Expected: FAIL on version/changelog assertions before the release edits; previous cleanup tests remain green.

- [ ] **Step 3: Bump and document the release**

Change manifest version to 0.7.26. Insert this exact entry above 0.7.25:

~~~markdown
## 0.7.26 - Audio Generator cleanup

- Kept Fish Audio and ElevenLabs Web generation on signed-in provider web sessions with discovered voice/model snapshots and no developer API-key route.
- Hardened provider bridge correlation, rejected unsupported Story Studio sections, and preserved cached-audio, download, pacing, standalone, and project recovery behavior.
- Moved Story Studio URL and username to local storage, kept the password session-only, and paused remote work for password re-entry after browser restart.
- Replaced stale Fleet “Coming soon” copy with opt-in sanitized telemetry and signed, revision-checked queue controls.
~~~

Replace README Availability with:

~~~markdown
## Availability

Audio generation uses supported signed-in provider web sessions; no developer API key is required. The extension discovers the account’s available voices, models, controls, and limits and keeps the exact selected voice/model snapshot with each queued item.
~~~

Add under Notes:

~~~markdown
- Remote Story Studio work asks for the password again after a browser restart; queued evidence and generated audio remain available for recovery.
~~~

Keep README product-level; do not add provider endpoints, authentication mechanics, account-limit details, or Fleet protocol fields.

- [ ] **Step 4: Run focused and full verification**

Run: node --test test/cleanup.test.js test/manifest.test.js test/providers.test.js test/queue-recovery.test.js

Expected: PASS with the original 29 provider/recovery tests retained plus every new focused test.

Run: npm test

Expected: PASS with zero failures, skips, or warnings.

Run: for f in $(rg --files -g '*.js' -g '!graphify-out/**' | sort); do node --check "$f"; done

Expected: exit 0 for every JavaScript file.

Run: node --test test/manifest.test.js

Expected: PASS for every manifest-declared file, exact permissions, and provider-page-only hosts.

Run: git diff --check

Expected: exit 0.

- [ ] **Step 5: Live Fish Audio check when a signed tab is available**

1. Reload the unpacked extension from this repository in chrome://extensions and keep a signed-in Fish workspace tab open.
2. Select Fish in the side panel, refresh inventory, and verify account voices plus visible model choices.
3. Select one discovered voice/model and queue exactly one short valid Introduction or numbered chapter.
4. Verify the background worker starts generation, the queued item retains the selected voice/model metadata, Fish returns audio, Story Studio accepts the save, and the expected section filename is produced.
5. Verify an intentionally incomplete/unknown model snapshot fails before provider generation and never calls audio-ingest.

- [ ] **Step 6: Live ElevenLabs Web check when a signed tab is available**

1. Keep a signed-in ElevenLabs speech-synthesis tab open and refresh inventory.
2. Verify account voices, at least one TTS-capable model, its advertised character limit, and supported controls appear.
3. Select one discovered voice/model and queue exactly one short valid Story Studio section.
4. Verify the exact voice ID/model metadata reaches the queue, generation uses that model without a default fallback, Story Studio accepts the save, and the item reaches done.
5. Close/reopen the panel during a save or use the existing recovery path; verify cached audio/download checkpoints remain intact and uncertain paid work is not replayed.

- [ ] **Step 7: Release commit, push, and remote alignment**

Review the final diff for provider API keys/routes, unknown-section ingest, persistent passwords, model/voice fallback, Fleet settings mutation, stale Coming soon copy, and accidental graphify-out changes. Create the task checkpoint commits above, then create the release commit with only the intended release files:

~~~bash
git diff --check
git add manifest.json README.md CHANGELOG.md test/cleanup.test.js
git commit -m "chore: release audio generator 0.7.26"
git push origin main
git fetch origin main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
git status --short --untracked-files=all
~~~

The final status must show no tracked release diff and must not add or modify graphify-out/; the remote-alignment test must pass after `git push origin main`.

## Coverage Gate

- Provider/billing boundary, dynamic inventories, exact model/voice snapshots, and unknown-model failure: Tasks 2–3.
- Correlated bridge channel/request integrity and background-only generation: Tasks 2–3.
- Late MAIN-world bridge startup, bounded hello retry/timeout cleanup, stale-response rejection, and the documented compromised-provider-page non-goal: Task 2.
- Ambiguous outcomes, cached artifacts, download checkpoints, pacing, and no uncertain replay: Task 4 plus retained queue-recovery tests.
- Whole-script/introduction/chapter eligibility and visible unsupported filenames: Tasks 1 and 4.
- Local URL/username, session password, legacy migration, restart pause, and preserved evidence: Tasks 4–5.
- Remote project password preflight before provider generation, with standalone and localhost bypasses: Task 5.
- Dead whoami removal, provider-page permissions, and remote host-permission preservation: Task 7.
- Actual opt-in Fleet telemetry and three signed revision-checked commands with local settings protected: Task 6.
- Existing visual layout, version/changelog/README, full tests, syntax checks, manifest checks, diff checks, and live Fish/ElevenLabs paths: Task 8.
