// What update the server offers and whether it is mandatory for this build.
// GET /app/update answers even builds the server otherwise turns away (426), so an
// outdated app always learns where to get the new version.
import { useEffect, useState } from 'react';
import { APP_VERSION, SERVER_URL } from '../serverConfig';

export type UpdateAsset = { url: string; sha256: string; size: number };
export type UpdateInfo = { version: string | null; minVersion: string | null; page: string | null; notes: string; android: UpdateAsset | null; windows: UpdateAsset | null;
  /** ms timestamps on the SERVER clock; requiredAt = when the update stops being optional. */
  releasedAt: number | null; requiredAt: number | null;
  /** server time − phone time, so a wrong phone clock does not shift the deadline. */
  clockOffset: number };
export type UpdateState = { info: UpdateInfo | null; required: boolean; available: boolean; dismissed: boolean };

export function parseVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,4})\.(\d{1,4})\.(\d{1,5})$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
export function versionLess(a: string, b: string): boolean {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i];
  return false;
}

const GITHUB_PREFIX = 'https://github.com/stage3hz/linea-build/releases/download/';
const asset = (value: any): UpdateAsset | null =>
  value && typeof value.url === 'string' && value.url.startsWith(GITHUB_PREFIX) && /^[0-9a-f]{64}$/.test(value.sha256) && Number.isSafeInteger(value.size) && value.size > 0 ? { url: value.url, sha256: value.sha256, size: value.size } : null;

/** Pure decision, unit-tested: what this build should show for a server answer. */
export function decide(info: UpdateInfo, current = APP_VERSION, nowMs = Date.now()): { required: boolean; available: boolean } {
  const newer = !!info.version && versionLess(current, info.version);
  const serverNow = nowMs + info.clockOffset;
  const required = (!!info.minVersion && versionLess(current, info.minVersion)) || (newer && info.requiredAt !== null && serverNow >= info.requiredAt);
  return { required, available: required || newer };
}

/** Server-clock "now" for countdowns. */
export const serverNow = (info: UpdateInfo | null, nowMs = Date.now()) => nowMs + (info?.clockOffset ?? 0);

const two = (n: number) => String(n).padStart(2, '0');
/** "2 д 14 ч 05 мин" / "14 ч 05 мин" / "5 мин" */
export function formatSpan(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000)), d = Math.floor(total / 1440), h = Math.floor((total % 1440) / 60), m = total % 60;
  if (d) return `${d} д ${h} ч ${two(m)} мин`;
  if (h) return `${h} ч ${two(m)} мин`;
  return `${Math.max(1, m)} мин`;
}

let state: UpdateState = { info: null, required: false, available: false, dismissed: false };
const listeners = new Set<(next: UpdateState) => void>();
const publish = (next: UpdateState) => { state = next; listeners.forEach(listener => listener(state)); };

export async function checkForUpdate(fetchImpl: typeof fetch = fetch): Promise<UpdateState> {
  try {
    const response = await fetchImpl(`${SERVER_URL}/app/update`, { credentials: 'omit', cache: 'no-store', redirect: 'error', headers: { 'X-Linea-Client': `invizent; v=${APP_VERSION}` } });
    if (!response.ok) return state;
    const raw = await response.json();
    const time = (value: unknown) => { const ms = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(ms) ? ms : null; };
    const server = time(raw.serverTime);
    const info: UpdateInfo = { version: parseVersion(raw.version) ? raw.version : null, minVersion: parseVersion(raw.minVersion) ? raw.minVersion : null, page: typeof raw.page === 'string' ? raw.page : null, notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 1000) : '', android: asset(raw.android), windows: asset(raw.windows),
      releasedAt: time(raw.releasedAt), requiredAt: time(raw.requiredAt), clockOffset: server === null ? 0 : server - Date.now() };
    publish({ info, ...decide(info), dismissed: state.dismissed && state.info?.version === info.version });
  } catch { /* offline: keep what we know */ }
  return state;
}

/** Any request answered 426 means the server has retired this build. */
export function markUpdateRequired() {
  if (state.required) return;
  publish({ ...state, required: true, available: true, dismissed: false });
  void checkForUpdate();
}
export function dismissUpdate() { if (!state.required) publish({ ...state, dismissed: true }); }
/** "Every time the app is opened": the prompt returns on a cold start and after the app was away a while. */
export const REPROMPT_AFTER_MS = 5 * 60_000;
export function appBecameActive(awayMs: number) {
  if (awayMs >= REPROMPT_AFTER_MS && state.dismissed) publish({ ...state, dismissed: false });
  void checkForUpdate();
}
/** Re-evaluates the deadline (called by a timer), so the app locks at the exact moment. */
export function recheckDeadline(nowMs = Date.now()) {
  if (!state.info || state.required) return;
  const next = decide(state.info, APP_VERSION, nowMs);
  if (next.required) publish({ ...state, ...next, dismissed: false });
}

export function useUpdateState(): UpdateState {
  const [value, setValue] = useState(state);
  useEffect(() => { listeners.add(setValue); setValue(state); return () => { listeners.delete(setValue); }; }, []);
  return value;
}
