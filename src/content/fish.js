// Isolated content script on fish.audio.
//
// Bridges the extension (background/popup) to the MAIN-world `fish-main.js`,
// which owns the Fish API calls (it needs the page's grecaptcha). This world
// has chrome.* APIs but not the page's JS objects; the main world has the JS
// objects but not chrome.*. They talk over window.postMessage.

const REQ = 'FISHEXT_REQ';
const RES = 'FISHEXT_RES';
let seq = 0;
const pending = new Map();

window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || d.kind !== RES) return;
  const p = pending.get(d.id);
  if (!p) return;
  pending.delete(d.id);
  d.ok ? p.resolve(d.result) : p.reject(Object.assign(new Error(d.error || 'main-world error'), { limit: !!d.limit }));
});

function callMain(op, payload, timeoutMs = 120000) {
  const id = `${Date.now()}-${seq++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.postMessage({ kind: REQ, id, op, payload }, '*');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Fish "${op}" timed out.`));
      }
    }, timeoutMs);
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'fish:generate') {
    callMain('generate', { text: msg.text, model: msg.voice, speed: msg.speed, autoTag: msg.autoTag })
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e), limit: !!e.limit }));
    return true;
  }
  if (msg?.type === 'fish:listVoices') {
    callMain('listVoices', {})
      .then((voices) => sendResponse({ ok: true, voices }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  return false;
});
