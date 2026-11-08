// MP4 / MOV / 3GP (ISO-BMFF and QuickTime), any size, any codec, plain or fragmented, 32/64-bit boxes.
// Only video and audio tracks are kept. Everything else is neutralised in place (same size, offsets stay valid):
// udta/meta/keys/ilst (GPS ©xyz, make, model, software, dates), XMP/uuid, timecode/telemetry/subtitle/data tracks
// (tmcd, GoPro gpmd, camm, DJI text), creation dates, handler and compressor names, external references;
// media-data bytes that belong to no kept sample (gaps, telemetry samples) are zeroed; user-data SEI inside
// H.264/HEVC samples is neutralised while streaming.
import { ascii, corrupt, u16, u32, u64, FrameIndex, PlanBuilder, WindowReader, type ByteSource, type CleanMedia, type CleanPlan } from './source.ts';
import { neutraliseHvcc } from './nal.ts';

const MiB=1024*1024;
/** A 12-hour 4K60 recording has ~40 MB of sample tables; far bigger is not a real camera file. */
export const MAX_MOOV=128*MiB;
const MAX_MOOF=64*MiB;
const PRIVATE=new Set(['udta','meta','ilst','keys','uuid','free','skip','wide','XMP_','pdin','prft','emsg','mfra','cprt','ctab','clip','matt','load','imap','txas','pnot','PICT','junk','JUNK']);
const KEEP:Record<string,Set<string>>={
  moov:new Set(['mvhd','trak','mvex','iods','pssh']),
  trak:new Set(['tkhd','edts','mdia','tref','tapt']),
  edts:new Set(['elst']),
  mdia:new Set(['mdhd','hdlr','minf','elng']),
  minf:new Set(['vmhd','smhd','hmhd','nmhd','gmhd','hdlr','dinf','stbl']),
  dinf:new Set(['dref']),
  mvex:new Set(['mehd','trex','leva','trep']),
  moof:new Set(['mfhd','traf','pssh']),
  traf:new Set(['tfhd','tfdt','trun','sbgp','sgpd','subs','saiz','saio','senc']),
};
const ROOT_KEEP=new Set(['ftyp','styp','moov','moof','mdat','sidx','ssix']);
const VIDEO_NAL:Record<string,'avc'|'hevc'>={avc1:'avc',avc3:'avc',dva1:'avc',dvav:'avc',hvc1:'hevc',hev1:'hevc',dvh1:'hevc',dvhe:'hevc'};
/** Motion-JPEG sample entries: each sample is a JPEG that may carry EXIF/GPS. */
const JPEG_CODECS=new Set(['jpeg','mjpa','mjpb','mjp2','MJPG','dmb1','AVDJ']);
const BRANDS=new Set(['isom','iso2','iso3','iso4','iso5','iso6','iso7','iso8','iso9','mp41','mp42','avc1','hvc1','hev1','M4V ','qt  ','dash','msdh','msix','cmfc','3gp4','3gp5','3gp6','3g2a']);

type Box={type:string;start:number;data:number;end:number};
const printable=(t:string)=>/^[\x20-\x7e\xa9]{4}$/.test(t);

function children(b:Uint8Array,start:number,end:number,strict=true):Box[]{
  const out:Box[]=[];let o=start;
  while(o<end){
    if(end-o<8){if(strict&&b.subarray(o,end).some(x=>x!==0))corrupt('MP4 блок');break;}
    let size=u32(b,o),header=8;const type=ascii(b,o+4,o+8);
    if(size===1){if(end-o<16)corrupt('MP4 блок');size=u64(b,o+8);header=16;}else if(size===0)size=end-o;
    if(size<header||o+size>end||!printable(type)){if(strict)corrupt('MP4 блок');break;}
    out.push({type,start:o,data:o+header,end:o+size});o+=size;
    if(out.length>100000)corrupt('MP4 (слишком много блоков)');
  }
  return out;
}

/** A box becomes a zero-filled `free` box of the same size. */
function free(b:Uint8Array,box:Box):void{
  b.fill(0,box.start,box.end);
  const view=new DataView(b.buffer,b.byteOffset,b.byteLength);
  view.setUint32(box.start,box.end-box.start);b.set([102,114,101,101],box.start+4);
}

type Track={id:number;kind:'vide'|'soun'|'other';codec?:string;lengthSize?:number;width?:number;height?:number;rotated?:boolean;timescale?:number;defaults?:{size:number}};
type Ranges={starts:number[];ends:number[]};
type Context={tracks:Map<number,Track>;ranges:Ranges;samples:Map<number,FrameIndex>;movie:{timescale:number;duration:number};fragmentDuration:number;pendingTrex:[number,number][]};

function fullVersion(b:Uint8Array,box:Box):number{if(box.end-box.data<4)corrupt('MP4 заголовок');return b[box.data];}

function clearTimes(b:Uint8Array,box:Box):void{
  const v=fullVersion(b,box),length=v===1?16:8;
  if(box.end-box.data<4+length)corrupt(`MP4 ${box.type}`);
  b.fill(0,box.data+4,box.data+4+length);
}

function handlerType(b:Uint8Array,trak:Box):string{
  for(const mdia of children(b,trak.data,trak.end))if(mdia.type==='mdia')
    for(const h of children(b,mdia.data,mdia.end))if(h.type==='hdlr'&&h.end-h.data>=12)return ascii(b,h.data+8,h.data+12);
  return '';
}

function visualEntry(b:Uint8Array,entry:Box,track:Track):void{
  if(entry.end-entry.data<78)return;
  track.codec=entry.type;
  b.fill(0,entry.data+8,entry.data+24);b.fill(0,entry.data+36,entry.data+40);b.fill(0,entry.data+42,entry.data+74);
  for(const child of children(b,entry.data+78,entry.end,false)){
    if(PRIVATE.has(child.type)){free(b,child);continue;}
    if(child.type==='avcC'&&child.end-child.data>=5&&VIDEO_NAL[entry.type]==='avc')track.lengthSize=(b[child.data+4]&3)+1;
    if(child.type==='hvcC'&&child.end-child.data>=23&&VIDEO_NAL[entry.type]==='hevc'){track.lengthSize=(b[child.data+21]&3)+1;neutraliseHvcc(b.subarray(child.data,child.end));}
  }
  if(!track.width){track.width=u16(b,entry.data+24);track.height=u16(b,entry.data+26);}
}

function audioEntry(b:Uint8Array,entry:Box,track:Track):void{
  if(entry.end-entry.data<28)return;
  track.codec=entry.type;
  const version=u16(b,entry.data+8),offset=version===1?44:version===2?64:28;
  b.fill(0,entry.data+12,entry.data+16);
  if(entry.end-entry.data<offset)return;
  for(const child of children(b,entry.data+offset,entry.end,false))if(PRIVATE.has(child.type))free(b,child);
}

function sampleDescriptions(b:Uint8Array,box:Box,track:Track):void{
  if(box.end-box.data<8)corrupt('MP4 stsd');
  for(const entry of children(b,box.data+8,box.end,false)){
    if(track.kind==='vide')visualEntry(b,entry,track);else audioEntry(b,entry,track);
  }
}

function dataReferences(b:Uint8Array,box:Box):void{
  if(box.end-box.data<8)return;
  for(const entry of children(b,box.data+8,box.end,false)){
    if(entry.end-entry.data<4)continue;
    b.set([0,0,0,1],entry.data);b.fill(0,entry.data+4,entry.end); // self-contained, no path or URL
  }
}

type Tables={stsz?:Box;stz2?:Box;stsc?:Box;stco?:Box;co64?:Box};

function sampleSizes(b:Uint8Array,t:Tables):(i:number)=>number{
  if(t.stsz){
    const box=t.stsz;if(box.end-box.data<12)corrupt('MP4 stsz');
    const fixed=u32(b,box.data+4),count=u32(b,box.data+8);
    if(!fixed&&box.end-box.data<12+count*4)corrupt('MP4 stsz');
    const sizes=(i:number)=>fixed||u32(b,box.data+12+i*4);
    return Object.assign(sizes,{count});
  }
  if(t.stz2){
    const box=t.stz2;if(box.end-box.data<12)corrupt('MP4 stz2');
    const field=b[box.data+7],count=u32(b,box.data+8);
    if(![4,8,16].includes(field)||box.end-box.data<12+Math.ceil(count*field/8))corrupt('MP4 stz2');
    const at=box.data+12;
    const sizes=(i:number)=>field===16?u16(b,at+i*2):field===8?b[at+i]:(i%2?b[at+(i>>1)]&15:b[at+(i>>1)]>>4);
    return Object.assign(sizes,{count});
  }
  return Object.assign((_:number)=>0,{count:0});
}

function trackSamples(b:Uint8Array,t:Tables,track:Track,context:Context):void{
  const sizes=sampleSizes(b,t) as ((i:number)=>number)&{count:number};
  const chunks=t.stco||t.co64,stsc=t.stsc;
  if(!sizes.count)return; // fragmented: samples live in moof/trun
  if(!chunks||!stsc)return void corrupt('MP4 таблица образцов');
  const wide=chunks.type==='co64',chunkCount=u32(b,chunks.data+4);
  if(chunks.end-chunks.data<8+chunkCount*(wide?8:4))corrupt('MP4 stco');
  const runCount=u32(b,stsc.data+4);
  if(stsc.end-stsc.data<8+runCount*12)corrupt('MP4 stsc');
  const samples=collector(track,context);
  let run=0,sample=0;
  for(let chunk=0;chunk<chunkCount;chunk++){
    while(run+1<runCount&&chunk+1>=u32(b,stsc.data+8+(run+1)*12))run++;
    const perChunk=runCount?u32(b,stsc.data+8+run*12+4):0;
    const at=chunks.data+8+chunk*(wide?8:4);
    let offset=wide?u64(b,at):u32(b,at);const start=offset;
    for(let k=0;k<perChunk&&sample<sizes.count;k++,sample++){
      const size=sizes(sample);
      if(samples&&size)pushSample(samples,offset,size);
      offset+=size;
    }
    if(offset>start){context.ranges.starts.push(start);context.ranges.ends.push(offset);}
  }
}

function collector(track:Track,context:Context):FrameIndex|undefined{
  if(track.kind!=='vide'||!track.codec)return undefined;
  const jpeg=JPEG_CODECS.has(track.codec),nal=VIDEO_NAL[track.codec]&&track.lengthSize;
  if(!jpeg&&!nal)return undefined;
  let samples=context.samples.get(track.id);
  if(!samples){samples=jpeg?new FrameIndex('jpeg'):new FrameIndex('length',VIDEO_NAL[track.codec]==='hevc',track.lengthSize);context.samples.set(track.id,samples);}
  return samples;
}
function pushSample(samples:FrameIndex,offset:number,size:number):void{samples.push(offset,size);}

function track(b:Uint8Array,trak:Box,context:Context):void{
  const kind=handlerType(b,trak);
  if(kind!=='vide'&&kind!=='soun'){free(b,trak);return;}
  const info:Track={id:0,kind};const tables:Tables={};
  const walk=(parent:Box)=>{
    for(const box of children(b,parent.data,parent.end)){
      if(parent.type==='stbl'){
        if(PRIVATE.has(box.type)){free(b,box);continue;}
        if(box.type==='stsd')sampleDescriptions(b,box,info);
        else if(['stsz','stz2','stsc','stco','co64'].includes(box.type))(tables as Record<string,Box>)[box.type]=box;
        continue;
      }
      if(!KEEP[parent.type]?.has(box.type)){free(b,box);continue;}
      if(box.type==='tkhd'){
        clearTimes(b,box);const v=b[box.data],at=box.data+(v===1?32:24);
        if(box.end-box.data>=(v===1?96:84)){
          info.id=u32(b,box.data+(v===1?20:12));
          const matrix=box.data+(v===1?52:40),w=u32(b,matrix+76-40)/65536,h=u32(b,matrix+80-40)/65536;
          info.rotated=u32(b,matrix)===0&&u32(b,matrix+4)!==0;
          if(w>=1&&h>=1){info.width=Math.round(w);info.height=Math.round(h);}
        }
      }
      else if(box.type==='mdhd'){
        clearTimes(b,box);const v=b[box.data];
        if(box.end-box.data>=(v===1?32:24)){info.timescale=u32(b,box.data+(v===1?20:12));b.set([0x55,0xc4],box.data+(v===1?32:20));}
      }
      else if(box.type==='hdlr'){b.fill(0,box.data+12,Math.min(box.end,box.data+24));if(box.end-box.data>24)b.fill(0,box.data+24,box.end);} // manufacturer ('appl'), flags, name
      else if(box.type==='dref')dataReferences(b,box);
      else if(['edts','mdia','minf','dinf','stbl'].includes(box.type))walk(box);
    }
  };
  walk(trak);
  context.tracks.set(info.id,info);
  trackSamples(b,tables,info,context);
}

function movie(b:Uint8Array,context:Context):void{
  const root:Box={type:'moov',start:0,data:8,end:b.length};
  if(u32(b,0)===1)root.data=16;
  for(const box of children(b,root.data,root.end)){
    if(!KEEP.moov.has(box.type)){free(b,box);continue;}
    if(box.type==='mvhd'){
      clearTimes(b,box);const v=b[box.data];
      context.movie={timescale:u32(b,box.data+(v===1?20:12)),duration:v===1?u64(b,box.data+24):u32(b,box.data+16)};
    }
    else if(box.type==='trak')track(b,box,context);
    else if(box.type==='mvex')for(const child of children(b,box.data,box.end)){
      if(!KEEP.mvex.has(child.type)){free(b,child);continue;}
      if(child.type==='mehd'){const v=b[child.data];context.fragmentDuration=v===1?u64(b,child.data+4):u32(b,child.data+4);}
      if(child.type==='trex'&&child.end-child.data>=24){const t=context.tracks.get(u32(b,child.data+4));if(t)t.defaults={size:u32(b,child.data+16)};else context.pendingTrex.push([u32(b,child.data+4),u32(b,child.data+16)]);}
    }
  }
  for(const [id,size] of context.pendingTrex){const t=context.tracks.get(id);if(t)t.defaults={size};}
}

/** Movie fragment: dropped tracks lose their traf; samples of kept tracks are recorded. */
function fragment(b:Uint8Array,moofStart:number,context:Context):void{
  const root:Box={type:'moof',start:0,data:u32(b,0)===1?16:8,end:b.length};
  let previousEnd=moofStart;
  for(const box of children(b,root.data,root.end)){
    if(!KEEP.moof.has(box.type)){free(b,box);continue;}
    if(box.type!=='traf')continue;
    const parts=children(b,box.data,box.end),tfhd=parts.find(p=>p.type==='tfhd');
    if(!tfhd||tfhd.end-tfhd.data<8)return void corrupt('MP4 фрагмент');
    const flags=u32(b,tfhd.data)&0xffffff,id=u32(b,tfhd.data+4),info=context.tracks.get(id);
    if(!info){free(b,box);continue;}
    let at=tfhd.data+8,base=previousEnd;
    if(flags&1){base=u64(b,at);at+=8;}else if(flags&0x20000)base=moofStart;
    if(flags&2)at+=4;if(flags&8)at+=4;
    const defaultSize=flags&0x10?u32(b,at):info.defaults?.size||0;
    let cursor=base;const samples=collector(info,context);
    for(const part of parts){
      if(!KEEP.traf.has(part.type)){free(b,part);continue;}
      if(part.type!=='trun')continue;
      const tf=u32(b,part.data)&0xffffff,count=u32(b,part.data+4);let p=part.data+8;
      if(tf&1){const view=new DataView(b.buffer,b.byteOffset,b.byteLength);cursor=base+view.getInt32(p);p+=4;}
      if(tf&4)p+=4;
      const stride=4*[0x100,0x200,0x400,0x800].filter(f=>tf&f).length;
      if(part.end<p+count*stride)corrupt('MP4 trun');
      const start=cursor;
      for(let i=0;i<count;i++){
        let q=p+i*stride;if(tf&0x100)q+=4;
        const size=tf&0x200?u32(b,q):defaultSize;
        if(samples&&size)pushSample(samples,cursor,size);
        cursor+=size;
      }
      if(cursor>start){context.ranges.starts.push(start);context.ranges.ends.push(cursor);}
    }
    previousEnd=cursor;
  }
}

function fileType(b:Uint8Array):void{
  const data=u32(b,0)===1?16:8;
  if(b.length-data<8||(b.length-data)%4)return;
  b.fill(0,data+4,data+8);
  for(let o=data;o<b.length;o+=4){if(o===data+4)continue;if(!BRANDS.has(ascii(b,o,o+4)))b.set([105,115,111,109],o);}
}

/** null when the file has no video track (audio-only M4A/MOV goes as it is, like before). */
export async function planIso(source:ByteSource):Promise<CleanPlan|null>{
  const reader=new WindowReader(source,64*1024),size=source.size,builder=new PlanBuilder();
  const roots:Box[]=[];let offset=0;
  while(offset<size){
    const h=await reader.bytes(offset,Math.min(16,size-offset));
    let length=h.length>=8?u32(h,0):0,header=8;const type=h.length>=8?ascii(h,4,8):'';
    if(length===1&&h.length>=16){length=u64(h,8);header=16;}else if(length===0&&h.length>=8)length=size-offset;
    if(h.length<8||!printable(type)||length<header||offset+length>size){
      // Vendor trailers after the boxes (Insta360, some Samsung/LG phones): neutralised, not parsed.
      if(roots.some(r=>r.type==='moov')&&roots.some(r=>r.type==='mdat')){builder.zeroRange(offset,size);break;}
      return corrupt('MP4');
    }
    roots.push({type,start:offset,data:offset+header,end:offset+length});offset+=length;
    if(roots.length>1_000_000)corrupt('MP4 (слишком много блоков)');
  }
  const moov=roots.filter(r=>r.type==='moov');
  if(moov.length!==1||!roots.some(r=>r.type==='mdat'))corrupt('MP4 (нет moov/mdat)');
  const context:Context={tracks:new Map(),ranges:{starts:[],ends:[]},samples:new Map(),movie:{timescale:0,duration:0},fragmentDuration:0,pendingTrex:[]};
  const load=async(box:Box,cap:number)=>{
    if(box.end-box.start>cap)corrupt('MP4 (слишком большой заголовок)');
    const bytes=new Uint8Array(await source.read(box.start,box.end-box.start));
    if(bytes.length!==box.end-box.start)corrupt('MP4');
    return bytes;
  };
  const neutral=(box:Box)=>{builder.patch(box.start+4,Uint8Array.from([102,114,101,101]));builder.zeroRange(box.data,box.end);};
  const moovBytes=await load(moov[0],MAX_MOOV);movie(moovBytes,context);
  builder.patch(moov[0].start,moovBytes);
  const kinds=[...context.tracks.values()].map(t=>t.kind);
  if(!kinds.includes('vide'))return null;
  for(const box of roots){
    if(box.type==='moov'||box.type==='mdat')continue;
    if(!ROOT_KEEP.has(box.type)||PRIVATE.has(box.type)){neutral(box);continue;}
    if(box.type==='ftyp'||box.type==='styp'){if(box.end-box.start>4096){neutral(box);continue;}const b=await load(box,4096);fileType(b);builder.patch(box.start,b);continue;}
    if(box.type==='moof'){const b=await load(box,MAX_MOOF);fragment(b,box.start,context);builder.patch(box.start,b);}
  }
  // Every byte of media data that is not a sample of a kept track is zeroed (gaps, telemetry, dropped tracks).
  const {starts,ends}=context.ranges,order=Array.from(starts.keys()).sort((a,b)=>starts[a]-starts[b]);
  let index=0;
  for(const mdat of roots.filter(r=>r.type==='mdat').sort((a,b)=>a.start-b.start)){
    let cursor=mdat.data;
    while(index<order.length&&starts[order[index]]<mdat.end){
      const s=Math.max(starts[order[index]],mdat.data),e=Math.min(ends[order[index]],mdat.end);index++;
      if(e<=s)continue;
      builder.zeroRange(cursor,s);cursor=Math.max(cursor,e);
    }
    builder.zeroRange(cursor,mdat.end);
  }
  for(const samples of context.samples.values())builder.nal.push(samples);
  return builder.finish('mp4',size,isoMedia(context));
}

function isoMedia(context:Context):CleanMedia|undefined{
  const video=[...context.tracks.values()].find(t=>t.kind==='vide');
  const media:CleanMedia={};
  if(video?.width&&video.height&&video.width<=20000&&video.height<=20000){media.width=video.rotated?video.height:video.width;media.height=video.rotated?video.width:video.height;}
  const {timescale,duration}=context.movie,total=duration||context.fragmentDuration;
  const ms=timescale?Math.round(total/timescale*1000):0;
  if(ms>0&&ms<=86400000)media.durationMs=ms;
  return Object.keys(media).length?media:undefined;
}
