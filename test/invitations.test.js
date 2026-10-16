import assert from 'node:assert/strict';
import test from 'node:test';
import { meetingInviteUrl, telegramShareUrl } from '../client/invitations.js';

test('creates a credential-free browser invitation URL', () => {
  const link = meetingInviteUrl({ origin: 'https://vynq.example', pathname: '/app' }, 'VYNQ-AB12-CD34-EF56');
  assert.equal(link, 'https://vynq.example/app#/room/VYNQ-AB12-CD34-EF56');
  assert.equal(link.includes('token='), false);
});

test('creates a Telegram share URL containing the browser invitation', () => {
  const invite = 'https://vynq.example/#/room/VYNQ-AB12-CD34-EF56';
  const share = telegramShareUrl(invite, 'Friday catch-up', 'https://t.me/VynqTestBot?start=join_VYNQ-AB12-CD34-EF56');
  assert.match(share, /^https:\/\/t\.me\/share\/url\?/);
  assert.match(decodeURIComponent(share), /VYNQ-AB12-CD34-EF56/);
  assert.match(decodeURIComponent(share), /t\.me\/VynqTestBot/);
});
