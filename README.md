# Story Studio TTS

A Chrome (Manifest V3) extension that turns **Story Studio KH** scripts into
narration audio using a TTS provider you already pay for — and saves each file
with the correct name, into the right project folder.

## Providers

Pick the provider in the side panel. Two kinds:

- **Web-session — fish.audio.** Driven through your logged-in fish.audio tab
  (uses your web plan; no API key). See the fish-specific details below.
- **API-key — ElevenLabs, OpenAI.** The service worker calls the official API
  directly with a key you paste in **Settings** (stored locally, never synced).
  No browser tab needed.
  - **ElevenLabs** draws from your subscription's character quota (same as the
    web app). Voices are pulled from your account.
  - **OpenAI TTS** has fixed voices (alloy, nova, …) and a 4096-char request
    cap, so long chapters are split into sentence-boundary chunks and the MP3s
    are joined automatically.

Auto-tag (emotion/pause tags) is a fish.audio-only feature and only shows for
that provider. Everything else — the queue, save-back, naming — is shared
across providers.

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

- **Only shows what needs audio.** Within a project, episodes are filtered to
  "script done, audio missing" (`status.script && !status.audio`), and the
  chapter/intro dropdown comes from the episode's `audio-status` `missing_files`
  — so anything already voiced is hidden, and a section drops off the list the
  moment its audio is saved.
- **Fast to open.** The popup no longer scans every project up front (slow on
  large projects). It lists projects cheaply and lazily loads only the selected
  project's episodes, cached for 5 minutes (and invalidated after you generate).
- **Doesn't lose progress.** Generation runs in the service worker and writes
  its status to storage, so closing and reopening the popup shows the live
  `(n/total)` progress or the final result — the work keeps going either way.
  (Note: because the extension calls Fish's API directly, generations do **not**
  appear in the fish.audio web editor or its history — that's expected; the
  saved audio file is the result.)
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

## The queue — set it and walk away

All generation flows through a single **persistent queue** in the worker, so you
can pile up a lot of work and leave:

- **Generate & save** — queue the one selected section.
- **Queue all chapters (this episode)** — queue every missing section of the
  current episode (intro + chapters).
- **Queue whole project** — queue every missing section of *every* episode in
  the project that still needs audio. Walk away; come back to a finished project.

The worker processes the queue **one item at a time, human-paced** (it waits for
each section's audio to come back and be saved, then a randomised 2.5–6s gap
before the next) — so fish.audio is never flooded no matter how much you queue.
Only the section identifiers are queued; the worker fetches each section's text
from Story Studio when it reaches it.

It's **durable**: the queue lives in `chrome.storage`, so it survives the side
panel closing and even Chrome terminating the background worker — a
`chrome.alarms` tick wakes the worker to resume any pending items (an
interrupted item just re-runs).

**Management + safety:**
- The queue bar (`N queued · M done · K failed`) is backed by a **visible list**
  of every item with its status (`• pending`, `⟳ running`, `✓ done`, `✗ failed`).
  Each pending item has an **✕** to remove it; **clear pending** empties the rest.
- **Batch actions confirm first** — "Queue all chapters" / "Queue whole project"
  ask before spending credits and show the count.
- **De-duplicated** — queuing the same chapter again (e.g. an accidental
  double-click, or re-queuing an episode) skips anything already pending/running,
  so it can't generate twice and waste credits.

## Requirements at run time

- A fish.audio tab, **logged in** (the extension opens one in the background
  if needed). The token + grecaptcha come from that page.
- For companion mode, Story Studio running (desktop `:8000` or server `:8766`).

## Side panel (not a popup)

The UI runs as a Chrome **side panel** — click the toolbar icon and it opens
docked on the right and **stays open** as you switch tabs or click around. That
keeps your project/episode selection and any in-progress generation visible,
instead of a popup that's destroyed (and has to reload everything) the moment
you click away. Close it with the panel's own ✕.

## Install (unpacked, for development)

1. Go to `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Click the toolbar icon to open the side panel; open **Options** (right-click
   the icon → Options) to pick a mode and set the filename template.

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
