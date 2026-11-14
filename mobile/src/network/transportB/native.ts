import { requireOptionalNativeModule } from 'expo-modules-core';
import type { TransportBNativeModule } from '../../../modules/linea-transport-b';

/** An experimental session bridge, not a TransportBJoiner for the production pool. */
export function loadTransportBSessionModule(): TransportBNativeModule | null {
  try {
    const native = requireOptionalNativeModule<TransportBNativeModule>('LineaTransportB');
    if (!native || typeof native.capabilities !== 'function' || typeof native.status !== 'function' ||
        typeof native.startSession !== 'function' || typeof native.stopSession !== 'function' ||
        typeof native.addListener !== 'function') return null;
    const capabilities = native.capabilities();
    // Do not silently accept a different ABI or a future backend whose routing
    // contract this version has not implemented/reviewed.
    if (!capabilities || capabilities.protocol !== 1 ||
        capabilities.nativeSession !== true || capabilities.appRouting !== false) return null;
    return native;
  } catch { return null; }
}

/** A linked native library must NEVER make the server pool display "connected". */
export function transportBReadiness(): { nativeSession: boolean; appRouting: false } {
  return { nativeSession: loadTransportBSessionModule() !== null, appRouting: false };
}
