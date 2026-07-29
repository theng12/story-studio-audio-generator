# Story Studio Audio Generator (`story-studio-audio-generator`)

MV3 extension for turning Story Studio scripts into audio and saving the results with consistent names.

## Public Documentation

Keep `README.md` product-level and provider-neutral. Do not document service-specific endpoints, authentication mechanics, account limits, or implementation details in public-facing files.

## Key Areas

- `src/background.js`: queue orchestration, persistence, and saving.
- `src/content/`: browser-session bridges for compatible services.
- `src/lib/`: configuration, naming, project integration, and service adapters.
- `src/popup/`: side panel workflow.
- `src/options/`: preferences and input-mode settings.

## Product Boundaries

- Keep the queue durable, observable, and safe to pause or retry.
- Preserve project-folder and Downloads save targets.
- Keep service integrations isolated behind the shared adapter layer.
- Keep public copy focused on user outcomes, not integration mechanics.
