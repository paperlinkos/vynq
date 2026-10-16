import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server; let baseUrl; let dataDir;

async function listen(instance) { await new Promise((resolve, reject) => { instance.once('error', reject); instance.listen(0, '127.0.0.1', resolve); }); return instance.address().port; }
async function api(path, { method = 'GET', body, forwardedFor, token } = {}) { const hasBody = body !== undefined; const response = await fetch(`${baseUrl}${path}`, { method, headers: { ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}), ...(token ? { 'X-VYNQ-Session': token } : {}) }, body: hasBody ? JSON.stringify(body) : undefined }); return { status: response.status, body: await response.json() }; }
function signedFutureInitData() { const params = new URLSearchParams({ auth_date: String(Math.floor((Date.now() + 10 * 60_000) / 1000)), user: JSON.stringify({ id: 1, first_name: 'Future' }) }); const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n'); const secret = createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest(); params.set('hash', createHmac('sha256', secret).update(check).digest('hex')); return params.toString(); }

try {
  dataDir = await mkdtemp(join(tmpdir(), 'vynq-security-'));
  Object.assign(process.env, { VYNQ_DATA_DIR: dataDir, TELEGRAM_BOT_TOKEN: 'security-test-token', LIVEKIT_URL: 'wss://livekit.example.test' });
  const { handleRequest } = await import('../lib/vynq-server.mjs'); server = createServer(handleRequest); const port = await listen(server); baseUrl = `http://127.0.0.1:${port}`;

  const vercelConfig = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const staticHeaders = Object.fromEntries(vercelConfig.headers[0].headers.map(header => [header.key.toLowerCase(), header.value]));
  assert.match(staticHeaders['content-security-policy'], /default-src 'self'/);
  assert.equal(staticHeaders['x-content-type-options'], 'nosniff');

  const home = await fetch(`${baseUrl}/`); const csp = home.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'self'/); assert.match(csp, /object-src 'none'/); assert.match(csp, /connect-src 'self' wss:\/\/livekit\.example\.test/); assert.equal(home.headers.get('access-control-allow-origin'), null);

  const future = await api('/api/telegram/join', { method: 'POST', body: { meetingId: 'VYNQ-AB12-CD34-EF56', initData: signedFutureInitData() } });
  assert.equal(future.status, 400); assert.match(future.body.error, /expired/);

  const created = await api('/api/meetings', { method: 'POST', forwardedFor: '198.51.100.250', body: { title: 'Error handling', hostName: 'Host User' } });
  assert.equal(created.status, 201);
  const internalFailure = await api(`/api/meetings/${created.body.meeting.id}/messages`, { method: 'POST', token: created.body.session.token, body: null });
  assert.equal(internalFailure.status, 500);
  assert.equal(internalFailure.body.error, 'The service is temporarily unavailable. Please try again.');

  const attempts = await Promise.all([...Array(11)].map((_, index) => api('/api/meetings', {
    method: 'POST', forwardedFor: `198.51.100.${index + 1}`, body: { title: 'Rate test', hostName: 'x' }
  })));
  attempts.forEach(result => assert.equal(result.status, 400));
  const blocked = await api('/api/meetings', { method: 'POST', forwardedFor: '203.0.113.1', body: { title: 'Rate test', hostName: 'x' } });
  assert.equal(blocked.status, 429);
  console.log('✓ security hardening checks passed');
} finally {
  await new Promise(resolve => server?.close(resolve) || resolve());
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}
