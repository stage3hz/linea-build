import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';
const G = loadTs(new URL('../src/videonote/recordGesture.ts', import.meta.url));
const run = events => { let phase = 'idle', pressedAt = 0; const actions = []; for (const e of events) { const r = G.recordGesture(phase, pressedAt, e); phase = r.phase; pressedAt = r.pressedAt; if (r.action) actions.push(r.action); } return { phase, actions }; };
const up = (at, x = 0, y = 0, vx = 0, vy = 0) => ({ type: 'up', at, x, y, vx, vy });

test('a quick tap switches voice ↔ video, nothing records', () => {
  assert.deepEqual(run([{ type: 'down', at: 0 }, up(120)]), { phase: 'idle', actions: ['toggleMode'] });
});
test('hold starts recording after HOLD_MS; release sends', () => {
  assert.deepEqual(run([{ type: 'down', at: 0 }, { type: 'hold', at: 100 }]).actions, []);
  assert.deepEqual(run([{ type: 'down', at: 0 }, { type: 'hold', at: G.HOLD_MS }, up(900)]), { phase: 'idle', actions: ['start', 'send'] });
});
test('slide left cancels while moving, slide up locks; release afterwards does nothing more', () => {
  assert.deepEqual(run([{ type: 'down', at: 0 }, { type: 'hold', at: 200 }, { type: 'move', x: -80, y: 0 }, { type: 'move', x: -G.CANCEL_DISTANCE, y: -10 }, up(900, -160)]), { phase: 'idle', actions: ['start', 'cancel'] });
  assert.deepEqual(run([{ type: 'down', at: 0 }, { type: 'hold', at: 200 }, { type: 'move', x: -5, y: -G.LOCK_DISTANCE }, up(900, 0, -120)]), { phase: 'locked', actions: ['start', 'lock'] });
});
test('release: a shorter slide or a flick still cancels/locks', () => {
  assert.equal(G.holdRelease(-G.CANCEL_ON_RELEASE, 0, 0, 0), 'cancel');
  assert.equal(G.holdRelease(-20, 0, -G.FLICK - 1, 0), 'cancel');
  assert.equal(G.holdRelease(0, -G.LOCK_ON_RELEASE, 0, 0), 'lock');
  assert.equal(G.holdRelease(0, -10, 0, -G.FLICK - 1), 'lock');
  assert.equal(G.holdRelease(40, 30, 300, 300), 'send'); // right/down never count
});
test('one axis at a time: the larger of left/up wins', () => {
  assert.deepEqual(G.holdAxis(-50, -20), { x: -50, y: 0 });
  assert.deepEqual(G.holdAxis(-20, -50), { x: 0, y: -50 });
  assert.deepEqual(G.holdAxis(30, 40), { x: 0, y: 0 });
});
test('cancel hint progress is quantised (5 % steps), so the chat re-renders rarely', () => {
  assert.equal(G.slideStep(0), 0);
  assert.equal(G.slideStep(-G.CANCEL_DISTANCE / 2), 0.5);
  assert.equal(G.slideStep(-1), 0);
  assert.equal(G.slideStep(-1000), 1);
  const steps = new Set(); for (let x = 0; x >= -G.CANCEL_DISTANCE; x--) steps.add(G.slideStep(x));
  assert.equal(steps.size, 21);
});
