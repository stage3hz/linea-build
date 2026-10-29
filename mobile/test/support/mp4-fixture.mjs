export function atom(type,...parts){const data=Buffer.concat(parts);const out=Buffer.alloc(8+data.length);out.writeUInt32BE(out.length);out.write(type,4,'latin1');data.copy(out,8);return out;}
export const full=(type,data=Buffer.alloc(0),version=0)=>atom(type,Buffer.from([version,0,0,0]),data);
const integers=(...numbers)=>{const result=Buffer.alloc(numbers.length*4);numbers.forEach((n,i)=>result.writeUInt32BE(n,i*4));return result;};
export function mp4Fixture({hdr='sdr',external=false,privateTrack=false,offsetDelta=0,metadata=true,privateGap=true,codec='avc1'}={}){
  const ftyp=atom('ftyp',Buffer.from('isom'),integers(512),Buffer.from('isommp42'));
  const sample=Buffer.from([0,0,0,3,0x65,0x88,0x84]);
  const gap=privateGap?Buffer.from('private unused media bytes'):Buffer.alloc(0);
  const mdat=atom('mdat',gap,sample,sample,gap);
  const start=ftyp.length+8+gap.length+offsetDelta;
  const mvhd=Buffer.alloc(100);mvhd.writeUInt32BE(3456789,4);mvhd.writeUInt32BE(3456799,8);mvhd.writeUInt32BE(1000,12);mvhd.writeUInt32BE(2000,16);
  const tkhd=Buffer.alloc(84);tkhd.writeUInt32BE(1234567,4);tkhd.writeUInt32BE(1234568,8);tkhd.writeUInt32BE(1,12);tkhd.writeUInt32BE(2000,20);tkhd.writeUInt32BE(2<<16,76);tkhd.writeUInt32BE(2<<16,80);
  const mdhd=Buffer.alloc(24);mdhd.writeUInt32BE(987654,4);mdhd.writeUInt32BE(987655,8);mdhd.writeUInt32BE(1000,12);mdhd.writeUInt32BE(2000,16);mdhd.writeUInt16BE(1234,20);
  const hdlr=Buffer.alloc(24);hdlr.write(privateTrack?'meta':'vide',8);const handler=atom('hdlr',hdlr,Buffer.from('private device handler\0'));
  const visual=Buffer.alloc(78);visual.writeUInt16BE(1,6);visual.writeUInt16BE(2,24);visual.writeUInt16BE(2,26);visual.writeUInt16BE(1,40);visual[42]=20;visual.write('private camera model',43);visual.writeUInt16BE(24,74);visual.writeInt16BE(-1,76);
  const color=Buffer.alloc(11);color.write('nclx');color.writeUInt16BE(9,4);color.writeUInt16BE(hdr==='pq'?16:hdr==='hlg'?18:1,6);color.writeUInt16BE(9,8);color[10]=128;
  const codecBox=codec==='hvc1'?atom('hvcC',Buffer.alloc(23,1)):atom('avcC',Buffer.from([1,66,0,30,255,225,0,2,0x67,0,1,0,2,0x68,0]));
  const entry=atom(codec,visual,codecBox,atom('colr',color));
  const stsd=full('stsd',integers(1),0);const stsdBox=atom('stsd',Buffer.alloc(4),integers(1),entry);
  const stbl=atom('stbl',stsdBox,full('stts',integers(1,2,1000)),full('stsc',integers(1,1,2,1)),full('stsz',integers(0,2,sample.length,sample.length)),full('stco',integers(1,start)));
  const dataRef=full('dref',Buffer.concat([integers(1),atom('url ',Buffer.from([0,0,0,external?0:1]),...(external?[Buffer.from('https://private.example/video')]:[]))]));
  const minf=atom('minf',full('vmhd',Buffer.alloc(8)),atom('dinf',dataRef),stbl);
  const trak=atom('trak',atom('tkhd',tkhd),atom('mdia',atom('mdhd',mdhd),handler,minf));
  const metadataBox=metadata?atom('udta',atom('meta',Buffer.from('private GPS camera author creation location'))):Buffer.alloc(0);
  return {bytes:Buffer.concat([ftyp,mdat,atom('moov',atom('mvhd',mvhd),trak,metadataBox)]),sample,start,gap};
}
