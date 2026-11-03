// «Messages without internet»: watches the phone's internet and Bluetooth and decides what to offer.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { LineaNearbyBridge, NearbyNativeState } from '../../modules/linea-nearby';
import { lastServerOkAt } from '../servers/pool';
import { nearbyNeeded, nearbyOffer, type NearbyOffer } from './logic';
import { setMeshActive } from './meshState';

const native = requireOptionalNativeModule<LineaNearbyBridge>('LineaNearby');
const INTRO_KEY = 'invizent.nearby.intro.v1';
// The radio transport is being built (modules/linea-nearby). Until it carries messages, the
// permission is not asked in release builds: asking for Bluetooth that does nothing would be wrong.
export const NEARBY_TRANSPORT_READY = false;

export function useNearby(): { offer: NearbyOffer; act: () => Promise<void> } {
  const [state, setState] = useState<NearbyNativeState | null>(null);
  const [introDone, setIntroDone] = useState(true);
  const [now, setNow] = useState(Date.now());
  const offlineSince = useRef<number | null>(null);
  const enabled = !!native && (NEARBY_TRANSPORT_READY || __DEV__);

  const apply = useCallback((next: NearbyNativeState) => {
    if (next.internet) offlineSince.current = null;
    else if (offlineSince.current === null) offlineSince.current = Date.now();
    setState(next);
  }, []);

  useEffect(() => {
    if (!enabled || !native) return;
    let alive = true;
    void AsyncStorage.getItem(INTRO_KEY).then(v => { if (alive) setIntroDone(v === '1'); }).catch(() => { if (alive) setIntroDone(false); });
    const refresh = () => void native.state().then(s => { if (alive) apply(s); }).catch(() => {});
    refresh();
    const sub = native.addListener('change', s => apply(s));
    // Coming back from Settings or the Bluetooth dialog: read the state again.
    const app = AppState.addEventListener('change', s => { if (s === 'active') refresh(); });
    const tick = setInterval(() => setNow(Date.now()), 2000);
    return () => { alive = false; sub.remove(); app.remove(); clearInterval(tick); };
  }, [enabled, apply]);

  const needed = !!state && nearbyNeeded({ internet: state.internet, offlineSince: offlineSince.current, lastServerOkAt: lastServerOkAt(), now });
  const offer: NearbyOffer = enabled && needed ? nearbyOffer(state, introDone) : { kind: 'none' };
  const mesh = enabled && needed && state?.permission === 'granted' && state.bluetooth === 'on';
  useEffect(() => { setMeshActive(mesh); }, [mesh]);
  useEffect(() => () => setMeshActive(false), []);

  const act = useCallback(async () => {
    if (!native) return;
    const current = nearbyOffer(state, introDone);
    if (current.kind === 'intro') {
      setIntroDone(true); void AsyncStorage.setItem(INTRO_KEY, '1').catch(() => {});
      const next = await native.requestPermission().catch(() => null);
      if (next) { apply(next); if (next.permission === 'granted' && next.bluetooth === 'off') apply(await native.requestEnable()); }
      return;
    }
    if (current.kind !== 'banner') return;
    if (current.action === 'settings') return native.openSettings();
    if (current.action === 'permission') {
      const next = await native.requestPermission().catch(() => null);
      if (next) { apply(next); if (next.permission === 'granted' && next.bluetooth === 'off') apply(await native.requestEnable()); }
      return;
    }
    const next = await native.requestEnable().catch(() => null);
    if (next) apply(next);
  }, [state, introDone, apply]);

  return { offer, act };
}
