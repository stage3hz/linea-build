// Music equalizer: settings store, the audio route (headphones / speaker) and the native bridge
// (iOS: filters on expo-audio's AVPlayer; Android: the system Equalizer on its ExoPlayer session).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { useEffect, useSyncExternalStore } from 'react';
import { DEFAULT_EQ, effectiveGains, parseEq, type EqProfile, type EqRoute, type EqSettings } from './equalizerModel';

type Native = {
  attachEqualizer?: (player: unknown) => Promise<void>;
  setEqualizer?: (low: number, mid: number, high: number, enabled: boolean) => void;
  audioRoute?: () => { route: EqRoute; name?: string | null };
  addListener?: (event: string, listener: (value: { route: EqRoute; name?: string | null }) => void) => { remove: () => void };
};
const native: Native | null = Platform.OS === 'ios' ? requireOptionalNativeModule('LineaPhoto') : Platform.OS === 'android' ? requireOptionalNativeModule('LineaEqualizer') : null;
export const equalizerAvailable = !!native?.setEqualizer;

const KEY = 'linea.equalizer.v1';
let settings: EqSettings = DEFAULT_EQ;
let route: { route: EqRoute; name: string | null } = { route: 'speaker', name: null };
const listeners = new Set<() => void>();
const emit = () => { snapshot = { settings, route }; listeners.forEach(listener => listener()); };
let snapshot = { settings, route };
let started = false;

function apply() {
  const gains = effectiveGains(settings[route.route]);
  try { native?.setEqualizer?.(gains.low, gains.mid, gains.high, gains.enabled); } catch { /* engine unavailable */ }
}
function start() {
  if (started) return; started = true;
  void AsyncStorage.getItem(KEY).then(raw => { settings = parseEq(raw); emit(); apply(); }).catch(() => {});
  try { const current = native?.audioRoute?.(); if (current) route = { route: current.route === 'headphones' ? 'headphones' : 'speaker', name: current.name || null }; } catch { /* unknown */ }
  try { native?.addListener?.('onAudioRoute', value => { route = { route: value.route === 'headphones' ? 'headphones' : 'speaker', name: value.name || null }; emit(); apply(); }); } catch { /* no events */ }
  emit();
}

export function useEqualizer() {
  start();
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot, () => snapshot);
}
export function setEqProfile(which: EqRoute, profile: EqProfile) {
  settings = { ...settings, [which]: profile }; emit(); apply();
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
