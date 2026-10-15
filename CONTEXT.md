# VYNQ — Project Context

Last updated: 2026-10-15

## Product

VYNQ is a browser-first meeting app with invite links, host admission, participant presence, LiveKit video/audio, screen sharing, and Watch Together support.

The product direction is now explicit: VYNQ is a Telegram-first instant meeting room, not a feature-for-feature Zoom replacement. See `PRODUCT_DIRECTION.md` for the validated meeting model, feature comparison, and delivery order.

The latest release-readiness findings are maintained in `AUDIT.md`.

## Live production site

- URL: https://vynq-virid.vercel.app
- Repository: https://github.com/paperlinkos/vynq
- Hosting: Vercel
- Database: Neon Postgres
- Realtime media: LiveKit Cloud
- Production was redeployed successfully on 2026-10-15 after renewing the local Vercel login. The canonical URL now serves the current build, including the remote-audio and automatic pre-join permission changes.

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
- Pre-join now immediately requests browser camera/microphone permission, with a retry control if it was denied or unavailable.
- In-room microphone, camera, and screen-share controls.
- Fixed the event delegation bug that prevented microphone, camera, and screen-share control clicks from reaching LiveKit.
- Meeting-room stage redesign: a viewport-bound video canvas, always-visible bottom control dock, responsive grid view, focus view, per-participant pinning, and browser full-screen control. The inactive Watch Together sidebar no longer takes permanent space from calls.
- Remote LiveKit audio tracks are now attached to the meeting page and removed when unsubscribed.
- In-call Devices panel with microphone, camera, and speaker switching, a speaker test, and microphone level feedback.
- Participant tiles now distinguish a pending server presence (`Joining…`) from an actual LiveKit media connection (`Connected` / `Camera on`) and avoid duplicate tiles.
- Admitting a guest closes the request and returns the host directly to the room; it no longer reopens the full participant list.
- Initial group-call capacity is now capped at 25 people (including waiting guests); it is configurable through `VYNQ_MAX_PARTICIPANTS` up to 100.
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

## Production verification — 2026-10-15

- Vercel production deployment is `READY` and assigned to the canonical URL above.
- A clean production API lifecycle check passed: create meeting (201), guest joins waiting room (200), host sees and admits guest (200), guest becomes approved, LiveKit token generation succeeds (200), and guest leave removes the guest from the host participant list.
- This proves the server-side meeting lifecycle and LiveKit credential delivery. A two-person browser call is still required to prove physical microphone/camera capture, publishing, and remote playback on actual devices.

## Known follow-up work

- **P0:** Verify a complete two-device LiveKit audio/video call in real browsers after the remote-audio fix.
- Make participant state explicitly distinguish waiting, admitted, connecting, connected, reconnecting, and left.
- Make normal-link guest joins idempotent so refresh/retry cannot generate confusing duplicate admission requests.
- Improve the visual participant grid and device-error messages based on testing feedback.
- Test the new grid, focus/pin, and full-screen layouts with two or more real participants and refine the participant-strip behavior for larger groups.
- Configure and test the Telegram bot/Mini App integration, then add the Telegram-specific one-tap create/share flow.
- Recording is a later differentiator: use a real recording pipeline and deliver the finished recording to a Telegram chat when a Telegram-connected host chooses it. Do not rely on Telegram as the only recording store.
- File sharing is not yet implemented; it requires object storage and access controls.
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
