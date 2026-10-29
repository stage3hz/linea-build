package expo.modules.lineavideo

object VideoBits {
  fun depth(nal:ByteArray,hevc:Boolean):Int {
    val header=if(hevc)2 else 1
    if(nal.size<=header)throw VideoFailure("MALFORMED_VIDEO")
    val bits=Bits(VideoNal.unescape(nal.copyOfRange(header,nal.size)))
    return if(hevc)hevcDepth(bits) else avcDepth(bits)
  }
  private fun hevcDepth(bits:Bits):Int {
    bits.skip(4);val layers=bits.read(3);bits.skip(1)
    if(layers>6)throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")
    bits.skip(96)
    val profile=BooleanArray(layers);val level=BooleanArray(layers)
    for(index in 0 until layers){profile[index]=bits.read(1)==1;level[index]=bits.read(1)==1}
    if(layers>0)bits.skip((8-layers)*2)
    for(index in 0 until layers){if(profile[index])bits.skip(88);if(level[index])bits.skip(8)}
    bits.ue();val chroma=bits.ue();if(chroma !in 0..3)throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")
    if(chroma==3)bits.skip(1)
    VideoPolicy.dimensions(bits.ue(),bits.ue())
    if(bits.read(1)==1)repeat(4){bits.ue()}
    return checkedDepth(bits)
  }
  private fun avcDepth(bits:Bits):Int {
    val profile=bits.read(8);bits.skip(16);bits.ue()
    if(profile in setOf(66,77,88))return 8
    if(profile !in setOf(100,110,122,244,44,83,86,118,128,138,139,134,135,144))throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")
    val chroma=bits.ue();if(chroma !in 0..3)throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")
    if(chroma==3)bits.skip(1)
    return checkedDepth(bits)
  }
  private fun checkedDepth(bits:Bits):Int {
    val luma=bits.ue()+8;val chroma=bits.ue()+8
    if(luma !in 8..16||luma!=chroma)throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")
    return luma
  }
  private class Bits(private val data:ByteArray) {
    private var offset=0
    fun skip(count:Int){if(count<0||count>data.size*8-offset)throw VideoFailure("MALFORMED_VIDEO");offset+=count}
    fun read(count:Int):Int {
      if(count !in 0..30||count>data.size*8-offset)throw VideoFailure("MALFORMED_VIDEO")
      var result=0;repeat(count){result=(result shl 1) or ((data[offset/8].toInt() ushr (7-offset%8)) and 1);offset++};return result
    }
    fun ue():Int {var zeros=0;while(read(1)==0){if(++zeros>29)throw VideoFailure("MALFORMED_VIDEO")};return (1 shl zeros)-1+read(zeros)}
  }
}
