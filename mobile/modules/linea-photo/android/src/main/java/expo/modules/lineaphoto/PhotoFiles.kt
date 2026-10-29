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

private const val MAX_SOURCE_BYTES=100L*1024*1024
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
    if(color is ColorSpace.Rgb && (color.transferParameters==null || (0..2).any{color.getMinValue(it)<0 || color.getMaxValue(it)>1}))range=range.merge(PhotoRange.unknown())
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
    return result
  }

  fun decode(uri:String,header:PhotoHeader,plan:PhotoPlan):Bitmap {
    if(header.range.value!="sdr")throw PhotoFailure("HDR_UNSUPPORTED")
    val (width,height)=PhotoDimensions.decodeSize(header.width,header.height,plan)
    val rawWidth=if(header.rotation%180==0)header.width else header.height
    val rawHeight=if(header.rotation%180==0)header.height else header.width
    var sample=1
    // The legacy decoder supports power-of-two samples; bound its allocation
    // before any rotation/scaling bitmap is created.
    val decodeBudget=minOf(16_000_000L,width.toLong()*height*2)
    while(rawWidth.toLong()*rawHeight/(sample.toLong()*sample)>decodeBudget)sample*=2
    val options=BitmapFactory.Options().apply {
      inSampleSize=sample;inPreferredConfig=Bitmap.Config.ARGB_8888
      inPreferredColorSpace=ColorSpace.get(ColorSpace.Named.SRGB)
    }
    var bitmap=open(uri).use { BitmapFactory.decodeStream(it,null,options) } ?: throw PhotoFailure("UNSUPPORTED_IMAGE")
    try {
      if(Build.VERSION.SDK_INT>=34 && bitmap.hasGainmap())throw PhotoFailure("HDR_UNSUPPORTED")
      if(header.rotation!=0||header.flipped) {
        val matrix=Matrix()
        if(header.flipped)matrix.postScale(-1f,1f)
        matrix.postRotate(header.rotation.toFloat())
        val oriented=Bitmap.createBitmap(bitmap,0,0,bitmap.width,bitmap.height,matrix,true)
        if(oriented!==bitmap)bitmap.recycle()
        bitmap=oriented
      }
      if(bitmap.width!=width||bitmap.height!=height) {
        val scaled=Bitmap.createScaledBitmap(bitmap,width,height,true)
        if(scaled!==bitmap)bitmap.recycle()
        bitmap=scaled
      }
      if(plan.crop!=PhotoRect(0,0,header.width,header.height)) {
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
        if(file.length()<=20L*1024*1024)return mapOf("uri" to Uri.fromFile(file).toString(),"width" to current.width,"height" to current.height,"downsampled" to (current!==bitmap),"format" to format,"mimeType" to if(format=="jpeg")"image/jpeg" else "image/png")
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
      }
      FileOutputStream(file).use { if(!(opaque?:bitmap).compress(if(jpeg)Bitmap.CompressFormat.JPEG else Bitmap.CompressFormat.PNG,100,it))throw PhotoFailure("WRITE_FAILED") }
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
