import {fromByteArray,toByteArray} from 'base64-js';
import {sanitizeJpeg} from '../photo/jpeg';
import type {AttachmentMedia,AttachmentPreview} from '../types';

export const MAX_PREVIEW_BYTES=8*1024;
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const dimension=(value:unknown,max:number)=>Number.isInteger(value)&&Number(value)>0&&Number(value)<=max;
const only=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).every(key=>keys.includes(key));

export function createPreview(bytes:Uint8Array):AttachmentPreview {
  const clean=sanitizeJpeg(bytes);
  if(clean.bytes.length>MAX_PREVIEW_BYTES||clean.width>256||clean.height>256)throw new Error('Миниатюра превышает допустимый размер.');
  return {mimeType:'image/jpeg',base64:fromByteArray(clean.bytes),width:clean.width,height:clean.height};
}

function previewHeader(value:unknown):value is AttachmentPreview {
  if(!record(value)||!only(value,['mimeType','base64','width','height']))return false;
  return value.mimeType==='image/jpeg'&&typeof value.base64==='string'&&value.base64.length<=Math.ceil(MAX_PREVIEW_BYTES/3)*4&&dimension(value.width,256)&&dimension(value.height,256);
}

export function validPreview(value:unknown):value is AttachmentPreview|undefined {
  if(value===undefined)return true;
  if(!previewHeader(value)||!value.base64||!/^[A-Za-z0-9+/]+={0,2}$/.test(value.base64))return false;
  try {
    const bytes=toByteArray(value.base64),clean=createPreview(bytes);
    return clean.base64===value.base64&&clean.width===value.width&&clean.height===value.height;
  }catch{return false;}
}

export function previewUri(value:unknown):string|null {
  return value&&validPreview(value)?`data:image/jpeg;base64,${value.base64}`:null;
}

export function validMedia(value:unknown):value is AttachmentMedia|undefined {
  if(value===undefined)return true;
  if(!record(value)||!only(value,['width','height','durationMs','hdr']))return false;
  if(value.width!==undefined&&!dimension(value.width,20000))return false;
  if(value.height!==undefined&&!dimension(value.height,20000))return false;
  if(value.durationMs!==undefined&&(typeof value.durationMs!=='number'||!Number.isFinite(value.durationMs)||value.durationMs<0||value.durationMs>86400000))return false;
  return value.hdr===undefined||['sdr','pq','hlg'].includes(String(value.hdr));
}
