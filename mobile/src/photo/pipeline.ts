import type { AttachmentMedia,LocalFile } from '../types';
import {ensureFileUri} from '../media/localCopy';
import * as FileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import { fromByteArray,toByteArray } from 'base64-js';
import type { NativePhotoResult,PhotoCapabilities,PhotoInfo,PhotoOptions } from '../../modules/linea-photo';
import { getPhotoBridge } from './bridge';
import { isPhotoCandidate,sniffPhotoFormat } from './formats';
import { containsHdrPng,sanitizePng } from './png';
import { sanitizeJpeg } from './jpeg';

export type PreparedPhoto={file:LocalFile;width:number;height:number;downsampled:boolean;media?:AttachmentMedia;dispose:()=>Promise<void>};
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
  const clean=result.format==='jpeg'?sanitizeJpeg(bytes):sanitizePng(bytes);
  if(clean.width!==result.width||clean.height!==result.height)throw new Error('Размер изображения не совпадает с результатом обработки.');
  return clean.bytes;
}

async function writeExport(bytes:Uint8Array,result:NativePhotoResult,hdr:'sdr'|'pq'|'hlg'='sdr'):Promise<PreparedPhoto> {
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

async function renderOnce(input:LocalFile,options:PhotoOptions):Promise<PreparedPhoto> {
  requireLocal(input.uri);
  const local=await ensureFileUri(input);
  try{return await renderLocal(local.file,options);}
  finally{await local.dispose().catch(()=>{});}
}

async function renderLocal(file:LocalFile,options:PhotoOptions):Promise<PreparedPhoto> {
  const hdr=await preserveHdrPng(file,options);if(hdr)return hdr;
  const bridge=getPhotoBridge(),result=await bridge.render(file.uri,options);
  nativeOutputUri(result.uri);
  let exported:PreparedPhoto|undefined;
  try{
    if((result.format||'png')!==(options.format||'png'))throw new Error('Редактор вернул другой формат. Нужна актуальная нативная сборка.');
    exported=await writeExport(await readOutput(result),result);return exported;
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

const noCleanup=async()=>{};

export async function preparePhotoForUpload(input:LocalFile):Promise<PreparedUpload> {
  requireLocal(input.uri);
  const owned=ownedExports.get(input.uri);
  if(owned)return {file:{...owned.file},photo:true,media:{...owned.media},dispose:noCleanup};
  const local=await ensureFileUri(input);
  try{
    const prepared=await prepareLocalPhoto(local.file);
    return {...prepared,dispose:async()=>{try{await prepared.dispose();}finally{await local.dispose().catch(()=>{});}}};
  }catch(error){await local.dispose().catch(()=>{});throw error;}
}

async function prepareLocalPhoto(file:LocalFile):Promise<PreparedUpload> {
  const owned=ownedExports.get(file.uri);
  if(owned)return {file:{...owned.file},photo:true,media:{...owned.media},dispose:noCleanup};
  const header=toByteArray(await FileSystem.readAsStringAsync(file.uri,{encoding:FileSystem.EncodingType.Base64,position:0,length:64}));
  if(!isPhotoCandidate(file)&&!sniffPhotoFormat(header))return {file,photo:false,dispose:noCleanup};
  const prepared=await renderPhoto(file,plainPhotoOptions());
  return {file:prepared.file,photo:true,media:prepared.media,dispose:prepared.dispose};
}

export function clearPhotoCache():Promise<void> {
  return exclusive(async()=>{
    if(!FileSystem.cacheDirectory)return;
    const directory=FileSystem.cacheDirectory,names=await FileSystem.readDirectoryAsync(directory);
    const stale=names.filter(name=>EXPORT_NAME.test(name)&&!ownedExports.has(`${directory}${name}`));
    await Promise.all(stale.map(name=>FileSystem.deleteAsync(`${directory}${name}`,{idempotent:true})));
    await getPhotoBridge().clearCache();
  });
}
