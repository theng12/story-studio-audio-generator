// Filename + download-path construction.
//
// Goal (v1): every generated audio file is saved with the *correct name*
// derived from the Story Studio episode/chapter it came from, optionally
// inside a per-project / per-episode subfolder of Downloads.
//
// chrome.downloads can write into subfolders *inside* the Downloads dir
// (forward-slash paths), but NOT to arbitrary absolute paths — that's the
// browser sandbox. Writing into the real Story Studio project folder is a
// v2 concern handled by POSTing audio back to the Story Studio server.

// Strip characters that are illegal/awkward in filenames across macOS.
// Keep spaces and dashes (the Story Studio naming convention uses them).
function sanitizeSegment(s) {
  return String(s ?? '')
    .replace(/[\/\\:*?"<>|]/g, '-') // path-illegal -> dash
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120); // keep individual segments sane
}

function applyTokens(template, tokens) {
  return template.replace(/\{(\w+)\}/g, (_, key) =>
    sanitizeSegment(tokens[key] ?? '')
  );
}

// Build the Downloads-relative path (no leading slash, forward slashes only).
// e.g. "StoryStudioAudio/abiding-faith/EP0110/EP0110 - 03 Chapter.mp3"
export function buildDownloadPath(settings, tokens, ext = 'mp3') {
  const dir = applyTokens(settings.downloadSubdir || '', tokens)
    .split('/')
    .map(sanitizeSegment)
    .filter(Boolean)
    .join('/');
  let name = applyTokens(settings.filenameTemplate || '{episodeCode}', tokens);
  name = sanitizeSegment(name) || 'audio';
  const file = `${name}.${ext}`;
  return dir ? `${dir}/${file}` : file;
}

export { sanitizeSegment, applyTokens };
