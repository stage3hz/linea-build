import { useSyncExternalStore } from 'react';
import { networkTier, subscribeNetwork, type NetworkTier } from './quality';
export function useNetworkTier(): NetworkTier { return useSyncExternalStore(subscribeNetwork, networkTier, () => 'fast'); }
