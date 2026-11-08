// MPEG-TS / M2TS / AVCHD (.ts .mts .m2ts; 188, 192 and 204-byte packets). PAT/PMT decide what each PID carries:
// video PIDs (H.264, HEVC, MPEG-1/2/4 visual) are kept with their SEI/user data neutralised (AVCHD writes date,
// time, camera model and GPS in an 'MDPM' user-data SEI of every I-frame); audio PIDs are kept; everything else
// (private/metadata streams, subtitles, SIT/TDT/SDT/EIT service tables, unknown PIDs) has its payload zeroed.
// The packet structure, continuity counters and PCR timing stay as they are, so the size and offsets do not change.
import { corrupt, PlanBuilder, WindowReader, type ByteSource, type CleanPlan } from './source.ts';
import { EsScanner } from './es.ts';
import type { FrameMode } from './nal.ts';

const VIDEO:Record<number,[FrameMode,boolean]>={0x01:['mpeg2',false],0x02:['mpeg2',false],0x10:['mpeg2',false],0x1b:['annexb',false],0x24:['annexb',true]};
const AUDIO=new Set([0x03,0x04,0x0f,0x11,0x1c,0x80,0x81,0x82,0x83,0x84,0x85,0x86,0x87,0xa1,0xa2]);
const AUDIO_REGISTRATION=new Set(['AC-3','EAC3','DTS1','DTS2','DTS3','Opus','BSSD','mlpa']);
const AUDIO_DESCRIPTORS=new Set([0x6a,0x7a,0x7b,0x7c,0x81]);
const MAX_PSI_SCAN=32*1024*1024;

export function packetLayout(head:Uint8Array):{size:number;sync:number}|null{
  for(const [size,sync] of [[188,0],[192,4],[204,0]])if(head.length>=sync+size*3&&[0,1,2].every(k=>head[sync+k*size]===0x47))return {size,sync};
  return null;
}

type Stream={kind:'video'|'audio'|'drop';scanner?:EsScanner};

function audioByDescriptors(d:Uint8Array):boolean{
  for(let p=0;p+2<=d.length;){
    const tag=d[p],length=d[p+1];
    if(AUDIO_DESCRIPTORS.has(tag))return true;
    if(tag===0x05&&length>=4&&AUDIO_REGISTRATION.has(String.fromCharCode(...d.subarray(p+2,p+6))))return true;
    p+=2+length;
  }
  return false;
}

export async function planTs(source:ByteSource):Promise<CleanPlan>{
  const reader=new WindowReader(source,4*1024*1024),builder=new PlanBuilder(),size=source.size;
  const layout=packetLayout(await reader.bytes(0,Math.min(1024,size)));
  if(!layout)return corrupt('MPEG-TS');
  const {size:packet,sync}=layout,count=Math.floor(size/packet);
  const pmtPids=new Set<number>(),streams=new Map<number,Stream>(),pcr=new Set<number>(),pmtSeen=new Set<number>();
  const payloadOf=(p:Uint8Array)=>{
    const control=(p[sync+3]>>4)&3;if(!(control&1))return -1;
    const start=sync+4+(control&2?1+p[sync+4]:0);
    return start<p.length?start:-1;
  };
  const section=(p:Uint8Array,start:number)=>{const s=start+1+p[start];return s+3<=p.length?s:-1;};
  // Pass 1: the program tables (PAT, PMTs) near the start.
  for(let i=0;i<count&&i*packet<MAX_PSI_SCAN;i++){
    const p=await reader.bytes(i*packet,packet);
    if(p[sync]!==0x47)corrupt('MPEG-TS');
    const pid=((p[sync+1]&0x1f)<<8)|p[sync+2],start=payloadOf(p);
    if(start<0||!(p[sync+1]&0x40))continue;
    const s=section(p,start);if(s<0)continue;
    const table=p[s],length=((p[s+1]&0x0f)<<8)|p[s+2],end=Math.min(p.length,s+3+length-4);
    if(pid===0&&table===0){for(let q=s+8;q+4<=end;q+=4){const program=(p[q]<<8)|p[q+1],target=((p[q+2]&0x1f)<<8)|p[q+3];if(program)pmtPids.add(target);}}
    else if(pmtPids.has(pid)&&table===2&&!pmtSeen.has(pid)){
      pmtSeen.add(pid);pcr.add(((p[s+8]&0x1f)<<8)|p[s+9]);
      let q=s+12+(((p[s+10]&0x0f)<<8)|p[s+11]);
      while(q+5<=end){
        const type=p[q],es=((p[q+1]&0x1f)<<8)|p[q+2],info=((p[q+3]&0x0f)<<8)|p[q+4],d=p.subarray(q+5,Math.min(end,q+5+info));
        const video=VIDEO[type];
        if(video)streams.set(es,{kind:'video',scanner:new EsScanner(builder,video[0],video[1])});
        else if(AUDIO.has(type)||(type===0x06&&audioByDescriptors(d)))streams.set(es,{kind:'audio'});
        else streams.set(es,{kind:'drop'});
        q+=5+info;
      }
    }
    if(pmtPids.size&&pmtSeen.size===pmtPids.size)break;
  }
  if(!pmtSeen.size)corrupt('MPEG-TS (нет таблицы программ)');
  // Pass 2: every packet.
  for(let i=0;i<count;i++){
    const at=i*packet,p=await reader.bytes(at,packet);
    if(p[sync]!==0x47)corrupt('MPEG-TS');
    const pid=((p[sync+1]&0x1f)<<8)|p[sync+2],start=payloadOf(p);
    if(start<0||pid===0||pid===0x1fff||pmtPids.has(pid))continue;
    const stream=streams.get(pid);
    if(stream?.kind==='audio')continue;
    if(stream?.kind==='video'){
      let data=start;
      if(p[sync+1]&0x40){
        // PES header: the elementary stream starts after it.
        if(p[data]===0&&p[data+1]===0&&p[data+2]===1)data+=[0xbc,0xbe,0xbf,0xf0,0xf1,0xf2,0xf8,0xff].includes(p[data+3])?6:9+p[data+8];
      }
      // 204-byte packets end with 16 bytes of Reed-Solomon parity: not part of the stream.
      if(data<sync+188)stream.scanner!.push(at+data,p.subarray(data,sync+188));
      continue;
    }
    if(pcr.has(pid)&&!stream)continue; // a PCR-only PID carries timing in the adaptation field
    builder.zeroRange(at+start,at+sync+188);
  }
  for(const stream of streams.values())stream.scanner?.flush();
  if(count*packet<size)builder.zeroRange(count*packet,size);
  return builder.finish('mpegts',size);
}
