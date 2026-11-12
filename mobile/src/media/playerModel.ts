// The video player's decisions (VideoPlayerView.tsx): pure, covered by test/video-player.test.mjs. The functions the
// seek bar calls while a finger is on it are worklets, so the bar follows the finger on the UI thread; nothing here
// imports React Native. The numbers are those of the approved browser demo (a YouTube-like phone player).

/** The controls hide themselves this long after they were shown, while the video plays. */
export const HIDE_MS = 3000;
/** Two taps this close in time and place are a double tap; a single tap is acted on only after this wait. */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP = 110;
/** One double tap seeks this far; further taps on the same side within the burst window add as much again. */
export const SEEK_STEP = 10;
export const SEEK_BURST_MS = 700;
/** Press and hold: this long, then the video runs at HOLD_RATE until the finger lifts. */
export const HOLD_MS = 500;
export const HOLD_RATE = 2;
/** The finger pulled this far (pt) above where it took the seek bar: precise seeking, the bar moves at FINE_FACTOR. */
export const FINE_PULL = 70;
export const FINE_FACTOR = 0.2;
/** While the bar is dragged the player is sought at most this often (ms); always once more on release. */
export const SCRUB_SEEK_MS = 100;
export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
/** The time tooltip stays within this share of the bar, so it never leaves the screen at either end. */
export const TOOLTIP_MIN = 0.18;
export const TOOLTIP_MAX = 0.82;

/** «0:07», «12:40», «75:03» — minutes are not folded into hours, as in the demo. */
export function clock(seconds: number): string {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

/** The speed as the settings sheet names it: «Обычная» for 1, otherwise «1.5×». */
export const speedLabel = (speed: number): string => speed === 1 ? 'Обычная' : `${speed}×`;

/** Where a seek by `delta` seconds lands: never before the start or past the end (0 while the length is unknown). */
export function seekTarget(current: number, duration: number, delta: number): number {
  const length = Number.isFinite(duration) && duration > 0 ? duration : 0;
  return Math.max(0, Math.min(length, (Number.isFinite(current) ? current : 0) + delta));
}

/** 0 … 1 of the video played; 0 while its length is unknown. */
export function fraction(time: number, duration: number): number {
  'worklet';
  if (!(duration > 0) || !Number.isFinite(time)) return 0;
  return Math.max(0, Math.min(1, time / duration));
}

// ─── Taps on the picture ─────────────────────────────────────────────────────────────────────────

export type TapState = { lastTime: number; lastX: number; /** Seconds gathered by the running burst of seek taps. */ acc: number; side: -1 | 0 | 1; accTime: number };
export const TAP_IDLE: TapState = { lastTime: -1e12, lastX: 0, acc: 0, side: 0, accTime: -1e12 };

/** True while a burst of seek taps is still open: its label is on the screen and one more tap adds to it. */
export const burstActive = (state: TapState, time: number): boolean => state.acc > 0 && time - state.accTime <= SEEK_BURST_MS;

/**
 * One finished tap at `x` (pt from the left of a picture `width` wide) at `time` (ms).
 * `seek` −1 / 1: seek back / forward by SEEK_STEP now, and show `state.acc` seconds as the gathered total.
 * `seek` 0: possibly a single tap — the caller waits DOUBLE_TAP_MS and toggles the controls if nothing followed.
 * A double tap starts a burst on its side; while the burst is open, every further tap on that side continues it
 * at once (the «20 секунд», «30 секунд» of YouTube), and a tap on the other side is an ordinary first tap.
 */
export function tapStep(state: TapState, tap: { x: number; time: number; width: number }): { state: TapState; seek: -1 | 0 | 1 } {
  const side = tap.x < tap.width / 2 ? -1 : 1;
  const continues = burstActive(state, tap.time) && side === state.side;
  const double = tap.time - state.lastTime < DOUBLE_TAP_MS && Math.abs(tap.x - state.lastX) < DOUBLE_TAP_SLOP;
  if (continues || double) return { state: { lastTime: tap.time, lastX: tap.x, acc: (continues ? state.acc : 0) + SEEK_STEP, side, accTime: tap.time }, seek: side };
  return { state: { ...state, lastTime: tap.time, lastX: tap.x }, seek: 0 };
}

// ─── The seek bar ────────────────────────────────────────────────────────────────────────────────

/** Where on the bar (0 … 1) a touch at `x` pt from its left end is. */
export function fractionAt(x: number, width: number): number {
  'worklet';
  if (!(width > 0) || !Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x / width));
}

/** Precise seeking starts once the finger is FINE_PULL above where it went down, and stays on until it lifts. */
export function fineEngaged(startY: number, y: number, already: boolean): boolean {
  'worklet';
  return already || startY - y > FINE_PULL;
}

/** The bar position after the finger moved `dx` pt sideways: one to one, or FINE_FACTOR of it in precise seeking. */
export function scrubMove(position: number, dx: number, width: number, fine: boolean): number {
  'worklet';
  if (!(width > 0) || !Number.isFinite(dx)) return position;
  return Math.max(0, Math.min(1, position + dx / width * (fine ? FINE_FACTOR : 1)));
}

/** Centre of the time tooltip (pt from the bar's left end) for a bar position. */
export function tooltipCenter(position: number, width: number): number {
  'worklet';
  return Math.max(TOOLTIP_MIN, Math.min(TOOLTIP_MAX, position)) * width;
}

/**
 * The frame shown above the bar is asked for at most once per step of the video, so a slow drag does not queue a
 * decode for every point the finger passes: about 120 steps over the whole video, never finer than half a second.
 */
export function thumbTime(time: number, duration: number): number {
  if (!(duration > 0) || !Number.isFinite(time)) return 0;
  const step = Math.max(0.5, duration / 120);
  return Math.max(0, Math.min(duration, Math.round(time / step) * step));
}

// ─── The three chevrons of a double-tap seek ─────────────────────────────────────────────────────

/**
 * Opacity of chevron `index` (0 … 2, left to right) at `phase` 0 … 1 of the 750 ms loop: each one lights up
 * (0.25 → 1 → 0.25) 150 ms after its neighbour, running in the direction of the seek.
 */
export function chevronOpacity(phase: number, index: number, forward: boolean): number {
  'worklet';
  const order = forward ? index : 2 - index;
  const local = (((phase - order * 0.2) % 1) + 1) % 1;
  if (local < 0.3) return 0.25 + 0.75 * (local / 0.3);
  if (local < 0.7) return 1 - 0.75 * ((local - 0.3) / 0.4);
  return 0.25;
}
