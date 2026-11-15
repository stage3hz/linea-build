// Android: a native decorative layer must never be a JS touch target.
//
// React Native on Android finds the target of a tap by coordinates (TouchTargetHelper) and honours
// `pointerEvents="none"` only on its own views; any other native view is taken for one that wants the touch. The
// snow's front layer lies over every screen: from 0.14.15 to 0.14.20 every tap on a button was addressed to it and
// no <Pressable> reacted on Android (scrolling, text fields and the tab bar's gestures still worked). Nothing here
// can run a phone, so these tests hold the two rules in the sources that keep it from coming back.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Android: each native snow / trail layer drawn over or behind the screens sits inside a React view that takes no touches', () => {
  const wrapper = read('../src/untouchableLayer.tsx');
  assert.match(wrapper, /Platform\.OS !== 'android'/, 'only Android needs the wrapper; iPhone and the PC keep their tree');
  assert.match(wrapper, /<View pointerEvents="none" collapsable=\{false\} style=\{StyleSheet\.absoluteFill\}>\{children\}<\/View>/, 'a plain View that React Native honours, kept in the native tree');

  const snow = read('../src/SnowPhone.tsx');
  for (const layer of ['front', 'back']) {
    const line = snow.split('\n').find(text => text.includes('<NativeSnow') && text.includes(`layer="${layer}"`));
    assert.ok(line, `the ${layer} layer is mounted`);
    assert.match(line, /<UntouchableLayer><NativeSnow [^>]*\/><\/UntouchableLayer>/, `the ${layer} snow layer is wrapped`);
  }
  // «Ледяное стекло» lies inside its own glass surface, under that surface's content: it is a descendant of whatever
  // is pressed there, so it cannot take a tap away from it, and one more view per glass surface is not spent on it.
  const rime = snow.split('\n').find(text => text.includes('<NativeSnow') && text.includes('layer="rime"'));
  assert.ok(rime && !rime.includes('UntouchableLayer'));

  const trail = read('../src/PixelTrail.tsx');
  const layer = trail.split('\n').find(text => text.includes('<NativeLayer ') && text.includes('return'));
  assert.ok(layer, 'the trail layer is mounted');
  assert.match(layer, /<UntouchableLayer><NativeLayer [^>]*\/><\/UntouchableLayer>/, 'the pixel trail layer is wrapped');

  // The front layer is the one above every screen: it is mounted once, at the root.
  const app = read('../App.tsx');
  assert.equal(app.split('<SnowPhone/>').length - 1, 1);
});

test('Android: every native view of the app either says it is disabled (decorative) or is known to take touches', () => {
  // A view that reports isEnabled() == false is passed over by React Native's touch targeting (AUTO becomes BOX_NONE,
  // and these views have no children). A new decorative native view must do the same; one that is meant to be touched
  // is listed here on purpose.
  const interactive = new Set(['VideoNoteView']);
  const modules = new URL('../modules/', import.meta.url);
  const found = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
      if (entry.isDirectory()) { if (entry.name !== 'build' && entry.name !== 'node_modules') walk(next); continue; }
      if (!entry.name.endsWith('.kt')) continue;
      const source = readFileSync(next, 'utf8');
      const classes = [...source.matchAll(/^class (\w+)\([^)]*\) : ExpoView\(/gm)];
      classes.forEach((match, index) => {
        const body = source.slice(match.index, classes[index + 1]?.index ?? source.length);
        found.push({ name: match[1], disabled: /override fun isEnabled\(\): Boolean = false/.test(body) });
      });
    }
  };
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    const android = new URL(`${entry.name}/android/src/main/java/`, modules);
    if (entry.isDirectory() && existsSync(android)) walk(android);
  }
  assert.deepEqual(found.map(view => view.name).sort(), ['SnowView', 'TrailBackgroundView', 'VideoNoteView'], 'a new native view: decide whether it takes touches');
  for (const view of found) assert.equal(view.disabled, !interactive.has(view.name), `${view.name}: decorative views are disabled, interactive ones are not`);
});
