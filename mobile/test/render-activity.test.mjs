import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Run production component effects without loading Android/native modules.
function load(name, mocks) {
  const source = readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } });
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${outputText}\n})`)(name => {
    assert.ok(Object.hasOwn(mocks, name), `Unexpected dependency: ${name}`);
    return mocks[name];
  }, module, module.exports);
  return module.exports;
}
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  createContext: value => ({ value, Provider: 'Provider' }),
  useContext: context => context.value,
};

test('covered scope stays inactive inside a nested active scope and resumes', () => {
  let parent = true;
  const { RenderActivity } = load('renderActivity.tsx', { react: { ...react, useContext: () => parent } });
  assert.equal(RenderActivity({ active: false, children: 'screen' }).props.value, false);
  assert.equal(RenderActivity({ active: true, children: 'screen' }).props.value, true);
  parent = false;
  assert.equal(RenderActivity({ active: true, children: 'screen' }).props.value, false);
});

function ambientHarness(enabled) {
  const effects = [], values = [], cancelled = [];
  const { MusicAmbient } = load('music/MusicAmbient.tsx', {
    react: { ...react, useEffect: (effect, deps) => effects.push({ effect, deps }) },
    'react-native': { View: 'View', StyleSheet: { absoluteFill: {} } },
    'react-native-svg': { default: 'Svg' },
    '../motion': { useMotion: () => ({ enabled }) },
    'react-native-reanimated': {
      default: { View: 'AnimatedView' }, Easing: { linear: 'linear', sin: 'sin', inOut: x => x },
      useSharedValue: value => { const shared = { value }; values.push(shared); return shared; },
      useAnimatedStyle: () => ({}), cancelAnimation: value => cancelled.push(value),
      withRepeat: (...args) => ({ repeat: args }), withTiming: (...args) => ({ timing: args }),
      withSequence: (...args) => ({ sequence: args }),
    },
  });
  const tree = MusicAmbient({ width: 400, height: 300 });
  const patches = tree.props.children.filter(child => child && typeof child.type === 'function');
  return { patches, effects, values, cancelled };
}

test('all ambient patches stop when motion is disabled or screen is covered', () => {
  const h = ambientHarness(false);
  assert.equal(h.patches.length, 4);
  for (const patch of h.patches) { assert.equal(patch.props.still, true); patch.type(patch.props); }
  for (const { effect, deps } of h.effects) { assert.equal(deps[0], true); effect(); }
  assert.equal(h.cancelled.length, 12);
  for (const value of h.values) assert.equal(typeof value.value, 'number');
});

test('ambient loops cancel on cleanup and reset when screen becomes inactive', () => {
  const h = ambientHarness(true);
  const patch = h.patches[0];
  patch.type(patch.props);
  const cleanup = h.effects[0].effect();
  assert.ok(h.values.every(value => value.value.repeat));
  h.cancelled.length = 0;
  cleanup();
  assert.equal(h.cancelled.length, 3);
  h.effects.length = 0;
  h.values.length = 0;
  patch.type({ ...patch.props, still: true });
  h.effects[0].effect();
  assert.equal(h.values[0].value, patch.props.offset);
  assert.equal(h.values[1].value, 0);
  assert.equal(h.values[2].value, 0);
});

test('stack propagates activity through Frozen and Android glass uses paused', () => {
  const stack = readFileSync(new URL('../src/stack.tsx', import.meta.url), 'utf8');
  assert.match(stack, /<RenderActivity active=\{!covered\}><Frozen frozen=\{covered\}>/);
  const glass = readFileSync(new URL('../src/glass.tsx', import.meta.url), 'utf8');
  assert.match(glass, /const renderActive=useRenderActive\(\)/);
  assert.match(glass, /<LiquidGlassView paused=\{!renderActive\}/);
  const motion = readFileSync(new URL('../src/motion.tsx', import.meta.url), 'utf8');
  assert.match(motion, /enabled: active && motionAllowed\(/);
});
