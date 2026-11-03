import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './support/load-ts.mjs';
const u = loadTs(new URL('../src/communities/unread.ts', import.meta.url), { react: { useSyncExternalStore: () => 0 } });
const summary = (id, unreadCount, mentionCount, muted = false) => ({ id, unreadCount, mentionCount, muted, isMember: true });

test('channels badge: muted servers count only @mentions; messages bump, reads reset', () => {
  u.resetCommunityCounts();
  u.setCommunitySummaries([summary('a', 3, 0), summary('b', 10, 2, true)]);
  assert.equal(u.channelsBadge(), 3 + 2);
  u.setCommunityChannels('a', [{ id: 'g', kind: 'text', unread: 3, mentions: 0 }, { id: 'v', kind: 'voice' }]);
  u.applyCommunityEvent({ type: 'community.message', communityId: 'a', message: { channelId: 'g', senderId: 'other' }, mentions: ['me'] }, 'me');
  assert.equal(u.channelsBadge(), 4 + 2);
  u.applyCommunityEvent({ type: 'community.message', communityId: 'a', message: { channelId: 'g', senderId: 'me' } }, 'me');
  u.applyCommunityEvent({ type: 'community.message', communityId: 'a', message: { channelId: 'g', senderId: 'x' }, edited: true }, 'me');
  assert.equal(u.channelsBadge(), 6, 'own and edited messages do not count');
  u.setViewingChannel('g');
  u.applyCommunityEvent({ type: 'community.message', communityId: 'a', message: { channelId: 'g', senderId: 'x' } }, 'me');
  assert.equal(u.channelsBadge(), 6, 'the open channel does not count');
  u.setViewingChannel(null);
  u.applyCommunityEvent({ type: 'community.read', communityId: 'a', channelId: 'g', unread: 0, mentions: 0, community: summary('a', 0, 0) }, 'me');
  assert.equal(u.channelsBadge(), 2);
  u.applyCommunityEvent({ type: 'community.removed', communityId: 'b' }, 'me');
  assert.equal(u.channelsBadge(), 0);
});

test('@mention matching follows the server rule', () => {
  assert.equal(u.mentionsUser('привет @Bob_U!', 'bob_u'), true);
  assert.equal(u.mentionsUser('mail@bob_u', 'bob_u'), false);
  assert.equal(u.mentionsUser('@bob_ufo', 'bob_u'), false);
  assert.equal(u.mentionsUser('', 'bob_u'), false);
});
