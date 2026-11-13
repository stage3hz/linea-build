// A call that wakes the app (Android). The server sends an incoming call to a closed app as a DATA message; Android
// starts the app without a screen and runs the task below, which shows the ringing full-screen notification
// (modules/linea-call, IncomingCall.kt): over the lock screen on an idle phone, a card with «Ответить» /
// «Отклонить» on a phone in use. Opened from it, the app connects, finds the call and shows its own call screen.
//
// Nothing here decrypts anything: the notification carries only who calls. If this code does not get to run (the
// system did not start it in time), the notifications library has already shown the same message as an ordinary
// ringing notification — that one is removed here once ours is up, so the phone does not ring twice.
// The task is defined at start-up (index.ts imports this file), as the system requires.
import { AppState, Platform } from 'react-native';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import { requireOptionalNativeModule } from 'expo-modules-core';
import type { LineaCallBridge } from '../../modules/linea-call';
import { tr } from '../i18n';
import { wakePayload } from './incomingModel';

export const CALL_PUSH_TASK = 'invizent-call-push';
const native = Platform.OS === 'android' ? (() => { try { return requireOptionalNativeModule<LineaCallBridge>('LineaCall'); } catch { return null; } })() : null;

async function onPush(data: unknown): Promise<void> {
  const call = wakePayload(data);
  if (!call || !native?.showIncoming) return;
  // The app is on screen: the call arrives by its own connection and rings there.
  if (AppState.currentState === 'active') return;
  const shown = await native.showIncoming(call.chatId, call.name || 'INVIZENT', tr('Входящий звонок'), tr('Ответить'), tr('Отклонить'), tr('Входящие звонки')).catch(() => false);
  if (!shown) return; // the ordinary ringing notification stays
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    await Promise.all(presented.filter(item => (item.request.content.data as { kind?: unknown } | undefined)?.kind === 'call').map(item => Notifications.dismissNotificationAsync(item.request.identifier)));
  } catch { /* both stay; ours is on top */ }
}

if (Platform.OS === 'android') {
  try { TaskManager.defineTask(CALL_PUSH_TASK, async ({ data }) => { try { await onPush(data); } catch { /* the fallback notification is already shown */ } }); }
  catch { /* a build without the module */ }
}

/** Asks the system to run the task for incoming data messages (called once the app is open; safe to call again). */
export async function enableCallPush() {
  if (Platform.OS !== 'android') return;
  try { await Notifications.registerTaskAsync(CALL_PUSH_TASK); } catch { /* not available on this phone */ }
}

/** What the app was opened for by the incoming-call notification, once: the chat and whether «Ответить» was pressed. */
export function takeIncomingCall(): { chatId: string; answer: boolean } | null {
  try { const value = native?.takeIncoming?.(); return value && typeof value.chatId === 'string' ? { chatId: value.chatId, answer: value.answer === true } : null; } catch { return null; }
}
/** The app over the lock screen: on while a call is on screen, off the moment it is left (the chats stay locked). */
export function setOverLock(on: boolean) { try { void native?.setOverLock?.(on)?.catch(() => {}); } catch { /* optional */ } }
/** The ringing notification is not needed any more (the call is on screen, or over). */
export function dismissIncomingCall() { try { void native?.dismissIncoming?.()?.catch(() => {}); } catch { /* optional */ } }
