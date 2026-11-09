// Telegram's record-button gesture (voice and round video), pure and worklet-safe
// (covered by test/videonote-record-gesture.test.mjs). Recording starts after HOLD_MS; while the finger
// holds: left by CANCEL_DISTANCE cancels, up by LOCK_DISTANCE locks (hands free); on release a shorter
// slide or a fast flick does the same, otherwise the take is sent. A quicker tap switches voice ↔ video.
export const CANCEL_DISTANCE = 150, LOCK_DISTANCE = 110, HOLD_MS = 190;
export const CANCEL_ON_RELEASE = 100, LOCK_ON_RELEASE = 60, FLICK = 400;
export type HoldResult = 'send' | 'cancel' | 'lock';

/** One axis at a time, like Telegram: the larger movement (left or up) wins; right/down count as 0. */
export function holdAxis(translationX: number, translationY: number): { x: number; y: number } {
  'worklet';
  const left = Math.min(0, translationX), up = Math.min(0, translationY);
  return -left > -up ? { x: left, y: 0 } : { x: 0, y: up };
}

/** While moving: cancel/lock as soon as the distance is reached, otherwise null (keep recording). */
export function holdMove(x: number, y: number): 'cancel' | 'lock' | null {
  'worklet';
  if (-x >= CANCEL_DISTANCE) return 'cancel';
  if (-y >= LOCK_DISTANCE) return 'lock';
  return null;
}

/** On release. */
export function holdRelease(translationX: number, translationY: number, velocityX: number, velocityY: number): HoldResult {
  'worklet';
  const left = -Math.min(0, translationX), up = -Math.min(0, translationY);
  if (left >= CANCEL_ON_RELEASE || velocityX < -FLICK) return 'cancel';
  if (up >= LOCK_ON_RELEASE || velocityY < -FLICK) return 'lock';
  return 'send';
}

/** Cancel-slide progress for the «‹ Влево — отмена» hint, in 5 % steps: the chat re-renders only on a step change. */
export function slideStep(x: number): number {
  'worklet';
  const raw = Math.min(1, Math.max(0, -x / CANCEL_DISTANCE));
  return Math.round(raw * 20) / 20;
}

// The whole gesture as a state machine (the button itself runs the same rules inside the gesture worklets).
export type RecordPhase = 'idle' | 'pressed' | 'recording' | 'locked';
export type RecordEvent =
  | { type: 'down'; at: number }
  | { type: 'hold'; at: number }
  | { type: 'move'; x: number; y: number }
  | { type: 'up'; at: number; x: number; y: number; vx: number; vy: number };
export type RecordAction = 'toggleMode' | 'start' | HoldResult | null;

export function recordGesture(phase: RecordPhase, pressedAt: number, event: RecordEvent): { phase: RecordPhase; pressedAt: number; action: RecordAction } {
  switch (event.type) {
    case 'down': return phase === 'idle' ? { phase: 'pressed', pressedAt: event.at, action: null } : { phase, pressedAt, action: null };
    case 'hold': return phase === 'pressed' && event.at - pressedAt >= HOLD_MS ? { phase: 'recording', pressedAt, action: 'start' } : { phase, pressedAt, action: null };
    case 'move': {
      if (phase !== 'recording') return { phase, pressedAt, action: null };
      const axis = holdAxis(event.x, event.y); const result = holdMove(axis.x, axis.y);
      if (result === 'cancel') return { phase: 'idle', pressedAt: 0, action: 'cancel' };
      if (result === 'lock') return { phase: 'locked', pressedAt, action: 'lock' };
      return { phase, pressedAt, action: null };
    }
    case 'up':
      if (phase === 'pressed') return { phase: 'idle', pressedAt: 0, action: event.at - pressedAt < HOLD_MS ? 'toggleMode' : null };
      if (phase === 'recording') {
        const result = holdRelease(event.x, event.y, event.vx, event.vy);
        return { phase: result === 'lock' ? 'locked' : 'idle', pressedAt: result === 'lock' ? pressedAt : 0, action: result };
      }
      // Locked: lifting the finger does nothing; the on-screen buttons send or cancel.
      return { phase, pressedAt, action: null };
  }
}
