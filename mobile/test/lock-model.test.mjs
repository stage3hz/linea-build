import assert from 'node:assert/strict';
import test from 'node:test';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { loadTs } from './support/load-ts.mjs';

const model = loadTs(new URL('../src/lock/model.ts', import.meta.url), {});
const { createRecord, verifyCode, codeKind, codeProblem, retryDelayMs, retryWaitMs, retryHint, shouldLock, shouldLockOnLaunch, shouldLockOnReturn, locksOnBackground, onLeave, parseLockSettings, constantTimeEqual, autolockMs, unlockedPatch, AUTOLOCK_MODES, DEFAULT_LOCK_SETTINGS, KDF_ITERATIONS, LOCKED_PATCH, INACTIVE_LOCK_GRACE_MS } = model;

// The same PBKDF2-HMAC-SHA256 the app runs (Node's), with a cheap iteration count for the tests.
const nodeKdf = (code, salt, iterations, length) => new Uint8Array(pbkdf2Sync(Buffer.from(code), Buffer.from(salt), iterations, length, 'sha256'));
const settings = (change = {}) => ({ ...DEFAULT_LOCK_SETTINGS, record: { kind: 'digits', salt: 'ab'.repeat(16), hash: 'cd'.repeat(32), iterations: 1000 }, ...change });

test('a code is kept only as a salted PBKDF2 hash and verifies against the same code', async () => {
  const salt = new Uint8Array(randomBytes(16));
  const record = await createRecord('1234', salt, nodeKdf, 2000);
  assert.equal(record.kind, 'digits');
  assert.equal(record.iterations, 2000);
  assert.equal(record.salt.length, 32);
  assert.equal(record.hash.length, 64);
  assert.ok(!JSON.stringify(record).includes('1234'), 'the code itself is never stored');
  assert.equal(record.hash, pbkdf2Sync('1234', Buffer.from(salt), 2000, 32, 'sha256').toString('hex'));
  assert.equal(await verifyCode('1234', record, nodeKdf), true);
  assert.equal(await verifyCode('1235', record, nodeKdf), false);
  assert.equal(await verifyCode('', record, nodeKdf), false);
  // Pure-JS PBKDF2 on Hermes: 60 000 rounds measured 1.5–5 s per unlock, 8 000 stay well under a second.
  assert.ok(KDF_ITERATIONS >= 8_000, 'production uses a real number of rounds');
  assert.ok(KDF_ITERATIONS <= 10_000, 'but not so many that Hermes freezes on every unlock');
});

test('the same code with another salt gives another hash; passwords are unicode-normalized', async () => {
  const a = await createRecord('secret', new Uint8Array(16).fill(1), nodeKdf, 1000);
  const b = await createRecord('secret', new Uint8Array(16).fill(2), nodeKdf, 1000);
  assert.notEqual(a.hash, b.hash);
  assert.equal(a.kind, 'password');
  const composed = await createRecord('é', new Uint8Array(16).fill(3), nodeKdf, 1000);
  assert.equal(await verifyCode('é', composed, nodeKdf), true);
  await assert.rejects(createRecord('1234', new Uint8Array(8), nodeKdf, 1000), /salt/);
  await assert.rejects(createRecord('1234', new Uint8Array(16), nodeKdf, 10), /iterations/);
});

test('code kinds: exactly four digits is a 4-digit code, everything else a password', () => {
  assert.equal(codeKind('0000'), 'digits');
  assert.equal(codeKind('12345'), 'password');
  assert.equal(codeKind('12a4'), 'password');
  assert.equal(codeProblem('123', 'digits'), 'Введи четыре цифры.');
  assert.equal(codeProblem('1234', 'digits'), null);
  assert.equal(codeProblem('', 'password'), 'Пароль не может быть пустым.');
  assert.equal(codeProblem('x'.repeat(65), 'password'), 'Пароль слишком длинный.');
  assert.equal(codeProblem('любой пароль', 'password'), null);
});

test('constant-time comparison only cares about equality', () => {
  assert.equal(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false);
});

test('five free tries, then the wait doubles from 10 s up to an hour', () => {
  for (let failures = 0; failures < 5; failures++) assert.equal(retryDelayMs(failures), 0);
  assert.equal(retryDelayMs(5), 10_000);
  assert.equal(retryDelayMs(6), 20_000);
  assert.equal(retryDelayMs(7), 40_000);
  assert.equal(retryDelayMs(10), 320_000);
  assert.equal(retryDelayMs(40), 3_600_000);
  assert.equal(retryDelayMs(1000), 3_600_000);
  assert.equal(retryWaitMs(5, 1000, 4000), 7000);
  assert.equal(retryWaitMs(5, 1000, 20_000), 0);
  assert.equal(retryWaitMs(9, null, 20_000), 0, 'nothing to wait for before the first failure');
  assert.equal(retryWaitMs(5, 10_000, 4000), 10_000, 'a clock that jumped back still waits the full delay');
  assert.equal(retryHint(7000), 'Попробуй через 7 с');
  assert.equal(retryHint(90_000), 'Попробуй через 2 мин');
  assert.equal(retryHint(3_600_000), 'Попробуй через 1 ч');
  assert.equal(retryHint(0), '');
});

test('autolock: Telegram delays, locked on return once the time away reaches the delay', () => {
  assert.deepEqual([...AUTOLOCK_MODES], ['off', 'immediate', '1m', '5m', '1h', '5h']);
  assert.equal(autolockMs('off'), null);
  assert.equal(autolockMs('immediate'), 0);
  assert.equal(autolockMs('1m'), 60_000);
  assert.equal(autolockMs('5h'), 5 * 3_600_000);
  const away = (mode, ms) => shouldLock(settings({ autolock: mode, backgroundAt: 1_000_000 }), 1_000_000 + ms);
  assert.equal(away('1m', 59_999), false);
  assert.equal(away('1m', 60_000), true);
  assert.equal(away('5m', 4 * 60_000), false);
  assert.equal(away('5m', 5 * 60_000), true);
  assert.equal(away('1h', 3_600_000), true);
  assert.equal(away('immediate', 1), true);
  assert.equal(away('off', 10 * 3_600_000), false, '«Выключена» never locks by itself');
  assert.equal(away('1h', -5000), true, 'a clock that jumped back counts as a long absence');
  assert.equal(shouldLock(settings({ backgroundAt: null }), 5), true, 'a code with no recorded activity locks');
  assert.equal(shouldLock({ ...DEFAULT_LOCK_SETTINGS, backgroundAt: null }, 5), false, 'no code, no lock');
});

test('«Сразу» locks on leaving; a cold start with autolock off is always locked', () => {
  assert.equal(locksOnBackground(settings({ autolock: 'immediate' })), true);
  assert.equal(locksOnBackground(settings({ autolock: '1m' })), false);
  assert.equal(locksOnBackground({ ...DEFAULT_LOCK_SETTINGS, autolock: 'immediate' }), false);
  assert.equal(shouldLockOnLaunch(settings({ autolock: 'off', backgroundAt: 1000 }), 1001), true);
  assert.equal(shouldLockOnLaunch(settings({ autolock: '1h', backgroundAt: 1000 }), 1001), false);
  assert.equal(shouldLockOnLaunch(settings({ autolock: '1h', backgroundAt: 1000 }), 1000 + 3_600_000), true);
  assert.equal(shouldLockOnLaunch(DEFAULT_LOCK_SETTINGS, 5), false);
  assert.equal(shouldLockOnLaunch(settings({ autolock: '1h', backgroundAt: 1000 }), 1001, 'web'), true, 'Telegram Web: a start with a code is always locked');
  assert.equal(shouldLockOnLaunch(DEFAULT_LOCK_SETTINGS, 5, 'web'), false);
});

test('locking is saved as «no last-open stamp», so a kill-and-relaunch inside the delay is still locked', () => {
  const open = settings({ autolock: '1h', backgroundAt: 1_000_000 });
  assert.equal(shouldLockOnLaunch(open, 1_000_000 + 1000), false, 'a short absence with the lock open: no code');
  const locked = parseLockSettings(JSON.stringify({ ...open, ...LOCKED_PATCH }));
  assert.equal(locked.backgroundAt, null);
  assert.equal(shouldLockOnLaunch(locked, 1_000_000 + 1000), true, 'locked, killed, relaunched a second later: still locked');
  assert.equal(shouldLock(locked, 1_000_000 + 1000), true);
  const reopened = { ...locked, ...unlockedPatch(2_000_000) };
  assert.equal(reopened.backgroundAt, 2_000_000);
  assert.equal(reopened.failures, 0);
  assert.equal(reopened.lastFailureAt, null);
  assert.equal(shouldLockOnLaunch(reopened, 2_000_000 + 1000), false);
});

test('leaving the foreground: the stamp is written only while open; «Сразу» locks on background, waits a grace on iOS inactive', () => {
  const ios = true, android = false;
  // Open app, a normal delay: remember when it left, no lock yet, cover the switcher snapshot on iPhone.
  assert.deepEqual(onLeave(settings({ autolock: '1m' }), false, 'background', ios), { recordBackgroundAt: true, lock: 'no', cover: true });
  assert.deepEqual(onLeave(settings({ autolock: '1m' }), false, 'inactive', ios), { recordBackgroundAt: false, lock: 'no', cover: true });
  assert.deepEqual(onLeave(settings({ autolock: '1m' }), false, 'background', android), { recordBackgroundAt: true, lock: 'no', cover: false });
  // Already locked: never write the stamp (it would let a relaunch skip the code), nothing more to lock, no cover needed.
  assert.deepEqual(onLeave(settings({ autolock: '1m' }), true, 'background', ios), { recordBackgroundAt: false, lock: 'no', cover: false });
  assert.deepEqual(onLeave(settings({ autolock: 'immediate' }), true, 'background', ios), { recordBackgroundAt: false, lock: 'no', cover: false });
  // «Сразу»: background locks now; iPhone inactive (Face ID sheet, Control Centre, a picker) waits a short grace; Android inactive does nothing.
  assert.deepEqual(onLeave(settings({ autolock: 'immediate' }), false, 'background', ios), { recordBackgroundAt: true, lock: 'now', cover: true });
  assert.deepEqual(onLeave(settings({ autolock: 'immediate' }), false, 'inactive', ios), { recordBackgroundAt: false, lock: 'soon', cover: true });
  assert.deepEqual(onLeave(settings({ autolock: 'immediate' }), false, 'inactive', android), { recordBackgroundAt: false, lock: 'no', cover: false });
  assert.ok(INACTIVE_LOCK_GRACE_MS >= 1000 && INACTIVE_LOCK_GRACE_MS <= 2000);
  // No code: nothing at all.
  assert.deepEqual(onLeave(DEFAULT_LOCK_SETTINGS, false, 'background', ios), { recordBackgroundAt: false, lock: 'no', cover: false });
});

test('coming back: only a real background stay counts, by the delay; «Сразу» locked on leaving and never relocks a fresh unlock', () => {
  const back = settings({ autolock: '1m', backgroundAt: 1_000_000 });
  assert.equal(shouldLockOnReturn(back, true, 1_000_000 + 60_000), true);
  assert.equal(shouldLockOnReturn(back, true, 1_000_000 + 10_000), false);
  assert.equal(shouldLockOnReturn(back, false, 1_000_000 + 60_000), false, 'an inactive moment (Face ID sheet) is not an absence');
  // Android's fingerprint dialog is a «background»; the unlock just stamped backgroundAt = now.
  assert.equal(shouldLockOnReturn(settings({ autolock: 'immediate', backgroundAt: 5_000 }), true, 5_050), false);
  assert.equal(shouldLockOnReturn(settings({ autolock: 'off', backgroundAt: 5_000 }), true, 5_000 + 10 * 3_600_000), false);
});

test('saved settings are validated: a broken record disables the lock instead of locking forever', () => {
  assert.deepEqual(parseLockSettings(null), DEFAULT_LOCK_SETTINGS);
  assert.deepEqual(parseLockSettings('not json'), DEFAULT_LOCK_SETTINGS);
  const good = settings({ biometrics: true, autolock: '5h', failures: 3, backgroundAt: 42, lastFailureAt: 41 });
  assert.deepEqual(parseLockSettings(JSON.stringify(good)), good);
  const broken = parseLockSettings(JSON.stringify({ ...good, record: { ...good.record, hash: 'zz' } }));
  assert.equal(broken.record, null);
  assert.equal(broken.biometrics, false, 'biometrics never stand without a code');
  const weak = parseLockSettings(JSON.stringify({ ...good, record: { ...good.record, iterations: 1 } }));
  assert.equal(weak.record, null);
  const odd = parseLockSettings(JSON.stringify({ ...good, autolock: '2d', failures: -4, lastFailureAt: 'yesterday' }));
  assert.equal(odd.autolock, '1m');
  assert.equal(odd.failures, 0);
  assert.equal(odd.lastFailureAt, null);
  const old = parseLockSettings(JSON.stringify({ record: good.record, autolock: '1m', failures: 6, backgroundAt: 42 }));
  assert.equal(old.lastFailureAt, null, 'a record saved before the field existed reads as «no wait pending»');
  assert.equal(retryWaitMs(old.failures, old.lastFailureAt, 50), 0);
});
