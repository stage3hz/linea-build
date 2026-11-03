// Pure rules for «messages without internet» (tested in test/nearby-logic.test.mjs).
import type { NearbyNativeState } from '../../modules/linea-nearby';

/** How long both checks must agree before the offer appears (short drops in a lift or the metro do not count). */
export const OFFLINE_AFTER_MS = 10_000;

/**
 * The offer appears only when the phone has no working internet at all — neither Wi-Fi nor mobile —
 * AND no Invizent server has answered for OFFLINE_AFTER_MS. If the internet works but our servers do
 * not, the app switches servers instead; that is not a reason to use Bluetooth.
 */
export function nearbyNeeded(input: { internet: boolean | null; offlineSince: number | null; lastServerOkAt: number; now: number }): boolean {
  const { internet, offlineSince, lastServerOkAt, now } = input;
  if (internet !== false || offlineSince === null) return false; // unknown (PC, web) → never
  return now - offlineSince >= OFFLINE_AFTER_MS && now - lastServerOkAt >= OFFLINE_AFTER_MS;
}

export type NearbyOffer =
  | { kind: 'none' }
  /** First time: our own screen with one button, then the system permission question. */
  | { kind: 'intro' }
  /** Afterwards always the same small banner with one button «Включить»; `action` is what it does. */
  | { kind: 'banner'; action: 'permission' | 'settings' | 'bluetooth' };

export function nearbyOffer(state: NearbyNativeState | null, introDone: boolean): NearbyOffer {
  if (!state?.supported) return { kind: 'none' };
  switch (state.permission) {
    case 'undetermined': return introDone ? { kind: 'banner', action: 'permission' } : { kind: 'intro' };
    // Android asks a second time once; after that, and on iPhone, only Settings can change it.
    case 'denied': return { kind: 'banner', action: 'permission' };
    case 'blocked': return { kind: 'banner', action: 'settings' };
    case 'granted': return state.bluetooth === 'off' ? { kind: 'banner', action: 'bluetooth' } : { kind: 'none' };
  }
}
