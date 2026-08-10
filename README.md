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

Audio generation uses signed-in Fish Audio or ElevenLabs browser sessions; no
provider API key is required. The extension discovers the available voices,
models, capabilities, and limits from the active account when the provider
exposes them, with conservative fallbacks when live discovery is unavailable.

## Install

1. Open `chrome://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select this repository folder.
3. Open the extension from the Chrome toolbar to use the side panel.

## Notes

- Requires a running Story Studio workspace.
- The queue is designed to survive closing and reopening the side panel.
