import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const moduleURL = new URL('../src/statusEmojiModel.ts', import.meta.url);
const now = Date.parse('2026-10-28T12:00:00Z');
test('status is empty by default; an active, known emoji with a finite future expiry is visible', () => {
  const { visibleStatusEmoji } = loadTs(moduleURL);
  assert.equal(visibleStatusEmoji({}, now), null);
  assert.equal(visibleStatusEmoji({ statusEmoji: '🎧', statusEmojiExpiresAt: '2026-10-28T12:01:00Z' }, now), '🎧');
  assert.equal(visibleStatusEmoji({ statusEmoji: 'Platina', statusEmojiExpiresAt: '2026-10-28T12:01:00Z' }, now), null);
});
test('expired, unknown and null expiry never keep a cached status visible', () => {
  const { visibleStatusEmoji } = loadTs(moduleURL);
  for (const expiry of [undefined, null, '', 'invalid', '2026-10-28T11:59:59Z', '2026-10-28T12:00:00Z']) assert.equal(visibleStatusEmoji({ statusEmoji: '✨', statusEmojiExpiresAt: expiry }, now), null);
});
test('expiry scheduling is bounded for native timers and stops when hidden', () => {
  const { statusEmojiRefreshDelay } = loadTs(moduleURL);
  assert.equal(statusEmojiRefreshDelay({ statusEmoji: '🌙', statusEmojiExpiresAt: '2026-10-28T12:01:00Z' }, now), 60_001);
  assert.equal(statusEmojiRefreshDelay({ statusEmoji: '🌙', statusEmojiExpiresAt: '2099-10-28T12:01:00Z' }, now), 2_147_483_647);
  assert.equal(statusEmojiRefreshDelay({ statusEmoji: '🌙', statusEmojiExpiresAt: '2026-10-28T12:00:00Z' }, now), null);
});

test('an explicitly permanent server status stays visible without an expiry timer', () => {
  const { visibleStatusEmoji, statusEmojiRefreshDelay } = loadTs(moduleURL);
  const permanent = { statusEmoji: '💎', statusEmojiExpiresAt: null, statusEmojiPermanent: true };
  assert.equal(visibleStatusEmoji(permanent, now), '💎');
  assert.equal(visibleStatusEmoji(permanent, Date.parse('2400-01-01T00:00:00Z')), '💎');
  assert.equal(statusEmojiRefreshDelay(permanent, now), null);
});

test('permanent status requires an exact true marker and a null expiry', () => {
  const { visibleStatusEmoji } = loadTs(moduleURL);
  for (const marker of [undefined, false, null, 'true', 1]) {
    assert.equal(visibleStatusEmoji({ statusEmoji: '💎', statusEmojiExpiresAt: null, statusEmojiPermanent: marker }, now), null);
  }
  for (const expiry of [undefined, '', 'invalid', '2026-10-28T12:01:00Z']) {
    assert.equal(visibleStatusEmoji({ statusEmoji: '💎', statusEmojiExpiresAt: expiry, statusEmojiPermanent: true }, now), null);
  }
});

test('a refreshed revoked status and an unknown emoji never inherit permanent visibility', () => {
  const { visibleStatusEmoji, statusEmojiRefreshDelay } = loadTs(moduleURL);
  const revoked = { statusEmoji: null, statusEmojiExpiresAt: null, statusEmojiPermanent: true };
  assert.equal(visibleStatusEmoji(revoked, now), null);
  assert.equal(statusEmojiRefreshDelay(revoked, now), null);
  assert.equal(visibleStatusEmoji({ statusEmoji: 'Platina', statusEmojiExpiresAt: null, statusEmojiPermanent: true }, now), null);
});
