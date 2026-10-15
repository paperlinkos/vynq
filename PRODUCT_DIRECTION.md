# VYNQ Product Direction

## What we are building

VYNQ is not a smaller Zoom clone. It is a **Telegram-first instant meeting room**:

1. A host taps **Start a room** from Telegram or the web.
2. VYNQ creates one shareable room link immediately.
3. The host sends it into a Telegram chat.
4. A guest taps the link, checks camera and microphone, and joins or asks to join.
5. The host sees a clear request and admits the guest.
6. Both people are immediately in a reliable video/audio room, with the option to watch something together.

The product promise is: **one link, one clear decision, one dependable room.**

## What to learn from Zoom and Google Meet

VYNQ should borrow their reliable interaction patterns, not their complexity.

| Moment | Zoom / Google Meet pattern | VYNQ decision |
| --- | --- | --- |
| Open an invite | Enter a predictable join flow | Open the room directly; never make a guest wonder whether they joined. |
| Before entry | Preview camera/audio and choose devices | Keep VYNQ's pre-join screen, add clear permission state, mic test, and speaker selection. |
| Request access | Guest sees an explicit waiting state; host sees an admission request | Make waiting a first-class two-sided state with admit, decline, and admit-all. |
| Enter room | Participant is visibly connected; join/leave is signalled | Show connecting, connected, and left states clearly and in real time. |
| During a call | Obvious mute, camera, devices, people, share, and leave controls | Keep the surface small: Mic, Camera, People, Share, Leave; tuck secondary options under Settings. |

Official references used for this comparison:

- Zoom: [Joining a Zoom meeting](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060732) and [Using waiting room during a meeting](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0063329).
- Google Meet: [Join a meeting](https://support.google.com/meet/answer/9303069?hl=en&co=GENIE.Platform%3DDesktop) and [Connect your video & audio](https://support.google.com/meet/answer/10409699?hl=en).

## Current VYNQ: confirmed capabilities

- Creates and persists meetings in Neon Postgres.
- Creates shareable meeting links.
- Supports guest names, a waiting room, host admission, removal, and participant presence.
- Uses LiveKit for room connection, local microphone/camera publication, video tracks, and screen sharing.
- Provides a pre-join preview with microphone and camera pickers.
- Has a browser fallback and a Telegram Mini App/Webhook path in the server.
- Has host-controlled Watch Together for direct video-file URLs.

## Current VYNQ: important gaps

### Must fix before calling the core call reliable

1. **Remote audio is not mounted.** `attachTrack` returns for any non-video track, so incoming audio tracks are not attached to an `<audio>` element. Video may render while callers cannot hear one another.
2. **No in-call device switching.** Device selectors exist only before entry. There is no speaker picker or audio test.
3. **Presence is session-based, not connection-based.** A person may display as “Joined” before media has connected, and the product does not clearly distinguish connected, reconnecting, or left in the participant list.
4. **Admission is polling-based.** It works, but the three-second polling flow makes requests and admission feel slower and less certain than Zoom/Meet.
5. **Guest identity is not idempotent.** Each normal join request creates a new guest session. Refresh/rejoin behavior needs deliberate handling so the host does not see confusing duplicates.

### Telegram is structurally present, but not a finished launch path

- Server-side Telegram `initData` verification is implemented.
- The `/start` webhook can send an **Open VYNQ** Mini App button.
- Telegram credentials and BotFather configuration are still pending.
- The browser client needs a Telegram-specific quick-start UX: use the Telegram name automatically, create/share with one obvious action, and use Telegram's native back/close controls where appropriate.

### Deliberately defer

- Calendar scheduling, recordings, phone dial-in, large-event moderation, virtual backgrounds, and full Zoom-style chat.
- They are not required to prove the VYNQ promise and would slow down the reliable-room foundation.

## Build order from here

### P0 — Make a two-person call dependable

1. Attach and manage remote audio tracks; verify two people can hear and see each other.
2. Add clear call lifecycle states: preparing, requesting access, admitted, connecting, connected, reconnecting, left.
3. Add a compact in-call device/settings panel: microphone, speaker, camera, and an audio level/test.
4. Make admission and leave events reliable and visually immediate; prevent duplicate guest requests.
5. Test the entire flow on two real devices and record the result.

### P1 — Make it Telegram-first

1. Configure the bot, Mini App, webhook, and production URL.
2. Replace unnecessary name/link steps inside Telegram with Telegram identity and a one-tap create/share action.
3. Add a Telegram-native meeting card/message that opens the correct room.

### P2 — Make VYNQ distinctive

1. Finish Watch Together around simple, permitted content sources.
2. Add recording only after the core call is proven reliable. Recordings should have an unmistakable in-room indicator, host control, and participant notice/consent.
3. When a Telegram-connected host records, deliver a **Recording ready** message to the chosen Telegram chat. Store the canonical recording in VYNQ-controlled object storage and send the file to Telegram only when it fits Telegram's current Bot API limits; otherwise send a secure VYNQ playback/download link.
4. Add lightweight reactions and room chat only if real testing shows they help.
5. Improve host control and room polish after the core call passes repeated two-device tests.

## Capability decisions

### Web and Telegram Mini App

VYNQ is intentionally both:

- **Web:** anyone can open a meeting link in a modern browser without Telegram.
- **Telegram Mini App:** a Telegram user can launch VYNQ inside Telegram, use their verified Telegram identity, create a room, and share it into a chat quickly.

The same room must work for both kinds of guest. Telegram makes creation and sharing faster; it must not exclude people who only have a browser.

### Group calls

VYNQ's LiveKit architecture can support more than two people. Before promoting it as a group-call product, we must add and test a responsive participant grid, active-speaker behavior, scalable presence, host moderation, and real device/network limits. The near-term proof point remains a reliable two-person call.

### Screen sharing

Screen sharing is implemented for the host through the browser/LiveKit path. Guest screen sharing is a product-control decision to add after core media testing; the host should be able to allow or prevent it.

### File sharing

File sharing is not implemented. It needs object storage, access control, expiration, size/type limits, and a clear in-room experience. It is useful, but less important than dependable audio/video. Telegram-connected rooms may later receive files in their Telegram chat, while web-only rooms need VYNQ-managed links.

### Recording delivery to Telegram

This is a good differentiator: after a host records a meeting, VYNQ can post a clean **Recording ready** card to Telegram. For a Telegram-first, lightweight model, VYNQ can use temporary processing storage only: record, encode or split the file into Telegram-safe parts, upload them to a private Telegram archive chat, verify delivery, then delete the temporary copy. Telegram's ordinary Bot API has upload and retrieval constraints, and those limits can change; recordings can also exceed them. Therefore the archive workflow must support parts and a secure fallback link when required. Never record silently; show a clear recording state to every attendee.

## Product rule for future work

Every change must make one of these faster or clearer: **create, share, request, admit, connect, talk, leave.**
If it does not, it is not a core VYNQ priority yet.
