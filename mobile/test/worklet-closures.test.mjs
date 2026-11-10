import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// The gesture decision helpers run as worklets on the UI thread. The worklets Babel plugin turns each
// module constant a worklet uses into `const {NAME} = this.__closure` at the top of its body, so a
// default parameter that names such a constant (`slop = SLOP`) is evaluated before that line and throws
// ReferenceError on the UI runtime. In a release build that error is fatal: the user profile closed the
// app on the first finger move (stripBlocksBack / axisLock). This test compiles the modules with the
// real plugin and runs every worklet the way the UI runtime does, defaults left out.
const require = createRequire(new URL('../package.json', import.meta.url));
const babel = require('@babel/core');

const MODULES = ['../src/listSwipes.ts', '../src/media/swipeMath.ts', '../src/swipeDismissModel.ts'];

function workletsOf(file) {
  const filename = fileURLToPath(new URL(file, import.meta.url));
  const { code } = babel.transformSync(readFileSync(filename, 'utf8'), {
    filename, babelrc: false, configFile: false,
    presets: [require.resolve('@babel/preset-typescript')],
    plugins: [require.resolve('react-native-worklets/plugin')],
  });
  // Load the compiled module: each worklet function carries __closure and __initData.code.
  const module = { exports: {} };
  vm.runInThisContext(`(function(exports, require, module) {\n${require('typescript').transpileModule(code, { compilerOptions: { module: 1, target: 9 } }).outputText}\n})`)(module.exports, require, module);
  return Object.entries(module.exports).filter(([, value]) => typeof value === 'function' && value.__initData);
}

for (const file of MODULES) {
  test(`worklets in ${file.replace('../src/', '')} run on a bare runtime with their defaults`, () => {
    const worklets = workletsOf(file);
    assert.ok(worklets.length > 0);
    for (const [name, fn] of worklets) {
      // A fresh context, like the UI runtime: only what __closure carries is visible.
      const onUi = vm.runInNewContext(`(${fn.__initData.code})`, {});
      const arity = fn.length;
      const args = Array.from({ length: arity }, () => 0);
      if (name === 'storySwipe') args[0] = { axis: 'x', tx: 0, ty: 0, vx: 0, vy: 0, width: 1 };
      if (name === 'rowActions') args.splice(0, 2, { unread: false, pinned: false, muted: false, archived: false }, { markUnread: false, pin: false, archive: false });
      assert.doesNotThrow(() => onUi.apply({ __closure: fn.__closure }, args), `${name} throws on the UI runtime`);
    }
  });
}
