import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// macOS (where the iOS app is built) does not tell «CallHistory.tsx» from «callHistory.ts»: TypeScript and
// Metro then resolve one import to the wrong file. Linux does not notice, so this test guards it.
const root = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = /\.(?:native|web|ios|android)?\.?(?:tsx?|jsx?|mjs|cjs)$/i;

function walk(dir, out) {
  const seen = new Map();
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'build' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { walk(path, out); continue; }
    if (!SOURCE.test(name)) continue;
    const base = name.replace(SOURCE, ''), key = base.toLowerCase();
    const other = seen.get(key);
    if (other !== undefined && other !== base) out.push(`${relative(root, dir)}: «${other}» and «${base}»`);
    else seen.set(key, base);
  }
}

test('no two source files differ only by letter case (macOS builds would mix them up)', () => {
  const clashes = [];
  for (const dir of ['src', 'modules']) walk(join(root, dir), clashes);
  assert.deepEqual(clashes, []);
});
