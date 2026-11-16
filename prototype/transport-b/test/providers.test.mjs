import assert from 'node:assert/strict';
import test from 'node:test';
import { isProviderJoinLink, requireTransportProvider } from '../src/providers.mjs';

test('providers form a closed list with a backwards-compatible WB default', () => {
  assert.equal(requireTransportProvider(), 'wbstream');
  for (const provider of ['wbstream', 'telemost']) assert.equal(requireTransportProvider(provider), provider);
  for (const provider of [null, '', 'vk', 'Telemost', '__proto__', {}, 1])
    assert.throws(() => requireTransportProvider(provider), /unsupported/);
});

test('strict canonical links are bound to their provider and bounded', () => {
  const wb = 'wbstream://room_123456789', tm = 'https://telemost.yandex.ru/j/1234567890123';
  assert.equal(isProviderJoinLink('wbstream', wb), true);
  assert.equal(isProviderJoinLink('telemost', tm), true);
  assert.equal(isProviderJoinLink('wbstream', tm), false);
  assert.equal(isProviderJoinLink('telemost', wb), false);
  for (const [provider, link] of [['wbstream', wb], ['telemost', tm]]) {
    for (const suffix of ['\n', '\r', '\r\n', ' ', '/', '?a=1', '#secret'])
      assert.equal(isProviderJoinLink(provider, link + suffix), false, `${provider} rejects suffix`);
    assert.equal(isProviderJoinLink(provider, '\n' + link), false);
    assert.equal(isProviderJoinLink(provider, undefined), false);
  }
  for (const link of [
    'https://telemost.yandex.ru.evil/j/123', 'https://telemost.yandex.ru@evil/j/123',
    'https://TELEMOST.yandex.ru/j/123', 'https://telemost.yandex.ru:443/j/123',
    'http://telemost.yandex.ru/j/123', 'https://telemost.yandex.ru/j/%31',
    'https://telemost.yandex.ru/j/', 'https://telemost.yandex.ru/j/１２３',
    'https://telemost.yandex.ru/j/' + '1'.repeat(161),
  ]) assert.equal(isProviderJoinLink('telemost', link), false);
  assert.equal(isProviderJoinLink('telemost', 'https://telemost.yandex.ru/j/' + '1'.repeat(160)), true);
  assert.equal(isProviderJoinLink('wbstream', 'wbstream://' + 'a'.repeat(161)), false);
});
