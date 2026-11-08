// AVI (RIFF 'AVI ' plus OpenDML 'AVIX' extensions). Only what playback needs is kept: the stream headers and
// formats, the movi data and the indexes. INFO lists, IDIT dates, stream names, codec driver data (strd), camera
// vendor lists (Nikon ncdt, Fuji, Pentax …) and JUNK content become zero-filled JUNK chunks of the same size.
// In movi, chunks of text/data streams (dashcam GPS 'txts'/'dats') are zeroed; video frames get SEI user data
// (H.264/HEVC), MPEG-2/MPEG-4 user data (encoder strings) or JPEG APPn (EXIF/GPS of Motion-JPEG) neutralised.
import { ascii, corrupt, le32, FrameIndex, PlanBuilder, WindowReader, type ByteSource, type CleanPlan } from './source.ts';
import type { FrameMode } from './nal.ts';

const KEEP_LISTS:Record<string,Set<string>>={
  'AVI ':new Set(['LIST:hdrl','LIST:movi','idx1']),
  AVIX:new Set(['LIST:movi']),
  hdrl:new Set(['avih','LIST:strl','LIST:odml']),
  strl:new Set(['strh','strf','indx','vprp']),
  odml:new Set(['dmlh']),
};
const CODECS:[RegExp,FrameMode,boolean][]=[
  [/^(h264|x264|avc1|davc|vssh)$/i,'annexb',false],
  [/^(hevc|h265|hev1|hvc1)$/i,'annexb',true],
  [/^(mjpg|avrn|dmb1|jpeg|mjpa|ijpg)$/i,'jpeg',false],
  [/^(mpg1|mpg2|mpeg|mp2v|xvid|divx|dx50|fmp4|mp4v|m4s2)$/i,'mpeg2',false],
];
type Chunk={id:string;list?:string;start:number;end:number};
type Stream={type:string;frames?:FrameIndex};

export async function planAvi(source:ByteSource):Promise<CleanPlan>{
  const reader=new WindowReader(source,4*1024*1024),builder=new PlanBuilder(),size=source.size,streams:Stream[]=[];
  const read=async(offset:number,limit:number):Promise<Chunk>=>{
    const h=await reader.bytes(offset,Math.min(12,limit-offset));
    if(h.length<8)corrupt('AVI');
    const id=ascii(h,0,4),length=le32(h,4),end=offset+8+length+(length&1);
    if(!/^[\x20-\x7e]{4}$/.test(id)||offset+8+length>limit)corrupt('AVI');
    const list=(id==='LIST'||id==='RIFF')&&h.length>=12?ascii(h,8,12):undefined;
    return {id,list,start:offset,end:Math.min(end,limit)};
  };
  const junk=(c:Chunk)=>{builder.patch(c.start,Uint8Array.from([74,85,78,75]));builder.zeroRange(c.start+8,c.end);};
  const streamHeader=async(c:Chunk)=>{
    const h=await reader.bytes(c.start+8,Math.min(8,c.end-c.start-8));
    streams.push({type:h.length>=4?ascii(h,0,4):''});
  };
  const streamFormat=async(c:Chunk)=>{
    const stream=streams.at(-1);if(!stream||stream.type!=='vids'||c.end-c.start<28)return;
    const h=await reader.bytes(c.start+8,20),codec=ascii(h,16,20).trim();
    const known=CODECS.find(([pattern])=>pattern.test(codec));
    if(known){stream.frames=new FrameIndex(known[1],known[2]);builder.nal.push(stream.frames);}
  };
  const movi=async(parent:Chunk)=>{
    for(let o=parent.start+12;o<parent.end;){
      if(parent.end-o<8){builder.zeroRange(o,parent.end);break;}
      const c=await read(o,parent.end);
      if(c.id==='LIST'&&c.list==='rec ')await movi(c);
      else if(/^\d\d/.test(c.id)&&!c.id.startsWith('ix')){
        const stream=streams[Number(c.id.slice(0,2))],data=c.start+8,length=le32(await reader.bytes(c.start+4,4),0);
        if(!stream||(stream.type!=='vids'&&stream.type!=='auds'))builder.zeroRange(data,data+length);
        else if(stream.frames)stream.frames.push(data,length);
      }
      else if(c.id==='JUNK')builder.zeroRange(c.start+8,c.end);
      else if(!/^ix\d\d$/.test(c.id))junk(c);
      o=c.end;
    }
  };
  const walk=async(parent:Chunk,kind:string)=>{
    const keep=KEEP_LISTS[kind];
    for(let o=parent.start+12;o<parent.end;){
      if(parent.end-o<8){builder.zeroRange(o,parent.end);break;}
      const c=await read(o,parent.end),key=c.list&&c.id==='LIST'?`LIST:${c.list}`:c.id;
      if(!keep.has(key))junk(c);
      else if(key==='LIST:movi')await movi(c);
      else if(c.id==='LIST'&&c.list&&KEEP_LISTS[c.list])await walk(c,c.list);
      else if(kind==='strl'&&c.id==='strh')await streamHeader(c);
      else if(kind==='strl'&&c.id==='strf')await streamFormat(c);
      o=c.end;
    }
  };
  let offset=0,riffs=0;
  while(offset<size){
    if(size-offset<12){if(riffs){builder.zeroRange(offset,size);break;}corrupt('AVI');}
    const riff=await read(offset,size);
    if(riff.id!=='RIFF'||(riff.list!=='AVI '&&riff.list!=='AVIX')||(riffs===0&&riff.list!=='AVI ')){if(riffs){builder.zeroRange(offset,size);break;}corrupt('AVI');}
    await walk(riff,riff.list!);riffs++;offset=riff.end;
  }
  return builder.finish('avi',size);
}
