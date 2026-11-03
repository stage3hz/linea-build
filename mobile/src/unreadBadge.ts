// Total unread (not muted, not archived) for tab bars that do not get the chat store directly.
import { useSyncExternalStore } from 'react';
let total = 0; const listeners = new Set<() => void>();
export function setUnreadTotal(next: number) { if (next !== total) { total = next; listeners.forEach(l => l()); } }
export function useUnreadTotal() { return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, () => total, () => 0); }
/** Like Telegram: exact up to 999, then «4,3K», «12K», «1,2M». */
export function badgeText(n: number): string {
  if (!Number.isFinite(n) || n < 1) return '';
  const short = (value: number, unit: string) => (value < 10 ? `${(Math.floor(value * 10) / 10).toString().replace('.', ',').replace(/,0$/, '')}${unit}` : `${Math.floor(value)}${unit}`);
  if (n < 1000) return String(Math.floor(n));
  if (n < 1_000_000) return short(n / 1000, 'K');
  return short(n / 1_000_000, 'M');
}
