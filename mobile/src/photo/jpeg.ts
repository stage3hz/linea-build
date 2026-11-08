export type Frame={width:number;height:number};
export type Segment={marker:number;start:number;end:number;payload:Uint8Array};
const MAX_BYTES=20*1024*1024;
export const SOF=new Set([0xc0,0xc1,0xc2]);
export const TABLES=new Set([0xc4,0xdb,0xdd]);
const fail=(reason:string):never=>{throw new Error(`JPEG: ${reason}`);};
const u16=(bytes:Uint8Array,offset:number)=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint16(offset);

export function segmentAt(bytes:Uint8Array,offset:number):Segment {
  const start=offset;
  if(bytes[offset]!==255)fail('нет маркера сегмента.');
  while(bytes[offset]===255)offset++;
  const marker=bytes[offset++];
  if(marker===0xd9)return {marker,start,end:offset,payload:new Uint8Array()};
  if(offset+2>bytes.length)fail('обрезан заголовок.');
  const length=u16(bytes,offset),end=offset+length;
  if(length<2||end>bytes.length)fail('неверная длина сегмента.');
  return {marker,start,end,payload:bytes.subarray(offset+2,end)};
}

export function readFrame(segment:Segment):Frame {
  const data=segment.payload;
  if(data[0]!==8||![1,3].includes(data[5])||data.length!==6+data[5]*3)fail('неподдерживаемый заголовок кодирования.');
  const height=u16(data,1),width=u16(data,3);
  validateFrameSize(width,height);
  return {width,height};
}

function validateFrameSize(width:number,height:number):void {
  if(!width||!height||width>20000||height>20000||width*height>16000000)fail('размер превышает предел пикселей.');
}

/** Markers of a gain map (Ultra HDR, ISO 21496-1, Apple). */
export const GAINMAP_MARKER=/hdrgm:|HDRGainMap|HDRCapacity|urn:iso:std:iso:ts:21496/i;

function checkMetadata(data:Uint8Array):void {
  const text=new TextDecoder().decode(data);
  if(GAINMAP_MARKER.test(text))fail('HDR gainmap нельзя удалить и незаметно преобразовать в SDR.');
}

export function entropyEnd(bytes:Uint8Array,start:number):number {
  let offset=start;
  while(offset<bytes.length){
    if(bytes[offset++]!==255)continue;
    const markerStart=offset-1;
    while(bytes[offset]===255)offset++;
    const marker=bytes[offset];
    if(marker===0||marker>=0xd0&&marker<=0xd7){offset++;continue;}
    return markerStart;
  }
  return fail('не найден конец данных изображения.');
}

/** Segment bytes with fill bytes (repeated 0xFF before the marker) removed: nothing hidden in padding is copied. */
export function segmentBytes(bytes:Uint8Array,segment:Segment):Uint8Array {
  let at=segment.start;
  while(bytes[at+1]===255)at++;
  if(at===segment.start)return bytes.subarray(segment.start,segment.end);
  return joined([new Uint8Array([255]),bytes.subarray(at+1,segment.end)]);
}

/** DQT, DHT and DRI must be exactly their tables: no trailing bytes travel inside them. */
export function checkTables(segment:Segment):void {
  const data=segment.payload;
  if(segment.marker===0xdd){if(data.length!==2)fail('неверная длина DRI.');return;}
  let at=0;
  if(!data.length)fail('пустая таблица.');
  while(at<data.length){
    if(segment.marker===0xdb){
      const precision=data[at]>>4,id=data[at]&15;
      if(precision>1||id>3)fail('неверная таблица квантования.');
      at+=1+64*(precision?2:1);
    }else{
      const kind=data[at]>>4,id=data[at]&15;
      if(kind>1||id>3||at+17>data.length)fail('неверная таблица Хаффмана.');
      let count=0;for(let i=1;i<=16;i++)count+=data[at+i];
      if(count>256)fail('неверная таблица Хаффмана.');
      at+=17+count;
    }
  }
  if(at!==data.length)fail('лишние байты в таблице.');
}

export function checkScan(data:Uint8Array):void {
  const components=data[0];
  if(![1,2,3].includes(components)||data.length!==1+components*2+3)fail('неверный заголовок сканирования.');
}

export function joined(parts:Uint8Array[]):Uint8Array {
  const result=new Uint8Array(parts.reduce((size,part)=>size+part.length,0));let offset=0;
  for(const part of parts){result.set(part,offset);offset+=part.length;}
  return result;
}

type State={frame:Frame|null;scan:boolean;end:boolean;parts:Uint8Array[]};
export const isMetadata=(marker:number)=>(marker>=0xe0&&marker<=0xef)||marker===0xfe;
function collectSegment(state:State,segment:Segment,bytes:Uint8Array):number {
  const {marker}=segment;
  if(marker===0xd9){state.end=true;state.parts.push(segmentBytes(bytes,segment));return segment.end;}
  if(isMetadata(marker)){checkMetadata(segment.payload);return segment.end;}
  if(SOF.has(marker)){
    if(state.frame)fail('повторный заголовок кадра.');
    state.frame=readFrame(segment);
  }else if(TABLES.has(marker))checkTables(segment);
  else if(marker!==0xda)fail('неподдерживаемый маркер кодирования.');
  state.parts.push(segmentBytes(bytes,segment));
  if(marker!==0xda)return segment.end;
  return collectScan(state,segment,bytes);
}

function collectScan(state:State,segment:Segment,bytes:Uint8Array):number {
  if(!state.frame)fail('сканирование до заголовка кадра.');
  checkScan(segment.payload);state.scan=true;
  const end=entropyEnd(bytes,segment.end);
  if(end===segment.end)fail('пустые данные изображения.');
  state.parts.push(bytes.subarray(segment.end,end));return end;
}

function completeFrame(state:State,offset:number,length:number):Frame {
  const frame=state.frame;
  if(!frame||!state.scan||!state.end||offset!==length)return fail('файл не завершён или содержит данные после конца.');
  return frame;
}

/** Metadata gate for freshly encoded SDR JPEG; not an HDR decoder or steganography detector. */
export function sanitizeJpeg(bytes:Uint8Array):{bytes:Uint8Array;width:number;height:number} {
  if(bytes.length>MAX_BYTES)fail('файл больше 20 МиБ.');
  if(bytes[0]!==255||bytes[1]!==0xd8)fail('нет начальной сигнатуры.');
  const state:State={frame:null,scan:false,end:false,parts:[bytes.subarray(0,2)]};
  let offset=2,count=0;
  while(offset<bytes.length&&!state.end){
    if(++count>4096)fail('слишком много сегментов.');
    offset=collectSegment(state,segmentAt(bytes,offset),bytes);
  }
  const frame=completeFrame(state,offset,bytes.length);
  return {bytes:joined(state.parts),width:frame.width,height:frame.height};
}
