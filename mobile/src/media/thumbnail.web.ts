// PC (Electron/web): the small JPEG preview that travels inside the encrypted message, made with a
// canvas from the already-cleaned photo or video. Without it photos and videos sent from the PC showed
// up everywhere (even for the sender) as a grey «загрузить» placeholder.
import type {AttachmentPreview} from '../types';
import type {PreparedMedia} from './pipeline';
import {createPreview} from './previewModel';

async function frame(uri:string,video:boolean):Promise<CanvasImageSource&{width:number;height:number}>{
  if(!video){const blob=await (await fetch(uri)).blob();return await createImageBitmap(blob);}
  const element=document.createElement('video');element.muted=true;element.playsInline=true;element.preload='auto';element.src=uri;
  await new Promise<void>((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('timeout')),8000);
    element.onloadeddata=()=>{element.currentTime=Math.min(0.6,(element.duration||1)/6);};
    element.onseeked=()=>{clearTimeout(t);resolve();};element.onerror=()=>{clearTimeout(t);reject(new Error('video'));};});
  const canvas=document.createElement('canvas');canvas.width=element.videoWidth||1;canvas.height=element.videoHeight||1;
  canvas.getContext('2d')?.drawImage(element,0,0);element.removeAttribute('src');element.load();
  return canvas;
}

export async function makeThumbnail(prepared:PreparedMedia):Promise<AttachmentPreview|undefined>{
  if(!prepared.photo&&!prepared.video)return undefined;
  try{
    const source=await frame(prepared.file.uri,!!prepared.video);
    const width=source.width||1,height=source.height||1;
    for(const [edge,quality] of [[240,.6],[160,.45],[96,.3]] as const){
      const scale=Math.min(1,edge/Math.max(width,height));
      const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
      const ctx=canvas.getContext('2d');if(!ctx)return undefined;
      ctx.fillStyle='#FFFFFF';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.imageSmoothingQuality='high';ctx.drawImage(source,0,0,canvas.width,canvas.height);
      const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
      if(!blob)continue;
      try{return createPreview(new Uint8Array(await blob.arrayBuffer()));}catch{/* try smaller */}
    }
    if('close' in source&&typeof (source as ImageBitmap).close==='function')(source as ImageBitmap).close();
  }catch{/* No preview: the attachment still sends. */}
  return undefined;
}
