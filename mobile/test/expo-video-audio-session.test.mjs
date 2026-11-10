import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('expo-video never takes the iOS audio session away from a recording (postinstall patch)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.postinstall, /patch-expo-video\.cjs/);
  const swift = readFileSync(new URL('../node_modules/expo-video/ios/VideoManager.swift', import.meta.url), 'utf8');
  assert.match(swift, /if audioSession\.category == \.playAndRecord \|\| audioSession\.category == \.record \{ return \}/);
});
