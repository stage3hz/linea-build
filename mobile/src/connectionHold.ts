/**
 * In the background the messenger socket is closed so peers see «был(а) только что» (Telegram).
 * A voice room or a 1:1 call must survive the background (UIBackgroundModes audio/voip keep JS
 * running): while someone holds the connection, the socket stays open and keeps its heartbeat,
 * otherwise the server would call leaveVoice on close and the peers would drop our RTC connection.
 */
const holds = new Set<string>();
/** Keeps the socket alive in the background until the returned function is called. */
export function holdConnection(key: string): () => void { holds.add(key); return () => { holds.delete(key); }; }
export const connectionHeld = () => holds.size > 0;
/** Tests only. */
export const resetConnectionHolds = () => { holds.clear(); };

export type SocketTick = 'ping' | 'reconnect' | 'sleep' | 'idle';
/** What the 3 s heartbeat does with the socket. `stale` — ms without a frame before a reconnect. */
export function socketTick(input: { foreground: boolean; held: boolean; open: boolean; sinceReceive: number; stale?: number }): SocketTick {
  const awake = input.foreground || input.held;
  if (!awake) return input.open ? 'sleep' : 'idle';
  if (input.sinceReceive > (input.stale ?? 15000)) return 'reconnect';
  return input.open ? 'ping' : 'idle';
}
