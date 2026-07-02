# Story Studio TTS (`fish-tts-extension`)

MV3 extension: turns Story Studio KH scripts into narration audio and saves each
file with the correct name. See `README.md` for the full provider/flow writeup;
this file is the orientation map. Shared architecture lives in the parent `../CLAUDE.md`.

## Providers — two kinds (chosen in the side panel)

- **Web-session (no API key):** drives your logged-in tab.
  - **fish.audio** — content scripts `content/fish-main.js` (+ `fish.js`).
  - **ElevenLabs (web)** — reads the page's Firebase session token, self-refreshes
    it via the `securetoken` endpoint, calls `api.us.elevenlabs.io`. Keep an
    elevenlabs.io tab open. Per-gen cap 5000 chars → chunk + join MP3s.
- **API-key (worker calls the API directly, no tab):** ElevenLabs (API key), OpenAI.
  - OpenAI TTS: fixed voices, paid per use, 4096-char cap → split on sentence
    boundaries and join.

Auto-tag (emotion/pause tags) is **fish.audio-only**; hide it for other providers.
Queue, save-back, and naming are shared across all providers.

## Key files

- `src/background.js` — service worker: the queue, API-key provider calls, downloads.
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
- Chunking limits differ per provider (5000 web / 4096 OpenAI); keep them per-provider.
