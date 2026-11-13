// A call that wakes the app: reading the notification's payload (pure; the task is in incomingPush.ts).

export type WakeCall = { chatId: string; name: string };
const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
const parsed = (value: unknown): Record<string, unknown> | null => { if (typeof value !== 'string') return record(value); try { return record(JSON.parse(value)); } catch { return null; } };

/**
 * The call in a background notification, or null when it is something else. The notifications library hands the
 * server's `data` over in slightly different shapes between versions (at the top, under `data`, as a JSON string
 * in `body` / `dataString`): each place is looked at. Only a message the server marked to wake the app counts
 * (`kind: 'call'`, `wake: '1'`).
 */
export function wakePayload(data: unknown): WakeCall | null {
  const top = record(data);
  if (!top) return null;
  const inner = parsed(top.data), notification = record(top.notification);
  const places = [top, inner, parsed(top.body), parsed(top.dataString), inner ? parsed(inner.body) : null, inner ? parsed(inner.dataString) : null, notification ? parsed(notification.data) : null];
  for (const place of places) {
    if (!place || place.kind !== 'call' || place.wake !== '1' || typeof place.chatId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(place.chatId)) continue;
    return { chatId: place.chatId, name: typeof place.title === 'string' ? place.title.slice(0, 80) : '' };
  }
  return null;
}
