// GIF of any size, streamed: frames, colour tables, frame timing and the NETSCAPE/ANIMEXTS loop block stay;
// comment, plain-text and any other application block (XMP, editor data) are zeroed in place (block sizes are
// kept, so the file structure and size do not change), as is anything after the trailer.
import { ascii, corrupt, PlanBuilder, WindowReader, type ByteSource, type CleanPlan } from './source.ts';

export async function planGif(source:ByteSource):Promise<CleanPlan>{
  const reader=new WindowReader(source,4*1024*1024),builder=new PlanBuilder(),size=source.size;
  const head=await reader.bytes(0,13);
  if(head.length<13||!/^GIF8[79]a$/.test(ascii(head,0,6)))corrupt('GIF');
  const width=head[6]|(head[7]<<8),height=head[8]|(head[9]<<8);
  let pos=13;if(head[10]&0x80)pos+=3*(1<<((head[10]&7)+1));
  const subBlocks=async(clear:boolean)=>{
    for(;;){
      if(pos>=size)corrupt('GIF');
      const length=await reader.byte(pos);
      if(clear&&length)builder.zeroRange(pos+1,pos+1+length);
      pos+=1+length;if(!length)return;
    }
  };
  let frames=0;
  while(pos<size){
    const block=await reader.byte(pos);
    if(block===0x3b){builder.zeroRange(pos+1,size);break;}
    if(block===0x2c){
      const d=await reader.bytes(pos,10);if(d.length<10)corrupt('GIF');
      pos+=10;if(d[9]&0x80)pos+=3*(1<<((d[9]&7)+1));
      pos+=1;await subBlocks(false);frames++;continue;
    }
    if(block!==0x21)corrupt('GIF');
    const e=await reader.bytes(pos,14),label=e[1];
    if(label===0xf9){pos+=2;await subBlocks(false);continue;}
    if(label===0xff&&e[2]===11&&e.length>=14&&['NETSCAPE2.0','ANIMEXTS1.0'].includes(ascii(e,3,14))){pos+=2;await subBlocks(false);continue;}
    pos+=2;await subBlocks(true);
  }
  if(!frames)corrupt('GIF');
  return builder.finish('gif',size,width&&height?{width,height}:undefined);
}
