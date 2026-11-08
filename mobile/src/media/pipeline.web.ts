import type { LocalFile } from '../types';
import type { PreparedUpload } from '../photo/pipeline';
import { sanitizeJpeg } from '../photo/jpeg';
import { announcesGainmap, sanitizeGainmapJpeg } from '../photo/jpegHdr';
import { requestHdrConsent, sdrAllowed } from '../photo/hdrConsent';
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
  let hdrMedia:{width:number;height:number;hdr:'gainmap'}|undefined;
  if(image==='jpeg'&&announcesGainmap(bytes)) {
    // HDR with a gain map: rebuilt by the gate (both images kept, metadata regenerated). Never converted to SDR
    // silently: if the gate refuses (rotated photo, unknown profile, trailer data…) the user decides.
    try{const clean=sanitizeGainmapJpeg(bytes);bytes=clean.bytes;hdrMedia={width:clean.width,height:clean.height,hdr:'gainmap'};}
    catch{if(!sdrAllowed(file.uri))throw requestHdrConsent(file.uri);bytes=(await transcode(bytes,false)).bytes;}
    mime='image/jpeg';photo=true;
  }
  else if(image==='jpeg') {if(jpegOrientation(bytes)>1)bytes=(await transcode(bytes,false)).bytes;else try{bytes=sanitizeJpeg(bytes).bytes;}catch{bytes=(await transcode(bytes,false)).bytes;}mime='image/jpeg';photo=true;}
  else if(image==='png') {try{bytes=sanitizePng(bytes).bytes;mime='image/png';}catch{const out=await transcode(bytes,true);bytes=out.bytes;mime=out.mime;}photo=true;}
  else if(image==='gif') {bytes=sanitizeGif(bytes).bytes;mime='image/gif';}
  else if(image) {const out=await transcode(bytes,image==='webp'||image==='bmp'||image==='tiff'||image==='avif');bytes=out.bytes;mime=out.mime;photo=true;}
  else if(video==='mp4' && !file.mimeType.startsWith('audio/')) {bytes=sanitizeMp4(bytes).bytes;mime='video/mp4';movie=true;}
  else if(video && !file.mimeType.startsWith('audio/')) throw new Error('На ПК отправляй видео в формате MP4.');
  const uri=URL.createObjectURL(new Blob([bytes as BlobPart],{type:mime}));
  // Videos: size and length for the bubble (the «0:12» badge and the right aspect before download).
  const media=movie?await probeVideo(uri):hdrMedia;
  return {file:{...file,uri,mimeType:mime,size:bytes.length},photo,video:movie,...(media?{media}:{}),dispose:async()=>URL.revokeObjectURL(uri)};
}
/**
 * A photo above 20 MB (any format the engine decodes: JPEG, PNG, WebP, AVIF, BMP, big panoramas): decoded from
 * the Blob and re-encoded, which drops every metadata block; scaled down until it fits in 20 MiB.
 */
export async function prepareBigPhoto(file: LocalFile, blob: Blob): Promise<PreparedMedia> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions); }
  catch { throw new Error('Это фото повреждено или в формате, который не открывается на ПК. Пересохрани его как JPEG или PNG и отправь снова.'); }
  const header = new Uint8Array(await blob.slice(0, 64).arrayBuffer()), format = sniffPhotoFormat(header);
  // Above 20 MB the picture is re-encoded through a canvas, which cannot carry a gain map: ask first.
  if (format === 'jpeg' && !sdrAllowed(file.uri) && announcesGainmap(new Uint8Array(await blob.slice(0, 512 * 1024).arrayBuffer()))) { bitmap.close(); throw requestHdrConsent(file.uri); }
  const alpha = format === 'png' || format === 'webp' || format === 'avif' || format === 'bmp' || format === 'tiff';
  const mime = alpha ? 'image/png' : 'image/jpeg';
  let scale = Math.min(1, Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height)), 8192 / Math.max(bitmap.width, bitmap.height));
  try {
    for (let attempt = 0; attempt < 8; attempt++, scale *= 0.75) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Не удалось обработать фото.');
      if (!alpha) { ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.imageSmoothingQuality = 'high'; ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const out = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Не удалось обработать фото.')), mime, 0.9));
      if (out.size > 20 * 1024 * 1024) continue;
      const uri = URL.createObjectURL(out);
      return { file: { ...file, uri, mimeType: mime, size: out.size, name: (file.name.replace(/\.[^.]*$/, '') || 'photo') + (alpha ? '.png' : '.jpg') }, photo: true, video: false, media: { width: canvas.width, height: canvas.height }, dispose: async () => URL.revokeObjectURL(uri) };
    }
  } finally { bitmap.close(); }
  throw new Error('Не удалось уменьшить фото до 20 МБ.');
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

/**
 * EXIF orientation of a JPEG (1 = as stored). Phone photos are often stored sideways with a tag;
 * stripping metadata without applying it sent them rotated. Such photos are redrawn upright instead.
 */
function jpegOrientation(b:Uint8Array):number{
  if(b[0]!==0xff||b[1]!==0xd8)return 1;
  let i=2;
  while(i+4<b.length&&b[i]===0xff){
    const marker=b[i+1],len=(b[i+2]<<8)|b[i+3];
    if(marker===0xda||len<2)break;
    if(marker===0xe1&&len>14&&b[i+4]===0x45&&b[i+5]===0x78&&b[i+6]===0x69&&b[i+7]===0x66){
      const t=i+10,le=b[t]===0x49;const u16=(o:number)=>le?b[o]|(b[o+1]<<8):(b[o]<<8)|b[o+1];const u32=(o:number)=>le?(b[o]|(b[o+1]<<8)|(b[o+2]<<16)|(b[o+3]<<24))>>>0:((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3])>>>0;
      const ifd=t+u32(t+4);if(ifd+2>b.length)return 1;const n=u16(ifd);
      for(let k=0;k<n;k++){const e=ifd+2+k*12;if(e+10>b.length)break;if(u16(e)===0x0112){const v=u16(e+8);return v>=1&&v<=8?v:1;}}
      return 1;
    }
    i+=2+len;
  }
  return 1;
}
