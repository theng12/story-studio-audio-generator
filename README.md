# Story Studio Audio Generator

A Chrome extension for turning Story Studio scripts into organized audio files.

## What It Does

- Works with project scripts or pasted text.
- Lets you choose the sections and voice settings for a batch.
- Runs work through a persistent queue with progress, pause, retry, and recovery controls.
- Saves finished audio to the connected project workspace or the browser Downloads folder.

## Workflow

1. Open the side panel and connect a project, or paste content directly.
2. Select an episode, the sections to process, and the available voice settings.
3. Queue the selected work and monitor its status in the active batch view.
4. Let the extension save each completed file to the chosen destination.

## Availability

Audio generation uses a compatible signed-in browser session. Available voices and limits depend on the session you are using.

## Install

1. Open `chrome://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select this repository folder.
3. Open the extension from the Chrome toolbar to use the side panel.

## Notes

- Project mode works with a running Story Studio workspace.
- Paste mode works independently and saves to Downloads.
- The queue is designed to survive closing and reopening the side panel.
