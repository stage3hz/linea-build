import { useEffect, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
  void noteGrant(owner, active);
}

// «Платина выдана» moment (confetti): the last state seen on this device is kept per account, so a
// grant is noticed whether it happens while the app is open or between launches. The first time an
// account is seen nothing is celebrated (it may have had Platina for long).
const SEEN_KEY = (owner: string) => `linea.platina.seen.${owner}`;
const grantListeners = new Set<(owner: string) => void>();
async function noteGrant(owner: string, active: boolean) {
  try {
    const before = await AsyncStorage.getItem(SEEN_KEY(owner));
    const now = active ? '1' : '0';
    if (before === now) return;
    await AsyncStorage.setItem(SEEN_KEY(owner), now);
    if (before === '0' && active) grantListeners.forEach(listener => listener(owner));
  } catch {}
}
export function onPlatinaGranted(listener: (owner: string) => void): () => void {
  grantListeners.add(listener); return () => { grantListeners.delete(listener); };
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

/**
 * What is already known about `owner`'s Platina, without asking the server:
 * true/false once a screen has loaded it this session, null before that.
 */
export function useKnownPlatina(owner: string | null): boolean | null {
  const snapshot = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state, () => state);
  return owner && snapshot.owner === owner ? snapshot.active : null;
}
