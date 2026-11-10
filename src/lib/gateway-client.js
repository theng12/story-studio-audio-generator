// Scoped worker wire v1. No automatic retries or credential-bearing redirects.
export const GATEWAY_KIND = 'audio';
export const TTS_JOB_SCHEMA = Object.freeze({
  required: ['jobId', 'provider', 'voice', 'text', 'model'],
  optional: ['speed', 'autoTag', 'providerSettings'],
  knownProviders: ['fish', 'elevenlabs_web'],
  acceptedMediaTypes: ['audio/mpeg', 'audio/mp3', 'audio/wav'],
});
export function validateTtsJob(job, { knownVoices = [], knownModels = [] } = {}) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) return { ok: false, error: 'Audio job is not an object.' };
  if (job.kind !== GATEWAY_KIND) return { ok: false, error: 'Job must state kind audio.' };
  for (const key of TTS_JOB_SCHEMA.required) {
    if (typeof job[key] !== 'string' || !job[key].trim()) return { ok: false, error: `Audio job needs ${key}.` };
  }
  if (!TTS_JOB_SCHEMA.knownProviders.includes(job.provider)) return { ok: false, error: 'Audio provider is unavailable.' };
  if (knownVoices.length && !knownVoices.includes(job.voice)) return { ok: false, error: 'Voice was not discovered.' };
  if (knownModels.length && !knownModels.includes(job.model)) return { ok: false, error: 'Model was not discovered.' };
  if (job.speed !== undefined && (typeof job.speed !== 'number' || !Number.isFinite(job.speed))) return { ok: false, error: 'Audio speed must be a finite number.' };
  if (job.autoTag !== undefined && typeof job.autoTag !== 'boolean') return { ok: false, error: 'Audio tags must be on or off.' };
  return { ok: true };
}
export function validateHealthResponse(json, { workerId, kind } = {}) {
  if (json?.ok !== true || json.workerId !== workerId || json.kind !== kind ||
      !Number.isSafeInteger(json.maxResultBytes) || json.maxResultBytes <= 0) {
    return { ok: false, error: 'Gateway health identity or upload limit is unavailable.' };
  }
  return { ok: true };
}
export function prepareAudioInventory(observations, workerId, health, now = Date.now()) {
  const maxAgeSeconds = health?.audioInventoryMaxAgeSeconds;
  const maxBytes = health?.audioInventoryMaxBytes;
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Gateway inventory age and byte limits are unavailable.');
  }
  const providers = {};
  for (const provider of TTS_JOB_SCHEMA.knownProviders) {
    const response = observations[provider];
    const inventory = response?.inventory;
    if (response?.ok !== true || inventory?.source !== 'live' || inventory.complete !== true) continue;
    if (![inventory.models, inventory.voices].every((rows) => Array.isArray(rows) && rows.length && rows.every((row) => typeof row?.id === 'string' && row.id.trim()))) continue;
    const fetchedAt = inventory.fetchedAt;
    if (!Number.isSafeInteger(fetchedAt) || fetchedAt <= 0 || fetchedAt > now || now - fetchedAt >= maxAgeSeconds * 1000) {
      throw new Error(`Audio inventory must be observed within Gateway's ${maxAgeSeconds} second age limit, without a future timestamp. Refresh the workspace and check the clocks.`);
    }
    providers[provider] = {
      source: 'live', complete: true, fetchedAt,
      models: inventory.models.map(({ id }) => ({ id })),
      voices: inventory.voices.map(({ id }) => ({ id })),
    };
  }
  const audioInventory = { schema: 1, providers };
  const bytes = new TextEncoder().encode(JSON.stringify({ workerId, kind: GATEWAY_KIND, audioInventory })).byteLength;
  if (bytes > maxBytes) throw new Error(`Audio claim is ${bytes} bytes; Gateway allows ${maxBytes} bytes. Inventory was not truncated.`);
  return audioInventory;
}
function baseAddress(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter the Gateway server address.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Gateway address must be HTTP or HTTPS without credentials, query or fragment.');
  return url.href.replace(/\/+$/, '');
}
export async function gatewayBindingFingerprint(baseUrl, workerId, token) {
  const bytes = new TextEncoder().encode(JSON.stringify([baseAddress(baseUrl), workerId, token]));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function buildGatewayClient(baseUrl, token) {
  const base = baseAddress(baseUrl);
  if (typeof token !== 'string' || !token.trim()) throw new Error('Set the Gateway worker token.');
  async function request(path, { json, body, idle = false, timeoutMs = 20000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(base + path, {
        method: json !== undefined || body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, ...(json === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: json === undefined ? body : JSON.stringify(json),
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
      });
      if (idle && response.status === 204) return null;
      // Untrusted response bodies may contain echoed credentials.
      if (!response.ok) throw Object.assign(new Error(`Gateway request failed (${response.status}).`), { status: response.status });
      let result;
      try { result = await response.json(); } catch { throw new Error('Gateway returned unreadable JSON.'); }
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Gateway returned an invalid response.');
      return result;
    } finally { clearTimeout(timer); }
  }
  const jobPath = (id, action) => `/api/workers/jobs/${encodeURIComponent(id)}/${action}`;
  function accepted(result) {
    if (result.ok !== true || result.ignored === true) throw new Error('Gateway did not accept this answer; work is retained.');
    return result;
  }
  return {
    async health() { const raw = await request('/api/workers/health', { timeoutMs: 8000 }); return { ok: raw.ok === true, raw }; },
    async claim(workerId, audioInventory) {
      if (typeof workerId !== 'string' || !workerId.trim() || workerId.length > 120) throw new Error('Worker ID must contain 1 to 120 characters.');
      let envelope;
      try {
        envelope = await request('/api/workers/claim', { json: { workerId, kind: GATEWAY_KIND, ...(audioInventory === undefined ? {} : { audioInventory }) }, idle: true });
      } catch (error) {
        if ([413, 422].includes(error?.status)) error.claimRejected = true;
        throw error;
      }
      if (envelope === null) return null;
      if (typeof envelope.job?.jobId !== 'string' || !envelope.job.jobId.trim()) throw new Error('Gateway claim has no job ID.');
      return envelope.job;
    },
    async progress(id, phase, message = '') { return accepted(await request(jobPath(id, 'progress'), { json: { phase, message } })); },
    async fail(id, error, { ambiguous = true } = {}) { return accepted(await request(jobPath(id, 'fail'), { json: { error: String(error?.message || error).slice(0, 500), ambiguous: ambiguous !== false } })); },
    async result(id, { mediaType, file }) {
      if (!TTS_JOB_SCHEMA.acceptedMediaTypes.includes(mediaType) || !(file instanceof Blob)) throw new Error('Gateway result needs supported audio bytes.');
      const form = new FormData();
      form.append('mediaType', mediaType);
      form.append('file', file, 'audio');
      const raw = await request(jobPath(id, 'result'), { body: form, timeoutMs: 120000 });
      return { ok: raw.ok === true, ignored: raw.ignored === true, acknowledged: raw.ok === true && raw.ignored !== true };
    },
  };
}
