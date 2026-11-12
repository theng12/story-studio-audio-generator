# Story Studio Audio Generator

A Chrome extension for turning Story Studio scripts into organized audio files.

## What It Does

- Works with scripts from a connected Story Studio project.
- Lets you choose the sections and voice settings for a batch.
- Runs work through a persistent queue with progress, pause, retry, and recovery controls.
- Saves finished audio back to the connected project workspace.

## Workflow

1. Open the side panel and connect a Story Studio project.
2. Select an episode, the sections to process, and the available voice settings.
3. Queue the selected work and monitor its status in the active batch view.
4. Let the extension save each completed file back to the project workspace.

## Availability

Audio generation uses supported signed-in provider web sessions; no developer API key is required. The extension discovers the account's available voices, models, controls, and limits and keeps the exact selected voice/model snapshot with each queued item.

## Gateway Studio mode

A third mode beside Story Studio and Standalone. The extension claims audio jobs from Gateway
Studio KH as an outbound worker: it opens no port and is never called by the server.

- **Pair** with a worker id and token from Gateway's Browser workers pane. Pairing does not arm
  dispatch; dispatch has to be turned on for that worker.
- **Account identity must be provider-observed and opaque.** The account provider must equal the
  job's provider (`fish` or `elevenlabs_web`); a Flow credit balance can never authorize an audio
  job, and an unreadable balance is reported as unknown, never as zero.
- **An unclaimed quote preview is read-only.** Nothing is enqueued, and no paid request is replayed
  when the outcome is unknown — uncertain work is held for review.
- Readiness is never inferred from a live process, and a missing observation keeps the claim
  refused rather than guessed.
- Browser TTS is outside this extension and stays optional and off.

## Install

1. Open `chrome://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select this repository folder.
3. Open the extension from the Chrome toolbar to use the side panel.

## Notes

- Requires a running Story Studio workspace.
- The queue is designed to survive closing and reopening the side panel.
- Remote Story Studio work asks for the password again after a browser restart; queued evidence and generated audio remain available for recovery.
