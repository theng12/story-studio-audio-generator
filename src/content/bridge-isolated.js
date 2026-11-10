// Isolated-world bridge entry. Kept distinct from the MAIN entry so Chrome
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

  const HELLO_RETRY_MS = 25;
  const HELLO_TIMEOUT_MS = 5000;

  root.createIsolatedBridge = ({ requestKind, responseKind, label }) => {
    let channel = '';
    const pending = new Map();
    const helloId = randomId();
    let helloRetry;
    let helloTimeout;
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const sendHello = () => window.postMessage({ kind: requestKind + ':hello', helloId }, '*');
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data) return;
      if (data.kind === responseKind + ':ready' && data.helloId === helloId && typeof data.channel === 'string') {
        channel = data.channel;
        clearInterval(helloRetry);
        clearTimeout(helloTimeout);
        resolveReady(channel);
        return;
      }
      if (data.kind !== responseKind || data.channel !== channel || typeof data.id !== 'string') return;
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      clearTimeout(entry.timeout);
      data.ok
        ? entry.resolve(data.result)
        : entry.reject(Object.assign(new Error(data.error || 'main-world error'), { limit: !!data.limit, ambiguous: !!data.ambiguous, verificationRequired: !!data.verificationRequired }));
    });
    helloRetry = setInterval(sendHello, HELLO_RETRY_MS);
    helloTimeout = setTimeout(() => {
      clearInterval(helloRetry);
      if (!channel) rejectReady(new Error(label + ' bridge did not initialize.'));
    }, HELLO_TIMEOUT_MS);
    sendHello();
    async function callMain(op, payload, timeoutMs = 120000) {
      const sessionChannel = await ready;
      const id = randomId();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(Object.assign(new Error(label + ' "' + op + '" timed out.'), { ambiguous: op === 'generate' }));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timeout });
        window.postMessage({ kind: requestKind, channel: sessionChannel, id, op, payload }, '*');
      });
    }
    return { callMain };
  };
})();
