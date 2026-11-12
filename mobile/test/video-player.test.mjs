// The video player (src/media/VideoPlayerView.tsx): the decisions in src/media/playerModel.ts, and that the player
// keeps what the old one did (picture in picture, the start nudges) and takes the touches it needs from the viewers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadTs } from './support/load-ts.mjs';

const ts = createRequire(import.meta.url)('typescript');

const M = loadTs(new URL('../src/media/playerModel.ts', import.meta.url), {});
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('the clock and the speed names', () => {
  assert.equal(M.clock(0), '0:00');
  assert.equal(M.clock(65.9), '1:05');
  assert.equal(M.clock(4503), '75:03');
  assert.equal(M.clock(NaN), '0:00');
  assert.equal(M.clock(-3), '0:00');
  assert.deepEqual(M.SPEEDS, [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
  assert.equal(M.speedLabel(1), 'Обычная');
  assert.equal(M.speedLabel(1.5), '1.5×');
  assert.equal(M.speedLabel(0.25), '0.25×');
});

test('the numbers of the approved demo', () => {
  assert.equal(M.HIDE_MS, 3000);
  assert.equal(M.DOUBLE_TAP_MS, 300);
  assert.equal(M.SEEK_STEP, 10);
  assert.equal(M.SEEK_BURST_MS, 700);
  assert.equal(M.HOLD_MS, 500);
  assert.equal(M.HOLD_RATE, 2);
  assert.equal(M.FINE_PULL, 70);
  assert.equal(M.FINE_FACTOR, 0.2);
});

test('a lone tap is not a seek; the caller toggles the controls after the double-tap window', () => {
  const first = M.tapStep(M.TAP_IDLE, { x: 300, time: 1000, width: 400 });
  assert.equal(first.seek, 0);
  assert.equal(first.state.acc, 0);
  assert.equal(M.burstActive(first.state, 1300), false);
  // The next tap comes too late to make a pair.
  assert.equal(M.tapStep(first.state, { x: 300, time: 1300, width: 400 }).seek, 0);
});

test('a double tap seeks towards its side, and further taps gather 20, 30…', () => {
  let step = M.tapStep(M.TAP_IDLE, { x: 320, time: 1000, width: 400 });
  step = M.tapStep(step.state, { x: 325, time: 1200, width: 400 });
  assert.equal(step.seek, 1);
  assert.equal(step.state.acc, 10);
  assert.equal(M.burstActive(step.state, 1500), true);
  // Slower than a double tap, but inside the burst, and anywhere on the same half.
  step = M.tapStep(step.state, { x: 220, time: 1800, width: 400 });
  assert.equal(step.seek, 1);
  assert.equal(step.state.acc, 20);
  step = M.tapStep(step.state, { x: 390, time: 2100, width: 400 });
  assert.equal(step.state.acc, 30);
  // The burst is over 0.7 s after its last tap: the next tap starts from nothing.
  assert.equal(M.burstActive(step.state, 2801), false);
  const late = M.tapStep(step.state, { x: 390, time: 2900, width: 400 });
  assert.equal(late.seek, 0);
});

test('a tap on the other side does not continue a burst; a double tap there starts its own from 10', () => {
  let step = M.tapStep(M.TAP_IDLE, { x: 50, time: 0, width: 400 });
  step = M.tapStep(step.state, { x: 55, time: 150, width: 400 });
  assert.equal(step.seek, -1);
  step = M.tapStep(step.state, { x: 60, time: 300, width: 400 });
  assert.equal(step.state.acc, 20);
  const other = M.tapStep(step.state, { x: 350, time: 450, width: 400 });
  assert.equal(other.seek, 0, 'too far from the last tap for a pair, and not the side of the burst');
  const pair = M.tapStep(other.state, { x: 352, time: 600, width: 400 });
  assert.equal(pair.seek, 1);
  assert.equal(pair.state.acc, 10);
});

test('two quick taps far apart are not a double tap', () => {
  const first = M.tapStep(M.TAP_IDLE, { x: 210, time: 0, width: 400 });
  assert.equal(M.tapStep(first.state, { x: 330, time: 100, width: 400 }).seek, 0);
});

test('a seek never leaves the video', () => {
  assert.equal(M.seekTarget(3, 60, -10), 0);
  assert.equal(M.seekTarget(55, 60, 10), 60);
  assert.equal(M.seekTarget(20, 60, 10), 30);
  assert.equal(M.seekTarget(20, NaN, 10), 0, 'length not known yet');
  assert.equal(M.fraction(15, 60), 0.25);
  assert.equal(M.fraction(70, 60), 1);
  assert.equal(M.fraction(5, 0), 0);
  assert.equal(M.fraction(5, -1), 0, 'expo-video reports -1 when it cannot tell the buffer');
  assert.equal(M.fraction(-1, 60), 0);
});

test('the seek bar: one to one, then a fifth of the movement once the finger is pulled 70 pt up', () => {
  assert.equal(M.fractionAt(150, 300), 0.5);
  assert.equal(M.fractionAt(-20, 300), 0);
  assert.equal(M.fractionAt(900, 300), 1);
  assert.equal(M.fractionAt(10, 0), 0);
  near(M.scrubMove(0.5, 30, 300, false), 0.6);
  near(M.scrubMove(0.5, 30, 300, true), 0.52);
  assert.equal(M.scrubMove(0.95, 60, 300, false), 1);
  assert.equal(M.scrubMove(0.05, -60, 300, false), 0);
  assert.equal(M.scrubMove(0.4, 10, 0, false), 0.4);
  assert.equal(M.fineEngaged(600, 531, false), false);
  assert.equal(M.fineEngaged(600, 529, false), true);
  assert.equal(M.fineEngaged(600, 640, true), true, 'stays precise until the finger lifts');
  assert.equal(M.fineEngaged(600, 700, false), false, 'pulling down is not it');
});

test('the tooltip stays on the screen, and frames are asked for in steps', () => {
  near(M.tooltipCenter(0, 300), 54);
  near(M.tooltipCenter(0.5, 300), 150);
  near(M.tooltipCenter(1, 300), 246);
  assert.equal(M.thumbTime(10.2, 30), 10, 'never finer than half a second');
  assert.equal(M.thumbTime(10.3, 30), 10.5);
  assert.equal(M.thumbTime(1234, 7200), 1260, 'a two-hour film: a frame a minute');
  assert.equal(M.thumbTime(99, 30), 30);
  assert.equal(M.thumbTime(5, 0), 0);
});

test('the chevrons light up one after another in the direction of the seek', () => {
  near(M.chevronOpacity(0, 0, true), 0.25);
  near(M.chevronOpacity(0.3, 0, true), 1);
  near(M.chevronOpacity(0.5, 1, true), 1, 'the second one 150 ms later');
  near(M.chevronOpacity(0.7, 2, true), 1);
  near(M.chevronOpacity(0.3, 2, false), 1, 'backwards the rightmost goes first');
  near(M.chevronOpacity(0.7, 0, false), 1);
  for (let phase = 0; phase <= 1; phase += 0.05) for (const index of [0, 1, 2]) { const value = M.chevronOpacity(phase, index, true); assert.ok(value >= 0.25 - 1e-9 && value <= 1 + 1e-9); }
});

test('no worklet of the model has a default parameter (a module constant there is a crash on the UI thread)', () => {
  const source = readFileSync(new URL('../src/media/playerModel.ts', import.meta.url), 'utf8');
  for (const match of source.matchAll(/export function (\w+)\(([^)]*)\)[^{]*\{\s*'worklet'/g)) assert.doesNotMatch(match[2], /=/, match[1]);
});

test('the player draws its own controls and both viewers hand it the touches it needs', () => {
  const player = readFileSync(new URL('../src/media/VideoPlayerView.tsx', import.meta.url), 'utf8');
  assert.match(player, /nativeControls=\{false\}/);
  assert.match(player, /contentFit=\{fill\?'cover':'contain'\}/);
  assert.match(player, /value\.loop=false;value\.audioMixingMode='doNotMix'/);
  const viewer = readFileSync(new URL('../src/media/AttachmentViewer.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(viewer, /nativeControls/);
  assert.match(viewer, /scrollEnabled=\{!zoomed&&!playerBusy\}/, 'the album does not page under a dragged seek bar');
  assert.equal(viewer.match(/enabled:!zoomed&&!playerBusy/g)?.length, 2, 'neither viewer starts its swipe-to-close');
  assert.match(viewer, /\{chrome&&!playerOn\?/, 'the gallery does not repeat close / keep / share over the player');
});

test('every interface string of the player has an English entry', () => {
  const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
  const player = readFileSync(new URL('../src/media/VideoPlayerView.tsx', import.meta.url), 'utf8');
  // Literals only, read from the syntax tree: a template with ${…} is built at runtime and cannot be a dictionary key.
  const tree = ts.createSourceFile('VideoPlayerView.tsx', player, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const strings = [];
  (function visit(node) {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /[А-Яа-яЁё]/.test(node.text)) strings.push(node.text);
    ts.forEachChild(node, visit);
  })(tree);
  assert.ok(strings.length > 15);
  assert.deepEqual(strings.filter(text => en[text] === undefined), []);
  assert.notEqual(en[M.speedLabel(1)], undefined);
});
