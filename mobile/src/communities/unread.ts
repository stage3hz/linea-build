// Unread and @mention counters for servers and channels (Discord-like): the «Каналы» tab badge,
// the community list and channel rows read from here. The server is the source of truth
// (summaries, channel lists, «community.read» events); new messages bump the numbers locally.
import { useSyncExternalStore } from 'react';
import type { CommunityChannel, CommunitySummary } from './types';

export type Counts = { unread: number; mentions: number };
type CommunityCounts = Counts & { muted: boolean };
type State = { communities: Record<string, CommunityCounts>; channels: Record<string, Counts & { communityId: string }>; viewing: string | null };

let state: State = { communities: {}, channels: {}, viewing: null };
const listeners = new Set<() => void>();
const commit = (next: State) => { state = next; listeners.forEach(l => l()); };
const ZERO: Counts = { unread: 0, mentions: 0 };

const fromSummary = (s: CommunitySummary): CommunityCounts => ({ unread: s.unreadCount || 0, mentions: s.mentionCount || 0, muted: !!s.muted });

export function setCommunitySummaries(list: CommunitySummary[]) {
  const communities: State['communities'] = {};
  for (const s of list) communities[s.id] = fromSummary(s);
  const channels = Object.fromEntries(Object.entries(state.channels).filter(([, c]) => communities[c.communityId]));
  commit({ ...state, communities, channels });
}
export function setCommunitySummary(s: CommunitySummary) {
  if (!s.isMember && s.isMember !== undefined) return removeCommunity(s.id);
  commit({ ...state, communities: { ...state.communities, [s.id]: fromSummary(s) } });
}
export function removeCommunity(id: string) {
  const communities = { ...state.communities }; delete communities[id];
  commit({ ...state, communities, channels: Object.fromEntries(Object.entries(state.channels).filter(([, c]) => c.communityId !== id)) });
}
/** Channel list from GET /communities/:id (each channel carries its own counters). */
export function setCommunityChannels(communityId: string, list: CommunityChannel[]) {
  const channels = Object.fromEntries(Object.entries(state.channels).filter(([, c]) => c.communityId !== communityId));
  for (const c of list) if (c.kind === 'text') channels[c.id] = { communityId, unread: c.unread || 0, mentions: c.mentions || 0 };
  commit({ ...state, channels });
}
/** The channel on screen right now: its new messages are read as they come. */
export function setViewingChannel(id: string | null) { if (state.viewing !== id) commit({ ...state, viewing: id }); }

/** WebSocket events. `me` is the signed-in user id. */
export function applyCommunityEvent(data: any, me: string) {
  if (!data || typeof data.type !== 'string') return;
  if (data.type === 'community' && data.community) setCommunitySummary(data.community);
  else if (data.type === 'community.removed' && typeof data.communityId === 'string') removeCommunity(data.communityId);
  else if (data.type === 'community.read' && data.community) {
    const channels = state.channels[data.channelId] ? { ...state.channels, [data.channelId]: { ...state.channels[data.channelId], unread: data.unread || 0, mentions: data.mentions || 0 } } : state.channels;
    commit({ ...state, channels, communities: { ...state.communities, [data.community.id]: fromSummary(data.community) } });
  } else if (data.type === 'community.message' && !data.edited && data.message && data.message.senderId !== me) {
    const channelId = data.message.channelId, communityId = data.communityId;
    const community = state.communities[communityId];
    if (!community || channelId === state.viewing) return;
    const mention = Array.isArray(data.mentions) && data.mentions.includes(me) ? 1 : 0;
    const channel = state.channels[channelId];
    commit({
      ...state,
      communities: { ...state.communities, [communityId]: { ...community, unread: community.unread + 1, mentions: community.mentions + mention } },
      channels: channel ? { ...state.channels, [channelId]: { ...channel, unread: channel.unread + 1, mentions: channel.mentions + mention } } : state.channels,
    });
  }
}
export function resetCommunityCounts() { commit({ communities: {}, channels: {}, viewing: null }); }

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export function useCommunityCounts(id: string): CommunityCounts {
  const c = useSyncExternalStore(subscribe, () => state.communities[id], () => undefined);
  return c || { ...ZERO, muted: false };
}
export function useChannelCounts(id: string): Counts {
  return useSyncExternalStore(subscribe, () => state.channels[id], () => undefined) || ZERO;
}
/** For the «Каналы» tab and the app icon: a muted server counts only its @mentions (as in Discord). */
export function channelsBadge(s: State = state): number {
  let n = 0;
  for (const c of Object.values(s.communities)) n += c.muted ? c.mentions : c.unread;
  return n;
}
export function useChannelsBadge(): number { return useSyncExternalStore(subscribe, () => channelsBadge(), () => 0); }

/** Same rule as the server: «@name» standing on its own (not inside an e-mail or a longer name). */
export function mentionsUser(text: string, username: string): boolean {
  if (!text || !username) return false;
  const re = /(^|[^a-z0-9_@])@([a-z0-9_]{3,24})(?![a-z0-9_])/gi;
  for (const m of text.matchAll(re)) if (m[2].toLowerCase() === username.toLowerCase()) return true;
  return false;
}
