// Gateway third-mode client — claim-based TTS worker protocol.
//
// Wire contract (static-only; no live server exercised here):
//   GET  /api/workers/health              -> 200 { ok: true }
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
  required: ['provider', 'voice', 'text'],
  optional: ['model', 'speed', 'autoTag', 'providerSettings'],
  // provider must be one of the extension's known web-session providers.
  knownProviders: ['fish', 'elevenlabs_web'],
});

export function validateTtsJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, error: 'job is not an object' };
  for (const field of TTS_JOB_SCHEMA.required) {
    if (typeof job[field] !== 'string' || !job[field].trim()) {
      return { ok: false, error: `missing or empty required field: ${field}` };
    }
  }
  if (!TTS_JOB_SCHEMA.knownProviders.includes(job.provider)) {
    return { ok: false, error: `unsupported provider: ${job.provider}` };
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
      return { ok: !!json.ok, status: res.status };
    },

    // Claim returns null when no job is available (204), or a validated job.
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
      const job = await res.json();
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
      return { ok: true };
    },
  };
}