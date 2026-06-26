// Central defaults + settings access for the extension.
//
// Two run modes, chosen on the Options page at install time:
//   - "companion": read scripts straight from a running Story Studio KH
//                  server (desktop API on :8000, or server-mode on :8766).
//   - "paste":     the user pastes/【selects】 the script text manually; no
//                  dependency on Story Studio running.
//
// Everything here is just defaults — the live values come from
// chrome.storage.sync and are edited on the Options page.

export const DEFAULTS = {
  mode: 'paste', // "companion" | "paste" — user picks on first run
  // Story Studio server. Server-mode default port is 8766 (auth-gated);
  // the plain desktop app serves the same API on 8000 (no auth).
  studioBaseUrl: 'http://localhost:8766',
  // Server mode requires a login -> session cookie. Desktop mode does not.
  studioUsername: '',
  // NOTE: we never store the password; the user logs in through the popup
  // and the session cookie is held by the browser for studioBaseUrl.
  // Where downloaded audio lands, relative to the browser's Downloads dir.
  // Tokens: {project} {episodeCode} {episodeTitle} are filled per job.
  downloadSubdir: 'StoryStudioAudio/{project}/{episodeCode}',
  // Filename template (extension appended automatically).
  // Tokens: {episodeCode} {chapterNum} {chapterLabel} {project}
  filenameTemplate: '{episodeCode} - {chapterNum} {chapterLabel}',
  // Default fish.audio voice id/name to apply (resolved during recon).
  fishVoice: '',
};

const STORAGE_KEY = 'settings';

export async function getSettings() {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  return { ...DEFAULTS, ...(stored[STORAGE_KEY] || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  return next;
}
