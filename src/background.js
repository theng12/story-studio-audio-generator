// Service worker — orchestrates a TTS job end to end.
//
// Flow:
//   popup → background { type: "runJob", job }
//   background → fish.audio content bridge { type: "fish:generate", text, voice }
//   bridge → MAIN world → POST api.fish.audio/task (stream) → MP3 bytes
//   bridge → background { base64, mime }
//   background → chrome.downloads.download(data: URL, filename: job.downloadPath)
//
// The Fish step is isolated behind "fish:generate" / "fish:listVoices", so the
// rest of the pipeline doesn't care how fish.audio is driven.

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

async function runJob(job) {
  const settings = await getSettings();
  const voice = job.voice || settings.fishVoice;
  if (!voice) throw new Error('No fish.audio voice selected. Pick one in Settings.');
  const tab = await ensureFishTab();

  const { base64, mime } = await send(tab.id, {
    type: 'fish:generate',
    text: job.text,
    voice,
    speed: job.speed ?? 1,
  });

  const ext = mime === 'audio/wav' ? 'wav' : 'mp3';
  const filename = job.downloadPath.replace(/\.(mp3|wav)$/i, '') + `.${ext}`;
  const downloadId = await chrome.downloads.download({
    url: `data:${mime};base64,${base64}`,
    filename,
    saveAs: false,
    conflictAction: 'uniquify',
  });
  return { ok: true, downloadId, savedAs: filename };
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
  if (msg?.type === 'listVoices') {
    listVoices()
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  return false;
});
