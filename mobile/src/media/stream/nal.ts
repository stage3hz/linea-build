// In-place, same-size neutralisation of private data inside compressed video, shared by every container:
// • H.264/HEVC SEI: payloads of messages 3 (filler), 4 (registered user data, except HDR10+ dynamic metadata,
//   Dolby Vision and ATSC/CEA-608/708 captions), 5 (unregistered user data: GPS of drones/action cameras, AVCHD
//   MDPM date/time/model/GPS, serial numbers) and 136 (time code) are overwritten; the emulation-prevention layout
//   is rebuilt so that a decoder still reads exactly `payloadSize` bytes. Decoding instructions stay untouched.
// • MPEG-1/2 video: user_data (start code 0xB2) payloads are zeroed.
// • JPEG frames (Motion-JPEG in MOV/AVI): APP1…APP15 and COM payloads are zeroed (EXIF, GPS, maker notes);
//   APP0 (JFIF/AVI1) and the Motion-JPEG-A field table ('mjpg' APP1) are kept.

const NEUTRALISE=new Set([3,4,5,136]);

function keepRegistered(rbsp:number[],p:number,size:number):boolean{
  if(size<5||rbsp[p]!==0xb5)return false;
  const provider=(rbsp[p+1]<<8)|rbsp[p+2];
  if(provider===0x003c)return ((rbsp[p+3]<<8)|rbsp[p+4])===0x0001; // HDR10+ (ST 2094-40)
  if(provider===0x003b)return true; // Dolby Vision
  if(provider===0x0031&&size>=7)return String.fromCharCode(rbsp[p+3],rbsp[p+4],rbsp[p+5],rbsp[p+6])==='GA94'; // captions
  return false;
}

/** One SEI NAL unit (header bytes first), modified in place. */
export function seiNal(nal:Uint8Array,header:number):void{
  const rbsp:number[]=[],map:number[]=[];let zeros=0;
  for(let i=header;i<nal.length;i++){
    const b=nal[i];
    if(zeros>=2&&b===3){zeros=0;continue;}
    rbsp.push(b);map.push(i);zeros=b===0?zeros+1:0;
  }
  let p=0,guard=0;
  while(p<rbsp.length&&++guard<=4096){
    if(rbsp[p]===0x80&&rbsp.slice(p+1).every(b=>b===0))return;
    let type=0;while(p<rbsp.length&&rbsp[p]===255){type+=255;p++;}
    if(p>=rbsp.length)return;type+=rbsp[p++];
    let size=0;while(p<rbsp.length&&rbsp[p]===255){size+=255;p++;}
    if(p>=rbsp.length)return;size+=rbsp[p++];
    if(p+size>rbsp.length)return;
    if(size>0&&NEUTRALISE.has(type)&&!(type===4&&keepRegistered(rbsp,p,size))){
      // The escaped region runs up to the next RBSP byte, so an emulation byte right after the payload is ours too.
      const from=map[p],to=p+size<map.length?map[p+size]:nal.length,escapes=(to-from)-size,filler=size-2*escapes;
      if(filler>=0){nal.fill(0xff,from,from+filler);for(let k=0;k<escapes;k++)nal.set([0,0,3],from+filler+k*3);}
      else nal.fill(0xff,from,to); // cannot happen for encoder output; erase rather than keep
    }
    p+=size;
  }
}

function nalUnit(nal:Uint8Array,hevc:boolean):void{
  if(!nal.length)return;
  if(hevc){const type=(nal[0]>>1)&63;if(nal.length>2&&(type===39||type===40))seiNal(nal,2);}
  else if((nal[0]&31)===6&&nal.length>1)seiNal(nal,1);
}

/**
 * Length-prefixed (MP4/MKV/FLV) sample. Returns false when the NAL lengths do not tile the sample (a damaged
 * sample, or a table that points to the wrong bytes): no SEI can be located in it reliably.
 */
export function neutraliseSample(sample:Uint8Array,hevc:boolean,lengthSize:number):boolean{
  let offset=0;
  while(offset+lengthSize<=sample.length){
    let length=0;for(let i=0;i<lengthSize;i++)length=length*256+sample[offset+i];
    offset+=lengthSize;
    if(length===0||offset+length>sample.length)return sample.subarray(offset-lengthSize).every(b=>b===0);
    nalUnit(sample.subarray(offset,offset+length),hevc);
    offset+=length;
  }
  return sample.subarray(offset).every(b=>b===0);
}

/** Start-code positions (index of the byte after 00 00 01). */
function startCodes(b:Uint8Array):number[]{
  const out:number[]=[];
  for(let i=0;i+2<b.length;i++){if(b[i]===0&&b[i+1]===0&&b[i+2]===1){out.push(i+3);i+=2;}}
  return out;
}

/** Annex-B (start codes) H.264/HEVC data: AVI frames, MPEG-TS/PS elementary streams. */
export function neutraliseAnnexB(data:Uint8Array,hevc:boolean):void{
  const starts=startCodes(data);
  for(let k=0;k<starts.length;k++){
    let end=k+1<starts.length?starts[k+1]-3:data.length;
    while(end>starts[k]&&data[end-1]===0)end--;
    nalUnit(data.subarray(starts[k],end),hevc);
  }
}

/** MPEG-1/2 video: user_data payloads (camera model, date, GPS in some camcorders) are zeroed. */
export function neutraliseMpeg2(data:Uint8Array):void{
  const starts=startCodes(data);
  for(let k=0;k<starts.length;k++){
    if(data[starts[k]]!==0xb2)continue;
    const end=k+1<starts.length?starts[k+1]-3:data.length;
    data.fill(0,starts[k]+1,end);
  }
}

/** JPEG frame(s): APP1–APP15 and COM payloads zeroed, everything a decoder needs kept. */
export function neutraliseJpeg(data:Uint8Array):void{
  for(let i=0;i+3<data.length;i++){
    if(data[i]!==0xff||data[i+1]!==0xd8||data[i+2]!==0xff)continue;
    let p=i+2;
    while(p+4<=data.length&&data[p]===0xff){
      const marker=data[p+1];
      if(marker===0xff){p++;continue;}
      if(marker===0xd8||(marker>=0xd0&&marker<=0xd7)||marker===0x01){p+=2;continue;}
      if(marker===0xda||marker===0xd9)break;
      const length=(data[p+2]<<8)|data[p+3];
      if(length<2||p+2+length>data.length)break;
      const payload=p+4,end=p+2+length;
      const mjpg=marker===0xe1&&end-payload>=4&&String.fromCharCode(...data.subarray(payload,payload+4))==='mjpg';
      if(((marker>=0xe1&&marker<=0xef)||marker===0xfe)&&!mjpg)data.fill(0,payload,end);
      p=end;
    }
    i=p;
  }
}

export type FrameMode='length'|'annexb'|'mpeg2'|'jpeg';
export function neutraliseFrame(data:Uint8Array,mode:FrameMode,hevc:boolean,lengthSize:number):void{
  // Fail closed: a sample whose structure cannot be followed is blanked rather than sent with unknown SEI inside.
  if(mode==='length'){if(!neutraliseSample(data,hevc,lengthSize))data.fill(0);}
  else if(mode==='annexb')neutraliseAnnexB(data,hevc);
  else if(mode==='mpeg2')neutraliseMpeg2(data);
  else neutraliseJpeg(data);
}

/** HEVCDecoderConfigurationRecord (hvcC / MKV CodecPrivate): SEI NAL arrays are cleaned in place. */
export function neutraliseHvcc(record:Uint8Array):void{
  if(record.length<23)return;
  let p=23;const arrays=record[22];
  for(let a=0;a<arrays&&p+3<=record.length;a++){
    const type=record[p]&63,count=(record[p+1]<<8)|record[p+2];p+=3;
    for(let n=0;n<count&&p+2<=record.length;n++){
      const length=(record[p]<<8)|record[p+1];p+=2;if(p+length>record.length)return;
      if(type===39||type===40)seiNal(record.subarray(p,p+length),2);
      p+=length;
    }
  }
}

/** RBSP view of a NAL (tests and diagnostics). */
export function unescapeRbsp(nal:Uint8Array):Uint8Array{
  const out:number[]=[];let zeros=0;
  for(const b of nal){if(zeros>=2&&b===3){zeros=0;continue;}out.push(b);zeros=b===0?zeros+1:0;}
  return Uint8Array.from(out);
}
