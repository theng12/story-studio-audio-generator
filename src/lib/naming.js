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

// Map a Story Studio audio filename back to the SECTION it belongs to.
//
// The app emits one file per TTS chunk, so a single section (a whole chapter or
// the intro) can land on disk — and in audio-status.missing_files — as several
// files. They all belong to ONE section and are filled by generating that
// section once (the app's skip-existing only remakes the missing chunk):
//   EP0042_Chapter_03.mp3                        -> Chapter_03
//   EP0042_Chapter_03_part2.mp3                  -> Chapter_03   (multi-chunk)
//   EP0042_Chapter_03_part2_v2.mp3               -> Chapter_03   (+ "new version")
//   EP0042_Chapter_03_seg01_narrator_part01.mp3  -> Chapter_03   (character-routed)
//   EP0042_Introduction.mp3                      -> Introduction
//
// Treating missing_files as authoritative and mapping each name through here
// (never dropping an unrecognised one) is what stops a chunked chapter from
// becoming an invisible, un-generatable row — the `_partN` names don't match a
// naive `_Chapter_NN.mp3` test, so the section silently vanished before.
export function sectionSlugFromFile(name, code) {
  return String(name || '')
    .replace(/\.(mp3|wav)$/i, '')
    .replace(new RegExp(`^${code}_`, 'i'), '') // drop the EP#### prefix
    .replace(/_v\d+$/i, '') //                    drop version suffix (must go before _part)
    .replace(/_part\d+$/i, '') //                 drop chunk part
    .replace(/_seg\d+_.+$/i, '') //               drop routed seg + speaker + part
    .trim();
}

export { sanitizeSegment, applyTokens };
