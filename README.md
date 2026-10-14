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

The packaged application is written to `dist/`; deploy that directory with a Node runtime and start it with `node server.mjs`.

## Vercel test deployment

`vercel.json` is included. Import this repository into Vercel, leave the detected build command as `npm run build`, and add environment variables in **Project Settings → Environment Variables**—never upload `.env`.

For initial interface testing, deploy with no secrets. Add the LiveKit and Telegram variables only when you are ready to test those integrations. Set `TELEGRAM_WEB_APP_URL` only after Vercel gives you the final HTTPS deployment URL.

For durable shared meetings on Vercel, create a Neon Postgres database through Vercel Marketplace and add its pooled `DATABASE_URL` to Vercel. VYNQ automatically creates its `meetings` and `meeting_sessions` tables on first use and stores only a SHA-256 hash of each meeting session token.

Without `DATABASE_URL`, local development uses `.vynq-data/meetings.json`; Vercel uses `/tmp` as a temporary fallback, so meetings may disappear after a cold start. Do not use that fallback for shared testing.

## Deliberate Phase 1 limitations

Meetings are persisted in a local JSON data store, expire after 24 hours by default, and require a server-issued session token to retrieve meeting details. The room is still an interface shell only: no LiveKit media, chat, screen sharing, Telegram integration, or synchronized playback has been connected yet.

The JSON store is a deliberately lightweight Phase 2 choice, suitable for local or single-instance development only. Phase 7 should replace it with PostgreSQL (or another durable shared database), HTTPS termination, rate limiting, cleanup of expired records, logging, and session lifecycle controls before public production use.

## Live video setup

Create a LiveKit project or run a self-hosted LiveKit server, then provide `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` from `.env.example` to the **server environment**. The VYNQ browser never receives the API secret; it requests a short-lived, room-scoped token only after its VYNQ meeting session has been validated.

Without these three variables, the meeting room remains usable for invitations but clearly reports that live media has not been configured. Once configured, participants can use the Mic and Camera controls to grant browser permissions and publish live audio/video.

## Future environment variables

LiveKit requires `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`. PostgreSQL is still deferred until a multi-instance deployment is required. No secret is stored in source control.

## Telegram setup

Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEB_APP_URL` (a public HTTPS VYNQ URL), and a strong `TELEGRAM_WEBHOOK_SECRET` on the server. Configure Telegram's webhook to `https://your-domain/api/telegram/webhook` with that same secret token, and set the Mini App URL to `TELEGRAM_WEB_APP_URL` in BotFather.

The Mini App submits Telegram's `initData` to the server; VYNQ validates its HMAC and freshness before creating a meeting as that Telegram user. Browser guests never need Telegram, and their normal meeting-link flow remains unchanged.

## Watch Together

The meeting host can select a direct HTTPS `.mp4`, `.webm`, or `.ogv` URL. VYNQ sends versioned playback state—source, play/pause status, position, and timestamp—through LiveKit reliable data messages. Guests apply the latest host state and correct playback drift greater than half a second.

Only the host receives LiveKit permission to publish Watch Together data. This MVP intentionally excludes uploaded files, DRM-protected streams, and provider-restricted embeds. Test it with two browser sessions and a permitted, CORS-enabled direct video source after configuring LiveKit.

## Host controls and waiting room

New guests enter a waiting room and cannot receive a LiveKit token until the host admits them. Hosts can list, admit, or remove guests from the People control. Hosts can also use the Screen control to share a browser-supported display through LiveKit; mobile browser support depends on the device and browser.

## Production safeguards

VYNQ sets browser security headers, limits sensitive API requests to 12 requests per minute per IP/path (and other API requests to 120), cleans expired meetings every five minutes, and writes structured request logs. The in-process rate limiter is useful for local and single-instance protection only; use Vercel Firewall or an external shared limiter before significant public traffic.
