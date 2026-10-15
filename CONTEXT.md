# VYNQ — Project Context

Last updated: 2026-10-15

## Product

VYNQ is a browser-first meeting app with invite links, host admission, participant presence, LiveKit video/audio, screen sharing, and Watch Together support.

## Live production site

- URL: https://vynq-virid.vercel.app
- Repository: https://github.com/paperlinkos/vynq
- Hosting: Vercel
- Database: Neon Postgres
- Realtime media: LiveKit Cloud

## Completed

- Landing page, create meeting, and join meeting flows.
- Persisted meetings and sessions in Neon Postgres.
- Shareable meeting links using `#/room/VYNQ-...`.
- Guest waiting room and host admission controls.
- One-time host prompt when a guest requests to join.
- Duplicate Join clicks are blocked in the browser.
- Host and admitted guests see each other as joined participant tiles before media connects.
- Leaving a meeting removes the participant from other attendees' presence lists.
- LiveKit token generation is configured and verified.
- Pre-join camera/microphone screen with preview, device pickers, and enter choices.
- In-room microphone, camera, and screen-share controls.
- Watch Together foundations using LiveKit data messages.
- Telegram Mini App authentication and webhook endpoints are implemented but not yet configured.

## Vercel environment variables

Configured in Production only. Values are secrets and must never be stored in this file.

- `DATABASE_URL`
- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

Still needed when Telegram launch begins:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEB_APP_URL`
- `TELEGRAM_WEBHOOK_SECRET`

## Current testing instructions

1. Hard-refresh the production site on both devices.
2. Host creates a meeting and shares the copied invite link.
3. Guest opens the link, enters a name, and joins the waiting room.
4. Host receives a join prompt and selects **Admit to meeting**.
5. Both people use the pre-join screen to enable camera/microphone, select devices, and enter.
6. Test mute/unmute, camera on/off, screen share, and Leave.

## Known follow-up work

- Verify two-device LiveKit audio/video behavior in real browsers after the latest pre-join deployment.
- Improve the visual participant grid and device-error messages based on testing feedback.
- Configure and test the Telegram bot/Mini App integration.
- Add Vercel Preview and Development environment variables if preview deployments need full functionality.
- Add GitHub Actions Vercel deployment secrets if GitHub-driven Vercel deploys are desired in addition to direct deployment.

## Coding-agent tooling

- REA (Reverse Engineer Anything) is installed globally for Codex as of 2026-10-15.
- REA 6.5.0 was verified with its capabilities check; its global `reverse-engineer-anything` skill and Codex MCP registration are present.
- Restart Codex once to load the newly registered REA capability into a fresh agent session.

## Recent commits

- `94abeff` Add prejoin media preview and device controls.
- `8454ae9` Reflect participant departures in meeting presence.
- `ea2e55d` Show admitted participants to guests.
- `6b5e821` Open guest room after joining an existing invite link.
