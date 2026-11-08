import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './support/load-ts.mjs';

// The real module with the platform swapped out: a web build (Electron / browser), no lock, a
// recording navigate() and an in-memory AsyncStorage. React hooks are not exercised here.
const store = new Map();
const navigated = [];
let locked = false;
const mod = loadTs(new URL('../src/notifications/desktopNotify.ts', import.meta.url), {
  react: { useEffect: () => {}, useRef: v => ({ current: v }), useSyncExternalStore: (_s, get) => get() },
  'react-native': { Platform: { OS: 'web' } },
  '@react-native-async-storage/async-storage': { getItem: async k => store.get(k) ?? null, setItem: async (k, v) => { store.set(k, v); } },
  '../lock/LockGate': { isLocked: () => locked },
  '../navigation': { navigate: r => navigated.push(r) },
});
const { decideNotification, newIncoming, planNotifications, dndLabel, parseDesktopPrefs, effectivePrefs, clipText, previewText, dndActive, showDecision, closeNotification, DEFAULT_DESKTOP_PREFS, BATCH_LIMIT, webNotificationPermission, requestWebNotificationPermission } = mod;
const { DEFAULT_NOTIFICATION_PREFS } = loadTs(new URL('../src/notifications/model.ts', import.meta.url));

// What the decision model sees: F2's common switches plus the desktop-only ones (effectivePrefs).
const BASE = effectivePrefs(DEFAULT_NOTIFICATION_PREFS, DEFAULT_DESKTOP_PREFS);
const prefs = (change = {}) => ({ ...BASE, ...change });
const ctx = (change = {}) => ({ windowActive: false, locked: false, prefs: prefs(), now: 1_000_000, ...change });
const msg = (over = {}) => ({ kind: 'message', chatId: 'c1', senderName: 'Анна', text: 'Привет, как дела?', fromSelf: false, muted: false, ...over });
const call = (over = {}) => ({ kind: 'call', chatId: 'c1', senderName: 'Анна', video: false, muted: false, ...over });

test('a message while the window is away: the name and «Новое сообщение», never the text by default', () => {
  const d = decideNotification(msg(), ctx());
  assert.equal(d.show, true);
  assert.equal(d.title, 'Анна'); assert.equal(d.body, 'Новое сообщение'); assert.equal(d.tag, 'chat:c1'); assert.equal(d.silent, false); assert.equal(d.answer, false);
  assert.ok(!JSON.stringify(d).includes('Привет'));
});

test('the text appears only with preview on, clipped to one line', () => {
  const d = decideNotification(msg({ text: '  Привет,\n\nкак дела?\u200b ' }), ctx({ prefs: prefs({ textPreview: true }) }));
  assert.equal(d.body, 'Привет, как дела?');
  const long = decideNotification(msg({ text: 'а'.repeat(300) }), ctx({ prefs: prefs({ textPreview: true }) }));
  assert.equal(long.body.length, 120); assert.ok(long.body.endsWith('…'));
  // An empty text (a photo whose label was not computed) falls back to the generic line.
  assert.equal(decideNotification(msg({ text: '' }), ctx({ prefs: prefs({ textPreview: true }) })).body, 'Новое сообщение');
});

test('the passcode lock hides the text and even the name', () => {
  const d = decideNotification(msg(), ctx({ locked: true, prefs: prefs({ textPreview: true }) }));
  assert.equal(d.title, 'Инвиз'); assert.equal(d.body, 'Новое сообщение');
  const c = decideNotification(call({ video: true }), ctx({ locked: true }));
  assert.equal(c.title, 'Инвиз'); assert.equal(c.body, 'Входящий звонок'); assert.equal(c.answer, true);
});

test('focused window, own message, disabled, muted chat and «не беспокоить» show nothing', () => {
  assert.deepEqual(decideNotification(msg(), ctx({ windowActive: true })), { show: false, reason: 'active' });
  assert.deepEqual(decideNotification(msg({ fromSelf: true }), ctx()), { show: false, reason: 'self' });
  assert.deepEqual(decideNotification(msg(), ctx({ prefs: prefs({ enabled: false }) })), { show: false, reason: 'disabled' });
  assert.deepEqual(decideNotification(msg({ muted: true }), ctx()), { show: false, reason: 'muted' });
  assert.deepEqual(decideNotification(msg(), ctx({ prefs: prefs({ dndUntil: 2_000_000 }) })), { show: false, reason: 'dnd' });
  assert.deepEqual(decideNotification(msg(), ctx({ prefs: prefs({ dndUntil: Infinity }) })), { show: false, reason: 'dnd' });
  // An expired «не беспокоить» no longer blocks.
  assert.equal(decideNotification(msg(), ctx({ prefs: prefs({ dndUntil: 999 }) })).show, true);
  assert.equal(dndActive({ dndUntil: null }, 5), false);
});

test('sound follows the setting; a call rings through the app, so its notification is silent', () => {
  assert.equal(decideNotification(msg(), ctx({ prefs: prefs({ sound: false }) })).silent, true);
  const c = decideNotification(call(), ctx());
  assert.equal(c.show, true); assert.equal(c.silent, true); assert.equal(c.answer, true); assert.equal(c.kind, 'call'); assert.equal(c.tag, 'call:c1');
  assert.equal(c.title, 'Анна'); assert.equal(c.body, 'Входящий звонок');
  assert.equal(decideNotification(call({ video: true }), ctx()).body, 'Входящий видеозвонок');
});

test('a muted chat still rings (Telegram), calls are switched off separately, DND silences them too', () => {
  assert.equal(decideNotification(call({ muted: true }), ctx()).show, true);
  assert.deepEqual(decideNotification(call(), ctx({ prefs: prefs({ calls: false }) })), { show: false, reason: 'calls-off' });
  assert.deepEqual(decideNotification(call(), ctx({ prefs: prefs({ dndUntil: Infinity }) })), { show: false, reason: 'dnd' });
  assert.deepEqual(decideNotification(call(), ctx({ windowActive: true })), { show: false, reason: 'active' });
});

test('a summary replaces a flood after a reconnect', () => {
  const d = decideNotification({ kind: 'summary', count: 7 }, ctx());
  assert.equal(d.show, true); assert.equal(d.title, 'Инвиз'); assert.equal(d.body, 'Новых сообщений: 7'); assert.equal(d.chatId, null);
  assert.deepEqual(decideNotification({ kind: 'summary', count: 0 }, ctx()), { show: false, reason: 'empty' });
  assert.ok(BATCH_LIMIT >= 3);
});

test('a sender name is cleaned and bounded; an empty one becomes the app name', () => {
  assert.equal(decideNotification(msg({ senderName: '' }), ctx()).title, 'Инвиз');
  assert.equal(decideNotification(msg({ senderName: 'A\u202eB\u0000C' }), ctx()).title, 'A B C');
  assert.equal(clipText('x'.repeat(70), 60).length, 60);
});

const message = (id, senderId, over = {}) => ({ id, chatId: 'c1', senderId, clientId: `k${id}`, text: 'hi', attachment: null, createdAt: '2026-01-01T00:00:00Z', cryptoState: 'decrypted', ...over });
const chat = (id, last, over = {}) => ({ id, peer: { id: `peer-${id}`, displayName: `Имя ${id}` }, lastMessage: last, unreadCount: 1, lastReadMessageId: 0, peerLastReadMessageId: 0, createdAt: '', updatedAt: '', ...over });

test('newIncoming: the first pass only remembers; later only newer incoming messages count', () => {
  const first = newIncoming(null, [chat('c1', message(5, 'peer'))], 'me');
  assert.deepEqual(first.arrivals, []); assert.equal(first.seen.get('c1'), 5);
  const same = newIncoming(first.seen, [chat('c1', message(5, 'peer'))], 'me');
  assert.deepEqual(same.arrivals, []);
  const newer = newIncoming(same.seen, [chat('c1', message(6, 'peer'))], 'me');
  assert.equal(newer.arrivals.length, 1); assert.equal(newer.arrivals[0].message.id, 6); assert.equal(newer.seen.get('c1'), 6);
  // Own message: remembered, not announced. A reaction/edit (an action) is not unread, so no notification either.
  assert.deepEqual(newIncoming(newer.seen, [chat('c1', message(7, 'me'))], 'me').arrivals, []);
  assert.deepEqual(newIncoming(newer.seen, [chat('c1', message(8, 'peer', { meta: { action: { type: 'reaction' } } }))], 'me').arrivals, []);
  // A list refresh that goes back to an older lastMessage never re-announces.
  assert.deepEqual(newIncoming(new Map([['c1', 9]]), [chat('c1', message(8, 'peer'))], 'me').arrivals, []);
});

test('newIncoming: a chat that appears later counts only when it already has unread; a missed call counts', () => {
  const seen = new Map([['c1', 3]]);
  assert.equal(newIncoming(seen, [chat('c1', message(3, 'peer')), chat('c2', message(1, 'peer'))], 'me').arrivals.length, 1);
  assert.equal(newIncoming(seen, [chat('c1', message(3, 'peer')), chat('c2', message(1, 'peer'), { unreadCount: 0 })], 'me').arrivals.length, 0);
  const missed = message(4, 'peer', { meta: { action: { type: 'call', call: 'x', step: 'end', reason: 'missed' } } });
  assert.equal(newIncoming(seen, [chat('c1', missed)], 'me').arrivals.length, 1);
  // Read on the phone meanwhile (unreadCount 0): a newer message is remembered but not announced.
  const readElsewhere = newIncoming(seen, [chat('c1', message(4, 'peer'), { unreadCount: 0 })], 'me');
  assert.deepEqual(readElsewhere.arrivals, []); assert.equal(readElsewhere.seen.get('c1'), 4);
});

test('newIncoming: a Mesh message (local id ≥ 9e15) is neither announced nor remembered as the watermark', () => {
  const seen = new Map([['c1', 3]]);
  const mesh = message(9_000_000_000_000_001, 'peer', { mesh: true });
  const result = newIncoming(seen, [chat('c1', mesh)], 'me');
  assert.equal(result.arrivals.length, 0);
  assert.equal(result.seen.get('c1'), 3, 'the watermark stays at the last server id');
  // The next real server message is therefore still news.
  assert.equal(newIncoming(result.seen, [chat('c1', message(4, 'peer'))], 'me').arrivals.length, 1);
  // A Mesh message in a chat never seen before: remembered as 0, so the first server message announces.
  assert.equal(newIncoming(seen, [chat('c2', mesh)], 'me').seen.get('c2'), 0);
});

const plan = (seen, chats, over = {}) => planNotifications(seen, chats, 'me', { ...ctx(), ready: true, ...over });

test('planNotifications (B1): nothing is remembered until the chat list has loaded, so the first real list is the baseline', () => {
  // Startup: chats = [] while listLoading — no baseline yet.
  const empty = plan(null, [], { ready: false });
  assert.equal(empty.seen, null); assert.deepEqual(empty.decisions, []);
  // The first loaded list, full of unread chats: only remembered, no storm.
  const loaded = plan(empty.seen, [chat('c1', message(5, 'peer')), chat('c2', message(7, 'peer'))]);
  assert.deepEqual(loaded.decisions, []); assert.equal(loaded.seen.get('c1'), 5); assert.equal(loaded.seen.get('c2'), 7);
  // From then on a newer message is announced — also while a refresh is in flight (ready false, seen set).
  const next = plan(loaded.seen, [chat('c1', message(6, 'peer')), chat('c2', message(7, 'peer'))], { ready: false });
  assert.equal(next.decisions.length, 1); assert.equal(next.decisions[0].tag, 'chat:c1'); assert.equal(next.decisions[0].title, 'Имя c1'); assert.equal(next.decisions[0].body, 'Новое сообщение');
  assert.equal(next.seen.get('c1'), 6);
});

test('planNotifications (B2/B3): Mesh ids, chats read elsewhere and muted chats are left out before the summary is counted', () => {
  const seen = new Map([['c1', 1], ['c2', 1], ['c3', 1]]);
  // Read on the phone: nothing. Muted: nothing (and the watermark still moves).
  assert.deepEqual(plan(seen, [chat('c1', message(2, 'peer'), { unreadCount: 0 })]).decisions, []);
  const muted = plan(seen, [chat('c2', message(2, 'peer'), { settings: { muted: true, mutedUntil: null } })]);
  assert.deepEqual(muted.decisions, []); assert.equal(muted.seen.get('c2'), 2);
  // An expired mute no longer hides anything.
  assert.equal(plan(seen, [chat('c2', message(2, 'peer'), { settings: { muted: true, mutedUntil: new Date(999).toISOString() } })]).decisions.length, 1);
  // Mesh: the watermark stays, no notification.
  const mesh = plan(seen, [chat('c3', message(9_000_000_000_000_001, 'peer', { mesh: true }))]);
  assert.deepEqual(mesh.decisions, []); assert.equal(mesh.seen.get('c3'), 1);
  // Seven new chats, five of them muted: two separate notifications, not a «Новых сообщений: 7» summary.
  const many = Array.from({ length: 7 }, (_, i) => chat(`m${i}`, message(2, 'peer'), i < 5 ? { settings: { muted: true, mutedUntil: null } } : {}));
  const before = new Map(many.map(c => [c.id, 1]));
  const few = plan(before, many);
  assert.deepEqual(few.decisions.map(d => d.tag), ['chat:m5', 'chat:m6']);
  // Seven unmuted: one summary.
  const flood = plan(before, many.map(c => ({ ...c, settings: undefined })));
  assert.equal(flood.decisions.length, 1); assert.equal(flood.decisions[0].tag, 'summary'); assert.equal(flood.decisions[0].body, 'Новых сообщений: 7');
  // The window in front, or the decision otherwise negative: the watermark moves, nothing is returned.
  const active = plan(before, many, { windowActive: true });
  assert.deepEqual(active.decisions, []); assert.equal(active.seen.get('m6'), 2);
  // Text only with the preview switch, from the message itself.
  const withText = plan(seen, [chat('c1', message(2, 'peer', { text: 'Привет' }))], { prefs: prefs({ textPreview: true }) });
  assert.equal(withText.decisions[0].body, 'Привет');
});

test('dndLabel: «Выкл», «До выключения», «До 18:30»', () => {
  const now = new Date(2026, 2, 10, 12, 0, 0).getTime();
  assert.equal(dndLabel({ dndUntil: null }, now), 'Выкл');
  assert.equal(dndLabel({ dndUntil: now - 1 }, now), 'Выкл');
  assert.equal(dndLabel({ dndUntil: Infinity }, now), 'До выключения');
  assert.equal(dndLabel({ dndUntil: now + 3600_000 }, now), 'До 13:00');
  assert.equal(dndLabel({ dndUntil: now + 24 * 3600_000 }, now), 'До завтра, 12:00');
});

test('previewText: like the chat list — text without spoilers, else the attachment label, nothing for undecrypted', () => {
  assert.equal(previewText(message(1, 'p', { text: 'Секрет: пароль', meta: { entities: [{ type: 'spoiler', offset: 8, length: 6 }] } })), 'Секрет: ▒▒▒▒▒▒');
  assert.equal(previewText(message(1, 'p', { text: '', attachment: { id: 'a', name: 'photo.jpg', mimeType: 'image/jpeg', size: 10 } })), '🖼 Фотография');
  assert.equal(previewText(message(1, 'p', { text: 'secret', cryptoState: 'no-key' })), '');
  assert.equal(previewText(message(1, 'p', { text: 'old', cryptoState: 'legacy' })), 'old');
});

test('prefs: F2 switches map onto the model, desktop extras default to no text and no DND', () => {
  assert.deepEqual(BASE, { enabled: true, senderName: true, textPreview: false, sound: true, calls: true, dndUntil: null });
  const quiet = effectivePrefs({ ...DEFAULT_NOTIFICATION_PREFS, chats: { show: false, sound: false, vibration: true, preview: false }, calls: { ringtone: 'none', vibration: false } }, { textPreview: true, dndUntil: 5 });
  assert.deepEqual(quiet, { enabled: false, senderName: false, textPreview: true, sound: false, calls: true, dndUntil: 5 });
  // «Имя отправителя» off: the app name stands in, the text still follows its own switch.
  const anonymous = decideNotification(msg(), ctx({ prefs: prefs({ senderName: false }) }));
  assert.equal(anonymous.title, 'Инвиз'); assert.equal(anonymous.body, 'Новое сообщение');
  assert.equal(decideNotification(msg(), ctx({ prefs: prefs({ senderName: false, textPreview: true }) })).body, 'Привет, как дела?');
  assert.equal(decideNotification(call(), ctx({ prefs: prefs({ senderName: false }) })).title, 'Инвиз');
});

test('desktop prefs: bad input falls back; «forever» DND round-trips through storage', () => {
  assert.deepEqual(parseDesktopPrefs(null), DEFAULT_DESKTOP_PREFS);
  assert.equal(DEFAULT_DESKTOP_PREFS.textPreview, false);
  assert.deepEqual(parseDesktopPrefs('nonsense'), DEFAULT_DESKTOP_PREFS);
  assert.deepEqual(parseDesktopPrefs('{"textPreview":"yes","dndUntil":-5}'), DEFAULT_DESKTOP_PREFS);
  assert.deepEqual(parseDesktopPrefs('{"textPreview":true,"dndUntil":"forever"}'), { textPreview: true, dndUntil: Infinity });
  assert.equal(parseDesktopPrefs('{"dndUntil":123}').dndUntil, 123);
  mod.setDesktopPrefs({ textPreview: true, dndUntil: Infinity });
  assert.equal(mod.getDesktopPrefs().textPreview, true);
  assert.equal(mod.currentPrefs().textPreview, true); assert.equal(mod.currentPrefs().dndUntil, Infinity); assert.equal(mod.currentPrefs().enabled, true);
  const saved = store.get('linea.desktop-notify.v1');
  assert.deepEqual(parseDesktopPrefs(saved), { textPreview: true, dndUntil: Infinity });
  mod.setDesktopPrefs({ textPreview: false, dndUntil: null });
  assert.deepEqual(mod.currentPrefs(), BASE);
});

test('Electron: the decision goes through the bridge as-is; close reaches the main process', async () => {
  const shown = [], closed = [];
  globalThis.invizentDesktop = { notifications: { show: async p => { shown.push(p); return true; }, close: async tag => { closed.push(tag); }, onAction: () => () => {} } };
  try {
    assert.equal(webNotificationPermission(), 'desktop');
    const d = decideNotification(msg(), ctx());
    assert.equal(await showDecision(d, () => {}), true);
    assert.deepEqual(shown, [{ tag: 'chat:c1', title: 'Анна', body: 'Новое сообщение', silent: false, kind: 'message', chatId: 'c1', answer: false }]);
    // The same chat again: the earlier one is closed first, so one card per chat.
    await showDecision(decideNotification(msg(), ctx()), () => {});
    assert.deepEqual(closed, ['chat:c1']);
    closeNotification('chat:c1');
    assert.deepEqual(closed, ['chat:c1', 'chat:c1', 'chat:c1']);
    assert.equal(await showDecision({ show: false, reason: 'active' }, () => {}), false);
  } finally { delete globalThis.invizentDesktop; }
});

test('browser: Notification API only after permission; a click focuses and opens the chat', async () => {
  const created = [];
  class FakeNotification { static permission = 'default'; constructor(title, options) { this.title = title; this.options = options; this.closed = 0; created.push(this); } close() { this.closed++; } static async requestPermission() { FakeNotification.permission = 'granted'; return 'granted'; } }
  const hadFocus = Object.hasOwn(globalThis, 'focus'); const previousFocus = globalThis.focus; let focused = 0;
  globalThis.Notification = FakeNotification; globalThis.focus = () => { focused++; };
  try {
    assert.equal(webNotificationPermission(), 'default');
    assert.equal(await showDecision(decideNotification(msg(), ctx()), () => {}), false);
    assert.equal(created.length, 0);
    assert.equal(await requestWebNotificationPermission(), 'granted');
    assert.equal(await requestWebNotificationPermission(), 'granted');
    const opened = [];
    assert.equal(await showDecision(decideNotification(call(), ctx()), (chatId, answer) => opened.push([chatId, answer])), true);
    assert.equal(created.length, 1); assert.equal(created[0].title, 'Анна'); assert.equal(created[0].options.tag, 'call:c1'); assert.equal(created[0].options.requireInteraction, true);
    created[0].onclick();
    assert.equal(focused, 1); assert.deepEqual(opened, [['c1', false]]); assert.equal(created[0].closed, 1);
    closeNotification('call:c1');
  } finally { delete globalThis.Notification; if (hadFocus) globalThis.focus = previousFocus; else delete globalThis.focus; }
});

test('without a bridge or a Notification API nothing is shown and nothing throws', async () => {
  assert.equal(webNotificationPermission(), 'unsupported');
  assert.equal(await requestWebNotificationPermission(), 'unsupported');
  assert.equal(await showDecision(decideNotification(msg(), ctx()), () => {}), false);
  closeNotification('chat:none');
  assert.equal(navigated.length, 0); assert.equal(locked, false);
});

test('F4 «Отправить без звука»: the desktop notification is shown, but without sound', () => {
  const quiet = decideNotification(msg({ quiet: true }), ctx());
  assert.equal(quiet.show, true); assert.equal(quiet.silent, true);
  assert.equal(decideNotification(msg({ quiet: true }), ctx({ locked: true })).silent, true, 'under the lock too');
  assert.equal(decideNotification(msg(), ctx()).silent, false, 'an ordinary message rings as before');
});
