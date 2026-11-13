// App-wide navigation requests from deep inside the tree (tab bar, invite banners, voice bar).
// App.tsx listens and switches pages; keeps props from being threaded through every screen.
export type NavigationRequest = { to: 'channels'; communityId?: string | null } | { to: 'invite'; code: string } | { to: 'security' } | { to: 'chat'; userId: string }
  /** A tap on @name in a message: find that person and open the chat with them. */
  | { to: 'mention'; username: string };
const listeners = new Set<(request: NavigationRequest) => void>();
export const onNavigate = (listener: (request: NavigationRequest) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const navigate = (request: NavigationRequest) => listeners.forEach(listener => listener(request));
