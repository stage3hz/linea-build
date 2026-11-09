// Round video message playback, as in Telegram (pure logic, covered by test/videonote-playback.test.mjs).
// poster — the first frame (thumbnail) only: not downloaded yet, autoplay off, or off screen;
// muted  — plays silently in a loop inside the chat;
// sound  — enlarged, from the start with sound, ring around it; paused — the same, stopped by a tap.
export type NoteState = 'poster' | 'muted' | 'sound' | 'paused';
export type NoteContext = { ready: boolean; autoplay: boolean; visible: boolean };
export type NoteEvent = { type: 'tap' } | { type: 'end' } | { type: 'interrupt' } | { type: 'sync' };

/** What a circle shows when nobody is listening to it. */
export const restState = (ctx: NoteContext): NoteState => ctx.ready && ctx.autoplay && ctx.visible ? 'muted' : 'poster';
export const isExpanded = (state: NoteState) => state === 'sound' || state === 'paused';

export function reduceNote(state: NoteState, event: NoteEvent, ctx: NoteContext): NoteState {
  switch (event.type) {
    case 'tap':
      if (state === 'sound') return 'paused';
      if (state === 'paused') return 'sound';
      // Not decrypted yet: the caller starts the download and taps again once the file is there.
      return ctx.ready ? 'sound' : state;
    case 'end':
      return state === 'sound' ? restState(ctx) : state;
    case 'interrupt': // another circle, a voice message or music took the sound
      return isExpanded(state) ? restState(ctx) : state;
    case 'sync':
      if (!ctx.ready) return 'poster';
      // Telegram: a circle being listened to keeps playing when it scrolls out of view (it stops only
      // when its row is unmounted far away, or something else takes the sound).
      if (isExpanded(state)) return state;
      return restState(ctx);
  }
}

/** Telegram downloads round videos by itself on Wi-Fi/fast links; on a medium link only small ones; never on EDGE. */
export const NOTE_AUTOLOAD_BYTES = 8 * 1024 * 1024, NOTE_AUTOLOAD_MEDIUM_BYTES = 2 * 1024 * 1024;
export function noteAutoload(size: number, tier: 'slow' | 'medium' | 'fast', powerVideo: boolean): boolean {
  if (!powerVideo) return false;
  if (tier === 'fast') return size <= NOTE_AUTOLOAD_BYTES;
  if (tier === 'medium') return size <= NOTE_AUTOLOAD_MEDIUM_BYTES;
  return false;
}

/**
 * Throttles playback progress: a new value is published only after `minMs` and a change of at least
 * `minDelta` (or at the very start/end), so a tick never re-renders the chat. Returns null to skip.
 */
export function progressStep(prev: { value: number; at: number }, currentSec: number, durationSec: number, now: number, minMs = 100, minDelta = 0.002): number | null {
  if (!(durationSec > 0) || !Number.isFinite(currentSec)) return null;
  const value = Math.max(0, Math.min(1, currentSec / durationSec));
  const edge = (value === 0 || value === 1) && value !== prev.value;
  if (edge) return value;
  if (now - prev.at < minMs || Math.abs(value - prev.value) < minDelta) return null;
  return value;
}

/** Progress ring geometry: a circle of radius `r` drawn from 12 o'clock clockwise (rotate −90°). */
export function ringDash(progress: number, r: number): { length: number; offset: number } {
  'worklet';
  const length = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  return { length, offset: length * (1 - p) };
}

// ---- One circle with sound at a time; anything else that takes the sound interrupts it. ----
type Owner = { id: string; release: () => void };
let owner: Owner | null = null;
/** Takes the sound for `id`; the previous holder's `release` runs (its circle shrinks back). */
const soundListeners = new Set<() => void>();
/** Other players (voice messages) pause themselves when a circle starts with sound. */
export function onNoteSound(listener: () => void) { soundListeners.add(listener); return () => { soundListeners.delete(listener); }; }
export function claimNoteAudio(id: string, release: () => void) {
  const previous = owner; owner = { id, release };
  for (const listener of soundListeners) { try { listener(); } catch { /* ignore */ } }
  if (previous && previous.id !== id) { try { previous.release(); } catch { /* unmounted */ } }
}
/** Gives the sound back (only if `id` still holds it). */
export function releaseNoteAudio(id: string) { if (owner?.id === id) owner = null; }
/** Voice/music players call this before they start: the playing circle stops and shrinks. */
export function interruptNoteAudio() { const previous = owner; owner = null; if (previous) { try { previous.release(); } catch { /* unmounted */ } } }
export const noteAudioOwner = () => owner?.id ?? null;

// ---- Which circles are on screen. ----
// Each list is its own scope (the chat, «Избранное»…): a list reports its viewable rows, and a circle
// rendered with that scope counts as visible only once the list has listed its id — so opening a chat
// never creates a player for every rendered row before the first report. A circle rendered without a
// scope (a standalone preview) is always visible. Separate scopes never hide each other's circles.
export const CHAT_NOTES = 'chat';
const scopes = new Map<string, Set<string>>();
const scopeListeners = new Map<string, Set<() => void>>();
/** The list `scope` reports its viewable note ids; null (the list unmounted) forgets the report. */
export function setVisibleNotes(ids: Iterable<string> | null, scope: string = CHAT_NOTES) {
  if (ids) scopes.set(scope, new Set(ids)); else scopes.delete(scope);
  for (const listener of [...(scopeListeners.get(scope) ?? [])]) listener();
}
export const isNoteVisible = (id: string, scope?: string | null) => !scope || !!scopes.get(scope)?.has(id);
export function subscribeVisibleNotes(listener: () => void, scope: string = CHAT_NOTES) {
  let set = scopeListeners.get(scope);
  if (!set) { set = new Set(); scopeListeners.set(scope, set); }
  set.add(listener);
  return () => { set!.delete(listener); if (!set!.size && scopeListeners.get(scope) === set) scopeListeners.delete(scope); };
}

/** A tap made while the file loads asks to play it with sound when ready; a failed or cancelled download drops that wish. */
export const keepsSoundRequest = (status: 'idle' | 'loading' | 'ready' | 'error') => status === 'loading' || status === 'ready';

/** Progress events only while listening (the ring); a silent loop needs none. Seconds; 0 turns them off. */
export const timeUpdateInterval = (state: NoteState) => state === 'sound' ? 0.1 : 0;

/**
 * After the player is sent back to 0 for a listen, it may still report the old loop position once or
 * twice. Such a tick is stale when it is ahead of what could have played since the restart.
 */
export function freshTick(restartAt: number | null, currentSec: number, now: number, rate = 1, slackSec = 0.4): boolean {
  if (restartAt === null) return true;
  return currentSec <= Math.max(0, now - restartAt) / 1000 * rate + slackSec;
}

/**
 * Sizes of a circle in a row `available` pt wide (the real row width): 212 pt in the chat, grows to at
 * most 404 pt (Telegram) and never past the row, so it never overflows its side.
 */
export const NOTE_COLLAPSED = 212, NOTE_EXPANDED_MAX = 404;
export function noteSizes(available: number): { collapsed: number; big: number; scale: number } {
  const room = Number.isFinite(available) && available > 0 ? Math.floor(available) : NOTE_COLLAPSED;
  const collapsed = Math.min(NOTE_COLLAPSED, room);
  const big = Math.max(collapsed, Math.min(NOTE_EXPANDED_MAX, room));
  return { collapsed, big, scale: collapsed / big };
}

/**
 * The strip under the chat header while a circle plays with sound (Telegram: pause, «Видеосообщение»,
 * speed, ✕). The playing bubble publishes its controls here; only the bubble that set it can clear it.
 */
export type NoteBar = { key: string; attachmentId: string; playing: boolean; toggle: () => void; close: () => void; applyRate: (rate: number) => void };
let noteBar: NoteBar | null = null;
const barListeners = new Set<() => void>();
export function setNoteBar(key: string, next: NoteBar | null) {
  if (!next && noteBar?.key !== key) return;
  if (next && noteBar && noteBar.key === next.key && noteBar.playing === next.playing && noteBar.attachmentId === next.attachmentId) { noteBar = next; return; }
  noteBar = next;
  for (const listener of [...barListeners]) listener();
}
export const getNoteBar = () => noteBar;
export function subscribeNoteBar(listener: () => void) { barListeners.add(listener); return () => { barListeners.delete(listener); }; }

/** Whole seconds played, for the counter under a circle that is being listened to (changes once a second). */
export const playedSeconds = (currentSec: number, durationSec: number) => Math.max(0, Math.floor(Math.min(currentSec, durationSec > 0 ? durationSec : currentSec)));
