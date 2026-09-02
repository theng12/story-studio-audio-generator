// Isolated content script on fish.audio.
//
// Bridges the extension (background/popup) to the MAIN-world `fish-main.js`,
// which owns the Fish API calls (it needs the page's grecaptcha). This world
// has chrome.* APIs but not the page's JS objects; the main world has the JS
// objects but not chrome.*. They talk over window.postMessage.

const bridge = globalThis.__STORY_STUDIO_BRIDGE__.createIsolatedBridge({
  requestKind: 'FISHEXT_REQ',
  responseKind: 'FISHEXT_RES',
  label: 'Fish',
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'fish:generate') {
    bridge.callMain('generate', { text: msg.text, model: msg.voice, backend: msg.backend, speed: msg.speed, autoTag: msg.autoTag })
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e), limit: !!e.limit, ambiguous: !!e.ambiguous }));
    return true;
  }
  if (msg?.type === 'fish:inventory') {
    bridge.callMain('inventory', {})
      .then((raw) => sendResponse({ ok: true, raw }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  return false;
});
