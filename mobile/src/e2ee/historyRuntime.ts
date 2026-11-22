import { useSyncExternalStore } from 'react';
import * as Crypto from 'expo-crypto';
import type { Api } from '../api';
import type { CryptoRuntime } from './runtime';
import { getSignalBridge } from './signal';
import { askForHistory, receiveHistory, runBackup, serveHistory, type HistoryDeps } from './historySync';

/**
 * Old chats on a new device, as the running app does it (docs/HISTORY-TRANSFER.md). useMessenger.ts starts one
 * runner per signed-in account and pokes it with the socket events `history.request` / `history.ready` /
 * `history.backup`; SecurityScreen reads its status and deps (backup key, restore).
 */
export type HistoryStatus = {
  /** sending: this device copies its chats to a new device; receiving: this device imports a copy. */
  phase: 'idle' | 'sending' | 'receiving';
  done: number; total: number;
  /** On a new device: when the copy from another device may start (the server's 10-minute wait). */
  waitingUntil: string | null;
  /** Messages imported on this device so far (shown once). */
  imported: number;
};
const IDLE: HistoryStatus = { phase: 'idle', done: 0, total: 0, waitingUntil: null, imported: 0 };
let status = IDLE;
const listeners = new Set<() => void>();
const publish = (change: Partial<HistoryStatus>) => { status = { ...status, ...change }; for (const listener of listeners) listener(); };
export const useHistoryStatus = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => status);

const BACKUP_EVERY_MS = 30 * 60_000;
const RECEIVE_POLL_MS = 2 * 60_000;
let active: HistoryRunner | null = null;
/** The runner of the signed-in account, for the security screen. */
export const historyRunner = () => active;

export class HistoryRunner {
  private stopped = false;
  private serveTimer: ReturnType<typeof setTimeout> | null = null;
  private backupTimer: ReturnType<typeof setTimeout> | null = null;
  private receiveTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> = Promise.resolve();
  constructor(private api: Api, private runtime: CryptoRuntime, private userId: string, private onImported: () => void) {}

  async deps(): Promise<HistoryDeps> {
    const crypto = await this.runtime.get();
    const bridge = getSignalBridge();
    // The PC build (desktop/build-ui.mjs) runs this in a browser engine: its own source first.
    const web = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
    const random = (count: number) => web?.getRandomValues ? web.getRandomValues(new Uint8Array(count)) : Crypto.getRandomBytes(count);
    return { userId: this.userId, api: this.api, crypto, cipher: bridge, random };
  }
  start() {
    active = this; status = IDLE;
    this.poke('start');
    this.backupTimer = setTimeout(() => this.poke('backup'), 20_000);
  }
  stop() {
    this.stopped = true;
    for (const timer of [this.serveTimer, this.backupTimer, this.receiveTimer]) if (timer) clearTimeout(timer);
    if (active === this) { active = null; status = IDLE; }
  }
  /** One job at a time, in order; a failure is retried at the next poke (a socket event, a timer, the next start). */
  poke(reason: 'start' | 'history.request' | 'history.ready' | 'history.backup' | 'backup' | 'serve' | 'receive') {
    this.running = this.running.then(() => this.stopped ? undefined : this.work(reason)).catch(() => {});
  }
  private async work(reason: string) {
    const deps = await this.deps();
    if (reason === 'start' || reason === 'history.ready' || reason === 'receive') await this.receive(deps);
    if (reason === 'start' || reason === 'history.request' || reason === 'serve') await this.serve(deps);
    if (reason === 'backup' || reason === 'history.backup') {
      try { await runBackup(deps); } finally { if (!this.stopped) { if (this.backupTimer) clearTimeout(this.backupTimer); this.backupTimer = setTimeout(() => this.poke('backup'), BACKUP_EVERY_MS); } }
    }
  }
  private async receive(deps: HistoryDeps) {
    const asked = await askForHistory(deps).catch(() => null);
    if (asked && asked.state === 'waiting') publish({ waitingUntil: asked.notBefore });
    try {
      const imported = await receiveHistory(deps, (done, total) => publish({ phase: 'receiving', done, total }));
      if (imported !== null) { publish({ phase: 'idle', waitingUntil: null, imported: status.imported + imported }); this.onImported(); return; }
    } catch (error) { publish({ phase: 'idle' }); throw error; }
    // Still waiting for the copy: look again now and then (the socket event usually comes first).
    if (status.waitingUntil && !this.stopped) { if (this.receiveTimer) clearTimeout(this.receiveTimer); this.receiveTimer = setTimeout(() => this.poke('receive'), RECEIVE_POLL_MS); }
  }
  private async serve(deps: HistoryDeps) {
    let next: string | null = null;
    try { next = await serveHistory(deps); }
    finally { publish({ phase: 'idle', done: 0, total: 0 }); }
    if (next && !this.stopped) {
      if (this.serveTimer) clearTimeout(this.serveTimer);
      this.serveTimer = setTimeout(() => this.poke('serve'), Math.max(1000, Date.parse(next) - Date.now() + 2000));
    }
  }
}
