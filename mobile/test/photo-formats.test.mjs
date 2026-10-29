import assert from 'node:assert/strict';
import test from 'node:test';
import { isPhotoCandidate,sniffPhotoFormat } from '../src/photo/formats.ts';

function bitmapHeader(){
  const bytes=Buffer.alloc(58);bytes.write('BM');bytes.writeUInt32LE(58,2);bytes.writeUInt32LE(54,10);
  bytes.writeUInt32LE(40,14);bytes.writeInt32LE(1,18);bytes.writeInt32LE(1,22);bytes.writeUInt16LE(1,26);bytes.writeUInt16LE(24,28);return bytes;
}

for(const [name,bytes,expected] of [
  ['PNG',Buffer.from([137,80,78,71,13,10,26,10]),'png'],
  ['JPEG',Buffer.from([255,216,255,225]),'jpeg'],
  ['GIF87',Buffer.from('GIF87a'),'gif'],
  ['GIF89',Buffer.from('GIF89a'),'gif'],
  ['WebP',Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WEBP')]),'webp'],
  ['BMP',bitmapHeader(),'bmp'],
  ['little-endian TIFF',Buffer.from([73,73,42,0]),'tiff'],
  ['big-endian TIFF',Buffer.from([77,77,0,42]),'tiff'],
  ['empty',Buffer.alloc(0),null],
  ['ordinary text',Buffer.from('hello world'),null],
  ['WAV is not WebP',Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WAVE')]),null],
])test(`upload signature: ${name}`,()=>assert.equal(sniffPhotoFormat(bytes),expected));

test('ordinary documents beginning with BM are not sent into the image decoder',()=>{
  assert.equal(sniffPhotoFormat(Buffer.from('BMW service notes: keep this plain text document.')),null);
  assert.equal(sniffPhotoFormat(Buffer.from('BM')),null);
});

function isoFile(major,compatible=[],declared=16+compatible.length*4){
  const size=Buffer.alloc(4);size.writeUInt32BE(declared);
  return Buffer.concat([size,Buffer.from('ftyp'),Buffer.from(major),Buffer.alloc(4),...compatible.map(value=>Buffer.from(value))]);
}
test('HEIC and AVIF are recognized through major or compatible brands',()=>{
  assert.equal(sniffPhotoFormat(isoFile('heic')),'heif');
  assert.equal(sniffPhotoFormat(isoFile('avif')),'heif');
  assert.equal(sniffPhotoFormat(isoFile('isom',['mif1'])),'heif');
});
test('MP4 video and bytes outside the declared ftyp box are not misclassified as HEIF',()=>{
  assert.equal(sniffPhotoFormat(isoFile('isom',['mp42'])),null);
  assert.equal(sniffPhotoFormat(isoFile('isom',['heic'],16)),null);
  assert.equal(sniffPhotoFormat(isoFile('heic',[],8)),null);
});

test('RAW, editing and HDR image files selected as ordinary files cannot bypass metadata preparation',()=>{
  for(const extension of ['dng','nef','arw','cr2','cr3','raf','orf','rw2','srw','pef','psd','psb','svg','jxl','jp2','j2k','exr','hdr','hif','tga','ico','heif'])assert.equal(isPhotoCandidate({name:`photo.${extension}`,mimeType:'application/octet-stream'}),true,extension);
});
test('less common image signatures are recognized even after a file is renamed',()=>{
  for(const [bytes,format] of [[Buffer.from([0xff,0x0a]),'jpegxl'],[Buffer.from([0x76,0x2f,0x31,0x01]),'exr'],[Buffer.from('8BPS\0\x01'),'psd'],[Buffer.from('#?RADIANCE\n'),'radiance'],[Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'),'svg'],[Buffer.from([0,0,1,0,1,0]),'ico']])assert.equal(sniffPhotoFormat(bytes),format);
});
