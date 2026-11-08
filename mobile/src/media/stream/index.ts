// What happens to a file before it is encrypted, decided from its CONTENT (first bytes), never its name.
import { isPhotoCandidate, sniffPhotoFormat } from '../../photo/formats.ts';
import { sniffVideoFormat } from '../formats.ts';
import { planIso } from './iso.ts';
import { planMatroska } from './ebml.ts';
import { planAvi } from './riff.ts';
import { planGif } from './gif.ts';
import { planTs } from './ts.ts';
import { planPs, planMpegVideo } from './ps.ts';
import { planFlv } from './flv.ts';
import { planAsf } from './asf.ts';
import type { ByteSource, CleanPlan } from './source.ts';
export { readClean, MediaCorrupt, type ByteSource, type CleanPlan } from './source.ts';

export const SMALL_FILE=20*1024*1024;
export type Container='iso'|'matroska'|'avi'|'mpegts'|'mpegps'|'mpegvideo'|'flv'|'asf';
/**
 * photo  – re-encoded by the platform (metadata never survives a decode/encode), scaled down to ≤ 20 MiB;
 * gif    – small: rebuilt by sanitizeGif; big: streamed cleaner;
 * video  – small: native remux + strict check, falling back to the streamed cleaner; big: streamed cleaner;
 * opaque – the name/type says video but the content is no container we can clean: never sent silently, the user
 *          has to confirm «Отправить без очистки?» first;
 * raw    – anything else (documents, archives, audio): unchanged, like Telegram's «send as file».
 */
export type UploadRoute={kind:'photo'|'gif'|'raw'}|{kind:'video';container:Container}|{kind:'opaque';container:string};
export type FileHint={name:string;mimeType:string};

const SKIP_BOXES=new Set(['free','skip','wide','uuid','junk','JUNK','pnot','PICT']);
const HEIF_BRANDS=new Set(['heic','heix','hevc','hevx','heim','heis','hevm','hevs','mif1','msf1','avif','avis','crx ']);
/** MP4/MOV with or without ftyp, also after leading free/skip/wide/uuid boxes (iPhone, older QuickTime). */
function isoRoute(header:Uint8Array):'iso'|'photo'|null{
  let o=0;
  for(let guard=0;guard<16&&o+8<=header.length;guard++){
    const size=((header[o]<<24)>>>0)+(header[o+1]<<16)+(header[o+2]<<8)+header[o+3],type=String.fromCharCode(...header.subarray(o+4,o+8));
    if(type==='ftyp'){
      const end=Math.min(header.length,o+Math.max(16,size));const brands:string[]=[];
      for(let p=o+8;p+4<=end;p+=4)if(p!==o+12)brands.push(String.fromCharCode(...header.subarray(p,p+4)));
      return brands.some(brand=>HEIF_BRANDS.has(brand))?'photo':'iso';
    }
    if(['moov','mdat'].includes(type))return 'iso';
    if(!SKIP_BOXES.has(type)||(size!==1&&size<8))return null;
    if(size===1)return null;
    o+=size;
  }
  return null;
}

const VIDEO_NAME=/\.(?:mp4|m4v|mov|qt|3gp|3g2|mkv|webm|avi|wmv|asf|flv|f4v|mpg|mpeg|mpe|m1v|m2v|mts|m2ts|vob|mod|tod|ogv|mxf|rm|rmvb|divx|dv)$/i;
const isVideoHint=(hint?:FileHint)=>!!hint&&(/^video\//i.test(hint.mimeType)||VIDEO_NAME.test(hint.name));

export function planUpload(header:Uint8Array,hint?:FileHint):UploadRoute{
  const image=sniffPhotoFormat(header);
  if(image==='gif')return {kind:'gif'};
  if(image&&image!=='heif')return {kind:'photo'};
  const iso=isoRoute(header);
  if(iso==='photo'||image==='heif')return {kind:'photo'};
  if(iso)return {kind:'video',container:'iso'};
  const video=sniffVideoFormat(header);
  if(video==='matroska')return {kind:'video',container:'matroska'};
  if(video==='avi')return {kind:'video',container:'avi'};
  if(video==='mpegts')return {kind:'video',container:'mpegts'};
  if(video==='mpeg')return {kind:'video',container:header[3]===0xba?'mpegps':'mpegvideo'};
  if(video==='flv')return {kind:'video',container:'flv'};
  if(video==='asf')return {kind:'video',container:'asf'};
  if(video)return {kind:'opaque',container:video};
  // Content not recognised: the name or type decides only in the safe direction (clean or ask, never send raw).
  if(hint&&/^audio\//i.test(hint.mimeType))return {kind:'raw'};
  if(hint&&isPhotoCandidate(hint)&&!isVideoHint(hint))return {kind:'photo'};
  if(isVideoHint(hint))return {kind:'opaque',container:'unknown'};
  return {kind:'raw'};
}

/** Streamed cleaning plan; null = no video inside (audio-only MP4/M4A), sent unchanged as before. */
export async function planStreamClean(route:UploadRoute,source:ByteSource):Promise<CleanPlan|null>{
  if(route.kind==='gif')return planGif(source);
  if(route.kind!=='video')return null;
  switch(route.container){
    case 'iso':return planIso(source);
    case 'matroska':return planMatroska(source);
    case 'avi':return planAvi(source);
    case 'mpegts':return planTs(source);
    case 'mpegps':return planPs(source);
    case 'mpegvideo':return planMpegVideo(source);
    case 'flv':return planFlv(source);
    case 'asf':return planAsf(source);
  }
}

/**
 * Same, for an upload. An audio file (voice message up to 18 h, music) that is an MP4/M4A has its index read:
 * with no video track the plan is null and it goes unchanged. If the index cannot be read, the file may still
 * hide a video track, so it is refused like any unreadable video — never sent raw on the strength of its MIME type.
 */
export async function planForUpload(route:UploadRoute,source:ByteSource,_mimeType:string):Promise<CleanPlan|null>{
  return planStreamClean(route,source);
}

/** Thrown for media that cannot be cleaned and was not explicitly confirmed by the user. */
export class UncleanableMedia extends Error { constructor(){super('Этот формат нельзя очистить от метаданных. Отправить без очистки?');this.name='UncleanableMedia';} }
export const UNCLEANABLE_QUESTION='Этот формат нельзя очистить от метаданных. Отправить без очистки?';

export const VIDEO_MIME:Record<Container,string>={iso:'video/mp4',matroska:'video/x-matroska',avi:'video/x-msvideo',mpegts:'video/mp2t',mpegps:'video/mpeg',mpegvideo:'video/mpeg',flv:'video/x-flv',asf:'video/x-ms-asf'};
