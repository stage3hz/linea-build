// Synthetic containers for the streamed metadata cleaner (MP4/MOV plain, 64-bit, fragmented; MKV; AVI; GIF).
import { atom, full } from './mp4-fixture.mjs';
export const be32=(...n)=>{const b=Buffer.alloc(n.length*4);n.forEach((v,i)=>b.writeUInt32BE(v,i*4));return b;};
export const be64=v=>{const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(v));return b;};
export const GPS='+48.8577+002.2945/GPS-SECRET';

/** AVC sample: SEI (user data unregistered carrying `secret`, with an emulation-prevention byte) + recovery point SEI + IDR slice. */
export function avcSample(secret=GPS){
  const payload=Buffer.concat([Buffer.alloc(16,0x11),Buffer.from([0,0,3,1]),Buffer.from(secret)]); // escaped bytes; RBSP is one byte shorter
  const rbspSize=payload.length-1;
  const sei=Buffer.concat([Buffer.from([0x06,5,rbspSize]),payload,Buffer.from([6,2,0x84,0x10]),Buffer.from([0x80])]);
  const slice=Buffer.from([0x65,0x88,0x84,0x21,0xa0,0x55,0x66]);
  return Buffer.concat([be32(sei.length),sei,be32(slice.length),slice]);
}

function stbl(entry,sizes,offsets,{co64=false}={}){
  return atom('stbl',full('stsd',Buffer.concat([be32(1),entry])),full('stts',be32(1,Math.max(1,sizes.length),1000)),
    full('stsc',sizes.length?be32(1,1,1,1):be32(0)),full('stsz',Buffer.concat([be32(0,sizes.length),...sizes.map(s=>be32(s))])),
    co64?full('co64',Buffer.concat([be32(offsets.length),...offsets.map(be64)])):full('stco',be32(offsets.length,...offsets)));
}
function tkhd(id,w=1920,h=1080){const b=Buffer.alloc(84);b.writeUInt32BE(1234567,4);b.writeUInt32BE(1234568,8);b.writeUInt32BE(id,12);b.writeUInt32BE(0x10000,40);b.writeUInt32BE(0x10000,56);b.writeUInt32BE(0x40000000,72);b.writeUInt32BE(w<<16>>>0,76);b.writeUInt32BE(h<<16>>>0,80);return atom('tkhd',b);}
function mdhd(){const b=Buffer.alloc(24);b.writeUInt32BE(987654,4);b.writeUInt32BE(987655,8);b.writeUInt32BE(1000,12);b.writeUInt32BE(2000,16);b.writeUInt16BE(0x15c7,20);return atom('mdhd',b);}
function hdlr(kind,name){const b=Buffer.alloc(24);b.write(kind,8);return atom('hdlr',b,Buffer.from(name+'\0'));}
const dinf=()=>atom('dinf',full('dref',Buffer.concat([be32(1),full('url ',Buffer.from('file:///Users/alice/private.mov'))])));
export function avcEntry(){
  const v=Buffer.alloc(78);v.writeUInt16BE(1,6);v.write('appl',12);v.writeUInt16BE(1920,24);v.writeUInt16BE(1080,26);v.writeUInt16BE(1,40);v[42]=12;v.write('GoPro AVC HERO',43);v.writeUInt16BE(24,74);v.writeInt16BE(-1,76);
  return atom('avc1',v,atom('avcC',Buffer.from([1,100,0,40,0xff,0xe1,0,2,0x67,0,1,0,2,0x68,0])),atom('uuid',Buffer.from('XMP SERIAL C3331324531')));
}
export function videoTrak(sizes,offsets,options={}){
  return atom('trak',tkhd(1),atom('mdia',mdhd(),hdlr('vide','GoPro AVC  '),atom('minf',full('vmhd',Buffer.alloc(8)),dinf(),stbl(avcEntry(),sizes,offsets,options))),atom('udta',Buffer.from('trak level '+GPS)));
}
export function gpsTrak(sizes,offsets,options={}){
  const entry=atom('gpmd',Buffer.alloc(8,0));
  return atom('trak',tkhd(2,0,0),atom('mdia',mdhd(),hdlr('meta','GoPro MET'),atom('minf',full('nmhd'),dinf(),stbl(entry,sizes,offsets,options))));
}
export function mvhd(){const b=Buffer.alloc(100);b.writeUInt32BE(3456789,4);b.writeUInt32BE(3456799,8);b.writeUInt32BE(1000,12);b.writeUInt32BE(2000,16);return atom('mvhd',b);}
export const udta=()=>atom('udta',atom('\xa9xyz',Buffer.from(GPS)),atom('meta',Buffer.from('com.apple.quicktime.location.ISO6709 '+GPS+' make Apple model iPhone 15 Pro')));
export const ftyp=(major='isom')=>atom('ftyp',Buffer.from(major),be32(512),Buffer.from('isomMSNV'));

/** Plain MP4 above 20 MiB: ftyp, mdat (gap, video samples, telemetry samples), moov at the end. */
export function bigMp4({gap=21*1024*1024,prefix=Buffer.alloc(0)}={}){
  const head=Buffer.concat([prefix,ftyp()]),video=[avcSample(),avcSample('second-frame-'+GPS)],gps=[Buffer.from('GPMF '+GPS),Buffer.from('GPMF 2 '+GPS)];
  const gapBytes=Buffer.alloc(gap);gapBytes.write('private padding '+GPS,Math.min(100,gap-45));
  const parts=[gapBytes,video[0],gps[0],video[1],gps[1]];
  const mdatData=Buffer.concat(parts),mdat=atom('mdat',mdatData);
  let at=head.length+8+gap;const vOff=[],gOff=[];
  vOff.push(at);at+=video[0].length;gOff.push(at);at+=gps[0].length;vOff.push(at);at+=video[1].length;gOff.push(at);
  const moov=atom('moov',mvhd(),videoTrak(video.map(v=>v.length),vOff),gpsTrak(gps.map(g=>g.length),gOff),udta());
  return {bytes:Buffer.concat([head,mdat,moov]),video,gps,vOff,gOff};
}

/** Fragmented MP4: init (moov with mvex/trex and empty tables), one moof with a video and a telemetry traf, mdat. */
export function fragmentedMp4(){
  const video=[avcSample(),avcSample('frag-'+GPS)],gps=[Buffer.from('GPMF fragment '+GPS)];
  const trex=id=>full('trex',be32(id,1,0,0,0));
  const moov=atom('moov',mvhd(),videoTrak([],[]),gpsTrak([],[]),atom('mvex',full('mehd',be32(5000)),trex(1),trex(2)),udta());
  const head=Buffer.concat([ftyp('iso6'),moov]);
  const trun=(sizes,offset)=>atom('trun',Buffer.from([0,0,0x02,0x01]),be32(sizes.length,offset),...sizes.map(s=>be32(s)));
  const build=(o1,o2)=>{
    const traf1=atom('traf',full('tfhd',be32(1)),full('tfdt',be32(0)),trun(video.map(v=>v.length),o1));
    const traf2=atom('traf',full('tfhd',be32(2)),trun(gps.map(g=>g.length),o2),atom('meta',Buffer.from(GPS)));
    return atom('moof',full('mfhd',be32(1)),traf1,traf2);
  };
  // tfhd flags 0 → default-base-is-moof semantics for the first traf (moof start); data_offset is relative to it.
  let moof=build(0,0);const dataStart=moof.length+8,videoBytes=video[0].length+video[1].length;
  // second traf base = end of first traf data; its offset is relative to that.
  moof=build(dataStart,0);
  const mdat=atom('mdat',...video,...gps);
  return {bytes:Buffer.concat([head,moof,mdat]),video,gps,videoStart:head.length+dataStart,gpsStart:head.length+dataStart+videoBytes};
}

// ---- Matroska ----
const vint=(n,len)=>{const b=Buffer.alloc(len);let v=n;for(let i=len-1;i>=0;i--){b[i]=v%256;v=Math.floor(v/256);}b[0]|=0x80>>(len-1);return b;};
const idBytes=id=>{const out=[];let v=id;while(v>0){out.unshift(v&255);v=Math.floor(v/256);}return Buffer.from(out);};
export const ebml=(id,...parts)=>{const data=Buffer.concat(parts);return Buffer.concat([idBytes(id),vint(data.length,8),data]);};
export function mkv(){
  const header=ebml(0x1a45dfa3,ebml(0x4282,Buffer.from('matroska')));
  const info=ebml(0x1549a966,ebml(0x2ad7b1,Buffer.from([0x0f,0x42,0x40])),ebml(0x7ba9,Buffer.from('Holiday at '+GPS)),ebml(0x4d80,Buffer.from('Lavf60')),ebml(0x5741,Buffer.from('DJI Mini 4 Pro')),ebml(0x4461,Buffer.alloc(8,7)));
  const avcC=Buffer.from([1,100,0,40,0xff,0xe1,0,2,0x67,0,1,0,2,0x68,0]);
  const tracks=ebml(0x1654ae6b,
    ebml(0xae,ebml(0xd7,Buffer.from([1])),ebml(0x83,Buffer.from([1])),ebml(0x536e,Buffer.from('cam of alice')),ebml(0x86,Buffer.from('V_MPEG4/ISO/AVC')),ebml(0x63a2,avcC)),
    ebml(0xae,ebml(0xd7,Buffer.from([2])),ebml(0x83,Buffer.from([0x11])),ebml(0x86,Buffer.from('S_TEXT/UTF8'))),
    ebml(0xbf,Buffer.from([1,2,3,4])));
  const frame=avcSample('mkv-frame-'+GPS),seiEnd=4+frame.readUInt32BE(0);
  const simple=(track,data)=>ebml(0xa3,Buffer.from([0x80|track,0,0,0x80]),data);
  const payload=Buffer.from('\x65CLUSTER-PAYLOAD-0123456789','latin1'),block=Buffer.concat([be32(payload.length),payload]);
  const cluster=ebml(0x1f43b675,ebml(0xe7,Buffer.from([0])),simple(1,frame),simple(2,Buffer.from('subtitle '+GPS)));
  const unknownCluster=Buffer.concat([idBytes(0x1f43b675),Buffer.from([0x01,0xff,0xff,0xff,0xff,0xff,0xff,0xff]),ebml(0xe7,Buffer.from([1])),ebml(0xa0,ebml(0xa1,Buffer.from([0x81,0,0,0]),block))]);
  const tags=ebml(0x1254c367,ebml(0x7373,ebml(0x67c8,ebml(0x45a3,Buffer.from('LOCATION')),ebml(0x4487,Buffer.from(GPS)))));
  const attachments=ebml(0x1941a469,ebml(0x61a7,ebml(0x466e,Buffer.from('cover.jpg')),ebml(0x465c,Buffer.from('JPEG with EXIF '+GPS))));
  const segment=Buffer.concat([idBytes(0x18538067),Buffer.from([0x01,0xff,0xff,0xff,0xff,0xff,0xff,0xff]),info,tracks,cluster,unknownCluster,tags,attachments]);
  return {bytes:Buffer.concat([header,segment]),block,slice:frame.subarray(seiEnd)};
}

// ---- AVI ----
const riffChunk=(id,data)=>{const len=Buffer.alloc(4);len.writeUInt32LE(data.length);return Buffer.concat([Buffer.from(id),len,data,data.length&1?Buffer.alloc(1):Buffer.alloc(0)]);};
const list=(type,...parts)=>riffChunk('LIST',Buffer.concat([Buffer.from(type),...parts]));
export const jpegFrame=()=>Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0,0,16]),Buffer.from('AVI1\0'),Buffer.alloc(9),Buffer.from([0xff,0xe1,0,40]),Buffer.from('Exif\0\0'),Buffer.from(GPS.padEnd(32,'.')),Buffer.from([0xff,0xda,0,8,1,1,0,0,0x3f,0]),Buffer.from('SCANDATA'),Buffer.from([0xff,0xd9])]);
export function avi(){
  const frame=jpegFrame();
  const strh=Buffer.alloc(56);strh.write('vids');strh.write('MJPG',4);
  const strf=Buffer.alloc(40);strf.writeUInt32LE(40);strf.write('MJPG',16);
  const gpsStrh=Buffer.alloc(56);gpsStrh.write('txts');
  const hdrl=list('hdrl',riffChunk('avih',Buffer.alloc(56,1)),list('strl',riffChunk('strh',strh),riffChunk('strf',strf),riffChunk('strd',Buffer.from('driver data '+GPS)),riffChunk('strn',Buffer.from('Nikon cam '+GPS+'\0'))),list('strl',riffChunk('strh',gpsStrh),riffChunk('strf',Buffer.alloc(4))),riffChunk('IDIT',Buffer.from('MON JAN 01 10:00:00 2026\n\0')),list('ncdt',riffChunk('nctg',Buffer.from('GPS '+GPS))));
  const body=Buffer.concat([Buffer.from('AVI '),hdrl,list('INFO',riffChunk('ISFT',Buffer.from('CanonMVI06 '+GPS+'\0'))),riffChunk('JUNK',Buffer.from('serial 1234 junk text')),list('movi',riffChunk('00dc',frame),riffChunk('01tx',Buffer.from('dashcam '+GPS))),riffChunk('idx1',Buffer.alloc(16,4))]);
  return {bytes:riffChunk('RIFF',body),frame,scan:Buffer.from('SCANDATA')};
}

// ---- GIF ----
export function gif({frames=1,pad=0}={}){
  const head=Buffer.concat([Buffer.from('GIF89a'),Buffer.from([2,0,2,0,0x80,0,0]),Buffer.from([0,0,0,255,255,255])]);
  const netscape=Buffer.concat([Buffer.from([0x21,0xff,11]),Buffer.from('NETSCAPE2.0'),Buffer.from([3,1,0,0,0])]);
  const xmp=Buffer.concat([Buffer.from([0x21,0xff,11]),Buffer.from('XMP DataXMP'),Buffer.from([GPS.length]),Buffer.from(GPS),Buffer.from([0])]);
  const comment=Buffer.concat([Buffer.from([0x21,0xfe,GPS.length]),Buffer.from(GPS),Buffer.from([0])]);
  const frame=Buffer.concat([Buffer.from([0x21,0xf9,4,0,10,0,0,0]),Buffer.from([0x2c,0,0,0,0,2,0,2,0,0]),Buffer.from([2,2,0x44,0x01,0])]);
  const big=[];for(let i=0;i<pad;i+=255)big.push(Buffer.from([255]),Buffer.alloc(255,0x5a));
  const padded=pad?Buffer.concat([Buffer.from([0x2c,0,0,0,0,2,0,2,0,0,2]),...big,Buffer.from([0])]):Buffer.alloc(0);
  return {bytes:Buffer.concat([head,netscape,xmp,comment,...Array(frames).fill(frame),padded,Buffer.from([0x3b]),Buffer.from('trailing '+GPS)]),netscape,frame};
}
