package expo.modules.lineaphoto

import kotlin.math.*

/**
 * Pixel edits of a gain map (Ultra HDR / ISO 21496-1), pure Kotlin so the JVM tests cover them.
 * A map is a PixelImage: single-channel maps are stored grey (r = g = b), multichannel maps per channel.
 *
 * Android's Gainmap formula: L = mix(ln ratioMin, ln ratioMax, G^gamma), D = (B + εsdr)·e^(L·W) − εhdr.
 * The neutral value ("no boost", L = 0) is therefore G0 = (−ln ratioMin / (ln ratioMax − ln ratioMin))^(1/gamma),
 * not a constant grey: with ratioMin = 1 (common for cameras) it is 0.
 */
object PhotoGainmap {
  private fun component(pixel:Int,shift:Int)=(pixel ushr shift) and 255
  private fun color(r:Int,g:Int,b:Int)=(255 shl 24) or (r shl 16) or (g shl 8) or b

  /** Byte G0 for one channel; 0 when the metadata cannot give a neutral value. */
  fun neutral(ratioMin:Double,ratioMax:Double,gamma:Double):Int {
    if(!(ratioMin>0 && ratioMax>0 && gamma>0) || !ratioMin.isFinite() || !ratioMax.isFinite() || !gamma.isFinite())return 0
    val low=ln(ratioMin);val high=ln(ratioMax)
    if(high-low<=1e-12)return 0
    val share=((0.0-low)/(high-low)).coerceIn(0.0,1.0)
    return (255*share.pow(1/gamma)).roundToInt().coerceIn(0,255)
  }

  /** Neutral ARGB pixel of a map from per-channel metadata (one or three values). */
  fun neutralPixel(ratioMin:DoubleArray,ratioMax:DoubleArray,gamma:DoubleArray):Int {
    fun at(values:DoubleArray,index:Int)=values[if(values.size==3)index else 0]
    val channels=IntArray(3){neutral(at(ratioMin,it),at(ratioMax,it),at(gamma,it))}
    return color(channels[0],channels[1],channels[2])
  }

  fun fillNeutral(map:PixelImage,mask:BooleanArray,neutral:Int):PixelImage {
    if(mask.size!=map.pixels.size)throw PhotoFailure("PROCESSING_FAILED")
    return map.copy(pixels=IntArray(map.pixels.size){if(mask[it])neutral else map.pixels[it]})
  }

  /** Pen lines in map coordinates, one extra map pixel wide so the colour never glows at the edge. */
  fun drawingMask(width:Int,height:Int,drawings:List<PhotoDrawing>):BooleanArray =
    PhotoPixels.strokeMask(width,height,drawings.map{PhotoStroke(it.width/2,it.points)},1.0)

  /** Under pen lines the map becomes neutral: the colour looks the same on SDR and HDR screens. */
  fun neutralUnderDrawings(map:PixelImage,drawings:List<PhotoDrawing>,neutral:Int):PixelImage =
    if(drawings.isEmpty())map else fillNeutral(map,drawingMask(map.width,map.height,drawings),neutral)

  /** Object removal: the map is filled by the same diffusion as the base; neutral when that is impossible. */
  fun inpaintMap(map:PixelImage,strokes:List<PhotoStroke>,neutral:Int):PixelImage {
    if(strokes.isEmpty())return map
    return try{PhotoPixels.inpaint(map,strokes)}
    catch(_:PhotoFailure){fillNeutral(map,PhotoPixels.strokeMask(map.width,map.height,strokes,1.0),neutral)}
  }

  /** Alpha of the base, averaged over each map pixel's area. */
  fun sampleAlpha(base:PixelImage,width:Int,height:Int):IntArray {
    val result=IntArray(width*height)
    for(y in 0 until height)for(x in 0 until width) {
      val x0=x*base.width/width;val x1=max(x0+1,(x+1)*base.width/width)
      val y0=y*base.height/height;val y1=max(y0+1,(y+1)*base.height/height)
      var sum=0L;var count=0
      for(sy in y0 until min(y1,base.height))for(sx in x0 until min(x1,base.width)){sum+=component(base.pixels[sy*base.width+sx],24);count++}
      result[y*width+x]=if(count==0)255 else ((sum+count/2)/count).toInt()
    }
    return result
  }

  /** White background: the original map under the subject, neutral under the new white. */
  fun compositeOnWhite(map:PixelImage,alpha:IntArray,neutral:Int):PixelImage {
    if(alpha.size!=map.pixels.size)throw PhotoFailure("PROCESSING_FAILED")
    return map.copy(pixels=IntArray(map.pixels.size) { i ->
      val p=map.pixels[i];val a=alpha[i].coerceIn(0,255)
      fun mix(shift:Int)=(component(p,shift)*a+component(neutral,shift)*(255-a)+127)/255
      color(mix(16),mix(8),mix(0))
    })
  }

  /** Same enlargement as the base (bicubic). */
  fun upscale(map:PixelImage,scale:Int):PixelImage = if(scale==1)map else PhotoPixels.upscale(map,scale)

  /** Map size for a base size: the same scale as the source map, at least one pixel. */
  fun mapSize(baseWidth:Int,baseHeight:Int,sourceBaseWidth:Int,sourceBaseHeight:Int,sourceMapWidth:Int,sourceMapHeight:Int):Pair<Int,Int> =
    max(1,(baseWidth.toLong()*sourceMapWidth/sourceBaseWidth).toInt()) to max(1,(baseHeight.toLong()*sourceMapHeight/sourceBaseHeight).toInt())
}

/**
 * Explicit SDR conversion of an HDR base (PQ/HLG), only after the user's consent. Input is linear light where
 * 1.0 is SDR reference white. Below the knee values stay exact; above it a rational curve with slope 1 at the knee
 * compresses highlights so that the content peak lands exactly on SDR white: monotonic, no clipping before the peak.
 */
object PhotoToneMap {
  const val KNEE=0.75
  fun curve(value:Double,peak:Double):Double {
    if(value<=0)return 0.0
    if(peak<=1.0 || value<=KNEE)return min(value,1.0)
    val span=peak-KNEE
    val c=(span/(1-KNEE)-1)/span
    return min(1.0,KNEE+(value-KNEE)/(1+(value-KNEE)*c))
  }
  /** Luminance gain that applies the curve while keeping hue. */
  fun gain(luminance:Double,peak:Double):Double = if(luminance<=0)0.0 else curve(luminance,peak)/luminance
  fun srgbEncode(linear:Double):Int {
    val value=linear.coerceIn(0.0,1.0)
    val encoded=if(value<=0.0031308)12.92*value else 1.055*value.pow(1/2.4)-0.055
    return (encoded*255).roundToInt().coerceIn(0,255)
  }
  /** Linear RGB(A) floats → ARGB pixels, hue kept by scaling all channels by the luminance gain. */
  fun map(linear:FloatArray,width:Int,height:Int,peak:Double):PixelImage {
    if(linear.size!=width*height*4)throw PhotoFailure("PROCESSING_FAILED")
    val pixels=IntArray(width*height) { i ->
      val r=linear[i*4].toDouble();val g=linear[i*4+1].toDouble();val b=linear[i*4+2].toDouble()
      val a=(linear[i*4+3].toDouble().coerceIn(0.0,1.0)*255).roundToInt()
      val y=max(0.0,.2126*r+.7152*g+.0722*b);val k=gain(y,peak)
      (a shl 24) or (srgbEncode(r*k) shl 16) or (srgbEncode(g*k) shl 8) or srgbEncode(b*k)
    }
    return PixelImage(width,height,pixels)
  }
  /** Brightest meaningful luminance (99.9th percentile), bounded to 1…64× SDR white. */
  fun peak(linear:FloatArray):Double {
    val count=linear.size/4;if(count==0)return 1.0
    val step=max(1,count/65536);val values=ArrayList<Double>(count/step+1)
    var i=0;while(i<count){values.add(max(0.0,.2126*linear[i*4]+.7152*linear[i*4+1]+.0722*linear[i*4+2]));i+=step}
    values.sort()
    return values[min(values.size-1,(values.size*0.999).toInt())].coerceIn(1.0,64.0)
  }
}
