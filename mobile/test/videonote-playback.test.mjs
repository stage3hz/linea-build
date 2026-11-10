import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';
const P = loadTs(new URL('../src/videonote/playback.ts', import.meta.url));
const on = { ready: true, autoplay: true, visible: true };

test('rest state: silent loop only when decrypted, autoplay allowed and on screen; otherwise the poster', () => {
  assert.equal(P.restState(on), 'muted');
  assert.equal(P.restState({ ...on, ready: false }), 'poster');
  assert.equal(P.restState({ ...on, autoplay: false }), 'poster'); // «Энергосбережение» / autoplay off
  assert.equal(P.restState({ ...on, visible: false }), 'poster');
});
test('tap plays with sound, tap again pauses and resumes; the end shrinks back to the loop', () => {
  let s = 'muted';
  s = P.reduceNote(s, { type: 'tap' }, on); assert.equal(s, 'sound'); assert.equal(P.isExpanded(s), true);
  s = P.reduceNote(s, { type: 'tap' }, on); assert.equal(s, 'paused'); assert.equal(P.isExpanded(s), true);
  s = P.reduceNote(s, { type: 'tap' }, on); assert.equal(s, 'sound');
  s = P.reduceNote(s, { type: 'end' }, on); assert.equal(s, 'muted');
  assert.equal(P.reduceNote('sound', { type: 'end' }, { ...on, autoplay: false }), 'poster');
  assert.equal(P.reduceNote('paused', { type: 'end' }, on), 'paused');
});
test('a tap before the file is decrypted does not expand (the caller downloads first)', () => {
  assert.equal(P.reduceNote('poster', { type: 'tap' }, { ...on, ready: false }), 'poster');
  assert.equal(P.reduceNote('poster', { type: 'tap' }, { ...on, autoplay: false }), 'sound');
});
test('interrupt (another circle, voice, music) shrinks a listening circle; scrolling away does not (Telegram)', () => {
  assert.equal(P.reduceNote('sound', { type: 'interrupt' }, on), 'muted');
  assert.equal(P.reduceNote('paused', { type: 'interrupt' }, on), 'muted');
  assert.equal(P.reduceNote('muted', { type: 'interrupt' }, on), 'muted');
  assert.equal(P.reduceNote('sound', { type: 'sync' }, { ...on, visible: false }), 'sound');
  assert.equal(P.reduceNote('paused', { type: 'sync' }, { ...on, visible: false }), 'paused');
  assert.equal(P.reduceNote('muted', { type: 'sync' }, { ...on, visible: false }), 'poster');
  assert.equal(P.reduceNote('sound', { type: 'sync' }, { ...on, ready: false }), 'poster'); // the file is gone
  assert.equal(P.reduceNote('sound', { type: 'sync' }, on), 'sound');
  assert.equal(P.reduceNote('poster', { type: 'sync' }, on), 'muted');
  assert.equal(P.reduceNote('muted', { type: 'sync' }, { ...on, ready: false }), 'poster');
});
test('only one circle has the sound: claiming releases the previous one and notifies other players', () => {
  const released = []; let voicePaused = 0;
  const off = P.onNoteSound(() => voicePaused++);
  P.claimNoteAudio('a', () => released.push('a'));
  P.claimNoteAudio('b', () => released.push('b'));
  assert.deepEqual(released, ['a']); assert.equal(P.noteAudioOwner(), 'b'); assert.equal(voicePaused, 2);
  P.releaseNoteAudio('a'); assert.equal(P.noteAudioOwner(), 'b'); // a stale release changes nothing
  P.interruptNoteAudio(); assert.deepEqual(released, ['a', 'b']); assert.equal(P.noteAudioOwner(), null);
  P.interruptNoteAudio(); assert.deepEqual(released, ['a', 'b']);
  off();
});
test('visibility: a list-scoped circle is hidden until its list reports it, then only reported ids', () => {
  let calls = 0; const off = P.subscribeVisibleNotes(() => calls++); // the chat scope by default
  assert.equal(P.isNoteVisible('x', P.CHAT_NOTES), false); // chat just opened: no players before the first report
  P.setVisibleNotes(['y']); assert.equal(P.isNoteVisible('x', P.CHAT_NOTES), false); assert.equal(P.isNoteVisible('y', P.CHAT_NOTES), true);
  P.setVisibleNotes(null); assert.equal(P.isNoteVisible('y', P.CHAT_NOTES), false); assert.equal(calls, 2); off();
  P.setVisibleNotes(['y']); assert.equal(calls, 2); // unsubscribed
  P.setVisibleNotes(null);
});
test('visibility scopes are independent; a circle outside any list is always visible', () => {
  let chat = 0, saved = 0;
  const offChat = P.subscribeVisibleNotes(() => chat++, 'chat');
  const offSaved = P.subscribeVisibleNotes(() => saved++, 'saved');
  P.setVisibleNotes(['a']); // the chat reports
  P.setVisibleNotes(['s'], 'saved');
  assert.equal(P.isNoteVisible('s', 'saved'), true); assert.equal(P.isNoteVisible('s', 'chat'), false);
  assert.equal(P.isNoteVisible('a', 'saved'), false); assert.equal(P.isNoteVisible('a', 'chat'), true);
  assert.equal(chat, 1); assert.equal(saved, 1); // a report wakes only its own list's circles
  assert.equal(P.isNoteVisible('anything', null), true); assert.equal(P.isNoteVisible('anything'), true);
  P.setVisibleNotes(null, 'chat'); assert.equal(P.isNoteVisible('s', 'saved'), true); // the chat closing does not hide Saved
  P.setVisibleNotes(null, 'saved'); offChat(); offSaved();
});
test('a sound request survives only while the file loads or is ready', () => {
  assert.equal(P.keepsSoundRequest('loading'), true);
  assert.equal(P.keepsSoundRequest('ready'), true);
  assert.equal(P.keepsSoundRequest('error'), false);
  assert.equal(P.keepsSoundRequest('idle'), false); // cancelled
});
test('progress events only while listening', () => {
  assert.equal(P.timeUpdateInterval('sound'), 0.1);
  for (const s of ['muted', 'poster', 'paused']) assert.equal(P.timeUpdateInterval(s), 0);
});
test('after a restart from 0, a late tick with the old loop position is dropped', () => {
  assert.equal(P.freshTick(null, 7, 1000), true); // no restart pending
  assert.equal(P.freshTick(1000, 4.2, 1050), false); // stale: the loop was at 4.2 s
  assert.equal(P.freshTick(1000, 0.05, 1050), true);
  assert.equal(P.freshTick(1000, 1.3, 2000), true); // 1 s played + slack
  assert.equal(P.freshTick(1000, 1.3, 2000, 1), true);
  assert.equal(P.freshTick(1000, 2.3, 2000, 2), true); // ×2 speed
  assert.equal(P.freshTick(1000, 2.3, 2000, 1), false);
  assert.equal(P.freshTick(1000, 0.2, 900), true); // clock skew never blocks a fresh start
});
test('circle sizes: 212 in the chat, up to 404 when playing, never wider than the row', () => {
  assert.deepEqual(P.noteSizes(375 - 18), { collapsed: 212, big: 357, scale: 212 / 357 });
  assert.equal(P.noteSizes(800).big, 404);
  assert.equal(P.noteSizes(404).big, 404);
  const narrow = P.noteSizes(180); assert.equal(narrow.collapsed, 180); assert.equal(narrow.big, 180); assert.equal(narrow.scale, 1);
  assert.equal(P.noteSizes(300.7).big, 300);
  for (const bad of [0, -5, NaN, Infinity]) { const s = P.noteSizes(bad); assert.equal(s.collapsed, 212); assert.equal(s.big, 212); }
  for (const w of [200, 250, 330, 390, 430, 1200]) { const s = P.noteSizes(w); assert.ok(s.big <= Math.max(w, 212) && s.big >= s.collapsed && s.scale > 0 && s.scale <= 1); }
});
test('autoload follows the network tier and power saving', () => {
  assert.equal(P.noteAutoload(1e6, 'fast', true), true);
  assert.equal(P.noteAutoload(9 * 1024 * 1024, 'fast', true), false);
  assert.equal(P.noteAutoload(1e6, 'medium', true), true);
  assert.equal(P.noteAutoload(3 * 1024 * 1024, 'medium', true), false);
  assert.equal(P.noteAutoload(1e5, 'slow', true), false);
  assert.equal(P.noteAutoload(1e5, 'fast', false), false);
});
test('progress is throttled: by time and by change, edges always pass', () => {
  const prev = { value: 0.5, at: 1000 };
  assert.equal(P.progressStep(prev, 5.5, 10, 1050), null); // too soon
  assert.equal(P.progressStep(prev, 5.01, 10, 1200), null); // too small
  assert.equal(P.progressStep(prev, 6, 10, 1200), 0.6);
  assert.equal(P.progressStep(prev, 10, 10, 1001), 1); // the end is never swallowed
  assert.equal(P.progressStep({ value: 0.3, at: 1000 }, 0, 10, 1001), 0); // restart
  assert.equal(P.progressStep(prev, 3, 0, 2000), null); // duration unknown
  assert.equal(P.progressStep(prev, 20, 10, 2000), 1);
});
test('ring geometry: dash offset shrinks clockwise from 12 o\'clock', () => {
  const r = 50, c = 2 * Math.PI * r;
  const at = p => P.ringDash(p, r);
  assert.equal(at(0).length, c);
  assert.equal(at(0).offset, c);
  assert.ok(Math.abs(at(0.25).offset - c * 0.75) < 1e-9);
  assert.ok(Math.abs(at(0.5).offset - c / 2) < 1e-9);
  assert.equal(at(1).offset, 0);
  assert.equal(at(1.4).offset, 0); assert.equal(at(-1).offset, c); assert.equal(at(NaN).offset, c);
});

test('the header strip belongs to the circle that set it; others cannot clear it, unchanged updates stay quiet', () => {
  const { setNoteBar, getNoteBar, subscribeNoteBar } = loadTs(new URL('../src/videonote/playback.ts', import.meta.url));
  let calls = 0; const off = subscribeNoteBar(() => { calls++; });
  const bar = (key, playing) => ({ key, attachmentId: 'a', playing, toggle() {}, close() {}, applyRate() {} });
  setNoteBar('n1', bar('n1', true)); assert.equal(getNoteBar().key, 'n1'); assert.equal(calls, 1);
  setNoteBar('n1', bar('n1', true)); assert.equal(calls, 1);
  setNoteBar('n1', bar('n1', false)); assert.equal(getNoteBar().playing, false); assert.equal(calls, 2);
  setNoteBar('n2', null); assert.equal(getNoteBar().key, 'n1'); assert.equal(calls, 2);
  setNoteBar('n1', null); assert.equal(getNoteBar(), null); assert.equal(calls, 3);
  off();
});

test('seconds played count whole seconds and never pass the length', () => {
  const { playedSeconds } = loadTs(new URL('../src/videonote/playback.ts', import.meta.url));
  assert.equal(playedSeconds(0.2, 7.4), 0);
  assert.equal(playedSeconds(3.99, 7.4), 3);
  assert.equal(playedSeconds(9, 7.4), 7);
  assert.equal(playedSeconds(-1, 7), 0);
  assert.equal(playedSeconds(2.5, 0), 2);
});

test('rewind along the ring: clockwise share from 12 o\'clock, no wrap across the top, only from the ring band', () => {
  const { scrubFraction, onScrubBand, SCRUB_MAX } = loadTs(new URL('../src/videonote/playback.ts', import.meta.url));
  const size = 400, near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);
  near(scrubFraction(200, 0, size, null), 0);       // 12 o'clock
  near(scrubFraction(400, 200, size, null), 0.25);  // 3 o'clock
  near(scrubFraction(200, 400, size, null), 0.5);   // 6 o'clock
  near(scrubFraction(0, 200, size, null), 0.75);    // 9 o'clock
  // Dragged past the top from the end: stays at the end, and from the start: stays at the start.
  assert.equal(scrubFraction(210, 0, size, 0.95), SCRUB_MAX);
  assert.equal(scrubFraction(190, 0, size, 0.03), 0);
  assert.equal(scrubFraction(199, 0, size, 0.5) <= SCRUB_MAX, true);
  assert.equal(onScrubBand(200, 6, size), true);    // on the ring
  assert.equal(onScrubBand(200, 200, size), false); // the middle is a tap / a scroll
  assert.equal(onScrubBand(200, 80, size), false);
});
