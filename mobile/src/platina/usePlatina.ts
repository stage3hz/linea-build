import { useEffect, useSyncExternalStore } from 'react';
import type { Api } from '../api';

/**
 * Whether the signed-in account has an active Platina, as the server reports it
 * (`/me/username`). Shared by every screen; refreshed once per session and whenever a
 * screen that knows better (the profile) calls `setPlatinaActive`.
 */
let state: { owner: string | null; active: boolean } = { owner: null, active: false };
let loading: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

export function setPlatinaActive(owner: string, active: boolean) {
  if (state.owner === owner && state.active === active) return;
  state = { owner, active }; emit();
}

export function usePlatina(api: Api, owner: string): boolean {
  const snapshot = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state, () => state);
  useEffect(() => {
    if (state.owner === owner || loading === owner) return;
    loading = owner;
    api.usernameStatus().then(status => { if (status.accountId === owner) setPlatinaActive(owner, status.platina.active); }).catch(() => {}).finally(() => { if (loading === owner) loading = null; });
  }, [api, owner]);
  return snapshot.owner === owner && snapshot.active;
}
