// Friend requests shared by the «Люди» tab badge, the people screen and profiles.
// Refreshed on start, on every WebSocket «friends» event and after own actions.
import { useSyncExternalStore } from 'react';
import type { Api } from './api';
import type { FriendRequest } from './types';

export type FriendRequestState = { incoming: FriendRequest[]; outgoing: FriendRequest[]; version: number };
let state: FriendRequestState = { incoming: [], outgoing: [], version: 0 };
const listeners = new Set<() => void>();
const empty: FriendRequestState = { incoming: [], outgoing: [], version: 0 };

export function setFriendRequests(incoming: FriendRequest[], outgoing: FriendRequest[]) {
  state = { incoming, outgoing, version: state.version + 1 };
  listeners.forEach(l => l());
}
export function resetFriendRequests() { state = empty; listeners.forEach(l => l()); }
export function useFriendRequests() {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, () => state, () => empty);
}
/** Number shown on the «Люди» tab. */
export const incomingCount = (s: FriendRequestState) => s.incoming.length;

let running: Promise<void> | null = null, again = false;
/** Reloads the lists; several calls at once collapse into one request plus one follow-up. */
export function refreshFriendRequests(api: Api): Promise<void> {
  if (running) { again = true; return running; }
  running = api.friendRequests().then(r => setFriendRequests(r.incoming, r.outgoing)).catch(() => {}).finally(() => {
    running = null;
    if (again) { again = false; void refreshFriendRequests(api); }
  });
  return running;
}
