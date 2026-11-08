// MPEG program stream (.mpg .mpeg .vob .mod .tod): pack and system headers are kept; video PES (0xE0–0xEF) keep
// their data with SEI / user data neutralised; audio (0xC0–0xDF, and private_stream_1 AC-3/DTS/LPCM) is kept;
// private_stream_2, other private sub-streams and unknown streams get a zeroed payload (same size).
import { corrupt, u16, PlanBuilder, WindowReader, type ByteSource, type CleanPlan } from './source.ts';
import { EsScanner } from './es.ts';

export async function planPs(source:ByteSource):Promise<CleanPlan>{
  const reader=new WindowReader(source,4*1024*1024),builder=new PlanBuilder(),size=source.size;
  const scanners=new Map<number,EsScanner>();let pos=0,packs=0;
  while(pos+4<=size){
    const h=await reader.bytes(pos,Math.min(32,size-pos));
    if(h[0]!==0||h[1]!==0||h[2]!==1){if(packs){builder.zeroRange(pos,size);break;}corrupt('MPEG-PS');}
    const id=h[3];
    if(id===0xb9){pos+=4;continue;}
    if(id===0xba){packs++;pos+=(h[4]>>6)===1?14+(h[13]&7):12;continue;}
    if(id<0xbb)corrupt('MPEG-PS');
    if(h.length<6)corrupt('MPEG-PS');
    const length=u16(h,4),end=pos+6+length;
    if(end>size)corrupt('MPEG-PS');
    const payload=async()=>{
      // MPEG-2 PES header or MPEG-1 stuffing/STD/PTS fields.
      let p=6;
      if((h[6]&0xc0)===0x80)return pos+9+h[8];
      const b=await reader.bytes(pos,Math.min(40,length+6));
      while(p<b.length&&b[p]===0xff)p++;
      if((b[p]&0xc0)===0x40)p+=2;
      p+=(b[p]&0xf0)===0x20?5:(b[p]&0xf0)===0x30?10:1;
      return pos+p;
    };
    if(id>=0xe0&&id<=0xef){
      const data=await payload();
      let scanner=scanners.get(id);
      if(!scanner){
        // MPEG-2 (sequence header 0xB3) unless the stream opens with an H.264 access unit delimiter / SPS.
        const first=await reader.bytes(data,Math.min(64,end-data));let mode:'mpeg2'|'annexb'='mpeg2';
        for(let i=0;i+3<first.length;i++)if(first[i]===0&&first[i+1]===0&&first[i+2]===1){const t=first[i+3];if(t===0xb3)break;if(t===0x09||t===0x67||t===0x27){mode='annexb';break;}}
        scanner=new EsScanner(builder,mode);scanners.set(id,scanner);
      }
      if(end>data)scanner.push(data,await reader.bytes(data,end-data));
    }
    else if(id>=0xc0&&id<=0xdf||id===0xbb||id===0xbc||id===0xbe){/* audio, system header, stream map, padding */}
    else if(id===0xbd){
      const data=await payload(),sub=(await reader.bytes(data,1))[0];
      if(!((sub>=0x80&&sub<=0x8f)||(sub>=0xa0&&sub<=0xaf)))builder.zeroRange(data,end);
    }
    else builder.zeroRange(pos+6,end);
    pos=end;
  }
  for(const scanner of scanners.values())scanner.flush();
  if(!packs)corrupt('MPEG-PS');
  return builder.finish('mpegps',size);
}

/** Raw MPEG-1/2 video elementary stream (.m1v .m2v): user data zeroed, nothing else touched. */
export async function planMpegVideo(source:ByteSource):Promise<CleanPlan>{
  const builder=new PlanBuilder(),scanner=new EsScanner(builder,'mpeg2'),step=4*1024*1024;
  for(let at=0;at<source.size;at+=step)scanner.push(at,new Uint8Array(await source.read(at,Math.min(step,source.size-at))));
  scanner.flush();
  return builder.finish('mpegps',source.size);
}
