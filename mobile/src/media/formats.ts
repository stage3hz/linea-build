import { isPhotoCandidate } from '../photo/formats';

type FileHint={name:string;mimeType:string};
const IMAGE_BRANDS=new Set(['avif','avis','heic','heix','hevc','hevx','mif1','msf1']);
const VIDEO_BRANDS=new Set(['isom','iso2','iso3','iso4','iso5','iso6','iso7','iso8','iso9','mp41','mp42','avc1','hvc1','hev1','M4V ','M4A ','MSNV','dash']);
const ascii=(bytes:Uint8Array,start:number,end:number)=>String.fromCharCode(...bytes.subarray(start,end));
const starts=(bytes:Uint8Array,signature:readonly number[])=>signature.every((byte,index)=>bytes[index]===byte);

export function isVideoCandidate(file:FileHint):boolean {
  return /^video\//i.test(file.mimeType)||/\.(?:mp4|m4v|mov|qt|3gp|3g2|mkv|webm|avi|wmv|asf|flv|f4v|mpg|mpeg|mpe|m2v|mts|m2ts|ts|vob|ogv|mxf)$/i.test(file.name);
}

function isoContainer(bytes:Uint8Array):string|null {
  if(bytes.length<16||ascii(bytes,4,8)!=='ftyp')return null;
  const length=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0,false);
  if(length<16||length%4!==0)return null;
  const brands=[ascii(bytes,8,12)];
  for(let offset=16;offset+4<=Math.min(bytes.length,length);offset+=4)brands.push(ascii(bytes,offset,offset+4));
  if(brands.some(brand=>IMAGE_BRANDS.has(brand)))return null;
  if(brands.includes('qt  '))return 'quicktime';
  if(brands.some(brand=>/^3g[pe2]/.test(brand)))return '3gpp';
  return brands.some(brand=>VIDEO_BRANDS.has(brand))?'mp4':null;
}

function transportStream(bytes:Uint8Array):boolean {
  for(const [first,stride] of [[0,188],[4,192],[0,204]]){
    if(bytes.length>first+stride*2&&[first,first+stride,first+stride*2].every(index=>bytes[index]===0x47))return true;
  }
  return false;
}

/** Recognition is routing only. The native decoder still validates every stream. */
export function sniffVideoFormat(bytes:Uint8Array):string|null {
  const iso=isoContainer(bytes);if(iso)return iso;
  if(starts(bytes,[0x1a,0x45,0xdf,0xa3]))return 'matroska';
  if(ascii(bytes,0,4)==='RIFF'&&ascii(bytes,8,12)==='AVI ')return 'avi';
  if(starts(bytes,[0,0,1,0xba])||starts(bytes,[0,0,1,0xb3]))return 'mpeg';
  if(ascii(bytes,0,3)==='FLV'&&bytes[3]===1)return 'flv';
  if(starts(bytes,[0x30,0x26,0xb2,0x75,0x8e,0x66,0xcf,0x11,0xa6,0xd9,0,0xaa,0,0x62,0xce,0x6c]))return 'asf';
  if(transportStream(bytes))return 'mpegts';
  return null;
}

export function mediaPreviewKind(file:FileHint):'photo'|'video'|'audio'|'file' {
  if(isPhotoCandidate(file))return 'photo';
  if(isVideoCandidate(file))return 'video';
  if(/^audio\//i.test(file.mimeType)||/\.(?:mp3|m4a|aac|wav|flac|ogg|oga|opus|aiff?|alac|amr|caf|wma)$/i.test(file.name))return 'audio';
  return 'file';
}
