// Gateway third-mode client — claim-based TTS worker protocol.
//
// Wire contract (static-only; no live server exercised here):
//   GET  /api/workers/health                                    -> 200 { ok: true, workerId, kind }
//   POST /api/workers/claim                                     <- { workerId, kind: 'audio' }
//        -> 204 (no job) | 200 { job: {...} }                   Bearer <token>
//   POST /api/workers/jobs/${jobId}/progress                    <- { phase, message }
//   POST /api/workers/jobs/${jobId}/fail                        <- { error, ambiguous }
//   POST /api/workers/jobs/${jobId}/result                      <- multipart { mediaType, file }
//        -> 200 { ok: true }              acknowledged
//        -> 200 { ok: true, ignored: true } earlier terminal won; NOT acknowledged
//        -> 200 {} or malformed           NOT acknowledged; preserve staged bytes
//
// This module is pure fetch + validation. It never touches chrome.storage,
// provider tabs, or the local queue — those stay in background.js.

export const GATEWAY_KIND = 'audio';

// Minimal strict TTS job payload proposal. The Gateway currently ships only
// a video payload adapter; audio/TTS requires these baseline fields. Any
// missing or unsupported field must fail before a provider call.
export const TTS_JOB_SCHEMA = Object.freeze({
  required: ['jobId', 'provider', 'voice', 'text'],
  optional: ['model', 'speed', 'autoTag', 'providerSettings'],
  knownProviders: ['fish', 'elevenlabs_web'],
  acceptedMediaTypes: ['audio/mpeg', 'audio/mp3', 'audio/wav'],
});

// Strict pre-provider validation. Rejects missing/unsupported provider, voice,
// model, format or malformed job BEFORE any provider call. Never silently
// substitutes account defaults.
export function validateTtsJob(job, { knownVoices = [], knownModels = [] } = {}) {
  if (!job || typeof job !== 'object') return { ok: false, error: 'job is not an object' };
  for (const field of TTS_JOB_SCHEMA.required) {
    if (typeof job[field] !== 'string' || !job[field].trim()) {
      return { ok: false, error: `missing or empty required field: ${field}` };
    }
  }
  if (!TTS_JOB_SCHEMA.knownProviders.includes(job.provider)) {
    return { ok: false, error: `unsupported provider: ${job.provider}` };
  }
  const voice = String(job.voice || '').trim();
  if (!voice) return { ok: false, error: 'missing or empty required field: voice' };
  if (knownVoices.length && !knownVoices.includes(voice)) {
    return { ok: false, error: `unsupported voice for ${job.provider}: ${voice}` };
  }
  if (job.model !== undefined && job.model !== null) {
    const model = String(job.model || '').trim();
    if (!model) return { ok: false, error: 'model field is empty string' };
    if (knownModels.length && !knownModels.includes(model)) {
      return { ok: false, error: `unsupported model for ${job.provider}: ${model}` };
    }
  }
  return { ok: true };
}

// Validate a health response: ok must be exactly true (not truthy), and
// workerId/kind must match exactly when reported. Missing identity fields
// when expected is a validation failure, not acceptance.
export function validateHealthResponse(json, { workerId, kind } = {}) {
  if (!json || typeof json !== 'object') return { ok: false, error: 'health response is not an object' };
  if (json.ok !== true) return { ok: false, error: 'health ok is not exactly true' };
  if (workerId !== undefined) {
    if (json.workerId === undefined) return { ok: false, error: 'health missing workerId' };
    if (json.workerId !== workerId) return { ok: false, error: `health workerId mismatch: expected ${workerId}, got ${json.workerId}` };
  }
  if (kind !== undefined) {
    if (json.kind === undefined) return { ok: false, error: 'health missing kind' };
    if (json.kind !== kind) return { ok: false, error: `health kind mismatch: expected ${kind}, got ${json.kind}` };
  }
  return { ok: true };
}

// Compute a non-secret binding fingerprint from URL + workerId so we can
// detect config changes without storing the token. Used to refuse redirecting
// an in-flight job when credentials change mid-flight.
export function gatewayBindingFingerprint(baseUrl, workerId) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const wid = String(workerId || '');
  // Simple hash-free fingerprint: concat normalized values. Not secret (no token).
  return `${base}|${wid}`;
}

export function buildGatewayClient(baseUrl, token) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const authHeaders = () => ({
    Authorization: `Bearer ${String(token || '')}`,
    'Content-Type': 'application/json',
  });

  async function request(path, { method = 'GET', body, headers } = {}) {
    const url = `${base}${path}`;
    const res = await fetch(url, {
      method,
      headers: { ...authHeaders(), ...(headers || {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return res;
  }

  function jobPath(jobId, action) {
    return `/api/workers/jobs/${encodeURIComponent(String(jobId || ''))}/${action}`;
  }

  return {
    async health() {
      const res = await request('/api/workers/health');
      if (!res.ok) throw new Error(`health check failed: ${res.status}`);
      const json = await res.json().catch(() => ({}));
      return { ok: json.ok === true, status: res.status, raw: json };
    },

    // Claim returns null when no job is available (204), or a validated job.
    // Wire returns { job: {...} }, not raw job. Malformed response throws.
    async claim(workerId) {
      const res = await request('/api/workers/claim', {
        method: 'POST',
        body: { workerId: String(workerId || ''), kind: GATEWAY_KIND },
      });
      if (res.status === 204) return null;
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`claim failed: ${res.status} ${detail}`);
      }
      let envelope;
      try {
        envelope = await res.json();
      } catch {
        throw new Error('claim returned non-JSON body');
      }
      if (!envelope || typeof envelope !== 'object') throw new Error('claim returned non-object body');
      const job = envelope.job;
      if (!job || typeof job !== 'object') throw new Error('claim returned envelope without job');
      if (!job.jobId) throw new Error('claim returned job without jobId');
      const validation = validateTtsJob(job);
      if (!validation.ok) throw new Error(`invalid tts job from gateway: ${validation.error}`);
      return job;
    },

    // Progress/fail use per-job routes. Body contains only phase/message or
    // error/ambiguous — jobId is in the URL, not the body.
    async progress(jobId, phase, message) {
      const res = await request(jobPath(jobId, 'progress'), {
        method: 'POST',
        body: { phase: String(phase || ''), message: String(message || '') },
      });
      if (!res.ok) throw new Error(`progress report failed: ${res.status}`);
      return { ok: true };
    },

    async fail(jobId, error, { ambiguous = true } = {}) {
      const res = await request(jobPath(jobId, 'fail'), {
        method: 'POST',
        body: { error: String(error || ''), ambiguous: !!ambiguous },
      });
      if (!res.ok) throw new Error(`fail report failed: ${res.status}`);
      return { ok: true };
    },

    // Result upload is multipart/form-data via per-job route. Returns parsed
    // response. Only explicit ok:true AND ignored!==true acknowledges delivery.
    // Malformed/empty/refused responses are NOT acknowledged.
    async result(jobId, { mediaType, file }) {
      if (!mediaType || !file) throw new Error('result requires mediaType and file');
      const form = new FormData();
      form.append('mediaType', String(mediaType));
      form.append('file', file);
      const url = `${base}${jobPath(jobId, 'result')}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${String(token || '')}` },
        body: form,
      });
      if (!res.ok) throw new Error(`result upload failed: ${res.status}`);
      let json;
      try {
        json = await res.json();
      } catch {
        // Malformed body on 200: NOT acknowledged. Preserve staged bytes.
        return { ok: false, ignored: false, acknowledged: false, raw: null };
      }
      if (!json || typeof json !== 'object') {
        return { ok: false, ignored: false, acknowledged: false, raw: json };
      }
      const acknowledged = json.ok === true && json.ignored !== true;
      return { ok: json.ok === true, ignored: json.ignored === true, acknowledged, raw: json };
    },
  };
}