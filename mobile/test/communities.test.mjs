import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';

const { inviteCodeFrom, can, PERM } = loadTs(new URL('../src/communities/types.ts', import.meta.url));

test('invite codes are found in app and web links only', () => {
  assert.equal(inviteCodeFrom('заходи linea://invite/Ab3dEf9hKm'), 'Ab3dEf9hKm');
  assert.equal(inviteCodeFrom('https://invizent.com/i/Ab3dEf9hKm?x=1'), 'Ab3dEf9hKm');
  assert.equal(inviteCodeFrom('https://invizent.com/i/abc'), null, 'too short');
  assert.equal(inviteCodeFrom('https://invizent.com/x/Ab3dEf9hKm'), null);
  assert.equal(inviteCodeFrom('просто текст'), null);
});

test('permission bits', () => {
  assert.equal(can({ perms: PERM.SEND | PERM.VOICE }, PERM.VOICE), true);
  assert.equal(can({ perms: PERM.SEND }, PERM.POST), false);
});
