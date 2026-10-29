/** The picker hint is supplemented by a byte signature at the upload boundary. */
export function isPhotoCandidate(file:{name:string;mimeType:string}):boolean {
  return /^image\//i.test(file.mimeType)||/\.(?:jpe?g|png|webp|hei[cf]|hif|bmp|tiff?|gif|avif|dng|nef|arw|cr2|cr3|raf|orf|rw2|srw|pef|dcr|raw|psd|psb|svg|jxl|jp2|j2k|jpf|jpx|exr|hdr|pic|tga|ico|cur|pcx|pnm|ppm|pgm|pbm|dds|qoi)$/i.test(file.name);
}

const ascii=(bytes:Uint8Array,start:number,end:number)=>String.fromCharCode(...bytes.subarray(start,end));
const matches=(bytes:Uint8Array,signature:number[])=>signature.every((value,index)=>bytes[index]===value);
const HEIF_BRANDS=new Set(['heic','heix','hevc','hevx','heim','heis','hevm','hevs','mif1','msf1','avif','avis','crx ']);

function isBitmap(bytes:Uint8Array):boolean {
  if(bytes.length<26||!matches(bytes,[66,77]))return false;
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),headerSize=view.getUint32(14,true);
  return [12,40,52,56,64,108,124].includes(headerSize)&&view.getUint32(10,true)>=14+headerSize;
}

function isHeif(bytes:Uint8Array):boolean {
  if(bytes.length<16||ascii(bytes,4,8)!=='ftyp')return false;
  const declared=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0,false);
  if(declared<16)return false;
  if(HEIF_BRANDS.has(ascii(bytes,8,12)))return true;
  for(let offset=16;offset+4<=Math.min(bytes.length,declared);offset+=4){
    if(HEIF_BRANDS.has(ascii(bytes,offset,offset+4)))return true;
  }
  return false;
}

export function sniffPhotoFormat(bytes:Uint8Array):string|null {
  if(matches(bytes,[137,80,78,71,13,10,26,10]))return 'png';
  if(matches(bytes,[255,216,255]))return 'jpeg';
  if(/^GIF8[79]a$/.test(ascii(bytes,0,6)))return 'gif';
  if(ascii(bytes,0,4)==='RIFF'&&ascii(bytes,8,12)==='WEBP')return 'webp';
  if(isBitmap(bytes))return 'bmp';
  if(matches(bytes,[73,73,42,0])||matches(bytes,[77,77,0,42]))return 'tiff';
  return isHeif(bytes)?'heif':otherImage(bytes);
}

function otherImage(bytes:Uint8Array):string|null {
  if(matches(bytes,[255,10])||matches(bytes,[0,0,0,12,74,88,76,32,13,10,135,10]))return 'jpegxl';
  if(matches(bytes,[0,0,0,12,106,80,32,32,13,10,135,10])||matches(bytes,[255,79,255,81]))return 'jpeg2000';
  if(matches(bytes,[118,47,49,1]))return 'exr';
  if(ascii(bytes,0,4)==='8BPS')return 'psd';
  if(/^#\?(?:RADIANCE|RGBE)/.test(ascii(bytes,0,16)))return 'radiance';
  if(matches(bytes,[0,0,1,0])&&bytes.length>=6)return 'ico';
  if(/^(?:\s*<\?xml[^>]*>\s*)?<svg[\s>]/i.test(ascii(bytes,0,Math.min(bytes.length,768))))return 'svg';
  return null;
}
