// Service worker — orchestrates a TTS job end to end.
//
// Flow:
//   popup → background { type: "runJob", job }
//   background → fish.audio content script { type: "fish:generate", text, voice }
//   content script → background { audio: <base64>, mime }
//   background → chrome.downloads.download({ filename: job.downloadPath })
//
// The Fish step is isolated behind the "fish:generate" message so that
// however we end up driving fish.audio (direct API call vs DOM automation),
// nothing else in the pipeline changes.

import { getSettings } from './lib/config.js';

const FISH_URL = 'https://fish.audio/';

// Find an existing fish.audio tab or open one, and make sure it has finished
// loading so the content script is live.
async function ensureFishTab() {
  const tabs = await chrome.tabs.query({ url: 'https://fish.audio/*' });
  if (tabs.length) return tabs[0];
  const tab = await chrome.tabs.create({ url: FISH_URL, active: false });
  // Wait for load complete.
  await new Promise((resolve) => {
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  return tab;
}

async function runJob(job) {
  const settings = await getSettings();
  const tab = await ensureFishTab();

  // Ask the content script to generate audio for this text.
  const result = await chrome.tabs.sendMessage(tab.id, {
    type: 'fish:generate',
    text: job.text,
    voice: job.voice || settings.fishVoice || '',
  });

  if (!result || !result.ok) {
    throw new Error(result?.error || 'Fish generation failed (no audio returned).');
  }

  // result.audioUrl is a data: or blob: URL the content script produced.
  const downloadId = await chrome.downloads.download({
    url: result.audioUrl,
    filename: job.downloadPath,
    saveAs: false,
    conflictAction: 'uniquify',
  });

  return { ok: true, downloadId, savedAs: job.downloadPath };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'runJob') {
    runJob(msg.job)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true; // async response
  }
  return false;
});
