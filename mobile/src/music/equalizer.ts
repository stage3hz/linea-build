// Music equalizer (one for every output): settings store and the native bridge
// (iOS: filters on expo-audio's AVPlayer; Android: the system Equalizer on its ExoPlayer session).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { useEffect, useSyncExternalStore } from 'react';
import { DEFAULT_EQ, effectiveGains, parseEq, type EqProfile } from './equalizerModel';

type Native = {
  attachEqualizer?: (player: unknown) => Promise<void>;
  setEqualizer?: (low: number, mid: number, high: number, enabled: boolean) => void;
};
const native: Native | null = Platform.OS === 'ios' ? requireOptionalNativeModule('LineaPhoto') : Platform.OS === 'android' ? requireOptionalNativeModule('LineaEqualizer') : null;
export const equalizerAvailable = !!native?.setEqualizer;

const KEY = 'linea.equalizer.v1';
let settings: EqProfile = DEFAULT_EQ;
const listeners = new Set<() => void>();
const emit = () => { listeners.forEach(listener => listener()); };
let started = false;

function apply() {
  const gains = effectiveGains(settings);
  try { native?.setEqualizer?.(gains.low, gains.mid, gains.high, gains.enabled); } catch { /* engine unavailable */ }
}
function start() {
  if (started) return; started = true;
  void AsyncStorage.getItem(KEY).then(raw => { settings = parseEq(raw); emit(); apply(); }).catch(() => {});

}

/** One equalizer for every output: speaker, wired and Bluetooth headphones. */
export function useEqualizer(): EqProfile {
  start();
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => settings, () => settings);
}
export function setEqProfile(profile: EqProfile) {
  settings = profile; emit(); apply();
  void AsyncStorage.setItem(KEY, JSON.stringify(settings)).catch(() => {});
}
/** Connects the equalizer to the music player once it exists (and again if it is recreated). */
export function useEqualizerOn(player: unknown) {
  useEffect(() => {
    start();
    if (!player || !native?.attachEqualizer) return;
    void native.attachEqualizer(player).then(apply).catch(() => {});
  }, [player]);
}
/** Re-attach after a new track (Android recreates the audio session; iOS observes items itself). */
export function reattachEqualizer(player: unknown) {
  if (!player || !native?.attachEqualizer) return;
  void native.attachEqualizer(player).then(apply).catch(() => {});
}
