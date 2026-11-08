package expo.modules.lineaphoto

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ColorSpace
import android.graphics.Gainmap
import android.os.Build
import android.util.Half
import androidx.annotation.RequiresApi
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Android glue around android.graphics.Gainmap (API 34). The pixel math lives in PhotoGainmap (JVM-tested);
 * this file only moves pixels in and out of Bitmaps and copies the gain-map parameters.
 */
object PhotoHdr {
  fun has(bitmap:Bitmap?):Boolean = bitmap!=null && Build.VERSION.SDK_INT>=34 && bitmap.hasGainmap()

  fun drop(bitmap:Bitmap) { if(Build.VERSION.SDK_INT>=34 && bitmap.hasGainmap())bitmap.gainmap=null }

  fun copy(from:Bitmap,to:Bitmap) { if(Build.VERSION.SDK_INT>=34 && from.hasGainmap())to.gainmap=from.gainmap }

  /** The gain map of a bitmap captured before a pixel effect replaces the base. */
  @RequiresApi(34)
  class GainState(val gainmap:Gainmap) {
    val contents:Bitmap get() = gainmap.gainmapContents
    val single:Boolean get() = contents.config==Bitmap.Config.ALPHA_8
    val neutral:Int get() = PhotoGainmap.neutralPixel(gainmap.ratioMin.map{it.toDouble()}.toDoubleArray(),gainmap.ratioMax.map{it.toDouble()}.toDoubleArray(),gainmap.gamma.map{it.toDouble()}.toDoubleArray())

    fun pixels():PixelImage {
      val bitmap=contents;val width=bitmap.width;val height=bitmap.height
      if(single) {
        val bytes=ByteArray(bitmap.rowBytes*height);bitmap.copyPixelsToBuffer(ByteBuffer.wrap(bytes))
        return PixelImage(width,height,IntArray(width*height){i->val v=bytes[(i/width)*bitmap.rowBytes+i%width].toInt() and 255;(255 shl 24) or (v shl 16) or (v shl 8) or v})
      }
      val data=IntArray(width*height);bitmap.getPixels(data,0,width,0,0,width,height)
      return PixelImage(width,height,data)
    }

    /** A new Gainmap with these contents and the same parameters. */
    fun with(image:PixelImage):Gainmap {
      val bitmap=if(single) {
        val result=Bitmap.createBitmap(image.width,image.height,Bitmap.Config.ALPHA_8)
        val row=result.rowBytes;val bytes=ByteArray(row*image.height)
        for(i in image.pixels.indices)bytes[(i/image.width)*row+i%image.width]=((image.pixels[i] ushr 16) and 255).toByte()
        result.copyPixelsFromBuffer(ByteBuffer.wrap(bytes));result
      } else Bitmap.createBitmap(image.width,image.height,Bitmap.Config.ARGB_8888).apply{setPixels(image.pixels,0,image.width,0,0,image.width,image.height)}
      return withContents(bitmap)
    }

    fun withContents(bitmap:Bitmap):Gainmap {
      if(Build.VERSION.SDK_INT>=35)return Gainmap(gainmap,bitmap)
      // API 34 has no copy constructor; every parameter has a setter.
      val result=Gainmap(bitmap)
      val min=gainmap.ratioMin;val max=gainmap.ratioMax;val gamma=gainmap.gamma;val sdr=gainmap.epsilonSdr;val hdr=gainmap.epsilonHdr
      result.setRatioMin(min[0],min[1],min[2]);result.setRatioMax(max[0],max[1],max[2]);result.setGamma(gamma[0],gamma[1],gamma[2])
      result.setEpsilonSdr(sdr[0],sdr[1],sdr[2]);result.setEpsilonHdr(hdr[0],hdr[1],hdr[2])
      result.displayRatioForFullHdr=gainmap.displayRatioForFullHdr;result.minDisplayRatioForHdrTransition=gainmap.minDisplayRatioForHdrTransition
      return result
    }

    fun scaled(width:Int,height:Int):Gainmap = withContents(Bitmap.createScaledBitmap(contents,width,height,true))
  }

  fun capture(bitmap:Bitmap):GainState? = if(Build.VERSION.SDK_INT>=34 && bitmap.hasGainmap())GainState(bitmap.gainmap!!) else null

  fun attach(bitmap:Bitmap,gainmap:Gainmap?) { if(Build.VERSION.SDK_INT>=34)bitmap.gainmap=gainmap }

  /**
   * Explicit SDR from an HDR base (PQ/HLG), after consent: decode to linear extended sRGB half floats, compress the
   * highlights with PhotoToneMap and encode sRGB. Assumes the decoder maps SDR reference white to 1.0 (to check on devices).
   */
  fun toneMapped(input:InputStream,sample:Int):Bitmap {
    val options=BitmapFactory.Options().apply {
      inSampleSize=sample;inPreferredConfig=Bitmap.Config.RGBA_F16
      inPreferredColorSpace=ColorSpace.get(ColorSpace.Named.LINEAR_EXTENDED_SRGB)
    }
    val decoded=input.use{BitmapFactory.decodeStream(it,null,options)} ?: throw PhotoFailure("UNSUPPORTED_IMAGE")
    try {
      if(decoded.config!=Bitmap.Config.RGBA_F16)throw PhotoFailure("HDR_UNSUPPORTED")
      val buffer=ByteBuffer.allocate(decoded.rowBytes*decoded.height).order(ByteOrder.nativeOrder())
      decoded.copyPixelsToBuffer(buffer);buffer.rewind()
      val shorts=buffer.asShortBuffer();val width=decoded.width;val height=decoded.height;val stride=decoded.rowBytes/2
      val linear=FloatArray(width*height*4)
      for(y in 0 until height)for(x in 0 until width)for(c in 0 until 4)linear[(y*width+x)*4+c]=Half.toFloat(shorts.get(y*stride+x*4+c))
      val image=PhotoToneMap.map(linear,width,height,PhotoToneMap.peak(linear))
      return Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888).apply{setPixels(image.pixels,0,width,0,0,width,height)}
    }finally{decoded.recycle()}
  }
}
