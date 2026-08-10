// Service worker — a persistent, resumable generation QUEUE.
//
// The panel enqueues work (a section, a whole episode, or a whole project);
// this worker processes one item at a time, human-paced, writing each result
// to the Story Studio project folder. The queue lives in
// chrome.storage, so it survives the panel closing AND the worker being
// killed: a chrome.alarms tick wakes the worker to resume any pending items.
//
// Strictly sequential — only ever one fish.audio generation in flight, so the
// site is never flooded no matter how much you queue.

import { getFleetPairingSecret, getSettings, getProviderSettings, providerCooldown } from './lib/config.js';
import { StudioClient } from './lib/story-studio.js';
import { sectionSlugFromFile } from './lib/naming.js';
import { PROVIDERS, buildElevenVoiceSettings, createElevenInventory, createFishInventory } from './lib/providers.js';
import { artifactDescriptor, artifactsForDiscardedItems, deleteAudioArtifacts, getAudioArtifact, putAudioArtifact, sweepOrphanedAudioArtifacts } from './lib/audio-artifacts.js';
import { RECOVERY_REVIEW_MESSAGE, canHandleInFlightFailure, isAmbiguousBridgeFailure, markGeneratedAudioPersistenceFailure, recoverQueueAfterRestart, retryQueueItem, workKindForQueueItem } from './lib/queue-recovery.js';

const QUEUE_KEY = 'queue';
const ALARM = 'queueTick';
const FLEET_ALARM = 'fleetHeartbeat';
const FLEET_PATH = '/api/v2/agents/heartbeat';
const FLEET_PROTOCOL_VERSION = 2;
const FLEET_IDENTITY_KEY = 'fleetIdentity';
const FLEET_REVISION_KEY = 'fleetQueueRevision';
const FLEET_HUB_PAUSE_KEY = 'fleetHubPaused';
const FLEET_RESPONSE_NONCES_KEY = 'fleetResponseNonces';
const FLEET_COMMAND_RECEIPTS_KEY = 'fleetCommandReceipts';
const FLEET_COMMAND_RESULTS_KEY = 'fleetCommandResults';
const FLEET_STATUS_KEY = 'fleetStatus';
// User-requested pause: the in-flight item finishes, then the loop stops until
// Resume. Human-pace timing: when the next generation is allowed to start.
const PAUSE_KEY = 'queuePaused';
const NEXT_RUN_KEY = 'nextRunAt';
const isPaused = async () => !!(await chrome.storage.local.get(PAUSE_KEY))[PAUSE_KEY];
const isHubPaused = async () => !!(await chrome.storage.local.get(FLEET_HUB_PAUSE_KEY))[FLEET_HUB_PAUSE_KEY];

// Per-provider cooldown, keyed by provider id -> resume-at timestamp (ms). Set
// when a generation fails with `.limit` (a detected credit/quota/rate-limit
// error — see the content scripts / providers.js) and that provider's
// auto-resume is on; cleared on manual Resume or once it naturally elapses.
const COOLDOWN_KEY = 'providerCooldownUntil';
const getCooldowns = async () => (await chrome.storage.local.get(COOLDOWN_KEY))[COOLDOWN_KEY] || {};
async function setCooldownUntil(provider, resumeAt) {
  const map = await getCooldowns();
  map[provider] = resumeAt;
  await writeFleetRevision({ [COOLDOWN_KEY]: map });
}
async function clearCooldown(provider) {
  const map = await getCooldowns();
  if (!(provider in map)) return;
  delete map[provider];
  await writeFleetRevision({ [COOLDOWN_KEY]: map });
}
const clearAllCooldowns = () => writeFleetRevision({ [COOLDOWN_KEY]: {} });

// Small guards so a missing/disabled API can never break top-level evaluation
// (which would stop the message listener from registering — symptom: every
// sendMessage resolves to `undefined`).
function alarmCreate() {
  try {
    chrome.alarms?.create(ALARM, { periodInMinutes: 0.5 });
  } catch {
    /* alarms unavailable — queue still runs while the worker is alive */
  }
}
function alarmClear() {
  try {
    chrome.alarms?.clear(ALARM);
  } catch {
    /* ignore */
  }
}

// Clicking the toolbar icon opens the persistent side panel (not a popup).
try {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} catch {
  /* sidePanel unavailable on older Chrome */
}

// On install/update, reload open web-session provider tabs so their content
// scripts aren't stale (they keep old code until the page reloads).
chrome.runtime.onInstalled.addListener(async () => {
  try {
    for (const p of Object.values(PROVIDERS)) {
      const tabs = await chrome.tabs.query({ url: p.origin });
      for (const t of tabs) chrome.tabs.reload(t.id);
    }
  } catch {
    /* best-effort */
  }
});

// ── web-session provider tab plumbing ───────────────────────────────────────
// Find an already-open, ready tab for the provider WITHOUT opening one. Passive
// actions (loading voices) use this so switching provider never pops a page
// open on its own — the panel's "Open provider" button is the explicit way in.
async function findProviderTab(p) {
  const tabs = await chrome.tabs.query({ url: p.origin });
  return tabs.find((t) => t.status === 'complete') || tabs[0] || null;
}

// Focus the provider's tab, or open it — only ever from the panel's explicit
// "↗ Open provider" button (never as a side effect of switching provider).
async function openProviderPage(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) return { ok: false, error: 'This provider is no longer supported.' };
  const tabs = await chrome.tabs.query({ url: p.origin });
  if (tabs[0]) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true }).catch(() => {});
    return { ok: true, opened: false };
  }
  await chrome.tabs.create({ url: p.workspaceUrl, active: true });
  return { ok: true, opened: true };
}

// Find a ready tab on the provider's site, or open its app page and wait.
// Used only when a queued generation actually needs the tab (opens in the
// background so "queue and walk away" still works unattended).
async function ensureProviderTab(p) {
  const tabs = await chrome.tabs.query({ url: p.origin });
  const ready = tabs.find((t) => t.status === 'complete');
  if (ready) return ready;
  const tab = tabs[0] || (await chrome.tabs.create({ url: p.workspaceUrl, active: false }));
  await new Promise((resolve) => {
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 800); // let content scripts initialise
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  return tab;
}

async function send(tabId, message) {
  let res;
  try {
    res = await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    throw Object.assign(new Error(`Provider connection failed: ${error?.message || error}`), { ambiguous: isAmbiguousBridgeFailure(error) });
  }
  if (!res || !res.ok)
    throw Object.assign(new Error(res?.error || 'No response from the provider page.'), { limit: !!res?.limit, ambiguous: !!res?.ambiguous });
  return res;
}

// Produce audio bytes by driving the provider's logged-in page.
async function produceAudio(job, settings) {
  const providerId = job.provider || settings.provider || 'fish';
  const p = PROVIDERS[providerId];
  if (!p) throw new Error('This queued provider is no longer supported. Re-queue it with fish.audio or ElevenLabs.');
  if (!job.text || !job.text.trim()) throw new Error('No script text to generate.');

  // Per-provider tuning (model + voice settings / speed): the item's snapshot
  // from when it was queued, or the current settings for a fresh call.
  const ps = { ...getProviderSettings(settings, providerId), ...(job.providerSettings || {}) };

  const voice = job.voice || settings.voiceByProvider?.[providerId] || (providerId === 'fish' ? settings.fishVoice : '');
  if (!voice) throw new Error(`No ${p.displayName} voice selected. Pick one in the panel.`);
  const tab = await ensureProviderTab(p);
  return send(tab.id, {
    type: `${p.messageNamespace}:generate`,
    text: job.text,
    voice,
    speed: ps.speed ?? 1,
    autoTag: !!job.autoTag,
    // ElevenLabs (web): model + voice_settings, built here so the content
    // script stays logic-free. fish ignores these.
    model: ps.model,
    backend: providerId === 'fish' ? ps.model || p.defaults.model : undefined,
    maxChars: ps.modelMeta?.maxChars || p.maxChars,
    voiceSettings: providerId === 'elevenlabs_web' ? buildElevenVoiceSettings(ps, ps.modelMeta || ps.model) : undefined,
  });
}

// Save already-generated audio; retries of this function never call a provider.
async function saveAudio(job, { base64, mime }, settings) {
  const ext = mime === 'audio/wav' ? 'wav' : 'mp3';
  if (!job.slug || !job.episodeCode || !job.sectionSlug) {
    throw new Error('Queue item is not linked to a Story Studio section. Queue it again from Story Studio.');
  }
  const base = (settings.studioBaseUrl || '').replace(/\/+$/, '');
  const url = `${base}/api/projects/${encodeURIComponent(job.slug)}/episodes/${encodeURIComponent(
    job.episodeCode
  )}/audio-ingest`;
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug: job.sectionSlug,
      chapterNumber: job.chapterNumber,
      audioBase64: base64,
      format: ext,
    }),
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j?.detail) detail = j.detail;
    } catch {
      /* non-JSON */
    }
    throw new Error(`Story Studio rejected the audio: ${detail}`);
  }
  const j = await res.json();
  return { savedAs: j.saved_as, savedIn: j.audio_dir };
}

async function startDownload(job, { base64, mime }) {
  const ext = mime === 'audio/wav' ? 'wav' : 'mp3';
  const filename = `${String(job.downloadPath || 'StoryStudioAudio/Standalone/audio.mp3').replace(/\.(mp3|wav)$/i, '')}.${ext}`;
  const downloadId = await chrome.downloads.download({
    url: `data:${mime};base64,${base64}`,
    filename,
    saveAs: false,
    conflictAction: 'uniquify',
  });
  return { downloadId, savedAs: filename, target: 'download' };
}

async function observeDownload(downloadId) {
  const [download] = await chrome.downloads.search({ id: downloadId });
  if (!download) throw new Error(`Download ${downloadId} is no longer available.`);
  if (download.state === 'complete') return { savedAs: download.filename || '', target: 'download' };
  if (download.state === 'interrupted') throw Object.assign(new Error(`Download interrupted: ${download.error || 'unknown error'}`), { downloadInterrupted: true });
  await new Promise((resolve, reject) => {
    const finish = (error) => {
      chrome.downloads.onChanged.removeListener(listener);
      error ? reject(error) : resolve();
    };
    const listener = (delta) => {
      if (delta.id !== downloadId || !delta.state?.current) return;
      if (delta.state.current === 'complete') finish();
      else if (delta.state.current === 'interrupted') finish(Object.assign(new Error(`Download interrupted: ${delta.error?.current || 'unknown error'}`), { downloadInterrupted: true }));
    };
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.search({ id: downloadId }).then(([latest]) => {
      if (latest?.state === 'complete') finish();
      else if (latest?.state === 'interrupted') finish(Object.assign(new Error(`Download interrupted: ${latest.error || 'unknown error'}`), { downloadInterrupted: true }));
    }).catch(finish);
  });
  const [completed] = await chrome.downloads.search({ id: downloadId });
  return { savedAs: completed?.filename || '', target: 'download' };
}

// ── status (persisted so the panel survives close/reopen) ───────────────────
// `details` can carry a live countdown ({ countdownUntil, countdownLabel }) that
// the panel ticks down each second.
async function writeStatus(text, kind = 'info', details = {}) {
  try {
    await chrome.storage.local.set({ lastStatus: { text, kind, ts: Date.now(), ...details } });
  } catch {
    /* best-effort */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── human pacing ────────────────────────────────────────────────────────────
// A randomised gap (from settings) between generations so a web session is
// never flooded. The gap is armed AFTER each generation and waited out before
// the next one starts — and it's interruptible by Pause.
function randomHumanDelayMs(settings) {
  const min = Math.max(0, Math.round(Number(settings.humanDelayMinSec) || 0));
  const max = Math.max(min, Math.round(Number(settings.humanDelayMaxSec) || 0));
  return (min + Math.floor(Math.random() * (max - min + 1))) * 1000;
}
async function armHumanDelay(settings) {
  await chrome.storage.local.set({ [NEXT_RUN_KEY]: Date.now() + randomHumanDelayMs(settings) });
}
// If the next pending item's provider is on an active cooldown, park the queue
// there (write a live countdown, arm the alarm to check back) instead of
// pulling that item. Returns true when the queue should stop for now — only a
// cooldown that's still armed AND has auto-resume on actually holds; a stale or
// disabled one is cleared and the queue proceeds normally.
async function holdForCooldown(provider, settings) {
  const cd = providerCooldown(settings, provider);
  const resumeAt = Number((await getCooldowns())[provider]) || 0;
  if (!cd.autoResume || resumeAt <= Date.now()) {
    if (resumeAt) await clearCooldown(provider);
    return false;
  }
  const name = PROVIDERS[provider]?.displayName || provider;
  await writeStatus(`${name} limit reached — the queue will resume automatically.`, 'info', {
    countdownUntil: resumeAt,
    countdownReason: 'cooldown',
    countdownProvider: provider,
  });
  alarmCreate();
  return true;
}

async function waitForNextRun(item) {
  for (;;) {
    if (await isPaused()) return;
    const { [NEXT_RUN_KEY]: nextRunAt = 0 } = await chrome.storage.local.get(NEXT_RUN_KEY);
    const remaining = Number(nextRunAt) - Date.now();
    if (remaining <= 0) return;
    const seconds = Math.max(1, Math.ceil(remaining / 1000));
    await writeStatus(`Waiting ${seconds}s before the next generation…`, 'info', {
      countdownUntil: Number(nextRunAt),
      countdownLabel: item?.label || '',
    });
    await sleep(Math.min(remaining, 1000));
  }
}

// ── the queue ───────────────────────────────────────────────────────────────
async function getQueue() {
  const { queue = [] } = await chrome.storage.local.get(QUEUE_KEY);
  return queue;
}

async function getFleetQueueRevision() {
  const stored = await chrome.storage.local.get(FLEET_REVISION_KEY);
  const revision = Number(stored[FLEET_REVISION_KEY]);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

// Every local queue/control-state mutation advances one durable revision. Hub
// commands carry the revision the operator saw, preventing a delayed command
// from acting on newer local work after a restart or manual change.
async function writeFleetRevision(values) {
  const revision = await getFleetQueueRevision();
  const nextRevision = revision >= Number.MAX_SAFE_INTEGER - 1 ? 1 : revision + 1;
  await chrome.storage.local.set({ ...values, [FLEET_REVISION_KEY]: nextRevision });
  return nextRevision;
}

async function setQueue(q) {
  await writeFleetRevision({ [QUEUE_KEY]: q });
}

async function cleanDiscardedArtifacts(before, after) {
  await deleteAudioArtifacts(caches, artifactsForDiscardedItems(before, after));
}

async function setQueuePaused(paused, { hub = false } = {}) {
  await writeFleetRevision({ [PAUSE_KEY]: !!paused, [FLEET_HUB_PAUSE_KEY]: !!paused && !!hub });
}

let _seq = 0;
function mkItem(o) {
  return { id: `${Date.now()}_${_seq++}`, status: 'pending', ...o };
}

let processing = false;

// Identity of a Story Studio section, used to dedupe (so a double-click — or
// re-queuing an episode — can't add the same chapter twice and waste credits).
function itemKey(it) {
  if (it?.kind === 'paste' && it.text) return `paste::${it.label || ''}::${it.text}`;
  return it.episodeCode && it.sectionSlug ? `${it.episodeCode}::${it.sectionSlug}` : null;
}

function isStudioQueueItem(item) {
  return !!(
    (item?.kind === 'paste' && typeof item.text === 'string' && item.target === 'download') ||
    (item?.slug && item.episodeCode && item.sectionSlug && (item.kind === 'intro' || item.kind === 'chapter'))
  );
}

async function enqueue(items) {
  if (!items?.length) return { ok: true, added: 0, skipped: 0 };
  let q = await getQueue();
  // If the previous run is fully finished, start a fresh queue so old
  // done/failed entries don't pile up — and clear a leftover pause flag so the
  // new batch actually runs (pausing only ever applies to its own batch).
  if (!q.some((i) => i.status === 'pending' || i.status === 'running')) {
    const previous = q;
    q = [];
    await setQueue(q);
    await cleanDiscardedArtifacts(previous, q);
    await setQueuePaused(false);
    await chrome.storage.local.remove(NEXT_RUN_KEY);
  }
  // Don't re-add anything already pending/running.
  const active = new Set(
    q.filter((i) => i.status === 'pending' || i.status === 'running').map(itemKey).filter(Boolean)
  );
  let added = 0;
  let skipped = 0;
  for (const it of items) {
    if (!isStudioQueueItem(it)) {
      skipped++;
      continue;
    }
    const key = itemKey(it);
    if (key && active.has(key)) {
      skipped++;
      continue;
    }
    q.push({ ...it, id: it.id || `${Date.now()}_${_seq++}`, status: 'pending', queuedAt: it.queuedAt || Date.now() });
    if (key) active.add(key);
    added++;
  }
  await setQueue(q);
  if (added) {
    alarmCreate();
    processQueue();
  }
  return { ok: true, added, skipped };
}

// Remove a single item from the queue — only if it hasn't started yet.
async function removeFromQueue(id) {
  const q = await getQueue();
  const next = q.filter((i) => !(i.id === id && i.status === 'pending'));
  await setQueue(next);
  await cleanDiscardedArtifacts(q, next);
  return { ok: true };
}

// Expand a whole project into queue items (done worker-side so the panel stays
// snappy). One item per missing section (intro + chapters) of every episode
// whose script is done but audio isn't.
async function enqueueProject({ slug, voice, autoTag, provider, providerSettings }) {
  const settings = await getSettings();
  const ps = providerSettings || getProviderSettings(settings, provider);
  const client = new StudioClient(settings.studioBaseUrl);
  const raw = await client.listEpisodes(slug);
  const eps = (Array.isArray(raw) ? raw : raw.episodes || []).filter(
    (e) => e.status?.script && !e.status?.audio
  );
  const items = [];
  for (const ep of eps) {
    const code = ep.episode_code || ep.code;
    let audio;
    try {
      audio = await client.audioStatus(slug, code);
    } catch {
      continue;
    }
    for (const it of missingSectionItems(audio.missing_files, { slug, code, title: ep.title || '', voice, autoTag, provider, providerSettings: ps })) {
      items.push(it);
    }
  }
  return enqueue(items).then((r) => ({ ...r, episodes: eps.length }));
}

// Build queue items from an audio-status missing_files list.
//
// missing_files is authoritative but lists one file PER CHUNK, so a chunked
// chapter appears as several `_partN` names. Map each back to its section and
// dedupe: two missing parts of Chapter 3 collapse to ONE `Chapter_03` job,
// which regenerates the section and fills every missing part at once.
function missingSectionItems(missingFiles, { slug, code, title, voice, autoTag, provider, providerSettings }) {
  const out = [];
  const seen = new Set();
  for (const f of missingFiles || []) {
    const section = sectionSlugFromFile(f, code);
    if (!section || seen.has(section)) continue;
    const isIntro = section === 'Introduction';
    const m = section.match(/^Chapter_(\d+)$/);
    if (!isIntro && !m) continue; // unknown section shape — no text endpoint to fetch it
    seen.add(section);
    const num = isIntro ? null : parseInt(m[1], 10);
    const numStr = isIntro ? '' : String(num).padStart(2, '0');
    out.push(
      mkItem({
        kind: isIntro ? 'intro' : 'chapter',
        slug,
        episodeCode: code,
        episodeTitle: title,
        sectionSlug: isIntro ? 'Introduction' : `Chapter_${numStr}`,
        chapterNumber: num,
        provider,
        voice,
        autoTag,
        providerSettings,
        label: `${code} ${isIntro ? 'Introduction' : 'Ch ' + num}`,
      })
    );
  }
  return out;
}

async function fetchItemText(item, client) {
  if (item.text) return item.text;
  if (!item.slug || !item.episodeCode) {
    throw new Error('Queue item is not linked to a Story Studio section. Queue it again from Story Studio.');
  }
  if (item.kind === 'intro') {
    const sc = await client.scriptContent(item.slug, item.episodeCode, item.episodeTitle);
    return sc?.introduction?.content || '';
  }
  const res = await client.chapterContent(item.slug, item.episodeCode, item.chapterNumber, item.episodeTitle);
  return res.content || res.text || '';
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    let settings = await getSettings();
    const client = new StudioClient(settings.studioBaseUrl);
    for (;;) {
      if (await isPaused()) {
        await writeStatus('Queue paused — press Resume to continue.', 'info');
        break;
      }
      settings = await getSettings();
      let q = await getQueue();
      const idx = q.findIndex((i) => i.status === 'pending');
      if (idx < 0) break;
      // Only a cooldown for the *next item's* provider should hold the queue —
      // one provider's cooldown must never block a pending item for another.
      if (await holdForCooldown(q[idx].provider || 'fish', settings)) return;
      const pendingId = q[idx].id;

      // Human-pace gap before starting (interruptible by Pause).
      await waitForNextRun(q[idx]);
      if (await isPaused()) {
        await writeStatus('Queue paused — press Resume to continue.', 'info');
        break;
      }

      q = await getQueue();
      const currentIdx = q.findIndex((i) => i.id === pendingId && i.status === 'pending');
      if (currentIdx < 0) continue; // removed/cleared while we waited
      const workKind = workKindForQueueItem(q[currentIdx]);
      if (workKind === 'review') {
        q[currentIdx].status = 'failed';
        q[currentIdx].ambiguous = true;
        q[currentIdx].requiresLocalReview = true;
        q[currentIdx].error = RECOVERY_REVIEW_MESSAGE;
        q[currentIdx].finishedAt = Date.now();
        await setQueue(q);
        await writeStatus(`${q[currentIdx].label}: ${RECOVERY_REVIEW_MESSAGE}`, 'info');
        continue;
      }
      q[currentIdx].status = 'running';
      q[currentIdx].startedAt = Date.now();
      delete q[currentIdx].finishedAt;
      delete q[currentIdx].durationMs;
      if (workKind === 'generate') q[currentIdx].phase = 'generating';
      await setQueue(q);
      const item = q[currentIdx];
      const pos = q.filter((i) => i.status === 'done' || i.status === 'failed').length + 1;
      await writeStatus(`(${pos}/${q.length}) ${item.label}…`, 'running');
      try {
        const job = {
          provider: item.provider,
          voice: item.voice,
          autoTag: item.autoTag,
          providerSettings: item.providerSettings,
          slug: item.slug,
          episodeCode: item.episodeCode,
          sectionSlug: item.sectionSlug,
          chapterNumber: item.chapterNumber,
          label: item.label,
          target: item.target || 'project',
          downloadPath: item.downloadPath,
        };
        let r;
        if (workKind === 'download') {
          r = await observeDownload(item.downloadId);
        } else {
          let audio;
          if (workKind === 'save') {
            audio = await getAudioArtifact(caches, item.artifact);
            if (!audio) throw Object.assign(new Error(`${RECOVERY_REVIEW_MESSAGE} The saved audio artifact is no longer available.`), { ambiguous: true });
          } else {
            const text = await fetchItemText(item, client);
            if (!text.trim()) throw new Error('no script text on disk');
            job.text = text;
            audio = await produceAudio(job, settings);
            try {
              const descriptor = await putAudioArtifact(caches, artifactDescriptor(item.id, audio.mime), audio);
              q = await getQueue();
              const generated = q.find((i) => i.id === item.id);
              if (!generated || generated.status !== 'running') throw new Error('Queue item was removed while audio was being saved.');
              generated.phase = 'saving';
              generated.artifact = descriptor;
              await setQueue(q);
            } catch (error) {
              throw markGeneratedAudioPersistenceFailure(error);
            }
          }
          if (job.target === 'download') {
            const started = await startDownload(job, audio);
            q = await getQueue();
            const downloading = q.find((i) => i.id === item.id);
            if (!downloading || downloading.status !== 'running') throw new Error('Queue item was removed while the download was starting.');
            downloading.phase = 'downloading';
            downloading.downloadId = started.downloadId;
            await setQueue(q);
            r = await observeDownload(started.downloadId);
          } else {
            r = await saveAudio(job, audio, settings);
          }
        }
        q = await getQueue();
        const it = q.find((i) => i.id === item.id);
        if (it) {
          const artifact = it.artifact;
          it.status = 'done';
          it.savedAs = r.savedAs;
          delete it.error;
          delete it.attempts;
          delete it.phase;
          delete it.artifact;
          delete it.ambiguous;
          delete it.requiresLocalReview;
          it.finishedAt = Date.now();
          it.durationMs = it.finishedAt - (it.startedAt || it.finishedAt);
          await setQueue(q);
          await deleteAudioArtifacts(caches, [artifact]);
        } else {
          await setQueue(q);
        }
      } catch (e) {
        q = await getQueue();
        const it = q.find((i) => i.id === item.id);
        if (!canHandleInFlightFailure(it)) continue;
        if (it && e?.ambiguous) {
          it.status = 'failed';
          it.error = String(e.message || RECOVERY_REVIEW_MESSAGE);
          it.ambiguous = true;
          it.requiresLocalReview = true;
          it.finishedAt = Date.now();
          it.durationMs = it.finishedAt - (it.startedAt || it.finishedAt);
          await setQueue(q);
          await writeStatus(`${item.label}: ${it.error}`, 'info');
          continue;
        }
        // A detected credit/quota/rate-limit failure (.limit — see the content
        // scripts / providers.js): re-pend the item (it's not really "failed",
        // the provider just needs a break) and either hold for an auto-resume
        // cooldown or hard-pause the whole queue, instead of ploughing through
        // every remaining item only to hit the same error on each one.
        if (e && e.limit) {
          const provider = item.provider || 'fish';
          const cd = providerCooldown(settings, provider);
          if (it) {
            it.status = 'pending';
            delete it.error;
            delete it.startedAt;
            delete it.finishedAt;
            delete it.durationMs;
            delete it.phase;
            delete it.ambiguous;
            delete it.requiresLocalReview;
          }
          await setQueue(q);
          const name = PROVIDERS[provider]?.displayName || provider;
          if (cd.autoResume) {
            const resumeAt = Date.now() + cd.minutes * 60000;
            await setCooldownUntil(provider, resumeAt);
            await writeStatus(`${name} limit reached — auto-resuming automatically.`, 'info', {
              countdownUntil: resumeAt,
              countdownReason: 'cooldown',
              countdownProvider: provider,
            });
            alarmCreate();
          } else {
            await setQueuePaused(true);
            const detail = e.message ? ` ${e.message}` : '';
            await writeStatus(`${name} limit reached — paused.${detail} Resume after it resets, or switch provider.`, 'info');
            alarmClear();
          }
          return; // stop this tick; the alarm (auto) or manual Resume continues it
        }
        const maxRetries = Math.max(0, Number(settings.maxRetries) || 0);
        if (it && (it.attempts || 0) < maxRetries) {
          it.attempts = (it.attempts || 0) + 1;
          it.status = 'pending';
          delete it.startedAt;
          if (it.phase === 'generating') delete it.phase;
          if (it.phase === 'downloading') {
            it.phase = 'saving';
            delete it.downloadId;
          }
          await setQueue(q);
          await writeStatus(`${item.label} failed — retry ${it.attempts}/${maxRetries}…`, 'running');
          await armHumanDelay(settings);
          continue;
        }
        if (it) {
          it.status = 'failed';
          it.error = String(e.message || e);
          if (it.phase === 'generating') delete it.phase;
          if (it.phase === 'downloading') {
            it.phase = 'saving';
            delete it.downloadId;
          }
          it.finishedAt = Date.now();
          it.durationMs = it.finishedAt - (it.startedAt || it.finishedAt);
        }
        await setQueue(q);
      }
      // Arm the pace gap for the next item (waited out at the top of the loop).
      if ((await getQueue()).some((i) => i.status === 'pending')) await armHumanDelay(settings);
    }
    const q = await getQueue();
    if (!(await isPaused()) && q.length && !q.some((i) => i.status === 'pending' || i.status === 'running')) {
      const done = q.filter((i) => i.status === 'done').length;
      const failed = q.filter((i) => i.status === 'failed').length;
      await writeStatus(`✓ Queue finished: ${done} saved${failed ? `, ${failed} failed` : ''}.`, 'done');
    }
    alarmClear();
  } finally {
    processing = false;
  }
}

// Drop only pending work; preserve active, completed, and failed history.
async function clearQueue() {
  const q = await getQueue();
  const next = q.filter((i) => i.status !== 'pending');
  await setQueue(next);
  await cleanDiscardedArtifacts(q, next);
  await writeStatus('Queue cleared.', 'info');
  return { ok: true };
}

// Pause: the in-flight item finishes and saves, then the loop stops.
async function pauseQueue({ hub = false } = {}) {
  await setQueuePaused(true, { hub });
  await writeStatus(processing ? 'Pausing — finishing the current item first…' : 'Queue paused — press Resume to continue.', 'info');
  return { ok: true };
}
async function resumeQueue() {
  // Manual resume overrides every provider's cooldown, not just the pause flag.
  await setQueuePaused(false);
  await chrome.storage.local.remove(NEXT_RUN_KEY);
  await clearAllCooldowns();
  alarmCreate();
  processQueue();
  return { ok: true };
}

// Re-pend failed items so the queue picks them up again. `id` targets one row;
// omit it to retry every failed item.
function isRemotelyRetryable(item) {
  return !!(
    item &&
    PROVIDERS[item.provider] &&
    retryQueueItem(item)
  );
}

async function retryFailed(id = null, { remote = false, ids = null } = {}) {
  const q = await getQueue();
  const selected = Array.isArray(ids) ? new Set(ids.filter((value) => typeof value === 'string')) : null;
  let retried = 0;
  for (let index = 0; index < q.length; index++) {
    const it = q[index];
    if (it.status !== 'failed' || (id && it.id !== id)) continue;
    if (selected && !selected.has(it.id)) continue;
    if (!PROVIDERS[it.provider]) continue;
    const retry = retryQueueItem(it);
    if (!retry || (remote && !isRemotelyRetryable(it))) continue;
    q[index] = retry;
    retried++;
  }
  if (retried) {
    await setQueue(q);
    if (!remote) {
      await setQueuePaused(false);
      await chrome.storage.local.remove(NEXT_RUN_KEY);
      await clearAllCooldowns();
    }
    await writeStatus(`Retrying ${retried} failed item${retried === 1 ? '' : 's'}…`, 'running');
    alarmCreate();
    processQueue();
  }
  return { ok: true, retried };
}

// ── Fleet Hub v2 adapter ───────────────────────────────────────────────────
// The Hub is transport/control-plane only. It never creates a provider tab or
// calls a provider: all work remains inside this durable sequential queue.
const FLEET_SESSION_ID = makeFleetRandomId();
let fleetHeartbeatInFlight = false;

function makeFleetRandomId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function makeFleetNonce() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function fleetHmacHex(secret, value) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fleetCanonicalMessage(timestamp, nonce, bodyText) {
  return `POST\n${FLEET_PATH}\n${timestamp}\n${nonce}\n${bodyText}`;
}

function fleetSafeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function getFleetIdentity() {
  const stored = await chrome.storage.local.get(FLEET_IDENTITY_KEY);
  const saved = stored[FLEET_IDENTITY_KEY];
  if (saved && typeof saved.agentId === 'string' && typeof saved.machineId === 'string') return saved;
  // IDs are random local identifiers rather than editable machine names. This
  // keeps the four generator extensions distinct even on one Mac.
  const identity = { agentId: `audio:${makeFleetRandomId()}`, machineId: makeFleetRandomId() };
  await chrome.storage.local.set({ [FLEET_IDENTITY_KEY]: identity });
  return identity;
}

async function consumeFleetResponseNonce(nonce, timestamp) {
  if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 256) return false;
  const now = Date.now();
  const stored = await chrome.storage.local.get(FLEET_RESPONSE_NONCES_KEY);
  const active = stored[FLEET_RESPONSE_NONCES_KEY] && typeof stored[FLEET_RESPONSE_NONCES_KEY] === 'object'
    ? stored[FLEET_RESPONSE_NONCES_KEY]
    : {};
  for (const [key, expiresAt] of Object.entries(active)) if (!Number.isFinite(expiresAt) || expiresAt <= now) delete active[key];
  if (active[nonce]) return false;
  active[nonce] = Number(timestamp) + 60_000;
  const bounded = Object.entries(active)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 128);
  await chrome.storage.local.set({ [FLEET_RESPONSE_NONCES_KEY]: Object.fromEntries(bounded) });
  return true;
}

async function verifyFleetResponse(response, bodyText, secret) {
  const timestamp = response.headers.get('X-Fleet-Timestamp') || '';
  const nonce = response.headers.get('X-Fleet-Nonce') || '';
  const signature = response.headers.get('X-Fleet-Signature') || '';
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 60_000) return false;
  const expected = await fleetHmacHex(secret, fleetCanonicalMessage(timestamp, nonce, bodyText));
  if (!fleetSafeEqual(expected, signature)) return false;
  return consumeFleetResponseNonce(nonce, timestampMs);
}

async function getFleetCommandRecords(key) {
  const stored = await chrome.storage.local.get(key);
  return stored[key] && typeof stored[key] === 'object' ? stored[key] : {};
}

async function recordFleetCommandResult(commandId, outcome, detail = '') {
  const now = Date.now();
  const revision = await getFleetQueueRevision();
  const result = { commandId, outcome, detail: String(detail || '').slice(0, 300), queueRevision: revision, updatedAt: now };
  const [receipts, results] = await Promise.all([
    getFleetCommandRecords(FLEET_COMMAND_RECEIPTS_KEY),
    getFleetCommandRecords(FLEET_COMMAND_RESULTS_KEY),
  ]);
  if (['succeeded', 'failed', 'rejected', 'expired'].includes(outcome)) receipts[commandId] = result;
  results[commandId] = result;
  const trim = (records) => Object.fromEntries(Object.entries(records).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 128));
  await chrome.storage.local.set({
    [FLEET_COMMAND_RECEIPTS_KEY]: trim(receipts),
    [FLEET_COMMAND_RESULTS_KEY]: trim(results),
  });
  return result;
}

async function fleetCommandResults() {
  const results = await getFleetCommandRecords(FLEET_COMMAND_RESULTS_KEY);
  return Object.values(results)
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(-50)
    .map(({ updatedAt, ...result }) => result);
}

function trimFleetText(value, max = 160) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

async function buildFleetHeartbeatBody(settings) {
  const [identity, queue, paused, hubPaused, cooldowns, stored, revision, commandResults] = await Promise.all([
    getFleetIdentity(),
    getQueue(),
    isPaused(),
    isHubPaused(),
    getCooldowns(),
    chrome.storage.local.get('lastStatus'),
    getFleetQueueRevision(),
    fleetCommandResults(),
  ]);
  const counts = {
    pending: queue.filter((item) => item.status === 'pending').length,
    running: queue.filter((item) => item.status === 'running').length,
    done: queue.filter((item) => item.status === 'done').length,
    failed: queue.filter((item) => item.status === 'failed').length,
  };
  const currentItem = queue.find((item) => item.status === 'running') || null;
  const nextItem = queue.find((item) => item.status === 'pending') || null;
  const activeCooldowns = Object.entries(cooldowns)
    .filter(([, until]) => Number(until) > Date.now())
    .map(([provider, until]) => ({ provider: trimFleetText(provider, 40), until: Number(until) }));
  const nextCooldown = activeCooldowns.find((entry) => entry.provider === (nextItem?.provider || settings.provider)) || null;
  let state = 'idle';
  if (paused) state = hubPaused ? 'hub_paused' : 'paused';
  else if (nextCooldown) state = 'cooldown';
  else if (counts.running) state = 'running';
  else if (counts.pending) state = 'queued';

  const detailed = settings.fleetTelemetryDetails === true;
  const snapshot = {
    queueRevision: revision,
    state,
    counts,
    current: currentItem ? { id: currentItem.id, ...(detailed ? { label: trimFleetText(currentItem.label) } : {}) } : null,
    cooldown: nextCooldown,
    config: {
      provider: trimFleetText(settings.provider, 40),
      pacing: {
        minSeconds: Math.max(0, Number(settings.humanDelayMinSec) || 0),
        maxSeconds: Math.max(0, Number(settings.humanDelayMaxSec) || 0),
      },
    },
    health: {
      studioConfigured: !!String(settings.studioBaseUrl || '').trim(),
      ...(detailed && stored.lastStatus ? { localStatus: trimFleetText(stored.lastStatus.text) } : {}),
    },
    ...(detailed
      ? {
          retryableFailedIds: queue.filter(isRemotelyRetryable).map((item) => item.id).slice(0, 50),
          activeCooldowns,
        }
      : {}),
  };
  return {
    protocolVersion: FLEET_PROTOCOL_VERSION,
    agent: {
      ...identity,
      extensionType: 'audio',
      sessionId: FLEET_SESSION_ID,
      version: chrome.runtime.getManifest().version,
      displayName: trimFleetText(settings.fleetAgentName, 80),
      capabilities: { actions: ['pause_after_current', 'resume_hub_pause', 'clear_pending', 'retry_failed'] },
      consent: { telemetry: settings.fleetAgentEnabled === true, queueControl: settings.fleetQueueControlEnabled === true },
    },
    snapshot,
    commandResults,
  };
}

function activeCooldownPresent(cooldowns) {
  return Object.values(cooldowns || {}).some((until) => Number(until) > Date.now());
}

async function executeFleetCommand(command, settings) {
  const commandId = typeof command?.commandId === 'string' ? command.commandId : typeof command?.id === 'string' ? command.id : '';
  if (!commandId) return;
  const identity = await getFleetIdentity();
  if (command.targetAgentId !== identity.agentId) return recordFleetCommandResult(commandId, 'rejected', 'wrong_target_agent');
  if (command.targetSessionId !== FLEET_SESSION_ID) return recordFleetCommandResult(commandId, 'rejected', 'wrong_target_session');
  const now = Date.now();
  const createdAt = Number(command.createdAt);
  const expiresAt = Number(command.expiresAt);
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    createdAt > expiresAt ||
    expiresAt - createdAt > 15 * 60_000 ||
    createdAt > now + 60_000
  ) {
    return recordFleetCommandResult(commandId, 'rejected', 'invalid_command_window');
  }
  const receipts = await getFleetCommandRecords(FLEET_COMMAND_RECEIPTS_KEY);
  if (receipts[commandId]) return; // durable terminal receipt: never run twice.
  if (expiresAt <= now) return recordFleetCommandResult(commandId, 'expired', 'command_expired');
  const expected = command.expectedQueueRevision;
  const actual = await getFleetQueueRevision();
  if (!Number.isSafeInteger(expected) || expected !== actual) return recordFleetCommandResult(commandId, 'rejected', 'queue_revision_mismatch');
  if (settings.fleetQueueControlEnabled !== true) return recordFleetCommandResult(commandId, 'rejected', 'queue_control_not_consented');

  await recordFleetCommandResult(commandId, 'accepted');
  try {
    switch (command.action) {
      case 'pause_after_current':
        if (await isPaused()) {
          if (!(await isHubPaused())) return recordFleetCommandResult(commandId, 'rejected', 'locally_paused');
        } else {
          await pauseQueue({ hub: true });
        }
        break;
      case 'resume_hub_pause': {
        if (!(await isHubPaused())) return recordFleetCommandResult(commandId, 'rejected', 'not_hub_paused');
        if (activeCooldownPresent(await getCooldowns())) return recordFleetCommandResult(commandId, 'rejected', 'cooldown_active');
        await setQueuePaused(false);
        alarmCreate();
        processQueue();
        break;
      }
      case 'clear_pending':
        await clearQueue();
        break;
      case 'retry_failed': {
        const itemIds = Array.isArray(command.payload?.itemIds) ? command.payload.itemIds : null;
        if (!itemIds || !itemIds.length) return recordFleetCommandResult(commandId, 'rejected', 'retry_item_ids_required');
        const result = await retryFailed(null, { remote: true, ids: itemIds });
        if (!result.retried) return recordFleetCommandResult(commandId, 'rejected', 'no_retryable_failed_items');
        break;
      }
      default:
        return recordFleetCommandResult(commandId, 'rejected', 'unsupported_action');
    }
    return recordFleetCommandResult(commandId, 'succeeded');
  } catch (error) {
    return recordFleetCommandResult(commandId, 'failed', trimFleetText(error?.message || error, 240));
  }
}

async function ensureFleetAlarm(settings = null) {
  const configured = settings || await getSettings();
  try {
    if (configured.fleetAgentEnabled && String(configured.fleetHubUrl || '').trim()) {
      chrome.alarms.create(FLEET_ALARM, { periodInMinutes: 0.5 });
    } else {
      chrome.alarms.clear(FLEET_ALARM);
    }
  } catch {
    /* alarms unavailable — an active worker will still attempt a heartbeat */
  }
}

async function fleetHeartbeat({ allowDisabled = false } = {}) {
  if (fleetHeartbeatInFlight) return { ok: false, error: 'heartbeat_in_progress' };
  fleetHeartbeatInFlight = true;
  try {
    const settings = await getSettings();
    const hub = String(settings.fleetHubUrl || '').trim().replace(/\/+$/, '');
    const secret = await getFleetPairingSecret();
    await ensureFleetAlarm(settings);
    if ((!settings.fleetAgentEnabled && !allowDisabled) || !hub || !secret) {
      return { ok: false, error: !hub ? 'hub_url_required' : !secret ? 'pairing_secret_required' : 'fleet_disabled' };
    }
    const payload = await buildFleetHeartbeatBody(settings);
    const bodyText = JSON.stringify(payload);
    const timestamp = String(Date.now());
    const nonce = makeFleetNonce();
    const signature = await fleetHmacHex(secret, fleetCanonicalMessage(timestamp, nonce, bodyText));
    const response = await fetch(`${hub}${FLEET_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Fleet-Timestamp': timestamp,
        'X-Fleet-Nonce': nonce,
        'X-Fleet-Signature': signature,
      },
      body: bodyText,
    });
    const responseText = await response.text();
    if (!response.ok) throw new Error(`Hub returned ${response.status}`);
    if (!(await verifyFleetResponse(response, responseText, secret))) throw new Error('Hub response authentication failed');
    const reply = JSON.parse(responseText || '{}');
    if (reply.protocolVersion !== FLEET_PROTOCOL_VERSION) throw new Error('Hub protocol version mismatch');
    await chrome.storage.local.set({ [FLEET_STATUS_KEY]: { ok: true, at: Date.now(), error: '' } });
    // Commands are deliberately ignored until telemetry is explicitly enabled.
    if (settings.fleetAgentEnabled) {
      for (const command of Array.isArray(reply.commands) ? reply.commands : []) await executeFleetCommand(command, settings);
    }
    return { ok: true, commands: Array.isArray(reply.commands) ? reply.commands.length : 0 };
  } catch (error) {
    const message = trimFleetText(error?.message || error, 240);
    await chrome.storage.local.set({ [FLEET_STATUS_KEY]: { ok: false, at: Date.now(), error: message } });
    return { ok: false, error: message };
  } finally {
    fleetHeartbeatInFlight = false;
  }
}

// Resume safe saves after a worker restart, quarantine uncertain provider
// submissions, migrate legacy ElevenLabs jobs, and stop retired OpenAI jobs.
(async () => {
  let q = await getQueue();
  const recovered = recoverQueueAfterRestart(q);
  q = recovered.queue;
  let changed = recovered.changed;
  for (const i of q) {
    if (i.provider === 'elevenlabs') {
      i.provider = 'elevenlabs_web';
      changed = true;
    }
    if (i.provider === 'openai' && (i.status === 'pending' || i.status === 'running')) {
      i.status = 'failed';
      i.error = 'OpenAI TTS was removed. Re-queue this section with fish.audio or ElevenLabs.';
      i.finishedAt = Date.now();
      changed = true;
      continue;
    }
    if (i.status === 'running') {
      i.status = 'pending';
      changed = true;
    }
  }
  if (changed) await setQueue(q);
  await sweepOrphanedAudioArtifacts(caches, q).catch(() => {});
  if (q.some((i) => i.status === 'pending') && !(await isPaused())) {
    alarmCreate();
    processQueue();
  }
})();

chrome.alarms?.onAlarm?.addListener((a) => {
  if (a.name === ALARM) {
    processQueue();
    fleetHeartbeat();
  } else if (a.name === FLEET_ALARM) {
    fleetHeartbeat();
  }
});

// MV3 workers are routinely suspended while idle. A durable alarm restores
// idle telemetry without touching a provider tab or the local queue.
getSettings().then((settings) => {
  ensureFleetAlarm(settings);
  if (settings.fleetAgentEnabled) fleetHeartbeat();
}).catch(() => {});

async function providerInventory(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) throw new Error('This provider is no longer supported.');
  // Use an already-open tab; never open one just to read the voice list.
  const tab = await findProviderTab(p);
  if (!tab) throw new Error(`Open the ${p.displayName} page first (↗ Open workspace), then refresh inventory.`);
  const response = await send(tab.id, { type: `${p.messageNamespace}:inventory` });
  const inventory = providerId === 'elevenlabs_web'
    ? createElevenInventory(response.raw?.modelsPayload, response.raw?.voices)
    : createFishInventory(response.raw?.fishModelOptions, response.raw?.voices);
  return { ok: true, inventory: { ...inventory, fetchedAt: Date.now() } };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const reply = (p) => p.then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  switch (msg?.type) {
    case 'enqueue':
      reply(enqueue(msg.items));
      return true;
    case 'removeItem':
      reply(removeFromQueue(msg.id));
      return true;
    case 'enqueueProject':
      reply(enqueueProject(msg.payload));
      return true;
    case 'clearQueue':
      reply(clearQueue());
      return true;
    case 'pauseQueue':
      reply(pauseQueue());
      return true;
    case 'resumeQueue':
      reply(resumeQueue());
      return true;
    case 'retryFailed':
      reply(retryFailed(msg.id || null));
      return true;
    case 'testFleetConnection':
      reply(fleetHeartbeat({ allowDisabled: true }));
      return true;
    case 'refreshFleetAgent':
      reply(getSettings().then(async (settings) => {
        await ensureFleetAlarm(settings);
        return settings.fleetAgentEnabled ? fleetHeartbeat() : { ok: true, disabled: true };
      }));
      return true;
    case 'getQueue':
      reply(getQueue().then(async (queue) => ({ ok: true, queue, paused: await isPaused() })));
      return true;
    case 'providerInventory':
      reply(providerInventory(msg.provider));
      return true;
    case 'openProviderPage':
      reply(openProviderPage(msg.provider));
      return true;
    default:
      return false;
  }
});
