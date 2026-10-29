type Frame={width:number;height:number};
type Segment={marker:number;start:number;end:number;payload:Uint8Array};
const MAX_BYTES=20*1024*1024;
const SOF=new Set([0xc0,0xc1,0xc2]);
const TABLES=new Set([0xc4,0xdb,0xdd]);
const fail=(reason:string):never=>{throw new Error(`JPEG: ${reason}`);};
const u16=(bytes:Uint8Array,offset:number)=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint16(offset);

function segmentAt(bytes:Uint8Array,offset:number):Segment {
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

function readFrame(segment:Segment):Frame {
  const data=segment.payload;
  if(data[0]!==8||![1,3].includes(data[5])||data.length!==6+data[5]*3)fail('неподдерживаемый заголовок кодирования.');
  const height=u16(data,1),width=u16(data,3);
  validateFrameSize(width,height);
  return {width,height};
}

function validateFrameSize(width:number,height:number):void {
  if(!width||!height||width>20000||height>20000||width*height>16000000)fail('размер превышает предел пикселей.');
}

function checkMetadata(data:Uint8Array):void {
  const text=new TextDecoder().decode(data);
  if(/hdrgm:|HDRGainMap|HDRCapacity|urn:iso:std:iso:ts:21496/i.test(text))fail('HDR gainmap нельзя удалить и незаметно преобразовать в SDR.');
}

function entropyEnd(bytes:Uint8Array,start:number):number {
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

function checkScan(data:Uint8Array):void {
  const components=data[0];
  if(![1,2,3].includes(components)||data.length!==1+components*2+3)fail('неверный заголовок сканирования.');
}

function joined(parts:Uint8Array[]):Uint8Array {
  const result=new Uint8Array(parts.reduce((size,part)=>size+part.length,0));let offset=0;
  for(const part of parts){result.set(part,offset);offset+=part.length;}
  return result;
}

type State={frame:Frame|null;scan:boolean;end:boolean;parts:Uint8Array[]};
const isMetadata=(marker:number)=>(marker>=0xe0&&marker<=0xef)||marker===0xfe;
function collectSegment(state:State,segment:Segment,bytes:Uint8Array):number {
  const {marker}=segment;
  if(marker===0xd9){state.end=true;state.parts.push(bytes.subarray(segment.start,segment.end));return segment.end;}
  if(isMetadata(marker)){checkMetadata(segment.payload);return segment.end;}
  if(SOF.has(marker)){
    if(state.frame)fail('повторный заголовок кадра.');
    state.frame=readFrame(segment);
  }else if(!TABLES.has(marker)&&marker!==0xda)fail('неподдерживаемый маркер кодирования.');
  state.parts.push(bytes.subarray(segment.start,segment.end));
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
