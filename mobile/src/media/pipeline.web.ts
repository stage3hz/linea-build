import type { LocalFile } from '../types';
import type { PreparedUpload } from '../photo/pipeline';
import { sanitizeJpeg } from '../photo/jpeg';
import { sanitizePng } from '../photo/png';
import { sanitizeGif } from '../photo/gif';
import { sanitizeMp4 } from './mp4';
import { sniffPhotoFormat } from '../photo/formats';
import { sniffVideoFormat } from './formats';
export type PreparedMedia = PreparedUpload & { video?: boolean };
export async function prepareMediaForUpload(file: LocalFile): Promise<PreparedMedia> {
  const response=await fetch(file.uri); if(!response.ok) throw new Error('Не удалось прочитать файл.');
  let bytes:Uint8Array=new Uint8Array(await response.arrayBuffer());
  if(bytes.length>20*1024*1024) throw new Error('Отправь большой файл как файл.');
  const image=sniffPhotoFormat(bytes), video=sniffVideoFormat(bytes);
  let mime=file.mimeType, photo=false, movie=false;
  if(image==='jpeg') {bytes=sanitizeJpeg(bytes).bytes;mime='image/jpeg';photo=true;}
  else if(image==='png') {bytes=sanitizePng(bytes).bytes;mime='image/png';photo=true;}
  else if(image==='gif') {bytes=sanitizeGif(bytes).bytes;mime='image/gif';}
  else if(image) throw new Error('Этот формат фото нужно сначала преобразовать в JPEG или PNG.');
  else if(video==='mp4') {bytes=sanitizeMp4(bytes).bytes;mime='video/mp4';movie=true;}
  else if(video && !file.mimeType.startsWith('audio/')) throw new Error('На ПК отправляй видео в формате MP4.');
  const uri=URL.createObjectURL(new Blob([bytes as BlobPart],{type:mime}));
  return {file:{...file,uri,mimeType:mime,size:bytes.length},photo,video:movie,dispose:async()=>URL.revokeObjectURL(uri)};
}
export async function resolveVideoLibraryAsset(_id:string):Promise<{fileUri:string;dispose:()=>Promise<void>}>{throw new Error('Выбери видео через диалог файлов.');}
export async function clearVideoCache(){}
