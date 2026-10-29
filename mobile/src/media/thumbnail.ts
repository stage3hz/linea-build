import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as VideoThumbnails from 'expo-video-thumbnails';
import {toByteArray} from 'base64-js';
import type {AttachmentPreview} from '../types';
import type {PreparedMedia} from './pipeline';
import {createPreview} from './previewModel';

const MAX_INTERMEDIATE=1024*1024;
const resize=(width:number,height:number,edge:number)=>width>=height?{width:edge}:{height:edge};
function generated(uri:string,source:string):boolean {
  if(!FileSystem.cacheDirectory||uri===source)return false;
  try{const base=new URL(FileSystem.cacheDirectory),item=new URL(uri);return item.protocol==='file:'&&item.hostname===base.hostname&&decodeURIComponent(item.pathname).startsWith(decodeURIComponent(base.pathname))&&!item.search&&!item.hash;}
  catch{return false;}
}
async function previewBytes(uri:string):Promise<Uint8Array>{
  const info=await FileSystem.getInfoAsync(uri);
  if(!info.exists||info.isDirectory||info.size>MAX_INTERMEDIATE)throw new Error('Миниатюра недоступна.');
  const bytes=toByteArray(await FileSystem.readAsStringAsync(uri,{encoding:FileSystem.EncodingType.Base64}));
  if(bytes.length>MAX_INTERMEDIATE)throw new Error('Миниатюра слишком большая.');
  return bytes;
}

/** A small derivative of already-cleaned media, carried inside the E2EE body. */
export async function makeThumbnail(prepared:PreparedMedia):Promise<AttachmentPreview|undefined>{
  if(!prepared.photo&&!prepared.video)return undefined;
  const temporary=new Set<string>();let source=prepared.file.uri;
  let width=prepared.media?.width||1,height=prepared.media?.height||1;
  try {
    if(prepared.video){
      const frame=await VideoThumbnails.getThumbnailAsync(source,{time:0,quality:.7});
      if(!generated(frame.uri,prepared.file.uri))throw new Error('Недопустимый путь миниатюры.');
      temporary.add(frame.uri);source=frame.uri;width=frame.width;height=frame.height;
    }
    for(const [edge,compress] of [[240,.6],[160,.4],[96,.3]]){
      const image=await ImageManipulator.manipulateAsync(source,[{resize:resize(width,height,edge)}],{format:ImageManipulator.SaveFormat.JPEG,compress});
      if(!generated(image.uri,prepared.file.uri))throw new Error('Недопустимый путь миниатюры.');
      temporary.add(image.uri);
      try{return createPreview(await previewBytes(image.uri));}catch{/* Retry a smaller derivative; never use the original as a preview. */}
    }
    return undefined;
  }finally{await Promise.all([...temporary].map(uri=>FileSystem.deleteAsync(uri,{idempotent:true}).catch(()=>{})));}
}
