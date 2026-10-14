import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeetingId, normaliseMeetingId } from '../client/meeting-id.js';

test('creates a shareable VYNQ meeting id', () => {
  assert.match(createMeetingId(() => 0), /^VYNQ-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
});

test('normalises a valid formatted or compact code', () => {
  assert.equal(normaliseMeetingId('vynq ab12 cd34 ef56'), 'VYNQ-AB12-CD34-EF56');
  assert.equal(normaliseMeetingId('VYNQAB12CD34EF56'), 'VYNQ-AB12-CD34-EF56');
});

test('rejects an invalid meeting id', () => {
  assert.equal(normaliseMeetingId('VYNQ-nope'), null);
});
