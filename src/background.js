// Service worker — orchestrates a TTS job end to end.
//
// Flow (single job):
//   popup → background { type: "runJob", job }
//   background → fish.audio content bridge { type: "fish:generate", text, voice }
//   bridge → MAIN world → POST api.fish.audio/task (stream) → MP3 bytes
//   bridge → background { base64, mime }
//   background → save (project ingest OR chrome.downloads)
//
// Batch ("generate all chapters") reuses the same generate-and-save core in a
// sequential loop over one fish.audio tab, emitting progress as it goes. It
// runs in the worker so it survives the popup being closed.

import { getSettings } from './lib/config.js';

const FISH_APP_URL = 'https://fish.audio/text-to-speech/';

// Find a usable fish.audio tab (must be an /app page so grecaptcha is loaded),
// or open one in the background and wait for it to finish loading.
async function ensureFishTab() {
  const tabs = await chrome.tabs.query({ url: 'https://fish.audio/*' });
  const ready = tabs.find((t) => t.status === 'complete');
  if (ready) return ready;
  const tab = tabs[0] || (await chrome.tabs.create({ url: FISH_APP_URL, active: false }));
  await new Promise((resolve) => {
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        // Give the content scripts + grecaptcha a beat to initialise.
        setTimeout(resolve, 800);
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

// Generate one chapter's audio on fish.audio and save it (project folder via
// Story Studio, or the browser Downloads folder). Returns a result summary.
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

  // v2: hand the audio back to Story Studio so it files it into the episode's
  // real audio folder. Requires companion identifiers (slug + code + chapter).
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
    return { ok: true, savedAs: j.saved_as, savedIn: j.audio_dir, target: 'project' };
  }

  const filename = job.downloadPath.replace(/\.(mp3|wav)$/i, '') + `.${ext}`;
  const downloadId = await chrome.downloads.download({
    url: `data:${mime};base64,${base64}`,
    filename,
    saveAs: false,
    conflictAction: 'uniquify',
  });
  return { ok: true, downloadId, savedAs: filename, target: 'download' };
}

async function runJob(job) {
  const settings = await getSettings();
  const tab = await ensureFishTab();
  return generateAndSave(job, settings, tab);
}

// Best-effort progress ping to the popup (no-op if it's closed).
function emit(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Human-like pause between chapters: a randomised gap so we don't hammer
// fish.audio. Each generation already waits for the audio + the save before
// the next starts; this just adds polite spacing on top.
function politeGap() {
  return 2500 + Math.floor(Math.random() * 3500); // 2.5–6.0s
}

// Sequentially generate + save every section in `batch.chapters`. Each entry is
// { chapterNumber, slug, label, text, downloadPath }. Shared fields (slug base,
// episodeCode, target, voice, autoTag) live on the batch.
async function runBatch(batch) {
  const settings = await getSettings();
  const tab = await ensureFishTab();
  const total = batch.chapters.length;
  const results = [];
  let succeeded = 0;

  for (let i = 0; i < total; i++) {
    const ch = batch.chapters[i];
    const label = ch.label || ch.slug || `Chapter ${ch.chapterNumber}`;
    emit({ type: 'batchProgress', index: i, total, label, state: 'running' });
    try {
      const job = {
        text: ch.text,
        voice: batch.voice,
        target: batch.target,
        slug: batch.slug,
        episodeCode: batch.episodeCode,
        chapterNumber: ch.chapterNumber,
        sectionSlug: ch.slug,
        autoTag: batch.autoTag,
        downloadPath: ch.downloadPath,
      };
      const r = await generateAndSave(job, settings, tab);
      succeeded++;
      results.push({ label, ok: true, savedAs: r.savedAs });
      emit({ type: 'batchProgress', index: i, total, label, state: 'done', savedAs: r.savedAs });
    } catch (e) {
      const error = String(e.message || e);
      results.push({ label, ok: false, error });
      emit({ type: 'batchProgress', index: i, total, label, state: 'failed', error });
    }
    // Polite, human-like gap before the next chapter (skip after the last).
    if (i < total - 1) await sleep(politeGap());
  }

  return { ok: true, total, succeeded, failed: total - succeeded, results };
}

async function listVoices() {
  const tab = await ensureFishTab();
  const { voices } = await send(tab.id, { type: 'fish:listVoices' });
  return { ok: true, voices };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'runJob') {
    runJob(msg.job)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg?.type === 'runBatch') {
    runBatch(msg.batch)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg?.type === 'listVoices') {
    listVoices()
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  return false;
});
