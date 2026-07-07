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

import { getSettings, getApiKeys } from './lib/config.js';
import { StudioClient } from './lib/story-studio.js';
import { buildDownloadPath } from './lib/naming.js';
import { PROVIDERS, listVoices as listApiVoices, generate as apiGenerate } from './lib/providers.js';

const QUEUE_KEY = 'queue';
const ALARM = 'queueTick';

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
  if (!res || !res.ok) throw new Error(res?.error || 'No response from the provider page.');
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

  if (p.type === 'webSession') {
    const voice = job.voice || settings.voiceByProvider?.[providerId] || (providerId === 'fish' ? settings.fishVoice : '');
    if (!voice) throw new Error(`No ${p.name} voice selected. Pick one in the panel.`);
    const tab = await ensureProviderTab(p);
    return send(tab.id, {
      type: `${p.msg}:generate`,
      text: job.text,
      voice,
      speed: job.speed ?? 1,
      autoTag: !!job.autoTag,
    });
  }
  // apiKey provider — no browser tab needed.
  const keys = await getApiKeys();
  return apiGenerate(providerId, { text: job.text, voice: job.voice, keys });
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
async function writeStatus(text, kind = 'info') {
  try {
    await chrome.storage.local.set({ lastStatus: { text, kind, ts: Date.now() } });
  } catch {
    /* best-effort */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const politeGap = () => 2500 + Math.floor(Math.random() * 3500); // 2.5–6s

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
  // done/failed entries don't pile up.
  if (!q.some((i) => i.status === 'pending' || i.status === 'running')) q = [];
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
    q.push({ ...it, id: it.id || `${Date.now()}_${_seq++}`, status: 'pending' });
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
async function enqueueProject({ slug, target, voice, autoTag, provider }) {
  const settings = await getSettings();
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
    for (const it of missingSectionItems(audio.missing_files, { slug, code, title: ep.title || '', target, voice, autoTag, provider })) {
      items.push(it);
    }
  }
  return enqueue(items).then((r) => ({ ...r, episodes: eps.length }));
}

// Build queue items from an audio-status missing_files list.
function missingSectionItems(missingFiles, { slug, code, title, target, voice, autoTag, provider }) {
  const out = [];
  for (const f of missingFiles || []) {
    const isIntro = /_Introduction\.(mp3|wav)$/i.test(f);
    const m = f.match(/_Chapter_(\d+)\.(?:mp3|wav)$/i);
    if (!isIntro && !m) continue;
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
    const settings = await getSettings();
    const client = new StudioClient(settings.studioBaseUrl);
    for (;;) {
      let q = await getQueue();
      const idx = q.findIndex((i) => i.status === 'pending');
      if (idx < 0) break;
      q[idx].status = 'running';
      await setQueue(q);
      const item = q[idx];
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
        }
        await setQueue(q);
      } catch (e) {
        q = await getQueue();
        const it = q.find((i) => i.id === item.id);
        if (it) {
          it.status = 'failed';
          it.error = String(e.message || e);
        }
        await setQueue(q);
      }
      const more = (await getQueue()).some((i) => i.status === 'pending');
      if (more) await sleep(politeGap());
    }
    const q = await getQueue();
    if (q.length) {
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
  if (q.some((i) => i.status === 'pending')) {
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
    case 'getQueue':
      reply(getQueue().then((queue) => ({ ok: true, queue })));
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
