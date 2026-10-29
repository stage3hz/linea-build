export type IsoBox={type:string;start:number;data:number;end:number};
export const mp4Fail=(message:string):never=>{throw new Error(`MP4: ${message}`);};
export const isoText=(bytes:Uint8Array,start:number,end:number)=>String.fromCharCode(...bytes.subarray(start,end));
export const isoView=(bytes:Uint8Array)=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);

function readBox(bytes:Uint8Array,offset:number,end:number):IsoBox {
  const view=isoView(bytes),length=view.getUint32(offset),type=isoText(bytes,offset+4,offset+8);
  let size=length,header=8;
  if(length===1){
    if(end-offset<16||view.getUint32(offset+8)!==0)mp4Fail('размер расширенного блока выходит за пределы файла.');
    size=view.getUint32(offset+12);header=16;
  }else if(length===0)size=end-offset;
  if(size<header||offset+size>end)mp4Fail('неверная длина блока.');
  return {type,start:offset,data:offset+header,end:offset+size};
}

export function boxes(bytes:Uint8Array,start=0,end=bytes.length):IsoBox[] {
  const found:IsoBox[]=[];let offset=start;
  while(offset<end){
    if(found.length>=4096||end-offset<8)mp4Fail('слишком много блоков или обрезанный заголовок.');
    const box=readBox(bytes,offset,end);found.push(box);offset=box.end;
  }
  return found;
}

export function need(box:IsoBox,length:number,exact=false):void {
  const actual=box.end-box.data;
  if(actual<length||exact&&actual!==length)mp4Fail(`неверный размер ${box.type}.`);
}

export function fullBox(bytes:Uint8Array,box:IsoBox,versions:readonly number[]=[0],flagsMask=0):number {
  need(box,4);const value=isoView(bytes).getUint32(box.data),version=value>>>24,flags=value&0xffffff;
  if(!versions.includes(version)||(flags&~flagsMask)!==0)mp4Fail(`неподдерживаемая версия или флаги ${box.type}.`);
  return version;
}

export function zeroBox(bytes:Uint8Array,box:IsoBox):void {
  bytes.fill(0,box.start,box.end);isoView(bytes).setUint32(box.start,box.end-box.start);
  bytes.set([102,114,101,101],box.start+4);
}

export function tableCount(bytes:Uint8Array,box:IsoBox,stride:number,prefix=8):number {
  need(box,prefix);const count=isoView(bytes).getUint32(box.data+prefix-4);
  if(count>1000000||box.end-box.data!==prefix+count*stride)mp4Fail(`неверная таблица ${box.type}.`);
  return count;
}
