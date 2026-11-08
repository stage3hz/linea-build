// Number on the app icon (phones), the taskbar button (Windows), the dock (macOS) or the tray icon
// and its tooltip (Windows/Linux): unread chats + server/channel counters + waiting friend requests —
// the same total the server sends in pushes while the app is closed.
import { Platform } from 'react-native';
import { desktopBridge } from './desktop';

let last = -1;
const short = (n: number) => (n > 99 ? '99+' : String(n));

/** Windows shows a 16×16 overlay on the taskbar button (and the tray counter on Windows/Linux); drawn at 32 px for sharp high-DPI screens. */
export function badgePicture(n: number): string | null {
  if (typeof document === 'undefined' || n < 1) return null;
  const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
  const g = canvas.getContext('2d'); if (!g) return null;
  g.fillStyle = '#F23F43'; g.beginPath(); g.arc(16, 16, 16, 0, Math.PI * 2); g.fill();
  const text = short(n);
  g.fillStyle = '#FFFFFF'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `700 ${text.length > 2 ? 13 : text.length > 1 ? 17 : 21}px "Segoe UI", system-ui, sans-serif`;
  g.fillText(text, 16, 17);
  return canvas.toDataURL('image/png');
}

export async function setAppBadge(total: number) {
  const n = Math.max(0, Math.floor(total) || 0);
  if (n === last) return; last = n;
  try {
    if (Platform.OS === 'web') {
      const desktop = desktopBridge();
      if (desktop?.badge) { await desktop.badge(n, badgePicture(n)); return; }
      const nav = globalThis.navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
      if (n) await nav?.setAppBadge?.(n); else await nav?.clearAppBadge?.();
      return;
    }
    const Notifications = await import('expo-notifications');
    await Notifications.setBadgeCountAsync(n);
  } catch { last = -1; /* not supported here (some Android launchers have no badges) */ }
}
