# Story Studio Audio Generator (`story-studio-audio-generator`)

MV3 extension: turns Story Studio KH scripts into narration audio and saves each
file with the correct name. See `README.md` for the full provider/flow writeup;
this file is the orientation map. Shared architecture lives in the parent `../CLAUDE.md`.

## Providers (chosen in the side panel)

- **Web-session (no API key):** drives your logged-in tab.
  - **fish.audio** — content scripts `content/fish-main.js` (+ `fish.js`).
  - **ElevenLabs (web)** — reads the page's Firebase session token, self-refreshes
    it via the `securetoken` endpoint, calls `api.us.elevenlabs.io`. Keep an
    elevenlabs.io tab open. Per-gen cap 5000 chars → chunk + join MP3s.

Auto-tag (emotion/pause tags) is **fish.audio-only**; hide it for other providers.
Queue, save-back, and naming are shared across all providers.

## Key files

- `src/background.js` — service worker: the queue, web-session provider calls, downloads.
- `src/content/{fish,fish-main,eleven,eleven-main}.js` — per-site web automation pairs.
- `src/lib/providers.js` — provider abstraction (where new providers plug in).
- `src/lib/{naming,config,story-studio}.js` — shared with the sibling extension.
- `src/popup/` side panel UI, `src/options/` settings + input-mode choice.

## Input & save (set on the Options page)

- **Input:** *Paste* (most reliable, no dependency) or *Companion* (reads from the
  running Story Studio server — `/api/projects`, `…/episodes`, `…/chapters/:n/content`).
- **Save:** Story Studio project folder (companion mode, POST back) or Downloads
  (`Downloads/StoryStudioAudio/<project>/<episode>/<name>.mp3`).

## Gotchas

- The ElevenLabs-web token refresh is what keeps sessions from going stale — don't
  remove it.
- Chunking limits: all ElevenLabs web models cap at 5000 chars/request — see
  `ELEVEN_MODELS` / `PROVIDERS` in `lib/providers.js`.
- Per-provider tuning (model + voice settings) lives in `settings.providerSettings`
  (`getProviderSettings`) and is snapshotted onto each queue item; the worker
  builds ElevenLabs `voice_settings` via `buildElevenVoiceSettings`.
