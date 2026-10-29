import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './support/load-ts.mjs';
const {isVideoCandidate,sniffVideoFormat,mediaPreviewKind}=loadTs(new URL('../src/media/formats.ts',import.meta.url));
const atom=(type,payload)=>{const b=Buffer.alloc(8+payload.length);b.writeUInt32BE(b.length);b.write(type,4);payload.copy(b,8);return b;};
const ftyp=(brand,compatible=[])=>atom('ftyp',Buffer.concat([Buffer.from(brand),Buffer.alloc(4),...compatible.map(b=>Buffer.from(b))]));

test('all picker video hints use the protected video path, including renamed/less common containers',()=>{
  for(const name of ['clip.MOV','movie.mp4','phone.3gp','clip.mkv','clip.webm','capture.m2ts','clip.mts','movie.mpg','recording.avi','legacy.wmv','movie.flv','clip.mxf','file.vob','clip.ogv'])assert.equal(isVideoCandidate({name,mimeType:'application/octet-stream'}),true,name);
  assert.equal(isVideoCandidate({name:'payload.bin',mimeType:'VIDEO/MP4'}),true);
  assert.equal(isVideoCandidate({name:'notes.txt',mimeType:'text/plain'}),false);
});
test('MP4, QuickTime and 3GPP are recognized from bytes without trusting the file name',()=>{
  assert.equal(sniffVideoFormat(ftyp('isom',['iso2','mp41'])),'mp4');
  assert.equal(sniffVideoFormat(ftyp('qt  ')),'quicktime');
  assert.equal(sniffVideoFormat(ftyp('3gp6')),'3gpp');
});
test('image containers sharing ISO BMFF must never be sent to the video remuxer',()=>{
  for(const brand of ['avif','avis','heic','heix','mif1','msf1'])assert.equal(sniffVideoFormat(ftyp(brand,['isom'])),null,brand);
  assert.equal(sniffVideoFormat(ftyp('isom',['avif'])),null);
});
test('untrusted MP4 headers are bounded and empty binary documents are not guessed as video',()=>{
  assert.equal(sniffVideoFormat(Buffer.alloc(0)),null);
  const truncated=ftyp('isom').subarray(0,10);assert.equal(sniffVideoFormat(truncated),null);
  const bad=ftyp('isom');bad.writeUInt32BE(7);assert.equal(sniffVideoFormat(bad),null);
  assert.equal(sniffVideoFormat(Buffer.from('some unrelated text')),null);
});
test('common non-MP4 video signatures route to native capability checking',()=>{
  assert.equal(sniffVideoFormat(Buffer.from([0x1a,0x45,0xdf,0xa3,0x87,0x42,0x82,0x84,0x77,0x65,0x62,0x6d])),'matroska');
  assert.equal(sniffVideoFormat(Buffer.from('RIFF\x20\0\0\0AVI LIST')),'avi');
  assert.equal(sniffVideoFormat(Buffer.from([0,0,1,0xba,0x44])),'mpeg');
  assert.equal(sniffVideoFormat(Buffer.from('FLV\x01\x05\0\0\0\x09')),'flv');
  const ts=Buffer.alloc(377);ts[0]=ts[188]=ts[376]=0x47;assert.equal(sniffVideoFormat(ts),'mpegts');
});
test('message presentation separates real photo/video/audio from ordinary files',()=>{
  const f=(name,mimeType='application/octet-stream')=>({name,mimeType});
  assert.equal(mediaPreviewKind(f('photo.png','image/png')),'photo');
  assert.equal(mediaPreviewKind(f('movie.mov')),'video');
  assert.equal(mediaPreviewKind(f('music.FLAC')),'audio');
  assert.equal(mediaPreviewKind(f('sound','audio/ogg')),'audio');
  assert.equal(mediaPreviewKind(f('contract.pdf','application/pdf')),'file');
});
