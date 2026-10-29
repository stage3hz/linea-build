import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { platinaState, visibleStatus, isStatusEmoji } from '../src/entitlements.js';

const NOW = Date.UTC(2026, 9, 28);

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  // A deliberately unconstrained read fixture exercises defensive decoding of
  // unexpected stored rows, without weakening the real production schema.
  db.exec('CREATE TABLE platina_entitlements(user_id,source,granted_at,expires_at,revoked_at)');
  t.after(() => db.close());
  const set = (overrides = {}) => {
    db.exec('DELETE FROM platina_entitlements');
    const row = { source: 'admin', granted_at: NOW, expires_at: NOW + 60_000, revoked_at: null, ...overrides };
    db.prepare('INSERT INTO platina_entitlements VALUES(?,?,?,?,?)').run('account', row.source, row.granted_at, row.expires_at, row.revoked_at);
  };
  return { db, set };
}

test('entitlement absence, trusted time interval, exact expiry and revocation are derived from stored facts', t => {
  const { db, set } = fixture(t);
  assert.deepEqual(platinaState(db, 'account', NOW), { active: false, expiresAt: null });
  set();
  assert.deepEqual(platinaState(db, 'account', NOW), { active: true, expiresAt: new Date(NOW + 60_000).toISOString() });
  assert.equal(platinaState(db, 'account', NOW - 1).active, false);
  assert.equal(platinaState(db, 'account', NOW + 59_999).active, true);
  assert.equal(platinaState(db, 'account', NOW + 60_000).active, false);
  set({ revoked_at: NOW });
  assert.equal(platinaState(db, 'account', NOW).active, false);
});

test('malformed or untrusted stored entitlement rows fail closed without invalid-date exceptions', t => {
  const { db, set } = fixture(t);
  for (const override of [
    { source: 'client' }, { granted_at: 'not-a-time' }, { granted_at: 1.5 },
    { expires_at: 'not-a-time' }, { expires_at: 1.5 }, { expires_at: Infinity },
    { expires_at: NOW }, { expires_at: NOW - 1 }, { expires_at: 8_640_000_000_000_001 },
  ]) {
    set(override);
    assert.deepEqual(platinaState(db, 'account', NOW), { active: false, expiresAt: null });
  }
  set({ expires_at: 8_640_000_000_000_000 });
  assert.equal(platinaState(db, 'account', NOW).active, true);
});

test('public emoji needs an active grant and an exact allowed static choice', () => {
  const active = { active: true, expiresAt: new Date(NOW + 60_000).toISOString() };
  assert.deepEqual(visibleStatus({ status_emoji: '🎧' }, active), { statusEmoji: '🎧', statusEmojiExpiresAt: active.expiresAt });
  for (const user of [{}, { status_emoji: null }, { status_emoji: 'not-an-emoji' }]) {
    assert.deepEqual(visibleStatus(user, active), { statusEmoji: null, statusEmojiExpiresAt: null });
  }
  assert.deepEqual(visibleStatus({ status_emoji: '🎧' }, { ...active, active: false }), { statusEmoji: null, statusEmojiExpiresAt: null });
  assert.equal(isStatusEmoji('✨'), true);
  assert.equal(isStatusEmoji(42), false);
  assert.equal(isStatusEmoji('✨✨'), false);
});

test('a trusted null expiry is explicitly permanent, remains active in the distant future and still respects start and revocation', t => {
  const { db, set } = fixture(t);
  set({ expires_at: null });
  const permanent = { active: true, expiresAt: null, permanent: true };
  assert.deepEqual(platinaState(db, 'account', NOW), permanent);
  assert.deepEqual(platinaState(db, 'account', Date.UTC(9999, 11, 31)), permanent);
  assert.deepEqual(platinaState(db, 'account', 8_640_000_000_000_000), permanent);
  assert.deepEqual(platinaState(db, 'account', NOW - 1), { ...permanent, active: false });
  set({ expires_at: null, revoked_at: NOW });
  assert.deepEqual(platinaState(db, 'account', NOW), { ...permanent, active: false });
  assert.deepEqual(platinaState(db, 'account', Date.UTC(9999, 11, 31)), { ...permanent, active: false });
});

test('null expiry never legitimizes an untrusted or malformed stored grant', t => {
  const { db, set } = fixture(t);
  for (const override of [
    { source: 'client' }, { source: null }, { granted_at: null },
    { granted_at: 'not-a-time' }, { granted_at: -1 }, { granted_at: 1.5 },
    { granted_at: 8_640_000_000_000_001 },
  ]) {
    set({ expires_at: null, ...override });
    assert.deepEqual(platinaState(db, 'account', NOW), { active: false, expiresAt: null });
  }
});

test('public permanent emoji is explicitly marked only for an active permanent grant and an allowed choice', () => {
  const permanent = { active: true, expiresAt: null, permanent: true };
  assert.deepEqual(visibleStatus({ status_emoji: '🎧' }, permanent), {
    statusEmoji: '🎧', statusEmojiExpiresAt: null, statusEmojiPermanent: true,
  });
  for (const user of [{}, { status_emoji: null }, { status_emoji: 'not-an-emoji' }]) {
    assert.deepEqual(visibleStatus(user, permanent), { statusEmoji: null, statusEmojiExpiresAt: null });
  }
  assert.deepEqual(visibleStatus({ status_emoji: '🎧' }, { ...permanent, active: false }), {
    statusEmoji: null, statusEmojiExpiresAt: null,
  });
  assert.deepEqual(visibleStatus({ status_emoji: '🎧' }, { active: false, expiresAt: null }), {
    statusEmoji: null, statusEmojiExpiresAt: null,
  });
});
