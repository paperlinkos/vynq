import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseGridLayout, nextLayout } from '../client/meeting-layout.js';

test('chooses balanced layouts from container dimensions and participant count', () => {
  assert.deepEqual(chooseGridLayout(2, 1200, 650), { columns: 2, rows: 1 });
  assert.deepEqual(chooseGridLayout(4, 1200, 650), { columns: 2, rows: 2 });
  assert.deepEqual(chooseGridLayout(6, 1200, 650), { columns: 3, rows: 2 });
  assert.equal(chooseGridLayout(9, 1200, 650).columns, 3);
});

test('keeps layout selection valid across participant changes', () => {
  assert.equal(nextLayout('speaker', 'focus'), 'focus');
  assert.equal(nextLayout('speaker', 'not-a-layout'), 'speaker');
});
