import { Platform } from 'react-native';
import { attestHeaders } from '../attest/index';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { fromByteArray, toByteArray } from 'base64-js';
import { CLIENT_HEADER, multipartFile, type Api } from '../api';
import type { Attachment, LocalFile } from '../types';
import { getSignalBridge } from './signal';
import { prepareMediaForUpload, type PreparedMedia } from '../media/pipeline';
import { sanitizePng } from '../photo/png';
import { sanitizePhotoJpeg } from '../photo/jpegHdr';
import { wireMedia } from '../media/previewModel';
import { sanitizeMp4 } from '../media/mp4';
import { makeThumbnail } from '../media/thumbnail';
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
/** Size of a local file without reading it (content:// included); 0 when unknown. */
export function localFileSize(file:LocalFile):number{
  if(file.size&&file.size>0)return file.size;
  try{const size=new File(file.uri).size;return typeof size==='number'&&size>0?size:0;}catch{return 0;}
}

export async function encryptAndUpload(api:Api,file:LocalFile,onProgress?:(sent:number,total:number)=>void):Promise<Attachment> {
  if(Platform.OS==='web')throw new Error('Зашифрованные вложения доступны в приложении Android/iPhone.');
  // Big files go in chunks; photos and videos among them are cleaned there too (never sent with metadata).
  const size=localFileSize(file);
  if(size>LARGE_FILE)return encryptAndUploadLarge(api,{...file,size},{onProgress});
  const bridge=getSignalBridge();
  let prepared:PreparedMedia;
  try{prepared=await prepareMediaForUpload(file);}
  catch(error){
    // The native remux handles H.264/HEVC + AAC only (and caps the cleaned output). Any other video (ProRes, AV1,
    // VP9, several video tracks, Matroska, AVI…) is cleaned at the container level by the streamed cleaner instead.
    const route=await sniffRoute(file).catch(()=>null);
    if(route?.kind!=='video'&&route?.kind!=='opaque')throw error;
    return encryptAndUploadLarge(api,file,{onProgress});
  }
  // The 20 MB pipeline recognises media by the classic signatures and names only. Content our streamed sniffing
  // still sees as photo/video (a MOV with leading free boxes, a camera RAW, MPEG-TS…) must not go out unchanged.
  if(!prepared.photo&&!prepared.video&&prepared.file.mimeType!=='image/gif'){
    const route=await sniffRoute(file).catch(()=>null);
    if(route&&route.kind!=='raw'&&!(route.kind==='video'&&isAudioHint(file))){await prepared.dispose().catch(()=>{});return encryptAndUploadLarge(api,file,{onProgress});}
  }
  try{return await encryptPrepared(api,prepared,bridge);}
  finally{await prepared.dispose().catch(()=>{});}
}
const isAudioHint=(file:LocalFile)=>/^audio\//i.test(file.mimeType||'')||/\.(?:m4a|m4b|aac|mp3|wav|flac|ogg|oga|opus|caf|amr|alac|aiff?)$/i.test(file.name||'');

type OpenSource=ByteSource&{close:()=>void};
function openSource(file:LocalFile):OpenSource{
  const source=new File(file.uri);
  const size=typeof source.size==='number'&&source.size>0?source.size:file.size||0;
  if(!Number.isSafeInteger(size)||size<=0)throw new Error('Не удалось определить размер файла.');
  const handle=source.open();
  return {size,read:async(offset,length)=>{handle.offset=offset;return handle.readBytes(length);},close:()=>handle.close()};
}
async function sniffRoute(file:LocalFile):Promise<UploadRoute>{
  const source=openSource(file);
  try{return planUpload(await source.read(0,Math.min(768,source.size)),file);}finally{source.close();}
}

async function uploadBytes(prepared:PreparedMedia):Promise<Uint8Array> {
  const file=prepared.file;
  const info=await FileSystem.getInfoAsync(file.uri);
  if(!info.exists||info.isDirectory)throw new Error('Не удалось прочитать файл.');
  if(info.size>MAX_FILE)throw new Error('Файл слишком большой. Максимум — 20 МБ.');
  const bytes=toByteArray(await FileSystem.readAsStringAsync(file.uri,{encoding:FileSystem.EncodingType.Base64}));
  if(bytes.length>MAX_FILE)throw new Error('Файл слишком большой. Максимум — 20 МБ.');
  if(prepared.video)return sanitizeMp4(bytes,prepared.media?.hdr==='gainmap'?undefined:prepared.media?.hdr).bytes;
  if(!prepared.photo)return bytes;
  // Gain-map JPEG is rebuilt by the HDR gate (two compressed images + regenerated numbers), others by the SDR gate.
  if(file.mimeType==='image/jpeg')return sanitizePhotoJpeg(bytes).bytes;
  if(file.mimeType==='image/png')return sanitizePng(bytes).bytes;
  throw new Error('Обработка фото вернула неподдерживаемый формат.');
}

async function encryptPrepared(api:Api,prepared:PreparedMedia,bridge:ReturnType<typeof getSignalBridge>):Promise<Attachment> {
  const bytes=await uploadBytes(prepared),file=prepared.file;
  const preview=prepared.photo||prepared.video?await makeThumbnail(prepared).catch(()=>undefined):undefined;
  const fileKeyId=Crypto.randomUUID();const key=fromByteArray(await Crypto.getRandomBytesAsync(32));const nonce=fromByteArray(await Crypto.getRandomBytesAsync(12));
  const ciphertext=await bridge.seal(fromByteArray(bytes),key,nonce,associatedData(fileKeyId));
  const part=multipartFile(toByteArray(ciphertext),'encrypted.bin','application/octet-stream');
  const result=await api.request<{id:string;size:number}>('/e2ee/files',{method:'POST',body:part.body as unknown as BodyInit,headers:{'Content-Type':part.contentType}});
  return {id:result.id,name:file.name.slice(0,240)||'file',mimeType:file.mimeType.slice(0,150)||'application/octet-stream',size:bytes.length,encryption:{scheme:'aes-256-gcm-siv',key,nonce,fileKeyId},...(prepared.media?{media:wireMedia(prepared.media)}:{}),...(preview?{preview}:{})};
}

export type FileLimits={platina:boolean;maxFileBytes:number;maxVideoBytes?:number;storageBytes:number;usedBytes:number;chunkBytes:number};
export const fileLimits=(api:Api)=>api.request<FileLimits>('/e2ee/limits');

/** What a big upload needs to continue after a lost connection: the same key and the server's upload id. */
export type LargeUploadState={key:string;nonce:string;fileKeyId:string;sessionId?:string};
export const sizeLabel=(bytes:number)=>bytes>=1024**3?`${(bytes/1024**3).toFixed(1).replace('.0','')} ГБ`:`${Math.round(bytes/1024**2)} МБ`;
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

/**
 * Encrypts and uploads a big file chunk by chunk: only one 4 MiB chunk is in memory at a time,
 * and an interrupted upload resumes from the last chunk the server confirmed.
 */
export async function encryptAndUploadLarge(api:Api,file:LocalFile,options:{state?:LargeUploadState;onState?:(state:LargeUploadState)=>void;onProgress?:(sent:number,total:number)=>void;signal?:AbortSignal}={}):Promise<Attachment>{
  if(Platform.OS==='web')throw new Error('Зашифрованные вложения доступны в приложении Android/iPhone.');
  const bridge=getSignalBridge();
  if(!api.token)throw new Error('Нужно войти в аккаунт.');
  const opened=openSource(file);
  let route:UploadRoute,plan:CleanPlan|null=null;
  try{
    route=planUpload(await opened.read(0,Math.min(768,opened.size)),file);
    if(route.kind==='opaque'&&!sendsUncleaned(file))throw new UncleanableMedia();
    if(route.kind==='photo'){opened.close();return await uploadBigPhoto(api,file,options.onProgress);}
    options.onProgress?.(0,opened.size);
    // Deterministic: a resumed upload plans the same file again and gets byte-for-byte the same stream.
    plan=await planForUpload(route,opened,file.mimeType||'');
  }catch(error){opened.close();throw error;}
  const meta=uploadMeta(file,route,plan);
  const source:OpenSource=plan?{size:plan.size,read:(offset,length)=>readClean(plan!,opened,offset,length),close:opened.close}:opened;
  try{
    const attachment=await uploadChunks(api,bridge,file,source,meta.kind,options);
    const preview=meta.kind==='video'?await makeThumbnail({file:{...file},photo:false,video:true,...(plan?.media?{media:plan.media}:{}),dispose:async()=>{}}).catch(()=>undefined):undefined;
    return {...attachment,mimeType:meta.mimeType,...(meta.media?{media:meta.media}:{}),...(preview?{preview}:{})};
  }finally{source.close();}
}

/** Video limit for a cleaned video, file limit for everything else (including video we could not clean). */
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

/** Platina raises only the limit for non-video files (videos go up to the same size for everyone). */
const PLATINA_FILE=4*1024**3;
export function limitError(limits:FileLimits,kind:'video'|'file',size:number):string|null{
  const max=kind==='video'?limits.maxVideoBytes??limits.maxFileBytes:limits.maxFileBytes;
  if(size>0&&size<=max)return null;
  if(kind==='video')return `Видео больше ${sizeLabel(max)}.`;
  return !limits.platina&&PLATINA_FILE>max?`Файл больше ${sizeLabel(max)}. С Platina можно отправлять файлы до ${sizeLabel(PLATINA_FILE)}.`:`Файл больше ${sizeLabel(max)}.`;
}

/** A photo of any size is re-encoded by the platform (≤ 20 MiB, no metadata) and sent as a normal photo. */
async function uploadBigPhoto(api:Api,file:LocalFile,onProgress?:(sent:number,total:number)=>void):Promise<Attachment>{
  const prepared=await prepareMediaForUpload(file);
  try{
    if(!prepared.photo)throw new Error('Не удалось обработать фото. Файл не отправлен.');
    const attachment=await encryptPrepared(api,prepared,getSignalBridge());
    onProgress?.(attachment.size,attachment.size);
    return attachment;
  }finally{await prepared.dispose().catch(()=>{});}
}

async function uploadChunks(api:Api,bridge:ReturnType<typeof getSignalBridge>,file:LocalFile,source:ByteSource,kind:'video'|'file',options:{state?:LargeUploadState;onState?:(state:LargeUploadState)=>void;onProgress?:(sent:number,total:number)=>void;signal?:AbortSignal},restarted=false):Promise<Attachment>{
  const size=source.size;
  if(!Number.isSafeInteger(size)||size<=0)throw new Error('Не удалось определить размер файла.');
  const limits=await fileLimits(api).catch(()=>null);
  const tooBig=limits&&limitError(limits,kind,size);
  if(tooBig)throw new Error(tooBig);
  // Fresh key material whenever the upload starts from byte 0: the file may have changed since an earlier
  // attempt, and different plaintext must never be sealed under the same key and nonce.
  const freshKeys=async():Promise<LargeUploadState>=>({key:fromByteArray(await Crypto.getRandomBytesAsync(32)),nonce:fromByteArray(await Crypto.getRandomBytesAsync(12)),fileKeyId:Crypto.randomUUID()});
  let state:LargeUploadState=options.state||await freshKeys();
  options.onState?.(state);
  const count=chunkCount(size),full=CHUNK_PLAIN+TAG,total=chunkedCipherSize(size);
  let received=0;
  if(state.sessionId){
    try{received=(await api.request<{received:number}>(`/e2ee/uploads/${state.sessionId}`)).received;}
    catch{state=await freshKeys();options.onState?.(state);}
  }
  if(!state.sessionId){
    const started=await api.request<{id:string}>('/e2ee/uploads',{method:'POST',body:JSON.stringify({size,kind})});
    state={...state,sessionId:started.id};options.onState?.(state);received=0;
  }
  const sessionId=state.sessionId!;
  const temp=`${FileSystem.cacheDirectory}linea-up-${Crypto.randomUUID()}.bin`;
  try{
    for(let index=Math.floor(received/full);index<count;index++){
      checkAbort(options.signal);
      const offset=index*CHUNK_PLAIN,length=Math.min(CHUNK_PLAIN,size-offset);
      const plain=await source.read(offset,length);
      if(plain.length!==length)throw new Error('Файл изменился во время отправки.');
      const cipher=await bridge.seal(fromByteArray(plain),state.key,chunkNonce(state.nonce,index),chunkAd(state.fileKeyId,index,count));
      await FileSystem.writeAsStringAsync(temp,cipher,{encoding:FileSystem.EncodingType.Base64});
      const at=index*full,next=Math.min(total,at+full);
      for(let attempt=0,busyFor=0;;attempt++){
        checkAbort(options.signal);
        const chunkPath=`/e2ee/uploads/${sessionId}?offset=${at}`;
        const result=await FileSystem.uploadAsync(`${api.endpoint}${chunkPath}`,temp,{httpMethod:'PUT',uploadType:FileSystem.FileSystemUploadType.BINARY_CONTENT,headers:{Authorization:`Bearer ${api.token}`,'Content-Type':'application/octet-stream','X-Linea-Client':CLIENT_HEADER,...attestHeaders('PUT',chunkPath)}}).catch(()=>null);
        if(result?.status===200)break;
        const body=(()=>{try{return JSON.parse(result?.body||'{}');}catch{return {};}})() as {received?:number;error?:string;code?:string};
        // The chunk got through but the reply was lost: the server already has it.
        if(result?.status===409&&body.received===next)break;
        // An earlier request of this upload still runs on the server: wait without spending the retries (≈ 90 s at most).
        if(result?.status===409&&body.code==='UPLOAD_BUSY'&&busyFor<90_000){await wait(5000);busyFor+=5000;attempt--;continue;}
        // The server lost the part file (e.g. after a failover): drop the session and start over once, with a new key.
        if(result?.status===409&&body.code==='UPLOAD_LOST'&&!restarted){
          await api.request(`/e2ee/uploads/${sessionId}`,{method:'DELETE'}).catch(()=>{});
          return await uploadChunks(api,bridge,file,source,kind,{...options,state:undefined},true);
        }
        if(result&&[401,403,404,413,507].includes(result.status))throw new Error(body.error||'Сервер отклонил файл.');
        if(attempt>=5)throw new Error('Связь прервалась. Нажми «повторить» — отправка продолжится с того же места.');
        await wait(800*2**attempt);
      }
      options.onProgress?.(Math.min(size,offset+length),size);
    }
    checkAbort(options.signal);
    const done=await api.request<{id:string;size:number}>(`/e2ee/uploads/${sessionId}/complete`,{method:'POST'});
    if(done.size!==total)throw new Error('Размер загруженного файла не совпадает.');
    return {id:done.id,name:file.name.slice(0,240)||'file',mimeType:(file.mimeType||'application/octet-stream').slice(0,150),size,encryption:{scheme:'aes-256-gcm-siv-chunked',key:state.key,nonce:state.nonce,fileKeyId:state.fileKeyId,chunkSize:CHUNK_PLAIN}};
  }finally{
    await FileSystem.deleteAsync(temp,{idempotent:true}).catch(()=>{});
  }
}

/** Drops an unfinished big upload on the server (cancel). */
export async function cancelLargeUpload(api:Api,state?:LargeUploadState):Promise<void>{
  if(state?.sessionId)await api.request(`/e2ee/uploads/${state.sessionId}`,{method:'DELETE'}).catch(()=>{});
}

/** Downloads a chunked file by byte ranges and decrypts it chunk by chunk straight into `target`. */
async function downloadChunked(api:Api,attachment:Attachment,target:string,onProgress:(fraction:number)=>void,signal?:AbortSignal):Promise<void>{
  const encryption=attachment.encryption;
  if(!encryption||encryption.scheme!=='aes-256-gcm-siv-chunked'||encryption.chunkSize!==CHUNK_PLAIN)throw new Error('У вложения нет ключа сквозного шифрования.');
  if(!api.token)throw new Error('Нужно войти в аккаунт.');
  if(!api.fileUrl(attachment.id).startsWith('https://'))throw new Error('Файлы загружаются только по защищённому соединению.');
  const bridge=getSignalBridge();
  const size=attachment.size,count=chunkCount(size),full=CHUNK_PLAIN+TAG,total=chunkedCipherSize(size);
  const temp=`${FileSystem.cacheDirectory}linea-view-dl-${Crypto.randomUUID()}.bin`;
  const out=new File(target);
  if(out.exists)out.delete();
  out.create();
  const handle=out.open();
  let ok=false;
  try{
    for(let index=0;index<count;index++){
      checkAbort(signal);
      const start=index*full,end=Math.min(total,start+full)-1;
      for(let attempt=0;;attempt++){
        checkAbort(signal);
        const result=await FileSystem.downloadAsync(api.fileUrl(attachment.id),temp,{headers:{Authorization:`Bearer ${api.token}`,Range:`bytes=${start}-${end}`},cache:false}).catch(()=>null);
        const info=result?await FileSystem.getInfoAsync(temp):null;
        if(result&&(result.status===206||(result.status===200&&count===1))&&info?.exists&&!info.isDirectory&&info.size===end-start+1)break;
        if(result&&[401,403,404].includes(result.status))throw new Error('Файл недоступен.');
        if(attempt>=5)throw new Error('Не удалось загрузить файл. Проверь интернет и попробуй ещё раз.');
        await wait(800*2**attempt);
      }
      const cipher=await FileSystem.readAsStringAsync(temp,{encoding:FileSystem.EncodingType.Base64});
      let plain:string;
      try{plain=await bridge.open(cipher,encryption.key,chunkNonce(encryption.nonce,index),chunkAd(encryption.fileKeyId,index,count));}
      catch{throw new Error('Проверка вложения не пройдена. Файл не будет открыт.');}
      const bytes=toByteArray(plain);
      if(bytes.length!==Math.min(CHUNK_PLAIN,size-index*CHUNK_PLAIN))throw new Error('Размер вложения не совпадает с сообщением.');
      handle.writeBytes(bytes);
      onProgress((index+1)/count);
    }
    ok=true;
  }finally{
    handle.close();
    await FileSystem.deleteAsync(temp,{idempotent:true}).catch(()=>{});
    if(!ok)await FileSystem.deleteAsync(target,{idempotent:true}).catch(()=>{});
  }
}

function checkAbort(signal?:AbortSignal):void {if(signal?.aborted){const error=new Error('Загрузка отменена.');error.name='AbortError';throw error;}}

export async function decryptAttachment(api:Api,attachment:Attachment,signal?:AbortSignal):Promise<{uri:string;dispose:()=>Promise<void>}> {
  checkAbort(signal);
  if(attachment.encryption?.scheme==='aes-256-gcm-siv-chunked'){
    const folder=`${FileSystem.cacheDirectory}linea-view-${Crypto.randomUUID()}/`;const path=`${folder}${safeName(attachment.name)}`;
    try{await FileSystem.makeDirectoryAsync(folder,{intermediates:true});await downloadChunked(api,attachment,path,()=>{},signal);}
    catch(error){await FileSystem.deleteAsync(folder,{idempotent:true}).catch(()=>{});throw error;}
    return {uri:path,dispose:()=>FileSystem.deleteAsync(folder,{idempotent:true})};
  }
  const bridge=getSignalBridge();const encryption=attachment.encryption;
  if(!encryption||encryption.scheme!=='aes-256-gcm-siv')throw new Error('У вложения нет ключа сквозного шифрования.');
  if(!api.token)throw new Error('Нужно войти в аккаунт.');
  if(attachment.size>MAX_FILE)throw new Error('Файл превышает допустимый размер.');
  const response=await fetch(api.fileUrl(attachment.id),{headers:{Authorization:`Bearer ${api.token}`},credentials:'omit',cache:'no-store',redirect:'error',signal});
  if(!response.ok)throw new Error('Не удалось загрузить зашифрованный файл.');
  const claimedSize=Number(response.headers.get('content-length'));
  if(Number.isFinite(claimedSize)&&claimedSize>MAX_FILE+16)throw new Error('Размер зашифрованного файла превышает ограничение.');
  const bytes=new Uint8Array(await response.arrayBuffer());
  checkAbort(signal);
  if(bytes.length>MAX_FILE+16||bytes.length!==attachment.size+16)throw new Error('Размер вложения не совпадает с сообщением.');
  let plain:string;
  try{plain=await bridge.open(fromByteArray(bytes),encryption.key,encryption.nonce,associatedData(encryption.fileKeyId));}
  catch{throw new Error('Проверка вложения не пройдена. Файл не будет открыт.');}
  checkAbort(signal);
  // A folder per file keeps the original name visible in the share sheet and Quick Look.
  const folder=`${FileSystem.cacheDirectory}linea-view-${Crypto.randomUUID()}/`;const path=`${folder}${safeName(attachment.name)}`;
  try{await FileSystem.makeDirectoryAsync(folder,{intermediates:true});await FileSystem.writeAsStringAsync(path,plain,{encoding:FileSystem.EncodingType.Base64});checkAbort(signal);}
  catch(error){await FileSystem.deleteAsync(folder,{idempotent:true}).catch(()=>{});throw error;}
  return {uri:path,dispose:()=>FileSystem.deleteAsync(folder,{idempotent:true})};
}

/**
 * Same checks as decryptAttachment, but the ciphertext is streamed to disk with
 * progress (as Telegram shows a ring while a photo or file loads). The ciphertext
 * file is deleted right after authenticated decryption.
 */
export async function decryptAttachmentWithProgress(api:Api,attachment:Attachment,onProgress:(fraction:number)=>void,target:string,signal?:AbortSignal):Promise<void> {
  checkAbort(signal);
  if(attachment.encryption?.scheme==='aes-256-gcm-siv-chunked')return downloadChunked(api,attachment,target,onProgress,signal);
  const bridge=getSignalBridge();const encryption=attachment.encryption;
  if(!encryption||encryption.scheme!=='aes-256-gcm-siv')throw new Error('У вложения нет ключа сквозного шифрования.');
  if(!api.token)throw new Error('Нужно войти в аккаунт.');
  if(attachment.size>MAX_FILE)throw new Error('Файл превышает допустимый размер.');
  if(!api.fileUrl(attachment.id).startsWith('https://'))throw new Error('Файлы загружаются только по защищённому соединению.');
  const temp=`${FileSystem.cacheDirectory}linea-view-dl-${Crypto.randomUUID()}.bin`;
  const expected=attachment.size+16;
  const task=FileSystem.createDownloadResumable(api.fileUrl(attachment.id),temp,{headers:{Authorization:`Bearer ${api.token}`},cache:false},data=>{
    const total=data.totalBytesExpectedToWrite>0?data.totalBytesExpectedToWrite:expected;
    onProgress(Math.max(0,Math.min(1,data.totalBytesWritten/total)));
  });
  const onAbort=()=>{void task.cancelAsync().catch(()=>{});};
  signal?.addEventListener('abort',onAbort);
  try{
    const result=await task.downloadAsync();
    checkAbort(signal);
    if(!result||result.status!==200)throw new Error('Не удалось загрузить зашифрованный файл.');
    const info=await FileSystem.getInfoAsync(temp);
    if(!info.exists||info.isDirectory||info.size!==expected)throw new Error('Размер вложения не совпадает с сообщением.');
    const cipher=await FileSystem.readAsStringAsync(temp,{encoding:FileSystem.EncodingType.Base64});
    checkAbort(signal);
    let plain:string;
    try{plain=await bridge.open(cipher,encryption.key,encryption.nonce,associatedData(encryption.fileKeyId));}
    catch{throw new Error('Проверка вложения не пройдена. Файл не будет открыт.');}
    checkAbort(signal);
    try{await FileSystem.writeAsStringAsync(target,plain,{encoding:FileSystem.EncodingType.Base64});checkAbort(signal);}
    catch(error){await FileSystem.deleteAsync(target,{idempotent:true}).catch(()=>{});throw error;}
    onProgress(1);
  }finally{
    signal?.removeEventListener('abort',onAbort);
    await FileSystem.deleteAsync(temp,{idempotent:true}).catch(()=>{});
  }
}

export const attachmentFileName=(attachment:Attachment)=>safeName(attachment.name);

export async function shareEncryptedAttachment(api:Api,attachment:Attachment):Promise<void> {
  if(!(await Sharing.isAvailableAsync()))throw new Error('На устройстве недоступно сохранение через меню отправки.');
  const decrypted=await decryptAttachment(api,attachment);
  try {await Sharing.shareAsync(decrypted.uri,{mimeType:attachment.mimeType,dialogTitle:attachment.name});}
  finally {await decrypted.dispose().catch(()=>{});}
}

export async function clearDecryptedAttachmentCache():Promise<void> {
  if(Platform.OS==='web'||!FileSystem.cacheDirectory)return;
  const files=await FileSystem.readDirectoryAsync(FileSystem.cacheDirectory);
  await Promise.all(files.filter(name=>name.startsWith('linea-view-')).map(name=>FileSystem.deleteAsync(`${FileSystem.cacheDirectory}${name}`,{idempotent:true})));
}
