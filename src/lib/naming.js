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
