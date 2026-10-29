package expo.modules.lineavideo

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream

class VideoNalTest {
  private fun annex(vararg units:ByteArray)=units.flatMap{listOf<Byte>(0,0,0,1)+it.toList()}.toByteArray()
  private fun length(vararg units:ByteArray):ByteArray { val out=ByteArrayOutputStream();units.forEach{n->out.write(byteArrayOf(0,0,(n.size ushr 8).toByte(),n.size.toByte()));out.write(n)};return out.toByteArray() }
  private fun sei(type:Int,payload:ByteArray,hevc:Boolean=false):ByteArray = (if(hevc)byteArrayOf(78,1) else byteArrayOf(6))+byteArrayOf(type.toByte(),payload.size.toByte())+payload+byteArrayOf(-128)
  private val slice=byteArrayOf(101,9,17,31)
  @Test fun removesPrivateAvcSeiWithoutChangingFrame() {
    val data=annex(sei(5,ByteArray(16){1}+"GPS PRIVATE CAMERA".toByteArray()),slice)
    assertArrayEquals(annex(slice),VideoNal.cleanAnnexB(data,false,"sdr"))
  }
  @Test fun removesHevcUserDataAndFiller() {
    val frame=byteArrayOf(38,1,12,34)
    assertArrayEquals(length(frame),VideoNal.cleanLengthPrefixed(length(sei(5,ByteArray(16){2}+"private".toByteArray(),true),byteArrayOf(76,1,-1,-128),frame),true,"sdr"))
  }
  @Test fun retainsValidHdrContentLightAndFrame() {
    val metadata=sei(144,byteArrayOf(3,-24,1,-112),true)
    val frame=byteArrayOf(38,1,12,34)
    val input=length(metadata,frame)
    assertArrayEquals(input,VideoNal.cleanLengthPrefixed(input,true,"pq"))
    assertArrayEquals(input,VideoNal.cleanLengthPrefixed(VideoNal.cleanLengthPrefixed(input,true,"pq"),true,"pq"))
  }
  @Test fun rejectsDynamicHdrRatherThanDroppingIt() {
    assertThrows(VideoFailure::class.java){VideoNal.cleanAnnexB(annex(sei(4,byteArrayOf(-75,0,60,0,1,4,1)),slice),false,"pq")}
    assertThrows(VideoFailure::class.java){VideoNal.cleanLengthPrefixed(length(byteArrayOf(124,1,2)),true,"hlg")}
  }
  @Test fun rejectsTruncatedLengthsAndInvalidHeaders() {
    for(data in listOf(byteArrayOf(0,0,0,8,101,1),byteArrayOf(0,0,0,0),byteArrayOf(1)))assertThrows(VideoFailure::class.java){VideoNal.cleanLengthPrefixed(data,false,"sdr")}
    assertThrows(VideoFailure::class.java){VideoNal.cleanAnnexB(annex(byteArrayOf(-27,1)),false,"sdr")}
  }
  @Test fun validatesHdrPayloadAndDeclaration() {
    assertThrows(VideoFailure::class.java){VideoNal.cleanAnnexB(annex(sei(144,byteArrayOf(1,2)),slice),false,"pq")}
    assertThrows(VideoFailure::class.java){VideoNal.cleanAnnexB(annex(sei(144,byteArrayOf(3,-24,1,-112)),slice),false,"sdr")}
  }
  @Test fun acceptsThreeByteStartCodesAndNormalizesThem() {
    assertArrayEquals(annex(slice),VideoNal.cleanAnnexB(byteArrayOf(0,0,1)+slice,false,"sdr"))
  }
  @Test fun rejectsMalformedSeiLengthAndUnitOverflow() {
    assertThrows(VideoFailure::class.java){VideoNal.cleanAnnexB(annex(byteArrayOf(6,5,100,1,-128)),false,"sdr")}
    assertThrows(VideoFailure::class.java){VideoNal.cleanAnnexB(ByteArray(VideoPolicy.MAX_SAMPLE+1),false,"sdr")}
  }
  @Test fun hdrNeedsRecognizedTransferAndWideColor() {
    assertEquals("sdr",VideoPolicy.hdr(0,0));assertEquals("sdr",VideoPolicy.hdr(3,1))
    assertEquals("pq",VideoPolicy.hdr(6,6));assertEquals("hlg",VideoPolicy.hdr(7,6))
    assertThrows(VideoFailure::class.java){VideoPolicy.hdr(6,1)}
    assertThrows(VideoFailure::class.java){VideoPolicy.hdr(99,6)}
  }
  @Test fun unknownRenderingMetadataIsNotSilentlyDiscarded() {
    assertThrows(VideoFailure::class.java){VideoNal.cleanAnnexB(annex(sei(47,byteArrayOf(1)),slice),false,"sdr")}
    assertThrows(VideoFailure::class.java){VideoNal.cleanAnnexB(annex(sei(5,byteArrayOf(1,2)),slice),false,"sdr")}
  }
  @Test fun highBitDepthNeedsAnExplicitRangeAndHdrNeedsRealPrecision() {
    assertThrows(VideoFailure::class.java){VideoPolicy.validateDepth(10,"sdr",false)}
    assertThrows(VideoFailure::class.java){VideoPolicy.validateDepth(8,"pq",true)}
    VideoPolicy.validateDepth(8,"sdr",false);VideoPolicy.validateDepth(10,"sdr",true);VideoPolicy.validateDepth(10,"pq",true)
  }
  @Test fun readsActualBitDepthFromEncodedSps() {
    val hevc=javaClass.getResourceAsStream("/video/hdr10.hevc")!!.use{it.readBytes()}
    val avc=javaClass.getResourceAsStream("/video/sdr.h264")!!.use{it.readBytes()}
    val hevcSps=VideoNal.annexUnits(hevc).first{(it[0].toInt() ushr 1) and 63==33}
    val avcSps=VideoNal.annexUnits(avc).first{it[0].toInt() and 31==7}
    assertEquals(10,VideoBits.depth(hevcSps,true));assertEquals(8,VideoBits.depth(avcSps,false))
    assertThrows(VideoFailure::class.java){VideoBits.depth(hevcSps.copyOf(3),true)}
  }
  @Test fun actualEncodedFramesAndHdrRemainByteIdenticalAfterPrivateSeiRemoval() {
    for((name,hevc,hdr) in listOf(Triple("hdr10.hevc",true,"pq"),Triple("sdr.h264",false,"sdr"))) {
      val source=javaClass.getResourceAsStream("/video/$name")!!.use{it.readBytes()}
      val clean=VideoNal.cleanAnnexB(source,hevc,hdr)
      fun frames(bytes:ByteArray)=VideoNal.annexUnits(bytes).filter{if(hevc)((it[0].toInt() ushr 1) and 63)<32 else (it[0].toInt() and 31) in 1..5}
      val before=frames(source);val after=frames(clean)
      assertEquals(before.size,after.size);assertTrue(before.isNotEmpty())
      before.zip(after).forEach{(first,second)->assertArrayEquals(first,second)}
      assertArrayEquals(clean,VideoNal.cleanAnnexB(clean,hevc,hdr));assertTrue(clean.size<source.size)
      System.getenv("LINEA_VIDEO_FIXTURE_OUT")?.let{directory->java.io.File(directory,"clean-$name").writeBytes(clean)}
    }
  }
}
