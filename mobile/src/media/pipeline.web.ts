import type { LocalFile } from '../types';
import type { PreparedUpload } from '../photo/pipeline';
import { sanitizeJpeg } from '../photo/jpeg';
import { sanitizePng } from '../photo/png';
import { sanitizeGif } from '../photo/gif';
import { sanitizeMp4 } from './mp4';
import { sniffPhotoFormat } from '../photo/formats';
import { sniffVideoFormat } from './formats';
export type PreparedMedia = PreparedUpload & { video?: boolean };
const MAX_PIXELS = 16_000_000;
/**
 * WebP/AVIF/BMP, photos above 16 MP and damaged JPEGs the strict sanitizer rejects: decoded by the
 * browser and re-encoded (which also drops all metadata). Big pictures are scaled down like in
 * Telegram; transparency is kept as PNG.
 */
async function transcode(bytes: Uint8Array, alpha: boolean): Promise<{ bytes: Uint8Array; mime: string }> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { imageOrientation: 'from-image' } as ImageBitmapOptions); }
  catch { throw new Error('Это фото повреждено или в формате, который не открывается на ПК. Пересохрани его как JPEG или PNG и отправь снова.'); }
  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height)), 8192 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d'); if (!ctx) { bitmap.close(); throw new Error('Не удалось обработать фото.'); }
  if (!alpha) { ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.imageSmoothingQuality = 'high'; ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  const mime = alpha ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Не удалось обработать фото.')), mime, 0.9));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime };
}
export async function prepareMediaForUpload(file: LocalFile): Promise<PreparedMedia> {
  const response=await fetch(file.uri); if(!response.ok) throw new Error('Не удалось прочитать файл.');
  let bytes:Uint8Array=new Uint8Array(await response.arrayBuffer());
  if(bytes.length>20*1024*1024) throw new Error('Отправь большой файл как файл.');
  const image=sniffPhotoFormat(bytes), video=sniffVideoFormat(bytes);
  if(file.mimeType==='audio/mp4' && video!=='mp4')throw new Error('Выбери аудиофайл: MP3, M4A, WAV, FLAC или другой поддерживаемый формат.');
  let mime=file.mimeType, photo=false, movie=false;
  if(image==='jpeg') {try{bytes=sanitizeJpeg(bytes).bytes;}catch{bytes=(await transcode(bytes,false)).bytes;}mime='image/jpeg';photo=true;}
  else if(image==='png') {try{bytes=sanitizePng(bytes).bytes;mime='image/png';}catch{const out=await transcode(bytes,true);bytes=out.bytes;mime=out.mime;}photo=true;}
  else if(image==='gif') {bytes=sanitizeGif(bytes).bytes;mime='image/gif';}
  else if(image) {const out=await transcode(bytes,image==='webp'||image==='bmp'||image==='tiff'||image==='avif');bytes=out.bytes;mime=out.mime;photo=true;}
  else if(video==='mp4' && !file.mimeType.startsWith('audio/')) {bytes=sanitizeMp4(bytes).bytes;mime='video/mp4';movie=true;}
  else if(video && !file.mimeType.startsWith('audio/')) throw new Error('На ПК отправляй видео в формате MP4.');
  const uri=URL.createObjectURL(new Blob([bytes as BlobPart],{type:mime}));
  // Videos: size and length for the bubble (the «0:12» badge and the right aspect before download).
  const media=movie?await probeVideo(uri):undefined;
  return {file:{...file,uri,mimeType:mime,size:bytes.length},photo,video:movie,...(media?{media}:{}),dispose:async()=>URL.revokeObjectURL(uri)};
}
export async function resolveVideoLibraryAsset(_id:string):Promise<{fileUri:string;dispose:()=>Promise<void>}>{throw new Error('Выбери видео через диалог файлов.');}
export async function clearVideoCache(){}

async function probeVideo(uri:string):Promise<{width:number;height:number;durationMs:number}|undefined>{
  try{
    const v=document.createElement('video');v.preload='metadata';v.muted=true;v.src=uri;
    await new Promise<void>((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('timeout')),5000);v.onloadedmetadata=()=>{clearTimeout(t);resolve();};v.onerror=()=>{clearTimeout(t);reject(new Error('video'));};});
    const out={width:v.videoWidth,height:v.videoHeight,durationMs:Math.round((v.duration||0)*1000)};v.removeAttribute('src');v.load();
    return out.width>0&&out.height>0&&Number.isFinite(out.durationMs)&&out.durationMs<=86400000?out:undefined;
  }catch{return undefined;}
}
