import { isoView, mp4Fail, need, tableCount, type IsoBox } from './mp4Boxes.ts';
export type SampleTable={sizes?:IsoBox;chunks?:IsoBox;runs?:IsoBox;timing?:IsoBox;composition?:IsoBox;sync?:IsoBox;dependencies?:IsoBox};
export type ByteRange={start:number;end:number};

function validSampleSize(size:number):void {
  if(size===0||size>20*1024*1024)mp4Fail('неверный размер образца.');
}

function sampleSizes(bytes:Uint8Array,box:IsoBox):number[] {
  need(box,12);const view=isoView(bytes),size=view.getUint32(box.data+4),count=view.getUint32(box.data+8);
  if(!count||count>1000000)mp4Fail('неверное число образцов видео.');
  need(box,12+(size?0:count*4),true);
  const sizes=Array.from({length:count},(_,index)=>size||view.getUint32(box.data+12+index*4));
  sizes.forEach(validSampleSize);
  return sizes;
}

function chunkOffsets(bytes:Uint8Array,box:IsoBox):number[] {
  const stride=box.type==='co64'?8:4,count=tableCount(bytes,box,stride),view=isoView(bytes);
  return Array.from({length:count},(_,index)=>{
    const at=box.data+8+index*stride;
    if(stride===8&&view.getUint32(at)!==0)return mp4Fail('offset не помещается в файл.');
    return view.getUint32(at+stride-4);
  });
}

type Run={first:number;samples:number};
function readSampleRun(view:DataView,offset:number,previous:number,chunkCount:number):Run {
  const first=view.getUint32(offset),samples=view.getUint32(offset+4),description=view.getUint32(offset+8);
  if(first>chunkCount||first<=previous)mp4Fail('неверный порядок таблицы stsc.');
  if(!samples||samples>1000000||description!==1)mp4Fail('неверное описание образцов stsc.');
  return {first,samples};
}

function sampleRuns(bytes:Uint8Array,box:IsoBox,chunkCount:number):Run[] {
  const count=tableCount(bytes,box,12),view=isoView(bytes),runs:Run[]=[];
  for(let index=0;index<count;index++){
    const at=box.data+8+index*12;
    runs.push(readSampleRun(view,at,runs.at(-1)?.first||0,chunkCount));
  }
  if(runs[0]?.first!==1)mp4Fail('нет начального блока stsc.');
  return runs;
}

function sizesInChunk(sizes:number[],first:number,count:number):number {
  if(first+count>sizes.length)mp4Fail('таблицы образцов не совпадают.');
  let size=0;for(let index=first;index<first+count;index++)size+=sizes[index];return size;
}

function timedSamples(bytes:Uint8Array,box:IsoBox,expected:number):void {
  const count=tableCount(bytes,box,8),view=isoView(bytes);let total=0;
  for(let index=0;index<count;index++){
    const at=box.data+8+index*8,samples=view.getUint32(at);
    if(!samples||total+samples>expected)mp4Fail(`неверное число образцов в ${box.type}.`);
    if(box.type==='stts'&&!view.getUint32(at+4))mp4Fail('нулевая длительность образца stts.');
    total+=samples;
  }
  if(total!==expected)mp4Fail(`таблица ${box.type} не соответствует числу образцов.`);
}

function validateSync(bytes:Uint8Array,box:IsoBox,expected:number):void {
  const count=tableCount(bytes,box,4),view=isoView(bytes);let previous=0;
  for(let index=0;index<count;index++){
    const sample=view.getUint32(box.data+8+index*4);
    if(sample<=previous||sample>expected)mp4Fail('неверный синхрообразец stss.');previous=sample;
  }
}

function validateDependencies(bytes:Uint8Array,box:IsoBox,expected:number):void {
  need(box,4+expected,true);
  for(let offset=box.data+4;offset<box.end;offset++){
    const value=bytes[offset];
    if((value&192)!==0||((value>>4)&3)===3||((value>>2)&3)===3||(value&3)===3)mp4Fail('неверные биты зависимостей sdtp.');
  }
}

function validateSampleTables(bytes:Uint8Array,table:SampleTable,count:number):void {
  if(!table.timing)return mp4Fail('нет обязательной таблицы stts.');
  timedSamples(bytes,table.timing,count);
  if(table.composition)timedSamples(bytes,table.composition,count);
  if(table.sync)validateSync(bytes,table.sync,count);
  if(table.dependencies)validateDependencies(bytes,table.dependencies,count);
}

export function sampleRanges(bytes:Uint8Array,table:SampleTable):ByteRange[] {
  const {sizes:sizesBox,chunks:chunksBox,runs:runsBox}=table;
  if(!sizesBox||!chunksBox||!runsBox)return mp4Fail('неполная таблица видеоданных.');
  const sizes=sampleSizes(bytes,sizesBox),offsets=chunkOffsets(bytes,chunksBox),runs=sampleRuns(bytes,runsBox,offsets.length),ranges:ByteRange[]=[];
  validateSampleTables(bytes,table,sizes.length);
  let run=0,sample=0;
  for(let index=0;index<offsets.length;index++){
    if(run+1<runs.length&&index+1>=runs[run+1].first)run++;
    const count=runs[run].samples,size=sizesInChunk(sizes,sample,count);sample+=count;
    ranges.push({start:offsets[index],end:offsets[index]+size});
  }
  if(sample!==sizes.length)mp4Fail('часть образцов не привязана к файлу.');
  return ranges;
}

/** Removes unreferenced padding too; absolute chunk positions do not change. */
export function cleanMediaGaps(bytes:Uint8Array,mdats:IsoBox[],ranges:ByteRange[]):void {
  const sorted=[...ranges].sort((a,b)=>a.start-b.start);
  let index=0;
  for(const box of mdats){
    let cursor=box.data;
    while(index<sorted.length&&sorted[index].start<box.end){
      const range=sorted[index++];
      if(range.start<box.data||range.end>box.end)mp4Fail('offset образца выходит за пределы видеоданных.');
      if(range.start<cursor)mp4Fail('области видеоданных пересекаются.');
      bytes.fill(0,cursor,range.start);cursor=range.end;
    }
    bytes.fill(0,cursor,box.end);
  }
  if(index!==sorted.length)mp4Fail('offset образца выходит за пределы видеоданных.');
}
