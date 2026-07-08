// Service worker — a persistent, resumable generation QUEUE.
//
// The panel enqueues work (a section, a whole episode, or a whole project);
// this worker processes one item at a time, human-paced, writing each result
// to the Story Studio project folder (or Downloads). The queue lives in
// chrome.storage, so it survives the panel closing AND the worker being
// killed: a chrome.alarms tick wakes the worker to resume any pending items.
//
// Strictly sequential — only ever one fish.audio generation in flight, so the
// site is never flooded no matter how much you queue.

import { getSettings, getApiKeys, getProviderSettings, providerCooldown } from './lib/config.js';
import { StudioClient } from './lib/story-studio.js';
import { buildDownloadPath, sectionSlugFromFile } from './lib/naming.js';
import { PROVIDERS, listVoices as listApiVoices, generate as apiGenerate, buildElevenVoiceSettings } from './lib/providers.js';

const QUEUE_KEY = 'queue';
const ALARM = 'queueTick';
// User-requested pause: the in-flight item finishes, then the loop stops until
// Resume. Human-pace timing: when the next generation is allowed to start.
const PAUSE_KEY = 'queuePaused';
const NEXT_RUN_KEY = 'nextRunAt';
const isPaused = async () => !!(await chrome.storage.local.get(PAUSE_KEY))[PAUSE_KEY];

// Per-provider cooldown, keyed by provider id -> resume-at timestamp (ms). Set
// when a generation fails with `.limit` (a detected credit/quota/rate-limit
// error — see the content scripts / providers.js) and that provider's
// auto-resume is on; cleared on manual Resume or once it naturally elapses.
const COOLDOWN_KEY = 'providerCooldownUntil';
const getCooldowns = async () => (await chrome.storage.local.get(COOLDOWN_KEY))[COOLDOWN_KEY] || {};
async function setCooldownUntil(provider, resumeAt) {
  const map = await getCooldowns();
  map[provider] = resumeAt;
  await chrome.storage.local.set({ [COOLDOWN_KEY]: map });
}
async function clearCooldown(provider) {
  const map = await getCooldowns();
  if (!(provider in map)) return;
  delete map[provider];
  await chrome.storage.local.set({ [COOLDOWN_KEY]: map });
}
const clearAllCooldowns = () => chrome.storage.local.remove(COOLDOWN_KEY);

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
      if (p.type !== 'webSession') continue;
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
  if (!p || p.type !== 'webSession') {
    return { ok: false, error: 'This provider needs no page — it calls the API directly with your key.' };
  }
  const tabs = await chrome.tabs.query({ url: p.origin });
  if (tabs[0]) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true }).catch(() => {});
    return { ok: true, opened: false };
  }
  await chrome.tabs.create({ url: p.appUrl, active: true });
  return { ok: true, opened: true };
}

// Find a ready tab on the provider's site, or open its app page and wait.
// Used only when a queued generation actually needs the tab (opens in the
// background so "queue and walk away" still works unattended).
async function ensureProviderTab(p) {
  const tabs = await chrome.tabs.query({ url: p.origin });
  const ready = tabs.find((t) => t.status === 'complete');
  if (ready) return ready;
  const tab = tabs[0] || (await chrome.tabs.create({ url: p.appUrl, active: false }));
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
  const res = await chrome.tabs.sendMessage(tabId, message);
  if (!res || !res.ok)
    throw Object.assign(new Error(res?.error || 'No response from the provider page.'), { limit: !!res?.limit });
  return res;
}

// Produce audio bytes for a job, routed by provider:
//   - webSession (fish.audio): drive the page's content script.
//   - apiKey (ElevenLabs, OpenAI): call the official API with the stored key.
// Returns { base64, mime }.
async function produceAudio(job, settings) {
  const providerId = job.provider || settings.provider || 'fish';
  const p = PROVIDERS[providerId] || PROVIDERS.fish;
  if (!job.text || !job.text.trim()) throw new Error('No script text to generate.');

  // Per-provider tuning (model + voice settings / speed): the item's snapshot
  // from when it was queued, or the current settings for a fresh call.
  const ps = job.providerSettings || getProviderSettings(settings, providerId);

  if (p.type === 'webSession') {
    const voice = job.voice || settings.voiceByProvider?.[providerId] || (providerId === 'fish' ? settings.fishVoice : '');
    if (!voice) throw new Error(`No ${p.name} voice selected. Pick one in the panel.`);
    const tab = await ensureProviderTab(p);
    return send(tab.id, {
      type: `${p.msg}:generate`,
      text: job.text,
      voice,
      speed: ps.speed ?? 1,
      autoTag: !!job.autoTag,
      // ElevenLabs (web): model + voice_settings, built here so the content
      // script stays logic-free. fish ignores these.
      model: ps.model,
      voiceSettings: providerId === 'elevenlabs_web' ? buildElevenVoiceSettings(ps, ps.model) : undefined,
    });
  }
  // apiKey provider — no browser tab needed.
  const keys = await getApiKeys();
  return apiGenerate(providerId, { text: job.text, voice: job.voice, keys, settings: ps });
}

// Generate one section's audio and save it (project folder or Downloads).
async function generateAndSave(job, settings) {
  const { base64, mime } = await produceAudio(job, settings);
  const ext = mime === 'audio/wav' ? 'wav' : 'mp3';

  if (job.target === 'project' && job.slug && job.episodeCode) {
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
    return { savedAs: j.saved_as, savedIn: j.audio_dir, target: 'project' };
  }

  const filename = job.downloadPath.replace(/\.(mp3|wav)$/i, '') + `.${ext}`;
  const downloadId = await chrome.downloads.download({
    url: `data:${mime};base64,${base64}`,
    filename,
    saveAs: false,
    conflictAction: 'uniquify',
  });
  return { downloadId, savedAs: filename, target: 'download' };
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
  const name = PROVIDERS[provider]?.name || provider;
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
async function setQueue(q) {
  await chrome.storage.local.set({ [QUEUE_KEY]: q });
}

let _seq = 0;
function mkItem(o) {
  return { id: `${Date.now()}_${_seq++}`, status: 'pending', ...o };
}

let processing = false;

// Identity of a companion section, used to dedupe (so a double-click — or
// re-queuing an episode — can't add the same chapter twice and waste credits).
function itemKey(it) {
  return it.episodeCode && it.sectionSlug ? `${it.episodeCode}::${it.sectionSlug}` : null;
}

async function enqueue(items) {
  if (!items?.length) return { ok: true, added: 0, skipped: 0 };
  let q = await getQueue();
  // If the previous run is fully finished, start a fresh queue so old
  // done/failed entries don't pile up — and clear a leftover pause flag so the
  // new batch actually runs (pausing only ever applies to its own batch).
  if (!q.some((i) => i.status === 'pending' || i.status === 'running')) {
    q = [];
    await chrome.storage.local.remove([PAUSE_KEY, NEXT_RUN_KEY]);
  }
  // Don't re-add anything already pending/running.
  const active = new Set(
    q.filter((i) => i.status === 'pending' || i.status === 'running').map(itemKey).filter(Boolean)
  );
  let added = 0;
  let skipped = 0;
  for (const it of items) {
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
  await setQueue(q.filter((i) => !(i.id === id && i.status === 'pending')));
  return { ok: true };
}

// Expand a whole project into queue items (done worker-side so the panel stays
// snappy). One item per missing section (intro + chapters) of every episode
// whose script is done but audio isn't.
async function enqueueProject({ slug, target, voice, autoTag, provider, providerSettings }) {
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
    for (const it of missingSectionItems(audio.missing_files, { slug, code, title: ep.title || '', target, voice, autoTag, provider, providerSettings: ps })) {
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
function missingSectionItems(missingFiles, { slug, code, title, target, voice, autoTag, provider, providerSettings }) {
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
        target,
        provider,
        voice,
        autoTag,
        providerSettings,
        // tokens for Downloads naming:
        project: title,
        chapterNum: numStr,
        chapterLabel: isIntro ? 'Introduction' : `Chapter ${num}`,
        label: `${code} ${isIntro ? 'Introduction' : 'Ch ' + num}`,
      })
    );
  }
  return out;
}

async function fetchItemText(item, client) {
  if (item.text) return item.text; // paste-mode items carry their own text
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
      q[currentIdx].status = 'running';
      q[currentIdx].startedAt = Date.now();
      delete q[currentIdx].finishedAt;
      delete q[currentIdx].durationMs;
      await setQueue(q);
      const item = q[currentIdx];
      const pos = q.filter((i) => i.status === 'done' || i.status === 'failed').length + 1;
      await writeStatus(`(${pos}/${q.length}) ${item.label}…`, 'running');
      try {
        const text = await fetchItemText(item, client);
        if (!text.trim()) throw new Error('no script text on disk');
        const job = {
          text,
          provider: item.provider,
          voice: item.voice,
          target: item.target,
          autoTag: item.autoTag,
          slug: item.slug,
          episodeCode: item.episodeCode,
          sectionSlug: item.sectionSlug,
          chapterNumber: item.chapterNumber,
          label: item.label,
        };
        if (item.target !== 'project') {
          job.downloadPath = buildDownloadPath(settings, {
            project: item.project,
            episodeCode: item.episodeCode,
            episodeTitle: item.episodeTitle,
            chapterNum: item.chapterNum,
            chapterLabel: item.chapterLabel,
          });
        }
        const r = await generateAndSave(job, settings);
        q = await getQueue();
        const it = q.find((i) => i.id === item.id);
        if (it) {
          it.status = 'done';
          it.savedAs = r.savedAs;
          delete it.error;
          delete it.attempts;
          it.finishedAt = Date.now();
          it.durationMs = it.finishedAt - (it.startedAt || it.finishedAt);
        }
        await setQueue(q);
      } catch (e) {
        // A detected credit/quota/rate-limit failure (.limit — see the content
        // scripts / providers.js): re-pend the item (it's not really "failed",
        // the provider just needs a break) and either hold for an auto-resume
        // cooldown or hard-pause the whole queue, instead of ploughing through
        // every remaining item only to hit the same error on each one.
        if (e && e.limit) {
          const provider = item.provider || 'fish';
          const cd = providerCooldown(settings, provider);
          q = await getQueue();
          const it = q.find((i) => i.id === item.id);
          if (it) {
            it.status = 'pending';
            delete it.error;
            delete it.startedAt;
            delete it.finishedAt;
            delete it.durationMs;
          }
          await setQueue(q);
          const name = PROVIDERS[provider]?.name || provider;
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
            await chrome.storage.local.set({ [PAUSE_KEY]: true });
            const detail = e.message ? ` ${e.message}` : '';
            await writeStatus(`${name} limit reached — paused.${detail} Resume after it resets, or switch provider.`, 'info');
            alarmClear();
          }
          return; // stop this tick; the alarm (auto) or manual Resume continues it
        }
        // Auto-retry (generation OR save/download failure) up to maxRetries
        // before marking it failed — repairs a flaky download without user input.
        const maxRetries = Math.max(0, Number(settings.maxRetries) || 0);
        q = await getQueue();
        const it = q.find((i) => i.id === item.id);
        if (it && (it.attempts || 0) < maxRetries) {
          it.attempts = (it.attempts || 0) + 1;
          it.status = 'pending';
          delete it.startedAt;
          await setQueue(q);
          await writeStatus(`${item.label} failed — retry ${it.attempts}/${maxRetries}…`, 'running');
          await armHumanDelay(settings);
          continue;
        }
        if (it) {
          it.status = 'failed';
          it.error = String(e.message || e);
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

// Drop everything not yet started; let an in-flight item finish on its own.
async function clearQueue() {
  const q = (await getQueue()).filter((i) => i.status === 'running');
  await setQueue(q);
  await writeStatus('Queue cleared.', 'info');
  return { ok: true };
}

// Pause: the in-flight item finishes and saves, then the loop stops.
async function pauseQueue() {
  await chrome.storage.local.set({ [PAUSE_KEY]: true });
  await writeStatus(processing ? 'Pausing — finishing the current item first…' : 'Queue paused — press Resume to continue.', 'info');
  return { ok: true };
}
async function resumeQueue() {
  // Manual resume overrides every provider's cooldown, not just the pause flag.
  await chrome.storage.local.remove([PAUSE_KEY, NEXT_RUN_KEY]);
  await clearAllCooldowns();
  alarmCreate();
  processQueue();
  return { ok: true };
}

// Re-pend failed items so the queue picks them up again. `id` targets one row;
// omit it to retry every failed item.
async function retryFailed(id = null) {
  const q = await getQueue();
  let retried = 0;
  for (const it of q) {
    if (it.status !== 'failed' || (id && it.id !== id)) continue;
    it.status = 'pending';
    it.attempts = 0;
    delete it.error;
    delete it.startedAt;
    delete it.finishedAt;
    delete it.durationMs;
    retried++;
  }
  if (retried) {
    await setQueue(q);
    await chrome.storage.local.remove([PAUSE_KEY, NEXT_RUN_KEY]);
    await clearAllCooldowns();
    await writeStatus(`Retrying ${retried} failed item${retried === 1 ? '' : 's'}…`, 'running');
    alarmCreate();
    processQueue();
  }
  return { ok: true, retried };
}

// Resume after a worker restart: re-pend any item that was mid-flight when the
// worker died, then keep going if anything is pending.
(async () => {
  const q = await getQueue();
  let changed = false;
  for (const i of q)
    if (i.status === 'running') {
      i.status = 'pending';
      changed = true;
    }
  if (changed) await setQueue(q);
  if (q.some((i) => i.status === 'pending') && !(await isPaused())) {
    alarmCreate();
    processQueue();
  }
})();

chrome.alarms?.onAlarm?.addListener((a) => {
  if (a.name === ALARM) processQueue();
});

async function listVoices(providerId) {
  const p = PROVIDERS[providerId] || PROVIDERS.fish;
  if (p.type === 'webSession') {
    // Use an already-open tab; never open one just to read the voice list.
    const tab = await findProviderTab(p);
    if (!tab) throw new Error(`Open the ${p.name} page first (↗ Open ${p.name}), then load voices.`);
    const { voices } = await send(tab.id, { type: `${p.msg}:listVoices` });
    return { ok: true, voices };
  }
  const keys = await getApiKeys();
  return { ok: true, voices: await listApiVoices(providerId, keys) };
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
    case 'getQueue':
      reply(getQueue().then(async (queue) => ({ ok: true, queue, paused: await isPaused() })));
      return true;
    case 'listVoices':
      reply(listVoices(msg.provider));
      return true;
    case 'openProviderPage':
      reply(openProviderPage(msg.provider));
      return true;
    default:
      return false;
  }
});
