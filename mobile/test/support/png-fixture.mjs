import { crc32, deflateSync } from 'node:zlib';

export const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
export function pngChunk(type,data=Buffer.alloc(0)) {
  const name=Buffer.from(type,'ascii'),length=Buffer.alloc(4),checksum=Buffer.alloc(4);
  length.writeUInt32BE(data.length);checksum.writeUInt32BE(crc32(Buffer.concat([name,data])));
  return Buffer.concat([length,name,data,checksum]);
}
export function pngFixture({width=1,height=1,color=6,depth=8,before=[],after=[],pixels=Buffer.from([0,20,40,60,127]),end=true}={}) {
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=depth;header[9]=color;
  return Buffer.concat([pngSignature,pngChunk('IHDR',header),...before,pngChunk('IDAT',deflateSync(pixels)),...after,...(end?[pngChunk('IEND')]:[])]);
}
export function readPngChunks(bytes) {
  const data=Buffer.from(bytes),chunks=[];
  for(let i=8;i<data.length;) {
    const length=data.readUInt32BE(i),type=data.toString('ascii',i+4,i+8);
    chunks.push({type,data:data.subarray(i+8,i+8+length)});i+=12+length;
  }
  return chunks;
}
