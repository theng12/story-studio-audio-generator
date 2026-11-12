// Isolated content script on elevenlabs.io.
//
// Bridges the extension (background) to the MAIN-world `eleven-main.js`, which
// owns the ElevenLabs API calls (it needs the page's same-origin Firebase
// session token). This world has chrome.* APIs but not the page's JS/session;
// the main world has those but not chrome.*. They talk over window.postMessage.

const bridge = globalThis.__STORY_STUDIO_BRIDGE__.createIsolatedBridge({
  requestKind: 'ELEVENEXT_REQ',
  responseKind: 'ELEVENEXT_RES',
  label: 'ElevenLabs',
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'eleven:generate') {
    bridge.callMain('generate', { text: msg.text, voice: msg.voice, model: msg.model, maxChars: msg.maxChars, voiceSettings: msg.voiceSettings })
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e), limit: !!e.limit, ambiguous: !!e.ambiguous }));
    return true;
  }
  if (msg?.type === 'eleven:account') {
    bridge.callMain('account', {})
      .then((raw) => sendResponse({ ok: true, raw }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg?.type === 'eleven:inventory') {
    bridge.callMain('inventory', {})
      .then((raw) => sendResponse({ ok: true, raw }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  return false;
});
