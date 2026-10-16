# VYNQ — Full Project Audit & Recovery Report

**Audited:** 2026-10-16
**Scope:** Entire tracked application repository, local non-secret configuration state, Vercel deployment metadata, and read-only production HTTP checks.
**Audit rule observed:** No application code, configuration, dependency, database, or deployment changes were made. This file is the only artifact created.

## A. Executive summary

VYNQ is a small, custom JavaScript meeting application rather than a framework application. It has a real server-side meeting/session model, a working LiveKit integration path, browser guest access, a waiting-room/admission model, and a deployed Vercel/Neon/LiveKit configuration.

It is **not release-ready**. The core implementation is closer to an early functional prototype than to a dependable meeting product. The biggest risks are not the landing page: presence is persisted-session based rather than connection based; guests can accumulate duplicate/stale sessions; a browser close now leaves stale server presence by design; host screen-share UI is mapped to the wrong control; and Watch Together is coded but inaccessible because its entire UI is hidden.

Audio/video was not independently proven in this audit because doing so requires actual cameras, microphones, two isolated browser sessions, and would create real meeting records. The source does construct LiveKit rooms, requests short-lived server tokens, publishes local media, and attaches remote tracks; that is implementation evidence, not end-to-end verification.

## B. Technology inventory

| Area | Actual implementation |
|---|---|
| Frontend | Vanilla browser JavaScript in `client/main.js`; no React, Next.js, Vue, routing library, or component library. |
| Build | Vite `8.3.4`, invoked by `npm run build`. |
| Local server | Node.js `http` server in `lib/vynq-server.mjs`; no Express/Fastify framework. |
| Vercel API | Catch-all Vercel function `api/[...route].mjs`, delegating to the same Node request handler. |
| Database | Neon serverless PostgreSQL when `DATABASE_URL` exists; local JSON file fallback in `.vynq-data/meetings.json`. |
| Media | `livekit-client 2.22.4` in browser and `livekit-server-sdk 2.19.1` for server-issued JWTs. |
| Auth | Anonymous server-issued bearer meeting-session token in `sessionStorage`; Telegram Web App HMAC identity verification for Telegram flows. No general user account system. |
| State | Module-level browser variables plus `sessionStorage`; server state in PostgreSQL or JSON. |
| Navigation | Hash routes: `#/` and `#/room/VYNQ-…`. |
| Deployment | Vercel, with a production deployment reported `Ready` on 2026-10-16. |
| Automation | GitHub Actions workflow builds/deploys with Vercel secrets, but secret configuration and successful workflow execution were not verifiable from this repository. |

**Production configuration inventory:** Vercel Production contains hidden `DATABASE_URL`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`. It does **not** contain the three Telegram variables. Local `.env` has none of database, complete LiveKit, or complete Telegram configuration enabled.

## C. Milestone scorecard

| Milestone | Status | Evidence | Remaining work |
|---|---|---|---|
| A. Foundation and design system | PARTIALLY IMPLEMENTED | Landing, modal, pre-join, room CSS and responsive overrides are in `styles.css`, `mobile.css`, and `client/main.js`. | Consolidate CSS, introduce maintainable UI modules, test accessibility/responsive behavior. |
| B. Create meeting and join meeting | IMPLEMENTED BUT NOT VERIFIED | `POST /api/meetings`, `POST /api/meetings/:id/join`, hash navigation, and form handlers exist in `lib/vynq-server.mjs:78-103` and `client/main.js:57-63,187-188`. | Automated API/browser coverage; idempotent rejoin. |
| C. Persistent meeting data and shareable links | IMPLEMENTED BUT NOT VERIFIED | Postgres `meetings` and `meeting_sessions` schema plus local JSON fallback; link format and ID normalisation are implemented. | Verify against the actual Neon database under concurrent use; define lifecycle/host departure. |
| D. Real LiveKit audio/video | IMPLEMENTED BUT NOT VERIFIED | Token endpoint at `lib/vynq-server.mjs:113-120`; browser `Room`, media publishing, and remote track attachment at `client/main.js:106-132`. | Two-device test matrix for media, reconnect, mute, camera, devices, and screen sharing. |
| E. Guest access without Telegram | IMPLEMENTED BUT NOT VERIFIED | Normal browser create/join endpoints and anonymous session tokens do not require Telegram. | Full browser journey tests, duplicate/retry handling. |
| F. Telegram bot and Mini App | BLOCKED BY CONFIGURATION | HMAC validation, Telegram endpoints, and `/start` webhook exist at `lib/vynq-server.mjs:47-55,83-96`; Production Telegram variables are absent. | Configure BotFather, bot token, webhook secret, Mini App URL, then test in Telegram. |
| G. Watch Together synchronized playback | BROKEN | Data-message and playback logic exists at `client/main.js:124-130`, but its only host launcher is inside `.room-sidebar`, which is permanently `display: none` in `mobile.css:59`. | Restore an accessible host control and test source, play, pause, seek, late join, and errors. |
| H. Screen sharing and host controls | PARTIALLY IMPLEMENTED | Host-only UI wiring occurs in `mountHostControls`; `toggleMedia('screen')` calls LiveKit. | Fix the control mapping, enforce permitted publish sources server-side, and test host/guest behavior. |
| I. Production security, deployment, reliability | PARTIALLY IMPLEMENTED | Vercel is Ready; DB/LiveKit Production variables exist; session hashes, expiry, validation, and an in-memory limiter exist. | Shared rate limiting, static security headers/CSP, lifecycle policy, tests, monitoring, and Telegram configuration. |

## D. Working features

Only the following are verified by this audit's source review or safe checks:

| Feature | Verification method |
|---|---|
| Meeting-ID formatting/normalisation | `npm test`: 3/3 existing unit tests passed. |
| JavaScript syntax | `node --check client/main.js` and `node --check lib/vynq-server.mjs` passed. |
| Production site deployment | `GET/HEAD https://vynq-virid.vercel.app` returned HTTP 200 from Vercel. Recent production deployment is `Ready`. |
| Production API handler headers | A read-only request to a nonexistent API route returned HTTP 404 with no-store, COOP, Permissions-Policy, Referrer-Policy, HSTS, and nosniff headers. |
| Session-token hashing in database path | Source uses SHA-256 token hash before inserting/querying session rows (`lib/vynq-server.mjs:41,59,71`). |
| Waiting-room authorization boundary in source | Token endpoint refuses non-approved sessions (`lib/vynq-server.mjs:115`). |
| Local and production configuration state | Local config booleans show DB/LiveKit/Telegram disabled; Vercel variable listing confirms Production DB/LiveKit variables and absent Telegram variables. |

These are **not** verified end-to-end by this audit: creation/join persistence, host admission, two-person media, screen share, device switching, refresh reconnection, Telegram flow, and Watch Together.

## E. Broken, incomplete, or mocked features

- **Watch Together is inaccessible.** The implementation exists, but the only UI that opens its chooser is inside a permanently hidden sidebar. There is no visible meeting control for it.
- **Chat is a disabled visual control only.** There is no chat transport, API, persistence, or message UI.
- **Screen sharing is partially wired but visually mapped to the Chat icon/control.** The actual Share control remains disabled.
- **Participant state is not real-time presence.** The UI poll reads durable session rows every three seconds. It is not a reliable representation of connected LiveKit participants.
- **Host departure has no policy.** Removing the host session does not end the room, transfer ownership, or clean guests.
- **Telegram is not operational.** Production secrets/configuration are absent, and the web client lacks Telegram-native UX work.
- **Recording, file sharing, and meeting chat are missing.** No backend, storage, consent, or UI implementation exists.
- **The local JSON fallback is unsuitable for Vercel or multi-instance use.** It is a single-process development fallback only.

## F. Bug register

| ID | Severity | Description | Affected files | Evidence | Recommended resolution |
|---|---|---|---|---|---|
| B-01 | High | Watch Together cannot be initiated from the product UI. | `client/main.js:125,129`; `mobile.css:59` | Host button is rendered inside `.watch-card`; `.room-sidebar { display: none; }`. | Add an accessible host control/modal, then browser-test synchronized playback. |
| B-02 | High | Presence can show people as present after a tab/browser closes; those stale sessions are re-added to tiles by polling. | `client/main.js:94,96,131,183-186`; `lib/vynq-server.mjs:108-111` | Sessions are durable until explicit leave/expiry. Refresh was preserved by removing page-exit leave behavior; polling re-adds all approved DB sessions. | Add server heartbeat/last-seen, reconnect grace period, and connection-aware presence; do not equate session with active attendee. |
| B-03 | High | Rejoin/retry creates a new guest session and new admission request each time. | `lib/vynq-server.mjs:98-103`; `client/main.js:187` | Every normal join performs `dbCreateSession`/pushes a session; no reuse key or idempotency. | Reuse the session in the same browser, or add a safe rejoin credential/identity strategy and expiration. |
| B-04 | High | Host screen sharing is wired onto the Chat control, while the Share control remains disabled. | `client/main.js:68,95` | Control order is Mic, Camera, People, Devices, Chat, Share; host setup enables `controls[4]` and labels it Screen. | Target controls by explicit data attribute, use the screen/share icon, and add automated DOM tests. |
| B-05 | High | UI-only host screen-share restriction is not enforced by LiveKit grant. | `lib/vynq-server.mjs:118-120` | All approved participants receive `canPublish: true`; guest can publish media through LiveKit APIs outside this UI. | Restrict publish sources/permissions if the product requires host-only screen sharing, or explicitly allow guest sharing. |
| B-06 | Medium | Rate limiting can be bypassed by varying query strings and is not shared across Vercel instances. | `lib/vynq-server.mjs:19,26-27,77` | Route handling uses `pathname`, but limiter key uses raw `req.url`; map lives in one process. | Key on canonical method/path/client identity and move enforcement to Vercel Firewall/Upstash or equivalent shared limiter. |
| B-07 | Medium | Static production pages do not receive the custom security headers; no CSP is configured. | `vercel.json`; production root headers | Root returned HSTS but not the API handler's COOP, Permissions-Policy, Referrer-Policy, or nosniff headers. | Configure Vercel static headers and a tested Content-Security-Policy. |
| B-08 | Medium | Host leaving has undefined room ownership and guest cleanup behavior. | `lib/vynq-server.mjs:108`; `client/main.js:185` | Leave only deletes the current session; no host transfer/end-room logic. | Decide policy: end the room for all, or transfer host atomically; implement and test. |
| B-09 | Medium | Documentation materially contradicts current code. | `README.md`; `AUDIT.md`; `PRODUCT_DIRECTION.md` | README calls live media/screen share/Telegram/Watch Together unconnected, although code exists; earlier audit says latest deployment was not live, while Vercel is Ready. | Replace stale phase notes with a capability matrix tied to tested evidence. |
| B-10 | Medium | Automation coverage is far too narrow for meeting lifecycle code. | `test/meeting-id.test.js`; `package.json` | Only 3 unit tests cover ID utility; no server/API/browser/media tests. | Add API integration tests and browser tests before more features. |
| B-11 | Low | Participant count can remain stale after remote removal/poll removal. | `client/main.js:94,96,100-101,131` | `updateStageCount()` runs only on tile add, not on all removal paths. | Centralize tile add/remove and recompute count. |
| B-12 | Low | Obsolete/dead build and dependency artifacts increase confusion. | `scripts/build.mjs`; `lib/vynq-server.mjs:6`; `README.md` | `npm run build` uses Vite, not `scripts/build.mjs`; script does not copy `mobile.css`; `RoomServiceClient` is imported but unused. | Remove or repair unused script/import and align README. |

## G. Architecture assessment

The basic architecture is suitable for a **small VYNQ MVP**, not yet for reliable production meetings:

```text
Browser hash SPA
  ├─ server-issued VYNQ session token in sessionStorage
  ├─ Vercel catch-all API / local Node HTTP server
  ├─ Neon: meeting and session rows
  └─ LiveKit: actual media and data messages
```

Good foundations include server-side token issuance, hash-only storage of session tokens, room-scoped LiveKit JWTs, database persistence in production, and a shared local/Vercel request handler.

The architectural correction needed is focused, not a full rewrite: make connection state a first-class server model; use a heartbeat/reconnect window; decide host-room ownership; make all permissions server-enforced; and split the 40 KB single browser file into testable modules. A partial rebuild of the meeting lifecycle/presence layer is justified; a full frontend/backend restart is not.

## H. UI/UX assessment

The visual direction is coherent—dark meeting room, light pre-join, lime accent—but its behavior is not consistently product-grade.

Five highest-impact UX problems:

1. **Watch Together is invisible.** The product promise is present in marketing copy but impossible to start in the room.
2. **Screen sharing is mislabeled/mis-iconed.** A host must use a Chat-looking button that changes label to Screen, while a Share button remains disabled.
3. **Participant presence can lie.** A durable DB session is displayed as an attendee even after a real connection has ended.
4. **Room controls rely on positional JavaScript indices.** This directly caused the screen-share mapping issue and makes future UI changes risky.
5. **Accessibility remains basic.** Dialogs lack focus management; disabled controls offer little explanation; the hidden sidebar contains functional controls; focus/error/loading states are not systematically covered.

The grid/focus/pin/full-screen work is implemented in the UI, but it requires real multi-participant responsive testing. The CSS has overlapping legacy and override rules, increasing regression risk.

## I. Test and build results

| Command/check | Result |
|---|---|
| `npm test` | Passed: 3 tests, all only for `client/meeting-id.js`. |
| `node --check client/main.js` | Passed. |
| `node --check lib/vynq-server.mjs` | Passed. |
| Local non-secret environment inventory | `database: false`, `livekit: false`, `telegram: false`, max participants defaults. |
| `vercel env ls production` | Production DB and LiveKit variables present and secret; Telegram variables absent. |
| `vercel ls` | Latest listed deployment Ready in Production. |
| Production root read-only HTTP check | HTTP 200 from Vercel. |
| Production nonexistent API read-only check | HTTP 404 with API security headers. |
| `npm run build` | **Not run.** It overwrites `dist/`; the audit instruction prohibited overwriting existing build artifacts. |
| Browser/media test | **Not run.** No existing browser automation was available, and authentic media testing needs real devices/sessions. |

## J. Security and operating cost assessment

### Security

- No `.env`, `.vynq-data`, `.vercel`, `node_modules`, or `dist` content is tracked by Git. The secret-pattern scan returned no tracked secret-bearing file.
- Meeting-session tokens are high-entropy and stored as SHA-256 hashes in the PostgreSQL path. This is good.
- There is no broad user authentication; access is bearer-session based. This is acceptable for short-lived invite meetings only if lifecycle and abuse controls are completed.
- Guest admission protects LiveKit token issuance, but screen-share authority is UI-only, not grant-enforced.
- The in-process rate limiter is not production-grade on serverless infrastructure and can be bypassed with URL query variation.
- API responses carry useful security headers; static responses do not carry the same policy, and no CSP is configured.
- Telegram validation logic is present but inactive until secrets/webhook are configured and tested.

### Cost

- Current recurring services are Vercel, Neon, and LiveKit Cloud. This is a reasonable testing stack but not the stated lowest-recurring-cost endpoint.
- No unnecessary paid service was found in code. The primary ongoing cost exposure is managed LiveKit usage as call volume grows.
- A self-hosted LiveKit deployment could reduce media cost later, but should not be introduced before the core lifecycle is stable. It adds operational burden, TURN/STUN, observability, and scaling responsibility.

## K. Recommended recovery plan

### 1. Critical security or data-loss problems

1. **Define and implement active-presence lifecycle.**
   - Files: `lib/vynq-server.mjs`, `client/main.js`, new API tests.
   - Work: heartbeat, last-seen, reconnect grace window, deterministic session expiry, and disconnect handling.
   - Verify: close, refresh, network loss, and reconnect from two browsers; assert tiles and People list converge correctly.

2. **Enforce host screen-share policy at the media authorization layer.**
   - Files: `lib/vynq-server.mjs`.
   - Work: restrict guest publish sources or change the product policy to allow guest sharing.
   - Verify: attempt screen sharing as host and guest using the real client and LiveKit API-level tests.

### 2. Build failures and crashes

3. **Repair documentation/build-path drift.**
   - Files: `README.md`, `AUDIT.md`, `scripts/build.mjs`, `package.json`.
   - Work: state the current Vite build path, remove/repair dead script, document tested versus untested features.
   - Verify: clean checkout instructions work exactly; no conflicting build scripts remain.

### 3. Core architectural defects

4. **Make join/rejoin idempotent and decide host departure policy.**
   - Files: `lib/vynq-server.mjs`, `client/main.js`, tests.
   - Verify: repeated Join/refresh does not create duplicate waiting requests; host leave has documented, tested behavior.

5. **Add API and browser test layers.**
   - Files: new tests, `package.json`.
   - Verify: test create, join, admit, remove, leave, capacity, token denial before admission, and UI controls automatically.

### 4. Broken existing features

6. **Fix the screen-control mapping and participant count lifecycle.**
   - Files: `client/main.js`, `mobile.css`.
   - Verify: Share icon/control activates only for host; count falls on all leave/remove paths.

7. **Restore an accessible Watch Together entry point.**
   - Files: `client/main.js`, `mobile.css`.
   - Verify: host can open chooser without developer tools; guests see synchronized direct-video playback.

### 5. Missing functionality required for the first working meeting

8. **Run and record a real two-device call matrix.**
   - Services: Vercel Production, Neon, LiveKit.
   - Verify: create, guest waiting/admission, preview permission, video/audio both directions, mute, camera, devices, screen share, refresh, reconnect, leave.

### 6. Telegram integration

9. **Configure and test Telegram only after core calls pass.**
   - Files/services: `lib/vynq-server.mjs`, Vercel Production variables, BotFather/webhook.
   - Verify: `/start` opens Mini App, verified identity creates/joins, ordinary web guest still works.

### 7. Watch Together

10. **Harden the direct-video MVP after its launcher is restored.**
   - Files: `client/main.js` and browser tests.
   - Verify: host play/pause/seek, late guest join, invalid URL, unsupported/cross-origin playback failure, host departure.

### 8. Additional features and polish

11. **Defer recording, files, chat, and large-group optimization.**
   - Begin only after the two-person reliability checklist passes repeatedly.

## L. Final verdict

- **Are we following the original VYNQ vision?** Yes in direction: browser guests, Telegram-first potential, LiveKit media, waiting room, and Watch Together were all started. No in execution completeness: Telegram and Watch Together are not usable end-to-end, and core presence reliability is unresolved.
- **What percentage is genuinely implemented and verified?** Approximately **25% verified, 50% implemented in some form**. The 25% includes safe checks, deployed availability, token/session source boundaries, and ID behavior—not two-person calling. The higher implementation estimate counts code paths that exist but lack end-to-end proof.
- **Is repair worthwhile?** Yes. A full rebuild is not justified. Repair the lifecycle/presence layer, permission model, control mapping, and test coverage before adding capabilities.
- **Single best next action:** Build and test a connection-aware participant lifecycle (heartbeat + reconnect grace period) before any more product features.
- **What to avoid now:** Do not build recordings, Telegram archival, file sharing, chat, calendar features, or larger group-call features until active presence, rejoin behavior, screen-share authority, and a real two-device test matrix are reliable.
