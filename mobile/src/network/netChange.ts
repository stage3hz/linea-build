// «The network changed» for live calls (Wi-Fi ↔ LTE, a new IP address): a call restarts ICE at once
// instead of waiting for the old path to time out. Phones: NetInfo (loaded lazily, so a build without the
// native module simply gets no events). PC: the browser's online / connection-change events.
// No reachability pings: NetInfo is configured not to contact any server.
import { Platform } from 'react-native';
import { networkKey } from '../calls/reconnect';

type Listener = () => void;
const listeners = new Set<Listener>();
type OnlineListener = (online: boolean) => void;
const onlineListeners = new Set<OnlineListener>();
let stop: (() => void) | null = null;
let last: string | null = null;
/** What the phone says about its network: null until the first report (or without NetInfo). */
let online: boolean | null = null;

function changed(key: string) {
  const previous = last; last = key;
  const now = key !== 'offline';
  if (online !== now) { online = now; onlineListeners.forEach(listener => { try { listener(now); } catch { /* keep the others */ } }); }
  // Going offline is not a change to act on; coming back (or a different network) is.
  if (previous === null || key === previous || key === 'offline') return;
  listeners.forEach(listener => { try { listener(); } catch { /* one listener does not stop the others */ } });
}

function startNative(): (() => void) | null {
  let NetInfo: any;
  try { NetInfo = require('@react-native-community/netinfo').default; } catch { return null; }
  try {
    NetInfo.configure?.({ reachabilityShouldRun: () => false, shouldFetchWiFiSSID: false });
    return NetInfo.addEventListener((state: any) => changed(networkKey(state)));
  } catch { return null; }
}

function startWeb(): (() => void) | null {
  const target: any = globalThis.window; if (!target?.addEventListener) return null;
  const connection: any = (globalThis.navigator as any)?.connection;
  const key = () => (globalThis.navigator as any)?.onLine === false ? 'offline' : `net|${connection?.type || ''}`; // not the speed estimates: they move all the time
  const onOnline = () => changed(key());
  const onOffline = () => changed('offline');
  const onChange = () => changed(key());
  last = key(); online = last !== 'offline';
  target.addEventListener('online', onOnline); target.addEventListener('offline', onOffline);
  connection?.addEventListener?.('change', onChange);
  return () => { target.removeEventListener('online', onOnline); target.removeEventListener('offline', onOffline); connection?.removeEventListener?.('change', onChange); };
}

const start = () => { if (!stop) stop = (Platform.OS === 'web' ? startWeb() : startNative()) || (() => {}); };
const release = () => { if (!listeners.size && !onlineListeners.size && stop) { stop(); stop = null; last = null; online = null; } };

/** Called after the phone switched networks (not when it merely lost one). */
export function onNetworkChange(listener: Listener): () => void {
  listeners.add(listener); start();
  return () => { listeners.delete(listener); release(); };
}

/** Network lost / back (Telegram's «Ожидание сети…»): the listener gets the current state at once when it is known. */
export function onOnlineChange(listener: OnlineListener): () => void {
  onlineListeners.add(listener); start();
  if (online !== null) { try { listener(online); } catch { /* the caller's problem */ } }
  return () => { onlineListeners.delete(listener); release(); };
}
