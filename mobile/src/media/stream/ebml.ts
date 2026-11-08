// Matroska / WebM, any size, Segment and Clusters of known or unknown size. Tags, Attachments (cover art,
// fonts, any file), Chapters, the Info title / muxing and writing application / date / file names and track
// names become `Void` elements of the same size; CRC-32 elements of the masters we change are voided too (they
// would no longer match). Frames of subtitle/metadata tracks (drone GPS subtitles, telemetry) are zeroed; video
// frames get their SEI user data (H.264/HEVC), MPEG-2 user data or JPEG APPn neutralised while streaming.
import { corrupt, FrameIndex, PlanBuilder, WindowReader, type ByteSource, type CleanPlan } from './source.ts';
import { neutraliseHvcc } from './nal.ts';

const SEGMENT=0x18538067,CLUSTER=0x1f43b675,EBML=0x1a45dfa3,INFO=0x1549a966,TRACKS=0x1654ae6b,TRACK_ENTRY=0xae,VOID=0xec,CRC=0xbf;
const SIMPLE_BLOCK=0xa3,BLOCK_GROUP=0xa0,BLOCK=0xa1;
const DROP_TOP=new Set([0x1254c367/*Tags*/,0x1941a469/*Attachments*/,0x1043a770/*Chapters*/]);
const DROP_INFO=new Set([0x7ba9/*Title*/,0x4d80/*MuxingApp*/,0x5741/*WritingApp*/,0x4461/*DateUTC*/,0x7384/*SegmentFilename*/,0x3c83ab/*PrevFilename*/,0x3e83bb/*NextFilename*/,CRC]);
const DROP_TRACK=new Set([0x536e/*Name*/,0x258688/*CodecName*/,CRC]);
const SEGMENT_LEVEL=new Set([0x114d9b74,INFO,TRACKS,CLUSTER,0x1c53bb6b,0x1941a469,0x1043a770,0x1254c367,VOID,CRC]);
type Element={id:number;start:number;data:number;end:number;unknown:boolean};
type Track={number:number;type:number;codec:string;frames?:FrameIndex};

async function element(reader:WindowReader,offset:number,limit:number):Promise<Element>{
  const h=await reader.bytes(offset,Math.min(12,limit-offset));
  if(!h.length)corrupt('MKV');
  const idLength=Math.clz32(h[0])-23;
  if(idLength<1||idLength>4||h.length<idLength+1)corrupt('MKV');
  let id=0;for(let i=0;i<idLength;i++)id=id*256+h[i];
  const first=h[idLength],sizeLength=Math.clz32(first)-23;
  if(sizeLength<1||sizeLength>8||h.length<idLength+sizeLength)corrupt('MKV');
  let size=first&(0xff>>sizeLength),ones=size===(0xff>>sizeLength);
  for(let i=1;i<sizeLength;i++){const b=h[idLength+i];size=size*256+b;ones&&=b===0xff;}
  const data=offset+idLength+sizeLength;
  if(ones)return {id,start:offset,data,end:limit,unknown:true};
  if(data+size>limit)corrupt('MKV');
  return {id,start:offset,data,end:data+size,unknown:false};
}

/** Same-size Void element: ID 0xEC, a size vint of up to 8 bytes, zero data. */
export function voidHeader(total:number):Uint8Array{
  if(total<2)return corrupt('MKV');
  const n=Math.min(8,total-1),value=total-1-n,out=new Uint8Array(1+n);
  out[0]=VOID;let v=value;
  for(let i=n;i>=1;i--){out[i]=v%256;v=Math.floor(v/256);}
  out[1]|=0x80>>(n-1);
  return out;
}

const uint=(b:Uint8Array)=>b.reduce((v,x)=>v*256+x,0);

export async function planMatroska(source:ByteSource):Promise<CleanPlan>{
  const reader=new WindowReader(source,4*1024*1024),builder=new PlanBuilder(),size=source.size,tracks=new Map<number,Track>();
  const neutral=(e:Element)=>{const header=voidHeader(e.end-e.start);builder.patch(e.start,header);builder.zeroRange(e.start+header.length,e.end);};
  const children=async(parent:Element,drop:Set<number>,inner?:(e:Element)=>Promise<void>)=>{
    for(let o=parent.data;o<parent.end;){
      const e=await element(reader,o,parent.end);
      if(e.unknown)corrupt('MKV');
      if(drop.has(e.id))neutral(e);else if(inner)await inner(e);
      o=e.end;
    }
  };
  const read=async(e:Element)=>{if(e.end-e.data>16*1024*1024)corrupt('MKV');return new Uint8Array(await reader.bytes(e.data,e.end-e.data));};
  const trackEntry=async(entry:Element)=>{
    const track:Track={number:0,type:0,codec:''};let privateData:Element|undefined;
    await children(entry,DROP_TRACK,async e=>{
      if(e.id===0xd7)track.number=uint(await read(e));
      else if(e.id===0x83)track.type=uint(await read(e));
      else if(e.id===0x86)track.codec=String.fromCharCode(...await read(e));
      else if(e.id===0x63a2)privateData=e;
    });
    if(track.type===1){
      const codec=track.codec;
      if(codec==='V_MPEG4/ISO/AVC'&&privateData){const p=await read(privateData);if(p.length>=5)track.frames=new FrameIndex('length',false,(p[4]&3)+1);}
      else if(codec==='V_MPEGH/ISO/HEVC'&&privateData){
        const before=await read(privateData),after=before.slice();neutraliseHvcc(after);builder.diff(privateData.data,before,after);
        if(after.length>=23)track.frames=new FrameIndex('length',true,(after[21]&3)+1);
      }
      else if(codec==='V_MJPEG')track.frames=new FrameIndex('jpeg');
      else if(codec==='V_MPEG1'||codec==='V_MPEG2')track.frames=new FrameIndex('mpeg2');
      if(track.frames)builder.nal.push(track.frames);
    }
    if(track.number)tracks.set(track.number,track);
  };
  const block=async(e:Element)=>{
    const h=await reader.bytes(e.data,Math.min(12,e.end-e.data));
    const n=Math.clz32(h[0])-23;if(n<1||n>8||h.length<n+3)corrupt('MKV');
    let number=h[0]&(0xff>>n);for(let i=1;i<n;i++)number=number*256+h[i];
    const frames=e.data+n+3,flags=h[n+2],track=tracks.get(number);
    if(!track||(track.type!==1&&track.type!==2)){builder.zeroRange(frames,e.end);return;} // subtitles, telemetry, unknown
    if(track.frames&&!(flags&0x06))track.frames.push(frames,e.end-frames);
  };
  const cluster=async(e:Element,end:number)=>{
    let o=e.data;
    for(;o<end;){
      const child=await element(reader,o,end);
      if(e.unknown&&SEGMENT_LEVEL.has(child.id))break;
      if(child.unknown)corrupt('MKV');
      if(child.id===SIMPLE_BLOCK)await block(child);
      else if(child.id===BLOCK_GROUP)await children(child,new Set(),async g=>{if(g.id===BLOCK)await block(g);});
      o=child.end;
    }
    return o;
  };
  let offset=0,segments=0;
  while(offset<size){
    const top=await element(reader,offset,size);
    if(top.id===EBML){offset=top.end;continue;}
    if(top.id!==SEGMENT){if(segments){builder.zeroRange(offset,size);break;}corrupt('MKV');}
    segments++;
    for(let o=top.data;o<top.end;){
      const e=await element(reader,o,top.end);
      if(e.unknown&&e.id!==CLUSTER)corrupt('MKV');
      if(DROP_TOP.has(e.id))neutral(e);
      else if(e.id===INFO)await children(e,DROP_INFO);
      else if(e.id===TRACKS)await children(e,new Set([CRC]),async entry=>{if(entry.id===TRACK_ENTRY)await trackEntry(entry);});
      else if(e.id===CLUSTER){o=await cluster(e,e.unknown?top.end:e.end);if(e.unknown)continue;}
      o=e.end;
    }
    offset=top.end;
  }
  if(!segments)corrupt('MKV');
  return builder.finish('matroska',size);
}
