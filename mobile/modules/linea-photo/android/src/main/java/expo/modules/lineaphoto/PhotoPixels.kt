package expo.modules.lineaphoto

import kotlin.math.*

data class PixelImage(val width: Int, val height: Int, val pixels: IntArray)
data class PhotoPoint(val x: Double, val y: Double)
data class PhotoStroke(val radius: Double, val points: List<PhotoPoint>)
/** Pen line: ARGB colour, full width as a share of min(width,height). */
data class PhotoDrawing(val color: Int, val width: Double, val points: List<PhotoPoint>)
class PhotoFailure(val reason: String) : RuntimeException(reason)

object PhotoPixels {
  private fun component(pixel: Int, shift: Int) = (pixel ushr shift) and 255
  private fun color(a: Int, r: Int, g: Int, b: Int) = (a shl 24) or (r shl 16) or (g shl 8) or b
  private fun byte(value: Double) = value.roundToInt().coerceIn(0,255)

  fun whiteBackground(image: PixelImage): PixelImage = image.copy(pixels=IntArray(image.pixels.size) { i ->
    val p=image.pixels[i];val a=component(p,24)
    fun blend(shift:Int)=(component(p,shift)*a+255*(255-a)+127)/255
    color(255,blend(16),blend(8),blend(0))
  })

  fun document(image: PixelImage, monochrome: Boolean): PixelImage {
    val opaque=whiteBackground(image)
    val luma=ByteArray(opaque.pixels.size) { i ->
      val p=opaque.pixels[i];((component(p,16)*77+component(p,8)*150+component(p,0)*29+128)/256).toByte()
    }
    val side=min(image.width,image.height)
    if(monochrome) {
      // Scanner-style black and white. Paper brightness is a local maximum only a little wider
      // than a pen stroke (side/130), smoothed by the same radius: it follows shadows, creases and
      // stains closely, so dividing by it leaves only the ink. A soft ramp keeps letters anti-aliased.
      val paperRadius=max(2,side/130)
      val paper=boxBlur(maxFilter(luma,image.width,image.height,paperRadius),image.width,image.height,paperRadius)
      val output=IntArray(luma.size) { i ->
        val value=min(255f,(luma[i].toInt() and 255)*255f/max(24f,paper[i]))
        val level=byte(((value-BW_INK)/(BW_PAPER-BW_INK)).coerceIn(0f,1f)*255.0)
        color(255,level,level,level)
      }
      return image.copy(pixels=output)
    }
    // Paper brightness: local maximum, then a blur no wider than that maximum,
    // so the estimate never spills from bright paper into shadows or the table.
    val closeRadius=max(2,side/40)
    val localMax=maxFilter(luma,image.width,image.height,closeRadius)
    val illumination=boxBlur(localMax,image.width,image.height,max(2,closeRadius/2))
    val output=IntArray(opaque.pixels.size) { i ->
      val divisor=max(16.0,illumination[i].toDouble())
      val p=opaque.pixels[i]
      color(255,byte(component(p,16)*255.0/divisor),byte(component(p,8)*255.0/divisor),byte(component(p,0)*255.0/divisor))
    }
    return image.copy(pixels=output)
  }

  /** Normalised brightness at or below which a pixel is pure ink, and at or above which it is paper. */
  private const val BW_INK=120f
  private const val BW_PAPER=200f

  private fun blurFloat(input:FloatArray,width:Int,height:Int,radius:Int):FloatArray {
    val horizontal=FloatArray(input.size);val output=FloatArray(input.size)
    for(y in 0 until height) blurLine(width,radius,{x->input[y*width+x]},{x,v->horizontal[y*width+x]=v})
    for(x in 0 until width) blurLine(height,radius,{y->horizontal[y*width+x]},{y,v->output[y*width+x]=v})
    return output
  }

  private fun maxFilter(input:ByteArray,width:Int,height:Int,radius:Int):ByteArray {
    val horizontal=ByteArray(input.size);val result=ByteArray(input.size)
    for(y in 0 until height) maxLine(width,radius,{x->input[y*width+x].toInt() and 255},{x,v->horizontal[y*width+x]=v.toByte()})
    for(x in 0 until width) maxLine(height,radius,{y->horizontal[y*width+x].toInt() and 255},{y,v->result[y*width+x]=v.toByte()})
    return result
  }

  private inline fun maxLine(length:Int,radius:Int,read:(Int)->Int,write:(Int,Int)->Unit) {
    val queue=IntArray(length);var head=0;var tail=0;var added=-1
    for(position in 0 until length) {
      val end=min(length-1,position+radius)
      while(added<end) {
        added++
        while(tail>head && read(queue[tail-1])<=read(added))tail--
        queue[tail++]=added
      }
      while(tail>head && queue[head]<position-radius)head++
      write(position,read(queue[head]))
    }
  }

  private fun boxBlur(input:ByteArray,width:Int,height:Int,radius:Int):FloatArray {
    val horizontal=FloatArray(input.size);val output=FloatArray(input.size)
    for(y in 0 until height) blurLine(width,radius,{x->(input[y*width+x].toInt() and 255).toFloat()},{x,v->horizontal[y*width+x]=v})
    for(x in 0 until width) blurLine(height,radius,{y->horizontal[y*width+x]},{y,v->output[y*width+x]=v})
    return output
  }

  private inline fun blurLine(length:Int,radius:Int,read:(Int)->Float,write:(Int,Float)->Unit) {
    var sum=0.0;var start=0;var end=-1
    for(position in 0 until length) {
      val desiredEnd=min(length-1,position+radius)
      while(end<desiredEnd){end++;sum+=read(end)}
      val desiredStart=max(0,position-radius)
      while(start<desiredStart){sum-=read(start);start++}
      write(position,(sum/(end-start+1)).toFloat())
    }
  }

  fun inpaint(image: PixelImage, strokes: List<PhotoStroke>): PixelImage {
    if(strokes.isEmpty())return image
    val mask=strokeMask(image.width,image.height,strokes)
    val count=mask.count{it}
    if(count==0)throw PhotoFailure("EMPTY_MASK")
    if(count.toLong()*5>mask.size)throw PhotoFailure("MASK_TOO_LARGE")
    var output=image.pixels.copyOf();var scratch=image.pixels.copyOf()
    val known=BooleanArray(mask.size){!mask[it]};val queued=BooleanArray(mask.size)
    val queue=IntArray(count);var tail=0
    for(i in mask.indices)if(mask[i] && hasKnownNeighbor(i,image.width,image.height,known)){queue[tail++]=i;queued[i]=true}
    var head=0
    while(head<tail) {
      val at=queue[head++];output[at]=neighborColor(at,image.width,image.height,output,known);known[at]=true
      neighbors(at,image.width,image.height){next->if(mask[next]&&!queued[next]){queued[next]=true;queue[tail++]=next}}
    }
    if(head!=count)throw PhotoFailure("EMPTY_BOUNDARY")
    // Four bounded diffusion passes refine the filled area. Outside pixels stay exact.
    repeat(4) {
      for(i in queue)scratch[i]=neighborColor(i,image.width,image.height,output,null)
      val swap=output;output=scratch;scratch=swap
    }
    return image.copy(pixels=output)
  }

  /** Pixels within `radius` (share of min side) plus `extra` pixels of each polyline. */
  internal fun strokeMask(width:Int,height:Int,strokes:List<PhotoStroke>,extra:Double=0.0):BooleanArray {
    val mask=BooleanArray(width*height);var budget=0L
    for(stroke in strokes) {
      val radius=max(1.0,stroke.radius*min(width,height))+extra
      val pairs=if(stroke.points.size==1)listOf(stroke.points[0] to stroke.points[0])else stroke.points.zipWithNext()
      for((start,end) in pairs) {
        val ax=start.x*(width-1);val ay=start.y*(height-1);val bx=end.x*(width-1);val by=end.y*(height-1)
        val x0=max(0,floor(min(ax,bx)-radius).toInt());val x1=min(width-1,ceil(max(ax,bx)+radius).toInt())
        val y0=max(0,floor(min(ay,by)-radius).toInt());val y1=min(height-1,ceil(max(ay,by)+radius).toInt())
        if(x0>x1||y0>y1)continue // Entirely outside this image (a stroke beyond the crop edge).
        budget+=(x1-x0+1).toLong()*(y1-y0+1)
        if(budget>60_000_000L)throw PhotoFailure("MASK_TOO_COMPLEX")
        val dx=bx-ax;val dy=by-ay;val squared=dx*dx+dy*dy
        for(y in y0..y1)for(x in x0..x1) {
          val t=if(squared==0.0)0.0 else (((x-ax)*dx+(y-ay)*dy)/squared).coerceIn(0.0,1.0)
          val px=x-ax-t*dx;val py=y-ay-t*dy
          if(px*px+py*py<=radius*radius)mask[y*width+x]=true
        }
      }
    }
    return mask
  }

  private inline fun neighbors(index:Int,width:Int,height:Int,visit:(Int)->Unit) {
    val x=index%width;val y=index/width
    for(dy in -1..1)for(dx in -1..1) {
      val nx=x+dx;val ny=y+dy
      if((dx!=0||dy!=0)&&nx>=0&&nx<width&&ny>=0&&ny<height)visit(ny*width+nx)
    }
  }
  private fun hasKnownNeighbor(at:Int,width:Int,height:Int,known:BooleanArray):Boolean {
    var found=false;neighbors(at,width,height){if(known[it])found=true};return found
  }
  private fun neighborColor(at:Int,width:Int,height:Int,pixels:IntArray,known:BooleanArray?):Int {
    var a=0;var r=0;var g=0;var b=0;var count=0
    neighbors(at,width,height){i->if(known==null||known[i]){val p=pixels[i];a+=component(p,24);r+=component(p,16);g+=component(p,8);b+=component(p,0);count++}}
    if(count==0)throw PhotoFailure("EMPTY_BOUNDARY")
    return color((a+count/2)/count,(r+count/2)/count,(g+count/2)/count,(b+count/2)/count)
  }

  private fun cubic(x:Double):Double {
    val t=abs(x)
    return if(t<=1.0)(1.5*t-2.5)*t*t+1.0 else if(t<2.0)((-.5*t+2.5)*t-4.0)*t+2.0 else 0.0
  }
  fun upscale(image: PixelImage, scale:Int=2): PixelImage {
    if(scale!=2 && scale!=4)throw PhotoFailure("INVALID_OPTIONS")
    val width=image.width*scale;val height=image.height*scale
    if(width.toLong()*height>8_000_000L)throw PhotoFailure("OUTPUT_TOO_LARGE")
    val output=IntArray(width*height)
    for(y in 0 until height)for(x in 0 until width)output[y*width+x]=bicubicPixel(image,(x+.5)/scale-.5,(y+.5)/scale-.5)
    return PixelImage(width,height,output)
  }
  private fun bicubicPixel(image:PixelImage,x:Double,y:Double):Int {
    val ix=floor(x).toInt();val iy=floor(y).toInt();var alpha=0.0;var r=0.0;var g=0.0;var b=0.0
    for(dy in -1..2)for(dx in -1..2) {
      val weight=cubic(x-(ix+dx))*cubic(y-(iy+dy))
      val pixel=image.pixels[(iy+dy).coerceIn(0,image.height-1)*image.width+(ix+dx).coerceIn(0,image.width-1)]
      val a=component(pixel,24).toDouble();alpha+=a*weight
      r+=component(pixel,16)*a*weight;g+=component(pixel,8)*a*weight;b+=component(pixel,0)*a*weight
    }
    if(alpha<=.5)return 0
    return color(byte(alpha),byte(r/alpha),byte(g/alpha),byte(b/alpha))
  }
}
