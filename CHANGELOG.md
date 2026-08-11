# Changelog

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

## 0.7.24 - Standalone batch review

- Added a paste, review, and approval flow for standalone audio scripts.
- Separate narration scripts with a `---` line while preserving multi-paragraph scripts.

## 0.7.23 - Queue actions

- Kept the compact queue-action row visible and added a consistent Clear pending control.

## 0.7.22 - Standalone mode

- Restored local-script audio generation with completed files saved to Downloads.

## 0.7.21 - Operational panel order

- Aligned the side-panel workflow with Image Generator: Provider settings,
  Generation workspace, Queue pacing, then Fleet Hub.
- Added a quiet Fleet Hub “Coming soon” disclosure; Audio queue controls remain local.

## 0.7.20 - Connection recovery visibility

- Hide the Update Studio URL recovery action while a fresh Studio connection
  test is in progress; it reappears only if that test fails.

## 0.7.19 - Connection-card consistency

- Added the missing remote-server Sign in action and standardized connection
  guidance, spacing, status feedback, and credentials layout.

## 0.7.18 - Sky-blue product accent

- Updated the Audio Generator's primary UI color and Chrome extension icon to
  the shared sky-blue audio identity.

## 0.7.17 - Settings save action

- Standardized Settings with the shared full-width primary Save action.

## 0.7.16 - Connection recovery and settings

- A failed panel connection test now links directly to the Studio URL setting.
- Reorganized Settings into consistent Appearance and Story Studio connection sections.

## 0.7.15 - Panel consistency

- Standardized the side-panel toolbar, disclosures, control sizing, action hierarchy, and queue activity treatment.

## 0.7.14 - Story Studio workflow

- Removed the standalone pasted-script workflow and browser-download output. Audio generation now starts from and returns to Story Studio projects only.

## 0.7.13 - Provider action

- Standardized the provider open action as a compact button.

## 0.7.12 - Working modes

- Made Story Studio and Standalone workflows explicit in the side panel.
- Added timestamped Studio connection results.

## 0.7.11 - Queue pacing

- Combined human pacing and provider cooldown controls into one queue pacing section.

## 0.7.10 - Applied settings

- Added a live header summary for pacing and the selected provider cooldown.

## 0.7.9 - Connection label

- Clarified the Studio connection test action.

## 0.7.8 - Provider settings

- Moved provider-specific voice controls directly below the primary setup row.

## 0.7.7 - Cooldown controls

- Standardized cooldown labels, presets, and manual versus auto-resume guidance.

## 0.7.6 - Setup flow

- Aligned the primary setup row as Provider, Voice, then Save to.

## 0.7.5 - Operational controls

- Kept pacing and cooldown settings visible as compact expandable control rows.
- Moved queue actions below the visible queue and show each action only when it can be used.

## 0.7.4 - Story Studio Audio Generator

- Renamed the extension across Chrome, the side panel, Settings, and public documentation.
- Simplified the public project description and documentation.

## 0.7.3 - Session-based generation

- Standardized generation around compatible signed-in browser sessions.
- Removed direct key configuration and migrated existing settings and queued work safely.

## 0.7.2 - Queue workspace

- Added the Active Batch workspace with progress, elapsed time, actions, and structured status rows.
- Refined project, episode, voice, pace, and cooldown controls for faster scanning.
- Fixed extension-page theme initialization.

## 0.7.1 - Long-script handling

- Improved section detection and recovery when one script produces multiple audio files.
- Prevented missing sections from disappearing from the generation workflow.

## 0.7.0 - Queue resilience

- Added cooldown handling, pause and resume controls, retries, and clearer failure states.

## Earlier releases

- Added voice controls, pacing, persistent queues, batch actions, project synchronization, and improved audio-file naming.
