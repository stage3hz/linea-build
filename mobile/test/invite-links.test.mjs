import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';
const { inviteCodeFrom, withoutInviteLink } = loadTs(new URL('../src/communities/types.ts', import.meta.url));

test('only our own invite links become a channel banner; look-alikes stay plain text', () => {
  assert.equal(inviteCodeFrom('https://api.invizent.com/i/Abc12345'), 'Abc12345');
  assert.equal(inviteCodeFrom('заходи https://invizent.com/i/Abc12345 !'), 'Abc12345');
  assert.equal(inviteCodeFrom('invizent://invite/Abc12345'), 'Abc12345');
  assert.equal(inviteCodeFrom('linea://invite/Abc12345'), 'Abc12345');
  for (const fake of ['https://evil.com/i/Abc12345', 'https://invizent.com.evil.ru/i/Abc12345', 'https://api.invizent.co/i/Abc12345', 'http://api.invizent.com/i/Abc12345', 'https://user@evil.com/i/Abc12345', 'https://evil.com/?x=https://api.invizent.com/i/Abc12345x'])
    assert.equal(inviteCodeFrom(fake), null, fake);
});

test('the banner replaces the link: no raw URL is left in the message', () => {
  assert.equal(withoutInviteLink('https://api.invizent.com/i/Abc12345'), '');
  assert.equal(withoutInviteLink('Подпишись: https://api.invizent.com/i/Abc12345'), 'Подпишись:');
});
