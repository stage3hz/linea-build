/** Read only TIFF IFD0 orientation. All EXIF bytes are removed after this check. */
export function exifIsUpright(bytes:Uint8Array):boolean {
  if(bytes.length<14)return false;
  const endian=String.fromCharCode(bytes[0],bytes[1]);
  if(endian!=='II'&&endian!=='MM')return false;
  const little=endian==='II',view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(view.getUint16(2,little)!==42)return false;
  const offset=view.getUint32(4,little);
  // An IFD needs its entry count and the following-IFD offset, even when empty.
  if(offset<8||offset>bytes.length-6)return false;
  const count=view.getUint16(offset,little);
  if(count>512||count*12>bytes.length-offset-6)return false;
  return uprightEntries(view,offset+2,count,little);
}

function uprightEntries(view:DataView,start:number,count:number,little:boolean):boolean {
  let seen=false;
  for(let index=0;index<count;index++){
    const at=start+index*12;
    if(view.getUint16(at,little)!==0x112)continue;
    if(seen||view.getUint16(at+2,little)!==3||view.getUint32(at+4,little)!==1||view.getUint16(at+8,little)!==1)return false;
    seen=true;
  }
  return true;
}
