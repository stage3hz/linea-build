import React, { useEffect, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import { ReduceMotion, ReducedMotionConfig } from 'react-native-reanimated';
import * as Battery from 'expo-battery';
import { getChatPreferences, useChatPreferences } from './chatPreferences';
import { motionAllowed, motionReason, type PowerState } from './motionPolicy';

let power: PowerState = { level: null, charging: false, lowPower: false, reduceMotion: false };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const update = (change: Partial<PowerState>) => { power = { ...power, ...change }; emit(); };

let started = false;
function start() {
  if (started || Platform.OS === 'web') return;
  started = true;
  const charging = (state: Battery.BatteryState) => state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL;
  void Battery.getBatteryLevelAsync().then(level => update({ level })).catch(() => {});
  void Battery.getBatteryStateAsync().then(state => update({ charging: charging(state) })).catch(() => {});
  void Battery.isLowPowerModeEnabledAsync().then(lowPower => update({ lowPower })).catch(() => {});
  void AccessibilityInfo.isReduceMotionEnabled().then(reduceMotion => update({ reduceMotion })).catch(() => {});
  try {
    Battery.addBatteryLevelListener(({ batteryLevel }) => update({ level: batteryLevel }));
    Battery.addBatteryStateListener(({ batteryState }) => update({ charging: charging(batteryState) }));
    Battery.addLowPowerModeListener(({ lowPowerMode }) => update({ lowPower: lowPowerMode }));
  } catch { /* battery events are optional */ }
  AccessibilityInfo.addEventListener('reduceMotionChanged', reduceMotion => update({ reduceMotion }));
}

const subscribe = (listener: () => void) => { start(); listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => power;

/** Synchronous check for code outside React (RN Animated durations, gesture callbacks). */
export function motionEnabled(): boolean { start(); const preferences = getChatPreferences(); return motionAllowed(preferences.animations, power, preferences.lowBattery); }
/** `ms` when animations are allowed, otherwise 0 (jump straight to the end). */
export const animMs = (ms: number) => motionEnabled() ? ms : 0;

export function useMotion(): { enabled: boolean; reason: string } {
  const preferences = useChatPreferences();
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { enabled: motionAllowed(preferences.animations, state, preferences.lowBattery), reason: motionReason(preferences.animations, state, preferences.lowBattery) };
}

/** Mount once near the root: switches every Reanimated animation in the app on or off. */
export function MotionRoot() {
  const { enabled } = useMotion();
  useEffect(() => { start(); }, []);
  return <ReducedMotionConfig mode={enabled ? ReduceMotion.Never : ReduceMotion.Always} />;
}
