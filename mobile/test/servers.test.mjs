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
