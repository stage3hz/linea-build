package expo.modules.lineaphoto

import java.io.*
import java.util.zip.InflaterInputStream
import kotlin.math.*

data class PhotoRange(val value:String,val reason:String?=null) {
  fun merge(other:PhotoRange):PhotoRange = when {
    value=="hdr" -> this
    other.value=="hdr" -> other
    value=="unknown" -> this
    else -> other
  }
  companion object {
    fun hdr()=PhotoRange("hdr","В файле найдены HDR-данные или карта яркости. Этот редактор пока не сохраняет их при обработке.")
    fun unknown()=PhotoRange("unknown","Динамический диапазон или точность этого файла нельзя безопасно сохранить в 8-битном редакторе.")
  }
}

/** Bounded structural inspection, before any decoder can choose the SDR look. */
object PhotoSource {
  private const val MAX_META=4*1024*1024
  fun inspect(input:InputStream):PhotoRange {
    try {
      val cursor=Cursor(BufferedInputStream(input))
      val first=cursor.take(12)
      return when {
        first.copyOfRange(0,8).contentEquals(byteArrayOf(-119,80,78,71,13,10,26,10))->png(cursor,u32(first,8))
        u8(first,0)==255 && u8(first,1)==216->jpeg(Cursor(SequenceInputStream(ByteArrayInputStream(first.copyOfRange(2,12)),cursor.input)))
        text(first,0,6) in setOf("GIF87a","GIF89a")->throw PhotoFailure("ANIMATED_IMAGE")
        text(first,0,4)=="RIFF" && text(first,8,4)=="WEBP"->webp(cursor)
        text(first,4,4)=="ftyp"->bmff(Cursor(SequenceInputStream(ByteArrayInputStream(first),cursor.input)))
        text(first,0,2)=="BM"->bmp(cursor)
        else->PhotoRange.unknown()
      }
    }catch(error:EOFException){throw PhotoFailure("UNSUPPORTED_IMAGE")}
  }
  private fun png(input:Cursor,firstLength:Long):PhotoRange {
    var length=firstLength;var result=PhotoRange("sdr");var chunks=0
    while(true) {
      if(++chunks>100_000 || length>100L*1024*1024)throw PhotoFailure("UNSUPPORTED_IMAGE")
      val type=text(input.take(4))
      when(type) {
        "acTL"->throw PhotoFailure("ANIMATED_IMAGE")
        "IHDR"->{val data=input.metadata(length);if(data.size!=13)throw PhotoFailure("UNSUPPORTED_IMAGE");if(u8(data,8)>8)result=result.merge(PhotoRange.unknown())}
        "cICP"->{val data=input.metadata(length);if(data.size!=4)throw PhotoFailure("UNSUPPORTED_IMAGE");result=result.merge(transfer(u8(data,1)))}
        "mDCV","cLLI"->{input.skip(length);result=result.merge(PhotoRange.unknown())}
        "iCCP"->result=result.merge(iccPng(input.metadata(length)))
        "iTXt","tEXt","zTXt"->{val data=input.metadata(length);if(hasHdr(data))result=result.merge(PhotoRange.hdr())}
        else->input.skip(length)
      }
      input.skip(4) // Decoder checks CRC; a malformed HDR marker still blocks conversion.
      if(type=="IEND")return result
      length=input.uint()
    }
  }
  private fun iccPng(data:ByteArray):PhotoRange {
    val end=data.indexOf(0)
    if(end !in 1..79 || end+2>data.size || data[end+1].toInt()!=0)return PhotoRange.unknown()
    return try {
      val profile=InflaterInputStream(ByteArrayInputStream(data,end+2,data.size-end-2)).use { stream ->
        val output=ByteArrayOutputStream();val buffer=ByteArray(8192)
        while(output.size()<=MAX_META){val count=stream.read(buffer,0,min(buffer.size,MAX_META+1-output.size()));if(count<0)break;output.write(buffer,0,count)}
        output.toByteArray()
      }
      if(profile.size>MAX_META)PhotoRange.unknown() else IccRange.inspect(profile)
    }catch(_:IOException){PhotoRange.unknown()}
  }
  private fun jpeg(input:Cursor):PhotoRange {
    var result=PhotoRange("sdr");val profiles=sortedMapOf<Int,ByteArray>();var total=0
    repeat(100_000) {
      if(input.byte()!=255)throw PhotoFailure("UNSUPPORTED_IMAGE")
      var marker=input.byte();while(marker==255)marker=input.byte()
      if(marker==0xda || marker==0xd9) {
        if(profiles.isNotEmpty()) {
          if(total!=profiles.size || (1..total).any{it !in profiles})result=result.merge(PhotoRange.unknown())
          else result=result.merge(IccRange.inspect(profiles.values.fold(ByteArrayOutputStream()){out,value->out.apply{write(value)}}.toByteArray()))
        }
        return result
      }
      if(marker==0 || marker==0xd8 || marker==1 || marker in 0xd0..0xd7)throw PhotoFailure("UNSUPPORTED_IMAGE")
      val length=input.short()-2;if(length<0)throw PhotoFailure("UNSUPPORTED_IMAGE")
      val data=input.metadata(length.toLong())
      if(marker in 0xc0..0xcf && marker !in setOf(0xc4,0xc8,0xcc) && (data.isEmpty()||u8(data,0)!=8))result=result.merge(PhotoRange.unknown())
      if(marker==0xe1 && !data.starts("Exif\u0000\u0000")) {
        result=result.merge(if(hasHdr(data))PhotoRange.hdr() else PhotoRange.unknown())
      }
      if(marker==0xe2)when {
        data.starts("urn:iso:std:iso:ts:21496:")->result=result.merge(PhotoRange.hdr())
        data.starts("MPF\u0000")->result=result.merge(PhotoRange.unknown())
        data.starts("ICC_PROFILE\u0000")-> {
          if(data.size<14)throw PhotoFailure("UNSUPPORTED_IMAGE")
          val order=u8(data,12);val count=u8(data,13)
          if(order==0 || count==0 || order>count || profiles.containsKey(order) || (total!=0 && count!=total))result=result.merge(PhotoRange.unknown())
          total=count;profiles[order]=data.copyOfRange(14,data.size)
        }
      }
    }
    throw PhotoFailure("UNSUPPORTED_IMAGE")
  }
  private fun webp(input:Cursor):PhotoRange {
    var result=PhotoRange("sdr")
    while(true) {
      val first=input.optionalByte() ?: return result
      val type=text(byteArrayOf(first.toByte())+input.take(3))
      val bytes=input.take(4);val length=(u8(bytes,0).toLong() or (u8(bytes,1).toLong() shl 8) or (u8(bytes,2).toLong() shl 16) or (u8(bytes,3).toLong() shl 24))
      when(type) {
        "ANIM","ANMF"->throw PhotoFailure("ANIMATED_IMAGE")
        "VP8X"->{val data=input.metadata(length);if(data.isEmpty())throw PhotoFailure("UNSUPPORTED_IMAGE");if(u8(data,0) and 2 !=0)throw PhotoFailure("ANIMATED_IMAGE")}
        "ICCP"->result=result.merge(IccRange.inspect(input.metadata(length)))
        "XMP "->{val data=input.metadata(length);result=result.merge(if(hasHdr(data))PhotoRange.hdr() else PhotoRange.unknown())}
        else->input.skip(length)
      }
      if(length and 1L !=0L)input.skip(1)
    }
  }
  private fun bmp(input:Cursor):PhotoRange {
    val data=input.take(42);val dib=u8(data,2) or (u8(data,3) shl 8) or (u8(data,4) shl 16) or (u8(data,5) shl 24)
    // Only conventional Windows BITMAPINFOHEADER. V4/V5 can embed profiles.
    return if(dib==40)PhotoRange("sdr") else PhotoRange.unknown()
  }
  private fun bmff(input:Cursor):PhotoRange {
    val state=BoxState();boxes(input,100L*1024*1024,0,state,true)
    val associated=state.associations[state.primary] ?: emptyList()
    val primaryKnown=state.primary in state.images && associated.any{it in state.colors} && associated.any{it in state.depths} && state.codec
    return if(primaryKnown)state.range else state.range.merge(PhotoRange.unknown())
  }
  private class BoxState {
    var range=PhotoRange("sdr");var count=0;var propertyCount=0;var containers=0;var primary= -1;var codec=false
    val colors=mutableSetOf<Int>();val depths=mutableSetOf<Int>();val images=mutableSetOf<Int>()
    val associations=mutableMapOf<Int,List<Int>>()
  }
  private fun boxes(input:Cursor,end:Long,depth:Int,state:BoxState,top:Boolean=false,properties:Boolean=false) {
    if(depth>12)throw PhotoFailure("UNSUPPORTED_IMAGE")
    while(input.position<end) {
      val first=input.optionalByte() ?: if(top)return else throw EOFException()
      val start=input.position-1;var size=u32(byteArrayOf(first.toByte())+input.take(3),0)
      val name=text(input.take(4));var header=8
      if(size==1L){val high=input.uint();val low=input.uint();if(high!=0L)throw PhotoFailure("UNSUPPORTED_IMAGE");size=low;header=16}
      if(size<header || size>100L*1024*1024 || start+size>end || ++state.count>100_000)throw PhotoFailure("UNSUPPORTED_IMAGE")
      val next=start+size;val length=size-header
      val property=if(properties)++state.propertyCount else 0
      when(name) {
        "meta"->{if(input.uint()!=0L)state.range=state.range.merge(PhotoRange.unknown());boxes(input,next,depth+1,state)}
        "iprp"->boxes(input,next,depth+1,state)
        "ipco"->{if(++state.containers>1)state.range=state.range.merge(PhotoRange.unknown());boxes(input,next,depth+1,state,properties=true)}
        "iinf"->{val version=input.byte();input.skip(3);input.skip(if(version==0)2 else 4);boxes(input,next,depth+1,state)}
        "infe"->{val data=input.metadata(length);val version=data.firstOrNull()?.toInt();val at=if(version==2)8 else if(version==3)10 else -1
          if(at<0||data.size<at+4)state.range=state.range.merge(PhotoRange.unknown())
          else when(text(data,at,4)){"tmap"->state.range=state.range.merge(PhotoRange.hdr());"hvc1","av01","grid"->state.images.add(if(version==2)u8(data,4)*256+u8(data,5) else u32(data,4).toInt());"Exif"->Unit;else->state.range=state.range.merge(PhotoRange.unknown())}}
        "colr"->{val data=input.metadata(length);val range=when {
          data.starts("nclx") && data.size>=11->transfer(u8(data,6)*256+u8(data,7))
          data.starts("prof") || data.starts("rICC")->IccRange.inspect(data.copyOfRange(4,data.size))
          else->PhotoRange.unknown()};if(property>0&&range.value=="sdr")state.colors.add(property);state.range=state.range.merge(range)}
        "pixi"->{val data=input.metadata(length);val count=if(data.size>=5)u8(data,4) else 0
          if(count==0 || data.size!=5+count || (5 until data.size).any{u8(data,it)>8 || u8(data,it)==0})state.range=state.range.merge(PhotoRange.unknown()) else if(property>0)state.depths.add(property)}
        "hvcC","av1C"->{val data=input.metadata(length);val eight=if(name=="hvcC")data.size>=23&&u8(data,0)==1&&(u8(data,17) and 7)==0&&(u8(data,18) and 7)==0 else data.size>=4&&u8(data,0)==129&&(u8(data,2) and 0x60)==0
          if(!eight)state.range=state.range.merge(PhotoRange.unknown()) else state.codec=true}
        "pitm"->{val data=input.metadata(length);val version=data.firstOrNull()?.toInt()
          val id=when{version==0&&data.size==6->u8(data,4)*256+u8(data,5);version==1&&data.size==8->u32(data,4).toInt();else-> -1}
          if(id<0||state.primary>=0)state.range=state.range.merge(PhotoRange.unknown()) else state.primary=id}
        "ipma"->associations(input.metadata(length),state)
        "auxC"->{val data=input.metadata(length);if(hasHdr(data))state.range=state.range.merge(PhotoRange.hdr())
          else if(!text(data).contains("auxiliary:alpha") && !text(data).contains("auxiliary:depth") && !text(data).contains("aux:disparity"))state.range=state.range.merge(PhotoRange.unknown())}
        "mdcv","clli","amve","cclv","grpl"->{input.skip(length);state.range=state.range.merge(PhotoRange.unknown())}
        "ftyp"->{val data=input.metadata(length);if(text(data).contains("avis")||text(data).contains("msf1"))throw PhotoFailure("ANIMATED_IMAGE")}
        "moov"->throw PhotoFailure("ANIMATED_IMAGE")
        "ispe","irot","imir","clap","pasp","iloc","iref","hdlr","dinf","mdat","idat","free","skip"->input.skip(length)
        else->{input.skip(length);state.range=state.range.merge(PhotoRange.unknown())}
      }
      if(input.position!=next)throw PhotoFailure("UNSUPPORTED_IMAGE")
    }
  }
  private fun associations(data:ByteArray,state:BoxState) {
    if(data.size<8 || u8(data,0)>1 || (u32(data,0) and 0x00fffffeL)!=0L)throw PhotoFailure("UNSUPPORTED_IMAGE")
    val wide=(u8(data,3) and 1)!=0;val version=u8(data,0);val count=u32(data,4)
    if(count>100_000)throw PhotoFailure("UNSUPPORTED_IMAGE")
    var at=8
    repeat(count.toInt()) {
      val bytes=if(version==0)2 else 4
      if(at+bytes+1>data.size)throw PhotoFailure("UNSUPPORTED_IMAGE")
      val id=if(version==0)u8(data,at)*256+u8(data,at+1) else u32(data,at).toInt();at+=bytes
      val number=u8(data,at++);val indices=ArrayList<Int>(number)
      repeat(number) {
        if(at+(if(wide)2 else 1)>data.size)throw PhotoFailure("UNSUPPORTED_IMAGE")
        val index=if(wide){val value=(u8(data,at)*256+u8(data,at+1)) and 0x7fff;at+=2;value}else u8(data,at++) and 0x7f
        if(index>0)indices.add(index)
      }
      if(state.associations.put(id,indices)!=null)state.range=state.range.merge(PhotoRange.unknown())
    }
    if(at!=data.size)throw PhotoFailure("UNSUPPORTED_IMAGE")
  }
  internal fun transfer(value:Int)=when(value){16,18->PhotoRange.hdr();1,4,5,6,7,13,14,15->PhotoRange("sdr");else->PhotoRange.unknown()}
  private fun hasHdr(data:ByteArray):Boolean {val value=text(data).lowercase();return listOf("hdr-gain-map","hdrgainmap","hdrgm:","gainmap","21496:","hdrheadroom").any{it in value}}
  private class Cursor(val input:InputStream) {
    var position=0L;private var metadata=0L
    fun optionalByte():Int? {val result=input.read();if(result<0)return null;position++;if(position>100L*1024*1024)throw PhotoFailure("IMAGE_TOO_LARGE");return result}
    fun byte()=optionalByte() ?: throw EOFException()
    fun short()=byte()*256+byte()
    fun uint()=u32(take(4),0)
    fun take(count:Int):ByteArray {if(count<0||count>MAX_META)throw PhotoFailure("UNSUPPORTED_IMAGE");val result=ByteArray(count);var offset=0;while(offset<count){val amount=input.read(result,offset,count-offset);if(amount<0)throw EOFException();if(amount==0){result[offset++]=byte().toByte()}else{offset+=amount;position+=amount}}
      if(position>100L*1024*1024)throw PhotoFailure("IMAGE_TOO_LARGE");return result}
    fun metadata(count:Long):ByteArray {metadata+=count;if(count<0||metadata>MAX_META)throw PhotoFailure("UNSUPPORTED_IMAGE");return take(count.toInt())}
    fun skip(count:Long){if(count<0||position+count>100L*1024*1024)throw PhotoFailure("UNSUPPORTED_IMAGE");var remaining=count;while(remaining>0){val amount=input.skip(remaining);if(amount>0){position+=amount;remaining-=amount}else{byte();remaining--}}}
  }
}

/** Accept only numeric matrix/TRC SDR profiles, never a profile display name. */
private object IccRange {
  private val ignored=setOf("desc","cprt","dmnd","dmdd","tech","view","meas","targ","chad","chrm","bkpt")
  fun inspect(data:ByteArray):PhotoRange {
    if(data.size<132 || u32(data,0)!=data.size.toLong() || text(data,36,4)!="acsp" || text(data,16,4)!="RGB " || text(data,20,4)!="XYZ " || u8(data,8) !in 2..4)return PhotoRange.unknown()
    val count=u32(data,128);if(count>256 || 132+count*12>data.size)return PhotoRange.unknown()
    val tags=mutableMapOf<String,ByteArray>()
    for(i in 0 until count.toInt()) {
      val at=132+i*12;val name=text(data,at,4);val start=u32(data,at+4);val size=u32(data,at+8)
      if(start<132+count*12 || size<8 || start+size>data.size || tags.containsKey(name))return PhotoRange.unknown()
      tags[name]=data.copyOfRange(start.toInt(),(start+size).toInt())
    }
    tags["cicp"]?.let{if(it.size<12)return PhotoRange.unknown();val range=PhotoSource.transfer(u8(it,9));if(range.value!="sdr")return range}
    if(tags.keys.any{it !in ignored && it !in setOf("rXYZ","gXYZ","bXYZ","wtpt","rTRC","gTRC","bTRC","cicp","lumi")})return PhotoRange.unknown()
    tags["lumi"]?.let{if(it.size<20 || text(it,0,4)!="XYZ " || fixed(it,12)>203)return PhotoRange.unknown()}
    var y=0.0
    for(name in listOf("rXYZ","gXYZ","bXYZ")){val tag=tags[name] ?: return PhotoRange.unknown();if(tag.size!=20||text(tag,0,4)!="XYZ ")return PhotoRange.unknown();y+=fixed(tag,12)}
    if(abs(y-1)>.03)return PhotoRange.unknown()
    for(name in listOf("rTRC","gTRC","bTRC"))if(!standardCurve(tags[name] ?: return PhotoRange.unknown()))return PhotoRange.unknown()
    return PhotoRange("sdr")
  }
  private fun standardCurve(data:ByteArray):Boolean {
    if(data.size<12)return false
    if(text(data,0,4)=="para") {
      val type=u8(data,8)*256+u8(data,9)
      if(type==0 && data.size>=16)return listOf(1.0,1.8,2.2,2.4).any{abs(fixed(data,12)-it)<.001}
      if(type !in setOf(3,4) || data.size<if(type==3)32 else 40)return false
      val expected=doubleArrayOf(2.4,1/1.055,.055/1.055,1/12.92,.04045)
      if(expected.indices.any{abs(fixed(data,12+it*4)-expected[it])>.0001})return false
      return type==3 || (abs(fixed(data,32))<.0001 && abs(fixed(data,36))<.0001)
    }
    if(text(data,0,4)!="curv")return false
    val count=u32(data,8);if(count>65536 || 12+count*2>data.size)return false
    if(count==0L)return true
    if(count==1L){val gamma=(u8(data,12)*256+u8(data,13))/256.0;return listOf(1.0,1.8,2.2,2.4).any{abs(gamma-it)<.01}}
    val candidates=mutableSetOf(0,1,2,3,4)
    for(i in 0 until count.toInt()) {
      val x=i.toDouble()/(count-1);val value=(u8(data,12+2*i)*256+u8(data,13+2*i))/65535.0
      candidates.removeAll{kind->val expected=when(kind){0->if(x<=.04045)x/12.92 else ((x+.055)/1.055).pow(2.4);1->x;2->x.pow(1.8);3->x.pow(2.2);else->x.pow(2.4)};abs(value-expected)>3.0/65535}
      if(candidates.isEmpty())return false
    }
    return true
  }
  private fun fixed(data:ByteArray,at:Int)=u32(data,at).toInt()/65536.0
}

private fun u8(data:ByteArray,at:Int)=data[at].toInt() and 255
private fun u32(data:ByteArray,at:Int)=(u8(data,at).toLong() shl 24) or (u8(data,at+1).toLong() shl 16) or (u8(data,at+2).toLong() shl 8) or u8(data,at+3).toLong()
private fun text(data:ByteArray,at:Int=0,count:Int=data.size-at)=String(data,at,count,Charsets.ISO_8859_1)
private fun ByteArray.starts(value:String)=size>=value.length && text(this,0,value.length)==value
