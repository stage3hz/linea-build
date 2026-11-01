import { fromByteArray, toByteArray } from 'base64-js';
import { desktopBridge } from './desktop';
export const cacheDirectory = 'invizent-cache://local/';
export const documentDirectory = cacheDirectory;
export const EncodingType = { Base64: 'base64', UTF8: 'utf8' } as const;
export const FileSystemUploadType = { BINARY_CONTENT: 0 };
const call = (method: string, ...args: unknown[]) => { const desktop = desktopBridge(); if (!desktop) throw new Error('Файлы доступны в приложении для ПК.'); return desktop.files(method,args); };
export async function readAsStringAsync(uri: string, options?: { encoding?: string }): Promise<string> {
  const bytes = uri.startsWith(cacheDirectory) ? new Uint8Array(await call('read',uri)) : new Uint8Array(await (await fetch(uri)).arrayBuffer());
  return options?.encoding === 'base64' ? fromByteArray(bytes) : new TextDecoder().decode(bytes);
}
export async function writeAsStringAsync(uri: string, data: string, options?: { encoding?: string }) { const bytes = options?.encoding === 'base64' ? toByteArray(data) : new TextEncoder().encode(data); await call('write',uri,bytes); }
export async function getInfoAsync(uri: string): Promise<any> {
  if (uri.startsWith(cacheDirectory)) return call('info',uri);
  try { const response = await fetch(uri); const blob = await response.blob(); return { exists: response.ok, isDirectory: false, size: blob.size, uri }; } catch { return { exists: false, isDirectory: false, uri }; }
}
export const makeDirectoryAsync = (uri: string, _options?: any) => call('mkdir',uri);
export const deleteAsync = (uri: string, _options?: any) => call('delete',uri);
export const readDirectoryAsync = (uri: string) => call('list',uri);
export async function copyAsync({ from, to }: { from: string; to: string }) { await writeAsStringAsync(to,await readAsStringAsync(from,{encoding:'base64'}),{encoding:'base64'}); }
export async function downloadAsync(url: string, target: string, options?: any) { const response = await fetch(url,{headers:options?.headers}); if (!response.ok) return { status: response.status, uri: target }; await call('write',target,new Uint8Array(await response.arrayBuffer())); return { status: response.status, uri: target }; }
export function createDownloadResumable(url: string, target: string, options: any, progress?: any) {
  const controller = new AbortController();
  return { cancelAsync: async () => controller.abort(), pauseAsync: async () => { controller.abort(); return {}; }, downloadAsync: async () => { const response = await fetch(url,{headers:options?.headers,signal:controller.signal}); if (!response.ok) return {status:response.status,uri:target}; const bytes=new Uint8Array(await response.arrayBuffer()); progress?.({totalBytesWritten:bytes.length,totalBytesExpectedToWrite:bytes.length}); await call('write',target,bytes); return { status:response.status,uri:target }; } };
}
export async function uploadAsync(url: string, uri: string, options?: any) { const data=toByteArray(await readAsStringAsync(uri,{encoding:'base64'})); const response=await fetch(url,{method:options?.httpMethod||'POST',headers:options?.headers,body:data as unknown as BodyInit}); return {status:response.status,body:await response.text(),headers:Object.fromEntries(response.headers.entries())}; }
