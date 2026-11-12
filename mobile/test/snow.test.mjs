// «Снег» (PC): the drift rules in src/snowModel.ts and the setting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTs } from './support/load-ts.mjs';

const { SNOW, snowBrush, snowCeiling, snowColumns, snowDeposit, snowSurface } = loadTs(new URL('../src/snowModel.ts', import.meta.url), {});

test('a drift never grows above its cap', () => {
  const h = new Float32Array(20);
  for (let n = 0; n < 5000; n++) snowDeposit(h, n % 20, 3, SNOW.MAX);
  for (const value of h) assert.ok(value <= SNOW.MAX + 1e-6);
  assert.ok(Math.min(...h) > SNOW.MAX - 2, 'every column fills up');
  assert.equal(snowDeposit(h, 5, 3, 0), -1, 'a full column takes nothing');
  assert.equal(snowDeposit(h, -1, 3, SNOW.MAX), -1);
  assert.equal(snowDeposit(h, 20, 3, SNOW.MAX), -1);
});

test('a flake rolls down to a lower neighbour, so one spot does not grow into a spike', () => {
  const h = new Float32Array(9);
  for (let n = 0; n < 12; n++) snowDeposit(h, 4, 2, SNOW.MAX);
  assert.ok(h[3] > 0 && h[5] > 0, 'the neighbours got snow too');
  assert.ok(h[4] - Math.min(h[3], h[5]) < 1.5);
});

test('the cursor sweeps only what is within its reach', () => {
  const h = new Float32Array(100).fill(10);
  const swept = [];
  const taken = snowBrush(h, 0, 100, 150, 96, column => swept.push(column));
  assert.ok(taken > 0);
  assert.ok(h[50] < 2, 'under the cursor the snow is gone');
  assert.equal(h[0], 10); assert.equal(h[99], 10);
  for (const column of swept) assert.ok(Math.abs(column * SNOW.COL - 150) <= SNOW.BRUSH);
  const far = new Float32Array(100).fill(10);
  assert.equal(snowBrush(far, 0, 100, 150, 300), 0, 'a cursor far below touches nothing');
});

test('columns: rounded corners hold no snow; the surface is smoothed', () => {
  assert.equal(snowColumns(300, 0), 100);
  assert.ok(snowColumns(300, 20) < 100);
  assert.equal(snowColumns(2, 20), 1);
  assert.equal(snowSurface(Float32Array.from([0, 8, 0]), 1), 4);
});

test('the setting is on by default and survives bad stored values', () => {
  const source = readFileSync(new URL('../src/chatPreferences.ts', import.meta.url), 'utf8');
  assert.match(source, /snow: true/);
  assert.match(source, /snow: typeof value\?\.snow === 'boolean' \? value\.snow : DEFAULTS\.snow/);
});

test('the desktop app keeps the cap strip harmless: no focus, no clicks, owned by the main window', () => {
  const main = readFileSync(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
  const cap = main.slice(main.indexOf('function snowCap('), main.indexOf('// In-game overlay for fullscreen games'));
  assert.match(cap, /parent: window/);
  assert.match(cap, /focusable: false/);
  assert.match(cap, /setIgnoreMouseEvents\(true\)/);
  assert.match(cap, /sandbox: true/);
  assert.doesNotMatch(cap, /alwaysOnTop/);
  const pkg = JSON.parse(readFileSync(new URL('../../desktop/package.json', import.meta.url), 'utf8'));
  for (const file of ['snow.html', 'snow.js', 'snow-preload.cjs']) assert.ok(pkg.build.files.includes(file), file);
});

test('the cap is lumpy, never taller than the limit, and rounds down to the ledge at both ends', () => {
  const n = 120, heights = Array.from({ length: n }, (_, i) => snowCeiling(i, n, SNOW.MAX, 3));
  for (const value of heights) assert.ok(value > 0 && value <= SNOW.MAX + 1e-9);
  assert.ok(heights[0] < heights[4] && heights[n - 1] < heights[n - 5], 'rounded ends');
  assert.ok(heights[0] < SNOW.MAX * 0.5);
  const middle = heights.slice(10, n - 10);
  assert.ok(Math.max(...middle) - Math.min(...middle) > 2, 'bumps, not a level strip');
  assert.ok(Math.min(...middle) >= SNOW.MAX * 0.5, 'thick everywhere away from the ends');
  assert.notDeepEqual(heights, Array.from({ length: n }, (_, i) => snowCeiling(i, n, SNOW.MAX, 40)), 'every ledge has its own shape');
});

test('phone: the island ledge is derived from the top inset; a notch or a wide Android cutout holds no snow', () => {
  const { islandLedge, ISLAND } = loadTs(new URL('../src/snowModel.ts', import.meta.url), {});
  const a = islandLedge('ios', 393, 852, 59, null);   // iPhone 14 Pro class
  assert.ok(a && Math.abs(a.x + a.width / 2 - 393 / 2) < 1e-9, 'centred');
  assert.equal(a.y, 11); assert.equal(a.width, ISLAND.WIDTH); assert.ok(Math.abs(a.radius - a.height / 2) < 1e-9);
  assert.equal(islandLedge('ios', 402, 874, 62, null).y, 14);     // iPhone 16 Pro class
  assert.equal(islandLedge('ios', 390, 844, 47, null), null, 'a notch: nothing to lie on');
  assert.equal(islandLedge('ios', 375, 667, 20, null), null);
  assert.equal(islandLedge('ios', 852, 393, 59, null), null, 'landscape');
  const hole = islandLedge('android', 412, 915, 40, { x: 190, y: 12, width: 32, height: 32 });
  assert.deepEqual(hole, { x: 190, y: 12, width: 32, height: 32, radius: 16 });
  assert.equal(islandLedge('android', 412, 915, 40, { x: 100, y: 0, width: 212, height: 30 }), null, 'a notch flush with the top edge');
  assert.equal(islandLedge('android', 412, 915, 40, { x: 20, y: 10, width: 300, height: 30 }), null, 'wider than half the screen');
  assert.equal(islandLedge('android', 412, 915, 40, null), null);
});

test('phone: the snow never takes a touch and is off with the setting; «Поиск» is the hidden first row of the list', () => {
  const phone = readFileSync(new URL('../src/SnowPhone.tsx', import.meta.url), 'utf8');
  assert.match(phone, /pointerEvents="none"/);
  assert.match(phone, /preferences\.snow && motion\.enabled/);
  const list = readFileSync(new URL('../src/ChatListScreen.tsx', import.meta.url), 'utf8');
  assert.match(list, /const pullSearch=float&&!archive&&!query;const topRow=archiveRow\|\|pullSearch;/, 'the phone keeps it above the first chat');
  assert.ok(list.includes('{topRow?<View onLayout=') && list.includes('>{pullSearch?searchBar:null}{archiveRow?'), 'one hidden block: the field, then «Архив»');
  assert.match(list, /\{float\?null:<SnowLedge id="chats\.search"/, 'the PC and the rail keep it in the header');
  assert.doesNotMatch(list, /searchPulled/);
});

test('phone: the falling snow is part of the background, the caps stay on the one front surface', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const glass = read('../src/glass.tsx');
  const backdrop = glass.slice(glass.indexOf('export function GlassBackdrop'), glass.indexOf('export function GlassStage'));
  assert.equal(backdrop.match(/<PixelTrailLayer\/><SnowBackLayer\/>/g)?.length, 2, 'both app backdrops');
  assert.match(read('../src/auth/AuthBackdrop.tsx'), /<PixelTrailLayer \/><SnowBackLayer\/>/);
  assert.equal(read('../src/WallpaperPicker.tsx').match(/<SnowBackLayer\/>/g)?.length, 2, 'the chat wallpaper covers the backdrop');
  const phone = read('../src/SnowPhone.tsx');
  assert.match(phone, /layer="back" active=\{active\}/);
  assert.equal(phone.match(/layer="front"/g)?.length, 1);
});
