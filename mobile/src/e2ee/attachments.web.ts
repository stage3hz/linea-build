import * as Crypto from 'expo-crypto';
import * as FileSystem from '../desktopFs.web';
import { desktopBridge } from '../desktop';
import { fromByteArray, toByteArray } from 'base64-js';
import { multipartFile, type Api } from '../api';
import type { Attachment, LocalFile } from '../types';
import { getSignalBridge } from './signal';
import { prepareMediaForUpload, prepareBigPhoto, type PreparedMedia } from '../media/pipeline.web';
import { makeThumbnail } from '../media/thumbnail.web';
import { wireMedia } from '../media/previewModel';
import { planUpload, planForUpload, readClean, UncleanableMedia, VIDEO_MIME, type ByteSource, type CleanPlan, type UploadRoute } from '../media/stream/index';
const MAX_FILE=20*1024*1024;
/**
 * Above this size a file goes in encrypted chunks (Telegram-like: videos up to 10 GB for everyone, other files up to
 * 2 GB, 4 GB with Platina). Photos and videos are still cleaned of metadata first, whatever their size (see encryptAndUploadLarge).
 */
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
export type FileLimits={platina:boolean;maxFileBytes:number;maxVideoBytes?:number;storageBytes:number;usedBytes:number;chunkBytes:number};
export const fileLimits=(api:Api)=>api.request<FileLimits>('/e2ee/limits');
export type LargeUploadState={key:string;nonce:string;fileKeyId:string;sessionId?:string};
function abort(signal?:AbortSignal) { if(signal?.aborted) throw new DOMException('Aborted','AbortError'); }
async function source(file:LocalFile) { const response=await fetch(file.uri);if(!response.ok)throw new Error('Не удалось прочитать файл.');return response.blob(); }
const isAudioHint=(file:LocalFile)=>/^audio\//i.test(file.mimeType||'')||/\.(?:m4a|m4b|aac|mp3|wav|flac|ogg|oga|opus|caf|amr|alac|aiff?)$/i.test(file.name||'');
async function sniffRoute(file:LocalFile):Promise<UploadRoute> { const blob=await source(file);return planUpload(new Uint8Array(await blob.slice(0,768).arrayBuffer()),file); }
const blobSource=(blob:Blob):ByteSource=>({size:blob.size,read:async(offset,length)=>new Uint8Array(await blob.slice(offset,offset+length).arrayBuffer())});
export async function encryptAndUpload(api:Api,file:LocalFile,onProgress?:(sent:number,total:number)=>void):Promise<Attachment> {
  if(!desktopBridge()) throw new Error('Нужна установленная версия для ПК.');
  // Big files go in chunks; photos and videos among them are cleaned there too (never sent with metadata).
  if(localFileSize(file)>LARGE_FILE) return encryptAndUploadLarge(api,file,{onProgress});
  let prepared:PreparedMedia;
  try{prepared=await prepareMediaForUpload(file);}
  catch(error){
    // MOV/MKV/AVI or an MP4 the strict cleaner does not take (ProRes, AV1, telemetry tracks…): container-level cleaning.
    const route=await sniffRoute(file);
    if(route.kind!=='video'&&route.kind!=='opaque')throw error;
    return encryptAndUploadLarge(api,file,{onProgress});
  }
  // Content the 20 MB pipeline did not treat as media but our sniffing does (MOV after free boxes, RAW, TS…).
  if(!prepared.photo&&!prepared.video&&prepared.file.mimeType!=='image/gif'){
    const route=await sniffRoute(file).catch(()=>null);
    // An «audio» file whose content is a video container: on the desktop nothing has checked it for a video track
    // yet (phones do it natively), so its index decides — audio only goes as is, anything with video is cleaned.
    if(route&&route.kind==='video'&&isAudioHint(file)){
      const blob=await source(file),plan=await planForUpload(route,blobSource(blob),file.mimeType||'');
      if(plan){await prepared.dispose();return encryptAndUploadLarge(api,file,{onProgress});}
    }
    else if(route&&route.kind!=='raw'){await prepared.dispose();return encryptAndUploadLarge(api,file,{onProgress});}
  }
  try {
    return await sealSmall(api,file.name,prepared,onProgress);
  } finally {await prepared.dispose();}
}
async function sealSmall(api:Api,name:string,prepared:PreparedMedia,onProgress?:(sent:number,total:number)=>void):Promise<Attachment>{
  const blob=await source(prepared.file),bytes=new Uint8Array(await blob.arrayBuffer());
  const key=fromByteArray(await Crypto.getRandomBytesAsync(32)),nonce=fromByteArray(await Crypto.getRandomBytesAsync(12)),fileKeyId=Crypto.randomUUID();
  const cipher=await getSignalBridge().seal(fromByteArray(bytes),key,nonce,associatedData(fileKeyId));
  const part=multipartFile(toByteArray(cipher),'encrypted.bin','application/octet-stream');
  const result=await api.request<{id:string}>('/e2ee/files',{method:'POST',headers:{'Content-Type':part.contentType},body:part.body as unknown as BodyInit});
  onProgress?.(bytes.length,bytes.length);
  // Small preview inside the encrypted message, as on phones (was missing on PC: grey placeholders).
  const gif=prepared.file.mimeType==='image/gif',preview=prepared.photo||prepared.video||gif?await makeThumbnail(gif?{...prepared,photo:true}:prepared).catch(()=>undefined):undefined;
  return {id:result.id,name,mimeType:prepared.file.mimeType,size:bytes.length,encryption:{scheme:'aes-256-gcm-siv',key,nonce,fileKeyId},...(prepared.media?{media:wireMedia(prepared.media)}:{}),...(preview?{preview}:{})};
}
const sizeLabel=(bytes:number)=>bytes>=1024**3?`${(bytes/1024**3).toFixed(1).replace('.0','')} ГБ`:`${Math.round(bytes/1024**2)} МБ`;
/** Platina raises only the limit for non-video files (videos go up to the same size for everyone). */
const PLATINA_FILE=4*1024**3;
export function limitError(limits:FileLimits,kind:'video'|'file',size:number):string|null{
  const max=kind==='video'?limits.maxVideoBytes??limits.maxFileBytes:limits.maxFileBytes;
  if(size>0&&size<=max)return null;
  if(kind==='video')return `Видео больше ${sizeLabel(max)}.`;
  return !limits.platina&&PLATINA_FILE>max?`Файл больше ${sizeLabel(max)}. С Platina можно отправлять файлы до ${sizeLabel(PLATINA_FILE)}.`:`Файл больше ${sizeLabel(max)}.`;
}
/**
 * A video the app cannot clean (unknown container) is sent only after the user confirmed it: the confirmation rides
 * on the LocalFile itself (`sendUncleaned`), so a retried or resumed upload keeps it.
 */
export type UncleanedFile=LocalFile&{sendUncleaned?:true};
const sendsUncleaned=(file:LocalFile)=>(file as UncleanedFile).sendUncleaned===true;
/** For the UI, before sending: true when the file needs the «Отправить без очистки?» confirmation. */
export async function needsUncleanedConsent(file:LocalFile):Promise<boolean>{
  if(sendsUncleaned(file))return false;
  try{return (await sniffRoute(file)).kind==='opaque';}catch{return false;}
}
export { UNCLEANABLE_QUESTION } from '../media/stream/index';

export function uploadMeta(file:LocalFile,route:UploadRoute,plan:CleanPlan|null):{kind:'video'|'file';mimeType:string;media?:CleanPlan['media']}{
  const original=(file.mimeType||'application/octet-stream').slice(0,150);
  if(route.kind==='video'&&plan)return {kind:'video',mimeType:/^video\//i.test(original)?original:VIDEO_MIME[route.container],media:plan.media};
  if(route.kind==='gif'&&plan)return {kind:'file',mimeType:'image/gif',media:plan.media};
  // Only after the user confirmed «Отправить без очистки?»: unchanged, and only as a file (never played as media).
  if(route.kind==='opaque')return {kind:'file',mimeType:'application/octet-stream'};
  return {kind:'file',mimeType:original};
}
export async function encryptAndUploadLarge(api:Api,file:LocalFile,options:{state?:LargeUploadState;onState?:(state:LargeUploadState)=>void;onProgress?:(sent:number,total:number)=>void;signal?:AbortSignal}={}):Promise<Attachment> {
  const blob=await source(file),original=blobSource(blob);
  const route=planUpload(new Uint8Array(await blob.slice(0,768).arrayBuffer()),file);
  if(route.kind==='opaque'&&!sendsUncleaned(file))throw new UncleanableMedia();
  if(route.kind==='photo'){
    // Any size: decoded and re-encoded by the browser engine (no metadata), scaled down to ≤ 20 MiB.
    const prepared=await prepareBigPhoto(file,blob);
    try{return await sealSmall(api,file.name,prepared,options.onProgress);}finally{await prepared.dispose();}
  }
  options.onProgress?.(0,blob.size);
  // Deterministic: a resumed upload plans the same file again and gets byte-for-byte the same stream.
  const plan=await planForUpload(route,original,file.mimeType||''),meta=uploadMeta(file,route,plan);
  const stream:ByteSource=plan?{size:plan.size,read:(offset,length)=>readClean(plan,original,offset,length)}:original;
  const size=stream.size,count=chunkCount(size),total=chunkedCipherSize(size),full=CHUNK_PLAIN+TAG;
  const limits=await fileLimits(api),tooBig=limitError(limits,meta.kind,size); if(tooBig)throw new Error(tooBig);
  let state=options.state||{key:fromByteArray(await Crypto.getRandomBytesAsync(32)),nonce:fromByteArray(await Crypto.getRandomBytesAsync(12)),fileKeyId:Crypto.randomUUID()};
  let received=0;
  if(state.sessionId) received=(await api.request<{received:number}>(`/e2ee/uploads/${state.sessionId}`)).received;
  else { const session=await api.request<{id:string}>('/e2ee/uploads',{method:'POST',body:JSON.stringify({size,kind:meta.kind})});state={...state,sessionId:session.id}; }
  options.onState?.(state);
  if(!Number.isSafeInteger(received)||received<0||received>total||(received<total&&received%full!==0))throw new Error('Неверный размер части.');
  for(let i=received===total?count:received/full;i<count;i++) {
    abort(options.signal);
    const bytes=await stream.read(i*CHUNK_PLAIN,Math.min(size,(i+1)*CHUNK_PLAIN)-i*CHUNK_PLAIN);
    const cipher=toByteArray(await getSignalBridge().seal(fromByteArray(bytes),state.key,chunkNonce(state.nonce,i),chunkAd(state.fileKeyId,i,count)));
    await api.request(`/e2ee/uploads/${state.sessionId}?offset=${i*full}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:cipher as unknown as BodyInit,signal:options.signal});
    options.onProgress?.(Math.min(size,(i+1)*CHUNK_PLAIN),size);
  }
  const result=await api.request<{id:string;size:number}>(`/e2ee/uploads/${state.sessionId}/complete`,{method:'POST'});if(result.size!==total)throw new Error('Неверный размер загруженного файла.');
  const preview=meta.kind==='video'&&size<=2*1024**3?await thumbnailOf(blob,plan?.media).catch(()=>undefined):undefined;
  return {id:result.id,name:file.name,mimeType:meta.mimeType,size,encryption:{scheme:'aes-256-gcm-siv-chunked',key:state.key,nonce:state.nonce,fileKeyId:state.fileKeyId,chunkSize:CHUNK_PLAIN},...(meta.media?{media:meta.media}:{}),...(preview?{preview}:{})};
}
/** A frame of the video drawn to a canvas: pixels only, the preview never carries the container metadata. */
async function thumbnailOf(blob:Blob,media?:CleanPlan['media']){
  const uri=URL.createObjectURL(blob);
  try{return await makeThumbnail({file:{uri,name:'video',mimeType:blob.type||'video/mp4'},photo:false,video:true,...(media?{media}:{}),dispose:async()=>{}});}
  finally{URL.revokeObjectURL(uri);}
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
