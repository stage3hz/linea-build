// The old chats of the account on a new device (docs/HISTORY-TRANSFER.md): who sends what, when.
// No React Native here: useMessenger.ts drives it, the tests run it with the real Signal library in Node.
//
// Variant A: a device whose vault has no history asks the server for a copy once. The account's older
// devices see «Новый вход»; after the server's 10-minute wait any of them that is online exports its
// cached chats in pages, encrypts every page under a fresh key and uploads it for that device only, then
// seals the key with Signal for that device. The new device opens the key, decrypts, imports, and the
// server deletes everything.
// Variant B: one device turns the backup on and makes the secret; it is sealed (Signal) for every other
// own device that has been signed in for 10 minutes; the device that writes the log appends what is new.
import type { CryptoService, HistoryBatch, SealedNote } from './core';
import type { SignalBridge } from './types';
import { backupAd, backupKeys, newBackupSecret, newPageKey, openPage, parseSecret, parseSecretNote, parseTransferNote, sealPage, secretNote, transferAd, transferNote, type RandomBytes } from './history';

export type HistoryTransfer = {
  id: string; state: 'waiting' | 'sending' | 'ready' | 'done' | 'cancelled'; targetDeviceId: string; sourceDeviceId: string | null;
  notBefore: string; ready: boolean; pageCount: number; bytes: number; expiresAt: string;
  target?: { id: string; deviceName: string; identityKey: string; registrationId: number; createdAt: string };
  note?: SealedNote;
};
export type BackupState = {
  enabled: boolean; salt: string; generation: number; pageCount: number; bytes: number; updatedAt: string | null; writerDeviceId: string | null;
  restoreAt: string; canRestore: boolean; note?: SealedNote; missing?: { id: string; deviceName: string }[];
};
/** The server's history routes (api.ts). */
export type HistoryApi = {
  requestHistory(deviceId: string): Promise<{ transfer: HistoryTransfer }>;
  outgoingHistory(deviceId: string): Promise<{ transfers: HistoryTransfer[] }>;
  incomingHistory(deviceId: string): Promise<{ transfer: HistoryTransfer | null }>;
  claimHistory(id: string, deviceId: string): Promise<{ transfer: HistoryTransfer }>;
  putHistoryPage(id: string, index: number, deviceId: string, body: string): Promise<{ pageCount: number }>;
  completeHistory(id: string, deviceId: string, note: SealedNote, pageCount: number): Promise<{ transfer: HistoryTransfer }>;
  historyPage(id: string, index: number, deviceId: string): Promise<{ body: string }>;
  ackHistory(id: string, deviceId: string): Promise<{ ok: true }>;
  cancelHistory(id: string, deviceId: string): Promise<{ ok: true }>;
  backupState(deviceId: string): Promise<BackupState>;
  enableBackup(deviceId: string, generation: number, keyCheck: string): Promise<BackupState>;
  disableBackup(deviceId: string): Promise<{ ok: true }>;
  putBackupNote(deviceId: string, targetDeviceId: string, generation: number, note: SealedNote): Promise<{ ok: true }>;
  appendBackupPage(deviceId: string, generation: number, body: string, reset: boolean): Promise<{ index: number; pageCount: number }>;
  startRestore(deviceId: string): Promise<{ salt: string; keyCheck: string; generation: number; pageCount: number; attemptsLeft: number }>;
  backupPage(index: number, deviceId: string): Promise<{ body: string }>;
};
/** Kept in the device's vault (`history:v1`): whether this device asked for a copy; the backup secret and marks. */
export type LocalHistoryState = {
  asked?: boolean; imported?: number; secret?: string; generation?: number; marks?: Record<string, string>;
  /** A copy being imported: its key (opened from the Signal note once) and how far it got. */
  transfer?: { id: string; key: string; pageCount: number; done: number; imported: number };
};
export type HistoryDeps = { userId: string; api: HistoryApi; crypto: CryptoService; cipher: Pick<SignalBridge, 'seal' | 'open'>; random: RandomBytes };

const errorCode = (error: unknown) => (error as { code?: unknown })?.code;
const errorStatus = (error: unknown) => (error as { status?: unknown })?.status;

export async function loadState(crypto: CryptoService): Promise<LocalHistoryState> {
  try { const value = JSON.parse((await crypto.loadLocal('history:v1')) || '{}'); return value && typeof value === 'object' ? value as LocalHistoryState : {}; } catch { return {}; }
}
export async function saveState(crypto: CryptoService, change: Partial<LocalHistoryState>): Promise<LocalHistoryState> {
  const next = { ...(await loadState(crypto)), ...change };
  await crypto.storeLocal('history:v1', JSON.stringify(next));
  return next;
}
const ownDeviceId = async (crypto: CryptoService) => { await crypto.initialize(); const id = crypto.deviceId; if (!id) throw new Error('Шифрование не готово.'); return id; };

// ── Variant A ──────────────────────────────────────────────────────────────────────────────────────────────

/** On a device without any cached chat: ask for a copy once. Gives the request, or null (nobody to ask). */
export async function askForHistory(deps: HistoryDeps): Promise<HistoryTransfer | null> {
  const state = await loadState(deps.crypto);
  if (state.asked) return null;
  const deviceId = await ownDeviceId(deps.crypto);
  if ((await deps.crypto.historyChats()).length) { await saveState(deps.crypto, { asked: true }); return null; }
  try {
    const { transfer } = await deps.api.requestHistory(deviceId);
    await saveState(deps.crypto, { asked: true });
    return transfer;
  } catch (error) {
    if (errorCode(error) === 'HISTORY_NO_SOURCE') { await saveState(deps.crypto, { asked: true }); return null; }
    throw error;
  }
}

/** Sends this device's cached chats to the new device of `transfer` (already past its wait). */
export async function sendHistory(deps: HistoryDeps, transfer: HistoryTransfer, onPage?: (pages: number) => void): Promise<number> {
  const deviceId = await ownDeviceId(deps.crypto);
  await deps.api.claimHistory(transfer.id, deviceId);
  const key = newPageKey(deps.random);
  let cursor: HistoryBatch['next'] = null, index = 0;
  for (;;) {
    const batch = await deps.crypto.historyExport(null, cursor);
    const last = batch.next === null || index + 1 >= 1024;
    await deps.api.putHistoryPage(transfer.id, index, deviceId, await sealPage(deps.cipher, key, transferAd(transfer.id, index), batch.items, last, deps.random));
    index++; onPage?.(index);
    if (last) break;
    cursor = batch.next;
  }
  const note = await deps.crypto.sealNote(deps.userId, transfer.targetDeviceId, transferNote(transfer.id, key, index), 'history');
  await deps.api.completeHistory(transfer.id, deviceId, note, index);
  return index;
}

/**
 * On an older device: answers every request whose wait is over. Gives the time of the next request still
 * waiting (to look again then), or null.
 */
export async function serveHistory(deps: HistoryDeps): Promise<string | null> {
  const deviceId = await ownDeviceId(deps.crypto);
  const { transfers } = await deps.api.outgoingHistory(deviceId);
  let next: string | null = null;
  for (const transfer of transfers) {
    if (!transfer.ready) { if (!next || transfer.notBefore < next) next = transfer.notBefore; continue; }
    if (transfer.state === 'sending' && transfer.sourceDeviceId && transfer.sourceDeviceId !== deviceId) continue;
    try { await sendHistory(deps, transfer); }
    catch (error) {
      // Another device took it, or the new device left / was cancelled meanwhile: nothing to do here.
      if (['HISTORY_CLAIMED', 'HISTORY_CLOSED', 'HISTORY_TOO_EARLY'].includes(String(errorCode(error))) || [403, 404, 409, 410].includes(Number(errorStatus(error)))) continue;
      throw error;
    }
  }
  return next;
}

/** On the new device: imports a completed copy. Gives the number of messages imported, or null when none is ready. */
export async function receiveHistory(deps: HistoryDeps, onPage?: (done: number, total: number) => void): Promise<number | null> {
  const deviceId = await ownDeviceId(deps.crypto);
  const { transfer } = await deps.api.incomingHistory(deviceId);
  if (!transfer || transfer.state !== 'ready' || !transfer.note) return null;
  // A Signal message opens once: the key is kept in the vault until the copy is imported, so a retry (no
  // internet halfway, the app closed) goes on with it from the page where it stopped.
  const local = await loadState(deps.crypto);
  let held = local.transfer && local.transfer.id === transfer.id ? local.transfer : null;
  if (!held) {
    const opened = parseTransferNote(await deps.crypto.openNote(deps.userId, transfer.note, 'history'), transfer.id);
    held = { id: transfer.id, key: opened.key, pageCount: opened.pageCount, done: 0, imported: 0 };
    await saveState(deps.crypto, { transfer: held });
  }
  const { key, pageCount } = held;
  if (pageCount !== transfer.pageCount) throw new Error('Копия переписок пришла не полностью.');
  let imported = held.imported;
  for (let index = held.done; index < pageCount; index++) {
    const { body } = await deps.api.historyPage(transfer.id, index, deviceId);
    const page = await openPage(deps.cipher, key, transferAd(transfer.id, index), body);
    if (page.last !== (index === pageCount - 1)) throw new Error('Копия переписок пришла не полностью.');
    imported += (await deps.crypto.historyImport(page.items)).imported;
    await saveState(deps.crypto, { transfer: { ...held, done: index + 1, imported } });
    onPage?.(index + 1, pageCount);
  }
  await deps.api.ackHistory(transfer.id, deviceId);
  await saveState(deps.crypto, { transfer: undefined, imported: ((await loadState(deps.crypto)).imported ?? 0) + imported });
  return imported;
}

// ── Variant B ──────────────────────────────────────────────────────────────────────────────────────────────

/** Turns the backup on with a new secret made here (or starts a new secret). Gives the secret to show. */
export async function enableBackup(deps: HistoryDeps): Promise<string> {
  const deviceId = await ownDeviceId(deps.crypto);
  const state = await deps.api.backupState(deviceId);
  const secret = newBackupSecret(deps.random);
  const { keyCheck } = backupKeys(secret, state.salt, deps.userId);
  const enabled = await deps.api.enableBackup(deviceId, state.generation + 1, keyCheck);
  await saveState(deps.crypto, { secret, generation: enabled.generation, marks: {} });
  return secret;
}

export async function disableBackup(deps: HistoryDeps): Promise<void> {
  await deps.api.disableBackup(await ownDeviceId(deps.crypto));
  await saveState(deps.crypto, { secret: undefined, generation: undefined, marks: undefined });
}

/** The secret this device holds for the backup as it is now, taking a sealed copy from another device if one came. */
export async function currentSecret(deps: HistoryDeps, state?: BackupState): Promise<string | null> {
  const deviceId = await ownDeviceId(deps.crypto);
  const server = state ?? await deps.api.backupState(deviceId);
  const local = await loadState(deps.crypto);
  if (!server.enabled) return null;
  if (local.secret && local.generation === server.generation) return local.secret;
  if (!server.note) return null;
  const opened = parseSecretNote(await deps.crypto.openNote(deps.userId, server.note, 'history'), deps.userId);
  if (opened.generation !== server.generation) return null;
  // A new secret (or the first one here): what this device had copied belongs to the old log.
  await saveState(deps.crypto, { secret: opened.secret, generation: opened.generation, marks: {} });
  return opened.secret;
}

/**
 * Keeps the backup going from this device: hands the secret to own devices still without it, then appends
 * what is new since the last run (only the device writing the log does). Gives the pages written.
 */
export async function runBackup(deps: HistoryDeps): Promise<number> {
  const deviceId = await ownDeviceId(deps.crypto);
  const server = await deps.api.backupState(deviceId);
  const secret = await currentSecret(deps, server);
  if (!secret) return 0;
  for (const device of server.missing ?? []) {
    try { await deps.api.putBackupNote(deviceId, device.id, server.generation, await deps.crypto.sealNote(deps.userId, device.id, secretNote(deps.userId, server.generation, secret), 'history')); }
    catch { /* that device left meanwhile, or its keys could not be used: the next run tries again */ }
  }
  // Another device may write the log: the server refuses this one (BACKUP_WRITER) until that writer goes quiet.
  const { key } = backupKeys(secret, server.salt, deps.userId);
  let marks = { ...((await loadState(deps.crypto)).marks ?? {}) }, reset = false, cursor: HistoryBatch['next'] = null, written = 0;
  for (;;) {
    const batch = await deps.crypto.historyExport(reset ? null : marks, cursor);
    if (!batch.items.length) break;
    const body = await sealPage(deps.cipher, key, backupAd(deps.userId, server.generation), batch.items, false, deps.random);
    try { await deps.api.appendBackupPage(deviceId, server.generation, body, reset && written === 0); }
    catch (error) {
      if (errorCode(error) === 'BACKUP_WRITER') return written;
      // Full: start the log again from this device's whole cache (the newest messages are kept by the cache itself).
      if (errorCode(error) === 'BACKUP_FULL' && !reset) { reset = true; marks = {}; cursor = null; written = 0; continue; }
      throw error;
    }
    written++;
    Object.assign(marks, batch.marks); // places only move forward within a run
    await saveState(deps.crypto, { marks });
    if (!batch.next) break;
    cursor = batch.next;
  }
  return written;
}

/** The answers of a restore the screen shows; `left`: attempts left this hour. */
export class RestoreError extends Error {
  constructor(message: string, readonly left?: number) { super(message); this.name = 'RestoreError'; }
}

/** On a new device: the typed (or scanned) secret → the backup is downloaded, decrypted and imported. */
export async function restoreBackup(deps: HistoryDeps, typed: string, onPage?: (done: number, total: number) => void): Promise<number> {
  const secret = parseSecret(typed);
  if (!secret) throw new RestoreError('Ключ введён с ошибкой. Проверь символы — попытка не потрачена.');
  const deviceId = await ownDeviceId(deps.crypto);
  const start = await deps.api.startRestore(deviceId);
  const { key, keyCheck } = backupKeys(secret, start.salt, deps.userId);
  if (keyCheck !== start.keyCheck) throw new RestoreError(`Ключ не подходит к резервной копии этого аккаунта. Осталось попыток: ${start.attemptsLeft}.`, start.attemptsLeft);
  let imported = 0;
  for (let index = 0; index < start.pageCount; index++) {
    const { body } = await deps.api.backupPage(index, deviceId);
    imported += (await deps.crypto.historyImport((await openPage(deps.cipher, key, backupAd(deps.userId, start.generation), body)).items)).imported;
    onPage?.(index + 1, start.pageCount);
  }
  // This device now holds the secret too (it can show it and keep the backup going if the writer goes quiet).
  await saveState(deps.crypto, { secret, generation: start.generation, marks: {}, asked: true, imported: ((await loadState(deps.crypto)).imported ?? 0) + imported });
  return imported;
}
