package expo.modules.lineaphoto

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.util.zip.CRC32
import java.util.zip.DeflaterOutputStream
import kotlin.math.roundToInt

class PhotoSourceTest {
  private fun bytes(write:DataOutputStream.()->Unit):ByteArray {val out=ByteArrayOutputStream();DataOutputStream(out).use(write);return out.toByteArray()}
  private fun range(data:ByteArray)=PhotoSource.inspect(data.inputStream()).value
  private fun chunk(type:String,payload:ByteArray)=bytes {writeInt(payload.size);writeBytes(type);write(payload);val crc=CRC32();crc.update(type.toByteArray());crc.update(payload);writeInt(crc.value.toInt())}
  private fun png(vararg extra:ByteArray,depth:Int=8):ByteArray {
    val header=bytes{writeInt(2);writeInt(2);writeByte(depth);writeByte(2);write(byteArrayOf(0,0,0))}
    return byteArrayOf(-119,80,78,71,13,10,26,10)+chunk("IHDR",header)+extra.fold(byteArrayOf()){a,b->a+b}+chunk("IDAT",byteArrayOf())+chunk("IEND",byteArrayOf())
  }
  private fun app(marker:Int,payload:ByteArray)=bytes{writeByte(255);writeByte(marker);writeShort(payload.size+2);write(payload)}
  private fun jpeg(vararg extra:ByteArray)=byteArrayOf(-1,-40)+extra.fold(byteArrayOf()){a,b->a+b}+app(0xc0,byteArrayOf(8,0,2,0,2,1,1,0x11,0))+byteArrayOf(-1,-38,0,2)
  private fun box(type:String,payload:ByteArray)=bytes{writeInt(payload.size+8);writeBytes(type);write(payload)}
  private fun icc(gamma:Double=2.4,hdrTransfer:Int?=null):ByteArray {
    fun xyz(y:Double)=bytes{writeBytes("XYZ ");writeInt(0);writeInt(0);writeInt((y*65536).roundToInt());writeInt(0)}
    val curve=bytes{writeBytes("para");writeInt(0);writeShort(3);writeShort(0);for(value in listOf(gamma,1/1.055,.055/1.055,1/12.92,.04045))writeInt((value*65536).roundToInt())}
    val tags=linkedMapOf("rXYZ" to xyz(.3),"gXYZ" to xyz(.6),"bXYZ" to xyz(.1),"rTRC" to curve,"gTRC" to curve,"bTRC" to curve)
    if(hdrTransfer!=null)tags["cicp"]="cicp".toByteArray()+byteArrayOf(0,0,0,0,9,hdrTransfer.toByte(),0,1)
    val header=ByteArray(128);header[8]=4;"RGB ".toByteArray().copyInto(header,16);"XYZ ".toByteArray().copyInto(header,20);"acsp".toByteArray().copyInto(header,36)
    val size=132+tags.size*12+tags.values.sumOf{it.size};bytes{writeInt(size)}.copyInto(header)
    var offset=132+tags.size*12
    return header+bytes{writeInt(tags.size);for((name,data) in tags){writeBytes(name);writeInt(offset);writeInt(data.size);offset+=data.size}}+tags.values.fold(byteArrayOf()){a,b->a+b}
  }
  private fun heif(transfer:Int,extra:ByteArray=byteArrayOf(),primaryAssociation:Boolean=true):ByteArray {
    val color=box("colr",bytes{writeBytes("nclx");writeShort(1);writeShort(transfer);writeShort(1);writeByte(128)})
    val depth=box("pixi",byteArrayOf(0,0,0,0,3,8,8,8))
    val image=box("infe",byteArrayOf(2,0,0,0,0,1,0,0)+"hvc1".toByteArray()+byteArrayOf(0))
    val info=box("iinf",byteArrayOf(0,0,0,0,0,1)+image)
    val primary=box("pitm",byteArrayOf(0,0,0,0,0,1))
    val association=if(primaryAssociation)box("ipma",byteArrayOf(0,0,0,0,0,0,0,1,0,1,2,1,2))else byteArrayOf()
    val codec=ByteArray(23);codec[0]=1
    return box("ftyp","heic".toByteArray()+byteArrayOf(0,0,0,0)+"mif1heic".toByteArray())+box("meta",byteArrayOf(0,0,0,0)+primary+info+box("iprp",box("ipco",color+depth+box("hvcC",codec)+extra)+association))
  }
  @Test fun untaggedEightBitPngAndBaselineJpegAreSdr() {assertEquals("sdr",range(png()));assertEquals("sdr",range(jpeg()))}
  @Test fun pqHlgAndMasteringMetadataNeverReachTheEightBitPipeline() {
    for(transfer in listOf(16,18))assertEquals("hdr",range(png(chunk("cICP",byteArrayOf(9,transfer.toByte(),0,1)))))
    assertEquals("unknown",range(png(chunk("mDCV",ByteArray(24)))))
    assertEquals("unknown",range(png(depth=16)))
  }
  @Test fun jpegGainMapIsoAndUnresolvedMultiPictureAreNotMistakenForSdr() {
    assertEquals("hdr",range(jpeg(app(0xe1,"http://ns.adobe.com/xap/1.0/\u0000http://ns.adobe.com/hdr-gain-map/1.0/".toByteArray()))))
    assertEquals("hdr",range(jpeg(app(0xe2,"urn:iso:std:iso:ts:21496:-1\u0000".toByteArray()))))
    assertEquals("unknown",range(jpeg(app(0xe2,"MPF\u0000more".toByteArray()))))
  }
  @Test fun heifSdrRequiresKnownColorAndRejectsAuxiliaryHdrOrToneMap() {
    assertEquals("sdr",range(heif(13)))
    assertEquals("hdr",range(heif(16)))
    assertEquals("hdr",range(heif(13,box("auxC",byteArrayOf(0,0,0,0)+"urn:com:apple:photo:2020:aux:hdrgainmap\u0000".toByteArray()))))
    assertEquals("unknown",range(heif(2)))
  }
  @Test fun unknownFilesAndTruncatedMetadataCannotBeAssumedSdr() {
    assertEquals("unknown",range("not an image header".toByteArray()))
    try{range(png().copyOf(19));fail("truncated PNG accepted")}catch(error:PhotoFailure){assertEquals("UNSUPPORTED_IMAGE",error.reason)}
  }
  @Test fun numericSrgbTransferAllowsP3StyleIccButNamesCannotBlessUnknownProfiles() {
    fun jpegProfile(profile:ByteArray)=jpeg(app(0xe2,"ICC_PROFILE\u0000".toByteArray()+byteArrayOf(1,1)+profile))
    assertEquals("sdr",range(jpegProfile(icc())))
    assertEquals("unknown",range(jpegProfile(icc(gamma=9.0))))
    assertEquals("hdr",range(jpegProfile(icc(hdrTransfer=16))))
    val compressed=ByteArrayOutputStream();DeflaterOutputStream(compressed).use{it.write(icc())}
    assertEquals("sdr",range(png(chunk("iCCP","arbitrary label\u0000".toByteArray()+byteArrayOf(0)+compressed.toByteArray()))))
  }
  @Test fun realLcmsSrgbProfileIsAcceptedFromItsMatrixAndTransferCurves() {
    val profile=javaClass.getResourceAsStream("/srgb-lcms.icc")!!.use{it.readBytes()}
    assertEquals("sdr",range(jpeg(app(0xe2,"ICC_PROFILE\u0000".toByteArray()+byteArrayOf(1,1)+profile))))
  }
  @Test fun auxiliarySdrPropertiesCannotBlessUnknownPrimaryOrTenBitCodec() {
    assertEquals("unknown",range(heif(13,primaryAssociation=false)))
    val hevc=ByteArray(23);hevc[0]=1;hevc[17]=2;hevc[18]=2
    assertEquals("unknown",range(heif(13,box("hvcC",hevc))))
    assertEquals("unknown",range(heif(13,box("av1C",byteArrayOf(0x81.toByte(),0,0x40,0)))))
  }
}
