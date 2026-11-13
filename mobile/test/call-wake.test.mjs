import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { wakePayload } from '../src/calls/incomingModel.ts';
import { chatNotification } from '../../server/src/push.js';

// A call that wakes the app (Android): the server's data message, read by the app's background task.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the app reads the server\'s wake message wherever the notifications library puts it', () => {
  const data = chatNotification({ chatId: 'chat-1', senderName: 'Аня', kind: 'call', unread: 0, ring: true, wake: true }).data;
  const call = { chatId: 'chat-1', name: 'Аня' };
  assert.deepEqual(wakePayload(data), call);
  assert.deepEqual(wakePayload({ data }), call);
  assert.deepEqual(wakePayload({ data: JSON.stringify(data) }), call);
  assert.deepEqual(wakePayload({ data: { body: JSON.stringify(data) } }), call);
  assert.deepEqual(wakePayload({ dataString: JSON.stringify(data) }), call);
  assert.deepEqual(wakePayload({ notification: { data } }), call);
});

test('anything else is not a call to wake for', () => {
  assert.equal(wakePayload({ chatId: 'chat-1', kind: 'call' }), null, 'an older server\'s call: the ordinary notification handles it');
  assert.equal(wakePayload({ chatId: 'chat-1', kind: 'message', wake: '1' }), null);
  assert.equal(wakePayload({ chatId: '../x', kind: 'call', wake: '1' }), null);
  assert.equal(wakePayload({ kind: 'call', wake: '1' }), null);
  for (const junk of [null, undefined, 'x', 5, [], { data: 'not json' }]) assert.equal(wakePayload(junk), null);
  assert.equal(wakePayload({ chatId: 'c', kind: 'call', wake: '1', title: 'я'.repeat(300) }).name.length, 80);
});

test('the pieces are in place: the task at start-up, a fallback, the lock screen only for the call', () => {
  const task = read('../src/calls/incomingPush.ts');
  assert.ok(task.includes("TaskManager.defineTask(CALL_PUSH_TASK") && task.includes('Notifications.registerTaskAsync(CALL_PUSH_TASK)'));
  assert.ok(task.includes("if (AppState.currentState === 'active') return;"), 'an open app rings by itself');
  assert.ok(task.includes('if (!shown) return; // the ordinary ringing notification stays'));
  assert.ok(!/from '[^']*e2ee|cryptoRuntime|LineaSignal/.test(task), 'nothing is decrypted in the background');
  assert.ok(read('../index.ts').includes("import './src/calls/incomingPush';"));
  assert.ok(read('../src/calls/incomingPush.web.ts').includes('export async function enableCallPush() {}'), 'the PC has none of it');
  const calls = read('../src/calls/CallProvider.tsx');
  assert.ok(calls.includes('else if (overLock.current) { overLock.current = false; setOverLock(false); }'), 'left the call screen: back behind the lock');
  assert.ok(calls.includes("if (opened?.answer && opened.chatId === chat.id)"), '«Ответить» on the notification answers');
  const kotlin = read('../modules/linea-call/android/src/main/java/expo/modules/lineacall/IncomingCall.kt');
  assert.ok(kotlin.includes('.setFullScreenIntent(full, true)') && kotlin.includes('Notification.CallStyle.forIncomingCall(person, decline, answer)'));
  assert.ok(kotlin.includes('.setTimeoutAfter(RING_MS)'), 'gone when the caller\'s ring runs out');
  assert.ok(kotlin.includes('if (android.os.SystemClock.elapsedRealtime() - pendingAt > OVER_LOCK_MS) return null'), 'an old «Ответить» never answers a later call');
  const manifest = read('../modules/linea-call/android/src/main/AndroidManifest.xml');
  assert.ok(manifest.includes('android.permission.USE_FULL_SCREEN_INTENT') && manifest.includes('IncomingCallReceiver'));
});
