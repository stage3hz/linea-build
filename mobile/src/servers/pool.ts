// Which server the app talks to right now. The account itself lives at a fixed «realm»
// (SERVER_URL) — keys and history on the device are tied to it, never to the address in use.
// Servers: built-in ones + a list signed by the owner. The fastest live one is used; a failed
// one is skipped at once; everything is re-measured every few minutes and after a failure.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { EDGE_SERVER_URLS, LEGACY_SERVER_URLS, SERVER_URL } from '../serverConfig';
import { SERVER_LIST_KEYS } from './key';
import { connectionRows, fallbackServer, healthOk, nextMeasureDelay, normalizeServer, pickRoute, RETURN_AFTER, routeState, verifyServerList, type RouteState, type ServerList, type SignedServerList } from './list';
import { networkTier } from '../network/quality';

const STORE = 'invizent.servers.v1';
// Probes wait longer on a slow link (EDGE: one TLS handshake alone takes about a second).
const probeTimeout = () => (networkTier() === 'slow' ? 9000 : networkTier() === 'medium' ? 5000 : 3000);
const REPROBE_MS = 5 * 60_000, DOWN_MS = 60_000;
// `reserve`: «Автоматический резерв» (on unless the user switched it off). `directStreak`: measurements in a row in
// which a direct server answered (list.ts, pickRoute). `measured`: at least one measurement has finished.
type State = { list: ServerList | null; signed: SignedServerList | null; current: string | null; rtt: Record<string, number | null>; down: Record<string, number>; reserve: boolean; directStreak: number; measured: boolean };
let state: State = { list: null, signed: null, current: null, rtt: {}, down: {}, reserve: true, directStreak: 0, measured: false };
let started = false, probing: Promise<void> | null = null, timer: ReturnType<typeof setInterval> | undefined;
// An extra measurement before the regular round (list.ts, nextMeasureDelay), and measurements in a row with no answer.
let extra: ReturnType<typeof setTimeout> | undefined, emptyRuns = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

export function builtinServers(): string[] {
  return [SERVER_URL, ...LEGACY_SERVER_URLS].map(normalizeServer).filter((u): u is string => !!u);
}
const edgeServers = () => EDGE_SERVER_URLS.map(normalizeServer).filter((u): u is string => !!u);
export function candidates(): string[] {
  const all = [...builtinServers(), ...(state.list?.servers.map(s => s.url) || []), ...(state.reserve ? edgeServers() : [])];
  return all.filter((u, i) => all.indexOf(u) === i);
}
/** The address requests go to now (the realm until the first measurement). */
export function currentEndpoint(): string { return state.current || builtinServers()[0] || SERVER_URL; }
export function subscribeServers(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
let lastOk = 0;
/** Any HTTP answer from any Invizent server (used to tell «no internet» from a short drop). */
export function markServerOk() { lastOk = Date.now(); }
export function lastServerOkAt() { return lastOk; }
/** Which route is in use (list.ts, routeState): for the status line and the connection settings. */
export function connectionRoute(): RouteState { return routeState({ current: state.current, edges: edgeServers(), rtt: state.rtt, measured: state.measured, probing: !!probing, directStreak: state.directStreak }); }
/** «Автоматический резерв»: whether the app may use the reserve entrance when no direct server answers. */
export function autoReserve(): boolean { return state.reserve; }
const save = () => { void AsyncStorage.setItem(STORE, JSON.stringify({ signed: state.signed, current: state.current, reserve: state.reserve })).catch(() => {}); };
export function setAutoReserve(on: boolean) {
  if (state.reserve === on) return;
  state = { ...state, reserve: on };
  // Switched off while the reserve is in use: go back to the realm's own address at once and measure.
  if (!on && state.current && edgeServers().includes(state.current)) state = { ...state, current: builtinServers()[0] || null };
  save(); emit(); void measureServers();
}
export function serverStatus() { return { current: currentEndpoint(), route: connectionRoute(), reserve: state.reserve, rtt: { ...state.rtt }, listVersion: state.list?.version ?? null }; }
/** Everything the connection screen draws: the route in use, whether the reserve is allowed, and our addresses with pings. */
export function connectionSnapshot() {
  return { route: connectionRoute(), reserve: state.reserve, probing: !!probing, rows: connectionRows({ current: currentEndpoint(), rtt: state.rtt, edges: edgeServers(), order: candidates() }) };
}
// Read-only diagnostics (Settings → «О приложении» can show it; the test stand reads it).
(globalThis as { __invizentServers?: () => unknown }).__invizentServers = serverStatus;

async function probe(url: string): Promise<number | null> {
  let best: number | null = null;
  for (let i = 0; i < 2; i++) {
    const abort = new AbortController(); const t = setTimeout(() => abort.abort(), probeTimeout());
    const start = Date.now();
    try { const r = await fetch(`${url}/health`, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: abort.signal }); // Only this service's own answer counts: any other successful page is not a route to it.
      if (healthOk(r.status, await r.text())) { const ms = Date.now() - start; best = best === null ? ms : Math.min(best, ms); } }
    catch { /* unreachable */ } finally { clearTimeout(t); }
  }
  return best;
}

async function refreshList(from: string): Promise<boolean> {
  if (!SERVER_LIST_KEYS.length) return false;
  try {
    const r = await fetch(`${from}/servers`, { credentials: 'omit', cache: 'no-store', redirect: 'error' });
    if (!r.ok) return false;
    const signed = await r.json() as SignedServerList;
    const list = verifyServerList(signed, SERVER_LIST_KEYS, state.list?.version ?? 0);
    if (list && (!state.list || list.version > state.list.version)) { state = { ...state, list, signed: { payload: signed.payload, sig: signed.sig } }; return true; }
  } catch { /* keep the list we have */ }
  return false;
}

/** Measures every candidate and switches if needed. Safe to call often (one run at a time). */
export function measureServers(): Promise<void> {
  if (probing) return probing;
  probing = (async () => {
    const urls = candidates(); const now = Date.now();
    const results = await Promise.all(urls.map(async u => [u, state.down[u] && now - state.down[u] < DOWN_MS ? null : await probe(u)] as const));
    const rtt = Object.fromEntries(results);
    // Cloudflare is a reserve: chosen only when no direct server answers at all.
    const edges = edgeServers();
    const direct = Object.fromEntries(Object.entries(rtt).filter(([u]) => !edges.includes(u)));
    const reserve = Object.fromEntries(Object.entries(rtt).filter(([u]) => edges.includes(u)));
    const directStreak = Object.values(direct).some(v => typeof v === 'number') ? state.directStreak + 1 : 0;
    const current = pickRoute(state.current, direct, reserve, directStreak, state.reserve) ?? state.current;
    state = { ...state, rtt, current, directStreak, measured: true };
    const alive = Object.values(rtt).some(v => typeof v === 'number');
    emptyRuns = alive ? 0 : emptyRuns + 1;
    if (extra) clearTimeout(extra);
    const again = started ? nextMeasureDelay({ alive, returning: !!current && edges.includes(current) && directStreak > 0 && directStreak < RETURN_AFTER, emptyRuns, regularMs: REPROBE_MS }) : null;
    extra = again === null ? undefined : setTimeout(() => void measureServers(), again);
    const fresh = current ? await refreshList(current) : false;
    emit();
    save();
    // A new list brought new servers: measure them right away rather than in five minutes.
    if (fresh) setTimeout(() => void measureServers(), 0);
  })().finally(() => { probing = null; });
  return probing;
}

/** A request to `endpoint` failed at the network level: skip it right away and re-measure. */
export function reportFailure(endpoint: string) {
  const url = normalizeServer(endpoint); if (!url) return;
  // A direct server that fails starts its count of good measurements anew (list.ts, pickRoute).
  state = { ...state, down: { ...state.down, [url]: Date.now() }, rtt: { ...state.rtt, [url]: null }, directStreak: edgeServers().includes(url) ? state.directStreak : 0 };
  if (state.current === url) {
    const next = fallbackServer(url, candidates(), state.rtt, state.down, Date.now(), DOWN_MS);
    state = { ...state, current: next || state.current };
    emit();
  }
  void measureServers();
}

/** The phone moved to another network (Wi-Fi ↔ mobile): what failed on the old one says nothing about this one. */
export function networkChanged() {
  if (!started) return;
  state = { ...state, down: {}, directStreak: 0 };
  emptyRuns = 0;
  void measureServers();
}

export async function startServerPool() {
  if (started) return; started = true;
  try {
    const saved = JSON.parse((await AsyncStorage.getItem(STORE)) || 'null');
    // The cached list is trusted again only after its signature is re-checked.
    const list = saved?.signed ? verifyServerList(saved.signed, SERVER_LIST_KEYS, 0) : null;
    if (list) state = { ...state, list, signed: saved.signed };
    if (saved?.reserve === false) state = { ...state, reserve: false };
    const current = typeof saved?.current === 'string' ? normalizeServer(saved.current) : null;
    if (current && candidates().includes(current)) state = { ...state, current };
  } catch { /* first start */ }
  await measureServers();
  timer = setInterval(() => void measureServers(), REPROBE_MS);
}
export function stopServerPool() { if (timer) clearInterval(timer); if (extra) clearTimeout(extra); extra = undefined; started = false; }
