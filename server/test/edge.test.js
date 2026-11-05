import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';

const SECRET = 'e'.repeat(64);

test('Cloudflare reserve entrance: only the shared secret may name the client IP for rate limits', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'linea-edge-'));
  const app = await buildApp({ dataDir, logger: false, authRateLimit: 2, edgeSecret: SECRET });
  try {
    const login = headers => app.inject({ method: 'POST', url: '/auth/login', headers, payload: { username: 'nobody_here', password: 'wrong password 123456', confirmationWord: 'слово' } });
    // Two different real users behind the same Cloudflare address are limited separately.
    for (const ip of ['203.0.113.1', '203.0.113.2']) for (let i = 0; i < 2; i++) assert.notEqual((await login({ 'x-invizent-edge-key': SECRET, 'x-invizent-edge-ip': ip })).statusCode, 429);
    assert.equal((await login({ 'x-invizent-edge-key': SECRET, 'x-invizent-edge-ip': '203.0.113.1' })).statusCode, 429);
    // A wrong secret cannot pick a fresh IP: it counts as the connecting address.
    for (let i = 0; i < 2; i++) await login({ 'x-invizent-edge-key': 'x'.repeat(64), 'x-invizent-edge-ip': `198.51.100.${i}` });
    assert.equal((await login({ 'x-invizent-edge-key': 'x'.repeat(64), 'x-invizent-edge-ip': '198.51.100.9' })).statusCode, 429);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
