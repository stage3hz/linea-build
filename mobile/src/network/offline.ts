// Offline like Telegram: no network (or the server is out of reach) is not an error to show. The title
// says what is going on («Ожидание сети…», «Соединение…», «Обновление…»), what is on the device keeps
// showing, and everything is retried by itself when the network comes back. Only errors the person can
// act on (a refused request, a key check, a broken local vault) still reach the screen.
// Pure logic, no React Native imports: tested in test/offline-state.test.mjs.

/** The request did not get a usable answer because of the connection, not because it was refused. */
export function isConnectivityError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, message, status } = error as { name?: unknown; message?: unknown; status?: unknown };
  // api.ts: NetworkError (no connection, 502/503/504 from the proxy) and RequestTimeoutError ('TimeoutError').
  if (name === 'NetworkError' || name === 'TimeoutError' || name === 'AbortError') return true;
  // A server error or «too many requests» is transient too: the next refresh asks again.
  if (typeof status === 'number' && (status >= 500 || status === 408 || status === 429)) return true;
  // fetch itself (React Native «Network request failed», browsers «Failed to fetch» / «Load failed»).
  return typeof message === 'string' && /network request failed|failed to fetch|load failed|networkerror when attempting|internet connection appears to be offline|ECONN|ENOTFOUND|ETIMEDOUT/i.test(message);
}

/** The text to show for an error: nothing for a connection problem (the title covers it). */
export function shownError(error: unknown, describe: (error: unknown) => string): string {
  return isConnectivityError(error) ? '' : describe(error);
}

export type Refresh<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * A refresh replaces the list only when it succeeded (`merge` folds the answer into what is on screen);
 * a failed one keeps the list as it is, and offline it shows no error either.
 */
export function afterRefresh<T>(previous: readonly T[], result: Refresh<readonly T[]>, describe: (error: unknown) => string, merge: (previous: readonly T[], next: readonly T[]) => readonly T[] = (_previous, next) => next): { list: readonly T[]; error: string } {
  if (result.ok) return { list: merge(previous, result.value), error: '' };
  return { list: previous, error: shownError(result.error, describe) };
}

/**
 * Whether the chat list still shows its skeleton. «Начни разговор» (an empty list) is shown only once
 * the server confirmed there are no chats, or a real error ended the wait — never because the device is
 * offline and the request failed.
 */
export function listStillLoading(state: { chats: number; serverLoaded: boolean; failure: 'none' | 'connectivity' | 'error' }): boolean {
  // Nothing on screen yet and no answer from the server: wait (for the device cache, then the network).
  return state.chats === 0 && !state.serverLoaded && state.failure !== 'error';
}

export type TitleState = 'chats' | 'mesh' | 'waiting' | 'connecting' | 'updating';
/**
 * The chat list title. `online`: what the phone says about its network (null = unknown, e.g. no NetInfo).
 * Connected and refreshing after a reconnect → «Обновление…»; no network → «Ожидание сети…» (or Mesh);
 * network but no server yet → «Соединение…».
 */
export function titleState(input: { connection: 'connecting' | 'connected' | 'offline'; online: boolean | null; updating: boolean; mesh: boolean }): TitleState {
  if (input.connection === 'connected') return input.updating ? 'updating' : 'chats';
  if (input.mesh) return 'mesh';
  if (input.online === false) return 'waiting';
  if (input.online === true) return 'connecting';
  return input.connection === 'connecting' ? 'connecting' : 'waiting';
}
export const TITLE_TEXT: Record<Exclude<TitleState, 'chats' | 'mesh'>, string> = { waiting: 'Ожидание сети…', connecting: 'Соединение…', updating: 'Обновление…' };
