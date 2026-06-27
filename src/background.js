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

import { getSettings } from './lib/config.js';
import { StudioClient } from './lib/story-studio.js';
import { buildDownloadPath } from './lib/naming.js';

const FISH_APP_URL = 'https://fish.audio/text-to-speech/';
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

// On install/update, reload open fish.audio tabs so their content scripts
// aren't stale (they keep old code until the page reloads).
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://fish.audio/*' });
    for (const t of tabs) chrome.tabs.reload(t.id);
  } catch {
    /* best-effort */
  }
});

// ── fish.audio tab plumbing ─────────────────────────────────────────────────
async function ensureFishTab() {
  const tabs = await chrome.tabs.query({ url: 'https://fish.audio/*' });
  const ready = tabs.find((t) => t.status === 'complete');
  if (ready) return ready;
  const tab = tabs[0] || (await chrome.tabs.create({ url: FISH_APP_URL, active: false }));
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
  if (!res || !res.ok) throw new Error(res?.error || 'No response from fish.audio.');
  return res;
}

// Generate one section's audio on fish.audio and save it (project or Downloads).
async function generateAndSave(job, settings, tab) {
  const voice = job.voice || settings.fishVoice;
  if (!voice) throw new Error('No fish.audio voice selected. Pick one in Settings.');
  if (!job.text || !job.text.trim()) throw new Error('No script text to generate.');

  const { base64, mime } = await send(tab.id, {
    type: 'fish:generate',
    text: job.text,
    voice,
    speed: job.speed ?? 1,
    autoTag: !!job.autoTag,
  });
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

async function enqueue(items) {
  if (!items?.length) return { ok: true, added: 0 };
  let q = await getQueue();
  // If the previous run is fully finished, start a fresh queue so old
  // done/failed entries don't pile up in the counter.
  if (!q.some((i) => i.status === 'pending' || i.status === 'running')) q = [];
  for (const it of items) q.push({ ...it, id: it.id || `${Date.now()}_${_seq++}`, status: 'pending' });
  await setQueue(q);
  alarmCreate();
  processQueue();
  return { ok: true, added: items.length };
}

// Expand a whole project into queue items (done worker-side so the panel stays
// snappy). One item per missing section (intro + chapters) of every episode
// whose script is done but audio isn't.
async function enqueueProject({ slug, target, voice, autoTag }) {
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
    for (const it of missingSectionItems(audio.missing_files, { slug, code, title: ep.title || '', target, voice, autoTag })) {
      items.push(it);
    }
  }
  return enqueue(items).then((r) => ({ ...r, episodes: eps.length }));
}

// Build queue items from an audio-status missing_files list.
function missingSectionItems(missingFiles, { slug, code, title, target, voice, autoTag }) {
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
    let tab = null;
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
        if (!tab) tab = await ensureFishTab();
        const text = await fetchItemText(item, client);
        if (!text.trim()) throw new Error('no script text on disk');
        const job = {
          text,
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
        const r = await generateAndSave(job, settings, tab);
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

async function listVoices() {
  const tab = await ensureFishTab();
  const { voices } = await send(tab.id, { type: 'fish:listVoices' });
  return { ok: true, voices };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const reply = (p) => p.then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  switch (msg?.type) {
    case 'enqueue':
      reply(enqueue(msg.items));
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
      reply(listVoices());
      return true;
    default:
      return false;
  }
});
