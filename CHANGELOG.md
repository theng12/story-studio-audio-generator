# Changelog

Older releases are in `git log`.

## 0.7.32 — 2026-11-13
- Gateway mode can reach the Gateway again: the loopback host permissions are restored, and a test fails if Gateway mode ships without them.

## 0.7.31 — 2026-11-13

- Only two modes remain: Standalone (the default) and Gateway Studio. The old Story Studio mode and its connection settings are gone.
- Saved Studio choices move quietly to Standalone, so updates start in the same working mode.
- Removed the localhost site permission that only the Story Studio server needed.

## 0.7.30 — 2026-11-12

- The options page keeps only real choices: Appearance and the Gateway worker block; the Story Studio connection is shown only outside Gateway mode.

## 0.7.29 — 2026-11-12

- Removed Fleet Hub entirely.

## 0.7.28 — 2026-11-10

- Show discovered model and voice choices without treating a partial list as generation support.
- Mark choices whose request details are unavailable instead of guessing them.
- Pause narration when workspace verification is required, without retrying it automatically.
- Keep saved audio and selected settings while generation is unavailable.

## 0.7.27 — 2026-11-09

- Added an optional Gateway Studio mode alongside Story Studio and Standalone.
- Keep completed audio when delivery is interrupted, without generating it again.
- Deliver retained audio from the side panel after checking the connection.
- Hold unfinished work when the connection changes or the generation outcome is unknown.
- Gateway mode requires a compatible server with audio workers enabled.

## 0.7.26 - Audio Generator cleanup

- Kept Fish Audio and ElevenLabs Web generation on signed-in provider web sessions with discovered voice/model snapshots and no developer API-key route.
- Hardened provider bridge correlation, rejected unsupported Story Studio sections, and preserved cached-audio, download, pacing, standalone, and project recovery behavior.
- Moved Story Studio URL and username to local storage, kept the password session-only, and paused remote work for password re-entry after browser restart.
- Replaced stale Fleet "Coming soon" copy with opt-in sanitized telemetry and signed, revision-checked queue controls.

## 0.7.25 - Dynamic web providers and safe recovery

- Discover Fish Audio and ElevenLabs models from the active signed-in web
  sessions, with conservative fallbacks when live discovery is unavailable.
- Preserve generated audio across Story Studio, download, retry, and browser
  restart failures without repeating uncertain paid provider requests.
- Classify uncertain generation outcomes as Review required instead of
  retrying them automatically.
