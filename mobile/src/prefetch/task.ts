// Фоновое обновление: the background run itself (Android). The system starts the app without a screen now and
// then (not more often than every 15 minutes, and when it sees fit); this downloads the encrypted messages waiting
// in the chats with unread ones and keeps them for the next opening (store.ts). Nothing is decrypted here.
// The task is defined at start-up (index.ts imports this file), as the system requires.
import { Platform } from 'react-native';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import { Api } from '../api';
import { SERVER_URL } from '../serverConfig';
import { readServer, readToken } from '../storage';
import { PREFETCH_BUDGET_MS, prefetchTargets } from './model';
import { keepPage, readPlan } from './store';

export const PREFETCH_TASK = 'invizent-prefetch';

async function run(): Promise<void> {
  const started = Date.now();
  const [token, server, plan] = await Promise.all([readToken(), readServer(), readPlan()]);
  // Signed out, or the app has not been opened since this was added: nothing to do.
  if (!token || !plan) return;
  const api = new Api(server || SERVER_URL, token);
  const { chats } = await api.chats();
  for (const target of prefetchTargets(chats, plan)) {
    if (Date.now() - started > PREFETCH_BUDGET_MS) break;
    try { await keepPage(plan.deviceId, target.chatId, target.after, await api.inboxPage(plan.deviceId, target.chatId, target.after)); }
    catch { /* this chat waits for the next run or for the app to be opened */ }
  }
}

if (Platform.OS === 'android') {
  try {
    TaskManager.defineTask(PREFETCH_TASK, async () => {
      try { await run(); return BackgroundTask.BackgroundTaskResult.Success; }
      catch { return BackgroundTask.BackgroundTaskResult.Failed; }
    });
  } catch { /* a build without the module: no background run */ }
}

/** Asks the system to run the task (called once the app is open; safe to call again). */
export async function enablePrefetch() {
  if (Platform.OS !== 'android') return;
  try { await BackgroundTask.registerTaskAsync(PREFETCH_TASK, { minimumInterval: 15 }); } catch { /* not available on this phone */ }
}
