package expo.modules.lineaphoto

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ColorSpace
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.net.Uri
import android.os.Build
import androidx.exifinterface.media.ExifInterface
import java.io.*
import java.util.UUID
import kotlin.math.*

private const val MAX_SOURCE_BYTES=2048L*1024*1024
data class PhotoHeader(val width:Int,val height:Int,val rotation:Int,val flipped:Boolean,val range:PhotoRange)

class PhotoFiles(private val context:Context) {
  private val directory get() = File(context.cacheDir,"linea-photo").apply { if(!exists()&&!mkdirs())throw PhotoFailure("WRITE_FAILED") }

  fun open(uri:String):InputStream {
    val parsed=Uri.parse(uri)
    if(parsed.scheme !in setOf("file","content"))throw PhotoFailure("LOCAL_FILE_REQUIRED")
    if(parsed.scheme=="file") {
      if(!parsed.host.isNullOrEmpty()||parsed.query!=null||parsed.fragment!=null)throw PhotoFailure("LOCAL_FILE_REQUIRED")
      val file=File(parsed.path ?: throw PhotoFailure("READ_FAILED"))
      if(!file.isFile || file.length()>MAX_SOURCE_BYTES)throw PhotoFailure("READ_FAILED")
    }
    val stream=context.contentResolver.openInputStream(parsed) ?: throw PhotoFailure("READ_FAILED")
    return LimitedInputStream(BufferedInputStream(stream),MAX_SOURCE_BYTES)
  }

  fun header(uri:String):PhotoHeader {
    var range=open(uri).use {PhotoSource.inspect(it)}
    val options=BitmapFactory.Options().apply { inJustDecodeBounds=true }
    open(uri).use { BitmapFactory.decodeStream(it,null,options) }
    if(options.outWidth<=0 || options.outHeight<=0 || options.outMimeType?.startsWith("image/")!=true)throw PhotoFailure("UNSUPPORTED_IMAGE")
    val color=options.outColorSpace
    if(Build.VERSION.SDK_INT>=33 && color!=null && (color==ColorSpace.get(ColorSpace.Named.BT2020_PQ) || color==ColorSpace.get(ColorSpace.Named.BT2020_HLG)))
      range=range.merge(PhotoRange.hdrBase(if(color==ColorSpace.get(ColorSpace.Named.BT2020_PQ))"pq" else "hlg"))
    else if(color is ColorSpace.Rgb && (color.transferParameters==null || (0..2).any{color.getMinValue(it)<0 || color.getMaxValue(it)>1}))range=range.merge(PhotoRange.unknown())
    val orientation=try { open(uri).use { input -> val exif=ExifInterface(input);exif.rotationDegrees to exif.isFlipped } }
      catch(_:IOException) { 0 to false }
    val rotated=orientation.first==90||orientation.first==270
    val width=if(rotated)options.outHeight else options.outWidth
    val height=if(rotated)options.outWidth else options.outHeight
    PhotoDimensions.fit(width,height,16_000_000)
    return PhotoHeader(width,height,orientation.first,orientation.second,range)
  }

  fun inspect(uri:String):Map<String,Any> {
    val header=header(uri);val fitted=PhotoDimensions.fit(header.width,header.height,4_000_000)
    val result=mutableMapOf<String,Any>("width" to header.width,"height" to header.height,"processingWidth" to fitted.first,"processingHeight" to fitted.second,"downsampled" to (fitted.first!=header.width||fitted.second!=header.height),"dynamicRange" to header.range.value)
    header.range.reason?.let{result["dynamicRangeReason"]=it}
    header.range.kind?.let{result["hdrKind"]=it}
    result["hdrPreservable"]=header.range.kind=="gainmap" && Build.VERSION.SDK_INT>=34 && decodesGainmap(uri,header)
    return result
  }

  /** A tiny decode tells whether this system's decoder hands out the gain map (Android 14+, JPEG; HEIC is device dependent). */
  private fun decodesGainmap(uri:String,header:PhotoHeader):Boolean {
    if(Build.VERSION.SDK_INT<34)return false
    var sample=1;while(header.width/(sample*2)>=64 && header.height/(sample*2)>=64 && header.width.toLong()*header.height/(sample.toLong()*sample)>65_536)sample*=2
    val bitmap=try{open(uri).use{BitmapFactory.decodeStream(it,null,BitmapFactory.Options().apply{inSampleSize=sample})}}catch(_:Exception){null} ?: return false
    try{return bitmap.hasGainmap()}finally{bitmap.recycle()}
  }

  /**
   * Decodes, orients (EXIF, then the user's rotation and mirror), scales and crops. On Android 14+ every step uses
   * createBitmap(…Matrix)/createScaledBitmap, which transform the gain map with the base. HDR is never dropped
   * silently: without `options.sdr` a gain map that cannot be kept, an HDR base or an unknown range ends in
   * HDR_NEEDS_CONSENT; with it the gain map is removed (the base is the camera's own SDR rendition) or an HDR base
   * is tone-mapped.
   */
  fun decode(uri:String,header:PhotoHeader,plan:PhotoPlan,options:PhotoOptions):Bitmap {
    val range=header.range
    val toneMap=range.value=="hdr" && (range.kind=="pq" || range.kind=="hlg")
    if(range.value!="sdr" && !options.sdr && (toneMap || range.value=="unknown" || Build.VERSION.SDK_INT<34))throw PhotoFailure("HDR_NEEDS_CONSENT")
    val (width,height)=PhotoDimensions.decodeSize(header.width,header.height,plan,options.rotation)
    val rawWidth=if(header.rotation%180==0)header.width else header.height
    val rawHeight=if(header.rotation%180==0)header.height else header.width
    var sample=1
    // The legacy decoder supports power-of-two samples; bound its allocation
    // before any rotation/scaling bitmap is created. Half-float tone mapping gets a smaller budget.
    val decodeBudget=minOf(if(toneMap)8_000_000L else 16_000_000L,width.toLong()*height*2)
    while(rawWidth.toLong()*rawHeight/(sample.toLong()*sample)>decodeBudget)sample*=2
    var bitmap=if(toneMap)PhotoHdr.toneMapped(open(uri),sample) else {
      val decodeOptions=BitmapFactory.Options().apply {
        inSampleSize=sample;inPreferredConfig=Bitmap.Config.ARGB_8888
        inPreferredColorSpace=ColorSpace.get(ColorSpace.Named.SRGB)
      }
      open(uri).use { BitmapFactory.decodeStream(it,null,decodeOptions) } ?: throw PhotoFailure("UNSUPPORTED_IMAGE")
    }
    try {
      if(Build.VERSION.SDK_INT>=34) {
        if(options.sdr || options.sdrOnly)PhotoHdr.drop(bitmap)
        else if(range.value=="hdr" && !bitmap.hasGainmap())throw PhotoFailure("HDR_NEEDS_CONSENT")
      }
      val matrix=Matrix()
      if(header.flipped)matrix.postScale(-1f,1f)
      matrix.postRotate(header.rotation.toFloat())
      matrix.postRotate(options.rotation.toFloat())
      if(options.flip)matrix.postScale(-1f,1f)
      if(!matrix.isIdentity) {
        val oriented=Bitmap.createBitmap(bitmap,0,0,bitmap.width,bitmap.height,matrix,true)
        if(oriented!==bitmap)bitmap.recycle()
        bitmap=oriented
      }
      if(bitmap.width!=width||bitmap.height!=height) {
        val scaled=Bitmap.createScaledBitmap(bitmap,width,height,true)
        if(scaled!==bitmap)bitmap.recycle()
        bitmap=scaled
      }
      val (rotatedWidth,rotatedHeight)=PhotoDimensions.rotated(header.width,header.height,options.rotation)
      if(plan.crop!=PhotoRect(0,0,rotatedWidth,rotatedHeight)) {
        val rect=plan.crop
        val cropped=Bitmap.createBitmap(bitmap,rect.x,rect.y,rect.width,rect.height)
        if(cropped!==bitmap)bitmap.recycle()
        bitmap=cropped
      }
      if(bitmap.width!=plan.width||bitmap.height!=plan.height) {
        val resized=Bitmap.createScaledBitmap(bitmap,plan.width,plan.height,true)
        if(resized!==bitmap)bitmap.recycle()
        bitmap=resized
      }
      return bitmap
    }catch(error:Throwable){bitmap.recycle();throw error}
  }

  fun save(bitmap:Bitmap,allowDownsample:Boolean,format:String="png"):Map<String,Any> {
    var current=bitmap
    try {
      repeat(4) {
        val file=encode(current,format)
        if(file.length()<=20L*1024*1024) {
          val result=mutableMapOf<String,Any>("uri" to Uri.fromFile(file).toString(),"width" to current.width,"height" to current.height,"downsampled" to (current!==bitmap),"format" to format,"mimeType" to if(format=="jpeg")"image/jpeg" else "image/png")
          if(format=="jpeg" && PhotoHdr.has(current))result["hdr"]="gainmap"
          return result
        }
        val length=file.length()
        if(!file.delete())throw PhotoFailure("DELETE_FAILED")
        if(!allowDownsample)throw PhotoFailure("OUTPUT_TOO_LARGE")
        val factor=min(.9,sqrt((20.0*1024*1024)/length)*.9)
        val width=max(1,floor(current.width*factor).toInt());val height=max(1,floor(current.height*factor).toInt())
        val smaller=Bitmap.createScaledBitmap(current,width,height,true)
        if(current!==bitmap && current!==smaller)current.recycle()
        current=smaller
      }
      throw PhotoFailure("OUTPUT_TOO_LARGE")
    }finally{if(current!==bitmap)current.recycle()}
  }
  private fun encode(bitmap:Bitmap,format:String):File {
    val jpeg=format=="jpeg"
    val file=File(directory,"linea-native-photo-${UUID.randomUUID()}.${if(jpeg)"jpg" else "png"}")
    var opaque:Bitmap?=null
    try {
      if(jpeg && bitmap.hasAlpha()) {
        opaque=Bitmap.createBitmap(bitmap.width,bitmap.height,Bitmap.Config.ARGB_8888)
        val canvas=Canvas(opaque);canvas.drawColor(Color.WHITE);canvas.drawBitmap(bitmap,0f,0f,null)
        PhotoHdr.copy(bitmap,opaque) // Drawing on a canvas loses the gain map; it is moved explicitly.
      }
      if(!jpeg && PhotoHdr.has(bitmap))throw PhotoFailure("INVALID_OPTIONS") // PNG cannot carry a gain map; the UI asks for SDR first.
      // Android 14+ writes Ultra HDR (15+: also ISO 21496-1) for a bitmap with a gain map. Two images at q=100 too
      // often exceed 20 MB, so HDR uses 95.
      val quality=if(jpeg && PhotoHdr.has(opaque?:bitmap))95 else 100
      FileOutputStream(file).use { if(!(opaque?:bitmap).compress(if(jpeg)Bitmap.CompressFormat.JPEG else Bitmap.CompressFormat.PNG,quality,it))throw PhotoFailure("WRITE_FAILED") }
      return file
    }catch(error:Throwable){if(file.exists()&&!file.delete())throw PhotoFailure("DELETE_FAILED");throw error}
    finally{opaque?.recycle()}
  }
  fun dispose(uri:String) {
    val parsed=Uri.parse(uri)
    if(parsed.scheme!="file"||!parsed.host.isNullOrEmpty()||parsed.query!=null||parsed.fragment!=null)throw PhotoFailure("INVALID_OUTPUT")
    val file=File(parsed.path ?: throw PhotoFailure("INVALID_OUTPUT")).canonicalFile
    if(file.parentFile!=directory.canonicalFile||!Regex("linea-native-photo-[0-9a-fA-F-]{36}\\.(png|jpg)").matches(file.name))throw PhotoFailure("INVALID_OUTPUT")
    if(file.exists()&&!file.delete())throw PhotoFailure("DELETE_FAILED")
  }
  fun clearCache() {
    directory.listFiles()?.filter{it.isFile&&Regex("linea-native-photo-[0-9a-fA-F-]{36}\\.(png|jpg)").matches(it.name)}?.forEach{dispose(Uri.fromFile(it).toString())}
  }

}

private class LimitedInputStream(input:InputStream,private val maximum:Long):FilterInputStream(input) {
  private var count=0L
  private fun track(amount:Long){count+=amount;if(count>maximum)throw PhotoFailure("IMAGE_TOO_LARGE")}
  override fun read():Int {val value=`in`.read();if(value>=0)track(1);return value}
  override fun read(buffer:ByteArray,offset:Int,length:Int):Int {val amount=`in`.read(buffer,offset,length);if(amount>0)track(amount.toLong());return amount}
  override fun skip(amount:Long):Long {val skipped=`in`.skip(amount);track(skipped);return skipped}
}
