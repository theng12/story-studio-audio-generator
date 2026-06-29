# Changelog

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
