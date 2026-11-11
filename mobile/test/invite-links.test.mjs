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

test('invite links are not listed under the profile «Ссылки» tab', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/SharedMedia.tsx', import.meta.url), 'utf8');
  assert.match(src, /if \(!inviteCodeFrom\(url\)\) links\.push/);
});

test('member counts stay short for big servers and the card text can shrink', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/communities/parts.tsx', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export const compactCount'), src.indexOf('export { inviteCodeFrom }'))
    .replace(/export const (\w+) = /g, 'const $1 = exports.$1 = ').replace(/\(count: number\)/g, '(count)').replace(/\(value: number, unit: string\)/g, '(value, unit)').replace(/\(count: number, one: string, few: string, many: string\)/g, '(count, one, few, many)');
  const exports = {}; new Function('exports', body.replace(/const counted/, 'const counted') + '\nexports.counted = counted;')(exports);
  const { members, subscribers } = exports;
  assert.equal(members(3), '3 участника');
  assert.equal(members(21), '21 участник');
  assert.equal(members(1234), '1 234 участника');
  assert.equal(members(12345), '12,3 тыс. участников');
  assert.equal(subscribers(2_500_000), '2,5 млн подписчиков');
  assert.equal(members(1005), '1 005 участников');
  const card = readFileSync(new URL('../src/communities/InviteCard.tsx', import.meta.url), 'utf8');
  assert.match(card, /flex: 1, minWidth: 0/);
  assert.match(card, /numberOfLines=\{1\} style=\{\{ color: t\.muted, fontSize: 12, flexShrink: 1 \}\}/);
});
