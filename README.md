# Story Studio Audio Generator for Story Studio

A Chrome (Manifest V3) extension that turns **Story Studio KH** scripts into
narration audio using your **paid fish.audio web plan** — and saves each file
with the correct name, so you're not paying for the Fish API or doing it by
hand.

## How it works

```
┌────────────┐   script text   ┌───────────┐   text→audio   ┌────────────┐
│ Story      │ ───────────────▶│ Extension │ ──────────────▶│ fish.audio │
│ Studio KH  │  (companion API │  (popup +  │  (content      │  (your paid│
│ local API  │   or paste)     │  worker)   │   script)      │   web plan)│
└────────────┘                 └─────┬─────┘                 └────────────┘
                                     │ chrome.downloads
                                     ▼
                         Downloads/StoryStudioAudio/<project>/<episode>/<name>.mp3
```

### Two input modes (chosen on the Options page)

- **Paste** — paste/type the script into the popup. No dependency on Story
  Studio running. Most reliable.
- **Companion** — read scripts straight from a running Story Studio server:
  - Desktop app API: `http://localhost:8000` (no login)
  - Server mode: `http://localhost:8766` (log in via the popup; sets the
    `ssk_session` cookie)

  Endpoints used: `GET /api/projects`, `GET /api/projects/:slug/episodes`,
  `…/chapter-list`, `…/chapters/:n/content`.

### Saving — two targets (chosen in the popup / Options)

- **Story Studio project folder (v2, companion mode):** the extension POSTs
  the audio to `POST /api/projects/:slug/episodes/:code/audio-ingest`. Story
  Studio writes it into the episode's real audio folder as
  `{CODE}_Chapter_NN.mp3` — exactly what its own Audio Assembly produces — and
  rebuilds `audio_chapters.json` so merge / subtitles / video pick it up. No
  native-host helper needed; the running server does the filing.
- **Downloads folder (always available):** saves into the browser Downloads
  folder, in a per-project / per-episode subfolder, with the correct filename.
  This is the only option in paste mode (no project identifiers) and the hard
  limit of the browser sandbox.

> The `audio-ingest` endpoint lives in the Story Studio repo
> (`electron/server/routes/audio.ts`) on branch `feat/audio-ingest-from-browser`.
> It must be built into the app (`npm run build` + relaunch) before the
> project-folder target works against a running server.

## fish.audio automation (how it actually works)

Recon against the logged-in studio settled the design — it's **fully
API-driven**, no DOM scraping, no polling:

1. **Auth** — the studio authorizes with `Authorization: Bearer <token>`,
   where the token is `localStorage.token` on any fish.audio page. A
   logged-in fish.audio tab must be open because that's where the token lives
   *and* because `api.fish.audio` only accepts the request from the fish.audio
   origin — so the call runs from a content script on the page.
2. **Generate** — `POST https://api.fish.audio/task` with
   `{ type:"tts", stream:true, model, prosody, latency, parameters:{…} }`.
   With `stream:true` the response *is* the MP3 (`application/octet-stream`),
   so there's nothing to poll — we get the bytes back in one request.
   (Fish's web app also sends a reCAPTCHA token, but the API does **not**
   enforce it for an authenticated request — verified live — so we skip it.)
3. **Voices** — `GET https://api.fish.audio/model?self=true` lists the user's
   own voices (`_id` = the `model_id` to pass).
4. **Auto-tag** (optional) — Fish's "Auto Tag All" is
   `POST https://api.fish.audio/enhance/text` with `{ payload: { text } }` →
   `{ enhanced_script }`. It inserts `[emphasis]`/`[soft]`/`[pause]`/… tags for
   more expressive narration. Verified it preserves the wording exactly
   (stripping the tags returns the original text); off by default.

Because `grecaptcha` is main-world only and `chrome.*` is isolated-world only,
two content scripts cooperate:

| File | World | Role |
|---|---|---|
| `src/content/fish-main.js` | MAIN | read the token, call the Fish API, return MP3 bytes |
| `src/content/fish.js` | isolated | bridge `chrome.runtime` ⇄ main world via `postMessage` |

Limit: one generation is capped at 15 000 characters (enforced with a clear
error). Splitting long chapters and stitching the parts is a follow-up.

## Companion mode behaviour

- **Only shows what needs audio.** Projects, episodes, and chapters are
  filtered to "script is done, audio is missing": episodes use the Story Studio
  `status` flags (`script && !audio`); chapters/intro come from the episode's
  `audio-status` `missing_files`, so anything already voiced is hidden.
- **Introduction included.** Episodes with an intro section show an
  **Introduction** entry (saved as `{CODE}_Introduction.mp3`), alongside the
  chapters.
- **Remembers your last selection.** The last project, episode, voice, save
  target, and auto-tag toggle are restored when you reopen the popup (no more
  resetting to the first project).
- **No login over localhost.** The Story Studio server trusts loopback
  requests, so the popup never asks you to log in for a `localhost` server.
  A login is only needed for a remote / tailnet address — set the username +
  password once in **Settings** (stored locally on this device, not synced)
  and the popup signs in automatically when a remote server returns 401.

## Generate all chapters

In companion mode the popup has a **Generate all chapters** button. It
pre-fetches every missing section's text (intro + chapters), then the worker
generates + saves them one at a time — **fully sequential and human-paced**:
each chapter waits for the audio to come back and be saved before the next
starts, with a randomised 2.5–6s gap in between, so fish.audio is never
flooded. Progress is reported `(n/total)`; the loop runs in the service worker
so it keeps going even if you close the popup. Per-chapter failures are
counted, not fatal.

## Requirements at run time

- A fish.audio tab, **logged in** (the extension opens one in the background
  if needed). The token + grecaptcha come from that page.
- For companion mode, Story Studio running (desktop `:8000` or server `:8766`).

## Install (unpacked, for development)

1. Go to `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open the extension's **Options** to pick a mode and set the filename
   template.

## Files

| Path | Purpose |
|---|---|
| `manifest.json` | MV3 manifest, permissions, content-script registration |
| `src/background.js` | Job orchestration + `chrome.downloads` |
| `src/content/fish.js` | fish.audio automation (**stub**) |
| `src/lib/story-studio.js` | Story Studio local API client |
| `src/lib/naming.js` | Filename + download-path builder |
| `src/lib/config.js` | Settings + defaults |
| `src/popup/` | Popup UI (mode-aware) |
| `src/options/` | Install-time settings |
