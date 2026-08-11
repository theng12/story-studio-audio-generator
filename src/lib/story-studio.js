// Client for the Story Studio KH local server.
//
// Story Studio runs an Express API. Two flavours, same routes:
//   - Desktop app:  http://localhost:8000   (no auth)
//   - Server mode:  http://localhost:8766   (session-cookie auth)
// All routes are mounted under /api. Auth is a single POST /api/auth/login
// that sets an HttpOnly `ssk_session` cookie; subsequent requests just need
// credentials:'include' and the browser attaches it.
//
// We deliberately keep this a thin REST wrapper — no caching, no retries —
// so the popup stays in control of the flow.

export class StudioClient {
  constructor(baseUrl) {
    this.base = (baseUrl || '').replace(/\/+$/, '');
  }

  async _json(path, opts = {}) {
    const res = await fetch(`${this.base}/api${path}`, {
      credentials: 'include',
      headers: { Accept: 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        if (body?.detail) detail = body.detail;
      } catch {
        /* non-JSON error body */
      }
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // Server mode only. Sets the session cookie as a side effect.
  login(username, password) {
    return this._json('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  }

  listProjects() {
    return this._json('/projects');
  }

  listEpisodes(slug) {
    return this._json(`/projects/${encodeURIComponent(slug)}/episodes`);
  }

  // Per-chapter rows for an episode → { chapters: [{ number, title,
  // present, word_count, character_count, audio_stale }] }.
  //
  // NOTE: `title` is REQUIRED in practice — episode folders are named
  // "CODE - Title", so without it the server can't resolve the episode dir
  // and returns an empty list. (Verified live against real projects.)
  chapterList(slug, episodeId, title = '') {
    const q = title ? `?title=${encodeURIComponent(title)}` : '';
    return this._json(
      `/projects/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(episodeId)}/chapter-list${q}`
    );
  }

  // Plain narration text for one chapter → { content }.
  chapterContent(slug, episodeId, chapterNumber, title = '') {
    const q = title ? `?title=${encodeURIComponent(title)}` : '';
    return this._json(
      `/projects/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(
        episodeId
      )}/chapters/${encodeURIComponent(chapterNumber)}/content${q}`
    );
  }

  // Per-episode audio presence → { total, present, missing, missing_files }.
  // `missing_files` are filenames like "CODE_Chapter_03.mp3" / "CODE_Introduction.mp3"
  // — the authoritative list of sections still missing audio. Resolves by code
  // (no title needed).
  audioStatus(slug, code) {
    return this._json(
      `/projects/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(code)}/audio-status`
    );
  }

  // Full narration (script + optional introduction) for an episode.
  scriptContent(slug, episodeId, title = '') {
    const q = title ? `?title=${encodeURIComponent(title)}` : '';
    return this._json(
      `/projects/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(
        episodeId
      )}/script-content${q}`
    );
  }
}
