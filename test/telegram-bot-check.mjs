import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server; let telegramMock; let baseUrl; let telegramBase; let dataDir; let failTelegram = false; const telegramRequests = [];

async function listen(server) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); return server.address().port; }
async function api(path, { method = 'GET', token, body, secret } = {}) { const response = await fetch(`${baseUrl}${path}`, { method, headers: { ...(token ? { 'X-VYNQ-Session': token } : {}), ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: response.status, body: await response.json() }; }
function signedInitData(user = { id: 12345, first_name: 'Spoof Test' }) { const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) }); const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n'); const secret = createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest(); params.set('hash', createHmac('sha256', secret).update(check).digest('hex')); return params.toString(); }
function lastTelegramMessage() { return telegramRequests.at(-1)?.body; }
async function webhook(text) { return api('/api/telegram/webhook', { method: 'POST', secret: process.env.TELEGRAM_WEBHOOK_SECRET, body: { update_id: Date.now(), message: { message_id: 1, chat: { id: 9001 }, from: { id: 9001, username: 'not_authority' }, text } } }); }

try {
  telegramMock = createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; telegramRequests.push({ path: req.url, body: JSON.parse(raw || '{}') }); res.writeHead(failTelegram ? 500 : 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: !failTelegram })); });
  const mockPort = await listen(telegramMock); telegramBase = `http://127.0.0.1:${mockPort}`;
  dataDir = await mkdtemp(join(tmpdir(), 'vynq-telegram-'));
  Object.assign(process.env, { VYNQ_DATA_DIR: dataDir, TELEGRAM_BOT_TOKEN: 'telegram-test-token', TELEGRAM_WEBHOOK_SECRET: 'telegram-test-secret', TELEGRAM_WEB_APP_URL: 'https://vynq.test', TELEGRAM_BOT_USERNAME: 'VynqTestBot', TELEGRAM_API_BASE_URL: telegramBase });
  const { handleRequest } = await import('../lib/vynq-server.mjs');
  server = createServer(handleRequest); const port = await listen(server); baseUrl = `http://127.0.0.1:${port}`;

  const host = await api('/api/meetings', { method: 'POST', body: { title: 'Telegram test', hostName: 'Browser Host' } }); assert.equal(host.status, 201);
  const id = host.body.meeting.id; const hostToken = host.body.session.token;
  const hostInvite = await api(`/api/meetings/${id}/telegram-invite`, { token: hostToken }); assert.equal(hostInvite.status, 200); assert.equal(hostInvite.body.botLink, `https://t.me/VynqTestBot?start=join_${id}`);

  assert.equal((await webhook('/start')).status, 200); assert.match(lastTelegramMessage().text, /Welcome to VYNQ/);
  assert.equal((await webhook('/help')).status, 200); assert.match(lastTelegramMessage().text, /\/newmeeting/);
  assert.equal((await webhook('/newmeeting')).status, 200); assert.match(lastTelegramMessage().text, /never creates a host session/);
  assert.equal((await webhook(`/join ${id}`)).status, 200); assert.equal(lastTelegramMessage().reply_markup.inline_keyboard[0][0].url, `https://vynq.test#/room/${id}`);
  assert.equal((await webhook(`/start join_${id}`)).status, 200); assert.equal(lastTelegramMessage().reply_markup.inline_keyboard[0][0].url, `https://vynq.test#/room/${id}`);
  assert.equal((await webhook('/join invalid')).status, 200); assert.match(lastTelegramMessage().text, /followed by a VYNQ meeting code/);
  assert.equal((await webhook('/join ' + 'x'.repeat(600))).status, 200);
  assert.equal(telegramRequests.some(request => JSON.stringify(request.body).includes(hostToken)), false);
  assert.equal(telegramRequests.some(request => JSON.stringify(request.body).includes(process.env.TELEGRAM_BOT_TOKEN)), false);

  const spoof = await api('/api/telegram/meetings', { method: 'POST', body: { initData: signedInitData({ id: 777, username: 'host_spoof' }) } });
  assert.equal(spoof.status, 403); assert.match(spoof.body.error, /browser form/);
  assert.equal((await api('/api/telegram/meetings', { method: 'POST', body: { initData: 'user=spoofed' } })).status, 400);
  assert.equal((await api('/api/telegram/webhook', { method: 'POST', secret: 'wrong-secret', body: { message: { text: '/help' } } })).status, 401);

  const guest = await api(`/api/meetings/${id}/join`, { method: 'POST', body: { name: 'Browser Guest' } }); assert.equal(guest.status, 200); assert.equal(guest.body.session.status, 'waiting');
  assert.equal((await api(`/api/meetings/${id}/telegram-invite`, { token: guest.body.session.token })).status, 403);
  assert.equal((await api(`/api/meetings/${id}/leave`, { method: 'POST', token: hostToken })).status, 200);
  assert.equal((await webhook(`/join ${id}`)).status, 200); assert.match(lastTelegramMessage().text, /invalid, expired, or has ended/);

  failTelegram = true; assert.equal((await webhook('/help')).status, 200); failTelegram = false;
  console.log('✓ Telegram bot checks passed');
} finally {
  await new Promise(resolve => server?.close(resolve) || resolve());
  await new Promise(resolve => telegramMock?.close(resolve) || resolve());
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}
