package expo.modules.lineavideo

import java.io.ByteArrayOutputStream

/** Container metadata is cleaned again by the JS ISO-BMFF boundary before seal.
 * Here we remove private NAL/SEI payloads without decoding or tone-mapping video.
 * Registered T.35 payloads are rejected: this includes unverified dynamic HDR.
 */
object VideoNal {
  private fun invalid():Nothing=throw VideoFailure("MALFORMED_VIDEO")
  private fun size(bytes:ByteArray) { if(bytes.isEmpty()||bytes.size>VideoPolicy.MAX_SAMPLE)invalid() }
  private fun start(bytes:ByteArray,index:Int):Int {
    if(index+3>bytes.size||bytes[index]!=0.toByte()||bytes[index+1]!=0.toByte())return 0
    if(bytes[index+2]==1.toByte())return 3
    return if(index+4<=bytes.size&&bytes[index+2]==0.toByte()&&bytes[index+3]==1.toByte())4 else 0
  }
  fun annexUnits(bytes:ByteArray):List<ByteArray> {
    size(bytes);val units=ArrayList<ByteArray>();var offset=0
    while(offset<bytes.size) {
      val prefix=start(bytes,offset);if(prefix==0)invalid()
      val begin=offset+prefix;var end=begin
      while(end<bytes.size&&start(bytes,end)==0)end++
      var payloadEnd=end;while(payloadEnd>begin&&bytes[payloadEnd-1]==0.toByte())payloadEnd--
      if(payloadEnd<=begin)invalid()
      units.add(bytes.copyOfRange(begin,payloadEnd));if(units.size>4096)invalid()
      offset=end
    }
    return units
  }
  fun cleanAnnexB(bytes:ByteArray,hevc:Boolean,hdr:String):ByteArray {
    val output=ByteArrayOutputStream()
    annexUnits(bytes).forEach { nal -> cleanNal(nal,hevc,hdr)?.let { output.write(byteArrayOf(0,0,0,1));output.write(it) } }
    return output.toByteArray()
  }
  fun cleanSample(bytes:ByteArray,hevc:Boolean,hdr:String):ByteArray =
    if(start(bytes,0)>0)cleanAnnexB(bytes,hevc,hdr) else cleanLengthPrefixed(bytes,hevc,hdr)
  fun cleanConfig(bytes:ByteArray,hevc:Boolean,hdr:String):ByteArray {
    val output=ByteArrayOutputStream();val parameters=if(hevc)setOf(32,33,34) else setOf(7,8,13)
    annexUnits(bytes).forEach { nal ->
      val type=type(nal,hevc)
      if(type in parameters) { output.write(byteArrayOf(0,0,0,1));output.write(nal) }
      else { val clean=cleanNal(nal,hevc,hdr);if(clean!=null)throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG") }
    }
    if(output.size()==0)throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")
    return output.toByteArray()
  }
  fun cleanLengthPrefixed(bytes:ByteArray,hevc:Boolean,hdr:String,lengthBytes:Int=4):ByteArray {
    size(bytes);if(lengthBytes !in setOf(1,2,4))invalid()
    val output=ByteArrayOutputStream();var offset=0;var count=0
    while(offset<bytes.size) {
      if(offset+lengthBytes>bytes.size||++count>4096)invalid()
      var length=0L;repeat(lengthBytes){length=(length shl 8) or (bytes[offset++].toLong() and 255)}
      if(length<=0||length>bytes.size-offset)invalid()
      val nal=bytes.copyOfRange(offset,offset+length.toInt());offset+=length.toInt()
      cleanNal(nal,hevc,hdr)?.let { clean ->
        for(i in lengthBytes-1 downTo 0)output.write((clean.size ushr (i*8)) and 255)
        output.write(clean)
      }
    }
    return output.toByteArray()
  }
  private fun type(nal:ByteArray,hevc:Boolean):Int {
    if(nal.isEmpty()||(nal[0].toInt() and 128)!=0)invalid()
    if(!hevc)return nal[0].toInt() and 31
    if(nal.size<2||(nal[1].toInt() and 7)==0)invalid()
    if((nal[0].toInt() and 1)!=0||(nal[1].toInt() and 248)!=0)throw VideoFailure("MULTILAYER_UNSUPPORTED")
    return (nal[0].toInt() ushr 1) and 63
  }
  private fun cleanNal(nal:ByteArray,hevc:Boolean,hdr:String):ByteArray? {
    val type=type(nal,hevc)
    if(hevc) {
      if(type==62||type==63)throw VideoFailure("DYNAMIC_HDR_UNSUPPORTED")
      if(type==38)return null
      if(type==39||type==40)return cleanSei(nal,2,hdr)
      if(type !in 0..9&&type !in 16..21&&type !in 32..37)throw VideoFailure("UNSUPPORTED_VIDEO_NAL")
    }else {
      if(type==12)return null
      if(type==6)return cleanSei(nal,1,hdr)
      if(type !in 1..5&&type !in 7..11&&type!=13)throw VideoFailure("UNSUPPORTED_VIDEO_NAL")
    }
    return nal
  }
  private fun cleanSei(nal:ByteArray,header:Int,hdr:String):ByteArray? {
    val rbsp=unescape(nal.copyOfRange(header,nal.size));val output=ByteArrayOutputStream()
    var offset=0;var count=0;var ended=false
    while(offset<rbsp.size) {
      if(rbsp[offset]==(-128).toByte()&&offset==rbsp.size-1){ended=true;break}
      if(++count>256)invalid()
      val type=extended(rbsp,offset);offset=type.second
      val length=extended(rbsp,offset);offset=length.second
      if(length.first>rbsp.size-offset-1)invalid()
      val payload=rbsp.copyOfRange(offset,offset+length.first);offset+=length.first
      if(keepSei(type.first,payload,hdr)) {
        writeExtended(output,type.first);writeExtended(output,payload.size);output.write(payload)
      }
    }
    if(!ended)invalid()
    if(output.size()==0)return null
    output.write(128)
    return nal.copyOfRange(0,header)+escape(output.toByteArray())
  }
  private fun keepSei(type:Int,payload:ByteArray,hdr:String):Boolean {
    if(type==4)throw VideoFailure("DYNAMIC_HDR_OR_REGISTERED_DATA_UNSUPPORTED")
    if(type==5) { if(payload.size<16)invalid();return false }
    if(type==3)return false
    // Buffer timing and recovery are decoding instructions, not user metadata.
    if(type in setOf(0,1,6)) { if(payload.isEmpty()||payload.size>256)invalid();return true }
    if(type !in setOf(137,144,147))throw VideoFailure("UNSUPPORTED_VIDEO_METADATA")
    if(hdr !in setOf("pq","hlg"))throw VideoFailure("UNKNOWN_HDR")
    validateHdr(type,payload,hdr);return true
  }
  private fun validateHdr(type:Int,data:ByteArray,hdr:String) {
    when(type) {
      137->{
        if(data.size!=24)invalid()
        for(i in 0 until 8)if(u16(data,i*2)>50000)invalid()
        val max=u32(data,16);val min=u32(data,20)
        if(max==0L||max>100000000L||min>=max)invalid()
      }
      144->{if(data.size!=4)invalid();if(u16(data,0)!=0&&u16(data,2)>u16(data,0))invalid()}
      147->{if(data.size!=1||data[0].toInt()!=(if(hdr=="pq")16 else 18))invalid()}
    }
  }
  private fun u16(data:ByteArray,index:Int)=((data[index].toInt() and 255) shl 8) or (data[index+1].toInt() and 255)
  private fun u32(data:ByteArray,index:Int)=(u16(data,index).toLong() shl 16) or u16(data,index+2).toLong()
  private fun extended(data:ByteArray,start:Int):Pair<Int,Int> {
    var index=start;var value=0
    while(true) { if(index>=data.size)invalid();val part=data[index++].toInt() and 255;value+=part;if(value>VideoPolicy.MAX_SAMPLE)invalid();if(part!=255)return value to index }
  }
  private fun writeExtended(out:ByteArrayOutputStream,input:Int) { var value=input;while(value>=255){out.write(255);value-=255};out.write(value) }
  internal fun unescape(bytes:ByteArray):ByteArray {
    val output=ByteArrayOutputStream();var zeros=0;var index=0
    while(index<bytes.size) {
      val value=bytes[index++].toInt() and 255
      if(zeros==2&&value==3) { if(index>=bytes.size||(bytes[index].toInt() and 255)>3)invalid();zeros=0;continue }
      output.write(value);zeros=if(value==0)zeros+1 else 0
    }
    return output.toByteArray()
  }
  private fun escape(bytes:ByteArray):ByteArray {
    val output=ByteArrayOutputStream();var zeros=0
    for(byte in bytes) {
      val value=byte.toInt() and 255
      if(zeros==2&&value<=3){output.write(3);zeros=0}
      output.write(value);zeros=if(value==0)zeros+1 else 0
    }
    return output.toByteArray()
  }
}
