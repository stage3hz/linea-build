// ASF / WMV / WMA: the header's Content Description (title, author, copyright, description), Extended Content
// Description (WM/… tags, camera, encoder, GPS), Metadata, Metadata Library and Content Branding objects keep
// their size but lose their content (counts and lengths become zero, so parsers see empty lists); the file
// creation date is zeroed. Data packets are not touched.
import { corrupt, le32, PlanBuilder, type ByteSource, type CleanPlan } from './source.ts';

/** GUID text → the little-endian byte order ASF stores. */
function guid(text:string):string{
  const h=text.replace(/-/g,''),b=(i:number)=>h.slice(i*2,i*2+2);
  return [b(3),b(2),b(1),b(0),b(5),b(4),b(7),b(6),...Array.from({length:8},(_,i)=>b(8+i))].join('').toLowerCase();
}
const HEADER=guid('75B22630-668E-11CF-A6D9-00AA0062CE6C'),EXTENSION=guid('5FBF03B5-A92E-11CF-8EE3-00C00C205365'),FILE_PROPERTIES=guid('8CABDCA1-A947-11CF-8EE4-00C00C205365');
const PRIVATE=new Set([guid('75B22633-668E-11CF-A6D9-00AA0062CE6C'),guid('D2D0A440-E307-11D2-97F0-00A0C95EA850'),guid('C5F8CBEA-5BAF-4877-8467-AA8C44FA4CCA'),guid('44231C94-9498-49D1-A141-1D134E457054'),guid('2211B3FA-BD23-11D2-B4B7-00A0C955FC6E')]);
const hex=(b:Uint8Array,o:number)=>Array.from(b.subarray(o,o+16),x=>x.toString(16).padStart(2,'0')).join('');
const size64=(b:Uint8Array,o:number)=>{const high=le32(b,o+4);if(high>=0x200000)corrupt('ASF');return high*2**32+le32(b,o);};

export async function planAsf(source:ByteSource):Promise<CleanPlan>{
  const builder=new PlanBuilder(),head=new Uint8Array(await source.read(0,Math.min(30,source.size)));
  if(head.length<30||hex(head,0)!==HEADER)corrupt('ASF');
  const length=size64(head,16);
  if(length>64*1024*1024||length>source.size||length<30)corrupt('ASF');
  const b=new Uint8Array(await source.read(0,length));
  const walk=(start:number,end:number,depth:number)=>{
    for(let o=start;o+24<=end;){
      const id=hex(b,o),size=size64(b,o+16);
      if(size<24||o+size>end)corrupt('ASF');
      if(PRIVATE.has(id))b.fill(0,o+24,o+size);
      else if(id===FILE_PROPERTIES&&size>=24+40)b.fill(0,o+24+24,o+24+32);
      else if(id===EXTENSION&&depth===0&&size>=46)walk(o+46,o+size,1);
      o+=size;
    }
  };
  walk(30,length,0);
  builder.patch(0,b);
  return builder.finish('asf',source.size);
}
