const fail=(type:string):never=>{throw new Error(`Некорректные данные HDR ${type}.`);};
const view=(data:Uint8Array)=>new DataView(data.buffer,data.byteOffset,data.byteLength);
const PRIMARIES=new Set([1,4,5,6,7,8,9,10,11,12,22]);

function codePoints(data:Uint8Array):'pq'|'hlg'|undefined {
  if(data.length!==4||data[2]!==0||data[3]>1)fail('cICP');
  if(data[1]!==16&&data[1]!==18)return undefined;
  if(!PRIMARIES.has(data[0]))fail('cICP');
  return data[1]===16?'pq':'hlg';
}

function masteringDisplay(data:Uint8Array):void {
  if(data.length!==24)fail('mDCV');
  const numbers=view(data);
  for(let offset=0;offset<16;offset+=4){
    const x=numbers.getUint16(offset),y=numbers.getUint16(offset+2);
    // Unsigned coordinates are nonnegative; the sum bounds each coordinate too.
    if(x+y>50000)fail('mDCV');
  }
  if(numbers.getUint32(16)<=numbers.getUint32(20))fail('mDCV');
}

function contentLight(data:Uint8Array):void {
  if(data.length!==8)fail('cLLI');
  const numbers=view(data),maximum=numbers.getUint32(0),average=numbers.getUint32(4);
  if(maximum!==0&&average>maximum)fail('cLLI');
}

/** W3C PNG 3 sections 11.3.2.6–8; no XML, ICC text, dates or private payloads. */
export function inspectPngHdrChunk(type:string,data:Uint8Array):'pq'|'hlg'|undefined {
  if(type==='cICP')return codePoints(data);
  if(type==='mDCV')masteringDisplay(data);
  else contentLight(data);
  return undefined;
}
