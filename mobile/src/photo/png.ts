import { inspectPngHdrChunk } from './pngHdr.ts';
import { exifIsUpright } from './exifOrientation.ts';
export type CleanPng = {bytes:Uint8Array;width:number;height:number;hasAlpha:boolean;removedChunks:string[];hdr?:'pq'|'hlg'};

// Pixel/transparency chunks and validated HDR code points are the only allowed
// payloads. SDR exports are converted to sRGB before this container check.
const SIGNATURE=new Uint8Array([137,80,78,71,13,10,26,10]);
const MAX_BYTES=20*1024*1024,MAX_PIXELS=16000000,MAX_CHUNKS=4096;
const DEPTHS:Record<number,readonly number[]>={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
type Header={width:number;height:number;color:number;depth:number};
type Chunk={type:string;data:Uint8Array;encoded:Uint8Array;end:number};
type State={header:Header|null;palette:number;transparent:boolean;dataBytes:number;dataSeen:boolean;dataClosed:boolean;ended:boolean;hdr?:'pq'|'hlg';colorChunks:Set<string>};

const CRC_TABLE=Uint32Array.from({length:256},(_,value)=>{
  let crc=value;for(let bit=0;bit<8;bit++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;return crc>>>0;
});
const u32=(bytes:Uint8Array,offset:number)=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(offset,false);
const fail=(message:string):never=>{throw new Error(message);};

function crc32(bytes:Uint8Array):number {
  let crc=0xffffffff;for(const byte of bytes)crc=CRC_TABLE[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;
}

function readChunk(bytes:Uint8Array,offset:number):Chunk {
  if(bytes.length-offset<12)fail('PNG обрезан: нет полного блока.');
  const length=u32(bytes,offset),end=offset+length+12;
  if(end>bytes.length)fail('Неверная длина или обрезанный блок PNG.');
  const type=String.fromCharCode(...bytes.subarray(offset+4,offset+8));
  if(!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type))fail('Неверный тип блока PNG.');
  if(crc32(bytes.subarray(offset+4,end-4))!==u32(bytes,end-4))fail('Контрольная сумма CRC изображения не совпадает.');
  return {type,data:bytes.subarray(offset+8,end-4),encoded:bytes.subarray(offset,end),end};
}

function readHeader(data:Uint8Array):Header {
  if(data.length!==13)fail('Неверный заголовок IHDR.');
  const width=u32(data,0),height=u32(data,4),depth=data[8],color=data[9];
  validateDimensions(width,height);
  if(!DEPTHS[color]?.includes(depth))fail('Неподдерживаемые цвет и глубина PNG.');
  if(data[10]!==0||data[11]!==0||data[12]>1)fail('Неподдерживаемый метод кодирования PNG.');
  return {width,height,color,depth};
}

function validateDimensions(width:number,height:number):void {
  if(width<1||height<1||width>20000||height>20000||width*height>MAX_PIXELS)fail('Размер PNG превышает допустимое число пикселей.');
}

function acceptHeader(state:State,chunk:Chunk):void {
  if(state.header)fail('Заголовок IHDR повторяется.');
  state.header=readHeader(chunk.data);
}

function acceptPalette(state:State,chunk:Chunk):void {
  if(state.dataSeen||state.palette||state.transparent)fail('Неверный порядок или повтор PLTE.');
  state.palette=paletteEntries(chunk.data,state.header!);
}

function paletteEntries(data:Uint8Array,header:Header):number {
  const size=data.length,color=header.color;
  if(size<3||size>768||size%3!==0)fail('Неверная длина палитры PLTE.');
  if(color===0||color===4)fail('Палитра PLTE недопустима для серого изображения.');
  const entries=size/3;
  if(color===3&&entries>2**header.depth)fail('Палитра PLTE не соответствует глубине цвета.');
  return entries;
}

function acceptTransparency(state:State,chunk:Chunk):void {
  if(state.dataSeen||state.transparent)fail('Неверный порядок или повтор tRNS.');
  const color=state.header!.color,length=chunk.data.length;
  const valid=color===0?length===2:color===2?length===6:color===3&&length>0&&length<=state.palette;
  if(!valid)fail('Блок прозрачности tRNS несовместим с изображением.');
  state.transparent=true;
}

function acceptPixels(state:State,chunk:Chunk):void {
  if(state.dataClosed)fail('Блоки IDAT должны идти подряд.');
  if(state.header!.color===3&&!state.palette)fail('Для индексного PNG нужна палитра PLTE.');
  state.dataSeen=true;state.dataBytes+=chunk.data.length;
}

function acceptEnd(state:State,chunk:Chunk):void {
  if(chunk.data.length!==0)fail('Неверная длина завершающего блока IEND.');
  if(!state.dataBytes)fail('В PNG нет данных изображения IDAT.');
  state.ended=true;
}

const REQUIRED:Record<string,(state:State,chunk:Chunk)=>void>={IHDR:acceptHeader,PLTE:acceptPalette,tRNS:acceptTransparency,IDAT:acceptPixels,IEND:acceptEnd};

function acceptHdr(state:State,chunk:Chunk):boolean {
  if(state.dataSeen||state.palette||state.colorChunks.has(chunk.type))fail(`Неверный порядок или повтор HDR ${chunk.type}.`);
  state.colorChunks.add(chunk.type);
  const hdr=inspectPngHdrChunk(chunk.type,chunk.data);
  if(chunk.type==='cICP'){state.hdr=hdr;return !!hdr;}
  return true;
}

function acceptChunk(state:State,chunk:Chunk):boolean {
  if(!state.header&&chunk.type!=='IHDR')fail('Первым должен быть заголовок IHDR.');
  if(state.dataSeen&&chunk.type!=='IDAT')state.dataClosed=true;
  const accept=REQUIRED[chunk.type];
  if(accept){accept(state,chunk);return true;}
  if(['cICP','mDCV','cLLI'].includes(chunk.type))return acceptHdr(state,chunk);
  if(['acTL','fcTL','fdAT'].includes(chunk.type))fail('Анимация APNG не поддерживается в редакторе статических фото.');
  if((chunk.type.charCodeAt(0)&32)===0)fail('Неизвестный обязательный блок PNG.');
  return false;
}

function joinParts(parts:Uint8Array[]):Uint8Array {
  const output=new Uint8Array(parts.reduce((size,part)=>size+part.length,0));
  let offset=0;for(const part of parts){output.set(part,offset);offset+=part.length;}return output;
}

function collectChunks(bytes:Uint8Array):{header:Header;transparent:boolean;parts:Uint8Array[];removedChunks:string[];hdr?:'pq'|'hlg'} {
  const state:State={header:null,palette:0,transparent:false,dataBytes:0,dataSeen:false,dataClosed:false,ended:false,colorChunks:new Set()};
  const parts:Uint8Array[]=[SIGNATURE],removedChunks:string[]=[],exif:Uint8Array[]=[];
  let offset=SIGNATURE.length,count=0;
  while(offset<bytes.length){
    if(++count>MAX_CHUNKS)fail('Слишком много блоков PNG.');
    const chunk=readChunk(bytes,offset);
    if(chunk.type==='eXIf')exif.push(chunk.data);
    if(acceptChunk(state,chunk))parts.push(chunk.encoded);else removedChunks.push(chunk.type);
    offset=chunk.end;
    if(state.ended&&offset!==bytes.length)fail('Обнаружены лишние данные после конца PNG.');
  }
  const header=state.header;
  if(!state.ended||!header)return fail('PNG не завершён блоком IEND.');
  validateHdrState(state,exif);
  return {header,transparent:state.transparent,parts,removedChunks,hdr:state.hdr};
}

function validateHdrState(state:State,exif:Uint8Array[]):void {
  if(!state.hdr&&(state.colorChunks.has('mDCV')||state.colorChunks.has('cLLI')))fail('Данные HDR требуют подтверждённого cICP PQ/HLG.');
  if(state.hdr&&(exif.length>1||!exif.every(exifIsUpright)))fail('Ориентация HDR PNG требует отдельной обработки без потери HDR.');
}

// This validates the PNG container, not its deflate stream or hidden pixel data.
// SDR processing must decode/re-encode first. Validated HDR PNG can be copied
// without pixel conversion; this is not a detector for hidden pixel information.
export function sanitizePng(bytes:Uint8Array):CleanPng {
  if(bytes.length>MAX_BYTES)fail('PNG больше 20 МБ. Выбери меньшее разрешение.');
  if(!SIGNATURE.every((byte,index)=>bytes[index]===byte))fail('Файл не является PNG.');
  const {header,transparent,parts,removedChunks,hdr}=collectChunks(bytes);
  const {width,height,color}=header;
  return {bytes:joinParts(parts),width,height,hasAlpha:color===4||color===6||transparent,removedChunks,...(hdr?{hdr}:{})};
}

/** Routing hint only; a true result still requires full sanitation below. */
export function containsHdrPng(bytes:Uint8Array):boolean {
  if(!SIGNATURE.every((byte,index)=>bytes[index]===byte))return false;
  let offset=SIGNATURE.length,count=0;
  while(offset<bytes.length){
    if(++count>MAX_CHUNKS)fail('Слишком много блоков PNG.');
    const chunk=readChunk(bytes,offset);offset=chunk.end;
    if(chunk.type==='cICP'&&inspectPngHdrChunk(chunk.type,chunk.data))return true;
    if(chunk.type==='IDAT'||chunk.type==='IEND')return false;
  }
  return false;
}
