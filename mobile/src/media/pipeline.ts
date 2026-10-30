import type {LocalFile} from '../types';
import * as FileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import {fromByteArray,toByteArray} from 'base64-js';
import {preparePhotoForUpload,type PreparedUpload} from '../photo/pipeline';
import {isPhotoCandidate,sniffPhotoFormat} from '../photo/formats';
import {isVideoCandidate,mediaPreviewKind,sniffVideoFormat} from './formats';
import {getVideoBridge} from './videoBridge';
import {sanitizeMp4} from './mp4';
import {ensureFileUri} from './localCopy';
import {sanitizeGif} from '../photo/gif';
import type {NativeVideoResult} from '../../modules/linea-video';
export type PreparedMedia=PreparedUpload&{video?:boolean};
const MAX_OUTPUT=20*1024*1024;
const EXPORT_NAME=/^linea-video-export-[0-9a-f-]{36}\.mp4$/i;
const NATIVE_OUTPUT=/^linea-native-video-[0-9a-f-]{36}\.mp4$/i;
const NATIVE_SOURCE=/^linea-native-video-source-[0-9a-f-]{36}\.bin$/i;
const ownedExports=new Set<string>(),ownedSources=new Set<string>();
const noCleanup=async()=>{};
let tail:Promise<void>=Promise.resolve();
function exclusive<T>(action:()=>Promise<T>):Promise<T>{const result=tail.then(action);tail=result.then(()=>undefined,()=>undefined);return result;}
function requireLocal(uri:string):void {if(!/^(?:file|content):\/\//.test(uri))throw new Error('Выбери локальный файл на устройстве.');}
function cache():string {if(!FileSystem.cacheDirectory)throw new Error('Кэш видео недоступен.');return FileSystem.cacheDirectory;}

function requireOwnedNativeUri(uri:string,pattern:RegExp):void {
  const base=new URL(cache()),file=new URL(uri),prefix=`${decodeURIComponent(base.pathname)}linea-video/`,path=decodeURIComponent(file.pathname);
  if(file.protocol!=='file:'||file.hostname!==base.hostname||file.search||file.hash||!path.startsWith(prefix)||!pattern.test(path.slice(prefix.length)))throw new Error('Модуль видео вернул недопустимый путь кэша.');
}

function checkedResult(result:NativeVideoResult):void {
  if(result.mimeType!=='video/mp4'||!['sdr','pq','hlg'].includes(result.hdr))throw new Error('Неподдерживаемый формат или HDR результата видео.');
  if(![result.width,result.height].every(value=>Number.isInteger(value)&&value>0&&value<=16384))throw new Error('Некорректный размер видео.');
  if(!Number.isFinite(result.durationMs)||result.durationMs<0||result.durationMs>86400000)throw new Error('Некорректная длительность видео.');
}

async function cleanNativeOutput(result:NativeVideoResult):Promise<Uint8Array> {
  checkedResult(result);const info=await FileSystem.getInfoAsync(result.uri);
  if(!info.exists||info.isDirectory)throw new Error('Не удалось прочитать обработанное видео.');
  if(info.size>MAX_OUTPUT)throw new Error('Обработанное видео больше 20 МиБ.');
  const bytes=toByteArray(await FileSystem.readAsStringAsync(result.uri,{encoding:FileSystem.EncodingType.Base64}));
  if(bytes.length!==info.size||bytes.length!==result.outputBytes)throw new Error('Размер видео изменился во время обработки.');
  const clean=sanitizeMp4(bytes,result.hdr);
  if(clean.width!==result.width||clean.height!==result.height)throw new Error('Размеры видео не совпадают с проверенным результатом.');
  return clean.bytes;
}

async function exportVideo(bytes:Uint8Array,result:NativeVideoResult):Promise<PreparedMedia> {
  const uri=`${cache()}linea-video-export-${Crypto.randomUUID()}.mp4`;
  try{await FileSystem.writeAsStringAsync(uri,fromByteArray(bytes),{encoding:FileSystem.EncodingType.Base64});}
  catch(error){await FileSystem.deleteAsync(uri,{idempotent:true}).catch(()=>{});throw error;}
  ownedExports.add(uri);
  const dispose=async()=>{if(ownedExports.delete(uri))await FileSystem.deleteAsync(uri,{idempotent:true});};
  return {file:{uri,name:'video.mp4',mimeType:'video/mp4',size:bytes.length},photo:false,video:true,media:{width:result.width,height:result.height,durationMs:result.durationMs,hdr:result.hdr},dispose};
}

async function prepareVideo(file:LocalFile):Promise<PreparedMedia> {
  const bridge=getVideoBridge(),result=await bridge.sanitize(file.uri);requireOwnedNativeUri(result.uri,NATIVE_OUTPUT);
  let exported:PreparedMedia|undefined;
  try{exported=await exportVideo(await cleanNativeOutput(result),result);return exported;}
  finally{
    try{await bridge.dispose(result.uri);}
    catch(error){await exported?.dispose().catch(()=>{});throw error;}
  }
}

async function confirmedAudioOnly(file:LocalFile,container:string|null):Promise<boolean> {
  if(mediaPreviewKind(file)!=='audio'||!['mp4','quicktime','3gpp'].includes(container||''))return false;
  try{await getVideoBridge().inspect(file.uri);return false;}
  catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='NO_VIDEO_TRACK')return true;throw error;}
}

export async function prepareMediaForUpload(input:LocalFile):Promise<PreparedMedia>{
  requireLocal(input.uri);
  const local=await ensureFileUri(input);
  try{
    const prepared=await prepareLocalMedia(local.file);
    return {...prepared,dispose:async()=>{try{await prepared.dispose();}finally{await local.dispose().catch(()=>{});}}};
  }catch(error){await local.dispose().catch(()=>{});throw error;}
}

async function prepareLocalMedia(file:LocalFile):Promise<PreparedMedia>{
  const header=toByteArray(await FileSystem.readAsStringAsync(file.uri,{encoding:FileSystem.EncodingType.Base64,position:0,length:768}));
  const image=sniffPhotoFormat(header),video=sniffVideoFormat(header);
  if(image==='gif')return prepareGif(file);
  if(image)return preparePhotoForUpload(file);
  if(await confirmedAudioOnly(file,video))return {file,photo:false,video:false,dispose:noCleanup};
  if(video||isVideoCandidate(file))return exclusive(()=>prepareVideo({...file}));
  if(isPhotoCandidate(file))return preparePhotoForUpload(file);
  return {file,photo:false,video:false,dispose:noCleanup};
}

/** Animated GIFs stay animated: metadata blocks are removed, frames are kept as they are. */
async function prepareGif(file:LocalFile):Promise<PreparedMedia>{
  const info=await FileSystem.getInfoAsync(file.uri);
  if(!info.exists||info.isDirectory)throw new Error('Не удалось прочитать GIF.');
  if(info.size>MAX_OUTPUT)throw new Error('Файл слишком большой. Максимум — 20 МБ.');
  const clean=sanitizeGif(toByteArray(await FileSystem.readAsStringAsync(file.uri,{encoding:FileSystem.EncodingType.Base64})));
  const uri=`${FileSystem.cacheDirectory}linea-gif-${Crypto.randomUUID()}.gif`;
  await FileSystem.writeAsStringAsync(uri,fromByteArray(clean.bytes),{encoding:FileSystem.EncodingType.Base64});
  const name=(file.name.replace(/\.[^.]*$/,'')||'animation').slice(0,200)+'.gif';
  return {file:{uri,name,mimeType:'image/gif',size:clean.bytes.length},photo:false,video:false,media:{width:clean.width,height:clean.height},dispose:()=>FileSystem.deleteAsync(uri,{idempotent:true})};
}

export async function resolveVideoLibraryAsset(id:string):Promise<{fileUri:string;dispose:()=>Promise<void>}>{
  if(!id||id.length>512||id.includes('\0'))throw new Error('Неверный идентификатор видео в галерее.');
  const bridge=getVideoBridge();
  if(typeof bridge.resolveLibraryAsset!=='function')throw new Error('Для оригинала видео нужна новая сборка. Пока выбери исходный файл через «Файлы».');
  const result=await bridge.resolveLibraryAsset(id);requireOwnedNativeUri(result.uri,NATIVE_SOURCE);
  if(result.owned!==true)throw new Error('Не подтверждено владение временным оригиналом видео.');
  ownedSources.add(result.uri);
  return {fileUri:result.uri,dispose:async()=>{if(ownedSources.delete(result.uri))await bridge.dispose(result.uri);}};
}

export function clearVideoCache():Promise<void>{return exclusive(async()=>{
  if(!FileSystem.cacheDirectory)return;
  const directory=FileSystem.cacheDirectory,names=await FileSystem.readDirectoryAsync(directory);
  await Promise.all(names.filter(name=>EXPORT_NAME.test(name)&&!ownedExports.has(`${directory}${name}`)).map(name=>FileSystem.deleteAsync(`${directory}${name}`,{idempotent:true})));
  if(!ownedSources.size)await getVideoBridge().clearCache();
});}
