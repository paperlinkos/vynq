import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server;
let baseUrl;
let dataDir;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function unusedPort() {
  const probe = createServer((_, res) => res.end());
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function api(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(token ? { 'X-VYNQ-Session': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json() };
}

async function createMeeting(name = 'Host User') {
  const result = await api('/api/meetings', { method: 'POST', body: { title: 'Lifecycle test', hostName: name } });
  assert.equal(result.status, 201);
  return result.body;
}

function heartbeat(id, token, presence = 'connected') {
  return api(`/api/meetings/${id}/heartbeat`, { method: 'POST', token, body: { presence } });
}

async function markSessionStale(meetingId, sessionId) {
  const file = join(dataDir, 'meetings.json');
  const store = JSON.parse(await readFile(file, 'utf8'));
  const session = store.meetings[meetingId].sessions.find(item => item.id === sessionId);
  session.lastSeenAt = new Date(0).toISOString();
  await writeFile(file, JSON.stringify(store), 'utf8');
}

async function exerciseCreateJoinAndAdmission() {
  const host = await createMeeting();
  const id = host.meeting.id;
  const hostToken = host.session.token;
  assert.equal((await heartbeat(id, hostToken)).status, 200);

  const guest = await api(`/api/meetings/${id}/join`, { method: 'POST', body: { name: 'Guest User' } });
  assert.equal(guest.status, 200);
  assert.equal(guest.body.session.status, 'waiting');
  const duplicates = await Promise.all([
    api(`/api/meetings/${id}/join`, { method: 'POST', token: guest.body.session.token, body: { name: 'Different Name' } }),
    api(`/api/meetings/${id}/join`, { method: 'POST', token: guest.body.session.token, body: { name: 'Another Name' } })
  ]);
  duplicates.forEach(duplicate => {
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.reused, true);
    assert.equal(duplicate.body.session.token, guest.body.session.token);
    assert.equal(duplicate.body.session.name, 'Guest User');
  });
  assert.equal((await api(`/api/meetings/${id}/livekit-token`, { method: 'POST', token: guest.body.session.token })).status, 403);

  const participants = await api(`/api/meetings/${id}/participants`, { token: hostToken });
  const guestParticipant = participants.body.participants.find(person => person.role === 'guest');
  assert.equal(participants.status, 200);
  assert.equal(participants.body.participants.length, 2);
  assert.equal(guestParticipant.presence, 'waiting');
  assert.equal((await api(`/api/meetings/${id}/participants/${guestParticipant.id}/admit`, { method: 'POST', token: hostToken })).status, 200);
  const guestHeartbeat = await heartbeat(id, guest.body.session.token);
  assert.equal(guestHeartbeat.status, 200);
  assert.equal(guestHeartbeat.body.participant.presence, 'connected');
}

async function exerciseReconnectionAndExpiry() {
  const host = await createMeeting('Host Two');
  const id = host.meeting.id;
  const hostToken = host.session.token;
  await heartbeat(id, hostToken);
  const guest = await api(`/api/meetings/${id}/join`, { method: 'POST', body: { name: 'Guest Two' } });
  const waiting = await api(`/api/meetings/${id}/participants`, { token: hostToken });
  const guestId = waiting.body.participants.find(person => person.role === 'guest').id;
  await api(`/api/meetings/${id}/participants/${guestId}/admit`, { method: 'POST', token: hostToken });
  await heartbeat(id, guest.body.session.token);

  await sleep(50);
  assert.equal((await heartbeat(id, guest.body.session.token, 'reconnecting')).status, 200);
  assert.equal((await heartbeat(id, hostToken)).status, 200);
  await markSessionStale(id, guestId);
  assert.equal((await heartbeat(id, hostToken)).status, 200);
  const participants = await api(`/api/meetings/${id}/participants`, { token: hostToken });
  assert.equal(participants.status, 200);
  assert.equal(participants.body.participants.some(person => person.id === guestId), false);
  assert.equal((await heartbeat(id, guest.body.session.token)).status, 401);
}

async function exerciseWatchTogether() {
  const host = await createMeeting('Watch Host'); const id = host.meeting.id; const hostToken = host.session.token;
  const endpoint = `/api/meetings/${id}/watch-state`;
  const update = (position, baseVersion, extra = {}) => ({ source: 'https://cdn.example.test/sample.mp4', playing: position < 20, position, baseVersion, ...extra });
  assert.equal((await api(endpoint)).status, 403);
  assert.equal((await api(endpoint, { method: 'POST', body: update(0, 0) })).status, 403);
  assert.equal((await api(endpoint, { token: hostToken })).status, 200);

  const guest = await api(`/api/meetings/${id}/join`, { method: 'POST', body: { name: 'Watch Guest' } });
  assert.equal((await api(endpoint, { token: guest.body.session.token })).status, 403);
  const people = await api(`/api/meetings/${id}/participants`, { token: hostToken });
  const hostId = people.body.participants.find(person => person.role === 'host').id;
  const guestId = people.body.participants.find(person => person.role === 'guest').id;
  assert.equal((await api(`/api/meetings/${id}/participants/${guestId}/admit`, { method: 'POST', token: hostToken })).status, 200);
  assert.equal((await api(endpoint, { token: guest.body.session.token })).body.state, null);

  const first = await api(endpoint, { method: 'POST', token: hostToken, body: update(12, 0, { version: 999, updatedAt: 'forged' }) });
  assert.equal(first.status, 200); assert.equal(first.body.state.version, 1); assert.equal(first.body.state.source, 'https://cdn.example.test/sample.mp4'); assert.ok(Date.parse(first.body.state.updatedAt));
  const guestRead = await api(endpoint, { token: guest.body.session.token });
  assert.equal(guestRead.status, 200); assert.deepEqual(guestRead.body.state, first.body.state);
  assert.equal((await api(endpoint, { method: 'POST', token: guest.body.session.token, body: update(13, 1) })).status, 403);

  const second = await api(endpoint, { method: 'POST', token: hostToken, body: update(20, 1) });
  assert.equal(second.status, 200); assert.equal(second.body.state.version, 2); assert.equal(second.body.state.playing, false);
  assert.equal((await api(endpoint, { method: 'POST', token: hostToken, body: update(21, 1) })).status, 400);
  assert.equal((await api(endpoint, { method: 'POST', token: hostToken, body: { source: 'http://example.test/video.mp4', playing: true, position: 0, baseVersion: 2 } })).status, 400);
  assert.equal((await api(endpoint, { method: 'POST', token: hostToken, body: { source: 'https://example.test/video.m3u8', playing: true, position: 0, baseVersion: 2 } })).status, 400);
  assert.equal((await api(endpoint, { method: 'POST', token: hostToken, body: { source: 'https://example.test/video.webm', playing: true, position: -1, baseVersion: 2 } })).status, 400);
  assert.equal((await api(endpoint, { method: 'POST', token: hostToken, body: [] })).status, 400);

  const other = await createMeeting('Other Watch Host');
  assert.equal((await api(endpoint, { token: other.session.token })).status, 403);
  assert.equal((await api(endpoint, { method: 'POST', token: other.session.token, body: update(1, 2) })).status, 403);

  const concurrent = await Promise.all([
    api(endpoint, { method: 'POST', token: hostToken, body: update(25, 2) }),
    api(endpoint, { method: 'POST', token: hostToken, body: update(30, 2) })
  ]);
  assert.equal(concurrent.filter(result => result.status === 200).length, 1);
  assert.equal(concurrent.filter(result => result.status === 400).length, 1);
  const persisted = await api(endpoint, { token: guest.body.session.token });
  assert.equal(persisted.body.state.version, 3);

  assert.equal((await api(`/api/meetings/${id}/participants/${guestId}/remove`, { method: 'POST', token: hostToken })).status, 200);
  assert.equal((await api(endpoint, { token: guest.body.session.token })).status, 403);
  await markSessionStale(id, hostId);
  assert.equal((await heartbeat(id, hostToken)).status, 410);
}

async function exerciseHostDeparture() {
  const host = await createMeeting('Host Three');
  const id = host.meeting.id;
  const hostToken = host.session.token;
  await heartbeat(id, hostToken);
  const guest = await api(`/api/meetings/${id}/join`, { method: 'POST', body: { name: 'Guest Three' } });
  const leave = await api(`/api/meetings/${id}/leave`, { method: 'POST', token: hostToken });
  assert.equal(leave.status, 200);
  assert.equal(leave.body.ended, true);
  assert.equal((await api(`/api/meetings/${id}/join`, { method: 'POST', body: { name: 'New Guest' } })).status, 410);
  assert.equal((await heartbeat(id, guest.body.session.token)).status, 410);
  assert.equal((await api(`/api/meetings/${id}/watch-state`, { token: hostToken })).status, 410);
}

async function exerciseChatPrivacy() {
  const host = await createMeeting('Chat Host'); const id = host.meeting.id; const hostToken = host.session.token;
  const joinAndAdmit = async name => { const joined = await api(`/api/meetings/${id}/join`, { method: 'POST', body: { name } }); const people = await api(`/api/meetings/${id}/participants`, { token: hostToken }); const person = people.body.participants.find(item => item.id !== host.session.id && item.status === 'waiting'); await api(`/api/meetings/${id}/participants/${person.id}/admit`, { method: 'POST', token: hostToken }); return { ...joined.body.session, id: person.id }; };
  const alice = await joinAndAdmit('Alice Chat'); const bob = await joinAndAdmit('Bob Chat');
  const group = await api(`/api/meetings/${id}/messages`, { method: 'POST', token: hostToken, body: { text: 'hello everyone', clientMessageId: 'groupmessage1' } });
  assert.equal(group.status, 201); assert.equal(group.body.message.sender.name, 'Chat Host'); assert.ok(group.body.message.id); assert.ok(group.body.message.createdAt);
  assert.equal((await api(`/api/meetings/${id}/messages`, { token: alice.token })).body.messages.length, 1);
  const direct = await api(`/api/meetings/${id}/messages`, { method: 'POST', token: alice.token, body: { text: 'private hello', recipientId: bob.id, clientMessageId: 'directmessage1' } });
  assert.equal(direct.status, 201);
  assert.equal((await api(`/api/meetings/${id}/messages?recipient=${bob.id}`, { token: alice.token })).body.messages[0].body, 'private hello');
  assert.equal((await api(`/api/meetings/${id}/messages?recipient=${alice.id}`, { token: bob.token })).body.messages.length, 1);
  assert.equal((await api(`/api/meetings/${id}/messages?recipient=${bob.id}`, { token: hostToken })).body.messages.length, 0);
  assert.equal((await api(`/api/meetings/${id}/messages`, { method: 'POST', token: alice.token, body: { text: 'x'.repeat(2001) } })).status, 400);
  const other = await createMeeting('Other Host');
  assert.equal((await api(`/api/meetings/${id}/messages`, { method: 'POST', token: alice.token, body: { text: 'cross', recipientId: other.session.token, clientMessageId: 'crossmessage1' } })).status, 400);
  for (let index = 0; index < 29; index += 1) await api(`/api/meetings/${id}/messages`, { method: 'POST', token: hostToken, body: { text: `rate ${index}`, clientMessageId: `ratemessage${index}` } });
  assert.equal((await api(`/api/meetings/${id}/messages`, { method: 'POST', token: hostToken, body: { text: 'one too many', clientMessageId: 'ratelimitmessage' } })).status, 429);
}

try {
  dataDir = await mkdtemp(join(tmpdir(), 'vynq-lifecycle-'));
  process.env.VYNQ_DATA_DIR = dataDir;
  process.env.VYNQ_PRESENCE_GRACE_SECONDS = '3';
  const port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  const { handleRequest } = await import('../lib/vynq-server.mjs');
  server = createServer(handleRequest);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await exerciseCreateJoinAndAdmission();
  await exerciseReconnectionAndExpiry();
  await exerciseChatPrivacy();
  await exerciseWatchTogether();
  await exerciseHostDeparture();
  console.log('✓ meeting lifecycle checks passed');
} finally {
  await new Promise(resolve => server?.close(resolve) || resolve());
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}
