// One copy of the server privacy settings for the «Конфиденциальность» pages: the main list, «Время
// захода» and its exception lists are separate stack pages, and a change on one shows on the others.
import { useEffect, useSyncExternalStore } from 'react';
import type { Api, LastSeenMode, LastSeenRules, Privacy } from '../api';

export type PrivacyState = {
  privacy: Privacy | null; platina: boolean; rules: LastSeenRules | null;
  saving: boolean; error: string; rulesError: string;
};
let state: PrivacyState = { privacy: null, platina: false, rules: null, saving: false, error: '', rulesError: '' };
let owner: Api | null = null;
const listeners = new Set<() => void>();
const set = (patch: Partial<PrivacyState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const message = (e: unknown, fallback: string) => e instanceof Error ? e.message : fallback;

/** The mode, old servers included: they only know the on/off switch. */
export const lastSeenModeOf = (privacy: Privacy | null): LastSeenMode => privacy?.lastSeen || (privacy?.showLastSeen === false ? 'nobody' : 'everyone');

export function loadPrivacy(api: Api) {
  if (owner !== api) { owner = api; state = { privacy: null, platina: false, rules: null, saving: false, error: '', rulesError: '' }; }
  set({ error: '' });
  api.privacy().then(result => { if (owner === api) set({ privacy: result.privacy, platina: result.platina === true }); })
    .catch(e => { if (owner === api) set({ error: message(e, 'Не удалось загрузить настройки.') }); });
}
export function loadLastSeenRules(api: Api) {
  set({ rulesError: '' });
  api.lastSeenRules().then(rules => { if (owner === api) set({ rules }); })
    .catch(e => { if (owner === api) set({ rulesError: message(e, 'Не удалось загрузить списки.') }); });
}

/** Optimistic: the switch moves at once and comes back if the server refuses. */
export async function changePrivacy(api: Api, patch: Partial<Privacy>) {
  if (!state.privacy || state.saving) return;
  const previous = state.privacy;
  set({ privacy: { ...previous, ...patch, ...(patch.lastSeen ? { showLastSeen: patch.lastSeen !== 'nobody' } : {}) }, saving: true, error: '' });
  try { const result = await api.updatePrivacy(patch); set({ privacy: result.privacy, platina: result.platina === true }); }
  catch (e) { set({ privacy: previous, error: message(e, 'Не удалось сохранить.') }); }
  finally { set({ saving: false }); }
}

export async function setLastSeenRule(api: Api, userId: string, rule: 'allow' | 'deny' | null) {
  set({ rulesError: '' });
  try { set({ rules: rule ? await api.setLastSeenRule(userId, rule) : await api.removeLastSeenRule(userId) }); }
  catch (e) { set({ rulesError: message(e, rule ? 'Не удалось добавить.' : 'Не удалось убрать.') }); throw e; }
}

/**
 * Subscribes and loads once per account (`api`); `rules` also fetches the exception lists. `fresh`
 * reloads on every mount (the page that opens the section), the pages under it reuse what it loaded.
 */
export function usePrivacy(api: Api, { rules = false, fresh = false }: { rules?: boolean; fresh?: boolean } = {}): PrivacyState {
  const current = useSyncExternalStore(subscribe, () => state, () => state);
  useEffect(() => { if (fresh || owner !== api || (!state.privacy && !state.error)) loadPrivacy(api); }, [api, fresh]);
  useEffect(() => { if (rules && (fresh || owner !== api || !state.rules)) loadLastSeenRules(api); }, [api, rules, fresh]);
  return current;
}
