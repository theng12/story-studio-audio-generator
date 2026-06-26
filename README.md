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
   where the token is `localStorage.token` on any fish.audio page.
2. **reCAPTCHA** — every generation carries a fresh reCAPTCHA Enterprise
   token. We mint our own with the page's site key + action `"tts"`. This is
   the *only* reason a fish.audio tab must be open: `grecaptcha` lives in the
   page's MAIN world.
3. **Generate** — `POST https://api.fish.audio/task` with
   `{ type:"tts", stream:true, model, prosody, latency, parameters:{…}, recaptcha }`.
   With `stream:true` the response *is* the MP3 (`application/octet-stream`),
   so there's nothing to poll — we get the bytes back in one request.
4. **Voices** — `GET https://api.fish.audio/model?self=true` lists the user's
   own voices (`_id` = the `model_id` to pass).

Because `grecaptcha` is main-world only and `chrome.*` is isolated-world only,
two content scripts cooperate:

| File | World | Role |
|---|---|---|
| `src/content/fish-main.js` | MAIN | mint reCAPTCHA, call the Fish API, return MP3 bytes |
| `src/content/fish.js` | isolated | bridge `chrome.runtime` ⇄ main world via `postMessage` |

Limit: one generation is capped at 15 000 characters (enforced with a clear
error). Splitting long chapters and stitching the parts is a follow-up.

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
