// Content script injected into fish.audio.
//
// ── STATUS: STUB — pending recon of the logged-in fish.audio studio. ──
//
// Responsibility: given { text, voice }, produce narration audio and hand
// back a downloadable URL. Two possible implementations, decided by recon:
//
//   (A) Direct API replay (preferred): fish.audio's studio calls its own
//       backend (likely api.fish.audio). Since this script runs in the
//       page's origin, it can fetch that same endpoint with the user's
//       session cookie, get the audio bytes, and return a blob URL.
//       Robust — no dependence on DOM layout.
//
//   (B) DOM automation (fallback): type into the TTS box, click Generate,
//       wait for the <audio> element / download button, capture the blob.
//       More fragile; only if there's no clean API to replay.
//
// The message contract below is final regardless of which path we pick, so
// background.js and the popup don't change when this gets implemented.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'fish:generate') {
    generate(msg.text, msg.voice)
      .then((audioUrl) => sendResponse({ ok: true, audioUrl }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true; // async
  }
  if (msg?.type === 'fish:ping') {
    sendResponse({ ok: true, href: location.href });
    return false;
  }
  return false;
});

async function generate(_text, _voice) {
  // TODO(recon): implement against the real fish.audio studio.
  throw new Error('Fish generation not implemented yet — pending studio recon.');
}
