# Changelog

## 0.6.1 — ElevenLabs 5000-char chunking

- All three ElevenLabs models share the same **5000-character per-request cap**
  (not the higher docs limits), so chunking now stays under 5000 for every model
  — no more oversized requests on Multilingual v2 / Flash v2.5.

## 0.6.0 — Model & voice controls (ElevenLabs, OpenAI, fish)

A new **Voice settings** panel that adapts to the provider — and, for
ElevenLabs, to the chosen model:

- **ElevenLabs model picker** — **Multilingual v2** (lifelike quality),
  **Flash v2.5** (fast & affordable), or **v3** (most expressive, alpha). Long
  text is chunked to stay under ElevenLabs' 5000-char per-request cap. Works for
  both the API-key and web-session ElevenLabs providers.
- **ElevenLabs voice settings** — Stability, Similarity, Style exaggeration,
  Speed, and Speaker boost, sent as `voice_settings`. The controls follow the
  model: v2/Flash show continuous sliders for everything, while **v3** shows a
  discrete **Creative / Natural / Robust** stability (it steers expression with
  audio tags instead of style/speed, so those are hidden).
- **Speed for OpenAI (0.25–4×) and fish.audio (0.5–2×)** too.
- Settings are **per provider**, persist, and are snapshotted onto each queue
  item when you queue — so changing them later doesn't rewrite pending work.
  A **Reset** link restores a provider's defaults.

## 0.5.1 — Settings fixes

- **Settings page buttons work again.** The options page listed a `fishVoice`
  field that doesn't exist there, so loading it threw before the Save / Grant
  access / Test connection buttons were wired — clicking them did nothing. Fixed
  (the loops are now null-safe), so all three give their feedback again: Save
  flashes "✓ Saved", Grant/Test report their result inline.
- **"✨ What's new" button sizing.** It was inheriting the 16px icon-link size;
  small text links (What's new, Reload, queue controls) are now 12px.

## 0.5.0 — Human pacing + full queue controls

Queue quality-of-life, adapted from the sibling Bulk Asset extension:

- **Human pace.** A configurable, randomised gap between generations so a web
  session (fish.audio / ElevenLabs) is never flooded — presets **Off / Quick
  (2–5s) / Balanced (5–12s) / Cautious (15–40s)** or a custom min–max. The gap
  is waited out with a live "Waiting Ns…" countdown and is interruptible.
- **Live queue status bar.** A prominent **Idle / Queued / Generating / Paused /
  Finished** indicator (green + glowing while generating, amber while paused)
  with running **done / failed / left** counts.
- **Pause & Resume.** Pause lets the current item finish and save, then stops;
  Resume picks straight back up.
- **Auto-retry / repair.** A failed generation or download is retried
  automatically (once by default) before it's marked failed — and every failed
  row keeps a **↻ retry** button, with a **Retry failed** action to re-run them
  all at once.
- **Clear pending.** Drops everything not yet started; the in-flight item
  finishes on its own.
- **Load / Reload script + audio.** A **⟳ Reload** button re-pulls the project's
  episodes and the open episode's chapters + audio status from Story Studio
  (dropping the cache), so you can refresh after editing scripts or saving audio.
- **Queue this episode's audio** — a one-click button to queue every missing
  section (intro + chapters) of the current episode, alongside **Queue selected**
  and **Queue all pending (whole project)**.

## 0.4.0 — Provider open-button, version badge, What's new

More UX parity with the sibling Bulk Asset extension:

- **No more surprise tabs when switching provider.** Selecting fish.audio or
  ElevenLabs (web) no longer pops their page open on its own. Loading voices now
  uses an already-open tab; if none is open you get a clear prompt instead.
- **"↗ Open provider" button.** A manual shortcut (shown only for the
  web-session providers) opens or focuses the provider's page when *you* want it
  — the extension never does it behind your back. Queued generations still open
  the tab in the background so unattended runs finish.
- **Version badge** next to the title, showing the installed extension version.
- **"✨ What's new" button** — renders this changelog in a panel, with a red dot
  until you've read the current version's notes.
- **Episode audio progress at a glance.** In companion mode the episode dropdown
  now annotates each episode with `· done/total ✓`, so you can see which
  episodes are fully voiced and which still need audio without opening each.

## 0.3.0 — Multi-select, in-panel test, auto-save, styled dialogs

Four UX features adapted from the sibling Flow extension:

- **Multi-select chapter list.** Companion mode replaces the single
  chapter/intro dropdown with a checkbox list + **select-all**, and a
  **"Queue selected (N)"** button — queue any subset (e.g. chapters 3, 5, 7) in
  one go. Already-voiced chapters show a ✓ badge and become selectable only in
  re-voice mode. Header shows `done/total have audio`.
- **In-panel "Test connection"** button + status chip — quick health check from
  where you work, not just Settings.
- **Settings auto-save** — every field saves as you edit (debounced), with a
  "Saved" flash. The Save button stays too.
- **Styled confirmation dialog** — replaces the native `confirm()` popup with an
  in-panel overlay for the queue confirmations.

## 0.2.0 — Portable, remote-capable Story Studio connection

- **Port-agnostic localhost permissions.** `host_permissions` now uses host-level
  `http://localhost/*` + `http://127.0.0.1/*` (no port), so a local Story Studio
  server on any port works — including the new default 8677.
- **Remote/Tailscale servers** via `optional_host_permissions` + a runtime
  **"Grant access to this server"** button in Settings (`chrome.permissions.request`),
  so each user authorizes their own server address — nothing is hardcoded.
  Distributable without a whitelist.
- **Default server URL → `http://localhost:8677`** (matches the Story Studio
  server the sibling Flow extension uses), fully editable.
- **"Test connection"** button in Settings — checks the URL is reachable and
  reports the project count (or a clear error + grant/login hint).
- **Panel hint** now distinguishes local vs remote when it can't reach the
  server ("did you Grant access + log in?").
- **Regeneration toggles** (borrowed from the sibling Flow extension): "Show
  episodes that already have all audio" and "Include chapters that already have
  audio (re-voice)" — so you can re-generate a chapter after editing its script
  or switching voice/provider. Already-voiced chapters are marked ✓.

Recap of how it works: localhost (loopback) needs no grant and no login; a
remote server needs the grant + server-mode login (`POST /api/auth/login`).
All script-reading / audio-writing stays server-side, so remote behaves
identically to local once authorized.
