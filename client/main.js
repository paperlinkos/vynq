import { Room, RoomEvent, Track } from 'livekit-client';
import { normaliseMeetingId } from './meeting-id.js';
import { chooseGridLayout, nextLayout } from './meeting-layout.js';
import { meetingInviteUrl, telegramShareUrl } from './invitations.js';

const app = document.querySelector('#app');
let liveRoom;
let hostWaitTimer;
let meetingSubmissionPending = false;
let knownWaitingGuestIds = new Set();
let previewStream;
let prejoinOptions = { audio: true, video: true, audioId: '', videoId: '' };
let micMeterFrame;
let micMeterContext;
let watchPollTimer;
let watchState = { version: 0, source: '', playing: false, position: 0, updatedAt: 0 };
let watchPublishQueue = Promise.resolve();
let applyingWatchState = false;
let roomLayout = 'grid';
let pinnedTileId = 'local-tile';
let activeSpeakerId = 'local-tile';
let stageResizeObserver;
let chatPollTimer;
let chatRecipientId = null;
let renderedMessageIds = new Set();
let presenceTimer;
let presenceState = 'connecting';
let leavingMeeting = false;
const icons = {
  video: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 10.5 20 7v10l-5-3.5V18H4V6h11v4.5Z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm-6-3h2a4 4 0 0 0 8 0h2a6 6 0 0 1-5 5.91V21h-2v-3.09A6 6 0 0 1 6 12Z"/></svg>',
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 10.5 20 7v10l-5-3.5V18H4V6h11v4.5Z"/></svg>',
  users: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 11a3 3 0 1 0-2.83-4H11a3 3 0 1 0-2.17 4.83A5 5 0 0 0 5 16.67V18h9v-1.33a5 5 0 0 0-3.25-4.67A5 5 0 0 0 12 10.63 5 5 0 0 0 15.25 12H16Zm2 1.25A4 4 0 0 1 21 16v2h-5v-1.33a6.9 6.9 0 0 0-1.37-4.14A4.99 4.99 0 0 1 18 12.25Z"/></svg>',
  chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v10H9l-4 4V5Zm2 2v7.17L8.17 13H17V7H7Z"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3v9.17l2.59-2.58L17 11l-5 5-5-5 1.41-1.41L11 12.17V3h2ZM5 19v-4h2v2h10v-2h2v4H5Z"/></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm0-12v2m0 13v2m8.5-8.5h-2m-13 0h-2m14.51-6.01-1.42 1.42M7.41 16.59l-1.42 1.42m0-12.02 1.42 1.42m9.18 9.18 1.42 1.42"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 9 6-9 6V6Z"/></svg>',
  grid: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg>',
  speaker: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6L8 10H4Zm12.5.5a3 3 0 0 1 0 3m2.5-6a7 7 0 0 1 0 9"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 4 5 5-3 1-4 4-1 4-2-2-4 4-1-1 4-4-2-2 4-1 4-4Z"/></svg>',
  fullscreen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4H4v4m12-4h4v4M8 20H4v-4m16 0v4h-4"/></svg>'
};

function wordmark() { return '<a class="wordmark" href="#/" aria-label="VYNQ home"><span class="brand-mark">V</span>VYNQ</a>'; }
function button(label, className = 'button', attrs = '') { return `<button class="${className}" ${attrs}>${label}</button>`; }

function home() {
  app.innerHTML = `
    <section class="hero">
      <nav class="nav">${wordmark()}<span class="nav-note">Made for moments together</span></nav>
      <div class="hero-content">
        <div class="eyebrow"><span></span> Video meetings, reimagined</div>
        <h1>Connect beyond<br>the call.</h1>
        <p>Meet face to face. Watch together. Share the moment.</p>
        <div class="hero-actions">
          ${button('Create a meeting <span class="button-icon">' + icons.arrow + '</span>', 'button button-primary', 'data-action="create"')}
          ${button('Join a meeting', 'button button-secondary', 'data-action="join"')}
        </div>
      </div>
      <div class="hero-visual" aria-hidden="true">
        <div class="visual-orbit orbit-one"></div><div class="visual-orbit orbit-two"></div>
        <div class="meeting-preview"><div class="preview-head"><span></span><span></span><span></span><b>Live in VYNQ</b></div><div class="preview-body"><div class="preview-main"><i></i><small>Watching together</small></div><div class="preview-tiles"><div>AM</div><div class="tile-dark">JD</div><div>SK</div></div></div></div>
      </div>
      <footer>VYNQ <span>•</span> Simple, secure conversations</footer>
    </section>`;
}

function modal(kind) {
  const isCreate = kind === 'create';
  const title = isCreate ? 'Start a meeting' : 'Join a meeting';
  const body = isCreate
    ? '<p>Give your meeting a name. You can invite people once you’re inside.</p><label>Meeting name<input id="meeting-name" maxlength="80" placeholder="Friday catch-up" autofocus></label><label>Your name<input id="display-name" maxlength="50" placeholder="Your name"></label><p id="form-error" class="form-error" role="alert"></p>'
    : '<p>Enter the meeting code you received to continue.</p><label>Meeting code<input id="meeting-code" autocomplete="off" placeholder="e.g. VYNQ-AB12-CD34-EF56" autofocus></label><label>Your name<input id="display-name" maxlength="50" placeholder="Your name"></label><p id="form-error" class="form-error" role="alert"></p>';
  app.insertAdjacentHTML('beforeend', `<div class="modal-backdrop" data-action="dismiss"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><button class="icon-button modal-close" data-action="dismiss" aria-label="Close">${icons.close}</button><div class="modal-symbol">${isCreate ? icons.video : icons.arrow}</div><h2 id="modal-title">${title}</h2>${body}${button(isCreate ? 'Create meeting' : 'Join meeting', 'button button-primary button-full', 'data-action="submit-' + kind + '"')}</section></div>`);
}

function room(id, name = 'You', title = 'Meeting') {
  roomLayout = 'grid'; pinnedTileId = 'local-tile';
  watchState = { version: 0, source: '', playing: false, position: 0, updatedAt: 0 };
  const inviteControls = isHost() ? '<div class="invite-actions"><button class="share-link" data-action="copy">Copy invite link</button><button class="share-link" data-action="telegram-share">Share via Telegram</button></div>' : '';
  const inviteEmptyState = isHost() ? '<button class="button button-secondary" data-action="copy">Copy invite link</button><button class="text-button" data-action="telegram-share">Share via Telegram</button>' : '<p>Waiting for the host to invite others.</p>';
  app.innerHTML = `<section class="room"><div id="remote-audio" aria-hidden="true"></div><header class="room-header">${wordmark()}<div class="room-title"><span class="live-dot"></span><span>${escapeHtml(title)}</span><b>${id}</b></div><span class="connection-state" id="connection-state">Connecting media…</span>${inviteControls}</header><main class="room-stage"><div class="stage-main"><div class="stage-bar"><span class="stage-count" id="stage-count">1 participant</span><div class="layout-switcher" aria-label="Meeting layout"><button class="layout-button active" data-action="layout-grid" aria-label="Grid view" title="Grid view">${icons.grid}</button><button class="layout-button" data-action="layout-speaker" aria-label="Speaker view" title="Speaker view">${icons.speaker}</button><button class="layout-button" data-action="layout-focus" aria-label="Focus view" title="Focus view">${icons.pin}</button><button class="layout-button" data-action="fullscreen" aria-label="Full screen" title="Full screen">${icons.fullscreen}</button></div></div><section class="video-grid room-layout-grid" id="video-grid"><article class="video-tile self-tile" id="local-tile"><div class="avatar">${name.slice(0, 2).toUpperCase()}</div><button class="tile-pin" data-action="pin-tile" data-tile="local-tile" aria-label="Pin ${escapeHtml(name)}" title="Pin participant">${icons.pin}</button><span class="tile-name">${escapeHtml(name)} <i>You</i></span><span class="tile-state" id="local-state">Camera off</span></article><article class="empty-tile" id="empty-state"><div class="empty-icon">${icons.users}</div><h2>You're the first one here</h2><p>Share the link to invite others to this meeting.</p>${inviteEmptyState}</article></section></div><aside class="room-sidebar" id="room-sidebar"><div class="sidebar-head"><p class="sidebar-label">Meeting</p><button class="icon-button" data-action="close-sidebar" aria-label="Close panel">${icons.close}</button></div><section class="participant-panel" id="participant-panel" hidden></section><section class="watch-panel" id="watch-panel"><p class="sidebar-label">Watch together</p><div class="watch-card"><div class="watch-play">${icons.play}</div><h3>Shared viewing</h3><p>Choose a supported video when everyone has joined.</p></div></section></aside></main><footer class="controls"><div class="control-dock"><div class="control-group"><button class="control" data-control="mic">${icons.mic}<span>Mic</span></button><button class="control" data-control="camera">${icons.camera}<span>Camera</span></button></div><div class="control-group"><button class="control" data-action="participants">${icons.users}<span>People</span></button><button class="control" data-action="devices">${icons.settings}<span>Devices</span></button><button class="control" data-action="watch-toggle">${icons.play}<span>Watch</span></button><button class="control" disabled title="Chat arrives in Phase 3">${icons.chat}<span>Chat soon</span></button><button class="control" data-control="screen" disabled>${icons.share}<span>Share</span></button></div><button class="leave" data-action="leave">Leave</button></div></footer></section>`;
  const chatButton = document.querySelector('.control[title="Chat arrives in Phase 3"]');
  if (chatButton) { chatButton.disabled = false; chatButton.removeAttribute('title'); chatButton.dataset.action = 'chat-toggle'; chatButton.querySelector('span').textContent = 'Chat'; }
  document.querySelector('#room-sidebar')?.insertAdjacentHTML('beforeend', '<section class="chat-panel" id="chat-panel" hidden></section>');
  observeStageLayout();
  clearInterval(watchPollTimer); watchPollTimer = setInterval(refreshWatchState, 2500); refreshWatchState();
}

function prejoin(meeting, participant) {
  leavingMeeting = false;
  startPresence('connecting');
  prejoinOptions = { audio: true, video: true, audioId: '', videoId: '' };
  app.innerHTML = `<section class="prejoin"><header class="prejoin-header">${wordmark()}<span>Ready to join</span></header><main class="prejoin-main"><section class="prejoin-preview"><video id="preview-video" autoplay muted playsinline></video><div class="preview-empty" id="preview-empty">Requesting camera preview…</div></section><section class="prejoin-panel"><p class="eyebrow"><span></span> ${escapeHtml(meeting.title)}</p><h1>Check your setup</h1><p>Allow VYNQ to use your camera and microphone, then choose how you want to enter. They stay private until you join.</p><div class="prejoin-actions"><button class="button button-secondary" data-action="preview-enable">Retry camera & microphone</button><button class="button button-secondary" data-action="preview-audio">Mic on</button><button class="button button-secondary" data-action="preview-video">Camera on</button></div><label>Microphone<select id="audio-device" data-action="audio-device"><option value="">Default microphone</option></select></label><label>Camera<select id="video-device" data-action="video-device"><option value="">Default camera</option></select></label><p id="prejoin-error" class="form-error" role="alert"></p><button class="button button-primary button-full" data-action="enter-meeting">Enter meeting</button></section></main></section>`;
  populatePrejoinDevices();
  startPreview();
}

function stopPreview() { previewStream?.getTracks().forEach(track => track.stop()); previewStream = undefined; }
function updatePrejoinControls() { const audio = document.querySelector('[data-action="preview-audio"]'); const video = document.querySelector('[data-action="preview-video"]'); if (audio) audio.textContent = prejoinOptions.audio ? 'Mic on' : 'Mic off'; if (video) video.textContent = prejoinOptions.video ? 'Camera on' : 'Camera off'; const empty = document.querySelector('#preview-empty'); if (empty) empty.hidden = prejoinOptions.video && Boolean(previewStream?.getVideoTracks().length); }
async function populatePrejoinDevices() { try { const devices = await navigator.mediaDevices.enumerateDevices(); const fill = (selector, kind, selected) => { const select = document.querySelector(selector); if (!select) return; select.innerHTML = `<option value="">Default ${kind === 'audioinput' ? 'microphone' : 'camera'}</option>` + devices.filter(device => device.kind === kind).map((device, index) => `<option value="${escapeHtml(device.deviceId)}" ${device.deviceId === selected ? 'selected' : ''}>${escapeHtml(device.label || `${kind === 'audioinput' ? 'Microphone' : 'Camera'} ${index + 1}`)}</option>`).join(''); }; fill('#audio-device', 'audioinput', prejoinOptions.audioId); fill('#video-device', 'videoinput', prejoinOptions.videoId); } catch { /* device labels appear after permission is granted */ } }
async function startPreview() { stopPreview(); const error = document.querySelector('#prejoin-error'); if (!prejoinOptions.audio && !prejoinOptions.video) return updatePrejoinControls(); try { previewStream = await navigator.mediaDevices.getUserMedia({ audio: prejoinOptions.audio ? { deviceId: prejoinOptions.audioId || undefined, echoCancellation: true, noiseSuppression: true } : false, video: prejoinOptions.video ? { deviceId: prejoinOptions.videoId || undefined } : false }); const video = document.querySelector('#preview-video'); if (video) video.srcObject = previewStream; await populatePrejoinDevices(); updatePrejoinControls(); } catch (err) { if (error) error.textContent = `Could not access your device: ${err.message}. You can still enter with it turned off.`; updatePrejoinControls(); } }
function togglePreview(kind) { prejoinOptions[kind] = !prejoinOptions[kind]; startPreview(); }
async function enterMeeting() { const match = location.hash.match(/^#\/room\/(VYNQ-[A-Z0-9-]+)$/); if (!match) return; const session = storedSession(match[1]); try { const value = await request(`/api/meetings/${match[1]}`, { headers: { 'X-VYNQ-Session': session.token } }); stopPreview(); room(value.meeting.id, value.participant.name, value.meeting.title); if (value.participant.role === 'host') mountHostControls(); else mountGuestPresence(); connectMedia(match[1], prejoinOptions); } catch (error) { const area = document.querySelector('#prejoin-error'); if (area) area.textContent = error.message; } }

function escapeHtml(value) { const node = document.createElement('span'); node.textContent = value; return node.innerHTML; }
function storedSession(id) { try { return JSON.parse(sessionStorage.getItem(`vynq:${id}`)); } catch { return null; } }
function saveSession(id, session) { sessionStorage.setItem(`vynq:${id}`, JSON.stringify(session)); }
async function request(path, options = {}) { const response = await fetch(path, { headers: { 'Content-Type': 'application/json', ...options.headers }, ...options }); const value = response.headers.get('content-type')?.includes('application/json') ? await response.json() : { error: 'The service returned an unexpected response. Please try again.' }; if (!response.ok) throw new Error(value.error || 'Something went wrong.'); return value; }
function activeMeeting() { const match = location.hash.match(/^#\/room\/(VYNQ-[A-Z0-9-]+)$/); const session = match && storedSession(match[1]); return match && session ? { id: match[1], session } : null; }
function stopPresence() { clearInterval(presenceTimer); presenceTimer = undefined; }
async function sendHeartbeat() {
  const active = activeMeeting(); if (!active) return;
  try { await request(`/api/meetings/${active.id}/heartbeat`, { method: 'POST', headers: { 'X-VYNQ-Session': active.session.token }, body: JSON.stringify({ presence: presenceState }) }); }
  catch (error) {
    if (/meeting has ended|meeting has expired/i.test(error.message)) { stopPresence(); liveRoom?.disconnect(); setConnection(error.message, 'warning'); }
  }
}
function startPresence(state) { if (leavingMeeting) return; presenceState = state; stopPresence(); sendHeartbeat(); presenceTimer = setInterval(sendHeartbeat, 10_000); }
function setMeetingSubmitState(pending) { const button = document.querySelector('[data-action="submit-create"], [data-action="submit-join"]'); if (!button) return; button.disabled = pending; button.textContent = pending ? 'Please wait…' : button.dataset.action === 'submit-create' ? 'Create meeting' : 'Join meeting'; }
function showFormError(message) { const area = document.querySelector('#form-error'); if (area) area.textContent = message; }
function setConnection(message, type = '') { const state = document.querySelector('#connection-state'); if (state) { state.textContent = message; state.className = `connection-state ${type}`; } }
function waitingRoom(title) { startPresence('waiting'); app.innerHTML = `<section class="hero waiting-room"><nav class="nav">${wordmark()}</nav><div class="hero-content"><div class="waiting-pulse" aria-hidden="true"></div><div class="eyebrow"><span></span> Waiting room</div><h1>You’re in the<br>waiting room.</h1><p><b>The host needs to admit you.</b> Keep this page open and we’ll bring you into ${escapeHtml(title)} automatically.</p><p class="waiting-hint">This page checks for approval every few seconds.</p></div></section>`; setTimeout(navigate, 4000); }
function showJoinRequest(person) { if (document.querySelector('.modal-backdrop')) return; app.insertAdjacentHTML('beforeend', `<div class="modal-backdrop" data-action="dismiss"><section class="modal join-request" role="dialog" aria-modal="true"><div class="modal-symbol">${icons.users}</div><h2>${escapeHtml(person.name)} wants to join</h2><p>They are waiting for your approval to enter this meeting.</p>${button('Admit to meeting', 'button button-primary button-full', `data-action="participant-admit" data-participant="${person.id}"`)}<button class="text-button request-later" data-action="dismiss">Not now</button></section></div>`); }
async function refreshHostWaiting() { if (!isHost()) return; const id = location.hash.split('/').pop(); const session = storedSession(id); if (!session) return; try { const value = await request(`/api/meetings/${id}/participants`, { headers: { 'X-VYNQ-Session': session.token } }); const waiting = value.participants.filter(person => person.role === 'guest' && person.status === 'waiting'); const approved = value.participants.filter(person => person.role === 'guest' && person.status === 'approved'); const waitingIds = new Set(waiting.map(person => person.id)); const newRequest = waiting.find(person => !knownWaitingGuestIds.has(person.id)); knownWaitingGuestIds = waitingIds; const alert = document.querySelector('#waiting-alert'); const people = document.querySelector('[data-action="participants"] span'); if (alert) alert.hidden = waiting.length === 0; if (alert) alert.textContent = `${waiting.length} waiting · Admit`; if (people) people.textContent = waiting.length ? `People (${waiting.length})` : 'People'; approved.forEach(person => { const tile = document.querySelector(`#remote-${person.id}`) || addRemoteTile({ identity: person.id, name: person.name }, presenceLabel(person)); setRemoteTileState(person.id, presenceLabel(person)); }); document.querySelectorAll('.remote-tile').forEach(tile => { if (!approved.some(person => `remote-${person.id}` === tile.id)) tile.remove(); }); updateStageCount(); if (newRequest) showJoinRequest(newRequest); } catch { /* keep the room usable if polling is unavailable */ } }
function mountHostControls() { knownWaitingGuestIds = new Set(); const people = document.querySelectorAll('.control')[2]; if (people) { people.disabled = false; people.dataset.action = 'participants'; } const screen = document.querySelector('.control[data-control="screen"]'); if (screen) { screen.disabled = false; screen.querySelector('span').textContent = 'Screen'; } document.querySelector('.room-header')?.insertAdjacentHTML('beforeend', '<button class="waiting-alert" id="waiting-alert" data-action="participants" hidden>1 waiting · Admit</button>'); clearInterval(hostWaitTimer); refreshHostWaiting(); hostWaitTimer = setInterval(refreshHostWaiting, 3000); }
async function refreshGuestPresence() { const id = location.hash.split('/').pop(); const session = storedSession(id); if (!session) return; try { const value = await request(`/api/meetings/${id}/participants`, { headers: { 'X-VYNQ-Session': session.token } }); const others = value.participants.filter(person => !person.isSelf && person.status === 'approved'); others.forEach(person => { const tile = document.querySelector(`#remote-${person.id}`) || addRemoteTile({ identity: person.id, name: person.name }, presenceLabel(person)); setRemoteTileState(person.id, presenceLabel(person)); }); document.querySelectorAll('.remote-tile').forEach(tile => { if (!others.some(person => `remote-${person.id}` === tile.id)) tile.remove(); }); updateStageCount(); } catch { /* the room remains usable while presence refreshes */ } }
function mountGuestPresence() { clearInterval(hostWaitTimer); refreshGuestPresence(); hostWaitTimer = setInterval(refreshGuestPresence, 3000); }
async function showParticipants() { const id = location.hash.split('/').pop(); const sidebar = document.querySelector('#room-sidebar'); const panel = document.querySelector('#participant-panel'); if (!sidebar || !panel) return; try { const value = await request(`/api/meetings/${id}/participants`, { headers: { 'X-VYNQ-Session': storedSession(id).token } }); const waiting = value.participants.filter(person => person.role === 'guest' && person.status === 'waiting').length; panel.hidden = false; document.querySelector('#watch-panel').hidden = true; sidebar.classList.add('is-open'); panel.innerHTML = `<p class="sidebar-label">People · ${value.participants.length}</p>${waiting && isHost() ? `<p class="waiting-summary">${waiting} waiting for approval</p>` : ''}<div class="participant-list">${value.participants.map(person => { const live = liveRoom?.remoteParticipants.get(person.id); const media = person.isSelf ? (liveRoom?.localParticipant || {}) : (live || {}); const mic = media.isMicrophoneEnabled === false ? 'Mic off' : 'Mic'; const camera = media.isCameraEnabled ? 'Camera' : 'Camera off'; return `<div class="participant-row"><span class="participant-avatar">${escapeHtml(person.name.slice(0, 2).toUpperCase())}</span><span class="participant-name">${escapeHtml(person.name)}${person.role === 'host' ? ' <i>Host</i>' : ''}<small>${presenceLabel(person)} · ${mic} · ${camera}</small></span>${isHost() && person.role === 'guest' ? `<button class="text-button approval-action" data-action="participant-${person.status === 'waiting' ? 'admit' : 'remove'}" data-participant="${person.id}">${person.status === 'waiting' ? 'Admit' : 'Remove'}</button>` : ''}</div>`; }).join('')}</div>`; } catch (error) { setConnection(error.message, 'warning'); } }
function showWatchPanel() { const sidebar = document.querySelector('#room-sidebar'); const panel = document.querySelector('#participant-panel'); const watch = document.querySelector('#watch-panel'); if (!sidebar || !watch) return; panel.hidden = true; watch.hidden = false; sidebar.classList.add('is-open'); mountWatch(); }
function closeSidebar() { clearInterval(chatPollTimer); chatPollTimer = undefined; document.querySelector('#room-sidebar')?.classList.remove('is-open'); }
function chatMeeting() { const id = location.hash.split('/').pop(); const session = storedSession(id); return session ? { id, token: session.token } : null; }
function openChat() { const sidebar = document.querySelector('#room-sidebar'); const panel = document.querySelector('#chat-panel'); if (!sidebar || !panel) return; document.querySelector('#participant-panel').hidden = true; document.querySelector('#watch-panel').hidden = true; panel.hidden = false; sidebar.classList.add('is-open'); panel.innerHTML = '<p class="sidebar-label">Chat</p><div class="chat-tabs"><button class="text-button active" data-action="chat-group">Everyone</button><button class="text-button" data-action="chat-directs">Direct</button></div><p class="chat-title" id="chat-title">Everyone</p><div class="chat-messages" id="chat-messages"><p class="chat-empty">Loading messages…</p></div><p class="chat-error" id="chat-error" role="alert"></p><form class="chat-composer" id="chat-composer"><textarea id="chat-input" maxlength="2000" placeholder="Message everyone" aria-label="Message"></textarea><button class="button button-primary" type="submit">Send</button></form>'; chatRecipientId = null; renderedMessageIds = new Set(); refreshChat(); clearInterval(chatPollTimer); chatPollTimer = setInterval(refreshChat, 2500); }
function closeChat() { clearInterval(chatPollTimer); chatPollTimer = undefined; closeSidebar(); }
function renderChat(messages) { const box = document.querySelector('#chat-messages'); if (!box) return; const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48; if (!messages.length) { box.replaceChildren(Object.assign(document.createElement('p'), { className: 'chat-empty', textContent: 'No messages yet.' })); return; } const fragment = document.createDocumentFragment(); messages.forEach(message => { const item = document.createElement('article'); item.className = `chat-message${message.isSelf ? ' self' : ''}`; item.dataset.id = message.id; const meta = document.createElement('small'); meta.textContent = `${message.sender.name} · ${new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`; const body = document.createElement('p'); body.textContent = message.body; item.append(meta, body); fragment.append(item); }); box.replaceChildren(fragment); renderedMessageIds = new Set(messages.map(message => message.id)); if (nearBottom) box.scrollTop = box.scrollHeight; }
async function refreshChat() { const active = chatMeeting(); if (!active || !document.querySelector('#chat-panel:not([hidden])')) return; try { const suffix = chatRecipientId ? `?recipient=${encodeURIComponent(chatRecipientId)}` : ''; const value = await request(`/api/meetings/${active.id}/messages${suffix}`, { headers: { 'X-VYNQ-Session': active.token } }); renderChat(value.messages); } catch (error) { const area = document.querySelector('#chat-error'); if (area) area.textContent = error.message; } }
async function sendChat() { const active = chatMeeting(); const input = document.querySelector('#chat-input'); const error = document.querySelector('#chat-error'); if (!active || !input) return; const text = input.value; if (!text.trim()) { if (error) error.textContent = 'Enter a message before sending.'; return; } const button = document.querySelector('#chat-composer button'); try { button.disabled = true; if (error) error.textContent = ''; await request(`/api/meetings/${active.id}/messages`, { method: 'POST', headers: { 'X-VYNQ-Session': active.token }, body: JSON.stringify({ text, recipientId: chatRecipientId, clientMessageId: crypto.randomUUID().replaceAll('-', '') }) }); input.value = ''; await refreshChat(); } catch (err) { if (error) error.textContent = err.message; } finally { button.disabled = false; } }
async function showDirectChats() { const active = chatMeeting(); if (!active) return; try { const value = await request(`/api/meetings/${active.id}/participants`, { headers: { 'X-VYNQ-Session': active.token } }); const panel = document.querySelector('#chat-panel'); const people = value.participants.filter(person => !person.isSelf && person.status === 'approved'); panel.querySelector('#chat-title').textContent = 'Direct messages'; const box = panel.querySelector('#chat-messages'); box.replaceChildren(...people.map(person => { const button = document.createElement('button'); button.className = 'chat-person'; button.dataset.action = 'chat-recipient'; button.dataset.recipient = person.id; button.dataset.name = person.name; button.textContent = person.name; return button; })); } catch (error) { document.querySelector('#chat-error').textContent = error.message; } }
function selectChatRecipient(id, name) { chatRecipientId = id; renderedMessageIds = new Set(); document.querySelector('#chat-title').textContent = `Direct · ${name}`; document.querySelector('#chat-input').placeholder = `Message ${name}`; refreshChat(); }
async function updateParticipant(id, action) { const meetingId = location.hash.split('/').pop(); try { await request(`/api/meetings/${meetingId}/participants/${id}/${action}`, { method: 'POST', headers: { 'X-VYNQ-Session': storedSession(meetingId).token } }); document.querySelector('.modal-backdrop')?.remove(); await refreshHostWaiting(); } catch (error) { setConnection(error.message, 'warning'); } }
function updateStageCount() { const count = document.querySelectorAll('#video-grid > .video-tile').length; const label = document.querySelector('#stage-count'); if (label) label.textContent = `${count} participant${count === 1 ? '' : 's'}`; refreshStageLayout(); }
function presenceLabel(person) { return person.presence === 'connected' ? 'Connected' : person.presence === 'reconnecting' ? 'Reconnecting…' : person.presence === 'connecting' ? 'Connecting…' : 'Waiting'; }
function addRemoteTile(participant, state = 'Joining…') { const existing = document.querySelector(`#remote-${participant.identity}`); if (existing) return existing; const tile = document.createElement('article'); tile.className = 'video-tile remote-tile'; tile.id = `remote-${participant.identity}`; tile.innerHTML = `<div class="avatar">${escapeHtml((participant.name || 'Guest').slice(0, 2).toUpperCase())}</div><button class="tile-pin" data-action="pin-tile" data-tile="remote-${participant.identity}" aria-label="Pin ${escapeHtml(participant.name || 'Guest')}" title="Pin participant">${icons.pin}</button><span class="tile-name">${escapeHtml(participant.name || 'Guest')}</span><span class="tile-state">${escapeHtml(state)}</span>`; document.querySelector('#video-grid')?.append(tile); document.querySelector('#empty-state')?.remove(); updateStageCount(); return tile; }
function refreshStageLayout() { const grid = document.querySelector('#video-grid'); if (!grid || roomLayout !== 'grid') return; const { columns } = chooseGridLayout(grid.querySelectorAll('.video-tile').length, grid.clientWidth, grid.clientHeight); grid.style.setProperty('--meeting-columns', columns); }
function observeStageLayout() { stageResizeObserver?.disconnect(); const grid = document.querySelector('#video-grid'); if (!grid || !window.ResizeObserver) return; stageResizeObserver = new ResizeObserver(refreshStageLayout); stageResizeObserver.observe(grid); refreshStageLayout(); }
function setRoomLayout(requested) { roomLayout = nextLayout(roomLayout, requested); const grid = document.querySelector('#video-grid'); if (!grid) return; grid.classList.toggle('room-layout-grid', roomLayout === 'grid'); grid.classList.toggle('room-layout-speaker', roomLayout === 'speaker'); grid.classList.toggle('room-layout-focus', roomLayout === 'focus'); const featured = roomLayout === 'speaker' ? activeSpeakerId : pinnedTileId; grid.querySelectorAll('.video-tile').forEach(tile => tile.classList.toggle('is-pinned', roomLayout !== 'grid' && tile.id === featured)); ['grid', 'speaker', 'focus'].forEach(layout => document.querySelector(`[data-action="layout-${layout}"]`)?.classList.toggle('active', roomLayout === layout)); refreshStageLayout(); }
function pinTile(id) { pinnedTileId = id; setRoomLayout('focus'); }
function setActiveSpeaker(participants = []) { const speaker = participants.find(participant => participant.isSpeaking); activeSpeakerId = speaker ? `remote-${speaker.identity}` : pinnedTileId; if (roomLayout === 'speaker') setRoomLayout('speaker'); }
async function toggleFullscreen() { const stage = document.querySelector('.room-stage'); try { if (document.fullscreenElement) await document.exitFullscreen(); else await stage?.requestFullscreen?.(); } catch { setConnection('Full screen is not available in this browser.', 'warning'); } }
function setRemoteTileState(identity, state) { document.querySelector(`#remote-${identity} .tile-state`)?.replaceChildren(document.createTextNode(state)); }
function attachTrack(track, participant, local = false) {
  if (track.kind === Track.Kind.Audio) {
    if (local) return;
    setRemoteTileState(participant.identity, 'Connected');
    const element = track.attach();
    element.autoplay = true;
    element.playsInline = true;
    element.className = 'remote-audio';
    document.querySelector('#remote-audio')?.append(element);
    return;
  }
  if (track.kind !== Track.Kind.Video) return;
  const tile = local ? document.querySelector('#local-tile') : document.querySelector(`#remote-${participant.identity}`) || addRemoteTile(participant, 'Connected');
  const element = track.attach(); element.autoplay = true; element.playsInline = true; tile.querySelectorAll('video').forEach(video => video.remove()); tile.prepend(element); tile.querySelector('.avatar')?.remove(); tile.querySelector('.tile-state').textContent = 'Camera on';
}
function detachTrack(track) { track.detach().forEach(element => element.remove()); }
function isHost() { return meetingSession()?.role === 'host'; }
function meetingSession() { const match = location.hash.match(/^#\/room\/(VYNQ-[A-Z0-9-]+)$/); return match ? storedSession(match[1]) : null; }
function validWatchSource(value) { try { const url = new URL(value); return url.protocol === 'https:' && /\.(mp4|webm|ogv)(?:$|[?#])/i.test(url.pathname + url.search); } catch { return false; } }
function mountWatch() { const card = document.querySelector('.watch-card'); if (!card) return; card.innerHTML = `<div class="watch-play">${icons.play}</div><h3>Watch together</h3><p id="watch-status">${isHost() ? 'Choose a direct HTTPS MP4, WebM, or OGV source.' : 'Waiting for the host to choose a video.'}</p>${isHost() ? '<button class="text-button" data-action="watch-open">Choose video</button>' : ''}`; }
function renderWatch(state) { const grid = document.querySelector('#video-grid'); if (!grid || !state.source) return; let stage = document.querySelector('#watch-stage'); if (!stage) { stage = document.createElement('article'); stage.id = 'watch-stage'; stage.className = 'empty-tile'; grid.prepend(stage); } stage.innerHTML = `<video id="watch-video" playsinline preload="metadata" src="${escapeHtml(state.source)}"></video><span class="tile-name">Watching together</span><span class="tile-state">${isHost() ? 'You control playback' : 'Host controls playback'}</span>`; stage.querySelector('video').addEventListener('error', () => { const status = document.querySelector('#watch-status'); if (status) status.textContent = 'This source could not be played in this browser.'; }); }
function syncWatchVideo(state) { const video = document.querySelector('#watch-video'); if (!video || video.readyState < 1) { video?.addEventListener('loadedmetadata', () => { if (watchState.version === state.version) syncWatchVideo(state); }, { once: true }); return; } const timestamp = new Date(state.updatedAt).getTime(); const elapsed = state.playing && Number.isFinite(timestamp) ? Math.max(0, (Date.now() - timestamp) / 1000) : 0; const expected = state.position + elapsed; applyingWatchState = true; if (Math.abs(video.currentTime - expected) > 0.5) video.currentTime = Math.max(0, expected); if (state.playing) video.play().catch(() => { const status = document.querySelector('#watch-status'); if (status) status.textContent = 'Tap play to allow synchronized playback.'; }); else video.pause(); applyingWatchState = false; const status = document.querySelector('#watch-status'); if (status) status.textContent = `${state.playing ? 'Playing' : 'Paused'} · ${isHost() ? 'You control playback' : 'Host controls playback'}`; }
function applyWatchState(state) { if (!state?.source || !validWatchSource(state.source) || !Number.isInteger(state.version) || state.version <= watchState.version) return; const existing = document.querySelector('#watch-video'); if (!existing || existing.currentSrc !== state.source) renderWatch(state); watchState = state; syncWatchVideo(state); }
async function publishWatchState() { if (!isHost() || !watchState.source) return; const publish = async () => { const active = chatMeeting(); const video = document.querySelector('#watch-video'); const value = await request(`/api/meetings/${active.id}/watch-state`, { method: 'POST', headers: { 'X-VYNQ-Session': active.token }, body: JSON.stringify({ source: watchState.source, playing: !video?.paused, position: video?.currentTime || 0, baseVersion: watchState.version }) }); watchState = value.state; }; const queued = watchPublishQueue.catch(() => {}).then(publish); watchPublishQueue = queued; try { await queued; } catch (error) { refreshWatchState(); const status = document.querySelector('#watch-status'); if (status) status.textContent = error.message; throw error; } }
async function refreshWatchState() { const active = chatMeeting(); if (!active) return; try { const value = await request(`/api/meetings/${active.id}/watch-state`, { headers: { 'X-VYNQ-Session': active.token } }); if (value.state) applyWatchState(value.state); } catch { /* lifecycle errors are shown elsewhere */ } }
function openWatchChooser() { const card = document.querySelector('.watch-card'); if (!card || !isHost()) return; card.innerHTML = `<h3>Choose a video</h3><label>Direct video URL<input id="watch-source" type="url" placeholder="https://example.com/video.mp4"></label><p id="watch-status">Only HTTPS MP4, WebM, and OGV sources are supported in this MVP.</p><button class="text-button" data-action="watch-start">Start for everyone</button>`; }
async function startWatch() { const source = document.querySelector('#watch-source')?.value.trim(); if (!validWatchSource(source)) { const status = document.querySelector('#watch-status'); if (status) status.textContent = 'Enter a direct HTTPS MP4, WebM, or OGV URL.'; return; } watchState = { version: 0, source, playing: false, position: 0, updatedAt: new Date().toISOString() }; renderWatch(watchState); await publishWatchState(); }
async function connectMedia(id, options = {}) { mountWatch(); try { const media = await request(`/api/meetings/${id}/livekit-token`, { method: 'POST', headers: { 'X-VYNQ-Session': storedSession(id).token } }); liveRoom = new Room({ adaptiveStream: true, dynacast: true }); liveRoom.on(RoomEvent.TrackSubscribed, (track, _, participant) => attachTrack(track, participant)); liveRoom.on(RoomEvent.TrackUnsubscribed, track => detachTrack(track)); liveRoom.on(RoomEvent.ParticipantConnected, participant => { addRemoteTile(participant, 'Connected'); setRemoteTileState(participant.identity, 'Connected'); publishWatchState(); }); liveRoom.on(RoomEvent.ParticipantDisconnected, participant => { document.querySelector(`#remote-${participant.identity}`)?.remove(); updateStageCount(); }); liveRoom.on(RoomEvent.ActiveSpeakersChanged, participants => setActiveSpeaker(participants)); liveRoom.on(RoomEvent.LocalTrackPublished, publication => attachTrack(publication.track, liveRoom.localParticipant, true)); liveRoom.on(RoomEvent.DataReceived, (payload, _, __, topic) => { if (topic !== 'vynq-watch') return; try { applyWatchState(JSON.parse(new TextDecoder().decode(payload))); } catch { /* ignore malformed packets */ } }); liveRoom.on(RoomEvent.Reconnecting, () => { startPresence('reconnecting'); setConnection('Reconnecting…', 'warning'); }); liveRoom.on(RoomEvent.Reconnected, () => { startPresence('connected'); setConnection('Media connected', 'connected'); }); liveRoom.on(RoomEvent.Disconnected, () => { startPresence('reconnecting'); setConnection('Media disconnected', 'warning'); }); await liveRoom.connect(media.url, media.token); startPresence('connected'); for (const participant of liveRoom.remoteParticipants.values()) { addRemoteTile(participant, 'Connected'); setRemoteTileState(participant.identity, 'Connected'); } if (options.audio) await liveRoom.localParticipant.setMicrophoneEnabled(true, { deviceId: options.audioId || undefined, echoCancellation: true, noiseSuppression: true }); if (options.video) await liveRoom.localParticipant.setCameraEnabled(true, { deviceId: options.videoId || undefined }); const controls = document.querySelectorAll('.control'); if (controls[0] && options.audio) { controls[0].classList.add('active'); controls[0].querySelector('span').textContent = 'Mic on'; } if (controls[1] && options.video) { controls[1].classList.add('active'); controls[1].querySelector('span').textContent = 'Camera on'; } setConnection('Media connected', 'connected'); } catch (error) { setConnection(error.message, 'warning'); } }
async function toggleMedia(kind, button) { if (!liveRoom) return setConnection('Live media is unavailable until LiveKit is configured.', 'warning'); try { const screen = kind === 'screen'; const camera = kind === 'camera'; const enabled = screen ? !liveRoom.localParticipant.isScreenShareEnabled : camera ? !liveRoom.localParticipant.isCameraEnabled : !liveRoom.localParticipant.isMicrophoneEnabled; if (screen) await liveRoom.localParticipant.setScreenShareEnabled(enabled); else if (camera) await liveRoom.localParticipant.setCameraEnabled(enabled); else await liveRoom.localParticipant.setMicrophoneEnabled(enabled); button.classList.toggle('active', enabled); button.querySelector('span').textContent = screen ? (enabled ? 'Sharing' : 'Screen') : camera ? (enabled ? 'Camera on' : 'Camera') : (enabled ? 'Mic on' : 'Mic'); if (camera) document.querySelector('#local-state').textContent = enabled ? 'Camera on' : 'Camera off'; } catch (error) { setConnection(`Could not access ${kind}: ${error.message}`, 'warning'); } }
function stopMicMeter() { cancelAnimationFrame(micMeterFrame); micMeterFrame = undefined; micMeterContext?.close().catch(() => {}); micMeterContext = undefined; }
function startMicMeter() {
  stopMicMeter();
  const meter = document.querySelector('#mic-level-fill');
  const status = document.querySelector('#device-status');
  const track = liveRoom?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
  if (!meter || !track) { if (status) status.textContent = 'Turn your microphone on to check its level.'; return; }
  try {
    micMeterContext = new AudioContext();
    const analyser = micMeterContext.createAnalyser(); analyser.fftSize = 512;
    micMeterContext.createMediaStreamSource(new MediaStream([track])).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const draw = () => { analyser.getByteTimeDomainData(samples); let total = 0; samples.forEach(value => { const centred = (value - 128) / 128; total += centred * centred; }); meter.style.width = `${Math.min(100, Math.max(3, Math.sqrt(total / samples.length) * 260))}%`; micMeterFrame = requestAnimationFrame(draw); };
    draw();
  } catch { if (status) status.textContent = 'Your microphone is on. Level preview is unavailable in this browser.'; }
}
async function testSpeaker() {
  const status = document.querySelector('#device-status');
  try {
    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    const tone = context.createOscillator(); tone.frequency.value = 660; tone.connect(destination);
    const audio = document.createElement('audio'); audio.autoplay = true; audio.srcObject = destination.stream;
    const deviceId = liveRoom?.getActiveDevice('audiooutput');
    if (deviceId && typeof audio.setSinkId === 'function') await audio.setSinkId(deviceId);
    document.querySelector('#remote-audio')?.append(audio); tone.start(); await audio.play();
    setTimeout(() => { tone.stop(); audio.remove(); context.close().catch(() => {}); }, 700);
    if (status) status.textContent = 'Playing a short test sound.';
  } catch (error) { if (status) status.textContent = `Could not play a test sound: ${error.message}`; }
}
async function switchCallDevice(kind, deviceId) {
  if (!liveRoom) return;
  const status = document.querySelector('#device-status');
  try {
    await liveRoom.switchActiveDevice(kind, deviceId);
    if (status) status.textContent = 'Device updated.';
    if (kind === 'audioinput') startMicMeter();
  } catch (error) { if (status) status.textContent = `Could not change device: ${error.message}`; }
}
async function showDeviceSettings() {
  if (!liveRoom) return setConnection('Enter the meeting before changing devices.', 'warning');
  app.insertAdjacentHTML('beforeend', `<div class="modal-backdrop" data-action="dismiss"><section class="modal device-modal" role="dialog" aria-modal="true" aria-labelledby="device-title"><button class="icon-button modal-close" data-action="dismiss" aria-label="Close">${icons.close}</button><div class="modal-symbol">${icons.settings}</div><h2 id="device-title">Devices</h2><p>Choose the microphone, camera, and speaker for this call.</p><label>Microphone<select id="call-audio-device"></select></label><div class="mic-level" aria-label="Microphone level"><span id="mic-level-fill"></span></div><label>Camera<select id="call-video-device"></select></label><label>Speaker<select id="call-output-device"></select></label><button class="button button-secondary button-full" data-action="test-speaker">Play test sound</button><p id="device-status" class="device-status" role="status"></p></section></div>`);
  const status = document.querySelector('#device-status');
  try {
    const devices = await Room.getLocalDevices(undefined, true);
    const fill = (selector, kind, fallback) => { const select = document.querySelector(selector); if (!select) return; const active = liveRoom.getActiveDevice(kind); const options = devices.filter(device => device.kind === kind).map((device, index) => `<option value="${escapeHtml(device.deviceId)}" ${device.deviceId === active ? 'selected' : ''}>${escapeHtml(device.label || `${fallback} ${index + 1}`)}</option>`).join(''); select.innerHTML = options || `<option value="">No ${fallback.toLowerCase()} found</option>`; };
    fill('#call-audio-device', 'audioinput', 'Microphone'); fill('#call-video-device', 'videoinput', 'Camera'); fill('#call-output-device', 'audiooutput', 'Speaker');
    startMicMeter();
  } catch (error) { if (status) status.textContent = `Could not list devices: ${error.message}`; }
}
function leavePayload() { const match = location.hash.match(/^#\/room\/(VYNQ-[A-Z0-9-]+)$/); const session = match && storedSession(match[1]); return match && session ? { id: match[1], token: session.token } : null; }
function notifyLeave() { const leave = leavePayload(); if (!leave) return; fetch(`/api/meetings/${leave.id}/leave`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-VYNQ-Session': leave.token }, keepalive: true }).catch(() => {}); }
function leaveMeeting() { leavingMeeting = true; clearInterval(watchPollTimer); closeChat(); stopMicMeter(); stopPresence(); stageResizeObserver?.disconnect(); liveRoom?.disconnect(); notifyLeave(); location.hash = '#/'; }
async function navigate() { clearInterval(hostWaitTimer); clearInterval(chatPollTimer); clearInterval(watchPollTimer); stopMicMeter(); stopPreview(); stopPresence(); stageResizeObserver?.disconnect(); liveRoom?.disconnect(); liveRoom = null; const found = location.hash.match(/^#\/room\/(VYNQ-[A-Z0-9-]+)$/); if (!found) return home(); const session = storedSession(found[1]); if (!session) { home(); modal('join'); document.querySelector('#meeting-code').value = found[1]; return showFormError('Enter your name to join this meeting.'); } try { const value = await request(`/api/meetings/${found[1]}`, { headers: { 'X-VYNQ-Session': session.token } }); if (value.participant.status === 'waiting') return waitingRoom(value.meeting.title); prejoin(value.meeting, value.participant); } catch (error) { sessionStorage.removeItem(`vynq:${found[1]}`); home(); modal('join'); document.querySelector('#meeting-code').value = found[1]; showFormError(error.message); } }
async function join(code, name) { const id = normaliseMeetingId(code); if (!id) return showFormError('Enter a valid meeting code, for example VYNQ-AB12-CD34-EF56.'); if (meetingSubmissionPending) return; meetingSubmissionPending = true; setMeetingSubmitState(true); try { const initData = window.Telegram?.WebApp?.initData; const existing = storedSession(id); const headers = existing?.token ? { 'X-VYNQ-Session': existing.token } : {}; const value = await request(initData ? '/api/telegram/join' : `/api/meetings/${id}/join`, { method: 'POST', headers, body: JSON.stringify(initData ? { meetingId: id, initData } : { name }) }); saveSession(id, value.session); const destination = `#/room/${id}`; if (location.hash === destination) await navigate(); else location.hash = destination; } catch (error) { showFormError(error.message); } finally { meetingSubmissionPending = false; setMeetingSubmitState(false); } }
async function create() { if (meetingSubmissionPending) return; meetingSubmissionPending = true; setMeetingSubmitState(true); try { const value = await request('/api/meetings', { method: 'POST', body: JSON.stringify({ title: document.querySelector('#meeting-name').value, hostName: document.querySelector('#display-name').value }) }); saveSession(value.meeting.id, value.session); location.hash = `#/room/${value.meeting.id}`; } catch (error) { showFormError(error.message); } finally { meetingSubmissionPending = false; setMeetingSubmitState(false); } }
function inviteLink() { const match = location.hash.match(/^#\/room\/(VYNQ-[A-Z0-9-]+)$/); return match ? meetingInviteUrl(window.location, match[1]) : null; }
async function copyInvite(target) { const link = inviteLink(); if (!link) return; try { if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable'); await navigator.clipboard.writeText(link); target.textContent = 'Link copied'; } catch { window.prompt('Copy this invitation link:', link); target.textContent = 'Copy link manually'; } setTimeout(() => { target.textContent = target.dataset.action === 'copy' ? 'Copy invite link' : target.textContent; }, 1800); }
async function shareInviteViaTelegram() { const link = inviteLink(); const active = chatMeeting(); if (!link || !active) return; let botLink = ''; try { botLink = (await request(`/api/meetings/${active.id}/telegram-invite`, { headers: { 'X-VYNQ-Session': active.token } })).botLink || ''; } catch { /* Telegram sharing still works with the browser invitation alone. */ } const title = document.querySelector('.room-title span:nth-child(2)')?.textContent || 'a VYNQ meeting'; const popup = window.open(telegramShareUrl(link, title, botLink), '_blank', 'noopener,noreferrer'); if (!popup) navigator.clipboard?.writeText(link).catch(() => {}); }

app.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action], [data-control]'); if (!target) return;
  const action = target.dataset.action;
  if (action === 'dismiss' && target.classList.contains('modal-backdrop') && event.target !== target) return;
  if (action === 'create' || action === 'join') modal(action);
  if (action === 'dismiss') { stopMicMeter(); document.querySelector('.modal-backdrop')?.remove(); }
  if (action === 'submit-create') create();
  if (action === 'submit-join') join(document.querySelector('#meeting-code').value, document.querySelector('#display-name').value);
  if (action === 'preview-enable') startPreview();
  if (action === 'preview-audio') togglePreview('audio');
  if (action === 'preview-video') togglePreview('video');
  if (action === 'enter-meeting') enterMeeting();
  if (action === 'layout-grid') setRoomLayout('grid');
  if (action === 'layout-speaker') setRoomLayout('speaker');
  if (action === 'layout-focus') setRoomLayout('focus');
  if (action === 'pin-tile') pinTile(target.dataset.tile);
  if (action === 'fullscreen') toggleFullscreen();
  if (action === 'watch-open') openWatchChooser();
  if (action === 'watch-start') startWatch();
  if (action === 'devices') showDeviceSettings();
  if (action === 'test-speaker') testSpeaker();
  if (action === 'participants') showParticipants();
  if (action === 'watch-toggle') showWatchPanel();
  if (action === 'chat-toggle') openChat();
  if (action === 'chat-group') { chatRecipientId = null; document.querySelector('#chat-input').placeholder = 'Message everyone'; refreshChat(); }
  if (action === 'chat-directs') showDirectChats();
  if (action === 'chat-recipient') selectChatRecipient(target.dataset.recipient, target.dataset.name);
  if (action === 'close-sidebar') closeSidebar();
  if (action === 'participant-admit' || action === 'participant-remove') updateParticipant(target.dataset.participant, action.replace('participant-', ''));
  if (action === 'copy') copyInvite(target);
  if (action === 'telegram-share') shareInviteViaTelegram();
  if (action === 'leave') leaveMeeting();
  if (target.dataset.control) toggleMedia(target.dataset.control, target);
});
app.addEventListener('play', event => { if (event.target.id === 'watch-video' && isHost() && !applyingWatchState) publishWatchState(); }, true);
app.addEventListener('pause', event => { if (event.target.id === 'watch-video' && isHost() && !applyingWatchState) publishWatchState(); }, true);
app.addEventListener('seeked', event => { if (event.target.id === 'watch-video' && isHost() && !applyingWatchState) publishWatchState(); }, true);
app.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'chat-input' && !e.shiftKey) { e.preventDefault(); sendChat(); } if (e.key === 'Enter' && document.querySelector('#meeting-code')) join(document.querySelector('#meeting-code').value, document.querySelector('#display-name').value); if (e.key === 'Escape') document.querySelector('.modal-backdrop')?.remove(); });
app.addEventListener('submit', event => { if (event.target.id === 'chat-composer') { event.preventDefault(); sendChat(); } });
app.addEventListener('change', event => { if (event.target.id === 'audio-device') { prejoinOptions.audioId = event.target.value; startPreview(); } if (event.target.id === 'video-device') { prejoinOptions.videoId = event.target.value; startPreview(); } if (event.target.id === 'call-audio-device') switchCallDevice('audioinput', event.target.value); if (event.target.id === 'call-video-device') switchCallDevice('videoinput', event.target.value); if (event.target.id === 'call-output-device') switchCallDevice('audiooutput', event.target.value); });
window.addEventListener('hashchange', navigate); navigate();
// Do not call notifyLeave on pagehide: browsers emit it for reloads as well as real exits.
