// Gateway third-mode client — claim-based TTS worker protocol.
//
// Wire contract (static-only; no live server exercised here):
//   GET  /api/workers/health              -> 200 { ok: true, workerId?, kind? }
//   POST /api/workers/claim               <- { workerId, kind: 'audio' }
//        -> 204 (no job) | 200 { job }    Bearer <token>
//   POST /api/workers/progress            <- { jobId, phase, message }
//   POST /api/workers/fail                <- { jobId, error, ambiguous? }
//   POST /api/workers/result              <- multipart { mediaType, file }
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
  // provider must be one of the extension's known web-session providers.
  knownProviders: ['fish', 'elevenlabs_web'],
  // Accepted result media types for TTS output.
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
  // Voice must be explicitly provided and, when a known set is available, must
  // match. Never silently fall back to an account default.
  const voice = String(job.voice || '').trim();
  if (!voice) return { ok: false, error: 'missing or empty required field: voice' };
  if (knownVoices.length && !knownVoices.includes(voice)) {
    return { ok: false, error: `unsupported voice for ${job.provider}: ${voice}` };
  }
  // Model is optional but when present must be recognized.
  if (job.model !== undefined && job.model !== null) {
    const model = String(job.model || '').trim();
    if (!model) return { ok: false, error: 'model field is empty string' };
    if (knownModels.length && !knownModels.includes(model)) {
      return { ok: false, error: `unsupported model for ${job.provider}: ${model}` };
    }
  }
  return { ok: true };
}

// Validate a health response: must have ok:true and, when the server reports
// workerId/kind, they must match the expected values. A malformed health
// response is NOT idle — it is a connection/config error.
export function validateHealthResponse(json, { workerId, kind } = {}) {
  if (!json || typeof json !== 'object') return { ok: false, error: 'health response is not an object' };
  if (!json.ok) return { ok: false, error: 'health reported not ok' };
  if (workerId !== undefined && json.workerId !== undefined && json.workerId !== workerId) {
    return { ok: false, error: `health workerId mismatch: expected ${workerId}, got ${json.workerId}` };
  }
  if (kind !== undefined && json.kind !== undefined && json.kind !== kind) {
    return { ok: false, error: `health kind mismatch: expected ${kind}, got ${json.kind}` };
  }
  return { ok: true };
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

  return {
    async health() {
      const res = await request('/api/workers/health');
      if (!res.ok) throw new Error(`health check failed: ${res.status}`);
      const json = await res.json().catch(() => ({}));
      return { ok: !!json.ok, status: res.status, raw: json };
    },

    // Claim returns null when no job is available (204), or a validated job.
    // A malformed claim response (non-204, non-JSON, missing jobId) throws —
    // it is NOT treated as idle.
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
      let job;
      try {
        job = await res.json();
      } catch {
        throw new Error('claim returned non-JSON body');
      }
      if (!job || typeof job !== 'object') throw new Error('claim returned non-object body');
      if (!job.jobId && !job.id) throw new Error('claim returned job without jobId');
      const validation = validateTtsJob(job);
      if (!validation.ok) throw new Error(`invalid tts job from gateway: ${validation.error}`);
      return job;
    },

    async progress(jobId, phase, message) {
      const res = await request('/api/workers/progress', {
        method: 'POST',
        body: { jobId: String(jobId || ''), phase: String(phase || ''), message: String(message || '') },
      });
      if (!res.ok) throw new Error(`progress report failed: ${res.status}`);
      return { ok: true };
    },

    async fail(jobId, error, { ambiguous = false } = {}) {
      const res = await request('/api/workers/fail', {
        method: 'POST',
        body: { jobId: String(jobId || ''), error: String(error || ''), ambiguous: !!ambiguous },
      });
      if (!res.ok) throw new Error(`fail report failed: ${res.status}`);
      return { ok: true };
    },

    // Result upload is multipart/form-data, not JSON. The caller provides
    // a Blob/File and its mediaType; this function builds the form body.
    // Returns the parsed response so the caller can detect {ok:true, ignored:true}
    // (an earlier terminal answer already won — does NOT acknowledge artifact acceptance).
    async result(jobId, { mediaType, file }) {
      if (!mediaType || !file) throw new Error('result requires mediaType and file');
      const form = new FormData();
      form.append('mediaType', String(mediaType));
      form.append('file', file);
      const url = `${base}/api/workers/result`;
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
        json = {};
      }
      return { ok: !!json.ok, ignored: !!json.ignored, raw: json };
    },
  };
}