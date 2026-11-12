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
