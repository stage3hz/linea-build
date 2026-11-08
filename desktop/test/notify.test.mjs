import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { notificationPayload, trayTooltip, composeBitmap, trayBadgeImage, applyTrayBadge, TRAY_SIZE } from '../notify.cjs';

// The real preload with a fake Electron underneath: what the page gets is exactly the frozen
// whitelist, every call turns into one 'invizent' invoke, and events coming back are type-checked.
function loadPreload() {
  const invokes = [], listeners = new Map();
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { electron.exposed = { name, api }; } },
    ipcRenderer: {
      invoke: (...args) => { invokes.push(args); return Promise.resolve(`ok:${args[1]}`); },
      on: (channel, handler) => { listeners.set(channel, [...(listeners.get(channel) || []), handler]); },
      removeListener: (channel, handler) => { listeners.set(channel, (listeners.get(channel) || []).filter(h => h !== handler)); },
    },
  };
  const original = Module._load;
  Module._load = function (request, ...rest) { return request === 'electron' ? electron : original.call(this, request, ...rest); };
  try {
    const require = createRequire(import.meta.url);
    delete require.cache[require.resolve('../preload.cjs')];
    require('../preload.cjs');
  } finally { Module._load = original; }
  const emit = (channel, ...args) => (listeners.get(channel) || []).forEach(h => h({}, ...args));
  return { api: electron.exposed.api, name: electron.exposed.name, invokes, listeners, emit };
}

test('preload exposes notifications and badge through the single invizent channel, frozen', async () => {
  const { api, name, invokes } = loadPreload();
  assert.equal(name, 'invizentDesktop');
  assert.ok(Object.isFrozen(api)); assert.ok(Object.isFrozen(api.notifications));
  assert.deepEqual(Object.keys(api.notifications).sort(), ['close', 'onAction', 'show']);
  const payload = { tag: 'chat:1', title: 'Анна', body: 'Новое сообщение', silent: false, kind: 'message', chatId: '1', answer: false };
  assert.equal(await api.notifications.show(payload), 'ok:notifyShow');
  assert.equal(await api.notifications.close('chat:1'), 'ok:notifyClose');
  await api.badge(3, 'data:image/png;base64,AAAA');
  assert.deepEqual(invokes, [['invizent', 'notifyShow', payload], ['invizent', 'notifyClose', 'chat:1'], ['invizent', 'badge', 3, 'data:image/png;base64,AAAA']]);
  // No Node or Electron object leaks to the page: every value is a function or a frozen plain object.
  const walk = (value, path) => { for (const [key, item] of Object.entries(value)) { if (typeof item === 'function') continue; assert.equal(typeof item === 'object' && Object.isFrozen(item) || typeof item === 'string', true, `${path}.${key}`); if (typeof item === 'object') walk(item, `${path}.${key}`); } };
  walk(api, 'invizentDesktop');
});

test('notification actions reach the page only when well-formed; unsubscribing stops them', () => {
  const { api, emit, listeners } = loadPreload();
  const got = [];
  const stop = api.notifications.onAction(action => got.push(action));
  emit('invizent-notify', { kind: 'open', chatId: 'c1' });
  emit('invizent-notify', { kind: 'answer', chatId: 'c2' });
  emit('invizent-notify', { kind: 'open', chatId: null });
  emit('invizent-notify', { kind: 'delete', chatId: 'c3' });
  emit('invizent-notify', { kind: 'open', chatId: 42 });
  emit('invizent-notify', { kind: 'open', chatId: 'x'.repeat(129) });
  emit('invizent-notify', 'open');
  emit('invizent-notify', null);
  assert.deepEqual(got, [{ kind: 'open', chatId: 'c1' }, { kind: 'answer', chatId: 'c2' }, { kind: 'open', chatId: null }]);
  // Extra fields are not forwarded.
  emit('invizent-notify', { kind: 'open', chatId: 'c4', extra: 'no' });
  assert.deepEqual(got[3], { kind: 'open', chatId: 'c4' });
  stop();
  assert.equal((listeners.get('invizent-notify') || []).length, 0);
  emit('invizent-notify', { kind: 'open', chatId: 'c5' });
  assert.equal(got.length, 4);
});

test('notificationPayload drops malformed input, bounds the strings and strips control characters', () => {
  assert.equal(notificationPayload(null), null); assert.equal(notificationPayload('x'), null); assert.equal(notificationPayload(7), null);
  assert.equal(notificationPayload({ title: 'A' }), null);
  assert.equal(notificationPayload({ tag: 't', title: '' }), null);
  assert.equal(notificationPayload({ tag: 't', title: '\u0000\u001f' }), null, 'a title of control characters is empty');
  assert.deepEqual(notificationPayload({ tag: 'chat:1', title: 'Анна\u0000', body: 'x'.repeat(300), silent: 'yes', kind: 'other', chatId: 7, answer: true }),
    { tag: 'chat:1', title: 'Анна', body: 'x'.repeat(200), silent: false, kind: 'message', chatId: null, answer: false });
  assert.deepEqual(notificationPayload({ tag: 'call:1', title: 'Анна', body: 'Входящий звонок', silent: true, kind: 'call', chatId: '1', answer: true }),
    { tag: 'call:1', title: 'Анна', body: 'Входящий звонок', silent: true, kind: 'call', chatId: '1', answer: true });
  // «Ответить» exists for calls only; a message can never carry it.
  assert.equal(notificationPayload({ tag: 'chat:1', title: 'Анна', kind: 'message', answer: true }).answer, false);
  assert.equal(notificationPayload({ tag: 'summary', title: 'Инвиз', body: 'Новых сообщений: 7', kind: 'message' }).chatId, null);
  assert.equal(notificationPayload({ tag: 'x'.repeat(200), title: 'T' }).tag.length, 128);
  assert.equal(notificationPayload({ tag: 't', title: 'T', chatId: 'x'.repeat(129) }).chatId, null);
  // Nothing beyond the known fields comes through.
  assert.deepEqual(Object.keys(notificationPayload({ tag: 't', title: 'T', extra: 1 })).sort(), ['answer', 'body', 'chatId', 'kind', 'silent', 'tag', 'title']);
});

test('tray tooltip carries the count while something is unread', () => {
  assert.equal(trayTooltip(0), 'Инвиз'); assert.equal(trayTooltip(-1), 'Инвиз'); assert.equal(trayTooltip(undefined), 'Инвиз');
  assert.equal(trayTooltip(3), 'Инвиз — непрочитанных: 3');
});

// BGRA helpers for the bitmap tests.
const solid = (size, [b, g, r, a]) => { const out = Buffer.alloc(size * size * 4); for (let i = 0; i < size * size; i++) out.set([b, g, r, a], i * 4); return out; };
const pixel = (buffer, size, x, y) => [...buffer.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];

test('composeBitmap: source-over in the corner, transparent mark pixels leave the icon alone, inputs untouched', () => {
  const base = solid(4, [255, 0, 0, 255]);          // opaque blue icon
  const mark = solid(2, [0, 0, 255, 255]);          // opaque red counter
  mark.set([0, 0, 0, 0], 0);                        // its top-left pixel is transparent (round corner)
  const out = composeBitmap(base, 4, mark, 2, 2, 2);
  assert.notEqual(out, base); assert.deepEqual([...base], [...solid(4, [255, 0, 0, 255])], 'the base buffer is not modified');
  assert.deepEqual(pixel(out, 4, 0, 0), [255, 0, 0, 255]); assert.deepEqual(pixel(out, 4, 1, 3), [255, 0, 0, 255]);
  assert.deepEqual(pixel(out, 4, 2, 2), [255, 0, 0, 255], 'transparent mark pixel shows the icon');
  assert.deepEqual(pixel(out, 4, 3, 2), [0, 0, 255, 255]); assert.deepEqual(pixel(out, 4, 3, 3), [0, 0, 255, 255]);
  // Half-transparent red over opaque blue: a mix, still opaque.
  const half = composeBitmap(base, 4, solid(1, [0, 0, 255, 128]), 1, 0, 0);
  const [b, g, r, a] = pixel(half, 4, 0, 0);
  assert.equal(a, 255); assert.equal(g, 0); assert.ok(r > 120 && r < 136, `r=${r}`); assert.ok(b > 120 && b < 136, `b=${b}`);
  // Over a transparent icon pixel the mark comes through as it is.
  assert.deepEqual(pixel(composeBitmap(solid(1, [0, 0, 0, 0]), 1, solid(1, [10, 20, 30, 200]), 1, 0, 0), 1, 0, 0), [10, 20, 30, 200]);
  // A mark that sticks out is clipped; a buffer of the wrong length changes nothing.
  assert.equal(composeBitmap(base, 4, mark, 2, 3, 3).length, 64);
  assert.deepEqual([...composeBitmap(base, 4, Buffer.alloc(3), 2, 0, 0)], [...base]);
});

// A fake nativeImage: an image knows its size and colour; resize() returns a new one, toBitmap() paints it solid.
function fakeNativeImage() {
  const image = (size, colour, empty = false) => ({
    isEmpty: () => empty, getSize: () => ({ width: size, height: size }),
    resize: ({ width, height, quality }) => { assert.equal(width, height); assert.equal(quality, 'best'); return image(width, colour); },
    toBitmap: () => solid(size, colour),
  });
  const created = [];
  return { image, created, createEmpty: () => { const reps = []; const out = { reps, isEmpty: () => reps.length === 0, addRepresentation: rep => reps.push(rep) }; created.push(out); return out; } };
}

test('trayBadgeImage: the counter is drawn over the app icon at 16 px and 32 px (scale 1 and 2)', () => {
  const ni = fakeNativeImage();
  const icon = ni.image(16, [255, 0, 0, 255]), badge = ni.image(32, [0, 0, 255, 255]);
  const out = trayBadgeImage(ni, icon, badge);
  assert.equal(ni.created[0], out);
  assert.deepEqual(out.reps.map(r => [r.scaleFactor, r.width, r.height, r.buffer.length]), [[1, 16, 16, 16 * 16 * 4], [2, 32, 32, 32 * 32 * 4]]);
  assert.equal(TRAY_SIZE, 16);
  for (const rep of out.reps) {
    const size = rep.width, mark = Math.round(size * 0.6875);
    assert.deepEqual(pixel(rep.buffer, size, 0, 0), [255, 0, 0, 255], 'top-left stays the icon');
    assert.deepEqual(pixel(rep.buffer, size, size - 1, size - 1), [0, 0, 255, 255], 'bottom-right is the counter');
    assert.deepEqual(pixel(rep.buffer, size, size - mark, size - mark), [0, 0, 255, 255], 'the counter starts at its corner');
    assert.deepEqual(pixel(rep.buffer, size, size - mark - 1, size - mark - 1), [255, 0, 0, 255], 'and not a pixel earlier');
  }
  // No usable app icon (a shell without file icons): the counter picture alone, as before; no counter: the icon.
  assert.equal(trayBadgeImage(ni, ni.image(0, [0, 0, 0, 0], true), badge), badge);
  assert.equal(trayBadgeImage(ni, null, badge), badge);
  assert.equal(trayBadgeImage(ni, icon, null), icon);
  assert.equal(trayBadgeImage(ni, icon, ni.image(0, [0, 0, 0, 0], true)), icon);
});

test('applyTrayBadge: tooltip and icon follow the count; without a tray nothing happens; a dead tray does not throw', () => {
  const ni = fakeNativeImage();
  const icon = ni.image(16, [255, 0, 0, 255]), badge = ni.image(32, [0, 0, 255, 255]);
  const calls = [];
  const tray = { setToolTip: text => calls.push(['tip', text]), setImage: image => calls.push(['image', image]) };
  applyTrayBadge({ tray, icon, badge: { count: 0, image: null }, nativeImage: ni });
  assert.deepEqual(calls, [['tip', 'Инвиз'], ['image', icon]]);
  calls.length = 0;
  applyTrayBadge({ tray, icon, badge: { count: 5, image: badge }, nativeImage: ni });
  assert.equal(calls[0][1], 'Инвиз — непрочитанных: 5');
  assert.equal(calls[1][1], ni.created[0]); assert.equal(calls[1][1].reps.length, 2);
  calls.length = 0;
  // A count without a picture (the page could not draw): tooltip only, the plain icon stays.
  applyTrayBadge({ tray, icon, badge: { count: 2, image: null }, nativeImage: ni });
  assert.deepEqual(calls, [['tip', 'Инвиз — непрочитанных: 2'], ['image', icon]]);
  calls.length = 0;
  applyTrayBadge({ tray, icon: null, badge: { count: 2, image: badge }, nativeImage: ni });
  assert.deepEqual(calls, [['tip', 'Инвиз — непрочитанных: 2']], 'no icon yet: nothing to set');
  applyTrayBadge({ tray: null, icon, badge: { count: 2, image: badge }, nativeImage: ni });
  assert.doesNotThrow(() => applyTrayBadge({ tray: { setToolTip: () => { throw new Error('gone'); }, setImage: () => {} }, icon, badge: { count: 1, image: badge }, nativeImage: ni }));
});
