# Audio Generator Cleanup Design

## Goal

Finish the Audio Generator cleanup around its already-working signed-session
discovery and recovery system: remove dead behavior, make Story Studio section
eligibility truthful, reconcile credential storage, and align Fleet and release
documentation with shipped behavior.

## Provider And Billing Boundary

Keep only Fish Audio and ElevenLabs Web. Both use the account already signed in
on the provider website and consume that website account's quota or credits.
The extension must not accept provider developer API keys or add separately
billed developer API routes.

Preserve dynamic account discovery:

- Fish discovers account voices and reads model choices exposed by the signed
  page, with a conservative tested fallback when the model control is unreadable.
- ElevenLabs discovers account voices, TTS-capable models, limits, and supported
  controls from the signed web session, with a conservative tested fallback.

Every queued item snapshots the exact discovered model metadata and voice ID.
Unknown models fail before generation rather than falling back silently.

## Provider Bridge Boundary

The background queue remains the only extension component authorized to start
generation. Add unpredictable per-session channel and per-request correlation
to the MAIN-world bridge so unrelated page messages and stale responses are
ignored. Treat this as message-integrity hardening, not protection from a fully
compromised provider origin: provider-origin code already holds the same signed
website authority.

Preserve ambiguous-outcome classification, cached-audio recovery, download
checkpointing, sequential pacing, and the rule that no uncertain paid request is
automatically replayed.

## Story Studio And Credentials

Only sections that map to a valid Story Studio whole-script, introduction, or
numbered-chapter contract may be queued. Unknown missing filenames remain
visible with an actionable unsupported-section reason but cannot reach provider
generation or an invalid ingest request.

Store the Story Studio URL and username in `chrome.storage.local`. Store the
Story Studio password in `chrome.storage.session`, not persistent local storage.
After a browser restart, remote Story Studio work pauses and asks for the
password again; generated audio and queue evidence remain preserved. Remove any
legacy persisted password during settings migration.

Remove the proven-dead `StudioClient.whoami()` path. Preserve Story Studio audio
ingestion, standalone downloads, section filenames, and remote host-permission
handling.

## Fleet And Interface

Replace the stale "Coming soon" copy with the actual opt-in Fleet behavior:
sanitized telemetry plus signed, revision-checked pause-after-current, resume,
and clear-pending commands. Fleet must not alter provider, model, voice, pacing,
credentials, or site-access settings.

Keep the existing visual layout. This is correctness and maintenance work, not
a redesign.

## Verification And Release

Add dependency-free tests for bridge request correlation, unknown-section
rejection, session-only password migration, provider inventory snapshots, Fleet
copy/contracts, manifest permissions, and preserved standalone/project queue
behavior. Retain the 29 provider and recovery tests.

Run the full Node test suite, `node --check` on every JavaScript file, manifest
and declared-file validation, and `git diff --check`. Live-discover Fish and
ElevenLabs inventories and run one real generation/save path for each when the
signed tabs are available. Bump the manifest version, update the changelog and
README, commit, and push.
