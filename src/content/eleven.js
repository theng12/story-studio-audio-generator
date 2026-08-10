// Isolated content script on elevenlabs.io.
//
// Bridges the extension (background) to the MAIN-world `eleven-main.js`, which
// owns the ElevenLabs API calls (it needs the page's same-origin Firebase
// session token). This world has chrome.* APIs but not the page's JS/session;
// the main world has those but not chrome.*. They talk over window.postMessage.

const REQ = 'ELEVENEXT_REQ';
const RES = 'ELEVENEXT_RES';
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
        reject(Object.assign(new Error(`ElevenLabs "${op}" timed out.`), { ambiguous: op === 'generate' }));
      }
    }, timeoutMs);
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'eleven:generate') {
    callMain('generate', { text: msg.text, voice: msg.voice, model: msg.model, maxChars: msg.maxChars, voiceSettings: msg.voiceSettings })
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e), limit: !!e.limit, ambiguous: !!e.ambiguous }));
    return true;
  }
  if (msg?.type === 'eleven:inventory') {
    callMain('inventory', {})
      .then((raw) => sendResponse({ ok: true, raw }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  return false;
});
