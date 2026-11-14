import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { CreatorPool, validateCreatorConfig } from '../src/creator-pool.mjs';

const base = { binary: '/opt/invizent/test/headless-wbstream-creator', cookiesFile: '/run/secrets/wb-cookies.json', egressSocks: '127.0.0.1:9090', startupMs: 70, leaseMs: 150, maxSessions: 2 };

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  signals = [];
  kill(signal) { this.signals.push(signal); this.emit('exit', 0); return true; }
  write(text) { this.stdout.emit('data', text); }
}

function makePool(config = {}) {
  const processes = [];
  const invocations = [];
  const spawnProcess = (binary, args, options) => {
    const child = new FakeChild(); processes.push(child); invocations.push({ binary, args, options }); return child;
  };
  const pool = new CreatorPool({ ...base, ...config }, { spawnProcess, now: () => 500_000 });
  return { pool, processes, invocations };
}

test('requires fixed binary, secret path, and an explicit local egress policy proxy', () => {
  assert.throws(() => validateCreatorConfig({ ...base, binary: 'sh' }), /absolute/);
  assert.throws(() => validateCreatorConfig({ ...base, cookiesFile: '../secrets' }), /absolute/);
  assert.throws(() => validateCreatorConfig({ ...base, egressSocks: '0.0.0.0:9090' }), /loopback/);
  assert.throws(() => validateCreatorConfig({ ...base, egressSocks: '127.0.0.1:65536' }), /loopback/);
  assert.throws(() => validateCreatorConfig({ ...base, maxSessions: 0 }), /maxSessions/);
  assert.equal(validateCreatorConfig(base).max, 2);
});

test('starts one isolated creator per device; returns the secret only to the caller', async () => {
  const { pool, processes, invocations } = makePool();
  const first = pool.acquire('test-device-01');
  const identical = pool.acquire('test-device-01');
  assert.equal(first, identical, 'one in-flight promise per device');
  assert.equal(processes.length, 1);
  assert.deepEqual(invocations[0].args, ['--cookies', base.cookiesFile, '--resources', 'moderate', '--upstream-socks', base.egressSocks, '--name', 'INVIZENT relay']);
  assert.equal(invocations[0].options.shell, false);
  assert.equal('LINEA_DATABASE_PASSWORD' in invocations[0].options.env, false);
  processes[0].write('  CALL CREATED\n  join_link: wbstream://room_123456789\n');
  const lease = await first;
  assert.deepEqual(lease, { joinLink: 'wbstream://room_123456789', expiresAt: 500_150 });
  assert.deepEqual(pool.stats(), { activeSessions: 1, maxSessions: 2 });
  assert.equal(JSON.stringify(pool.stats()).includes('room_123456789'), false);
  assert.deepEqual(await pool.acquire('test-device-01'), lease);
  pool.close();
  assert.deepEqual(processes[0].signals, ['SIGTERM']);
});

test('handles split stdout lines and ignores malicious/unexpected join links', async () => {
  const { pool, processes } = makePool();
  const lease = pool.acquire('test-device-01');
  processes[0].write('join_link: https://evil.example/connect\n');
  processes[0].write('join_link: wbstream://../../etc/passwd\n');
  processes[0].write('join_link: wbstream://sa');
  processes[0].write('fe_room_99\n');
  assert.equal((await lease).joinLink, 'wbstream://safe_room_99');
  pool.close();
});

test('enforces session capacity, then releases a slot on process exit', async () => {
  const { pool, processes } = makePool({ maxSessions: 1 });
  const lease = pool.acquire('test-device-01');
  await assert.rejects(pool.acquire('test-device-02'), /capacity/);
  processes[0].write('join_link: wbstream://room_123456789\n');
  await lease;
  processes[0].emit('exit', 1);
  assert.equal(pool.stats().activeSessions, 0);
  const second = pool.acquire('test-device-02');
  processes[1].write('join_link: wbstream://room_22222222\n');
  assert.equal((await second).joinLink, 'wbstream://room_22222222');
  pool.close();
});

test('creator process crash before link produces a generic failure without stderr secrets', async () => {
  const { pool, processes } = makePool();
  const lease = pool.acquire('test-device-01');
  processes[0].stderr.emit('data', 'secret XSRF token; some cookies');
  processes[0].emit('exit', 1);
  await assert.rejects(lease, error => error.message === 'creator process exited');
  assert.equal(pool.stats().activeSessions, 0);
  pool.close();
});

test('startup expiry terminates an unresponsive creator', async () => {
  const { pool, processes } = makePool({ startupMs: 10 });
  const lease = pool.acquire('test-device-01');
  const rejected = assert.rejects(lease, /startup timeout/);
  await new Promise(resolve => setTimeout(resolve, 35));
  await rejected;
  assert.deepEqual(processes[0].signals, ['SIGTERM']);
  assert.equal(pool.stats().activeSessions, 0);
  pool.close();
});

test('lease expiry terminates the creator; later calls can create a new one', async () => {
  const { pool, processes } = makePool({ leaseMs: 10 });
  const first = pool.acquire('test-device-01');
  processes[0].write('join_link: wbstream://room_123456789\n');
  await first;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(pool.stats().activeSessions, 0);
  assert.deepEqual(processes[0].signals, ['SIGTERM']);
  const second = pool.acquire('test-device-01');
  processes[1].write('join_link: wbstream://room_22222222\n');
  assert.equal((await second).joinLink, 'wbstream://room_22222222');
  pool.close();
});

test('close cancels an in-progress creator and forbids future sessions', async () => {
  const { pool, processes } = makePool();
  const pending = pool.acquire('test-device-01');
  pool.close();
  await assert.rejects(pending, /creator stopped/);
  await assert.rejects(pool.acquire('test-device-02'), /closed/);
  assert.equal(pool.release('test-device-01'), false);
  assert.deepEqual(processes[0].signals, ['SIGTERM']);
});

test('rejects unexpected IDs without starting a subprocess', async () => {
  const { pool, processes } = makePool();
  await assert.rejects(pool.acquire('--cookies=/tmp/evil'), /invalid device ID/);
  await assert.rejects(pool.acquire('x'), /invalid device ID/);
  assert.equal(processes.length, 0);
  pool.close();
});

test('spawn failure is caught and cleans up capacity', async () => {
  const pool = new CreatorPool(base, { spawnProcess: () => { throw new Error('internal filesystem detail'); } });
  await assert.rejects(pool.acquire('test-device-01'), error => error.message === 'creator launch failed');
  assert.equal(pool.stats().activeSessions, 0);
  pool.close();
});
