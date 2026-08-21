import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransientError, pacing } from '../src/media/players.js';

test('a rate-limit refusal is a distinct, transient failure', () => {
  // The distinction is the whole fix: 216 players were marked 'error' — a permanent
  // state the backfill skips — when they had never actually been looked up.
  const e = new TransientError('429 Too Many Requests');
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'TransientError');
});

test('the pacer reports its current interval and throttle count', () => {
  const p = pacing();
  assert.ok(p.intervalMs >= 1, 'an interval must exist, or requests are unspaced');
  assert.equal(typeof p.throttled, 'number');
});
