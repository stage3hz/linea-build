import {fromByteArray,toByteArray} from 'base64-js';
import {sanitizeJpeg} from '../photo/jpeg';
import {announcesGainmap,primaryJpeg} from '../photo/jpegHdr';
import type {AttachmentMedia,AttachmentPreview} from '../types';

export const MAX_PREVIEW_BYTES=8*1024;
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const dimension=(value:unknown,max:number)=>Number.isInteger(value)&&Number(value)>0&&Number(value)<=max;
const only=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).every(key=>keys.includes(key));

export function createPreview(bytes:Uint8Array):AttachmentPreview {
  // Android 14+ image tools keep the gain map in a derived JPEG; the preview takes only its SDR base.
  const clean=sanitizeJpeg(announcesGainmap(bytes)?primaryJpeg(bytes):bytes);
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
  if(!record(value)||!only(value,['width','height','durationMs','hdr','waveform']))return false;
  if(value.width!==undefined&&!dimension(value.width,20000))return false;
  if(value.height!==undefined&&!dimension(value.height,20000))return false;
  if(value.durationMs!==undefined&&(typeof value.durationMs!=='number'||!Number.isFinite(value.durationMs)||value.durationMs<0||value.durationMs>86400000))return false;
  // Voice messages: loudness bars like Telegram's, 0…31 per bar as one letter (A–Z, a–f).
  if(value.waveform!==undefined&&(typeof value.waveform!=='string'||!/^[A-Za-f]{8,100}$/.test(value.waveform)))return false;
  // 'gainmap' is accepted for forward compatibility; senders do not put it on the wire yet (see wireMedia).
  return value.hdr===undefined||['sdr','pq','hlg','gainmap'].includes(String(value.hdr));
}

/**
 * Media description as sent inside the encrypted message. Clients up to 0.14.x accept only
 * hdr ∈ {sdr, pq, hlg} and refuse unknown keys (validMedia → the whole message is «invalid»), so a gain-map
 * photo is sent without the hdr field: every client shows the JPEG, and HDR screens use its gain map.
 */
export function wireMedia(media:AttachmentMedia|undefined):AttachmentMedia|undefined {
  if(!media||media.hdr!=='gainmap')return media;
  const {hdr:_hdr,...rest}=media;
  return rest;
}
