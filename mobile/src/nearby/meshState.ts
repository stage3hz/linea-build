// Whether messages currently travel over Mesh (Bluetooth, people nearby) instead of the internet.
import { useSyncExternalStore } from 'react';

let active = false;
const listeners = new Set<() => void>();
export function setMeshActive(next: boolean) { if (next !== active) { active = next; for (const l of listeners) l(); } }
export function meshActive() { return active; }
export function useMeshActive() {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, () => active, () => false);
}
