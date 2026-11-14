import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const { Api, NetworkError } = loadTs(new URL('../src/api.ts', import.meta.url), {
  'react-native': { Platform: { OS: 'android' } },
});

// A gateway status cannot establish whether a write reached the upstream server.
// The HTTP client may change its route, but arbitrary non-idempotent writes must
// retain an unknown outcome for operation-specific reconciliation.
for (const status of [502, 503, 504]) {
  test('gateway ' + status + ' is not proof of non-delivery for a write', async t => {
    let attempts = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      attempts++;
      return new Response('{"error":"gateway"}', {
        status, headers: { 'content-type': 'application/json' },
      });
    });
    await assert.rejects(
      new Api('https://example.invalid').request('/auth/register', { method: 'POST', body: '{}' }),
      error => error instanceof NetworkError && error.notDelivered === false,
    );
    assert.equal(attempts, 1);
  });
}
