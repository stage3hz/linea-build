import type { AttachmentMedia,LocalFile } from '../types';
import {ensureFileUri} from '../media/localCopy';
import * as FileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import { fromByteArray,toByteArray } from 'base64-js';
import type { NativePhotoResult,PhotoCapabilities,PhotoInfo,PhotoOptions } from '../../modules/linea-photo';
import { getPhotoBridge } from './bridge';
import { isPhotoCandidate,sniffPhotoFormat } from './formats';
import { containsHdrPng,sanitizePng } from './png';
import { announcesGainmap,sanitizePhotoJpeg } from './jpegHdr';
import { HdrConsentError,isHdrConsentError,requestHdrConsent,sdrAllowed } from './hdrConsent';

export type PreparedPhoto={file:LocalFile;width:number;height:number;downsampled:boolean;media?:AttachmentMedia;dispose:()=>Promise<void>};
/** An on-screen effect preview: never registered for upload, removed by dispose. */
export type PhotoPreview={uri:string;width:number;height:number;dispose:()=>Promise<void>};
type PhotoHdr=NonNullable<AttachmentMedia['hdr']>;
export type PreparedUpload={file:LocalFile;photo:boolean;media?:AttachmentMedia;dispose:()=>Promise<void>};
export const plainPhotoOptions=():PhotoOptions=>({background:'keep',document:'none',scale:1,strokes:[],allowDownsample:false,format:'png',resolution:1});
const MAX_OUTPUT_BYTES=20*1024*1024;
const EXPORT_NAME=/^linea-photo-export-[0-9a-f-]{36}\.(?:png|jpg)$/i;
const NATIVE_NAME=/^linea-native-photo-[0-9a-f-]{36}\.(?:png|jpg)$/i;
const ownedExports=new Map<string,{file:LocalFile;media:AttachmentMedia}>();
let renderTail:Promise<void>=Promise.resolve();

function exclusive<T>(action:()=>Promise<T>):Promise<T> {
  const result=renderTail.then(action);renderTail=result.then(()=>undefined,()=>undefined);return result;
}

function requireLocal(uri:string):void {
  if(!/^(?:file|content):\/\//.test(uri))throw new Error('Выбери локальное фото на устройстве.');
}

function cacheDirectory():string {
  if(!FileSystem.cacheDirectory)throw new Error('Кэш редактора недоступен на этом устройстве.');
  return FileSystem.cacheDirectory;
}

function nativeOutputUri(uri:string):void {
  const cache=new URL(cacheDirectory()),output=new URL(uri);
  const prefix=`${decodeURIComponent(cache.pathname)}linea-photo/`;
  const path=decodeURIComponent(output.pathname);
  if(output.protocol!=='file:'||output.hostname!==cache.hostname||!path.startsWith(prefix)||!NATIVE_NAME.test(path.slice(prefix.length))) {
    throw new Error('Редактор вернул недопустимый путь кэша.');
  }
  if(output.search||output.hash)throw new Error('Недопустимый путь кэша редактора.');
}

function snapshot(options:PhotoOptions):PhotoOptions {
  return {...options,...(options.crop?{crop:{...options.crop}}:{}),strokes:options.strokes.map(stroke=>({...stroke,points:stroke.points.map(point=>({...point}))}))};
}

export async function getPhotoCapabilities():Promise<PhotoCapabilities>{return getPhotoBridge().capabilities();}
export async function inspectPhoto(uri:string):Promise<PhotoInfo>{requireLocal(uri);return getPhotoBridge().inspect(uri);}
export async function preparePhotoBackground():Promise<void>{await getPhotoBridge().prepareBackground();}

async function readOutput(result:NativePhotoResult):Promise<Uint8Array> {
  const info=await FileSystem.getInfoAsync(result.uri);
  if(!info.exists||info.isDirectory)throw new Error('Редактор не создал изображение.');
  if(info.size>MAX_OUTPUT_BYTES)throw new Error('Фото больше 20 МиБ. Выбери уменьшение и повтори обработку.');
  const bytes=toByteArray(await FileSystem.readAsStringAsync(result.uri,{encoding:FileSystem.EncodingType.Base64}));
  let clean;
  try{clean=result.format==='jpeg'?sanitizePhotoJpeg(bytes):sanitizePng(bytes);}
  catch(error){
    // The system wrote a gain map the gate cannot rebuild safely (unknown profile tags, missing markers…): the
    // photo is not stuck, the user is offered an SDR render instead (the original file's uri is filled in above).
    if(result.hdr==='gainmap')throw new HdrConsentError(result.uri);
    throw error;
  }
  if(clean.width!==result.width||clean.height!==result.height)throw new Error('Размер изображения не совпадает с результатом обработки.');
  // The native side wrote a gain map: the gate must have kept it, or HDR would be lost without consent.
  if(result.hdr==='gainmap'&&(!('hdr' in clean)||clean.hdr!=='gainmap'))throw new HdrConsentError(result.uri);
  return clean.bytes;
}

async function writeExport(bytes:Uint8Array,result:NativePhotoResult,hdr:PhotoHdr='sdr'):Promise<PreparedPhoto> {
  const extension=result.format==='jpeg'?'jpg':'png',mimeType=result.format==='jpeg'?'image/jpeg':'image/png';
  const uri=`${cacheDirectory()}linea-photo-export-${Crypto.randomUUID()}.${extension}`;
  try{await FileSystem.writeAsStringAsync(uri,fromByteArray(bytes),{encoding:FileSystem.EncodingType.Base64});}
  catch(error){await FileSystem.deleteAsync(uri,{idempotent:true}).catch(()=>{});throw error;}
  const file:LocalFile={uri,name:`photo.${extension}`,mimeType,size:bytes.length},media:AttachmentMedia={width:result.width,height:result.height,hdr};
  ownedExports.set(uri,{file,media});
  const dispose=async()=>{
    if(!ownedExports.delete(uri))return;
    await FileSystem.deleteAsync(uri,{idempotent:true});
  };
  return {file,width:result.width,height:result.height,downsampled:result.downsampled,media,dispose};
}

async function preserveHdrPng(file:LocalFile,options:PhotoOptions):Promise<PreparedPhoto|null> {
  const header=toByteArray(await FileSystem.readAsStringAsync(file.uri,{encoding:FileSystem.EncodingType.Base64,position:0,length:64}));
  if(sniffPhotoFormat(header)!=='png')return null;
  const info=await FileSystem.getInfoAsync(file.uri);
  if(!info.exists||info.isDirectory||info.size>MAX_OUTPUT_BYTES)return null;
  const bytes=toByteArray(await FileSystem.readAsStringAsync(file.uri,{encoding:FileSystem.EncodingType.Base64}));
  if(!containsHdrPng(bytes))return null;
  const unchanged=options.background==='keep'&&options.document==='none'&&options.scale===1&&options.strokes.length===0&&!options.crop&&(options.resolution??1)===1&&(options.format??'png')==='png';
  if(!unchanged)throw new Error('Для этого HDR PNG доступна отправка с очисткой метаданных без изменения пикселей. Эффекты не должны превращать HDR в SDR.');
  const clean=sanitizePng(bytes);
  return writeExport(clean.bytes,{uri:file.uri,width:clean.width,height:clean.height,downsampled:false,format:'png',mimeType:'image/png'},clean.hdr);
}

const unedited=(options:PhotoOptions)=>options.background==='keep'&&options.document==='none'&&options.scale===1&&options.strokes.length===0&&!options.crop
  &&(options.resolution??1)===1&&!options.rotation&&!options.flip&&!options.drawings?.length&&options.dynamicRange!=='sdr'&&!options.preview;

/** An unedited, upright JPEG with a gain map is sent as its own two compressed images, rebuilt by the gate:
 * exact quality, HDR kept, all personal metadata dropped. Used before the native re-encode on every platform. */
async function preserveHdrJpeg(file:LocalFile,options:PhotoOptions):Promise<PreparedPhoto|null> {
  if(!unedited(options))return null;
  const header=toByteArray(await FileSystem.readAsStringAsync(file.uri,{encoding:FileSystem.EncodingType.Base64,position:0,length:64}));
  if(sniffPhotoFormat(header)!=='jpeg')return null;
  const info=await FileSystem.getInfoAsync(file.uri);
  if(!info.exists||info.isDirectory||info.size>MAX_OUTPUT_BYTES)return null;
  const bytes=toByteArray(await FileSystem.readAsStringAsync(file.uri,{encoding:FileSystem.EncodingType.Base64}));
  if(!announcesGainmap(bytes))return null;
  let clean;
  try{clean=sanitizePhotoJpeg(bytes);}catch{return null;} // Rotated, previews in a trailer, unknown ICC…: native path.
  if(clean.hdr!=='gainmap')return null;
  return writeExport(clean.bytes,{uri:file.uri,width:clean.width,height:clean.height,downsampled:false,format:'jpeg',mimeType:'image/jpeg',hdr:'gainmap'},'gainmap');
}

const nativeConsent=(error:unknown)=>{const code=(error as {code?:unknown}|null)?.code;return code==='ERR_LINEA_PHOTO_HDR_NEEDS_CONSENT'||code==='HDR_NEEDS_CONSENT';};

async function renderOnce(input:LocalFile,options:PhotoOptions):Promise<PreparedPhoto> {
  requireLocal(input.uri);
  const local=await ensureFileUri(input);
  try{return await renderLocal(local.file,options);}
  catch(error){
    // Native refusal to drop HDR becomes the consent question for the original file.
    if(nativeConsent(error)||isHdrConsentError(error))throw requestHdrConsent(input.uri);
    throw error;
  }
  finally{await local.dispose().catch(()=>{});}
}

async function renderLocal(file:LocalFile,options:PhotoOptions):Promise<PreparedPhoto> {
  const hdr=await preserveHdrPng(file,options)??await preserveHdrJpeg(file,options);if(hdr)return hdr;
  const bridge=getPhotoBridge(),result=await bridge.render(file.uri,options);
  nativeOutputUri(result.uri);
  let exported:PreparedPhoto|undefined;
  try{
    if((result.format||'png')!==(options.format||'png'))throw new Error('Редактор вернул другой формат. Нужна актуальная нативная сборка.');
    exported=await writeExport(await readOutput(result),result,result.hdr==='gainmap'?'gainmap':'sdr');return exported;
  }
  finally{
    try{await bridge.dispose(result.uri);}
    catch(error){await exported?.dispose().catch(()=>{});throw error;}
  }
}

export function renderPhoto(file:LocalFile,options:PhotoOptions):Promise<PreparedPhoto> {
  const source={...file},parameters=snapshot(options);
  return exclusive(()=>renderOnce(source,parameters));
}

/** Small SDR render of the expensive effects for the editor screen. The file stays in the native cache, is
 * never cleaned for upload and can never be sent: it is not an owned export. */
export function renderPreview(file:LocalFile,options:PhotoOptions):Promise<PhotoPreview> {
  if(!options.preview)return Promise.reject(new Error('Предпросмотр требует ограничения размера.'));
  const source={...file},parameters={...snapshot(options),dynamicRange:'sdr' as const,preview:{...options.preview}};
  return exclusive(async()=>{
    requireLocal(source.uri);
    const local=await ensureFileUri(source);
    try{
      const bridge=getPhotoBridge(),result=await bridge.render(local.file.uri,parameters);
      nativeOutputUri(result.uri);
      let disposed=false;
      return {uri:result.uri,width:result.width,height:result.height,dispose:async()=>{if(disposed)return;disposed=true;await exclusive(()=>bridge.dispose(result.uri));}};
    }finally{await local.dispose().catch(()=>{});}
  });
}

const noCleanup=async()=>{};
const isRawName=(file:LocalFile)=>/\.(?:dng|nef|nrw|arw|srf|sr2|cr2|srw|3fr|kdc|dcr|pef|erf|mef|mos|iiq|rwl)$/i.test(file.name)||/raw|dng|nikon|sony|canon|pentax/i.test(file.mimeType);

export async function preparePhotoForUpload(input:LocalFile):Promise<PreparedUpload> {
  requireLocal(input.uri);
  const owned=ownedExports.get(input.uri);
  if(owned)return {file:{...owned.file},photo:true,media:{...owned.media},dispose:noCleanup};
  const local=await ensureFileUri(input);
  originals.set(local.file.uri,input.uri);
  try{
    const prepared=await prepareLocalPhoto(local.file);
    return {...prepared,dispose:async()=>{try{await prepared.dispose();}finally{await local.dispose().catch(()=>{});}}};
  }catch(error){
    await local.dispose().catch(()=>{});
    if(isHdrConsentError(error))throw requestHdrConsent(input.uri);
    throw error;
  }finally{if(local.file.uri!==input.uri)originals.delete(local.file.uri);}
}

async function prepareLocalPhoto(file:LocalFile):Promise<PreparedUpload> {
  const owned=ownedExports.get(file.uri);
  if(owned)return {file:{...owned.file},photo:true,media:{...owned.media},dispose:noCleanup};
  const header=toByteArray(await FileSystem.readAsStringAsync(file.uri,{encoding:FileSystem.EncodingType.Base64,position:0,length:64}));
  if(!isPhotoCandidate(file)&&!sniffPhotoFormat(header))return {file,photo:false,dispose:noCleanup};
  // Sending never fails on size: a photo whose clean re-encode is over 20 MiB is scaled down natively
  // (RAW/DNG/HEIC/ProRAW of any size are decoded by the platform and re-encoded without metadata).
  // Big photos without transparency (camera JPEG/HEIC/RAW) become JPEG, so they stay sharp within 20 MiB;
  // formats that may carry an alpha channel stay PNG.
  const format=sniffPhotoFormat(header),info=await FileSystem.getInfoAsync(file.uri);
  const big=info.exists&&!info.isDirectory&&info.size>MAX_OUTPUT_BYTES,opaque=!!format&&!['png','webp','gif','bmp','avif','psd','svg','ico','exr','jpegxl','jpeg2000','tiff'].includes(format);
  // HDR with a gain map is carried by JPEG only; the user's «Отправить без HDR» makes it a plain SDR render.
  const consented=sdrAllowed(source(file));
  const hdr=!consented&&opaque?await inspectPhoto(file.uri).then(value=>value.dynamicRange==='hdr'&&value.hdrKind==='gainmap',()=>false):false;
  const jpeg=hdr||big&&(opaque||format==='tiff'&&isRawName(file));
  const prepared=await renderPhoto(file,{...plainPhotoOptions(),allowDownsample:true,...(jpeg?{format:'jpeg' as const}:{}),...(consented?{dynamicRange:'sdr' as const}:{})});
  return {file:prepared.file,photo:true,media:prepared.media,dispose:prepared.dispose};
}

/** Consent is recorded against the file the user picked (before any local copy). */
const originals=new Map<string,string>();
const source=(file:LocalFile)=>originals.get(file.uri)??file.uri;

export function clearPhotoCache():Promise<void> {
  return exclusive(async()=>{
    if(!FileSystem.cacheDirectory)return;
    const directory=FileSystem.cacheDirectory,names=await FileSystem.readDirectoryAsync(directory);
    const stale=names.filter(name=>EXPORT_NAME.test(name)&&!ownedExports.has(`${directory}${name}`));
    await Promise.all(stale.map(name=>FileSystem.deleteAsync(`${directory}${name}`,{idempotent:true})));
    await getPhotoBridge().clearCache();
  });
}
