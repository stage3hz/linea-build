// FLV: the onMetaData script tag keeps the playback fields (duration, size, rates, codec ids, keyframe index) and
// loses every string, date and other number (creation date, metadatacreator/encoder, GPS-like custom fields);
// video tags (H.264/HEVC, classic and enhanced FLV) get SEI user data neutralised; other tag types are zeroed.
import { corrupt, u32, FrameIndex, PlanBuilder, WindowReader, type ByteSource, type CleanPlan } from './source.ts';

const KEEP_NUMBERS=new Set(['duration','width','height','videodatarate','framerate','videocodecid','audiodatarate','audiosamplerate','audiosamplesize','stereo','audiocodecid','filesize','lasttimestamp','lastkeyframetimestamp','lastkeyframelocation','audiodelay','canseektoend','datasize','videosize','audiosize','times','filepositions','keyframes']);
const u24=(b:Uint8Array,o:number)=>(b[o]<<16)|(b[o+1]<<8)|b[o+2];

/** Cleans an AMF0 script body in place; false if it cannot be parsed (the caller then zeroes it all). */
export function cleanAmf(b:Uint8Array):boolean{
  let p=0;
  const fail=()=>{throw new Error('amf');};
  const need=(n:number)=>{if(p+n>b.length)fail();};
  const key=()=>{need(2);const n=(b[p]<<8)|b[p+1];p+=2;need(n);const k=String.fromCharCode(...b.subarray(p,p+n));p+=n;return k;};
  const value=(name:string,keep:boolean,depth:number):void=>{
    if(depth>32)fail();need(1);const type=b[p++];
    if(type===0){need(8);if(!keep&&!KEEP_NUMBERS.has(name.toLowerCase()))b.fill(0,p,p+8);p+=8;}
    else if(type===1){need(1);p++;}
    else if(type===2||type===12){const wide=type===12;need(wide?4:2);const n=wide?u32(b,p):(b[p]<<8)|b[p+1];p+=wide?4:2;need(n);b.fill(0x20,p,p+n);p+=n;}
    else if(type===3||type===8){
      if(type===8){need(4);p+=4;}
      const inner=keep||KEEP_NUMBERS.has(name.toLowerCase());
      for(let guard=0;;guard++){if(guard>100000)fail();need(3);if(b[p]===0&&b[p+1]===0&&b[p+2]===9){p+=3;break;}const k=key();value(k,inner,depth+1);}
    }
    else if(type===10){need(4);const n=u32(b,p);p+=4;const inner=keep||KEEP_NUMBERS.has(name.toLowerCase());for(let i=0;i<n;i++)value(name,inner,depth+1);}
    else if(type===11){need(10);b.fill(0,p,p+10);p+=10;}
    else if(type===5||type===6||type===9){/* null, undefined, end */}
    else fail();
  };
  try{
    // Name ('onMetaData') is a string value whose text is needed by players: kept as is.
    need(3);if(b[0]!==2)return false;p=3+((b[1]<<8)|b[2]);
    while(p<b.length){if(b.length-p===3&&b[p]===0&&b[p+1]===0&&b[p+2]===9)break;value('',false,0);}
    return true;
  }catch{return false;}
}

export async function planFlv(source:ByteSource):Promise<CleanPlan>{
  const reader=new WindowReader(source,4*1024*1024),builder=new PlanBuilder(),size=source.size;
  const head=await reader.bytes(0,Math.min(13,size));
  if(head.length<13||String.fromCharCode(head[0],head[1],head[2])!=='FLV')corrupt('FLV');
  let pos=u32(head,5)+4,lengthSize=4,hevc=false,frames:FrameIndex|undefined;
  const index=(isHevc:boolean,size:number)=>{if(!frames||hevc!==isHevc||lengthSize!==size){hevc=isHevc;lengthSize=size;frames=new FrameIndex('length',hevc,lengthSize);builder.nal.push(frames);}return frames;};
  while(pos+11<=size){
    const h=await reader.bytes(pos,11),type=h[0]&0x1f,dataSize=u24(h,1),data=pos+11,end=data+dataSize;
    if(end+4>size){builder.zeroRange(pos,size);break;}
    if(type===18){
      if(dataSize>16*1024*1024)builder.zeroRange(data,end);
      else{const before=new Uint8Array(await source.read(data,dataSize)),after=before.slice();if(cleanAmf(after))builder.diff(data,before,after);else builder.zeroRange(data,end);}
    }
    else if(type===9&&dataSize>5){
      const v=await reader.bytes(data,Math.min(16,dataSize)),ex=(v[0]&0x80)!==0;
      if(ex){
        const packetType=v[0]&0x0f,fourcc=String.fromCharCode(v[1],v[2],v[3],v[4]),isHevc=fourcc==='hvc1';
        if(fourcc==='avc1'||isHevc){
          if(packetType===0){const cfg=await reader.bytes(data+5,Math.min(32,dataSize-5));if(cfg.length>=(isHevc?23:5))index(isHevc,((isHevc?cfg[21]:cfg[4])&3)+1);}
          else if((packetType===1||packetType===3)&&frames){const skip=packetType===1?8:5;frames.push(data+skip,dataSize-skip);}
        }
      }else{
        const codec=v[0]&0x0f,isHevc=codec===12;
        if(codec===7||isHevc){
          if(v[1]===0){const cfg=await reader.bytes(data+5,Math.min(32,dataSize-5));if(cfg.length>=(isHevc?23:5))index(isHevc,((isHevc?cfg[21]:cfg[4])&3)+1);}
          else if(v[1]===1&&frames)frames.push(data+5,dataSize-5);
        }
      }
    }
    else if(type!==8&&type!==9)builder.zeroRange(data,end);
    pos=end+4;
  }
  if(pos<size)builder.zeroRange(pos,size);
  return builder.finish('flv',size);
}
