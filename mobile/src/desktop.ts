import type { SignalBridge } from './e2ee/types';
/** A system notification the main process shows (Windows toast, macOS banner, Linux libnotify). Text only when the page decided so (notifications/desktopNotify.ts). */
export type DesktopNotification = { tag: string; title: string; body: string; silent: boolean; kind: 'message' | 'call'; chatId: string | null; answer: boolean };
export type DesktopBridge = {
  saveFile(uri:string, name:string): Promise<void>;
  openFile(uri:string):Promise<boolean>;
  files(method: string, args: unknown[]): Promise<any>;
  signal: SignalBridge;
  request(id: string, request: { url: string; method: string; headers: Record<string,string>; body: ArrayBuffer | null }): Promise<{ status: number; statusText: string; headers: Record<string,string>; body: ArrayBuffer }>;
  cancelRequest(id: string): Promise<void>;
  vault: { open(scope: string): Promise<string>; get(id: string, key: string): Promise<string | null>; commit(id: string, changes: Record<string, string | null>): Promise<void>; close(id: string): Promise<void> };
  token: { read(): Promise<string | null>; write(value: string | null): Promise<void> };
  /** Downloads the Windows installer, checks it against the published SHA-256, then launches it. Older builds lack this. */
  /** Mute/deafen keys that work even when Инвиз is in the background (Electron globalShortcut). */
  shortcuts?: { set(binds: Record<string, string>): Promise<Record<string, boolean>>; onAction(listener: (action: string) => void): () => void;
    /** Hold binds over other apps (system keyboard hook, only while in voice / a call). Older builds lack it. */
    setHold?(config: { active: boolean; ptt?: string; pushToMute?: string }): Promise<{ hooked: boolean }>; onHold?(listener: (action: 'ptt' | 'pushToMute', down: boolean) => void): () => void };
  /** In-game overlay window (Настройки → Оверлей). Older builds lack it. */
  overlay?: { configure(prefs: { enabled: boolean; corner: string; onlySpeaking: boolean; opacity: number }): Promise<void>; update(view: unknown): Promise<void> };
  update?: { download(url: string, sha256: string, size: number): Promise<boolean>; progress(): Promise<{ received: number; total: number; ready: boolean }>; cancel(): Promise<void>; install(): Promise<boolean> };
  /** Unread counter: Windows taskbar overlay (picture drawn by the page), macOS dock badge, tray icon and tooltip on Windows/Linux. */
  badge?: (count: number, picture: string | null) => Promise<void>;
  /** System notifications shown by the main process; a click comes back as an action (open the chat, answer the call). Older builds lack it. */
  notifications?: { show(payload: DesktopNotification): Promise<boolean>; close(tag: string): Promise<void>; onAction(listener: (action: { kind: 'open' | 'answer'; chatId: string | null }) => void): () => void };
};
export const desktopBridge = (): DesktopBridge | undefined => (globalThis as unknown as { invizentDesktop?: DesktopBridge }).invizentDesktop;
