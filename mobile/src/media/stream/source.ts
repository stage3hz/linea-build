// Streaming media cleaning (big photos/videos, any container the strict small-file path cannot take).
// Pure TypeScript, shared by phones (expo-file-system handle) and the PC (Blob.slice), tested in node.
//
// A plan never changes the file size or any offset: metadata is neutralised in place (an MP4 box becomes a
// zero-filled `free`, an EBML element becomes `Void`, a RIFF chunk becomes `JUNK`, GIF comment bytes become
// zeros). The cleaned stream is produced on the fly while it is encrypted chunk by chunk, so a 5 GB video needs
// no extra disk and only one chunk plus the container header in memory, and a resumed upload reproduces the
// exact same bytes (the plan is a pure function of the file).

import { neutraliseFrame, type FrameMode } from './nal.ts';

export interface ByteSource { readonly size:number; read(offset:number,length:number):Promise<Uint8Array>; }
/** Same as the native remux sample cap: a multi-hour 4K60 recording has a few million frames. */
export const MAX_FRAMES=50_000_000;
/** Video frames whose private payloads (SEI user data, MPEG-2 user data, JPEG APPn) are neutralised while streaming. */
export class FrameIndex {
  mode:FrameMode;hevc:boolean;lengthSize:number;offsets=new Float64Array(256);sizes=new Float64Array(256);count=0;
  constructor(mode:FrameMode,hevc=false,lengthSize=4){this.mode=mode;this.hevc=hevc;this.lengthSize=lengthSize;}
  push(offset:number,size:number):void{
    if(!size)return;
    if(this.count>=MAX_FRAMES)corrupt('видео (слишком много кадров)');
    if(this.count===this.offsets.length){
      const grow=(a:Float64Array)=>{const b=new Float64Array(Math.min(MAX_FRAMES,a.length*2));b.set(a);return b;};
      this.offsets=grow(this.offsets);this.sizes=grow(this.sizes);
    }
    this.offsets[this.count]=offset;this.sizes[this.count]=size;this.count++;
  }
  /** Frames must be in file order for the streamed lookup; containers almost always store them so. */
  sort():void{
    let sorted=true;for(let i=1;i<this.count;i++)if(this.offsets[i]<this.offsets[i-1]){sorted=false;break;}
    if(sorted)return;
    const order=Array.from({length:this.count},(_,i)=>i).sort((a,b)=>this.offsets[a]-this.offsets[b]);
    const offsets=Float64Array.from(order,i=>this.offsets[i]),sizes=Float64Array.from(order,i=>this.sizes[i]);
    this.offsets=offsets;this.sizes=sizes;
  }
}
export type NalIndex=FrameIndex;
export type CleanMedia={width?:number;height?:number;durationMs?:number};
export type CleanPlan={
  format:'mp4'|'matroska'|'avi'|'gif'|'mpegts'|'mpegps'|'flv'|'asf';
  size:number;
  /** Replacement bytes, sorted by offset, never overlapping. */
  patches:{offset:number;bytes:Uint8Array}[];
  /** Flat sorted [start,end) pairs to zero. */
  zero:Float64Array;
  /** Video samples whose user-data SEI payloads are neutralised while streaming. */
  nal:NalIndex[];
  media?:CleanMedia;
};

export class MediaCorrupt extends Error { constructor(message:string){super(message);this.name='MediaCorrupt';} }
export const corrupt=(what:string):never=>{throw new MediaCorrupt(`Не удалось убрать личные метаданные (место съёмки, дату, модель камеры): ${what} повреждён или устроен непривычно. Чтобы не отправить их случайно, файл не отправлен.`);};

export const ascii=(bytes:Uint8Array,start:number,end:number)=>String.fromCharCode(...bytes.subarray(start,end));
export const u16=(b:Uint8Array,o:number)=>(b[o]<<8)|b[o+1];
export const u32=(b:Uint8Array,o:number)=>((b[o]<<24)>>>0)+(b[o+1]<<16)+(b[o+2]<<8)+b[o+3];
export const u64=(b:Uint8Array,o:number)=>{const high=u32(b,o);if(high>=0x200000)corrupt('64-битный размер');return high*2**32+u32(b,o+4);};
export const le32=(b:Uint8Array,o:number)=>(b[o]|(b[o+1]<<8)|(b[o+2]<<16))+b[o+3]*2**24;

/** Sequential header scanning with a read-ahead window (headers are tiny, one read per window, not per header). */
export class WindowReader {
  source:ByteSource;window:number;base=0;buffer:Uint8Array=new Uint8Array(0);reads=0;
  constructor(source:ByteSource,window=1024*1024){this.source=source;this.window=window;}
  async bytes(offset:number,length:number):Promise<Uint8Array>{
    const end=Math.min(this.source.size,offset+length);
    if(offset<0||offset>end)corrupt('файл');
    if(offset>=this.base&&end<=this.base+this.buffer.length)return this.buffer.subarray(offset-this.base,end-this.base);
    const size=Math.min(this.source.size-offset,Math.max(length,this.window));
    const data=await this.source.read(offset,size);this.reads++;
    if(data.length!==size)corrupt('файл (изменился во время чтения)');
    this.base=offset;this.buffer=data;
    return data.subarray(0,end-offset);
  }
  async byte(offset:number):Promise<number>{const b=await this.bytes(offset,1);if(!b.length)corrupt('файл');return b[0];}
}

/** Collects the edits of a plan; finish() sorts them and checks they never overlap. */
export class PlanBuilder {
  patches:{offset:number;bytes:Uint8Array}[]=[];zero:number[]=[];nal:NalIndex[]=[];
  patch(offset:number,bytes:Uint8Array):void{if(bytes.length)this.patches.push({offset,bytes});}
  /** Patches only the bytes that differ between `before` and `after` (a region read at `offset`). */
  diff(offset:number,before:Uint8Array,after:Uint8Array):void{
    for(let i=0;i<after.length;){
      if(before[i]===after[i]){i++;continue;}
      let j=i;while(j<after.length&&before[j]!==after[j])j++;
      this.patch(offset+i,after.slice(i,j));i=j;
    }
  }
  zeroRange(start:number,end:number):void{if(end>start)this.zero.push(start,end);}
  finish(format:CleanPlan['format'],size:number,media?:CleanMedia):CleanPlan{
    const patches=[...this.patches].sort((a,b)=>a.offset-b.offset);
    for(let i=1;i<patches.length;i++)if(patches[i].offset<patches[i-1].offset+patches[i-1].bytes.length)corrupt('контейнер (пересекающиеся блоки)');
    const pairs:number[][]=[];for(let i=0;i<this.zero.length;i+=2)pairs.push([this.zero[i],this.zero[i+1]]);
    pairs.sort((a,b)=>a[0]-b[0]);
    const merged:number[]=[];
    for(const [s,e] of pairs){const last=merged.length-1;if(last>0&&s<=merged[last])merged[last]=Math.max(merged[last],e);else merged.push(s,e);}
    if(patches.some(p=>p.offset<0||p.offset+p.bytes.length>size))corrupt('контейнер');
    for(const index of this.nal)index.sort();
    return {format,size,patches,zero:Float64Array.from(merged),nal:this.nal,...(media?{media}:{})};
  }
}

function firstEnding(ends:(i:number)=>number,count:number,offset:number):number{
  let lo=0,hi=count;while(lo<hi){const mid=(lo+hi)>>1;if(ends(mid)<=offset)lo=mid+1;else hi=mid;}return lo;
}

/** Bytes [offset, offset+length) of the cleaned stream. Deterministic: the same plan and file give the same bytes. */
export async function readClean(plan:CleanPlan,source:ByteSource,offset:number,length:number):Promise<Uint8Array>{
  const neutralise=(data:Uint8Array,index:FrameIndex)=>neutraliseFrame(data,index.mode,index.hevc,index.lengthSize);
  const end=Math.min(plan.size,offset+length);
  if(source.size!==plan.size)throw new Error('Файл изменился во время отправки.');
  const raw=await source.read(offset,end-offset);
  if(raw.length!==end-offset)throw new Error('Файл изменился во время отправки.');
  const out=new Uint8Array(raw);
  const patches=plan.patches;
  for(let i=firstEnding(index=>patches[index].offset+patches[index].bytes.length,patches.length,offset);i<patches.length&&patches[i].offset<end;i++){
    const p=patches[i],from=Math.max(offset,p.offset),to=Math.min(end,p.offset+p.bytes.length);
    out.set(p.bytes.subarray(from-p.offset,to-p.offset),from-offset);
  }
  for(const index of plan.nal){
    const count=index.count;
    for(let i=firstEnding(k=>index.offsets[k]+index.sizes[k],count,offset);i<count&&index.offsets[i]<end;i++){
      const start=index.offsets[i],size=index.sizes[i];
      if(start>=offset&&start+size<=end){neutralise(out.subarray(start-offset,start-offset+size),index);continue;}
      const sample=new Uint8Array(await source.read(start,size));
      if(sample.length!==size)throw new Error('Файл изменился во время отправки.');
      neutralise(sample,index);
      const from=Math.max(offset,start),to=Math.min(end,start+size);
      out.set(sample.subarray(from-start,to-start),from-offset);
    }
  }
  const zero=plan.zero,pairs=zero.length/2;
  for(let i=firstEnding(k=>zero[k*2+1],pairs,offset);i<pairs&&zero[i*2]<end;i++){
    out.fill(0,Math.max(offset,zero[i*2])-offset,Math.min(end,zero[i*2+1])-offset);
  }
  return out;
}
