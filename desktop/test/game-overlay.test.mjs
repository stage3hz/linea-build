import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { encodeFrame, fitSize, parseHostLine, injectDecision, createGameOverlay, MAGIC, HEADER_SIZE, MAX_WIDTH, MAX_HEIGHT, STABLE_MS } = require('../game-overlay.cjs');

test('frame header layout matches native/overlay/src/shared.h', () => {
  const pixels = Buffer.alloc(3 * 2 * 4, 0xab);
  const buf = encodeFrame({ width: 3, height: 2, corner: 'bottomRight', opacity: 0.8, visible: true, margin: 16, frame: 7, pixels });
  assert.equal(buf.length, HEADER_SIZE + 24);
  assert.equal(buf.readUInt32LE(0), MAGIC);
  assert.equal(buf.toString('latin1', 0, 4), 'INVO');
  assert.equal(buf.readUInt32LE(4), 1);          // version
  assert.equal(buf.readUInt32LE(8), 3);          // width
  assert.equal(buf.readUInt32LE(12), 2);         // height
  assert.equal(buf.readUInt32LE(16), 12);        // stride
  assert.equal(buf.readUInt32LE(20), 7);         // frame
  assert.equal(buf.readUInt32LE(24), 3);         // corner bottomRight
  assert.equal(buf.readUInt32LE(28), 204);       // opacity 0.8 * 255
  assert.equal(buf.readUInt32LE(32), 1);         // visible
  assert.equal(buf.readUInt32LE(36), 16);        // margin
  assert.ok(buf.subarray(40, 64).every(b => b === 0)); // consumer pid/tick + reserved: DLL-owned
  assert.ok(buf.subarray(64).every(b => b === 0xab));
  // The C++ side agrees on the offsets and limits.
  const header = readFileSync(new URL('../native/overlay/src/shared.h', import.meta.url), 'utf8');
  assert.match(header, /kFrameMagic = 0x4F564E49/);
  assert.match(header, new RegExp(`kMaxWidth = ${MAX_WIDTH};`));
  assert.match(header, new RegExp(`kMaxHeight = ${MAX_HEIGHT};`));
  assert.match(header, /kHeaderSize = 64;/);
  for (const [name, offset] of [['width', 8], ['stride', 16], ['corner', 24], ['visible', 32], ['consumer_pid', 40], ['consumer_tick', 44]])
    assert.match(header, new RegExp(`${name};\\s+// ${offset}\\b`), name);
});

test('frame encoder refuses oversize or mismatched pictures; empty header when hidden', () => {
  assert.throws(() => encodeFrame({ width: MAX_WIDTH + 1, height: 1, pixels: Buffer.alloc((MAX_WIDTH + 1) * 4) }), RangeError);
  assert.throws(() => encodeFrame({ width: 1, height: MAX_HEIGHT + 1, pixels: Buffer.alloc((MAX_HEIGHT + 1) * 4) }), RangeError);
  assert.throws(() => encodeFrame({ width: 2, height: 2, pixels: Buffer.alloc(3) }), RangeError);
  const hidden = encodeFrame({ visible: false, opacity: 5, corner: 'nowhere' });
  assert.equal(hidden.length, HEADER_SIZE);
  assert.equal(hidden.readUInt32LE(24), 0); // unknown corner → topLeft
  assert.equal(hidden.readUInt32LE(28), 255); // clamped
  assert.equal(hidden.readUInt32LE(32), 0);
});

test('fitSize keeps the aspect ratio within 400×600', () => {
  assert.deepEqual(fitSize(260, 300), { width: 260, height: 300 });
  assert.deepEqual(fitSize(520, 600), { width: 400, height: 461 });
  assert.deepEqual(fitSize(390, 932), { width: 251, height: 600 });
});

test('helper lines are validated', () => {
  const fg = { type: 'fg', pid: 42, path: 'D:\\Games\\game.exe', fullscreen: true, exclusive: false, wow64: false, elevated: false, drawing: true };
  assert.deepEqual(parseHostLine(JSON.stringify(fg)), fg);
  assert.equal(parseHostLine(JSON.stringify({ ...fg, pid: -1 })), null);
  assert.equal(parseHostLine(JSON.stringify({ ...fg, fullscreen: 'yes' })), null);
  assert.equal(parseHostLine(JSON.stringify({ ...fg, path: 'x'.repeat(2000) })), null);
  assert.deepEqual(parseHostLine(JSON.stringify({ ...fg, elevated: null })).elevated, null);
  assert.equal(parseHostLine('not json'), null);
  assert.equal(parseHostLine('{"type":"other"}'), null);
  assert.deepEqual(parseHostLine('{"type":"error","code":"config-exists"}'), { type: 'error', code: 'config-exists' });
});

const game = { type: 'fg', pid: 500, path: 'D:\\Games\\Shooter\\shooter.exe', fullscreen: true, exclusive: true, wow64: false, elevated: false, drawing: false };
const ctx = { inVoice: true, ownPids: new Set([1, 2]), ownExe: 'INVIZENT.exe', systemRoot: 'C:\\Windows', stableMs: STABLE_MS, attempts: new Map(), now: 100000 };

test('inject only into a settled fullscreen game while in a voice channel', () => {
  assert.deepEqual(injectDecision(game, ctx), { inject: true, reason: 'fullscreen-game' });
  assert.equal(injectDecision({ ...game, exclusive: false }, ctx).inject, true); // borderless counts the same
  assert.equal(injectDecision(game, { ...ctx, inVoice: false }).reason, 'not-in-voice');
  assert.equal(injectDecision({ ...game, fullscreen: false }, ctx).reason, 'not-fullscreen');
  assert.equal(injectDecision(game, { ...ctx, stableMs: 500 }).reason, 'settling');
  assert.equal(injectDecision({ ...game, pid: 0 }, ctx).reason, 'no-window');
});

test('never: own processes, system/shell, browsers, 32-bit, elevated or unknown', () => {
  assert.equal(injectDecision({ ...game, pid: 2 }, ctx).reason, 'own-process');
  assert.equal(injectDecision({ ...game, path: 'C:\\Users\\a\\AppData\\Local\\Programs\\INVIZENT\\INVIZENT.exe' }, ctx).reason, 'excluded');
  assert.equal(injectDecision({ ...game, path: 'C:\\Windows\\explorer.exe' }, ctx).reason, 'excluded');
  assert.equal(injectDecision({ ...game, path: 'C:\\Windows\\System32\\game.exe' }, ctx).reason, 'system');
  assert.equal(injectDecision({ ...game, path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }, ctx).reason, 'excluded');
  assert.equal(injectDecision({ ...game, wow64: true }, ctx).reason, '32-bit-or-unknown');
  assert.equal(injectDecision({ ...game, wow64: null }, ctx).reason, '32-bit-or-unknown');
  assert.equal(injectDecision({ ...game, elevated: true }, ctx).reason, 'elevated-or-unknown');
  assert.equal(injectDecision({ ...game, elevated: null }, ctx).reason, 'elevated-or-unknown');
  assert.equal(injectDecision({ ...game, path: '' }, ctx).reason, 'unknown-process');
});

test('one attempt per game process; a refusal is never retried', () => {
  const key = '500:d:\\games\\shooter\\shooter.exe';
  for (const code of [0, 6, 8, 11]) {
    const attempts = new Map([[key, { code, at: 0, retried: false }]]);
    assert.equal(injectDecision(game, { ...ctx, attempts }).reason, 'already-tried', `code ${code}`);
  }
  // A new process that reuses the pid is a different game.
  assert.equal(injectDecision({ ...game, path: 'D:\\Games\\Other\\other.exe' }, { ...ctx, attempts: new Map([[key, { code: 6, at: 0 }]]) }).inject, true);
  // "Already loaded" (an unloading copy from an earlier session): one retry after 5 s.
  assert.equal(injectDecision(game, { ...ctx, attempts: new Map([[key, { code: 12, at: ctx.now - 1000 }]]) }).inject, false);
  assert.equal(injectDecision(game, { ...ctx, attempts: new Map([[key, { code: 12, at: ctx.now - 6000 }]]) }).reason, 'retry');
  assert.equal(injectDecision(game, { ...ctx, attempts: new Map([[key, { code: 12, at: 0, retried: true }]]) }).inject, false);
});

// ---- controller with a fake helper ----
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.stdin.writes = [];
  child.stdin.write = buf => { child.stdin.writes.push(buf); return true; };
  child.stdin.end = () => { child.ended = true; };
  child.exitCode = null;
  child.kill = () => {};
  return child;
}
function harness() {
  let t = 1000;
  const spawned = [], logs = [], drawingChanges = [];
  const ctl = createGameOverlay({
    binDir: 'C:\\app\\resources\\overlay', exists: () => true, now: () => t,
    spawn: (exe, args) => { const c = fakeChild(); spawned.push({ exe, args, child: c }); return c; },
    log: m => logs.push(m), ownPids: () => new Set([1]), ownExe: 'INVIZENT.exe', systemRoot: 'C:\\Windows',
    onDrawingChange: v => drawingChanges.push(v),
  });
  const say = (child, obj) => child.stdout.emit('data', JSON.stringify(obj) + '\n');
  return { ctl, spawned, logs, drawingChanges, say, tick: ms => { t += ms; } };
}

test('controller: helper runs only while the option is on; injects once; the game drawing hides the window overlay', () => {
  const h = harness();
  h.ctl.update({ enabled: true, inject: false, inVoice: true, appFocused: false });
  assert.equal(h.spawned.length, 0);
  h.ctl.update({ inject: true });
  assert.equal(h.spawned.length, 1);
  const host = h.spawned[0];
  assert.equal(host.args[0], '--host');
  assert.match(host.args[1], /^[0-9a-f]{16}$/);
  assert.ok(host.exe.endsWith('invizent-overlay-injector.exe'));
  assert.equal(h.ctl.rendererWanted(), true);

  h.say(host.child, game);             // first sighting: settling
  assert.equal(h.spawned.length, 1);
  h.tick(STABLE_MS); h.say(host.child, game);
  assert.equal(h.spawned.length, 2);
  assert.deepEqual(h.spawned[1].args, ['--inject', '500']);
  h.tick(1000); h.say(host.child, game); // in flight: no second injector
  assert.equal(h.spawned.length, 2);
  h.spawned[1].child.emit('exit', 6);   // refused (anti-cheat / protected)
  assert.ok(h.logs.some(m => /not loaded into pid 500: access denied/.test(m)));
  h.tick(10000); h.say(host.child, game);
  assert.equal(h.spawned.length, 2, 'no retry after a refusal');
  assert.equal(h.ctl.drawingInGame(), false);

  h.say(host.child, { ...game, drawing: true });
  assert.equal(h.ctl.drawingInGame(), true);
  assert.deepEqual(h.drawingChanges, [true]);
  h.tick(3000); // no fresh report: stale → the window overlay comes back
  assert.equal(h.ctl.drawingInGame(), false);

  h.ctl.update({ enabled: false });
  assert.equal(host.child.ended, true);
  assert.equal(h.ctl.running(), false);
  assert.deepEqual(h.drawingChanges, [true, false]);
});

test('controller: frames go to the helper only when changed; hidden while Инвиз is focused or out of voice', () => {
  const h = harness();
  h.ctl.update({ enabled: true, inject: true, inVoice: true, appFocused: false, corner: 'topRight', opacity: 0.6 });
  const writes = h.spawned[0].child.stdin.writes;
  const before = writes.length;
  const pixels = Buffer.alloc(4 * 2 * 4, 9);
  h.ctl.frame({ width: 4, height: 2, pixels });
  assert.equal(writes.length, before + 1);
  const last = writes.at(-1);
  assert.equal(last.readUInt32LE(32), 1);
  assert.equal(last.readUInt32LE(24), 1);
  assert.equal(last.readUInt32LE(28), 153);
  h.ctl.frame({ width: 4, height: 2, pixels: Buffer.from(pixels) }); // same picture
  assert.equal(writes.length, before + 1);
  h.ctl.frame({ width: 401, height: 1, pixels: Buffer.alloc(401 * 4) }); // over the cap: ignored
  assert.equal(writes.length, before + 1);
  h.ctl.update({ appFocused: true });
  assert.equal(writes.at(-1).readUInt32LE(32), 0);
  assert.equal(writes.at(-1).length, HEADER_SIZE);
  h.ctl.update({ appFocused: false, inVoice: false });
  assert.equal(h.ctl.rendererWanted(), false);
  assert.equal(writes.at(-1).readUInt32LE(32), 0);
});

test('controller: a crashing helper is not restarted in a loop; missing files → window overlay only', () => {
  const h = harness();
  for (let i = 0; i < 5; i++) {
    h.ctl.update({ enabled: true, inject: true, inVoice: true });
    h.spawned.at(-1).child.emit('exit', 1);
  }
  h.ctl.update({ enabled: true });
  assert.equal(h.spawned.length, 3);

  const logs = [];
  const none = createGameOverlay({ binDir: 'x', exists: () => false, spawn: () => { throw new Error('must not spawn'); }, log: m => logs.push(m) });
  none.update({ enabled: true, inject: true, inVoice: true });
  none.update({ appFocused: false });
  assert.equal(none.running(), false);
  assert.equal(logs.length, 1);
});
