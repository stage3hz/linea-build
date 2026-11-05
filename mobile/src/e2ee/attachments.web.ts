import * as Crypto from 'expo-crypto';
import * as FileSystem from '../desktopFs.web';
import { desktopBridge } from '../desktop';
import { fromByteArray, toByteArray } from 'base64-js';
import { multipartFile, type Api } from '../api';
import type { Attachment, LocalFile } from '../types';
import { getSignalBridge } from './signal';
import { prepareMediaForUpload } from '../media/pipeline.web';
import { makeThumbnail } from '../media/thumbnail.web';
const MAX_FILE=20*1024*1024;
/** Above this size a file goes in encrypted chunks (Telegram-like, up to 5 GB with Platina), without media re-encoding. */
export const LARGE_FILE=MAX_FILE;
export const CHUNK_PLAIN=4*1024*1024;
const TAG=16;
const chunkCount=(size:number)=>Math.max(1,Math.ceil(size/CHUNK_PLAIN));
export const chunkedCipherSize=(size:number)=>size+chunkCount(size)*TAG;
/** Each chunk gets its own nonce (the base nonce with the chunk index mixed into its last 4 bytes). */
export function chunkNonce(base:string,index:number):string{
  const bytes=toByteArray(base);if(bytes.length!==12)throw new Error('Неверный nonce вложения.');
  const view=new DataView(bytes.buffer,bytes.byteOffset,12);view.setUint32(8,(view.getUint32(8)^index)>>>0);
  return fromByteArray(bytes);
}
/** Position and count are authenticated: chunks cannot be reordered, dropped or cut off. */
export const chunkAd=(fileKeyId:string,index:number,count:number)=>fromByteArray(new TextEncoder().encode(`linea-attachment-v2:${fileKeyId}:${index}:${count}`));
const associatedData=(id:string)=>fromByteArray(new TextEncoder().encode(`linea-attachment-v1:${id}`));
const safeName=(name:string)=>name.replace(/[^a-zA-Zа-яА-ЯёЁ0-9._-]/g,'_').slice(-100)||'file';
export function localFileSize(file:LocalFile) { return file.size || 0; }
export type FileLimits={platina:boolean;maxFileBytes:number;storageBytes:number;usedBytes:number;chunkBytes:number};
export const fileLimits=(api:Api)=>api.request<FileLimits>('/e2ee/limits');
export type LargeUploadState={key:string;nonce:string;fileKeyId:string;sessionId?:string};
function abort(signal?:AbortSignal) { if(signal?.aborted) throw new DOMException('Aborted','AbortError'); }
async function source(file:LocalFile) { const response=await fetch(file.uri);if(!response.ok)throw new Error('Не удалось прочитать файл.');return response.blob(); }
export async function encryptAndUpload(api:Api,file:LocalFile,onProgress?:(sent:number,total:number)=>void):Promise<Attachment> {
  if(!desktopBridge()) throw new Error('Нужна установленная версия для ПК.');
  if(localFileSize(file)>LARGE_FILE) return encryptAndUploadLarge(api,file,{onProgress});
  const prepared=await prepareMediaForUpload(file);
  try {
    const blob=await source(prepared.file),bytes=new Uint8Array(await blob.arrayBuffer());
    const key=fromByteArray(await Crypto.getRandomBytesAsync(32)),nonce=fromByteArray(await Crypto.getRandomBytesAsync(12)),fileKeyId=Crypto.randomUUID();
    const cipher=await getSignalBridge().seal(fromByteArray(bytes),key,nonce,associatedData(fileKeyId));
    const part=multipartFile(toByteArray(cipher),'encrypted.bin','application/octet-stream');
    const result=await api.request<{id:string}>('/e2ee/files',{method:'POST',headers:{'Content-Type':part.contentType},body:part.body as unknown as BodyInit});
    onProgress?.(bytes.length,bytes.length);
    // Small preview inside the encrypted message, as on phones (was missing on PC: grey placeholders).
    const gif=prepared.file.mimeType==='image/gif',preview=prepared.photo||prepared.video||gif?await makeThumbnail(gif?{...prepared,photo:true}:prepared).catch(()=>undefined):undefined;
    return {id:result.id,name:file.name,mimeType:prepared.file.mimeType,size:bytes.length,encryption:{scheme:'aes-256-gcm-siv',key,nonce,fileKeyId},...(prepared.media?{media:prepared.media}:{}),...(preview?{preview}:{})};
  } finally {await prepared.dispose();}
}
export async function encryptAndUploadLarge(api:Api,file:LocalFile,options:{state?:LargeUploadState;onState?:(state:LargeUploadState)=>void;onProgress?:(sent:number,total:number)=>void;signal?:AbortSignal}={}):Promise<Attachment> {
  const blob=await source(file),size=blob.size,count=chunkCount(size),total=chunkedCipherSize(size),full=CHUNK_PLAIN+TAG;
  const limits=await fileLimits(api); if(size<=0||size>limits.maxFileBytes)throw new Error('Размер файла превышает доступный лимит.');
  let state=options.state||{key:fromByteArray(await Crypto.getRandomBytesAsync(32)),nonce:fromByteArray(await Crypto.getRandomBytesAsync(12)),fileKeyId:Crypto.randomUUID()};
  let received=0;
  if(state.sessionId) received=(await api.request<{received:number}>(`/e2ee/uploads/${state.sessionId}`)).received;
  else { const session=await api.request<{id:string}>('/e2ee/uploads',{method:'POST',body:JSON.stringify({size})});state={...state,sessionId:session.id}; }
  options.onState?.(state);
  if(!Number.isSafeInteger(received)||received<0||received>total||(received<total&&received%full!==0))throw new Error('Неверный размер части.');
  for(let i=received===total?count:received/full;i<count;i++) {
    abort(options.signal);
    const bytes=new Uint8Array(await blob.slice(i*CHUNK_PLAIN,Math.min(size,(i+1)*CHUNK_PLAIN)).arrayBuffer());
    const cipher=toByteArray(await getSignalBridge().seal(fromByteArray(bytes),state.key,chunkNonce(state.nonce,i),chunkAd(state.fileKeyId,i,count)));
    await api.request(`/e2ee/uploads/${state.sessionId}?offset=${i*full}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:cipher as unknown as BodyInit,signal:options.signal});
    options.onProgress?.(Math.min(size,(i+1)*CHUNK_PLAIN),size);
  }
  const result=await api.request<{id:string;size:number}>(`/e2ee/uploads/${state.sessionId}/complete`,{method:'POST'});if(result.size!==total)throw new Error('Неверный размер загруженного файла.');
  return {id:result.id,name:file.name,mimeType:file.mimeType,size,encryption:{scheme:'aes-256-gcm-siv-chunked',key:state.key,nonce:state.nonce,fileKeyId:state.fileKeyId,chunkSize:CHUNK_PLAIN}};
}
export async function cancelLargeUpload(api:Api,state?:LargeUploadState) { if(state?.sessionId)await api.request(`/e2ee/uploads/${state.sessionId}`,{method:'DELETE'}); }
export const attachmentFileName=(file:Attachment)=>safeName(file.name);
export async function decryptAttachmentWithProgress(api:Api,file:Attachment,progress:(fraction:number)=>void,target:string,signal?:AbortSignal) {
  const encryption=file.encryption; if(!encryption||!api.token)throw new Error('Нет ключа вложения.');
  await FileSystem.deleteAsync(target,{idempotent:true});
  try {
    if(encryption.scheme==='aes-256-gcm-siv') {
      const response=await fetch(api.fileUrl(file.id),{headers:{Authorization:`Bearer ${api.token}`},signal});if(!response.ok)throw new Error('Не удалось загрузить файл.');
      const cipher=fromByteArray(new Uint8Array(await response.arrayBuffer()));
      const plain=toByteArray(await getSignalBridge().open(cipher,encryption.key,encryption.nonce,associatedData(encryption.fileKeyId)));
      if(plain.length!==file.size)throw new Error('Размер вложения не совпадает.');
      await desktopBridge()!.files('write',[target,plain]); progress(1);return;
    }
    if(encryption.chunkSize!==CHUNK_PLAIN)throw new Error('Неподдерживаемый размер блока.');
    const count=chunkCount(file.size),total=chunkedCipherSize(file.size),full=CHUNK_PLAIN+TAG;
    for(let i=0;i<count;i++) {
      abort(signal);const start=i*full,end=Math.min(total,start+full)-1;
      const response=await fetch(api.fileUrl(file.id),{headers:{Authorization:`Bearer ${api.token}`,Range:`bytes=${start}-${end}`},signal});
      if(response.status!==206&&!(count===1&&response.status===200))throw new Error('Не удалось загрузить часть файла.');
      const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length!==end-start+1)throw new Error('Неверный размер части.');
      const plain=toByteArray(await getSignalBridge().open(fromByteArray(bytes),encryption.key,chunkNonce(encryption.nonce,i),chunkAd(encryption.fileKeyId,i,count)));
      if(plain.length!==Math.min(CHUNK_PLAIN,file.size-i*CHUNK_PLAIN))throw new Error('Размер вложения не совпадает.');
      await desktopBridge()!.files('append',[target,plain]);progress((i+1)/count);
    }
  } catch(e) {await FileSystem.deleteAsync(target,{idempotent:true});throw e;}
}
export async function decryptAttachment(api:Api,file:Attachment,signal?:AbortSignal) {
  const folder=`${FileSystem.cacheDirectory}linea-view-${Crypto.randomUUID()}/`,target=folder+safeName(file.name);
  await FileSystem.makeDirectoryAsync(folder,{intermediates:true});
  await decryptAttachmentWithProgress(api,file,()=>{},target,signal);
  return {uri:target,dispose:async()=>{await FileSystem.deleteAsync(folder,{idempotent:true});}};
}
export async function shareEncryptedAttachment(api:Api,file:Attachment) {const decrypted=await decryptAttachment(api,file);try{await desktopBridge()!.saveFile(decrypted.uri,file.name);}finally{await decrypted.dispose();}}
export async function clearDecryptedAttachmentCache() {if(!desktopBridge())return;const names=await FileSystem.readDirectoryAsync(FileSystem.cacheDirectory);await Promise.all(names.filter((name:string)=>name.startsWith('linea-view-')).map((name:string)=>FileSystem.deleteAsync(FileSystem.cacheDirectory+name,{idempotent:true})));}
