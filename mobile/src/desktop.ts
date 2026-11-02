import type { SignalBridge } from './e2ee/types';
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
  update?: { download(url: string, sha256: string, size: number): Promise<boolean>; progress(): Promise<{ received: number; total: number; ready: boolean }>; cancel(): Promise<void>; install(): Promise<boolean> };
};
export const desktopBridge = (): DesktopBridge | undefined => (globalThis as unknown as { invizentDesktop?: DesktopBridge }).invizentDesktop;
