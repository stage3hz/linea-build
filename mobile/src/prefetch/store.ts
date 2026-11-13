// Фоновое обновление: where the plan and the kept pages live on the phone (the rules are in model.ts).
//  - the plan: AsyncStorage (two small numbers per chat, no message content);
//  - kept pages: one file per chat in the app's cache folder — ciphertext exactly as the server sent it.
// Importing this file connects it to the Api: `cryptoInbox` then asks here first and reports each cursor.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { setInboxPrefetch } from '../api';
import { cursorAfter, keptAnswers, parseKept, parsePlan, planWith, validPage, type InboxPage, type KeptPage, type PrefetchPlan } from './model';

const PLAN_KEY = 'linea.prefetch.plan.v1';
const folder = () => `${FileSystem.cacheDirectory || ''}prefetch/`;
const fileOf = (chatId: string) => `${folder()}${chatId.replace(/[^A-Za-z0-9_-]/g, '')}.json`;

let plan: PrefetchPlan | null | undefined;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export async function readPlan(): Promise<PrefetchPlan | null> {
  if (plan === undefined) plan = parsePlan(await AsyncStorage.getItem(PLAN_KEY).catch(() => null));
  return plan;
}

/** The open app has read `chatId` up to `cursor`: remembered for the next background run (written a moment later,
 *  many chats at once). */
async function note(deviceId: string, chatId: string, cursor: number) {
  const next = planWith(await readPlan(), deviceId, chatId, cursor);
  if (next === plan) return;
  plan = next;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; if (plan) void AsyncStorage.setItem(PLAN_KEY, JSON.stringify(plan)).catch(() => {}); }, 1500);
}

/** The kept page for exactly this request, or null. A page is used once: its file is removed either way (one that
 *  no longer fits is of no use to a later request either — the cursor only moves forward). */
async function take(deviceId: string, chatId: string, after: number): Promise<InboxPage | null> {
  if (!FileSystem.cacheDirectory) return null;
  const path = fileOf(chatId);
  const info = await FileSystem.getInfoAsync(path).catch(() => null);
  if (!info?.exists) return null;
  const kept = parseKept(await FileSystem.readAsStringAsync(path).catch(() => null));
  await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
  return keptAnswers(kept, deviceId, chatId, after, Date.now()) ? kept!.result : null;
}

/** The background run keeps a page it has just downloaded. */
export async function keepPage(deviceId: string, chatId: string, after: number, result: unknown): Promise<boolean> {
  if (!FileSystem.cacheDirectory || !validPage(result, chatId, after) || !result.messages.length) return false;
  const page: KeptPage = { deviceId, chatId, after, at: Date.now(), result };
  await FileSystem.makeDirectoryAsync(folder(), { intermediates: true }).catch(() => {});
  await FileSystem.writeAsStringAsync(fileOf(chatId), JSON.stringify(page));
  return true;
}

/** Signing out: nothing of the account's is left behind. */
export async function clearPrefetch() {
  plan = null;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  await AsyncStorage.removeItem(PLAN_KEY).catch(() => {});
  if (FileSystem.cacheDirectory) await FileSystem.deleteAsync(folder(), { idempotent: true }).catch(() => {});
}

setInboxPrefetch({ take, note: (deviceId, chatId, page, after) => { void note(deviceId, chatId, cursorAfter(page, after)).catch(() => {}); } });
