// MAIN-world bridge entry. Kept distinct from the isolated entry so Chrome
// injects a bridge into each execution world.
(() => {
  const root = globalThis.__STORY_STUDIO_BRIDGE__ || (globalThis.__STORY_STUDIO_BRIDGE__ = {});
  const crypto = globalThis.crypto;
  const randomId = () => {
    if (crypto?.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  };

  root.createMainBridge = ({ requestKind, responseKind, handlers }) => {
    const channel = randomId();
    window.addEventListener('message', async (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data) return;
      if (data.kind === requestKind + ':hello' && typeof data.helloId === 'string') {
        window.postMessage({ kind: responseKind + ':ready', helloId: data.helloId, channel }, '*');
        return;
      }
      if (data.kind !== requestKind || data.channel !== channel || typeof data.id !== 'string') return;
      try {
        const handler = handlers[data.op];
        if (!handler) throw new Error('Unknown op: ' + data.op);
        const result = await handler(data.payload || {});
        window.postMessage({ kind: responseKind, channel, id: data.id, ok: true, result }, '*');
      } catch (error) {
        window.postMessage({ kind: responseKind, channel, id: data.id, ok: false, error: String(error.message || error), limit: !!error.limit, ambiguous: !!error.ambiguous }, '*');
      }
    });
  };
})();
