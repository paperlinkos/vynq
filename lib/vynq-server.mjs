import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { neon } from '@neondatabase/serverless';

const appRoot = process.cwd();
const root = normalize(process.env.VYNQ_STATIC_DIR || appRoot);
const port = Number(process.env.PORT || 4173);
const dataDir = normalize(process.env.VYNQ_DATA_DIR || (process.env.VERCEL ? '/tmp/vynq-data' : join(appRoot, '.vynq-data')));
const dataFile = join(dataDir, 'meetings.json');
const meetingTtlHours = Number(process.env.VYNQ_MEETING_TTL_HOURS || 24);
const maxParticipants = Math.max(2, Math.min(100, Number(process.env.VYNQ_MAX_PARTICIPANTS || 25)));
const oneDay = 24 * 60 * 60 * 1000;
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
let schemaReady;
const rateBuckets = new Map();
let lastCleanup = 0;
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
await mkdir(dataDir, { recursive: true });
async function readStore() { if (!existsSync(dataFile)) return { meetings: {} }; try { return JSON.parse(await readFile(dataFile, 'utf8')); } catch { return { meetings: {} }; } }
async function writeStore(store) { await writeFile(dataFile, JSON.stringify(store, null, 2), 'utf8'); }
function setSecurityHeaders(res) { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=()'); res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); if (process.env.VERCEL) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains'); }
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim(); }
function rateAllowed(req, limit, windowMs = 60_000) { const now = Date.now(); const key = `${clientIp(req)}:${req.url}`; const bucket = rateBuckets.get(key); const fresh = !bucket || bucket.resetAt <= now ? { count: 0, resetAt: now + windowMs } : bucket; fresh.count += 1; rateBuckets.set(key, fresh); if (rateBuckets.size > 10_000) for (const [entry, value] of rateBuckets) if (value.resetAt <= now) rateBuckets.delete(entry); return fresh.count <= limit; }
async function cleanupExpired() { if (Date.now() - lastCleanup < 300_000) return; lastCleanup = Date.now(); if (sql) { await ensureSchema(); await sql`DELETE FROM meetings WHERE expires_at <= NOW()`; return; } const store = await readStore(); const before = Object.keys(store.meetings).length; for (const [id, meeting] of Object.entries(store.meetings)) if (isExpired(meeting)) delete store.meetings[id]; if (Object.keys(store.meetings).length !== before) await writeStore(store); }
async function ensureSchema() {
  if (!sql) return;
  schemaReady ??= (async () => {
    await sql`CREATE TABLE IF NOT EXISTS meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL)`;
    await sql`CREATE TABLE IF NOT EXISTS meeting_sessions (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, display_name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('host', 'guest')), status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('waiting', 'approved')), token_hash TEXT NOT NULL, joined_at TIMESTAMPTZ NOT NULL, telegram_user_id TEXT)`;
    await sql`ALTER TABLE meeting_sessions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved'`;
    await sql`CREATE INDEX IF NOT EXISTS meeting_sessions_lookup ON meeting_sessions (meeting_id, token_hash)`;
  })();
  return schemaReady;
}
function createId() { const raw = randomBytes(10).toString('hex').toUpperCase(); return `VYNQ-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`; }
function token() { return randomBytes(32).toString('base64url'); }
function hashToken(value) { return createHash('sha256').update(value || '').digest('hex'); }
function cleanText(value, limit) { return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, limit) : ''; }
function validName(value) { return value.length >= 2 && value.length <= 50; }
function isExpired(meeting) { return new Date(meeting.expiresAt).getTime() <= Date.now(); }
function publicMeeting(meeting) { return { id: meeting.id, title: meeting.title, createdAt: meeting.createdAt, expiresAt: meeting.expiresAt }; }
function safeEqual(a, b) { if (!a || !b || a.length !== b.length) return false; return timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function telegramIdentity(initData) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN; if (!botToken) throw new Error('Telegram is not configured on this VYNQ server yet.');
  const params = new URLSearchParams(initData || ''); const hash = params.get('hash'); params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest(); const calculated = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!safeEqual(calculated, hash)) throw new Error('Telegram identity could not be verified.');
  const authDate = Number(params.get('auth_date')); if (!Number.isFinite(authDate) || authDate * 1000 < Date.now() - oneDay) throw new Error('Telegram sign-in has expired. Please reopen VYNQ from Telegram.');
  try { const user = JSON.parse(params.get('user')); if (!user?.id) throw new Error(); return user; } catch { throw new Error('Telegram did not provide a valid user identity.'); }
}
function asIso(value) { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function meetingFromRow(row) { return row && { id: row.id, title: row.title, createdAt: asIso(row.created_at), expiresAt: asIso(row.expires_at) }; }
async function dbMeeting(id) { await ensureSchema(); const rows = await sql`SELECT id, title, created_at, expires_at FROM meetings WHERE id = ${id}`; return meetingFromRow(rows[0]); }
async function dbCreateSession(meetingId, name, role, telegramUserId, status = role === 'host' ? 'approved' : 'waiting') { const joinToken = token(); const session = { id: randomUUID(), name, role, status, token: joinToken, joinedAt: new Date().toISOString(), telegramUserId: telegramUserId ? String(telegramUserId) : null }; await sql`INSERT INTO meeting_sessions (id, meeting_id, display_name, role, status, token_hash, joined_at, telegram_user_id) VALUES (${session.id}, ${meetingId}, ${session.name}, ${session.role}, ${session.status}, ${hashToken(joinToken)}, ${session.joinedAt}, ${session.telegramUserId})`; return session; }
async function createMeeting(title, hostName, telegramUser) {
  if (sql) { await ensureSchema(); let meetingId; do { meetingId = createId(); } while (await dbMeeting(meetingId)); const createdAt = new Date().toISOString(); const meeting = { id: meetingId, title: title || 'Untitled meeting', createdAt, expiresAt: new Date(Date.now() + meetingTtlHours * 3600000).toISOString() }; await sql`INSERT INTO meetings (id, title, created_at, expires_at) VALUES (${meeting.id}, ${meeting.title}, ${meeting.createdAt}, ${meeting.expiresAt})`; const session = await dbCreateSession(meeting.id, hostName, 'host', telegramUser?.id); return { meeting, joinToken: session.token }; }
  const store = await readStore();
  let meetingId; do { meetingId = createId(); } while (store.meetings[meetingId]); const joinToken = token(); const createdAt = new Date().toISOString();
  const meeting = { id: meetingId, title: title || 'Untitled meeting', createdAt, expiresAt: new Date(Date.now() + meetingTtlHours * 3600000).toISOString(), sessions: [{ id: randomUUID(), name: hostName, role: 'host', status: 'approved', token: joinToken, joinedAt: createdAt, telegramUserId: telegramUser?.id || null }] };
  store.meetings[meetingId] = meeting; await writeStore(store); return { meeting, joinToken };
}
function json(res, status, value) { setSecurityHeaders(res); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
async function body(req) { let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 10_000) throw new Error('Request body is too large.'); } try { return JSON.parse(text || '{}'); } catch { throw new Error('Invalid JSON body.'); } }
async function getMeeting(id) { if (sql) return [null, await dbMeeting(id)]; const store = await readStore(); return [store, store.meetings[id]]; }
async function meetingHasCapacity(meeting) { if (sql) { const rows = await sql`SELECT COUNT(*)::int AS count FROM meeting_sessions WHERE meeting_id = ${meeting.id}`; return Number(rows[0]?.count || 0) < maxParticipants; } return meeting.sessions.length < maxParticipants; }
async function requireSession(req, id) { const [store, meeting] = await getMeeting(id); if (!meeting || isExpired(meeting)) return [null, null, null]; if (sql) { const rows = await sql`SELECT id, display_name, role, status FROM meeting_sessions WHERE meeting_id = ${id} AND token_hash = ${hashToken(req.headers['x-vynq-session'])}`; const row = rows[0]; return [null, meeting, row ? { id: row.id, name: row.display_name, role: row.role, status: row.status } : null]; } const session = meeting.sessions.find(item => safeEqual(item.token, req.headers['x-vynq-session'])); return [store, meeting, session || null]; }

export async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const startedAt = Date.now(); res.once('finish', () => console.log(JSON.stringify({ event: 'http_request', method: req.method, path: url.pathname, status: res.statusCode, durationMs: Date.now() - startedAt })));
  try {
    if (url.pathname.startsWith('/api/')) { await cleanupExpired(); const strict = req.method === 'POST' && (url.pathname === '/api/meetings' || url.pathname.endsWith('/join') || url.pathname === '/api/telegram/meetings'); if (!rateAllowed(req, strict ? 12 : 120)) return json(res, 429, { error: 'Too many requests. Please try again shortly.' }); }
    if (req.method === 'POST' && url.pathname === '/api/meetings') {
      const input = await body(req); const title = cleanText(input.title, 80) || 'Untitled meeting'; const hostName = cleanText(input.hostName, 50);
      if (!validName(hostName)) return json(res, 400, { error: 'Please enter a name between 2 and 50 characters.' });
      const { meeting, joinToken } = await createMeeting(title, hostName); return json(res, 201, { meeting: publicMeeting(meeting), session: { token: joinToken, name: hostName, role: 'host' } });
    }
    if (req.method === 'POST' && url.pathname === '/api/telegram/meetings') {
      const input = await body(req); const telegramUser = telegramIdentity(input.initData); const hostName = cleanText(`${telegramUser.first_name || ''} ${telegramUser.last_name || ''}`, 50) || `Telegram ${telegramUser.id}`; const title = cleanText(input.title, 80) || 'Untitled meeting';
      const { meeting, joinToken } = await createMeeting(title, hostName, telegramUser); return json(res, 201, { meeting: publicMeeting(meeting), session: { token: joinToken, name: hostName, role: 'host' }, telegram: { id: telegramUser.id } });
    }
    if (req.method === 'POST' && url.pathname === '/api/telegram/join') {
      const input = await body(req); const telegramUser = telegramIdentity(input.initData); const meetingId = cleanText(input.meetingId, 32).toUpperCase(); const hostName = cleanText(`${telegramUser.first_name || ''} ${telegramUser.last_name || ''}`, 50) || `Telegram ${telegramUser.id}`;
      const [store, meeting] = await getMeeting(meetingId); if (!meeting) return json(res, 404, { error: 'This meeting does not exist.' }); if (isExpired(meeting)) return json(res, 410, { error: 'This meeting has expired.' }); if (!await meetingHasCapacity(meeting)) return json(res, 403, { error: `This meeting has reached its ${maxParticipants}-person limit.` });
      if (sql) { const session = await dbCreateSession(meetingId, hostName, 'guest', telegramUser.id); return json(res, 200, { meeting: publicMeeting(meeting), session: { token: session.token, name: hostName, role: 'guest', status: session.status }, telegram: { id: telegramUser.id } }); }
      const joinToken = token(); meeting.sessions.push({ id: randomUUID(), name: hostName, role: 'guest', status: 'waiting', token: joinToken, joinedAt: new Date().toISOString(), telegramUserId: telegramUser.id }); await writeStore(store); return json(res, 200, { meeting: publicMeeting(meeting), session: { token: joinToken, name: hostName, role: 'guest', status: 'waiting' }, telegram: { id: telegramUser.id } });
    }
    if (req.method === 'POST' && url.pathname === '/api/telegram/webhook') {
      const secret = process.env.TELEGRAM_WEBHOOK_SECRET; if (!secret || !safeEqual(secret, req.headers['x-telegram-bot-api-secret-token'])) return json(res, 401, { error: 'Invalid Telegram webhook secret.' });
      const update = await body(req); const message = update.message; if (message?.text?.startsWith('/start')) { const botToken = process.env.TELEGRAM_BOT_TOKEN; const webAppUrl = process.env.TELEGRAM_WEB_APP_URL; if (botToken && webAppUrl) await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: message.chat.id, text: 'Open VYNQ to create or join a meeting.', reply_markup: { inline_keyboard: [[{ text: 'Open VYNQ', web_app: { url: webAppUrl } }]] } }) }); }
      return json(res, 200, { ok: true });
    }
    const joinMatch = url.pathname.match(/^\/api\/meetings\/(VYNQ-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\/join$/);
    if (req.method === 'POST' && joinMatch) {
      const input = await body(req); const name = cleanText(input.name, 50); if (!validName(name)) return json(res, 400, { error: 'Please enter a name between 2 and 50 characters.' });
      const [store, meeting] = await getMeeting(joinMatch[1]); if (!meeting) return json(res, 404, { error: 'This meeting does not exist.' }); if (isExpired(meeting)) return json(res, 410, { error: 'This meeting has expired.' }); if (!await meetingHasCapacity(meeting)) return json(res, 403, { error: `This meeting has reached its ${maxParticipants}-person limit.` });
      if (sql) { const session = await dbCreateSession(meeting.id, name, 'guest'); return json(res, 200, { meeting: publicMeeting(meeting), session: { token: session.token, name, role: 'guest', status: session.status } }); }
      const joinToken = token(); meeting.sessions.push({ id: randomUUID(), name, role: 'guest', status: 'waiting', token: joinToken, joinedAt: new Date().toISOString() }); await writeStore(store); return json(res, 200, { meeting: publicMeeting(meeting), session: { token: joinToken, name, role: 'guest', status: 'waiting' } });
    }
    const detailMatch = url.pathname.match(/^\/api\/meetings\/(VYNQ-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})$/);
    const participantsMatch = url.pathname.match(/^\/api\/meetings\/(VYNQ-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\/participants$/);
    const leaveMatch = url.pathname.match(/^\/api\/meetings\/(VYNQ-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\/leave$/);
    if (req.method === 'POST' && leaveMatch) { const [store, meeting, session] = await requireSession(req, leaveMatch[1]); if (!meeting || !session) return json(res, 401, { error: 'A valid meeting session is required.' }); if (sql) await sql`DELETE FROM meeting_sessions WHERE id = ${session.id} AND meeting_id = ${meeting.id}`; else { meeting.sessions = meeting.sessions.filter(item => item.id !== session.id); await writeStore(store); } return json(res, 200, { ok: true }); }
    if (req.method === 'GET' && participantsMatch) { const [store, meeting, session] = await requireSession(req, participantsMatch[1]); if (!meeting || !session) return json(res, 403, { error: 'A valid meeting session is required.' }); if (sql) { const rows = await sql`SELECT id, display_name, role, status FROM meeting_sessions WHERE meeting_id = ${meeting.id} ORDER BY joined_at`; const visible = session.role === 'host' ? rows : rows.filter(row => row.status === 'approved'); return json(res, 200, { participants: visible.map(row => ({ id: row.id, name: row.display_name, role: row.role, status: row.status, isSelf: row.id === session.id })) }); } const visible = session.role === 'host' ? meeting.sessions : meeting.sessions.filter(item => (item.status || 'approved') === 'approved'); return json(res, 200, { participants: visible.map(item => ({ id: item.id, name: item.name, role: item.role, status: item.status || 'approved', isSelf: item.id === session.id })) }); }
    const participantActionMatch = url.pathname.match(/^\/api\/meetings\/(VYNQ-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\/participants\/([^/]+)\/(admit|remove)$/);
    if (req.method === 'POST' && participantActionMatch) { const [, meetingId, participantId, action] = participantActionMatch; const [store, meeting, session] = await requireSession(req, meetingId); if (!meeting || !session || session.role !== 'host') return json(res, 403, { error: 'Host permission is required.' }); if (sql) { if (action === 'admit') await sql`UPDATE meeting_sessions SET status = 'approved' WHERE id = ${participantId} AND meeting_id = ${meetingId} AND role = 'guest'`; else { const rows = await sql`SELECT id FROM meeting_sessions WHERE id = ${participantId} AND meeting_id = ${meetingId} AND role = 'guest'`; if (rows[0]) await sql`DELETE FROM meeting_sessions WHERE id = ${participantId}`; } } else { const target = meeting.sessions.find(item => item.id === participantId && item.role === 'guest'); if (target) { if (action === 'admit') target.status = 'approved'; else meeting.sessions = meeting.sessions.filter(item => item.id !== participantId); await writeStore(store); } } return json(res, 200, { ok: true }); }
    if (req.method === 'GET' && detailMatch) { const [, meeting, session] = await requireSession(req, detailMatch[1]); if (!meeting) return json(res, 404, { error: 'Meeting not found or expired.' }); if (!session) return json(res, 401, { error: 'A valid meeting session is required.' }); return json(res, 200, { meeting: publicMeeting(meeting), participant: { name: session.name, role: session.role, status: session.status } }); }
    const tokenMatch = url.pathname.match(/^\/api\/meetings\/(VYNQ-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\/livekit-token$/);
    if (req.method === 'POST' && tokenMatch) {
      const [, meeting, session] = await requireSession(req, tokenMatch[1]); if (!meeting) return json(res, 404, { error: 'Meeting not found or expired.' }); if (!session) return json(res, 401, { error: 'A valid meeting session is required.' }); if (session.status !== 'approved') return json(res, 403, { error: 'You are waiting for the host to admit you.' });
      const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
      if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) return json(res, 503, { error: 'Live video is not configured on this VYNQ server yet.' });
      const accessToken = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity: session.id, name: session.name, ttl: '10m', metadata: JSON.stringify({ meetingId: meeting.id, role: session.role }) });
      accessToken.addGrant({ roomJoin: true, room: meeting.id, canPublish: true, canSubscribe: true, canPublishData: session.role === 'host' });
      return json(res, 200, { url: LIVEKIT_URL, token: await accessToken.toJwt() });
    }
    if (req.method === 'GET') { const requestPath = url.pathname === '/' ? '/index.html' : url.pathname; const file = normalize(join(root, requestPath)); if (!file.startsWith(root + '/') && file !== join(root, 'index.html')) return json(res, 403, { error: 'Forbidden' }); if (!existsSync(file)) return json(res, 404, { error: 'Not found' }); setSecurityHeaders(res); res.writeHead(200, { 'Content-Type': contentTypes[extname(file)] || 'application/octet-stream' }); return res.end(await readFile(file)); }
    json(res, 405, { error: 'Method not allowed.' });
  } catch (error) { json(res, 400, { error: error.message || 'Invalid request.' }); }
}

if (process.argv[1]?.endsWith('vynq-server.mjs')) {
  createServer(handleRequest).listen(port, () => console.log(`VYNQ is ready at http://localhost:${port}`));
}
