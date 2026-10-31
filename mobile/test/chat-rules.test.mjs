import assert from 'node:assert/strict';
import test from 'node:test';
import { foldChat, validMeta, actionFallback } from '../src/messageMeta.ts';

const t0 = Date.parse('2026-10-31T10:00:00Z');
let n = 0;
const msg = (sender, minutes, extra = {}) => ({ id: ++n, chatId: 'c', senderId: sender, clientId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, text: 'x', attachment: null, createdAt: new Date(t0 + minutes * 60000).toISOString(), cryptoState: 'decrypted', ...extra });

test('auto-delete applies to messages sent after it was turned on; clear hides older history for both', () => {
  n = 0;
  const before = msg('a', 0);
  const rules = msg('a', 1, { meta: { action: { type: 'settings', ttl: 86400, noCopy: true } } });
  const after = msg('b', 2);
  const fresh = msg('a', 60 * 24 + 1);
  let view = foldChat([before, rules, after, fresh], 'a', new Set(), t0 + 60 * 60000);
  assert.deepEqual(view.messages.map(m => m.id), [before.id, after.id, fresh.id]);
  assert.deepEqual(view.rules, { ttl: 86400, noCopy: true });
  assert.equal(view.nextExpiry, Date.parse(after.createdAt) + 86400000);
  view = foldChat([before, rules, after, fresh], 'a', new Set(), t0 + (60 * 24 + 3) * 60000);
  assert.deepEqual(view.messages.map(m => m.id), [before.id, fresh.id], 'only the message sent under auto-delete expires');
  const clear = msg('b', 60 * 24 + 5, { meta: { action: { type: 'clear' } } });
  const later = msg('b', 60 * 24 + 6);
  view = foldChat([before, rules, after, fresh, clear, later], 'a', new Set(), t0 + (60 * 24 + 7) * 60000);
  assert.deepEqual(view.messages.map(m => m.id), [later.id]);
});

test('chat rule actions are validated and have readable fallbacks', () => {
  assert.equal(validMeta({ action: { type: 'settings', ttl: 604800, noCopy: false } }), true);
  assert.equal(validMeta({ action: { type: 'settings', ttl: 5, noCopy: false } }), false);
  assert.equal(validMeta({ action: { type: 'clear', extra: 1 } }), false);
  assert.equal(actionFallback({ type: 'settings', ttl: 2592000, noCopy: false }), '⏱ Автоудаление: 1 месяц');
  assert.equal(actionFallback({ type: 'clear' }), '🧹 История очищена');
});
