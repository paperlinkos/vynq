# VYNQ Build Audit

Audited: 2026-10-15

## Overall assessment

**Product direction: strong. Release readiness: not yet ready for public use.**

VYNQ has a coherent Telegram-first meeting model and the essential UI flow is substantially in place. The remaining risk is not the landing page or database flow; it is proving real multi-device media behavior and publishing the newest verified build.

## Verified in source and local checks

- `node --check`, `npm test`, and `npm run build` pass.
- Meetings can be created, joined, placed in a waiting room, admitted, removed, and left.
- The host is the only participant allowed to admit/remove guests or start screen share.
- A guest cannot obtain a LiveKit token until admitted.
- Browser pre-join requests camera/microphone access automatically and provides device choice before entry.
- The in-call Devices panel supports microphone, camera, and speaker changes, speaker testing, and microphone level feedback where the browser supports those APIs.
- Remote audio tracks are attached to audio elements; remote video tracks are attached to participant tiles.
- Meeting links, session-token hashing, rate limiting, security headers, meeting expiry, and a configurable 25-person room cap are implemented.

## Critical release blockers

### 1. The newest code is not deployed to Vercel

The newest commits are pushed to GitHub, but Vercel production has not deployed them because the local Vercel CLI authorization needs renewal. The public URL therefore cannot yet be used to validate the remote-audio, automatic permission, participant-state, and device-control changes.

### 2. Real two-device LiveKit testing is incomplete

The source is wired for audio/video, but this still needs a real host and guest on separate browser/device sessions to verify:

- both sides can hear each other;
- both sides can see each other;
- mute, camera, device switching, screen share, reconnect, and leaving behave correctly.

## Important follow-up gaps

| Area | Current state | Needed next |
| --- | --- | --- |
| Local environment | No database, LiveKit, or Telegram variables are configured locally. | Use deployed configuration for cross-device testing, or add non-production test credentials locally. |
| Automated tests | Only three meeting-ID unit tests exist. | Add API tests for create/join/admit/remove/leave/capacity and browser-level flow tests. |
| Participant identity | Normal link joins create a new guest session. | Make retry/rejoin behavior idempotent to avoid duplicate admission requests. |
| Host departure | A host can leave; there is no explicit room-end or host-transfer policy. | Decide and implement “end for everyone” or “transfer host.” |
| Telegram | Validation and webhook code exist, but Telegram is not configured. | Configure bot, Mini App, webhook, and Telegram-first create/share flow. |
| Recording and files | Not implemented. | Add recording pipeline, Telegram archive delivery, and controlled file storage only after core calls pass real-device testing. |

## Deliberately out of scope today

- Recording to Telegram archive.
- File sharing.
- Guest screen sharing.
- Large-scale group-call UX beyond the initial 25-person cap.
- Chat, scheduling, calendars, virtual backgrounds, and dial-in.

## Recommended next sequence

1. Renew Vercel deployment authorization and deploy the latest GitHub commit.
2. Perform the two-device media checklist above.
3. Fix every observed media-flow issue before adding recording or file sharing.
4. Configure Telegram and build the one-tap Telegram launch/share experience.
