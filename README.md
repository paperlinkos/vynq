# VYNQ

VYNQ is a browser-first video meeting product, designed for effortless calls and shared watching.

## Current phase

Phase 7 — production-hardening foundations and deployment readiness.

## Run locally

No dependencies are required. Start the local application server:

```sh
npm start
```

Then visit `http://localhost:4173`. Copy `.env.example` to `.env` (or set those variables in your host) only when you need a non-default port, data folder, or meeting lifetime.

## Commands

```sh
npm test
npm run build
```

The packaged browser application is written to `dist/`; run the local server with `npm start`.

## Vercel test deployment

`vercel.json` is included. Import this repository into Vercel, leave the detected build command as `npm run build`, and add environment variables in **Project Settings → Environment Variables**—never upload `.env`.

For initial interface testing, deploy with no secrets. Add the LiveKit and Telegram variables only when you are ready to test those integrations. Set `TELEGRAM_WEB_APP_URL` only after Vercel gives you the final HTTPS deployment URL.

For durable shared meetings on Vercel, create a Neon Postgres database through Vercel Marketplace and add its pooled `DATABASE_URL` to Vercel. VYNQ automatically creates its `meetings` and `meeting_sessions` tables on first use and stores only a SHA-256 hash of each meeting session token.

Without `DATABASE_URL`, local development uses `.vynq-data/meetings.json`; Vercel uses `/tmp` as a temporary fallback, so meetings may disappear after a cold start. Do not use that fallback for shared testing.

## Production architecture and configuration

Vercel serves the Vite build from `dist/` and routes every `/api/*` request to `api/[...route].mjs`, which delegates to the shared Node handler in `lib/vynq-server.mjs`. Vercel serves the static app directly, so `vercel.json` also applies the browser security headers there; the Node handler applies the equivalent policy to local/static and API responses.

For a controlled beta, `DATABASE_URL` is required. It selects Neon Postgres, so meetings, sessions, chat, and Watch Together state are shared across Vercel function instances. The schema setup is idempotent (`CREATE/ALTER ... IF NOT EXISTS`) and runs on first database use; it does not drop tables or production data. The JSON store is only a local/single-process fallback. On Vercel that fallback is `/tmp`, which is ephemeral and must not be used for shared testing.

Required before a media-enabled beta: `DATABASE_URL`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`. LiveKit credentials remain server-only; the browser receives a short-lived, room-scoped token after admission. `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEB_APP_URL`, `TELEGRAM_WEBHOOK_SECRET`, and `TELEGRAM_BOT_USERNAME` are optional as a group—VYNQ starts and normal browser invitations work without them. An absent LiveKit or Telegram configuration produces a safe, user-facing 503 only when that integration is requested.

The Content Security Policy permits same-origin resources, direct HTTPS media for Watch Together, and secure WebSocket connections for the configured LiveKit service. It does not allow third-party scripts or CORS. Vercel cannot interpolate the secret LiveKit host into a static header, so the static CSP permits `wss:` while the Node response policy additionally narrows the configured LiveKit origin. Keep LiveKit on secure WebSockets in production.

## Live video setup

Create a LiveKit project or run a self-hosted LiveKit server, then provide `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` from `.env.example` to the **server environment**. The VYNQ browser never receives the API secret; it requests a short-lived, room-scoped token only after its VYNQ meeting session has been validated.

Without these three variables, the meeting room remains usable for invitations but clearly reports that live media has not been configured. Once configured, participants can use the Mic and Camera controls to grant browser permissions and publish live audio/video.

## Telegram setup

Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEB_APP_URL` (a public HTTPS VYNQ URL), `TELEGRAM_WEBHOOK_SECRET`, and `TELEGRAM_BOT_USERNAME` (the public BotFather username without `@`) on the server. Configure Telegram's webhook to `https://your-domain/api/telegram/webhook` and set its secret token to the exact `TELEGRAM_WEBHOOK_SECRET` value. Set the Mini App URL to `TELEGRAM_WEB_APP_URL` in BotFather.

VYNQ uses a webhook, which fits serverless hosting: Telegram sends updates to VYNQ and VYNQ sends a short command response through the Bot API. Supported commands are `/start`, `/help`, `/newmeeting`, and `/join <VYNQ link or code>`. The bot directs `/newmeeting` users to the existing browser form; it never creates a host session itself. `/join` validates that a meeting is active before returning a browser link, and the guest still enters the normal waiting room.

The Mini App may submit signed Telegram `initData` only for the existing guest-join helper; VYNQ validates its HMAC and freshness server-side. Telegram usernames are never treated as proof of VYNQ host authority. Browser guests never need Telegram, and every invitation remains a normal browser link.

For local bot tests, use a test bot or the automated mock suite. Do not configure a production webhook to a localhost URL. Telegram must be able to reach the final HTTPS `/api/telegram/webhook` URL before a real bot test can work.

## Watch Together

The meeting host can select a direct HTTPS `.mp4`, `.webm`, or `.ogv` URL. VYNQ persists an authoritative, versioned playback state—source, play/pause status, position, and server timestamp—and admitted participants fetch it every 2.5 seconds while in the room. Guests apply only newer host revisions and correct playback drift greater than half a second. Browser autoplay rules still apply: a guest may need to tap play before audible playback can begin.

Only the authenticated meeting host can publish Watch Together state; guests can retrieve it only after admission. Updates carry the revision the host started from, so stale or racing writes are rejected instead of silently overwriting newer playback. This MVP intentionally excludes uploaded files, DRM-protected streams, and provider-restricted embeds. Test it with two browser sessions and a permitted, CORS-enabled direct video source.

## Host controls and waiting room

New guests enter a waiting room and cannot receive a LiveKit token until the host admits them. Hosts can list, admit, or remove guests from the People control. Hosts can also use the Screen control to share a browser-supported display through LiveKit; mobile browser support depends on the device and browser.

## Invitations

Only the authorized host sees invitation controls in the meeting room. **Copy invite link** produces `https://your-domain/#/room/VYNQ-…`; it contains no VYNQ session, LiveKit token, or participant data. **Share via Telegram** opens Telegram's standard share URL with that same browser link and, when `TELEGRAM_BOT_USERNAME` is configured, a short bot deep link such as `https://t.me/your_bot?start=join_VYNQ-…`. The bot validates the meeting before returning the browser flow; the deep link never bypasses admission. People can open the invitation without Telegram, enter a name, and wait for host admission. Invalid, expired, and ended meetings are rejected by the existing server flow.

## Meeting lifecycle and reconnects

An approved meeting session is not the same thing as an online participant. The browser sends a server heartbeat every 10 seconds, and only sessions seen within `VYNQ_PRESENCE_GRACE_SECONDS` (45 seconds by default) appear in the People list and participant tiles. This allows a normal refresh or short connection interruption to rejoin using the existing session token without producing another waiting-room request.

An explicit **Leave** by the host ends the meeting for everyone: new joins and media-token requests are rejected, stored meeting sessions are removed, and VYNQ asks LiveKit to close the room when LiveKit is configured. A temporary host disconnection does not end the meeting until the reconnect grace period has elapsed. Guests who leave or remain disconnected past that period disappear from active presence.

LiveKit permissions are enforced in server-issued tokens: hosts may publish camera, microphone, and screen-share tracks; admitted guests may publish camera and microphone tracks only. Hiding a browser control is not relied on for that restriction.

## Meeting chat

Admitted participants can use group chat and direct messages from the meeting Chat panel. VYNQ stores messages in the existing Neon database when `DATABASE_URL` is configured, or in the local JSON store during local development. Messages are retained only for the lifetime of the meeting and are deleted when the meeting expires or is ended.

Chat uses authenticated HTTPS polling (every 2.5 seconds while the panel is open), not a room-wide LiveKit data broadcast. The server derives the sender from the session token, accepts up to 2,000 characters, limits a participant to 30 sends per minute, and validates the direct-message recipient as an admitted member of the same active meeting. Direct-message history is queried only as a conversation between the authenticated caller and the selected recipient; private bodies are never sent through group history or a room broadcast.

## Production safeguards

VYNQ sets a restrictive Content Security Policy, browser security headers, and no-store API responses; it does not enable CORS. It limits sensitive API requests to 12 requests per minute per IP/path (and other API requests to 120), accepts request bodies up to 10 KB, cleans expired meetings every five minutes, and writes structured request logs without request bodies, credentials, or message content. Unexpected backend errors return a generic 500 response and a minimal server-side event. Telegram Bot API sends time out after five seconds.

Local development rate limiting uses the socket address rather than a client-supplied forwarded-IP header; Vercel supplies the forwarded address in production. These rate-limit buckets are in-process and therefore are not shared across Vercel instances. Configure Vercel Firewall or a shared external limiter before opening access beyond a small controlled beta. There is no dedicated health endpoint; Vercel deployment status plus a non-mutating `GET /` check is the current availability check.

## Controlled-beta launch checklist

### Verified locally and by automated tests

- Meeting lifecycle: create, join, waiting-room admission, idempotent rejoin, reconnect grace period, expiry, guest removal, and host closure.
- Host-only LiveKit publish-source grants, group/private chat authorization, Watch Together state authorization and concurrency, and Telegram command validation with mocked Bot API calls.
- Browser build, Node syntax, and repository whitespace checks. These checks do not prove real browser media, Telegram, or third-party availability.

### Requires production configuration

1. Set `DATABASE_URL`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` in Vercel for the intended environment; do not add them to Git or client code.
2. Use a deployed HTTPS Vercel URL. HTTPS is required for browser camera/microphone access and for Telegram webhooks/Mini Apps.
3. If Telegram is included in the beta, set all four Telegram variables, then configure BotFather's Mini App URL and webhook secret for `https://your-domain/api/telegram/webhook`. Otherwise leave Telegram disabled; browser invitations still work.

### Requires real-browser and live-service testing

1. In two separate browsers/devices, create a meeting, copy the credential-free link, join the waiting room, admit the guest, and enter through pre-join.
2. Verify camera/microphone permission prompts, mute, camera toggle, device selection, remote audio/video, host screen share, guest screen-share denial, leave, and refresh/reconnect within 45 seconds.
3. Verify group chat and a private message with three accounts, plus Watch Together with a permitted CORS-enabled direct video URL; test a late join and browser autoplay fallback.
4. If enabled, test Telegram `/start`, `/newmeeting`, `/join`, invalid/ended invitations, and the actual webhook using a test bot—not a production audience.

### Operational setup outside this repository

- Before inviting testers, confirm Neon backup and restoration procedures in the Neon console and rehearse any recovery on a non-production branch/database. Schema changes are idempotent but are not a full migration system.
- Set Vercel access/log alerts and an incident contact path. The application has no monitoring vendor or health endpoint.
- Keep the beta small (the default capacity is 25 including people waiting). Add Vercel Firewall or a shared limiter before broad public traffic.
- The current Vite production build warns that the main minified JavaScript bundle is above 500 kB. It is not a functional deployment failure, but measure first-load performance on slower tester networks and plan code splitting before broad launch.
- Do not promise recording, end-to-end encryption, file sharing, or Telegram recording storage: they are not implemented.
