// Companion-mode client for the Story Studio KH local server.
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

  // Returns { username, mode } — mode "local" means desktop (no login needed),
  // "server" means a valid session cookie is present. Throws 401 if server
  // mode and not logged in.
  whoami() {
    return this._json('/auth/me');
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

  // Per-chapter rows for an episode (chapter number, label, staleness…).
  chapterList(slug, episodeId) {
    return this._json(
      `/projects/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(episodeId)}/chapter-list`
    );
  }

  // Plain text for one chapter.
  chapterContent(slug, episodeId, chapterNumber) {
    return this._json(
      `/projects/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(
        episodeId
      )}/chapters/${encodeURIComponent(chapterNumber)}/content`
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
