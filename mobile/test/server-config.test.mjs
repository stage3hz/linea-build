import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const load = value => {
  const before = process.env.EXPO_PUBLIC_SIMULATOR_SERVER;
  if (value === undefined) delete process.env.EXPO_PUBLIC_SIMULATOR_SERVER; else process.env.EXPO_PUBLIC_SIMULATOR_SERVER = value;
  try { return loadTs(new URL('../src/serverConfig.ts', import.meta.url), {}); }
  finally { if (before === undefined) delete process.env.EXPO_PUBLIC_SIMULATOR_SERVER; else process.env.EXPO_PUBLIC_SIMULATOR_SERVER = before; }
};

test('release builds always use the real server; the simulator override accepts only https://localhost:<port>', () => {
  assert.equal(load(undefined).SERVER_URL, 'https://api.invizent.com');
  assert.equal(load('https://evil.example.com').SERVER_URL, 'https://api.invizent.com');
  assert.equal(load('http://localhost:8443').SERVER_URL, 'https://api.invizent.com');
  assert.equal(load('https://localhost:8443.evil.com').SERVER_URL, 'https://api.invizent.com');
  const sim = load('https://localhost:8443');
  assert.equal(sim.SERVER_URL, 'https://localhost:8443');
  assert.deepEqual(sim.EDGE_SERVER_URLS, []); assert.deepEqual(sim.LEGACY_SERVER_URLS, []);
  assert.equal(load(undefined).EDGE_SERVER_URLS.length, 1);
});
