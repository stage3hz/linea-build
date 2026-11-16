import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTs } from './support/load-ts.mjs';
const { verifyServerList, chooseServer, normalizeServer } = loadTs(new URL('../src/servers/list.ts', import.meta.url));
const tool = new URL('../../deploy/servers.mjs', import.meta.url).pathname;
const dir = mkdtempSync(path.join(os.tmpdir(), 'srv-'));
const keygen = name => execFileSync('node', [tool, 'keygen', path.join(dir, name)]).toString().match(/приложения: (\S+)/)[1];
const signList = (key, list) => { writeFileSync(path.join(dir, 'l.json'), JSON.stringify(list)); execFileSync('node', [tool, 'sign', path.join(dir, key), path.join(dir, 'l.json'), path.join(dir, 'o.json')], { stdio: 'pipe' }); return JSON.parse(readFileSync(path.join(dir, 'o.json'), 'utf8')); };
const pub = keygen('a.pem'), other = keygen('b.pem');
const list = { version: 3, servers: [{ url: 'https://api.invizent.com', region: 'msk' }, { url: 'https://api2.invizent.ru', region: 'spb' }] };

test('a list signed with the built-in key is accepted; any other key or edit is rejected', () => {
  const signed = signList('a.pem', list);
  assert.deepEqual(verifyServerList(signed, [pub]).servers.map(s => s.url), ['https://api.invizent.com', 'https://api2.invizent.ru']);
  assert.equal(verifyServerList(signList('b.pem', list), [pub]), null, 'foreign key');
  assert.equal(verifyServerList({ ...signed, payload: signed.payload.replace('api2.invizent.ru', 'api2.invizent.ru.evil.com') }, [pub]), null, 'edited after signing');
  assert.equal(verifyServerList(signed, [pub], 4), null, 'older version than the one already known');
  assert.ok(verifyServerList(signed, [other, pub]), 'key rotation: any built-in key');
});

test('only https servers on our domains can ever be listed', () => {
  for (const bad of ['http://api.invizent.com', 'https://invizent.com.evil.ru', 'https://evil.com', 'https://api.invizent.com:8443', 'https://u:p@api.invizent.com', 'https://api.invizent.com/x'])
    assert.equal(normalizeServer(bad), null, bad);
  assert.equal(normalizeServer('https://API3.invizent.ru/'), 'https://api3.invizent.ru');
  assert.throws(() => signList('a.pem', { version: 4, servers: [{ url: 'https://evil.com' }] }));
});

test('the fastest live server wins; a small difference does not cause flip-flopping; a dead one is left', () => {
  assert.equal(chooseServer(null, { a: 120, b: 30, c: null }), 'b');
  assert.equal(chooseServer('a', { a: 60, b: 45 }), 'a', 'only 15 ms faster: stay');
  assert.equal(chooseServer('a', { a: 160, b: 40 }), 'b', 'clearly faster: switch');
  assert.equal(chooseServer('a', { a: null, b: 300 }), 'b', 'current is down');
  assert.equal(chooseServer('a', { a: null, b: null }), 'a', 'nothing alive: keep trying the current one');
});

test('after a failure the next server is a live one, never a recently dead one first', () => {
  const { fallbackServer } = loadTs(new URL('../src/servers/list.ts', import.meta.url));
  const all = ['https://api.invizent.com', 'https://api2.invizent.com', 'https://api3.invizent.ru'];
  const now = 1_000_000;
  // api2 and api3 were never reachable (null) — after api fails, api2 must not jump ahead of a measured one.
  assert.equal(fallbackServer(all[0], all, { [all[1]]: null, [all[2]]: 120 }, {}, now, 60000), all[2]);
  // Every other server is known dead: stay where we are (a slow link drops a request now and then).
  assert.equal(fallbackServer(all[0], all, { [all[1]]: null, [all[2]]: null }, {}, now, 60000), all[0]);
  assert.equal(fallbackServer(all[0], all, {}, { [all[1]]: now - 5000, [all[2]]: now - 30000 }, now, 60000), all[0]);
  // Unknown beats recently dead.
  assert.equal(fallbackServer(all[0], all, {}, { [all[1]]: now - 5000 }, now, 60000), all[2]);
  assert.equal(fallbackServer(all[0], [all[0]], {}, {}, now, 60000), null);
});

test('a route counts only when /health is this service\'s own answer, not any successful page', () => {
  const { healthOk } = loadTs(new URL('../src/servers/list.ts', import.meta.url));
  assert.equal(healthOk(200, '{"status":"ok"}'), true);
  assert.equal(healthOk(200, '<html><body>Войдите в сеть Wi-Fi</body></html>'), false, 'a captive portal page');
  assert.equal(healthOk(200, ''), false);
  assert.equal(healthOk(200, '{"status":"maintenance"}'), false);
  assert.equal(healthOk(200, 'null'), false);
  assert.equal(healthOk(204, '{"status":"ok"}'), false);
  assert.equal(healthOk(200, `{"status":"ok","pad":"${'x'.repeat(300)}"}`), false, 'not the short answer the server sends');
});

test('the reserve entrance is the last resort, and the way back to a direct server needs it to answer twice in a row', () => {
  const { pickRoute, RETURN_AFTER } = loadTs(new URL('../src/servers/list.ts', import.meta.url));
  const api = 'https://api.invizent.com', edge = 'https://edge.example';
  assert.equal(RETURN_AFTER, 2);
  // Normal network: direct, the reserve is not touched even though it answers faster.
  assert.equal(pickRoute(api, { [api]: 80 }, { [edge]: 20 }, 5, true), api);
  // No direct server answers: the reserve — unless the user switched it off, or it does not answer either.
  assert.equal(pickRoute(api, { [api]: null }, { [edge]: 200 }, 0, true), edge);
  assert.equal(pickRoute(api, { [api]: null }, {}, 0, false), api, '«Автоматический резерв» off: stay and keep trying');
  assert.equal(pickRoute(api, { [api]: null }, { [edge]: null }, 0, true), api, 'nothing answers: no jump to a dead reserve');
  // On the reserve, the direct server answers once: not yet. Twice in a row: back.
  assert.equal(pickRoute(edge, { [api]: 90 }, { [edge]: 200 }, 1, true), edge);
  assert.equal(pickRoute(edge, { [api]: 90 }, { [edge]: 200 }, 2, true), api);
  // The reserve itself stopped answering while a direct server answers: go direct at once.
  assert.equal(pickRoute(edge, { [api]: 90 }, { [edge]: null }, 1, true), api);
  // The reserve was switched off while in use.
  assert.equal(pickRoute(edge, { [api]: 90 }, { [edge]: 200 }, 1, false), api);
});

test('the status names the route in use', () => {
  const { routeState } = loadTs(new URL('../src/servers/list.ts', import.meta.url));
  const api = 'https://api.invizent.com', edge = 'https://edge.example', edges = [edge];
  const base = { edges, measured: true, probing: false, directStreak: 0 };
  assert.equal(routeState({ ...base, current: null, rtt: {}, measured: false }), 'checking', 'nothing measured yet');
  assert.equal(routeState({ ...base, current: api, rtt: { [api]: 70, [edge]: 150 }, directStreak: 3 }), 'direct');
  assert.equal(routeState({ ...base, current: edge, rtt: { [api]: null, [edge]: 150 } }), 'reserve');
  assert.equal(routeState({ ...base, current: edge, rtt: { [api]: 90, [edge]: 150 }, directStreak: 1 }), 'returning');
  assert.equal(routeState({ ...base, current: api, rtt: { [api]: null, [edge]: null } }), 'offline');
  assert.equal(routeState({ ...base, current: api, rtt: { [api]: null, [edge]: null }, probing: true }), 'checking');
  assert.equal(routeState({ ...base, current: api, rtt: { [api]: null, [edge]: 150 } }), 'checking', 'the address in use just failed');
});

test('an extra measurement comes soon on the way back and with growing pauses when nothing answers', () => {
  const { nextMeasureDelay, usesReserve } = loadTs(new URL('../src/servers/list.ts', import.meta.url));
  const regularMs = 300_000;
  assert.equal(nextMeasureDelay({ alive: true, returning: false, emptyRuns: 0, regularMs }), null, 'all is well: the regular round only');
  assert.equal(nextMeasureDelay({ alive: true, returning: true, emptyRuns: 0, regularMs }), 20_000);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 40].map(emptyRuns => nextMeasureDelay({ alive: false, returning: false, emptyRuns, regularMs })), [15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  assert.deepEqual(['direct', 'checking', 'reserve', 'returning', 'offline'].map(usesReserve), [false, false, true, true, false]);
});
