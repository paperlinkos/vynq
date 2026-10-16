import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { TrackSource } from '@livekit/protocol';
import { neon } from '@neondatabase/serverless';

const appRoot = process.cwd();
const root = normalize(process.env.VYNQ_STATIC_DIR || appRoot);
const port = Number(process.env.PORT || 4173);
const dataDir = normalize(process.env.VYNQ_DATA_DIR || (process.env.VERCEL ? '/tmp/vynq-data' : join(appRoot, '.vynq-data')));
const dataFile = join(dataDir, 'meetings.json');
const meetingTtlHours = Number(process.env.VYNQ_MEETING_TTL_HOURS || 24);
const maxParticipants = Math.max(2, Math.min(100, Number(process.env.VYNQ_MAX_PARTICIPANTS || 25)));
const presenceGraceMs = Math.max(100, Number(process.env.VYNQ_PRESENCE_GRACE_SECONDS || 45) * 1000);
const oneDay = 24 * 60 * 60 * 1000;
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const presenceStates = new Set(['waiting', 'connecting', 'connected', 'reconnecting']);
const rateBuckets = new Map();
const chatRateBuckets = new Map();
const botRateBuckets = new Map();
const meetingWriteQueues = new Map();
let schemaReady;
let lastExpiryCleanup = 0;
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

await mkdir(dataDir, { recursive: true });

function nowIso() { return new Date().toISOString(); }
function staleCutoff() { return new Date(Date.now() - presenceGraceMs); }
function createId() { const raw = randomBytes(10).toString('hex').toUpperCase(); return `VYNQ-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`; }
function token() { return randomBytes(32).toString('base64url'); }
function hashToken(value) { return createHash('sha256').update(value || '').digest('hex'); }
function cleanText(value, limit) { return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, limit) : ''; }
function validName(value) { return value.length >= 2 && value.length <= 50; }
function asIso(value) { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function isExpired(meeting) { return new Date(meeting.expiresAt).getTime() <= Date.now(); }
function isEnded(meeting) { return Boolean(meeting?.endedAt); }
function safeEqual(a, b) { if (!a || !b || a.length !== b.length) return false; return timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function defaultPresence(session) { return session.status === 'waiting' ? 'waiting' : 'connecting'; }
function presenceOf(session) { return presenceStates.has(session.presenceState) ? session.presenceState : defaultPresence(session); }
function lastSeenOf(session) { return new Date(session.lastSeenAt || session.joinedAt).getTime(); }
function isFresh(session, cutoff = Date.now() - presenceGraceMs) { return lastSeenOf(session) > cutoff; }
function publicMeeting(meeting) { return { id: meeting.id, title: meeting.title, createdAt: meeting.createdAt, expiresAt: meeting.expiresAt, endedAt: meeting.endedAt || null }; }
function publicSession(session, selfId) { return { id: session.id, name: session.name, role: session.role, status: session.status, presence: presenceOf(session), isSelf: session.id === selfId }; }
function meetingFromRow(row) { return row && { id: row.id, title: row.title, createdAt: asIso(row.created_at), expiresAt: asIso(row.expires_at), endedAt: row.ended_at ? asIso(row.ended_at) : null }; }
function sessionFromRow(row) { return row && { id: row.id, name: row.display_name, role: row.role, status: row.status, joinedAt: asIso(row.joined_at), lastSeenAt: asIso(row.last_seen_at || row.joined_at), presenceState: row.presence_state || (row.status === 'waiting' ? 'waiting' : 'connecting') }; }
function sessionState(session, requested) { if (session.status === 'waiting') return 'waiting'; return presenceStates.has(requested) && requested !== 'waiting' ? requested : 'connecting'; }

async function readStore() { if (!existsSync(dataFile)) return { meetings: {} }; try { return JSON.parse(await readFile(dataFile, 'utf8')); } catch { return { meetings: {} }; } }
async function writeStore(store) { await writeFile(dataFile, JSON.stringify(store, null, 2), 'utf8'); }
function contentSecurityPolicy() { const connect = ["'self'"]; try { const livekit = new URL(process.env.LIVEKIT_URL || ''); if (livekit.protocol === 'wss:' || livekit.protocol === 'ws:') connect.push(livekit.origin); } catch { /* LiveKit remains optional until configured. */ } return `default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' https: blob:; connect-src ${connect.join(' ')}; form-action 'self'; frame-ancestors 'none'`; }
function setSecurityHeaders(res) { res.setHeader('Content-Security-Policy', contentSecurityPolicy()); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=()'); res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); if (process.env.VERCEL) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains'); }
function clientIp(req) { const forwarded = process.env.VERCEL ? req.headers['x-forwarded-for'] : null; return String(forwarded || req.socket.remoteAddress || 'unknown').split(',')[0].trim(); }
function rateAllowed(req, limit, windowMs = 60_000) { const now = Date.now(); const path = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname; const key = `${clientIp(req)}:${req.method}:${path}`; const bucket = rateBuckets.get(key); const fresh = !bucket || bucket.resetAt <= now ? { count: 0, resetAt: now + windowMs } : bucket; fresh.count += 1; rateBuckets.set(key, fresh); if (rateBuckets.size > 10_000) for (const [entry, value] of rateBuckets) if (value.resetAt <= now) rateBuckets.delete(entry); return fresh.count <= limit; }
function botRateAllowed(chatId) { const now = Date.now(); const bucket = botRateBuckets.get(chatId); const fresh = !bucket || bucket.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : bucket; fresh.count += 1; botRateBuckets.set(chatId, fresh); if (botRateBuckets.size > 10_000) for (const [entry, value] of botRateBuckets) if (value.resetAt <= now) botRateBuckets.delete(entry); return fresh.count <= 12; }

async function ensureSchema() {
  if (!sql) return;
  schemaReady ??= (async () => {
    await sql`CREATE TABLE IF NOT EXISTS meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ)`;
    await sql`CREATE TABLE IF NOT EXISTS meeting_sessions (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, display_name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('host', 'guest')), status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('waiting', 'approved')), token_hash TEXT NOT NULL, joined_at TIMESTAMPTZ NOT NULL, last_seen_at TIMESTAMPTZ NOT NULL, presence_state TEXT NOT NULL DEFAULT 'connecting', telegram_user_id TEXT)`;
    await sql`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ`;
    await sql`ALTER TABLE meeting_sessions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved'`;
    await sql`ALTER TABLE meeting_sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`;
    await sql`ALTER TABLE meeting_sessions ADD COLUMN IF NOT EXISTS presence_state TEXT NOT NULL DEFAULT 'connecting'`;
    await sql`UPDATE meeting_sessions SET last_seen_at = joined_at WHERE last_seen_at IS NULL`;
    await sql`ALTER TABLE meeting_sessions ALTER COLUMN last_seen_at SET NOT NULL`;
    await sql`CREATE INDEX IF NOT EXISTS meeting_sessions_lookup ON meeting_sessions (meeting_id, token_hash)`;
    await sql`CREATE INDEX IF NOT EXISTS meeting_sessions_presence ON meeting_sessions (meeting_id, last_seen_at)`;
    await sql`CREATE TABLE IF NOT EXISTS meeting_messages (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, sender_id TEXT NOT NULL REFERENCES meeting_sessions(id) ON DELETE CASCADE, recipient_id TEXT REFERENCES meeting_sessions(id) ON DELETE CASCADE, body TEXT NOT NULL, client_message_id TEXT, created_at TIMESTAMPTZ NOT NULL)`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS meeting_messages_dedupe ON meeting_messages (sender_id, client_message_id) WHERE client_message_id IS NOT NULL`;
    await sql`CREATE INDEX IF NOT EXISTS meeting_messages_history ON meeting_messages (meeting_id, created_at)`;
    await sql`CREATE TABLE IF NOT EXISTS meeting_watch_state (meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE, source TEXT NOT NULL, playing BOOLEAN NOT NULL, position DOUBLE PRECISION NOT NULL, revision BIGINT NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`;
  })();
  return schemaReady;
}

async function cleanupExpired() {
  if (Date.now() - lastExpiryCleanup < 300_000) return;
  lastExpiryCleanup = Date.now();
  if (sql) { await ensureSchema(); await sql`DELETE FROM meetings WHERE expires_at <= NOW()`; return; }
  const store = await readStore(); let changed = false;
  for (const [id, meeting] of Object.entries(store.meetings)) if (isExpired(meeting)) { delete store.meetings[id]; changed = true; }
  if (changed) await writeStore(store);
}

async function closeLiveKitRoom(meetingId) {
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) return;
  try {
    const serviceUrl = LIVEKIT_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    const rooms = new RoomServiceClient(serviceUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    await rooms.deleteRoom(meetingId);
  } catch (error) { console.warn(JSON.stringify({ event: 'livekit_room_close_failed', meetingId, message: error.message })); }
}

async function cleanupStalePresence() {
  const cutoff = staleCutoff();
  if (sql) {
    await ensureSchema();
    const staleHosts = await sql`SELECT meeting_id FROM meeting_sessions WHERE role = 'host' AND last_seen_at <= ${cutoff}`;
    for (const row of staleHosts) {
      await sql`UPDATE meetings SET ended_at = COALESCE(ended_at, NOW()) WHERE id = ${row.meeting_id}`;
      await sql`DELETE FROM meeting_sessions WHERE meeting_id = ${row.meeting_id}`;
      await closeLiveKitRoom(row.meeting_id);
    }
    await sql`DELETE FROM meeting_sessions WHERE role = 'guest' AND last_seen_at <= ${cutoff}`;
    return;
  }
  const store = await readStore(); let changed = false;
  for (const meeting of Object.values(store.meetings)) {
    if (isEnded(meeting)) continue;
    const host = meeting.sessions.find(session => session.role === 'host');
    if (host && !isFresh(host)) {
      meeting.endedAt = nowIso(); meeting.sessions = []; changed = true; await closeLiveKitRoom(meeting.id); continue;
    }
    const sessions = meeting.sessions.filter(isFresh);
    if (sessions.length !== meeting.sessions.length) { meeting.sessions = sessions; changed = true; }
  }
  if (changed) await writeStore(store);
}

async function dbMeeting(id) { await ensureSchema(); const rows = await sql`SELECT id, title, created_at, expires_at, ended_at FROM meetings WHERE id = ${id}`; return meetingFromRow(rows[0]); }
async function getMeeting(id) { if (sql) return [null, await dbMeeting(id)]; const store = await readStore(); return [store, store.meetings[id]]; }
function unavailable(res, meeting) { if (!meeting) { json(res, 404, { error: 'This meeting does not exist.' }); return true; } if (isEnded(meeting)) { json(res, 410, { error: 'This meeting has ended.' }); return true; } if (isExpired(meeting)) { json(res, 410, { error: 'This meeting has expired.' }); return true; } return false; }

async function dbCreateSession(meetingId, name, role, telegramUserId, status = role === 'host' ? 'approved' : 'waiting') {
  const joinToken = token(); const joinedAt = nowIso(); const presenceState = status === 'waiting' ? 'waiting' : 'connecting';
  const session = { id: randomUUID(), name, role, status, token: joinToken, joinedAt, lastSeenAt: joinedAt, presenceState, telegramUserId: telegramUserId ? String(telegramUserId) : null };
  await sql`INSERT INTO meeting_sessions (id, meeting_id, display_name, role, status, token_hash, joined_at, last_seen_at, presence_state, telegram_user_id) VALUES (${session.id}, ${meetingId}, ${session.name}, ${session.role}, ${session.status}, ${hashToken(joinToken)}, ${session.joinedAt}, ${session.lastSeenAt}, ${session.presenceState}, ${session.telegramUserId})`;
  return session;
}

async function createMeeting(title, hostName, telegramUser) {
  if (sql) {
    await ensureSchema(); let meetingId; do { meetingId = createId(); } while (await dbMeeting(meetingId));
    const createdAt = nowIso(); const meeting = { id: meetingId, title: title || 'Untitled meeting', createdAt, expiresAt: new Date(Date.now() + meetingTtlHours * 3600000).toISOString(), endedAt: null };
    await sql`INSERT INTO meetings (id, title, created_at, expires_at) VALUES (${meeting.id}, ${meeting.title}, ${meeting.createdAt}, ${meeting.expiresAt})`;
    const session = await dbCreateSession(meeting.id, hostName, 'host', telegramUser?.id); return { meeting, session };
  }
  const store = await readStore(); let meetingId; do { meetingId = createId(); } while (store.meetings[meetingId]);
  const createdAt = nowIso(); const joinToken = token(); const session = { id: randomUUID(), name: hostName, role: 'host', status: 'approved', token: joinToken, joinedAt: createdAt, lastSeenAt: createdAt, presenceState: 'connecting', telegramUserId: telegramUser?.id || null };
  const meeting = { id: meetingId, title: title || 'Untitled meeting', createdAt, expiresAt: new Date(Date.now() + meetingTtlHours * 3600000).toISOString(), endedAt: null, sessions: [session], messages: [] };
  store.meetings[meetingId] = meeting; await writeStore(store); return { meeting, session };
}

async function meetingHasCapacity(meeting) {
  if (sql) { const rows = await sql`SELECT COUNT(*)::int AS count FROM meeting_sessions WHERE meeting_id = ${meeting.id} AND last_seen_at > ${staleCutoff()}`; return Number(rows[0]?.count || 0) < maxParticipants; }
  return meeting.sessions.filter(isFresh).length < maxParticipants;
}

async function sessionByToken(meetingId, joinToken, guestOnly = false) {
  if (!joinToken) return null;
  if (sql) {
    const rows = await sql`SELECT id, display_name, role, status, joined_at, last_seen_at, presence_state FROM meeting_sessions WHERE meeting_id = ${meetingId} AND token_hash = ${hashToken(joinToken)} AND last_seen_at > ${staleCutoff()}`;
    const session = sessionFromRow(rows[0]); return guestOnly && session?.role !== 'guest' ? null : session;
  }
  const [, meeting] = await getMeeting(meetingId); const session = meeting?.sessions.find(item => safeEqual(item.token, joinToken) && isFresh(item)); return guestOnly && session?.role !== 'guest' ? null : session || null;
}

async function requireSession(req, id) {
  const [store, meeting] = await getMeeting(id);
  if (!meeting || isExpired(meeting) || isEnded(meeting)) return [store, meeting, null];
  const joinToken = req.headers['x-vynq-session'];
  if (!sql) {
    const session = meeting.sessions.find(item => safeEqual(item.token, joinToken) && isFresh(item)) || null;
    return [store, meeting, session];
  }
  return [store, meeting, await sessionByToken(id, joinToken)];
}

async function touchSession(store, meeting, session, requestedState) {
  const presenceState = sessionState(session, requestedState); const lastSeenAt = nowIso();
  if (sql) await sql`UPDATE meeting_sessions SET last_seen_at = ${lastSeenAt}, presence_state = ${presenceState} WHERE id = ${session.id} AND meeting_id = ${meeting.id}`;
  else { session.lastSeenAt = lastSeenAt; session.presenceState = presenceState; await writeStore(store); }
  session.lastSeenAt = lastSeenAt; session.presenceState = presenceState; return session;
}

async function activeSessions(meeting) {
  if (sql) { const rows = await sql`SELECT id, display_name, role, status, joined_at, last_seen_at, presence_state FROM meeting_sessions WHERE meeting_id = ${meeting.id} AND last_seen_at > ${staleCutoff()} ORDER BY joined_at`; return rows.map(sessionFromRow); }
  return meeting.sessions.filter(isFresh);
}

function cleanMessage(value) { return typeof value === 'string' ? value.trim().slice(0, 2000) : ''; }
function validWatchSource(value) { try { const url = new URL(value); return url.protocol === 'https:' && /\.(mp4|webm|ogv)(?:$|[?#])/i.test(url.pathname + url.search); } catch { return false; } }
async function watchState(meeting) { if (sql) { const rows = await sql`SELECT source, playing, position, revision, updated_at FROM meeting_watch_state WHERE meeting_id = ${meeting.id}`; return rows[0] && { source: rows[0].source, playing: rows[0].playing, position: Number(rows[0].position), version: Number(rows[0].revision), updatedAt: asIso(rows[0].updated_at) }; } return meeting.watchState || null; }
function queueMeetingWrite(meetingId, work) { const previous = meetingWriteQueues.get(meetingId) || Promise.resolve(); const result = previous.catch(() => {}).then(work); meetingWriteQueues.set(meetingId, result); result.finally(() => { if (meetingWriteQueues.get(meetingId) === result) meetingWriteQueues.delete(meetingId); }).catch(() => {}); return result; }
function cleanWatchInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !validWatchSource(input.source) || typeof input.playing !== 'boolean' || !Number.isFinite(input.position) || input.position < 0 || !Number.isInteger(input.baseVersion) || input.baseVersion < 0) throw new Error('Enter a valid Watch Together update.');
  return { source: input.source, playing: input.playing, position: input.position, baseVersion: input.baseVersion };
}
function publicWatchState(row) { return { source: row.source, playing: row.playing, position: Number(row.position), version: Number(row.revision), updatedAt: asIso(row.updated_at) }; }
async function saveWatchState(store, meeting, input) {
  const update = cleanWatchInput(input);
  if (sql) {
    await ensureSchema();
    let rows;
    if (update.baseVersion === 0) rows = await sql`INSERT INTO meeting_watch_state (meeting_id, source, playing, position, revision, updated_at) VALUES (${meeting.id}, ${update.source}, ${update.playing}, ${update.position}, 1, NOW()) ON CONFLICT (meeting_id) DO NOTHING RETURNING source, playing, position, revision, updated_at`;
    else rows = await sql`UPDATE meeting_watch_state SET source = ${update.source}, playing = ${update.playing}, position = ${update.position}, revision = revision + 1, updated_at = NOW() WHERE meeting_id = ${meeting.id} AND revision = ${update.baseVersion} RETURNING source, playing, position, revision, updated_at`;
    if (!rows[0]) throw new Error('This Watch Together update is out of date. Refreshing the current state.');
    return publicWatchState(rows[0]);
  }
  return queueMeetingWrite(meeting.id, async () => {
    const latestStore = await readStore(); const latestMeeting = latestStore.meetings[meeting.id];
    if (!latestMeeting || isEnded(latestMeeting) || isExpired(latestMeeting)) throw new Error('This meeting is no longer available.');
    const current = latestMeeting.watchState || null; const currentVersion = current?.version || 0;
    if (update.baseVersion !== currentVersion) throw new Error('This Watch Together update is out of date. Refreshing the current state.');
    const value = { source: update.source, playing: update.playing, position: update.position, version: currentVersion + 1, updatedAt: nowIso() };
    latestMeeting.watchState = value; await writeStore(latestStore); return value;
  });
}
function chatAllowed(session) { const now = Date.now(); const key = session.id; const bucket = chatRateBuckets.get(key); const fresh = !bucket || bucket.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : bucket; fresh.count += 1; chatRateBuckets.set(key, fresh); if (chatRateBuckets.size > 10_000) for (const [entry, value] of chatRateBuckets) if (value.resetAt <= now) chatRateBuckets.delete(entry); return fresh.count <= 30; }
function publicMessage(message, session) { return { id: message.id, body: message.body, createdAt: message.createdAt, sender: { id: message.senderId, name: message.senderName }, recipientId: message.recipientId || null, isSelf: message.senderId === session.id }; }
async function chatRecipients(meeting) { return (await activeSessions(meeting)).filter(item => item.status === 'approved'); }
async function createChatMessage(store, meeting, sender, input) {
  const text = cleanMessage(input.text); if (!text) throw new Error('Enter a message before sending.');
  if (typeof input.text !== 'string' || input.text.length > 2000) throw new Error('Messages can contain up to 2,000 characters.');
  const recipientId = input.recipientId || null; const recipients = await chatRecipients(meeting);
  if (recipientId && (!recipients.some(item => item.id === recipientId) || recipientId === sender.id)) throw new Error('That participant is not available for a direct message.');
  const clientMessageId = typeof input.clientMessageId === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(input.clientMessageId) ? input.clientMessageId : null;
  if (input.clientMessageId && !clientMessageId) throw new Error('Invalid message request.');
  if (sql) {
    if (clientMessageId) { const existing = await sql`SELECT m.id, m.body, m.created_at, m.sender_id, m.recipient_id, s.display_name FROM meeting_messages m JOIN meeting_sessions s ON s.id = m.sender_id WHERE m.sender_id = ${sender.id} AND m.client_message_id = ${clientMessageId}`; if (existing[0]) return { id: existing[0].id, body: existing[0].body, createdAt: asIso(existing[0].created_at), senderId: existing[0].sender_id, senderName: existing[0].display_name, recipientId: existing[0].recipient_id }; }
    const message = { id: randomUUID(), body: text, createdAt: nowIso(), senderId: sender.id, senderName: sender.name, recipientId, clientMessageId };
    await sql`INSERT INTO meeting_messages (id, meeting_id, sender_id, recipient_id, body, client_message_id, created_at) VALUES (${message.id}, ${meeting.id}, ${message.senderId}, ${message.recipientId}, ${message.body}, ${message.clientMessageId}, ${message.createdAt})`; return message;
  }
  meeting.messages ??= []; const existing = clientMessageId && meeting.messages.find(item => item.senderId === sender.id && item.clientMessageId === clientMessageId); if (existing) return existing;
  const message = { id: randomUUID(), body: text, createdAt: nowIso(), senderId: sender.id, senderName: sender.name, recipientId, clientMessageId }; meeting.messages.push(message); await writeStore(store); return message;
}
async function listChatMessages(meeting, session, recipientId) {
  const recipients = await chatRecipients(meeting);
  if (recipientId && (!recipients.some(item => item.id === recipientId) || recipientId === session.id)) throw new Error('That conversation is not available.');
  if (sql) { const rows = recipientId ? await sql`SELECT m.id, m.body, m.created_at, m.sender_id, m.recipient_id, s.display_name FROM meeting_messages m JOIN meeting_sessions s ON s.id = m.sender_id WHERE m.meeting_id = ${meeting.id} AND ((m.sender_id = ${session.id} AND m.recipient_id = ${recipientId}) OR (m.sender_id = ${recipientId} AND m.recipient_id = ${session.id})) ORDER BY m.created_at ASC LIMIT 200` : await sql`SELECT m.id, m.body, m.created_at, m.sender_id, m.recipient_id, s.display_name FROM meeting_messages m JOIN meeting_sessions s ON s.id = m.sender_id WHERE m.meeting_id = ${meeting.id} AND m.recipient_id IS NULL ORDER BY m.created_at ASC LIMIT 200`; return rows.map(row => ({ id: row.id, body: row.body, createdAt: asIso(row.created_at), senderId: row.sender_id, senderName: row.display_name, recipientId: row.recipient_id })); }
  return (meeting.messages || []).filter(item => recipientId ? ((item.senderId === session.id && item.recipientId === recipientId) || (item.senderId === recipientId && item.recipientId === session.id)) : !item.recipientId).slice(-200);
}

async function endMeeting(store, meeting) {
  if (sql) { await sql`UPDATE meetings SET ended_at = COALESCE(ended_at, NOW()) WHERE id = ${meeting.id}`; await sql`DELETE FROM meeting_sessions WHERE meeting_id = ${meeting.id}`; }
  else { meeting.endedAt = nowIso(); meeting.sessions = []; await writeStore(store); }
  await closeLiveKitRoom(meeting.id);
}

function json(res, status, value) { setSecurityHeaders(res); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
async function body(req) { let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 10_000) throw new Error('Request body is too large.'); } try { return JSON.parse(text || '{}'); } catch { throw new Error('Invalid JSON body.'); } }
const publicRequestErrors = new Set([
  'Enter a valid Watch Together update.',
  'This Watch Together update is out of date. Refreshing the current state.',
  'This meeting is no longer available.',
  'Enter a message before sending.',
  'Messages can contain up to 2,000 characters.',
  'That participant is not available for a direct message.',
  'Invalid message request.',
  'That conversation is not available.',
  'Request body is too large.',
  'Invalid JSON body.',
  'Telegram is not configured on this VYNQ server yet.',
  'Telegram identity could not be verified.',
  'Telegram sign-in has expired. Please reopen VYNQ from Telegram.',
  'Telegram did not provide a valid user identity.'
]);
function publicRequestError(error) { return error instanceof Error && publicRequestErrors.has(error.message) ? error.message : null; }
function telegramIdentity(initData) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN; if (!botToken) throw new Error('Telegram is not configured on this VYNQ server yet.');
  const params = new URLSearchParams(initData || ''); const hash = params.get('hash'); params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest(); const calculated = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!safeEqual(calculated, hash)) throw new Error('Telegram identity could not be verified.');
  const authDate = Number(params.get('auth_date')); const authTime = authDate * 1000; if (!Number.isFinite(authDate) || authTime < Date.now() - oneDay || authTime > Date.now() + 5 * 60_000) throw new Error('Telegram sign-in has expired. Please reopen VYNQ from Telegram.');
  try { const user = JSON.parse(params.get('user')); if (!user?.id) throw new Error(); return user; } catch { throw new Error('Telegram did not provide a valid user identity.'); }
}

function telegramWebAppUrl() {
  try { const url = new URL(process.env.TELEGRAM_WEB_APP_URL || ''); return url.protocol === 'https:' ? url.toString().replace(/\/$/, '') : null; } catch { return null; }
}
function telegramBotUsername() { const username = cleanText(process.env.TELEGRAM_BOT_USERNAME || '', 32).replace(/^@/, ''); return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username) ? username : null; }
function telegramBotDeepLink(meetingId) { const username = telegramBotUsername(); return username && validMeetingId(meetingId) ? `https://t.me/${username}?start=join_${meetingId}` : null; }
function validMeetingId(value) { return /^VYNQ-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value); }
function normaliseMeetingReference(value) {
  const text = cleanText(value, 300); const hashMatch = text.match(/#\/room\/(VYNQ-[A-Z0-9-]+)/i); const raw = (hashMatch?.[1] || text).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^VYNQ[A-Z0-9]{12}$/.test(raw)) return null;
  const id = `VYNQ-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`; return validMeetingId(id) ? id : null;
}
function meetingBrowserUrl(meetingId) { const base = telegramWebAppUrl(); return base && validMeetingId(meetingId) ? `${base}#/room/${meetingId}` : null; }
async function telegramSendMessage(chatId, text, replyMarkup) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN; if (!botToken || !chatId) return false;
  try {
    const base = (process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org').replace(/\/$/, '');
    const response = await fetch(`${base}/bot${botToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }), signal: AbortSignal.timeout(5_000) });
    if (!response.ok) { console.warn(JSON.stringify({ event: 'telegram_send_failed', status: response.status })); return false; }
    return true;
  } catch { console.warn(JSON.stringify({ event: 'telegram_send_failed' })); return false; }
}
async function telegramMeetingAvailable(meetingId) { const [, meeting] = await getMeeting(meetingId); return Boolean(meeting && !isExpired(meeting) && !isEnded(meeting)); }
async function respondToBotCommand(message) {
  const chatId = message?.chat?.id; const text = typeof message?.text === 'string' ? message.text.trim() : ''; if (!chatId || !text || text.length > 512 || !botRateAllowed(String(chatId))) return;
  const [commandWithBot, ...parts] = text.split(/\s+/); const command = commandWithBot.toLowerCase().split('@')[0]; const argument = parts.join(' ');
  const webAppUrl = telegramWebAppUrl(); const botUsername = telegramBotUsername(); const openApp = webAppUrl ? { inline_keyboard: [[{ text: 'Open VYNQ', web_app: { url: webAppUrl } }]] } : undefined;
  if (command === '/start') {
    const meetingId = argument.startsWith('join_') ? normaliseMeetingReference(argument.slice(5)) : null;
    if (meetingId && await telegramMeetingAvailable(meetingId)) { const url = meetingBrowserUrl(meetingId); return telegramSendMessage(chatId, 'Open the meeting in your browser. The host will need to admit you before you can enter.', url ? { inline_keyboard: [[{ text: 'Join meeting', url }]] } : undefined); }
    return telegramSendMessage(chatId, `Welcome to VYNQ${botUsername ? ` via @${botUsername}` : ''}. Use /newmeeting to open the secure browser creation flow, or /join followed by a meeting link or code. Guests can join from any browser and are admitted by the host.`, openApp);
  }
  if (command === '/help') return telegramSendMessage(chatId, 'Commands:\n/newmeeting — open VYNQ to create a meeting\n/join <link or VYNQ code> — open a meeting in your browser\n/start — welcome and help\n\nMeeting links never contain host or media credentials. Guests still wait for host admission.', openApp);
  if (command === '/newmeeting') return telegramSendMessage(chatId, 'Open VYNQ to choose your name and create a meeting. This bot never creates a host session for you.', webAppUrl ? { inline_keyboard: [[{ text: 'Create meeting in VYNQ', web_app: { url: webAppUrl } }]] } : undefined);
  if (command === '/join') {
    const meetingId = normaliseMeetingReference(argument);
    if (!meetingId) return telegramSendMessage(chatId, 'Send /join followed by a VYNQ meeting code or invitation link, for example: /join VYNQ-AB12-CD34-EF56');
    if (!await telegramMeetingAvailable(meetingId)) return telegramSendMessage(chatId, 'That meeting link is invalid, expired, or has ended. Ask the host for a new invitation.');
    const url = meetingBrowserUrl(meetingId); return telegramSendMessage(chatId, 'Open the meeting in your browser. You will enter the waiting room until the host admits you.', url ? { inline_keyboard: [[{ text: 'Join meeting', url }]] } : undefined);
  }
  return telegramSendMessage(chatId, 'I do not recognise that command. Send /help to see the available VYNQ commands.', openApp);
}

function sessionResponse(meeting, session) { return { meeting: publicMeeting(meeting), session: { token: session.token, name: session.name, role: session.role, status: session.status, presence: presenceOf(session) } }; }
async function joinMeeting(req, res, meetingId, name, telegramUser, localWriteLocked = false) {
  if (!validName(name)) return json(res, 400, { error: 'Please enter a name between 2 and 50 characters.' });
  if (!sql && !localWriteLocked) return queueMeetingWrite(meetingId, () => joinMeeting(req, res, meetingId, name, telegramUser, true));
  const [store, meeting] = await getMeeting(meetingId); if (unavailable(res, meeting)) return;
  const reuseToken = req.headers['x-vynq-session'];
  const reusable = sql
    ? await sessionByToken(meeting.id, reuseToken, true)
    : meeting.sessions.find(item => item.role === 'guest' && safeEqual(item.token, reuseToken) && isFresh(item)) || null;
  if (reusable) { await touchSession(store, meeting, reusable, reusable.status === 'waiting' ? 'waiting' : 'connecting'); return json(res, 200, { ...sessionResponse(meeting, { ...reusable, token: reuseToken }), reused: true }); }
  if (!await meetingHasCapacity(meeting)) return json(res, 403, { error: `This meeting has reached its ${maxParticipants}-person limit.` });
  let session;
  if (sql) session = await dbCreateSession(meeting.id, name, 'guest', telegramUser?.id);
  else { const joinedAt = nowIso(); session = { id: randomUUID(), name, role: 'guest', status: 'waiting', token: token(), joinedAt, lastSeenAt: joinedAt, presenceState: 'waiting', telegramUserId: telegramUser?.id || null }; meeting.sessions.push(session); await writeStore(store); }
  return json(res, 200, sessionResponse(meeting, session));
}

export async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const startedAt = Date.now(); res.once('finish', () => console.log(JSON.stringify({ event: 'http_request', method: req.method, path: url.pathname, status: res.statusCode, durationMs: Date.now() - startedAt })));
  try {
    if (url.pathname.startsWith('/api/')) { await cleanupExpired(); await cleanupStalePresence(); const strict = req.method === 'POST' && (url.pathname === '/api/meetings' || url.pathname.endsWith('/join') || url.pathname === '/api/telegram/meetings'); if (!rateAllowed(req, strict ? 12 : 120)) return json(res, 429, { error: 'Too many requests. Please try again shortly.' }); }
    if (req.method === 'POST' && url.pathname === '/api/meetings') {
      const input = await body(req); const title = cleanText(input.title, 80) || 'Untitled meeting'; const hostName = cleanText(input.hostName, 50);
      if (!validName(hostName)) return json(res, 400, { error: 'Please enter a name between 2 and 50 characters.' });
      const { meeting, session } = await createMeeting(title, hostName); return json(res, 201, sessionResponse(meeting, session));
    }
    if (req.method === 'POST' && url.pathname === '/api/telegram/meetings') {
      const input = await body(req); telegramIdentity(input.initData); return json(res, 403, { error: 'Create meetings through the VYNQ browser form so you can choose the authorized host session.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/telegram/join') { const input = await body(req); const telegramUser = telegramIdentity(input.initData); const meetingId = cleanText(input.meetingId, 32).toUpperCase(); const hostName = cleanText(`${telegramUser.first_name || ''} ${telegramUser.last_name || ''}`, 50) || `Telegram ${telegramUser.id}`; return joinMeeting(req, res, meetingId, hostName, telegramUser); }
    if (req.method === 'POST' && url.pathname === '/api/telegram/webhook') {
      const secret = process.env.TELEGRAM_WEBHOOK_SECRET; if (!secret || !safeEqual(secret, req.headers['x-telegram-bot-api-secret-token'])) return json(res, 401, { error: 'Invalid Telegram webhook secret.' });
      const update = await body(req); await respondToBotCommand(update.message);
      return json(res, 200, { ok: true });
    }
    const joinMatch = url.pathname.match(/^\/api\/meetings\/(VYNQ-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\/join$/);
    if (req.method === 'POST' && joinMatch) { const input = await body(req); return joinMeeting(req, res, joinMatch[1], cleanText(input.name, 50)); }
    const heartbeatMatch = url.pathname.match(/^\/api\/meetings\/(VYNQ-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\/heartbeat$/);
    if (req.method === 'POST' && heartbeatMatch) { const [store, meeting, session] = await requireSession(req, heartbeatMatch[1]); if (unavailable(res, meeting)) return; if (!session) return json(res, 401, { error: 'A valid active meeting session is required.' }); const input = await body(req); await touchSession(store, meeting, session, input.presence); return json(res, 200, { meeting: publicMeeting(meeting), participant: publicSession(session, session.id) }); }
    const detailMatch = url.pathname.match(/^\/api\/meetings\/(VYNQ-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})$/);
    const telegramInviteMatch = url.pathname.match(/^\/api\/meetings\/(VYNQ-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\/telegram-invite$/);
    const participantsMatch = url.pathname.match(/^\/api\/meetings\/(VYNQ-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\/participants$/);
    const messagesMatch = url.pathname.match(/^\/api\/meetings\/(VYNQ-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\/messages$/);
    const leaveMatch = url.pathname.match(/^\/api\/meetings\/(VYNQ-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\/leave$/);
    if (req.method === 'POST' && leaveMatch) { const [store, meeting, session] = await requireSession(req, leaveMatch[1]); if (unavailable(res, meeting)) return; if (!session) return json(res, 401, { error: 'A valid active meeting session is required.' }); if (session.role === 'host') await endMeeting(store, meeting); else if (sql) await sql`DELETE FROM meeting_sessions WHERE id = ${session.id} AND meeting_id = ${meeting.id}`; else { meeting.sessions = meeting.sessions.filter(item => item.id !== session.id); await writeStore(store); } return json(res, 200, { ok: true, ended: session.role === 'host' }); }
    if (req.method === 'GET' && participantsMatch) { const [store, meeting, session] = await requireSession(req, participantsMatch[1]); if (unavailable(res, meeting)) return; if (!session) return json(res, 403, { error: 'A valid active meeting session is required.' }); await touchSession(store, meeting, session, presenceOf(session)); const sessions = await activeSessions(meeting); const visible = session.role === 'host' ? sessions : sessions.filter(item => item.status === 'approved'); return json(res, 200, { participants: visible.map(item => publicSession(item, session.id)) }); }
    if (messagesMatch && (req.method === 'GET' || req.method === 'POST')) { const [store, meeting, session] = await requireSession(req, messagesMatch[1]); if (unavailable(res, meeting)) return; if (!session || session.status !== 'approved') return json(res, 403, { error: 'You must be admitted to use meeting chat.' }); await touchSession(store, meeting, session, presenceOf(session)); const recipientId = req.method === 'GET' ? url.searchParams.get('recipient') : null; if (req.method === 'GET') { const messages = await listChatMessages(meeting, session, recipientId); return json(res, 200, { messages: messages.map(message => publicMessage(message, session)) }); } if (!chatAllowed(session)) return json(res, 429, { error: 'You are sending messages too quickly. Please wait a moment.' }); const message = await createChatMessage(store, meeting, session, await body(req)); return json(res, 201, { message: publicMessage(message, session) }); }
    const participantActionMatch = url.pathname.match(/^\/api\/meetings\/(VYNQ-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\/participants\/([^/]+)\/(admit|remove)$/);
    if (req.method === 'POST' && participantActionMatch) {
      const [, meetingId, participantId, action] = participantActionMatch; const [store, meeting, session] = await requireSession(req, meetingId); if (unavailable(res, meeting)) return; if (!session || session.role !== 'host') return json(res, 403, { error: 'Host permission is required.' }); await touchSession(store, meeting, session, presenceOf(session));
      if (sql) { if (action === 'admit') await sql`UPDATE meeting_sessions SET status = 'approved', presence_state = 'connecting', last_seen_at = NOW() WHERE id = ${participantId} AND meeting_id = ${meetingId} AND role = 'guest' AND last_seen_at > ${staleCutoff()}`; else await sql`DELETE FROM meeting_sessions WHERE id = ${participantId} AND meeting_id = ${meetingId} AND role = 'guest'`; }
      else { const target = meeting.sessions.find(item => item.id === participantId && item.role === 'guest' && isFresh(item)); if (target && action === 'admit') { target.status = 'approved'; target.presenceState = 'connecting'; target.lastSeenAt = nowIso(); } else if (target) meeting.sessions = meeting.sessions.filter(item => item.id !== participantId); await writeStore(store); }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && detailMatch) { const [store, meeting, session] = await requireSession(req, detailMatch[1]); if (unavailable(res, meeting)) return; if (!session) return json(res, 401, { error: 'A valid active meeting session is required.' }); await touchSession(store, meeting, session, presenceOf(session)); return json(res, 200, { meeting: publicMeeting(meeting), participant: publicSession(session, session.id) }); }
    if (req.method === 'GET' && telegramInviteMatch) { const [store, meeting, session] = await requireSession(req, telegramInviteMatch[1]); if (unavailable(res, meeting)) return; if (!session || session.role !== 'host') return json(res, 403, { error: 'Host permission is required.' }); const botLink = telegramBotDeepLink(meeting.id); if (!botLink) return json(res, 503, { error: 'Telegram sharing is not configured on this VYNQ server yet.' }); return json(res, 200, { botLink }); }
    const watchMatch = url.pathname.match(/^\/api\/meetings\/(VYNQ-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\/watch-state$/);
    if (watchMatch && (req.method === 'GET' || req.method === 'POST')) { const [store, meeting, session] = await requireSession(req, watchMatch[1]); if (unavailable(res, meeting)) return; if (!session || session.status !== 'approved') return json(res, 403, { error: 'You must be admitted to use Watch Together.' }); if (req.method === 'GET') return json(res, 200, { state: await watchState(meeting) }); if (session.role !== 'host') return json(res, 403, { error: 'Only the host can control Watch Together.' }); return json(res, 200, { state: await saveWatchState(store, meeting, await body(req)) }); }
    const tokenMatch = url.pathname.match(/^\/api\/meetings\/(VYNQ-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\/livekit-token$/);
    if (req.method === 'POST' && tokenMatch) { const [store, meeting, session] = await requireSession(req, tokenMatch[1]); if (unavailable(res, meeting)) return; if (!session) return json(res, 401, { error: 'A valid active meeting session is required.' }); if (session.status !== 'approved') return json(res, 403, { error: 'You are waiting for the host to admit you.' }); const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env; if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) return json(res, 503, { error: 'Live video is not configured on this VYNQ server yet.' }); await touchSession(store, meeting, session, 'connecting'); const sources = session.role === 'host' ? [TrackSource.CAMERA, TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] : [TrackSource.CAMERA, TrackSource.MICROPHONE]; const accessToken = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity: session.id, name: session.name, ttl: '10m', metadata: JSON.stringify({ meetingId: meeting.id, role: session.role }) }); accessToken.addGrant({ roomJoin: true, room: meeting.id, canPublish: true, canPublishSources: sources, canSubscribe: true, canPublishData: session.role === 'host' }); return json(res, 200, { url: LIVEKIT_URL, token: await accessToken.toJwt() }); }
    if (req.method === 'GET') { const requestPath = url.pathname === '/' ? '/index.html' : url.pathname; const file = normalize(join(root, requestPath)); if (!file.startsWith(root + '/') && file !== join(root, 'index.html')) return json(res, 403, { error: 'Forbidden' }); if (!existsSync(file)) return json(res, 404, { error: 'Not found' }); setSecurityHeaders(res); res.writeHead(200, { 'Content-Type': contentTypes[extname(file)] || 'application/octet-stream' }); return res.end(await readFile(file)); }
    json(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    const message = publicRequestError(error);
    if (message) return json(res, 400, { error: message });
    console.error(JSON.stringify({ event: 'request_failed', method: req.method, path: url.pathname, errorType: error instanceof Error ? error.name : 'unknown' }));
    return json(res, 500, { error: 'The service is temporarily unavailable. Please try again.' });
  }
}

if (process.argv[1]?.endsWith('vynq-server.mjs')) createServer(handleRequest).listen(port, () => console.log(`VYNQ is ready at http://localhost:${port}`));
